import { afterEach, expect, it, vi } from 'vitest';
import { EventType, type RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { DotAgent } from '../src/server/dot-agent.js';
import {
  ChatGPTPlanError,
  chatgptPlanProvider,
  type ChatGPTPlanAuth,
} from '../src/server/chatgpt-plan.js';
import { setupStatus } from '../src/server/platform-config.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import {
  responsesText,
  responsesToolCall,
} from './fixtures/responses-stream.js';

const TOKEN = 'fixture-access-token-never-log';
const databases: Array<{ close(): void }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  databases.splice(0).forEach((db) => db.close());
});

function fakeAuth(overrides: Partial<ChatGPTPlanAuth> = {}): ChatGPTPlanAuth {
  return {
    getAccessToken: async () => TOKEN,
    listModels: async () => [
      { slug: 'gpt-5.6-luna', displayName: 'Luna' },
      { slug: 'gpt-6-astra', displayName: 'Astra' },
    ],
    ...overrides,
  };
}

function fixture(auth: ChatGPTPlanAuth, model = 'gpt-5.6-luna') {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  databases.push(store, workspace);
  const dot = workspace.dots()[0];
  workspace.bindThread('thread', dot.id, 'ChatGPT plan');
  const agent = new DotAgent(
    store,
    workspace,
    {
      intelligenceKey: 'fixture',
      baseUrl: 'https://unused.invalid/v1',
      modelProvider: chatgptPlanProvider({ auth, model }),
      runtimeUrl: '',
      voiceName: 'marin',
      slackUsers: [],
    },
    dot.id,
  );
  const input: RunAgentInput = {
    threadId: 'thread',
    runId: 'run',
    state: {},
    context: [],
    messages: [
      { id: 'user', role: 'user', content: 'Create a page called Notes.' },
    ],
    tools: [],
    forwardedProps: {},
  };
  return { workspace, dot, agent, input };
}

it('runs the TanStack agent loop through a ChatGPT plan: tool call, local tool, final answer', async () => {
  const f = fixture(fakeAuth());
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      responsesToolCall('create_space_page', {
        title: 'Notes',
        content: '# Notes',
      }),
    )
    .mockResolvedValueOnce(responsesText('Created Notes.'));
  const events = await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
  expect(f.workspace.pages.list(f.dot.spaceId)).toEqual(
    expect.arrayContaining([expect.objectContaining({ title: 'Notes' })]),
  );
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: 'call-1',
      }),
      expect.objectContaining({
        type: EventType.TEXT_MESSAGE_CHUNK,
        delta: 'Created Notes.',
      }),
    ]),
  );
  expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(
    false,
  );
  expect(network).toHaveBeenCalledTimes(2);
  expect(String(network.mock.calls[0][0])).toBe(
    'https://api.openai.com/v1/responses',
  );
  const first = network.mock.calls[0][1];
  expect(new Headers(first?.headers).get('authorization')).toBe(
    `Bearer ${TOKEN}`,
  );
  const request = JSON.parse(String(first?.body));
  expect(request).toMatchObject({
    model: 'gpt-5.6-luna',
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
  });
  expect(request).not.toHaveProperty('max_completion_tokens');
  const continuation = JSON.parse(String(network.mock.calls[1][1]?.body));
  expect(continuation.input).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'function_call_output',
        call_id: 'call-1',
      }),
    ]),
  );
});

it('replays a reasoning item with its function call on the next stateless turn', async () => {
  const f = fixture(fakeAuth());
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      responsesToolCall(
        'create_space_page',
        { title: 'Notes', content: '# Notes' },
        { reasoning: true },
      ),
    )
    .mockResolvedValueOnce(responsesText('Created Notes.'));
  const events = await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
  expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(
    false,
  );
  expect(f.workspace.pages.list(f.dot.spaceId)).toEqual(
    expect.arrayContaining([expect.objectContaining({ title: 'Notes' })]),
  );
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: EventType.TEXT_MESSAGE_CHUNK,
        delta: 'Created Notes.',
      }),
    ]),
  );
  const continuation = JSON.parse(String(network.mock.calls[1][1]?.body));
  expect(continuation.store).toBe(false);
  expect(continuation.include).toEqual(['reasoning.encrypted_content']);
  const types = continuation.input.map((item: { type?: string }) => item.type);
  expect(continuation.input).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'reasoning',
        encrypted_content: 'encrypted-reasoning-blob',
      }),
      expect.objectContaining({
        type: 'function_call_output',
        call_id: 'call-1',
      }),
    ]),
  );
  // Reasoning must precede its function call and the call its output.
  expect(types.indexOf('reasoning')).toBeLessThan(
    types.indexOf('function_call'),
  );
  expect(types.indexOf('function_call')).toBeLessThan(
    types.indexOf('function_call_output'),
  );
});

it('never leaks the access token into agent events or logs', async () => {
  const logs = [
    vi.spyOn(console, 'log'),
    vi.spyOn(console, 'error'),
    vi.spyOn(console, 'warn'),
  ];
  const f = fixture(fakeAuth());
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      responsesToolCall('create_space_page', { title: 'T', content: 'c' }),
    )
    .mockResolvedValueOnce(responsesText('Done.'));
  const events = await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
  expect(JSON.stringify(events)).not.toContain(TOKEN);
  expect(JSON.stringify(logs.map((spy) => spy.mock.calls))).not.toContain(
    TOKEN,
  );
});

it('reports an unavailable model with the live model list and sends no request', async () => {
  const f = fixture(fakeAuth(), 'gpt-9-nonexistent');
  const network = vi.spyOn(globalThis, 'fetch');
  await expect(
    lastValueFrom(f.agent.run(f.input).pipe(toArray())),
  ).rejects.toThrow(/gpt-9-nonexistent.*gpt-5\.6-luna, gpt-6-astra/);
  expect(network).not.toHaveBeenCalled();
});

it('surfaces a signed-out account as a sign-in error, not a connection error', async () => {
  const f = fixture(
    fakeAuth({
      getAccessToken: async () => {
        throw new ChatGPTPlanError(
          'sign_in_required',
          'Sign in with ChatGPT to continue.',
          401,
        );
      },
    }),
  );
  const network = vi.spyOn(globalThis, 'fetch');
  await expect(
    lastValueFrom(f.agent.run(f.input).pipe(toArray())),
  ).rejects.toThrow('Sign in with ChatGPT to continue.');
  expect(network).not.toHaveBeenCalled();
});

it('asks for the missing chatgpt-plan settings in setup status', () => {
  const config = {
    intelligenceKey: 'fixture',
    baseUrl: '',
    runtimeUrl: '',
    voiceName: 'marin',
    slackUsers: [],
  };
  expect(
    setupStatus({
      ...config,
      modelProvider: chatgptPlanProvider({}),
    }),
  ).toMatchObject({
    model: false,
    missing: ['CHATGPT_DEVKIT_DIST', 'OPENAI_MODEL'],
  });
  expect(
    setupStatus({
      ...config,
      modelProvider: chatgptPlanProvider({ auth: fakeAuth(), model: 'm' }),
    }),
  ).toMatchObject({ model: true, missing: [] });
});
