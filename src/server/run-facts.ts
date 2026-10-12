// Must stay the first import: see telemetry-guard.ts.
import './telemetry-guard.js';
import type { BaseEvent } from '@ag-ui/core';
import {
  RUN_STATUSES,
  type ConversationLog,
  type RunRow,
  type RunStatus,
  type StoredEvent,
} from './conversation-log.js';
import {
  UNKNOWN_OUTCOME_CONTENT,
  classifyRun,
  declaredToolNames,
  isClientExecuted,
  type RecoveryKind,
} from './run-rules.js';

// Read-only durable facts about runs (C4c). Five synchronous accessors over the
// conversation log and over what this process itself is driving. They report
// what is durable and what is in memory; they never decide anything.
//
// Facts are not admission. `threadState` says whether a thread looks free at the
// instant of the read, and nothing more: another caller can reserve it before
// the answer is used. Admission belongs to DurableAgentRunner.run(), which
// checks and reserves in one synchronous stretch.
//
// Read-only by construction. This module calls no log method that writes, never
// creates the schema, never recovers or closes a run, never reads the derived
// message view, and never calls a provider or a tool.
// Every accessor is synchronous, so each answer is one consistent read of this
// process's view of the database.
//
// Trusted callers only for the global scopes. `activeRuns({ all: true })` and
// `unresolvedRuns({ all: true })` name no thread, so no per-thread ownership
// check can be made; they return identifiers and enumerated reasons, never event
// content, and they are for server-internal callers (a scheduler, an operator
// tool). No HTTP route uses them and none may: tests/run-facts-boundary.test.ts
// keeps this module's names out of every other source file. A request-driven
// path must use the thread-scoped forms, which check ownership first.
//
// R17: one OpenDots server process owns the database. A run row that this
// process is not driving is "not active in this process"; it can be a dead run
// or the live run of another process, and the facts do not claim to know which.
// Authority: docs/LOCAL_FIRST_C4C_READONLY_AND_ADMISSION_BOUNDARY.md.

// ------------------------------------------------------------------- errors

export type RunFactsErrorCode =
  | 'THREAD_NOT_OWNED'
  | 'RUN_NOT_FOUND'
  | 'INCONSISTENT_DURABLE_STATE'
  | 'STORAGE_UNAVAILABLE';

// Why a run's durable shape cannot be trusted. Enumerated, so a caller can
// branch on it and so no event content is ever needed in a message.
export type ShapeIssue =
  | 'event_unreadable'
  | 'unknown_status'
  | 'run_without_events'
  | 'first_event_not_run_started'
  | 'identity_mismatch'
  | 'seq_gap'
  | 'multiple_terminal_events'
  | 'events_after_terminal'
  | 'status_without_terminal'
  | 'terminal_without_status'
  | 'status_terminal_mismatch';

// Carries identifiers and an enumerated reason list, never event content, a SQL
// text, a file path or the message of the underlying error. A thread that is not
// owned names the thread only, so an existing and a missing run cannot be told
// apart through it.
export class RunFactsError extends Error {
  constructor(
    readonly code: RunFactsErrorCode,
    readonly threadId: string | undefined,
    readonly runId: string | undefined,
    readonly reasons: readonly ShapeIssue[] = [],
  ) {
    super(
      `${code}${threadId ? ` thread=${threadId}` : ''}${runId ? ` run=${runId}` : ''}${reasons.length ? ` reasons=${reasons.join(',')}` : ''}`,
    );
    this.name = 'RunFactsError';
  }
}

// -------------------------------------------------------------------- facts

// The rules that stay open (nothing is written for them): R22 a pending client
// and a pending server call, R24 open text or an incomplete call beside a
// pending call, R26b any other unclassified lifecycle.
export type OpenRule = 'R22' | 'R24' | 'R26b';
export type Disposition = 'recoverable' | 'deferred' | 'inconsistent';

export interface UnresolvedRunFact {
  threadId: string;
  runId: string;
  seq: number;
  agentId: string;
  startedAt: number;
  eventCount: number;
  disposition: Disposition;
  // The rules' own kind, for 'recoverable' and 'deferred'. Absent for
  // 'inconsistent'.
  kind?: RecoveryKind;
  openRule?: OpenRule;
  // What recovery WOULD do with this run, without doing it.
  afterRecovery: 'closed_by_recovery' | 'remains_open';
  pendingServerCalls: number;
  pendingClientCalls: number;
  issues: ShapeIssue[];
  // The same runId is on another thread's unresolved run. A run's identity is
  // the pair (threadId, runId); a caller keyed on runId alone would conflate
  // them.
  duplicateRunId: boolean;
  // Never provable here: a running row this process does not drive is a dead
  // run or a live run of another process (R17).
  liveness: 'not_active_in_this_process';
}

