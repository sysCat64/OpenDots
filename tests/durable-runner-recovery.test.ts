import { afterEach, describe, expect, it } from 'vitest';
import type { BaseEvent } from '@ag-ui/core';
import {
  INTERRUPTION_MESSAGE,
  UNKNOWN_OUTCOME_CONTENT,
} from '../src/server/run-rules';
import { snapshotDatabase } from './helpers/db-snapshot';
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
import {
  collect,
  createHarness,
  restartRunner,
  runInput,
  runToEnd,
  seedRun,
  startRun,
  typesOf,
  until,
  type Harness,
} from './helpers/runner-harness';
import {
  ScriptedAgent,
  finished,
  textMessage,
  toolCall,
  toolResult,
} from './helpers/scripted-agent';

// Recovery of runs that died without a terminal event, in-process: the dead
// state is written through the log and a restarted runner recovers it. The real
// SIGKILL evidence for the same classes is tests/crash. Recovery must never call
// a model or execute a tool, so every case carries counters that stay at zero.
const harnesses: Harness[] = [];
const make = () => {
  const harness = createHarness();
  harnesses.push(harness);
  return harness;
};
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.cleanup();
});

const THREAD = 't1';
const RUN = 'r1';
const ids = { threadId: THREAD, runId: RUN };
const stockError = {
  type: 'RUN_ERROR',
  message: INTERRUPTION_MESSAGE,
  code: 'INCOMPLETE_STREAM',
};

// Counters for the two things recovery must never do.
const never = () => {
  const counters = { model: 0, tool: 0 };
  const agent = new ScriptedAgent(
    (input) => [
      () => {
        counters.tool += 1;
      },
      ...textMessage('later', 'x'),
      finished(input),
    ],
    'dot-1',
    undefined,
    () => {
      counters.model += 1;
    },
  );
  return { counters, agent };
};

async function recoverFresh(h: Harness) {
  const fresh = restartRunner(h);
  const result = await fresh.runner.ready();
  return { ...fresh, result };
}

const storedTypes = (h: Harness) =>
  h.log.runEvents(THREAD, RUN).map((s) => s.event.type as string);

