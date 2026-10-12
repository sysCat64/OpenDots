// Must stay the first import: see telemetry-guard.ts.
import './telemetry-guard.js';
import { createHash } from 'node:crypto';
import { compactEvents, verifyEvents } from '@ag-ui/client';
import type { BaseEvent } from '@ag-ui/core';
import { VERSION } from '@copilotkit/runtime/v2';
import { from, lastValueFrom, toArray } from 'rxjs';
import {
  foldEvents,
  type ConversationLog,
  type RunRow,
  type RunStatus,
  type StoredEvent,
} from './conversation-log.js';
import {
  RunFactsError,
  deriveAttemptFacts,
  runShapeIssues,
  type AttemptFacts,
  type RunFacts,
  type ShapeIssue,
  type ThreadStateFacts,
  type ThreadStateName,
  type ToolCallFact,
  type ToolResultProvenance,
} from './run-facts.js';
import {
  UNKNOWN_OUTCOME_CONTENT,
  classifyRun,
  recoveryEvents,
  type RecoveryKind,
} from './run-rules.js';

// Read-only diagnosis of unresolved durable runs (resolver phase R-DIAG).
//
// What it is: for a thread (or one run of it) it reports, from the log alone,
// what is durable, what is unknown, what a replay would do with it, and what the
// accepted resolver design WOULD append, as event TYPES. It never appends, never
// recovers, never calls a provider or a tool, never reads the derived message
// cache and never opens a transaction. Every database read happens in one
// synchronous stretch before the first await; the replay dry-run then works on
// in-memory copies, so an answer describes one instant.
//
// What it is not: it is not admission and not the resolver. It authorizes
// nothing. It never says that a run may be retried, that a result succeeded, that
// an effect was reversed, that an executor stopped, or that an unresolved thread
// is safe to release: those are not facts the log can show, and no field here
// carries them (`nonClaims` states it). Runner admission (P-ADM) is unchanged and
// a diagnosis is no substitute for it: a plain terminal append still reopens a
// thread (RC-01), which is why every result lists the admission guard as an open
// blocker.
//
// Content safety. A result holds identifiers, tool names, counts, enumerated
// reasons and digests, never a text delta, an argument, a result, reasoning or a
// state value, and never the message of an underlying error (the SDK quotes state
// in its patch errors).
//
// Authority. The runner's own ownership predicate runs, with the caller's agent
// id, before any thread-specific read. Only thread and run scopes exist.
//
// R17 is unchanged: a running row this process does not drive can be a dead run or
// the live run of another process. Authority: the resolver phase boundary
// (scratch: docs/LOCAL_FIRST_R_DIAG_BOUNDARY.md) and
// docs/LOCAL_FIRST_C4C_READONLY_AND_ADMISSION_BOUNDARY.md.

export const DIAGNOSIS_SCHEMA = 1 as const;
export const EVIDENCE_DIGEST_VERSION = 'opendots.run-evidence.v1' as const;
// The names the accepted resolver design reserves. The diagnosis only builds
// in-memory copies carrying them for its dry-run; it writes none.
const RESOLUTION_AUDIT_NAME = 'opendots.run_resolution';
const RESOLUTION_ERROR_CODE = 'RUN_ADMINISTRATIVELY_RESOLVED';
const RESOLUTION_MESSAGE =
  'Run resolved by the owner; the outcome of some of its work is not known.';
const ENGINE = `copilotkit-runtime@${String(VERSION)};diagnosis@${DIAGNOSIS_SCHEMA}`;

// ------------------------------------------------------------------- limits

export interface DiagnosisLimits {
  // Run rows of one thread.
  maxRuns: number;
  // Events of one thread: bounds the read, the clone and the synchronous checks.
  maxThreadEvents: number;
  // Events of one run.
  maxRunEvents: number;
  // Events the whole-thread reducer fold may take. The fold is super-linear in
  // thread size (about 0.3 s at 1,000 events, 0.9 s at 2,000, 14 s and 1.8 GB at
  // 7,500) and the diagnosis folds a thread twice (stored and projected), so above
  // this it is skipped and the replay is reported incomplete, never passed.
  maxReducerThreadEvents: number;
}

export const DEFAULT_DIAGNOSIS_LIMITS: DiagnosisLimits = {
  maxRuns: 5_000,
  maxThreadEvents: 50_000,
  maxRunEvents: 20_000,
  maxReducerThreadEvents: 1_000,
};

// ------------------------------------------------------------------- errors

export type RunDiagnosisErrorCode =
  'THREAD_NOT_OWNED' | 'RUN_NOT_FOUND' | 'STORAGE_UNAVAILABLE';

// Identifiers and an enumerated code only. A thread that is not owned names the
// thread only, so an existing and a missing run cannot be told apart through it.
export class RunDiagnosisError extends Error {
  constructor(
    readonly code: RunDiagnosisErrorCode,
    readonly threadId?: string,
    readonly runId?: string,
  ) {
    super(
      `${code}${threadId ? ` thread=${threadId}` : ''}${runId ? ` run=${runId}` : ''}`,
    );
    this.name = 'RunDiagnosisError';
  }
}

// -------------------------------------------------------------------- types

export type Severity = 'damaged' | 'attention' | 'info';

export type FindingCode =
  // The rows contradict each other or cannot be read (the C4c vocabulary).
  | ShapeIssue
  | 'run_seq_gap'
  // A terminal run whose effect evidence is incomplete.
  | 'terminal_server_outcome_unrecorded'
  | 'server_outcome_masked_by_synthetic_closer'
  | 'terminal_open_lifecycle'
  // Known unknowns, reported for completeness.
  | 'terminal_client_call_unanswered'
  | 'server_outcome_unknown_marker';

export interface Finding {
  code: FindingCode;
  severity: Severity;
  runId?: string;
  toolCallId?: string;
}

export type CheckResult = 'ok' | 'failed' | 'skipped_limit' | 'not_applicable';

export type ReplayReason =
  | 'verify_rejected'
  | 'state_delta_unappliable'
  | 'compact_failed'
  | 'reducer_failed'
  | 'open_text'
  | 'open_reasoning'
  | 'open_step'
  | 'open_tool_args'
  | 'server_call_without_result'
  | 'synthetic_closer_on_server_call'
  | 'marker_not_canonical';

export interface ReplayChecks {
  // failed: a check failed. incomplete: none failed and one was skipped by a
  // limit. not_run: the history is unreadable. passed: every applicable check
  // ran and passed. Never a claim about providers or a browser.
  state: 'passed' | 'failed' | 'incomplete' | 'not_run';
  // Each run through verifyEvents, as the persistence tap applies it.
  verifyEvents: CheckResult;
  // The thread as connect and getThreadEvents replay it.
  compactEvents: CheckResult;
  // The whole thread through the SDK reducer (what messagesFor derives).
  reducer: CheckResult;
  // The target run alone through the SDK reducer.
  runReducer: CheckResult;
  // No lifecycle left open at the terminal, every server call with an END has a
  // result. Evaluated for the projected history only.
  lifecycle: CheckResult;
  // No server call closed by a stock closer, markers canonical. Projected only.
  provenance: CheckResult;
  reasons: ReplayReason[];
}

export interface ReplayReport {
  // The history as stored.
  current: ReplayChecks;
  // The stored history with the proposed appends applied in memory. Null when
  // there is no plan to project.
  projected: ReplayChecks | null;
}

