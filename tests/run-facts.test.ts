import type { BaseEvent } from '@ag-ui/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RunFacts,
  RunFactsError,
  type RunFactsErrorCode,
  type RunnerView,
} from '../src/server/run-facts';
import { ConversationLog } from '../src/server/conversation-log';
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
  AGENT_ID,
  collect,
  createHarness,
  prime,
  runInput,
  seedRun,
  until,
  type Harness,
} from './helpers/runner-harness';
import { recordStatements } from './helpers/statement-recorder';
import {
  HANG,
  ScriptedAgent,
  createGate,
  finished,
  textMessage,
  toolCall,
  toolResult,
} from './helpers/scripted-agent';

// C4c: the read-only durable facts (docs/LOCAL_FIRST_C4C_READONLY_AND_ADMISSION_BOUNDARY.md).
// Everything runs offline over throwaway databases with the real
// ConversationLog and DurableAgentRunner and a scripted producer.
const T = 'thread-1';
const ev = (value: Record<string, unknown>) => value as unknown as BaseEvent;

const harnesses: Harness[] = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.cleanup();
});
function make(
  options: Parameters<typeof createHarness>[0] = {},
): Harness & { facts: RunFacts } {
  const h = createHarness(options);
  harnesses.push(h);
  return Object.assign(h, { facts: h.runner.facts });
}

// What a process leaves behind when it dies mid-run.
function seed(
  h: Harness,
  runId: string,
  events: BaseEvent[],
  options: { declared?: string[]; threadId?: string; agentId?: string } = {},
) {
  const threadId = options.threadId ?? T;
  seedRun(h.log, {
    threadId,
    runId,
    agentId: options.agentId ?? AGENT_ID,
    start: runStarted(options.declared ?? [], [], { threadId, runId }),
    events,
  });
}

const codeOf = (work: () => unknown): string => {
  try {
    work();
    return 'NO_ERROR';
  } catch (error) {
    return error instanceof RunFactsError
      ? error.code
      : `OTHER:${(error as Error).name}`;
  }
};

async function completeRun(
  h: Harness,
  runId: string,
  script: ConstructorParameters<typeof ScriptedAgent>[0],
  threadId = T,
) {
  const input = runInput(threadId, runId, [user(`u-${runId}`, 'go')]);
  return collect(
    h.runner.run({
      threadId,
      agent: prime(new ScriptedAgent(script), input),
      input,
    }),
  );
}

const ask = (h: { facts: RunFacts }, runId: string, threadId = T) => ({
  attempt: () => h.facts.attemptFacts({ threadId, runId, agentId: AGENT_ID }),
  terminal: () =>
    h.facts.terminalResult({ threadId, runId, agentId: AGENT_ID }),
});

// ------------------------------------------------------------------ surface

describe('the surface', () => {
  it('is a read-only property of the runner with exactly the five accessors', () => {
    const h = make();
    expect(h.runner.facts).toBeInstanceOf(RunFacts);
    const methods = Object.getOwnPropertyNames(RunFacts.prototype)
      .filter((name) => name !== 'constructor')
      .sort();
    expect(methods).toEqual([
      'activeRuns',
      'attemptFacts',
      'terminalResult',
      'threadState',
      'unresolvedRuns',
    ]);
  });

  it('is a stable object: reading it twice returns the same instance', () => {
    const h = make();
    expect(h.runner.facts).toBe(h.runner.facts);
  });
});

// -------------------------------------------------------------- threadState

