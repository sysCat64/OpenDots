import type { BaseEvent } from '@ag-ui/core';
import { afterEach, describe, expect, it } from 'vitest';
import { UNKNOWN_OUTCOME_CONTENT } from '../src/server/run-rules';
import {
  DEFAULT_DIAGNOSIS_LIMITS,
  EVIDENCE_DIGEST_VERSION,
  RunDiagnosis,
  RunDiagnosisError,
  canonicalJson,
  runEvidenceChain,
  type RunDiagnosisResult,
  type ThreadDiagnosis,
} from '../src/server/run-diagnosis';
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
import {
  AGENT_ID,
  createHarness,
  runInput,
  runToEnd,
  seedRun,
  until,
  type Harness,
} from './helpers/runner-harness';
import {
  HANG,
  ScriptedAgent,
  textMessage,
  toolCall,
} from './helpers/scripted-agent';

// R-DIAG: the dormant, read-only diagnosis of unresolved durable runs
// (docs of the resolver phase: boundary RC-01..RC-04). It reports what the log
// holds and what the replay machinery would do with it; it decides nothing,
// writes nothing and authorizes nothing. Offline, throwaway databases, scripted
// producer, no provider.
const T = 'thread-1';
const ev = (value: Record<string, unknown>) => value as unknown as BaseEvent;
const SECRET = 'SENTINEL-CONTENT-7f3a';

const harnesses: Harness[] = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.cleanup();
});
const make = () => {
  const h = createHarness();
  harnesses.push(h);
  return h;
};
const diagnosisOf = (
  h: Harness,
  options: {
    limits?: ConstructorParameters<typeof RunDiagnosis>[0]['limits'];
    clientExecutableToolNames?: ReadonlySet<string>;
  } = {},
) =>
  new RunDiagnosis({
    log: h.log,
    runner: h.runner,
    clientExecutableToolNames:
      options.clientExecutableToolNames ?? CLIENT_EXECUTABLE,
    limits: options.limits,
  });

function put(
  h: Harness,
  runId: string,
  events: BaseEvent[],
  options: {
    threadId?: string;
    declared?: string[];
    status?: 'finished' | 'error' | 'stopped' | 'interrupted';
  } = {},
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
    status: options.status,
  });
}
const finishedRun = (runId: string, threadId = T) =>
  ev({ type: 'RUN_FINISHED', threadId, runId });

const diagnoseRun = async (
  h: Harness,
  runId: string,
  threadId = T,
): Promise<Extract<RunDiagnosisResult, { outcome: 'diagnosed' }>> => {
  const result = await diagnosisOf(h).diagnoseRun({
    threadId,
    runId,
    agentId: AGENT_ID,
  });
  if (result.outcome !== 'diagnosed') throw new Error('refused');
  return result;
};
const diagnoseThread = async (
  h: Harness,
  threadId = T,
): Promise<Extract<ThreadDiagnosis, { outcome: 'diagnosed' }>> => {
  const result = await diagnosisOf(h).diagnoseThread({
    threadId,
    agentId: AGENT_ID,
  });
  if (result.outcome !== 'diagnosed') throw new Error('refused');
  return result;
};

