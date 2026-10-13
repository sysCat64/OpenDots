import { afterEach, describe, expect, it } from 'vitest';
import type { BaseEvent } from '@ag-ui/core';
import { RunDiagnosis } from '../src/server/run-diagnosis';
import { UNKNOWN_OUTCOME_CONTENT } from '../src/server/run-rules';
import {
  CLIENT_EXECUTABLE,
  CLIENT_TOOL,
  SERVER_TOOL,
  user,
} from './helpers/event-fixtures';
import {
  AGENT_ID,
  collect,
  createHarness,
  restartRunner,
  runInput,
  startRun,
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

// A + A': the terminal commit and the stream that ends silently. A server tool
// call whose TOOL_CALL_END is durable and whose result is not may have entered
// its executor; whatever ends the run, the call is recorded with the existing
// unknown-outcome result (UNKNOWN_OUTCOME_CONTENT), in the same transaction as
// the terminal event and the status. Never a success, never a failure, never a
// retry, and never an answer for a client (HITL) call or for a call whose
// arguments were still streaming. Scripted producer, throwaway databases, no
// provider.
const T = 't-term';
// The stock finalizer's closer for a stream that ended with no terminal event
// (@copilotkit/shared, pinned by agent-runner-sdk-contract.test.ts).
const isStockError = (content: unknown) => {
  try {
    const parsed = JSON.parse(String(content)) as Record<string, unknown>;
    return (
      parsed.status === 'error' && parsed.reason === 'missing_terminal_event'
    );
  } catch {
    return false;
  }
};
const harnesses: Harness[] = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.cleanup();
});
const make = () => {
  const h = createHarness();
  harnesses.push(h);
  return h;
};
const ev = (value: Record<string, unknown>) => value as unknown as BaseEvent;
const errored = ev({
  type: 'RUN_ERROR',
  message: 'the provider failed after the call was complete',
  code: 'PROVIDER_FAILED',
});

type Stored = Record<string, unknown>;
const durable = (h: Harness, runId = 'r1') =>
  h.log.runEvents(T, runId).map((s) => s.event as unknown as Stored);
const shape = (h: Harness, runId = 'r1') =>
  durable(h, runId).map(
    (e) => `${String(e.type)}${e.toolCallId ? ':' + String(e.toolCallId) : ''}`,
  );
const resultOf = (h: Harness, id: string, runId = 'r1') =>
  durable(h, runId).find(
    (e) => e.type === 'TOOL_CALL_RESULT' && e.toolCallId === id,
  );
const markerFor = (id: string) => ({
  type: 'TOOL_CALL_RESULT',
  toolCallId: id,
  messageId: `${id}-unknown-outcome`,
  role: 'tool',
  content: UNKNOWN_OUTCOME_CONTENT,
});

async function drive(
  h: Harness,
  script: Array<Record<string, unknown> | (() => void)>,
  tools: string[] = [],
  runId = 'r1',
) {
  const agent = new ScriptedAgent(() => script as never);
  return collect(
    startRun(h.runner, agent, runInput(T, runId, [user(`u-${runId}`)], tools)),
  );
}

