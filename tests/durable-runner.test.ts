import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentRunner,
  InMemoryAgentRunner,
  supportsLocalThreadEndpoints,
} from '@copilotkit/runtime/v2';
import type { BaseEvent } from '@ag-ui/core';
import { snapshotDatabase } from './helpers/db-snapshot';
import {
  AGENT_ID,
  collect,
  committedTypes,
  createHarness,
  prime,
  restartRunner,
  runInput,
  runToEnd,
  startRun,
  typesOf,
  until,
  type Harness,
} from './helpers/runner-harness';
import {
  ScriptedAgent,
  createGate,
  finished,
  textMessage,
} from './helpers/scripted-agent';
import { assistant, user } from './helpers/event-fixtures';

// L2 (docs/LOCAL_FIRST_C4_LANDING_BOUNDARY.md, section 21): a normal durable
// run, persist-then-publish (W1), replay and connect, the OpenDots ownership
// predicate on its own, and the refusal of clearThreads. All offline, on
// throwaway databases.
const harnesses: Harness[] = [];
const make = (options?: Parameters<typeof createHarness>[0]) => {
  const harness = createHarness(options);
  harnesses.push(harness);
  return harness;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const harness of harnesses.splice(0)) harness.cleanup();
});

const textAgent = (id = 'a1', text = 'hello there') =>
  new ScriptedAgent((input) => [...textMessage(id, text), finished(input)]);

describe('construction and explicit schema initialization', () => {
  it('constructing a runner touches nothing; the schema appears on first use', async () => {
    const h = make();
    expect(h.log.hasSchema()).toBe(false);
    expect(
      h.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name LIKE 'conversation%'",
        )
        .all(),
    ).toEqual([]);
    await runToEnd(h.runner, textAgent(), runInput('t1', 'r1', [user('u1')]));
    expect(h.log.hasSchema()).toBe(true);
  });

  it('ready() on an empty database creates the schema and writes nothing else', async () => {
    const h = make();
    const result = await h.runner.ready();
    expect(h.log.hasSchema()).toBe(true);
    expect(result).toMatchObject({ checked: 0, rebuilt: 0 });
    expect(h.log.runs('t1')).toEqual([]);
    expect(
      h.db.prepare('SELECT COUNT(*) AS n FROM conversation_events').get(),
    ).toEqual({ n: 0 });
  });

  it('leaves an existing schema alone (no schema write on a healthy database)', async () => {
    const h = make();
    await runToEnd(h.runner, textAgent(), runInput('t1', 'r1', [user('u1')]));
    const before = snapshotDatabase(h.throwaway.path);
    const second = restartRunner(h);
    const result = await second.runner.ready();
    expect(result.rebuilt).toBe(0);
    expect(snapshotDatabase(h.throwaway.path)).toBe(before);
  });
});

describe('the AgentRunner contract', () => {
  it('is an AgentRunner that advertises the local thread endpoints', () => {
    const h = make();
    expect(h.runner).toBeInstanceOf(AgentRunner);
    expect(h.runner.ɵsupportsLocalThreadEndpoints).toBe(true);
    expect(supportsLocalThreadEndpoints(h.runner)).toBe(true);
    for (const method of [
      'run',
      'connect',
      'isRunning',
      'stop',
      'listThreads',
      'getThreadMessages',
      'getThreadEvents',
      'getThreadState',
      'clearThreads',
      'messagesFor',
      'ready',
      'stopAll',
      'ownsThread',
    ])
      expect(
        typeof (h.runner as unknown as Record<string, unknown>)[method],
        method,
      ).toBe('function');
  });
});

