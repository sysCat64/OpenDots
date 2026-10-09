# C5 landing boundary: dormant local headless adapter

Status: **approved for implementation (owner, 2026-10-10); this document is the
approved boundary.** Section 13 records the approval and the amendments it made to the
review text; where a section above says otherwise (the behaviour after the grace
expires, the error classes), section 13 wins. Authority: the production integration
design (§10, §16 C5, R36-R38, P-8), the decisions record (DEC-3, DEC-13, DEC-14,
DEC-19), the C4 landing boundary, the accepted C4a/C4b code, the pinned SDK
(`@copilotkit/runtime` 1.75.0, `@ag-ui/client` 0.0.59). Evidence:
`c5-design-evidence/` (`summary.json`, `MANIFEST.sha256`). Node 24.14.1, offline.
Verdict: **C5 implementation: GO / APPROVED** (sections 12 and 13), no C4b change
required for it. C6, P2a-9 and P2b-1 remain HOLD.

## 0. C4b closeout (done before this review)

C4b = **PASS**, three commits approved together and pushed non-force:
`7609e41` dormant durable runner, `25db61e` A1 synchronous execution fence,
`8289e5a` conservative unknown outcome on stop. Origin was `20c532d`; pushed
`20c532d..8289e5a`; afterwards local HEAD = remote HEAD = `8289e5a`, ahead 0 / behind
0, `git status --short` = `?? mise.toml`, 0 tags. Closeout snapshot:
`opendots-local-first-snapshots/c4b-final-closeout-20261009T110509Z` (333 files,
MANIFEST 0 mismatches, 328 sources all present with equal hashes, sources unchanged
during the copy, 0 secret-pattern hits, read-only). The earlier HOLD snapshot still
verifies. Accepted: W1 persist-before-publish, A1 persist-before-execute, fail-closed
middleware guard, unknown outcome on ambiguous stop, recovery without automatic
tool/provider retry, real SIGKILL verification, dormant production integration.
**Not closed:** R17 single-process ownership, R26b reasoning/state recovery, R31/R33
host and reproducibility, R35 long-thread performance. C4b remains dormant;
this approval does not authorize C6.

## 1. What C5 is

**A dormant local headless adapter**: `runLocalTurn(...)`, the in-process equivalent of
`runThreadTurn` (`headless.ts`), built on `DurableAgentRunner.run`. It is called by
nothing in production. C5 does not: activate the local runner, switch scheduled jobs
off Intelligence, change scheduler semantics, implement DEC-3, create tables at
startup, touch browser or voice traffic, migrate anything, or begin C6.

## 2. Current production headless path (verified)

