import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import {
  INTERRUPTION_MESSAGE,
  UNKNOWN_OUTCOME_CONTENT,
} from '../../src/server/run-rules';
import {
  killLiveChildren,
  createWorkspace,
  recoverChild,
  runAndKill,
  runChild,
  start,
  waitForMarker,
  classifyExit,
  withHostRetry,
  type Workspace,
} from './orchestrator';
import { observe } from './state';
import { RUN, THREAD } from './scenarios';

// L7: real SIGKILL recovery (docs/LOCAL_FIRST_C4_LANDING_BOUNDARY.md section 21).
// A child process drives a scenario, freezes right after the commit of a chosen
// event (a marker file, no sleeps) and is killed with SIGKILL. A second, fresh
// process recovers. The parent reads the database and the counter files: after
// recovery the model must not have been called again and no tool re-executed.
const workspaces: Workspace[] = [];
afterEach(() => {
  killLiveChildren();
  for (const workspace of workspaces.splice(0)) workspace.cleanup();
});
const workspace = () => {
  const created = createWorkspace();
  workspaces.push(created);
  return created;
};

const stockError = {
  type: 'RUN_ERROR',
  message: INTERRUPTION_MESSAGE,
  code: 'INCOMPLETE_STREAM',
};

// Kills a scenario, records the durable state, recovers in a fresh process.
async function killAndRecover(name: string) {
  const ws = workspace();
  const killed = await runAndKill(ws, name);
  const before = observe(ws);
  const report = await recoverChild(ws);
  const after = observe(ws);
  return { ws, killed, before, after, report };
}

