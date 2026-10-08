import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  THROWAWAY_PREFIX,
  assertThrowawayPath,
  createThrowawayDatabase,
  openThrowawayDatabase,
  type ThrowawayDatabase,
} from './helpers/throwaway-db';

// Conversation tests may only ever open a database this helper made. These
// tests guard the guard: if it ever accepted a real OpenDots database path, a
// test could create tables in the user's data.
const created: ThrowawayDatabase[] = [];
const make = () => {
  const database = createThrowawayDatabase();
  created.push(database);
  return database;
};
afterEach(() => {
  for (const database of created.splice(0)) database.cleanup();
});

describe('throwaway database helper', () => {
  it('creates the database under the real operating system temp directory', () => {
    const database = make();
    const root = realpathSync(tmpdir());
    expect(database.path.startsWith(root + sep)).toBe(true);
    expect(database.dir.startsWith(join(root, THROWAWAY_PREFIX))).toBe(true);
    expect(database.path.startsWith(database.dir + sep)).toBe(true);
    expect(existsSync(database.path)).toBe(true);
    expect(database.db.prepare('SELECT 1 AS one').get()).toEqual({ one: 1 });
  });

  it('gives every call its own directory', () => {
    expect(make().dir).not.toBe(make().dir);
  });

  it('never reads a database path from the environment', () => {
    const saved = { ...process.env };
    process.env.DATABASE_PATH = resolve('data', 'opendots.sqlite');
    process.env.OPENDOTS_DATABASE = resolve('data', 'opendots.sqlite');
    try {
      const database = make();
      expect(database.path).not.toContain('opendots.sqlite');
      expect(database.path.startsWith(realpathSync(tmpdir()) + sep)).toBe(true);
    } finally {
      process.env = saved;
    }
  });

  it('refuses a path outside the temp directory (negative control)', () => {
    for (const path of [
      'data/opendots.sqlite',
      resolve('data', 'opendots.sqlite'),
      join(homedir(), 'Documents', 'Repositories', 'OpenDots', 'x.sqlite'),
      '/Users/someone/OpenDots/data/opendots.sqlite',
      '/etc/passwd',
      ':memory:',
      '',
    ]) {
      expect(() => assertThrowawayPath(path), path).toThrow(/throwaway/i);
      expect(() => openThrowawayDatabase(path), path).toThrow(/throwaway/i);
    }
  });

  it('refuses a temp path that is not inside one of its own directories', () => {
    expect(() => assertThrowawayPath(join(tmpdir(), 'plain.sqlite'))).toThrow(
      /throwaway/i,
    );
    expect(() =>
      assertThrowawayPath(join(tmpdir(), 'other-dir', 'plain.sqlite')),
    ).toThrow(/throwaway/i);
  });

  it('refuses a path that climbs out of the temp directory', () => {
    const database = make();
    expect(() =>
      assertThrowawayPath(join(database.dir, '..', '..', 'escape.sqlite')),
    ).toThrow(/throwaway/i);
  });

  describe('symbolic links', () => {
    // A directory next to the helper's own, outside any helper directory.
    let outside: string;
    beforeEach(() => {
      outside = mkdtempSync(join(realpathSync(tmpdir()), 'opendots-outside-'));
    });
    afterEach(() => rmSync(outside, { recursive: true, force: true }));

    it('refuses a link to an existing directory outside the helper directory', () => {
      const database = make();
      symlinkSync(outside, join(database.dir, 'link'));
      const target = join(database.dir, 'link', 'opendots.sqlite');
      expect(() => assertThrowawayPath(target)).toThrow(/throwaway/i);
      expect(() => openThrowawayDatabase(target)).toThrow(/throwaway/i);
      expect(readdirSync(outside)).toEqual([]);
    });

    it('refuses a link to a directory that does not exist', () => {
      const database = make();
      const missing = join(outside, 'missing');
      symlinkSync(missing, join(database.dir, 'link'));
      const target = join(database.dir, 'link', 'opendots.sqlite');
      expect(() => openThrowawayDatabase(target)).toThrow(/throwaway/i);
      expect(existsSync(missing)).toBe(false);
    });

    it('refuses a database file that is a dangling link, which SQLite would create at the target', () => {
      const database = make();
      const real = join(outside, 'opendots.sqlite');
      symlinkSync(real, join(database.dir, 'db.sqlite'));
      const target = join(database.dir, 'db.sqlite');
      expect(() => openThrowawayDatabase(target)).toThrow(/throwaway/i);
      expect(existsSync(real)).toBe(false);
    });

    it('refuses a database file that links to an existing file', () => {
      const database = make();
      const real = join(outside, 'opendots.sqlite');
      writeFileSync(real, '');
      symlinkSync(real, join(database.dir, 'db.sqlite'));
      expect(() =>
        openThrowawayDatabase(join(database.dir, 'db.sqlite')),
      ).toThrow(/throwaway/i);
    });
  });

  it('opens an existing helper-made path again, as a child process would', () => {
    const database = make();
    database.db.exec('CREATE TABLE t(x INTEGER); INSERT INTO t VALUES (7);');
    database.db.close();
    const again = openThrowawayDatabase(database.path);
    expect(again.prepare('SELECT x FROM t').get()).toEqual({ x: 7 });
    again.close();
  });

  it('opens nested paths inside a helper directory', () => {
    const database = make();
    mkdirSync(join(database.dir, 'nested'));
    const nested = join(database.dir, 'nested', 'db.sqlite');
    expect(() => assertThrowawayPath(nested)).not.toThrow();
  });

  it('removes only the directory it created, and only with its prefix', () => {
    const database = createThrowawayDatabase();
    const { dir, path } = database;
    database.cleanup();
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(path)).toBe(false);
    // The temp directory itself is untouched.
    expect(existsSync(realpathSync(tmpdir()))).toBe(true);
    // A second cleanup is harmless.
    expect(() => database.cleanup()).not.toThrow();
  });

  it('writes with the production pragmas but the log never has to', () => {
    const database = make();
    const mode = database.db.prepare('PRAGMA journal_mode').get() as {
      journal_mode: string;
    };
    expect(mode.journal_mode).toBe('wal');
  });
});
