function sse(events: Array<Record<string, unknown>>) {
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(''),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

const base = {
  id: 'resp',
  object: 'response',
  created_at: 1,
  model: 'gpt-fixture',
  status: 'completed',
};

export const reasoningItem = {
  type: 'reasoning',
  id: 'rs-1',
  summary: [],
  encrypted_content: 'encrypted-reasoning-blob',
};

// Mirrors Sign in with ChatGPT: complete items arrive in output_item.done, but
// response.completed.output is empty. With `reasoning`, a reasoning item
// precedes the call, as a reasoning model produces.
export function responsesToolCall(
  name: string,
  args: Record<string, unknown>,
  {
    callId = 'call-1',
    reasoning = false,
    // True models a server that fills response.completed.output (SIWC leaves it empty).
    completedOutput = false,
  } = {},
) {
  const item = {
    type: 'function_call',
    id: 'fc-1',
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
    status: 'completed',
  };
  const index = reasoning ? 1 : 0;
  return sse([
    {
      type: 'response.created',
      sequence_number: 0,
      response: { ...base, status: 'in_progress', output: [] },
    },
    ...(reasoning
      ? [
          {
            type: 'response.output_item.added',
            sequence_number: 1,
            output_index: 0,
            item: { ...reasoningItem, encrypted_content: null },
          },
          {
            type: 'response.output_item.done',
            sequence_number: 2,
            output_index: 0,
            item: reasoningItem,
          },
        ]
      : []),
    {
      type: 'response.output_item.added',
      sequence_number: 3,
      output_index: index,
      item: { ...item, arguments: '', status: 'in_progress' },
    },
    {
      type: 'response.output_item.done',
      sequence_number: 4,
      output_index: index,
      item,
    },
    {
      type: 'response.completed',
      sequence_number: 5,
      response: {
        ...base,
        output: completedOutput
          ? [...(reasoning ? [reasoningItem] : []), item]
          : [],
      },
    },
  ]);
}

export function responsesText(text: string) {
  const item = {
    type: 'message',
    id: 'msg-1',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  return sse([
    {
      type: 'response.created',
      sequence_number: 0,
      response: { ...base, status: 'in_progress', output: [] },
    },
    {
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: { ...item, content: [], status: 'in_progress' },
    },
    {
      type: 'response.content_part.added',
      sequence_number: 2,
      item_id: 'msg-1',
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    },
    {
      type: 'response.output_text.delta',
      sequence_number: 3,
      item_id: 'msg-1',
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: 'response.output_text.done',
      sequence_number: 4,
      item_id: 'msg-1',
      output_index: 0,
      content_index: 0,
      text,
    },
    {
      type: 'response.output_item.done',
      sequence_number: 5,
      output_index: 0,
      item,
    },
    {
      type: 'response.completed',
      sequence_number: 6,
      response: { ...base, output: [] },
    },
  ]);
}
