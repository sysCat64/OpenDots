import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventType, type RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { DotAgent } from '../src/server/dot-agent.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { completion } from './fixtures/model-stream.js';
import { responsesText } from './fixtures/responses-stream.js';
import {
  ASTRA,
  LUNA,
  SECRETS,
  harness,
  until,
  type Harness,
} from './fixtures/fake-chatgpt-session.js';

vi.setConfig({ testTimeout: 20_000 });

// Default for the whole file: a call nobody expected fails, rather than reaching
// the real network with a fake token.
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('unexpected network call'),
  );
});

const open: Array<{ close(): void }> = [];
const services: Harness[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  open.splice(0).forEach((db) => db.close());
  await Promise.all(services.splice(0).map((h) => h.service.close()));
});

async function fixture(overrides: Parameters<typeof harness>[0] = {}) {
  const h = harness({
    signedIn: true,
    apiKey: {
      apiKey: 'api-key-fixture',
      model: 'custom-model',
      baseUrl: 'https://unused.invalid/v1',
    },
    server: { provider: 'api-key' },
    ...overrides,
  });
  services.push(h);
  await h.service.start();
  await until(() => h.session.models.snapshot().fetchedAt !== undefined);
  const workspace = new WorkspaceStore(':memory:', 'owner');
  open.push(workspace);
  const dot = workspace.dots()[0];
  workspace.bindThread('thread', dot.id, 'Switching');
  const agent = new DotAgent(
    h.store,
    workspace,
    {
      intelligenceKey: 'fixture',
      baseUrl: '',
      modelProvider: h.service.provider,
      runtimeUrl: '',
      voiceName: 'marin',
      slackUsers: [],
    },
    dot.id,
  );
  const input = (runId: string): RunAgentInput => ({
    threadId: 'thread',
    runId,
    state: {},
    context: [],
    messages: [
      { id: 'u', role: 'user', content: 'Create a page called Notes.' },
    ],
    tools: [],
    forwardedProps: {},
  });
  const run = (runId: string) =>
    lastValueFrom(agent.run(input(runId)).pipe(toArray()));
  return { ...h, workspace, dot, run };
}

const pageToolCall = () =>
  completion(
    {
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: 'call-1',
          type: 'function',
          function: {
            name: 'create_space_page',
            arguments: JSON.stringify({ title: 'Notes', content: '# Notes' }),
          },
        },
      ],
    },
    'tool_calls',
  );

it('switches provider between runs without a restart', async () => {
  const f = await fixture();
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      completion({ role: 'assistant', content: 'From the key.' }),
    )
    .mockResolvedValueOnce(responsesText('From the plan.'));

  await f.run('one');
  expect(String(network.mock.calls[0][0])).toBe(
    'https://unused.invalid/v1/chat/completions',
  );

  f.service.setProvider('chatgpt-plan');
  await f.service.setChatGPTModel(LUNA.slug);
  const events = await f.run('two');
  expect(String(network.mock.calls[1][0])).toBe(
    'https://api.openai.com/v1/responses',
  );
  expect(JSON.parse(String(network.mock.calls[1][1]?.body))).toMatchObject({
    model: LUNA.slug,
    store: false,
  });
  expect(
    new Headers(network.mock.calls[1][1]?.headers).get('authorization'),
  ).toBe(`Bearer ${SECRETS[0]}`);
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: EventType.TEXT_MESSAGE_CHUNK,
        delta: 'From the plan.',
      }),
    ]),
  );
});

it('keeps a run on the provider it started with, and uses the new one from the next run', async () => {
  const f = await fixture();
  await f.service.setChatGPTModel(ASTRA.slug);
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    urls.push(String(input));
    if (urls.length === 1) {
      // The owner switches while the first run is waiting on the model.
      f.service.setProvider('chatgpt-plan');
      return pageToolCall();
    }
    if (urls.length === 2)
      return completion({ role: 'assistant', content: 'Done.' });
    return responsesText('Next run.');
  });

  await f.run('in-flight');
  expect(urls[0]).toBe('https://unused.invalid/v1/chat/completions');
  // The continuation of the same run stays on its starting provider.
  expect(urls[1]).toBe('https://unused.invalid/v1/chat/completions');
  expect(f.workspace.pages.list(f.dot.spaceId)).toEqual(
    expect.arrayContaining([expect.objectContaining({ title: 'Notes' })]),
  );

  await f.run('next');
  expect(urls[2]).toBe('https://api.openai.com/v1/responses');
});

it('returns to the server default with no restart', async () => {
  const f = await fixture();
  f.service.setProvider('chatgpt-plan');
  await f.service.setChatGPTModel(LUNA.slug);
  f.service.clearSelection();
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(completion({ role: 'assistant', content: 'Back.' }));
  await f.run('after-reset');
  expect(String(network.mock.calls[0][0])).toContain('/chat/completions');
});

// No test may reach the real network: anything unexpected fails loudly.
const noNetwork = () =>
  vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('unexpected network call'));

it('never substitutes another model: a saved model that is gone stops the run', async () => {
  const f = await fixture({ server: { provider: 'chatgpt-plan' } });
  f.store.setModelSelection({ chatgptModel: 'gpt-retired' });
  await f.service.refreshModels();
  expect(f.service.status().chatgpt.model).toMatchObject({
    savedAvailable: false,
  });
  expect(f.service.status().chatgpt.model.effective).toBeUndefined();
  const network = noNetwork();
  const events = await f.run('no-model');
  expect(events).toEqual([
    expect.objectContaining({
      type: EventType.RUN_ERROR,
      message: expect.stringMatching(/configuration are required/),
    }),
  ]);
  expect(network).not.toHaveBeenCalled();
  expect(f.store.modelSelection().chatgptModel).toBe('gpt-retired');
  // Fixing it in the UI makes the next run work.
  await f.service.setChatGPTModel(LUNA.slug);
  network.mockResolvedValueOnce(responsesText('Fixed.'));
  await f.run('fixed');
  expect(JSON.parse(String(network.mock.calls[0][1]?.body)).model).toBe(
    LUNA.slug,
  );
});

it('does not swap in another model when the account loses one the cached list still shows', async () => {
  const f = await fixture();
  f.service.setProvider('chatgpt-plan');
  await f.service.setChatGPTModel(ASTRA.slug);
  f.session.available = [LUNA]; // Astra is gone, but the cached list has not caught up
  const network = noNetwork().mockResolvedValueOnce(
    new Response(JSON.stringify({ error: { message: 'model not found' } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  // The upstream refusal is what the run reports ...
  await expect(f.run('stale-cache')).rejects.toThrow(/model not found/);
  // ... and the request went out for the model the owner chose, never for Luna.
  expect(JSON.parse(String(network.mock.calls[0][1]?.body)).model).toBe(
    ASTRA.slug,
  );
  // Once the list refreshes, the model is marked unavailable and runs stop early.
  await f.service.refreshModels();
  expect(f.service.status().chatgpt.model).toMatchObject({
    savedAvailable: false,
  });
  network.mockClear();
  await f.run('after-refresh');
  expect(network).not.toHaveBeenCalled();
});