describe('classification, tool lifecycle, hitl and the proposed append types', () => {
  it('R22: mixed pending server and client calls. The server effect is unknown, the client call is unanswered, the plan is on hold', async () => {
    const h = make();
    put(
      h,
      'r-dead',
      [
        ...callEvents('c1', SERVER_TOOL, 1),
        ...callEvents('c2', CLIENT_TOOL, 1, 'a2'),
      ],
      { declared: [CLIENT_TOOL] },
    );
    const d = await diagnoseRun(h, 'r-dead');
    expect(d.authoritativeStatus).toBe('running');
    expect(d.lifecycle).toBe('nonterminal_not_active');
    expect(d.classification).toMatchObject({ class: 'R22', deferred: true });
    expect(d.toolLifecycle.calls).toEqual([
      expect.objectContaining({
        toolCallId: 'c1',
        side: 'server',
        executorEntry: 'possible',
        knowledge: 'unknown',
        provenance: 'none',
      }),
      expect.objectContaining({
        toolCallId: 'c2',
        side: 'client',
        executorEntry: 'not_applicable_client',
        knowledge: 'client_side',
      }),
    ]);
    expect(d.executor.entryPossible).toBe(1);
    expect(d.hitl.pendingClientCalls).toEqual([
      { toolCallId: 'c2', toolName: CLIENT_TOOL },
    ]);
    expect(d.plan.status).toBe('on_hold');
    expect(d.plan.eventTypes).toEqual([
      'CUSTOM',
      'TOOL_CALL_RESULT',
      'RUN_ERROR',
    ]);
    expect(d.plan.terminalStatus).toBe('interrupted');
    expect(d.plan.requiredAcknowledgements).toEqual([
      'server_effect_unknown',
      'client_call_unanswered',
    ]);
    expect(d.blockers).toEqual(
      expect.arrayContaining([
        'RESOLVER_NOT_AVAILABLE',
        'ADMISSION_GUARD_NOT_IMPLEMENTED',
        'LIVENESS_UNPROVEN',
        'HITL_RELEASE_HOLD',
        'PROVIDER_HISTORY_UNVERIFIED',
      ]),
    );
    // The projected history is mechanically sound, which is exactly why it is
    // not taken as provider compatibility.
    expect(d.replay.projected).toMatchObject({
      state: 'passed',
      lifecycle: 'ok',
      provenance: 'ok',
    });
  });

  it('R24: open text beside a pending server call. The text is kept, the call is marked unknown', async () => {
    const h = make();
    put(h, 'r-dead', [
      ...textEvents('a1', false, 'partial'),
      ...callEvents('c1', SERVER_TOOL, 1, 'a2'),
    ]);
    const d = await diagnoseRun(h, 'r-dead');
    expect(d.classification.class).toBe('R24');
    expect(d.lifecycles.openText).toBe(1);
    expect(d.plan.status).toBe('proposed');
    expect(d.plan.eventTypes).toEqual([
      'CUSTOM',
      'TEXT_MESSAGE_END',
      'TOOL_CALL_RESULT',
      'RUN_ERROR',
    ]);
    expect(d.plan.requiredAcknowledgements).toEqual([
      'server_effect_unknown',
      'incomplete_content_kept',
    ]);
    expect(d.blockers).not.toContain('HITL_RELEASE_HOLD');
  });

  it('R24: an incomplete-args call is NOT treated as executed, the complete pending call is', async () => {
    const h = make();
    put(h, 'r-dead', [
      ...callEvents('c1', SERVER_TOOL, 0, 'a1'),
      ...callEvents('c2', SERVER_TOOL, 1, 'a2'),
    ]);
    const d = await diagnoseRun(h, 'r-dead');
    expect(d.classification.class).toBe('R24');
    const [c1, c2] = d.toolLifecycle.calls;
    expect(c1).toMatchObject({
      toolCallId: 'c1',
      phase: 'args_open',
      executorEntry: 'not_possible',
      knowledge: 'not_executed',
    });
    expect(c2).toMatchObject({
      toolCallId: 'c2',
      executorEntry: 'possible',
      knowledge: 'unknown',
    });
    expect(d.executor.entryPossible).toBe(1);
    expect(d.lifecycles.incompleteArgsCalls).toBe(1);
    expect(d.plan.eventTypes).toEqual([
      'CUSTOM',
      'TOOL_CALL_END',
      'TOOL_CALL_RESULT',
      'TOOL_CALL_RESULT',
      'RUN_ERROR',
    ]);
    expect(d.plan.requiredAcknowledgements).toEqual([
      'server_effect_unknown',
      'incomplete_tool_args_closed',
    ]);
  });

  it('R24 with only a pending client call is on hold as well (the same unanswered-call hazard)', async () => {
    const h = make();
    put(
      h,
      'r-dead',
      [
        ...textEvents('a1', false, 'partial'),
        ...callEvents('c2', CLIENT_TOOL, 1, 'a2'),
      ],
      { declared: [CLIENT_TOOL] },
    );
    const d = await diagnoseRun(h, 'r-dead');
    expect(d.classification.class).toBe('R24');
    expect(d.plan.status).toBe('on_hold');
    expect(d.blockers).toContain('HITL_RELEASE_HOLD');
  });

  it('R26b: open reasoning has no tool call, so no executor can have run, and is not closed by itself', async () => {
    const h = make();
    put(h, 'r-dead', reasoningEvents('m1', false));
    const d = await diagnoseRun(h, 'r-dead');
    expect(d.classification.class).toBe('R26b');
    expect(d.toolLifecycle.calls).toEqual([]);
    expect(d.executor.entryPossible).toBe(0);
    expect(d.lifecycles.openReasoning).toBe(1);
    expect(d.plan.status).toBe('proposed');
    expect(d.plan.eventTypes).toEqual([
      'CUSTOM',
      'REASONING_MESSAGE_END',
      'REASONING_END',
      'RUN_ERROR',
    ]);
    expect(d.blockers).toContain('RESOLVER_NOT_AVAILABLE');
  });

  it('R26b: state and custom events only. Nothing is open, only the terminal is missing', async () => {
    const h = make();
    put(h, 'r-dead', [
      ev({ type: 'STATE_SNAPSHOT', snapshot: { k: 1 } }),
      ev({ type: 'CUSTOM', name: 'x', value: { a: 1 } }),
    ]);
    const d = await diagnoseRun(h, 'r-dead');
    expect(d.classification.class).toBe('R26b');
    expect(d.lifecycles.stateEvents).toBe(1);
    expect(d.lifecycles.customEvents).toBe(1);
    expect(d.plan.eventTypes).toEqual(['CUSTOM', 'RUN_ERROR']);
    expect(d.plan.requiredAcknowledgements).toEqual([]);
  });

  it('an unappliable STATE_DELTA fails the replay, authorizes nothing and has no plan', async () => {
    const h = make();
    put(h, 'r-dead', [
      ...textEvents('a1', true, 'x'),
      ev({ type: 'STATE_SNAPSHOT', snapshot: { secret: SECRET } }),
      ev({
        type: 'STATE_DELTA',
        delta: [{ op: 'replace', path: '/missing/path', value: 1 }],
      }),
    ]);
    const d = await diagnoseRun(h, 'r-dead');
    // verifyEvents and the reducer both accept this history. Only the replay
    // the connect endpoint performs fails.
    expect(d.replay.current).toMatchObject({
      state: 'failed',
      verifyEvents: 'ok',
      compactEvents: 'failed',
      reducer: 'ok',
      reasons: ['state_delta_unappliable'],
    });
    expect(d.plan.status).toBe('not_possible');
    expect(d.plan.eventTypes).toEqual([]);
    expect(d.replay.projected).toBeNull();
    expect(d.blockers).toContain('STATE_REPLAY_UNAPPLIABLE');
    // The SDK's own message quotes the state; the diagnosis never does.
    expect(JSON.stringify(d)).not.toContain(SECRET);
  });

  it('a thread whose OTHER run cannot replay is not releasable by resolving this one', async () => {
    const h = make();
    put(
      h,
      'r-old',
      [
        ev({ type: 'STATE_SNAPSHOT', snapshot: { a: 1 } }),
        ev({
          type: 'STATE_DELTA',
          delta: [{ op: 'replace', path: '/nope', value: 1 }],
        }),
        finishedRun('r-old'),
      ],
      { status: 'finished' },
    );
    put(h, 'r-dead', reasoningEvents('m1', false));
    const d = await diagnoseRun(h, 'r-dead');
    expect(d.plan.status).toBe('not_possible');
    expect(d.blockers).toContain('STATE_REPLAY_UNAPPLIABLE');
  });

  it('a failed final write leaves a nonterminal run that is diagnosed by its content', async () => {
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
      const agent = new ScriptedAgent(() => [
        ...(reasoningEvents('m1', false) as unknown as Array<
          Record<string, unknown>
        >),
        HANG,
      ]);
      agent.agentId = AGENT_ID;
      const input = runInput(T, 'r-live', [user('u1')]);
      agent.setMessages(input.messages);
      agent.threadId = T;
      const sub = h.runner
        .run({ threadId: T, agent, input })
        .subscribe({ error: () => undefined });
      await until(() => agent.stats.emitted >= 4);
      await h.runner.stop({ threadId: T, runId: 'r-live' } as never);
      await until(
        () => h.runner.facts.activeRuns({ all: true }).length === 0,
        'reservation dropped',
      );
      sub.unsubscribe();
      h.log.beforeAppend = undefined;
    } finally {
      console.error = original;
    }
    const d = await diagnoseRun(h, 'r-live');
    expect(d.authoritativeStatus).toBe('running');
    expect(d.lifecycle).toBe('nonterminal_not_active');
    expect(d.classification.class).toBe('R26b');
    expect(d.terminal).toBeNull();
    expect(d.blockers).toContain('LIVENESS_UNPROVEN');
  });

  it('a recoverable run is reported as one the existing recovery closes, and is not closed by the diagnosis', async () => {
    const h = make();
    put(h, 'r-dead', callEvents('c1', SERVER_TOOL, 1));
    const d = await diagnoseRun(h, 'r-dead');
    expect(d.classification).toMatchObject({
      class: 'recoverable',
      recoveryKind: 'server_unknown_outcome',
      deferred: false,
    });
    expect(d.plan.status).toBe('closed_by_recovery');
    // What the existing recovery would append, never appended here.
    expect(d.plan.eventTypes).toEqual(['TOOL_CALL_RESULT', 'RUN_ERROR']);
    expect(h.log.getRun(T, 'r-dead')?.status).toBe('running');
  });

  it('a normal completed run is terminal: consistent, nothing to resolve, no blockers', async () => {
    const h = make();
    put(h, 'r-ok', [...textEvents('a1', true, 'ok'), finishedRun('r-ok')], {
      status: 'finished',
    });
    const d = await diagnoseRun(h, 'r-ok');
    expect(d.classification.class).toBe('terminal');
    expect(d.lifecycle).toBe('terminal');
    expect(d.integrity).toEqual({ state: 'consistent', issues: [] });
    expect(d.terminal).toEqual({ eventType: 'RUN_FINISHED' });
    expect(d.plan.status).toBe('not_needed');
    expect(d.plan.eventTypes).toEqual([]);
    expect(d.blockers).toEqual([]);
    expect(d.findings).toEqual([]);
    const thread = await diagnoseThread(h);
    expect(thread.integrity.state).toBe('consistent');
    expect(thread.effectEvidence.state).toBe('complete');
    expect(thread.blockers).toEqual([]);
    expect(thread.unresolved).toEqual([]);
  });

  it('a run this process is driving is active, not unresolved', async () => {
    const h = make();
    const agent = new ScriptedAgent(() => [...textMessage('a1', 'x'), HANG]);
    agent.agentId = AGENT_ID;
    const input = runInput(T, 'r-live', [user('u1')]);
    agent.setMessages(input.messages);
    agent.threadId = T;
    const sub = h.runner
      .run({ threadId: T, agent, input })
      .subscribe({ error: () => undefined });
    await until(() => agent.stats.emitted >= 4);
    const d = await diagnoseRun(h, 'r-live');
    expect(d.lifecycle).toBe('active_in_memory');
    expect(d.classification.class).toBe('active');
    expect(d.blockers).toEqual(['RUN_ACTIVE_IN_MEMORY']);
    const thread = await diagnoseThread(h);
    expect(thread.state).toBe('running');
    expect(thread.unresolved).toEqual([]);
    await h.runner.stop({ threadId: T, runId: 'r-live' } as never);
    await until(() => h.log.getRun(T, 'r-live')?.status !== 'running');
    sub.unsubscribe();
  });
});

