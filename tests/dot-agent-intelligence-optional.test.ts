import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventType } from '@ag-ui/core';
import { CopilotKitIntelligence } from '@copilotkit/runtime/v2';
import { maxIterations } from '@tanstack/ai';
import { lastValueFrom, toArray } from 'rxjs';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { DotAgent } from '../src/server/dot-agent.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { startCounter, type Counter } from './helpers/counting-server';
import { readLines } from './helpers/server-entry';
import { completion } from './fixtures/model-stream.js';

// What DotAgent hands to BuiltInAgent is the contract under test, so the real
// BuiltInAgent is subclassed only to record its configuration. It still runs
// the real SDK constructor, including whatever it builds from that option.
const sdk = vi.hoisted(() => ({ configs: [] as Record<string, unknown>[] }));
vi.mock('@copilotkit/runtime/v2', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@copilotkit/runtime/v2')>();
  class RecordingBuiltInAgent extends actual.BuiltInAgent {
    constructor(config: ConstructorParameters<typeof actual.BuiltInAgent>[0]) {
      sdk.configs.push(config as unknown as Record<string, unknown>);
      super(config);
    }
  }
  return { ...actual, BuiltInAgent: RecordingBuiltInAgent };
});
vi.mock('@tanstack/ai', { spy: true });

const MODEL_URL = 'https://unused.invalid/v1';
const KEY = 'intelligence-fixture-key';
let dir: string;
let remote: Counter;
let fetched: string[];
let guardLog: string;
const databases: Array<{ close(): void }> = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'opendots-dot-agent-'));
  guardLog = join(dir, 'blocked.txt');
  // Refuses and records any non-loopback connection made by this process.
  process.env.OPENDOTS_NET_GUARD_LOG = guardLog;
  await import('./fixtures/telemetry/net-guard');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  remote = await startCounter();
  sdk.configs.length = 0;
  vi.mocked(maxIterations).mockClear();
  fetched = [];
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    fetched.push(url);
    // Loopback is real so the counter sees it; the model is faked; nothing
    // else is allowed to be called.
    if (url.startsWith('http://127.0.0.1')) return realFetch(input, init);
    if (url.startsWith(MODEL_URL))
      return completion({ role: 'assistant', content: 'ok' });
    throw new Error(`unexpected network call: ${url}`);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  databases.splice(0).forEach((db) => db.close());
  await remote.close();
});

interface Setup {
  intelligenceKey?: string;
  learning?: boolean;
  provider?: boolean;
}

function fixture({ intelligenceKey, learning, provider = true }: Setup) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  databases.push(store, workspace);
  const dot = workspace.dots()[0];
  if (learning)
    workspace.updateDot(dot.id, {
      ...dot,
      learningContainerId: 'research',
      skillDeliveryEnabled: true,
    });
  workspace.bindThread('thread', dot.id, 'Thread');
  const config: PlatformConfig = {
    ...(intelligenceKey
      ? { intelligenceKey, intelligenceApiUrl: remote.url }
      : {}),
    ...(provider
      ? { apiKey: 'provider-fixture-key', model: 'custom-model' }
      : {}),
    baseUrl: MODEL_URL,
    runtimeUrl: '',
    voiceName: 'marin',
    slackUsers: [],
  };
  return new DotAgent(store, workspace, config, dot.id);
}

function run(agent: DotAgent) {
  return lastValueFrom(
    agent
      .run({
        threadId: 'thread',
        runId: 'run',
        messages: [{ id: 'm1', role: 'user', content: 'hello' }],
        state: {},
        tools: [],
        context: [],
        forwardedProps: {},
      })
      .pipe(toArray()),
  );
}

// The faked model's reply reached the caller: the run really went through.
const completed = (events: Array<{ type: EventType; delta?: string }>) =>
  events.some(
    (event) =>
      event.type === EventType.TEXT_MESSAGE_CHUNK && event.delta === 'ok',
  );
const leftTheMachine = () => readLines(guardLog);

