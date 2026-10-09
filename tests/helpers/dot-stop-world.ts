import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { BaseEvent, Message, RunAgentInput } from '@ag-ui/core';
import { DotAgent } from '../../src/server/dot-agent';
import { Store } from '../../src/server/store';
import { WorkspaceStore } from '../../src/server/workspace';
import { ConversationLog } from '../../src/server/conversation-log';
import { DurableAgentRunner } from '../../src/server/durable-runner';
import { CLIENT_EXECUTABLE } from './event-fixtures';
import { ProbeLog } from './probe-log';
import { collect } from './runner-harness';
import { createThrowawayDatabase, openThrowawayDatabase } from './throwaway-db';
import { openWitness, readWitness } from './dot-fence-fixture';

// Test-only. The PRODUCTION DotAgent (BuiltInAgent -> TanStack chat() -> the
// production tools -> a real WorkspaceStore) behind the PRODUCTION
// DurableAgentRunner (A1 fence), offline: the model is a local function standing
// in for fetch and records every request body. A separate SQLite file (the
// witness) records executor entry and the committed side effect.
export const THREAD = 't-stop';
export { openWitness, readWitness };

export type Script = (n: number, body: ProviderBody) => Response;
export interface ProviderBody {
  messages: Array<{
    role: string;
    content?: unknown;
    tool_calls?: Array<{
      id: string;
      function: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
  }>;
  [k: string]: unknown;
}

const sse = (deltas: Array<Record<string, unknown>>, finish: string) =>
  new Response(
    [
      ...deltas.map((delta) => ({ index: 0, delta, finish_reason: null })),
      { index: 0, delta: {}, finish_reason: finish },
    ]
      .map(
        (choice) =>
          `data: ${JSON.stringify({ id: 'completion', object: 'chat.completion.chunk', created: 1, model: 'custom-model', choices: [choice] })}\n\n`,
      )
      .join('') + 'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
export const toolReply = (n: number, content = 'body') =>
  sse(
    [
      {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: `call-${n}`,
            type: 'function',
            function: { name: 'create_space_page', arguments: '' },
          },
        ],
      },
      {
        tool_calls: [
          {
            index: 0,
            function: {
              arguments: JSON.stringify({ title: `Notes ${n}`, content }),
            },
          },
        ],
      },
    ],
    'tool_calls',
  );
export const namedToolReply = (id: string, name: string, args: unknown) =>
  sse(
    [
      {
        role: 'assistant',
        tool_calls: [
          { index: 0, id, type: 'function', function: { name, arguments: '' } },
        ],
      },
      {
        tool_calls: [
          { index: 0, function: { arguments: JSON.stringify(args) } },
        ],
      },
    ],
    'tool_calls',
  );
export const parallelToolReply = (
  calls: Array<{ id: string; name: string; args: unknown }>,
) =>
  sse(
    [
      {
        role: 'assistant',
        tool_calls: calls.map((c, index) => ({
          index,
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: '' },
        })),
      },
      ...calls.map((c, index) => ({
        tool_calls: [
          { index, function: { arguments: JSON.stringify(c.args) } },
        ],
      })),
    ],
    'tool_calls',
  );
export const textReply = (text: string) =>
  sse([{ role: 'assistant', content: text }], 'stop');

export interface World {
  store: Store;
  workspace: WorkspaceStore;
  dotId: string;
  requests: Array<{ n: number; body: ProviderBody }>;
  witnessDb: DatabaseSync;
  observer: DatabaseSync;
  db: DatabaseSync;
  log: ProbeLog;
  runner: DurableAgentRunner;
  path: string;
  hooks: {
    onModelRequest?: (n: number) => void;
    onExecutor?: (point: 'entered' | 'committed', n: number) => void;
    // read_public_page's browser request (an ASYNC server executor). The init
    // carries the abort signal the production tool passes.
    onBrowse?: (init: {
      signal?: AbortSignal | null;
    }) => Response | Promise<Response>;
  };
  onNewAgent?: (agent: DotAgent) => void;
  setScript(script: Script): void;
  pages(): string[];
  newAgent(input: RunAgentInput): DotAgent;
  runTurn(
    runId: string,
    messages: Message[],
    extra?: Partial<RunAgentInput>,
  ): Promise<BaseEvent[]>;
  restartRunner(): { runner: DurableAgentRunner; log: ProbeLog };
  close(): void;
}