export type ThreadStateName =
  'idle' | 'running' | 'stopping' | 'finishing' | 'unresolved';

export interface ActiveRunFact {
  threadId: string;
  runId: string;
  agentId: string | undefined;
  // 'stopping': a stop was requested and the run is still settling (the SDK's
  // isRunning() is already false). 'finishing': the terminal event is committed
  // and the thread is not yet released.
  phase: 'running' | 'stopping' | 'finishing';
  // Events of this run this process holds as committed.
  eventsCommitted: number;
  // An event could not be written; the runner has stopped persisting.
  failure: boolean;
}

export interface ThreadStateFacts {
  threadId: string;
  state: ThreadStateName;
  // True only for 'idle': this process drives no run on the thread and the log
  // holds no nonterminal run for it. A fact at the instant of the read, not a
  // reservation: admission is run()'s.
  quiescent: boolean;
  schema: 'present' | 'absent';
  runCount: number;
  active: ActiveRunFact | null;
  unresolved: UnresolvedRunFact[];
  // The thread's newest event id, to correlate later reads.
  maxEventId: number;
}

// Where a tool call's result came from.
//   none             no TOOL_CALL_RESULT is durable.
//   recorded         a result that is not one of the markers below.
//   unknown_outcome  the runner's marker: the call may have run, the effect is
//                    not known (UNKNOWN_OUTCOME_CONTENT).
//   synthetic_closer the stock finalizer's closer. It states how the run ended,
//                    not what the tool did, and is no proof either way.
//   unrecognised     only closer-shaped results of an unrecognised form.
export type ToolResultProvenance =
  'none' | 'recorded' | 'unknown_outcome' | 'synthetic_closer' | 'unrecognised';

export interface ToolCallFact {
  toolCallId: string;
  toolName: string;
  side: 'client' | 'server';
  // The highest lifecycle step with a durable event.
  phase: 'args_open' | 'args_complete' | 'result_recorded';
  // 'not_possible' only when it is proven: a server call whose TOOL_CALL_END is
  // absent in a run that still has no terminal event (the A1 fence keeps the
  // executor from starting before END is durable). Any other server call is
  // 'possible', and a synthetic closer is never turned into "did not run".
  executorEntry: 'not_possible' | 'possible' | 'not_applicable_client';
  resultProvenance: ToolResultProvenance;
  // Whether the log holds what the tool returned. A synthetic closer and an
  // unknown-outcome marker are not a known outcome.
  outcomeKnown: boolean;
}

export interface AttemptFacts {
  threadId: string;
  runId: string;
  seq: number;
  agentId: string;
  status: RunStatus;
  startedAt: number;
  finishedAt: number | null;
  lifecycle: 'terminal' | 'active_in_memory' | 'nonterminal_not_active';
  eventCount: number;
  lastEventId: number;
  terminal: {
    eventType: 'RUN_FINISHED' | 'RUN_ERROR';
    code?: string;
  } | null;
  text: { opened: number; open: number; hasContent: boolean };
  reasoning: { opened: number; open: number };
  // Event types beyond run, text, tool and reasoning events (state, activity,
  // custom, raw) and types this version does not know.
  otherFamilies: string[];
  toolCalls: ToolCallFact[];
  summary: {
    serverCalls: number;
    clientCalls: number;
    serverExecutorPossible: number;
    serverOutcomesKnown: number;
    serverOutcomesUnknown: number;
    serverPending: number;
    clientPending: number;
  };
  // The rules' recovery class, for a run with no terminal event only. Never an
  // outcome for a terminal run: classifyRun returns "unclassified" for every
  // run that already holds a terminal event.
  recovery: {
    kind: RecoveryKind;
    deferred: boolean;
    openRule?: OpenRule;
  } | null;
  // Explicit non-claims. No accessor can prove that no provider request was
  // made, and the fence is an assumption of the runner's wiring, not a fact the
  // log can show.
  evidence: {
    providerRequest: 'unknown';
    fenceAssumed: true;
  };
}

export type TerminalResult =
  | {
      available: false;
      threadId: string;
      runId: string;
      reason: 'run_active_in_memory' | 'run_not_terminal';
    }
  | {
      available: true;
      threadId: string;
      runId: string;
      status: Exclude<RunStatus, 'running'>;
      outcome:
        | 'success'
        | 'finished_without_text'
        | 'stopped'
        | 'failed'
        | 'interrupted_by_recovery';
      // A run that ended 'finished' and produced assistant text.
      text?: string;
      // A run that ended 'stopped': what its last assistant message held.
      partialText?: string;
      // From the durable RUN_ERROR.
      error?: { code?: string; message: string };
      // The terminal event is committed and this process has not yet released
      // the thread.
      threadReserved: boolean;
      // Server calls whose result is the unknown-outcome marker.
      unknownOutcomeCalls: number;
    };

