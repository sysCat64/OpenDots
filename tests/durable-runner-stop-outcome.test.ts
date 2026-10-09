import { afterEach, describe, expect, it } from 'vitest';
import { ConversationLog } from '../src/server/conversation-log';
import { DurableAgentRunner } from '../src/server/durable-runner';
import { UNKNOWN_OUTCOME_CONTENT } from '../src/server/run-rules';
import {
  CLIENT_EXECUTABLE,
  CLIENT_TOOL,
  SERVER_TOOL,
  user,
} from './helpers/event-fixtures';
import {
  THREAD,
  createWorld,
  durable,
  providerHistory,
  readWitness,
  textReply,
  toolReply,
  type World,
} from './helpers/dot-stop-world';
import { ProbeLog } from './helpers/probe-log';
import {
  collect,
  committedTypes,
  runInput,
  startRun,
  until,
} from './helpers/runner-harness';
import {
  HANG,
  ScriptedAgent,
  finished,
  textMessage,
  toolCall,
} from './helpers/scripted-agent';
import { createThrowawayDatabase } from './helpers/throwaway-db';

// Stop outcome. The run's lifecycle (`stopped`) and the outcome of a server tool
// are independent: a stop never proves that a server tool did not run. An
// unresolved server call (TOOL_CALL_END durable, no result) is recorded with the
// existing unknown-outcome result; a durable real result is kept; client (HITL)
// calls keep the stock stop result. Real DotAgent behind the A1 runner, a separate
// SQLite witness for executor entry and the committed side effect, deterministic
// barriers (a model-request hook, a storage-commit hook, an executor hook).
const STOCK_STOPPED =
  '{"status":"stopped","reason":"stop_requested","message":"Run stopped by user"}';
const worlds: World[] = [];
afterEach(() => {
  while (worlds.length) worlds.pop()!.close();
});

type Stop =
  | { kind: 'model-request'; n: number }
  | { kind: 'append'; type: string }
  | { kind: 'executor'; point: 'entered' | 'committed'; n: number };

async function stopped(stop: Stop, options: { twoTools?: boolean } = {}) {
  const world = createWorld();
  worlds.push(world);
  world.setScript((n) =>
    n === 1
      ? toolReply(1)
      : n === 2 && options.twoTools
        ? toolReply(2)
        : textReply('Done.'),
  );
  let fired = false;
  const stopNow = () => {
    if (fired) return;
    fired = true;
    void world.runner.stop({ threadId: THREAD, runId: 'r1' });
  };
  if (stop.kind === 'model-request')
    world.hooks.onModelRequest = (n) => n === stop.n && stopNow();
  else if (stop.kind === 'executor')
    world.hooks.onExecutor = (point, n) =>
      point === stop.point && n === stop.n && stopNow();
  else
    world.log.afterAppend = (stored) => {
      if (stored.some((s) => s.eventType === stop.type)) stopNow();
    };
  const published = await world.runTurn('r1', [
    user('u1', 'Create a page called Notes.'),
  ]);
  world.hooks.onModelRequest = undefined;
  world.hooks.onExecutor = undefined;
  world.log.afterAppend = undefined;
  return { world, published, run: durable(world, 'r1') };
}

const resultOf = (run: ReturnType<typeof durable>, id: string) =>
  run.results.find((r) => r.toolCallId === id)?.content;

// What must hold after every stop, whatever the window.
async function stoppedRunInvariants(
  world: World,
  published: unknown[],
  run: ReturnType<typeof durable>,
) {
  expect(run.status).toBe('stopped');
  expect(run.types.at(-1)).toBe('RUN_FINISHED');
  expect(run.types.filter((t) => t === 'RUN_FINISHED')).toHaveLength(1);
  expect(published.map((e) => (e as { type: string }).type)).toEqual(run.types);
  expect(world.log.checkInvariants()).toEqual([]);
  // One result per call, paired with a call that exists.
  const starts = run.events
    .filter((e) => e.type === 'TOOL_CALL_START')
    .map((e) => String(e.toolCallId));
  const resultIds = run.results.map((r) => r.toolCallId);
  expect(new Set(resultIds).size).toBe(resultIds.length);
  for (const id of resultIds) expect(starts).toContain(id);
  // The derived view agrees with the events and is cached.
  const before = await world.runner.messagesFor(THREAD);
  expect(
    (await world.log.readMessages(THREAD, { runActive: false })).source,
  ).toBe('cache');
  world.db.exec(
    `DELETE FROM conversation_messages WHERE threadId = '${THREAD}'`,
  );
  const derived = await world.log.readMessages(THREAD, { runActive: false });
  expect(derived.source).not.toBe('cache');
  expect(derived.messages).toEqual(before);
  // Restart and ready() twice: nothing is added, nothing is run.
  const requests = world.requests.length;
  const witness = readWitness(world.witnessDb);
  const eventCount = world.log.threadEvents(THREAD).length;
  for (let i = 0; i < 2; i++) {
    const fresh = world.restartRunner();
    const ready = await fresh.runner.ready();
    expect(ready.recovered).toEqual([]);
    expect(ready.deferred).toEqual([]);
  }
  expect(world.log.threadEvents(THREAD).length).toBe(eventCount);
  expect(world.requests.length).toBe(requests);
  expect(readWitness(world.witnessDb)).toEqual(witness);
  expect(new ConversationLog(world.observer).getRun(THREAD, 'r1')?.status).toBe(
    'stopped',
  );
}

