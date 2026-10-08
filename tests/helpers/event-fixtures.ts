import type { BaseEvent, Message, RunAgentInput } from '@ag-ui/core';
import { pageReviewTool } from '../../src/shared/page-review';

// Builders for the AG-UI event shapes the durable log stores. Test-only: the
// production modules take events as data and build none of these themselves.

// The one tool the browser executes (src/client/Chat.tsx), taken from the
// production definition rather than retyped.
export const CLIENT_TOOL = pageReviewTool.name;
// A tool the server executes (src/server/page-tools.ts).
export const SERVER_TOOL = 'read_space_page';
// What the composition root will inject at C6: server-owned configuration.
export const CLIENT_EXECUTABLE: ReadonlySet<string> = new Set([CLIENT_TOOL]);

const event = (value: Record<string, unknown>) => value as unknown as BaseEvent;

export const runStarted = (
  tools: string[] = [],
  messages: Message[] = [],
  ids: { threadId?: string; runId?: string } = {},
) =>
  event({
    type: 'RUN_STARTED',
    threadId: ids.threadId ?? 't',
    runId: ids.runId ?? 'r',
    input: {
      threadId: ids.threadId ?? 't',
      runId: ids.runId ?? 'r',
      state: {},
      messages,
      tools: tools.map((name) => ({ name, description: name, parameters: {} })),
      context: [],
      forwardedProps: {},
    },
  });

export const textEvents = (id: string, closed = true, delta = 'hi') => [
  event({ type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' }),
  event({ type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta }),
  ...(closed ? [event({ type: 'TEXT_MESSAGE_END', messageId: id })] : []),
];

// upto 0: START and ARGS only; 1: also END (result pending); 2: also RESULT.
export const callEvents = (
  id: string,
  name: string,
  upto: 0 | 1 | 2,
  parentMessageId = 'a1',
) => [
  event({
    type: 'TOOL_CALL_START',
    toolCallId: id,
    toolCallName: name,
    parentMessageId,
  }),
  event({ type: 'TOOL_CALL_ARGS', toolCallId: id, delta: '{}' }),
  ...(upto >= 1 ? [event({ type: 'TOOL_CALL_END', toolCallId: id })] : []),
  ...(upto >= 2
    ? [
        event({
          type: 'TOOL_CALL_RESULT',
          toolCallId: id,
          messageId: `${id}-r`,
          role: 'tool',
          content: '{"ok":true}',
        }),
      ]
    : []),
];

export const reasoningEvents = (id: string, closed = false) => [
  event({ type: 'REASONING_START', messageId: id }),
  event({ type: 'REASONING_MESSAGE_START', messageId: id, role: 'reasoning' }),
  event({ type: 'REASONING_MESSAGE_CONTENT', messageId: id, delta: '..' }),
  ...(closed
    ? [
        event({ type: 'REASONING_MESSAGE_END', messageId: id }),
        event({ type: 'REASONING_END', messageId: id }),
      ]
    : []),
];

export const runFinished = (threadId = 't', runId = 'r') =>
  event({ type: 'RUN_FINISHED', threadId, runId });
export const runError = (message = 'boom', code?: string) =>
  event({ type: 'RUN_ERROR', message, ...(code ? { code } : {}) });
export const custom = () =>
  event({ type: 'CUSTOM', name: 'x', value: { a: 1 } });

export const types = (events: readonly BaseEvent[]) =>
  events.map((e) => e.type as string);

export const user = (id: string, content = 'q'): Message => ({
  id,
  role: 'user',
  content,
});
export const assistant = (id: string, ...toolCallIds: string[]): Message =>
  ({
    id,
    role: 'assistant',
    ...(toolCallIds.length
      ? {
          toolCalls: toolCallIds.map((callId) => ({
            id: callId,
            type: 'function',
            function: { name: SERVER_TOOL, arguments: '{}' },
          })),
        }
      : { content: 'ok' }),
  }) as Message;
export const toolMessage = (id: string, toolCallId: string): Message => ({
  id,
  role: 'tool',
  toolCallId,
  content: '{}',
});

export const inputOf = (
  ...messages: Message[]
): Pick<RunAgentInput, 'messages'> => ({
  messages,
});

// Recursively freezes, so a rule that mutates its arguments throws.
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