// A request scope. `{ all: true }` is explicit so a global listing can never be
// reached by an omitted or misspelt field.
export type ActiveScope = { agentId: string } | { all: true };
export type UnresolvedScope =
  { threadId: string; agentId: string } | { all: true };

// --------------------------------------------------------------- the runner

// What the accessors read of a run this process drives.
export interface ActiveEntry {
  readonly runId: string;
  readonly agent: { readonly agentId?: string };
  readonly events: readonly BaseEvent[];
  readonly stopRequested: boolean;
  readonly finalized: boolean;
  readonly failure?: unknown;
}

// The runner's side, supplied by DurableAgentRunner. Reading only: the runner
// hands over a view of its own state and its own ownership predicate (the one
// run() uses), never a way to change either.
export interface RunnerView {
  readonly active: ReadonlyMap<string, ActiveEntry>;
  ownsThread(threadId: string, agentId: string): boolean;
  readonly clientExecutableToolNames: ReadonlySet<string>;
}

// ------------------------------------------------------------ pure derivation

type Loose = { type: string; [field: string]: unknown };
const loose = (event: BaseEvent) => event as unknown as Loose;
const text = (value: unknown) =>
  typeof value === 'string' ? value : undefined;
const TERMINAL = new Set(['RUN_FINISHED', 'RUN_ERROR']);
// Types the attempt summary accounts for itself; anything else is reported in
// otherFamilies.
const ACCOUNTED = new Set([
  'RUN_STARTED',
  'RUN_FINISHED',
  'RUN_ERROR',
  'STEP_STARTED',
  'STEP_FINISHED',
  'TEXT_MESSAGE_START',
  'TEXT_MESSAGE_CONTENT',
  'TEXT_MESSAGE_END',
  'TOOL_CALL_START',
  'TOOL_CALL_ARGS',
  'TOOL_CALL_END',
  'TOOL_CALL_RESULT',
  'REASONING_START',
  'REASONING_MESSAGE_START',
  'REASONING_MESSAGE_CONTENT',
  'REASONING_MESSAGE_END',
  'REASONING_END',
]);

// Structural soundness of one run's rows, from the rows alone and without a
// classifier. An empty list means the run is internally consistent.
export function runShapeIssues(
  run: RunRow,
  events: readonly StoredEvent[],
): ShapeIssue[] {
  const issues = new Set<ShapeIssue>();
  if (!(RUN_STATUSES as readonly string[]).includes(run.status))
    issues.add('unknown_status');
  if (!events.length) {
    issues.add('run_without_events');
    return [...issues];
  }
  const first = loose(events[0].event);
  if (first.type !== 'RUN_STARTED') issues.add('first_event_not_run_started');
  else if (first.threadId !== run.threadId || first.runId !== run.runId)
    issues.add('identity_mismatch');
  events.forEach((stored, index) => {
    if (stored.seq !== index) issues.add('seq_gap');
  });
  const terminals = events
    .map((stored, index) => ({ index, type: loose(stored.event).type }))
    .filter((entry) => TERMINAL.has(entry.type));
  if (terminals.length > 1) issues.add('multiple_terminal_events');
  if (terminals.length && terminals[0].index !== events.length - 1)
    issues.add('events_after_terminal');
  if (run.status === 'running' && terminals.length)
    issues.add('terminal_without_status');
  if (run.status !== 'running' && !terminals.length)
    issues.add('status_without_terminal');
  if (run.status !== 'running' && terminals.length) {
    const type = terminals[0].type;
    const agrees =
      (type === 'RUN_FINISHED' &&
        (run.status === 'finished' || run.status === 'stopped')) ||
      (type === 'RUN_ERROR' &&
        (run.status === 'error' || run.status === 'interrupted'));
    if (!agrees) issues.add('status_terminal_mismatch');
  }
  return [...issues];
}

function openRuleOf(kind: RecoveryKind): OpenRule | undefined {
  if (kind === 'mixed_pending_tool_calls') return 'R22';
  if (kind === 'open_text_with_pending_tool_call') return 'R24';
  if (kind === 'unclassified_lifecycle') return 'R26b';
  return undefined;
}

