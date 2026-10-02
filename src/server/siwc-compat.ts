import type { ModelAdapter } from './model-provider.js';

// Sign in with ChatGPT streams a complete function_call in
// `response.output_item.done`, but its `response.completed.output` is empty.
// TanStack's Responses adapter derives finishReason from that empty array, so
// a turn that did call a tool finishes as "stop" and the agent loop never runs
// the tool. Correct that one case: a fully observed tool call in this turn
// means the turn finished with "tool_calls".
export function withSiwcToolCallFinishReason<T extends ModelAdapter>(
  adapter: T,
): T {
  const chatStream = adapter.chatStream.bind(adapter);
  adapter.chatStream = async function* (options) {
    let completedToolCall = false;
    for await (const chunk of chatStream(options)) {
      if (chunk.type === 'TOOL_CALL_END') completedToolCall = true;
      yield chunk.type === 'RUN_FINISHED' &&
      completedToolCall &&
      chunk.finishReason === 'stop'
        ? { ...chunk, finishReason: 'tool_calls' }
        : chunk;
    }
  };
  return adapter;
}