describe('threadState', () => {
  it('is idle and creates no table when the conversation schema does not exist', () => {
    const h = make();
    const tables = () =>
      (
        h.db
          .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'")
          .get() as { n: number }
      ).n;
    const before = tables();
    const state = h.facts.threadState(T, AGENT_ID);
    expect(state).toMatchObject({
      threadId: T,
      state: 'idle',
      quiescent: true,
      schema: 'absent',
      runCount: 0,
      active: null,
      unresolved: [],
      maxEventId: 0,
    });
    expect(tables()).toBe(before);
    expect(before).toBe(0);
  });

  it('is idle for an unknown thread and for a thread whose runs all ended', async () => {
    const h = make();
    h.log.ensureSchema();
    expect(h.facts.threadState('never-seen', AGENT_ID)).toMatchObject({
      state: 'idle',
      runCount: 0,
      schema: 'present',
    });
    await completeRun(h, 'r1', (i) => [...textMessage('a1', 'x'), finished(i)]);
    const state = h.facts.threadState(T, AGENT_ID);
    expect(state).toMatchObject({
      state: 'idle',
      quiescent: true,
      runCount: 1,
      active: null,
      unresolved: [],
    });
    expect(state.maxEventId).toBeGreaterThan(0);
  });

  it('reports a run this process drives as running, not as unresolved', async () => {
    const h = make();
    const gate = createGate();
    const agent = new ScriptedAgent((i) => [
      ...textMessage('a1', 'x'),
      gate,
      finished(i),
    ]);
    const input = runInput(T, 'r-live', [user('u1')]);
    const sub = h.runner
      .run({ threadId: T, agent: prime(agent, input), input })
      .subscribe({ error: () => undefined });
    await until(() => agent.stats.emitted >= 4, 'text emitted');
    const state = h.facts.threadState(T, AGENT_ID);
    expect(state.state).toBe('running');
    expect(state.quiescent).toBe(false);
    expect(state.active).toMatchObject({
      runId: 'r-live',
      phase: 'running',
      failure: false,
    });
    expect(state.unresolved).toEqual([]);
    expect(await h.runner.isRunning({ threadId: T } as never)).toBe(true);
    gate.open();
    await until(() => h.log.getRun(T, 'r-live')?.status === 'finished');
    sub.unsubscribe();
  });

  it('distinguishes stopping (isRunning is already false, the thread is still reserved)', async () => {
    const h = make();
    const gate = createGate();
    const agent = new ScriptedAgent((i) => [
      ...toolCall('c1', SERVER_TOOL, 'a1'),
      gate,
      finished(i),
    ]);
    const input = runInput(T, 'r-live', [user('u1')]);
    const sub = h.runner
      .run({ threadId: T, agent: prime(agent, input), input })
      .subscribe({ error: () => undefined });
    await until(() => agent.stats.emitted >= 4, 'END emitted');
    expect(await h.runner.stop({ threadId: T, runId: 'r-live' } as never)).toBe(
      true,
    );
    const state = h.facts.threadState(T, AGENT_ID);
    expect(state.state).toBe('stopping');
    expect(state.quiescent).toBe(false);
    expect(await h.runner.isRunning({ threadId: T } as never)).toBe(false);
    gate.open();
    await until(() => h.log.getRun(T, 'r-live')?.status !== 'running');
    sub.unsubscribe();
    await until(() => h.facts.threadState(T, AGENT_ID).state === 'idle');
  });

  it('distinguishes finishing: the terminal event is committed, the thread is still reserved', async () => {
    const h = make();
    let release!: () => void;
    h.log.rebuildGate = new Promise<void>((resolve) => (release = resolve));
    const done = completeRun(h, 'r1', (i) => [
      ...textMessage('a1', 'x'),
      finished(i),
    ]);
    await until(() => h.log.getRun(T, 'r1')?.status === 'finished');
    await until(() => h.log.rebuildCalls >= 1, 'view rebuild started');
    const state = h.facts.threadState(T, AGENT_ID);
    expect(state.state).toBe('finishing');
    expect(state.quiescent).toBe(false);
    expect(state.active?.phase).toBe('finishing');
    release();
    await done;
    await until(() => h.facts.threadState(T, AGENT_ID).state === 'idle');
  });

  it('reports a dead run as unresolved, never as idle, before and after ready()', async () => {
    const h = make();
    seed(h, 'r-dead', reasoningEvents('m1', false));
    const before = h.facts.threadState(T, AGENT_ID);
    expect(before).toMatchObject({
      state: 'unresolved',
      quiescent: false,
      active: null,
    });
    expect(before.unresolved).toHaveLength(1);
    expect(before.unresolved[0]).toMatchObject({
      runId: 'r-dead',
      disposition: 'deferred',
      openRule: 'R26b',
      afterRecovery: 'remains_open',
      liveness: 'not_active_in_this_process',
    });
    await h.runner.ready();
    expect(h.facts.threadState(T, AGENT_ID).state).toBe('unresolved');
    expect(h.log.getRun(T, 'r-dead')?.status).toBe('running');
  });

  it('shows a recoverable dead run as unresolved until ready() closes it, and then as idle', async () => {
    const h = make();
    seed(h, 'r-dead', callEvents('c1', SERVER_TOOL, 1));
    const before = h.facts.threadState(T, AGENT_ID);
    expect(before.state).toBe('unresolved');
    expect(before.unresolved[0]).toMatchObject({
      disposition: 'recoverable',
      kind: 'server_unknown_outcome',
      afterRecovery: 'closed_by_recovery',
      pendingServerCalls: 1,
    });
    await h.runner.ready();
    expect(h.facts.threadState(T, AGENT_ID)).toMatchObject({
      state: 'idle',
      unresolved: [],
    });
  });

  it('keeps threads apart', async () => {
    const h = make();
    seed(h, 'r-dead', reasoningEvents('m1', false), { threadId: 'other' });
    expect(h.facts.threadState(T, AGENT_ID).state).toBe('idle');
    expect(h.facts.threadState('other', AGENT_ID).state).toBe('unresolved');
  });

  it('returns a fresh object each time', () => {
    const h = make();
    h.log.ensureSchema();
    const a = h.facts.threadState(T, AGENT_ID);
    (a as { state: string }).state = 'running';
    a.unresolved.push({} as never);
    expect(h.facts.threadState(T, AGENT_ID)).toMatchObject({
      state: 'idle',
      unresolved: [],
    });
  });
});

// --------------------------------------------------------------- activeRuns

describe('activeRuns', () => {
  it('lists only the runs this process drives, with no database read', async () => {
    const h = make();
    h.log.ensureSchema();
    seed(h, 'r-dead', reasoningEvents('m1', false), { threadId: 'dead' });
    expect(h.facts.activeRuns({ all: true })).toEqual([]);
    const gate = createGate();
    const agent = new ScriptedAgent((i) => [
      ...textMessage('a1', 'x'),
      gate,
      finished(i),
    ]);
    const input = runInput(T, 'r-live', [user('u1')]);
    const sub = h.runner
      .run({ threadId: T, agent: prime(agent, input), input })
      .subscribe({ error: () => undefined });
    await until(() => agent.stats.emitted >= 4);
    const recorder = recordStatements(h.db);
    const listed = h.facts.activeRuns({ all: true });
    expect(recorder.executed).toEqual([]);
    recorder.stop();
    expect(listed).toEqual([
      expect.objectContaining({
        threadId: T,
        runId: 'r-live',
        agentId: AGENT_ID,
        phase: 'running',
      }),
    ]);
    gate.open();
    await until(() => h.log.getRun(T, 'r-live')?.status === 'finished');
    sub.unsubscribe();
    await until(() => h.facts.activeRuns({ all: true }).length === 0);
  });

  it('with an agent scope lists only threads that agent owns', async () => {
    const h = make();
    // Ownership is by thread: `t-a` belongs to AGENT_ID, `t-b` does not.
    const owned = (threadId: string, agentId: string) =>
      agentId === AGENT_ID && threadId === 't-a';
    const view: RunnerView = {
      active: new Map([
        [
          't-a',
          {
            runId: 'r1',
            agent: { agentId: AGENT_ID },
            events: [],
            stopRequested: false,
            finalized: false,
          },
        ],
        [
          't-b',
          {
            runId: 'r2',
            agent: { agentId: 'someone-else' },
            events: [],
            stopRequested: false,
            finalized: false,
          },
        ],
      ]),
      ownsThread: owned,
      clientExecutableToolNames: CLIENT_EXECUTABLE,
    };
    const facts = new RunFacts(h.log, view);
    expect(
      facts.activeRuns({ agentId: AGENT_ID }).map((run) => run.threadId),
    ).toEqual(['t-a']);
    expect(facts.activeRuns({ all: true }).map((run) => run.threadId)).toEqual([
      't-a',
      't-b',
    ]);
  });
});

