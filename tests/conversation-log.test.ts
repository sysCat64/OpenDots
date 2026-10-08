import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BaseEvent } from '@ag-ui/core';
import {
  CONVERSATION_SCHEMA_SQL,
  ConversationLog,
  DuplicateRunError,
  RUN_STATUSES,
  RunNotRunningError,
  foldEvents,
} from '../src/server/conversation-log';
import { Store } from '../src/server/store';
import { WorkspaceStore } from '../src/server/workspace';
import { emittedImports } from './helpers/evaluation-order';
import {
  CLIENT_TOOL,
  SERVER_TOOL,
  callEvents,
  runError,
  runFinished,
  runStarted,
  textEvents,
  types,
  user,
} from './helpers/event-fixtures';
import {
  createThrowawayDatabase,
  openThrowawayDatabase,
  type ThrowawayDatabase,
} from './helpers/throwaway-db';

// L1 (schema, serialisation, invariants), the storage part of L2 and the
// derived-view part of L9, from docs/LOCAL_FIRST_C4_LANDING_BOUNDARY.md
// sections 5, 6, 9, 10 and 16. Every database is a throwaway under the temp
// directory (tests/helpers/throwaway-db.ts); none is a real OpenDots database.
const open: ThrowawayDatabase[] = [];
const extra: DatabaseSync[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of extra.splice(0))
    try {
      db.close();
    } catch {
      // already closed
    }
  for (const database of open.splice(0)) database.cleanup();
});

function throwaway(): ThrowawayDatabase {
  const database = createThrowawayDatabase();
  open.push(database);
  return database;
}

function fixture(options: { schema?: boolean; now?: () => number } = {}) {
  const database = throwaway();
  const log = new ConversationLog(database.db, { now: options.now });
  if (options.schema !== false) log.ensureSchema();
  return { ...database, log };
}

const rows = (db: DatabaseSync, sql: string, ...params: never[]) =>
  db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
const count = (db: DatabaseSync, table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const master = (db: DatabaseSync) =>
  rows(
    db,
    'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name',
  );
const sha256 = (path: string) =>
  createHash('sha256').update(readFileSync(path)).digest('hex');
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

// Everything every table holds, so two snapshots are equal only if nothing
// was written, updated or deleted between them.
function snapshot(db: DatabaseSync): string {
  const tables = rows(
    db,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).map((row) => String(row.name));
  return JSON.stringify(
    Object.fromEntries(
      tables.map((table) => [table, rows(db, `SELECT * FROM "${table}"`)]),
    ),
  );
}

const TABLES = [
  'conversation_events',
  'conversation_messages',
  'conversation_runs',
];

describe('dormancy: constructing a ConversationLog touches nothing', () => {
  it('creates no table', () => {
    const { db } = throwaway();
    const log = new ConversationLog(db);
    expect(master(db)).toEqual([]);
    expect(log.hasSchema()).toBe(false);
  });

  it('executes no SQL at all', () => {
    const { db } = throwaway();
    const calls: string[] = [];
    const spy = new Proxy(db, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, target) as unknown;
        if (property === 'exec' || property === 'prepare')
          return (...args: unknown[]) => {
            calls.push(`${String(property)}: ${String(args[0])}`);
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : Reflect.get(target, property, receiver);
      },
    });
    new ConversationLog(spy);
    expect(calls).toEqual([]);
  });

  it('leaves a database that already holds the application tables byte-identical', () => {
    const database = throwaway();
    // A database created by the current code: Store and WorkspaceStore tables.
    database.db.close();
    const store = new Store(database.path);
    store.close();
    const workspace = new WorkspaceStore(database.path, 'owner');
    workspace.close();
    const before = sha256(database.path);
    const db = openThrowawayDatabase(database.path);
    extra.push(db);
    const tablesBefore = master(db);
    const log = new ConversationLog(db);
    expect(sha256(database.path)).toBe(before);
    expect(master(db)).toEqual(tablesBefore);
    expect(tablesBefore.length).toBeGreaterThan(5);
    expect(log.hasSchema()).toBe(false);
    db.close();
    expect(sha256(database.path)).toBe(before);
  });

  it('changes no pragma, registers no process hook and makes no network call', () => {
    const { db } = throwaway();
    const pragmas = () =>
      [
        'journal_mode',
        'foreign_keys',
        'busy_timeout',
        'user_version',
        'synchronous',
      ]
        .map((name) => JSON.stringify(rows(db, `PRAGMA ${name}`)))
        .join('|');
    const hooks = () =>
      [
        'exit',
        'beforeExit',
        'uncaughtException',
        'unhandledRejection',
        'SIGINT',
        'SIGTERM',
        'warning',
      ]
        .map((name) => process.listenerCount(name))
        .join(',');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const before = [pragmas(), hooks()];
    new ConversationLog(db);
    expect([pragmas(), hooks()]).toEqual(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is not a side effect of any read before the schema exists', () => {
    const { db, path } = throwaway();
    const log = new ConversationLog(db);
    expect(log.hasSchema()).toBe(false);
    expect(master(db)).toEqual([]);
    expect(sha256(path)).toBe(sha256(path));
  });
});