// The stock finalizer's closers (finalizeRunEvents, pinned by
// tests/agent-runner-sdk-contract.test.ts): messageId `${toolCallId}-result`
// and one of two JSON contents.
function isStockCloser(toolCallId: string, result: Loose): boolean {
  if (text(result.messageId) !== `${toolCallId}-result`) return false;
  try {
    const parsed = JSON.parse(text(result.content) ?? '') as {
      status?: unknown;
      reason?: unknown;
    } | null;
    return (
      (parsed?.status === 'stopped' && parsed.reason === 'stop_requested') ||
      (parsed?.status === 'error' && parsed.reason === 'missing_terminal_event')
    );
  } catch {
    return false;
  }
}

function resultProvenance(
  toolCallId: string,
  results: readonly Loose[],
): ToolResultProvenance {
  if (!results.length) return 'none';
  const kinds = new Set(
    results.map((result) =>
      text(result.messageId) === `${toolCallId}-unknown-outcome` &&
      text(result.content) === UNKNOWN_OUTCOME_CONTENT
        ? 'unknown_outcome'
        : isStockCloser(toolCallId, result)
          ? 'synthetic_closer'
          : 'recorded',
    ),
  );
  // The strongest claim wins: what the runner marked unknown, then a recorded
  // result, then a closer.
  if (kinds.has('unknown_outcome')) return 'unknown_outcome';
  if (kinds.has('recorded')) return 'recorded';
  return 'synthetic_closer';
}

// Facts of one run from its stored events. `lifecycle` is the caller's: only the
// runner's own state can say that a run is the one this process is driving.
export function deriveAttemptFacts(
  run: RunRow,
  events: readonly StoredEvent[],
  clientExecutable: ReadonlySet<string>,
  lifecycle: AttemptFacts['lifecycle'],
): AttemptFacts {
  const raw = events.map((stored) => stored.event);
  const all = raw.map(loose);
  const declared = declaredToolNames(raw);
  const terminalEvent = all.find((event) => TERMINAL.has(event.type));
  const terminalCode = terminalEvent && text(terminalEvent.code);
  const terminal = terminalEvent
    ? {
        eventType: terminalEvent.type as 'RUN_FINISHED' | 'RUN_ERROR',
        ...(terminalCode ? { code: terminalCode } : {}),
      }
    : null;

  const openText = new Set<string>();
  let textOpened = 0;
  let hasContent = false;
  const openReasoning = new Set<string>();
  let reasoningOpened = 0;
  const other = new Set<string>();
  const calls = new Map<
    string,
    { name: string; ended: boolean; results: Loose[] }
  >();
  for (const event of all) {
    const messageId = text(event.messageId);
    const toolCallId = text(event.toolCallId);
    switch (event.type) {
      case 'TEXT_MESSAGE_START':
        if (messageId !== undefined) {
          openText.add(messageId);
          textOpened++;
        }
        break;
      case 'TEXT_MESSAGE_CONTENT':
        if (text(event.delta)) hasContent = true;
        break;
      case 'TEXT_MESSAGE_END':
        if (messageId !== undefined) openText.delete(messageId);
        break;
      case 'REASONING_START':
        if (messageId !== undefined) {
          openReasoning.add(messageId);
          reasoningOpened++;
        }
        break;
      case 'REASONING_END':
        if (messageId !== undefined) openReasoning.delete(messageId);
        break;
      case 'TOOL_CALL_START':
        if (toolCallId !== undefined && !calls.has(toolCallId))
          calls.set(toolCallId, {
            name: text(event.toolCallName) ?? '',
            ended: false,
            results: [],
          });
        break;
      case 'TOOL_CALL_END':
        if (toolCallId !== undefined && calls.has(toolCallId))
          calls.get(toolCallId)!.ended = true;
        break;
      case 'TOOL_CALL_RESULT':
        if (toolCallId !== undefined && calls.has(toolCallId))
          calls.get(toolCallId)!.results.push(event);
        break;
      default:
        if (!ACCOUNTED.has(event.type)) other.add(event.type);
    }
  }

  const noTerminal = terminal === null;
  const toolCalls: ToolCallFact[] = [...calls.entries()].map(([id, call]) => {
    const side = isClientExecuted(call.name, declared, clientExecutable)
      ? 'client'
      : 'server';
    const provenance = resultProvenance(id, call.results);
    const phase: ToolCallFact['phase'] = call.results.length
      ? 'result_recorded'
      : call.ended
        ? 'args_complete'
        : 'args_open';
    // The absence of END is observable directly only while the run has no
    // terminal event. In a terminal run the finalizer may have appended END
    // itself, so nothing is claimed.
    const executorEntry: ToolCallFact['executorEntry'] =
      side === 'client'
        ? 'not_applicable_client'
        : phase === 'args_open' && noTerminal
          ? 'not_possible'
          : 'possible';
    return {
      toolCallId: id,
      toolName: call.name,
      side,
      phase,
      executorEntry,
      resultProvenance: provenance,
      outcomeKnown: provenance === 'recorded',
    };
  });
  const server = toolCalls.filter((call) => call.side === 'server');
  const client = toolCalls.filter((call) => call.side === 'client');

  let recovery: AttemptFacts['recovery'] = null;
  if (noTerminal) {
    const classification = classifyRun(raw, clientExecutable);
    const rule = openRuleOf(classification.kind);
    recovery = {
      kind: classification.kind,
      deferred: classification.deferred,
      ...(rule ? { openRule: rule } : {}),
    };
  }
  return {
    threadId: run.threadId,
    runId: run.runId,
    seq: run.seq,
    agentId: run.agentId,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    lifecycle,
    eventCount: events.length,
    lastEventId: events.at(-1)?.id ?? 0,
    terminal,
    text: { opened: textOpened, open: openText.size, hasContent },
    reasoning: { opened: reasoningOpened, open: openReasoning.size },
    otherFamilies: [...other].sort(),
    toolCalls,
    summary: {
      serverCalls: server.length,
      clientCalls: client.length,
      serverExecutorPossible: server.filter(
        (call) => call.executorEntry === 'possible',
      ).length,
      serverOutcomesKnown: server.filter((call) => call.outcomeKnown).length,
      serverOutcomesUnknown: server.filter(
        (call) => call.phase === 'result_recorded' && !call.outcomeKnown,
      ).length,
      serverPending: server.filter((call) => call.phase !== 'result_recorded')
        .length,
      clientPending: client.filter((call) => call.phase !== 'result_recorded')
        .length,
    },
    recovery,
    evidence: { providerRequest: 'unknown', fenceAssumed: true },
  };
}

