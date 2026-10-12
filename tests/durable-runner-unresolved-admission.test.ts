import type { BaseEvent } from '@ag-ui/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RunRejectedError,
  type DurableAgentRunner,
  type RunRejectCode,
} from '../src/server/durable-runner';
import { runLocalTurn } from '../src/server/headless-local';
import { snapshotDatabase } from './helpers/db-snapshot';
import {
  CLIENT_TOOL,
  SERVER_TOOL,
  callEvents,
  reasoningEvents,
  runStarted,
  textEvents,
  user,
} from './helpers/event-fixtures';
import {
  AGENT_ID,
  collect,
  createHarness,
  prime,
  restartRunner,
  runInput,
  seedRun,
  until,
  type Harness,
} from './helpers/runner-harness';
import {
  HANG,
  ScriptedAgent,
  createGate,
  finished,
  textMessage,
  toolCall,
} from './helpers/scripted-agent';

// P-ADM (docs/LOCAL_FIRST_C4C_READONLY_AND_ADMISSION_BOUNDARY.md): a thread that
// holds a durable run no one resolved does not admit a new run. The refusal is
// made by run() itself, in the same synchronous stretch as the reservation, from
// the result of the admission-time recovery. Nothing here closes, rewrites or
// resolves a deferred run, and nothing fabricates an outcome. Offline, throwaway
// databases, scripted producer.
//
// This is not a claim about R17: the exclusion stays process-local, and a second
// writer process on the same database is still outside what these tests cover.
const T = 'thread-1';
const ev = (value: Record<string, unknown>) => value as unknown as BaseEvent;

const harnesses: Harness[] = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.cleanup();
});
const make = (options: Parameters<typeof createHarness>[0] = {}) => {
  const h = createHarness(options);
  harnesses.push(h);
  return h;
};

function seed(
  h: Harness,
  runId: string,
  events: BaseEvent[],
  options: { declared?: string[]; threadId?: string } = {},
) {
  const threadId = options.threadId ?? T;
  seedRun(h.log, {
    threadId,
    runId,
    agentId: AGENT_ID,
    start: runStarted(options.declared ?? [], [user(`u-${runId}`)], {
      threadId,
      runId,
    }),
    events,
  });
}

// The three open classes the rules leave running (R22, R24, R26b), each with the
// shapes that reach them.
const OPEN: Array<{
  id: string;
  rule: string;
  declared: string[];
  events: () => BaseEvent[];
}> = [
  {
    id: 'R22',
    rule: 'mixed_pending_tool_calls',
    declared: [CLIENT_TOOL],
    events: () => [
      ...callEvents('c1', SERVER_TOOL, 1),
      ...callEvents('c2', CLIENT_TOOL, 1, 'a2'),
    ],
  },
  {
    id: 'R24',
    rule: 'open_text_with_pending_tool_call',
    declared: [],
    events: () => [
      ...textEvents('a1', false, 'part'),
      ...callEvents('c1', SERVER_TOOL, 1, 'a2'),
    ],
  },
  {
    id: 'R26b-reasoning',
    rule: 'unclassified_lifecycle',
    declared: [],
    events: () => reasoningEvents('m1', false),
  },
  {
    id: 'R26b-state',
    rule: 'unclassified_lifecycle',
    declared: [],
    events: () => [
      ...textEvents('a1', true, 'x'),
      ev({ type: 'STATE_SNAPSHOT', snapshot: { k: 1 } }),
    ],
  },
];

// Recoverable classes: recovery closes them with durable closers and admission
// goes on.
const RECOVERABLE: Array<{
  id: string;
  declared: string[];
  events: () => BaseEvent[];
}> = [
  { id: 'no_tool_lifecycle', declared: [], events: () => [] },
  {
    id: 'open_text_message',
    declared: [],
    events: () => textEvents('a1', false, 'part'),
  },
  {
    id: 'complete_text_no_terminal',
    declared: [],
    events: () => textEvents('a1', true, 'done'),
  },
  {
    id: 'tool_args_incomplete',
    declared: [],
    events: () => callEvents('c1', SERVER_TOOL, 0),
  },
  {
    id: 'server_unknown_outcome',
    declared: [],
    events: () => callEvents('c1', SERVER_TOOL, 1),
  },
  {
    id: 'client_hitl_pending',
    declared: [CLIENT_TOOL],
    events: () => callEvents('c1', CLIENT_TOOL, 1),
  },
  {
    id: 'server_result_durable',
    declared: [],
    events: () => callEvents('c1', SERVER_TOOL, 2),
  },
];

