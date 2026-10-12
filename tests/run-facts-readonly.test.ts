import { DatabaseSync } from 'node:sqlite';
import type { BaseEvent } from '@ag-ui/core';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationLog } from '../src/server/conversation-log';
import { RunFacts, type RunnerView } from '../src/server/run-facts';
import {
  CLIENT_EXECUTABLE,
  CLIENT_TOOL,
  SERVER_TOOL,
  callEvents,
  reasoningEvents,
  runFinished,
  runStarted,
  textEvents,
  user,
} from './helpers/event-fixtures';
import { snapshotDatabase } from './helpers/db-snapshot';
import { installNetworkGuard, netStats } from './helpers/net-guard';
import {
  AGENT_ID,
  createHarness,
  prime,
  runInput,
  seedRun,
  until,
  type Harness,
} from './helpers/runner-harness';
import { recordStatements } from './helpers/statement-recorder';
import { HANG, ScriptedAgent, textMessage } from './helpers/scripted-agent';

// C4c read-only guarantees: no write, no append, no status change, no DDL, no
// provider or tool call, no recovery and no use of the derived message view,
// before and after ready(). Throwaway databases, scripted producer, offline.
const T = 'thread-1';
const ev = (value: Record<string, unknown>) => value as unknown as BaseEvent;

const harnesses: Harness[] = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.cleanup();
});
function make(): Harness {
  const h = createHarness();
  harnesses.push(h);
  return h;
}

function populate(h: Harness) {
  const put = (
    runId: string,
    events: BaseEvent[],
    threadId: string,
    declared: string[] = [],
  ) =>
    seedRun(h.log, {
      threadId,
      runId,
      agentId: AGENT_ID,
      start: runStarted(declared, [], { threadId, runId }),
      events,
    });
  // Deferred (R26b), deferred (R22), recoverable, terminal success, terminal error.
  put('r-r26b', reasoningEvents('m1', false), T);
  put(
    'r-r22',
    [
      ...callEvents('c1', SERVER_TOOL, 1),
      ...callEvents('c2', CLIENT_TOOL, 1, 'a2'),
    ],
    'thread-r22',
    [CLIENT_TOOL],
  );
  put('r-rec', callEvents('c1', SERVER_TOOL, 1), 'thread-rec');
  put(
    'r-ok',
    [...textEvents('a1', true, 'ok'), runFinished('thread-ok', 'r-ok')],
    'thread-ok',
  );
  put(
    'r-err',
    [ev({ type: 'RUN_ERROR', message: 'bad', code: 'X' })],
    'thread-err',
  );
}

// Every accessor, on every kind of run, once.
function exerciseAll(facts: RunFacts) {
  facts.threadState(T, AGENT_ID);
  facts.threadState('thread-rec', AGENT_ID);
  facts.threadState('never', AGENT_ID);
  facts.activeRuns({ all: true });
  facts.activeRuns({ agentId: AGENT_ID });
  facts.unresolvedRuns({ all: true });
  facts.unresolvedRuns({ threadId: T, agentId: AGENT_ID });
  for (const [threadId, runId] of [
    [T, 'r-r26b'],
    ['thread-r22', 'r-r22'],
    ['thread-rec', 'r-rec'],
    ['thread-ok', 'r-ok'],
    ['thread-err', 'r-err'],
  ] as const) {
    facts.attemptFacts({ threadId, runId, agentId: AGENT_ID });
    facts.terminalResult({ threadId, runId, agentId: AGENT_ID });
  }
}

describe('the accessors write nothing', () => {
  it('leaves the database byte-for-byte unchanged across repeated calls, before and after ready()', async () => {
    const h = make();
    populate(h);
    const snapshots: string[] = [snapshotDatabase(h.throwaway.path)];
    for (let i = 0; i < 25; i++) exerciseAll(h.runner.facts);
    snapshots.push(snapshotDatabase(h.throwaway.path));
    expect(snapshots[1]).toBe(snapshots[0]);

    await h.runner.ready();
    const afterReady = snapshotDatabase(h.throwaway.path);
    for (let i = 0; i < 25; i++) exerciseAll(h.runner.facts);
    expect(snapshotDatabase(h.throwaway.path)).toBe(afterReady);
  });

  it('executes only SELECT statements, and opens no transaction', async () => {
    const h = make();
    populate(h);
    const recorder = recordStatements(h.db);
    for (let i = 0; i < 5; i++) {
      exerciseAll(h.runner.facts);
      expect(h.db.isTransaction).toBe(false);
    }
    expect(recorder.executed.length).toBeGreaterThan(0);
    expect(recorder.nonSelect()).toEqual([]);
    recorder.reset();
    await h.runner.ready();
    recorder.reset();
    exerciseAll(h.runner.facts);
    expect(recorder.nonSelect()).toEqual([]);
    recorder.stop();
  });

  it('issues no log append, run start, rebuild or schema call', () => {
    const h = make();
    populate(h);
    const before = {
      append: h.log.appendCalls,
      start: h.log.startCalls,
      rebuild: h.log.rebuildCalls,
    };
    exerciseAll(h.runner.facts);
    expect({
      append: h.log.appendCalls,
      start: h.log.startCalls,
      rebuild: h.log.rebuildCalls,
    }).toEqual(before);
  });

  it('changes no run status and recovers nothing: running rows stay running until ready()', async () => {
    const h = make();
    populate(h);
    const running = () =>
      h.log
        .runningRuns()
        .map((run) => run.runId)
        .sort();
    expect(running()).toEqual(['r-r22', 'r-r26b', 'r-rec']);
    exerciseAll(h.runner.facts);
    expect(running()).toEqual(['r-r22', 'r-r26b', 'r-rec']);
    // ready() then does exactly what it would have done without the reads.
    const ready = await h.runner.ready();
    expect(ready.recovered.map((r) => r.runId)).toEqual(['r-rec']);
    expect(ready.deferred.map((r) => r.runId).sort()).toEqual([
      'r-r22',
      'r-r26b',
    ]);
  });

  it('creates no table, no index and no schema object on an empty database', () => {
    const h = make();
    const objects = () =>
      h.db.prepare('SELECT type, name FROM sqlite_master ORDER BY name').all();
    const before = objects();
    h.runner.facts.threadState(T, AGENT_ID);
    h.runner.facts.activeRuns({ all: true });
    h.runner.facts.unresolvedRuns({ all: true });
    expect(() =>
      h.runner.facts.attemptFacts({
        threadId: T,
        runId: 'r',
        agentId: AGENT_ID,
      }),
    ).toThrow();
    expect(objects()).toEqual(before);
    expect(before).toEqual([]);
  });

  it('does not touch the derived message view: no read of conversation_messages and no dependence on it', () => {
    const h = make();
    populate(h);
    const recorder = recordStatements(h.db);
    exerciseAll(h.runner.facts);
    const touching = recorder.executed.filter((sql) =>
      /\bFROM\s+conversation_messages\b|\bJOIN\s+conversation_messages\b/i.test(
        sql,
      ),
    );
    expect(touching).toEqual([]);
    recorder.stop();
  });

  it('writes no synthetic tool result: the event counts of every run are unchanged', () => {
    const h = make();
    populate(h);
    const counts = () =>
      h.db
        .prepare(
          'SELECT runId, COUNT(*) AS n, SUM(eventType = ?) AS results FROM conversation_events GROUP BY runId ORDER BY runId',
        )
        .all('TOOL_CALL_RESULT');
    const before = counts();
    exerciseAll(h.runner.facts);
    expect(counts()).toEqual(before);
  });
});