describe('the closed recovery classes', () => {
  it('A. RUN_STARTED only: interrupted with INCOMPLETE_STREAM', async () => {
    const h = make();
    seedRun(h.log, { ...ids, start: runStarted([], [user('u1')], ids) });
    const { result } = await recoverFresh(h);
    expect(result.recovered).toMatchObject([
      { kind: 'no_tool_lifecycle', appended: ['RUN_ERROR'] },
    ]);
    expect(storedTypes(h)).toEqual(['RUN_STARTED', 'RUN_ERROR']);
    expect(h.log.runEvents(THREAD, RUN)[1].event).toEqual(stockError);
    expect(h.log.getRun(THREAD, RUN)).toMatchObject({ status: 'interrupted' });
    expect(h.log.checkInvariants()).toEqual([]);
  });

  it('B. open text: keeps the durable partial, closes it, then RUN_ERROR', async () => {
    const h = make();
    seedRun(h.log, {
      ...ids,
      start: runStarted([], [user('u1')], ids),
      events: textEvents('a1', false, 'partial answer'),
    });
    const fresh = await recoverFresh(h);
    expect(storedTypes(h)).toEqual([
      'RUN_STARTED',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'RUN_ERROR',
    ]);
    expect(h.log.getRun(THREAD, RUN)?.status).toBe('interrupted');
    const view = await fresh.runner.messagesFor(THREAD);
    expect(view.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'partial answer',
    });
  });

  it('C. incomplete tool arguments (the executor cannot have run): stock failure result, no execution', async () => {
    const h = make();
    const { counters } = never();
    seedRun(h.log, {
      ...ids,
      start: runStarted([], [user('u1')], ids),
      events: callEvents('c1', SERVER_TOOL, 0),
    });
    await recoverFresh(h);
    expect(storedTypes(h).slice(-3)).toEqual([
      'TOOL_CALL_END',
      'TOOL_CALL_RESULT',
      'RUN_ERROR',
    ]);
    const result = h.log
      .runEvents(THREAD, RUN)
      .find((s) => s.eventType === 'TOOL_CALL_RESULT')!.event as unknown as {
      messageId: string;
      content: string;
    };
    expect(result.messageId).toBe('c1-result');
    expect(JSON.parse(result.content)).toMatchObject({
      status: 'error',
      reason: 'missing_terminal_event',
    });
    expect(h.log.getRun(THREAD, RUN)?.status).toBe('interrupted');
    expect(counters).toEqual({ model: 0, tool: 0 });
  });

  it('D. server tool with an ambiguous outcome: the unknown-outcome result, never a retry', async () => {
    const h = make();
    const { counters } = never();
    seedRun(h.log, {
      ...ids,
      start: runStarted([], [user('u1')], ids),
      events: callEvents('c1', SERVER_TOOL, 1),
    });
    await recoverFresh(h);
    expect(storedTypes(h).slice(-2)).toEqual(['TOOL_CALL_RESULT', 'RUN_ERROR']);
    expect(h.log.runEvents(THREAD, RUN).at(-2)!.event).toEqual({
      type: 'TOOL_CALL_RESULT',
      toolCallId: 'c1',
      messageId: 'c1-unknown-outcome',
      role: 'tool',
      content: UNKNOWN_OUTCOME_CONTENT,
    });
    expect(h.log.getRun(THREAD, RUN)?.status).toBe('interrupted');
    expect(counters).toEqual({ model: 0, tool: 0 });
  });

  it('E. a durable result without a terminal event: the result stays, only the terminal is added', async () => {
    const h = make();
    const { counters } = never();
    seedRun(h.log, {
      ...ids,
      start: runStarted([], [user('u1')], ids),
      events: callEvents('c1', SERVER_TOOL, 2),
    });
    const before = h.log.runEvents(THREAD, RUN).map((s) => s.event);
    await recoverFresh(h);
    const after = h.log.runEvents(THREAD, RUN).map((s) => s.event);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length)).toEqual([stockError]);
    expect(counters).toEqual({ model: 0, tool: 0 });
  });

  it('F. a pending client tool in a healthy finished run is preserved: ready() writes nothing', async () => {
    const h = make();
    seedRun(h.log, {
      ...ids,
      start: runStarted([CLIENT_TOOL], [user('u1')], ids),
      events: [...callEvents('rv1', CLIENT_TOOL, 1), runFinished(THREAD, RUN)],
      status: 'finished',
    });
    await h.runner.ready();
    const before = snapshotDatabase(h.throwaway.path);
    const { result } = await recoverFresh(h);
    expect(result.recovered).toEqual([]);
    expect(snapshotDatabase(h.throwaway.path)).toBe(before);
    expect(h.log.heldToolCallIds(THREAD).size).toBe(0);
  });

  it('G. a client TOOL_CALL_END without RUN_FINISHED: the canonical pending form, not a server ambiguity', async () => {
    const h = make();
    const { counters } = never();
    seedRun(h.log, {
      ...ids,
      start: runStarted([CLIENT_TOOL], [user('u1')], ids),
      events: callEvents('rv1', CLIENT_TOOL, 1),
    });
    const { result } = await recoverFresh(h);
    expect(result.recovered).toMatchObject([
      {
        kind: 'client_hitl_pending',
        appended: ['RUN_FINISHED'],
        status: 'finished',
      },
    ]);
    expect(storedTypes(h).slice(-2)).toEqual(['TOOL_CALL_END', 'RUN_FINISHED']);
    expect(storedTypes(h)).not.toContain('TOOL_CALL_RESULT');
    expect(h.log.getRun(THREAD, RUN)?.status).toBe('finished');
    expect(h.log.heldToolCallIds(THREAD).size).toBe(0);
    expect(counters).toEqual({ model: 0, tool: 0 });
  });

  it('H. R26a: closed text with no tool and no other family becomes RUN_ERROR, interrupted, never finished', async () => {
    const h = make();
    seedRun(h.log, {
      ...ids,
      start: runStarted([], [user('u1')], ids),
      events: [...textEvents('a1', true, 'a whole answer')],
    });
    const { result } = await recoverFresh(h);
    expect(result.recovered).toMatchObject([
      {
        kind: 'complete_text_no_terminal',
        appended: ['RUN_ERROR'],
        status: 'interrupted',
      },
    ]);
    expect(h.log.runEvents(THREAD, RUN).at(-1)!.event).toEqual(stockError);
    expect(h.log.getRun(THREAD, RUN)?.status).toBe('interrupted');
    expect(storedTypes(h)).not.toContain('RUN_FINISHED');
  });
});

