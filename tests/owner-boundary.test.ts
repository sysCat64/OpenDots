import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createApp } from '../src/server/app';
import type { ModelProvider } from '../src/server/model-provider';
import { Platform } from '../src/server/platform';
import { Runner } from '../src/server/runner';
import { Store } from '../src/server/store';
import { WorkspaceStore } from '../src/server/workspace';
import { snapshotDatabase } from './helpers/db-snapshot';

// The real app, platform and scope validation, with two spies on what must stay
// untouched for a rejected request: the CopilotKit runtime handler (every agent
// run, provider call, tool execution and durable write happens inside it) and
// the model provider's adapter. A full database snapshot covers writes made
// outside the runtime.
const TOKEN = randomBytes(24).toString('hex');
let dir: string;
let database: string;
let store: Store;
let workspace: WorkspaceStore;
let app: ReturnType<typeof createApp>;
let handlerFetch: ReturnType<typeof vi.spyOn>;
let dotA: string;
let dotB: string;
const THREAD = 'boundary-thread';
const createAdapter = vi.fn(() => {
  throw new Error('The provider must not be reached.');
});

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'opendots-boundary-'));
  database = join(dir, 'boundary.sqlite');
  store = new Store(database);
  workspace = new WorkspaceStore(database, 'owner');
  const first = workspace.dots()[0];
  dotA = first.id;
  dotB = workspace.createDot(
    first.spaceId,
    'Second',
    'Other Dot',
    true,
    true,
  ).id;
  workspace.bindThread(THREAD, dotA, 'Bound to A');
  const modelProvider: ModelProvider = {
    kind: 'api-key',
    configured: true,
    missing: [],
    modelOptions: {},
    createAdapter: createAdapter as unknown as ModelProvider['createAdapter'],
  };
  const platform = new Platform(store, workspace, {
    intelligenceKey: 'fixture-intelligence-key',
    intelligenceApiUrl: 'http://127.0.0.1:9',
    intelligenceWsUrl: 'ws://127.0.0.1:9',
    baseUrl: 'http://127.0.0.1:9',
    modelProvider,
    voiceName: 'marin',
    slackUsers: [],
    runtimeUrl: 'http://127.0.0.1:9/api/copilotkit',
    ownerToken: TOKEN,
  });
  handlerFetch = vi.spyOn(platform.handler!, 'fetch');
  const config = { mode: 'sample' as const, baseUrl: 'http://127.0.0.1:9' };
  app = createApp({
    store,
    runner: new Runner(store, config),
    config,
    ownerToken: TOKEN,
    platform,
  });
});

afterEach(() => {
  handlerFetch.mockClear();
  createAdapter.mockClear();
});

afterAll(() => {
  store.close();
  workspace.close();
  rmSync(dir, { recursive: true, force: true });
});

const run = (threadId: string) =>
  JSON.stringify({
    threadId,
    runId: 'boundary-run',
    state: {},
    messages: [{ id: 'm1', role: 'user', content: 'hello' }],
    tools: [],
    context: [],
    forwardedProps: {},
  });

type Call = [method: string, path: string, body?: string];
const rt = '/api/copilotkit';
// Requests that can read, run, stop or destroy a conversation.
const runtimeCalls: Record<string, Call> = {
  info: ['GET', `${rt}/info`],
  'thread list': ['GET', `${rt}/threads`],
  'thread messages': ['GET', `${rt}/threads/${THREAD}/messages`],
  'thread events': ['GET', `${rt}/threads/${THREAD}/events`],
  run: ['POST', `/api/copilotkit/agent/A/run`, run(THREAD)],
};

function request([method, path, body]: Call, authorization?: string) {
  return app.request(path.replace('/agent/A/', `/agent/${dotA}/`), {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(authorization === undefined ? {} : { Authorization: authorization }),
    },
    body,
  });
}

// Sends one request and asserts it ran nothing and wrote nothing.
async function rejected(
  call: Call,
  authorization: string | undefined,
  status: number,
) {
  const before = snapshotDatabase(database);
  const response = await request(call, authorization);
  const text = await response.text();
  const label = `${call[0]} ${call[1]}`;
  expect(response.status, label).toBe(status);
  expect(handlerFetch, label).not.toHaveBeenCalled();
  expect(createAdapter, label).not.toHaveBeenCalled();
  expect(snapshotDatabase(database), label).toBe(before);
  expect(text, label).not.toContain(TOKEN);
}

