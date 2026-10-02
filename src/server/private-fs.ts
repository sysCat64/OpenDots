import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { CredentialStoreError } from './credential-errors.js';

// Owner-only file helpers for OpenDots' own credential-adjacent state. They
// match what the DevKit requires of its own files: a private (0700) real
// directory owned by the user, and 0600 regular files.

const MAX_PRIVATE_FILE_BYTES = 64 * 1024;
const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
const ownedByUser = (uid: number) =>
  process.getuid === undefined || uid === process.getuid();

export async function ensurePrivateDir(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || !ownedByUser(info.uid))
    throw new CredentialStoreError('state_dir_unsafe');
  await chmod(directory, 0o700);
}

// Undefined when the file does not exist. Refuses links and any file that is
// not owner-only, rather than quietly trusting it.
export async function readPrivateFile(
  path: string,
  maxBytes = MAX_PRIVATE_FILE_BYTES,
) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (code(error) === 'ENOENT') return undefined;
    throw new CredentialStoreError('state_dir_unsafe', { cause: error });
  }
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.size > maxBytes ||
      (info.mode & 0o077) !== 0 ||
      !ownedByUser(info.uid)
    )
      throw new CredentialStoreError('state_dir_unsafe');
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}

// Atomic: a reader sees the old file or the new one, never a partial write.
export async function writePrivateFile(path: string, content: string) {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(content);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export interface FileLockOptions {
  /** How old a lock with no usable owner pid must be to count as abandoned. */
  staleMs?: number;
  timeoutMs?: number;
  pollMs?: number;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return code(error) !== 'ESRCH';
  }
};

// Mutual exclusion by atomic exclusive creation, used only for the brief
// first-start key creation. The lock names its owner's pid, so one left behind
// by kill -9 is recognised as abandoned and taken over: the taker
// renames the stale file away (atomic, so only one taker wins) and then creates
// its own. Takeover is best-effort; callers must keep the critical section safe
// to repeat.
export async function withFileLock<T>(
  path: string,
  operation: () => Promise<T>,
  { staleMs = 30_000, timeoutMs = 15_000, pollMs = 50 }: FileLockOptions = {},
): Promise<T> {
  const token = randomBytes(8).toString('hex');
  const started = Date.now();
  for (;;) {
    try {
      const file = await open(path, 'wx', 0o600);
      try {
        await file.writeFile(
          JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }),
        );
      } finally {
        await file.close();
      }
      break;
    } catch (error) {
      if (code(error) !== 'EEXIST')
        throw new CredentialStoreError('state_dir_unsafe', { cause: error });
    }
    if (await abandoned(path, staleMs)) {
      const away = `${path}.stale-${randomBytes(4).toString('hex')}`;
      try {
        await rename(path, away);
        await rm(away, { force: true });
      } catch {
        // Someone else took it over first; try to acquire again.
      }
      continue;
    }
    if (Date.now() - started > timeoutMs)
      throw new CredentialStoreError('lock_timeout');
    await delay(pollMs);
  }
  try {
    return await operation();
  } finally {
    // Release only our own lock, not one a taker created after calling ours stale.
    if ((await readLock(path))?.token === token)
      await rm(path, { force: true });
  }
}

async function readLock(path: string) {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      const parsed = JSON.parse(await file.readFile('utf8')) as {
        pid?: unknown;
        token?: unknown;
        createdAt?: unknown;
      };
      return {
        pid: typeof parsed.pid === 'number' ? parsed.pid : undefined,
        token: typeof parsed.token === 'string' ? parsed.token : undefined,
        createdAt:
          typeof parsed.createdAt === 'number'
            ? parsed.createdAt
            : info.mtimeMs,
        mtimeMs: info.mtimeMs,
      };
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}

// A lock is abandoned only when no live owner holds it:
// - an owner pid that is alive is never overridden, however old the lock is;
// - an owner pid that is gone is abandoned at once (kill -9 recovery);
// - with no usable owner pid (empty or damaged metadata), the lock's age decides.
async function abandoned(path: string, staleMs: number) {
  const lock = await readLock(path);
  if (lock?.pid !== undefined) return !alive(lock.pid);
  // A live owner writes its pid right after creating the file, so a lock still
  // without one after a short grace was left by a crashed creator or damaged.
  const grace = lock ? staleMs : Math.min(staleMs, 2_000);
  try {
    const age = Date.now() - (lock?.createdAt ?? (await lstat(path)).mtimeMs);
    return age > grace;
  } catch {
    return false;
  }
}
