import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BaseEvent, RunAgentInput } from '@ag-ui/core';
import { EMPTY, Observable, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentTurnText } from '../src/server/headless';
import {
  DEFAULT_ABORT_GRACE_MS,
  HeadlessTurnError,
  ThreadBusyError,
  runLocalTurn,
  type LocalTurnDeps,
} from '../src/server/headless-local';
import { RunRejectedError } from '../src/server/durable-runner';
import { user } from './helpers/event-fixtures';
import {
  THREAD as DOT_THREAD,
  createWorld,
  durable,
  namedToolReply,
  providerHistory,
  readWitness,
  textReply,
  toolReply,
  type World,
} from './helpers/dot-stop-world';
import { AGENT_ID, createHarness, until } from './helpers/runner-harness';
import {
  ScriptedAgent,
  createGate,
  finished,
  textMessage,
  type AgentStats,
  type Script,
} from './helpers/scripted-agent';

// C5: the dormant local headless adapter (docs/LOCAL_FIRST_C5_LANDING_BOUNDARY.md).
// Everything here is offline with throwaway databases. Layer L1 uses a scripted
// producer behind the real DurableAgentRunner; layer L2 uses the production
// DotAgent (BuiltInAgent -> TanStack -> the production tools) behind it.
const T = 't1';
const root = fileURLToPath(new URL('../', import.meta.url));

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => void unhandled.push(reason);
beforeEach(() => {
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
});
afterEach(async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  process.off('unhandledRejection', onUnhandled);
  expect(unhandled).toEqual([]);
});

const never = () => new AbortController().signal;
const drain = async (n = 100) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

// ----------------------------------------------------------------------- L1

type Harness = ReturnType<typeof createHarness>;
const harnesses: Harness[] = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.cleanup();
});

function l1(script: Script, options: Partial<LocalTurnDeps> = {}) {
  const h = createHarness();
  harnesses.push(h);
  const stats: AgentStats = {
    invocations: 0,
    emitted: 0,
    aborts: 0,
    inputs: [],
  };
  const created: ScriptedAgent[] = [];
  const calls = {
    run: [] as Array<{ threadId: string; runId: string }>,
    stop: [] as Array<{ threadId: string; runId?: string }>,
  };
  const deps: LocalTurnDeps = {
    runner: {
      run: (request) => {
        calls.run.push({
          threadId: request.threadId,
          runId: request.input.runId,
        });
        return h.runner.run(request);
      },
      stop: (request) => {
        calls.stop.push({ threadId: request.threadId, runId: request.runId });
        return h.runner.stop(request);
      },
    },
    dotIdOf: () => AGENT_ID,
    agentFor: () => {
      const agent = new ScriptedAgent(script, 'scripted', stats);
      created.push(agent);
      return agent;
    },
    ...options,
  };
  const durableCounts = () => ({
    appendCalls: h.log.appendCalls,
    startCalls: h.log.startCalls,
    runs: h.log.runs(T).length,
    events: h.log.threadEvents(T).length,
  });
  return { h, stats, created, calls, deps, durableCounts };
}

const answer =
  (text: string): Script =>
  (input) => [...textMessage('a1', text), finished(input)];

