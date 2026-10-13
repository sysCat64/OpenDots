import { afterEach, describe, expect, it } from 'vitest';
import type { BaseEvent } from '@ag-ui/core';
import type { DotAgent } from '../src/server/dot-agent';
import { UNKNOWN_OUTCOME_CONTENT } from '../src/server/run-rules';
import { CLIENT_TOOL, user } from './helpers/event-fixtures';
import {
  THREAD,
  createWorld,
  durable,
  readWitness,
  type World,
} from './helpers/dot-stop-world';
import {
  functionCallOutputs,
  responsesCalls,
  type ResponsesCall,
  type ResponsesEnding,
} from './helpers/responses-call-stream';

// A + A' on the PRODUCTION DotAgent (BuiltInAgent -> TanStack chat() -> the
// production tools -> a real WorkspaceStore) behind the production
// DurableAgentRunner, through the production ChatGPT-plan provider (the OpenAI
// Responses adapter). The model is a local function standing in for fetch; a
// separate SQLite witness records executor entry and the committed effect.
//
// What these pin: a server tool call whose TOOL_CALL_END is durable and whose
// result is not is recorded as an UNKNOWN outcome, whatever ended the run
// (a provider failure after the call, the agent aborting itself on its watcher
// or its 90 s timer, a stop), and the next turn neither runs it nor tells the
// model it failed.
const worlds: World[] = [];
afterEach(() => {
  while (worlds.length) worlds.pop()!.close();
});
const make = (options: Parameters<typeof createWorld>[0] = {}) => {
  const world = createWorld({ plan: true, ...options });
  worlds.push(world);
  return world;
};

const create = (n: number, callId = `call-${n}`): ResponsesCall => ({
  callId,
  name: 'create_space_page',
  args: { title: `Notes ${n}`, content: 'x' },
});
const browse = (callId = 'call-2'): ResponsesCall => ({
  callId,
  name: 'read_public_page',
  args: { url: 'https://example.invalid/page' },
});
const answer = (text = 'Understood.') => responsesCalls([], 'completed', text);
const capture = () =>
  Response.json({
    title: 'Example',
    url: 'https://example.invalid/page',
    text: 'synthetic page text',
  });
const types = (run: ReturnType<typeof durable>) =>
  run.events.map(
    (e) =>
      `${String(e.type).replace('TOOL_CALL_', 'TC_')}${e.toolCallId ? ':' + String(e.toolCallId) : ''}`,
  );
const resultOf = (run: ReturnType<typeof durable>, id: string) =>
  run.results.find((r) => r.toolCallId === id)?.content;
const isStockError = (content: unknown) => {
  try {
    const parsed = JSON.parse(String(content)) as Record<string, unknown>;
    return (
      parsed.status === 'error' && parsed.reason === 'missing_terminal_event'
    );
  } catch {
    return false;
  }
};

// The next turn the way the UI sends it: the materialized history plus a new
// user message. The model answers with text, so any executor entry would have
// to come from the engine's own pre-model dispatch of an unanswered call.
async function nextTurn(world: World, runId = 'r2') {
  const history = await world.runner.messagesFor(THREAD);
  world.setScript(() => answer());
  const witness = readWitness(world.witnessDb);
  const pages = world.pages();
  const requests = world.requests.length;
  await world.runTurn(runId, [...history, user('u2', 'Did it work?')]);
  const sent = world.requests.slice(requests);
  expect(durable(world, runId).status).toBe('finished');
  return {
    requests: sent.length,
    outputs: sent[0] ? functionCallOutputs(sent[0].body) : [],
    executorEntries: readWitness(world.witnessDb).length - witness.length,
    pagesChanged: world.pages().length !== pages.length,
  };
}

