import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkspaceStore } from '../../src/server/workspace';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const OWNER = 'opendots-owner';
const THREAD = 'telemetry-probe-thread';

export interface Trap {
  url: string;
  events: string[];
  close(): Promise<void>;
}

// A loopback stand-in for the telemetry sink. Every POST is one telemetry
// attempt; the SDK reads its destination from COPILOTKIT_TELEMETRY_URL.
export async function startTrap(): Promise<Trap> {
  const events: string[] = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      try {
        events.push(String(JSON.parse(body).event));
      } catch {
        events.push('unparsed');
      }
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/ingest`,
    events,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export interface EntryOptions {
  // Import the CopilotKit runtime before the application starts, the way an
  // entry that initialises the SDK ahead of the guard would.
  sdkFirst?: boolean;
  // Extra environment for the server, e.g. a hostile telemetry setting.
  env?: Record<string, string>;
}

export interface EntryResult {
  // One element per telemetry POST that reached the loopback trap.
  events: string[];
  // Destinations of refused non-loopback connection attempts.
  blocked: string[];
  output: string;
  infoStatus: number;
  runStatus: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Starts the real server entry (src/server/index.ts) in a fresh process against
// a temp database and loopback-only Intelligence URLs, sends it an /info request
// and a run request for a bound thread, then reports what it tried to send.
export async function runServerEntry(
  options: EntryOptions = {},
): Promise<EntryResult> {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-telemetry-'));
  const database = join(dir, 'probe.sqlite');
  const guardLog = join(dir, 'blocked.txt');
  const trap = await startTrap();
  const workspace = new WorkspaceStore(database, OWNER);
  const dotId = workspace.dots()[0].id;
  workspace.bindThread(THREAD, dotId, 'Probe');
  workspace.close();
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
  // Nothing from the developer's shell leaks in: the telemetry settings under
  // test come only from options.env.
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? dir,
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      HOST: '127.0.0.1',
      PORT: '0',
      DATABASE_PATH: database,
      OWNER_ID: OWNER,
      INTELLIGENCE_API_KEY: 'telemetry-probe-key',
      INTELLIGENCE_API_URL: 'http://127.0.0.1:9',
      INTELLIGENCE_WS_URL: 'ws://127.0.0.1:9',
      COPILOTKIT_TELEMETRY_URL: trap.url,
      OPENDOTS_NET_GUARD_LOG: guardLog,
      ...options.env,
    },
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  );
  try {
    const port = await new Promise<number>((resolve, reject) => {
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
      child.once('exit', (code) => {
        clearTimeout(timer);
        clearInterval(poll);
        reject(new Error(`Server exited with ${code}.\n${output}`));
      });
    });
    const base = `http://127.0.0.1:${port}/api/copilotkit`;
    const info = await fetch(`${base}/info`);
    const run = await fetch(`${base}/agent/${dotId}/run`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({
        threadId: THREAD,
        runId: 'telemetry-probe-run',
        state: {},
        messages: [{ id: 'probe-message', role: 'user', content: 'hello' }],
        tools: [],
        context: [],
        forwardedProps: {},
      }),
    });
    await run.text();
    // Telemetry is sent in the background; loopback delivery takes milliseconds.
    await sleep(1500);
    return {
      events: [...trap.events],
      blocked: readLines(guardLog),
      output,
      infoStatus: info.status,
      runStatus: run.status,
    };
  } finally {
    child.kill('SIGTERM');
    const killer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    await exited;
    clearTimeout(killer);
    await trap.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export function readLines(path: string): string[] {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}