describe('runLocalTurn: a normal prompt-only turn', () => {
  it('runs the prompt through the durable runner and returns the assistant text', async () => {
    const { h, stats, deps, calls } = l1(answer('Four.'));
    const text = await runLocalTurn(deps, T, 'What is 2+2?', never());
    expect(text).toBe('Four.');
    expect(calls.run).toHaveLength(1);
    const [run] = h.log.runs(T);
    expect(run.status).toBe('finished');
    // The agent saw exactly the prompt, with nothing else attached.
    const input = stats.inputs[0];
    expect(input.messages).toHaveLength(1);
    expect(input.messages[0]).toMatchObject({
      role: 'user',
      content: 'What is 2+2?',
    });
    expect(input.tools).toEqual([]);
    expect(input.context).toEqual([]);
    expect(input.state).toEqual({});
    expect(input.forwardedProps).toEqual({});
    expect(input.threadId).toBe(T);
    expect(input.runId).toBe(calls.run[0].runId);
  });

  it('persists the user message id and metadata exactly as the production headless turn does', async () => {
    const { h, deps } = l1(answer('Receipt.'));
    await runLocalTurn(deps, T, 'sync it', never(), {
      opendotsSource: 'voice_receipt',
    });
    await runLocalTurn(deps, T, 'plain', never());
    const [receipt, plain] = h.log.runs(T).map((run) => {
      const start = h.log.runEvents(T, run.runId)[0].event as unknown as {
        input: { messages: Array<{ id: string; metadata?: unknown }> };
      };
      return start.input.messages[0];
    });
    expect(receipt.id.startsWith('opendots:voice_receipt:')).toBe(true);
    expect(receipt.metadata).toEqual({ opendotsSource: 'voice_receipt' });
    expect(plain.id.startsWith('opendots:voice_receipt:')).toBe(false);
    expect(plain.metadata).toBeUndefined();
  });

  it('extracts the result with the existing currentTurnText semantics', async () => {
    const script: Script = (input) => [
      ...textMessage('a1', 'first'),
      ...textMessage('a2', 'second answer'),
      finished(input),
    ];
    const { created, deps } = l1(script);
    const text = await runLocalTurn(deps, T, 'go', never());
    const agent = created[0];
    const fresh = agent.messages.filter((m) => m.role === 'assistant');
    expect(text).toBe(currentTurnText(fresh));
    expect(text).toBe('second answer');
  });

  it('fails like currentTurnText when the assistant produced no text', async () => {
    const { deps } = l1((input) => [
      ...textMessage('a1', '   '),
      finished(input),
    ]);
    await expect(runLocalTurn(deps, T, 'go', never())).rejects.toThrow(
      'The current compute turn returned no assistant response.',
    );
  });

  it('uses a new run id for every attempt (and the injected generator when given)', async () => {
    const { h, deps, calls } = l1(answer('ok'));
    await runLocalTurn(deps, T, 'one', never());
    await runLocalTurn(deps, T, 'two', never());
    const ids = calls.run.map((c) => c.runId);
    expect(new Set(ids).size).toBe(2);
    expect(
      h.log
        .runs(T)
        .map((r) => r.runId)
        .sort(),
    ).toEqual([...ids].sort());
    const seen: string[] = [];
    const injected = l1(answer('ok'), {
      newId: () => {
        seen.push('id-' + seen.length);
        return seen.at(-1)!;
      },
    });
    await runLocalTurn(injected.deps, T, 'x', never());
    expect(injected.calls.run[0].runId).toBe('id-0');
  });

  it('asks the factory for a fresh agent every time and never reuses an instance', async () => {
    let factoryCalls = 0;
    const base = l1(answer('ok'));
    const instances = new Set<unknown>();
    const deps: LocalTurnDeps = {
      ...base.deps,
      agentFor: (dotId) => {
        factoryCalls += 1;
        const agent = base.deps.agentFor(dotId);
        instances.add(agent);
        return agent;
      },
    };
    await runLocalTurn(deps, T, 'one', never());
    await runLocalTurn(deps, T, 'two', never());
    await runLocalTurn(deps, T, 'three', never());
    expect(factoryCalls).toBe(3);
    expect(instances.size).toBe(3);
    // One agent invocation per turn, each on its own instance.
    expect(base.stats.invocations).toBe(3);
  });

  it('is prompt-only: a prior history on the agent the factory returns is not forwarded', async () => {
    const base = l1(answer('ok'));
    const deps: LocalTurnDeps = {
      ...base.deps,
      agentFor: (dotId) => {
        const agent = base.deps.agentFor(dotId) as ScriptedAgent;
        // A browser-style history sitting on the instance.
        agent.setMessages([
          user('old-1', 'earlier question'),
          {
            id: 'old-2',
            role: 'assistant',
            content: 'earlier answer',
          } as never,
        ]);
        return agent;
      },
    };
    await runLocalTurn(deps, T, 'only this', never());
    const input = base.stats.inputs[0];
    expect(input.messages.map((m) => m.content)).toEqual(['only this']);
    const started = base.h.log.runEvents(T, base.h.log.runs(T)[0].runId)[0]
      .event as unknown as { input: { messages: unknown[] } };
    expect(started.input.messages).toHaveLength(1);
  });

  it('passes the signal check before reading or writing anything', async () => {
    const base = l1(answer('ok'));
    let dotIdCalls = 0;
    let factoryCalls = 0;
    const deps: LocalTurnDeps = {
      ...base.deps,
      dotIdOf: (id) => (dotIdCalls++, base.deps.dotIdOf(id)),
      agentFor: (dotId) => (factoryCalls++, base.deps.agentFor(dotId)),
    };
    const controller = new AbortController();
    const reason = new Error('already gone');
    controller.abort(reason);
    await expect(runLocalTurn(deps, T, 'x', controller.signal)).rejects.toBe(
      reason,
    );
    expect(dotIdCalls).toBe(0);
    expect(factoryCalls).toBe(0);
    expect(base.calls.run).toEqual([]);
    expect(base.calls.stop).toEqual([]);
    expect(base.h.log.startCalls).toBe(0);
    expect(base.h.log.appendCalls).toBe(0);
    expect(base.stats.invocations).toBe(0);
  });
});

