import { afterEach, describe, expect, it } from 'vitest';
import { UNKNOWN_OUTCOME_CONTENT } from '../src/server/run-rules';
import { SERVER_TOOL, user } from './helpers/event-fixtures';
import {
  collect,
  committedTypes,
  createHarness,
  runInput,
  startRun,
  typesOf,
  until,
  type Harness,
} from './helpers/runner-harness';
import {
  HANG,
  ScriptedAgent,
  createGate,
  finished,
  textMessage,
  toolCall,
} from './helpers/scripted-agent';

// L5: stopping a run. A user stop keeps the partial text, closes what is open,
// ends with RUN_FINISHED and the status `stopped`, and is never an error.
const harnesses: Harness[] = [];
const make = () => {
  const harness = createHarness();
  harnesses.push(harness);
  return harness;
};
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.cleanup();
});

const streamingText = () =>
  new ScriptedAgent(() => [
    { type: 'TEXT_MESSAGE_START', messageId: 'a1', role: 'assistant' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: 'partial ' },
    HANG,
  ]);

describe('stopping an ordinary streaming text run', () => {
  it('keeps the partial text, closes it once and ends with RUN_FINISHED, not RUN_ERROR', async () => {
    const h = make();
    const agent = streamingText();
    const events = collect(
      startRun(h.runner, agent, runInput('t1', 'r1', [user('u1')])),
    );
    await until(() =>
      committedTypes(h.db, 't1', 'r1').includes('TEXT_MESSAGE_CONTENT'),
    );
    expect(await h.runner.isRunning({ threadId: 't1' })).toBe(true);
    expect(await h.runner.stop({ threadId: 't1', runId: 'r1' })).toBe(true);
    expect(await h.runner.isRunning({ threadId: 't1' })).toBe(false);
    const observed = await events;
    expect(typesOf(observed)).toEqual([
      'RUN_STARTED',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'RUN_FINISHED',
    ]);
    expect(typesOf(observed)).not.toContain('RUN_ERROR');
    expect(h.log.getRun('t1', 'r1')?.status).toBe('stopped');
    expect(h.log.checkInvariants()).toEqual([]);
    expect(agent.stats.aborts).toBe(1);
    const view = await h.runner.messagesFor('t1');
    expect(view.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'partial ',
    });
  });

  it('aborts the agent exactly once however often stop is called', async () => {
    const h = make();
    const agent = streamingText();
    const events = collect(
      startRun(h.runner, agent, runInput('t1', 'r1', [user('u1')])),
    );
    await until(() =>
      committedTypes(h.db, 't1', 'r1').includes('TEXT_MESSAGE_CONTENT'),
    );
    const answers = await Promise.all([
      h.runner.stop({ threadId: 't1' }),
      h.runner.stop({ threadId: 't1' }),
      h.runner.stop({ threadId: 't1', runId: 'r1' }),
    ]);
    expect(answers).toEqual([true, false, false]);
    await events;
    expect(agent.stats.aborts).toBe(1);
  });

  it('returns false for nothing to stop, a finished run and the wrong run id', async () => {
    const h = make();
    expect(await h.runner.stop({ threadId: 'nobody' })).toBe(false);
    const agent = streamingText();
    const events = collect(
      startRun(h.runner, agent, runInput('t1', 'r1', [user('u1')])),
    );
    await until(() =>
      committedTypes(h.db, 't1', 'r1').includes('TEXT_MESSAGE_CONTENT'),
    );
    expect(await h.runner.stop({ threadId: 't1', runId: 'other' })).toBe(false);
    expect(agent.stats.aborts).toBe(0);
    await h.runner.stop({ threadId: 't1' });
    await events;
    expect(await h.runner.stop({ threadId: 't1' })).toBe(false);
  });

  it('writes exactly one closer and one terminal event', async () => {
    // The stock finalizer is the only author of the stop terminal event.
    const h = make();
    const agent = streamingText();
    const events = collect(
      startRun(h.runner, agent, runInput('t1', 'r1', [user('u1')])),
    );
    await until(() =>
      committedTypes(h.db, 't1', 'r1').includes('TEXT_MESSAGE_CONTENT'),
    );
    await h.runner.stop({ threadId: 't1' });
    const observed = await events;
    expect(observed.filter((e) => e.type === 'RUN_FINISHED')).toHaveLength(1);
    expect(observed.filter((e) => e.type === 'TEXT_MESSAGE_END')).toHaveLength(
      1,
    );
  });
});