export type RunClass =
  | 'terminal'
  | 'active'
  | 'recoverable'
  | 'R22'
  | 'R24'
  | 'R26b'
  | 'inconsistent';

export type Acknowledgement =
  | 'server_effect_unknown'
  | 'client_call_unanswered'
  | 'incomplete_content_kept'
  | 'incomplete_tool_args_closed';

export type PlanStatus =
  'proposed' | 'on_hold' | 'not_possible' | 'closed_by_recovery' | 'not_needed';

export type BlockerCode =
  | 'RESOLVER_NOT_AVAILABLE'
  | 'ADMISSION_GUARD_NOT_IMPLEMENTED'
  | 'LIVENESS_UNPROVEN'
  | 'HITL_RELEASE_HOLD'
  | 'PROVIDER_HISTORY_UNVERIFIED'
  | 'STATE_REPLAY_UNAPPLIABLE'
  | 'REPLAY_CHECK_FAILED'
  | 'REPLAY_CHECK_INCOMPLETE'
  | 'HISTORY_INCONSISTENT'
  | 'RUN_ACTIVE_IN_MEMORY'
  | 'FACTS_DISAGREE'
  | 'RESOURCE_LIMIT_EXCEEDED';

// A fixed order, so a result is stable and comparable.
const BLOCKER_ORDER: readonly BlockerCode[] = [
  'RESOURCE_LIMIT_EXCEEDED',
  'HISTORY_INCONSISTENT',
  'FACTS_DISAGREE',
  'RUN_ACTIVE_IN_MEMORY',
  'STATE_REPLAY_UNAPPLIABLE',
  'REPLAY_CHECK_FAILED',
  'REPLAY_CHECK_INCOMPLETE',
  'HITL_RELEASE_HOLD',
  'PROVIDER_HISTORY_UNVERIFIED',
  'LIVENESS_UNPROVEN',
  'ADMISSION_GUARD_NOT_IMPLEMENTED',
  'RESOLVER_NOT_AVAILABLE',
];

export interface ProposedPlan {
  status: PlanStatus;
  // Event TYPES in append order. Never events, never content.
  eventTypes: string[];
  terminalStatus: 'interrupted' | 'finished' | null;
  // What an owner would have to acknowledge, by name.
  requiredAcknowledgements: Acknowledgement[];
  // Binds the evidence digest, the types and the engine. Null without evidence.
  digest: string | null;
}

export interface ToolCallDiagnosis {
  toolCallId: string;
  toolName: string;
  side: 'client' | 'server';
  phase: ToolCallFact['phase'];
  executorEntry: ToolCallFact['executorEntry'];
  provenance: ToolResultProvenance;
  // known: the log holds what the tool returned. unknown: the executor may have
  // entered and no result is recorded (a marker or a stock closer is not one).
  // not_executed: proven, the arguments never completed. client_side: a client
  // tool, nothing server-side ran.
  knowledge: 'known' | 'unknown' | 'not_executed' | 'client_side';
}

// Explicit non-claims. None of these is a fact the log can show.
export interface NonClaims {
  retryPermitted: 'not_established';
  executorStopped: 'not_established';
  effectsReversed: 'not_established';
  releaseAuthorized: 'not_established';
}

const NON_CLAIMS: NonClaims = Object.freeze({
  retryPermitted: 'not_established',
  executorStopped: 'not_established',
  effectsReversed: 'not_established',
  releaseAuthorized: 'not_established',
});

export interface EvidenceBinding {
  digestVersion: typeof EVIDENCE_DIGEST_VERSION;
  // The chain value over every event of the run. Null when an event cannot be
  // read.
  digest: string | null;
  eventCount: number | null;
  // The newest event id the diagnosis read, to correlate later reads.
  lastEventId: number;
  // Binds every run of the thread: id, seq, status, count, digest.
  threadDigest: string;
  engine: string;
}

export interface RunDiagnosisReport {
  schema: typeof DIAGNOSIS_SCHEMA;
  advisory: true;
  outcome: 'diagnosed';
  threadId: string;
  runId: string;
  agentId: string;
  runSeq: number;
  authoritativeStatus: RunStatus;
  lifecycle: AttemptFacts['lifecycle'];
  classification: {
    class: RunClass;
    recoveryKind?: RecoveryKind;
    deferred: boolean;
  };
  integrity: { state: 'consistent' | 'damaged'; issues: ShapeIssue[] };
  toolLifecycle: {
    calls: ToolCallDiagnosis[];
    serverCalls: number;
    clientCalls: number;
  };
  executor: { entryPossible: number };
  hitl: {
    pendingClientCalls: Array<{ toolCallId: string; toolName: string }>;
  };
  lifecycles: {
    openText: number;
    openReasoning: number;
    openSteps: number;
    incompleteArgsCalls: number;
    stateEvents: number;
    activityEvents: number;
    customEvents: number;
    rawEvents: number;
    otherFamilies: string[];
  };
  terminal: { eventType: 'RUN_FINISHED' | 'RUN_ERROR'; code?: string } | null;
  findings: Finding[];
  thread: {
    integrity: 'consistent' | 'damaged';
    effectEvidence: 'complete' | 'gaps';
    runCount: number;
    eventCount: number;
  };
  replay: ReplayReport;
  plan: ProposedPlan;
  evidence: EvidenceBinding;
  blockers: BlockerCode[];
  nonClaims: NonClaims;
}

export interface RunSummary {
  runId: string;
  seq: number;
  status: RunStatus;
  class: RunClass;
  eventCount: number | null;
  digest: string | null;
  integrity: 'consistent' | 'damaged';
  findingCodes: FindingCode[];
}

export interface ThreadDiagnosis {
  schema: typeof DIAGNOSIS_SCHEMA;
  advisory: true;
  outcome: 'diagnosed';
  threadId: string;
  agentId: string;
  // The committed facts' thread state at the same instant, or 'unknown' when the
  // facts could not answer.
  state: ThreadStateName | 'unknown';
  integrity: { state: 'consistent' | 'damaged'; findings: Finding[] };
  effectEvidence: { state: 'complete' | 'gaps'; findings: Finding[] };
  runs: RunSummary[];
  unresolved: RunDiagnosisReport[];
  replay: { current: ReplayChecks };
  evidence: {
    digestVersion: typeof EVIDENCE_DIGEST_VERSION;
    threadDigest: string;
    runCount: number;
    eventCount: number;
    lastEventId: number;
    engine: string;
  };
  limits: DiagnosisLimits;
  blockers: BlockerCode[];
  nonClaims: NonClaims;
}

// A limit was exceeded. Never partial: nothing else is reported.
export interface RefusedDiagnosis {
  schema: typeof DIAGNOSIS_SCHEMA;
  advisory: true;
  outcome: 'refused';
  threadId: string;
  runId?: string;
  limit: keyof DiagnosisLimits;
  observed: number;
  allowed: number;
  blockers: ['RESOURCE_LIMIT_EXCEEDED'];
  nonClaims: NonClaims;
}

export type RunDiagnosisResult = RunDiagnosisReport | RefusedDiagnosis;
export type ThreadDiagnosisResult = ThreadDiagnosis | RefusedDiagnosis;