describe('terminal runs are inspected too (integrity and effect evidence)', () => {
  const seedDone = (h: Harness) =>
    put(
      h,
      'r-done',
      [...textEvents('a0', true, 'done'), finishedRun('r-done')],
      { status: 'finished' },
    );

  it('a terminal run with an unreadable event is damaged and is never reported as idle or available', async () => {
    const h = make();
    seedDone(h);
    h.db
      .prepare(
        "UPDATE conversation_events SET eventJson='{not json' WHERE runId='r-done' AND seq=1",
      )
      .run();
    // The committed facts look at running rows only and call this thread idle.
    expect(h.runner.facts.threadState(T, AGENT_ID).state).toBe('idle');
    const thread = await diagnoseThread(h);
    expect(thread.integrity.state).toBe('damaged');
    expect(thread.integrity.findings).toEqual([
      { code: 'event_unreadable', severity: 'damaged', runId: 'r-done' },
    ]);
    expect(thread.blockers).toContain('HISTORY_INCONSISTENT');
    expect(thread.replay.current.state).toBe('not_run');
    const run = await diagnoseRun(h, 'r-done');
    expect(run.integrity).toEqual({
      state: 'damaged',
      issues: ['event_unreadable'],
    });
    expect(run.classification.class).toBe('inconsistent');
    expect(run.evidence.digest).toBeNull();
    expect(run.plan.status).toBe('not_possible');
  });

  it('status finished without a terminal event is damaged', async () => {
    const h = make();
    seedDone(h);
    h.db
      .prepare(
        "DELETE FROM conversation_events WHERE runId='r-done' AND eventType='RUN_FINISHED'",
      )
      .run();
    const thread = await diagnoseThread(h);
    expect(thread.integrity.state).toBe('damaged');
    expect(thread.integrity.findings).toEqual([
      { code: 'status_without_terminal', severity: 'damaged', runId: 'r-done' },
    ]);
    expect(thread.blockers).toContain('HISTORY_INCONSISTENT');
  });

  it('a status that disagrees with its terminal event is damaged', async () => {
    const h = make();
    seedDone(h);
    h.db
      .prepare(
        "UPDATE conversation_runs SET status='error' WHERE runId='r-done'",
      )
      .run();
    const thread = await diagnoseThread(h);
    expect(thread.integrity.findings.map((f) => f.code)).toEqual([
      'status_terminal_mismatch',
    ]);
  });

  it('a corrupt RUNNING run is diagnosed, not thrown, and blocks', async () => {
    const h = make();
    put(h, 'r-dead', reasoningEvents('m1', false));
    h.db
      .prepare(
        "UPDATE conversation_events SET eventJson='{not json' WHERE runId='r-dead' AND seq=1",
      )
      .run();
    const d = await diagnoseRun(h, 'r-dead');
    expect(d.classification.class).toBe('inconsistent');
    expect(d.integrity).toEqual({
      state: 'damaged',
      issues: ['event_unreadable'],
    });
    expect(d.toolLifecycle.calls).toEqual([]);
    expect(d.blockers).toEqual(
      expect.arrayContaining(['HISTORY_INCONSISTENT', 'LIVENESS_UNPROVEN']),
    );
    expect(d.plan).toMatchObject({ status: 'not_possible', eventTypes: [] });
    // The error text of the parser is not carried.
    expect(JSON.stringify(d)).not.toMatch(/JSON|Unexpected|position/i);
  });

  it('a run-seq gap is a thread-level integrity finding', async () => {
    const h = make();
    seedDone(h);
    put(h, 'r-two', [...textEvents('a1', true, 'x'), finishedRun('r-two')], {
      status: 'finished',
    });
    h.db
      .prepare("UPDATE conversation_runs SET seq=3 WHERE runId='r-two'")
      .run();
    const thread = await diagnoseThread(h);
    expect(thread.integrity.state).toBe('damaged');
    expect(thread.integrity.findings).toEqual([
      { code: 'run_seq_gap', severity: 'damaged' },
    ]);
  });

  it('a server call whose only result is the stock closer is reported as masked, not as a known outcome', async () => {
    const h = make();
    put(
      h,
      'r-closed',
      [
        ...callEvents('c1', SERVER_TOOL, 1),
        ev({
          type: 'TOOL_CALL_RESULT',
          toolCallId: 'c1',
          messageId: 'c1-result',
          role: 'tool',
          content: JSON.stringify({
            status: 'error',
            reason: 'missing_terminal_event',
            message: 'x',
          }),
        }),
        ev({ type: 'RUN_ERROR', message: 'x', code: 'INCOMPLETE_STREAM' }),
      ],
      { status: 'error' },
    );
    const d = await diagnoseRun(h, 'r-closed');
    expect(d.toolLifecycle.calls[0]).toMatchObject({
      provenance: 'synthetic_closer',
      knowledge: 'unknown',
    });
    expect(d.findings).toEqual([
      {
        code: 'server_outcome_masked_by_synthetic_closer',
        severity: 'attention',
        runId: 'r-closed',
        toolCallId: 'c1',
      },
    ]);
    const thread = await diagnoseThread(h);
    expect(thread.effectEvidence.state).toBe('gaps');
    expect(thread.integrity.state).toBe('consistent');
  });

  it('a recorded unknown-outcome marker is a known unknown, never a result', async () => {
    const h = make();
    put(
      h,
      'r-marked',
      [
        ...callEvents('c1', SERVER_TOOL, 1),
        ev({
          type: 'TOOL_CALL_RESULT',
          toolCallId: 'c1',
          messageId: 'c1-unknown-outcome',
          role: 'tool',
          content: UNKNOWN_OUTCOME_CONTENT,
        }),
        ev({ type: 'RUN_ERROR', message: 'x', code: 'INCOMPLETE_STREAM' }),
      ],
      { status: 'interrupted' },
    );
    const d = await diagnoseRun(h, 'r-marked');
    expect(d.toolLifecycle.calls[0]).toMatchObject({
      provenance: 'unknown_outcome',
      knowledge: 'unknown',
    });
    expect(d.findings).toEqual([
      {
        code: 'server_outcome_unknown_marker',
        severity: 'info',
        runId: 'r-marked',
        toolCallId: 'c1',
      },
    ]);
  });

  it('a HISTORICAL terminal beside a pending server call is a legitimate shape that leaves the outcome unrecorded', async () => {
    const h = make();
    // Written before the terminal commit recorded the unknown outcome (A): a
    // terminal run is never rewritten, so the shape is still diagnosed.
    put(
      h,
      'r1',
      [
        ...textEvents('a1', true, 'checking'),
        ...callEvents('c1', SERVER_TOOL, 1),
        ev({
          type: 'RUN_ERROR',
          message: 'provider failed',
          code: 'PROVIDER_FAILED',
        }),
      ],
      { status: 'error' },
    );
    expect(h.log.getRun(T, 'r1')?.status).toBe('error');
    // The facts call this thread idle and the next turn is admitted.
    expect(h.runner.facts.threadState(T, AGENT_ID).state).toBe('idle');
    const d = await diagnoseRun(h, 'r1');
    expect(d.findings).toEqual([
      {
        code: 'terminal_server_outcome_unrecorded',
        severity: 'attention',
        runId: 'r1',
        toolCallId: 'c1',
      },
    ]);
    const thread = await diagnoseThread(h);
    expect(thread.integrity.state).toBe('consistent');
    expect(thread.effectEvidence.state).toBe('gaps');
  });

  it('a NEW agent-emitted terminal beside a pending server call records the unknown outcome with it', async () => {
    const h = make();
    const agent = new ScriptedAgent(() => [
      ...textMessage('a1', 'checking'),
      ...toolCall('c1', SERVER_TOOL, 'a1'),
      {
        type: 'RUN_ERROR',
        message: 'provider failed',
        code: 'PROVIDER_FAILED',
      },
    ]);
    await runToEnd(h.runner, agent, runInput(T, 'r1', [user('u1', 'go')]));
    expect(h.log.getRun(T, 'r1')?.status).toBe('error');
    expect(h.runner.facts.threadState(T, AGENT_ID).state).toBe('idle');
    const d = await diagnoseRun(h, 'r1');
    // Recorded as unknown (never as success): the gap is closed, the
    // uncertainty is not.
    expect(d.findings).toEqual([
      {
        code: 'server_outcome_unknown_marker',
        severity: 'info',
        runId: 'r1',
        toolCallId: 'c1',
      },
    ]);
    expect(d.toolLifecycle.calls[0].knowledge).toBe('unknown');
  });

  it('a terminal run that ends with an unanswered client call or an open message is reported', async () => {
    const h = make();
    put(
      h,
      'r-hitl',
      [
        ...callEvents('c2', CLIENT_TOOL, 1, 'a2'),
        ev({ type: 'RUN_FINISHED', threadId: T, runId: 'r-hitl' }),
      ],
      { declared: [CLIENT_TOOL], status: 'finished' },
    );
    put(
      h,
      'r-open',
      [
        ...textEvents('a3', false, 'cut'),
        ev({ type: 'RUN_ERROR', message: 'x' }),
      ],
      { status: 'error' },
    );
    const thread = await diagnoseThread(h);
    const codes = (id: string) =>
      thread.runs.find((run) => run.runId === id)?.findingCodes;
    expect(codes('r-hitl')).toEqual(['terminal_client_call_unanswered']);
    expect(codes('r-open')).toEqual(['terminal_open_lifecycle']);
  });
});