export function createWorld(
  options: {
    log?: (db: DatabaseSync) => ProbeLog;
    apiKey?: string;
    research?: boolean;
  } = {},
): World {
  const t = createThrowawayDatabase();
  const observer = openThrowawayDatabase(t.path);
  const witnessDb = openWitness(join(t.dir, 'witness.sqlite'));
  const log = options.log ? options.log(t.db) : new ProbeLog(t.db);
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const dot = workspace.dots()[0];
  workspace.bindThread(THREAD, dot.id, 'stop review');
  if (options.research)
    workspace.updateDot(dot.id, {
      name: dot.name,
      instructions: dot.instructions,
      researchAllowed: true,
      memoryAllowed: dot.memoryAllowed,
    });
  const runner = new DurableAgentRunner({
    log,
    clientExecutableToolNames: CLIENT_EXECUTABLE,
    ownsThread: () => true,
  });
  const requests: World['requests'] = [];
  const hooks: World['hooks'] = {};
  let script: Script = () => textReply('ok');

  const pagesApi = workspace.pages as unknown as {
    create: (...args: unknown[]) => unknown;
  };
  const originalCreate = pagesApi.create.bind(workspace.pages);
  let executorCalls = 0;
  pagesApi.create = (...args: unknown[]) => {
    const n = ++executorCalls;
    witnessDb.exec("INSERT INTO witness (kind) VALUES ('executorEntered')");
    hooks.onExecutor?.('entered', n);
    const result = originalCreate(...args);
    witnessDb.exec("INSERT INTO witness (kind) VALUES ('sideEffectCommitted')");
    hooks.onExecutor?.('committed', n);
    return result;
  };

  // The async executor's side effect: the capture the tool saves after its fetch.
  const workspaceApi = workspace as unknown as {
    saveCapture: (...a: unknown[]) => unknown;
  };
  const originalSave = workspaceApi.saveCapture.bind(workspace);
  workspaceApi.saveCapture = (...args: unknown[]) => {
    const result = originalSave(...args);
    witnessDb.exec("INSERT INTO witness (kind) VALUES ('sideEffectCommitted')");
    hooks.onExecutor?.('committed', 1);
    return result;
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: unknown,
    init?: { body?: unknown; signal?: AbortSignal | null },
  ) => {
    const url = String((input as { url?: string })?.url ?? input);
    if (url.endsWith('/browse') && hooks.onBrowse) {
      witnessDb.exec("INSERT INTO witness (kind) VALUES ('executorEntered')");
      hooks.onExecutor?.('entered', 1);
      return hooks.onBrowse(init ?? {});
    }
    if (!url.endsWith('/chat/completions'))
      throw new Error(`unexpected fetch ${url}`);
    const body = JSON.parse(
      String(init?.body ?? (input as { body?: string }).body ?? '{}'),
    ) as ProviderBody;
    const n = requests.length + 1;
    requests.push({ n, body });
    hooks.onModelRequest?.(n);
    return script(n, body);
  }) as typeof fetch;

  const world: World = {
    store,
    workspace,
    dotId: dot.id,
    requests,
    witnessDb,
    observer,
    db: t.db,
    log,
    runner,
    path: t.path,
    hooks,
    setScript: (s) => void (script = s),
    pages: () =>
      workspace.pages
        .list(dot.spaceId)
        .filter((p) => /^Notes \d$/.test(p.title))
        .map((p) => p.title),
    newAgent(input) {
      const agent = new DotAgent(
        store,
        workspace,
        {
          intelligenceKey: 'fixture',
          apiKey: options.apiKey ?? 'fixture',
          model: 'custom-model',
          baseUrl: 'https://unused.invalid/v1',
          browserUrl: options.research
            ? 'http://browser.invalid:4311'
            : undefined,
          browserSecret: options.research ? 'canary-browser-secret' : undefined,
          runtimeUrl: '',
          voiceName: 'marin',
          slackUsers: [],
        },
        dot.id,
      );
      agent.agentId = dot.id;
      agent.setMessages(input.messages);
      agent.setState(input.state);
      agent.threadId = input.threadId;
      world.onNewAgent?.(agent);
      return agent;
    },
    async runTurn(runId, messages, extra = {}) {
      const input: RunAgentInput = {
        threadId: THREAD,
        runId,
        state: {},
        messages,
        tools: [],
        context: [],
        forwardedProps: {},
        ...extra,
      };
      return collect(
        world.runner.run({
          threadId: THREAD,
          agent: world.newAgent(input) as never,
          input,
        }),
      );
    },
    restartRunner() {
      const fresh = new ProbeLog(t.db);
      return {
        log: fresh,
        runner: new DurableAgentRunner({
          log: fresh,
          clientExecutableToolNames: CLIENT_EXECUTABLE,
          ownsThread: () => true,
        }),
      };
    },
    close() {
      globalThis.fetch = realFetch;
      pagesApi.create = originalCreate as never;
      workspaceApi.saveCapture = originalSave as never;
      workspace.close();
      store.close();
      observer.close();
      witnessDb.close();
      t.cleanup();
    },
  };
  return world;
}

// What the log holds for a run, as another connection sees it.
export function durable(world: World, runId: string) {
  const events = new ConversationLog(world.observer)
    .runEvents(THREAD, runId)
    .map((s) => s.event as unknown as Record<string, unknown>);
  return {
    types: events.map((e) => String(e.type)),
    results: events
      .filter((e) => e.type === 'TOOL_CALL_RESULT')
      .map((e) => ({
        toolCallId: String(e.toolCallId),
        content: String(e.content),
      })),
    status: new ConversationLog(world.observer).getRun(THREAD, runId)?.status,
    events,
  };
}

// A provider request must pair every assistant tool call with a tool message and
// carry no orphan tool message, or the provider rejects it.
export function providerHistory(body: ProviderBody) {
  const calls = new Set<string>();
  const answered = new Set<string>();
  const toolMessages: Array<{ id: string; content: string }> = [];
  for (const m of body.messages) {
    for (const c of m.tool_calls ?? []) calls.add(c.id);
    if (m.role === 'tool') {
      answered.add(String(m.tool_call_id));
      toolMessages.push({
        id: String(m.tool_call_id),
        content: String(m.content),
      });
    }
  }
  const unanswered = [...calls].filter((id) => !answered.has(id));
  const orphans = [...answered].filter((id) => !calls.has(id));
  return {
    valid: !unanswered.length && !orphans.length,
    unanswered,
    orphans,
    toolMessages,
  };
}