const allCalls: Call[] = [
  ...Object.values(runtimeCalls),
  ['POST', `${rt}/agent/A/connect`, run(THREAD)],
  ['POST', `${rt}/agent/A/stop/${THREAD}`, '{}'],
  ['POST', `${rt}/agent/A/suggest`, run(THREAD)],
  ['POST', `${rt}/threads/clear`, '{}'],
  ['GET', '/api/state'],
  ['GET', '/api/workspace'],
];

describe('without a valid owner token', () => {
  const other = randomBytes(24).toString('hex');
  it.each([
    ['no Authorization header', undefined],
    ['a wrong token of the same length', `Bearer ${other}`],
    ['a shorter wrong token', `Bearer ${other.slice(0, 10)}`],
    ['a longer wrong token', `Bearer ${other}${other}`],
    ['an empty bearer', 'Bearer '],
  ])('rejects %s with 401 before anything runs', async (_name, header) => {
    for (const call of allCalls) await rejected(call, header, 401);
  });
});

describe('with the right token but the wrong scope', () => {
  const token = `Bearer ${TOKEN}`;
  it.each<[string, Call]>([
    ['an unknown agent', ['POST', `${rt}/agent/no-such-dot/run`, run(THREAD)]],
    [
      'another Dot than the thread belongs to',
      ['POST', `${rt}/agent/B/run`, run(THREAD)],
    ],
    ['an unknown thread', ['POST', `${rt}/agent/A/run`, run('foreign-thread')]],
    [
      'connect to an unknown thread',
      ['POST', `${rt}/agent/A/connect`, run('foreign-thread')],
    ],
    [
      'stop of an unknown thread',
      ['POST', `${rt}/agent/A/stop/foreign-thread`, '{}'],
    ],
    [
      'messages of an unknown thread',
      ['GET', `${rt}/threads/foreign-thread/messages`],
    ],
    [
      'a thread named in the route and another in the query',
      ['GET', `${rt}/threads/${THREAD}/messages?threadId=foreign-thread`],
    ],
    [
      'a runtime route OpenDots does not enable',
      ['GET', `${rt}/inspector-metadata`],
    ],
  ])('rejects %s with 403 before anything runs', async (_name, call) => {
    const resolved: Call = [
      call[0],
      call[1].replace('/agent/B/', `/agent/${dotB}/`),
      call[2],
    ];
    await rejected(resolved, token, 403);
  });

  it('answers 401, not 403, when the token is also missing', async () => {
    await rejected(
      ['POST', `${rt}/agent/no-such-dot/run`, run('foreign-thread')],
      undefined,
      401,
    );
  });
});

describe('DEC-17: /agent/:id/suggest', () => {
  it('is denied even for the owner, on a bound thread, for the right Dot', async () => {
    await rejected(
      ['POST', `${rt}/agent/A/suggest`, run(THREAD)],
      `Bearer ${TOKEN}`,
      403,
    );
  });
});

describe('DEC-16: /threads/clear', () => {
  it.each<[string, Call]>([
    ['POST', ['POST', `${rt}/threads/clear`, '{}']],
    ['DELETE', ['DELETE', `${rt}/threads/clear`, '{}']],
    ['GET', ['GET', `${rt}/threads/clear`]],
    ['PATCH', ['PATCH', `${rt}/threads/clear`, '{}']],
    ['a percent-encoded name', ['POST', `${rt}/threads/%63lear`, '{}']],
  ])(
    'is denied for the owner (%s) and deletes nothing',
    async (_name, call) => {
      await rejected(call, `Bearer ${TOKEN}`, 403);
      expect(workspace.conversations().map((thread) => thread.id)).toContain(
        THREAD,
      );
    },
  );
});

describe('with the right token and the right scope', () => {
  const token = `Bearer ${TOKEN}`;

  it('serves the runtime info through the real handler', async () => {
    const response = await request(runtimeCalls.info, token);
    expect(response.status).toBe(200);
    expect(handlerFetch).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Call]>([
    ['run', runtimeCalls.run],
    ['connect', ['POST', `${rt}/agent/A/connect`, run(THREAD)]],
    ['stop', ['POST', `${rt}/agent/A/stop/${THREAD}`, '{}']],
    ['thread messages', runtimeCalls['thread messages']],
    ['thread list', runtimeCalls['thread list']],
  ])('forwards %s to the runtime', async (_name, call) => {
    handlerFetch.mockImplementationOnce(async () =>
      Response.json({ reached: true }),
    );
    const response = await request(call, token);
    expect(response.status).toBe(200);
    expect(handlerFetch).toHaveBeenCalledTimes(1);
  });

  it('still serves the application API', async () => {
    expect((await request(['GET', '/api/state'], token)).status).toBe(200);
    expect((await request(['GET', '/api/workspace'], token)).status).toBe(200);
  });
});