describe('the thread view', () => {
  it('lists every run and diagnoses only the nonterminal runs this process does not drive', async () => {
    const h = make();
    put(h, 'r-1', [...textEvents('a1', true, 'x'), finishedRun('r-1')], {
      status: 'finished',
    });
    put(h, 'r-2', reasoningEvents('m2', false));
    const thread = await diagnoseThread(h);
    expect(thread.state).toBe('unresolved');
    expect(thread.runs.map((run) => [run.runId, run.seq, run.class])).toEqual([
      ['r-1', 1, 'terminal'],
      ['r-2', 2, 'R26b'],
    ]);
    expect(thread.unresolved.map((run) => run.runId)).toEqual(['r-2']);
    expect(thread.blockers).toEqual(
      expect.arrayContaining(['RESOLVER_NOT_AVAILABLE']),
    );
    expect(thread.evidence.runCount).toBe(2);
    expect(thread.evidence.digestVersion).toBe(EVIDENCE_DIGEST_VERSION);
    expect(thread.limits).toEqual(DEFAULT_DIAGNOSIS_LIMITS);
  });

  it('an empty database and an unknown thread diagnose as having no runs, and create nothing', async () => {
    const h = make();
    const thread = await diagnoseThread(h, 'never');
    expect(thread.runs).toEqual([]);
    expect(thread.state).toBe('idle');
    expect(thread.integrity.state).toBe('consistent');
    await expect(
      diagnosisOf(h).diagnoseRun({
        threadId: 'never',
        runId: 'r',
        agentId: AGENT_ID,
      }),
    ).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
  });

  it('refuses an unknown run with a typed error, on a thread that has others', async () => {
    const h = make();
    put(h, 'r-1', reasoningEvents('m1', false));
    await expect(
      diagnosisOf(h).diagnoseRun({
        threadId: T,
        runId: 'missing',
        agentId: AGENT_ID,
      }),
    ).rejects.toBeInstanceOf(RunDiagnosisError);
  });
});

