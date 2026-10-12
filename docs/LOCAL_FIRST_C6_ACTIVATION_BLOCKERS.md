# Local-first: open blockers before C6 / live activation

Recorded 2026-10-09 while correcting C4b stop outcome. These are NOT part of C4b
and were NOT fixed opportunistically. C6 stays on HOLD, independently of DEC-3
(Store/scheduler). Each item carries its evidence and what must be shown before
activation.

## STATE-REPLAY: an unappliable STATE_DELTA poisons reconnect

Observed (evidence: `c4b-stop-outcome-evidence/persisted-not-applied.json`, key
`invalid STATE_DELTA`; reproduced with the production `DurableAgentRunner`,
scripted producer):

- A `STATE_DELTA` whose JSON patch cannot be applied (here `replace` at a missing
  path) passes `verifyEvents`, is committed by the A1 tap and published, and the run
  **finishes** (`finished`, log invariants clean).
- `connect()` replay of that thread then fails permanently:
  `OPERATION_PATH_UNRESOLVABLE` is thrown from `compactEvents` (also
  `getThreadEvents`). `messagesFor`, `ready()` and new turns still work, so the
  failure is loud and thread-local, not an unsafe execution.
- Not caused by A1 or by stop: the committed pre-A1 runner persisted the same event.
  It belongs to the R26b/C8 area (the TanStack converter can emit `STATE_*`).

Required before C6 activation:

1. Classify when it occurs (which producers can emit an unappliable delta; is a
   malformed patch reachable from the TanStack converter or only from a hostile or
   buggy agent).
2. Define the behaviour: validate and reject at the tap (before commit), repair on
   replay, or fail closed per thread, with a stable error code.
3. Demonstrate reconnect, replay (`connect`, `getThreadEvents`) and the next turn
   for a thread that has such an event.
4. Do not assume the R32/C8 hash checkpoint solves this: a hash covers whatever the
   log holds, including an invalid authoritative event.

## PROVIDER-ERROR-REDACTION: provider error text reaches logs and the durable log

Observed (evidence: `c4b-stop-outcome-evidence/persistence-log-canary.json`, key
`CONTROL (not A1): provider 401 whose body echoes the API key`):

- A provider error whose message echoes a credential (synthetic canary) appears in
  the SDK's `Agent execution failed: ...` log line AND in the `RUN_ERROR` message,
  which the runner persists in the conversation log and publishes to the client.
- Existing behaviour (the finalizer writes the failure message); not introduced by
  the A1 or stop corrections. Real providers usually mask keys, but nothing in the
  runner relies on that.

Required before live local-first activation:

1. Define the error normalization/redaction boundary (where provider error text is
   turned into what is logged, persisted and shown).
2. Keep safe error codes that behaviour depends on (for example subscription
   usage-limit codes captured by `run-error-code`).
3. Never persist provider secrets or credential-shaped text.
4. Test with synthetic credential canaries through the real DotAgent path, for the
   log, the durable `RUN_ERROR`, the published event and the view.

## LOGGING-POLICY (later review, accepted for C4b)

The diagnostic stack on a SQLite persistence failure (`Agent execution failed: ...`
plus a stack with repository and `node_modules` paths) is accepted for the C4b
correction. To review later as a logging policy:

- driver messages (SQLite messages carried no bound parameters, SQL text or the
  database path in the five tested failure classes: read-only, disk full, closed,
  trigger abort, locked);
- stack traces;
- disclosure of local filesystem paths.

This is not a guarantee that every future storage error is free of secrets: only the
five tested classes were measured. The project's own request-time policy logs
`error.name` only (`app.ts`, `model-routes.ts`).

## A1 production-wiring gate (carried from the A1 correction)

Real production-wired DotAgent -> middleware -> synchronous persistence -> server
executor must preserve the A1 ordering invariant; a new async middleware or SDK
behaviour change must fail this gate. See `LOCAL_FIRST_C4B_A1_CORRECTION.md` section 8.

## DEC-3: recurring-task busy policy (Store/scheduler design)

Open, owner decision DEC-3 (MODIFY), `LOCAL_FIRST_PRODUCTION_INTEGRATION_DECISIONS.md`.
One-shot busy: fail loudly, no automatic retry. Recurring busy: no provider, tool or
run side effect, the occurrence is marked busy or skipped, the schedule advances, no
immediate retry. Today a rejected turn reaches `Store.fail` (`store.ts:297`), which
stops a repeating task until the owner presses Run; `claim()` selects only `queued`
tasks and due `completed` tasks (`store.ts:241`) and clears `nextRunAt`; `release()`
returns a task to `queued` and `Runner.tick` re-claims every second (hot loop). Five
sub-questions are listed in DEC-3 (how an occurrence is recorded, how the schedule
advances, one-shot versus recurring, what it requires of voice compute and the voice
receipt, what "run side effect" excludes). C6 stays HOLD until designed and tested.
Not part of C5.

