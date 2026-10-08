import type { DatabaseSync } from 'node:sqlite';
import { AbstractAgent, defaultApplyEvents } from '@ag-ui/client';
import type { BaseEvent, Message, RunAgentInput } from '@ag-ui/core';
import { Observable, from, lastValueFrom, of, toArray } from 'rxjs';

// The durable log of local conversations: three tables over an injected
// DatabaseSync. conversation_events is the authoritative, append-only history.
// conversation_runs holds each run's lifecycle and metadata. conversation_messages
// is a derived view that is rebuilt from the events and trusted only while it is
// provably fresh. Dormant: nothing in the application imports this module and
// nothing calls ensureSchema(). Constructing a log touches nothing; the schema
// exists only after an explicit ensureSchema().
// Authority: docs/LOCAL_FIRST_C4_LANDING_BOUNDARY.md sections 5, 6, 9, 10 and 16.
// The schema and the public surface below are frozen for C4 (DEC-20).

// DEC-18: snake_case table names, camelCase column names. No foreign key (the
// connection enforces them, and a key would tie the log to tables other modules
// own), no CHECK (SQLite cannot alter one and there is no migration framework),
// no version table. lastEventId is the minimal C4 freshness watermark, not the
// deferred R32 checkpoint (throughRunSeq, throughEventSeq, eventCount,
// messagesSha256 belong to C8).
export const CONVERSATION_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS conversation_runs(
  threadId TEXT NOT NULL, runId TEXT NOT NULL, seq INTEGER NOT NULL,
  agentId TEXT NOT NULL, parentRunId TEXT, status TEXT NOT NULL,
  startedAt INTEGER NOT NULL, finishedAt INTEGER,
  PRIMARY KEY(threadId, runId), UNIQUE(threadId, seq));
CREATE TABLE IF NOT EXISTS conversation_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, threadId TEXT NOT NULL, runId TEXT NOT NULL,
  seq INTEGER NOT NULL, eventType TEXT NOT NULL, messageId TEXT, eventJson TEXT NOT NULL,
  UNIQUE(threadId, runId, seq));