// One message as the AG-UI reducer would hold it, reduced to what picking the
// answer needs.
interface Held {
  id: string;
  role: string;
  content: unknown;
  toolCallIds: string[];
}

function held(message: unknown): Held {
  const value = message as {
    id?: unknown;
    role?: unknown;
    content?: unknown;
    toolCalls?: unknown;
  };
  return {
    id: String(value.id),
    role: String(value.role),
    content: value.content,
    toolCallIds: Array.isArray(value.toolCalls)
      ? value.toolCalls
          .map((call) => text((call as { id?: unknown } | null)?.id))
          .filter((id): id is string => id !== undefined)
      : [],
  };
}

// The text of a run's answer, by the rule runLocalTurn applies through
// currentTurnText (headless.ts): of the messages the run added to the
// conversation, the LAST assistant message, and its content when that is a
// non-blank string; otherwise no text. An earlier message is never substituted.
//
// It follows the message list the SDK's AG-UI reducer would build from these
// events (run input first, then each event in order), for the events that
// create or change a message, so the answer is the one the adapter would have
// returned. The reducer itself is asynchronous and costs about 70 us per event,
// so it is the oracle in tests/run-facts-text-parity.test.ts rather than the
// implementation. Events that do not touch messages (state, steps, custom, raw,
// tool arguments, end markers) are ignored, as the reducer ignores them for the
// message list. The SDK versions this was verified on are pinned there.
export function ownAssistantText(
  events: readonly BaseEvent[],
): string | undefined {
  const start = events.map(loose).find((event) => event.type === 'RUN_STARTED');
  const input = (start?.input as { messages?: unknown } | undefined)?.messages;
  const messages: Held[] = [];
  const before = new Set<string>();
  if (Array.isArray(input))
    for (const item of input) {
      const message = held(item);
      before.add(message.id);
      if (!messages.some((existing) => existing.id === message.id))
        messages.push(message);
    }
  const find = (id: string) => messages.find((message) => message.id === id);

  for (const event of events.map(loose)) {
    switch (event.type) {
      case 'TEXT_MESSAGE_START': {
        const id = text(event.messageId);
        if (id === undefined) break;
        const existing = find(id);
        if (existing?.role === 'activity') break;
        if (!existing)
          messages.push({
            id,
            role: text(event.role) ?? 'assistant',
            content: '',
            toolCallIds: [],
          });
        break;
      }
      case 'TEXT_MESSAGE_CONTENT':
      case 'REASONING_MESSAGE_CONTENT': {
        const target = find(String(event.messageId));
        if (!target) break;
        if (event.type === 'TEXT_MESSAGE_CONTENT' && target.role === 'activity')
          break;
        target.content = `${typeof target.content === 'string' ? target.content : ''}${String(event.delta)}`;
        break;
      }
      case 'REASONING_MESSAGE_START': {
        const id = text(event.messageId);
        if (id !== undefined && !find(id))
          messages.push({
            id,
            role: 'reasoning',
            content: '',
            toolCallIds: [],
          });
        break;
      }
      case 'TOOL_CALL_START': {
        const callId = text(event.toolCallId);
        if (callId === undefined) break;
        if (messages.some((message) => message.toolCallIds.includes(callId)))
          break;
        const parentId = text(event.parentMessageId);
        let host: Held | undefined;
        if (parentId) {
          const parent = find(parentId);
          if (parent?.role === 'assistant') host = parent;
          else
            messages.push(
              (host = {
                id: parent ? callId : parentId,
                role: 'assistant',
                content: undefined,
                toolCallIds: [],
              }),
            );
        } else
          messages.push(
            (host = {
              id: callId,
              role: 'assistant',
              content: undefined,
              toolCallIds: [],
            }),
          );
        host.toolCallIds.push(callId);
        break;
      }
      case 'TOOL_CALL_RESULT':
        messages.push({
          id: String(event.messageId),
          role: text(event.role) || 'tool',
          content: event.content,
          toolCallIds: [],
        });
        break;
      case 'ACTIVITY_SNAPSHOT': {
        const id = String(event.messageId);
        const index = messages.findIndex((message) => message.id === id);
        const replace = event.replace === undefined ? true : !!event.replace;
        const next: Held = {
          id,
          role: 'activity',
          content: event.content,
          toolCallIds: [],
        };
        if (index === -1) messages.push(next);
        else if (replace) messages[index] = next;
        break;
      }
      case 'MESSAGES_SNAPSHOT': {
        const snapshot = Array.isArray(event.messages)
          ? event.messages.map(held)
          : [];
        const byId = new Map(snapshot.map((message) => [message.id, message]));
        const hasActivity = snapshot.some((m) => m.role === 'activity');
        const hasReasoning = snapshot.some((m) => m.role === 'reasoning');
        const local = (m: Held) =>
          (m.role === 'activity' && !hasActivity) ||
          (m.role === 'reasoning' && !hasReasoning);
        const kept = messages
          .filter((m) => local(m) || byId.has(m.id))
          .map((m) => (local(m) ? m : byId.get(m.id)!));
        const seen = new Set(kept.map((m) => m.id));
        for (const message of snapshot)
          if (!seen.has(message.id)) kept.push(message);
        messages.length = 0;
        messages.push(...kept);
        break;
      }
      default:
        break;
    }
  }
  const answer = messages
    .filter((message) => !before.has(message.id))
    .filter((message) => message.role === 'assistant')
    .at(-1)?.content;
  return typeof answer === 'string' && answer.trim() ? answer : undefined;
}