describe('A: a terminal event committed beside an unresolved server call', () => {
  it('TS-A1 records the marker with a producer RUN_ERROR, in one commit, status error', async () => {
    const h = make();
    const appends: string[][] = [];
    h.log.beforeAppend = (events) =>
      appends.push(events.map((e) => String(e.type)));
    await drive(h, [...toolCall('c1', SERVER_TOOL, 'a1'), errored]);
    expect(shape(h)).toEqual([
      'RUN_STARTED',
      'TOOL_CALL_START:c1',
      'TOOL_CALL_ARGS:c1',
      'TOOL_CALL_END:c1',
      'TOOL_CALL_RESULT:c1',
      'RUN_ERROR',
    ]);
    expect(resultOf(h, 'c1')).toMatchObject(markerFor('c1'));
    // The producer's own terminal is kept as it was, code included.
    expect(durable(h).at(-1)).toMatchObject({
      type: 'RUN_ERROR',
      code: 'PROVIDER_FAILED',
    });
    expect(h.log.getRun(T, 'r1')?.status).toBe('error');
    // The marker and the terminal event are ONE append.
    expect(appends.at(-1)).toEqual(['TOOL_CALL_RESULT', 'RUN_ERROR']);
    expect(h.log.checkInvariants()).toEqual([]);
  });

  it('records one marker per unresolved server call, in call order, and leaves a durable result alone', async () => {
    const h = make();
    await drive(h, [
      ...toolCall('c1', SERVER_TOOL, 'a1'),
      ...toolCall('c2', SERVER_TOOL, 'a1'),
      toolResult('c2', '{"page":"real"}'),
      ...toolCall('c3', SERVER_TOOL, 'a1'),
      errored,
    ]);
    const results = durable(h).filter((e) => e.type === 'TOOL_CALL_RESULT');
    expect(results.map((r) => r.toolCallId)).toEqual(['c2', 'c1', 'c3']);
    expect(resultOf(h, 'c2')).toMatchObject({ content: '{"page":"real"}' });
    expect(resultOf(h, 'c1')?.content).toBe(UNKNOWN_OUTCOME_CONTENT);
    expect(resultOf(h, 'c3')?.content).toBe(UNKNOWN_OUTCOME_CONTENT);
    expect(shape(h).at(-1)).toBe('RUN_ERROR');
  });

  it('TS-A3 leaves a client (HITL) call unanswered and a call with open arguments without a result', async () => {
    const h = make();
    await drive(
      h,
      [
        ...toolCall('review-1', CLIENT_TOOL, 'a1'),
        {
          type: 'TOOL_CALL_START',
          toolCallId: 'open-1',
          toolCallName: SERVER_TOOL,
          parentMessageId: 'a1',
        },
        { type: 'TOOL_CALL_ARGS', toolCallId: 'open-1', delta: '{"ti' },
        errored,
      ],
      [CLIENT_TOOL],
    );
    // Neither is an END'd server call: nothing is written for them.
    expect(durable(h).filter((e) => e.type === 'TOOL_CALL_RESULT')).toEqual([]);
    expect(shape(h).at(-1)).toBe('RUN_ERROR');
    expect(h.log.getRun(T, 'r1')?.status).toBe('error');
  });

  it('TS-A3 marks only the server call when a client call is pending beside it', async () => {
    const h = make();
    await drive(
      h,
      [
        ...toolCall('review-1', CLIENT_TOOL, 'a1'),
        ...toolCall('c1', SERVER_TOOL, 'a1'),
        finished({ threadId: T, runId: 'r1' } as never),
      ],
      [CLIENT_TOOL],
    );
    expect(resultOf(h, 'c1')?.content).toBe(UNKNOWN_OUTCOME_CONTENT);
    expect(resultOf(h, 'review-1')).toBeUndefined();
    expect(h.log.getRun(T, 'r1')?.status).toBe('finished');
  });

  it('a declared client tool that the server does not allow on the client is a server call', async () => {
    const h = make();
    // The client declares it; the server-owned set does not list it.
    await drive(
      h,
      [...toolCall('x1', 'client_only_tool', 'a1'), errored],
      ['client_only_tool'],
    );
    expect(resultOf(h, 'x1')?.content).toBe(UNKNOWN_OUTCOME_CONTENT);
  });

  it('TS-A4 records the marker when the producer finishes the run over an unresolved server call', async () => {
    const h = make();
    const published = await drive(h, [
      ...textMessage('m1', 'I created the page.'),
      ...toolCall('c1', SERVER_TOOL, 'a1'),
      finished({ threadId: T, runId: 'r1' } as never),
    ]);
    expect(shape(h).slice(-2)).toEqual(['TOOL_CALL_RESULT:c1', 'RUN_FINISHED']);
    expect(resultOf(h, 'c1')?.content).toBe(UNKNOWN_OUTCOME_CONTENT);
    expect(h.log.getRun(T, 'r1')?.status).toBe('finished');
    expect(published.map((e) => e.type).slice(-2)).toEqual([
      'TOOL_CALL_RESULT',
      'RUN_FINISHED',
    ]);
  });

  it('TS-A4 the marker is not readable as a success by any facts or diagnosis consumer', async () => {
    const h = make();
    await drive(h, [
      ...textMessage('m1', 'I created the page.'),
      ...toolCall('c1', SERVER_TOOL, 'a1'),
      finished({ threadId: T, runId: 'r1' } as never),
    ]);
    // What the model is told, verbatim.
    const content = JSON.parse(String(resultOf(h, 'c1')?.content)) as Record<
      string,
      unknown
    >;
    expect(content.outcome).toBe('unknown');
    expect(Object.keys(content).sort()).toEqual([
      'message',
      'outcome',
      'reason',
    ]);
    expect(String(content.message)).toContain('may or may not have run');
    for (const word of ['success', 'ok', 'completed', 'created'])
      expect(JSON.stringify(content).toLowerCase()).not.toContain(word);
    // C4c facts.
    const attempt = h.runner.facts.attemptFacts({
      threadId: T,
      runId: 'r1',
      agentId: AGENT_ID,
    });
    expect(attempt.toolCalls).toHaveLength(1);
    expect(attempt.toolCalls[0]).toMatchObject({
      side: 'server',
      resultProvenance: 'unknown_outcome',
      outcomeKnown: false,
      executorEntry: 'possible',
    });
    expect(attempt.summary).toMatchObject({
      serverOutcomesKnown: 0,
      serverOutcomesUnknown: 1,
    });
    const terminal = h.runner.facts.terminalResult({
      threadId: T,
      runId: 'r1',
      agentId: AGENT_ID,
    });
    expect(terminal).toMatchObject({
      available: true,
      status: 'finished',
      unknownOutcomeCalls: 1,
    });
    // R-DIAG.
    const diagnosis = await new RunDiagnosis({
      log: h.log,
      runner: h.runner,
      clientExecutableToolNames: CLIENT_EXECUTABLE,
    }).diagnoseRun({ threadId: T, runId: 'r1', agentId: AGENT_ID });
    if (diagnosis.outcome !== 'diagnosed') throw new Error('refused');
    expect(diagnosis.toolLifecycle.calls[0].knowledge).toBe('unknown');
    const codes = diagnosis.findings.map((f) => f.code);
    expect(codes).toContain('server_outcome_unknown_marker');
    expect(codes).not.toContain('terminal_server_outcome_unrecorded');
    expect(diagnosis.toolLifecycle.calls.map((c) => c.knowledge)).not.toContain(
      'known',
    );
  });

  it('TS-A5 publishes exactly what it committed, the marker before the terminal', async () => {
    const h = make();
    const published = await drive(h, [
      ...toolCall('c1', SERVER_TOOL, 'a1'),
      ...toolCall('c2', SERVER_TOOL, 'a1'),
      errored,
    ]);
    expect(published).toEqual(durable(h));
    expect(published.map((e) => e.type)).toEqual([
      'RUN_STARTED',
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
      'TOOL_CALL_RESULT',
      'TOOL_CALL_RESULT',
      'RUN_ERROR',
    ]);
  });

  it('a run with every call resolved commits its terminal event alone', async () => {
    const h = make();
    const appends: string[][] = [];
    h.log.beforeAppend = (events) =>
      appends.push(events.map((e) => String(e.type)));
    await drive(h, [
      ...toolCall('c1', SERVER_TOOL, 'a1'),
      toolResult('c1'),
      finished({ threadId: T, runId: 'r1' } as never),
    ]);
    expect(appends.at(-1)).toEqual(['RUN_FINISHED']);
    expect(
      durable(h).filter((e) => e.type === 'TOOL_CALL_RESULT'),
    ).toHaveLength(1);
  });

  it('commits the marker and the terminal event atomically: a failed terminal commit leaves no marker', async () => {
    const h = make();
    // A storage fault raised inside the transaction, at the terminal row. The
    // marker row is inserted first; the whole append must roll back.
    h.log.ensureSchema();
    h.db.exec(`CREATE TRIGGER fail_terminal BEFORE INSERT ON conversation_events
      WHEN NEW.eventType = 'RUN_ERROR'
      BEGIN SELECT RAISE(ABORT, 'injected terminal write fault'); END`);
    // The producer's stream may end in an error; what matters is the log.
    await drive(h, [...toolCall('c1', SERVER_TOOL, 'a1'), errored]).catch(
      () => undefined,
    );
    const committed = h.db
      .prepare(
        'SELECT eventType FROM conversation_events WHERE threadId = ? AND runId = ? ORDER BY seq',
      )
      .all(T, 'r1')
      .map((row) => String(row.eventType));
    expect(committed).toEqual([
      'RUN_STARTED',
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
    ]);
    expect(h.log.getRun(T, 'r1')?.status).toBe('running');
    // The fault clears; recovery (a restart) closes the run with the same
    // marker, never with a result of its own invention.
    h.db.exec('DROP TRIGGER fail_terminal');
    const fresh = restartRunner(h);
    const ready = await fresh.runner.ready();
    expect(ready.recovered.map((r) => r.runId)).toEqual(['r1']);
    expect(resultOf(h, 'c1')?.content).toBe(UNKNOWN_OUTCOME_CONTENT);
  });
});