// ------------------------------------------------------------- attemptFacts

describe('attemptFacts: tool lifecycles', () => {
  const tool = (h: { facts: RunFacts }, runId: string) =>
    ask(h, runId).attempt().toolCalls;

  it('proves "no executor entry" only for a server call without END in a run with no terminal event', () => {
    const h = make();
    seed(h, 'r-args', callEvents('c1', SERVER_TOOL, 0));
    const facts = ask(h, 'r-args').attempt();
    expect(facts.toolCalls).toEqual([
      expect.objectContaining({
        toolCallId: 'c1',
        side: 'server',
        phase: 'args_open',
        executorEntry: 'not_possible',
        resultProvenance: 'none',
        outcomeKnown: false,
      }),
    ]);
    expect(facts.recovery).toMatchObject({
      kind: 'tool_args_incomplete',
      deferred: false,
    });
    expect(facts.lifecycle).toBe('nonterminal_not_active');
  });

  it('treats END without a result as "an executor may have entered", never as not dispatched', () => {
    const h = make();
    seed(h, 'r-end', callEvents('c1', SERVER_TOOL, 1));
    expect(tool(h, 'r-end')).toEqual([
      expect.objectContaining({
        phase: 'args_complete',
        executorEntry: 'possible',
        resultProvenance: 'none',
        outcomeKnown: false,
      }),
    ]);
  });

  it('records a durable result as a known outcome', () => {
    const h = make();
    seed(h, 'r-res', callEvents('c1', SERVER_TOOL, 2));
    expect(tool(h, 'r-res')).toEqual([
      expect.objectContaining({
        phase: 'result_recorded',
        executorEntry: 'possible',
        resultProvenance: 'recorded',
        outcomeKnown: true,
      }),
    ]);
  });

  it('keeps an interrupted server call as unknown-outcome, and the stock closer as no proof either way', async () => {
    const h = make();
    // r-unknown: a real stop while the executor may have entered.
    const gate = createGate();
    const agent = new ScriptedAgent((i) => [
      ...toolCall('c1', SERVER_TOOL, 'a1'),
      gate,
      finished(i),
    ]);
    const input = runInput(T, 'r-unknown', [user('u1')]);
    const sub = h.runner
      .run({ threadId: T, agent: prime(agent, input), input })
      .subscribe({ error: () => undefined });
    await until(() => agent.stats.emitted >= 4);
    await h.runner.stop({ threadId: T, runId: 'r-unknown' } as never);
    gate.open();
    await until(() => h.log.getRun(T, 'r-unknown')?.status !== 'running');
    sub.unsubscribe();
    await until(() => h.facts.threadState(T, AGENT_ID).state === 'idle');
    expect(tool(h, 'r-unknown')).toEqual([
      expect.objectContaining({
        phase: 'result_recorded',
        executorEntry: 'possible',
        resultProvenance: 'unknown_outcome',
        outcomeKnown: false,
      }),
    ]);

    // r-closer: a dead run whose incomplete call is closed by recovery with the
    // stock finalizer.
    seed(h, 'r-closer', callEvents('c2', SERVER_TOOL, 0), {
      threadId: 'other',
    });
    const before = ask(h, 'r-closer', 'other').attempt();
    expect(before.toolCalls[0].executorEntry).toBe('not_possible');
    await h.runner.ready();
    const after = ask(h, 'r-closer', 'other').attempt();
    expect(after.toolCalls[0]).toMatchObject({
      resultProvenance: 'synthetic_closer',
      executorEntry: 'possible',
      outcomeKnown: false,
    });
    expect(after.recovery).toBeNull();
  });

  it('does not let a closer-shaped but different payload pass as a closer', () => {
    const h = make();
    seed(h, 'r-look', [
      ...callEvents('c1', SERVER_TOOL, 1),
      ev({
        type: 'TOOL_CALL_RESULT',
        toolCallId: 'c1',
        messageId: 'c1-result',
        role: 'tool',
        content: JSON.stringify({
          status: 'stopped',
          reason: 'something_else',
        }),
      }),
      runFinished(T, 'r-look'),
    ]);
    expect(tool(h, 'r-look')[0]).toMatchObject({
      resultProvenance: 'recorded',
      outcomeKnown: true,
    });
  });

  it('keeps per-call facts for a two-tool attempt (first recorded, second unknown)', async () => {
    const h = make();
    const agent = new ScriptedAgent(() => [
      ...toolCall('c1', SERVER_TOOL, 'a1'),
      toolResult('c1', '{"effect":"committed"}'),
      ...toolCall('c2', SERVER_TOOL, 'a1'),
      HANG,
    ]);
    const input = runInput(T, 'r-two', [user('u1')]);
    const sub = h.runner
      .run({ threadId: T, agent: prime(agent, input), input })
      .subscribe({ error: () => undefined });
    await until(() => agent.stats.emitted >= 8, 'second END');
    await h.runner.stop({ threadId: T, runId: 'r-two' } as never);
    await until(() => h.log.getRun(T, 'r-two')?.status !== 'running');
    sub.unsubscribe();
    const facts = ask(h, 'r-two').attempt();
    expect(facts.toolCalls.map((call) => call.outcomeKnown)).toEqual([
      true,
      false,
    ]);
    expect(facts.toolCalls.map((call) => call.resultProvenance)).toEqual([
      'recorded',
      'unknown_outcome',
    ]);
    expect(facts.summary).toMatchObject({
      serverCalls: 2,
      serverExecutorPossible: 2,
      serverOutcomesKnown: 1,
      serverOutcomesUnknown: 1,
    });
  });

  it('marks client-executed calls as not applicable to a server executor', () => {
    const h = make();
    seed(h, 'r-client', callEvents('c1', CLIENT_TOOL, 1), {
      declared: [CLIENT_TOOL],
    });
    const facts = ask(h, 'r-client').attempt();
    expect(facts.toolCalls[0]).toMatchObject({
      side: 'client',
      executorEntry: 'not_applicable_client',
    });
    expect(facts.summary).toMatchObject({ clientCalls: 1, clientPending: 1 });
  });

  it('does not treat an undeclared tool name as client-executed', () => {
    const h = make();
    // The server allows the tool but the client did not declare it (DEC-19).
    seed(h, 'r-undeclared', callEvents('c1', CLIENT_TOOL, 1));
    expect(ask(h, 'r-undeclared').attempt().toolCalls[0].side).toBe('server');
  });

  it('inspects every call of the attempt, including calls after a recorded one', () => {
    const h = make();
    seed(h, 'r-many', [
      ...callEvents('c1', SERVER_TOOL, 2),
      ...callEvents('c2', SERVER_TOOL, 1, 'a2'),
      ...callEvents('c3', SERVER_TOOL, 0, 'a3'),
    ]);
    const facts = ask(h, 'r-many').attempt();
    expect(
      facts.toolCalls.map((call) => [
        call.toolCallId,
        call.phase,
        call.executorEntry,
      ]),
    ).toEqual([
      ['c1', 'result_recorded', 'possible'],
      ['c2', 'args_complete', 'possible'],
      ['c3', 'args_open', 'not_possible'],
    ]);
  });
});