describe('the open classes stay open (R26b, R22, R24)', () => {
  const dead: Array<{
    name: string;
    tools?: string[];
    events: BaseEvent[];
    kind: string;
  }> = [
    {
      name: 'open reasoning',
      events: reasoningEvents('z1', false),
      kind: 'unclassified_lifecycle',
    },
    {
      name: 'text mixed with reasoning (R26a is not generalized)',
      events: [...textEvents('a1', true), ...reasoningEvents('z1', true)],
      kind: 'unclassified_lifecycle',
    },
    {
      name: 'a state snapshot after closed text',
      events: [
        ...textEvents('a1', true),
        { type: 'STATE_SNAPSHOT', snapshot: { n: 1 } } as never,
      ],
      kind: 'unclassified_lifecycle',
    },
    {
      name: 'a pending client call beside a pending server call (R22)',
      tools: [CLIENT_TOOL],
      events: [
        ...callEvents('rv1', CLIENT_TOOL, 1),
        ...callEvents('c1', SERVER_TOOL, 1),
      ],
      kind: 'mixed_pending_tool_calls',
    },
    {
      name: 'open text beside a pending call (R24)',
      events: [...textEvents('a1', false), ...callEvents('c1', SERVER_TOOL, 1)],
      kind: 'open_text_with_pending_tool_call',
    },
  ];

  it.each(dead)(
    '$name: nothing is written, the run stays running and is reported',
    async (row) => {
      const h = make();
      seedRun(h.log, {
        ...ids,
        start: runStarted(row.tools ?? [], [user('u1')], ids),
        events: row.events,
      });
      const before = snapshotDatabase(h.throwaway.path);
      const { result } = await recoverFresh(h);
      expect(result.recovered).toEqual([]);
      expect(result.deferred).toMatchObject([
        { threadId: THREAD, runId: RUN, kind: row.kind, outcome: 'deferred' },
      ]);
      expect(h.log.getRun(THREAD, RUN)?.status).toBe('running');
      // The only difference is the derived view, never the events or the run.
      const strip = (snapshot: string) => {
        const parsed = JSON.parse(snapshot);
        delete parsed.conversation_messages;
        return JSON.stringify(parsed);
      };
      expect(strip(snapshotDatabase(h.throwaway.path))).toBe(strip(before));
    },
  );

  it('does not block the thread: a new run starts beside a deferred one, and ready() reports it again', async () => {
    const h = make();
    seedRun(h.log, {
      ...ids,
      start: runStarted([], [user('u1')], ids),
      events: reasoningEvents('z1', false),
    });
    const fresh = restartRunner(h);
    const events = await runToEnd(
      fresh.runner,
      new ScriptedAgent((input) => [
        ...textMessage('a2', 'ok'),
        finished(input),
      ]),
      runInput(THREAD, 'r2', [user('u2')]),
    );
    expect(typesOf(events).at(-1)).toBe('RUN_FINISHED');
    expect(h.log.getRun(THREAD, RUN)?.status).toBe('running');
    const again = await restartRunner(h).runner.ready();
    expect(again.deferred).toHaveLength(1);
  });
});