describe('runLocalTurn: admission is the runner, never isRunning', () => {
  it('refuses a busy thread with a typed error, no agent call and no durable write', async () => {
    const gate = createGate();
    const { h, stats, deps, calls, durableCounts } = l1((input) => [
      gate,
      ...textMessage('a1', 'late'),
      finished(input),
    ]);
    const first = runLocalTurn(deps, T, 'first', never());
    await until(() => stats.invocations === 1, 'first run started');
    const before = durableCounts();
    const invocations = stats.invocations;

    const refused = await runLocalTurn(deps, T, 'second', never()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(ThreadBusyError);
    const busy = refused as ThreadBusyError;
    expect(busy.code).toBe('THREAD_BUSY');
    expect(busy.threadId).toBe(T);
    expect(busy.reason).toBe('THREAD_ALREADY_RUNNING');
    expect(busy.cause).toBeInstanceOf(RunRejectedError);
    expect((busy.cause as RunRejectedError).code).toBe(
      'THREAD_ALREADY_RUNNING',
    );
    expect(stats.invocations).toBe(invocations);
    expect(durableCounts()).toEqual(before);

    // No automatic retry: the refused attempt asked the runner exactly once and
    // nothing asks again, however long we wait.
    await drain(200);
    expect(calls.run).toHaveLength(2);
    expect(calls.stop).toEqual([]);

    gate.open();
    expect(await first).toBe('late');
    // Free again, and only an explicit new call runs.
    expect(calls.run).toHaveLength(2);
    expect(h.log.runs(T)).toHaveLength(1);
    expect(await runLocalTurn(deps, T, 'third', never())).toBe('late');
    expect(calls.run).toHaveLength(3);
  });

  it('decides admission from run(), not from isRunning (both directions)', async () => {
    const base = l1(answer('ok'));
    const traps = {
      isRunning: vi.fn(async () => true), // claims busy; run() admits
    };
    const deps: LocalTurnDeps = {
      ...base.deps,
      runner: {
        ...base.deps.runner,
        isRunning: traps.isRunning,
      } as LocalTurnDeps['runner'],
    };
    expect(await runLocalTurn(deps, T, 'x', never())).toBe('ok');
    expect(traps.isRunning).not.toHaveBeenCalled();

    // The reverse: isRunning says false while run() rejects as busy.
    const busyRunner: LocalTurnDeps['runner'] = {
      run: () => {
        throw new RunRejectedError('THREAD_ALREADY_RUNNING', T, 'r', 'busy');
      },
      stop: async () => false,
      isRunning: async () => false,
    } as LocalTurnDeps['runner'];
    await expect(
      runLocalTurn({ ...base.deps, runner: busyRunner }, T, 'x', never()),
    ).rejects.toBeInstanceOf(ThreadBusyError);
  });

  it.each([
    ['THREAD_NOT_OWNED'],
    ['STALE_TOOL_HISTORY'],
    ['DUPLICATE_RUN_ID'],
    ['UNSUPPORTED_MIDDLEWARE'],
  ] as const)(
    'keeps the %s rejection distinct from busy and does not retry it',
    async (code) => {
      const base = l1(answer('ok'));
      let runs = 0;
      const deps: LocalTurnDeps = {
        ...base.deps,
        runner: {
          run: () => {
            runs += 1;
            throw new RunRejectedError(code, T, 'r', 'rejected');
          },
          stop: async () => false,
        },
      };
      const error = await runLocalTurn(deps, T, 'x', never()).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(RunRejectedError);
      expect(error).not.toBeInstanceOf(ThreadBusyError);
      expect((error as RunRejectedError).code).toBe(code);
      expect(runs).toBe(1);
    },
  );

  it('the real runner: a thread that the agent does not own is THREAD_NOT_OWNED, with no write and no agent call', async () => {
    const h = createHarness({ ownsThread: () => false });
    harnesses.push(h);
    const stats: AgentStats = {
      invocations: 0,
      emitted: 0,
      aborts: 0,
      inputs: [],
    };
    const deps: LocalTurnDeps = {
      runner: h.runner,
      dotIdOf: () => AGENT_ID,
      agentFor: () => new ScriptedAgent(answer('no'), 'scripted', stats),
    };
    const error = await runLocalTurn(deps, T, 'x', never()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RunRejectedError);
    expect((error as RunRejectedError).code).toBe('THREAD_NOT_OWNED');
    expect(stats.invocations).toBe(0);
    expect(h.log.startCalls).toBe(0);
    expect(h.log.appendCalls).toBe(0);
  });

  it('the real runner: an agent carrying middleware is refused unmapped, before any model call', async () => {
    const base = l1(answer('no'));
    const deps: LocalTurnDeps = {
      ...base.deps,
      agentFor: (dotId) => {
        const agent = base.deps.agentFor(dotId) as ScriptedAgent;
        agent.use({
          run: (
            input: RunAgentInput,
            next: { run: (i: RunAgentInput) => Observable<BaseEvent> },
          ) => next.run(input),
        } as never);
        return agent;
      },
    };
    const error = await runLocalTurn(deps, T, 'x', never()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RunRejectedError);
    expect((error as RunRejectedError).code).toBe('UNSUPPORTED_MIDDLEWARE');
    expect(base.stats.invocations).toBe(0);
    expect(base.h.log.appendCalls).toBe(0);
  });

  it('the real runner: a duplicate run id is rejected, never retried with a new id', async () => {
    let ids = 0;
    const base = l1(answer('ok'), { newId: () => (ids++, 'same-id') });
    await runLocalTurn(base.deps, T, 'one', never());
    const error = await runLocalTurn(base.deps, T, 'two', never()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((error as RunRejectedError).code).toBe('DUPLICATE_RUN_ID');
    expect(ids).toBe(2);
    expect(base.calls.run).toHaveLength(2);
  });

  it('a refused attempt never stops the run that holds the thread', async () => {
    const gate = createGate();
    const { stats, deps, calls } = l1((input) => [
      gate,
      ...textMessage('a1', 'kept'),
      finished(input),
    ]);
    const first = runLocalTurn(deps, T, 'first', never());
    await until(() => stats.invocations === 1, 'first run started');
    const controller = new AbortController();
    const refused = runLocalTurn(deps, T, 'second', controller.signal);
    await expect(refused).rejects.toBeInstanceOf(ThreadBusyError);
    controller.abort(new Error('late abort of the refused attempt'));
    await drain(50);
    expect(calls.stop).toEqual([]);
    expect(stats.aborts).toBe(0);
    gate.open();
    expect(await first).toBe('kept');
  });
});

describe('runLocalTurn: abort and settlement', () => {
  // A producer that only ends when the test opens the gate; abortRun() does not
  // end it, like an executor that keeps going after the stop was requested.
  const slow =
    (gate: ReturnType<typeof createGate>): Script =>
    (input) => [gate, ...textMessage('a1', 'late text'), finished(input)];

  it('requests the stop for its own run and waits for the runner to settle before rejecting', async () => {
    const gate = createGate();
    const { h, stats, deps, calls } = l1(slow(gate));
    const controller = new AbortController();
    const reason = new Error('call ended');
    let outcome: unknown = 'pending';
    const turn = runLocalTurn(deps, T, 'go', controller.signal).then(
      () => (outcome = 'resolved'),
      (e: unknown) => (outcome = e),
    );
    await until(() => stats.invocations === 1, 'run started');
    controller.abort(reason);
    await drain(100);
    // Stop was requested; the producer has not ended, so the caller is still held.
    expect(calls.stop).toEqual([{ threadId: T, runId: calls.run[0].runId }]);
    expect(stats.aborts).toBe(1);
    expect(outcome).toBe('pending');
    expect(h.log.runs(T)[0].status).toBe('running');

    gate.open();
    await turn;
    // Released only now: the run is finalized and the thread is free.
    expect(outcome).toBe(reason);
    expect(h.log.runs(T)[0].status).toBe('stopped');
    expect(calls.stop).toHaveLength(1);
    expect(calls.run).toHaveLength(1);
  });

  it('admits the next turn on the thread right after a settled abort (the voice shape)', async () => {
    const gate = createGate();
    let first = true;
    const { h, stats, deps } = l1((input) => {
      if (first) {
        first = false;
        return [gate, ...textMessage('a1', 'x'), finished(input)];
      }
      return [...textMessage('a2', 'receipt'), finished(input)];
    });
    const controller = new AbortController();
    const turn = runLocalTurn(deps, T, 'compute', controller.signal).then(
      () => undefined,
      (e: unknown) => e,
    );
    await until(() => stats.invocations === 1, 'run started');
    controller.abort(new Error('end'));
    gate.open();
    await turn;
    expect(await runLocalTurn(deps, T, 'receipt', never())).toBe('receipt');
    expect(h.log.runs(T).map((r) => r.status)).toEqual(['stopped', 'finished']);
  });

  it('raises ABORT_SETTLE_TIMEOUT when the run does not settle within the grace, and does not pretend it did', async () => {
    const gate = createGate();
    const { h, stats, deps, calls, durableCounts } = l1(slow(gate), {
      abortGraceMs: 40,
    });
    const controller = new AbortController();
    const reason = new Error('give up');
    const error = await (async () => {
      const turn = runLocalTurn(deps, T, 'go', controller.signal).then(
        () => undefined,
        (e: unknown) => e,
      );
      await until(() => stats.invocations === 1, 'run started');
      controller.abort(reason);
      return turn;
    })();
    expect(error).toBeInstanceOf(HeadlessTurnError);
    const timeout = error as HeadlessTurnError;
    expect(timeout.code).toBe('ABORT_SETTLE_TIMEOUT');
    expect(timeout).not.toBe(reason);
    expect(timeout.cause).toBe(reason);
    // Not released, not stopped, not settled: the log still says running.
    expect(h.log.runs(T)[0].status).toBe('running');

    // The thread stays reserved: a new turn is an explicit busy refusal, with
    // no agent call and no durable write, and nothing was retried.
    const before = durableCounts();
    const invocations = stats.invocations;
    await expect(
      runLocalTurn(deps, T, 'again', never()),
    ).rejects.toBeInstanceOf(ThreadBusyError);
    expect(stats.invocations).toBe(invocations);
    expect(durableCounts()).toEqual(before);
    expect(calls.stop).toHaveLength(1);
    expect(calls.run).toHaveLength(2);

    // When the producer finally ends, the runner finalizes by itself.
    gate.open();
    await until(() => h.log.runs(T)[0].status === 'stopped', 'finalization');
    expect(await runLocalTurn(deps, T, 'now free', never())).toBe('late text');
  });

  it('uses 10 s as the default grace, only on the abort path, and clears its timer', async () => {
    expect(DEFAULT_ABORT_GRACE_MS).toBe(10_000);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const timers = vi.spyOn(globalThis, 'setTimeout');
      // A successful turn waits for nothing: no grace timer exists.
      const ok = l1(answer('ok'));
      expect(await runLocalTurn(ok.deps, T, 'x', never())).toBe('ok');
      expect(timers.mock.calls.filter((c) => c[1] === 10_000)).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);

      // On abort the default grace is armed, and cleared when the run settles.
      const gate = createGate();
      const slowRun = l1(slow(gate));
      const controller = new AbortController();
      const turn = runLocalTurn(
        slowRun.deps,
        't-default',
        'x',
        controller.signal,
      );
      const settled = turn.then(
        () => undefined,
        (e: unknown) => e,
      );
      for (let i = 0; i < 200 && slowRun.stats.invocations === 0; i++)
        await new Promise((r) => setImmediate(r));
      controller.abort(new Error('stop'));
      for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
      expect(timers.mock.calls.filter((c) => c[1] === 10_000)).toHaveLength(1);
      gate.open();
      await settled;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      // The spy wraps the fake timer, so it is restored first.
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('accepts an injected grace and refuses an invalid one before reading or writing anything', async () => {
    const ok = l1(answer('ok'), { abortGraceMs: 1 });
    expect(await runLocalTurn(ok.deps, T, 'x', never())).toBe('ok');
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const base = l1(answer('no'), { abortGraceMs: bad });
      await expect(
        runLocalTurn(base.deps, T, 'x', never()),
      ).rejects.toBeInstanceOf(RangeError);
      expect(base.calls.run).toEqual([]);
      expect(base.h.log.startCalls).toBe(0);
    }
  });

  it('abort racing normal completion yields exactly one outcome, the abort reason, and a finished run', async () => {
    const base = l1(answer('done'));
    const controller = new AbortController();
    const reason = new Error('raced');
    const racing: LocalTurnDeps = {
      ...base.deps,
      runner: {
        ...base.deps.runner,
        // Aborts at the very instant the stream completes.
        run: (request) =>
          new Observable<BaseEvent>((subscriber) =>
            base.deps.runner.run(request).subscribe({
              next: (event) => subscriber.next(event),
              error: (error) => subscriber.error(error),
              complete: () => {
                controller.abort(reason);
                subscriber.complete();
              },
            }),
          ),
      },
    };
    await expect(runLocalTurn(racing, T, 'go', controller.signal)).rejects.toBe(
      reason,
    );
    expect(base.h.log.runs(T)[0].status).toBe('finished');
    // A late stop on a finished run has nothing to stop and starts nothing.
    expect(base.calls.run).toHaveLength(1);
    // The thread is free.
    expect(await runLocalTurn(base.deps, T, 'next', never())).toBe('done');
  });

  it('removes its abort listener whatever the outcome', async () => {
    const add = vi.fn();
    const remove = vi.fn();
    const spy = {
      aborted: false,
      reason: undefined,
      throwIfAborted: () => undefined,
      addEventListener: (...a: unknown[]) => add(...a),
      removeEventListener: (...a: unknown[]) => remove(...a),
    } as unknown as AbortSignal;
    const base = l1(answer('ok'));
    await runLocalTurn(base.deps, T, 'x', spy);
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0][1]).toBe(add.mock.calls[0][1]);
  });
});

