// Must stay the first import: see telemetry-guard.ts.
import './telemetry-guard.js';
import { finalizeRunEvents } from '@copilotkit/runtime/v2';
import type { BaseEvent, RunAgentInput } from '@ag-ui/core';

// Pure rules for durable local runs: how a run that died without a terminal
// event is classified and repaired, which tool calls wait for a human, and
// when a client's history is too stale to continue from. Every function takes
// the stored events as data; none reads a database, a clock, the environment
// or the network. Dormant: nothing in the application imports this module.
// Authority: docs/LOCAL_FIRST_C4_LANDING_BOUNDARY.md sections 11 to 15 and 23.

export const INTERRUPTION_MESSAGE =
  'Run interrupted: the server process ended before the run finished.';

// Recorded instead of the stock error result when the log cannot tell whether
// a server tool's side effect happened: the tool is neither retried nor
// reported as failed.
export const UNKNOWN_OUTCOME_CONTENT = JSON.stringify({
  outcome: 'unknown',
  reason: 'run_interrupted',
  message:
    'The run was interrupted before the result of this tool call was recorded. The tool may or may not have run. Do not assume that it succeeded or that it failed, and do not retry it automatically: verify its effect before retrying.',
});

export type RecoveryKind =
  | 'no_tool_lifecycle'
  | 'open_text_message'
  | 'tool_args_incomplete'
  | 'server_unknown_outcome'
  | 'server_result_durable'
  | 'client_hitl_pending'
  // R26a, CONDITIONALLY APPROVED (DEC-21): accepted behaviour only after its
  // real-process SIGKILL test passes. R26 stays open.
  | 'complete_text_no_terminal'
  // Open (R22): a pending client and a pending server call. Nothing is written.
  | 'mixed_pending_tool_calls'
  // Open (R24): open text or an incomplete call beside a pending complete call.
  | 'open_text_with_pending_tool_call'
  // Open (R26b): anything else, such as reasoning or state. Not generalized
  // from R26a.
  | 'unclassified_lifecycle';

export interface PendingToolCall {
  toolCallId: string;
  toolCallName: string;
}

export interface RunClassification {
  kind: RecoveryKind;
  // True when the rules write nothing and the run stays as it is.
  deferred: boolean;
  pendingClient: PendingToolCall[];
  pendingServer: PendingToolCall[];
}

export interface RecoveryPlan {
  // Appended to the run in one transaction, in order.
  appended: BaseEvent[];
  status: 'finished' | 'interrupted';
}

interface Loose {
  type: string;
  [field: string]: unknown;
}
const loose = (event: BaseEvent) => event as unknown as Loose;
const text = (value: unknown) =>
  typeof value === 'string' ? value : undefined;

// The tool names the client declared in the persisted RUN_STARTED input.
export function declaredToolNames(events: readonly BaseEvent[]): Set<string> {
  const start = events.map(loose).find((event) => event.type === 'RUN_STARTED');
  const tools = (start?.input as { tools?: unknown } | undefined)?.tools;
  const names = new Set<string>();
  if (Array.isArray(tools))
    for (const tool of tools) {
      const name = text((tool as { name?: unknown } | null)?.name);
      if (name !== undefined) names.add(name);
    }
  return names;
}

// DEC-19 / R23. A tool is client-executed only if the client declared it AND
// the server says it may run on the client. The client can therefore narrow
// the permitted set but never widen it; every disagreement is a server tool,
// which is the safe direction.
export function isClientExecuted(
  toolName: string,
  declared: ReadonlySet<string>,
  clientExecutableToolNames: ReadonlySet<string>,
): boolean {
  return declared.has(toolName) && clientExecutableToolNames.has(toolName);
}

// Event families that R26a may consist of.
const R26A_TYPES = new Set([
  'RUN_STARTED',
  'TEXT_MESSAGE_START',
  'TEXT_MESSAGE_CONTENT',
  'TEXT_MESSAGE_END',
]);