describe('R23: the browser can never widen its own authority', () => {
  const pending = (declared: string[], tool: string) => ({
    start: runStarted(declared, [user('u1')], ids),
    events: callEvents('c1', tool, 1),
  });
  const cases: Array<{
    name: string;
    declared: string[];
    tool: string;
    set: ReadonlySet<string>;
    client: boolean;
  }> = [
    {
      name: 'declared and in the server set',
      declared: [CLIENT_TOOL],
      tool: CLIENT_TOOL,
      set: CLIENT_EXECUTABLE,
      client: true,
    },
    {
      name: 'declared but not in the server set',
      declared: [CLIENT_TOOL],
      tool: CLIENT_TOOL,
      set: new Set(),
      client: false,
    },
    {
      name: 'in the server set but not declared',
      declared: [],
      tool: CLIENT_TOOL,
      set: CLIENT_EXECUTABLE,
      client: false,
    },
    {
      name: 'a hostile client declares a server tool',
      declared: [SERVER_TOOL],
      tool: SERVER_TOOL,
      set: CLIENT_EXECUTABLE,
      client: false,
    },
    {
      name: 'declared by the client, absent from the set, server named',
      declared: [SERVER_TOOL, CLIENT_TOOL],
      tool: SERVER_TOOL,
      set: CLIENT_EXECUTABLE,
      client: false,
    },
  ];

  it.each(cases)(
    '$name -> client-executed: $client',
    async ({ declared, tool, set, client }) => {
      const h = make();
      seedRun(h.log, { ...ids, ...pending(declared, tool) });
      await restartRunner(h, { clientExecutableToolNames: set }).runner.ready();
      const types = storedTypes(h);
      if (client) {
        expect(types.at(-1)).toBe('RUN_FINISHED');
        expect(types).not.toContain('TOOL_CALL_RESULT');
        expect(h.log.getRun(THREAD, RUN)?.status).toBe('finished');
      } else {
        expect(types.slice(-2)).toEqual(['TOOL_CALL_RESULT', 'RUN_ERROR']);
        expect(h.log.runEvents(THREAD, RUN).at(-2)!.event).toMatchObject({
          content: UNKNOWN_OUTCOME_CONTENT,
        });
        expect(h.log.getRun(THREAD, RUN)?.status).toBe('interrupted');
      }
    },
  );

  it('never embeds a tool name: the runner source names no tool', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(
      new URL('../src/server/durable-runner.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(
      /review_space_page|pageReviewTool|read_space_page/,
    );
  });
});

