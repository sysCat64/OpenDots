import { afterEach, describe, expect, it } from 'vitest';
import { RunRejectedError } from '../src/server/durable-runner';
import { UNKNOWN_OUTCOME_CONTENT } from '../src/server/run-rules';
import { user } from './helpers/event-fixtures';
import {
  THREAD,
  createWorld,
  durable,
  namedToolReply,
  parallelToolReply,
  readWitness,
  textReply,
  type World,
} from './helpers/dot-stop-world';

// Can an already-entered server executor stay active after the runner records
// RUN_FINISHED and releases the thread? read_public_page is the production
// ASYNC server tool (a browser request, then a saved capture); here its request
// is held open by a latch. "Not finalized yet" is observed after a bounded
// number of event-loop turns, but the ORDER claims come from the trace: what
// happened before what, not from elapsed time.
const worlds: World[] = [];
afterEach(() => {
  while (worlds.length) worlds.pop()!.close();
});
const drain = async (turns = 300) => {
  for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));
};
const capture = (n: string) =>
  Response.json({ title: n, url: `https://${n}.example.com`, text: n });

describe('a stop while an async server executor is in flight', () => {
  it('is not finalized, and the thread stays reserved, until the executor settles', async () => {
    const world = createWorld({ research: true });
    worlds.push(world);
    const trace: string[] = [];
    let release!: () => void;
    const latch = new Promise<void>((resolve) => (release = resolve));
    world.setScript((n) =>
      n === 1
        ? namedToolReply('call-1', 'read_public_page', {
            url: 'https://example.com',
          })
        : textReply('Done.'),
    );
    world.hooks.onBrowse = () => {
      trace.push('executor-in-flight');
      // Ignores the abort signal: the worst case for an executor.
      return latch.then(() => (trace.push('executor-settled'), capture('a')));
    };
    world.hooks.onExecutor = (point) => {
      if (point !== 'entered') return;
      trace.push('stop');
      void world.runner.stop({ threadId: THREAD, runId: 'r1' });
    };
    world.log.afterAppend = (stored) => {
      if (stored.some((s) => s.eventType === 'RUN_FINISHED'))
        trace.push('RUN_FINISHED-committed');
    };
    const turn = world
      .runTurn('r1', [user('u1', 'read it')])
      .then(() => trace.push('stream-completed'));
    await drain();
    // Nothing final yet; the run is still 'running' in the log.
    expect(durable(world, 'r1').status).toBe('running');
    expect(trace).not.toContain('RUN_FINISHED-committed');
    // isRunning() already says false after a stop (existing semantics), but the
    // thread is reserved: a second run is rejected, never started.
    expect(await world.runner.isRunning({ threadId: THREAD })).toBe(false);
    expect(() =>
      world.runner.run({
        threadId: THREAD,
        agent: world.newAgent({
          threadId: THREAD,
          runId: 'r2',
          state: {},
          messages: [],
          tools: [],
          context: [],
          forwardedProps: {},
        }) as never,
        input: {
          threadId: THREAD,
          runId: 'r2',
          state: {},
          messages: [user('u2', 'again')],
          tools: [],
          context: [],
          forwardedProps: {},
        },
      }),
    ).toThrowError(RunRejectedError);
    release();
    await turn;
    expect(trace).toEqual([
      'stop',
      'executor-in-flight',
      'executor-settled',
      'RUN_FINISHED-committed',
      'stream-completed',
    ]);
    const run = durable(world, 'r1');
    expect(run.status).toBe('stopped');
    expect(run.results).toEqual([
      { toolCallId: 'call-1', content: UNKNOWN_OUTCOME_CONTENT },
    ]);
    // The production tool re-checks the abort before it saves, so the capture
    // (its side effect) was not committed after the stop.
    expect(readWitness(world.witnessDb)).toEqual(['executorEntered']);
  });

  it('two parallel executors: no result or terminal event is committed before the slowest settles', async () => {
    const world = createWorld({ research: true });
    worlds.push(world);
    const trace: string[] = [];
    let release!: () => void;
    const latch = new Promise<void>((resolve) => (release = resolve));
    world.setScript((n) =>
      n === 1
        ? parallelToolReply([
            {
              id: 'c1',
              name: 'read_public_page',
              args: { url: 'https://a.example.com' },
            },
            {
              id: 'c2',
              name: 'read_public_page',
              args: { url: 'https://b.example.com' },
            },
          ])
        : textReply('Done.'),
    );
    let browses = 0;
    world.hooks.onBrowse = () => {
      const n = ++browses;
      return n === 1
        ? capture('a')
        : latch.then(() => (trace.push('slowest-settled'), capture('b')));
    };
    world.log.afterAppend = (stored) => {
      for (const s of stored)
        if (
          s.eventType === 'TOOL_CALL_RESULT' ||
          s.eventType === 'RUN_FINISHED'
        )
          trace.push(`${s.eventType}-committed`);
    };
    const turn = world.runTurn('r1', [user('u1', 'read both')]);
    await drain();
    expect(trace).toEqual([]);
    release();
    await turn;
    expect(trace.slice(0, 2)).toEqual([
      'slowest-settled',
      'TOOL_CALL_RESULT-committed',
    ]);
    expect(durable(world, 'r1').status).toBe('finished');
  });
});
