import { DatabaseSync } from 'node:sqlite';
import type { BaseEvent } from '@ag-ui/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationLog } from '../src/server/conversation-log';
import { DurableAgentRunner } from '../src/server/durable-runner';
import { RunDiagnosis, RunDiagnosisError } from '../src/server/run-diagnosis';
import { snapshotDatabase } from './helpers/db-snapshot';
import {
  CLIENT_EXECUTABLE,
  CLIENT_TOOL,
  SERVER_TOOL,
  callEvents,
  reasoningEvents,
  runStarted,
  textEvents,
  user,
} from './helpers/event-fixtures';
import { installNetworkGuard, netStats } from './helpers/net-guard';
import {
  AGENT_ID,
  createHarness,
  seedRun,
  type Harness,
} from './helpers/runner-harness';
import { recordStatements } from './helpers/statement-recorder';

// R-DIAG read-only and authority guarantees. The diagnosis is advisory: it reads,
// it never writes, never recovers, never calls a provider or a tool, never
// opens a transaction and never reaches a thread its caller does not own.
// Throwaway databases, offline.
installNetworkGuard();
const T = 'thread-1';
const ev = (value: Record<string, unknown>) => value as unknown as BaseEvent;

const harnesses: Harness[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) closers.pop()!();
  while (harnesses.length) harnesses.pop()!.cleanup();
});
const make = (options: Parameters<typeof createHarness>[0] = {}) => {
  const h = createHarness(options);
  harnesses.push(h);
  return h;
};
const diagnosisOf = (h: Harness) =>
  new RunDiagnosis({
    log: h.log,
    runner: h.runner,
    clientExecutableToolNames: CLIENT_EXECUTABLE,
  });

function populate(h: Harness) {
  const put = (
    threadId: string,
    runId: string,
    events: BaseEvent[],
    declared: string[] = [],
    status?: 'finished' | 'error',
  ) =>
    seedRun(h.log, {
      threadId,
      runId,
      agentId: AGENT_ID,
      start: runStarted(declared, [user(`u-${runId}`)], { threadId, runId }),
      events,
      status,
    });
  put(
    T,
    'r-ok',
    [
      ...textEvents('a0', true, 'ok'),
      ev({ type: 'RUN_FINISHED', threadId: T, runId: 'r-ok' }),
    ],
    [],
    'finished',
  );
  put(T, 'r-r26b', reasoningEvents('m1', false));
  put(
    'thread-r22',
    'r-r22',
    [
      ...callEvents('c1', SERVER_TOOL, 1),
      ...callEvents('c2', CLIENT_TOOL, 1, 'a2'),
    ],
    [CLIENT_TOOL],
  );
  put('thread-rec', 'r-rec', callEvents('c1', SERVER_TOOL, 1));
  put(
    'thread-err',
    'r-err',
    [ev({ type: 'RUN_ERROR', message: 'bad' })],
    [],
    'error',
  );
}

async function exerciseAll(service: RunDiagnosis) {
  for (const [threadId, runId] of [
    [T, 'r-ok'],
    [T, 'r-r26b'],
    ['thread-r22', 'r-r22'],
    ['thread-rec', 'r-rec'],
    ['thread-err', 'r-err'],
  ] as const) {
    await service.diagnoseThread({ threadId, agentId: AGENT_ID });
    const run = await service.diagnoseRun({
      threadId,
      runId,
      agentId: AGENT_ID,
    });
    if (run.outcome === 'diagnosed' && run.evidence.digest)
      await service.confirmEvidence({
        threadId,
        runId,
        agentId: AGENT_ID,
        digest: run.evidence.digest,
      });
  }
  await service.diagnoseThread({ threadId: 'never', agentId: AGENT_ID });
}