describe('the frozen three-table schema (DEC-6, DEC-18)', () => {
  it('uses exactly the DDL of the approved boundary document', () => {
    const doc = readFileSync(
      fileURLToPath(
        new URL('../docs/LOCAL_FIRST_C4_LANDING_BOUNDARY.md', import.meta.url),
      ),
      'utf8',
    );
    const block = doc.match(/### 5\.1[\s\S]*?```sql\n([\s\S]*?)```/)?.[1];
    expect(block).toBeTruthy();
    expect(squash(CONVERSATION_SCHEMA_SQL)).toBe(squash(block!));
  });

  it('is created only by an explicit ensureSchema(): exactly the approved tables and indexes', () => {
    const { db, log } = fixture({ schema: false });
    expect(log.hasSchema()).toBe(false);
    log.ensureSchema();
    expect(log.hasSchema()).toBe(true);
    expect(
      master(db).map((row) => `${row.type}:${row.name}:${row.tbl_name}`),
    ).toEqual([
      'index:conversation_events_thread:conversation_events',
      'index:sqlite_autoindex_conversation_events_1:conversation_events',
      'index:sqlite_autoindex_conversation_messages_1:conversation_messages',
      'index:sqlite_autoindex_conversation_runs_1:conversation_runs',
      'index:sqlite_autoindex_conversation_runs_2:conversation_runs',
      'table:conversation_events:conversation_events',
      'table:conversation_messages:conversation_messages',
      'table:conversation_runs:conversation_runs',
      // Created by SQLite itself for AUTOINCREMENT.
      'table:sqlite_sequence:sqlite_sequence',
    ]);
  });

  it('is idempotent: a second ensureSchema() changes nothing and keeps the data', () => {
    const { db, log } = fixture();
    log.startRun({
      threadId: 't',
      runId: 'r',
      agentId: 'a',
      startEvent: runStarted(),
    });
    const schema = master(db);
    const data = snapshot(db);
    log.ensureSchema();
    log.ensureSchema();
    expect(master(db)).toEqual(schema);
    expect(snapshot(db)).toBe(data);
  });

  it('does not count a partial schema as present, and completes it', () => {
    const { db, log } = fixture({ schema: false });
    db.exec('CREATE TABLE conversation_runs(x TEXT)');
    expect(log.hasSchema()).toBe(false);
    db.exec('DROP TABLE conversation_runs');
    log.ensureSchema();
    expect(log.hasSchema()).toBe(true);
  });

  const columns = (db: DatabaseSync, table: string) =>
    rows(db, `PRAGMA table_info(${table})`).map(
      (c) =>
        `${c.name} ${c.type} notnull=${c.notnull} pk=${c.pk} default=${c.dflt_value}`,
    );

  it('conversation_runs: lifecycle and metadata columns', () => {
    expect(columns(fixture().db, 'conversation_runs')).toEqual([
      'threadId TEXT notnull=1 pk=1 default=null',
      'runId TEXT notnull=1 pk=2 default=null',
      'seq INTEGER notnull=1 pk=0 default=null',
      'agentId TEXT notnull=1 pk=0 default=null',
      'parentRunId TEXT notnull=0 pk=0 default=null',
      'status TEXT notnull=1 pk=0 default=null',
      'startedAt INTEGER notnull=1 pk=0 default=null',
      'finishedAt INTEGER notnull=0 pk=0 default=null',
    ]);
  });

  it('conversation_events: the authoritative history columns', () => {
    expect(columns(fixture().db, 'conversation_events')).toEqual([
      'id INTEGER notnull=0 pk=1 default=null',
      'threadId TEXT notnull=1 pk=0 default=null',
      'runId TEXT notnull=1 pk=0 default=null',
      'seq INTEGER notnull=1 pk=0 default=null',
      'eventType TEXT notnull=1 pk=0 default=null',
      'messageId TEXT notnull=0 pk=0 default=null',
      'eventJson TEXT notnull=1 pk=0 default=null',
    ]);
  });

  it('conversation_messages: exactly the derived view and its watermark', () => {
    expect(columns(fixture().db, 'conversation_messages')).toEqual([
      'threadId TEXT notnull=0 pk=1 default=null',
      'messagesJson TEXT notnull=1 pk=0 default=null',
      'lastEventId INTEGER notnull=1 pk=0 default=null',
    ]);
  });

  it('declares the approved keys, unique constraints and the one extra index', () => {
    const { db } = fixture();
    const indexes = (table: string) =>
      rows(db, `PRAGMA index_list(${table})`)
        .map((index) => ({
          name: String(index.name),
          unique: index.unique === 1,
          origin: String(index.origin),
          columns: rows(db, `PRAGMA index_info(${index.name})`).map((c) =>
            String(c.name),
          ),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    expect(indexes('conversation_runs')).toEqual([
      {
        name: 'sqlite_autoindex_conversation_runs_1',
        unique: true,
        origin: 'pk',
        columns: ['threadId', 'runId'],
      },
      {
        name: 'sqlite_autoindex_conversation_runs_2',
        unique: true,
        origin: 'u',
        columns: ['threadId', 'seq'],
      },
    ]);
    expect(indexes('conversation_events')).toEqual([
      {
        name: 'conversation_events_thread',
        unique: false,
        origin: 'c',
        columns: ['threadId', 'id'],
      },
      {
        name: 'sqlite_autoindex_conversation_events_1',
        unique: true,
        origin: 'u',
        columns: ['threadId', 'runId', 'seq'],
      },
    ]);
    expect(indexes('conversation_messages')).toEqual([
      {
        name: 'sqlite_autoindex_conversation_messages_1',
        unique: true,
        origin: 'pk',
        columns: ['threadId'],
      },
    ]);
    // The event id is an AUTOINCREMENT, so a deleted id is never reused.
    expect(
      String(
        rows(
          db,
          "SELECT sql FROM sqlite_master WHERE name='conversation_events'",
        )[0].sql,
      ),
    ).toContain('id INTEGER PRIMARY KEY AUTOINCREMENT');
  });

  it('has no foreign key, no CHECK constraint, no trigger, no view and no version table', () => {
    const { db } = fixture();
    for (const table of TABLES) {
      expect(rows(db, `PRAGMA foreign_key_list(${table})`), table).toEqual([]);
    }
    const sql = rows(db, 'SELECT sql FROM sqlite_master WHERE sql IS NOT NULL')
      .map((row) => String(row.sql))
      .join('\n');
    expect(sql).not.toMatch(/\bCHECK\b/i);
    expect(sql).not.toMatch(/\bREFERENCES\b/i);
    expect(sql).not.toMatch(/\bFOREIGN\b/i);
    expect(
      rows(
        db,
        "SELECT name FROM sqlite_master WHERE type IN ('trigger','view')",
      ),
    ).toEqual([]);
    expect(
      rows(
        db,
        "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%version%' OR name LIKE '%migration%' OR name LIKE '%schema%')",
      ),
    ).toEqual([]);
    expect(rows(db, 'PRAGMA user_version')).toEqual([{ user_version: 0 }]);
  });

  it('carries none of the R32 checkpoint fields deferred to C8', () => {
    const { db } = fixture();
    const names = TABLES.flatMap((table) =>
      rows(db, `PRAGMA table_info(${table})`).map((c) => String(c.name)),
    );
    for (const deferred of [
      'throughRunSeq',
      'throughEventSeq',
      'eventCount',
      'messagesSha256',
    ])
      expect(names, deferred).not.toContain(deferred);
    expect(
      names.filter((name) => /sha|through|count|checkpoint/i.test(name)),
    ).toEqual([]);
    // The only freshness field is the minimal C4 watermark.
    expect(
      rows(db, 'PRAGMA table_info(conversation_messages)').map((c) => c.name),
    ).toEqual(['threadId', 'messagesJson', 'lastEventId']);
  });

  it('names tables in snake_case and columns in camelCase (DEC-18)', () => {
    const { db } = fixture();
    for (const table of TABLES) expect(table).toMatch(/^[a-z]+(_[a-z]+)+$/);
    for (const table of TABLES)
      for (const column of rows(db, `PRAGMA table_info(${table})`))
        expect(String(column.name), `${table}.${column.name}`).toMatch(
          /^[a-z]+([A-Z][a-z]*)*$/,
        );
  });

  it('accepts a status the code would reject: no CHECK, the closed union is in code', () => {
    const { db, log } = fixture();
    db.exec(
      "INSERT INTO conversation_runs VALUES('t','r',1,'a',NULL,'abandoned',1,NULL)",
    );
    expect(RUN_STATUSES).toEqual([
      'running',
      'finished',
      'error',
      'stopped',
      'interrupted',
    ]);
    expect(log.checkInvariants().map((v) => v.invariant)).toContain('status');
  });
});

describe('event identity, run identity and the three tables (sections 6 and 10)', () => {
  const start = (
    log: ConversationLog,
    threadId: string,
    runId: string,
    tools: string[] = [],
  ) =>
    log.startRun({
      threadId,
      runId,
      agentId: 'dot',
      startEvent: runStarted(tools, [], { threadId, runId }),
    });

  it('starts a run: a running row and event seq 0 in one step', () => {
    let clock = 1000;
    const { log, db } = fixture({ now: () => clock++ });
    const { run, event } = start(log, 't', 'r1');
    expect(run).toEqual({
      threadId: 't',
      runId: 'r1',
      seq: 1,
      agentId: 'dot',
      parentRunId: null,
      status: 'running',
      startedAt: 1000,
      finishedAt: null,
    });
    expect(event).toMatchObject({
      threadId: 't',
      runId: 'r1',
      seq: 0,
      eventType: 'RUN_STARTED',
      messageId: null,
    });
    expect(event.id).toBe(1);
    expect(count(db, 'conversation_runs')).toBe(1);
    expect(count(db, 'conversation_events')).toBe(1);
  });

  it('orders runs of a thread 1..m and links each to the previous one', () => {
    const { log } = fixture();
    start(log, 't', 'r1');
    log.appendEvent('t', 'r1', runFinished('t', 'r1'));
    const second = start(log, 't', 'r2').run;
    expect([second.seq, second.parentRunId]).toEqual([2, 'r1']);
    // Another thread numbers its own runs from 1.
    const other = start(log, 'u', 'r1').run;
    expect([other.seq, other.parentRunId]).toEqual([1, null]);
    expect(log.runs('t').map((run) => [run.runId, run.seq])).toEqual([
      ['r1', 1],
      ['r2', 2],
    ]);
  });

  it('rejects a duplicate (threadId, runId) before writing anything, whatever its status', () => {
    const { log, db } = fixture();
    start(log, 't', 'r1');
    for (const terminal of [undefined, runFinished('t', 'r1')]) {
      if (terminal) log.appendEvent('t', 'r1', terminal);
      const before = snapshot(db);
      expect(() => start(log, 't', 'r1')).toThrow(DuplicateRunError);
      try {
        start(log, 't', 'r1');
      } catch (error) {
        expect((error as DuplicateRunError).code).toBe('DUPLICATE_RUN_ID');
      }
      expect(snapshot(db)).toBe(before);
    }
  });

  it('rejects a duplicate runId across a restart, and accepts the same runId on another thread', () => {
    const database = throwaway();
    const first = new ConversationLog(database.db);
    first.ensureSchema();
    start(first, 't', 'r1');
    first.appendEvent('t', 'r1', runFinished('t', 'r1'));
    // A restarted process: a new connection and a new log over the same file.
    const db = openThrowawayDatabase(database.path);
    extra.push(db);
    const restarted = new ConversationLog(db);
    expect(() => start(restarted, 't', 'r1')).toThrow(DuplicateRunError);
    expect(() => start(restarted, 'other', 'r1')).not.toThrow();
    expect(restarted.runs('other').map((run) => run.runId)).toEqual(['r1']);
  });

  it('numbers the events of a run 0..n-1 and gives every event a larger commit id', () => {
    const { log } = fixture();
    start(log, 't', 'r1');
    start(log, 'u', 'r1');
    const a = log.appendEvent('t', 'r1', textEvents('m1')[0]);
    const b = log.appendEvent('u', 'r1', textEvents('m1')[0]);
    const c = log.appendEvent('t', 'r1', textEvents('m1')[1]);
    expect([a.seq, b.seq, c.seq]).toEqual([1, 1, 2]);
    expect(a.id).toBeLessThan(b.id);
    expect(b.id).toBeLessThan(c.id);
    expect(log.maxEventId('t')).toBe(c.id);
    expect(log.maxEventId('u')).toBe(b.id);
    expect(log.maxEventId('nobody')).toBe(0);
  });

  it('never uses messageId as event identity: events sharing a messageId are all kept', () => {
    const { log, db } = fixture();
    start(log, 't', 'r1');
    start(log, 't2', 'r1');
    // A text message is many events with one messageId.
    for (const event of textEvents('m1')) log.appendEvent('t', 'r1', event);
    // The same messageId reused by another run and another thread.
    log.appendEvent('t', 'r1', runFinished('t', 'r1'));
    start(log, 't', 'r2');
    for (const event of textEvents('m1')) log.appendEvent('t', 'r2', event);
    for (const event of textEvents('m1')) log.appendEvent('t2', 'r1', event);
    // Two RUN_STARTED, three text events on t/r1, its RUN_FINISHED, the
    // RUN_STARTED of t/r2, three text events there and three on t2/r1.
    expect(count(db, 'conversation_events')).toBe(2 + 3 + 1 + 1 + 3 + 3);
    const sharing = rows(
      db,
      "SELECT COUNT(*) AS n FROM conversation_events WHERE messageId='m1'",
    )[0].n;
    expect(sharing).toBe(9);
    expect(
      log.threadEvents('t').filter((e) => e.messageId === 'm1'),
    ).toHaveLength(6);
  });

  it('enforces the event identity (threadId, runId, seq) in the table itself', () => {
    const { log, db } = fixture();
    start(log, 't', 'r1');
    expect(() =>
      db.exec(
        "INSERT INTO conversation_events(threadId, runId, seq, eventType, eventJson) VALUES ('t','r1',0,'X','{}')",
      ),
    ).toThrow(/UNIQUE/i);
    // The same (runId, seq) on another thread is a different event.
    expect(() =>
      db.exec(
        "INSERT INTO conversation_events(threadId, runId, seq, eventType, eventJson) VALUES ('other','r1',0,'X','{}')",
      ),
    ).not.toThrow();
  });

  it('keeps messageId, toolCallId and parentMessageId apart', () => {
    const { log, db } = fixture();
    start(log, 't', 'r1');
    for (const event of [
      ...textEvents('a1'),
      ...callEvents('call-1', SERVER_TOOL, 2, 'a1'),
    ])
      log.appendEvent('t', 'r1', event);
    const byType = Object.fromEntries(
      rows(db, 'SELECT eventType, messageId FROM conversation_events').map(
        (row) => [`${row.eventType}`, row.messageId],
      ),
    );
    // Only the event's own messageId is recorded: not a parentMessageId, not a toolCallId.
    expect(byType.TOOL_CALL_START).toBeNull();
    expect(byType.TOOL_CALL_ARGS).toBeNull();
    expect(byType.TOOL_CALL_END).toBeNull();
    expect(byType.TOOL_CALL_RESULT).toBe('call-1-r');
    expect(byType.TEXT_MESSAGE_START).toBe('a1');
    const stored = log
      .threadEvents('t')
      .find((e) => e.eventType === 'TOOL_CALL_START')!;
    expect(stored.event).toMatchObject({
      toolCallId: 'call-1',
      parentMessageId: 'a1',
    });
  });

  it('records the terminal event and the status together', () => {
    let clock = 5;
    const { log } = fixture({ now: () => clock++ });
    start(log, 't', 'r1');
    expect(log.getRun('t', 'r1')).toMatchObject({
      status: 'running',
      finishedAt: null,
    });
    log.appendEvent('t', 'r1', runFinished('t', 'r1'));
    expect(log.getRun('t', 'r1')).toMatchObject({
      status: 'finished',
      finishedAt: 6,
    });
    start(log, 't', 'r2');
    log.appendEvent('t', 'r2', runError('x', 'INCOMPLETE_STREAM'));
    expect(log.getRun('t', 'r2')?.status).toBe('error');
  });

  it('accepts the explicit terminal statuses recovery and stop need, and no others', () => {
    const { log } = fixture();
    const ok: Array<
      [BaseEvent, 'finished' | 'stopped' | 'error' | 'interrupted']
    > = [
      [runFinished('t', 'a'), 'finished'],
      [runFinished('t', 'b'), 'stopped'],
      [runError('x'), 'error'],
      [runError('x'), 'interrupted'],
    ];
    ok.forEach(([event, status], index) => {
      const runId = `ok${index}`;
      start(log, 't', runId);
      log.appendEvents('t', runId, [event], { status });
      expect(log.getRun('t', runId)?.status).toBe(status);
    });
    start(log, 't', 'bad');
    const bad: Array<
      [
        BaseEvent[],
        'finished' | 'stopped' | 'error' | 'interrupted' | 'running',
      ]
    > = [
      [[runFinished('t', 'bad')], 'interrupted'],
      [[runFinished('t', 'bad')], 'error'],
      [[runError('x')], 'finished'],
      [[runError('x')], 'stopped'],
      [[runFinished('t', 'bad')], 'running'],
      [textEvents('m1'), 'stopped'],
      [textEvents('m1'), 'interrupted'],
    ];
    for (const [events, status] of bad)
      expect(() =>
        log.appendEvents('t', 'bad', events, { status: status as never }),
      ).toThrow(TypeError);
    // None of the rejected attempts wrote anything.
    expect(log.runEvents('t', 'bad').map((e) => e.seq)).toEqual([0]);
    expect(log.getRun('t', 'bad')?.status).toBe('running');
  });

  it('allows a terminal event only as the last event of a batch, and only one', () => {
    const { log } = fixture();
    start(log, 't', 'r1');
    expect(() =>
      log.appendEvents('t', 'r1', [
        runFinished('t', 'r1'),
        ...textEvents('m1'),
      ]),
    ).toThrow(TypeError);
    expect(() =>
      log.appendEvents('t', 'r1', [runFinished('t', 'r1'), runError('x')]),
    ).toThrow(TypeError);
    expect(() => log.appendEvents('t', 'r1', [])).toThrow(TypeError);
    expect(log.runEvents('t', 'r1')).toHaveLength(1);
  });

  it('treats an event type that is also an object property name as an ordinary event', () => {
    // Unknown event types are preserved; none of them may be mistaken for a
    // terminal event through the prototype chain.
    const { log } = fixture();
    start(log, 't', 'r1');
    for (const type of [
      'constructor',
      'toString',
      '__proto__',
      'hasOwnProperty',
    ])
      log.appendEvent('t', 'r1', { type, n: 1 } as unknown as BaseEvent);
    expect(log.getRun('t', 'r1')?.status).toBe('running');
    expect(log.runEvents('t', 'r1').map((e) => e.eventType)).toEqual([
      'RUN_STARTED',
      'constructor',
      'toString',
      '__proto__',
      'hasOwnProperty',
    ]);
    expect(log.checkInvariants()).toEqual([]);
  });

  it('refuses to append to a run that is finished or unknown', () => {
    const { log } = fixture();
    start(log, 't', 'r1');
    log.appendEvent('t', 'r1', runFinished('t', 'r1'));
    expect(() => log.appendEvent('t', 'r1', textEvents('m1')[0])).toThrow(
      RunNotRunningError,
    );
    expect(() => log.appendEvent('t', 'nope', textEvents('m1')[0])).toThrow(
      RunNotRunningError,
    );
    expect(log.runEvents('t', 'r1')).toHaveLength(2);
  });

  it('validates what it is given to store', () => {
    const { log } = fixture();
    expect(() =>
      log.startRun({
        threadId: 't',
        runId: 'r',
        agentId: 'a',
        startEvent: textEvents('m')[0],
      }),
    ).toThrow(TypeError);
    expect(() =>
      log.startRun({
        threadId: 't',
        runId: 'r',
        agentId: 'a',
        startEvent: runStarted([], [], { threadId: 'other', runId: 'r' }),
      }),
    ).toThrow(TypeError);
    expect(() =>
      log.startRun({
        threadId: 't',
        runId: 'r',
        agentId: 'a',
        startEvent: runStarted([], [], { threadId: 't', runId: 'other' }),
      }),
    ).toThrow(TypeError);
    expect(log.runs('t')).toEqual([]);
    start(log, 't', 'r1');
    expect(() =>
      log.appendEvent('t', 'r1', { notAnEvent: true } as unknown as BaseEvent),
    ).toThrow(TypeError);
    expect(log.runEvents('t', 'r1')).toHaveLength(1);
  });
});

describe('W1: an append is committed before it reports success', () => {
  it('is visible to a separate connection the moment the call returns', () => {
    const database = throwaway();
    const log = new ConversationLog(database.db);
    log.ensureSchema();
    const reader = openThrowawayDatabase(database.path);
    extra.push(reader);
    const seen = () => count(reader, 'conversation_events');
    log.startRun({
      threadId: 't',
      runId: 'r',
      agentId: 'a',
      startEvent: runStarted(),
    });
    expect(seen()).toBe(1);
    log.appendEvent('t', 'r', textEvents('m1')[0]);
    expect(seen()).toBe(2);
    log.appendEvents('t', 'r', textEvents('m1').slice(1));
    expect(seen()).toBe(4);
    log.appendEvent('t', 'r', runFinished('t', 'r'));
    expect(seen()).toBe(5);
    expect(
      reader
        .prepare("SELECT status FROM conversation_runs WHERE runId='r'")
        .get(),
    ).toEqual({ status: 'finished' });
    // And nothing is left open on the writer.
    expect(database.db.isTransaction).toBe(false);
  });

  it('commits a whole batch (finalizer or recovery) in one transaction', () => {
    const { log, db } = fixture();
    log.startRun({
      threadId: 't',
      runId: 'r',
      agentId: 'a',
      startEvent: runStarted(),
    });
    const commits: string[] = [];
    const original = db.exec.bind(db);
    vi.spyOn(db, 'exec').mockImplementation((sql: string) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) commits.push(sql.split(' ')[0]);
      return original(sql);
    });
    log.appendEvents(
      't',
      'r',
      [...textEvents('m1', false), runError('x', 'INCOMPLETE_STREAM')],
      {
        status: 'interrupted',
      },
    );
    expect(commits).toEqual(['BEGIN', 'COMMIT']);
  });
});

describe('storage failure rolls the whole step back', () => {
  const boom = (db: DatabaseSync, trigger: string) => db.exec(trigger);
  const failOn = (table: string, when: string, message = 'disk full') =>
    `CREATE TRIGGER fail_${table} BEFORE INSERT ON ${table} WHEN ${when} BEGIN SELECT RAISE(ABORT, '${message}'); END`;

  it('a failed terminal status update leaves no terminal event behind (invariant I1)', () => {
    const { log, db } = fixture();
    log.startRun({
      threadId: 't',
      runId: 'r',
      agentId: 'a',
      startEvent: runStarted(),
    });
    boom(
      db,
      "CREATE TRIGGER no_status BEFORE UPDATE ON conversation_runs BEGIN SELECT RAISE(ABORT, 'status update failed'); END",
    );
    const before = snapshot(db);
    expect(() => log.appendEvent('t', 'r', runFinished('t', 'r'))).toThrow(
      /status update failed/,
    );
    expect(snapshot(db)).toBe(before);
    expect(log.getRun('t', 'r')?.status).toBe('running');
    expect(types(log.runEvents('t', 'r').map((e) => e.event))).toEqual([
      'RUN_STARTED',
    ]);
    expect(log.checkInvariants()).toEqual([]);
    expect(db.isTransaction).toBe(false);
  });

  it('a failure part-way through a batch persists none of the batch and leaves no gap', () => {
    const { log, db } = fixture();
    log.startRun({
      threadId: 't',
      runId: 'r',
      agentId: 'a',
      startEvent: runStarted(),
    });
    boom(db, failOn('conversation_events', 'NEW.seq = 3'));
    const before = snapshot(db);
    const batch = [
      ...textEvents('m1', false),
      runError('x', 'INCOMPLETE_STREAM'),
    ];
    expect(() =>
      log.appendEvents('t', 'r', batch, { status: 'interrupted' }),
    ).toThrow(/disk full/);
    expect(snapshot(db)).toBe(before);
    expect(log.getRun('t', 'r')?.status).toBe('running');
    // The connection is usable and numbering continues without a gap.
    db.exec('DROP TRIGGER fail_conversation_events');
    log.appendEvents('t', 'r', batch, { status: 'interrupted' });
    expect(log.runEvents('t', 'r').map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(log.getRun('t', 'r')?.status).toBe('interrupted');
    expect(log.checkInvariants()).toEqual([]);
  });

  it('a failure while starting a run leaves no run row without its event', () => {
    const { log, db } = fixture();
    boom(db, failOn('conversation_events', '1'));
    expect(() =>
      log.startRun({
        threadId: 't',
        runId: 'r',
        agentId: 'a',
        startEvent: runStarted(),
      }),
    ).toThrow(/disk full/);
    expect(count(db, 'conversation_runs')).toBe(0);
    expect(count(db, 'conversation_events')).toBe(0);
    db.exec('DROP TRIGGER fail_conversation_events');
    const { run } = log.startRun({
      threadId: 't',
      runId: 'r',
      agentId: 'a',
      startEvent: runStarted(),
    });
    expect(run.seq).toBe(1);
    expect(log.checkInvariants()).toEqual([]);
  });

  it('rethrows the original error rather than a rollback error', () => {
    const { log, db } = fixture();
    log.startRun({
      threadId: 't',
      runId: 'r',
      agentId: 'a',
      startEvent: runStarted(),
    });
    boom(db, failOn('conversation_events', '1', 'original failure'));
    expect(() => log.appendEvent('t', 'r', textEvents('m1')[0])).toThrow(
      'original failure',
    );
  });
});

describe('serialisation: the complete event is the authority', () => {
  const roundTrip = (event: BaseEvent) => {
    const { log } = fixture();
    log.startRun({
      threadId: 't',
      runId: 'r',
      agentId: 'a',
      startEvent: runStarted(),
    });
    const stored = log.appendEvent('t', 'r', event);
    const read = log.runEvents('t', 'r').at(-1)!;
    expect(read.event).toEqual(event);
    expect(JSON.stringify(read.event)).toBe(JSON.stringify(event));
    expect(read.id).toBe(stored.id);
    return read;
  };

  it('round-trips text events', () => {
    for (const event of textEvents('m1', true, 'héllo — “quoted”   \n\t 🙂'))
      roundTrip(event);
    roundTrip({
      type: 'TEXT_MESSAGE_CHUNK',
      messageId: 'm2',
      delta: 'x',
      role: 'assistant',
    } as unknown as BaseEvent);
  });

  it('round-trips tool events with their arguments and results', () => {
    for (const event of callEvents('c1', SERVER_TOOL, 2)) roundTrip(event);
    roundTrip({
      type: 'TOOL_CALL_RESULT',
      toolCallId: 'c2',
      messageId: 'c2-r',
      role: 'tool',
      content: JSON.stringify({ nested: { list: [1, 2, { three: null }] } }),
    } as unknown as BaseEvent);
  });

  it('round-trips errors and terminal events', () => {
    roundTrip(runError('boom', 'INCOMPLETE_STREAM'));
  });

  it('round-trips a terminal event', () => {
    roundTrip({
      type: 'RUN_FINISHED',
      threadId: 't',
      runId: 'r',
      result: { a: [1, 2] },
    } as unknown as BaseEvent);
  });

  it('preserves unknown and additional fields, and unknown event types', () => {
    const withExtras = {
      type: 'TEXT_MESSAGE_CONTENT',
      messageId: 'm1',
      delta: 'x',
      timestamp: 1700000000000,
      rawEvent: { provider: { id: 'abc', usage: { tokens: 3 } } },
      metadata: { tag: ['a', 'b'] },
      futureField: { deep: [true, false, null, 1.5, 'z'] },
    } as unknown as BaseEvent;
    expect(
      (roundTrip(withExtras).event as unknown as Record<string, unknown>)
        .futureField,
    ).toEqual({
      deep: [true, false, null, 1.5, 'z'],
    });
    const unknownType = {
      type: 'SOME_FUTURE_EVENT',
      messageId: 'f1',
      payload: { n: 1 },
    } as unknown as BaseEvent;
    const read = roundTrip(unknownType);
    expect(read.eventType).toBe('SOME_FUTURE_EVENT');
    expect(read.messageId).toBe('f1');
  });

  it('round-trips a large payload without truncation', () => {
    const delta = 'x'.repeat(2_000_000);
    const read = roundTrip({
      type: 'TEXT_MESSAGE_CONTENT',
      messageId: 'big',
      delta,
    } as unknown as BaseEvent);
    expect((read.event as unknown as { delta: string }).delta).toHaveLength(
      2_000_000,
    );
  });

  it('stores the whole RUN_STARTED input, including the client tool declarations', () => {
    const { log } = fixture();
    log.startRun({
      threadId: 't',
      runId: 'r',
      agentId: 'a',
      startEvent: runStarted([CLIENT_TOOL], [user('u1', 'hello')]),
    });
    expect(log.runEvents('t', 'r')[0].event).toEqual(
      runStarted([CLIENT_TOOL], [user('u1', 'hello')]),
    );
  });

  it('reads the event from eventJson, never from the helper columns', () => {
    const { log, db } = fixture();
    log.startRun({
      threadId: 't',
      runId: 'r',
      agentId: 'a',
      startEvent: runStarted(),
    });
    const event = textEvents('m1')[0];
    log.appendEvent('t', 'r', event);
    db.exec(
      "UPDATE conversation_events SET eventType='TAMPERED', messageId='other' WHERE seq=1",
    );
    const read = log.runEvents('t', 'r')[1];
    expect(read.event).toEqual(event);
    expect(read.eventType).toBe('TAMPERED');
    // The event returned is the stored JSON, whatever the helpers now say.
    expect((read.event as unknown as { messageId: string }).messageId).toBe(
      'm1',
    );
  });

  it('records helper columns as derived copies of the event', () => {
    const { log, db } = fixture();
    log.startRun({
      threadId: 't',
      runId: 'r',
      agentId: 'a',
      startEvent: runStarted(),
    });
    log.appendEvent('t', 'r', textEvents('m1')[1]);
    expect(
      rows(
        db,
        'SELECT eventType, messageId, eventJson FROM conversation_events WHERE seq=1',
      ),
    ).toEqual([
      {
        eventType: 'TEXT_MESSAGE_CONTENT',
        messageId: 'm1',
        eventJson: JSON.stringify(textEvents('m1')[1]),
      },
    ]);
  });
});

describe('replay order, reads and the interlock input', () => {
  const start = (log: ConversationLog, threadId: string, runId: string) =>
    log.startRun({
      threadId,
      runId,
      agentId: 'a',
      startEvent: runStarted([], [], { threadId, runId }),
    });

  it('replays by (run seq, event seq), not by commit id', () => {
    const { log } = fixture();
    start(log, 't', 'r1');
    log.appendEvent('t', 'r1', textEvents('m1')[0]);
    // r1 is a dead run; a newer run is started and finished.
    start(log, 't', 'r2');
    log.appendEvent('t', 'r2', runFinished('t', 'r2'));
    // A late recovery append to the older run gets the largest id of all.
    const late = log.appendEvents(
      't',
      'r1',
      [runError('x', 'INCOMPLETE_STREAM')],
      { status: 'interrupted' },
    );
    expect(late[0].id).toBe(log.maxEventId('t'));
    expect(
      log.threadEvents('t').map((e) => `${e.runId}:${e.seq}:${e.eventType}`),
    ).toEqual([
      'r1:0:RUN_STARTED',
      'r1:1:TEXT_MESSAGE_START',
      'r1:2:RUN_ERROR',
      'r2:0:RUN_STARTED',
      'r2:1:RUN_FINISHED',
    ]);
  });

  it('lists threads, runs and running runs', () => {
    const { log } = fixture();
    start(log, 'b', 'r1');
    start(log, 'a', 'r1');
    log.appendEvent('a', 'r1', runFinished('a', 'r1'));
    start(log, 'a', 'r2');
    expect(log.threadIds()).toEqual(['a', 'b']);
    expect(
      log.runningRuns().map((run) => `${run.threadId}/${run.runId}`),
    ).toEqual(['a/r2', 'b/r1']);
    expect(log.getRun('a', 'r1')?.status).toBe('finished');
    expect(log.getRun('a', 'missing')).toBeUndefined();
    expect(log.runs('nobody')).toEqual([]);
    expect(log.threadEvents('nobody')).toEqual([]);
  });

  it('reports the tool call ids that have a durable result, by thread', () => {
    const { log } = fixture();
    start(log, 't', 'r1');
    for (const event of [
      ...callEvents('c1', SERVER_TOOL, 2),
      ...callEvents('c2', SERVER_TOOL, 1),
    ])
      log.appendEvent('t', 'r1', event);
    log.appendEvent('t', 'r1', runFinished('t', 'r1'));
    start(log, 't', 'r2');
    for (const event of callEvents('c3', SERVER_TOOL, 2))
      log.appendEvent('t', 'r2', event);
    start(log, 'u', 'r1');
    for (const event of callEvents('c9', SERVER_TOOL, 2))
      log.appendEvent('u', 'r1', event);
    expect(log.heldToolCallIds('t')).toEqual(new Set(['c1', 'c3']));
    expect(log.heldToolCallIds('u')).toEqual(new Set(['c9']));
    expect(log.heldToolCallIds('nobody')).toEqual(new Set());
  });
});

describe('invariants I1 to I3 (section 5.6)', () => {
  const start = (log: ConversationLog, threadId: string, runId: string) =>
    log.startRun({
      threadId,
      runId,
      agentId: 'a',
      startEvent: runStarted([], [], { threadId, runId }),
    });
  const healthy = () => {
    const f = fixture();
    start(f.log, 't', 'r1');
    for (const event of textEvents('m1')) f.log.appendEvent('t', 'r1', event);
    f.log.appendEvent('t', 'r1', runFinished('t', 'r1'));
    start(f.log, 't', 'r2');
    return f;
  };

  it('holds on a healthy log', () => {
    expect(healthy().log.checkInvariants()).toEqual([]);
    expect(fixture().log.checkInvariants()).toEqual([]);
  });

  it('I1: running without a terminal event, and a terminal event without finishing', () => {
    const a = healthy();
    a.db.exec(
      "UPDATE conversation_runs SET status='finished', finishedAt=1 WHERE runId='r2'",
    );
    expect(a.log.checkInvariants()).toEqual([
      expect.objectContaining({ invariant: 'I1', threadId: 't', runId: 'r2' }),
    ]);
    const b = healthy();
    b.db.exec(
      "UPDATE conversation_runs SET status='running', finishedAt=NULL WHERE runId='r1'",
    );
    expect(b.log.checkInvariants()).toEqual([
      expect.objectContaining({ invariant: 'I1', threadId: 't', runId: 'r1' }),
    ]);
  });

  it('I2: a gap in the event seq values, a gap in the run seq values, an orphan event', () => {
    const gap = healthy();
    gap.db.exec("DELETE FROM conversation_events WHERE runId='r1' AND seq=2");
    expect(gap.log.checkInvariants().map((v) => v.invariant)).toEqual(['I2']);
    const runGap = healthy();
    runGap.db.exec("UPDATE conversation_runs SET seq=3 WHERE runId='r2'");
    expect(runGap.log.checkInvariants().map((v) => v.invariant)).toEqual([
      'I2',
    ]);
    const orphan = healthy();
    orphan.db.exec(
      "INSERT INTO conversation_events(threadId, runId, seq, eventType, eventJson) VALUES ('t','ghost',0,'RUN_STARTED','{}')",
    );
    expect(orphan.log.checkInvariants().map((v) => v.invariant)).toEqual([
      'I2',
    ]);
    const empty = healthy();
    empty.db.exec("DELETE FROM conversation_events WHERE runId='r2'");
    expect(empty.log.checkInvariants().map((v) => v.invariant)).toEqual(['I2']);
  });

  it('I3: the view stamp is never ahead of the log', async () => {
    const { log, db } = healthy();
    await log.rebuildMessages('t');
    expect(log.checkInvariants()).toEqual([]);
    db.exec(
      `UPDATE conversation_messages SET lastEventId = ${log.maxEventId('t') + 5}`,
    );
    expect(log.checkInvariants()).toEqual([
      expect.objectContaining({ invariant: 'I3', threadId: 't' }),
    ]);
  });

  it('does not write while checking', () => {
    const { log, db } = healthy();
    db.exec("UPDATE conversation_runs SET status='finished' WHERE runId='r2'");
    const before = snapshot(db);
    log.checkInvariants();
    expect(snapshot(db)).toBe(before);
  });
});

// Section 6 and 16: events are the truth; the messages table is a rebuildable
// view that is trusted only by the minimal C4 freshness rule (5.7).
describe('the derived message view: full rebuild from the events', () => {
  const start = (
    log: ConversationLog,
    threadId: string,
    runId: string,
    messages = [user('u1', 'hello')],
  ) =>
    log.startRun({
      threadId,
      runId,
      agentId: 'a',
      startEvent: runStarted([], messages, { threadId, runId }),
    });
  const conversation = (threadId = 't') => {
    const f = fixture();
    start(f.log, threadId, 'r1');
    for (const event of textEvents('a1', true, 'Hi there'))
      f.log.appendEvent(threadId, 'r1', event);
    f.log.appendEvent(threadId, 'r1', runFinished(threadId, 'r1'));
    start(f.log, threadId, 'r2', [user('u2', 'again')]);
    for (const event of [...callEvents('c1', SERVER_TOOL, 2, 'a2')])
      f.log.appendEvent(threadId, 'r2', event);
    f.log.appendEvent(threadId, 'r2', runFinished(threadId, 'r2'));
    return f;
  };

  it('derives the messages from the events alone, in replay order', async () => {
    const { log } = conversation();
    const { messages } = await log.deriveMessages('t');
    expect(messages.map((m) => `${m.role}:${m.id}`)).toEqual([
      'user:u1',
      'assistant:a1',
      'user:u2',
      'assistant:a2',
      'tool:c1-r',
    ]);
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: 'Hi there',
    });
    expect(messages[3]).toMatchObject({ toolCalls: [{ id: 'c1' }] });
  });

  it('equals folding the events with the public reducer', async () => {
    const { log } = conversation();
    const folded = await foldEvents(log.threadEvents('t').map((e) => e.event));
    expect((await log.deriveMessages('t')).messages).toEqual(folded);
    expect(await foldEvents([])).toEqual([]);
  });

  it('is reproducible after the view table is emptied or dropped', async () => {
    const { log, db } = conversation();
    const first = (await log.deriveMessages('t')).messages;
    await log.rebuildMessages('t');
    db.exec('DELETE FROM conversation_messages');
    expect((await log.deriveMessages('t')).messages).toEqual(first);
    db.exec('DROP TABLE conversation_messages');
    expect((await log.deriveMessages('t')).messages).toEqual(first);
  });

  it('is independent per thread', async () => {
    const { log } = conversation();
    start(log, 'u', 'r1', [user('x1', 'other thread')]);
    expect((await log.deriveMessages('u')).messages.map((m) => m.id)).toEqual([
      'x1',
    ]);
    expect((await log.deriveMessages('nobody')).messages).toEqual([]);
  });

  it('writes the view with the watermark it was derived at', async () => {
    const { log, db } = conversation();
    expect(rows(db, 'SELECT * FROM conversation_messages')).toEqual([]);
    const messages = await log.rebuildMessages('t');
    const [row] = rows(db, 'SELECT * FROM conversation_messages');
    expect(row.threadId).toBe('t');
    expect(row.lastEventId).toBe(log.maxEventId('t'));
    expect(JSON.parse(String(row.messagesJson))).toEqual(messages);
    // Rebuilding again replaces the one row.
    await log.rebuildMessages('t');
    expect(count(db, 'conversation_messages')).toBe(1);
  });
});

describe('cache freshness (the minimal C4 rule, section 5.7) and events-win', () => {
  const start = (log: ConversationLog, runId: string) =>
    log.startRun({
      threadId: 't',
      runId,
      agentId: 'a',
      startEvent: runStarted([], [user(`u-${runId}`, 'q')], {
        threadId: 't',
        runId,
      }),
    });
  const built = async () => {
    const f = fixture();
    start(f.log, 'r1');
    for (const event of textEvents('a1')) f.log.appendEvent('t', 'r1', event);
    f.log.appendEvent('t', 'r1', runFinished('t', 'r1'));
    await f.log.rebuildMessages('t');
    return f;
  };
  const read = (log: ConversationLog, runActive = false) =>
    log.readMessages('t', { runActive });

  it('serves a fresh row from the cache, equal to the full derivation', async () => {
    const { log } = await built();
    const result = await read(log);
    expect(result.source).toBe('cache');
    expect(result.messages).toEqual((await log.deriveMessages('t')).messages);
  });

  it('falls back to the events when the row is missing', async () => {
    const { log, db } = await built();
    db.exec('DELETE FROM conversation_messages');
    const result = await read(log);
    expect(result.source).toBe('events');
    expect(result.messages).toEqual((await log.deriveMessages('t')).messages);
  });

  it('falls back to the events when the row is stale, and shows the newer events', async () => {
    const { log } = await built();
    start(log, 'r2');
    log.appendEvent('t', 'r2', runFinished('t', 'r2'));
    const result = await read(log);
    expect(result.source).toBe('events');
    expect(result.messages.map((m) => m.id)).toEqual(['u-r1', 'a1', 'u-r2']);
  });

  it('is stale after a late recovery append to an older run', async () => {
    const f = fixture();
    start(f.log, 'r1');
    start(f.log, 'r2');
    f.log.appendEvent('t', 'r2', runFinished('t', 'r2'));
    await f.log.rebuildMessages('t');
    expect((await read(f.log)).source).toBe('cache');
    f.log.appendEvents('t', 'r1', [runError('x', 'INCOMPLETE_STREAM')], {
      status: 'interrupted',
    });
    expect((await read(f.log)).source).toBe('events');
  });

  it('treats an unparseable payload as stale, not as authority', async () => {
    const { log, db } = await built();
    for (const payload of ['not json', '{"a":1}', '"text"', 'null', '42', '']) {
      db.prepare('UPDATE conversation_messages SET messagesJson = ?').run(
        payload,
      );
      const result = await read(log);
      expect(result.source, payload).toBe('events');
      expect(result.messages.map((m) => m.id)).toEqual(['u-r1', 'a1']);
    }
  });

  it('treats a row ahead of the log as stale', async () => {
    const { log, db } = await built();
    db.exec(
      `UPDATE conversation_messages SET lastEventId = ${log.maxEventId('t') + 1}`,
    );
    expect((await read(log)).source).toBe('events');
  });

  it('does not trust the cache while a run is active', async () => {
    const { log } = await built();
    expect((await read(log, true)).source).toBe('events');
    expect((await read(log, false)).source).toBe('cache');
  });

  it('lets the events win when a stale row disagrees with them', async () => {
    const { log, db } = await built();
    start(log, 'r2');
    db.prepare('UPDATE conversation_messages SET messagesJson = ?').run(
      JSON.stringify([{ id: 'forged', role: 'user', content: 'forged' }]),
    );
    const result = await read(log);
    expect(result.source).toBe('events');
    expect(result.messages.map((m) => m.id)).not.toContain('forged');
  });

  it('known limit: a parseable but wrong payload with a correct stamp is served by the cheap read', async () => {
    // The C4 rule has no content hash (messagesSha256 is deferred to C8), so a
    // payload that parses and carries the right watermark cannot be told apart
    // by a reader that does not re-derive. Every write recomputes the payload
    // from the full log, and the authoritative paths below ignore the row.
    const { log, db } = await built();
    db.prepare('UPDATE conversation_messages SET messagesJson = ?').run(
      JSON.stringify([{ id: 'wrong', role: 'user', content: 'wrong' }]),
    );
    expect((await read(log)).messages.map((m) => m.id)).toEqual(['wrong']);
    // The events still win wherever the view is derived or rebuilt.
    expect((await log.deriveMessages('t')).messages.map((m) => m.id)).toEqual([
      'u-r1',
      'a1',
    ]);
    await log.rebuildMessages('t');
    expect((await read(log)).messages.map((m) => m.id)).toEqual(['u-r1', 'a1']);
  });

  it('a reader writes nothing', async () => {
    const { log, db } = await built();
    db.exec('DELETE FROM conversation_messages');
    const before = snapshot(db);
    await read(log);
    await read(log, true);
    expect(snapshot(db)).toBe(before);
  });

  it('a stamp taken before a concurrent append leaves the row stale', async () => {
    const { log } = await built();
    start(log, 'r2');
    log.appendEvent('t', 'r2', runFinished('t', 'r2'));
    const rebuild = log.rebuildMessages('t');
    // The derivation is asynchronous; this append lands while it is running.
    start(log, 'r3');
    await rebuild;
    expect((await read(log)).source).toBe('events');
    expect((await read(log)).messages.map((m) => m.id)).toContain('u-r3');
  });

  it('a view failure does not redefine the authoritative run or event state', async () => {
    const { log, db } = await built();
    start(log, 'r2');
    log.appendEvent('t', 'r2', runFinished('t', 'r2'));
    db.exec(
      "CREATE TRIGGER no_view BEFORE INSERT ON conversation_messages BEGIN SELECT RAISE(ABORT, 'view write failed'); END",
    );
    db.exec(
      "CREATE TRIGGER no_view_update BEFORE UPDATE ON conversation_messages BEGIN SELECT RAISE(ABORT, 'view write failed'); END",
    );
    const authoritative = () =>
      JSON.stringify([
        rows(db, 'SELECT * FROM conversation_runs'),
        rows(db, 'SELECT * FROM conversation_events'),
      ]);
    const before = authoritative();
    await expect(log.rebuildMessages('t')).rejects.toThrow(/view write failed/);
    expect(authoritative()).toBe(before);
    expect(log.getRun('t', 'r2')?.status).toBe('finished');
    expect(log.checkInvariants()).toEqual([]);
    // Readers still get the truth from the events.
    const result = await read(log);
    expect(result.source).toBe('events');
    expect(result.messages.map((m) => m.id)).toEqual(['u-r1', 'a1', 'u-r2']);
  });
});

describe('module shape', () => {
  const path = 'src/server/conversation-log.ts';
  const source = readFileSync(
    fileURLToPath(new URL(`../${path}`, import.meta.url)),
    'utf8',
  );

  it('imports no other application module and nothing that touches the file system or network', () => {
    const { staticImports, dynamicImports } = emittedImports(path, source);
    expect([...staticImports].sort()).toEqual(['@ag-ui/client', 'rxjs']);
    expect(dynamicImports).toEqual([]);
  });

  it('opens no database of its own and sets no pragma', () => {
    expect(source).not.toMatch(/new DatabaseSync/);
    expect(source).not.toMatch(/PRAGMA/i);
    expect(source).not.toMatch(/process\.(on|once|env)/);
    expect(source).not.toMatch(/\bfetch\(/);
  });

  it('never spreads the events into a call: of(...events) throws RangeError from 150,000 events', () => {
    // A long thread holds more events than a call can take as arguments, and the
    // SDK reducer is too slow at that size for a behavioural test (its cost per
    // event grows with the thread), so the call shape is checked in the source.
    const code = source.replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bof\(\s*\.\.\./);
    expect(code).toMatch(/defaultApplyEvents\(input, from\(events\)/);
  });

  it('keeps ensureSchema out of the constructor', () => {
    const constructor =
      source.match(/constructor\([\s\S]*?\n {2}\}/)?.[0] ?? '';
    expect(constructor).not.toContain('ensureSchema');
    expect(constructor).not.toMatch(/\.exec\(|\.prepare\(/);
  });
});
