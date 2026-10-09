import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openWitness, readWitness, tuple } from '../helpers/dot-fence-fixture';
import { openThrowawayDatabase } from '../helpers/throwaway-db';
import type { DotChildSpec } from './dot-child';
import {
  DECOY_DATABASE,
  classifyExit,
  createWorkspace,
  withHostRetry,
  type Workspace,
} from './orchestrator';

// Real SIGKILL of the PRODUCTION DotAgent running through the production
// DurableAgentRunner. For every window: the durable conversation prefix, whether
// the executor was entered, the side-effect witness (a separate SQLite file),
// the recovery classification and what recovery did. The fence's own invariant:
// a side effect never exists without durable START and END of its tool call.
const root = fileURLToPath(new URL('../../', import.meta.url));
const CHILD = fileURLToPath(new URL('./dot-child.ts', import.meta.url));

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}
const live = new Set<() => void>();
const workspaces: Workspace[] = [];
afterEach(() => {
  for (const kill of live) kill();
  live.clear();
  while (workspaces.length) workspaces.pop()!.cleanup();
});

function spawnChild(args: string[]) {
  const child = spawn(process.execPath, ['--import', 'tsx', CHILD, ...args], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '',
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      DATABASE_PATH: DECOY_DATABASE,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => (stdout += c));
  child.stderr.on('data', (c) => (stderr += c));
  const exited = new Promise<Exit>((resolve) =>
    child.on('exit', (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    ),
  );
  const kill = () => child.kill('SIGKILL');
  live.add(kill);
  return { kill, exited };
}

async function runAndKill(workspace: Workspace, spec: DotChildSpec) {
  const child = spawnChild([
    'run',
    workspace.db,
    workspace.dir,
    JSON.stringify(spec),
  ]);
  let early: Exit | undefined;
  void child.exited.then((exit) => (early = exit));
  for (let i = 0; i < 6000; i++) {
    if (existsSync(workspace.marker) && readFileSync(workspace.marker, 'utf8'))
      break;
    if (early) {
      classifyExit(early);
      throw new Error(
        `child ended before the kill point: ${early.code}/${early.signal}\n${early.stderr}\n${early.stdout}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!existsSync(workspace.marker)) {
    child.kill();
    throw new Error('no freeze marker');
  }
  child.kill();
  const exit = await child.exited;
  classifyExit(exit);
  expect(exit.signal).toBe('SIGKILL');
  return JSON.parse(readFileSync(workspace.marker, 'utf8')) as {
    pid: number;
    detail: {
      at: string;
      durable: string[];
      witness: string[];
      net: { loopback: number; nonLoopback: string[] };
    };
  };
}

async function recover(workspace: Workspace) {
  const child = spawnChild(['recover', workspace.db, workspace.dir]);
  const exit = await child.exited;
  classifyExit(exit);
  if (exit.code !== 0) throw new Error(`recover failed: ${exit.stderr}`);
  const line = exit.stdout.split('\n').find((l) => l.startsWith('RESULT '))!;
  return JSON.parse(line.slice('RESULT '.length)) as {
    classification: string | null;
    status: string;
    typesBefore: string[];
    appended: Array<{ type: string; content?: string; message?: string }>;
    replayTypes: string[];
    witnessBefore: string[];
    witnessAfter: string[];
    providerCalls: number;
    net: { loopback: number; nonLoopback: string[] };
  };
}

interface Expected {
  witness: string[];
  hasEnd: boolean;
  hasResult: boolean;
  classification: string;
}
const WINDOWS: Array<[string, DotChildSpec, Expected]> = [
  [
    'K1 killed inside the executor, after TOOL_CALL_END was durable and before the side effect',
    { freezeExecutor: { point: 'entered' } },
    {
      witness: ['executorEntered'],
      hasEnd: true,
      hasResult: false,
      classification: 'server_unknown_outcome',
    },
  ],
  [
    'K1b killed after the side effect committed, before any TOOL_CALL_RESULT exists',
    { freezeExecutor: { point: 'committed' } },
    {
      witness: ['executorEntered', 'sideEffectCommitted'],
      hasEnd: true,
      hasResult: false,
      classification: 'server_unknown_outcome',
    },
  ],
  [
    'K2a persistence blocked before TOOL_CALL_START: no side effect',
    { freezeBeforeAppend: { type: 'TOOL_CALL_START' } },
    {
      witness: [],
      hasEnd: false,
      hasResult: false,
      classification: 'no_tool_lifecycle',
    },
  ],
  [
    'K2b persistence blocked before the last TOOL_CALL_ARGS: no side effect',
    { freezeBeforeAppend: { type: 'TOOL_CALL_ARGS', nth: 2 } },
    {
      witness: [],
      hasEnd: false,
      hasResult: false,
      classification: 'tool_args_incomplete',
    },
  ],
  [
    'K2c persistence blocked before TOOL_CALL_END: no side effect',
    { freezeBeforeAppend: { type: 'TOOL_CALL_END' } },
    {
      witness: [],
      hasEnd: false,
      hasResult: false,
      classification: 'tool_args_incomplete',
    },
  ],
  [
    'K3 side effect committed, storage blocked at the TOOL_CALL_RESULT',
    { freezeBeforeAppend: { type: 'TOOL_CALL_RESULT' } },
    {
      witness: ['executorEntered', 'sideEffectCommitted'],
      hasEnd: true,
      hasResult: false,
      classification: 'server_unknown_outcome',
    },
  ],
  [
    'K4 two tools: the first completed durably; storage blocked before the second TOOL_CALL_END',
    { twoTools: true, freezeBeforeAppend: { type: 'TOOL_CALL_END', nth: 2 } },
    {
      witness: ['executorEntered', 'sideEffectCommitted'],
      hasEnd: true,
      hasResult: true,
      classification: 'tool_args_incomplete',
    },
  ],
  [
    'K5 long stream (400 argument chunks), killed inside the executor',
    { argChunks: 400, freezeExecutor: { point: 'entered' } },
    {
      witness: ['executorEntered'],
      hasEnd: true,
      hasResult: false,
      classification: 'server_unknown_outcome',
    },
  ],
  [
    'K6 two tools: killed inside the second executor, after the first result was durable',
    { twoTools: true, freezeExecutor: { point: 'entered', n: 2 } },
    {
      witness: ['executorEntered', 'sideEffectCommitted', 'executorEntered'],
      hasEnd: true,
      hasResult: true,
      classification: 'server_unknown_outcome',
    },
  ],
];

describe('real SIGKILL of the production DotAgent behind the A1 fence', () => {
  for (const [name, spec, expected] of WINDOWS)
    it(name, () =>
      withHostRetry(name, async () => {
        const workspace = createWorkspace();
        workspaces.push(workspace);
        const frozen = await runAndKill(workspace, spec);
        // The parent reads the dead process's two databases.
        const db = openThrowawayDatabase(workspace.db);
        const witnessDb = openWitness(join(workspace.dir, 'witness.sqlite'));
        const durable = tuple(db);
        const witness = readWitness(witnessDb);
        db.close();
        witnessDb.close();
        const recovered = await recover(workspace);
        // The kill point is what the spec says; the databases agree with the
        // child's own report.
        expect(frozen.detail.witness).toEqual(witness);
        expect(durable).toEqual(frozen.detail.durable);
        expect(witness).toEqual(expected.witness);
        expect(durable.includes('TOOL_CALL_END')).toBe(expected.hasEnd);
        expect(durable.includes('TOOL_CALL_RESULT')).toBe(expected.hasResult);
        // The fence: no side effect without durable evidence of its call.
        if (witness.includes('executorEntered')) {
          expect(durable).toContain('TOOL_CALL_START');
          expect(durable).toContain('TOOL_CALL_END');
        }
        // Recovery: classified from the durable events alone, nothing re-run.
        expect(recovered.classification).toBe(expected.classification);
        expect(recovered.providerCalls).toBe(0);
        expect(recovered.witnessAfter).toEqual(recovered.witnessBefore);
        expect(recovered.status).toBe('interrupted');
        expect(frozen.detail.net.nonLoopback).toEqual([]);
        expect(recovered.net.nonLoopback).toEqual([]);
        if (expected.classification === 'server_unknown_outcome') {
          const text = JSON.stringify(recovered.appended);
          expect(text).not.toMatch(
            /did not run|never ran|not executed|not run\b/i,
          );
          expect(text).toMatch(/may or may not have run/);
        }
      }),
    );
});