describe('attemptFacts: shape and non-claims', () => {
  it('carries no retry, safe or eligibility field and keeps provider-request evidence unknown', () => {
    const h = make();
    seed(h, 'r1', [...callEvents('c1', SERVER_TOOL, 1)]);
    const facts = ask(h, 'r1').attempt();
    expect(Object.keys(facts).sort()).toEqual(
      [
        'agentId',
        'eventCount',
        'evidence',
        'finishedAt',
        'lastEventId',
        'lifecycle',
        'otherFamilies',
        'reasoning',
        'recovery',
        'runId',
        'seq',
        'startedAt',
        'status',
        'summary',
        'terminal',
        'text',
        'threadId',
        'toolCalls',
      ].sort(),
    );
    expect(Object.keys(facts.toolCalls[0]).sort()).toEqual(
      [
        'executorEntry',
        'outcomeKnown',
        'phase',
        'resultProvenance',
        'side',
        'toolCallId',
        'toolName',
      ].sort(),
    );
    expect(facts.evidence).toEqual({
      providerRequest: 'unknown',
      fenceAssumed: true,
    });
    expect(JSON.stringify(facts)).not.toMatch(/retry|retriable|safe|eligible/i);
  });

  it('reports text, reasoning and other event families', () => {
    const h = make();
    seed(h, 'r1', [
      ...textEvents('a1', true, 'done'),
      ...textEvents('a2', false, 'part'),
      ...reasoningEvents('m1', false),
      ev({ type: 'STATE_SNAPSHOT', snapshot: { k: 1 } }),
      ev({ type: 'CUSTOM', name: 'x', value: 1 }),
      ev({ type: 'SOME_FUTURE_EVENT' }),
    ]);
    const facts = ask(h, 'r1').attempt();
    expect(facts.text).toEqual({ opened: 2, open: 1, hasContent: true });
    expect(facts.reasoning).toEqual({ opened: 1, open: 1 });
    expect(facts.otherFamilies).toEqual([
      'CUSTOM',
      'SOME_FUTURE_EVENT',
      'STATE_SNAPSHOT',
    ]);
  });

  it('reports the terminal event of an ended run, and no recovery class for it', async () => {
    const h = make();
    await completeRun(h, 'r1', () => [
      { type: 'RUN_ERROR', message: 'nope', code: 'PROVIDER_ERROR' },
    ]);
    const facts = ask(h, 'r1').attempt();
    expect(facts.status).toBe('error');
    expect(facts.lifecycle).toBe('terminal');
    expect(facts.terminal).toEqual({
      eventType: 'RUN_ERROR',
      code: 'PROVIDER_ERROR',
    });
    expect(facts.recovery).toBeNull();
  });

  it('reports a run this process drives as active_in_memory', async () => {
    const h = make();
    const gate = createGate();
    const agent = new ScriptedAgent((i) => [
      ...toolCall('c1', SERVER_TOOL, 'a1'),
      gate,
      finished(i),
    ]);
    const input = runInput(T, 'r-live', [user('u1')]);
    const sub = h.runner
      .run({ threadId: T, agent: prime(agent, input), input })
      .subscribe({ error: () => undefined });
    await until(() => agent.stats.emitted >= 4);
    const facts = ask(h, 'r-live').attempt();
    expect(facts.lifecycle).toBe('active_in_memory');
    expect(facts.toolCalls[0]).toMatchObject({
      phase: 'args_complete',
      executorEntry: 'possible',
      outcomeKnown: false,
    });
    gate.open();
    await until(() => h.log.getRun(T, 'r-live')?.status === 'finished');
    sub.unsubscribe();
  });
});