const okScript = (runId: string) => (input: Parameters<typeof finished>[0]) => [
  ...textMessage(`a-${runId}`, 'ok'),
  finished(input),
];

function attempt(
  runner: DurableAgentRunner,
  runId: string,
  threadId = T,
  script: ConstructorParameters<typeof ScriptedAgent>[0] = okScript(runId),
) {
  const agent = new ScriptedAgent(script);
  const input = runInput(threadId, runId, [user(`u-${runId}`)]);
  return {
    agent,
    start: () => runner.run({ threadId, agent: prime(agent, input), input }),
  };
}

// The code of a synchronous refusal, or 'ADMITTED' with the open stream.
function admission(runner: DurableAgentRunner, runId: string, threadId = T) {
  const { agent, start } = attempt(runner, runId, threadId);
  try {
    return { result: 'ADMITTED' as const, agent, stream: start() };
  } catch (error) {
    if (error instanceof RunRejectedError)
      return { result: error.code as RunRejectCode, agent, error };
    throw error;
  }
}

async function admitted(
  runner: DurableAgentRunner,
  runId: string,
  threadId = T,
) {
  const outcome = admission(runner, runId, threadId);
  expect(outcome.result).toBe('ADMITTED');
  if (outcome.result === 'ADMITTED') return collect(outcome.stream);
  return [];
}

const eventCounts = (h: Harness) =>
  h.db
    .prepare(
      'SELECT runId, COUNT(*) AS n FROM conversation_events GROUP BY runId ORDER BY runId',
    )
    .all();

// ------------------------------------------------------------ the open classes

describe.each(OPEN)(
  '$id leaves a durable run that blocks its thread',
  (row) => {
    async function world(phase: 'before_ready' | 'after_ready') {
      const h = make();
      seed(h, 'r-dead', row.events(), { declared: row.declared });
      const { runner } = restartRunner(h);
      if (phase === 'after_ready') await runner.ready();
      return { h, runner };
    }

    it.each(['before_ready', 'after_ready'] as const)(
      'refuses a new same-thread run %s, leaving everything as it was',
      async (phase) => {
        const { h, runner } = await world(phase);
        const before = snapshotDatabase(h.throwaway.path);
        const eventsBefore = eventCounts(h);
        const outcome = admission(runner, 'r-new');
        expect(outcome.result).toBe('THREAD_HAS_UNRESOLVED_RUN');
        const error = (outcome as { error: RunRejectedError }).error;
        expect(error).toBeInstanceOf(RunRejectedError);
        expect(error).toMatchObject({
          name: 'RunRejectedError',
          code: 'THREAD_HAS_UNRESOLVED_RUN',
          threadId: T,
          runId: 'r-new',
        });
        // 0 new run rows, 0 new events, 0 provider calls, 0 tool executions.
        expect(h.log.getRun(T, 'r-new')).toBeUndefined();
        expect(h.log.runs(T).map((run) => run.runId)).toEqual(['r-dead']);
        expect(eventCounts(h)).toEqual(eventsBefore);
        expect(outcome.agent.stats.invocations).toBe(0);
        // The unresolved run is exactly as it was: still running, no event added,
        // no terminal, no closer.
        expect(h.log.getRun(T, 'r-dead')?.status).toBe('running');
        expect(snapshotDatabase(h.throwaway.path)).toBe(before);
      },
    );

    it('keeps refusing on every attempt, and reports the thread as unresolved', async () => {
      const { h, runner } = await world('before_ready');
      for (const runId of ['n1', 'n2', 'n3'])
        expect(admission(runner, runId).result).toBe(
          'THREAD_HAS_UNRESOLVED_RUN',
        );
      expect(runner.facts.threadState(T, AGENT_ID)).toMatchObject({
        state: 'unresolved',
        quiescent: false,
      });
      expect(h.log.runs(T)).toHaveLength(1);
      // Neither stop nor isRunning pretends it is live.
      expect(await runner.isRunning({ threadId: T } as never)).toBe(false);
      expect(await runner.stop({ threadId: T, runId: 'r-dead' } as never)).toBe(
        false,
      );
    });

    it('does not touch another thread', async () => {
      const { runner } = await world('after_ready');
      const events = await admitted(runner, 'r-other', 'thread-2');
      expect(events.at(-1)?.type).toBe('RUN_FINISHED');
    });

    it('refuses when the unresolved run appeared after the runner was ready', async () => {
      const h = make();
      const runner = h.runner;
      await runner.ready();
      // Written by someone else after this runner started: nothing is cached.
      seed(h, 'r-late', row.events(), { declared: row.declared });
      expect(admission(runner, 'r-new').result).toBe(
        'THREAD_HAS_UNRESOLVED_RUN',
      );
    });
  },
);