describe('explicit non-claims', () => {
  it('never carries a permission, a success, a reversal, a stop or a release', async () => {
    const h = make();
    put(
      h,
      'r-dead',
      [
        ...callEvents('c1', SERVER_TOOL, 1),
        ...callEvents('c2', CLIENT_TOOL, 1, 'a2'),
      ],
      { declared: [CLIENT_TOOL] },
    );
    put(h, 'r-ok', [...textEvents('a1', true, 'ok'), finishedRun('r-ok')], {
      threadId: 'thread-2',
      status: 'finished',
    });
    const results = [
      await diagnoseRun(h, 'r-dead'),
      await diagnoseThread(h),
      await diagnoseThread(h, 'thread-2'),
      await diagnoseRun(h, 'r-ok', 'thread-2'),
    ];
    for (const result of results) {
      expect(result.advisory).toBe(true);
      expect(result.nonClaims).toEqual({
        retryPermitted: 'not_established',
        executorStopped: 'not_established',
        effectsReversed: 'not_established',
        releaseAuthorized: 'not_established',
      });
      // Everything but the explicit non-claims: no word that would grant.
      const { nonClaims: _omit, ...rest } = result;
      void _omit;
      expect(JSON.stringify(rest)).not.toMatch(
        /\b(safe|safely|releasable|released|retry|retried|reversed|authorized|permitted|succeeded)\b/i,
      );
    }
  });
});