describe('attemptFacts: R22, R24 and R26b are represented, not resolved', () => {
  it('R22: a pending client call and a pending server call', async () => {
    const h = make();
    seed(
      h,
      'r22',
      [
        ...callEvents('c1', SERVER_TOOL, 1),
        ...callEvents('c2', CLIENT_TOOL, 1, 'a2'),
      ],
      { declared: [CLIENT_TOOL] },
    );
    const facts = ask(h, 'r22').attempt();
    expect(facts.recovery).toEqual({
      kind: 'mixed_pending_tool_calls',
      deferred: true,
      openRule: 'R22',
    });
    expect(facts.summary).toMatchObject({ serverPending: 1, clientPending: 1 });
    await h.runner.ready();
    // ready() leaves it exactly as it was.
    expect(h.log.getRun(T, 'r22')?.status).toBe('running');
    expect(ask(h, 'r22').attempt().eventCount).toBe(facts.eventCount);
  });

  it('R24: open text beside a pending server call', () => {
    const h = make();
    seed(h, 'r24', [
      ...textEvents('a1', false, 'part'),
      ...callEvents('c1', SERVER_TOOL, 1, 'a2'),
    ]);
    const facts = ask(h, 'r24').attempt();
    expect(facts.recovery).toMatchObject({
      kind: 'open_text_with_pending_tool_call',
      deferred: true,
      openRule: 'R24',
    });
    expect(facts.text.open).toBe(1);
  });

  it('R26b: open reasoning, and a state snapshot after closed text', () => {
    const h = make();
    seed(h, 'r26b-reasoning', reasoningEvents('m1', false));
    seed(
      h,
      'r26b-state',
      [
        ...textEvents('a1', true, 'x'),
        ev({ type: 'STATE_SNAPSHOT', snapshot: { k: 1 } }),
      ],
      { threadId: 'other' },
    );
    expect(ask(h, 'r26b-reasoning').attempt().recovery).toEqual({
      kind: 'unclassified_lifecycle',
      deferred: true,
      openRule: 'R26b',
    });
    expect(ask(h, 'r26b-state', 'other').attempt().recovery).toMatchObject({
      deferred: true,
      openRule: 'R26b',
    });
  });

  it('all three are listed as unresolved, deferred and remaining open after recovery', async () => {
    const h = make();
    seed(
      h,
      'r22',
      [
        ...callEvents('c1', SERVER_TOOL, 1),
        ...callEvents('c2', CLIENT_TOOL, 1, 'a2'),
      ],
      { declared: [CLIENT_TOOL] },
    );
    seed(
      h,
      'r24',
      [
        ...textEvents('a1', false, 'p'),
        ...callEvents('c1', SERVER_TOOL, 1, 'a2'),
      ],
      { threadId: 'thread-r24' },
    );
    seed(h, 'r26b', reasoningEvents('m1', false), { threadId: 'thread-r26b' });
    const listed = h.facts.unresolvedRuns({ all: true });
    expect(
      listed.map((run) => [run.runId, run.openRule, run.afterRecovery]),
    ).toEqual([
      ['r22', 'R22', 'remains_open'],
      ['r24', 'R24', 'remains_open'],
      ['r26b', 'R26b', 'remains_open'],
    ]);
    await h.runner.ready();
    await h.runner.ready();
    expect(h.facts.unresolvedRuns({ all: true })).toHaveLength(3);
    for (const run of listed)
      expect(h.log.getRun(run.threadId, run.runId)?.status).toBe('running');
  });
});

// ----------------------------------------------------------- terminalResult

