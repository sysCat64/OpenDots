import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  killLiveChildren,
  DECOY_DATABASE,
  createWorkspace,
  readChild,
  start,
  type Workspace,
} from './orchestrator';

// Throwaway database safety for the crash suite: the child only ever opens a
// validated temp path, passed through argv, and ignores the environment.
const root = fileURLToPath(new URL('../../', import.meta.url));
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

async function refused(db: string, dir: string) {
  const exit = await start('read', db, dir).exited;
  expect(exit.code).not.toBe(0);
  expect(exit.stderr).toContain(
    'Refusing to open a non-throwaway database path',
  );
}

describe('the child refuses a database that is not a throwaway', () => {
  it('a path outside the temp directory (the repository data directory)', async () => {
    const ws = workspace();
    const target = join(root, 'data', 'opendots.sqlite');
    const existed = existsSync(target);
    await refused(target, ws.dir);
    expect(existsSync(target)).toBe(existed);
  });

  it('a temp path that is not under a helper directory', async () => {
    const ws = workspace();
    const target = join(tmpdir(), 'plain-opendots.sqlite');
    await refused(target, ws.dir);
    expect(existsSync(target)).toBe(false);
  });

  it('a symbolic link that leads out of the helper directory', async () => {
    const ws = workspace();
    const outside = join(
      ws.throwaway.dir,
      '..',
      'opendots-escape-target.sqlite',
    );
    const link = join(ws.throwaway.dir, 'link.sqlite');
    symlinkSync(outside, link);
    await refused(link, ws.dir);
    expect(existsSync(outside)).toBe(false);
  });

  it('a symbolic link to a directory outside the helper directory', async () => {
    const ws = workspace();
    const elsewhere = join(root, 'tests', 'crash');
    const link = join(ws.throwaway.dir, 'dirlink');
    symlinkSync(elsewhere, link);
    await refused(join(link, 'escaped.sqlite'), ws.dir);
    expect(existsSync(join(elsewhere, 'escaped.sqlite'))).toBe(false);
  });

  it('a dot-dot path that climbs out', async () => {
    const ws = workspace();
    mkdirSync(join(ws.throwaway.dir, 'sub'));
    await refused(
      join(ws.throwaway.dir, 'sub', '..', '..', 'climbed.sqlite'),
      ws.dir,
    );
  });
});

describe('the environment is not consulted', () => {
  it('ignores a production database path in the environment', async () => {
    const ws = workspace();
    const report = await readChild(ws);
    expect(report.replay).toEqual([]);
    expect(existsSync(DECOY_DATABASE)).toBe(false);
  });
});
