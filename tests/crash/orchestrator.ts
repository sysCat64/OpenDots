import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BaseEvent, Message } from '@ag-ui/core';
import type { ReadyResult } from '../../src/server/durable-runner';
import {
  createThrowawayDatabase,
  openThrowawayDatabase,
  type ThrowawayDatabase,
} from '../helpers/throwaway-db';

// Starts, waits for and kills the child process of child.ts. Every database is
// a throwaway whose path goes to the child through argv; the child's
// environment holds nothing but PATH, plus a decoy production path that must be
// ignored.
const root = fileURLToPath(new URL('../../', import.meta.url));
const CHILD = fileURLToPath(new URL('./child.ts', import.meta.url));

export const DECOY_DATABASE =
  '/nonexistent-opendots-production/opendots.sqlite';

export interface Workspace {
  throwaway: ThrowawayDatabase;
  db: string;
  dir: string;
  marker: string;
  cleanup(): void;
}

export function createWorkspace(): Workspace {
  const throwaway = createThrowawayDatabase();
  throwaway.db.close();
  return {
    throwaway,
    db: throwaway.path,
    dir: join(throwaway.dir, 'run'),
    marker: join(throwaway.dir, 'run', 'marker.json'),
    cleanup: () => throwaway.cleanup(),
  };
}

export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface ChildHandle {
  pid: number;
  kill(): void;
  exited: Promise<ChildExit>;
}

// A V8 or runtime crash of the host (R33), as opposed to the injected SIGKILL
// or an assertion in the test. Recorded, and the whole test rerun once.
export class HostInstabilityError extends Error {
  constructor(readonly detail: string) {
    super(`Host instability (R33): ${detail}`);
    this.name = 'HostInstabilityError';
  }
}
const HOST_SIGNALS = new Set([
  'SIGSEGV',
  'SIGABRT',
  'SIGILL',
  'SIGBUS',
  'SIGTRAP',
]);
export function classifyExit(exit: ChildExit): void {
  if (exit.signal && HOST_SIGNALS.has(exit.signal))
    throw new HostInstabilityError(`child ended with ${exit.signal}`);
  if (
    /FATAL ERROR|Fatal process out of memory|V8 /.test(exit.stderr) &&
    exit.code !== 0
  )
    throw new HostInstabilityError(exit.stderr.split('\n')[0]);
}

export const hostInstability: string[] = [];
export async function withHostRetry<T>(
  name: string,
  test: () => Promise<T>,
): Promise<T> {
  try {
    return await test();
  } catch (error) {
    if (!(error instanceof HostInstabilityError)) throw error;
    hostInstability.push(`${name}: ${error.detail}`);
    console.warn(
      `R33 host instability in "${name}": ${error.detail}; rerunning the whole test once`,
    );
    return test();
  }
}

// Children that have not exited, so a failed test can never leave a frozen
// process behind.
const live = new Set<ChildHandle>();
export function killLiveChildren(): void {
  for (const handle of live) handle.kill();
  live.clear();
}

export function start(
  mode: string,
  db: string,
  ...args: string[]
): ChildHandle {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', CHILD, mode, db, ...args],
    {
      cwd: root,
      // No DATABASE_PATH discovery: the decoy proves the environment is not read.
      env: {
        PATH: process.env.PATH ?? '',
        // Where the operating system keeps temporary files: the child applies the
        // throwaway check against its own view of it.
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        DATABASE_PATH: DECOY_DATABASE,
        OPENDOTS_DATABASE: DECOY_DATABASE,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const exited = new Promise<ChildExit>((resolve) =>
    child.on('exit', (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    ),
  );
  const handle: ChildHandle = {
    pid: child.pid!,
    kill: () => child.kill('SIGKILL'),
    exited,
  };
  live.add(handle);
  void exited.then(() => live.delete(handle));
  return handle;
}

export async function waitForMarker(
  workspace: Workspace,
  handle: ChildHandle,
): Promise<{ pid: number; after: string }> {
  let early: ChildExit | undefined;
  void handle.exited.then((exit) => (early = exit));
  for (let i = 0; i < 6000; i++) {
    if (existsSync(workspace.marker)) {
      const text = readFileSync(workspace.marker, 'utf8');
      if (text) return JSON.parse(text);
    }
    if (early) {
      classifyExit(early);
      throw new Error(
        `child ended before the kill point (code ${early.code}, signal ${early.signal}): ${early.stderr}\n${early.stdout}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  handle.kill();
  throw new Error('timed out waiting for the freeze marker');
}

// Runs a scenario until it freezes at its kill point, then kills it with SIGKILL.
export async function runAndKill(
  workspace: Workspace,
  scenario: string,
): Promise<{ after: string }> {
  const handle = start('run', workspace.db, scenario, workspace.dir);
  const frozen = await waitForMarker(workspace, handle);
  handle.kill();
  const exit = await handle.exited;
  classifyExit(exit);
  if (exit.signal !== 'SIGKILL')
    throw new Error(
      `expected SIGKILL, got ${exit.signal} / ${exit.code}: ${exit.stderr}`,
    );
  return { after: frozen.after };
}

export interface Report {
  ready?: ReadyResult;
  replay: string[];
  replayEvents: BaseEvent[];
  messages: Message[];
  threads: string[];
  counters: { provider: number; tool: number };
  completed?: boolean;
  types?: string[];
}

// Runs a child that finishes by itself and returns what it printed.
export async function runChild(
  mode: string,
  workspace: Workspace,
  ...args: string[]
): Promise<Report> {
  const handle = start(mode, workspace.db, ...args);
  const exit = await handle.exited;
  classifyExit(exit);
  if (exit.code !== 0)
    throw new Error(
      `child ${mode} failed (code ${exit.code}, signal ${exit.signal}): ${exit.stderr}`,
    );
  const line = exit.stdout.split('\n').find((l) => l.startsWith('RESULT '));
  if (!line) throw new Error(`child ${mode} printed no result: ${exit.stdout}`);
  return JSON.parse(line.slice('RESULT '.length));
}

export const recoverChild = (workspace: Workspace) =>
  runChild('recover', workspace, workspace.dir);
export const readChild = (workspace: Workspace) =>
  runChild('read', workspace, workspace.dir);

// The database as the parent sees it: a fresh connection to the same file.
export function inspect<T>(
  workspace: Workspace,
  work: (db: ReturnType<typeof openThrowawayDatabase>) => T,
): T {
  const db = openThrowawayDatabase(workspace.db);
  try {
    return work(db);
  } finally {
    db.close();
  }
}