describe('what is returned is a description, never an event', () => {
  const walk = (
    value: unknown,
    visit: (object: Record<string, unknown>) => void,
  ) => {
    if (Array.isArray(value)) value.forEach((item) => walk(item, visit));
    else if (value && typeof value === 'object') {
      visit(value as Record<string, unknown>);
      Object.values(value).forEach((item) => walk(item, visit));
    }
  };

  it('carries event TYPES in the plan and no object shaped like an event, a result or an audit record', async () => {
    const h = make();
    put(
      h,
      'r-dead',
      [
        ...textEvents('a1', false, 'partial'),
        ...callEvents('c1', SERVER_TOOL, 1, 'a2'),
        ...callEvents('c2', CLIENT_TOOL, 1, 'a3'),
      ],
      { declared: [CLIENT_TOOL] },
    );
    const run = await diagnoseRun(h, 'r-dead');
    const thread = await diagnoseThread(h);
    for (const result of [run, thread]) {
      walk(result, (object) => {
        // An AG-UI event has a string `type` and a payload field; the
        // diagnosis has descriptions with neither.
        const looksLikeEvent =
          typeof object.type === 'string' &&
          [
            'messageId',
            'toolCallId',
            'delta',
            'content',
            'role',
            'toolCallName',
          ].some((key) => key in object);
        expect(looksLikeEvent, JSON.stringify(object)).toBe(false);
        expect(object).not.toHaveProperty('content');
        expect(object).not.toHaveProperty('delta');
      });
    }
    expect(run.plan.eventTypes.every((type) => typeof type === 'string')).toBe(
      true,
    );
    // The synthetic result for an unknown outcome exists only inside the dry-run.
    expect(JSON.stringify(run)).not.toContain(UNKNOWN_OUTCOME_CONTENT);
    expect(JSON.stringify(run)).not.toContain('unknown-outcome');
  });
});

describe('several unresolved runs on one thread', () => {
  it('diagnoses each in the thread view, and a run view reads only its own', async () => {
    const h = make();
    put(h, 'r-1', reasoningEvents('m1', false));
    put(h, 'r-2', [
      ...textEvents('a1', false, 'p'),
      ...callEvents('c1', SERVER_TOOL, 1, 'a2'),
    ]);
    const thread = await diagnoseThread(h);
    expect(
      thread.unresolved.map((run) => [run.runId, run.classification.class]),
    ).toEqual([
      ['r-1', 'R26b'],
      ['r-2', 'R24'],
    ]);
    const second = await diagnoseRun(h, 'r-2');
    expect(second.runId).toBe('r-2');
    expect(second.classification.class).toBe('R24');
    expect(second.thread.runCount).toBe(2);
  });
});

