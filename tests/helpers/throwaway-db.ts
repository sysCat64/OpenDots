import { lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// The only way conversation tests obtain a database. It creates its own
// directory under the real operating system temp directory and refuses every
// other path, so a test can never open (and create tables in) a real OpenDots
// database. It reads no environment variable: a child process receives the
// path as an argument and applies the same check before opening it.
export const THROWAWAY_PREFIX = 'opendots-c4-';

export interface ThrowawayDatabase {
  db: DatabaseSync;
  path: string;
  dir: string;
  // Closes the database and removes the directory this helper created.
  cleanup(): void;
}

function refuse(path: string): never {
  throw new Error(`Refusing to open a non-throwaway database path: ${path}`);
}

// The directory of `path` (or its nearest existing ancestor), with symbolic
// links resolved, so a link or `..` cannot lead out of the temp directory.
function resolvedDirectory(path: string): string {
  let current = dirname(path);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(current), ...rest);
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      rest.unshift(basename(current));
      current = parent;
    }
  }
}

// Returns the helper directory that contains `path` after resolving it, or
// throws. The path must lie inside a directory named with THROWAWAY_PREFIX
// that sits directly in the real temp directory.
export function assertThrowawayPath(path: string): string {
  if (!path || path === ':memory:') return refuse(path);
  const root = realpathSync(tmpdir());
  const resolved = join(resolvedDirectory(path), basename(path));
  const inside = relative(root, resolved);
  if (inside === '' || inside.startsWith('..') || inside.startsWith(sep))
    return refuse(path);
  const [first, ...more] = inside.split(sep);
  if (!first.startsWith(THROWAWAY_PREFIX) || more.length === 0)
    return refuse(path);
  // No component below the helper directory may be a symbolic link, even a
  // dangling one: opening a link to a missing file creates that file at the
  // link's target, outside the temp directory.
  let walked = join(root, first);
  for (const segment of more) {
    walked = join(walked, segment);
    if (lstatSync(walked, { throwIfNoEntry: false })?.isSymbolicLink())
      return refuse(path);
  }
  return join(root, first);
}

function configure(db: DatabaseSync): DatabaseSync {
  // The pragmas production applies when it opens its databases. The log under
  // test never sets them itself.
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  return db;
}

// Opens an existing or new database file inside a helper directory. Used by
// the helper itself and by child processes that were given the path.
export function openThrowawayDatabase(path: string): DatabaseSync {
  assertThrowawayPath(path);
  return configure(new DatabaseSync(path));
}

export function createThrowawayDatabase(): ThrowawayDatabase {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), THROWAWAY_PREFIX));
  const path = join(dir, 'conversation.sqlite');
  const db = openThrowawayDatabase(path);
  let cleaned = false;
  return {
    db,
    path,
    dir,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      try {
        db.close();
      } catch {
        // already closed by the test
      }
      // Re-check before deleting: only a directory this helper could have made.
      if (assertThrowawayPath(path) !== dir) refuse(dir);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