// Classifies a run that has no terminal event. A run that has one, or that does
// not begin with RUN_STARTED, is left alone (deferred).
export function classifyRun(
  events: readonly BaseEvent[],
  clientExecutableToolNames: ReadonlySet<string>,
): RunClassification {
  const none = { pendingClient: [], pendingServer: [] };
  const all = events.map(loose);
  if (
    all[0]?.type !== 'RUN_STARTED' ||
    all.some(
      (event) => event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR',
    )
  )
    return { kind: 'unclassified_lifecycle', deferred: true, ...none };

  const declared = declaredToolNames(events);
  const openText = new Set<string>();
  let closedText = 0;
  const calls = new Map<
    string,
    { name: string; ended: boolean; result: boolean }
  >();
  for (const event of all) {
    const messageId = text(event.messageId);
    const toolCallId = text(event.toolCallId);
    if (event.type === 'TEXT_MESSAGE_START' && messageId !== undefined)
      openText.add(messageId);
    else if (event.type === 'TEXT_MESSAGE_END' && messageId !== undefined) {
      if (openText.delete(messageId)) closedText++;
    } else if (event.type === 'TOOL_CALL_START' && toolCallId !== undefined)
      calls.set(toolCallId, {
        name: text(event.toolCallName) ?? '',
        ended: false,
        result: false,
      });
    else if (event.type === 'TOOL_CALL_END' && toolCallId !== undefined) {
      const call = calls.get(toolCallId);
      if (call) call.ended = true;
    } else if (event.type === 'TOOL_CALL_RESULT' && toolCallId !== undefined) {
      const call = calls.get(toolCallId);
      if (call) call.result = true;
    }
  }

  const entries = [...calls.entries()].map(([toolCallId, call]) => ({
    toolCallId,
    toolCallName: call.name,
    ...call,
  }));
  const incomplete = entries.filter((call) => !call.ended);
  const pending = entries.filter((call) => call.ended && !call.result);
  const toPending = ({ toolCallId, toolCallName }: PendingToolCall) => ({
    toolCallId,
    toolCallName,
  });
  const pendingClient = pending
    .filter((call) =>
      isClientExecuted(call.toolCallName, declared, clientExecutableToolNames),
    )
    .map(toPending);
  const pendingServer = pending
    .filter(
      (call) =>
        !isClientExecuted(
          call.toolCallName,
          declared,
          clientExecutableToolNames,
        ),
    )
    .map(toPending);
  const result = (
    kind: RecoveryKind,
    deferred: boolean,
  ): RunClassification => ({
    kind,
    deferred,
    pendingClient,
    pendingServer,
  });

  if (pendingServer.length && pendingClient.length)
    return result('mixed_pending_tool_calls', true);
  if ((openText.size || incomplete.length) && pending.length)
    return result('open_text_with_pending_tool_call', true);
  if (pendingServer.length) return result('server_unknown_outcome', false);
  if (pendingClient.length) return result('client_hitl_pending', false);
  if (incomplete.length) return result('tool_args_incomplete', false);
  if (openText.size) return result('open_text_message', false);
  if (entries.length && entries.every((call) => call.result))
    return result('server_result_durable', false);
  if (all.length === 1) return result('no_tool_lifecycle', false);
  // R26a: nothing but fully closed text messages. No tool call exists, so no
  // executor can have run; whether the answer was complete is unknowable, so
  // the run is closed as an error and never as finished.
  if (
    !entries.length &&
    closedText > 0 &&
    all.every((event) => R26A_TYPES.has(event.type))
  )
    return result('complete_text_no_terminal', false);
  return result('unclassified_lifecycle', true);
}

// The events recovery appends to a dead run, and the status it ends in, or null
// when the class is deferred and nothing is written. Never re-drives the agent:
// no provider call and no tool execution is repeated for any class.
export function recoveryEvents(
  threadId: string,
  runId: string,
  events: readonly BaseEvent[],
  classification: RunClassification,
): RecoveryPlan | null {
  if (classification.deferred) return null;
  // The canonical pending form: the human's answer arrives afterwards exactly
  // as it does for a run that finished normally.
  if (classification.kind === 'client_hitl_pending')
    return {
      appended: [
        { type: 'RUN_FINISHED', threadId, runId } as unknown as BaseEvent,
      ],
      status: 'finished',
    };
  // The stock finalizer appends to the array it is given, so it gets a copy.
  const stock = finalizeRunEvents([...events], {
    interruptionMessage: INTERRUPTION_MESSAGE,
  });
  if (classification.kind !== 'server_unknown_outcome')
    return { appended: stock, status: 'interrupted' };
  const unknown = new Set(
    classification.pendingServer.map((call) => call.toolCallId),
  );
  return {
    status: 'interrupted',
    appended: stock.map((event) => {
      const stored = loose(event);
      const toolCallId = text(stored.toolCallId);
      return stored.type === 'TOOL_CALL_RESULT' &&
        toolCallId !== undefined &&
        unknown.has(toolCallId)
        ? ({
            type: 'TOOL_CALL_RESULT',
            toolCallId,
            messageId: `${toolCallId}-unknown-outcome`,
            role: 'tool',
            content: UNKNOWN_OUTCOME_CONTENT,
          } as unknown as BaseEvent)
        : event;
    }),
  };
}

// DEC-5. `held` is the set of tool call ids that have a durable
// TOOL_CALL_RESULT in the thread's log. Returns the first tool call id that the
// input's own assistant history names, whose result the log holds and the input
// does not carry (the input is stale and would run the tool again), or null.
// A prompt-only input has no assistant tool calls, so it is never stale. The
// caller is never inspected: only what the input itself claims.
export function findStaleToolHistory(
  input: Pick<RunAgentInput, 'messages'>,
  held: ReadonlySet<string>,
): string | null {
  const messages = input.messages ?? [];
  const answered = new Set<string>();
  for (const message of messages)
    if (message.role === 'tool') answered.add(message.toolCallId);
  for (const message of messages)
    if (message.role === 'assistant')
      for (const call of message.toolCalls ?? [])
        if (held.has(call.id) && !answered.has(call.id)) return call.id;
  return null;
}