describe('the evidence digest', () => {
  const identity = {
    threadId: T,
    runId: 'r',
    agentId: AGENT_ID,
    runSeq: 1,
    startedAt: 7,
  };
  const events = [
    runStarted([], [], { threadId: T, runId: 'r' }),
    ...textEvents('a1', true, 'x'),
  ];

  it('is canonical: key order does not matter, content does', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}',
    );
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ a: undefined })).toThrow(TypeError);
    const reordered = events.map(
      (event) =>
        Object.fromEntries(
          Object.entries(event).reverse(),
        ) as unknown as BaseEvent,
    );
    expect(runEvidenceChain(identity, reordered)).toEqual(
      runEvidenceChain(identity, events),
    );
  });

  it('is a chain: the digest of a prefix is the chain value at that length, so an appended audit event is outside it', () => {
    const chain = runEvidenceChain(identity, events);
    expect(chain).toHaveLength(events.length + 1);
    expect(new Set(chain).size).toBe(chain.length);
    for (let k = 0; k <= events.length; k++)
      expect(runEvidenceChain(identity, events.slice(0, k)).at(-1)).toBe(
        chain[k],
      );
    // Anything appended after position k leaves digest(k) unchanged.
    const extended = [...events, ev({ type: 'CUSTOM', name: 'x', value: 1 })];
    expect(runEvidenceChain(identity, extended)[events.length]).toBe(
      chain[events.length],
    );
    // Identity and content both matter.
    expect(
      runEvidenceChain({ ...identity, runId: 'other' }, events).at(-1),
    ).not.toBe(chain.at(-1));
    expect(
      runEvidenceChain(identity, [
        events[0],
        ...textEvents('a1', true, 'y'),
      ]).at(-1),
    ).not.toBe(chain.at(-1));
    expect(chain.every((digest) => /^[0-9a-f]{64}$/.test(digest))).toBe(true);
  });

  it('is stable across reads and changes when the run changes', async () => {
    const h = make();
    put(h, 'r-dead', reasoningEvents('m1', false));
    const first = await diagnoseRun(h, 'r-dead');
    const second = await diagnoseRun(h, 'r-dead');
    expect(second.evidence).toEqual(first.evidence);
    expect(second).toEqual(first);
    h.log.appendEvents(T, 'r-dead', [
      ev({ type: 'CUSTOM', name: 'x', value: 1 }),
    ]);
    const third = await diagnoseRun(h, 'r-dead');
    expect(third.evidence.digest).not.toBe(first.evidence.digest);
    expect(third.evidence.threadDigest).not.toBe(first.evidence.threadDigest);
    expect(third.evidence.eventCount).toBe(first.evidence.eventCount! + 1);
  });

  it('the plan digest binds the evidence and the proposed types', async () => {
    const h = make();
    put(h, 'r-a', reasoningEvents('m1', false), { threadId: 'ta' });
    put(
      h,
      'r-b',
      [
        ...textEvents('a1', false, 'p'),
        ...callEvents('c', SERVER_TOOL, 1, 'a2'),
      ],
      { threadId: 'tb' },
    );
    const a = await diagnoseRun(h, 'r-a', 'ta');
    const b = await diagnoseRun(h, 'r-b', 'tb');
    expect(a.plan.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(a.plan.digest).not.toBe(b.plan.digest);
    expect((await diagnoseRun(h, 'r-a', 'ta')).plan.digest).toBe(a.plan.digest);
  });

  it('confirmEvidence accepts the digest it was given and rejects a stale or malformed one', async () => {
    const h = make();
    put(h, 'r-dead', reasoningEvents('m1', false));
    const d = await diagnoseRun(h, 'r-dead');
    const request = { threadId: T, runId: 'r-dead', agentId: AGENT_ID };
    const service = diagnosisOf(h);
    await expect(
      service.confirmEvidence({ ...request, digest: d.evidence.digest! }),
    ).resolves.toMatchObject({
      current: true,
      digest: d.evidence.digest,
      status: 'running',
      eventCount: d.evidence.eventCount,
    });
    // An event lands after the evidence was read: the old digest is stale.
    h.log.appendEvents(T, 'r-dead', [
      ev({ type: 'CUSTOM', name: 'late', value: 1 }),
    ]);
    await expect(
      service.confirmEvidence({ ...request, digest: d.evidence.digest! }),
    ).resolves.toEqual(
      expect.objectContaining({ current: false, reason: 'evidence_changed' }),
    );
    await expect(
      service.confirmEvidence({ ...request, digest: 'not-a-digest' }),
    ).resolves.toEqual(
      expect.objectContaining({ current: false, reason: 'digest_malformed' }),
    );
    // A run closed after the evidence was read.
    const fresh = await diagnoseRun(h, 'r-dead');
    h.log.appendEvents(T, 'r-dead', [ev({ type: 'RUN_ERROR', message: 'x' })], {
      status: 'interrupted',
    });
    await expect(
      service.confirmEvidence({ ...request, digest: fresh.evidence.digest! }),
    ).resolves.toEqual(
      expect.objectContaining({ current: false, reason: 'evidence_changed' }),
    );
  });
});

