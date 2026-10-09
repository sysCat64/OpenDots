import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { AbstractAgent, Middleware } from '@ag-ui/client';
import type { BaseEvent, RunAgentInput } from '@ag-ui/core';
import { Observable, tap } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunRejectedError } from '../src/server/durable-runner';
import { SERVER_TOOL, user } from './helpers/event-fixtures';
import {
  AGENT_ID,
  collect,
  committedTypes,
  createHarness,
  prime,
  runInput,
  startRun,
  typesOf,
  until,
  type Harness,
} from './helpers/runner-harness';
import {
  HANG,
  ScriptedAgent,
  finished,
  textMessage,
  toolCall,
  toolResult,
} from './helpers/scripted-agent';

// The middleware contract the execution fence depends on, and the guard that
// fails closed when it does not hold. Every test is offline.
const harnesses: Harness[] = [];
const make = () => {
  const harness = createHarness();
  harnesses.push(harness);
  return harness;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const harness of harnesses.splice(0)) harness.cleanup();
});

const chainOf = (agent: AbstractAgent) =>
  (agent as unknown as { middlewares: unknown[] }).middlewares;
const textAgent = () =>
  new ScriptedAgent((input) => [
    ...textMessage('a1', 'hello'),
    finished(input),
  ]);
const run1 = () => runInput('t1', 'r1', [user('u1')]);
const passThrough = () => (input: RunAgentInput, next: AbstractAgent) =>
  next.run(input);

// A middleware that hands each event on a macrotask later, as the runtime's
// MCP middleware does.
class LateMiddleware extends Middleware {
  constructor(readonly apiKey = 'sk-secret-do-not-print') {
    super();
  }
  run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const queue: BaseEvent[] = [];
      let done = false;
      const pump = () =>
        setTimeout(() => {
          const item = queue.shift();
          if (item) subscriber.next(item);
          if (queue.length || !done) pump();
          else subscriber.complete();
        }, 0);
      pump();
      const sub = next.run(input).subscribe({
        next: (event) => queue.push(event),
        error: (error) => subscriber.error(error),
        complete: () => (done = true),
      });
      return () => sub.unsubscribe();
    });
  }
}

