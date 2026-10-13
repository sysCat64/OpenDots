// Must stay the first import: see telemetry-guard.ts.
import './telemetry-guard.js';
import {
  AgentRunner,
  finalizeRunEvents,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
  type LocalThreadEndpointRecord,
} from '@copilotkit/runtime/v2';
import {
  Middleware,
  compactEvents,
  verifyEvents,
  type AbstractAgent,
} from '@ag-ui/client';
import type { BaseEvent, Message, RunAgentInput } from '@ag-ui/core';
import { Observable, ReplaySubject, tap, throwError } from 'rxjs';
import {
  ConversationLog,
  DuplicateRunError,
  RunNotRunningError,
  type RunRow,
  type StoredEvent,
  type TerminalStatus,
} from './conversation-log.js';
import {
  UNKNOWN_OUTCOME_CONTENT,
  classifyRun,
  findStaleToolHistory,
  recoveryEvents,
  type RecoveryKind,
} from './run-rules.js';
import { RunFacts } from './run-facts.js';

// A durable AgentRunner over the local conversation log. Every event of a run
// is written to the log and committed before any subscriber sees it (policy W1:
// persist, commit, publish). The log is the authority; this class holds only
// process-local state: which runs it is driving and their live streams.
//
// Dormant (C4b): nothing in the application imports this module, so no runner
// is ever constructed in production. It takes everything by injection: the log,
// the server-owned set of tools that may run on the client (R23, DEC-19) and the
// ownership predicate (an OpenDots seam, not part of the SDK AgentRunner
// contract). The conversation schema is created only by initializeStorage(),
// reached from the first use of a runner someone chose to construct.
//
// R17: one OpenDots server process owns the database and this runtime. Exclusion
// is process-local; a second process on the same file is not recognised, and its
// ready() would wrongly recover this process's live run. No multi-process safety
// is claimed.
//
// The execution fence (A1). A server tool executor must never begin before the
// tool call's START, ARGS and END events are committed. A subscriber callback
// (the AG-UI onEvent) cannot give that: it runs after asynchronous stages, and
// the producer runs the executor right after it pushes TOOL_CALL_END. So each
// run installs one synchronous rxjs operator, DurableFenceTap, through the
// public agent.use() as the only and therefore innermost middleware, directly
// on the producer's output. It appends and commits each event inside the
// producer's own push, publishes it, and on a write failure aborts the producer
// and errors the stream before the producer can go on. runAgent stays the
// execution path, so nothing is bypassed.
//
// Safety assumptions that tie this to the pinned SDK (@ag-ui/client 0.0.59,
// @copilotkit/runtime 1.75.0), all enforced at run time and fail closed:
//  - runAgent composes middlewares with reduceRight, so the last one added is
//    the innermost. The tap is installed last and checked to be the only one.
//  - agent.middlewares (a TypeScript-private field) is a readable array. If an
//    SDK change reshapes it the run is refused rather than guessed at.
//  - No other middleware is allowed. An asynchronous one (for example the
//    runtime's MCP middleware) can run tools itself, rewrite the stream or add
//    events after the producer finished, so the log would no longer be what the
//    client received. There is no allowlist: an SDK upgrade needs its own review.
// Authority: docs/LOCAL_FIRST_C4_LANDING_BOUNDARY.md sections 8 to 18 and 23.

export type RunRejectCode =
  | 'THREAD_NOT_OWNED'
  | 'THREAD_ALREADY_RUNNING'
  | 'THREAD_HAS_UNRESOLVED_RUN'
  | 'STALE_TOOL_HISTORY'
  | 'DUPLICATE_RUN_ID'
  | 'UNSUPPORTED_MIDDLEWARE';

// Thrown synchronously from run(), before anything is written, the agent is
// started or a tool executes. THREAD_ALREADY_RUNNING is the explicit busy
// conflict a caller can map; the runner never waits or queues.
// THREAD_HAS_UNRESOLVED_RUN is the other refusal of a free-looking thread: the
// log holds a run of it that recovery leaves open (R22, R24, R26b), so its
// outcome is unknown or its client tool call is unanswered. It is not a busy
// condition and retrying does not clear it; only resolving that run does, and
// nothing resolves it yet.
export class RunRejectedError extends Error {
  constructor(
    readonly code: RunRejectCode,
    readonly threadId: string,
    readonly runId: string,
    message: string,
  ) {
    super(message);
    this.name = 'RunRejectedError';
  }
}