describe('the diagnosis writes nothing', () => {
  it('leaves the database byte-for-byte unchanged across repeated calls, before and after ready()', async () => {
    const h = make();
    populate(h);
    const service = diagnosisOf(h);
    const before = snapshotDatabase(h.throwaway.path);
    for (let i = 0; i < 5; i++) await exerciseAll(service);
    expect(snapshotDatabase(h.throwaway.path)).toBe(before);

    await h.runner.ready();
    const afterReady = snapshotDatabase(h.throwaway.path);
    for (let i = 0; i < 5; i++) await exerciseAll(service);
    expect(snapshotDatabase(h.throwaway.path)).toBe(afterReady);
  });

  it('works over a database connection that cannot write: a write attempt would throw', async () => {
    const h = make();
    populate(h);
    const readOnly = new DatabaseSync(h.throwaway.path, { readOnly: true });
    closers.push(() => readOnly.close());
    const log = new ConversationLog(readOnly);
    const runner = new DurableAgentRunner({
      log,
      clientExecutableToolNames: CLIENT_EXECUTABLE,
      ownsThread: () => true,
    });
    const service = new RunDiagnosis({
      log,
      runner,
      clientExecutableToolNames: CLIENT_EXECUTABLE,
    });
    // The control: this connection really refuses a write.
    expect(() =>
      readOnly.exec(
        "INSERT INTO conversation_messages(threadId, messagesJson, lastEventId) VALUES ('x','[]',0)",
      ),
    ).toThrow(/readonly/i);
    for (let i = 0; i < 3; i++) await exerciseAll(service);
    const thread = await service.diagnoseThread({
      threadId: 'thread-r22',
      agentId: AGENT_ID,
    });
    if (thread.outcome !== 'diagnosed') throw new Error('refused');
    expect(thread.unresolved[0].classification.class).toBe('R22');
  });

  it('executes only SELECT statements and opens no transaction', async () => {
    const h = make();
    populate(h);
    const recorder = recordStatements(h.db);
    const service = diagnosisOf(h);
    await exerciseAll(service);
    expect(recorder.executed.length).toBeGreaterThan(0);
    expect(recorder.nonSelect()).toEqual([]);
    expect(h.db.isTransaction).toBe(false);
    recorder.stop();
  });

  it('issues no log append, run start or rebuild, and starts and stops no run', async () => {
    const h = make();
    populate(h);
    const run = vi.spyOn(h.runner, 'run');
    const stop = vi.spyOn(h.runner, 'stop');
    const before = {
      append: h.log.appendCalls,
      start: h.log.startCalls,
      rebuild: h.log.rebuildCalls,
    };
    await exerciseAll(diagnosisOf(h));
    expect({
      append: h.log.appendCalls,
      start: h.log.startCalls,
      rebuild: h.log.rebuildCalls,
    }).toEqual(before);
    expect(run).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it('closes no running run: recoverable and deferred rows stay running, and ready() then does what it would have done', async () => {
    const h = make();
    populate(h);
    const running = () =>
      h.log
        .runningRuns()
        .map((run) => run.runId)
        .sort();
    expect(running()).toEqual(['r-r22', 'r-r26b', 'r-rec']);
    await exerciseAll(diagnosisOf(h));
    expect(running()).toEqual(['r-r22', 'r-r26b', 'r-rec']);
    const ready = await h.runner.ready();
    expect(ready.recovered.map((r) => r.runId)).toEqual(['r-rec']);
    expect(ready.deferred.map((r) => r.runId).sort()).toEqual([
      'r-r22',
      'r-r26b',
    ]);
  });

  it('creates no schema object on an empty database', async () => {
    const h = make();
    const objects = () =>
      h.db.prepare('SELECT type, name FROM sqlite_master ORDER BY name').all();
    expect(objects()).toEqual([]);
    const service = diagnosisOf(h);
    await service.diagnoseThread({ threadId: T, agentId: AGENT_ID });
    await expect(
      service.diagnoseRun({ threadId: T, runId: 'r', agentId: AGENT_ID }),
    ).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
    expect(objects()).toEqual([]);
  });

  it('does not read or change the derived message cache, and is not affected by a corrupt one', async () => {
    const h = make();
    populate(h);
    await h.runner.ready();
    const cache = () =>
      h.db
        .prepare('SELECT * FROM conversation_messages ORDER BY threadId')
        .all();
    const before = JSON.stringify(cache());
    const recorder = recordStatements(h.db);
    await exerciseAll(diagnosisOf(h));
    expect(
      recorder.executed.filter((sql) =>
        /\b(FROM|JOIN)\s+conversation_messages\b/i.test(sql),
      ),
    ).toEqual([]);
    recorder.stop();
    expect(JSON.stringify(cache())).toBe(before);
    h.db
      .prepare("UPDATE conversation_messages SET messagesJson='{bad json'")
      .run();
    const damaged = JSON.stringify(cache());
    const thread = await diagnosisOf(h).diagnoseThread({
      threadId: T,
      agentId: AGENT_ID,
    });
    expect(thread.outcome).toBe('diagnosed');
    expect(JSON.stringify(cache())).toBe(damaged);
  });

  it('makes no network connection', async () => {
    const h = make();
    populate(h);
    await exerciseAll(diagnosisOf(h));
    expect(netStats.nonLoopback).toEqual([]);
  });
});

describe("authority: the runner's ownership predicate, before any thread read", () => {
  it('reads nothing for a thread the caller does not own', async () => {
    const owns = vi.fn((threadId: string) => threadId === 'mine');
    const h = make({ ownsThread: owns });
    populate(h);
    const recorder = recordStatements(h.db);
    const service = diagnosisOf(h);
    for (const request of [
      () => service.diagnoseThread({ threadId: T, agentId: AGENT_ID }),
      () =>
        service.diagnoseRun({ threadId: T, runId: 'r-ok', agentId: AGENT_ID }),
      () =>
        service.confirmEvidence({
          threadId: T,
          runId: 'r-ok',
          agentId: AGENT_ID,
          digest: 'a'.repeat(64),
        }),
    ])
      await expect(request()).rejects.toMatchObject({
        name: 'RunDiagnosisError',
        code: 'THREAD_NOT_OWNED',
      });
    expect(owns).toHaveBeenCalledWith(T, AGENT_ID);
    // Not one statement, not even a schema check.
    expect(recorder.executed).toEqual([]);
    recorder.stop();
  });

  it("uses the same predicate and the caller's agent id as admission", async () => {
    const owns = vi.fn(
      (threadId: string, agentId: string) =>
        threadId === T && agentId === AGENT_ID,
    );
    const h = make({ ownsThread: owns });
    populate(h);
    const service = diagnosisOf(h);
    await expect(
      service.diagnoseThread({ threadId: T, agentId: 'another-agent' }),
    ).rejects.toMatchObject({ code: 'THREAD_NOT_OWNED' });
    await expect(
      service.diagnoseThread({ threadId: T, agentId: AGENT_ID }),
    ).resolves.toMatchObject({ outcome: 'diagnosed' });
  });

  it('has no global scope: an all-threads, malformed, extended or missing request is refused unread', async () => {
    const h = make();
    populate(h);
    const recorder = recordStatements(h.db);
    const service = diagnosisOf(h) as unknown as Record<
      string,
      (request: unknown) => Promise<unknown>
    >;
    const named = { threadId: T, agentId: AGENT_ID, runId: 'r-ok' };
    const requests: Array<[string, unknown]> = [
      ['diagnoseThread', { all: true }],
      ['diagnoseThread', {}],
      ['diagnoseThread', null],
      ['diagnoseThread', undefined],
      ['diagnoseThread', 'thread-1'],
      ['diagnoseThread', { threadId: '', agentId: AGENT_ID }],
      ['diagnoseThread', { threadId: T, agentId: '' }],
      ['diagnoseThread', { threadId: 7, agentId: AGENT_ID }],
      ['diagnoseThread', { threadId: T, agentId: AGENT_ID, all: true }],
      ['diagnoseRun', { all: true }],
      ['diagnoseRun', { ...named, runId: '' }],
      ['diagnoseRun', { ...named, all: true }],
      ['confirmEvidence', { all: true }],
      ['confirmEvidence', { ...named, digest: 'a'.repeat(64), all: true }],
      ['confirmEvidence', { ...named, threadId: undefined, digest: 'a' }],
    ];
    for (const [method, request] of requests) {
      const settled = await service[method](request).then(
        () => 'resolved',
        (error: unknown) =>
          error instanceof RunDiagnosisError
            ? error.code
            : `other:${String(error)}`,
      );
      expect(settled, `${method} ${JSON.stringify(request)}`).toMatch(
        /^(THREAD_NOT_OWNED|RUN_NOT_FOUND)$/,
      );
    }
    expect(
      recorder.executed.filter((sql) => /conversation_/.test(sql)),
    ).toEqual([]);
    recorder.stop();
  });

  it('a throwing ownership predicate fails closed', async () => {
    const h = make({
      ownsThread: () => {
        throw new Error('boom');
      },
    });
    populate(h);
    await expect(
      diagnosisOf(h).diagnoseThread({ threadId: T, agentId: AGENT_ID }),
    ).rejects.toMatchObject({ code: 'THREAD_NOT_OWNED' });
  });
});

describe('content safety: the default diagnosis carries identifiers, names, counts, enumerations and digests only', () => {
  it('contains no text, argument, result, reasoning or state value', async () => {
    const SECRET = 'SENTINEL-7f3a-do-not-leak';
    const h = make();
    seedRun(h.log, {
      threadId: T,
      runId: 'r-dead',
      agentId: AGENT_ID,
      start: runStarted([CLIENT_TOOL], [user('u1', SECRET)], {
        threadId: T,
        runId: 'r-dead',
      }),
      events: [
        ev({ type: 'TEXT_MESSAGE_START', messageId: 'a1', role: 'assistant' }),
        ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: SECRET }),
        ev({ type: 'REASONING_START', messageId: 'm1' }),
        ev({
          type: 'REASONING_MESSAGE_CONTENT',
          messageId: 'm1',
          delta: SECRET,
        }),
        ev({
          type: 'TOOL_CALL_START',
          toolCallId: 'c1',
          toolCallName: SERVER_TOOL,
          parentMessageId: 'a2',
        }),
        ev({ type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: SECRET }),
        ev({ type: 'TOOL_CALL_END', toolCallId: 'c1' }),
        ev({ type: 'STATE_SNAPSHOT', snapshot: { secret: SECRET } }),
        ev({ type: 'CUSTOM', name: 'x', value: { secret: SECRET } }),
        ev({ type: 'RAW', event: { secret: SECRET } }),
      ],
    });
    seedRun(h.log, {
      threadId: T,
      runId: 'r-done',
      agentId: AGENT_ID,
      start: runStarted([], [user('u0', SECRET)], {
        threadId: T,
        runId: 'r-done',
      }),
      events: [
        ev({
          type: 'TOOL_CALL_RESULT',
          toolCallId: 'x',
          messageId: 'x-r',
          role: 'tool',
          content: SECRET,
        }),
        ev({ type: 'RUN_ERROR', message: SECRET, code: 'X' }),
      ],
      status: 'error',
    });
    const service = diagnosisOf(h);
    const out = JSON.stringify([
      await service.diagnoseThread({ threadId: T, agentId: AGENT_ID }),
      await service.diagnoseRun({
        threadId: T,
        runId: 'r-dead',
        agentId: AGENT_ID,
      }),
      await service.diagnoseRun({
        threadId: T,
        runId: 'r-done',
        agentId: AGENT_ID,
      }),
    ]);
    expect(out.length).toBeGreaterThan(500);
    expect(out).not.toContain(SECRET);
  });
});