## H2: OWNER_TOKEN transport compatibility

Open, must resolve before shipping, does not block C4/C5. `requireOwnerToken` checks
presence and length (24) only; Node `fetch` strips trailing whitespace from header
values, so a token that ends in (or is) whitespace can pass startup and not be
presentable. Note for C5/C6: `Platform.turn` today sends the owner token to its own
runtime (`platform.ts:188`); the local adapter has no HTTP hop and so no such header.

## D3: stale RUN_ERROR replay in the UI

DEC-10: D3 is v1 shipping scope; the mechanism is undecided (no candidate approved). A
historical `RUN_ERROR` (for example a usage-limit error) replays every time the thread
is opened. The headless adapter (C5) keeps `RUN_ERROR.code` durable and on the thrown
error and changes no UI; the replay behaviour is C6/shipping.

## R17: single local runtime process per database

Open. Exclusion is process-local (`active` map). A second process on the same file is
not recognised, and its `ready()` would recover the first process's live run. The
adapter inherits this; it adds no locking of its own. The unresolved-run refusal
(P-ADM, below) is made by the same process-local `run()` and does not change this: a
second writer process could still pass between that check and its own reservation.
An in-transaction guard would need a change to the frozen `conversation-log.ts`
`startRun` surface and is not part of P-ADM.

## ISRUNNING-ADMISSION: `isRunning()` is not admission authority (new, C6 gate)

Found in the C4b stop review, characterized for C5 (`c5-design-evidence/probes.json`).
After a stop request `isRunning()` returns false, the run may still be settling (an
entered executor runs to completion; `RUN_FINISHED` is committed only afterwards), and
the thread stays reserved: `run()` rejects `THREAD_ALREADY_RUNNING`. The SDK's own
in-memory runner documents the same split (`isRunning` false at stop, `stopRequested`
guard until finalization). No code in `src/` and no SDK request handler calls
`runner.isRunning`; the only planned consumer is the C6 advisory 409 (P-9) and the
DEC-13 conflict response. Required before C6: no admission, conflict-response,
scheduler or UI decision may use `isRunning`; the authority is `run()`'s typed
synchronous rejection (and, for an advisory pre-check, a new read-only busy accessor on
the runner, which is a separate C4b-level correction requiring review). Acceptance
test: stop requested with an executor in flight -> the 409/busy path still reports
busy, provider 0, tool 0, durable writes 0, including a race lost between the advisory
check and admission.

Update (C4c): the read-only busy accessor now exists as `runner.facts.threadState`
(dormant). It is advisory by construction: only an `idle` state means a thread looks
free, and admission still belongs to `run()`. The gate above is unchanged.

## UNRESOLVED-RUN-RESOLUTION: nothing resolves a deferred run (new, C6 gate)

Found in the C4c review (P-ADM). The rules leave three classes running with nothing
written: R22 (a pending client and a pending server call), R24 (open text or an
incomplete call beside a pending call) and R26b (any other unclassified lifecycle, for
example open reasoning or a state event, which the TanStack converter emits). Before
P-ADM the runner admitted a new run on such a thread. It now refuses
(`THREAD_HAS_UNRESOLVED_RUN`) and the run is left exactly as it was. That is the safe
direction, and it means **a thread with such a run stays blocked indefinitely**:
`ready()` re-reports it, `stop()` returns false for it (it is not driven by this
process), `isRunning()` is false. A dormant runner may stay that way. Activating C6
with no resolution policy is not authorized: a thread would be blocked for good, and a
scheduler or a browser retry would meet an error nothing can clear.

A separately reviewed design must, before C6 activation:

1. Distinguish R22, R24 and R26b; they need different handling and the stock finalizer
   is wrong for two of them (it gives a client HITL call an error result, and it does
   not close `REASONING_*`).
2. Protect client/HITL semantics: a client tool call that is waiting for a person is not
   an error and must not be given an error result.
3. Never fabricate a server tool success, and keep an ambiguous effect outcome ambiguous
   (the recorded unknown-outcome marker, never "failed" and never "succeeded").
4. Require the appropriate owner authority for any manual intervention, and audit every
   resolution (who, when, what was appended, why).
5. Show that a thread admits again only after a safe resolution, and that a resolution
   that fails or is repeated leaves the log consistent.