describe('terminalResult', () => {
  it('success: the run text of a finished run', async () => {
    const h = make();
    await completeRun(h, 'r1', (i) => [
      ...textMessage('a1', 'the answer'),
      finished(i),
    ]);
    expect(ask(h, 'r1').terminal()).toEqual({
      available: true,
      threadId: T,
      runId: 'r1',
      status: 'finished',
      outcome: 'success',
      text: 'the answer',
      threadReserved: false,
      unknownOutcomeCalls: 0,
    });
  });

  it('several text messages: the last assistant message, as currentTurnText takes it', async () => {
    const h = make();
    await completeRun(h, 'r1', (i) => [
      ...textMessage('a1', 'first'),
      ...textMessage('a2', 'second'),
      finished(i),
    ]);
    expect(ask(h, 'r1').terminal()).toMatchObject({
      outcome: 'success',
      text: 'second',
    });
  });

  it('finished without text: no text, and never the previous run text', async () => {
    const h = make();
    await completeRun(h, 'r1', (i) => [
      ...textMessage('a1', 'earlier'),
      finished(i),
    ]);
    await completeRun(h, 'r2', (i) => [finished(i)]);
    const result = ask(h, 'r2').terminal();
    expect(result).toMatchObject({
      available: true,
      outcome: 'finished_without_text',
    });
    expect(result).not.toHaveProperty('text');
  });

  it('a blank answer, or a final message that only carries a tool call, is no text', async () => {
    const h = make();
    await completeRun(h, 'blank', (i) => [
      ...textMessage('a1', 'real'),
      ...textMessage('a2', '   '),
      finished(i),
    ]);
    expect(ask(h, 'blank').terminal()).toMatchObject({
      outcome: 'finished_without_text',
    });
    await completeRun(h, 'tool-last', (i) => [
      ...textMessage('a3', 'real'),
      ...toolCall('c1', SERVER_TOOL, 'a4'),
      toolResult('c1'),
      finished(i),
    ]);
    expect(ask(h, 'tool-last').terminal()).toMatchObject({
      outcome: 'finished_without_text',
    });
  });

  it('a stopped run: stopped, with what was produced and the unknown calls counted', async () => {
    const h = make();
    const gate = createGate();
    const agent = new ScriptedAgent((i) => [
      ...textMessage('a1', 'partial'),
      ...toolCall('c1', SERVER_TOOL, 'a2'),
      gate,
      finished(i),
    ]);
    const input = runInput(T, 'r-stop', [user('u1')]);
    const sub = h.runner
      .run({ threadId: T, agent: prime(agent, input), input })
      .subscribe({ error: () => undefined });
    await until(() => agent.stats.emitted >= 7);
    await h.runner.stop({ threadId: T, runId: 'r-stop' } as never);
    gate.open();
    await until(() => h.log.getRun(T, 'r-stop')?.status !== 'running');
    sub.unsubscribe();
    const result = ask(h, 'r-stop').terminal();
    expect(result).toMatchObject({
      available: true,
      status: 'stopped',
      outcome: 'stopped',
      unknownOutcomeCalls: 1,
    });
    // The last assistant message is the tool-call parent: no partial text from
    // an earlier message is substituted.
    expect(result).not.toHaveProperty('text');
    expect(result).not.toHaveProperty('partialText');
  });

  it('a stopped run keeps the partial text when no later message exists', async () => {
    const h = make();
    const agent = new ScriptedAgent(() => [...textMessage('a1', 'half'), HANG]);
    const input = runInput(T, 'r-stop', [user('u1')]);
    const sub = h.runner
      .run({ threadId: T, agent: prime(agent, input), input })
      .subscribe({ error: () => undefined });
    await until(() => agent.stats.emitted >= 4);
    await h.runner.stop({ threadId: T, runId: 'r-stop' } as never);
    await until(() => h.log.getRun(T, 'r-stop')?.status !== 'running');
    sub.unsubscribe();
    expect(ask(h, 'r-stop').terminal()).toMatchObject({
      outcome: 'stopped',
      partialText: 'half',
    });
  });

  it('a durable RUN_ERROR: failed, with the code and message, never success', async () => {
    const h = make();
    await completeRun(h, 'r1', () => [
      {
        type: 'RUN_ERROR',
        message: 'provider said no',
        code: 'PROVIDER_ERROR',
      },
    ]);
    const result = ask(h, 'r1').terminal();
    expect(result).toMatchObject({
      available: true,
      status: 'error',
      outcome: 'failed',
      error: { code: 'PROVIDER_ERROR', message: 'provider said no' },
    });
    expect(result).not.toHaveProperty('text');
  });

  it('interrupted by recovery: its own outcome, never success', async () => {
    const h = make();
    seed(h, 'r-dead', textEvents('a1', true, 'looked complete'));
    expect(ask(h, 'r-dead').terminal()).toMatchObject({
      available: false,
      reason: 'run_not_terminal',
    });
    await h.runner.ready();
    const result = ask(h, 'r-dead').terminal();
    expect(result).toMatchObject({
      available: true,
      status: 'interrupted',
      outcome: 'interrupted_by_recovery',
    });
    expect(result).not.toHaveProperty('text');
  });

  it('missing terminal evidence is not an outcome: a running run is unavailable', async () => {
    const h = make();
    seed(h, 'r-open', textEvents('a1', true, 'looks done'));
    expect(ask(h, 'r-open').terminal()).toEqual({
      available: false,
      threadId: T,
      runId: 'r-open',
      reason: 'run_not_terminal',
    });
  });

  it('a run row that says finished without a terminal event is inconsistent, not a success', () => {
    const h = make();
    seed(h, 'r-bad', textEvents('a1', true, 'x'));
    h.db
      .prepare(
        "UPDATE conversation_runs SET status='finished', finishedAt=1 WHERE runId='r-bad'",
      )
      .run();
    expect(codeOf(() => ask(h, 'r-bad').terminal())).toBe(
      'INCONSISTENT_DURABLE_STATE',
    );
    try {
      ask(h, 'r-bad').terminal();
    } catch (error) {
      expect((error as RunFactsError).reasons).toContain(
        'status_without_terminal',
      );
    }
  });

  it('persisted but not yet finished: the committed terminal is read, and the thread is reported reserved', async () => {
    const h = make();
    let release!: () => void;
    h.log.rebuildGate = new Promise<void>((resolve) => (release = resolve));
    const done = completeRun(h, 'r1', (i) => [
      ...textMessage('a1', 'persisted answer'),
      finished(i),
    ]);
    await until(() => h.log.getRun(T, 'r1')?.status === 'finished');
    await until(() => h.log.rebuildCalls >= 1);
    expect(ask(h, 'r1').terminal()).toMatchObject({
      available: true,
      outcome: 'success',
      text: 'persisted answer',
      threadReserved: true,
    });
    release();
    await done;
    await until(
      () =>
        !(ask(h, 'r1').terminal() as { threadReserved: boolean })
          .threadReserved,
    );
  });

  it('reports a live run as unavailable', async () => {
    const h = make();
    const agent = new ScriptedAgent(() => [...textMessage('a1', 'x'), HANG]);
    const input = runInput(T, 'r-live', [user('u1')]);
    const sub = h.runner
      .run({ threadId: T, agent: prime(agent, input), input })
      .subscribe({ error: () => undefined });
    await until(() => agent.stats.emitted >= 4);
    expect(ask(h, 'r-live').terminal()).toMatchObject({
      available: false,
      reason: 'run_active_in_memory',
    });
    await h.runner.stop({ threadId: T, runId: 'r-live' } as never);
    await until(() => h.log.getRun(T, 'r-live')?.status !== 'running');
    sub.unsubscribe();
  });

  it('never reads the derived message view: a stale or forged view changes nothing', async () => {
    const h = make();
    await completeRun(h, 'r1', (i) => [
      ...textMessage('a1', 'real'),
      finished(i),
    ]);
    const before = JSON.stringify([
      h.facts.threadState(T, AGENT_ID),
      ask(h, 'r1').attempt(),
      ask(h, 'r1').terminal(),
    ]);
    h.db
      .prepare(
        'UPDATE conversation_messages SET messagesJson = ?, lastEventId = 0 WHERE threadId = ?',
      )
      .run(
        JSON.stringify([{ id: 'zz', role: 'assistant', content: 'FORGED' }]),
        T,
      );
    const after = JSON.stringify([
      h.facts.threadState(T, AGENT_ID),
      ask(h, 'r1').attempt(),
      ask(h, 'r1').terminal(),
    ]);
    expect(after).toBe(before);
    expect(after).not.toContain('FORGED');
  });
});

// -------------------------------------------------------------- unresolvedRuns