describe('DotAgent without an Intelligence key (dormant path)', () => {
  it.each([
    ['learning disabled', false, 5],
    // maxIterations follows stored Dot data, not the key: C3 does not change
    // that, so a learning-enabled Dot keeps its current cap.
    ['a learning-enabled stored Dot', true, 10],
  ])(
    'runs with %s and builds no learned-skills registry',
    async (_name, learning, cap) => {
      const events = await run(fixture({ learning }));
      expect(events.map((event) => event.type)).not.toContain(
        EventType.RUN_ERROR,
      );
      expect(completed(events)).toBe(true);
      expect(sdk.configs).toHaveLength(1);
      // Absent, not undefined, empty or keyless: any learnedSkills value makes
      // the SDK build a registry.
      expect(sdk.configs[0]).not.toHaveProperty('learnedSkills');
      expect(maxIterations).toHaveBeenCalledWith(cap);
      // Nothing was fetched except the model, and nothing reached Intelligence.
      expect(fetched.every((url) => url.startsWith(MODEL_URL))).toBe(true);
      expect(remote.count()).toBe(0);
      expect(leftTheMachine()).toEqual([]);
    },
  );

  it('does not rediscover Intelligence from stale environment', async () => {
    // Every setting the SDK or this app has ever read for the remote path,
    // pointed at a loopback counter.
    vi.stubEnv('INTELLIGENCE_API_KEY', KEY);
    vi.stubEnv('INTELLIGENCE_API_URL', remote.url);
    vi.stubEnv('INTELLIGENCE_WS_URL', remote.url.replace('http', 'ws'));
    vi.stubEnv('CPK_INTELLIGENCE_API_KEY', KEY);
    vi.stubEnv('CPK_INTELLIGENCE_LEARNING_CONTAINER_ID', 'research');
    const events = await run(fixture({ learning: true }));
    expect(completed(events)).toBe(true);
    expect(sdk.configs[0]).not.toHaveProperty('learnedSkills');
    expect(fetched.every((url) => url.startsWith(MODEL_URL))).toBe(true);
    expect(remote.count()).toBe(0);
    expect(leftTheMachine()).toEqual([]);
  });

  it.each([
    ['without an Intelligence key', undefined],
    ['with an Intelligence key', KEY],
  ])('still requires a configured model provider %s', async (_name, key) => {
    const events = await run(
      fixture({ intelligenceKey: key, provider: false, learning: true }),
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: EventType.RUN_ERROR,
        message: 'Model configuration is required.',
      }),
    ]);
    // Neither the SDK nor the network was reached, and no credential is named.
    expect(sdk.configs).toHaveLength(0);
    expect(fetched).toEqual([]);
    expect(JSON.stringify(events)).not.toContain(KEY);
    expect(JSON.stringify(events)).not.toContain('provider-fixture-key');
  });
});

describe('DotAgent with an Intelligence key (the active path)', () => {
  it('passes the same learned-skills configuration as before', async () => {
    // The loopback counter answers 503, so the registry's fetch fails and the
    // run ends in an error; only what was configured and contacted matters.
    await run(fixture({ intelligenceKey: KEY, learning: true })).catch(
      () => undefined,
    );
    expect(sdk.configs).toHaveLength(1);
    expect(sdk.configs[0].learnedSkills).toEqual({
      containers: [{ id: 'research' }],
      apiKey: KEY,
      apiUrl: remote.url,
    });
    // The registry really is live: it went to Intelligence. This is what makes
    // the zero counts above meaningful.
    expect(remote.count()).toBeGreaterThan(0);
  });

  it('keeps the learning loop cap of 10 when the skills are delivered', async () => {
    const bytes = readFileSync(
      new URL('./fixtures/learning-skills.zip', import.meta.url),
    );
    vi.spyOn(
      CopilotKitIntelligence.prototype,
      'getLearnedSkillsSnapshots',
    ).mockResolvedValue([
      {
        containerId: 'research',
        status: 'snapshot',
        bytes,
        revision: 'fixture-v1',
        etag: `"${createHash('sha256').update(bytes).digest('hex')}"`,
        contentType: 'application/zip',
      },
    ]);
    const events = await run(fixture({ intelligenceKey: KEY, learning: true }));
    expect(completed(events)).toBe(true);
    expect(maxIterations).toHaveBeenCalledWith(10);
  });

  it('passes no learned skills for a Dot without learning, as before', async () => {
    const events = await run(fixture({ intelligenceKey: KEY }));
    expect(completed(events)).toBe(true);
    expect(sdk.configs[0].learnedSkills).toBeUndefined();
    expect(maxIterations).toHaveBeenCalledWith(5);
  });
});
