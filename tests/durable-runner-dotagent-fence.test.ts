import { join } from 'node:path';
import type { BaseEvent } from '@ag-ui/core';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationLog } from '../src/server/conversation-log';
import { DurableAgentRunner } from '../src/server/durable-runner';
import { UNKNOWN_OUTCOME_CONTENT, classifyRun } from '../src/server/run-rules';
import {
  CALL1,
  CALL2,
  RUN,
  THREAD,
  createDotWorld,
  openWitness,
  probeProducerBoundary,
  readWitness,
  tuple,
} from './helpers/dot-fence-fixture';
import { CLIENT_EXECUTABLE } from './helpers/event-fixtures';
import { installNetworkGuard, netStats } from './helpers/net-guard';
import { ProbeLog } from './helpers/probe-log';
import { collect } from './helpers/runner-harness';
import {
  createThrowawayDatabase,
  openThrowawayDatabase,
} from './helpers/throwaway-db';

// The A1 fence on the PRODUCTION DotAgent (BuiltInAgent -> TanStack chat() ->
// the production tools -> a real WorkspaceStore), driven through the production
// DurableAgentRunner. Offline: the model is a local function standing in for
// fetch, the side effect is a real page write into a throwaway workspace, and a
// second SQLite file (the witness) records executor entry and the committed side
// effect where the conversation log cannot see it.
installNetworkGuard();
afterAll(() => expect(netStats.nonLoopback).toEqual([]));

const closers: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (closers.length) closers.pop()!();
});

interface Options {
  argChunks?: number;
  textFirst?: boolean;
  twoTools?: boolean;
  subscribers?: number;
  failAt?: { type: string; nth?: number };
  probe?: boolean;
}

async function dotRun(options: Options = {}) {
  const t = createThrowawayDatabase();
  const observer = openThrowawayDatabase(t.path);
  const witness = openWitness(join(t.dir, 'witness.sqlite'));
  const log = new ProbeLog(t.db);
  if (options.failAt) {
    let seen = 0;
    const fail = options.failAt;
    log.beforeAppend = (events) => {
      for (const event of events)
        if (event.type === fail.type && ++seen === (fail.nth ?? 1))
          throw new Error(`injected storage fault at ${event.type}`);
    };
  }
  const world = createDotWorld({
    observer,
    witness,
    argChunks: options.argChunks,
    textFirst: options.textFirst,
    twoTools: options.twoTools,
  });
  closers.push(() => {
    world.close();
    observer.close();
    witness.close();
    t.cleanup();
  });
  for (let i = 0; i < (options.subscribers ?? 0); i++)
    world.agent.subscribe({ onEvent: () => undefined });
  const runner = new DurableAgentRunner({
    log,
    clientExecutableToolNames: CLIENT_EXECUTABLE,
    ownsThread: () => true,
  });
  const probe = options.probe ? probeProducerBoundary(observer) : undefined;
  let published: BaseEvent[];
  try {
    published = await collect(
      runner.run({
        threadId: THREAD,
        agent: world.agent as never,
        input: world.input,
      }),
    );
  } finally {
    probe?.restore();
  }
  const final = new ConversationLog(t.db)
    .runEvents(THREAD, RUN)
    .map((stored) => stored.event as unknown as Record<string, unknown>);
  return { world, published, final, t, observer, witness, probe, log };
}

// Every executor entry had its whole call durable, and the run was durable
// before the first model request.
function fenceReasons(run: Awaited<ReturnType<typeof dotRun>>): string[] {
  const reasons: string[] = [];
  if (run.world.entries.length === 0) reasons.push('executor never entered');
  if (run.world.modelRequests[0]?.durableAtRequest[0] !== 'RUN_STARTED')
    reasons.push('RUN_STARTED not durable before the first model request');
  for (const entry of run.world.entries) {
    const call = run.final
      .filter(
        (e) =>
          e.toolCallId === entry.toolCallId && e.type !== 'TOOL_CALL_RESULT',
      )
      .map((e) => e.type);
    if (JSON.stringify(entry.durableCallEvents) !== JSON.stringify(call))
      reasons.push(
        `executor ${entry.n}: ${entry.durableCallEvents.length} of ${call.length} call events durable at entry`,
      );
    if (entry.durableCallEvents.at(-1) !== 'TOOL_CALL_END')
      reasons.push(`executor ${entry.n}: TOOL_CALL_END not durable at entry`);
  }
  return reasons;
}

