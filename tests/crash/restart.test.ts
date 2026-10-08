import { afterEach, describe, expect, it } from 'vitest';
import { snapshotDatabase } from '../helpers/db-snapshot';
import {
  killLiveChildren,
  createWorkspace,
  inspect,
  readChild,
  recoverChild,
  runChild,
  withHostRetry,
  type Workspace,
} from './orchestrator';
import { observe } from './state';

// L6: a fresh process on the same file. Replay is identical, the model is not
// called, a pure reader changes nothing, and ready() repairs a stale view while
// a healthy restart writes nothing.
const workspaces: Workspace[] = [];
afterEach(() => {
  killLiveChildren();
  for (const workspace of workspaces.splice(0)) workspace.cleanup();
});
const completed = async (scenario = 'terminal-committed-view-unwritten') => {
  const ws = createWorkspace();
  workspaces.push(ws);
  const done = await runChild('run-to-end', ws, scenario, ws.dir);
  expect(done.completed).toBe(true);
  return ws;
};

describe('a fresh process reading a completed thread', () => {
  it('replays exactly what was stored, calls the model never, and writes nothing', async () => {
    await withHostRetry('replay', async () => {
      const ws = await completed();
      const stored = observe(ws);
      const before = snapshotDatabase(ws.db);
      const report = await readChild(ws);
      expect(report.replay).toEqual(stored.types);
      expect(report.counters.provider).toBe(1);
      expect(report.counters.tool).toBe(0);
      expect(report.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(snapshotDatabase(ws.db)).toBe(before);
    });
  });
});

describe('ready() in a fresh process', () => {
  it('writes nothing on a healthy database', async () => {
    await withHostRetry('healthy-ready', async () => {
      const ws = await completed();
      await recoverChild(ws);
      const settled = snapshotDatabase(ws.db);
      const report = await recoverChild(ws);
      expect(report.ready).toMatchObject({
        checked: 1,
        rebuilt: 0,
        recovered: [],
        deferred: [],
      });
      expect(snapshotDatabase(ws.db)).toBe(settled);
    });
  });

  it('repairs a stale view and only the view', async () => {
    await withHostRetry('stale-view', async () => {
      const ws = await completed();
      await recoverChild(ws);
      const events = observe(ws).events;
      inspect(ws, (db) =>
        db.exec(
          'UPDATE conversation_messages SET lastEventId = lastEventId - 1',
        ),
      );
      const report = await recoverChild(ws);
      expect(report.ready).toMatchObject({ checked: 1, rebuilt: 1 });
      expect(observe(ws)).toMatchObject({ viewRows: 1, status: 'finished' });
      expect(observe(ws).events).toEqual(events);
      expect(
        inspect(ws, (db) =>
          db.prepare('SELECT lastEventId FROM conversation_messages').get(),
        ),
      ).toEqual({
        lastEventId: observe(ws).eventRows,
      });
    });
  });
});