// ---------------------------------------------------------------- accessors

// Maps what a read can throw to the typed error, without the underlying message:
// the log's one non-storage throw is JSON.parse of a stored event.
function reading<T>(work: () => T, threadId?: string, runId?: string): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof RunFactsError) throw error;
    if (error instanceof SyntaxError)
      throw new RunFactsError('INCONSISTENT_DURABLE_STATE', threadId, runId, [
        'event_unreadable',
      ]);
    throw new RunFactsError('STORAGE_UNAVAILABLE', threadId, runId);
  }
}

const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value !== '';
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const hasExactly = (value: Record<string, unknown>, ...keys: string[]) => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
};

function activeFact(threadId: string, entry: ActiveEntry): ActiveRunFact {
  return {
    threadId,
    runId: entry.runId,
    agentId: entry.agent.agentId,
    phase: entry.finalized
      ? 'finishing'
      : entry.stopRequested
        ? 'stopping'
        : 'running',
    eventsCommitted: entry.events.length,
    failure: entry.failure !== undefined,
  };
}

// The same predicate and arguments run() uses for admission. A thread or an
// agent id that is not a non-empty string is not owned.
function requireOwner(
  runner: RunnerView,
  threadId: unknown,
  agentId: unknown,
): string {
  if (
    !nonEmpty(threadId) ||
    !nonEmpty(agentId) ||
    !runner.ownsThread(threadId, agentId)
  )
    throw new RunFactsError(
      'THREAD_NOT_OWNED',
      nonEmpty(threadId) ? threadId : undefined,
      undefined,
    );
  return threadId;
}