// clearThreads() deletes every conversation, so the runner never does it. The
// scope layer already denies the route; this is the defence in depth (DEC-16).
export class ClearThreadsRefusedError extends Error {
  readonly code = 'CLEAR_THREADS_REFUSED' as const;
  constructor() {
    super(
      'Refusing to clear every conversation: the durable log is not erasable through the runner',
    );
    this.name = 'ClearThreadsRefusedError';
  }
}

export interface DurableRunnerOptions {
  log: ConversationLog;
  // Server-owned: the tool names that may legally be executed on the client.
  // A tool is client-executed only if the client also declared it (DEC-19).
  clientExecutableToolNames: ReadonlySet<string>;
  // Whether this agent may use this thread. Called with the thread id and the
  // id of the agent the SDK supplied.
  ownsThread: (threadId: string, agentId: string) => boolean;
}

export interface RecoveryRecord {
  threadId: string;
  runId: string;
  kind: RecoveryKind;
  outcome: 'recovered' | 'deferred';
  appended: string[];
  status?: TerminalStatus;
}

export interface ReadyResult {
  // Threads whose message view was checked, and how many had to be rebuilt.
  checked: number;
  rebuilt: number;
  // Dead runs: closed by recovery, or left running because their class is open.
  recovered: RecoveryRecord[];
  deferred: RecoveryRecord[];
}

interface ActiveRun {
  runId: string;
  agent: AbstractAgent;
  // The persistence tap this run installed on the agent, removed when it ends.
  tap?: DurableFenceTap;
  // The events of this run that are committed, in order.
  events: BaseEvent[];
  // Replays the run from its first event to every late subscriber and is what
  // run() returns.
  subject: ReplaySubject<BaseEvent>;
  persistedStart: BaseEvent;
  startPublished: boolean;
  stopRequested: boolean;
  // Set when an event could not be written. The AG-UI client swallows an error
  // thrown from the subscriber, so the runner itself stops persisting and
  // publishing from then on: a log never skips an event and goes on.
  failure?: unknown;
  // The terminal event is durable.
  finalized: boolean;
  // Resolves once the run is fully over (view attempted, thread released).
  done: Promise<void>;
  release: () => void;
}

// ------------------------------------------------------------------- the fence

// Class names only, never the middleware's own data (an MCP middleware carries
// server URLs and headers).
function middlewareNames(chain: readonly unknown[]): string {
  return chain
    .map((entry) => {
      const name =
        entry !== null && typeof entry === 'object'
          ? (entry as object).constructor?.name
          : typeof entry;
      return String(name ?? 'unknown')
        .replace(/[^\w$.-]/g, '?')
        .slice(0, 40);
    })
    .join(', ');
}

type MiddlewareCheck = { ok: true } | { ok: false; reason: string };

// Reads the agent's middleware chain. `expected` is what this run may find: no
// middleware before the tap is installed, exactly the tap afterwards.
function checkMiddlewares(
  agent: AbstractAgent,
  expected: readonly unknown[],
): MiddlewareCheck {
  const chain = (agent as unknown as { middlewares?: unknown }).middlewares;
  if (!Array.isArray(chain))
    return {
      ok: false,
      reason:
        'the agent middleware chain is not readable (the SDK layout changed)',
    };
  const matches =
    chain.length === expected.length &&
    chain.every((entry, index) => entry === expected[index]);
  if (matches) return { ok: true };
  const foreign = chain.filter((entry) => !expected.includes(entry));
  return {
    ok: false,
    reason: foreign.length
      ? `unsupported middleware on the agent (${foreign.length}: ${middlewareNames(foreign)}); none is allowed`
      : 'the persistence middleware is missing, duplicated or out of place',
  };
}