// The next turn through the same runner: what the provider is told and whether
// anything runs. The model here answers with text, so any executor entry would
// have to come from the runner itself.
async function nextTurn(world: World) {
  const view = await world.runner.messagesFor(THREAD);
  world.setScript(() => textReply('Understood.'));
  const requests = world.requests.length;
  const witness = readWitness(world.witnessDb);
  const pages = world.pages();
  await world.runTurn('r2', [...view, user('u2', 'Did the page get created?')]);
  const sent = world.requests.slice(requests);
  expect(sent).toHaveLength(1);
  const history = providerHistory(sent[0].body);
  expect(history.valid).toBe(true);
  expect(durable(world, 'r2').status).toBe('finished');
  expect(readWitness(world.witnessDb)).toEqual(witness);
  expect(world.pages()).toEqual(pages);
  return history.toolMessages;
}

const sees = (messages: Array<{ content: string }>) =>
  messages.map((m) => m.content).join('\n');

describe('stopping a run on the real DotAgent', () => {
  it('S0: before any tool call is emitted, nothing is fabricated', async () => {
    const { world, published, run } = await stopped({
      kind: 'model-request',
      n: 1,
    });
    await stoppedRunInvariants(world, published, run);
    expect(run.types).toEqual(['RUN_STARTED', 'RUN_FINISHED']);
    expect(run.results).toEqual([]);
    expect(readWitness(world.witnessDb)).toEqual([]);
    expect(await nextTurn(world)).toEqual([]);
  });

  it('S0b: during incomplete arguments no executor ran, so the stock closer stays accurate', async () => {
    const { world, published, run } = await stopped({
      kind: 'append',
      type: 'TOOL_CALL_ARGS',
    });
    await stoppedRunInvariants(world, published, run);
    expect(readWitness(world.witnessDb)).toEqual([]);
    expect(world.pages()).toEqual([]);
    expect(resultOf(run, 'call-1')).toBe(STOCK_STOPPED);
    await nextTurn(world);
  });

  it('S1: END durable, executor not entered: unknown outcome, no side effect', async () => {
    const { world, published, run } = await stopped({
      kind: 'append',
      type: 'TOOL_CALL_END',
    });
    await stoppedRunInvariants(world, published, run);
    expect(readWitness(world.witnessDb)).toEqual([]);
    expect(world.pages()).toEqual([]);
    expect(resultOf(run, 'call-1')).toBe(UNKNOWN_OUTCOME_CONTENT);
    const seen = sees(await nextTurn(world));
    expect(seen).toContain('may or may not have run');
  });

  for (const point of ['entered', 'committed'] as const)
    it(`S${point === 'entered' ? 2 : 3}: stop inside the executor (${point}): the side effect exists, the outcome is unknown, nothing is retried`, async () => {
      const { world, published, run } = await stopped({
        kind: 'executor',
        point,
        n: 1,
      });
      await stoppedRunInvariants(world, published, run);
      expect(readWitness(world.witnessDb)).toEqual([
        'executorEntered',
        'sideEffectCommitted',
      ]);
      expect(world.pages()).toEqual(['Notes 1']);
      expect(run.results).toEqual([
        { toolCallId: 'call-1', content: UNKNOWN_OUTCOME_CONTENT },
      ]);
      const message = run.events.find((e) => e.type === 'TOOL_CALL_RESULT');
      expect(message).toMatchObject({
        messageId: 'call-1-unknown-outcome',
        role: 'tool',
      });
      const seen = sees(await nextTurn(world));
      expect(seen).toContain('may or may not have run');
      expect(seen).toContain('do not retry it automatically');
      expect(seen).not.toMatch(
        /did not run|never ran|not executed|stop_requested|Run stopped by user/i,
      );
    });

  it('S4: after the real result is durable it is kept exactly, never replaced by unknown', async () => {
    const { world, published, run } = await stopped({
      kind: 'append',
      type: 'TOOL_CALL_RESULT',
    });
    await stoppedRunInvariants(world, published, run);
    expect(run.results).toHaveLength(1);
    const content = resultOf(run, 'call-1')!;
    expect(content).not.toBe(UNKNOWN_OUTCOME_CONTENT);
    expect(JSON.parse(content)).toMatchObject({
      title: 'Notes 1',
      content: 'body',
    });
    const seen = await nextTurn(world);
    expect(seen[0].content).toBe(content);
  });

  for (const point of ['entered', 'committed'] as const)
    it(`two server tools, the second interrupted inside its executor (${point}): the first real result is kept, the second is unknown`, async () => {
      const { world, published, run } = await stopped(
        { kind: 'executor', point, n: 2 },
        { twoTools: true },
      );
      await stoppedRunInvariants(world, published, run);
      expect(world.pages()).toEqual(['Notes 1', 'Notes 2']);
      expect(run.results).toHaveLength(2);
      expect(JSON.parse(resultOf(run, 'call-1')!)).toMatchObject({
        title: 'Notes 1',
      });
      expect(resultOf(run, 'call-2')).toBe(UNKNOWN_OUTCOME_CONTENT);
      const seen = await nextTurn(world);
      expect(JSON.parse(seen[0].content)).toMatchObject({ title: 'Notes 1' });
      expect(seen[1].content).toBe(UNKNOWN_OUTCOME_CONTENT);
    });
});