// -------------------------------------------------------- the other classes

describe('classes recovery closes still recover and admit', () => {
  it.each(RECOVERABLE)(
    '$id: closed with durable closers by admission-time recovery, then admitted',
    async (row) => {
      const h = make();
      seed(h, 'r-dead', row.events(), { declared: row.declared });
      const { runner } = restartRunner(h);
      const events = await admitted(runner, 'r-new');
      expect(events.at(-1)?.type).toBe('RUN_FINISHED');
      expect(h.log.getRun(T, 'r-dead')?.status).not.toBe('running');
      expect(h.log.getRun(T, 'r-new')?.status).toBe('finished');
      expect(h.log.checkInvariants()).toEqual([]);
    },
  );

  it.each(RECOVERABLE)(
    '$id: closed by ready(), and no longer blocks a later run',
    async (row) => {
      const h = make();
      seed(h, 'r-dead', row.events(), { declared: row.declared });
      const { runner } = restartRunner(h);
      const ready = await runner.ready();
      expect(ready.deferred).toEqual([]);
      expect(runner.facts.threadState(T, AGENT_ID).state).toBe('idle');
      const events = await admitted(runner, 'r-new');
      expect(events.at(-1)?.type).toBe('RUN_FINISHED');
    },
  );

  it('a genuinely idle thread admits exactly as before', async () => {
    const h = make();
    const events = await admitted(h.runner, 'r1');
    expect(events.at(0)?.type).toBe('RUN_STARTED');
    expect(events.at(-1)?.type).toBe('RUN_FINISHED');
    expect(h.log.runs(T).map((run) => run.status)).toEqual(['finished']);
    // And again, now that a finished run is in the history.
    expect((await admitted(h.runner, 'r2')).at(-1)?.type).toBe('RUN_FINISHED');
  });

  it('closes a recoverable run beside an open one, but still refuses and leaves the open one alone', async () => {
    const h = make();
    seed(h, 'r-open', reasoningEvents('m1', false));
    seed(h, 'r-recoverable', callEvents('c1', SERVER_TOOL, 1));
    const { runner } = restartRunner(h);
    const outcome = admission(runner, 'r-new');
    expect(outcome.result).toBe('THREAD_HAS_UNRESOLVED_RUN');
    // The existing recovery behaviour is unchanged: the recoverable run was
    // closed by it. The open run is untouched and nothing new was admitted.
    expect(h.log.getRun(T, 'r-recoverable')?.status).not.toBe('running');
    expect(h.log.getRun(T, 'r-open')?.status).toBe('running');
    expect(h.log.getRun(T, 'r-new')).toBeUndefined();
    expect(eventCounts(h).find((row) => row.runId === 'r-open')).toEqual({
      runId: 'r-open',
      n: 4,
    });
  });
});

// --------------------------------------------- active, stopping, unresolved