describe('closed classes, recovered after a real SIGKILL', () => {
  it('A. RUN_STARTED only: interrupted with INCOMPLETE_STREAM, model never called', async () => {
    await withHostRetry('A', async () => {
      const { before, after, report } =
        await killAndRecover('run-started-only');
      expect(before).toMatchObject({
        status: 'running',
        types: ['RUN_STARTED'],
        provider: 0,
      });
      expect(after.types).toEqual(['RUN_STARTED', 'RUN_ERROR']);
      expect(after.events[1]).toEqual(stockError);
      expect(after.status).toBe('interrupted');
      expect(after.invariants).toEqual([]);
      expect(report.ready?.recovered).toMatchObject([
        { kind: 'no_tool_lifecycle' },
      ]);
      expect(after.provider).toBe(0);
      expect(after.tool).toBe(0);
    });
  });

  it('B. open text: the durable partial is kept, closed, then RUN_ERROR', async () => {
    await withHostRetry('B', async () => {
      const { before, after, report } = await killAndRecover('open-text');
      expect(before.types).toEqual([
        'RUN_STARTED',
        'TEXT_MESSAGE_START',
        'TEXT_MESSAGE_CONTENT',
      ]);
      expect(after.types).toEqual([
        ...before.types,
        'TEXT_MESSAGE_END',
        'RUN_ERROR',
      ]);
      expect(after.status).toBe('interrupted');
      expect(after.invariants).toEqual([]);
      expect(report.messages.at(-1)).toMatchObject({
        role: 'assistant',
        content: 'partial answer',
      });
      expect(after.provider).toBe(before.provider);
      expect(after.tool).toBe(0);
    });
  });

  it('C. incomplete tool arguments: stock failure result, the executor is not run', async () => {
    await withHostRetry('C', async () => {
      const { before, after } = await killAndRecover('tool-args-incomplete');
      expect(before.types.slice(-2)).toEqual([
        'TOOL_CALL_START',
        'TOOL_CALL_ARGS',
      ]);
      expect(after.types.slice(-3)).toEqual([
        'TOOL_CALL_END',
        'TOOL_CALL_RESULT',
        'RUN_ERROR',
      ]);
      expect(
        after.events.find((e) => e.type === 'TOOL_CALL_RESULT'),
      ).toMatchObject({ messageId: 'c1-result' });
      expect(after.status).toBe('interrupted');
      expect(after.tool).toBe(0);
      expect(after.provider).toBe(before.provider);
    });
  });

  describe('D. a server tool with an ambiguous outcome is never retried', () => {
    const unknown = {
      type: 'TOOL_CALL_RESULT',
      toolCallId: 'c1',
      messageId: 'c1-unknown-outcome',
      role: 'tool',
      content: UNKNOWN_OUTCOME_CONTENT,
    };

    it('window 1: killed before the executor ran', async () => {
      await withHostRetry('D1', async () => {
        const { before, after } = await killAndRecover('server-before-exec');
        expect(before.tool).toBe(0);
        expect(before.types.at(-1)).toBe('TOOL_CALL_END');
        expect(after.events.at(-2)).toEqual(unknown);
        expect(after.events.at(-1)).toEqual(stockError);
        expect(after.status).toBe('interrupted');
        expect(after.tool).toBe(0);
        expect(after.provider).toBe(before.provider);
      });
    });

    it('window 2: killed after the executor ran, its result unrecorded', async () => {
      await withHostRetry('D2', async () => {
        const { before, after } = await killAndRecover('server-after-exec');
        expect(before.tool).toBe(1);
        expect(before.types.at(-1)).toBe('TOOL_CALL_END');
        // The log cannot tell the two windows apart: the same representation.
        expect(after.events.at(-2)).toEqual(unknown);
        expect(after.events.at(-1)).toEqual(stockError);
        expect(after.status).toBe('interrupted');
        expect(after.tool).toBe(1);
        expect(after.provider).toBe(before.provider);
      });
    });
  });

  it('E. a durable result without a terminal event: the result is kept, only the terminal is added', async () => {
    await withHostRetry('E', async () => {
      const { before, after } = await killAndRecover('result-durable');
      expect(before.types.at(-1)).toBe('TOOL_CALL_RESULT');
      expect(after.events.slice(0, before.events.length)).toEqual(
        before.events,
      );
      expect(after.types.slice(before.types.length)).toEqual(['RUN_ERROR']);
      expect(after.status).toBe('interrupted');
      expect(after.tool).toBe(1);
      expect(after.provider).toBe(before.provider);
    });
  });

  it('F. a pending client tool in a run that finished: nothing is synthesized, nothing is executed', async () => {
    await withHostRetry('F', async () => {
      const ws = workspace();
      await runAndKill(ws, 'client-pending-finished');
      const before = observe(ws);
      expect(before).toMatchObject({
        status: 'finished',
        provider: 1,
        tool: 0,
      });
      const report = await recoverChild(ws);
      const after = observe(ws);
      expect(after.events).toEqual(before.events);
      expect(after.status).toBe('finished');
      expect(report.ready?.recovered).toEqual([]);
      expect(after.types).not.toContain('TOOL_CALL_RESULT');
      expect(after.provider).toBe(1);
      expect(after.tool).toBe(0);
    });
  });

  it('G. a client TOOL_CALL_END without RUN_FINISHED: the canonical pending form, not a server ambiguity', async () => {
    await withHostRetry('G', async () => {
      const { before, after, report } = await killAndRecover(
        'client-pending-before-finish',
      );
      expect(before.types.at(-1)).toBe('TOOL_CALL_END');
      expect(after.types.slice(before.types.length)).toEqual(['RUN_FINISHED']);
      expect(after.types).not.toContain('TOOL_CALL_RESULT');
      expect(after.status).toBe('finished');
      expect(report.ready?.recovered).toMatchObject([
        { kind: 'client_hitl_pending', status: 'finished' },
      ]);
      // The call stays pending in the conversation, waiting for the human.
      const assistant = report.messages.find(
        (m) => m.role === 'assistant',
      ) as unknown as {
        toolCalls?: Array<{ id: string }>;
      };
      expect(assistant.toolCalls?.map((c) => c.id)).toEqual(['rv1']);
      expect(report.messages.some((m) => m.role === 'tool')).toBe(false);
      expect(after.tool).toBe(0);
      expect(after.provider).toBe(before.provider);
    });
  });

  it('H. R26a: closed complete text with no terminal event becomes RUN_ERROR, interrupted, never finished (real SIGKILL)', async () => {
    await withHostRetry('H', async () => {
      const { before, after, report } =
        await killAndRecover('r26a-complete-text');
      expect(before.types).toEqual([
        'RUN_STARTED',
        'TEXT_MESSAGE_START',
        'TEXT_MESSAGE_CONTENT',
        'TEXT_MESSAGE_END',
      ]);
      expect(before.status).toBe('running');
      expect(after.types).toEqual([...before.types, 'RUN_ERROR']);
      expect(after.events.at(-1)).toEqual(stockError);
      expect(after.status).toBe('interrupted');
      expect(after.types).not.toContain('RUN_FINISHED');
      expect(report.ready?.recovered).toMatchObject([
        { kind: 'complete_text_no_terminal', status: 'interrupted' },
      ]);
      expect(after.invariants).toEqual([]);
      expect(after.provider).toBe(before.provider);
    });
  });
});