describe('a long history costs a bounded number of statements', () => {
  it("reads the run rows once and each run's events once, plus the facts' own reads", async () => {
    const h = make();
    h.log.ensureSchema();
    const RUNS = 150;
    for (let n = 0; n < RUNS; n++)
      seedRun(h.log, {
        threadId: T,
        runId: `r${n}`,
        agentId: AGENT_ID,
        start: runStarted([], [], { threadId: T, runId: `r${n}` }),
        events: [
          ...textEvents(`a${n}`, true, 'x'),
          ev({ type: 'RUN_FINISHED', threadId: T, runId: `r${n}` }),
        ],
        status: 'finished',
      });
    const recorder = recordStatements(h.db);
    const started = performance.now();
    const thread = await diagnosisOf(h).diagnoseThread({
      threadId: T,
      agentId: AGENT_ID,
    });
    const elapsed = performance.now() - started;
    expect(thread.outcome).toBe('diagnosed');
    const eventReads = recorder.executed.filter((sql) =>
      /FROM conversation_events WHERE threadId = \? AND runId = \?/.test(sql),
    );
    expect(eventReads).toHaveLength(RUNS);
    // Nothing scans another thread or the global tables.
    expect(
      recorder.executed.filter((sql) =>
        /FROM conversation_runs WHERE status = 'running'/.test(sql),
      ),
    ).toEqual([]);
    expect(elapsed).toBeLessThan(10_000);
    recorder.stop();
  });
});
