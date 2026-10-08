import { afterEach, describe, expect, it } from 'vitest';
import type { Message } from '@ag-ui/core';
import { snapshotDatabase } from './helpers/db-snapshot';
import {
  SERVER_TOOL,
  assistant,
  callEvents,
  runStarted,
  toolMessage,
  user,
} from './helpers/event-fixtures';
import {
  createHarness,
  runInput,
  runToEnd,
  seedRun,
  startRun,
  typesOf,
  type Harness,
} from './helpers/runner-harness';
import {
  ScriptedAgent,
  finished,
  textMessage,
  toolCall,
  toolResult,
} from './helpers/scripted-agent';

// L8: the stale-tool-history interlock (DEC-5), end to end through run(). A
// browser that claims continuity but leaves out a result the log holds is
// refused before anything runs; a prompt-only turn is not.
const harnesses: Harness[] = [];
const make = () => {
  const harness = createHarness();
  harnesses.push(harness);
  return harness;
};
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.cleanup();
});

// A thread whose first run called c1 and c2 and recorded both results.
async function threadWithResults(h: Harness) {
  await runToEnd(
    h.runner,
    new ScriptedAgent((input) => [
      ...toolCall('c1', SERVER_TOOL, 'a1'),
      toolResult('c1'),
      ...toolCall('c2', SERVER_TOOL, 'a1'),
      toolResult('c2'),
      ...textMessage('a2', 'done'),
      finished(input),
    ]),
    runInput('t1', 'r1', [user('u1')]),
  );
}

const counted = () => {
  let toolRuns = 0;
  const agent = new ScriptedAgent((input) => [
    () => {
      toolRuns += 1;
    },
    ...textMessage('n1', 'ok'),
    finished(input),
  ]);
  return { agent, toolRuns: () => toolRuns };
};

describe('the nine-row truth table through run()', () => {
  const rows: Array<{
    name: string;
    seed: 'results' | 'empty' | 'pending';
    messages: Message[];
    verdict: 'REJECT' | 'ACCEPT';
  }> = [
    {
      name: 'stale tab: assistant tool call present, recorded result absent',
      seed: 'results',
      messages: [user('u1'), assistant('a1', 'c1'), user('u9')],
      verdict: 'REJECT',
    },
    {
      name: 'prompt-only input on a thread with tool history',
      seed: 'results',
      messages: [user('u9')],
      verdict: 'ACCEPT',
    },
    {
      name: 'complete history: call and result',
      seed: 'results',
      messages: [
        user('u1'),
        assistant('a1', 'c1', 'c2'),
        toolMessage('m1', 'c1'),
        toolMessage('m2', 'c2'),
        user('u9'),
      ],
      verdict: 'ACCEPT',
    },
    {
      name: 'one assistant message with two calls, the unanswered one is recorded',
      seed: 'results',
      messages: [
        user('u1'),
        assistant('a1', 'c1', 'c2'),
        toolMessage('m1', 'c1'),
      ],
      verdict: 'REJECT',
    },
    {
      name: 'unanswered call whose result the log does not hold (pending client call)',
      seed: 'pending',
      messages: [user('u1'), assistant('a1', 'c9'), user('u9')],
      verdict: 'ACCEPT',
    },
    {
      name: 'client supplies the HITL result for a call the log does not hold',
      seed: 'pending',
      messages: [user('u1'), assistant('a1', 'c9'), toolMessage('m1', 'c9')],
      verdict: 'ACCEPT',
    },
    {
      name: 'truncated history that mentions neither the call nor its result',
      seed: 'results',
      messages: [user('u9')],
      verdict: 'ACCEPT',
    },
    {
      name: 'empty log',
      seed: 'empty',
      messages: [user('u1'), assistant('a1', 'c1'), user('u9')],
      verdict: 'ACCEPT',
    },
    {
      name: 'tool message present, its assistant message omitted',
      seed: 'results',
      messages: [user('u1'), toolMessage('m1', 'c1'), user('u9')],
      verdict: 'ACCEPT',
    },
  ];

  it.each(rows)('$name -> $verdict', async ({ seed, messages, verdict }) => {
    const h = make();
    if (seed === 'results') await threadWithResults(h);
    if (seed === 'pending')
      seedRun(h.log, {
        threadId: 't1',
        runId: 'r1',
        start: runStarted([], [], { threadId: 't1', runId: 'r1' }),
        events: [
          ...callEvents('c9', SERVER_TOOL, 1),
          { type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' } as never,
        ],
        status: 'finished',
      });
    const before = snapshotDatabase(h.throwaway.path);
    const { agent, toolRuns } = counted();
    if (verdict === 'REJECT') {
      expect(() =>
        startRun(h.runner, agent, runInput('t1', 'r2', messages)),
      ).toThrowError(
        expect.objectContaining({
          name: 'RunRejectedError',
          code: 'STALE_TOOL_HISTORY',
        }),
      );
      // Nothing ran and nothing was written: provider 0, tool 0, durable 0.
      expect(agent.stats.invocations).toBe(0);
      expect(toolRuns()).toBe(0);
      expect(snapshotDatabase(h.throwaway.path)).toBe(before);
    } else {
      const events = await runToEnd(
        h.runner,
        agent,
        runInput('t1', 'r2', messages),
      );
      expect(typesOf(events).at(-1)).toBe('RUN_FINISHED');
      expect(agent.stats.invocations).toBe(1);
    }
  });
});

describe('the interlock sees what recovery wrote', () => {
  it('counts an unknown-outcome result written by recovery as held', async () => {
    const h = make();
    seedRun(h.log, {
      threadId: 't1',
      runId: 'r1',
      start: runStarted([], [user('u1')], { threadId: 't1', runId: 'r1' }),
      events: callEvents('c1', SERVER_TOOL, 1),
    });
    // The dead run's call has no result yet; the stale tab still names it.
    const { agent, toolRuns } = counted();
    expect(() =>
      startRun(
        h.runner,
        agent,
        runInput('t1', 'r2', [user('u1'), assistant('a1', 'c1'), user('u2')]),
      ),
    ).toThrowError(expect.objectContaining({ code: 'STALE_TOOL_HISTORY' }));
    expect(agent.stats.invocations).toBe(0);
    expect(toolRuns()).toBe(0);
    // Recovery did run: the dead run is closed with the unknown-outcome result.
    expect(h.log.getRun('t1', 'r1')?.status).toBe('interrupted');
    expect(h.log.heldToolCallIds('t1')).toEqual(new Set(['c1']));
    // A prompt-only turn on the same thread goes through.
    const events = await runToEnd(
      h.runner,
      counted().agent,
      runInput('t1', 'r3', [user('u3')]),
    );
    expect(typesOf(events).at(-1)).toBe('RUN_FINISHED');
  });
});
