import { afterEach, describe, expect, it } from 'vitest';
import { snapshotDatabase } from './helpers/db-snapshot';
import { user } from './helpers/event-fixtures';
import {
  collect,
  committedTypes,
  createHarness,
  restartRunner,
  runInput,
  runToEnd,
  startRun,
  until,
  type Harness,
} from './helpers/runner-harness';
import {
  ScriptedAgent,
  createGate,
  finished,
  textMessage,
} from './helpers/scripted-agent';

// L4: one active run per thread and independent threads, as the frozen C4a
// contract has it. The runner never waits or queues: a loser gets a typed
// conflict synchronously, before it does any work.
const harnesses: Harness[] = [];
const make = () => {
  const harness = createHarness();
  harnesses.push(harness);
  return harness;
};
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.cleanup();
});

const quick = (id: string) =>
  new ScriptedAgent((input) => [...textMessage(id, id), finished(input)]);

describe('the same thread', () => {
  it('has exactly one winner among many simultaneous attempts, and the losers do no work', async () => {
    const h = make();
    const gate = createGate();
    const agents = Array.from(
      { length: 20 },
      (_, i) =>
        new ScriptedAgent((input) => [
          gate,
          ...textMessage(`a${i}`, 'x'),
          finished(input),
        ]),
    );
    const outcomes = agents.map((agent, i) => {
      try {
        return {
          ok: true as const,
          events: collect(
            startRun(h.runner, agent, runInput('t1', `r${i}`, [user(`u${i}`)])),
          ),
        };
      } catch (error) {
        return { ok: false as const, error };
      }
    });
    const winners = outcomes.filter((o) => o.ok);
    const losers = outcomes.filter((o) => !o.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(19);
    for (const loser of losers)
      expect((loser as { error: unknown }).error).toMatchObject({
        name: 'RunRejectedError',
        code: 'THREAD_ALREADY_RUNNING',
        threadId: 't1',
      });
    await until(
      () => agents.some((a) => a.stats.invocations > 0),
      'the winner to start',
    );
    expect(agents.filter((a) => a.stats.invocations > 0)).toHaveLength(1);
    expect(h.log.runs('t1')).toHaveLength(1);
    expect(h.log.startCalls).toBe(1);
    gate.open();
    await (winners[0] as { events: Promise<unknown> }).events;
    expect(h.log.checkInvariants()).toEqual([]);
  });

  it('frees the thread when the run is over', async () => {
    const h = make();
    await runToEnd(h.runner, quick('a1'), runInput('t1', 'r1', [user('u1')]));
    await runToEnd(h.runner, quick('a2'), runInput('t1', 'r2', [user('u2')]));
    expect(h.log.runs('t1').map((r) => r.seq)).toEqual([1, 2]);
    expect(h.log.runs('t1')[1].parentRunId).toBe('r1');
  });

  it('reports the busy window honestly: isRunning is false once the terminal event is durable, while run() still answers the conflict until the view is attempted', async () => {
    const h = make();
    let open!: () => void;
    h.log.rebuildGate = new Promise<void>((resolve) => (open = resolve));
    const running = collect(
      startRun(h.runner, quick('a1'), runInput('t1', 'r1', [user('u1')])),
    );
    await until(() => h.log.getRun('t1', 'r1')?.status === 'finished');
    await until(() => h.log.rebuildCalls === 1);
    expect(await h.runner.isRunning({ threadId: 't1' })).toBe(false);
    expect(() =>
      startRun(h.runner, quick('a2'), runInput('t1', 'r2', [user('u2')])),
    ).toThrowError(expect.objectContaining({ code: 'THREAD_ALREADY_RUNNING' }));
    open();
    await running;
    expect(() =>
      startRun(h.runner, quick('a2'), runInput('t1', 'r2', [user('u2')])),
    ).not.toThrow();
  });
});

describe('different threads', () => {
  it('run concurrently with independent order', async () => {
    const h = make();
    const gateA = createGate();
    const gateB = createGate();
    const a = new ScriptedAgent((input) => [
      ...textMessage('a1', 'A'),
      gateA,
      finished(input),
    ]);
    const b = new ScriptedAgent((input) => [
      ...textMessage('b1', 'B'),
      gateB,
      finished(input),
    ]);
    const first = collect(
      startRun(h.runner, a, runInput('tA', 'r1', [user('uA')])),
    );
    const second = collect(
      startRun(h.runner, b, runInput('tB', 'r1', [user('uB')])),
    );
    await until(
      () =>
        committedTypes(h.db, 'tA', 'r1').includes('TEXT_MESSAGE_END') &&
        committedTypes(h.db, 'tB', 'r1').includes('TEXT_MESSAGE_END'),
      'both threads running',
    );
    expect(await h.runner.isRunning({ threadId: 'tA' })).toBe(true);
    expect(await h.runner.isRunning({ threadId: 'tB' })).toBe(true);
    gateB.open();
    await second;
    expect(h.log.getRun('tB', 'r1')?.status).toBe('finished');
    expect(h.log.getRun('tA', 'r1')?.status).toBe('running');
    gateA.open();
    await first;
    expect(h.log.getRun('tA', 'r1')?.status).toBe('finished');
    expect(h.log.checkInvariants()).toEqual([]);
  });

  it('may reuse a run id, which identifies a run only within its thread', async () => {
    const h = make();
    await runToEnd(h.runner, quick('a1'), runInput('tA', 'same', [user('uA')]));
    await runToEnd(h.runner, quick('a2'), runInput('tB', 'same', [user('uB')]));
    expect(h.log.getRun('tA', 'same')?.status).toBe('finished');
    expect(h.log.getRun('tB', 'same')?.status).toBe('finished');
  });
});

describe('duplicate run ids', () => {
  it('rejects the same (thread, run) before any write or model call, and changes nothing', async () => {
    const h = make();
    await runToEnd(h.runner, quick('a1'), runInput('t1', 'r1', [user('u1')]));
    const before = snapshotDatabase(h.throwaway.path);
    const again = quick('a2');
    expect(() =>
      startRun(h.runner, again, runInput('t1', 'r1', [user('u2')])),
    ).toThrowError(
      expect.objectContaining({
        name: 'RunRejectedError',
        code: 'DUPLICATE_RUN_ID',
        runId: 'r1',
      }),
    );
    expect(again.stats.invocations).toBe(0);
    expect(snapshotDatabase(h.throwaway.path)).toBe(before);
  });

  it('rejects it after a restart as well', async () => {
    const h = make();
    await runToEnd(h.runner, quick('a1'), runInput('t1', 'r1', [user('u1')]));
    const fresh = restartRunner(h);
    await fresh.runner.ready();
    const before = snapshotDatabase(h.throwaway.path);
    const again = quick('a2');
    expect(() =>
      startRun(fresh.runner, again, runInput('t1', 'r1', [user('u2')])),
    ).toThrowError(expect.objectContaining({ code: 'DUPLICATE_RUN_ID' }));
    expect(again.stats.invocations).toBe(0);
    expect(snapshotDatabase(h.throwaway.path)).toBe(before);
  });
});
