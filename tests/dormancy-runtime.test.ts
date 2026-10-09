import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
const DORMANT = /conversation-log|run-rules|durable-runner|headless-local/;

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
    ['durable-runner', './src/server/durable-runner.ts'],
    ['headless-local', './src/server/headless-local.ts'],
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

// D7/D8 (docs/LOCAL_FIRST_C5_LANDING_BOUNDARY.md). The adapter can be loaded on
// purpose, and doing so is inert: it pulls in the existing currentTurnText
// (headless.ts, which imports the CopilotKit client) but opens no socket, no
// database and no file, starts no runtime, registers no process handler and
// replaces no global. The one process-wide effect is the telemetry guard that
// every server module already applies.
describe('importing the headless adapter on purpose has no side effect (D7, D8)', () => {
  it('loads exactly its own dependencies and does nothing else', () => {
    const log = traceFile();
    const home = mkdtempSync(
      join(realpathSync(tmpdir()), 'opendots-c5-import-'),
    );
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const script = `
        import net from 'node:net';
        let sockets = 0;
        const connect = net.Socket.prototype.connect;
        net.Socket.prototype.connect = function (...args) { sockets += 1; return connect.apply(this, args); };
        const events = ['exit', 'beforeExit', 'SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection', 'warning'];
        const count = () => Object.fromEntries(events.map((e) => [e, process.listenerCount(e)]));
        const env = { ...process.env };
        const fetchBefore = globalThis.fetch;
        const listenersBefore = count();
        const mod = await import(${JSON.stringify(join(root, 'src/server/headless-local.ts'))});
        const changed = Object.keys(process.env).filter((k) => process.env[k] !== env[k]).sort();
        console.log('RESULT ' + JSON.stringify({
          exports: Object.keys(mod).sort(),
          sockets,
          changedEnv: changed,
          listenersChanged: JSON.stringify(count()) !== JSON.stringify(listenersBefore),
          fetchReplaced: globalThis.fetch !== fetchBefore,
        }));
      `;
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: home,
          TMPDIR: home,
          NODE_OPTIONS: `--import ${TRACE}`,
          OPENDOTS_MODULE_TRACE_LOG: log,
        },
      },
    );
    // It ended on its own: nothing kept the process alive (no server, timer
    // or open handle).
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    const line = result.stdout.split('\n').find((l) => l.startsWith('RESULT '));
    const observed = JSON.parse(line!.slice('RESULT '.length));
    expect(observed.exports).toEqual([
      'DEFAULT_ABORT_GRACE_MS',
      'HeadlessTurnError',
      'ThreadBusyError',
      'runLocalTurn',
    ]);
    expect(observed.sockets).toBe(0);
    expect(observed.listenersChanged).toBe(false);
    expect(observed.fetchReplaced).toBe(false);
    // Only the telemetry guard's protective assignments.
    expect(observed.changedEnv).toEqual([
      'COPILOTKIT_TELEMETRY_DISABLED',
      'DO_NOT_TRACK',
    ]);
    // The application modules it loaded: the adapter, the runner with its log
    // and rules, the guard, headless.ts (for currentTurnText) and the shared
    // voice prefix. No store, workspace, platform, app, voice, scheduler or
    // entry point, so no database is opened and no table can be created.
    const own = `${pathToFileURL(join(root, 'src')).href}/`;
    const modules = loaded(log)
      .filter((url) => url.startsWith(own))
      .map((url) => url.slice(own.length))
      .sort();
    expect([...new Set(modules)]).toEqual([
      'server/conversation-log.ts',
      'server/durable-runner.ts',
      'server/headless-local.ts',
      'server/headless.ts',
      'server/run-rules.ts',
      'server/telemetry-guard.ts',
      'shared/voice-receipt.ts',
    ]);
    // Nothing was written anywhere it could have been (its HOME and TMPDIR),
    // apart from the tsx loader's own cache directory.
    expect(readdirSync(home).filter((name) => !/^tsx-/.test(name))).toEqual([]);
  }, 90_000);
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
