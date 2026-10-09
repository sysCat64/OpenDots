// Must stay the first import: see telemetry-guard.ts.
import './telemetry-guard.js';
import { randomUUID } from 'node:crypto';
import type { AbstractAgent } from '@ag-ui/client';
import type { BaseEvent, Message, RunAgentInput } from '@ag-ui/core';
import type { Subscription } from 'rxjs';
import { voiceReceiptMessagePrefix } from '../shared/voice-receipt.js';
import { RunRejectedError, type DurableAgentRunner } from './durable-runner.js';
import { currentTurnText } from './headless.js';

// Dormant (C5): the local, in-process equivalent of runThreadTurn (headless.ts)
// on the durable runner. Nothing in the application imports this module, so it
// is never loaded and changes no behaviour; tests/dormancy*.test.ts enforce it.
// Authority: docs/LOCAL_FIRST_C5_LANDING_BOUNDARY.md.
//
// What it is: one turn, prompt only, on a thread. It asks the runner to run a
// fresh agent and reads the result from the runner's own event stream. It does
// not persist, execute tools, recover or retry anything itself: the A1 fence,
// W1 publication order, thread exclusivity and the unknown-outcome rules are the
// runner's, and the only calls made on it are run() and stop().
//
// Admission is the runner's. isRunning() is the SDK-facing state: it turns false
// when a stop is requested although the run is still settling and the thread is
// still reserved, so it is never consulted. A synchronous THREAD_ALREADY_RUNNING
// rejection from run() is the one authoritative "busy", and it is refused, never
// queued and never retried. Any other rejection (THREAD_NOT_OWNED and the rest)
// passes through unmapped.

// A provisional internal default, not an approved voice UX policy. Waited for
// only after an abort, and only until the runner finishes the run.
export const DEFAULT_ABORT_GRACE_MS = 10_000;

// The thread is reserved by another run (or by this thread's run that is still
// settling). The run did not start: no model request, no tool, no durable write.
export class ThreadBusyError extends Error {
  readonly code = 'THREAD_BUSY' as const;
  constructor(
    readonly threadId: string,
    // The runner's reject code that was mapped.
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super('This conversation is busy; the run did not start.', options);
    this.name = 'ThreadBusyError';
  }
}

// The turn did not produce a result. `message` and `code` are the durable
// RUN_ERROR's when there was one; otherwise `code` is an adapter code:
//   ABORT_SETTLE_TIMEOUT      an abort was requested and the run was not seen to
//                             settle within the grace. This is a failure to
//                             observe settlement, not evidence that execution or
//                             side effects stopped; the thread stays reserved.
//   UNEXPECTED_TERMINAL_STATE the stream ended with neither RUN_FINISHED nor RUN_ERROR.
//   RUN_STREAM_FAILED         the runner's event stream itself errored.
export class HeadlessTurnError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'HeadlessTurnError';
  }
}

export interface LocalTurnDeps {
  runner: Pick<DurableAgentRunner, 'run' | 'stop'>;
  // The Dot that owns the thread; throws when there is none.
  dotIdOf(threadId: string): string;
  // A new agent for every call. The adapter never keeps or reuses one.
  agentFor(dotId: string): AbstractAgent;
  newId?: () => string;
  // How long to wait for the runner to finish a run after an abort.
  abortGraceMs?: number;
}

const FAILED_RUN = 'The local run failed.';

export async function runLocalTurn(
  deps: LocalTurnDeps,
  threadId: string,
  prompt: string,
  signal: AbortSignal,
  metadata?: Record<string, unknown>,
): Promise<string> {
  signal.throwIfAborted();
  const grace = deps.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
  if (!Number.isFinite(grace) || grace < 0)
    throw new RangeError(
      'abortGraceMs must be a finite number of milliseconds.',
    );
  const dotId = deps.dotIdOf(threadId);
  const agent = deps.agentFor(dotId);
  const runId = (deps.newId ?? randomUUID)();
  const message = {
    id: `${metadata?.opendotsSource === 'voice_receipt' ? voiceReceiptMessagePrefix : ''}${randomUUID()}`,
    role: 'user',
    content: prompt,
    ...(metadata ? { metadata } : {}),
  } as Message;
  // Prompt only: the agent's messages are replaced, never extended, so nothing a
  // caller left on the instance reaches the model or the log.
  const input: RunAgentInput = {
    threadId,
    runId,
    state: {},
    messages: [message],
    tools: [],
    context: [],
    forwardedProps: {},
  };
  agent.agentId = dotId;
  agent.setMessages(input.messages);
  agent.setState(input.state);
  agent.threadId = threadId;
  const before = new Set(agent.messages.map((m) => m.id));

  let events;
  try {
    events = deps.runner.run({ threadId, agent, input });
  } catch (error) {
    if (
      error instanceof RunRejectedError &&
      error.code === 'THREAD_ALREADY_RUNNING'
    )
      throw new ThreadBusyError(threadId, error.code, { cause: error });
    throw error;
  }

  let runError: { message: string; code?: string } | undefined;
  let finished = false;
  let subscription: Subscription | undefined;
  const settled = new Promise<void>((resolve, reject) => {
    subscription = events.subscribe({
      next: (event: BaseEvent) => {
        if (event.type === 'RUN_FINISHED') finished = true;
        if (event.type === 'RUN_ERROR') {
          const { message: text, code } = event as unknown as Record<
            string,
            unknown
          >;
          runError = {
            message: typeof text === 'string' && text ? text : FAILED_RUN,
            ...(typeof code === 'string' ? { code } : {}),
          };
        }
      },
      error: reject,
      complete: resolve,
    });
  });
  // Observed through the race below; never an unhandled rejection after it.
  settled.catch(() => undefined);

  // An abort asks the runner to stop this run (by its id, so a different run on
  // the thread is never touched) and arms the grace. Requesting is not settling:
  // the caller is held until the runner has finished the run or the grace ends.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => undefined as void;
  const graceExpired = new Promise<'expired'>((resolve) => {
    onAbort = () => {
      timer = setTimeout(() => resolve('expired'), grace);
      try {
        Promise.resolve(deps.runner.stop({ threadId, runId })).catch(
          () => undefined,
        );
      } catch {
        // A stop that cannot be requested leaves the run unsettled; the grace
        // below then reports it.
      }
    };
  });
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });

  try {
    let streamFailed = false;
    let streamFailure: unknown;
    const outcome = await Promise.race([
      settled.then(
        () => 'settled' as const,
        (error: unknown) => {
          streamFailed = true;
          streamFailure = error;
          return 'settled' as const;
        },
      ),
      graceExpired,
    ]);
    if (outcome === 'expired')
      throw new HeadlessTurnError(
        'The aborted turn was not seen to settle in time; the conversation may still be busy.',
        'ABORT_SETTLE_TIMEOUT',
        { cause: signal.reason },
      );
    // The caller asked to stop: that is the outcome, whatever the run ended with.
    signal.throwIfAborted();
    if (streamFailed)
      throw new HeadlessTurnError(
        'The local run stream failed.',
        'RUN_STREAM_FAILED',
        { cause: streamFailure },
      );
    if (!runError && !finished)
      throw new HeadlessTurnError(
        'The local run ended without a terminal event.',
        'UNEXPECTED_TERMINAL_STATE',
      );
    const fresh = agent.messages.filter((m) => !before.has(m.id));
    return currentTurnText(
      fresh,
      runError
        ? new HeadlessTurnError(runError.message, runError.code)
        : undefined,
    );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    subscription?.unsubscribe();
  }
}