describe('open classes stay open (R26b): no confident terminal state', () => {
  it.each(['r26b-reasoning', 'r26b-state'])(
    '%s: nothing is written, the run stays running and is reported',
    async (name) => {
      await withHostRetry(name, async () => {
        const { before, after, report } = await killAndRecover(name);
        expect(before.status).toBe('running');
        expect(after.events).toEqual(before.events);
        expect(after.status).toBe('running');
        expect(report.ready?.recovered).toEqual([]);
        expect(report.ready?.deferred).toMatchObject([
          {
            threadId: THREAD,
            runId: RUN,
            kind: 'unclassified_lifecycle',
            outcome: 'deferred',
          },
        ]);
        // The replay has no terminal event for this run: unresolved, recorded.
        expect(report.replay).not.toContain('RUN_FINISHED');
        expect(report.replay).not.toContain('RUN_ERROR');
        expect(after.invariants).toEqual([]);
        expect(after.provider).toBe(before.provider);
      });
    },
  );
});

describe('the cache window: the run is durable, its view is not yet written', () => {
  it('keeps the run finished, and ready() writes only the view', async () => {
    await withHostRetry('cache-window', async () => {
      const { before, after, report } = await killAndRecover(
        'terminal-committed-view-unwritten',
      );
      expect(before).toMatchObject({ status: 'finished', viewRows: 0 });
      expect(after.events).toEqual(before.events);
      expect(after.status).toBe('finished');
      expect(after.viewRows).toBe(1);
      expect(report.ready).toMatchObject({
        checked: 1,
        rebuilt: 1,
        recovered: [],
      });
      expect(report.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    });
  });
});

describe('a kill inside the recovery transaction', () => {
  it('leaves the run exactly as it was, and the next recovery completes it', async () => {
    await withHostRetry('recovery-transaction', async () => {
      const ws = workspace();
      await runAndKill(ws, 'open-text');
      const before = observe(ws);
      // Recovery is frozen after its first insert, still inside the transaction.
      rmSync(ws.marker);
      const handle = start('recover-frozen', ws.db, ws.dir);
      const frozen = await waitForMarker(ws, handle);
      expect(frozen.after).toBe('recovery-insert');
      handle.kill();
      const exit = await handle.exited;
      classifyExit(exit);
      expect(exit.signal).toBe('SIGKILL');
      const between = observe(ws);
      expect(between.events).toEqual(before.events);
      expect(between.status).toBe('running');
      expect(between.invariants).toEqual([]);
      // A later recovery finishes the job, once.
      await recoverChild(ws);
      const after = observe(ws);
      expect(after.types).toEqual([
        ...before.types,
        'TEXT_MESSAGE_END',
        'RUN_ERROR',
      ]);
      expect(after.status).toBe('interrupted');
      expect(after.invariants).toEqual([]);
      const again = await recoverChild(ws);
      expect(again.ready?.recovered).toEqual([]);
      expect(observe(ws).events).toEqual(after.events);
    });
  });
});

describe('the child really is killed by the injected signal', () => {
  it('reports SIGKILL, and a run that is not frozen simply completes', async () => {
    await withHostRetry('signal', async () => {
      const ws = workspace();
      const done = await runChild(
        'run-to-end',
        ws,
        'terminal-committed-view-unwritten',
        ws.dir,
      );
      expect(done).toMatchObject({ completed: true });
      expect(observe(ws).status).toBe('finished');
    });
  });
});