describe('production DotAgent: the tool call is durable before the executor', () => {
  const rows: Array<[string, Options]> = [
    ['short stream (2 argument chunks)', { argChunks: 2 }],
    ['long stream (400 argument chunks)', { argChunks: 400 }],
    ['text before the tool call', { textFirst: true }],
    ['two sequential server tools', { twoTools: true }],
    ['128 trivial AG-UI subscribers ahead', { subscribers: 128 }],
  ];
  for (const [name, options] of rows)
    it(name, async () => {
      const run = await dotRun(options);
      expect(fenceReasons(run)).toEqual([]);
      expect(run.world.unexpectedFetch).toEqual([]);
      expect(run.world.pagesTitled()).toBe(options.twoTools ? 2 : 1);
      if (options.twoTools)
        expect(run.world.entries.map((e) => e.toolCallId)).toEqual([
          CALL1,
          CALL2,
        ]);
      expect(new ConversationLog(run.t.db).getRun(THREAD, RUN)?.status).toBe(
        'finished',
      );
    });

  it('publishes exactly what it committed, in order', async () => {
    const run = await dotRun({ textFirst: true, twoTools: true });
    expect(run.published.map((e) => e.type)).toEqual(
      run.final.map((e) => e.type),
    );
  });
});

describe('production DotAgent: every tool-call event is durable when the producer push returns', () => {
  it('has no violation at the real producer boundary', async () => {
    const run = await dotRun({ probe: true, argChunks: 40, twoTools: true });
    expect(run.probe!.pushed.TOOL_CALL_END).toBeGreaterThan(0);
    expect(run.probe!.violations).toEqual([]);
  });
});

describe('production DotAgent: persistence failures F1 to F4', () => {
  const rows: Array<[string, string, number | undefined, boolean]> = [
    ['F1 TOOL_CALL_START', 'TOOL_CALL_START', undefined, true],
    ['F2 first TOOL_CALL_ARGS', 'TOOL_CALL_ARGS', 1, true],
    ['F2 last TOOL_CALL_ARGS', 'TOOL_CALL_ARGS', 2, true],
    ['F3 TOOL_CALL_END', 'TOOL_CALL_END', undefined, true],
    [
      'F4 TOOL_CALL_RESULT after the side effect',
      'TOOL_CALL_RESULT',
      undefined,
      false,
    ],
  ];
  for (const [name, type, nth, beforeExecutor] of rows)
    it(name, async () => {
      // The SDK logs a rejected run; the point of the test is the outcome.
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const run = await dotRun({ failAt: { type, nth } });
      const witness = readWitness(run.witness);
      // The failure reaches the caller as the run's error.
      const last = run.published.at(-1) as unknown as {
        type: string;
        message?: string;
      };
      expect(last.type).toBe('RUN_ERROR');
      expect(last.message).toContain(`injected storage fault at ${type}`);
      expect(new ConversationLog(run.t.db).getRun(THREAD, RUN)?.status).toBe(
        'error',
      );
      // No second model request, no automatic retry.
      expect(run.world.modelRequests.length).toBe(1);
      expect(run.world.pagesTitled()).toBe(beforeExecutor ? 0 : 1);
      if (beforeExecutor) {
        expect(run.world.entries.length).toBe(0);
        expect(witness).toEqual([]);
      } else {
        expect(witness).toEqual(['executorEntered', 'sideEffectCommitted']);
        // The side effect exists and its result was never recorded. The run is
        // closed with the same unknown-outcome result recovery writes, never a
        // stock "error" result that would read as "the tool did not run".
        const results = run.final.filter((e) => e.type === 'TOOL_CALL_RESULT');
        expect(results.map((e) => e.content)).toEqual([
          UNKNOWN_OUTCOME_CONTENT,
        ]);
        expect(JSON.stringify(run.final)).not.toMatch(
          /missing_terminal_event|did not run|never ran|not executed/i,
        );
      }
      // What was published is exactly what is durable: nothing was shown to a
      // client before its commit.
      expect(run.published.map((e) => e.type)).toEqual(
        run.final.map((e) => e.type),
      );
      // Recovery, in a fresh runner over the same database, runs nothing.
      const requests = run.world.modelRequests.length;
      await new DurableAgentRunner({
        log: new ConversationLog(run.t.db),
        clientExecutableToolNames: CLIENT_EXECUTABLE,
        ownsThread: () => true,
      }).ready();
      expect(run.world.modelRequests.length).toBe(requests);
      expect(readWitness(run.witness)).toEqual(witness);
    });
});

describe('production DotAgent: the chain is empty and stays empty', () => {
  it('starts with no middleware and is left with none', async () => {
    const run = await dotRun();
    const chain = (run.world.agent as unknown as { middlewares: unknown[] })
      .middlewares;
    expect(chain).toEqual([]);
    expect(
      classifyRun(run.final as unknown as BaseEvent[], CLIENT_EXECUTABLE).kind,
    ).toBeDefined();
  });
});

void tuple;
