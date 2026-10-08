import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/server/store';
import { WorkspaceStore } from '../src/server/workspace';
import { startCounter, type Counter } from './helpers/counting-server';
import { OWNER_ID, randomToken, spawnServer } from './helpers/server-entry';
import { createThrowawayDatabase } from './helpers/throwaway-db';

// DORM-2 and DORM-3 (docs/LOCAL_FIRST_C4_LANDING_BOUNDARY.md, section 19,
// layers D2 and D3). A real server process is started with a module-resolution
// trace preloaded, against a disposable database, and driven through the flows
// the application serves today. The dormant modules must never be loaded and
// no conversation table may appear. The database is a throwaway under the temp
// directory; the real OpenDots database is never opened.
const SLOW = 180_000;
const root = fileURLToPath(new URL('../', import.meta.url));
const TRACE = fileURLToPath(
  new URL('./fixtures/dormancy/module-trace.mjs', import.meta.url),
);
const DORMANT = /conversation-log|run-rules|durable-runner/;

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const undo of cleanup.splice(0).reverse()) await undo();
});

function traceFile(): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'opendots-c4-trace-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'modules.txt');
}

const loaded = (log: string) => {
  try {
    return readFileSync(log, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

// type, name and sql of every schema object.
function schemaOf(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return JSON.stringify(
      db
        .prepare(
          'SELECT type, name, sql FROM sqlite_master ORDER BY type, name',
        )
        .all(),
    );
  } finally {
    db.close();
  }
}

describe('the trace itself can see a dormant module (positive control)', () => {
  it.each([
    ['conversation-log', './src/server/conversation-log.ts'],
    ['run-rules', './src/server/run-rules.ts'],
  ])(
    'reports %s when a process really loads it',
    (name, path) => {
      const log = traceFile();
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '--eval',
          `await import(${JSON.stringify(join(root, path))});`,
        ],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH ?? '',
            HOME: process.env.HOME ?? root,
            NODE_OPTIONS: `--import ${TRACE}`,
            OPENDOTS_MODULE_TRACE_LOG: log,
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(loaded(log).filter((url) => url.includes(name))).not.toEqual([]);
    },
    60_000,
  );
});

describe('a real server on a disposable database', () => {
  let intelligence: Counter;
  let provider: Counter;
  afterEach(async () => {
    await intelligence?.close();
    await provider?.close();
  });

  it(
    'loads neither dormant module and creates no conversation table (DORM-2, DORM-3)',
    async () => {
      // The schema the current code gives a database, built by its own
      // constructors in a throwaway directory.
      const baseline = createThrowawayDatabase();
      cleanup.push(() => baseline.cleanup());
      baseline.db.close();
      new Store(baseline.path).close();
      new WorkspaceStore(baseline.path, OWNER_ID).close();
      const expectedSchema = schemaOf(baseline.path);
      expect(expectedSchema).not.toContain('conversation_');

      intelligence = await startCounter();
      provider = await startCounter();
      const log = traceFile();
      const server = spawnServer({
        seedThread: true,
        env: {
          INTELLIGENCE_API_URL: intelligence.url,
          OPENAI_BASE_URL: provider.url,
          OPENAI_API_KEY: randomToken(),
          OPENAI_MODEL: 'fixture-model',
          NODE_OPTIONS: `--import ${TRACE}`,
          OPENDOTS_MODULE_TRACE_LOG: log,
        },
      });
      try {
        const port = await server.ready;
        const base = `http://127.0.0.1:${port}`;
        const { dotId, threadId } = server;
        const authorization = { Authorization: `Bearer ${server.token}` };
        const body = JSON.stringify({
          threadId,
          runId: 'dormancy-run',
          state: {},
          messages: [{ id: 'm1', role: 'user', content: 'hello' }],
          tools: [],
          context: [],
          forwardedProps: {},
        });
        const send = async (method: string, path: string, payload?: string) =>
          (
            await fetch(base + path, {
              method,
              headers: {
                ...authorization,
                ...(payload ? { 'content-type': 'application/json' } : {}),
              },
              body: payload,
            })
          ).status;

        // Normal flows: state, workspace, model, runtime info, thread reads,
        // an authorized run, connect and stop.
        for (const path of [
          '/api/state',
          '/api/workspace',
          '/api/model',
          '/api/copilotkit/info',
        ])
          expect(await send('GET', path), path).toBe(200);
        for (const [method, path, payload] of [
          ['GET', '/api/copilotkit/threads'],
          ['GET', `/api/copilotkit/threads/${threadId}/messages`],
          ['POST', `/api/copilotkit/agent/${dotId}/run`, body],
          ['POST', `/api/copilotkit/agent/${dotId}/connect`, body],
          ['POST', `/api/copilotkit/agent/${dotId}/stop/${threadId}`, '{}'],
        ] as const)
          expect([401], `${method} ${path}`).not.toContain(
            await send(method, path, payload),
          );
        // The current Intelligence path still serves the run: the stand-in for
        // Intelligence received it.
        expect(intelligence.count()).toBeGreaterThan(0);

        // DORM-2. The trace sees the application's own modules (so it works
        // under this process) and never one of the dormant ones.
        const modules = loaded(log);
        expect(
          modules.some((url) => url.endsWith('/src/server/index.ts')),
        ).toBe(true);
        expect(
          modules.some((url) => url.includes('/src/server/workspace')),
        ).toBe(true);
        expect(modules.filter((url) => DORMANT.test(url))).toEqual([]);

        // DORM-3. No conversation table, the schema is exactly what the
        // current code creates, no version change, and the identifier appears
        // nowhere in the database bytes (including the write-ahead log).
        const db = new DatabaseSync(server.database, { readOnly: true });
        try {
          expect(
            db
              .prepare(
                "SELECT name FROM sqlite_master WHERE name LIKE 'conversation\\_%' ESCAPE '\\'",
              )
              .all(),
          ).toEqual([]);
          expect(db.prepare('PRAGMA user_version').get()).toEqual({
            user_version: 0,
          });
        } finally {
          db.close();
        }
        expect(schemaOf(server.database)).toBe(expectedSchema);
        expect(server.databaseBytes().toString('latin1')).not.toContain(
          'conversation_',
        );

        // Nothing left the machine.
        expect(server.blocked()).toEqual([]);
        expect(server.trap.events).toEqual([]);
      } finally {
        await server.stop();
      }
    },
    SLOW,
  );
});