// One run and its events, checked for structural soundness. Unknown run:
// RUN_NOT_FOUND. Rows that contradict each other: INCONSISTENT_DURABLE_STATE
// with the enumerated reasons.
function readRun(
  log: ConversationLog,
  threadId: string,
  runId: unknown,
): { run: RunRow; events: StoredEvent[] } {
  if (!nonEmpty(runId))
    throw new RunFactsError('RUN_NOT_FOUND', threadId, undefined);
  return reading(
    () => {
      if (!log.hasSchema())
        throw new RunFactsError('RUN_NOT_FOUND', threadId, runId);
      const run = log.getRun(threadId, runId);
      if (!run) throw new RunFactsError('RUN_NOT_FOUND', threadId, runId);
      const events = log.runEvents(threadId, runId);
      const issues = runShapeIssues(run, events);
      if (issues.length)
        throw new RunFactsError(
          'INCONSISTENT_DURABLE_STATE',
          threadId,
          runId,
          issues,
        );
      return { run, events };
    },
    threadId,
    runId,
  );
}

// One persisted run that no one in this process is driving. An unreadable run
// is reported as 'inconsistent' (and still blocks its thread) rather than
// hiding the other runs of a listing.
function unresolvedFact(
  log: ConversationLog,
  runner: RunnerView,
  run: RunRow,
): UnresolvedRunFact {
  let events: StoredEvent[] = [];
  let issues: ShapeIssue[];
  try {
    events = log.runEvents(run.threadId, run.runId);
    issues = runShapeIssues(run, events);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    issues = ['event_unreadable'];
  }
  const base = {
    threadId: run.threadId,
    runId: run.runId,
    seq: run.seq,
    agentId: run.agentId,
    startedAt: run.startedAt,
    eventCount: events.length,
    duplicateRunId: false,
    liveness: 'not_active_in_this_process' as const,
  };
  if (issues.length)
    return {
      ...base,
      disposition: 'inconsistent',
      afterRecovery: 'remains_open',
      pendingServerCalls: 0,
      pendingClientCalls: 0,
      issues,
    };
  const classification = classifyRun(
    events.map((stored) => stored.event),
    runner.clientExecutableToolNames,
  );
  const rule = openRuleOf(classification.kind);
  return {
    ...base,
    disposition: classification.deferred ? 'deferred' : 'recoverable',
    kind: classification.kind,
    ...(rule ? { openRule: rule } : {}),
    afterRecovery: classification.deferred
      ? 'remains_open'
      : 'closed_by_recovery',
    pendingServerCalls: classification.pendingServer.length,
    pendingClientCalls: classification.pendingClient.length,
    issues: [],
  };
}

export class RunFacts {
  constructor(
    private readonly log: ConversationLog,
    private readonly runner: RunnerView,
  ) {}

  // Where a thread stands at this instant. 'unresolved' means the log holds a
  // run for it that this process is not driving; it is never reported as idle.
  threadState(threadId: string, agentId: string): ThreadStateFacts {
    requireOwner(this.runner, threadId, agentId);
    return reading(() => {
      const entry = this.runner.active.get(threadId);
      const active = entry ? activeFact(threadId, entry) : null;
      const name = (unresolved: readonly UnresolvedRunFact[]) =>
        active
          ? active.phase
          : unresolved.length
            ? ('unresolved' as const)
            : ('idle' as const);
      if (!this.log.hasSchema())
        return {
          threadId,
          state: name([]),
          quiescent: !active,
          schema: 'absent',
          runCount: 0,
          active,
          unresolved: [],
          maxEventId: 0,
        };
      const runs = this.log.runs(threadId);
      const unresolved = runs
        .filter((run) => run.status === 'running' && run.runId !== entry?.runId)
        .map((run) => unresolvedFact(this.log, this.runner, run));
      const state = name(unresolved);
      return {
        threadId,
        state,
        quiescent: state === 'idle',
        schema: 'present',
        runCount: runs.length,
        active,
        unresolved,
        maxEventId: this.log.maxEventId(threadId),
      };
    }, threadId);
  }

  // The runs this process is driving. In memory only: no database read. The
  // agent scope keeps the threads that agent owns; the global scope is for
  // trusted in-process callers and checks no ownership (no thread is named).
  activeRuns(scope: ActiveScope): ActiveRunFact[] {
    // Whatever the type says, a caller may hand over parsed input: only the two
    // exact shapes are accepted, anything else is refused and never read as a
    // global listing.
    const request: unknown = scope;
    let agentId: string | undefined;
    if (isObject(request) && hasExactly(request, 'all') && request.all === true)
      agentId = undefined;
    else if (
      isObject(request) &&
      hasExactly(request, 'agentId') &&
      nonEmpty(request.agentId)
    )
      agentId = request.agentId;
    else throw new RunFactsError('THREAD_NOT_OWNED', undefined, undefined);
    const facts: ActiveRunFact[] = [];
    for (const [threadId, entry] of this.runner.active) {
      if (agentId !== undefined && !this.runner.ownsThread(threadId, agentId))
        continue;
      facts.push(activeFact(threadId, entry));
    }
    return facts.sort((a, b) => a.threadId.localeCompare(b.threadId));
  }