describe('A on the production ChatGPT-plan provider (F4, F5)', () => {
  const endings: ResponsesEnding[] = ['failed', 'incomplete', 'fault', 'close'];
  for (const ending of endings)
    it(`TS-A1 a response that ends '${ending}' after a complete call records the marker; the next turn runs nothing`, async () => {
      const world = make();
      const appends: string[][] = [];
      world.log.beforeAppend = (events) =>
        appends.push(events.map((e) => String(e.type)));
      world.setScript(() => responsesCalls([create(1)], ending));
      const published = await world.runTurn('r1', [
        user('u1', 'Create a page called Notes.'),
      ]);
      world.log.beforeAppend = undefined;
      const run = durable(world, 'r1');
      // The call completed, nothing started its executor, and the run did not
      // finish: the log says exactly "unknown", never "error" and never "ok".
      expect(types(run).slice(-3)).toEqual([
        'TC_END:call-1',
        'TC_RESULT:call-1',
        'RUN_ERROR',
      ]);
      expect(resultOf(run, 'call-1')).toBe(UNKNOWN_OUTCOME_CONTENT);
      expect(run.status).toBe('error');
      expect(published).toEqual(run.events as unknown as BaseEvent[]);
      expect(readWitness(world.witnessDb)).toEqual([]);
      expect(world.pages()).toEqual([]);
      expect(world.log.checkInvariants()).toEqual([]);
      // TS-A2: the model is told the outcome is unknown, and nothing runs.
      const next = await nextTurn(world);
      expect(next.requests).toBe(1);
      expect(next.outputs).toEqual([
        { callId: 'call-1', output: UNKNOWN_OUTCOME_CONTENT },
      ]);
      expect(next.executorEntries).toBe(0);
      expect(next.pagesChanged).toBe(false);
      expect(world.pages()).toEqual([]);
    });

  it('TS-A1 the marker and the terminal event are one append on the production path', async () => {
    const world = make();
    const appends: string[][] = [];
    world.log.beforeAppend = (events) =>
      appends.push(events.map((e) => String(e.type)));
    world.setScript(() => responsesCalls([create(1)], 'failed'));
    await world.runTurn('r1', [user('u1', 'Create a page called Notes.')]);
    expect(appends.at(-1)).toEqual(['TOOL_CALL_RESULT', 'RUN_ERROR']);
  });

  it('a call whose arguments never completed gets no result and no marker; its executor never ran', async () => {
    const world = make();
    world.setScript(() =>
      responsesCalls([{ ...create(1), partial: true }], 'fault'),
    );
    await world.runTurn('r1', [user('u1', 'Create a page called Notes.')]);
    const run = durable(world, 'r1');
    expect(run.results).toEqual([]);
    expect(types(run).at(-1)).toBe('RUN_ERROR');
    expect(readWitness(world.witnessDb)).toEqual([]);
  });

  it('a complete call whose executor really ran keeps its real result', async () => {
    const world = make();
    world.setScript((n) =>
      n === 1
        ? responsesCalls([create(1)], 'completed')
        : responsesCalls([], 'fault'),
    );
    await world.runTurn('r1', [user('u1', 'Create a page called Notes.')]);
    const run = durable(world, 'r1');
    expect(world.pages()).toEqual(['Notes 1']);
    const result = resultOf(run, 'call-1')!;
    expect(result).not.toBe(UNKNOWN_OUTCOME_CONTENT);
    expect(JSON.parse(result)).toMatchObject({ title: 'Notes 1' });
    expect(types(run).filter((t) => t === 'TC_RESULT:call-1')).toHaveLength(1);
  });

  it('TS-A3 a pending client (HITL) call is left unanswered on the production path', async () => {
    const world = make();
    world.setScript((n) =>
      n === 1
        ? responsesCalls(
            [
              {
                callId: 'review-1',
                name: CLIENT_TOOL,
                args: { title: 't', content: 'c', spaceId: 's' },
              },
            ],
            'completed',
          )
        : answer(),
    );
    await world.runTurn('r1', [user('u1', 'Review before saving.')], {
      tools: [{ name: CLIENT_TOOL, description: 'review', parameters: {} }],
    });
    const run = durable(world, 'r1');
    expect(types(run)).toContain('TC_END:review-1');
    expect(run.results).toEqual([]);
    expect(run.status).toBe('finished');
  });
});

