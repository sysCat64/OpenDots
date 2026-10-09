import type { DatabaseSync } from 'node:sqlite';
import type { RunAgentInput } from '@ag-ui/core';
import { BuiltInAgent } from '@copilotkit/runtime/v2';
import { Observable } from 'rxjs';
import { DotAgent } from '../../src/server/dot-agent';
import { Store } from '../../src/server/store';
import { WorkspaceStore } from '../../src/server/workspace';
import { DatabaseSync as WitnessDatabase } from 'node:sqlite';

// Test-only. The ACTUAL production DotAgent (BuiltInAgent -> TanStack chat() -> production
// tanstackTools -> production page tools -> a real WorkspaceStore), driven
// offline: the model is a local function standing in for global fetch, and the
// side effect is a real page write into a throwaway workspace. A separate file
// database (the witness) records executor entry and the committed side effect.
export function openWitness(path: string): DatabaseSync {
  const db = new WitnessDatabase(path);
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS witness (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL)',
  );
  return db;
}
export function readWitness(db: DatabaseSync): string[] {
  return db
    .prepare('SELECT kind FROM witness ORDER BY seq')
    .all()
    .map((row) => String(row.kind));
}

export const THREAD = 't-dot';
export const RUN = 'r-dot';
export const CALL1 = 'call-1';
export const CALL2 = 'call-2';

// The committed event types of the Dot run, as a given connection sees them.
export const tuple = (db: DatabaseSync): string[] =>
  db
    .prepare(
      'SELECT eventType FROM conversation_events WHERE threadId = ? AND runId = ? ORDER BY seq',
    )
    .all(THREAD, RUN)
    .map((row) => String(row.eventType));

export interface DotWorldOptions {
  observer: DatabaseSync;
  witness: DatabaseSync;
  argChunks?: number;
  textFirst?: boolean;
  twoTools?: boolean;
  // Called at executor entry (the first line of the production executor that
  // reaches the workspace), after the instrumentation.
  freezeAt?: (point: 'entered' | 'committed', n: number) => void;
}

export interface DotEntry {
  n: number;
  toolCallId: string;
  durableTypes: string[];
  durableCallEvents: string[];
}