describe('the replay dry-run is not verifyEvents alone', () => {
  it('reports the check that fails even when verifyEvents and the reducer pass', async () => {
    const h = make();
    put(h, 'r-dead', [
      ev({ type: 'STATE_SNAPSHOT', snapshot: { a: 1 } }),
      ev({
        type: 'STATE_DELTA',
        delta: [{ op: 'remove', path: '/b' }],
      }),
    ]);
    const d = await diagnoseRun(h, 'r-dead');
    expect(d.replay.current.verifyEvents).toBe('ok');
    expect(d.replay.current.reducer).toBe('ok');
    expect(d.replay.current.compactEvents).toBe('failed');
    expect(d.replay.current.state).toBe('failed');
    expect(d.blockers).toContain('STATE_REPLAY_UNAPPLIABLE');
  });

  it('a thread of terminal runs only that cannot replay is blocked by the thread, and is not reported available', async () => {
    const h = make();
    put(
      h,
      'r-old',
      [
        ev({ type: 'STATE_SNAPSHOT', snapshot: { a: 1 } }),
        ev({
          type: 'STATE_DELTA',
          delta: [{ op: 'replace', path: '/nope', value: 1 }],
        }),
        finishedRun('r-old'),
      ],
      { status: 'finished' },
    );
    const thread = await diagnoseThread(h);
    // Every run is terminal and the rows are consistent; the replay is not.
    expect(thread.unresolved).toEqual([]);
    expect(thread.integrity.state).toBe('consistent');
    expect(thread.replay.current).toMatchObject({
      state: 'failed',
      verifyEvents: 'ok',
      compactEvents: 'failed',
      reasons: ['state_delta_unappliable'],
    });
    expect(thread.blockers).toEqual(['STATE_REPLAY_UNAPPLIABLE']);
    expect(thread.state).toBe('idle');
  });

  it('a long thread skips the thread-level reducer, says so, and blocks on the incomplete replay', async () => {
    const h = make();
    for (let n = 0; n < 6; n++)
      put(
        h,
        `r${n}`,
        [...textEvents(`a${n}`, true, 'x'), finishedRun(`r${n}`)],
        { status: 'finished' },
      );
    put(h, 'r-dead', reasoningEvents('m1', false));
    const service = diagnosisOf(h, { limits: { maxReducerThreadEvents: 10 } });
    const d = await service.diagnoseRun({
      threadId: T,
      runId: 'r-dead',
      agentId: AGENT_ID,
    });
    if (d.outcome !== 'diagnosed') throw new Error('refused');
    expect(d.replay.current.reducer).toBe('skipped_limit');
    expect(d.replay.current.runReducer).toBe('ok');
    expect(d.replay.current.state).toBe('incomplete');
    expect(d.blockers).toContain('REPLAY_CHECK_INCOMPLETE');
  });
});

describe('resource limits fail closed', () => {
  const seedMany = (h: Harness, runs: number) => {
    for (let n = 0; n < runs; n++)
      put(
        h,
        `r${n}`,
        [...textEvents(`a${n}`, true, 'x'), finishedRun(`r${n}`)],
        { status: 'finished' },
      );
  };

  it.each([
    ['maxRuns', { maxRuns: 3 }, 5],
    ['maxThreadEvents', { maxThreadEvents: 10 }, 5],
    ['maxRunEvents', { maxRunEvents: 3 }, 2],
  ] as const)(
    'refuses, with no partial answer, over %s',
    async (limit, limits, runs) => {
      const h = make();
      seedMany(h, runs);
      const service = diagnosisOf(h, { limits });
      const thread = await service.diagnoseThread({
        threadId: T,
        agentId: AGENT_ID,
      });
      expect(thread).toMatchObject({
        outcome: 'refused',
        limit,
        blockers: ['RESOURCE_LIMIT_EXCEEDED'],
      });
      expect(thread).not.toHaveProperty('runs');
      expect(thread).not.toHaveProperty('replay');
      const run = await service.diagnoseRun({
        threadId: T,
        runId: 'r0',
        agentId: AGENT_ID,
      });
      expect(run).toMatchObject({ outcome: 'refused', limit });
      expect(run).not.toHaveProperty('plan');
    },
  );
});

describe('the classification is cross-checked against the runner', () => {
  it("fails closed when the configured client-executable set differs from the runner's", async () => {
    const h = make();
    put(
      h,
      'r-dead',
      [
        ...callEvents('c1', SERVER_TOOL, 1),
        ...callEvents('c2', CLIENT_TOOL, 1, 'a2'),
      ],
      { declared: [CLIENT_TOOL] },
    );
    // The diagnosis is told the client tool is a SERVER tool: it would classify
    // the run differently from the runner (and so describe a different hazard).
    const mismatched = diagnosisOf(h, {
      clientExecutableToolNames: new Set<string>(),
    });
    const d = await mismatched.diagnoseRun({
      threadId: T,
      runId: 'r-dead',
      agentId: AGENT_ID,
    });
    if (d.outcome !== 'diagnosed') throw new Error('refused');
    expect(d.blockers).toContain('FACTS_DISAGREE');
    expect(d.plan.status).toBe('not_possible');
  });
});
