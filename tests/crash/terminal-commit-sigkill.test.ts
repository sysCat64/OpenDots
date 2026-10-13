import { afterEach, describe, expect, it } from 'vitest';
import {
  INTERRUPTION_MESSAGE,
  UNKNOWN_OUTCOME_CONTENT,
} from '../../src/server/run-rules';
import {
  createWorkspace,
  killLiveChildren,
  recoverChild,
  runAndKill,
  withHostRetry,
  type Workspace,
} from './orchestrator';
import { observe } from './state';

// A: the unknown-outcome marker and the terminal event are ONE commit, so a
// SIGKILL leaves both or neither. Real child process, real SIGKILL, throwaway
// database; a second fresh process recovers. No model, no network.
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
const marker = {
  type: 'TOOL_CALL_RESULT',
  toolCallId: 'c1',
  messageId: 'c1-unknown-outcome',
  role: 'tool',
  content: UNKNOWN_OUTCOME_CONTENT,
};

describe('the terminal commit under a real SIGKILL (A)', () => {
  it('killed right after the commit: marker and RUN_ERROR are both durable, status error, nothing runs again', async () => {
    await withHostRetry('A-after', async () => {
      const ws = workspace();
      await runAndKill(ws, 'provider-error-after-end');
      const before = observe(ws);
      expect(before.types).toEqual([
        'RUN_STARTED',
        'TOOL_CALL_START',
        'TOOL_CALL_ARGS',
        'TOOL_CALL_END',
        'TOOL_CALL_RESULT',
        'RUN_ERROR',
      ]);
      expect(before.events[4]).toEqual(marker);
      expect(before.status).toBe('error');
      expect(before.invariants).toEqual([]);
      // A terminal run is left exactly as it is by a fresh process.
      const report = await recoverChild(ws);
      const after = observe(ws);
      expect(report.ready?.recovered).toEqual([]);
      expect(after.types).toEqual(before.types);
      expect(after.status).toBe('error');
      expect(after.tool).toBe(0);
      expect(after.provider).toBe(before.provider);
    });
  });

  it('killed inside the commit: neither the marker nor the terminal event is durable; recovery then records the same marker', async () => {
    await withHostRetry('A-inside', async () => {
      const ws = workspace();
      await runAndKill(ws, 'provider-error-after-end-mid-commit');
      const before = observe(ws);
      // The transaction never committed: the run is as it was at END.
      expect(before.types).toEqual([
        'RUN_STARTED',
        'TOOL_CALL_START',
        'TOOL_CALL_ARGS',
        'TOOL_CALL_END',
      ]);
      expect(before.status).toBe('running');
      expect(before.invariants).toEqual([]);
      const report = await recoverChild(ws);
      const after = observe(ws);
      expect(report.ready?.recovered).toMatchObject([
        { kind: 'server_unknown_outcome' },
      ]);
      expect(after.types).toEqual([
        ...before.types,
        'TOOL_CALL_RESULT',
        'RUN_ERROR',
      ]);
      expect(after.events[4]).toEqual(marker);
      expect(after.events[5]).toMatchObject({
        type: 'RUN_ERROR',
        message: INTERRUPTION_MESSAGE,
      });
      expect(after.status).toBe('interrupted');
      expect(after.invariants).toEqual([]);
      // Recovery never re-drives the agent and never runs a tool.
      expect(after.tool).toBe(0);
      expect(after.provider).toBe(before.provider);
    });
  });
});