export function pieces(text: string, count: number): string[] {
  const size = Math.max(1, Math.ceil(text.length / count));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
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

export function createDotWorld(options: DotWorldOptions) {
  const { observer, witness } = options;
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const dot = workspace.dots()[0];
  workspace.bindThread(THREAD, dot.id, 'fence test');
  const agent = new DotAgent(
    store,
    workspace,
    {
      intelligenceKey: 'fixture',
      apiKey: 'fixture',
      model: 'custom-model',
      baseUrl: 'https://unused.invalid/v1',
      runtimeUrl: '',
      voiceName: 'marin',
      slackUsers: [],
    },
    dot.id,
  );

  const entries: DotEntry[] = [];
  const modelRequests: Array<{ url: string; durableAtRequest: string[] }> = [];
  const unexpectedFetch: string[] = [];
  const durableTypes = () =>
    observer
      .prepare(
        'SELECT eventType FROM conversation_events WHERE threadId = ? AND runId = ? ORDER BY seq',
      )
      .all(THREAD, RUN)
      .map((row) => String(row.eventType));
  const durableFor = (toolCallId: string) =>
    observer
      .prepare(
        "SELECT eventType FROM conversation_events WHERE threadId = ? AND runId = ? AND json_extract(eventJson, '$.toolCallId') = ? ORDER BY seq",
      )
      .all(THREAD, RUN, toolCallId)
      .map((row) => String(row.eventType));
  const mark = (kind: string) =>
    witness.exec(`INSERT INTO witness (kind) VALUES ('${kind}')`);

  // The executor: workspace.pages.create is the first call of the production
  // create_space_page executor that has an effect. Instrumented on the instance.
  const pages = workspace.pages as unknown as {
    create: (...args: unknown[]) => unknown;
  };
  const originalCreate = pages.create.bind(workspace.pages);
  let executorCalls = 0;
  pages.create = (...args: unknown[]) => {
    executorCalls += 1;
    const n = executorCalls;
    const toolCallId = n === 1 ? CALL1 : CALL2;
    entries.push({
      n,
      toolCallId,
      durableTypes: durableTypes(),
      durableCallEvents: durableFor(toolCallId),
    });
    mark('executorEntered');
    options.freezeAt?.('entered', n);
    const result = originalCreate(...args);
    mark('sideEffectCommitted');
    options.freezeAt?.('committed', n);
    return result;
  };

  const title = (n: number) => `Notes ${n}`;
  const argsFor = (n: number) =>
    JSON.stringify({
      title: title(n),
      content: 'x'.repeat(Math.max(1, options.argChunks ?? 2)),
    });
  const toolDelta = (n: number) => {
    const text = argsFor(n);
    const parts = pieces(text, options.argChunks ?? 2);
    return [
      {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: n === 1 ? CALL1 : CALL2,
            type: 'function',
            function: { name: 'create_space_page', arguments: '' },
          },
        ],
      },
      ...parts.map((part) => ({
        tool_calls: [{ index: 0, function: { arguments: part } }],
      })),
    ];
  };

  const realFetch = globalThis.fetch;
  let round = 0;
  globalThis.fetch = (async (input: unknown) => {
    const url = String((input as { url?: string })?.url ?? input);
    if (!url.endsWith('/chat/completions')) {
      unexpectedFetch.push(url);
      throw new Error(`unexpected fetch ${url}`);
    }
    modelRequests.push({ url, durableAtRequest: durableTypes() });
    const current = round++;
    if (current === 0)
      return sse(
        [
          ...(options.textFirst
            ? [{ role: 'assistant', content: 'Let me create that page.' }]
            : []),
          ...toolDelta(1),
        ],
        'tool_calls',
      );
    if (current === 1 && options.twoTools)
      return sse(toolDelta(2), 'tool_calls');
    return sse([{ role: 'assistant', content: 'Created.' }], 'stop');
  }) as typeof fetch;

  const input: RunAgentInput = {
    threadId: THREAD,
    runId: RUN,
    state: {},
    messages: [
      { id: 'u1', role: 'user', content: 'Create a page called Notes.' },
    ],
    tools: [],
    context: [],
    forwardedProps: {},
  };
  agent.agentId = dot.id;
  agent.setMessages(input.messages);
  agent.setState(input.state);
  agent.threadId = THREAD;

  return {
    agent,
    input,
    workspace,
    dot,
    store,
    entries,
    modelRequests,
    unexpectedFetch,
    pagesTitled: () =>
      workspace.pages
        .list(dot.spaceId)
        .filter((page) => /^Notes \d$/.test(page.title)).length,
    close() {
      globalThis.fetch = realFetch;
      pages.create = originalCreate as never;
      workspace.close();
      store.close();
    },
  };
}

// C6 CANARY SHAPE. Observes the REAL producer boundary of the REAL DotAgent:
// DotAgent.run() builds a BuiltInAgent and forwards each of its events with
// subscriber.next(). This test-only patch of BuiltInAgent.prototype.run reports,
// when each downstream push RETURNS, whether that tool-call event is already
// durable. Any asynchronous step between the producer and the commit (a new
// operator, a new middleware, an SDK change) makes this fail, wherever it is.
export function probeProducerBoundary(observer: DatabaseSync) {
  const violations: string[] = [];
  const pushed: Record<string, number> = {};
  const original = BuiltInAgent.prototype.run;
  BuiltInAgent.prototype.run = function (this: BuiltInAgent, input: never) {
    const source = original.call(this, input);
    return new Observable((subscriber) => {
      const subscription = source.subscribe({
        next: (event) => {
          const type = String(event.type);
          pushed[type] = (pushed[type] ?? 0) + 1;
          subscriber.next(event);
          if (!type.startsWith('TOOL_CALL')) return;
          const row = observer
            .prepare(
              'SELECT count(*) AS n FROM conversation_events WHERE threadId = ? AND runId = ? AND eventType = ?',
            )
            .get(THREAD, RUN, type) as { n: number };
          if (row.n < pushed[type]) violations.push(type);
        },
        error: (error) => subscriber.error(error),
        complete: () => subscriber.complete(),
      });
      return () => subscription.unsubscribe();
    });
  } as typeof BuiltInAgent.prototype.run;
  return {
    violations,
    pushed,
    restore() {
      BuiltInAgent.prototype.run = original;
    },
  };
}