describe("A': a stream that ends with no terminal event", () => {
  it('TS-AP1 records the marker, not the stock error closer, when the agent aborts itself', async () => {
    const h = make();
    const agent = new ScriptedAgent(
      () => [...toolCall('c1', SERVER_TOOL, 'a1'), HANG] as never,
    );
    const done = collect(
      startRun(h.runner, agent, runInput(T, 'r1', [user('u1')])),
    );
    await until(
      () => shape(h).includes('TOOL_CALL_END:c1'),
      'END of c1 durable',
    );
    // Not runner.stop(): the agent's own abort (its timer, its watcher).
    agent.abortRun();
    await done;
    expect(resultOf(h, 'c1')?.content).toBe(UNKNOWN_OUTCOME_CONTENT);
    expect(isStockError(resultOf(h, 'c1')?.content)).toBe(false);
    expect(shape(h).at(-1)).toBe('RUN_ERROR');
    expect(h.log.getRun(T, 'r1')?.status).toBe('error');
  });

  it('keeps the stock closer for a call whose arguments never completed, beside a marker for an ended one', async () => {
    const h = make();
    const agent = new ScriptedAgent(
      () =>
        [
          ...toolCall('c1', SERVER_TOOL, 'a1'),
          {
            type: 'TOOL_CALL_START',
            toolCallId: 'open-1',
            toolCallName: SERVER_TOOL,
            parentMessageId: 'a1',
          },
          { type: 'TOOL_CALL_ARGS', toolCallId: 'open-1', delta: '{"ti' },
          HANG,
        ] as never,
    );
    const done = collect(
      startRun(h.runner, agent, runInput(T, 'r1', [user('u1')])),
    );
    await until(
      () => shape(h).includes('TOOL_CALL_ARGS:open-1'),
      'open arguments durable',
    );
    agent.abortRun();
    await done;
    expect(resultOf(h, 'c1')?.content).toBe(UNKNOWN_OUTCOME_CONTENT);
    expect(isStockError(resultOf(h, 'open-1')?.content)).toBe(true);
  });

  it('closes a pending client (HITL) call exactly as before, with no marker', async () => {
    const h = make();
    const agent = new ScriptedAgent(
      () => [...toolCall('review-1', CLIENT_TOOL, 'a1'), HANG] as never,
    );
    const done = collect(
      startRun(h.runner, agent, runInput(T, 'r1', [user('u1')], [CLIENT_TOOL])),
    );
    await until(
      () => shape(h).includes('TOOL_CALL_END:review-1'),
      'END durable',
    );
    agent.abortRun();
    await done;
    expect(resultOf(h, 'review-1')?.content).not.toBe(UNKNOWN_OUTCOME_CONTENT);
    expect(isStockError(resultOf(h, 'review-1')?.content)).toBe(true);
  });

  it('TS-AP5 a user stop still records the marker and status stopped', async () => {
    const h = make();
    const agent = new ScriptedAgent(
      () => [...toolCall('c1', SERVER_TOOL, 'a1'), HANG] as never,
    );
    const done = collect(
      startRun(h.runner, agent, runInput(T, 'r1', [user('u1')])),
    );
    await until(() => shape(h).includes('TOOL_CALL_END:c1'), 'END durable');
    await h.runner.stop({ threadId: T, runId: 'r1' });
    await done;
    expect(resultOf(h, 'c1')?.content).toBe(UNKNOWN_OUTCOME_CONTENT);
    expect(h.log.getRun(T, 'r1')?.status).toBe('stopped');
  });

  it('a stream that ends with no terminal and nothing unresolved gains no result', async () => {
    const h = make();
    const agent = new ScriptedAgent(
      () => [...textMessage('m1', 'partial'), HANG] as never,
    );
    const done = collect(
      startRun(h.runner, agent, runInput(T, 'r1', [user('u1')])),
    );
    await until(() => shape(h).length >= 4, 'text durable');
    agent.abortRun();
    await done;
    expect(durable(h).filter((e) => e.type === 'TOOL_CALL_RESULT')).toEqual([]);
  });
});