describe('stopping during an in-flight tool', () => {
  it('closes the unresolved server call with the unknown outcome (never a stock stopped result) and finishes the run as stopped', async () => {
    const h = make();
    const agent = new ScriptedAgent(() => [
      ...textMessage('a1', 'looking'),
      ...toolCall('c1', SERVER_TOOL, 'a2'),
      HANG,
    ]);
    const events = collect(
      startRun(h.runner, agent, runInput('t1', 'r1', [user('u1')])),
    );
    await until(() =>
      committedTypes(h.db, 't1', 'r1').includes('TOOL_CALL_END'),
    );
    await h.runner.stop({ threadId: 't1', runId: 'r1' });
    const observed = await events;
    expect(typesOf(observed).slice(-2)).toEqual([
      'TOOL_CALL_RESULT',
      'RUN_FINISHED',
    ]);
    const result = observed.find(
      (e) => e.type === 'TOOL_CALL_RESULT',
    ) as unknown as {
      content: string;
    };
    // A stop never proves that a server tool did not run: the call is closed with
    // the same unknown-outcome result recovery writes, and the run is `stopped`.
    expect(result.content).toBe(UNKNOWN_OUTCOME_CONTENT);
    expect(h.log.getRun('t1', 'r1')?.status).toBe('stopped');
  });
});

describe('a run that ends without a terminal event and without a stop', () => {
  it('is finalized as an error (the DotAgent timeout path)', async () => {
    const h = make();
    const agent = new ScriptedAgent(() => [
      { type: 'TEXT_MESSAGE_START', messageId: 'a1', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: 'cut ' },
    ]);
    const observed = await collect(
      startRun(h.runner, agent, runInput('t1', 'r1', [user('u1')])),
    );
    expect(typesOf(observed).slice(-2)).toEqual([
      'TEXT_MESSAGE_END',
      'RUN_ERROR',
    ]);
    expect(observed.at(-1)).toMatchObject({ code: 'INCOMPLETE_STREAM' });
    expect(h.log.getRun('t1', 'r1')?.status).toBe('error');
  });

  it('is finalized as an error with the failure message when the agent throws', async () => {
    const h = make();
    const agent = new ScriptedAgent(() => [
      ...textMessage('a1', 'x'),
      () => {
        throw new Error('model exploded');
      },
    ]);
    const observed = await collect(
      startRun(h.runner, agent, runInput('t1', 'r1', [user('u1')])),
    );
    expect(observed.at(-1)).toMatchObject({
      type: 'RUN_ERROR',
      message: 'model exploded',
    });
    expect(h.log.getRun('t1', 'r1')?.status).toBe('error');
  });
});

describe('stopAll', () => {
  it('stops and finalizes every active run inside the deadline, leaving none running', async () => {
    const h = make();
    const runs = ['tA', 'tB', 'tC'].map((threadId) =>
      collect(
        startRun(
          h.runner,
          streamingText(),
          runInput(threadId, 'r1', [user(`u-${threadId}`)]),
        ),
      ),
    );
    await until(
      () =>
        ['tA', 'tB', 'tC'].every((t) =>
          committedTypes(h.db, t, 'r1').includes('TEXT_MESSAGE_CONTENT'),
        ),
      'three active runs',
    );
    expect(await h.runner.stopAll(5000)).toEqual({ stopped: 3, remaining: 0 });
    await Promise.all(runs);
    expect(h.log.runningRuns()).toEqual([]);
    expect(h.log.runs('tA')[0].status).toBe('stopped');
    expect(h.log.checkInvariants()).toEqual([]);
  });

  it('reports a run that ignores the stop and leaves it running for recovery', async () => {
    const h = make();
    const stubborn = createGate();
    const agent = new ScriptedAgent((input) => [
      ...textMessage('a1', 'x'),
      stubborn,
      finished(input),
    ]);
    const events = collect(
      startRun(h.runner, agent, runInput('t1', 'r1', [user('u1')])),
    );
    await until(() =>
      committedTypes(h.db, 't1', 'r1').includes('TEXT_MESSAGE_END'),
    );
    expect(await h.runner.stopAll(30)).toEqual({ stopped: 0, remaining: 1 });
    expect(h.log.getRun('t1', 'r1')?.status).toBe('running');
    stubborn.open();
    await events;
  });
});