CREATE INDEX IF NOT EXISTS conversation_events_thread ON conversation_events(threadId, id);
CREATE TABLE IF NOT EXISTS conversation_messages(
  threadId TEXT PRIMARY KEY, messagesJson TEXT NOT NULL, lastEventId INTEGER NOT NULL);`;

export const RUN_STATUSES = [
  'running',
  'finished',
  'error',
  'stopped',
  'interrupted',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export type TerminalStatus = Exclude<RunStatus, 'running'>;

export interface RunRow {
  threadId: string;
  runId: string;
  seq: number;
  agentId: string;
  parentRunId: string | null;
  status: RunStatus;
  startedAt: number;
  finishedAt: number | null;
}

export interface StoredEvent {
  // Commit order across the whole log, and the view's freshness watermark.
  id: number;
  threadId: string;
  runId: string;
  // 0-based position within the run; 0 is RUN_STARTED.
  seq: number;
  // Informational copies of fields of `event`. Not identity.
  eventType: string;
  messageId: string | null;
  // The complete event as it was stored: the content authority.
  event: BaseEvent;
}

export interface InvariantViolation {
  invariant: 'I1' | 'I2' | 'I3' | 'status';
  threadId: string;
  runId?: string;
  detail: string;
}

export type MessageSource = 'cache' | 'events';

// A (threadId, runId) pair that already exists, whatever its status. Rejected
// before anything is written.
export class DuplicateRunError extends Error {
  readonly code = 'DUPLICATE_RUN_ID' as const;
  constructor(
    readonly threadId: string,
    readonly runId: string,
  ) {
    super(`Run ${runId} already exists on thread ${threadId}`);
    this.name = 'DuplicateRunError';
  }
}

// An append to a run that is finished or does not exist.
export class RunNotRunningError extends Error {
  readonly code = 'RUN_NOT_RUNNING' as const;
  constructor(
    readonly threadId: string,
    readonly runId: string,
  ) {
    super(`Run ${runId} on thread ${threadId} is not running`);
    this.name = 'RunNotRunningError';
  }
}

// RUN_FINISHED ends a run as finished or stopped; RUN_ERROR as error or
// interrupted. The first of each pair is the default.
const TERMINAL_STATUSES: Record<string, readonly TerminalStatus[]> = {
  RUN_FINISHED: ['finished', 'stopped'],
  RUN_ERROR: ['error', 'interrupted'],
};

interface PreparedEvent {
  eventType: string;
  messageId: string | null;
  eventJson: string;
}

function prepareEvent(event: BaseEvent): PreparedEvent {
  const value = event as unknown as { type?: unknown; messageId?: unknown };
  if (!event || typeof value.type !== 'string')
    throw new TypeError('A conversation event needs a string type');
  const eventJson = JSON.stringify(event);
  return {
    eventType: value.type,
    messageId: typeof value.messageId === 'string' ? value.messageId : null,
    eventJson,
  };
}

function requireText(name: string, value: unknown): string {
  if (typeof value !== 'string' || value === '')
    throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

class StateAgent extends AbstractAgent {
  run(): Observable<BaseEvent> {
    return of();
  }
}

// Folds events into the AG-UI message list from an empty state with the public
// reducer. `from` rather than `of(...events)`: a long conversation has more
// events than a call can take as arguments.
export async function foldEvents(
  events: readonly BaseEvent[],
): Promise<Message[]> {
  if (!events.length) return [];
  const input: RunAgentInput = {
    threadId: 'derive',
    runId: 'derive',
    state: {},
    messages: [],
    tools: [],
    context: [],
    forwardedProps: {},
  };
  const mutations = await lastValueFrom(
    defaultApplyEvents(input, from(events), new StateAgent(), []).pipe(
      toArray(),
    ),
  );
  let messages: Message[] = [];
  for (const mutation of mutations)
    if (mutation && 'messages' in mutation && mutation.messages)
      messages = mutation.messages as Message[];
  return messages;
}

type Row = Record<string, unknown>;

export class ConversationLog {
  private readonly now: () => number;
  constructor(
    private readonly db: DatabaseSync,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  // ---------------------------------------------------------------- schema

  hasSchema(): boolean {
    const found = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('conversation_runs','conversation_events','conversation_messages')",
      )
      .get() as { n: number };
    return found.n === 3;
  }

  // Idempotent. Called by tests on throwaway databases; no production caller.
  ensureSchema(): void {
    this.transaction(() => this.db.exec(CONVERSATION_SCHEMA_SQL));
  }

  // ---------------------------------------------------------------- writes
  // Every write is one BEGIN IMMEDIATE ... COMMIT and returns only after the
  // COMMIT, so a caller that publishes after a write publishes committed data
  // (policy W1). A failure rolls the whole step back and rethrows.

  // Rejects a duplicate (threadId, runId) before writing anything. The run row
  // and event 0 (RUN_STARTED) are written together.
  startRun(request: {
    threadId: string;
    runId: string;
    agentId: string;
    startEvent: BaseEvent;
  }): { run: RunRow; event: StoredEvent } {
    const { threadId, runId, agentId, startEvent } = request;
    requireText('threadId', threadId);
    requireText('runId', runId);
    requireText('agentId', agentId);
    const start = startEvent as unknown as {
      type?: unknown;
      threadId?: unknown;
      runId?: unknown;
    };
    if (
      !startEvent ||
      start.type !== 'RUN_STARTED' ||
      start.threadId !== threadId ||
      start.runId !== runId
    )
      throw new TypeError(
        'startEvent must be the RUN_STARTED event of this thread and run',
      );
    const prepared = prepareEvent(startEvent);
    return this.transaction(() => {
      const existing = this.db
        .prepare(
          'SELECT 1 AS found FROM conversation_runs WHERE threadId = ? AND runId = ?',
        )
        .get(threadId, runId);
      if (existing) throw new DuplicateRunError(threadId, runId);
      const last = this.db
        .prepare(
          'SELECT seq, runId FROM conversation_runs WHERE threadId = ? ORDER BY seq DESC LIMIT 1',
        )
        .get(threadId) as { seq: number; runId: string } | undefined;
      const startedAt = this.now();
      this.db
        .prepare(
          `INSERT INTO conversation_runs(threadId, runId, seq, agentId, parentRunId, status, startedAt, finishedAt)
           VALUES (?, ?, ?, ?, ?, 'running', ?, NULL)`,
        )
        .run(
          threadId,
          runId,
          (last?.seq ?? 0) + 1,
          agentId,
          last?.runId ?? null,
          startedAt,
        );
      const event = this.insertEvent(threadId, runId, 0, prepared);
      return { run: this.getRun(threadId, runId)!, event };
    });
  }

  appendEvent(
    threadId: string,
    runId: string,
    event: BaseEvent,
    options: { status?: TerminalStatus } = {},
  ): StoredEvent {
    return this.appendEvents(threadId, runId, [event], options)[0];
  }

  // Appends to a run that is still running, in one transaction. A terminal
  // event (RUN_FINISHED or RUN_ERROR) may only be the last event of the batch;
  // it sets the run's status and finishedAt in the same transaction, so a run
  // never has a terminal event without a final status or the reverse (I1).
  // `status` picks among the statuses that terminal event allows.
  appendEvents(
    threadId: string,
    runId: string,
    events: readonly BaseEvent[],
    options: { status?: TerminalStatus } = {},
  ): StoredEvent[] {
    if (!events.length) throw new TypeError('Append at least one event');
    const prepared = events.map(prepareEvent);
    const terminal = prepared.map((p) =>
      Object.hasOwn(TERMINAL_STATUSES, p.eventType),
    );
    if (terminal.slice(0, -1).some(Boolean))
      throw new TypeError('A terminal event must be the last event appended');
    let status: TerminalStatus | undefined;
    if (terminal.at(-1)) {
      const allowed = TERMINAL_STATUSES[prepared.at(-1)!.eventType];
      status = options.status ?? allowed[0];
      if (!allowed.includes(status))
        throw new TypeError(
          `${prepared.at(-1)!.eventType} cannot end a run as ${status}`,
        );
    } else if (options.status !== undefined)
      throw new TypeError('A status needs a terminal event');
    return this.transaction(() => {
      const run = this.getRun(threadId, runId);
      if (run?.status !== 'running')
        throw new RunNotRunningError(threadId, runId);
      const last = this.db
        .prepare(
          'SELECT MAX(seq) AS seq FROM conversation_events WHERE threadId = ? AND runId = ?',
        )
        .get(threadId, runId) as { seq: number | null };
      let seq = (last.seq ?? -1) + 1;
      const stored = prepared.map((p) =>
        this.insertEvent(threadId, runId, seq++, p),
      );
      if (status !== undefined)
        this.db
          .prepare(
            'UPDATE conversation_runs SET status = ?, finishedAt = ? WHERE threadId = ? AND runId = ?',
          )
          .run(status, this.now(), threadId, runId);
      return stored;
    });
  }

  private insertEvent(
    threadId: string,
    runId: string,
    seq: number,
    event: PreparedEvent,
  ): StoredEvent {
    const result = this.db
      .prepare(
        'INSERT INTO conversation_events(threadId, runId, seq, eventType, messageId, eventJson) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        threadId,
        runId,
        seq,
        event.eventType,
        event.messageId,
        event.eventJson,
      );
    return {
      id: Number(result.lastInsertRowid),
      threadId,
      runId,
      seq,
      eventType: event.eventType,
      messageId: event.messageId,
      event: JSON.parse(event.eventJson) as BaseEvent,
    };
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      // SQLite may already have rolled back (for example after a full disk).
      if (this.db.isTransaction)
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // keep the original error
        }
      throw error;
    }
  }

  // ----------------------------------------------------------------- reads

  getRun(threadId: string, runId: string): RunRow | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM conversation_runs WHERE threadId = ? AND runId = ?',
      )
      .get(threadId, runId);
    return row ? toRun(row) : undefined;
  }

  // The runs of a thread in order.
  runs(threadId: string): RunRow[] {
    return this.db
      .prepare(
        'SELECT * FROM conversation_runs WHERE threadId = ? ORDER BY seq',
      )
      .all(threadId)
      .map(toRun);
  }

  // Runs with no terminal event, across every thread (the recovery scan).
  runningRuns(): RunRow[] {
    return this.db
      .prepare(
        "SELECT * FROM conversation_runs WHERE status = 'running' ORDER BY threadId, seq",
      )
      .all()
      .map(toRun);
  }

  threadIds(): string[] {
    return this.db
      .prepare(
        'SELECT DISTINCT threadId FROM conversation_runs ORDER BY threadId',
      )
      .all()
      .map((row) => String(row.threadId));
  }

  // Every event of a thread in replay order: run seq, then event seq. Not commit
  // order: a late recovery append to an older run has the newest id.
  threadEvents(threadId: string): StoredEvent[] {
    return this.db
      .prepare(
        `SELECT e.* FROM conversation_events e
         JOIN conversation_runs r ON r.threadId = e.threadId AND r.runId = e.runId
         WHERE e.threadId = ? ORDER BY r.seq, e.seq`,
      )
      .all(threadId)
      .map(toEvent);
  }

  runEvents(threadId: string, runId: string): StoredEvent[] {
    return this.db
      .prepare(
        'SELECT * FROM conversation_events WHERE threadId = ? AND runId = ? ORDER BY seq',
      )
      .all(threadId, runId)
      .map(toEvent);
  }

  // The newest event id of a thread, 0 if it has none. The view's watermark.
  maxEventId(threadId: string): number {
    const row = this.db
      .prepare(
        'SELECT MAX(id) AS id FROM conversation_events WHERE threadId = ?',
      )
      .get(threadId) as { id: number | null };
    return row.id ?? 0;
  }

  // Tool call ids that have a durable TOOL_CALL_RESULT in the thread: the input
  // of the stale-tool-history rule. The ids come from the stored events.
  heldToolCallIds(threadId: string): Set<string> {
    const held = new Set<string>();
    for (const row of this.db
      .prepare(
        "SELECT eventJson FROM conversation_events WHERE threadId = ? AND eventType = 'TOOL_CALL_RESULT'",
      )
      .all(threadId)) {
      const id = (JSON.parse(String(row.eventJson)) as { toolCallId?: unknown })
        .toolCallId;
      if (typeof id === 'string') held.add(id);
    }
    return held;
  }

  // ------------------------------------------------------------ invariants

  // I1: running iff no terminal event. I2: event seq 0..n-1 per run, run seq
  // 1..m per thread, no event without a run, no run without events. I3: a view
  // is never ahead of its log. Also: the status is one of the five. I4 (one
  // active run per thread) is process state and belongs to the runner.
  checkInvariants(): InvariantViolation[] {
    const found: InvariantViolation[] = [];
    for (const row of this.db
      .prepare(
        `SELECT r.threadId, r.runId, r.status,
           (SELECT COUNT(*) FROM conversation_events e
             WHERE e.threadId = r.threadId AND e.runId = r.runId
               AND e.eventType IN ('RUN_FINISHED','RUN_ERROR')) AS terminals
         FROM conversation_runs r ORDER BY r.threadId, r.seq`,
      )
      .all()) {
      const { threadId, runId, status } = row as {
        threadId: string;
        runId: string;
        status: string;
      };
      if (!(RUN_STATUSES as readonly string[]).includes(status))
        found.push({
          invariant: 'status',
          threadId,
          runId,
          detail: `unknown status ${status}`,
        });
      if ((status === 'running') !== (Number(row.terminals) === 0))
        found.push({
          invariant: 'I1',
          threadId,
          runId,
          detail: `status ${status} with ${row.terminals} terminal events`,
        });
    }
    for (const row of this.db
      .prepare(
        `SELECT e.threadId, e.runId, COUNT(*) AS n, MIN(e.seq) AS lo, MAX(e.seq) AS hi,
           EXISTS(SELECT 1 FROM conversation_runs r WHERE r.threadId = e.threadId AND r.runId = e.runId) AS hasRun
         FROM conversation_events e GROUP BY e.threadId, e.runId ORDER BY e.threadId, e.runId`,
      )
      .all() as Row[]) {
      const { threadId, runId } = row as { threadId: string; runId: string };
      if (!row.hasRun)
        found.push({
          invariant: 'I2',
          threadId,
          runId,
          detail: 'events without a run',
        });
      else if (row.lo !== 0 || row.hi !== Number(row.n) - 1)
        found.push({
          invariant: 'I2',
          threadId,
          runId,
          detail: `event seq ${row.lo}..${row.hi} for ${row.n} events`,
        });
    }
    for (const row of this.db
      .prepare(
        `SELECT r.threadId, r.runId FROM conversation_runs r
         WHERE NOT EXISTS (SELECT 1 FROM conversation_events e WHERE e.threadId = r.threadId AND e.runId = r.runId)
         ORDER BY r.threadId, r.seq`,
      )
      .all() as Array<{ threadId: string; runId: string }>)
      found.push({ ...row, invariant: 'I2', detail: 'run without events' });
    for (const row of this.db
      .prepare(
        `SELECT threadId, COUNT(*) AS n, MIN(seq) AS lo, MAX(seq) AS hi
         FROM conversation_runs GROUP BY threadId ORDER BY threadId`,
      )
      .all() as Row[])
      if (row.lo !== 1 || row.hi !== Number(row.n))
        found.push({
          invariant: 'I2',
          threadId: String(row.threadId),
          detail: `run seq ${row.lo}..${row.hi} for ${row.n} runs`,
        });
    for (const row of this.db
      .prepare(
        `SELECT m.threadId, m.lastEventId,
           (SELECT COALESCE(MAX(e.id), 0) FROM conversation_events e WHERE e.threadId = m.threadId) AS newest
         FROM conversation_messages m ORDER BY m.threadId`,
      )
      .all() as Row[])
      if (Number(row.lastEventId) > Number(row.newest))
        found.push({
          invariant: 'I3',
          threadId: String(row.threadId),
          detail: `view stamp ${row.lastEventId} is ahead of the log at ${row.newest}`,
        });
    return found;
  }

  // ------------------------------------------------- the derived message view

  // The authoritative derivation: every event of the thread folded from an empty
  // state. Ignores the view table entirely. The events and the watermark are
  // read in one synchronous stretch, so `lastEventId` is exactly the newest event
  // the messages include, even if an append lands while the fold is running.
  async deriveMessages(
    threadId: string,
  ): Promise<{ messages: Message[]; lastEventId: number }> {
    const events = this.threadEvents(threadId).map((stored) => stored.event);
    const lastEventId = this.maxEventId(threadId);
    return { messages: await foldEvents(events), lastEventId };
  }

  // Derives from the events and replaces the view row. The events win over
  // whatever the row held. A failure here changes no run or event.
  async rebuildMessages(threadId: string): Promise<Message[]> {
    const { messages, lastEventId } = await this.deriveMessages(threadId);
    const messagesJson = JSON.stringify(messages);
    this.transaction(() =>
      this.db
        .prepare(
          `INSERT INTO conversation_messages(threadId, messagesJson, lastEventId) VALUES (?, ?, ?)
           ON CONFLICT(threadId) DO UPDATE SET messagesJson = excluded.messagesJson, lastEventId = excluded.lastEventId`,
        )
        .run(threadId, messagesJson, lastEventId),
    );
    return messages;
  }

  // The minimal C4 freshness rule (section 5.7). The cached row is trusted only
  // if it exists, its lastEventId equals the thread's newest event id, no run is
  // active, and its payload parses to an array. Anything else derives from the
  // events. A reader never writes. Known limit: a payload that parses and carries
  // the right stamp is served as is; the content hash that would catch it
  // (messagesSha256) is deferred to C8, and deriveMessages/rebuildMessages ignore
  // or replace the row.
  async readMessages(
    threadId: string,
    options: { runActive: boolean },
  ): Promise<{ messages: Message[]; source: MessageSource }> {
    if (!options.runActive) {
      const cached = this.freshCache(threadId);
      if (cached) return { messages: cached, source: 'cache' };
    }
    return {
      messages: (await this.deriveMessages(threadId)).messages,
      source: 'events',
    };
  }

  private freshCache(threadId: string): Message[] | undefined {
    const row = this.db
      .prepare(
        'SELECT messagesJson, lastEventId FROM conversation_messages WHERE threadId = ?',
      )
      .get(threadId) as
      { messagesJson: string; lastEventId: number } | undefined;
    if (!row || row.lastEventId !== this.maxEventId(threadId)) return undefined;
    try {
      const parsed: unknown = JSON.parse(row.messagesJson);
      return Array.isArray(parsed) ? (parsed as Message[]) : undefined;
    } catch {
      return undefined;
    }
  }
}

function toRun(row: Row): RunRow {
  return {
    threadId: String(row.threadId),
    runId: String(row.runId),
    seq: Number(row.seq),
    agentId: String(row.agentId),
    parentRunId: row.parentRunId === null ? null : String(row.parentRunId),
    status: String(row.status) as RunStatus,
    startedAt: Number(row.startedAt),
    finishedAt: row.finishedAt === null ? null : Number(row.finishedAt),
  };
}

function toEvent(row: Row): StoredEvent {
  return {
    id: Number(row.id),
    threadId: String(row.threadId),
    runId: String(row.runId),
    seq: Number(row.seq),
    eventType: String(row.eventType),
    messageId: row.messageId === null ? null : String(row.messageId),
    event: JSON.parse(String(row.eventJson)) as BaseEvent,
  };
}
