import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import {
  chmod,
  readFile,
  utimes,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ensurePrivateDir,
  readPrivateFile,
  withFileLock,
  writePrivateFile,
} from '../src/server/private-fs.js';

// These tests do real filesystem and process work; leave headroom on a loaded machine.
vi.setConfig({ testTimeout: 20_000 });

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'private-fs-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const mode = async (path: string) => (await stat(path)).mode & 0o777;

it('creates and tightens directories to 0700, and refuses a symlink', async () => {
  const fresh = join(root, 'a', 'b');
  await ensurePrivateDir(fresh);
  expect(await mode(fresh)).toBe(0o700);
  const loose = join(root, 'loose');
  await mkdir(loose, { mode: 0o755 });
  await ensurePrivateDir(loose);
  expect(await mode(loose)).toBe(0o700);
  const link = join(root, 'link');
  await symlink(loose, link);
  await expect(ensurePrivateDir(link)).rejects.toMatchObject({
    code: 'state_dir_unsafe',
  });
});

it('writes files atomically as 0600 and reads only private files', async () => {
  const file = join(root, 'f.json');
  await writePrivateFile(file, 'one');
  await writePrivateFile(file, 'two');
  expect(await mode(file)).toBe(0o600);
  expect(await readPrivateFile(file)).toBe('two');
  expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual(
    [],
  );
  expect(await readPrivateFile(join(root, 'missing'))).toBeUndefined();
  await chmod(file, 0o644);
  await expect(readPrivateFile(file)).rejects.toMatchObject({
    code: 'state_dir_unsafe',
  });
  const link = join(root, 'link');
  await symlink(file, link);
  await expect(readPrivateFile(link)).rejects.toMatchObject({
    code: 'state_dir_unsafe',
  });
});

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

it('runs critical sections one at a time and releases the lock', async () => {
  const lock = join(root, '.lock');
  let inside = 0;
  let overlapped = false;
  await Promise.all(
    [1, 2, 3, 4].map(() =>
      withFileLock(
        lock,
        async () => {
          inside += 1;
          overlapped ||= inside > 1;
          await sleep(20);
          inside -= 1;
        },
        { pollMs: 5 },
      ),
    ),
  );
  expect(overlapped).toBe(false);
  expect(existsSync(lock)).toBe(false);
  await expect(
    withFileLock(lock, async () => {
      throw new Error('boom');
    }),
  ).rejects.toThrow('boom');
  expect(existsSync(lock)).toBe(false);
});

it('times out behind a live holder', async () => {
  const lock = join(root, '.lock');
  await writeFile(
    lock,
    JSON.stringify({ pid: process.pid, token: 'x', createdAt: Date.now() }),
    { mode: 0o600 },
  );
  await expect(
    withFileLock(lock, async () => 1, { timeoutMs: 150, pollMs: 10 }),
  ).rejects.toMatchObject({ code: 'lock_timeout' });
  expect(existsSync(lock)).toBe(true);
});

const writeLock = (path: string, metadata: object | string) =>
  writeFile(
    path,
    typeof metadata === 'string' ? metadata : JSON.stringify(metadata),
    { mode: 0o600 },
  );
const longAgo = (ms: number) => new Date(Date.now() - ms);

it('takes over a lock at once when its owner process is gone', async () => {
  const lock = join(root, '.lock');
  const dead = spawn(process.execPath, ['-e', '0']);
  await new Promise((done) => dead.on('exit', done));
  // Brand new, and with a long staleMs: only the dead pid makes it stale.
  await writeLock(lock, { pid: dead.pid, token: 'x', createdAt: Date.now() });
  const started = Date.now();
  await expect(
    withFileLock(lock, async () => 'dead', { staleMs: 3_600_000 }),
  ).resolves.toBe('dead');
  expect(Date.now() - started).toBeLessThan(1_000);
});

it('never takes a lock from a live owner, however old it is', async () => {
  const lock = join(root, '.lock');
  await writeLock(lock, {
    pid: process.pid,
    token: 'live-owner',
    createdAt: Date.now() - 3_600_000,
  });
  await expect(
    withFileLock(lock, async () => 'stolen', {
      staleMs: 1_000,
      timeoutMs: 200,
      pollMs: 10,
    }),
  ).rejects.toMatchObject({ code: 'lock_timeout' });
  expect(JSON.parse(await readFile(lock, 'utf8')).token).toBe('live-owner');
});

it('decides by age only when the lock names no usable owner', async () => {
  const lock = join(root, '.lock');
  const quick = { staleMs: 1_000, timeoutMs: 150, pollMs: 10 };
  // Valid metadata but no pid (or a nonsense one): fresh is respected, old is not.
  for (const noPid of [{}, { pid: 'abc' }, { pid: null }]) {
    await writeLock(lock, { ...noPid, token: 'x', createdAt: Date.now() });
    await expect(
      withFileLock(lock, async () => 1, quick),
    ).rejects.toMatchObject({ code: 'lock_timeout' });
    await writeLock(lock, {
      ...noPid,
      token: 'x',
      createdAt: Date.now() - 5_000,
    });
    await expect(withFileLock(lock, async () => 'old', quick)).resolves.toBe(
      'old',
    );
  }
  // Empty or damaged metadata: a creator may still be writing, so a brief grace.
  for (const damaged of ['', '{nope', 'null']) {
    await writeLock(lock, damaged);
    await expect(
      withFileLock(lock, async () => 1, quick),
    ).rejects.toMatchObject({ code: 'lock_timeout' });
    await utimes(lock, longAgo(10_000), longAgo(10_000));
    await expect(
      withFileLock(lock, async () => 'damaged', quick),
    ).resolves.toBe('damaged');
  }
});

it('does not delete a lock that another process now owns', async () => {
  const lock = join(root, '.lock');
  await withFileLock(lock, async () => {
    await writeFile(
      lock,
      JSON.stringify({
        pid: process.pid,
        token: 'taker',
        createdAt: Date.now(),
      }),
      { mode: 0o600 },
    );
  });
  expect(existsSync(lock)).toBe(true);
});

it('recovers after the holder is killed with SIGKILL', async () => {
  const lock = join(root, '.lock');
  const module = pathToFileURL(
    new URL('../src/server/private-fs.ts', import.meta.url).pathname,
  ).href;
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `import { withFileLock } from ${JSON.stringify(module)};
       await withFileLock(${JSON.stringify(lock)}, async () => {
         console.log('locked');
         await new Promise(() => {});
       });`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await new Promise<void>((done, fail) => {
    child.stdout.on(
      'data',
      (chunk) => String(chunk).includes('locked') && done(),
    );
    child.on('exit', () => fail(new Error('child exited early')));
  }).catch((error) => {
    child.kill('SIGKILL');
    throw error;
  });
  expect(existsSync(lock)).toBe(true);
  child.kill('SIGKILL');
  await new Promise((done) => child.on('exit', done));
  expect(existsSync(lock)).toBe(true); // the dead holder left it behind
  const started = Date.now();
  await expect(withFileLock(lock, async () => 'recovered')).resolves.toBe(
    'recovered',
  );
  expect(Date.now() - started).toBeLessThan(2_000);
  expect((await lstat(root)).isDirectory()).toBe(true);
}, 30_000);