Not authorized in the meantime: closing, rewriting, expiring or auto-resolving such a
run, in the runner, in recovery or in the scheduler.

## THREAD-REFUSAL-OBSERVABLE: a refusal must reach the user as a refusal (new, C6 gate)

Recorded, not approved (`tests/durable-runner-sdk-handler.test.ts`, section D, the
real `CopilotSseRuntime` behind its real fetch handler). When `run()` refuses, the SDK
handler answers **HTTP 200 with `content-type: text/event-stream` and an empty body**,
for `THREAD_ALREADY_RUNNING`, `THREAD_HAS_UNRESOLVED_RUN` and `THREAD_NOT_OWNED` alike.
The browser sees a turn that neither ran nor failed. That is not an acceptable
production experience, and no route is changed by C4c or P-ADM. Before C6 activation
(DEC-13) the HTTP/UI boundary must map a synchronous `RunRejectedError` to an
observable, correctly classified outcome per code (busy, unresolved, not owned), with
a visible user message, and a rejected run must never be shown as a completed turn.
The headless adapter already passes a non-busy rejection through unmapped, so a
scheduled or voice turn fails loudly; that mapping to a scheduler state (for example
`needs_review`) is the DEC-3 design.

## CORRUPT-DURABLE-HISTORY: an unreadable run row is fail-closed but untyped (observation)

Recorded, not changed. A running row with an unreadable event (invalid JSON) makes
`run()` on that thread throw the underlying `SyntaxError` out of the admission-time
recovery (nothing is admitted, nothing is written), and makes `ready()` reject, which
fails boot for the whole database on one bad row. Both are fail-closed, neither is a
typed error. `runner.facts` reports the same row as `unresolved` / `inconsistent` and
throws `INCONSISTENT_DURABLE_STATE` with enumerated reasons, and never reports it as
idle, not dispatched or safe to retry. A typed admission code, a boot policy for a
corrupt row and any repair are a separate decision (no schema or recovery redesign is
done opportunistically).

## SCHEDULER-REQUEUE: scheduler-level retry is outside the runner guarantee (new)

C4b guarantees no automatic provider/tool retry inside the runner and in recovery. The
Store does not share that guarantee: `Runner.stop()` releases a running task to
`queued` ("Server stopping; queued for restart.", `runner.ts:29`) and `claim()`
re-queues an expired lease ("safely retrying", `store.ts:237`). A re-run is a new
prompt-only turn that cannot see the earlier attempt, including an unknown tool
outcome. Required before C6: define how a scheduled turn whose previous attempt left an
unknown or unresolved server tool outcome is re-queued (DEC-3 adjacent), with a test
that a restart mid-turn does not silently re-run a side-effecting task.

## ABORT-SETTLE-BOUND: grace for an aborting headless caller (new, C5 parameter)

An aborting caller (scheduler 90 s limit, voice call end) must not release the thread
before the runner has, and must not wait forever for an executor that never settles.
C5 settles the run (waits for the runner to finalize) for a bounded grace and then
raises a `HeadlessTurnError` (`ABORT_SETTLE_TIMEOUT`) while the thread stays busy; later
turns get an explicit `ThreadBusyError`. The timeout is a failure to observe settlement,
not evidence that execution stopped. The grace is a provisional 10 s C5 default
(injectable), NOT an approved production voice UX policy: C6 must decide the real value
and what the caller (scheduler, voice end) does on `ABORT_SETTLE_TIMEOUT`. Voice `end()` awaits its compute turns and then starts
the receipt turn on the same thread (`voice.ts:208`, `:222`); a busy receipt is recorded
by the existing catch as a failed sync (`voice.ts:229`) and is not resumed by
`resumePending` (it matches only the "pending Intelligence sync" marker): DEC-3 item 4.

## HISTORY-PROJECTION: explicit history drops tool messages (observation)

`Platform.history` keeps only user and assistant messages (`platform.ts:144`), so
tool results, including an unknown outcome, never reach the voice context. Headless
turns are prompt-only (no implicit history). Not a defect of C5; a parity fact C6 must
keep or decide.

## Carried risks (not closed by the C4b approval)

R26b reasoning/state recovery (open); R31/R33 host and reproducibility (open); R35
long-thread performance (open, C8).

## Status

All items open. None blocks C5 (a dormant adapter). C6: HOLD. Completing C5 closes
none of them (owner approval 2026-10-10). C4c and P-ADM (2026-10-12) close none of
them either; they add UNRESOLVED-RUN-RESOLUTION and THREAD-REFUSAL-OBSERVABLE as C6
activation gates and record CORRUPT-DURABLE-HISTORY.