describe("A': the agent aborts itself after an effect committed (F6)", () => {
  const batch = (n: number) =>
    n === 1
      ? responsesCalls([create(1, 'c1'), browse('c2')], 'completed')
      : answer();

  // The effect is committed, the batch is not finished, and the run ends with
  // no terminal event and no stop request. Whatever the cause, both calls must
  // be recorded as unknown, the effect must not be reported as an error, and
  // the next turn must neither run nor re-create anything.
  async function afterAbort(
    world: World,
    cause: (init: { signal?: AbortSignal | null }) => void | Promise<void>,
  ) {
    world.setScript(batch);
    world.hooks.onBrowse = async (init) => {
      await cause(init);
      // An executor that does not notice the abort: the worst case.
      return capture();
    };
    const published = await world.runTurn('r1', [
      user('u1', 'Create a page called Notes and read the example page.'),
    ]);
    world.hooks.onBrowse = undefined;
    return { published, run: durable(world, 'r1') };
  }

  function expectUnknown(
    world: World,
    run: ReturnType<typeof durable>,
    published: unknown,
  ) {
    expect(world.pages()).toEqual(['Notes 1']);
    expect(resultOf(run, 'c1')).toBe(UNKNOWN_OUTCOME_CONTENT);
    expect(resultOf(run, 'c2')).toBe(UNKNOWN_OUTCOME_CONTENT);
    expect(isStockError(resultOf(run, 'c1'))).toBe(false);
    expect(run.status).toBe('error');
    expect(types(run).at(-1)).toBe('RUN_ERROR');
    expect(published).toEqual(run.events);
    // c1's executor entered once and committed once; c2's entered once.
    expect(readWitness(world.witnessDb)).toEqual([
      'executorEntered',
      'sideEffectCommitted',
      'executorEntered',
    ]);
    expect(world.log.checkInvariants()).toEqual([]);
  }

  async function expectNoRerun(world: World) {
    const next = await nextTurn(world);
    expect(next.outputs).toEqual(
      expect.arrayContaining([
        { callId: 'c1', output: UNKNOWN_OUTCOME_CONTENT },
        { callId: 'c2', output: UNKNOWN_OUTCOME_CONTENT },
      ]),
    );
    expect(next.executorEntries).toBe(0);
    expect(world.pages()).toEqual(['Notes 1']);
  }

  it('TS-AP1 agent.abortRun() after the effect committed', async () => {
    const world = make({ research: true });
    let agent: DotAgent | undefined;
    world.onNewAgent = (created) => (agent = created);
    const { published, run } = await afterAbort(world, () => {
      agent!.abortRun();
    });
    expectUnknown(world, run, published);
    await expectNoRerun(world);
  });

  it('TS-AP2 the 100 ms watcher after the owner pauses the Dot mid-batch', async () => {
    const world = make({ research: true });
    const { published, run } = await afterAbort(world, async (init) => {
      world.store.updateSettings({ paused: true });
      // The production watcher is a real 100 ms interval.
      await new Promise<void>((resolve) =>
        init.signal?.addEventListener('abort', () => resolve(), { once: true }),
      );
    });
    world.store.updateSettings({ paused: false });
    expectUnknown(world, run, published);
    await expectNoRerun(world);
  });

  it('TS-AP3 the 90 s timer, with a controlled clock', async () => {
    const world = make({ research: true });
    const realSetTimeout = globalThis.setTimeout;
    const ninety: Array<() => void> = [];
    globalThis.setTimeout = ((
      fn: (...args: unknown[]) => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      if (ms === 90_000) {
        ninety.push(fn as () => void);
        return realSetTimeout(() => undefined, 0);
      }
      return realSetTimeout(fn, ms, ...rest);
    }) as typeof setTimeout;
    try {
      const { published, run } = await afterAbort(world, () => {
        // The run's one 90 s timer fires while c2 is still in flight.
        expect(ninety).toHaveLength(1);
        ninety[0]();
      });
      expectUnknown(world, run, published);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    await expectNoRerun(world);
  });

  it('TS-AP4 a pause while the model is still streaming: no tool call, nothing is marked', async () => {
    const world = make();
    world.setScript(() => {
      // Headers now; the body arrives after the 100 ms watcher has fired.
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (sent === 0) {
            sent = 1;
            world.store.updateSettings({ paused: true });
            await new Promise((r) => setTimeout(r, 400));
            controller.enqueue(
              new TextEncoder().encode(
                'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"r","object":"response","model":"custom-model","status":"in_progress","output":[]}}\n\n',
              ),
            );
            return;
          }
          controller.close();
        },
      });
      return new Response(body, {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });
    await world.runTurn('r1', [user('u1', 'Create a page called Notes.')]);
    world.store.updateSettings({ paused: false });
    const run = durable(world, 'r1');
    expect(run.results).toEqual([]);
    expect(types(run)).not.toContain('TC_END:call-1');
    expect(readWitness(world.witnessDb)).toEqual([]);
    expect(run.status).toBe('error');
  });

  it('TS-AP5 runner.stop() after the effect committed is unchanged: markers, status stopped', async () => {
    const world = make({ research: true });
    const { published, run } = await afterAbort(world, async () => {
      void world.runner.stop({ threadId: THREAD, runId: 'r1' });
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(world.pages()).toEqual(['Notes 1']);
    expect(resultOf(run, 'c1')).toBe(UNKNOWN_OUTCOME_CONTENT);
    expect(resultOf(run, 'c2')).toBe(UNKNOWN_OUTCOME_CONTENT);
    expect(run.status).toBe('stopped');
    expect(types(run).at(-1)).toBe('RUN_FINISHED');
    expect(published).toEqual(run.events);
  });
});