| Piece                                                | Where                                                                               | Behaviour                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Platform.turn(threadId, prompt, signal, metadata?)` | `platform.ts:180`                                                                   | `requireReady`, `requireThread`, then `runThreadTurn`                                                                                                                                                                                                                               |
| `runThreadTurn`                                      | `headless.ts:25`                                                                    | `GET /info` must say mode `intelligence` (`:20`), `IntelligenceAgent` over WebSocket, `agent.addMessage(user)` then `runAgent()`; abort -> `agent.abortRun()` (`:61`); result `currentTurnText(newMessages, runError)`; `RUN_ERROR` -> `new Error(event.message)`, **code dropped** |
| Callers                                              | `index.ts:109` (scheduled task), `voice.ts:184` (compute), `voice.ts:222` (receipt) | all three go through `Platform.turn`                                                                                                                                                                                                                                                |
| `Platform.history`                                   | `platform.ts:144`                                                                   | explicit retrieval, user/assistant only, last 12                                                                                                                                                                                                                                    |
| Scheduler                                            | `runner.ts`                                                                         | one task at a time, 90 s abort (`:56`), `store.fail` on any error (`:81`), `store.release` on shutdown (`:29`)                                                                                                                                                                      |

Why a local adapter is needed before activation: the SSE runtime reports `/info` mode
`sse`, so `runThreadTurn` would fail every scheduled task, voice compute and receipt
the moment C6 activates (design D2).

## 3. Exact C5 responsibility

`runLocalTurn(deps, threadId, prompt, signal, metadata?) : Promise<string>`:

1. `signal.throwIfAborted()` before anything is read or written.
2. `dotId = deps.dotIdOf(threadId)` (production: `workspace.requireThread`; "The
   selected Dot is unavailable in the runtime." preserved for a missing Dot).
3. A **fresh** agent from an injected factory `deps.agentFor(dotId)` (production wiring
   later: `new DotAgent(store, workspace, config, dotId)`, exactly what `Platform`'s
   `agents` factory builds), primed like the SDK handler: `agentId = dotId`,
   `setMessages`, `setState`, `threadId`. The adapter never imports `DotAgent`.
4. Input: `{threadId, runId: randomUUID(), state: {}, messages: [oneUserMessage],
tools: [], context: [], forwardedProps: {}}`. The message id is
   `<voice_receipt prefix if metadata.opendotsSource === 'voice_receipt'><uuid>`,
   `metadata` passed through: identical to production.
5. `runner.run({threadId, agent, input})` (the call `handleSseRun` makes). A synchronous
   `RunRejectedError` with `THREAD_ALREADY_RUNNING` becomes a typed `ThreadBusyError`;
   every other rejection is rethrown as it is. **No retry of any kind.**
6. Consume the event stream: remember the last `RUN_ERROR` (`message`, `code`).
7. Abort: `runner.stop({threadId, runId})`, then **settle** (section 5).
8. Result: `currentTurnText(newMessages, runError)` where `newMessages` = the agent's
   messages that were not there before the run; a `RUN_ERROR` throws an error with the
   **same message** and the durable `code` attached (DEC-14).

Not C5: wiring into `Platform`/`index.ts`/`voice.ts`, `history()` and
`createConversation` locally, the 409 conflict response (DEC-13), recurring busy
(DEC-3), the Store.

## 4. Real interface findings (production + pinned SDK)

| Need                   | Production now                                    | SDK / local runner                                                                                                                                                                | C5                                              |
| ---------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| start a headless run   | `runThreadTurn(...)`                              | `runner.run({threadId, agent, input})` -> `Observable<BaseEvent>`, replays from the first event, **completes only after finalization and release of the thread**                  | mandatory                                       |
| events / final result  | `onRunErrorEvent`; `runAgent()` -> `newMessages`  | events from the observable; the agent instance keeps `messages` (public AG-UI client field)                                                                                       | mandatory                                       |
| busy / conflict        | in-process runner throws "Thread already running" | synchronous `RunRejectedError` (`THREAD_ALREADY_RUNNING`, `THREAD_NOT_OWNED`, `STALE_TOOL_HISTORY`, `DUPLICATE_RUN_ID`, `UNSUPPORTED_MIDDLEWARE`), **before** anything is written | mandatory (typed)                               |
| cancel                 | `agent.abortRun()`                                | `runner.stop({threadId, runId})` -> `true` if it took effect                                                                                                                      | mandatory                                       |
| wait for completion    | `await agent.runAgent()`                          | the observable completing                                                                                                                                                         | mandatory                                       |
| error code             | dropped                                           | durable on `RUN_ERROR`; probe: message preserved, `code` kept                                                                                                                     | mandatory (DEC-14)                              |
| authoritative messages | `intelligence.getThreadMessages`                  | `runner.messagesFor(threadId)` (cache or derived)                                                                                                                                 | not needed by `runLocalTurn`; `history()` is C6 |
| thread ownership       | `requireThread` + Dot in `/info`                  | `ownsThread(threadId, agentId)` predicate injected into the runner                                                                                                                | adapter calls `dotIdOf`; the runner re-checks   |
| `runner.isRunning`     | not used                                          | SDK-facing state                                                                                                                                                                  | **never used** (section 5)                      |

SDK facts checked: `handleSseRun` calls exactly `runtime.runner.run({threadId, agent,
input})`; the SDK turns a synchronous rejection into a 200 with an empty stream
(`sse-response.mjs:52`, the factory is awaited inside the stream); no SDK request
handler and no code in `src/` calls `runner.isRunning` (only the runners and a telemetry
pass-through do); `handle-stop` calls `runner.stop`.

## 5. `isRunning()` versus thread admission versus stop-requested

Three different facts, measured on the production DotAgent with the async tool
`read_public_page` held open (`probes.json`, P2-P4):

| State                                 | `isRunning()` | `run()` for the thread                | log status         | What it means                   |
| ------------------------------------- | ------------- | ------------------------------------- | ------------------ | ------------------------------- |
| running                               | true          | rejected `THREAD_ALREADY_RUNNING`     | running            | SDK-facing running, thread busy |
| **stop requested, executor settling** | **false**     | **rejected `THREAD_ALREADY_RUNNING`** | **running**        | thread **still reserved**       |
| finalized                             | false         | admitted                              | stopped / finished | thread free (stream completed)  |

`isRunning() === false` therefore does **not** mean the thread is available. The SDK's
own in-memory runner documents the same split. Seams that could assume otherwise:
none in `src/` or in the SDK handlers today; the one planned consumer is the C6
advisory 409 (P-9) and the DEC-13 conflict response, which must not be built on
`isRunning`. Admission authority is `run()`'s synchronous typed rejection (atomic with
the check). **Findings for the adapter:**

- Busy refusal (P2): `ThreadBusyError` (`code: 'THREAD_BUSY'`), provider requests 0,
  tool entries 0, log `startRun`/`appendEvents` calls and event/run counts unchanged.
- Abort (P3). With a naive "reject on abort" adapter the caller is released while the run
  is still settling: the voice shape (abort compute turns, then immediately the receipt
  turn on the same thread) got `ThreadBusyError`. With the **settle** rule (stop, then
  wait for the runner's stream to complete) the caller is released only after the
  executor settled and `RUN_FINISHED` was committed, and the next turn is admitted.
- A stuck executor makes settle wait forever, so the wait is **bounded**
  (provisional 10 s, injectable); after the grace the adapter raises a
  `HeadlessTurnError` with code `ABORT_SETTLE_TIMEOUT` (section 13) and the thread stays
  busy until the runner finalizes (explicit `ThreadBusyError` for later turns). Scheduler 90 s limit plus grace stays inside the
  180 s lease (`store.ts`).
- **Recommendation:** use the typed rejection and the stream completion the runner
  already provides; add no locking and no `isRunning` pre-check in the adapter.
  **Does the existing runner API suffice for C5? Yes; no C4b correction is required for
  C5.** For C6 a read-only busy accessor (`idle | running | stopping`, from the
  `active` map) is the clean basis for the advisory 409; that is a separate, small
  C4b-level correction to be reviewed on its own, not part of C5.

## 6. Busy policies stay separate

- One-shot headless (and, by analogy, voice compute/receipt, DEC-3 item 4): busy ->
  explicit `ThreadBusyError`, no automatic retry. The adapter implements only this
  refusal; what the caller records is the caller's (unchanged) behaviour.
- Recurring scheduled occurrence: needs Store/scheduler design (record busy/skipped,
  advance the schedule, no immediate retry). **Not implemented in C5.** C6 stays HOLD.

## 7. Tool safety and recovery integration

| Question                        | Result                                                                                                                                                                                                                                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| prompt-only input               | accepted: `findStaleToolHistory` only inspects assistant tool calls in the input; probe P1 ran a headless turn on a thread whose previous run stopped with an unknown outcome: accepted, provider saw `[system, user]` only                                                                     |
| stale browser history           | not applicable; headless never sends history                                                                                                                                                                                                                                                    |
| `clientExecutableToolNames`     | server-owned set injected into the runner (C6: `pageReviewTool.name`); a client call needs the tool declared in `RUN_STARTED.input.tools` **and** in the set; headless sends `tools: []`, `DotAgent` forwards no client tool then, so a headless run **cannot** have a pending client/HITL call |
| unknown outcomes / stopped runs | produced by the runner (`8289e5a`); a headless turn does not see them (prompt-only); the explicit `history()` projection drops tool messages (observation, C6)                                                                                                                                  |
| thread ownership                | runner predicate `ownsThread`; `THREAD_NOT_OWNED` is not retried and not mapped to busy                                                                                                                                                                                                         |
| runId                           | `randomUUID()` per turn; `DUPLICATE_RUN_ID` can only be a bug and is never retried                                                                                                                                                                                                              |
| retry responsibility            | runner: none; adapter: none; **scheduler: yes, outside the guarantee**: `Runner.stop` -> `store.release` -> `queued` and expired-lease re-queue ("safely retrying") re-run a prompt-only turn that cannot see an earlier unknown outcome. New C6 blocker SCHEDULER-REQUEUE                      |

Bypass check for a future adapter: it must only call `runner.run`/`runner.stop` with a
**fresh** agent from the factory. It must not call `agent.run`, `agent.runAgent` or
`agent.use`, must not add middleware (the A1 guard rejects `UNSUPPORTED_MIDDLEWARE`,
fail closed), must not pass history, and must not add a tool executor or a second
recovery implementation. A static test enforces this (section 9).

## 8. Adapter surface (smallest)

```ts
export class ThreadBusyError extends Error {
  code: 'THREAD_BUSY';
  threadId;
  reason;
}
export class HeadlessTurnError extends Error {
  code?: string;
} // message == RUN_ERROR.message;
// code ABORT_SETTLE_TIMEOUT for an unsettled abort
export interface LocalTurnDeps {
  runner: Pick<DurableAgentRunner, 'run' | 'stop'>;
  dotIdOf(threadId: string): string;
  agentFor(dotId: string): AbstractAgent;
  newId?: () => string; // tests
  abortGraceMs?: number; // default 10_000 (provisional), injectable
}
export function runLocalTurn(
  deps,
  threadId,
  prompt,
  signal,
  metadata?,
): Promise<string>;
```

Mandatory: `runLocalTurn`, `ThreadBusyError`, the code on the thrown error. Optional,
not in C5: a `history()` port, `createConversation`, a busy accessor, a
`HeadlessTurnError` subclass hierarchy. Everything is injected, so tests run offline
with `ScriptedAgent` (L1) or the production `DotAgent` over a faked `fetch` (L2).

## 9. Dormancy and acceptance plan

Can C5 stay isolated without editing an active production module? **Yes.** It needs
no change to `headless.ts`, `platform.ts`, `index.ts`, `voice.ts`, `store.ts` or
`runner.ts`. It reads `currentTurnText` from `headless.ts` (import only). That keeps
`headless.ts` reachable from the dormant module; when C6 makes `runThreadTurn`
unreachable the helper must move to a neutral module (C6/C9 task, recorded; the
alternative of copying 9 lines loses the parity-by-identity oracle).

Dormancy proof: add `headless-local.ts` to `DORMANT` in `tests/dormancy.test.ts`
(static: no importer, unreachable from every root and from every source file, no
dynamic import, no table name) and to the module regex in
`tests/dormancy-runtime.test.ts` (a real server never loads it and creates no
conversation table). Browser chat, voice and scheduler: the existing suites stay
unmodified and green (`headless-runtime`, `headless`, `voice`, `runner`, `app`,
`page-routes`, `owner-boundary`, `dot-agent-channel`, D4 oracle).

New tests (`tests/headless-local.test.ts`, offline, no live provider):

1. prompt-only: provider sees `[system, user]`; result string-equal to the production
   `currentTurnText`; `voice_receipt_` id prefix and metadata persisted.
2. tool-using turn on the real DotAgent: page created once, durable, A1 fence intact.
3. busy: second turn while the first is in flight -> `ThreadBusyError`; provider 0,
   tool 0, durable writes 0; no automatic retry (no second `run`).
4. `isRunning` is not admission: stop requested + executor in flight -> `isRunning`
   false, adapter still `ThreadBusyError`; static check that the module never mentions
   `isRunning`.
5. abort: `stop` reaches the runner; partial text durable, `TEXT_MESSAGE_END` once,
   `RUN_FINISHED` once, `RUN_ERROR` 0; caller rejects with the signal reason; **settle**:
   the rejection arrives only after the thread is free; stuck executor -> after the grace
   a `HeadlessTurnError` (`ABORT_SETTLE_TIMEOUT`), later turn refused as busy.
6. pre-aborted signal: nothing read or written.
7. error: `RUN_ERROR` with a code -> same message, code on the error and durable.
8. next turn after a stopped/unknown run: accepted, prompt-only, no replay, no duplicate
   effect (witness), provider/tool recovery counters 0.
9. rejected admission: `THREAD_NOT_OWNED`, `UNSUPPORTED_MIDDLEWARE` (agent with a
   middleware) surface unmapped; provider 0.
10. static no-bypass: the module has no `.runAgent(`, `.use(`, `agent.run(`, no
    `DotAgent`, `platform`, `Store` import.
11. negative controls (mutation, byte-identical restore): map every rejection to busy;
    use `isRunning` as pre-check; reject without settling; retry on busy; drop the code;
    pass history; swallow the abort reason.

## 10. Proposed C5 commit (one commit on top of `8289e5a`)

| File                             | NEW/MOD | Purpose                                                  | Active/dormant | Depends on C4b                                    | Tests                              | SDK semi-public?                                                                                                                           |
| -------------------------------- | ------- | -------------------------------------------------------- | -------------- | ------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/server/headless-local.ts`   | NEW     | `runLocalTurn`, `ThreadBusyError`, `HeadlessTurnError`   | dormant        | `DurableAgentRunner.run/stop`, `RunRejectedError` | `headless-local.test.ts`, dormancy | No. Uses `AgentRunner.run` (public abstract), `AbstractAgent` public fields (`messages`, `setMessages`, `setState`, `threadId`, `agentId`) |
| `tests/headless-local.test.ts`   | NEW     | section 9 matrix at L1/L2                                | test           | yes                                               | itself                             | No                                                                                                                                         |
| `tests/dormancy.test.ts`         | MOD     | add the module to `DORMANT` and the dynamic-import regex | test           | no                                                | itself                             | No                                                                                                                                         |
| `tests/dormancy-runtime.test.ts` | MOD     | add the module to the runtime-trace regex                | test           | no                                                | itself                             | No                                                                                                                                         |

No dependency change, no C4a change, no active module touched. If implementation
reveals a C4b API defect, it is a separate correction requiring review.

## 11. C6 blocker inventory

Tracked in `docs/LOCAL_FIRST_C6_ACTIVATION_BLOCKERS.md`: STATE-REPLAY,
PROVIDER-ERROR-REDACTION, LOGGING-POLICY, DEC-3 recurring busy, H2 OWNER_TOKEN
transport compatibility, D3 stale `RUN_ERROR` replay, R17 process ownership, plus new:
ISRUNNING-ADMISSION, SCHEDULER-REQUEUE, ABORT-SETTLE-BOUND, HISTORY-PROJECTION, and the
carried R26b, R31/R33, R35. **Should the isRunning/busy distinction be a C6 activation
gate? Yes** (ISRUNNING-ADMISSION): no admission or conflict decision may use
`isRunning`, the 409 path must come from runner admission, acceptance covers a stop in
flight and a race lost between advisory check and admission.

## 12. Verdict

**C5 implementation: GO.** Reasons: the boundary fits entirely in one new dormant
module plus test registrations; the existing runner API gives typed synchronous
admission and completion-after-release, so no C4b change is needed; the three open
behaviours were measured (busy refusal, abort settlement, error code). Conditions: (1)
settle-with-bounded-grace is part of the adapter contract (default 10 s, owner may
choose another value); (2) only the one-shot refusal is implemented, recurring busy
stays DEC-3/C6; (3) `currentTurnText` is imported, with its relocation tracked for C6;
(4) the C6 blockers above stay open and C6 stays HOLD.

## 13. Owner approval and amendments (2026-10-10)

C5 is approved for implementation as one dormant module plus tests, in a second local
commit after a documentation checkpoint. Recorded decisions:

1. **Provisional abort-settlement grace: 10,000 ms, injectable** (`abortGraceMs`). It is
   a C5-internal default, **not** an approved production voice UX policy. It is waited
   for only when an abort has been requested and the run has not yet settled; a
   successful request never waits.
2. **`isRunning()` is not admission authority.** Admission is determined by the runner's
   actual thread reservation, observed only through `run()`'s synchronous typed
   rejection (`THREAD_ALREADY_RUNNING` -> `ThreadBusyError`). `THREAD_NOT_OWNED` and
   every other rejection stay distinct and are never mapped to busy.
3. **No automatic retry** after busy, after an abort-settlement timeout, or after any
   error. No queue, delayed retry or scheduler fallback.
4. **Abort settlement timeout** is a failure to _observe_ settlement within the grace,
   not evidence that execution or side effects stopped. The adapter raises
   `HeadlessTurnError` with code `ABORT_SETTLE_TIMEOUT` (this replaces the review text
   that rejected with the abort reason after the grace). It does not report the run as
   settled, does not release the thread, does not start another run on it, and leaves
   no unhandled rejection. A settlement within the grace preserves the runner's real
   stopped/finalized outcome and the caller rejects with the abort reason.
5. **Recurring scheduling is outside C5.** DEC-3 (recurring busy) is not implemented
   and the scheduler is untouched. The adapter implements only the one-shot refusal.
6. **Prompt-only input.** Prompt-only acceptance does not guarantee exactly-once task
   execution across scheduler requeues: the runner does not retry earlier unknown
   tools, but a later model request may independently repeat a similar side effect.
   HISTORY-PROJECTION and SCHEDULER-REQUEUE stay OPEN for C6.
7. **`currentTurnText`** is imported from `headless.ts` (relocation deferred). The import
   must not instantiate the Intelligence runtime, call the network, create tables,
   register global side effects or create an active import path from a production root
   to the adapter; the dormancy tests (D1-D8) check it. A violation stops the work.
8. **No provider-error redaction in C5** (PROVIDER-ERROR-REDACTION is a C6 blocker). A
   durable `RUN_ERROR` keeps its exact message and code.
9. **C6 activation is not authorized.** None of the blockers in
   `LOCAL_FIRST_C6_ACTIVATION_BLOCKERS.md` is closed by C5. The decisions DEC-1 to
   DEC-24 are unchanged (`LOCAL_FIRST_PRODUCTION_INTEGRATION_DECISIONS.md` is not
   modified by this commit).