// The synchronous persistence operator of one run. It is the producer's
// downstream: nothing the producer pushes next can happen before this returns.
class DurableFenceTap extends Middleware {
  constructor(
    private readonly agent: AbstractAgent,
    private readonly threadId: string,
    private readonly runId: string,
    private readonly handle: (event: BaseEvent) => void,
  ) {
    super();
  }

  run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    // The latest point before execution: the chain is composed, and nothing has
    // been requested from the model yet because that happens when the source
    // below is subscribed to.
    const verdict = checkMiddlewares(this.agent, [this]);
    if (!verdict.ok) return throwError(() => new Error(verdict.reason));
    if (input.threadId !== this.threadId || input.runId !== this.runId)
      return throwError(
        () => new Error('the persistence middleware belongs to another run'),
      );
    // runNext applies transformChunks. verifyEvents keeps the log to the events
    // the pipeline itself would accept. The operator form matters: an error
    // thrown here ends the stream and rejects runAgent, where a throw in a
    // subscriber callback is swallowed (onEvent) or reported late and ignored.
    return this.runNext(input, next).pipe(
      verifyEvents(false),
      tap((event) => this.handle(event)),
    );
  }
}

type Loose = { type: string; [field: string]: unknown };
const loose = (event: BaseEvent) => event as unknown as Loose;
const isTerminal = (event: BaseEvent) =>
  event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR';

export class DurableAgentRunner extends AgentRunner {
  readonly ɵsupportsLocalThreadEndpoints = true as const;
  private readonly log: ConversationLog;
  private readonly clientExecutableToolNames: ReadonlySet<string>;
  private readonly ownership: DurableRunnerOptions['ownsThread'];
  private readonly active = new Map<string, ActiveRun>();
  // The derived view as this process last wrote or read it, with the newest
  // event id it covers. Only a mirror for the synchronous endpoint: it is valid
  // while that id equals the log's, never an authority.
  private readonly viewMirror = new Map<
    string,
    { lastEventId: number; messages: Message[] }
  >();
  private readonly viewRepairLogged = new Set<string>();
  private storageReady = false;
  // Read-only facts about runs (C4c): what is durable and what this process is
  // driving. Not admission: only run() admits a run, and a fact read can be out
  // of date the moment it is returned. The accessors write nothing, recover
  // nothing and create no schema, so reading them has no effect on the runner.
  readonly facts: RunFacts;

  constructor(options: DurableRunnerOptions) {
    super();
    this.log = options.log;
    this.clientExecutableToolNames = options.clientExecutableToolNames;
    this.ownership = options.ownsThread;
    this.facts = new RunFacts(this.log, {
      active: this.active,
      ownsThread: (threadId, agentId) => this.ownsThread(threadId, agentId),
      clientExecutableToolNames: this.clientExecutableToolNames,
    });
  }

  // ------------------------------------------------------------- initialization

  // The only place the conversation schema is created: a runner that was
  // constructed on purpose creates it on first use. Normal application startup
  // constructs no runner, so it creates no table.
  private initializeStorage(): void {
    if (this.storageReady) return;
    if (!this.log.hasSchema()) this.log.ensureSchema();
    this.storageReady = true;
  }

  // ----------------------------------------------------------------- ownership