describe('runLocalTurn: errors', () => {
  it('keeps the exact RUN_ERROR message and code, on the thrown error and in the log', async () => {
    const { h, deps } = l1(() => [
      {
        type: 'RUN_ERROR',
        message: 'You have reached the usage limit.',
        code: 'usage_limit_reached',
      },
    ]);
    const error = await runLocalTurn(deps, T, 'x', never()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HeadlessTurnError);
    expect(error).not.toBeInstanceOf(ThreadBusyError);
    expect((error as HeadlessTurnError).message).toBe(
      'You have reached the usage limit.',
    );
    expect((error as HeadlessTurnError).code).toBe('usage_limit_reached');
    const durableError = h.log
      .runEvents(T, h.log.runs(T)[0].runId)
      .map((s) => s.event as unknown as { type: string; code?: string })
      .find((e) => e.type === 'RUN_ERROR');
    expect(durableError?.code).toBe('usage_limit_reached');
  });

  it('a RUN_ERROR without a code has no code (nothing is invented)', async () => {
    const { deps } = l1(() => [
      { type: 'RUN_ERROR', message: 'plain failure' },
    ]);
    const error = (await runLocalTurn(deps, T, 'x', never()).then(
      () => undefined,
      (e: unknown) => e,
    )) as HeadlessTurnError;
    expect(error.message).toBe('plain failure');
    expect(error.code).toBeUndefined();
  });

  it('a producer that throws becomes the run failure, never a busy error', async () => {
    const { h, deps } = l1(() => [
      () => {
        throw new Error('synthetic model failure');
      },
    ]);
    const error = await runLocalTurn(deps, T, 'x', never()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HeadlessTurnError);
    expect(error).not.toBeInstanceOf(ThreadBusyError);
    expect(h.log.runs(T)[0].status).toBe('error');
  });

  const stub = (events: Observable<BaseEvent>): LocalTurnDeps => ({
    runner: { run: () => events, stop: async () => false },
    dotIdOf: () => AGENT_ID,
    agentFor: () => new ScriptedAgent(answer('x'), 'scripted'),
  });

  it('a stream that completes without a terminal event is an explicit error', async () => {
    const error = await runLocalTurn(
      stub(of({ type: 'RUN_STARTED', threadId: T, runId: 'r' } as BaseEvent)),
      T,
      'x',
      never(),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HeadlessTurnError);
    expect((error as HeadlessTurnError).code).toBe('UNEXPECTED_TERMINAL_STATE');
    const empty = await runLocalTurn(stub(EMPTY), T, 'x', never()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((empty as HeadlessTurnError).code).toBe('UNEXPECTED_TERMINAL_STATE');
  });

  it('a stream that errors is an explicit error that keeps its cause', async () => {
    const cause = new Error('stream broke');
    const error = (await runLocalTurn(
      stub(throwError(() => cause)),
      T,
      'x',
      never(),
    ).then(
      () => undefined,
      (e: unknown) => e,
    )) as HeadlessTurnError;
    expect(error).toBeInstanceOf(HeadlessTurnError);
    expect(error.code).toBe('RUN_STREAM_FAILED');
    expect(error.cause).toBe(cause);
  });

  it('a malformed RUN_ERROR still fails the turn (never success)', async () => {
    const error = (await runLocalTurn(
      stub(
        of({ type: 'RUN_ERROR', message: 42, code: 7 } as unknown as BaseEvent),
      ),
      T,
      'x',
      never(),
    ).then(
      () => undefined,
      (e: unknown) => e,
    )) as HeadlessTurnError;
    expect(error).toBeInstanceOf(HeadlessTurnError);
    expect(typeof error.message).toBe('string');
    expect(error.message.length).toBeGreaterThan(0);
    expect(error.code).toBeUndefined();
  });

  it('the stream errored after an abort still rejects without an unhandled rejection', async () => {
    const controller = new AbortController();
    const reason = new Error('abort');
    const deps: LocalTurnDeps = {
      runner: {
        run: () =>
          new Observable<BaseEvent>((subscriber) => {
            controller.signal.addEventListener('abort', () =>
              subscriber.error(new Error('stream torn down')),
            );
          }),
        stop: async () => true,
      },
      dotIdOf: () => AGENT_ID,
      agentFor: () => new ScriptedAgent(answer('x'), 'scripted'),
      abortGraceMs: 30,
    };
    const turn = runLocalTurn(deps, T, 'x', controller.signal);
    controller.abort(reason);
    await expect(turn).rejects.toBe(reason);
  });
});

describe('runLocalTurn: nothing bypasses the durable runner', () => {
  it('only reaches the model and the tools through runner.run (a runner that runs nothing leaves them untouched)', async () => {
    const world = createWorld();
    try {
      world.setScript(() => textReply('must not be requested'));
      const deps: LocalTurnDeps = {
        runner: { run: () => EMPTY, stop: async () => false },
        dotIdOf: () => world.dotId,
        agentFor: () => world.newAgent(emptyInput()) as never,
      };
      await expect(
        runLocalTurn(deps, DOT_THREAD, 'create a page', never()),
      ).rejects.toBeInstanceOf(HeadlessTurnError);
      expect(world.requests).toHaveLength(0);
      expect(readWitness(world.witnessDb)).toEqual([]);
      expect(world.pages()).toEqual([]);
    } finally {
      world.close();
    }
  });

  it('the module source never runs an agent, adds middleware or reads isRunning', () => {
    const source = readFileSync(`${root}src/server/headless-local.ts`, 'utf8');
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/\.runAgent\(/);
    expect(code).not.toMatch(/\.use\(/);
    expect(code).not.toMatch(/\bisRunning\b/);
    expect(code).not.toMatch(/\bagent\.run\(/);
    expect(code).not.toMatch(/\.subscribe\(\s*\{[^}]*\bTOOL_CALL/s);
    expect(code).not.toMatch(
      /from '\.\/(dot-agent|platform|store|workspace|voice|runner|app|index)\.js'/,
    );
    expect(code).not.toMatch(/process\.env|fetch\(|new Store|new Dot/);
  });
});

// ----------------------------------------------------------------------- L2

const worlds: World[] = [];
afterEach(() => {
  while (worlds.length) worlds.pop()!.close();
});
const emptyInput = (): RunAgentInput => ({
  threadId: DOT_THREAD,
  runId: 'x',
  state: {},
  messages: [],
  tools: [],
  context: [],
  forwardedProps: {},
});
function l2(options: Parameters<typeof createWorld>[0] = {}) {
  const world = createWorld(options);
  worlds.push(world);
  const calls = { run: 0, stop: 0 };
  const deps = (extra: Partial<LocalTurnDeps> = {}): LocalTurnDeps => ({
    runner: {
      run: (request) => (calls.run++, world.runner.run(request)),
      stop: (request) => (calls.stop++, world.runner.stop(request)),
    },
    dotIdOf: () => world.dotId,
    agentFor: () => world.newAgent(emptyInput()) as never,
    ...extra,
  });
  return { world, deps, calls };
}
const page = (title: string) =>
  Response.json({ title, url: `https://${title}.example.com`, text: title });

describe('runLocalTurn on the production DotAgent', () => {
  it('runs a tool turn through the durable runner with the A1 fence intact', async () => {
    const { world, deps } = l2();
    world.setScript((n) =>
      n === 1 ? toolReply(1) : textReply('Page created.'),
    );
    let atEntry: string[] = [];
    world.hooks.onExecutor = (point) => {
      if (point === 'entered') atEntry = durable(world, 'r-tool').types;
    };
    const text = await runLocalTurn(
      deps({ newId: () => 'r-tool' }),
      DOT_THREAD,
      'Create a page called Notes.',
      never(),
    );
    expect(text).toBe('Page created.');
    expect(world.pages()).toEqual(['Notes 1']);
    expect(readWitness(world.witnessDb)).toEqual([
      'executorEntered',
      'sideEffectCommitted',
    ]);
    // The whole tool call was durable before the executor was entered.
    expect(atEntry).toEqual(
      expect.arrayContaining([
        'TOOL_CALL_START',
        'TOOL_CALL_ARGS',
        'TOOL_CALL_END',
      ]),
    );
    expect(atEntry).not.toContain('TOOL_CALL_RESULT');
    expect(durable(world, 'r-tool').status).toBe('finished');
    expect(world.requests).toHaveLength(2);
  });

  it('is prompt-only after a run that stopped with an unknown tool outcome: no replay, no second effect', async () => {
    const { world, deps } = l2();
    world.setScript((n) =>
      n === 1 ? toolReply(1) : textReply('Compute answer.'),
    );
    // Stop the first run from inside its executor, so its tool outcome is unknown.
    world.hooks.onExecutor = (point) => {
      if (point === 'entered')
        void world.runner.stop({ threadId: DOT_THREAD, runId: 'r1' });
    };
    await world.runTurn('r1', [user('u1', 'Create a page called Notes.')]);
    world.hooks.onExecutor = undefined;
    const prior = durable(world, 'r1');
    expect(prior.status).toBe('stopped');
    expect(prior.results[0].content).toContain('may or may not have run');
    const witness = readWitness(world.witnessDb);
    const requestsBefore = world.requests.length;

    const text = await runLocalTurn(
      deps(),
      DOT_THREAD,
      'What is 2+2?',
      never(),
      { opendotsSource: 'voice_receipt' },
    );
    expect(text).toBe('Compute answer.');
    const sent = world.requests.slice(requestsBefore);
    expect(sent).toHaveLength(1);
    expect(sent[0].body.messages.map((m) => m.role)).not.toContain('tool');
    expect(providerHistory(sent[0].body).valid).toBe(true);
    // Nothing re-executed, nothing recovered, the unknown outcome is untouched.
    expect(readWitness(world.witnessDb)).toEqual(witness);
    expect(world.pages()).toEqual(['Notes 1']);
    expect(durable(world, 'r1').results).toEqual(prior.results);
  });

  it('turns a provider failure into a HeadlessTurnError with the durable RUN_ERROR message', async () => {
    const { world, deps } = l2();
    // 4xx: the OpenAI client does not retry it (a 5xx would back off for seconds).
    world.setScript(
      () => new Response('synthetic upstream failure', { status: 400 }),
    );
    const error = await runLocalTurn(deps(), DOT_THREAD, 'hello', never()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HeadlessTurnError);
    expect(error).not.toBeInstanceOf(ThreadBusyError);
    const run = world.log.runs(DOT_THREAD)[0];
    expect(run.status).toBe('error');
    const durableError = world.log
      .runEvents(DOT_THREAD, run.runId)
      .map((s) => s.event as unknown as { type: string; message?: string })
      .find((e) => e.type === 'RUN_ERROR');
    expect((error as HeadlessTurnError).message).toBe(durableError?.message);
  });

  it('a busy thread whose stop is still settling is refused: isRunning is false but the thread is reserved', async () => {
    const { world, deps, calls } = l2({ research: true });
    let release!: () => void;
    const latch = new Promise<void>((r) => (release = r));
    world.setScript((n) =>
      n === 1
        ? namedToolReply('c1', 'read_public_page', {
            url: 'https://a.example.com',
          })
        : textReply('Receipt.'),
    );
    world.hooks.onBrowse = () => latch.then(() => page('a'));
    const controller = new AbortController();
    const reason = new Error('call ended');
    let outcome: unknown = 'pending';
    const compute = runLocalTurn(
      deps(),
      DOT_THREAD,
      'compute',
      controller.signal,
    ).then(
      () => (outcome = 'resolved'),
      (e: unknown) => (outcome = e),
    );
    await until(
      () => readWitness(world.witnessDb).includes('executorEntered'),
      'executor entered',
    );
    controller.abort(reason);
    await drain(150);

    // The SDK-facing state says "not running"; admission still says busy.
    expect(await world.runner.isRunning({ threadId: DOT_THREAD })).toBe(false);
    expect(outcome).toBe('pending');
    const requests = world.requests.length;
    const witness = readWitness(world.witnessDb);
    const appendCalls = world.log.appendCalls;
    const startCalls = world.log.startCalls;
    const receipt = await runLocalTurn(
      deps(),
      DOT_THREAD,
      'receipt',
      never(),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(receipt).toBeInstanceOf(ThreadBusyError);
    expect(world.requests.length).toBe(requests);
    expect(readWitness(world.witnessDb)).toEqual(witness);
    expect(world.log.appendCalls).toBe(appendCalls);
    expect(world.log.startCalls).toBe(startCalls);

    // The executor settles: the caller is released with the abort reason, the
    // run is finalized, and the next turn is admitted.
    release();
    await compute;
    expect(outcome).toBe(reason);
    expect(world.log.runs(DOT_THREAD)[0].status).toBe('stopped');
    expect(await runLocalTurn(deps(), DOT_THREAD, 'receipt', never())).toBe(
      'Receipt.',
    );
    expect(calls.run).toBe(3);
    expect(calls.stop).toBe(1);
  });

  it('an executor that never settles within the grace: ABORT_SETTLE_TIMEOUT, thread still reserved, no overlapping run', async () => {
    const { world, deps } = l2({ research: true });
    let release!: () => void;
    const latch = new Promise<void>((r) => (release = r));
    world.setScript((n) =>
      n === 1
        ? namedToolReply('c1', 'read_public_page', {
            url: 'https://a.example.com',
          })
        : textReply('later'),
    );
    world.hooks.onBrowse = () => latch.then(() => page('a'));
    const controller = new AbortController();
    const compute = runLocalTurn(
      deps({ abortGraceMs: 50 }),
      DOT_THREAD,
      'compute',
      controller.signal,
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    await until(
      () => readWitness(world.witnessDb).includes('executorEntered'),
      'executor entered',
    );
    controller.abort(new Error('end'));
    const error = await compute;
    expect((error as HeadlessTurnError).code).toBe('ABORT_SETTLE_TIMEOUT');
    // The executor is still in flight; no second run may start on the thread.
    const requests = world.requests.length;
    await expect(
      runLocalTurn(deps(), DOT_THREAD, 'again', never()),
    ).rejects.toBeInstanceOf(ThreadBusyError);
    expect(world.requests.length).toBe(requests);
    expect(world.log.runs(DOT_THREAD)).toHaveLength(1);
    release();
    await until(
      () => world.log.runs(DOT_THREAD)[0].status === 'stopped',
      'finalization after the executor settled',
    );
    expect(await runLocalTurn(deps(), DOT_THREAD, 'again', never())).toBe(
      'later',
    );
  });
});
