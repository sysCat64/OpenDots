import { afterEach, describe, expect, it } from 'vitest';
import {
  CLIENT_TOOL,
  SERVER_TOOL,
  assistant,
  toolMessage,
  user,
} from './helpers/event-fixtures';
import {
  AGENT_ID,
  committedTypes,
  createHarness,
  restartRunner,
  runInput,
  runToEnd,
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

// L3: a server tool executes once and its result is durable; a pending client
// (HITL) tool survives a restart and is approved afterwards. Offline.
const harnesses: Harness[] = [];
const make = () => {
  const harness = createHarness();
  harnesses.push(harness);
  return harness;
};
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.cleanup();
});

describe('a server tool', () => {
  it('executes once, and its call and result are durable and in the view', async () => {
    const h = make();
    let executions = 0;
    const agent = new ScriptedAgent((input) => [
      ...toolCall('c1', SERVER_TOOL, 'a1'),
      () => {
        executions += 1;
      },
      toolResult('c1', '{"page":"x"}'),
      ...textMessage('a2', 'done'),
      finished(input),
    ]);
    const events = await runToEnd(
      h.runner,
      agent,
      runInput('t1', 'r1', [user('u1')]),
    );
    expect(executions).toBe(1);
    expect(typesOf(events)).toContain('TOOL_CALL_RESULT');
    expect(h.log.heldToolCallIds('t1')).toEqual(new Set(['c1']));
    expect(h.log.getRun('t1', 'r1')?.status).toBe('finished');
    const view = await h.runner.messagesFor('t1');
    expect(view.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(view.find((m) => m.role === 'tool')).toMatchObject({
      toolCallId: 'c1',
      content: '{"page":"x"}',
    });
    // A restarted process replays it without executing anything.
    const fresh = restartRunner(h);
    await fresh.runner.ready();
    expect(executions).toBe(1);
  });
});

describe('the producer is held back while an event is persisted (A1 fence)', () => {
  // The pinned @ag-ui/client 0.0.59 pipeline does not wait for a subscriber
  // (onEvent) while the producer goes on, so persisting from onEvent let a tool
  // executor start before the TOOL_CALL_END that announced it was durable. The
  // runner now persists inside the producer's own push (see DurableFenceTap), so
  // the whole call is durable when the executor enters. The full ordering and
  // failure matrix is in durable-runner-fence.test.ts and, for the production
  // DotAgent, durable-runner-dotagent-fence.test.ts.
  it('has TOOL_CALL_END durable when a tool executor starts', async () => {
    const h = make();
    const observer = h.observer();
    let endDurableWhenExecutorStarted: boolean | undefined;
    const agent = new ScriptedAgent((input) => [
      ...toolCall('c1', SERVER_TOOL, 'a1'),
      () => {
        endDurableWhenExecutorStarted = committedTypes(
          observer,
          't1',
          'r1',
        ).includes('TOOL_CALL_END');
      },
      toolResult('c1'),
      finished(input),
    ]);
    await runToEnd(h.runner, agent, runInput('t1', 'r1', [user('u1')]));
    expect(endDurableWhenExecutorStarted).toBe(true);
  });
});

describe('a pending client (HITL) tool', () => {
  const pendingReview = () =>
    new ScriptedAgent((input) => [
      ...toolCall(
        'review-1',
        CLIENT_TOOL,
        'a1',
        '{"title":"t","content":"c","spaceId":"s"}',
      ),
      finished(input),
    ]);

  it('finishes the run with the call still pending, and ready() leaves it alone', async () => {
    const h = make();
    const events = await runToEnd(
      h.runner,
      pendingReview(),
      runInput('t1', 'r1', [user('u1')], [CLIENT_TOOL]),
    );
    expect(typesOf(events).at(-1)).toBe('RUN_FINISHED');
    expect(typesOf(events)).not.toContain('TOOL_CALL_RESULT');
    expect(h.log.heldToolCallIds('t1').size).toBe(0);
    const fresh = restartRunner(h);
    const result = await fresh.runner.ready();
    expect(result.recovered).toEqual([]);
    expect(h.log.getRun('t1', 'r1')?.status).toBe('finished');
  });

  it('is approved after a restart: the next run carries the human result and is accepted', async () => {
    const h = make();
    await runToEnd(
      h.runner,
      pendingReview(),
      runInput('t1', 'r1', [user('u1')], [CLIENT_TOOL]),
    );
    const fresh = restartRunner(h);
    await fresh.runner.ready();
    const approval = new ScriptedAgent((input) => [
      ...textMessage('a2', 'saved'),
      finished(input),
    ]);
    const events = await runToEnd(
      fresh.runner,
      approval,
      runInput(
        't1',
        'r2',
        [
          user('u1'),
          assistant('a1', 'review-1'),
          toolMessage('tm1', 'review-1'),
        ],
        [CLIENT_TOOL],
      ),
      AGENT_ID,
    );
    expect(typesOf(events).at(-1)).toBe('RUN_FINISHED');
    expect(approval.stats.invocations).toBe(1);
    expect(committedTypes(h.db, 't1', 'r2')[0]).toBe('RUN_STARTED');
    // The human's result is part of the stored input of the approving run.
    const start = h.log.runEvents('t1', 'r2')[0].event as unknown as {
      input: { messages: Array<{ id: string; role: string }> };
    };
    expect(start.input.messages.map((m) => m.id)).toEqual(['tm1']);
  });
});