describe('already running, stopping and durably unresolved are told apart', () => {
  it('an active same-thread run is THREAD_ALREADY_RUNNING', async () => {
    const h = make();
    const first = attempt(h.runner, 'r1', T, () => [
      ...textMessage('a1', 'x'),
      HANG,
    ]);
    const sub = first.start().subscribe({ error: () => undefined });
    await until(() => first.agent.stats.emitted >= 4);
    const second = admission(h.runner, 'r2');
    expect(second.result).toBe('THREAD_ALREADY_RUNNING');
    expect(h.log.getRun(T, 'r2')).toBeUndefined();
    await h.runner.stop({ threadId: T, runId: 'r1' } as never);
    await until(() => h.log.getRun(T, 'r1')?.status !== 'running');
    sub.unsubscribe();
  });

  it('a stopping run, while its executor still settles, is still THREAD_ALREADY_RUNNING', async () => {
    const h = make();
    const gate = createGate();
    const first = attempt(h.runner, 'r1', T, (input) => [
      ...toolCall('c1', SERVER_TOOL, 'a1'),
      gate,
      finished(input),
    ]);
    const sub = first.start().subscribe({ error: () => undefined });
    await until(() => first.agent.stats.emitted >= 4);
    expect(await h.runner.stop({ threadId: T, runId: 'r1' } as never)).toBe(
      true,
    );
    // isRunning is already false; the thread is still reserved.
    expect(await h.runner.isRunning({ threadId: T } as never)).toBe(false);
    expect(h.runner.facts.threadState(T, AGENT_ID).state).toBe('stopping');
    expect(admission(h.runner, 'r2').result).toBe('THREAD_ALREADY_RUNNING');
    gate.open();
    await until(() => h.log.getRun(T, 'r1')?.status !== 'running');
    sub.unsubscribe();
    await until(() => h.runner.facts.threadState(T, AGENT_ID).state === 'idle');
    expect((await admitted(h.runner, 'r3')).at(-1)?.type).toBe('RUN_FINISHED');
  });

  it('the active reservation is reported before an older unresolved run on the same thread', async () => {
    // A history the previous rule could produce: a run admitted beside a
    // deferred one. The live run decides the answer.
    const h = make();
    const first = attempt(h.runner, 'r-live', T, () => [
      ...textMessage('a1', 'x'),
      HANG,
    ]);
    const sub = first.start().subscribe({ error: () => undefined });
    await until(() => first.agent.stats.emitted >= 4);
    seed(h, 'r-old', reasoningEvents('m1', false));
    expect(admission(h.runner, 'r-new').result).toBe('THREAD_ALREADY_RUNNING');
    await h.runner.stop({ threadId: T, runId: 'r-live' } as never);
    await until(() => h.log.getRun(T, 'r-live')?.status !== 'running');
    sub.unsubscribe();
    await until(() => !h.runner.facts.activeRuns({ all: true }).length);
    // Once nothing is live, the older unresolved run is what blocks.
    expect(admission(h.runner, 'r-new').result).toBe(
      'THREAD_HAS_UNRESOLVED_RUN',
    );
  });
});

// ------------------------------------------------------------------- races

