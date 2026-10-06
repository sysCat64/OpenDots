import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkspaceStore } from '../../src/server/workspace';
import { startTrap, type Trap } from './telemetry-trap';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
export const OWNER_ID = 'opendots-owner';
export const THREAD_ID = 'server-entry-thread';

export interface ServerOptions {
  // Import the CopilotKit runtime before the application starts, the way an
  // entry that initialises the SDK ahead of the guard would.
  sdkFirst?: boolean;
  // OWNER_TOKEN for the server. Defaults to a fresh random synthetic token;
  // null leaves it unset.
  ownerToken?: string | null;
  // Extra environment. A value of undefined removes the variable.
  env?: Record<string, string | undefined>;
  // Bind a thread to the first Dot in the database before the server starts.
  seedThread?: boolean;
}

export interface ServerProcess {
  token: string | undefined;
  dir: string;
  database: string;
  dotId?: string;
  threadId?: string;
  trap: Trap;
  // Port, once the server reports it is listening; rejects if it exits first.
  ready: Promise<number>;
  // Exit code; resolves whenever the process ends.
  exited: Promise<number | null>;
  output(): string;
  // Destinations of refused non-loopback connection attempts.
  blocked(): string[];
  // The database file and its write-ahead log and shared-memory files.
  databaseBytes(): Buffer;
  stop(): Promise<void>;
}

// A random token is synthetic: it exists only for one test process.
export const randomToken = () => randomBytes(24).toString('hex');

export function readLines(path: string): string[] {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// Starts the real server entry (src/server/index.ts) in a fresh process against
// a temp database and loopback-only service URLs, with every non-loopback
// connection refused. Callers must await stop().
export function spawnServer(options: ServerOptions = {}): ServerProcess {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-server-'));
  const database = join(dir, 'server.sqlite');
  const guardLog = join(dir, 'blocked.txt');
  const token =
    options.ownerToken === null
      ? undefined
      : (options.ownerToken ?? randomToken());
  let dotId: string | undefined;
  if (options.seedThread) {
    const workspace = new WorkspaceStore(database, OWNER_ID);
    dotId = workspace.dots()[0].id;
    workspace.bindThread(THREAD_ID, dotId, 'Probe');
    workspace.close();
  }
  const sinkReady = startTrap();
  const args = [
    '--import',
    'tsx',
    '--import',
    './tests/fixtures/telemetry/net-guard.ts',
    ...(options.sdkFirst
      ? ['--import', './tests/fixtures/telemetry/sdk-first.ts']
      : []),
    'src/server/index.ts',
  ];
  let output = '';
  let trap: Trap | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  const exited = sinkReady.then(
    (started) =>
      new Promise<number | null>((resolve) => {
        trap = started;
        // Nothing from the developer's shell leaks in: every setting under
        // test comes from the options.
        const env: Record<string, string | undefined> = {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? dir,
          TMPDIR: process.env.TMPDIR ?? tmpdir(),
          HOST: '127.0.0.1',
          PORT: '0',
          DATABASE_PATH: database,
          OWNER_ID,
          OWNER_TOKEN: token,
          INTELLIGENCE_API_KEY: 'server-entry-key',
          INTELLIGENCE_API_URL: 'http://127.0.0.1:9',
          INTELLIGENCE_WS_URL: 'ws://127.0.0.1:9',
          COPILOTKIT_TELEMETRY_URL: started.url,
          OPENDOTS_NET_GUARD_LOG: guardLog,
          ...options.env,
        };
        child = spawn(process.execPath, args, {
          cwd: repoRoot,
          env: Object.fromEntries(
            Object.entries(env).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
        });
        child.stdout?.on('data', (chunk) => (output += chunk));
        child.stderr?.on('data', (chunk) => (output += chunk));
        child.once('exit', (code) => resolve(code));
      }),
  );
  const ready = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Server did not start.\n${output}`)),
      90_000,
    );
    const poll = setInterval(() => {
      const match = output.match(/listening on http:\/\/[^:]+:(\d+)/);
      if (match) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve(Number(match[1]));
      }
    }, 50);
    void exited.then((code) => {
      clearTimeout(timer);
      clearInterval(poll);
      reject(new Error(`Server exited with ${code}.\n${output}`));
    });
  });
  // A caller that only waits for the exit never reads `ready`.
  ready.catch(() => undefined);
  let stopped: Promise<void> | undefined;
  return {
    token,
    dir,
    database,
    dotId,
    threadId: options.seedThread ? THREAD_ID : undefined,
    get trap() {
      return trap as Trap;
    },
    ready,
    exited,
    output: () => output,
    blocked: () => readLines(guardLog),
    databaseBytes: () =>
      Buffer.concat(
        [database, `${database}-wal`, `${database}-shm`]
          .filter((path) => existsSync(path))
          .map((path) => readFileSync(path)),
      ),
    stop: () =>
      (stopped ??= (async () => {
        await sinkReady;
        child?.kill('SIGTERM');
        const killer = setTimeout(() => child?.kill('SIGKILL'), 10_000);
        await exited;
        clearTimeout(killer);
        await trap?.close();
        rmSync(dir, { recursive: true, force: true });
      })()),
  };
}
