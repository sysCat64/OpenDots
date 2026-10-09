import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BaseEvent } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { ConversationLog } from '../../src/server/conversation-log';
import { DurableAgentRunner } from '../../src/server/durable-runner';
import { classifyRun } from '../../src/server/run-rules';
import {
  RUN,
  THREAD,
  createDotWorld,
  openWitness,
  readWitness,
  tuple,
} from '../helpers/dot-fence-fixture';
import { CLIENT_EXECUTABLE } from '../helpers/event-fixtures';
import { installNetworkGuard, netStats } from '../helpers/net-guard';
import { ProbeLog } from '../helpers/probe-log';
import { openThrowawayDatabase } from '../helpers/throwaway-db';

installNetworkGuard();

// The PRODUCTION DotAgent in its own process, driven by the production
// DurableAgentRunner into a file database, with a real WorkspaceStore side
// effect and a separate witness file. It freezes (Atomics.wait) at the chosen
// point so the parent can SIGKILL it. Everything comes from argv; no
// environment is read.
//   dot-child.ts run <db> <dir> <specJson>
//   dot-child.ts recover <db> <dir>
const [mode, dbPath, dir, specJson] = process.argv.slice(2);
mkdirSync(dir, { recursive: true });
const marker = join(dir, 'marker.json');

export interface DotChildSpec {
  argChunks?: number;
  twoTools?: boolean;
  // Freeze in the executor, after the witness says it entered / the side effect
  // committed, at the n-th executor entry.
  freezeExecutor?: { point: 'entered' | 'committed'; n?: number };
  // Freeze (a blocked or dead storage layer) just BEFORE the append of this event.
  freezeBeforeAppend?: { type: string; nth?: number };
}

function freezeForever(detail: unknown): never {
  writeFileSync(marker, JSON.stringify({ pid: process.pid, detail }));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error('unreachable');
}

if (mode === 'run') {
  const spec = JSON.parse(specJson) as DotChildSpec;
  const db = openThrowawayDatabase(dbPath);
  const observer = openThrowawayDatabase(dbPath);
  const witness = openWitness(join(dir, 'witness.sqlite'));
  const log = new ProbeLog(db);
  log.ensureSchema();
  const state = () => ({
    durable: tuple(observer),
    witness: readWitness(witness),
    net: { ...netStats },
  });
  if (spec.freezeBeforeAppend) {
    let seen = 0;
    const target = spec.freezeBeforeAppend;
    log.beforeAppend = (events) => {
      for (const event of events)
        if (event.type === target.type && ++seen === (target.nth ?? 1))
          freezeForever({ at: `before append of ${target.type}`, ...state() });
    };
  }
  const world = createDotWorld({
    observer,
    witness,
    argChunks: spec.argChunks,
    twoTools: spec.twoTools,
    freezeAt: (point, n) => {
      const target = spec.freezeExecutor;
      if (target && target.point === point && n === (target.n ?? 1))
        freezeForever({ at: `executor ${point} #${n}`, ...state() });
    },
  });
  const runner = new DurableAgentRunner({
    log,
    clientExecutableToolNames: CLIENT_EXECUTABLE,
    ownsThread: () => true,
  });
  await lastValueFrom(
    runner
      .run({
        threadId: THREAD,
        agent: world.agent as never,
        input: world.input,
      })
      .pipe(toArray()),
    { defaultValue: [] as BaseEvent[] },
  );
  process.stdout.write(
    `RESULT ${JSON.stringify({ completed: true, durable: tuple(observer) })}\n`,
  );
} else if (mode === 'recover') {
  // Recovery must make zero provider calls and run zero tools: any fetch is a
  // failure of the test and is counted.
  let providerCalls = 0;
  globalThis.fetch = (async () => {
    providerCalls += 1;
    throw new Error('recovery must not call a provider');
  }) as typeof fetch;
  const db = openThrowawayDatabase(dbPath);
  const witness = openWitness(join(dir, 'witness.sqlite'));
  const log = new ConversationLog(db);
  const before = readWitness(witness);
  const events = log.hasSchema()
    ? log.runEvents(THREAD, RUN).map((s) => s.event as unknown as BaseEvent)
    : [];
  const classification = events.length
    ? classifyRun(events, CLIENT_EXECUTABLE)
    : null;
  const typesBefore = events.map((e) => e.type as string);
  const runner = new DurableAgentRunner({
    log,
    clientExecutableToolNames: CLIENT_EXECUTABLE,
    ownsThread: () => true,
  });
  const ready = await runner.ready();
  const replay = await lastValueFrom(
    runner.connect({ threadId: THREAD }).pipe(toArray()),
    { defaultValue: [] as BaseEvent[] },
  );
  const after = log
    .runEvents(THREAD, RUN)
    .map((s) => s.event as unknown as Record<string, unknown>);
  process.stdout.write(
    `RESULT ${JSON.stringify({
      classification: classification?.kind ?? null,
      recovered: ready.recovered,
      status: log.getRun(THREAD, RUN)?.status,
      typesBefore,
      appended: after.slice(typesBefore.length).map((e) => ({
        type: e.type,
        content: e.content,
        message: e.message,
        code: e.code,
      })),
      replayTypes: replay.map((e) => e.type),
      witnessBefore: before,
      witnessAfter: readWitness(witness),
      providerCalls,
      net: { ...netStats },
    })}\n`,
  );
} else throw new Error(`unknown mode ${mode}`);