describe('the guard: no other middleware is allowed', () => {
  it('rejects a function middleware before anything is written or requested', async () => {
    const h = make();
    const agent = textAgent();
    agent.use(passThrough());
    const input = run1();
    expect(() => startRun(h.runner, agent, input)).toThrowError(
      RunRejectedError,
    );
    try {
      startRun(h.runner, agent, input);
    } catch (error) {
      expect((error as RunRejectedError).code).toBe('UNSUPPORTED_MIDDLEWARE');
    }
    expect(h.log.startCalls + h.log.appendCalls).toBe(0);
    expect(agent.stats.invocations).toBe(0);
    expect(chainOf(agent)).toHaveLength(1);
  });

  it('rejects a class middleware and never prints its data', async () => {
    const h = make();
    const agent = textAgent();
    agent.use(new LateMiddleware());
    let message = '';
    try {
      startRun(h.runner, agent, run1());
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('LateMiddleware');
    expect(message).not.toContain('sk-secret-do-not-print');
    expect(agent.stats.invocations).toBe(0);
  });

  for (const [name, value] of [
    ['missing', undefined],
    ['not an array', {}],
    ['a string', 'middlewares'],
  ] as const)
    it(`refuses to guess when the chain is ${name} (the SDK layout changed)`, () => {
      const h = make();
      const agent = textAgent();
      (agent as unknown as { middlewares: unknown }).middlewares = value;
      expect(() => startRun(h.runner, agent, run1())).toThrowError(
        /not readable/,
      );
      expect(agent.stats.invocations).toBe(0);
      expect(h.log.startCalls).toBe(0);
    });

  it('is checked again when the chain is composed: a middleware added after admission stops the run before the first model request', async () => {
    for (const where of ['inner', 'outer'] as const) {
      const h = make();
      const agent = textAgent();
      const late = new LateMiddleware();
      // runAgent awaits its subscribers before it composes the chain, which is
      // the window in which a one-time check at admission would be stale.
      agent.subscribe({
        onRunInitialized: () => {
          if (where === 'inner') agent.use(late);
          else chainOf(agent).unshift(late);
        },
      });
      const events = await collect(startRun(h.runner, agent, run1()));
      expect(agent.stats.invocations).toBe(0);
      expect(typesOf(events).at(-1)).toBe('RUN_ERROR');
      const message = (events.at(-1) as unknown as { message: string }).message;
      expect(message).toMatch(/unsupported middleware|out of place/);
      expect(message).not.toContain('sk-secret-do-not-print');
      expect(h.log.getRun('t1', 'r1')?.status).toBe('error');
      // Only the foreign middleware is left; the run's own tap is gone.
      expect(chainOf(agent)).toEqual([late]);
    }
  });

  it('fails closed when use() no longer installs the tap', async () => {
    const h = make();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const agent = textAgent();
    agent.use = () => agent;
    const events = await collect(startRun(h.runner, agent, run1()));
    expect(agent.stats.invocations).toBe(0);
    expect(typesOf(events).at(-1)).toBe('RUN_ERROR');
    expect(h.log.getRun('t1', 'r1')?.status).toBe('error');
  });
});

describe('the tap lifecycle', () => {
  it('uses the public use() as the last middleware and keeps runAgent as the execution path', async () => {
    const h = make();
    const agent = textAgent();
    const use = vi.spyOn(agent, 'use');
    const runAgent = vi.spyOn(agent, 'runAgent');
    await collect(startRun(h.runner, agent, run1()));
    expect(use).toHaveBeenCalledTimes(1);
    expect(use.mock.calls[0][0]).toBeInstanceOf(Middleware);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(agent.stats.invocations).toBe(1);
    expect(Object.hasOwn(agent, 'run')).toBe(false);
  });

  it('is installed during the run and gone when it ends, however it ends', async () => {
    const h = make();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // completes
    const done = textAgent();
    const during: number[] = [];
    done.subscribe({
      onRunInitialized: () => void during.push(chainOf(done).length),
    });
    await collect(startRun(h.runner, done, run1()));
    expect(chainOf(done)).toEqual([]);
    // fails to persist
    h.log.beforeAppend = (events) => {
      if (events.some((e) => e.type === 'TEXT_MESSAGE_CONTENT')) {
        h.log.beforeAppend = undefined;
        throw new Error('disk full');
      }
    };
    const failed = textAgent();
    await collect(
      startRun(h.runner, failed, runInput('t2', 'r2', [user('u2')])),
    );
    expect(chainOf(failed)).toEqual([]);
    // is stopped
    const hanging = new ScriptedAgent(() => [
      { type: 'TEXT_MESSAGE_START', messageId: 'a1', role: 'assistant' },
      HANG,
    ]);
    const stopped = collect(
      startRun(h.runner, hanging, runInput('t3', 'r3', [user('u3')])),
    );
    await until(() =>
      committedTypes(h.db, 't3', 'r3').includes('TEXT_MESSAGE_START'),
    );
    expect(chainOf(hanging)).toHaveLength(1);
    await h.runner.stop({ threadId: 't3', runId: 'r3' });
    await stopped;
    expect(chainOf(hanging)).toEqual([]);
    // the producer errors
    const broken = new ScriptedAgent(() => [
      () => {
        throw new Error('model failed');
      },
    ]);
    await collect(
      startRun(h.runner, broken, runInput('t4', 'r4', [user('u4')])),
    );
    expect(chainOf(broken)).toEqual([]);
    expect(during).toEqual([1]);
  });

  it('does not accumulate taps or persist across runs when an agent is used again', async () => {
    const h = make();
    const agent = textAgent();
    for (const n of [1, 2, 3]) {
      const input = runInput('t1', `r${n}`, [user(`u${n}`)]);
      await collect(startRun(h.runner, agent, input));
      expect(chainOf(agent)).toEqual([]);
    }
    expect(h.log.runs('t1').map((r) => r.status)).toEqual([
      'finished',
      'finished',
      'finished',
    ]);
    for (const n of [1, 2, 3])
      expect(committedTypes(h.db, 't1', `r${n}`)).toEqual([
        'RUN_STARTED',
        'TEXT_MESSAGE_START',
        'TEXT_MESSAGE_CONTENT',
        'TEXT_MESSAGE_END',
        'RUN_FINISHED',
      ]);
  });

  it('keeps concurrent runs of different threads apart', async () => {
    const h = make();
    const scripts = ['t1', 't2'].map(
      (thread) =>
        new ScriptedAgent((input) => [
          ...textMessage(`m-${thread}`, `text of ${thread}`),
          HANG,
          finished(input),
        ]),
    );
    const outputs = ['t1', 't2'].map((thread, i) =>
      collect(
        startRun(
          h.runner,
          scripts[i],
          runInput(thread, `r-${thread}`, [user(`u-${thread}`)]),
        ),
      ),
    );
    await until(
      () =>
        committedTypes(h.db, 't1', 'r-t1').includes('TEXT_MESSAGE_END') &&
        committedTypes(h.db, 't2', 'r-t2').includes('TEXT_MESSAGE_END'),
    );
    await h.runner.stop({ threadId: 't1' });
    await h.runner.stop({ threadId: 't2' });
    const [one, two] = await Promise.all(outputs);
    const body = (events: BaseEvent[]) =>
      JSON.stringify(events.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT'));
    expect(body(one)).toContain('text of t1');
    expect(body(one)).not.toContain('text of t2');
    expect(body(two)).toContain('text of t2');
    expect(body(two)).not.toContain('text of t1');
    for (const thread of ['t1', 't2']) {
      const stored = JSON.stringify(
        h.log.threadEvents(thread).map((s) => s.event),
      );
      expect(stored).not.toContain(
        thread === 't1' ? 'text of t2' : 'text of t1',
      );
    }
  });

  it('refuses a second run on an agent instance that already has an active run, and leaves the first untouched', async () => {
    const h = make();
    const agent = new ScriptedAgent((input) => [
      ...textMessage('a1', 'first'),
      HANG,
      finished(input),
    ]);
    const first = collect(startRun(h.runner, agent, run1()));
    await until(() =>
      committedTypes(h.db, 't1', 'r1').includes('TEXT_MESSAGE_END'),
    );
    let code = '';
    try {
      startRun(h.runner, agent, runInput('t2', 'r2', [user('u2')]));
    } catch (error) {
      code = (error as RunRejectedError).code;
    }
    expect(code).toBe('UNSUPPORTED_MIDDLEWARE');
    expect(h.log.getRun('t2', 'r2')).toBeUndefined();
    await h.runner.stop({ threadId: 't1' });
    await first;
    expect(committedTypes(h.db, 't1', 'r1')).not.toContain('TOOL_CALL_START');
    expect(chainOf(agent)).toEqual([]);
  });

  it('belongs to its own run: the installed tap errors for any other run id', async () => {
    const h = make();
    const agent = new ScriptedAgent((input) => [
      ...textMessage('a1', 'x'),
      HANG,
      finished(input),
    ]);
    const output = collect(startRun(h.runner, agent, run1()));
    await until(() => committedTypes(h.db, 't1', 'r1').length > 1);
    const installed = chainOf(agent)[0] as Middleware;
    const other = runInput('t1', 'another-run', []);
    const errors: unknown[] = [];
    installed.run(other, agent).subscribe({ error: (e) => errors.push(e) });
    expect(String((errors[0] as Error).message)).toMatch(/another run/);
    await h.runner.stop({ threadId: 't1' });
    await output;
  });
});

describe('the pinned SDK contract', () => {
  const require = createRequire(import.meta.url);
  const version = (name: string) =>
    JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8'))
      .version as string;

  it('is the validated SDK pair; an upgrade needs its own review', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(manifest.dependencies['@copilotkit/runtime']).toBe('1.75.0');
    expect(version('@copilotkit/runtime')).toBe('1.75.0');
    expect(version('@ag-ui/client')).toBe('0.0.59');
  });

  it('composes use() so that the last middleware is innermost', async () => {
    const order: string[] = [];
    const agent = textAgent();
    for (const name of ['first', 'second', 'last'])
      agent.use((input, next) => {
        order.push(`${name}:run`);
        return next.run(input).pipe(
          tap((event) => {
            if (event.type === 'TEXT_MESSAGE_START')
              order.push(`${name}:event`);
          }),
        );
      });
    prime(agent, run1());
    await agent.runAgent(run1());
    expect(order).toEqual([
      'first:run',
      'second:run',
      'last:run',
      'last:event',
      'second:event',
      'first:event',
    ]);
  });

  it('exposes the chain as a plain array that use() appends to', () => {
    const agent = textAgent();
    expect(Array.isArray(chainOf(agent))).toBe(true);
    const mw = passThrough();
    agent.use(mw);
    expect(chainOf(agent)).toHaveLength(1);
    expect(chainOf(agent)[0]).toBeInstanceOf(Middleware);
  });

  it('bypasses every middleware when run() is called directly (the reason runAgent stays the path)', async () => {
    const agent = textAgent();
    let called = 0;
    agent.use((input, next) => {
      called += 1;
      return next.run(input);
    });
    prime(agent, run1());
    await collect(agent.run(run1()));
    expect(called).toBe(0);
    await agent.runAgent(run1());
    expect(called).toBe(1);
  });

  it('ends the run when an operator throws, where a subscriber callback throw would not', async () => {
    const agent = textAgent();
    const boom = new Error('operator boom');
    agent.use((input, next) =>
      next.run(input).pipe(
        tap((event) => {
          if (event.type === 'TEXT_MESSAGE_CONTENT') throw boom;
        }),
      ),
    );
    prime(agent, run1());
    await expect(agent.runAgent(run1())).rejects.toBe(boom);
    // The SDK swallows a throw in onEvent: the run goes on.
    const other = textAgent();
    prime(other, run1());
    const seen: string[] = [];
    await other.runAgent(run1(), {
      onEvent: ({ event }) => {
        seen.push(event.type);
        throw new Error('swallowed');
      },
    });
    expect(seen).toContain('RUN_FINISHED');
  });

  it('would let an asynchronous middleware run after the tap saw the event (why none is allowed)', async () => {
    const h = make();
    const agent = textAgent();
    agent.use(new LateMiddleware());
    expect(() => startRun(h.runner, agent, run1())).toThrowError(
      /unsupported middleware/,
    );
  });
});

describe('the middleware guard does not change the other contracts', () => {
  it('still runs a server tool once with its result durable', async () => {
    const h = make();
    let executions = 0;
    const agent = new ScriptedAgent((input) => [
      ...toolCall('c1', SERVER_TOOL, 'a1'),
      () => {
        executions += 1;
      },
      toolResult('c1'),
      finished(input),
    ]);
    await collect(startRun(h.runner, agent, run1()));
    expect(executions).toBe(1);
    expect(h.log.heldToolCallIds('t1')).toEqual(new Set(['c1']));
    expect(AGENT_ID).toBeTruthy();
  });
});
