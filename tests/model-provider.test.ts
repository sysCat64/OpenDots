import { expect, it } from 'vitest';
import { apiKeyProvider } from '../src/server/model-provider.js';
import { withSiwcToolCallFinishReason } from '../src/server/siwc-compat.js';
import { setupStatus } from '../src/server/platform-config.js';

// The Chat Completions request itself is covered end-to-end in
// tanstack-agent.test.ts.
it('keeps the API-key provider on the existing limits and fails closed when unconfigured', () => {
  expect(
    apiKeyProvider({ apiKey: 'key', model: 'custom-model' }),
  ).toMatchObject({
    kind: 'api-key',
    configured: true,
    missing: [],
    modelOptions: { max_completion_tokens: 2200 },
  });
  const empty = apiKeyProvider({});
  expect(empty.configured).toBe(false);
  expect(() => empty.createAdapter()).toThrow(/configuration are required/);
});

it('reports the legacy missing variables for an unconfigured API-key provider', () => {
  expect(
    setupStatus({
      intelligenceKey: 'fixture',
      baseUrl: '',
      runtimeUrl: '',
      voiceName: 'marin',
      slackUsers: [],
    }),
  ).toMatchObject({
    model: false,
    missing: ['OPENAI_API_KEY', 'OPENAI_MODEL'],
  });
});

function adapterEmitting(chunks: Array<Record<string, unknown>>) {
  return {
    chatStream: async function* () {
      yield* chunks;
    },
  } as never as Parameters<typeof withSiwcToolCallFinishReason>[0];
}
async function finish(chunks: Array<Record<string, unknown>>) {
  const adapter = withSiwcToolCallFinishReason(adapterEmitting(chunks));
  const out: Array<Record<string, unknown>> = [];
  for await (const chunk of adapter.chatStream({} as never))
    out.push(chunk as never);
  return out.find((chunk) => chunk.type === 'RUN_FINISHED');
}

it('corrects stop to tool_calls only after a completed tool call', async () => {
  const done = { type: 'RUN_FINISHED', finishReason: 'stop' };
  expect(
    await finish([
      { type: 'TOOL_CALL_START' },
      { type: 'TOOL_CALL_END' },
      done,
    ]),
  ).toMatchObject({ finishReason: 'tool_calls' });
  expect(await finish([{ type: 'TOOL_CALL_START' }, done])).toMatchObject({
    finishReason: 'stop',
  });
  expect(await finish([done])).toMatchObject({ finishReason: 'stop' });
  expect(
    await finish([
      { type: 'TOOL_CALL_END' },
      { type: 'RUN_FINISHED', finishReason: 'length' },
    ]),
  ).toMatchObject({ finishReason: 'length' });
});