describe('unresolvedRuns', () => {
  it('lists the persisted nonterminal runs this process does not drive, with stable reasons', () => {
    const h = make();
    seed(h, 'r-a', reasoningEvents('m1', false));
    seed(h, 'r-b', callEvents('c1', SERVER_TOOL, 1), { threadId: 'thread-b' });
    const listed = h.facts.unresolvedRuns({ all: true });
    expect(listed).toEqual([
      expect.objectContaining({
        threadId: T,
        runId: 'r-a',
        disposition: 'deferred',
        openRule: 'R26b',
        afterRecovery: 'remains_open',
        duplicateRunId: false,
        liveness: 'not_active_in_this_process',
        agentId: AGENT_ID,
        seq: 1,
      }),
      expect.objectContaining({
        threadId: 'thread-b',
        runId: 'r-b',
        disposition: 'recoverable',
        kind: 'server_unknown_outcome',
        afterRecovery: 'closed_by_recovery',
      }),
    ]);
    expect(
      h.facts.unresolvedRuns({ threadId: 'thread-b', agentId: AGENT_ID }),
    ).toHaveLength(1);
  });

  it('flags the same runId on two threads, keeping the pair as the identity', () => {
    const h = make();
    seed(h, 'same', reasoningEvents('m1', false), { threadId: 'thread-1' });
    seed(h, 'same', reasoningEvents('m2', false), { threadId: 'thread-2' });
    const listed = h.facts.unresolvedRuns({ all: true });
    expect(listed.map((run) => [run.threadId, run.duplicateRunId])).toEqual([
      ['thread-1', true],
      ['thread-2', true],
    ]);
    expect(ask(h, 'same', 'thread-1').attempt().threadId).toBe('thread-1');
  });

  it('reports an unreadable run as inconsistent without blinding the listing', () => {
    const h = make();
    seed(h, 'r-bad', textEvents('a1', false, 'x'));
    seed(h, 'r-ok', reasoningEvents('m1', false), { threadId: 'thread-ok' });
    h.db
      .prepare(
        "UPDATE conversation_events SET eventJson='{not json' WHERE runId='r-bad' AND seq=1",
      )
      .run();
    const listed = h.facts.unresolvedRuns({ all: true });
    expect(
      Object.fromEntries(listed.map((run) => [run.runId, run.disposition])),
    ).toEqual({ 'r-bad': 'inconsistent', 'r-ok': 'deferred' });
    expect(listed.find((run) => run.runId === 'r-bad')?.issues).toContain(
      'event_unreadable',
    );
    expect(h.facts.threadState(T, AGENT_ID).state).toBe('unresolved');
  });

  it('does not list a run this process is driving', async () => {
    const h = make();
    const agent = new ScriptedAgent(() => [...textMessage('a1', 'x'), HANG]);
    const input = runInput(T, 'r-live', [user('u1')]);
    const sub = h.runner
      .run({ threadId: T, agent: prime(agent, input), input })
      .subscribe({ error: () => undefined });
    await until(() => agent.stats.emitted >= 4);
    expect(h.facts.unresolvedRuns({ all: true })).toEqual([]);
    expect(h.facts.unresolvedRuns({ threadId: T, agentId: AGENT_ID })).toEqual(
      [],
    );
    await h.runner.stop({ threadId: T, runId: 'r-live' } as never);
    await until(() => h.log.getRun(T, 'r-live')?.status !== 'running');
    sub.unsubscribe();
  });

  it('returns an empty list, and creates nothing, without a schema', () => {
    const h = make();
    expect(h.facts.unresolvedRuns({ all: true })).toEqual([]);
    expect(h.facts.unresolvedRuns({ threadId: T, agentId: AGENT_ID })).toEqual(
      [],
    );
  });
});

// ------------------------------------------------- ownership and global scope

describe('ownership', () => {
  it('refuses every thread-scoped accessor before reading anything', () => {
    const h = make({ ownsThread: () => false });
    seed(h, 'r-a', reasoningEvents('m1', false));
    const recorder = recordStatements(h.db);
    const codes = [
      codeOf(() => h.facts.threadState(T, AGENT_ID)),
      codeOf(() => ask(h, 'r-a').attempt()),
      codeOf(() => ask(h, 'missing').attempt()),
      codeOf(() => ask(h, 'r-a').terminal()),
      codeOf(() => h.facts.unresolvedRuns({ threadId: T, agentId: AGENT_ID })),
    ];
    expect(codes).toEqual(Array(5).fill('THREAD_NOT_OWNED'));
    expect(recorder.executed).toEqual([]);
    recorder.stop();
  });

  it('cannot tell an existing run from a missing one on a thread that is not owned', () => {
    const h = make({ ownsThread: () => false });
    seed(h, 'r-a', reasoningEvents('m1', false));
    const messages = ['r-a', 'nope'].map((runId) => {
      try {
        ask(h, runId).attempt();
        return 'none';
      } catch (error) {
        return (error as Error).message.replace(runId, '<run>');
      }
    });
    expect(messages[0]).toBe(messages[1]);
  });

  it('fails closed when the predicate throws, or the agent id is empty', () => {
    const h = make({
      ownsThread: () => {
        throw new Error('predicate failed');
      },
    });
    expect(codeOf(() => h.facts.threadState(T, AGENT_ID))).toBe(
      'THREAD_NOT_OWNED',
    );
    const open = make();
    expect(codeOf(() => open.facts.threadState(T, ''))).toBe(
      'THREAD_NOT_OWNED',
    );
  });

  it('uses the same predicate and arguments the runner uses for admission', async () => {
    const calls: Array<[string, string]> = [];
    const h = make({
      ownsThread: (threadId, agentId) => {
        calls.push([threadId, agentId]);
        return true;
      },
    });
    h.facts.threadState(T, 'agent-x');
    expect(calls).toEqual([[T, 'agent-x']]);
    const input = runInput(T, 'r1', [user('u1')]);
    const agent = new ScriptedAgent((i) => [finished(i)]);
    await collect(
      h.runner.run({
        threadId: T,
        agent: prime(agent, input, 'agent-x'),
        input,
      }),
    );
    expect(calls.slice(1)).toEqual([[T, 'agent-x']]);
  });
});

describe('global enumeration is explicit and fail closed', () => {
  const malformed: unknown[] = [
    {},
    { all: false },
    { all: 'true' },
    { all: 1 },
    { all: undefined },
    { threadId: T },
    { agentId: undefined },
    { agentId: '' },
    null,
    undefined,
    'all',
    [],
  ];

  it.each(
    malformed.map((scope) => [JSON.stringify(scope) ?? 'undefined', scope]),
  )(
    'activeRuns(%s) is refused, never read as a global listing',
    (_label, scope) => {
      const h = make();
      expect(codeOf(() => h.facts.activeRuns(scope as never))).toBe(
        'THREAD_NOT_OWNED',
      );
    },
  );

  it.each(
    malformed.map((scope) => [JSON.stringify(scope) ?? 'undefined', scope]),
  )(
    'unresolvedRuns(%s) is refused, never read as a global listing',
    (_label, scope) => {
      const h = make();
      seed(h, 'r-a', reasoningEvents('m1', false));
      expect(codeOf(() => h.facts.unresolvedRuns(scope as never))).toBe(
        'THREAD_NOT_OWNED',
      );
    },
  );

  it('does not ownership-check a global listing and says so: it returns identifiers and reasons only', () => {
    const h = make({ ownsThread: () => false });
    seed(h, 'r-a', [
      ...textEvents('a1', false, 'SECRET-CONTENT'),
      ...callEvents('c1', SERVER_TOOL, 1),
    ]);
    const listed = h.facts.unresolvedRuns({ all: true });
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain('SECRET-CONTENT');
    expect(Object.keys(listed[0]).sort()).toEqual(
      [
        'afterRecovery',
        'agentId',
        'disposition',
        'duplicateRunId',
        'eventCount',
        'issues',
        'kind',
        'liveness',
        'openRule',
        'pendingClientCalls',
        'pendingServerCalls',
        'runId',
        'seq',
        'startedAt',
        'threadId',
      ].sort(),
    );
  });
});

