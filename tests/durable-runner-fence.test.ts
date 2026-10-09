import type { DatabaseSync } from 'node:sqlite';
import { AbstractAgent } from '@ag-ui/client';
import type { BaseEvent, RunAgentInput } from '@ag-ui/core';
import { Observable } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SERVER_TOOL, user } from './helpers/event-fixtures';
import { UNKNOWN_OUTCOME_CONTENT } from '../src/server/run-rules';
import {
  AGENT_ID,
  committedTypes,
  createHarness,
  prime,
  runInput,
  typesOf,
  collect,
  type Harness,
} from './helpers/runner-harness';
import {
  finished,
  textMessage,
  toolCall,
  toolResult,
} from './helpers/scripted-agent';

// The execution fence (A1): a server tool executor never begins before the
// tool call's lifecycle (START, every ARGS, END) is committed, and each event is
// committed when the producer's own push returns, not eventually. Offline: the
// producer is a local function, and "durable" is read through a second SQLite
// connection, as another process sees it.
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

interface Execute {
  execute: (durable: () => string[]) => void | Promise<void>;
}
type Step = Record<string, unknown> | Execute;
const isExecute = (step: Step): step is Execute =>
  typeof (step as Execute).execute === 'function';

// A producer that pushes synchronously and never yields between a push and the
// next step: the worst case for an asynchronous persister. It records, after
// every push returns, what another connection can read.
class FenceAgent extends AbstractAgent {
  readonly afterPush: Array<{ pushed: string; durable: string[] }> = [];
  readonly entries: Array<{ at: string; durable: string[] }> = [];
  invocations = 0;
  aborts = 0;
  private cancelled = false;
  constructor(
    private readonly steps: (input: RunAgentInput) => Step[],
    private readonly observer: () => DatabaseSync,
    // How the producer learns that it must stop: from abortRun() (the real
    // engine's isCancelled), or only from its subscription being closed (the
    // teardown of an Observable). The runner must be safe with either alone.
    private readonly honors: 'abort' | 'unsubscribe' = 'abort',
  ) {
    super({ agentId: AGENT_ID });
  }
  clone(): FenceAgent {
    return new FenceAgent(this.steps, this.observer, this.honors);
  }
  // The real engine learns of a stop or a failure here and checks it before its
  // tool phase (isCancelled); this producer does the same before an executor.
  abortRun(): void {
    this.aborts += 1;
    this.cancelled = true;
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      this.invocations += 1;
      const durable = () =>
        committedTypes(this.observer(), input.threadId, input.runId);
      void (async () => {
        try {
          const push = (event: Record<string, unknown>) => {
            subscriber.next(event as unknown as BaseEvent);
            this.afterPush.push({
              pushed: String(event.type),
              durable: durable(),
            });
          };
          push({
            type: 'RUN_STARTED',
            threadId: input.threadId,
            runId: input.runId,
          });
          for (const step of this.steps(input)) {
            if (this.honors === 'abort' ? this.cancelled : subscriber.closed)
              break;
            if (isExecute(step)) {
              this.entries.push({ at: 'executor', durable: durable() });
              await step.execute(durable);
            } else push(step);
          }
          subscriber.complete();
        } catch (error) {
          subscriber.error(error);
        }
      })();
    });
  }
}

const input = () => runInput('t1', 'r1', [user('u1')]);
const toolRun = (executed: string[]) => (i: RunAgentInput) => [
  ...textMessage('a0', 'looking'),
  ...toolCall('c1', SERVER_TOOL, 'a1', '{"x":1}'),
  { execute: () => void executed.push('c1') },
  toolResult('c1'),
  finished(i),
];

describe('the persist-before-execute fence', () => {
  it('has the whole tool call durable when the executor enters', async () => {
    const h = make();
    const executed: string[] = [];
    const agent = new FenceAgent(toolRun(executed), () => h.observer());
    const run = input();
    await collect(
      h.runner.run({
        threadId: 't1',
        agent: prime(agent as never, run),
        input: run,
      }),
    );
    expect(executed).toEqual(['c1']);
    const durable = agent.entries[0].durable;
    expect(durable).toEqual(
      expect.arrayContaining([
        'TOOL_CALL_START',
        'TOOL_CALL_ARGS',
        'TOOL_CALL_END',
      ]),
    );
  });

  it('has each event durable when the producer push returns', async () => {
    const h = make();
    const agent = new FenceAgent(toolRun([]), () => h.observer());
    const run = input();
    await collect(
      h.runner.run({
        threadId: 't1',
        agent: prime(agent as never, run),
        input: run,
      }),
    );
    const lagging = agent.afterPush.filter(
      (entry, index) => entry.durable.length < index + 1,
    );
    expect(lagging).toEqual([]);
  });
});

describe('persistence failure before the executor', () => {
  for (const honors of ['abort', 'unsubscribe'] as const)
    for (const failing of [
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
    ] as const) {
      it(`never enters the executor when ${failing} cannot be written (producer stops on ${honors} alone)`, async () => {
        const h = make();
        // runAgent now rejects with the write error and the SDK logs that.
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const executed: string[] = [];
        h.log.beforeAppend = (events) => {
          if (events.some((e) => e.type === failing)) {
            h.log.beforeAppend = undefined;
            throw new Error('disk full');
          }
        };
        const agent = new FenceAgent(
          toolRun(executed),
          () => h.observer(),
          honors,
        );
        const run = input();
        const events = await collect(
          h.runner.run({
            threadId: 't1',
            agent: prime(agent as never, run),
            input: run,
          }),
        );
        expect(executed).toEqual([]);
        expect(agent.entries).toEqual([]);
        const types = typesOf(events);
        // The event that failed was never published or committed as the
        // producer's. Finalization closes the dangling call with its own closers
        // (END, an interrupted RESULT) directly before the terminal event.
        if (failing === 'TOOL_CALL_END')
          expect(types.slice(-3)).toEqual([
            'TOOL_CALL_END',
            'TOOL_CALL_RESULT',
            'RUN_ERROR',
          ]);
        if (failing === 'TOOL_CALL_START')
          expect(types).not.toContain('TOOL_CALL_START');
        expect(types.at(-1)).toBe('RUN_ERROR');
        expect(h.log.getRun('t1', 'r1')?.status).toBe('error');
        expect(h.log.checkInvariants()).toEqual([]);
      });
    }
});

describe('a failure after the executor was entered', () => {
  it('closes the unrecorded call as an unknown outcome, never as a stock error, and does not retry', async () => {
    const h = make();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const executed: string[] = [];
    const agent = new FenceAgent(
      (i) => [
        ...toolCall('c1', SERVER_TOOL, 'a1'),
        { execute: () => void executed.push('c1') },
        {
          execute: () => {
            throw new Error('stream dropped');
          },
        },
        toolResult('c1'),
        finished(i),
      ],
      () => h.observer(),
    );
    const run = input();
    const events = await collect(
      h.runner.run({
        threadId: 't1',
        agent: prime(agent as never, run),
        input: run,
      }),
    );
    expect(executed).toEqual(['c1']);
    const results = events.filter((e) => e.type === 'TOOL_CALL_RESULT');
    expect(
      results.map((e) => (e as unknown as { content: string }).content),
    ).toEqual([UNKNOWN_OUTCOME_CONTENT]);
    expect(typesOf(events).at(-1)).toBe('RUN_ERROR');
    expect(JSON.stringify(events)).not.toMatch(
      /missing_terminal_event|did not run/i,
    );
    expect(agent.invocations).toBe(1);
  });
});
