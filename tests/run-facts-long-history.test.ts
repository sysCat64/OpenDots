import type { BaseEvent } from '@ag-ui/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLIENT_TOOL,
  SERVER_TOOL,
  callEvents,
  runStarted,
  textEvents,
} from './helpers/event-fixtures';
import {
  AGENT_ID,
  createHarness,
  seedRun,
  type Harness,
} from './helpers/runner-harness';
import { recordStatements } from './helpers/statement-recorder';

// C4c cost on long histories. The accessors must not scale with the length of
// the thread's history the way a whole-thread derivation does, and must not
// scan the event table of other threads. These assertions use the number of
// executed statements (deterministic) and a generous wall-clock ceiling that
// only catches a gross regression, never a close call.
const T = 'thread-long';
const ev = (value: Record<string, unknown>) => value as unknown as BaseEvent;

const harnesses: Harness[] = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.cleanup();
});

describe('threadState on a long thread', () => {
  it('executes a bounded number of statements and does not read events of ended runs', () => {
    const h = createHarness();
    harnesses.push(h);
    h.log.ensureSchema();
    const RUNS = 300;
    for (let n = 0; n < RUNS; n++) {
      const runId = `r${n}`;
      seedRun(h.log, {
        threadId: T,
        runId,
        agentId: AGENT_ID,
        start: runStarted([], [], { threadId: T, runId }),
        events: [
          ...textEvents(`a${n}`, true, 'x'),
          ...callEvents(`c${n}`, SERVER_TOOL, 2, `p${n}`),
          ev({ type: 'RUN_FINISHED', threadId: T, runId }),
        ],
      });
    }
    // A running run on another thread: it must not cost this thread anything.
    seedRun(h.log, {
      threadId: 'other',
      runId: 'r-other',
      agentId: AGENT_ID,
      start: runStarted([], [], { threadId: 'other', runId: 'r-other' }),
      events: callEvents('c-other', CLIENT_TOOL, 1),
    });
    const recorder = recordStatements(h.db);
    const started = performance.now();
    const state = h.runner.facts.threadState(T, AGENT_ID);
    const elapsed = performance.now() - started;
    expect(state).toMatchObject({ state: 'idle', runCount: RUNS });
    // hasSchema, runs(thread), maxEventId: independent of history length.
    expect(recorder.executed).toHaveLength(3);
    // The only statement that touches the event table is the watermark, and no
    // run's events were read.
    expect(
      recorder.executed.filter((sql) => /FROM conversation_events/.test(sql)),
    ).toEqual([
      'SELECT MAX(id) AS id FROM conversation_events WHERE threadId = ?',
    ]);
    expect(elapsed).toBeLessThan(1_000);
    recorder.stop();
  });
});

describe('a run with many events', () => {
  it('attemptFacts and terminalResult read the run once, in three statements', () => {
    const h = createHarness();
    harnesses.push(h);
    h.log.ensureSchema();
    const calls = 2_000;
    const events: BaseEvent[] = [];
    for (let n = 0; n < calls; n++)
      events.push(...callEvents(`c${n}`, SERVER_TOOL, 2, `p${n}`));
    events.push(...textEvents('final', true, 'the end'));
    events.push(ev({ type: 'RUN_FINISHED', threadId: T, runId: 'big' }));
    seedRun(h.log, {
      threadId: T,
      runId: 'big',
      agentId: AGENT_ID,
      start: runStarted([], [], { threadId: T, runId: 'big' }),
      events,
    });
    const recorder = recordStatements(h.db);
    let started = performance.now();
    const facts = h.runner.facts.attemptFacts({
      threadId: T,
      runId: 'big',
      agentId: AGENT_ID,
    });
    const attemptMs = performance.now() - started;
    expect(recorder.executed).toHaveLength(3);
    expect(facts.toolCalls).toHaveLength(calls);
    expect(facts.summary.serverOutcomesKnown).toBe(calls);
    recorder.reset();
    started = performance.now();
    const result = h.runner.facts.terminalResult({
      threadId: T,
      runId: 'big',
      agentId: AGENT_ID,
    });
    const terminalMs = performance.now() - started;
    expect(recorder.executed).toHaveLength(3);
    expect(result).toMatchObject({ outcome: 'success', text: 'the end' });
    // About 8,000 events. Measured around 10 ms on the development host; the
    // ceiling only catches an accidental quadratic or per-event reducer.
    expect(attemptMs).toBeLessThan(5_000);
    expect(terminalMs).toBeLessThan(5_000);
    recorder.stop();
  });
});

describe('unresolvedRuns scale with the nonterminal runs, not with history', () => {
  it('executes three statements plus one per running run', () => {
    const h = createHarness();
    harnesses.push(h);
    h.log.ensureSchema();
    for (let n = 0; n < 200; n++) {
      const threadId = `t${n}`;
      seedRun(h.log, {
        threadId,
        runId: `done${n}`,
        agentId: AGENT_ID,
        start: runStarted([], [], { threadId, runId: `done${n}` }),
        events: [ev({ type: 'RUN_FINISHED', threadId, runId: `done${n}` })],
      });
    }
    for (let n = 0; n < 5; n++)
      seedRun(h.log, {
        threadId: `dead${n}`,
        runId: `dead${n}`,
        agentId: AGENT_ID,
        start: runStarted([], [], {
          threadId: `dead${n}`,
          runId: `dead${n}`,
        }),
        events: callEvents(`c${n}`, SERVER_TOOL, 1),
      });
    const recorder = recordStatements(h.db);
    const listed = h.runner.facts.unresolvedRuns({ all: true });
    expect(listed).toHaveLength(5);
    // hasSchema + the running-run scan + one event read per running run.
    expect(recorder.executed).toHaveLength(2 + 5);
    recorder.stop();
  });
});