export type EvidenceConfirmation =
  | {
      schema: typeof DIAGNOSIS_SCHEMA;
      advisory: true;
      current: true;
      digest: string;
      status: RunStatus;
      eventCount: number;
    }
  | {
      schema: typeof DIAGNOSIS_SCHEMA;
      advisory: true;
      current: false;
      reason:
        | 'evidence_changed'
        | 'digest_malformed'
        | 'run_unreadable'
        | 'resource_limit_exceeded';
    };

export interface RunDiagnosisDeps {
  // A structural subset: reads only, so a writer cannot be passed by mistake.
  log: Pick<ConversationLog, 'hasSchema' | 'runs' | 'runEvents'>;
  // The runner's read-only facts and its ownership predicate (the one run()
  // uses). The facts are read for the thread state and as a cross-check.
  runner: {
    readonly facts: RunFacts;
    ownsThread(threadId: string, agentId: string): boolean;
  };
  // The server-owned set the runner was constructed with. Cross-checked against
  // the runner's own facts: a mismatch fails closed (FACTS_DISAGREE).
  clientExecutableToolNames: ReadonlySet<string>;
  limits?: Partial<DiagnosisLimits>;
}

// ------------------------------------------------------- canonical + digest

// RFC 8785-style canonical JSON over a parsed value: object keys sorted by UTF-16
// code unit, no whitespace, arrays in order. Anything JSON.parse cannot produce
// (undefined, a non-finite number, a function) is an error, never a guess.
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value))
        throw new TypeError('A non-finite number has no canonical form');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value))
        return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
        .join(',')}}`;
    }
    default:
      throw new TypeError(`A ${typeof value} has no canonical form`);
  }
}

const sha256 = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex');

export interface EvidenceIdentity {
  threadId: string;
  runId: string;
  agentId: string;
  runSeq: number;
  startedAt: number;
}

// The run's evidence chain: element 0 binds the immutable identity, element i+1
// binds element i and event i (by the run's own seq, never the commit id). The
// digest of the first k events is element k, so an event appended after position
// k, such as a resolution audit, is outside the digest of everything before it by
// construction. The run's status is NOT in the chain: it changes at resolution.
export function runEvidenceChain(
  identity: EvidenceIdentity,
  events: readonly BaseEvent[],
): string[] {
  const chain = [
    sha256(
      `${EVIDENCE_DIGEST_VERSION}\n${canonicalJson({
        threadId: identity.threadId,
        runId: identity.runId,
        agentId: identity.agentId,
        runSeq: identity.runSeq,
        startedAt: identity.startedAt,
      })}`,
    ),
  ];
  events.forEach((event, seq) => {
    chain.push(sha256(`${chain[seq]}\n${canonicalJson({ seq, event })}`));
  });
  return chain;
}

// ---------------------------------------------------------- pure derivations

type Loose = { type: string; [field: string]: unknown };
const loose = (event: BaseEvent) => event as unknown as Loose;
const text = (value: unknown) =>
  typeof value === 'string' ? value : undefined;

interface CallScan {
  name: string;
  ended: boolean;
}
interface LifecycleScan {
  openText: string[];
  openReasoningMessages: string[];
  openReasoning: string[];
  openSteps: string[];
  calls: Map<string, CallScan>;
  stateEvents: number;
  activityEvents: number;
  customEvents: number;
  rawEvents: number;
  hasStateDelta: boolean;
}

function scanLifecycles(events: readonly BaseEvent[]): LifecycleScan {
  const openText = new Set<string>();
  const openMessages = new Set<string>();
  const openReasoning = new Set<string>();
  const steps = new Map<string, number>();
  const scan: LifecycleScan = {
    openText: [],
    openReasoningMessages: [],
    openReasoning: [],
    openSteps: [],
    calls: new Map(),
    stateEvents: 0,
    activityEvents: 0,
    customEvents: 0,
    rawEvents: 0,
    hasStateDelta: false,
  };
  for (const event of events.map(loose)) {
    const messageId = text(event.messageId);
    const toolCallId = text(event.toolCallId);
    switch (event.type) {
      case 'TEXT_MESSAGE_START':
        if (messageId !== undefined) openText.add(messageId);
        break;
      case 'TEXT_MESSAGE_END':
        if (messageId !== undefined) openText.delete(messageId);
        break;
      case 'REASONING_START':
        if (messageId !== undefined) openReasoning.add(messageId);
        break;
      case 'REASONING_END':
        if (messageId !== undefined) openReasoning.delete(messageId);
        break;
      case 'REASONING_MESSAGE_START':
        if (messageId !== undefined) openMessages.add(messageId);
        break;
      case 'REASONING_MESSAGE_END':
        if (messageId !== undefined) openMessages.delete(messageId);
        break;
      case 'STEP_STARTED': {
        const name = text(event.stepName);
        if (name !== undefined) steps.set(name, (steps.get(name) ?? 0) + 1);
        break;
      }
      case 'STEP_FINISHED': {
        const name = text(event.stepName);
        if (name !== undefined && (steps.get(name) ?? 0) > 0)
          steps.set(name, steps.get(name)! - 1);
        break;
      }
      case 'TOOL_CALL_START':
        if (toolCallId !== undefined && !scan.calls.has(toolCallId))
          scan.calls.set(toolCallId, {
            name: text(event.toolCallName) ?? '',
            ended: false,
          });
        break;
      case 'TOOL_CALL_END':
        if (toolCallId !== undefined && scan.calls.has(toolCallId))
          scan.calls.get(toolCallId)!.ended = true;
        break;
      case 'STATE_SNAPSHOT':
        scan.stateEvents++;
        break;
      case 'STATE_DELTA':
        scan.stateEvents++;
        scan.hasStateDelta = true;
        break;
      case 'MESSAGES_SNAPSHOT':
      case 'ACTIVITY_SNAPSHOT':
      case 'ACTIVITY_DELTA':
        scan.activityEvents++;
        break;
      case 'CUSTOM':
        scan.customEvents++;
        break;
      case 'RAW':
        scan.rawEvents++;
        break;
      default:
        break;
    }
  }
  scan.openText = [...openText];
  scan.openReasoningMessages = [...openMessages];
  scan.openReasoning = [...openReasoning];
  scan.openSteps = [...steps.entries()].flatMap(([name, count]) =>
    Array<string>(count).fill(name),
  );
  return scan;
}

// What the accepted design would append, built only in memory so the dry-run has
// something to replay. It is never exported and never handed to a log. A later,
// separately reviewed resolver must derive its batch from this same projection.
interface Projection {
  events: BaseEvent[];
  types: string[];
  acknowledgements: Acknowledgement[];
}

const stockCloserContent = JSON.stringify({
  status: 'error',
  reason: 'missing_terminal_event',
  message:
    'The tool call arguments were incomplete when the run ended; the tool did not run.',
});

function project(input: {
  scan: LifecycleScan;
  attempt: AttemptFacts;
  prefixCount: number;
  prefixDigest: string;
}): Projection {
  const { scan, attempt } = input;
  const acknowledgements: Acknowledgement[] = [];
  const closers: BaseEvent[] = [];
  const event = (value: Record<string, unknown>) =>
    value as unknown as BaseEvent;
  for (const messageId of scan.openText)
    closers.push(event({ type: 'TEXT_MESSAGE_END', messageId }));
  for (const messageId of scan.openReasoningMessages)
    closers.push(event({ type: 'REASONING_MESSAGE_END', messageId }));
  for (const messageId of scan.openReasoning)
    closers.push(event({ type: 'REASONING_END', messageId }));
  for (const stepName of scan.openSteps)
    closers.push(event({ type: 'STEP_FINISHED', stepName }));
  if (scan.openText.length || scan.openReasoning.length)
    acknowledgements.push('incomplete_content_kept');
  // A call whose arguments never completed: the fence kept its executor from
  // starting, so it is closed the way the stock finalizer closes it. Which
  // closer to reuse is an owner decision; this is the shape the stock one has.
  const incomplete = [...scan.calls.entries()].filter(
    ([, call]) => !call.ended,
  );
  for (const [toolCallId] of incomplete) {
    closers.push(event({ type: 'TOOL_CALL_END', toolCallId }));
    closers.push(
      event({
        type: 'TOOL_CALL_RESULT',
        toolCallId,
        messageId: `${toolCallId}-result`,
        role: 'tool',
        content: stockCloserContent,
      }),
    );
  }
  if (incomplete.length) acknowledgements.push('incomplete_tool_args_closed');
  // A server call with an END and no result: the tool may have run. It gets the
  // runner's own unknown-outcome marker, never success and never failure.
  const unknown = attempt.toolCalls.filter(
    (call) => call.side === 'server' && call.phase === 'args_complete',
  );
  for (const call of unknown)
    closers.push(
      event({
        type: 'TOOL_CALL_RESULT',
        toolCallId: call.toolCallId,
        messageId: `${call.toolCallId}-unknown-outcome`,
        role: 'tool',
        content: UNKNOWN_OUTCOME_CONTENT,
      }),
    );
  if (unknown.length) acknowledgements.push('server_effect_unknown');
  // A client call is left exactly as it is: no answer is invented for a human.
  if (
    attempt.toolCalls.some(
      (call) => call.side === 'client' && call.phase === 'args_complete',
    )
  )
    acknowledgements.push('client_call_unanswered');
  const terminal = event({
    type: 'RUN_ERROR',
    message: RESOLUTION_MESSAGE,
    code: RESOLUTION_ERROR_CODE,
  });
  const audit = event({
    type: 'CUSTOM',
    name: RESOLUTION_AUDIT_NAME,
    value: {
      schema: 1,
      prefixCount: input.prefixCount,
      prefixDigest: input.prefixDigest,
      acknowledgements,
    },
  });
  const events = [audit, ...closers, terminal];
  const order: Acknowledgement[] = [
    'server_effect_unknown',
    'client_call_unanswered',
    'incomplete_content_kept',
    'incomplete_tool_args_closed',
  ];
  return {
    events,
    types: events.map((item) => item.type as string),
    acknowledgements: order.filter((name) => acknowledgements.includes(name)),
  };
}

// ------------------------------------------------------------- replay checks

const emptyChecks = (
  state: ReplayChecks['state'],
  value: CheckResult,
): ReplayChecks => ({
  state,
  verifyEvents: value,
  compactEvents: value,
  reducer: value,
  runReducer: value,
  lifecycle: value,
  provenance: value,
  reasons: [],
});

const copy = <T>(value: T): T => structuredClone(value);

// failed beats incomplete beats passed. An unreadable history never reaches this:
// it is `not_run`.
function stateOf(
  results: readonly CheckResult[],
): 'passed' | 'failed' | 'incomplete' {
  return results.includes('failed')
    ? 'failed'
    : results.includes('skipped_limit')
      ? 'incomplete'
      : 'passed';
}

async function verifies(events: readonly BaseEvent[]): Promise<boolean> {
  try {
    await lastValueFrom(
      from(copy(events)).pipe(verifyEvents(false), toArray()),
      {
        defaultValue: [],
      },
    );
    return true;
  } catch {
    return false;
  }
}

async function folds(events: readonly BaseEvent[]): Promise<boolean> {
  try {
    await foldEvents(copy(events));
    return true;
  } catch {
    return false;
  }
}

interface ReplayRun {
  runId: string;
  events: readonly BaseEvent[];
}

// The mechanical replay of a thread: what verifyEvents, the connect endpoint's
// compaction and the message reducer do with it. `target` adds the run-alone
// reducer. Everything is applied to copies.
async function replayChecks(
  runs: readonly ReplayRun[],
  target: ReplayRun | undefined,
  limits: DiagnosisLimits,
): Promise<ReplayChecks> {
  const reasons = new Set<ReplayReason>();
  let verifyResult: CheckResult = 'ok';
  for (const run of runs)
    if (!(await verifies(run.events))) {
      verifyResult = 'failed';
      reasons.add('verify_rejected');
      break;
    }
  const all = runs.flatMap((run) => run.events);
  let compactResult: CheckResult = 'ok';
  try {
    compactEvents(copy(all));
  } catch {
    compactResult = 'failed';
    reasons.add(
      all.some((event) => loose(event).type === 'STATE_DELTA')
        ? 'state_delta_unappliable'
        : 'compact_failed',
    );
  }
  let reducerResult: CheckResult;
  if (all.length > limits.maxReducerThreadEvents)
    reducerResult = 'skipped_limit';
  else if (await folds(all)) reducerResult = 'ok';
  else {
    reducerResult = 'failed';
    reasons.add('reducer_failed');
  }
  let runReducerResult: CheckResult = 'not_applicable';
  if (target) {
    if (await folds(target.events)) runReducerResult = 'ok';
    else {
      runReducerResult = 'failed';
      reasons.add('reducer_failed');
    }
  }
  return {
    state: stateOf([
      verifyResult,
      compactResult,
      reducerResult,
      runReducerResult,
    ]),
    verifyEvents: verifyResult,
    compactEvents: compactResult,
    reducer: reducerResult,
    runReducer: runReducerResult,
    lifecycle: 'not_applicable',
    provenance: 'not_applicable',
    reasons: [...reasons],
  };
}

// The thread's replay (already computed) plus the target run alone through the
// reducer, so a diagnosis of several runs does not repeat the thread's checks.
async function withRunReducer(
  base: ReplayChecks,
  events: readonly BaseEvent[],
): Promise<ReplayChecks> {
  const ok = await folds(events);
  const reasons = new Set(base.reasons);
  if (!ok) reasons.add('reducer_failed');
  const runReducer: CheckResult = ok ? 'ok' : 'failed';
  return {
    ...base,
    runReducer,
    reasons: [...reasons],
    state: stateOf([
      base.verifyEvents,
      base.compactEvents,
      base.reducer,
      runReducer,
    ]),
  };
}

// The OpenDots checks verifyEvents does not make, on the projected history.
function projectedGuarantees(
  prefix: AttemptFacts,
  projected: readonly BaseEvent[],
): {
  lifecycle: CheckResult;
  provenance: CheckResult;
  reasons: ReplayReason[];
} {
  const reasons: ReplayReason[] = [];
  const scan = scanLifecycles(projected);
  if (scan.openText.length) reasons.push('open_text');
  if (scan.openReasoning.length || scan.openReasoningMessages.length)
    reasons.push('open_reasoning');
  if (scan.openSteps.length) reasons.push('open_step');
  if ([...scan.calls.values()].some((call) => !call.ended))
    reasons.push('open_tool_args');
  const results = new Map<string, Loose[]>();
  for (const event of projected.map(loose))
    if (event.type === 'TOOL_CALL_RESULT') {
      const id = text(event.toolCallId);
      if (id !== undefined)
        results.set(id, [...(results.get(id) ?? []), event]);
    }
  const lifecycle: ReplayReason[] = [];
  const provenance: ReplayReason[] = [];
  for (const call of prefix.toolCalls) {
    if (call.side !== 'server' || call.phase === 'args_open') continue;
    // An END in the prefix: the executor may have run.
    const outcome = results.get(call.toolCallId) ?? [];
    if (!outcome.length) {
      lifecycle.push('server_call_without_result');
      continue;
    }
    if (call.phase === 'result_recorded') continue;
    const canonical = outcome.every(
      (event) =>
        text(event.messageId) === `${call.toolCallId}-unknown-outcome` &&
        text(event.content) === UNKNOWN_OUTCOME_CONTENT,
    );
    if (!canonical) {
      const stock = outcome.some(
        (event) => text(event.messageId) === `${call.toolCallId}-result`,
      );
      provenance.push(
        stock ? 'synthetic_closer_on_server_call' : 'marker_not_canonical',
      );
    }
  }
  const lifecycleFailed = reasons.length > 0 || lifecycle.length > 0;
  return {
    lifecycle: lifecycleFailed ? 'failed' : 'ok',
    provenance: provenance.length ? 'failed' : 'ok',
    reasons: [...reasons, ...lifecycle, ...provenance],
  };
}

// ------------------------------------------------------------------- reading

const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value !== '';
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const hasExactly = (value: Record<string, unknown>, ...keys: string[]) => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
};

interface RunRead {
  run: RunRow;
  // Null when an event could not be parsed.
  events: StoredEvent[] | null;
  issues: ShapeIssue[];
}

type Reading =
  | {
      kind: 'read';
      runs: RunRead[];
      eventCount: number;
      lastEventId: number;
    }
  | {
      kind: 'refused';
      limit: keyof DiagnosisLimits;
      observed: number;
      allowed: number;
    };

interface Prepared {
  analyses: Analysis[];
  eventCount: number;
  lastEventId: number;
  facts: ThreadStateFacts | null;
  activeRunId: string | undefined;
  // At least one run's events could not be parsed: no replay is attempted.
  unreadable: boolean;
}

interface Analysis {
  read: RunRead;
  lifecycle: AttemptFacts['lifecycle'];
  damaged: boolean;
  attempt: AttemptFacts | null;
  scan: LifecycleScan | null;
  rawEvents: BaseEvent[] | null;
  chain: string[] | null;
  digest: string | null;
  findings: Finding[];
  klass: RunClass;
  recoveryKind?: RecoveryKind;
  deferred: boolean;
  disagrees: boolean;
}

const SEVERITY: Record<FindingCode, Severity> = {
  event_unreadable: 'damaged',
  unknown_status: 'damaged',
  run_without_events: 'damaged',
  first_event_not_run_started: 'damaged',
  identity_mismatch: 'damaged',
  seq_gap: 'damaged',
  multiple_terminal_events: 'damaged',
  events_after_terminal: 'damaged',
  status_without_terminal: 'damaged',
  terminal_without_status: 'damaged',
  status_terminal_mismatch: 'damaged',
  run_seq_gap: 'damaged',
  terminal_server_outcome_unrecorded: 'attention',
  server_outcome_masked_by_synthetic_closer: 'attention',
  terminal_open_lifecycle: 'attention',
  terminal_client_call_unanswered: 'info',
  server_outcome_unknown_marker: 'info',
};

const finding = (
  code: FindingCode,
  runId?: string,
  toolCallId?: string,
): Finding => ({
  code,
  severity: SEVERITY[code],
  ...(runId !== undefined ? { runId } : {}),
  ...(toolCallId !== undefined ? { toolCallId } : {}),
});

function knowledgeOf(call: ToolCallFact): ToolCallDiagnosis['knowledge'] {
  if (call.side === 'client') return 'client_side';
  if (call.resultProvenance === 'recorded') return 'known';
  if (call.executorEntry === 'not_possible') return 'not_executed';
  return 'unknown';
}

function openRuleClass(attempt: AttemptFacts): RunClass {
  const recovery = attempt.recovery;
  if (!recovery || !recovery.deferred) return 'recoverable';
  if (recovery.openRule === 'R22') return 'R22';
  if (recovery.openRule === 'R24') return 'R24';
  return 'R26b';
}

function terminalFindings(
  runId: string,
  attempt: AttemptFacts,
  scan: LifecycleScan,
): Finding[] {
  const found: Finding[] = [];
  const openCall = attempt.toolCalls.some((call) => call.phase === 'args_open');
  if (
    scan.openText.length ||
    scan.openReasoning.length ||
    scan.openReasoningMessages.length ||
    scan.openSteps.length ||
    openCall
  )
    found.push(finding('terminal_open_lifecycle', runId));
  for (const call of attempt.toolCalls) {
    if (call.side === 'client') {
      if (call.phase === 'args_complete')
        found.push(
          finding('terminal_client_call_unanswered', runId, call.toolCallId),
        );
      continue;
    }
    if (call.phase === 'args_complete' && call.resultProvenance === 'none')
      found.push(
        finding('terminal_server_outcome_unrecorded', runId, call.toolCallId),
      );
    else if (call.resultProvenance === 'synthetic_closer')
      found.push(
        finding(
          'server_outcome_masked_by_synthetic_closer',
          runId,
          call.toolCallId,
        ),
      );
    else if (call.resultProvenance === 'unknown_outcome')
      found.push(
        finding('server_outcome_unknown_marker', runId, call.toolCallId),
      );
  }
  return found;
}

// ------------------------------------------------------------------- service

export class RunDiagnosis {
  private readonly limits: DiagnosisLimits;

  constructor(private readonly deps: RunDiagnosisDeps) {
    this.limits = { ...DEFAULT_DIAGNOSIS_LIMITS, ...deps.limits };
  }

  // The thread: integrity and effect evidence of EVERY run, the replay of the
  // stored history, and a full diagnosis of each nonterminal run this process
  // does not drive.
  async diagnoseThread(request: {
    threadId: string;
    agentId: string;
  }): Promise<ThreadDiagnosisResult> {
    const { threadId, agentId } = this.parseThread(request);
    const prepared = this.prepare(threadId, agentId);
    if (prepared.kind === 'refused')
      return this.refused(threadId, undefined, prepared);
    return (await this.assemble(threadId, agentId, prepared, undefined)).thread;
  }

  // One run, in the context of its thread.
  async diagnoseRun(request: {
    threadId: string;
    runId: string;
    agentId: string;
  }): Promise<RunDiagnosisResult> {
    const { threadId, runId, agentId } = this.parseRun(request, false);
    const prepared = this.prepare(threadId, agentId);
    if (prepared.kind === 'refused')
      return this.refused(threadId, runId, prepared);
    if (!prepared.analyses.some((one) => one.read.run.runId === runId))
      throw new RunDiagnosisError('RUN_NOT_FOUND', threadId, runId);
    return (await this.assemble(threadId, agentId, prepared, runId)).run!;
  }

  // Whether the evidence a caller saw is still the run's evidence. A read: it
  // recomputes the digest and compares. A future resolver repeats the comparison
  // inside its own transaction.
  async confirmEvidence(request: {
    threadId: string;
    runId: string;
    agentId: string;
    digest: string;
  }): Promise<EvidenceConfirmation> {
    const { threadId, runId, digest } = this.parseRun(request, true);
    const base = { schema: DIAGNOSIS_SCHEMA, advisory: true } as const;
    const found = this.read(() => {
      if (!this.deps.log.hasSchema()) return undefined;
      const run = this.deps.log.runs(threadId).find((r) => r.runId === runId);
      if (!run) return undefined;
      try {
        return { run, events: this.deps.log.runEvents(threadId, runId) };
      } catch (error) {
        if (error instanceof SyntaxError) return { run, events: null };
        throw error;
      }
    });
    if (!found) throw new RunDiagnosisError('RUN_NOT_FOUND', threadId, runId);
    if (!/^[0-9a-f]{64}$/.test(digest))
      return { ...base, current: false, reason: 'digest_malformed' };
    if (!found.events)
      return { ...base, current: false, reason: 'run_unreadable' };
    if (found.events.length > this.limits.maxRunEvents)
      return { ...base, current: false, reason: 'resource_limit_exceeded' };
    const chain = runEvidenceChain(
      this.identityOf(found.run),
      found.events.map((stored) => stored.event),
    );
    return chain.at(-1) === digest
      ? {
          ...base,
          current: true,
          digest,
          status: found.run.status,
          eventCount: found.events.length,
        }
      : { ...base, current: false, reason: 'evidence_changed' };
  }

  // ----------------------------------------------------------- request checks

  private owned(threadId: unknown, agentId: unknown): string {
    let owns = false;
    if (nonEmpty(threadId) && nonEmpty(agentId)) {
      try {
        owns = this.deps.runner.ownsThread(threadId, agentId) === true;
      } catch {
        owns = false;
      }
    }
    if (!owns)
      throw new RunDiagnosisError(
        'THREAD_NOT_OWNED',
        nonEmpty(threadId) ? threadId : undefined,
      );
    return threadId as string;
  }

  private parseThread(request: unknown): { threadId: string; agentId: string } {
    if (!isObject(request) || !hasExactly(request, 'threadId', 'agentId'))
      throw new RunDiagnosisError('THREAD_NOT_OWNED');
    const threadId = this.owned(request.threadId, request.agentId);
    return { threadId, agentId: request.agentId as string };
  }

  private parseRun(
    request: unknown,
    withDigest: true,
  ): { threadId: string; runId: string; agentId: string; digest: string };
  private parseRun(
    request: unknown,
    withDigest: false,
  ): { threadId: string; runId: string; agentId: string };
  private parseRun(request: unknown, withDigest: boolean) {
    const keys = withDigest
      ? ['threadId', 'runId', 'agentId', 'digest']
      : ['threadId', 'runId', 'agentId'];
    if (!isObject(request) || !hasExactly(request, ...keys))
      throw new RunDiagnosisError('THREAD_NOT_OWNED');
    const threadId = this.owned(request.threadId, request.agentId);
    if (!nonEmpty(request.runId))
      throw new RunDiagnosisError('RUN_NOT_FOUND', threadId);
    return {
      threadId,
      runId: request.runId,
      agentId: request.agentId as string,
      ...(withDigest ? { digest: String(request.digest) } : {}),
    };
  }

  private read<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      if (error instanceof RunDiagnosisError) throw error;
      throw new RunDiagnosisError('STORAGE_UNAVAILABLE');
    }
  }

  private identityOf(run: RunRow): EvidenceIdentity {
    return {
      threadId: run.threadId,
      runId: run.runId,
      agentId: run.agentId,
      runSeq: run.seq,
      startedAt: run.startedAt,
    };
  }

  private refused(
    threadId: string,
    runId: string | undefined,
    reading: Extract<Reading, { kind: 'refused' }>,
  ): RefusedDiagnosis {
    return {
      schema: DIAGNOSIS_SCHEMA,
      advisory: true,
      outcome: 'refused',
      threadId,
      ...(runId !== undefined ? { runId } : {}),
      limit: reading.limit,
      observed: reading.observed,
      allowed: reading.allowed,
      blockers: ['RESOURCE_LIMIT_EXCEEDED'],
      nonClaims: NON_CLAIMS,
    };
  }

  // ---------------------------------------------------- the synchronous read

  // Everything the answer depends on is read here, with no await, so it is one
  // consistent view of this process's database connection. Only after this does
  // the dry-run begin, on copies.
  private prepare(
    threadId: string,
    agentId: string,
  ): Extract<Reading, { kind: 'refused' }> | (Prepared & { kind: 'ready' }) {
    const reading = this.read((): Reading => {
      const { log } = this.deps;
      if (!log.hasSchema())
        return { kind: 'read', runs: [], eventCount: 0, lastEventId: 0 };
      const rows = log.runs(threadId);
      if (rows.length > this.limits.maxRuns)
        return {
          kind: 'refused',
          limit: 'maxRuns',
          observed: rows.length,
          allowed: this.limits.maxRuns,
        };
      const runs: RunRead[] = [];
      let eventCount = 0;
      let lastEventId = 0;
      for (const run of rows) {
        let events: StoredEvent[] | null;
        try {
          events = log.runEvents(threadId, run.runId);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          events = null;
        }
        if (events) {
          if (events.length > this.limits.maxRunEvents)
            return {
              kind: 'refused',
              limit: 'maxRunEvents',
              observed: events.length,
              allowed: this.limits.maxRunEvents,
            };
          eventCount += events.length;
          if (eventCount > this.limits.maxThreadEvents)
            return {
              kind: 'refused',
              limit: 'maxThreadEvents',
              observed: eventCount,
              allowed: this.limits.maxThreadEvents,
            };
          for (const stored of events)
            lastEventId = Math.max(lastEventId, stored.id);
        }
        runs.push({
          run,
          events,
          issues: events ? runShapeIssues(run, events) : ['event_unreadable'],
        });
      }
      return { kind: 'read', runs, eventCount, lastEventId };
    });
    if (reading.kind === 'refused') return reading;

    let facts: ThreadStateFacts | null = null;
    try {
      facts = this.deps.runner.facts.threadState(threadId, agentId);
    } catch (error) {
      if (error instanceof RunFactsError) {
        if (error.code === 'THREAD_NOT_OWNED')
          throw new RunDiagnosisError('THREAD_NOT_OWNED', threadId);
        if (error.code === 'STORAGE_UNAVAILABLE')
          throw new RunDiagnosisError('STORAGE_UNAVAILABLE', threadId);
        facts = null;
      } else throw new RunDiagnosisError('STORAGE_UNAVAILABLE', threadId);
    }
    const activeRunId = facts?.active?.runId;
    const analyses = reading.runs.map((read) =>
      this.analyze(read, activeRunId, facts),
    );
    return {
      kind: 'ready',
      analyses,
      eventCount: reading.eventCount,
      lastEventId: reading.lastEventId,
      facts,
      activeRunId,
      unreadable: analyses.some((one) => one.read.events === null),
    };
  }

  private analyze(
    read: RunRead,
    activeRunId: string | undefined,
    facts: ThreadStateFacts | null,
  ): Analysis {
    const { run } = read;
    const lifecycle: AttemptFacts['lifecycle'] =
      run.runId === activeRunId
        ? 'active_in_memory'
        : run.status === 'running'
          ? 'nonterminal_not_active'
          : 'terminal';
    const damagedFindings = read.issues.map((code) => finding(code, run.runId));
    if (read.events === null || read.issues.length) {
      const raw = read.events?.map((stored) => stored.event) ?? null;
      const chain = raw ? runEvidenceChain(this.identityOf(run), raw) : null;
      return {
        read,
        lifecycle,
        damaged: true,
        attempt: null,
        scan: null,
        rawEvents: raw,
        chain,
        digest: chain?.at(-1) ?? null,
        findings: damagedFindings,
        klass: 'inconsistent',
        deferred: true,
        disagrees: false,
      };
    }
    const raw = read.events.map((stored) => stored.event);
    const attempt = deriveAttemptFacts(
      run,
      read.events,
      this.deps.clientExecutableToolNames,
      lifecycle,
    );
    const scan = scanLifecycles(raw);
    const chain = runEvidenceChain(this.identityOf(run), raw);
    const base = {
      read,
      lifecycle,
      damaged: false,
      attempt,
      scan,
      rawEvents: raw,
      chain,
      digest: chain.at(-1)!,
    };
    if (lifecycle === 'terminal')
      return {
        ...base,
        findings: terminalFindings(run.runId, attempt, scan),
        klass: 'terminal',
        deferred: false,
        disagrees: false,
      };
    if (lifecycle === 'active_in_memory')
      return {
        ...base,
        findings: [],
        klass: 'active',
        deferred: false,
        disagrees: false,
      };
    // A nonterminal run this process does not drive. The runner's own facts
    // must agree with this classification, or the configuration differs.
    const mine = classifyRun(raw, this.deps.clientExecutableToolNames);
    const theirs = facts?.unresolved.find((fact) => fact.runId === run.runId);
    const disagrees =
      !theirs ||
      theirs.kind !== mine.kind ||
      (theirs.disposition === 'deferred') !== mine.deferred;
    if (disagrees)
      return {
        ...base,
        findings: [],
        klass: 'inconsistent',
        deferred: true,
        disagrees: true,
      };
    return {
      ...base,
      findings: [],
      klass: openRuleClass(attempt),
      recoveryKind: mine.kind,
      deferred: mine.deferred,
      disagrees: false,
    };
  }

  // -------------------------------------------------------- the asynchronous

  private async assemble(
    threadId: string,
    agentId: string,
    prepared: Prepared,
    targetRunId: string | undefined,
  ): Promise<{ thread: ThreadDiagnosis; run?: RunDiagnosisReport }> {
    const { analyses, activeRunId } = prepared;
    const limits = this.limits;
    const replayable = analyses
      .filter(
        (one) => one.rawEvents !== null && one.read.run.runId !== activeRunId,
      )
      .map((one) => ({
        runId: one.read.run.runId,
        events: one.rawEvents as BaseEvent[],
      }));
    const findings = analyses.flatMap((one) => one.findings);
    const seqs = analyses.map((one) => one.read.run.seq);
    const seqGap = seqs.some((seq, index) => seq !== index + 1);
    const threadFindings = seqGap
      ? [finding('run_seq_gap'), ...findings]
      : findings;
    const integrityFindings = threadFindings.filter(
      (item) => item.severity === 'damaged',
    );
    const effectFindings = threadFindings.filter(
      (item) => item.severity !== 'damaged',
    );
    const integrity = integrityFindings.length ? 'damaged' : 'consistent';
    const effectEvidence = effectFindings.some(
      (item) => item.severity === 'attention',
    )
      ? 'gaps'
      : 'complete';

    const threadReplay: ReplayChecks = prepared.unreadable
      ? emptyChecks('not_run', 'not_applicable')
      : await replayChecks(replayable, undefined, limits);

    const summaries: RunSummary[] = analyses.map((one) => ({
      runId: one.read.run.runId,
      seq: one.read.run.seq,
      status: one.read.run.status,
      class: one.klass,
      eventCount: one.read.events?.length ?? null,
      digest: one.digest,
      integrity: one.damaged ? 'damaged' : 'consistent',
      findingCodes: one.findings.map((item) => item.code),
    }));
    const threadDigest = sha256(
      `${EVIDENCE_DIGEST_VERSION}\nthread\n${canonicalJson({
        threadId,
        runs: summaries.map((one) => ({
          runId: one.runId,
          seq: one.seq,
          status: one.status,
          eventCount: one.eventCount,
          digest: one.digest,
        })),
      })}`,
    );

    const threadLevel = (): BlockerCode[] => {
      const blockers = new Set<BlockerCode>();
      if (integrity === 'damaged') blockers.add('HISTORY_INCONSISTENT');
      if (threadReplay.state === 'failed') {
        blockers.add(
          threadReplay.reasons.includes('state_delta_unappliable')
            ? 'STATE_REPLAY_UNAPPLIABLE'
            : 'REPLAY_CHECK_FAILED',
        );
      }
      if (threadReplay.state === 'incomplete')
        blockers.add('REPLAY_CHECK_INCOMPLETE');
      if (prepared.facts === null) blockers.add('FACTS_DISAGREE');
      return [...blockers];
    };

    const diagnoseOne = async (one: Analysis): Promise<RunDiagnosisReport> => {
      const { run } = one.read;
      const blockers = new Set<BlockerCode>(threadLevel());
      const evidence: EvidenceBinding = {
        digestVersion: EVIDENCE_DIGEST_VERSION,
        digest: one.digest,
        eventCount: one.read.events?.length ?? null,
        lastEventId: prepared.lastEventId,
        threadDigest,
        engine: ENGINE,
      };
      const planDigest = (
        status: PlanStatus,
        types: string[],
      ): string | null =>
        one.digest === null
          ? null
          : sha256(
              `${EVIDENCE_DIGEST_VERSION}\nplan\n${canonicalJson({
                prefixDigest: one.digest,
                status,
                types,
                engine: ENGINE,
              })}`,
            );
      const attempt = one.attempt;
      const calls: ToolCallDiagnosis[] =
        attempt?.toolCalls.map((call) => ({
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          side: call.side,
          phase: call.phase,
          executorEntry: call.executorEntry,
          provenance: call.resultProvenance,
          knowledge: knowledgeOf(call),
        })) ?? [];
      const scan = one.scan;
      const lifecycles: RunDiagnosisReport['lifecycles'] = {
        openText: scan?.openText.length ?? 0,
        openReasoning: scan
          ? new Set([...scan.openReasoning, ...scan.openReasoningMessages]).size
          : 0,
        openSteps: scan?.openSteps.length ?? 0,
        incompleteArgsCalls: scan
          ? [...scan.calls.values()].filter((call) => !call.ended).length
          : 0,
        stateEvents: scan?.stateEvents ?? 0,
        activityEvents: scan?.activityEvents ?? 0,
        customEvents: scan?.customEvents ?? 0,
        rawEvents: scan?.rawEvents ?? 0,
        otherFamilies:
          attempt?.otherFamilies.filter(
            (type) =>
              ![
                'STATE_SNAPSHOT',
                'STATE_DELTA',
                'MESSAGES_SNAPSHOT',
                'ACTIVITY_SNAPSHOT',
                'ACTIVITY_DELTA',
                'CUSTOM',
                'RAW',
              ].includes(type),
          ) ?? [],
      };

      let plan: ProposedPlan;
      let projected: ReplayChecks | null = null;
      const currentWithRun: ReplayChecks =
        one.damaged ||
        prepared.unreadable ||
        one.lifecycle === 'active_in_memory'
          ? threadReplay
          : await withRunReducer(threadReplay, one.rawEvents as BaseEvent[]);
      const none = (status: PlanStatus): ProposedPlan => ({
        status,
        eventTypes: [],
        terminalStatus: null,
        requiredAcknowledgements: [],
        digest: planDigest(status, []),
      });

      if (one.damaged) {
        blockers.add('HISTORY_INCONSISTENT');
        if (one.lifecycle !== 'terminal') blockers.add('LIVENESS_UNPROVEN');
        plan = none('not_possible');
      } else if (one.lifecycle === 'terminal') {
        plan = none('not_needed');
      } else if (one.lifecycle === 'active_in_memory') {
        blockers.add('RUN_ACTIVE_IN_MEMORY');
        plan = none('not_possible');
      } else {
        // A nonterminal run this process does not drive.
        blockers.add('LIVENESS_UNPROVEN');
        blockers.add('ADMISSION_GUARD_NOT_IMPLEMENTED');
        blockers.add('RESOLVER_NOT_AVAILABLE');
        if (currentWithRun.state === 'failed') {
          blockers.add(
            currentWithRun.reasons.includes('state_delta_unappliable')
              ? 'STATE_REPLAY_UNAPPLIABLE'
              : 'REPLAY_CHECK_FAILED',
          );
        }
        if (currentWithRun.state === 'incomplete')
          blockers.add('REPLAY_CHECK_INCOMPLETE');
        if (one.disagrees) {
          blockers.add('FACTS_DISAGREE');
          plan = none('not_possible');
        } else if (currentWithRun.state === 'failed') {
          plan = none('not_possible');
        } else if (!one.deferred) {
          // The existing recovery closes this run. What it would append is
          // reported as types; nothing is appended here.
          const raw = one.rawEvents as BaseEvent[];
          const recovery = recoveryEvents(
            run.threadId,
            run.runId,
            raw,
            classifyRun(raw, this.deps.clientExecutableToolNames),
          );
          const types = recovery?.appended.map((e) => e.type as string) ?? [];
          plan = {
            status: 'closed_by_recovery',
            eventTypes: types,
            terminalStatus: recovery?.status ?? null,
            requiredAcknowledgements: [],
            digest: planDigest('closed_by_recovery', types),
          };
        } else {
          const raw = one.rawEvents as BaseEvent[];
          const projection = project({
            scan: one.scan!,
            attempt: attempt!,
            prefixCount: raw.length,
            prefixDigest: one.digest!,
          });
          const hold = (attempt?.summary.clientPending ?? 0) > 0;
          const status: PlanStatus = hold ? 'on_hold' : 'proposed';
          if (hold) {
            blockers.add('HITL_RELEASE_HOLD');
            blockers.add('PROVIDER_HISTORY_UNVERIFIED');
          }
          plan = {
            status,
            eventTypes: projection.types,
            terminalStatus: 'interrupted',
            requiredAcknowledgements: projection.acknowledgements,
            digest: planDigest(status, projection.types),
          };
          // The projected history: stored events plus the proposed appends, in
          // memory only.
          const projectedEvents = [...raw, ...projection.events];
          const mechanical = await replayChecks(
            replayable.map((item) =>
              item.runId === run.runId
                ? { runId: item.runId, events: projectedEvents }
                : item,
            ),
            { runId: run.runId, events: projectedEvents },
            limits,
          );
          const guarantees = projectedGuarantees(attempt!, projectedEvents);
          const reasons = [...mechanical.reasons, ...guarantees.reasons];
          const failed =
            mechanical.state === 'failed' ||
            guarantees.lifecycle === 'failed' ||
            guarantees.provenance === 'failed';
          projected = {
            ...mechanical,
            lifecycle: guarantees.lifecycle,
            provenance: guarantees.provenance,
            reasons,
            state: failed
              ? 'failed'
              : mechanical.state === 'incomplete'
                ? 'incomplete'
                : 'passed',
          };
          if (failed) blockers.add('REPLAY_CHECK_FAILED');
        }
      }

      const classification: RunDiagnosisReport['classification'] = {
        class: one.klass,
        ...(one.recoveryKind ? { recoveryKind: one.recoveryKind } : {}),
        deferred: one.deferred,
      };
      return {
        schema: DIAGNOSIS_SCHEMA,
        advisory: true,
        outcome: 'diagnosed',
        threadId,
        runId: run.runId,
        agentId: run.agentId,
        runSeq: run.seq,
        authoritativeStatus: run.status,
        lifecycle: one.lifecycle,
        classification,
        integrity: {
          state: one.damaged ? 'damaged' : 'consistent',
          issues: one.read.issues,
        },
        toolLifecycle: {
          calls,
          serverCalls: calls.filter((call) => call.side === 'server').length,
          clientCalls: calls.filter((call) => call.side === 'client').length,
        },
        executor: {
          entryPossible: calls.filter(
            (call) => call.executorEntry === 'possible',
          ).length,
        },
        hitl: {
          pendingClientCalls: calls
            .filter(
              (call) =>
                call.side === 'client' && call.phase !== 'result_recorded',
            )
            .map((call) => ({
              toolCallId: call.toolCallId,
              toolName: call.toolName,
            })),
        },
        lifecycles,
        terminal: attempt?.terminal ?? null,
        findings: one.findings,
        thread: {
          integrity,
          effectEvidence,
          runCount: analyses.length,
          eventCount: prepared.eventCount,
        },
        replay: { current: currentWithRun, projected },
        plan,
        evidence,
        blockers: BLOCKER_ORDER.filter((code) => blockers.has(code)),
        nonClaims: NON_CLAIMS,
      };
    };

    // A run diagnosis reads one run in the context of its thread; it does not
    // pay for the others.
    const unresolvedOnes = analyses.filter(
      (one) =>
        one.lifecycle === 'nonterminal_not_active' &&
        (targetRunId === undefined || one.read.run.runId === targetRunId),
    );
    const diagnosed: RunDiagnosisReport[] = [];
    for (const one of unresolvedOnes) diagnosed.push(await diagnoseOne(one));

    let runDiagnosis: RunDiagnosisReport | undefined;
    if (targetRunId !== undefined) {
      const target = analyses.find(
        (one) => one.read.run.runId === targetRunId,
      )!;
      runDiagnosis =
        diagnosed.find((item) => item.runId === targetRunId) ??
        (await diagnoseOne(target));
    }

    const blockers = new Set<BlockerCode>(threadLevel());
    for (const item of diagnosed)
      for (const code of item.blockers) blockers.add(code);
    if (activeRunId !== undefined) blockers.add('RUN_ACTIVE_IN_MEMORY');

    return {
      thread: {
        schema: DIAGNOSIS_SCHEMA,
        advisory: true,
        outcome: 'diagnosed',
        threadId,
        agentId,
        state: prepared.facts?.state ?? 'unknown',
        integrity: { state: integrity, findings: integrityFindings },
        effectEvidence: { state: effectEvidence, findings: effectFindings },
        runs: summaries,
        unresolved: diagnosed,
        replay: { current: threadReplay },
        evidence: {
          digestVersion: EVIDENCE_DIGEST_VERSION,
          threadDigest,
          runCount: analyses.length,
          eventCount: prepared.eventCount,
          lastEventId: prepared.lastEventId,
          engine: ENGINE,
        },
        limits: { ...limits },
        blockers: BLOCKER_ORDER.filter((code) => blockers.has(code)),
        nonClaims: NON_CLAIMS,
      },
      ...(runDiagnosis ? { run: runDiagnosis } : {}),
    };
  }
}