describe('the accessors call neither provider nor tool', () => {
  it('does not start, abort or feed an agent that is running', async () => {
    const h = make();
    const agent = new ScriptedAgent(() => [...textMessage('a1', 'x'), HANG]);
    const input = runInput(T, 'r-live', [user('u1')]);
    const sub = h.runner
      .run({ threadId: T, agent: prime(agent, input), input })
      .subscribe({ error: () => undefined });
    await until(() => agent.stats.emitted >= 4);
    const before = { ...agent.stats, inputs: agent.stats.inputs.length };
    for (let i = 0; i < 25; i++) exerciseAllLive(h.runner.facts);
    expect({ ...agent.stats, inputs: agent.stats.inputs.length }).toEqual(
      before,
    );
    expect(agent.stats.aborts).toBe(0);
    await h.runner.stop({ threadId: T, runId: 'r-live' } as never);
    await until(() => h.log.getRun(T, 'r-live')?.status !== 'running');
    sub.unsubscribe();
  });
});

function exerciseAllLive(facts: RunFacts) {
  facts.threadState(T, AGENT_ID);
  facts.activeRuns({ all: true });
  facts.unresolvedRuns({ all: true });
  facts.attemptFacts({ threadId: T, runId: 'r-live', agentId: AGENT_ID });
  facts.terminalResult({ threadId: T, runId: 'r-live', agentId: AGENT_ID });
}

describe('a real SQLite read-only connection is enough', () => {
  it('answers every accessor, and the connection itself refuses writes', () => {
    const h = make();
    populate(h);
    const readOnly = new DatabaseSync(h.throwaway.path, { readOnly: true });
    try {
      const view: RunnerView = {
        active: new Map(),
        ownsThread: () => true,
        clientExecutableToolNames: CLIENT_EXECUTABLE,
      };
      const facts = new RunFacts(new ConversationLog(readOnly), view);
      exerciseAll(facts);
      expect(facts.threadState(T, AGENT_ID).state).toBe('unresolved');
      expect(facts.unresolvedRuns({ all: true })).toHaveLength(3);
      expect(
        facts.terminalResult({
          threadId: 'thread-ok',
          runId: 'r-ok',
          agentId: AGENT_ID,
        }),
      ).toMatchObject({ available: true, outcome: 'success', text: 'ok' });
      expect(() =>
        readOnly.exec(
          "INSERT INTO conversation_runs VALUES('x','y',1,'a',NULL,'running',1,NULL)",
        ),
      ).toThrow(/readonly|read-only|read only/i);
    } finally {
      readOnly.close();
    }
  });

  it('works for a database in which the conversation schema does not exist', () => {
    const h = make();
    const readOnly = new DatabaseSync(h.throwaway.path, { readOnly: true });
    try {
      const view: RunnerView = {
        active: new Map(),
        ownsThread: () => true,
        clientExecutableToolNames: CLIENT_EXECUTABLE,
      };
      const facts = new RunFacts(new ConversationLog(readOnly), view);
      expect(facts.threadState(T, AGENT_ID)).toMatchObject({
        state: 'idle',
        schema: 'absent',
      });
      expect(facts.unresolvedRuns({ all: true })).toEqual([]);
    } finally {
      readOnly.close();
    }
  });
});

describe('the accessors open no connection', () => {
  it('makes no socket connection, loopback or otherwise', () => {
    installNetworkGuard();
    const h = make();
    populate(h);
    const before = {
      loopback: netStats.loopback,
      nonLoopback: [...netStats.nonLoopback],
    };
    for (let i = 0; i < 10; i++) exerciseAll(h.runner.facts);
    expect(netStats.loopback).toBe(before.loopback);
    expect(netStats.nonLoopback).toEqual(before.nonLoopback);
    expect(netStats.nonLoopback).toEqual([]);
  });
});