describe('a normal durable run', () => {
  it('persists a sanitised RUN_STARTED before the model is invoked, then the events, then the terminal state', async () => {
    const h = make();
    const observer = h.observer();
    let atInvocation: { types: string[]; status: unknown } | undefined;
    const agent = new ScriptedAgent(
      (input) => [...textMessage('a1', 'hi'), finished(input)],
      AGENT_ID,
      undefined,
      () => {
        atInvocation = {
          types: committedTypes(observer, 't1', 'r1'),
          status: observer
            .prepare('SELECT status FROM conversation_runs WHERE runId = ?')
            .get('r1')?.status,
        };
      },
    );
    const events = await runToEnd(
      h.runner,
      agent,
      runInput('t1', 'r1', [user('u1', 'hello')]),
    );
    expect(atInvocation).toEqual({ types: ['RUN_STARTED'], status: 'running' });
    expect(typesOf(events)).toEqual([
      'RUN_STARTED',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'RUN_FINISHED',
    ]);
    expect(committedTypes(h.db, 't1', 'r1')).toEqual(typesOf(events));
    expect(h.log.getRun('t1', 'r1')).toMatchObject({
      status: 'finished',
      agentId: AGENT_ID,
      seq: 1,
    });
    expect(h.log.checkInvariants()).toEqual([]);
    const start = h.log.runEvents('t1', 'r1')[0].event as unknown as {
      input: { messages: Array<{ id: string }> };
    };
    expect(start.input.messages.map((m) => m.id)).toEqual(['u1']);
  });

  it('publishes exactly what it stored', async () => {
    const h = make();
    const events = await runToEnd(
      h.runner,
      textAgent(),
      runInput('t1', 'r1', [user('u1')]),
    );
    expect(events).toEqual(h.log.runEvents('t1', 'r1').map((s) => s.event));
  });

  it('stores each user message once: known ids are dropped from the persisted input', async () => {
    const h = make();
    await runToEnd(
      h.runner,
      textAgent('a1', 'one'),
      runInput('t1', 'r1', [user('u1')]),
    );
    await runToEnd(
      h.runner,
      textAgent('a2', 'two'),
      runInput('t1', 'r2', [user('u1'), assistant('a1'), user('u2', 'again')]),
    );
    const start = h.log.runEvents('t1', 'r2')[0].event as unknown as {
      input: { messages: Array<{ id: string }> };
    };
    expect(start.input.messages.map((m) => m.id)).toEqual(['u2']);
    const view = await h.runner.messagesFor('t1');
    expect(view.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
  });

  it('never persists the per-request token or the SDK-side input messages', async () => {
    const h = make();
    const input = runInput('t1', 'r1', [user('u1')]);
    const sentinel = 'sentinel-token-never-stored-0123456789';
    await collect(
      h.runner.run({
        threadId: 't1',
        agent: prime(textAgent(), input),
        input,
        authToken: sentinel,
        persistedInputMessages: [user('u-secret', sentinel)],
      }),
    );
    const everything = JSON.stringify(
      h.db.prepare('SELECT eventJson FROM conversation_events').all(),
    );
    expect(everything).not.toContain(sentinel);
    expect(everything).not.toContain('u-secret');
  });

  it('matches the SDK in-memory runner event for event, except the persisted input', async () => {
    const h = make();
    const durable = await runToEnd(
      h.runner,
      textAgent('a1', 'same'),
      runInput('t1', 'r1', [user('u1')]),
    );
    const reference = new InMemoryAgentRunner();
    const input = runInput('t1', 'r1', [user('u1')]);
    const expected = await collect(
      reference.run({
        threadId: 't1',
        agent: prime(textAgent('a1', 'same'), input),
        input,
      }),
    );
    const strip = (events: BaseEvent[]) =>
      events.map((event) => {
        const { input: _input, ...rest } = event as unknown as Record<
          string,
          unknown
        >;
        void _input;
        return rest;
      });
    expect(strip(durable)).toEqual(strip(expected));
  });
});

describe('W1: persist, commit, publish', () => {
  it('has committed every event, as another connection sees it, by the time a subscriber receives it', async () => {
    const h = make();
    const observer = h.observer();
    const seen: Array<{ type: string; committed: boolean }> = [];
    const input = runInput('t1', 'r1', [user('u1')]);
    await new Promise<void>((resolve, reject) => {
      startRun(h.runner, textAgent(), input).subscribe({
        next: (event) => {
          const committed = committedTypes(observer, 't1', 'r1');
          seen.push({
            type: event.type as string,
            committed: committed.length >= seen.length + 1,
          });
        },
        error: reject,
        complete: resolve,
      });
    });
    expect(seen.length).toBe(5);
    expect(seen.filter((entry) => !entry.committed)).toEqual([]);
  });

  it('never publishes an event whose transaction failed, and ends the run with an error', async () => {
    const h = make();
    h.log.beforeAppend = (events) => {
      if (events.some((e) => e.type === 'TEXT_MESSAGE_CONTENT'))
        throw new Error('disk full');
    };
    const events = await runToEnd(
      h.runner,
      textAgent(),
      runInput('t1', 'r1', [user('u1')]),
    );
    expect(typesOf(events)).not.toContain('TEXT_MESSAGE_CONTENT');
    expect(typesOf(events).at(-1)).toBe('RUN_ERROR');
    expect(committedTypes(h.db, 't1', 'r1')).toEqual(typesOf(events));
    expect(h.log.getRun('t1', 'r1')?.status).toBe('error');
    expect(h.log.checkInvariants()).toEqual([]);
  });

  it('keeps the run alive for recovery when even the final write fails', async () => {
    const h = make();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.log.beforeAppend = (events) => {
      if (events.some((e) => e.type === 'TEXT_MESSAGE_CONTENT'))
        throw new Error('disk full');
      if (events.some((e) => e.type === 'RUN_ERROR'))
        throw new Error('still full');
    };
    const events = await runToEnd(
      h.runner,
      textAgent(),
      runInput('t1', 'r1', [user('u1')]),
    );
    expect(typesOf(events)).toEqual(['RUN_STARTED', 'TEXT_MESSAGE_START']);
    expect(h.log.getRun('t1', 'r1')?.status).toBe('running');
    expect(await h.runner.isRunning({ threadId: 't1' })).toBe(false);
  });
});

describe('connect and replay', () => {
  it('replays a completed thread without calling the model or writing', async () => {
    const h = make();
    const agent = textAgent();
    await runToEnd(h.runner, agent, runInput('t1', 'r1', [user('u1')]));
    const before = snapshotDatabase(h.throwaway.path);
    const fresh = restartRunner(h);
    const replay = await collect(fresh.runner.connect({ threadId: 't1' }));
    expect(typesOf(replay)).toEqual([
      'RUN_STARTED',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'RUN_FINISHED',
    ]);
    expect(agent.stats.invocations).toBe(1);
    expect(snapshotDatabase(h.throwaway.path)).toBe(before);
    expect(fresh.log.appendCalls + fresh.log.startCalls).toBe(0);
  });

  it('completes empty for a thread that has no runs', async () => {
    const h = make();
    expect(await collect(h.runner.connect({ threadId: 'none' }))).toEqual([]);
  });

  it('replays earlier runs by order of run, not by message id', async () => {
    const h = make();
    await runToEnd(
      h.runner,
      textAgent('same', 'one'),
      runInput('t1', 'r1', [user('u1')]),
    );
    await runToEnd(
      h.runner,
      textAgent('same', 'two'),
      runInput('t1', 'r2', [user('u2')]),
    );
    const replay = await collect(h.runner.connect({ threadId: 't1' }));
    expect(
      replay
        .filter((e) => e.type === 'RUN_STARTED')
        .map((e) => (e as never as { runId: string }).runId),
    ).toEqual(['r1', 'r2']);
  });

  it('gives an active run its history once and its live events once, with no duplicated durable prefix', async () => {
    const h = make();
    await runToEnd(
      h.runner,
      textAgent('a1', 'old'),
      runInput('t1', 'r1', [user('u1')]),
    );
    const gate = createGate();
    const live = new ScriptedAgent((input) => [
      ...textMessage('a2', 'new'),
      gate,
      ...textMessage('a3', 'later'),
      finished(input),
    ]);
    const running = collect(
      startRun(h.runner, live, runInput('t1', 'r2', [user('u2')])),
    );
    await until(
      () => committedTypes(h.db, 't1', 'r2').includes('TEXT_MESSAGE_END'),
      'first message of the live run',
    );
    const joined = collect(h.runner.connect({ threadId: 't1' }));
    gate.open();
    const [observed, ownEvents] = [await joined, await running];
    expect(observed).toEqual([
      ...h.log.runEvents('t1', 'r1').map((s) => s.event),
      ...ownEvents,
    ]);
    const ids = observed
      .filter((e) => e.type === 'TEXT_MESSAGE_START')
      .map((e) => (e as never as { messageId: string }).messageId);
    expect(ids).toEqual(['a1', 'a2', 'a3']);
  });

  it('is a read: the connection of a joiner writes nothing', async () => {
    const h = make();
    await runToEnd(h.runner, textAgent(), runInput('t1', 'r1', [user('u1')]));
    const before = h.log.appendCalls;
    await collect(h.runner.connect({ threadId: 't1' }));
    expect(h.log.appendCalls).toBe(before);
  });
});

describe('OpenDots ownsThread seam (not part of the SDK AgentRunner contract)', () => {
  it('is asked with the thread id and the agent id, and its answer is final', () => {
    const asked: Array<[string, string]> = [];
    const h = make({
      ownsThread: (threadId, agentId) => {
        asked.push([threadId, agentId]);
        return agentId === 'dot-a' && threadId === 't-a';
      },
    });
    expect(h.runner.ownsThread('t-a', 'dot-a')).toBe(true);
    expect(h.runner.ownsThread('t-a', 'dot-b')).toBe(false);
    expect(h.runner.ownsThread('t-b', 'dot-a')).toBe(false);
    expect(asked).toEqual([
      ['t-a', 'dot-a'],
      ['t-a', 'dot-b'],
      ['t-b', 'dot-a'],
    ]);
  });

  it('refuses a run for a thread the agent does not own, before anything is written or the model is called', async () => {
    const h = make({ ownsThread: () => false });
    const agent = textAgent();
    const input = runInput('t1', 'r1', [user('u1')]);
    expect(() => startRun(h.runner, agent, input)).toThrowError(
      expect.objectContaining({
        name: 'RunRejectedError',
        code: 'THREAD_NOT_OWNED',
      }),
    );
    expect(agent.stats.invocations).toBe(0);
    expect(h.log.startCalls).toBe(0);
    expect(h.log.appendCalls).toBe(0);
  });

  it('fails closed when the predicate throws or the agent has no id', () => {
    const throwing = make({
      ownsThread: () => {
        throw new Error('workspace unavailable');
      },
    });
    const input = runInput('t1', 'r1', [user('u1')]);
    expect(() => startRun(throwing.runner, textAgent(), input)).toThrowError(
      expect.objectContaining({ code: 'THREAD_NOT_OWNED' }),
    );
    const anonymous = make();
    const agent = textAgent();
    const primed = prime(agent, input);
    primed.agentId = undefined;
    expect(() =>
      anonymous.runner.run({ threadId: 't1', agent: primed, input }),
    ).toThrowError(expect.objectContaining({ code: 'THREAD_NOT_OWNED' }));
  });

  it('is checked on the run path with the agent id the run carries', async () => {
    const asked: Array<[string, string]> = [];
    const h = make({
      ownsThread: (threadId, agentId) => {
        asked.push([threadId, agentId]);
        return true;
      },
    });
    await runToEnd(
      h.runner,
      textAgent(),
      runInput('t9', 'r1', [user('u1')]),
      'dot-9',
    );
    expect(asked).toEqual([['t9', 'dot-9']]);
  });
});

describe('clearThreads refuses (DEC-16, DEC-23)', () => {
  it('throws, deletes nothing and truncates nothing', async () => {
    const h = make();
    await runToEnd(
      h.runner,
      textAgent('a1', 'one'),
      runInput('t1', 'r1', [user('u1')]),
    );
    await runToEnd(
      h.runner,
      textAgent('a2', 'two'),
      runInput('t2', 'r1', [user('u2')]),
    );
    const before = snapshotDatabase(h.throwaway.path);
    expect(() => h.runner.clearThreads()).toThrowError(
      expect.objectContaining({
        name: 'ClearThreadsRefusedError',
        code: 'CLEAR_THREADS_REFUSED',
      }),
    );
    expect(snapshotDatabase(h.throwaway.path)).toBe(before);
    expect(h.log.threadIds()).toEqual(['t1', 't2']);
    const counts = h.db
      .prepare(
        'SELECT (SELECT COUNT(*) FROM conversation_runs) AS runs, (SELECT COUNT(*) FROM conversation_events) AS events',
      )
      .get();
    expect(counts).toEqual({ runs: 2, events: 10 });
  });

  it('refuses even on an empty database and while a run is active', async () => {
    const h = make();
    expect(() => h.runner.clearThreads()).toThrow(/refus/i);
    const gate = createGate();
    const agent = new ScriptedAgent((input) => [gate, finished(input)]);
    const running = collect(
      startRun(h.runner, agent, runInput('t1', 'r1', [user('u1')])),
    );
    await until(() => h.log.getRun('t1', 'r1') !== undefined);
    expect(() => h.runner.clearThreads()).toThrow(/refus/i);
    gate.open();
    await running;
    expect(h.log.getRun('t1', 'r1')?.status).toBe('finished');
  });
});

describe('the local thread endpoints', () => {
  it('lists a thread once a run has ended, with the agent of its first run', async () => {
    const h = make();
    await runToEnd(
      h.runner,
      textAgent(),
      runInput('t1', 'r1', [user('u1')]),
      'dot-first',
    );
    await runToEnd(
      h.runner,
      textAgent('a2', 'x'),
      runInput('t1', 'r2', [user('u2')]),
      'dot-first',
    );
    const threads = h.runner.listThreads();
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      id: 't1',
      name: null,
      agentId: 'dot-first',
      organizationId: '',
      createdById: '',
      archived: false,
    });
    expect(Number.isNaN(Date.parse(threads[0].createdAt))).toBe(false);
  });

  it('serves messages from the derived view and fails closed when it is stale', async () => {
    const h = make();
    await runToEnd(
      h.runner,
      textAgent('a1', 'one'),
      runInput('t1', 'r1', [user('u1')]),
    );
    expect(h.runner.getThreadMessages('t1').map((m) => m.id)).toEqual([
      'u1',
      'a1',
    ]);
    // A thread the process never derived has no synchronous answer.
    const cold = restartRunner(h);
    expect(() => cold.runner.getThreadMessages('t1')).toThrow(/stale|missing/i);
    await cold.runner.ready();
    expect(cold.runner.getThreadMessages('t1').map((m) => m.id)).toEqual([
      'u1',
      'a1',
    ]);
    // New events behind its back make it stale again.
    await runToEnd(
      h.runner,
      textAgent('a2', 'two'),
      runInput('t1', 'r2', [user('u2')]),
    );
    expect(() => cold.runner.getThreadMessages('t1')).toThrow(/stale/i);
    expect(h.runner.getThreadMessages('nothing')).toEqual([]);
  });

  it('exposes only committed events of runs that are not active, compacted, and the last state snapshot', async () => {
    const h = make();
    await runToEnd(
      h.runner,
      new ScriptedAgent((input) => [
        { type: 'STATE_SNAPSHOT', snapshot: { n: 1 } },
        ...textMessage('a1', 'one'),
        finished(input),
      ]),
      runInput('t1', 'r1', [user('u1')]),
    );
    expect(typesOf(h.runner.getThreadEvents('t1'))).toContain('RUN_FINISHED');
    expect(h.runner.getThreadState('t1')).toEqual({ n: 1 });
    expect(h.runner.getThreadState('none')).toBeNull();
    const gate = createGate();
    const running = collect(
      startRun(
        h.runner,
        new ScriptedAgent((input) => [
          ...textMessage('a2', 'x'),
          gate,
          finished(input),
        ]),
        runInput('t1', 'r2', [user('u2')]),
      ),
    );
    await until(() =>
      committedTypes(h.db, 't1', 'r2').includes('TEXT_MESSAGE_END'),
    );
    const visible = h.runner.getThreadEvents('t1');
    expect(
      visible
        .filter((e) => e.type === 'RUN_STARTED')
        .map((e) => (e as never as { runId: string }).runId),
    ).toEqual(['r1']);
    gate.open();
    await running;
  });
});