describe('recovery never repeats a model call, a tool or a side effect', () => {
  it('a run on a thread with a dead run recovers it first and executes only the new run', async () => {
    const h = make();
    seedRun(h.log, {
      ...ids,
      start: runStarted([], [user('u1')], ids),
      events: callEvents('c1', SERVER_TOOL, 1),
    });
    const { counters, agent } = never();
    const fresh = restartRunner(h);
    await runToEnd(fresh.runner, agent, runInput(THREAD, 'r2', [user('u2')]));
    // The one tool-counter tick is the new run's own step, not the dead call.
    expect(counters).toEqual({ model: 1, tool: 1 });
    expect(h.log.getRun(THREAD, RUN)?.status).toBe('interrupted');
    expect(
      h.log
        .runEvents(THREAD, RUN)
        .filter((s) => s.eventType === 'TOOL_CALL_RESULT'),
    ).toHaveLength(1);
  });

  it('replay of a recovered thread by a fresh process calls nothing and writes nothing', async () => {
    const h = make();
    const { counters } = never();
    seedRun(h.log, {
      ...ids,
      start: runStarted([], [user('u1')], ids),
      events: callEvents('c1', SERVER_TOOL, 1),
    });
    await recoverFresh(h);
    const before = snapshotDatabase(h.throwaway.path);
    const reader = restartRunner(h);
    const replay = await collect(reader.runner.connect({ threadId: THREAD }));
    expect(typesOf(replay).at(-1)).toBe('RUN_ERROR');
    expect(counters).toEqual({ model: 0, tool: 0 });
    expect(
      reader.log.appendCalls + reader.log.startCalls + reader.log.rebuildCalls,
    ).toBe(0);
    expect(snapshotDatabase(h.throwaway.path)).toBe(before);
  });

  it('is idempotent: a second ready() recovers nothing and writes nothing', async () => {
    const h = make();
    seedRun(h.log, {
      ...ids,
      start: runStarted([], [user('u1')], ids),
      events: textEvents('a1', false),
    });
    await recoverFresh(h);
    const before = snapshotDatabase(h.throwaway.path);
    const second = await recoverFresh(h);
    expect(second.result).toMatchObject({ recovered: [], rebuilt: 0 });
    expect(snapshotDatabase(h.throwaway.path)).toBe(before);
  });

  it('never touches a run this instance is driving', async () => {
    const h = make();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const agent = new ScriptedAgent((input) => [
      ...textMessage('a1', 'x'),
      () => hold,
      finished(input),
    ]);
    const events = collect(
      h.runner.run({
        threadId: THREAD,
        agent: Object.assign(agent, { agentId: 'dot-1', threadId: THREAD }),
        input: runInput(THREAD, RUN, [user('u1')]),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const result = await h.runner.ready();
    expect(result.recovered).toEqual([]);
    expect(result.deferred).toEqual([]);
    release();
    expect(typesOf(await events).at(-1)).toBe('RUN_FINISHED');
  });
});

describe('a run left hanging at a crash window', () => {
  // To a second runner on the same file the first runner's run is a dead run:
  // its model and its executor are still in this process, so any attempt by
  // recovery to drive them again would be counted.
  const windows: Array<{
    name: string;
    kind: string;
    waitFor: string;
    script: (
      executed: () => void,
    ) => ConstructorParameters<typeof ScriptedAgent>[0];
    toolExecutions: number;
  }> = [
    {
      name: 'RUN_STARTED only',
      kind: 'no_tool_lifecycle',
      waitFor: 'RUN_STARTED',
      script: () => () => [() => new Promise<void>(() => undefined)],
      toolExecutions: 0,
    },
    {
      name: 'open text',
      kind: 'open_text_message',
      waitFor: 'TEXT_MESSAGE_CONTENT',
      script: () => () => [
        { type: 'TEXT_MESSAGE_START', messageId: 'a1', role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: 'partial' },
        () => new Promise<void>(() => undefined),
      ],
      toolExecutions: 0,
    },
    {
      name: 'a server tool that ran, its result unrecorded',
      kind: 'server_unknown_outcome',
      waitFor: 'TOOL_CALL_END',
      script: (executed) => () => [
        ...toolCall('c1', SERVER_TOOL, 'a1'),
        executed,
        () => new Promise<void>(() => undefined),
      ],
      toolExecutions: 1,
    },
    {
      name: 'a server tool whose result is durable',
      kind: 'server_result_durable',
      waitFor: 'TOOL_CALL_RESULT',
      script: (executed) => () => [
        ...toolCall('c1', SERVER_TOOL, 'a1'),
        executed,
        toolResult('c1'),
        () => new Promise<void>(() => undefined),
      ],
      toolExecutions: 1,
    },
  ];

  it.each(windows)(
    '$name: recovery by another runner calls no model and executes no tool again',
    async ({ kind, waitFor, script, toolExecutions }) => {
      const h = make();
      let executed = 0;
      const original = new ScriptedAgent(
        script(() => {
          executed += 1;
        }),
      );
      const running = collect(
        startRun(h.runner, original, runInput(THREAD, RUN, [user('u1')])),
      );
      await until(
        () =>
          h.log
            .runEvents(THREAD, RUN)
            .some((stored) => stored.eventType === waitFor) &&
          executed === toolExecutions &&
          original.stats.emitted >= 1,
        'the run to reach its window',
      );
      const invocations = original.stats.invocations;
      const emitted = original.stats.emitted;
      const result = await restartRunner(h).runner.ready();
      expect(result.recovered).toMatchObject([{ kind, status: 'interrupted' }]);
      expect(original.stats.invocations).toBe(invocations);
      expect(original.stats.emitted).toBe(emitted);
      expect(executed).toBe(toolExecutions);
      expect(h.log.getRun(THREAD, RUN)?.status).toBe('interrupted');
      void running;
    },
  );
});

describe('R17: one server process owns the database (a deployment constraint, not a feature)', () => {
  it("does not recognise a second runner: it treats the first runner's live run as dead", async () => {
    const h = make();
    const stay = new Promise<void>(() => undefined);
    const first = new ScriptedAgent(() => [
      ...textMessage('a1', 'live'),
      () => stay,
    ]);
    void collect(
      startRun(h.runner, first, runInput(THREAD, RUN, [user('u1')])),
    );
    await until(() =>
      h.log
        .runEvents(THREAD, RUN)
        .some((s) => s.eventType === 'TEXT_MESSAGE_END'),
    );
    // Exclusion is process-local. A second instance on the same file has no
    // way to know this run is alive, so its ready() closes it.
    const second = await restartRunner(h).runner.ready();
    expect(second.recovered).toHaveLength(1);
    expect(h.log.getRun(THREAD, RUN)?.status).toBe('interrupted');
  });
});

describe('ready() writes', () => {
  it('a healthy restart makes no write at all', async () => {
    const h = make();
    await runToEnd(
      h.runner,
      new ScriptedAgent((input) => [
        ...textMessage('a1', 'x'),
        finished(input),
      ]),
      runInput(THREAD, RUN, [user('u1')]),
    );
    const before = snapshotDatabase(h.throwaway.path);
    const fresh = restartRunner(h);
    const changesBefore = (
      h.db.prepare('SELECT total_changes() AS n').get() as { n: number }
    ).n;
    const result = await fresh.runner.ready();
    const changesAfter = (
      h.db.prepare('SELECT total_changes() AS n').get() as { n: number }
    ).n;
    expect(result).toEqual({
      checked: 1,
      rebuilt: 0,
      recovered: [],
      deferred: [],
    });
    expect(changesAfter - changesBefore).toBe(0);
    expect(
      fresh.log.appendCalls + fresh.log.startCalls + fresh.log.rebuildCalls,
    ).toBe(0);
    expect(snapshotDatabase(h.throwaway.path)).toBe(before);
  });

  it('repairs a missing view with exactly one view write and no event or run write', async () => {
    const h = make();
    await runToEnd(
      h.runner,
      new ScriptedAgent((input) => [
        ...textMessage('a1', 'x'),
        finished(input),
      ]),
      runInput(THREAD, RUN, [user('u1')]),
    );
    h.db.exec('DELETE FROM conversation_messages');
    const eventsBefore = h.db
      .prepare('SELECT COUNT(*) AS n FROM conversation_events')
      .get();
    const fresh = restartRunner(h);
    const result = await fresh.runner.ready();
    expect(result).toMatchObject({ checked: 1, rebuilt: 1, recovered: [] });
    expect(fresh.log.rebuildCalls).toBe(1);
    expect(fresh.log.appendCalls).toBe(0);
    expect(
      h.db.prepare('SELECT COUNT(*) AS n FROM conversation_events').get(),
    ).toEqual(eventsBefore);
    expect(
      h.db.prepare('SELECT COUNT(*) AS n FROM conversation_messages').get(),
    ).toEqual({ n: 1 });
  });

  it('recovers a dead run in one append and one view write', async () => {
    const h = make();
    seedRun(h.log, {
      ...ids,
      start: runStarted([], [user('u1')], ids),
      events: textEvents('a1', false),
    });
    const fresh = restartRunner(h);
    const result = await fresh.runner.ready();
    expect(result).toMatchObject({ checked: 1, rebuilt: 1 });
    expect(fresh.log.appendCalls).toBe(1);
    expect(fresh.log.rebuildCalls).toBe(1);
    expect(fresh.log.startCalls).toBe(0);
  });
});