describe('the check and the reservation are one synchronous stretch', () => {
  it('two same-turn requests at a free thread: exactly one is admitted', async () => {
    const h = make();
    const a = attempt(h.runner, 'r-a', T, () => [
      ...textMessage('a-a', 'x'),
      HANG,
    ]);
    const b = attempt(h.runner, 'r-b', T, () => [
      ...textMessage('a-b', 'x'),
      HANG,
    ]);
    const results: string[] = [];
    const subs: Array<{ unsubscribe(): void }> = [];
    for (const request of [a, b]) {
      try {
        subs.push(request.start().subscribe({ error: () => undefined }));
        results.push('ADMITTED');
      } catch (error) {
        results.push((error as RunRejectedError).code);
      }
    }
    expect(results).toEqual(['ADMITTED', 'THREAD_ALREADY_RUNNING']);
    expect(h.log.runs(T).map((run) => run.runId)).toEqual(['r-a']);
    await until(() => a.agent.stats.emitted >= 4);
    await h.runner.stop({ threadId: T, runId: 'r-a' } as never);
    await until(() => h.log.getRun(T, 'r-a')?.status !== 'running');
    subs.forEach((sub) => sub.unsubscribe());
  });

  it('three same-turn requests at an unresolved thread: all are refused and nothing is written', async () => {
    const h = make();
    seed(h, 'r-dead', reasoningEvents('m1', false));
    const { runner } = restartRunner(h);
    const before = snapshotDatabase(h.throwaway.path);
    const results = ['n1', 'n2', 'n3'].map((runId) => {
      const request = attempt(runner, runId);
      try {
        request.start();
        return 'ADMITTED';
      } catch (error) {
        return (error as RunRejectedError).code;
      }
    });
    expect(results).toEqual(Array(3).fill('THREAD_HAS_UNRESOLVED_RUN'));
    expect(snapshotDatabase(h.throwaway.path)).toBe(before);
  });

  it('recovery followed by admission: a recoverable dead run is closed, one run is admitted, the next is refused as running', async () => {
    const h = make();
    seed(h, 'r-dead', callEvents('c1', SERVER_TOOL, 1));
    const { runner } = restartRunner(h);
    const first = attempt(runner, 'r1', T, () => [
      ...textMessage('a1', 'x'),
      HANG,
    ]);
    const sub = first.start().subscribe({ error: () => undefined });
    expect(h.log.getRun(T, 'r-dead')?.status).not.toBe('running');
    expect(admission(runner, 'r2').result).toBe('THREAD_ALREADY_RUNNING');
    await until(() => first.agent.stats.emitted >= 4);
    await runner.stop({ threadId: T, runId: 'r1' } as never);
    await until(() => h.log.getRun(T, 'r1')?.status !== 'running');
    sub.unsubscribe();
    await until(() => runner.facts.threadState(T, AGENT_ID).state === 'idle');
    expect((await admitted(runner, 'r3')).at(-1)?.type).toBe('RUN_FINISHED');
  });

  it('a failed final write leaves an unresolved run with no reservation, and the thread is then refused', async () => {
    const h = make();
    const original = console.error;
    console.error = () => undefined;
    try {
      h.log.beforeAppend = (events) => {
        if (
          events.some(
            (event) =>
              event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR',
          )
        )
          throw new Error('injected final-write failure');
      };
      const first = attempt(h.runner, 'r-live', T, () => [
        ...(reasoningEvents('m1', false) as unknown as Array<
          Record<string, unknown>
        >),
        HANG,
      ]);
      const sub = first.start().subscribe({ error: () => undefined });
      await until(() => first.agent.stats.emitted >= 4);
      await h.runner.stop({ threadId: T, runId: 'r-live' } as never);
      await until(
        () => h.runner.facts.activeRuns({ all: true }).length === 0,
        'reservation dropped',
      );
      sub.unsubscribe();
      h.log.beforeAppend = undefined;
      // No restart happened: the run is still 'running' in the log, and this
      // process holds no reservation for it.
      expect(h.log.getRun(T, 'r-live')?.status).toBe('running');
      expect(h.runner.facts.threadState(T, AGENT_ID).state).toBe('unresolved');
      const outcome = admission(h.runner, 'r-next');
      expect(outcome.result).toBe('THREAD_HAS_UNRESOLVED_RUN');
      expect(h.log.runs(T)).toHaveLength(1);
    } finally {
      console.error = original;
    }
  });

  it('distinct threads run concurrently, and an unresolved thread does not hold them back', async () => {
    const h = make();
    seed(h, 'r-dead', reasoningEvents('m1', false), { threadId: 'blocked' });
    const gate = createGate();
    const hold = (id: string) =>
      attempt(h.runner, `r-${id}`, `thread-${id}`, (input) => [
        ...textMessage(`a-${id}`, id),
        gate,
        finished(input),
      ]);
    const x = hold('x');
    const y = hold('y');
    const subs = [x, y].map((request) =>
      request.start().subscribe({ error: () => undefined }),
    );
    await until(
      () => x.agent.stats.emitted >= 4 && y.agent.stats.emitted >= 4,
      'both running',
    );
    expect(
      h.runner.facts
        .activeRuns({ all: true })
        .map((run) => run.threadId)
        .sort(),
    ).toEqual(['thread-x', 'thread-y']);
    expect(admission(h.runner, 'r-blocked', 'blocked').result).toBe(
      'THREAD_HAS_UNRESOLVED_RUN',
    );
    gate.open();
    await until(
      () =>
        h.log.getRun('thread-x', 'r-x')?.status === 'finished' &&
        h.log.getRun('thread-y', 'r-y')?.status === 'finished',
    );
    subs.forEach((sub) => sub.unsubscribe());
  });
});