  // OpenDots-defined, not an SDK contract. Fails closed.
  ownsThread(threadId: string, agentId: string): boolean {
    try {
      return this.ownership(threadId, agentId) === true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------------ run

  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const { threadId, agent, input } = request;
    const runId = input.runId;
    const reject: (code: RunRejectCode, message: string) => never = (
      code,
      message,
    ) => {
      throw new RunRejectedError(code, threadId, runId, message);
    };
    // 1. Ownership, before anything else is read or written.
    const agentId = agent.agentId;
    if (!agentId || !this.ownsThread(threadId, agentId))
      reject('THREAD_NOT_OWNED', `Agent does not own thread ${threadId}`);
    // 1b. No middleware may stand between the producer and the persistence tap.
    //     Before anything is written or started.
    const admitted = checkMiddlewares(agent, []);
    if (!admitted.ok) reject('UNSUPPORTED_MIDDLEWARE', admitted.reason);
    this.initializeStorage();
    // 2. One run per thread. The check and active.set below are one synchronous
    //    stretch with no await between them.
    if (this.active.has(threadId))
      reject('THREAD_ALREADY_RUNNING', `Thread ${threadId} already has a run`);
    // 3. A dead run of this thread is closed first, so the interlock sees any
    //    result recovery wrote. A run that recovery had to leave open (R22,
    //    R24, R26b) is not resolved by it: its server tool may have run with an
    //    unknown outcome, or a client tool call may still be unanswered. The
    //    thread then admits nothing. The decision is made from the result of
    //    this very recovery and, with the reservation below, in one synchronous
    //    stretch (no await, no second read), so two same-turn requests cannot
    //    both pass. Nothing is closed, rewritten or invented here and nothing
    //    is written for the refused run. R17 is unchanged: this is the
    //    exclusion of one process.
    const unresolved = this.recoverRuns(threadId).filter(
      (record) => record.outcome === 'deferred',
    );
    if (unresolved.length)
      reject(
        'THREAD_HAS_UNRESOLVED_RUN',
        `Thread ${threadId} has ${unresolved.length} unresolved run(s); no new run is admitted until they are resolved`,
      );
    // 4. The client's history must not leave out a result the log holds.
    const stale = findStaleToolHistory(
      input,
      this.log.heldToolCallIds(threadId),
    );
    if (stale !== null)
      reject(
        'STALE_TOOL_HISTORY',
        `The history leaves out the recorded result of tool call ${stale}; reload the conversation`,
      );
    // 5. Persist RUN_STARTED (sanitised) before the agent starts. A duplicate
    //    (threadId, runId) is rejected inside that transaction.
    const known = this.knownMessageIds(threadId);
    const startEvent = {
      type: 'RUN_STARTED',
      threadId,
      runId,
      input: {
        ...input,
        ...(input.messages
          ? { messages: input.messages.filter((m) => !known.has(m.id)) }
          : {}),
      },
    } as unknown as BaseEvent;
    let persistedStart: BaseEvent;
    try {
      persistedStart = this.log.startRun({
        threadId,
        runId,
        agentId,
        startEvent,
      }).event.event;
    } catch (error) {
      if (error instanceof DuplicateRunError)
        reject('DUPLICATE_RUN_ID', error.message);
      throw error;
    }
    let release!: () => void;
    const state: ActiveRun = {
      runId,
      agent,
      events: [persistedStart],
      subject: new ReplaySubject<BaseEvent>(Infinity),
      persistedStart,
      startPublished: false,
      stopRequested: false,
      finalized: false,
      done: new Promise<void>((resolve) => (release = resolve)),
      release,
    };
    this.active.set(threadId, state);
    void this.drive(threadId, state, request);
    return state.subject.asObservable();
  }

  // The message namespace: ids of input messages, of every event's messageId and
  // the parentMessageId of tool calls. toolCallIds are a separate namespace.
  private knownMessageIds(threadId: string): Set<string> {
    const ids = new Set<string>();
    for (const { event } of this.log.threadEvents(threadId)) {
      const value = loose(event);
      if (typeof value.messageId === 'string') ids.add(value.messageId);
      if (
        value.type === 'TOOL_CALL_START' &&
        typeof value.parentMessageId === 'string'
      )
        ids.add(value.parentMessageId);
      if (value.type === 'RUN_STARTED') {
        const messages = (value.input as { messages?: Array<{ id?: unknown }> })
          ?.messages;
        for (const message of messages ?? [])
          if (typeof message.id === 'string') ids.add(message.id);
      }
    }
    return ids;
  }

  private async drive(
    threadId: string,
    state: ActiveRun,
    request: AgentRunnerRunRequest,
  ): Promise<void> {
    const { agent } = request;
    let failure: unknown;
    try {
      const tap = new DurableFenceTap(agent, threadId, state.runId, (event) =>
        this.persistAndPublish(threadId, state, event),
      );
      state.tap = tap;
      agent.use(tap);
      // use() is the public way in; make sure it did what the fence relies on.
      const installed = checkMiddlewares(agent, [tap]);
      if (!installed.ok) throw new Error(installed.reason);
      await agent.runAgent(request.input);
    } catch (error) {
      failure = error;
    }
    // Before the run is released, so a caller that starts the next run on this
    // agent from the stream's completion finds the chain it came with.
    this.uninstall(agent, state);
    await this.finalizeRun(threadId, state, state.failure ?? failure);
  }

  // Takes this run's tap off the agent, by identity, however the run ended, so
  // an agent that is used again starts from the chain it came with.
  private uninstall(agent: AbstractAgent, state: ActiveRun): void {
    const chain = (agent as unknown as { middlewares?: unknown }).middlewares;
    if (!Array.isArray(chain) || !state.tap) return;
    const at = chain.indexOf(state.tap);
    if (at >= 0) chain.splice(at, 1);
    state.tap = undefined;
  }

  // Runs inside the producer's push (see DurableFenceTap): persist and commit,
  // then publish. If the write fails the event is not published, the producer is
  // aborted before it can go on, and the error ends the stream; the run is then
  // finalized with that error.
  private persistAndPublish(
    threadId: string,
    state: ActiveRun,
    event: BaseEvent,
  ): void {
    if (state.failure !== undefined) throw state.failure;
    // RUN_STARTED is already durable (committed before the agent started). The
    // persisted event, which carries the sanitised input, is what is published.
    if (event.type === 'RUN_STARTED') {
      this.publishStart(state);
      return;
    }
    const terminal = isTerminal(event);
    let stored: StoredEvent[];
    try {
      // A terminal event is never committed beside a server tool call that
      // may have entered its executor and has no durable result (see
      // unknownOutcomeEvents). The markers, the terminal event and the status
      // are one append, so none of them is ever durable without the others.
      const markers = terminal ? this.unknownOutcomeEvents(state.events) : [];
      const options = {
        status: terminal ? this.terminalStatus(state, event) : undefined,
      };
      stored = markers.length
        ? this.log.appendEvents(
            threadId,
            state.runId,
            [...markers, event],
            options,
          )
        : [this.log.appendEvent(threadId, state.runId, event, options)];
    } catch (error) {
      state.failure = error;
      try {
        state.agent.abortRun();
      } catch {
        // the stream is ended below either way
      }
      throw error;
    }
    this.publishStart(state);
    // Committed in order, published in order: the markers precede the terminal
    // event on the stream exactly as they do in the log.
    for (const item of stored) {
      state.events.push(item.event);
      state.subject.next(item.event);
    }
  }

  private terminalStatus(state: ActiveRun, event: BaseEvent): TerminalStatus {
    if (event.type === 'RUN_ERROR') return 'error';
    return state.stopRequested ? 'stopped' : 'finished';
  }

  private publishStart(state: ActiveRun): void {
    if (state.startPublished) return;
    state.startPublished = true;
    state.subject.next(state.persistedStart);
  }

  // The server tool calls of a run that may have entered their executor and
  // have no durable result. A tool call is only ever recorded as "unknown"
  // here, never as a success and never as a failure: the log cannot tell a call
  // whose executor never started from one whose effect committed and whose
  // result was lost, and a stop, an abort or a provider failure proves neither.
  // Only ended, unresolved, non-client calls are listed (classifyRun): an
  // already durable result, a client (HITL) call (its result comes from the
  // user, not from an executor) and a call whose arguments were still streaming
  // (the A1 fence guarantees its executor cannot have run) keep what they have.
  private pendingServerCallIds(events: readonly BaseEvent[]): Set<string> {
    return new Set(
      classifyRun(events, this.clientExecutableToolNames).pendingServer.map(
        (call) => call.toolCallId,
      ),
    );
  }

  // The same result recovery writes (run-rules.ts), byte for byte.
  private unknownOutcomeEvent(toolCallId: string): BaseEvent {
    return {
      type: 'TOOL_CALL_RESULT',
      toolCallId,
      messageId: `${toolCallId}-unknown-outcome`,
      role: 'tool',
      content: UNKNOWN_OUTCOME_CONTENT,
    } as unknown as BaseEvent;
  }

  // A (terminal commit). What must be committed together with a terminal event
  // that is about to be appended to `events`: one unknown-outcome result per
  // pending server call, in the order the calls started. Nothing is executed,
  // retried or invented, and a run with no pending server call gets nothing.
  private unknownOutcomeEvents(events: readonly BaseEvent[]): BaseEvent[] {
    return [...this.pendingServerCallIds(events)].map((id) =>
      this.unknownOutcomeEvent(id),
    );
  }

  // A' (no terminal event). A failure, a user stop, and a stream that simply
  // ended (the agent aborting itself on its timer or its watcher) can end a run
  // after a server executor was entered and before its result was recorded. The
  // stock finalizer closes such a call with an "error" or "stopped" result,
  // which reads as "it did not run". The call gets the unknown-outcome result
  // instead. This does not depend on why the run ended.
  private keepUnknownOutcome(
    events: readonly BaseEvent[],
    closers: BaseEvent[],
  ): BaseEvent[] {
    // Nothing to rewrite (a run that ended with its own terminal event): no
    // need to classify the run again.
    if (!closers.length) return closers;
    const pending = this.pendingServerCallIds(events);
    if (!pending.size) return closers;
    return closers.map((event) => {
      const stored = loose(event);
      const toolCallId =
        typeof stored.toolCallId === 'string' ? stored.toolCallId : undefined;
      return stored.type === 'TOOL_CALL_RESULT' &&
        toolCallId !== undefined &&
        pending.has(toolCallId)
        ? this.unknownOutcomeEvent(toolCallId)
        : event;
    });
  }

  private async finalizeRun(
    threadId: string,
    state: ActiveRun,
    failure?: unknown,
  ): Promise<void> {
    try {
      // A user stop is not an error, however the aborted stream ended.
      const interruption =
        failure === undefined || state.stopRequested
          ? undefined
          : failure instanceof Error
            ? failure.message
            : String(failure);
      const closers = finalizeRunEvents([...state.events], {
        stopRequested: state.stopRequested,
        ...(interruption !== undefined
          ? { interruptionMessage: interruption }
          : {}),
      });
      // Whatever ended the run, a server executor may have run: a stop is a
      // flag (an executor already entered runs to completion and its result is
      // not recorded), and an agent's own abort ends the stream with neither a
      // failure nor a stop request. Run status (`stopped`, `error`) and tool
      // outcome are independent, so such a call is recorded as unknown, never
      // as "stopped" or as an error. The stock finalizer returns no closer once
      // a terminal event was observed, so this only rewrites closers that exist.
      const appended = this.keepUnknownOutcome(state.events, closers);
      if (appended.length) {
        const last = appended[appended.length - 1];
        // One transaction for the closers, the terminal event and the status.
        const stored = this.log.appendEvents(threadId, state.runId, appended, {
          status: this.terminalStatus(state, last),
        });
        this.publishStart(state);
        for (const item of stored) {
          state.events.push(item.event);
          state.subject.next(item.event);
        }
      } else this.publishStart(state);
    } catch (error) {
      // The final write failed. The run stays 'running' in the log and recovery
      // closes it. Nothing was published that was not committed.
      console.error(
        `The final events of run ${state.runId} on thread ${threadId} could not be written; recovery will close it.`,
        error,
      );
      this.publishStart(state);
    }
    state.finalized = true;
    await this.refreshView(threadId);
    this.active.delete(threadId);
    state.subject.complete();
    state.release();
  }

  // ----------------------------------------------------------- derived messages

  // Rebuilds the view from the events. A failure never changes the run, whose
  // outcome the events already decide: one repair attempt, a note once per
  // thread, and the next finalization or ready() catches up. Readers derive from
  // the events meanwhile.
  private async refreshView(threadId: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.rebuildView(threadId);
        this.viewRepairLogged.delete(threadId);
        return;
      } catch (error) {
        if (attempt === 1 && !this.viewRepairLogged.has(threadId)) {
          this.viewRepairLogged.add(threadId);
          console.error(
            `Conversation view for thread ${threadId} could not be written; readers derive it from the events.`,
            error,
          );
        }
      }
    }
  }

  private async rebuildView(threadId: string): Promise<Message[]> {
    // rebuildMessages reads the events and its watermark in one synchronous
    // stretch, so the id read here is the one the stored row carries.
    const lastEventId = this.log.maxEventId(threadId);
    const messages = await this.log.rebuildMessages(threadId);
    this.viewMirror.set(threadId, { lastEventId, messages });
    return messages;
  }

  // The reader seam (P-3): the cached view when it is fresh and the thread is
  // idle, otherwise a derivation from the committed events. Writes nothing.
  async messagesFor(threadId: string): Promise<Message[]> {
    this.initializeStorage();
    return (
      await this.log.readMessages(threadId, {
        runActive: this.active.has(threadId),
      })
    ).messages;
  }

  // ------------------------------------------------------------- connect / state

  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    this.initializeStorage();
    const { threadId } = request;
    const active = this.active.get(threadId);
    // Every other run comes from the log. The active run is owned by its live
    // stream, which replays it from its first event, so its durable prefix is
    // not read: it would be delivered twice.
    const history = this.log
      .threadEvents(threadId)
      .filter((stored) => stored.runId !== active?.runId)
      .map((stored) => stored.event);
    return new Observable<BaseEvent>((subscriber) => {
      for (const event of compactEvents(history)) subscriber.next(event);
      if (!active) {
        subscriber.complete();
        return undefined;
      }
      const live = active.subject.subscribe(subscriber);
      return () => live.unsubscribe();
    });
  }

  async isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
    const state = this.active.get(request.threadId);
    return !!state && !state.finalized && !state.stopRequested;
  }

  async stop(request: AgentRunnerStopRequest): Promise<boolean | undefined> {
    const state = this.active.get(request.threadId);
    if (!state || state.finalized || state.stopRequested) return false;
    if (state.failure !== undefined) return false;
    if (request.runId !== undefined && state.runId !== request.runId)
      return false;
    state.stopRequested = true;
    try {
      state.agent.abortRun();
      return true;
    } catch (error) {
      console.error('Failed to abort the agent run', error);
      state.stopRequested = false;
      return false;
    }
  }

  // Stops every active run and waits for each to be finalized, up to the
  // deadline, so a graceful shutdown leaves no interrupted run. A run that does
  // not end in time stays 'running' in the log for recovery.
  async stopAll(
    deadlineMs: number,
  ): Promise<{ stopped: number; remaining: number }> {
    const runs = [...this.active.entries()];
    await Promise.all(
      runs.map(([threadId, state]) =>
        this.stop({ threadId, runId: state.runId }),
      ),
    );
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, deadlineMs));
    });
    await Promise.race([Promise.all(runs.map(([, s]) => s.done)), deadline]);
    clearTimeout(timer);
    const remaining = runs.filter(
      ([threadId, s]) => this.active.get(threadId) === s,
    ).length;
    return { stopped: runs.length - remaining, remaining };
  }

  // -------------------------------------------------------- local thread methods

  listThreads(): LocalThreadEndpointRecord[] {
    this.initializeStorage();
    const threads: LocalThreadEndpointRecord[] = [];
    for (const threadId of this.log.threadIds()) {
      const runs = this.log.runs(threadId);
      const ended = runs.filter((run) => run.status !== 'running');
      if (!ended.length) continue;
      threads.push({
        id: threadId,
        name: null,
        agentId: runs[0].agentId,
        organizationId: '',
        createdById: '',
        archived: false,
        createdAt: new Date(
          Math.min(...runs.map((r) => r.startedAt)),
        ).toISOString(),
        updatedAt: new Date(
          Math.max(...runs.map((r) => r.finishedAt ?? r.startedAt)),
        ).toISOString(),
      });
    }
    return threads;
  }

  // The synchronous SDK endpoint cannot derive (the reducer is asynchronous), so
  // it answers from the mirror and fails closed when the view is stale. OpenDots
  // reads through messagesFor().
  getThreadMessages(threadId: string): Message[] {
    this.initializeStorage();
    if (!this.log.runs(threadId).length) return [];
    const mirror = this.viewMirror.get(threadId);
    if (this.active.has(threadId)) return mirror?.messages ?? [];
    if (!mirror)
      throw new Error(
        `The conversation view of ${threadId} is missing; it has not been derived by this process`,
      );
    if (mirror.lastEventId !== this.log.maxEventId(threadId))
      throw new Error(`The conversation view of ${threadId} is stale`);
    return mirror.messages;
  }

  // Committed events of runs that are not active, compacted.
  getThreadEvents(threadId: string): BaseEvent[] {
    this.initializeStorage();
    const active = this.active.get(threadId);
    const events = this.log
      .threadEvents(threadId)
      .filter((stored) => stored.runId !== active?.runId)
      .map((stored) => stored.event);
    return events.length ? compactEvents(events) : [];
  }

  getThreadState(threadId: string): Record<string, unknown> | null {
    const events = this.getThreadEvents(threadId);
    for (let i = events.length - 1; i >= 0; i--) {
      const event = loose(events[i]);
      if (event.type === 'STATE_SNAPSHOT') {
        const snapshot = event.snapshot;
        return snapshot &&
          typeof snapshot === 'object' &&
          !Array.isArray(snapshot)
          ? { ...(snapshot as Record<string, unknown>) }
          : null;
      }
    }
    return null;
  }

  clearThreads(): void {
    throw new ClearThreadsRefusedError();
  }

  // ------------------------------------------------------------------- recovery

  // Closes the runs that died without a terminal event, from the stored events
  // alone. It never drives an agent: no model call and no tool execution is
  // repeated for any class. A run this instance is driving is never touched.
  // Classes the rules leave open (R22, R24, R26b) are reported, not written.
  private recoverRuns(only?: string): RecoveryRecord[] {
    const records: RecoveryRecord[] = [];
    for (const run of this.log.runningRuns()) {
      if (only !== undefined && run.threadId !== only) continue;
      if (this.active.get(run.threadId)?.runId === run.runId) continue;
      const record = this.recoverRun(run);
      if (record) records.push(record);
    }
    return records;
  }

  private recoverRun(run: RunRow): RecoveryRecord | undefined {
    const events = this.log
      .runEvents(run.threadId, run.runId)
      .map((stored) => stored.event);
    const classification = classifyRun(events, this.clientExecutableToolNames);
    const base = {
      threadId: run.threadId,
      runId: run.runId,
      kind: classification.kind,
    };
    const plan = recoveryEvents(
      run.threadId,
      run.runId,
      events,
      classification,
    );
    if (!plan) return { ...base, outcome: 'deferred', appended: [] };
    try {
      // One transaction; the run's status is re-checked inside it.
      this.log.appendEvents(run.threadId, run.runId, plan.appended, {
        status: plan.status,
      });
    } catch (error) {
      if (error instanceof RunNotRunningError) return undefined;
      throw error;
    }
    return {
      ...base,
      outcome: 'recovered',
      appended: plan.appended.map((event) => event.type),
      status: plan.status,
    };
  }

  // Explicit initialization and boot-time repair: creates the schema if this
  // runner owns an empty database, closes dead runs, then makes sure every
  // thread's view is fresh. A healthy database costs one watermark check per
  // thread and writes nothing. It calls no model and no tool.
  async ready(): Promise<ReadyResult> {
    this.initializeStorage();
    const records = this.recoverRuns();
    let checked = 0;
    let rebuilt = 0;
    for (const threadId of this.log.threadIds()) {
      // A run this instance is driving owns its thread's view until it ends.
      if (this.active.has(threadId)) continue;
      checked += 1;
      const lastEventId = this.log.maxEventId(threadId);
      const { messages, source } = await this.log.readMessages(threadId, {
        runActive: false,
      });
      if (source === 'cache') {
        // A fresh row: remember what it covers, write nothing.
        this.viewMirror.set(threadId, { lastEventId, messages });
        continue;
      }
      await this.rebuildView(threadId);
      rebuilt += 1;
    }
    return {
      checked,
      rebuilt,
      recovered: records.filter((record) => record.outcome === 'recovered'),
      deferred: records.filter((record) => record.outcome === 'deferred'),
    };
  }
}
