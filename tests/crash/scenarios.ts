import type { RunAgentInput } from '@ag-ui/core';
import { CLIENT_TOOL, SERVER_TOOL, user } from '../helpers/event-fixtures';
import {
  HANG,
  finished,
  textMessage,
  toolCall,
  toolResult,
  type Step,
} from '../helpers/scripted-agent';

// The deterministic windows the real-process tests kill a runner in. A scenario
// says what the scripted model does, which tools the browser declared, and at
// which committed event the child freezes so the parent can SIGKILL it. Used by
// the child process and by the tests that read the outcome. No model, no network.

export const THREAD = 'crash-thread';
export const RUN = 'crash-run-1';

// What the script can do besides emit events.
export interface ScenarioContext {
  // A side effect of the tool executor: recorded where the parent can read it.
  executeTool(toolCallId: string): void;
  // Resolves once an event of this type is committed for the run. These gated
  // scenarios are a RECOVERY SEMANTIC ORACLE UNDER A KNOWN DURABLE STATE: they
  // fix which events are durable when the process dies and prove how that state
  // is recovered. The gate is not what makes execution safe, and these scenarios
  // do not by themselves prove that production execution cannot outrun
  // persistence. That proof is the A1 fence (DurableFenceTap, persisting inside
  // the producer's push) shown on the production DotAgent by
  // tests/durable-runner-dotagent-fence.test.ts and, with real SIGKILL, by
  // tests/crash/dot-sigkill.test.ts.
  awaitDurable(eventType: string): Promise<void>;
  // Writes the marker and blocks forever, to be killed. A no-op in a run that
  // is driven to its end.
  freeze(): void;
}

export type Freeze =
  // After the start transaction, before the model is invoked.
  | { at: 'start' }
  // Right after the commit of the first event that matches.
  | { at: 'event'; type: string }
  // Inside the script itself (after a side effect).
  | { at: 'script' };

export interface Scenario {
  tools: string[];
  freeze: Freeze;
  script(input: RunAgentInput, context: ScenarioContext): Step[];
}

const reasoning = [
  { type: 'REASONING_START', messageId: 'z1' },
  { type: 'REASONING_MESSAGE_START', messageId: 'z1', role: 'reasoning' },
  { type: 'REASONING_MESSAGE_CONTENT', messageId: 'z1', delta: 'thinking' },
];

export const SCENARIOS: Record<string, Scenario> = {
  // A
  'run-started-only': {
    tools: [],
    freeze: { at: 'start' },
    script: (input) => [...textMessage('a1', 'never'), finished(input)],
  },
  // B
  'open-text': {
    tools: [],
    freeze: { at: 'event', type: 'TEXT_MESSAGE_CONTENT' },
    script: (input) => [
      { type: 'TEXT_MESSAGE_START', messageId: 'a1', role: 'assistant' },
      {
        type: 'TEXT_MESSAGE_CONTENT',
        messageId: 'a1',
        delta: 'partial answer',
      },
      HANG,
      finished(input),
    ],
  },
  // C: the arguments were still streaming. Given that durable state, recovery
  // treats the executor as not run; that this state is a faithful record rests on
  // the A1 fence (see awaitDurable).
  'tool-args-incomplete': {
    tools: [],
    freeze: { at: 'event', type: 'TOOL_CALL_ARGS' },
    // The model is still streaming the arguments; nothing can have executed.
    script: (input) => [
      {
        type: 'TOOL_CALL_START',
        toolCallId: 'c1',
        toolCallName: SERVER_TOOL,
        parentMessageId: 'a1',
      },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: '{"q":' },
      HANG,
      finished(input),
    ],
  },
  // D, window 1: the call is complete, the executor has not run yet.
  'server-before-exec': {
    tools: [],
    freeze: { at: 'event', type: 'TOOL_CALL_END' },
    script: (input, { executeTool, awaitDurable }) => [
      ...toolCall('c1', SERVER_TOOL, 'a1'),
      () => awaitDurable('TOOL_CALL_END'),
      () => executeTool('c1'),
      toolResult('c1'),
      finished(input),
    ],
  },
  // D, window 2: the executor ran, its result was never recorded.
  'server-after-exec': {
    tools: [],
    freeze: { at: 'script' },
    script: (input, { executeTool, awaitDurable, freeze }) => [
      ...toolCall('c1', SERVER_TOOL, 'a1'),
      () => awaitDurable('TOOL_CALL_END'),
      () => executeTool('c1'),
      () => freeze(),
      toolResult('c1'),
      finished(input),
    ],
  },
  // E
  'result-durable': {
    tools: [],
    freeze: { at: 'event', type: 'TOOL_CALL_RESULT' },
    script: (input, { executeTool, awaitDurable }) => [
      ...toolCall('c1', SERVER_TOOL, 'a1'),
      () => awaitDurable('TOOL_CALL_END'),
      () => executeTool('c1'),
      toolResult('c1'),
      ...textMessage('a2', 'then more'),
      finished(input),
    ],
  },
  // G: the browser's tool call is complete; RUN_FINISHED has not been written.
  'client-pending-before-finish': {
    tools: [CLIENT_TOOL],
    freeze: { at: 'event', type: 'TOOL_CALL_END' },
    script: (input) => [
      ...toolCall(
        'rv1',
        CLIENT_TOOL,
        'a1',
        '{"title":"t","content":"c","spaceId":"s"}',
      ),
      finished(input),
    ],
  },
  // F: the same call in a run that did finish; killed afterwards.
  'client-pending-finished': {
    tools: [CLIENT_TOOL],
    freeze: { at: 'event', type: 'RUN_FINISHED' },
    script: (input) => [
      ...toolCall(
        'rv1',
        CLIENT_TOOL,
        'a1',
        '{"title":"t","content":"c","spaceId":"s"}',
      ),
      finished(input),
    ],
  },
  // H: R26a. Complete text, nothing else, no terminal event.
  'r26a-complete-text': {
    tools: [],
    freeze: { at: 'event', type: 'TEXT_MESSAGE_END' },
    script: (input) => [
      ...textMessage('a1', 'a whole answer'),
      HANG,
      finished(input),
    ],
  },
  // I: R26b. Reasoning open.
  'r26b-reasoning': {
    tools: [],
    freeze: { at: 'event', type: 'REASONING_MESSAGE_CONTENT' },
    script: (input) => [...reasoning, HANG, finished(input)],
  },
  // I: R26b. Closed text, then a state snapshot.
  'r26b-state': {
    tools: [],
    freeze: { at: 'event', type: 'STATE_SNAPSHOT' },
    script: (input) => [
      ...textMessage('a1', 'text first'),
      { type: 'STATE_SNAPSHOT', snapshot: { step: 1 } },
      HANG,
      finished(input),
    ],
  },
  // The cache window: the run is complete and durable, its view not yet written.
  'terminal-committed-view-unwritten': {
    tools: [],
    freeze: { at: 'event', type: 'RUN_FINISHED' },
    script: (input) => [...textMessage('a1', 'done'), finished(input)],
  },
};

export const startMessages = () => [user('crash-u1', 'hello')];