// ------------------------------------------------------------------- errors

describe('typed errors', () => {
  it('RUN_NOT_FOUND for an unknown run of an owned thread, with and without a schema', () => {
    const h = make();
    expect(codeOf(() => ask(h, 'nope').attempt())).toBe('RUN_NOT_FOUND');
    expect(codeOf(() => ask(h, 'nope').terminal())).toBe('RUN_NOT_FOUND');
    h.log.ensureSchema();
    expect(codeOf(() => ask(h, 'nope').attempt())).toBe('RUN_NOT_FOUND');
    expect(codeOf(() => ask(h, 'nope').terminal())).toBe('RUN_NOT_FOUND');
  });

  const corruptions: Array<[string, (h: Harness) => void, string]> = [
    [
      'a terminal event on a running row',
      (h) =>
        h.db
          .prepare(
            "INSERT INTO conversation_events(threadId, runId, seq, eventType, messageId, eventJson) VALUES (?, 'r-bad', 3, 'RUN_FINISHED', NULL, ?)",
          )
          .run(T, JSON.stringify({ type: 'RUN_FINISHED' })),
      'terminal_without_status',
    ],
    [
      'a finished row without a terminal event',
      (h) =>
        h.db
          .prepare(
            "UPDATE conversation_runs SET status='finished', finishedAt=1 WHERE runId='r-bad'",
          )
          .run(),
      'status_without_terminal',
    ],
    [
      'a gap in the event sequence',
      (h) =>
        h.db
          .prepare(
            "DELETE FROM conversation_events WHERE runId='r-bad' AND seq=1",
          )
          .run(),
      'seq_gap',
    ],
    [
      'an unreadable event',
      (h) =>
        h.db
          .prepare(
            "UPDATE conversation_events SET eventJson='{not json' WHERE runId='r-bad' AND seq=1",
          )
          .run(),
      'event_unreadable',
    ],
    [
      'a RUN_STARTED of another run',
      (h) =>
        h.db
          .prepare(
            "UPDATE conversation_events SET eventJson=? WHERE runId='r-bad' AND seq=0",
          )
          .run(
            JSON.stringify({
              type: 'RUN_STARTED',
              threadId: T,
              runId: 'someone-else',
            }),
          ),
      'identity_mismatch',
    ],
    [
      'an unknown status',
      (h) =>
        h.db
          .prepare(
            "UPDATE conversation_runs SET status='weird' WHERE runId='r-bad'",
          )
          .run(),
      'unknown_status',
    ],
    [
      'a RUN_ERROR under a finished row',
      (h) => {
        h.db
          .prepare(
            "INSERT INTO conversation_events(threadId, runId, seq, eventType, messageId, eventJson) VALUES (?, 'r-bad', 3, 'RUN_ERROR', NULL, ?)",
          )
          .run(T, JSON.stringify({ type: 'RUN_ERROR', message: 'x' }));
        h.db
          .prepare(
            "UPDATE conversation_runs SET status='finished', finishedAt=1 WHERE runId='r-bad'",
          )
          .run();
      },
      'status_terminal_mismatch',
    ],
  ];

  it.each(corruptions)(
    'INCONSISTENT_DURABLE_STATE for %s, with the enumerated reason and no event content',
    (_label, corrupt, reason) => {
      const h = make();
      seed(h, 'r-bad', textEvents('a1', false, 'SECRET-CONTENT'));
      corrupt(h);
      for (const read of [
        () => ask(h, 'r-bad').attempt(),
        () => ask(h, 'r-bad').terminal(),
      ]) {
        let caught: unknown;
        try {
          read();
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(RunFactsError);
        const error = caught as RunFactsError;
        expect(error.code).toBe(
          'INCONSISTENT_DURABLE_STATE' satisfies RunFactsErrorCode,
        );
        expect(error.reasons).toContain(reason);
        expect(error.threadId).toBe(T);
        expect(error.runId).toBe('r-bad');
        expect(error.message).not.toContain('SECRET-CONTENT');
        expect(error.message).not.toMatch(/SELECT|conversation_|\/tmp|\/var/);
      }
    },
  );

  it('STORAGE_UNAVAILABLE when the database cannot be read, without SQL or paths', () => {
    const h = make();
    seed(h, 'r-a', reasoningEvents('m1', false));
    const reader = new ClosedConnectionReader(h);
    let message = '';
    let code = '';
    try {
      reader.facts.threadState(T, AGENT_ID);
    } catch (error) {
      code = (error as RunFactsError).code;
      message = (error as Error).message;
    }
    expect(code).toBe('STORAGE_UNAVAILABLE');
    expect(message).not.toMatch(/SELECT|conversation_|\/tmp|\/var|opendots-c4/);
  });

  it('does not map corruption to idle or to a result', () => {
    const h = make();
    seed(h, 'r-bad', textEvents('a1', false, 'x'));
    h.db
      .prepare(
        "UPDATE conversation_events SET eventJson='{not json' WHERE runId='r-bad' AND seq=1",
      )
      .run();
    expect(h.facts.threadState(T, AGENT_ID).state).toBe('unresolved');
    expect(codeOf(() => ask(h, 'r-bad').attempt())).toBe(
      'INCONSISTENT_DURABLE_STATE',
    );
    expect(codeOf(() => ask(h, 'r-bad').terminal())).toBe(
      'INCONSISTENT_DURABLE_STATE',
    );
  });
});

// A facts reader over a connection that has been closed.
class ClosedConnectionReader {
  readonly facts: RunFacts;
  constructor(h: Harness) {
    const connection = h.observer();
    const view: RunnerView = {
      active: new Map(),
      ownsThread: () => true,
      clientExecutableToolNames: CLIENT_EXECUTABLE,
    };
    this.facts = new RunFacts(new ConversationLog(connection), view);
    connection.close();
  }
}
