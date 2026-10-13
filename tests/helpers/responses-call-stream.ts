// Test-only. A Sign in with ChatGPT / OpenAI Responses stream carrying complete
// function calls, with a chosen ending. The production adapter emits
// TOOL_CALL_END at `response.function_call_arguments.done`, in the MIDDLE of the
// response, so a failure of the response after it is a provider failure AFTER a
// durable TOOL_CALL_END and BEFORE the engine's tool phase.
export type ResponsesEnding =
  'completed' | 'failed' | 'incomplete' | 'close' | 'fault';

export interface ResponsesCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  // Stop in the middle of the arguments: no `.done`, no END.
  partial?: boolean;
}

const enc = new TextEncoder();
const frame = (type: string, body: Record<string, unknown>) =>
  enc.encode(
    `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: 0, ...body })}\n\n`,
  );
const RESPONSE = {
  id: 'resp_1',
  object: 'response',
  model: 'custom-model',
  status: 'in_progress',
  output: [] as unknown[],
};

export function responsesCalls(
  calls: readonly ResponsesCall[],
  ending: ResponsesEnding,
  text?: string,
): Response {
  const chunks: Uint8Array[] = [];
  chunks.push(frame('response.created', { response: RESPONSE }));
  chunks.push(frame('response.in_progress', { response: RESPONSE }));
  let outputIndex = 0;
  if (text !== undefined) {
    const item = {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'in_progress',
      content: [] as unknown[],
    };
    chunks.push(
      frame('response.output_item.added', { output_index: outputIndex, item }),
    );
    chunks.push(
      frame('response.content_part.added', {
        item_id: 'msg_1',
        output_index: outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      }),
    );
    chunks.push(
      frame('response.output_text.delta', {
        item_id: 'msg_1',
        output_index: outputIndex,
        content_index: 0,
        delta: text,
      }),
    );
    chunks.push(
      frame('response.output_text.done', {
        item_id: 'msg_1',
        output_index: outputIndex,
        content_index: 0,
        text,
      }),
    );
    chunks.push(
      frame('response.output_item.done', {
        output_index: outputIndex,
        item: {
          ...item,
          status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }],
        },
      }),
    );
    outputIndex++;
  }
  calls.forEach((call, n) => {
    const args = JSON.stringify(call.args);
    const id = `fc_${n}`;
    const item = (done: boolean) => ({
      type: 'function_call',
      id,
      call_id: call.callId,
      name: call.name,
      arguments: done ? args : '',
      status: done ? 'completed' : 'in_progress',
    });
    chunks.push(
      frame('response.output_item.added', {
        output_index: outputIndex,
        item: item(false),
      }),
    );
    chunks.push(
      frame('response.function_call_arguments.delta', {
        item_id: id,
        output_index: outputIndex,
        delta: args.slice(0, 12),
      }),
    );
    if (call.partial) return;
    chunks.push(
      frame('response.function_call_arguments.delta', {
        item_id: id,
        output_index: outputIndex,
        delta: args.slice(12),
      }),
    );
    chunks.push(
      frame('response.function_call_arguments.done', {
        item_id: id,
        output_index: outputIndex,
        arguments: args,
      }),
    );
    chunks.push(
      frame('response.output_item.done', {
        output_index: outputIndex,
        item: item(true),
      }),
    );
    outputIndex++;
  });
  if (ending === 'completed')
    // Sign in with ChatGPT leaves response.completed.output empty.
    chunks.push(
      frame('response.completed', {
        response: {
          ...RESPONSE,
          status: 'completed',
          output: [],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      }),
    );
  else if (ending === 'failed')
    chunks.push(
      frame('response.failed', {
        response: {
          ...RESPONSE,
          status: 'failed',
          error: {
            code: 'server_error',
            message: 'The model failed to complete the response.',
          },
        },
      }),
    );
  else if (ending === 'incomplete')
    chunks.push(
      frame('response.incomplete', {
        response: {
          ...RESPONSE,
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
        },
      }),
    );
  let next = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next < chunks.length) {
        controller.enqueue(chunks[next++]);
        return;
      }
      if (ending === 'fault') controller.error(new Error('socket hang up'));
      else controller.close();
    },
  });
  return new Response(body, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

// The Responses request's function_call_output items: what the model is told
// about each earlier call.
export function functionCallOutputs(
  body: Record<string, unknown>,
): Array<{ callId: string; output: string }> {
  const input = (body as { input?: unknown }).input;
  if (!Array.isArray(input)) return [];
  return input
    .filter(
      (item): item is { type: string; call_id: string; output: unknown } =>
        !!item &&
        typeof item === 'object' &&
        (item as { type?: unknown }).type === 'function_call_output',
    )
    .map((item) => ({
      callId: String(item.call_id),
      output: String(item.output),
    }));
}