describe('client (HITL) tool calls at a stop', () => {
  const REVIEW = '{"title":"t","content":"c","spaceId":"s"}';
  async function stopWith(mixed: boolean) {
    const t = createThrowawayDatabase();
    const log = new ProbeLog(t.db);
    const runner = new DurableAgentRunner({
      log,
      clientExecutableToolNames: CLIENT_EXECUTABLE,
      ownsThread: () => true,
    });
    const agent = new ScriptedAgent(() => [
      ...(mixed ? toolCall('c1', SERVER_TOOL, 'a1') : []),
      ...toolCall('rv1', CLIENT_TOOL, 'a1', REVIEW),
      HANG,
    ]);
    const events = collect(
      startRun(
        runner,
        agent,
        runInput('t1', 'r1', [user('u1')], [CLIENT_TOOL]),
      ),
    );
    await until(
      () =>
        committedTypes(t.db, 't1', 'r1').filter((x) => x === 'TOOL_CALL_END')
          .length === (mixed ? 2 : 1),
    );
    await runner.stop({ threadId: 't1', runId: 'r1' });
    await events;
    const results = Object.fromEntries(
      log
        .runEvents('t1', 'r1')
        .map((s) => s.event as unknown as Record<string, unknown>)
        .filter((e) => e.type === 'TOOL_CALL_RESULT')
        .map((e) => [String(e.toolCallId), String(e.content)]),
    );
    const status = log.getRun('t1', 'r1')?.status;
    const next = new ScriptedAgent((i) => [
      ...textMessage('m2', 'ok'),
      finished(i),
    ]);
    const view = await runner.messagesFor('t1');
    await collect(
      startRun(
        runner,
        next,
        runInput('t1', 'r2', [...view, user('u2', 'continue')], [CLIENT_TOOL]),
      ),
    );
    const out = {
      results,
      status,
      nextInvocations: next.stats.invocations,
      invariants: log.checkInvariants(),
    };
    t.cleanup();
    return out;
  }

  it('a pending client call keeps the stock stop result and is never made unknown', async () => {
    const o = await stopWith(false);
    expect(o.status).toBe('stopped');
    expect(o.results).toEqual({ rv1: STOCK_STOPPED });
    expect(o.nextInvocations).toBe(1);
    expect(o.invariants).toEqual([]);
  });

  it('next to a server call: the server call is unknown, the client call is untouched', async () => {
    const o = await stopWith(true);
    expect(o.status).toBe('stopped');
    expect(o.results).toEqual({
      c1: UNKNOWN_OUTCOME_CONTENT,
      rv1: STOCK_STOPPED,
    });
    expect(o.nextInvocations).toBe(1);
    expect(o.invariants).toEqual([]);
  });
});