  // What the log holds for one run, tool call by tool call.
  attemptFacts(request: {
    threadId: string;
    runId: string;
    agentId: string;
  }): AttemptFacts {
    const { threadId, runId, agentId } = isObject(request)
      ? request
      : ({} as Record<string, unknown>);
    const thread = requireOwner(this.runner, threadId, agentId);
    const { run, events } = readRun(this.log, thread, runId);
    const lifecycle: AttemptFacts['lifecycle'] =
      this.runner.active.get(thread)?.runId === run.runId
        ? 'active_in_memory'
        : run.status === 'running'
          ? 'nonterminal_not_active'
          : 'terminal';
    return deriveAttemptFacts(
      run,
      events,
      this.runner.clientExecutableToolNames,
      lifecycle,
    );
  }

  // The outcome of a run from its terminal event alone. Unavailable (a value,
  // not an error) while the run has none. Never success without a terminal
  // event, never the text of another run, never a cached message view.
  terminalResult(request: {
    threadId: string;
    runId: string;
    agentId: string;
  }): TerminalResult {
    const { threadId, runId, agentId } = isObject(request)
      ? request
      : ({} as Record<string, unknown>);
    const thread = requireOwner(this.runner, threadId, agentId);
    const { run, events } = readRun(this.log, thread, runId);
    const reserved = this.runner.active.get(thread)?.runId === run.runId;
    if (run.status === 'running')
      return {
        available: false,
        threadId: run.threadId,
        runId: run.runId,
        reason: reserved ? 'run_active_in_memory' : 'run_not_terminal',
      };
    const terminal = loose(events.at(-1)!.event);
    const answer = ownAssistantText(events.map((stored) => stored.event));
    const unknownOutcomeCalls = deriveAttemptFacts(
      run,
      events,
      this.runner.clientExecutableToolNames,
      'terminal',
    ).toolCalls.filter(
      (call) => call.resultProvenance === 'unknown_outcome',
    ).length;
    const base = {
      available: true as const,
      threadId: run.threadId,
      runId: run.runId,
      status: run.status,
      threadReserved: reserved,
      unknownOutcomeCalls,
    };
    switch (run.status) {
      case 'finished':
        return answer !== undefined
          ? { ...base, outcome: 'success', text: answer }
          : { ...base, outcome: 'finished_without_text' };
      case 'stopped':
        return {
          ...base,
          outcome: 'stopped',
          ...(answer !== undefined ? { partialText: answer } : {}),
        };
      case 'interrupted':
      case 'error': {
        const code = text(terminal.code);
        return {
          ...base,
          outcome:
            run.status === 'interrupted' ? 'interrupted_by_recovery' : 'failed',
          error: {
            ...(code ? { code } : {}),
            message: (text(terminal.message) ?? '').slice(0, 2048),
          },
        };
      }
    }
  }

  // The persisted runs with no terminal event that this process is not driving.
  // A thread scope checks ownership first; the global scope is for trusted
  // in-process callers. One unreadable run is reported as 'inconsistent' and
  // does not hide the others.
  unresolvedRuns(scope: UnresolvedScope): UnresolvedRunFact[] {
    const request: unknown = scope;
    let threadId: string | undefined;
    if (isObject(request) && hasExactly(request, 'all') && request.all === true)
      threadId = undefined;
    else if (isObject(request) && hasExactly(request, 'threadId', 'agentId'))
      threadId = requireOwner(this.runner, request.threadId, request.agentId);
    else throw new RunFactsError('THREAD_NOT_OWNED', undefined, undefined);
    return reading(() => {
      if (!this.log.hasSchema()) return [];
      const rows =
        threadId !== undefined
          ? this.log.runs(threadId).filter((run) => run.status === 'running')
          : this.log.runningRuns();
      const facts = rows
        .filter(
          (run) => this.runner.active.get(run.threadId)?.runId !== run.runId,
        )
        .map((run) => unresolvedFact(this.log, this.runner, run));
      // Reuse of a runId across threads is surfaced, never thrown: identity
      // is the pair.
      const seen = new Map<string, number>();
      for (const fact of facts)
        seen.set(fact.runId, (seen.get(fact.runId) ?? 0) + 1);
      for (const fact of facts)
        fact.duplicateRunId = (seen.get(fact.runId) ?? 0) > 1;
      return facts;
    }, threadId);
  }
}