// ------------------------------------------------ what the callers observe

describe('every caller sees the refusal as a refusal', () => {
  it('a direct caller gets a typed, content-safe rejection before anything starts', () => {
    const h = make();
    seed(h, 'r-dead', [
      ...textEvents('a1', false, 'SECRET-CONTENT'),
      ...callEvents('c1', SERVER_TOOL, 1, 'a2'),
    ]);
    const { runner } = restartRunner(h);
    const outcome = admission(runner, 'r-new');
    const error = (outcome as { error: RunRejectedError }).error;
    expect(error.code).toBe('THREAD_HAS_UNRESOLVED_RUN');
    expect(error.message).toContain(T);
    expect(error.message).not.toContain('SECRET-CONTENT');
    expect(error.message).not.toContain('r-dead');
  });

  it('the headless adapter (scheduler, voice) passes it through as a rejection, never as a completed turn', async () => {
    const h = make();
    seed(h, 'r-dead', reasoningEvents('m1', false));
    const { runner } = restartRunner(h);
    const agent = new ScriptedAgent((input) => [
      ...textMessage('a1', 'a result that must never be returned'),
      finished(input),
    ]);
    let outcome: unknown;
    try {
      outcome = await runLocalTurn(
        {
          runner,
          dotIdOf: () => AGENT_ID,
          agentFor: () => agent,
          newId: () => 'run-turn',
        },
        T,
        'prompt',
        new AbortController().signal,
      );
    } catch (error) {
      outcome = error;
    }
    expect(outcome).toBeInstanceOf(RunRejectedError);
    expect(outcome).toMatchObject({ code: 'THREAD_HAS_UNRESOLVED_RUN' });
    expect(agent.stats.invocations).toBe(0);
    expect(h.log.getRun(T, 'run-turn')).toBeUndefined();
  });

  it('is not an ownership refusal: THREAD_NOT_OWNED is still decided first', () => {
    const h = make({ ownsThread: () => false });
    seed(h, 'r-dead', reasoningEvents('m1', false));
    expect(admission(h.runner, 'r-new').result).toBe('THREAD_NOT_OWNED');
  });
});

// ---------------------------------------------------- unreadable history

describe('a durable history that cannot be read stays fail-closed', () => {
  it('an unreadable event: run() throws the underlying SyntaxError (untyped, recorded as such), writes nothing and admits nothing', () => {
    const h = make();
    seed(h, 'r-bad', textEvents('a1', false, 'x'));
    h.db
      .prepare(
        "UPDATE conversation_events SET eventJson='{not json' WHERE runId='r-bad' AND seq=1",
      )
      .run();
    const { runner } = restartRunner(h);
    const before = snapshotDatabase(h.throwaway.path);
    const request = attempt(runner, 'r-new');
    let thrown: unknown;
    try {
      request.start();
    } catch (error) {
      thrown = error;
    }
    // Not a RunRejectedError: there is no typed code for it yet (C6 blocker
    // CORRUPT-DURABLE-HISTORY). What matters here is that it is a refusal.
    expect(thrown).toBeInstanceOf(SyntaxError);
    expect(request.agent.stats.invocations).toBe(0);
    expect(h.log.getRun(T, 'r-new')).toBeUndefined();
    expect(snapshotDatabase(h.throwaway.path)).toBe(before);
    // The facts never call that thread idle.
    expect(runner.facts.threadState(T, AGENT_ID).state).toBe('unresolved');
  });

  it('a running row that already holds a terminal event is not trusted: it blocks the thread', () => {
    const h = make();
    seed(h, 'r-odd', textEvents('a1', true, 'x'));
    h.db
      .prepare(
        `INSERT INTO conversation_events(threadId, runId, seq, eventType, messageId, eventJson)
         VALUES (?, 'r-odd', 4, 'RUN_FINISHED', NULL, ?)`,
      )
      .run(
        T,
        JSON.stringify({ type: 'RUN_FINISHED', threadId: T, runId: 'r-odd' }),
      );
    const { runner } = restartRunner(h);
    expect(admission(runner, 'r-new').result).toBe('THREAD_HAS_UNRESOLVED_RUN');
    expect(h.log.getRun(T, 'r-odd')?.status).toBe('running');
  });
});
