# Local-first P2a-6 acceptance: current vs historical RUN_ERROR, and stop

**Status: PASS in a scratch worktree. P2a-7 is GO but not started. Production integration has not been done. The scratch client patch (`src/client/run-origin.ts`, the `Chat.tsx` change), the tests (`tests/p2a/*`) and the evidence (`p2a-evidence/*`) are not in main; only this document and the design update are.**

Review outcome: **P2a-6 PASS accepted; D3 accepted as a UX policy; the scratch `runId` seam is a validated candidate, _not_ production-approved.**

Scope: a scratch UX candidate in `/private/tmp/opendots-p2a1.FV0LOx`. Nothing was changed in main by the experiment itself; nothing was pushed or tagged.

## 1. Baseline and environment

- Scratch worktree detached at `aa2a415`; main HEAD = origin = `5f4d671bbad0c6580493648ae2459671580019ed`, main `git status --short` = `?? mise.toml`, 0 tags.
- Node 24.14.1, npm 11.11.0, `COPILOTKIT_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`, fake provider on 127.0.0.1 only.
- Real client: the built `src/client/Chat.tsx` (vite build) in headless Chromium (`chrome-headless-shell` 1228), `--host-resolver-rules` resolving nothing but 127.0.0.1.
- Real server: the real Hono app, `Platform`, `DotAgent`, workspace routes, `CopilotSseRuntime` and the scratch `SqliteAgentRunner`. Harness-only: `Platform.handler` (Intelligence) and `createConversation` are replaced on the instance in `tests/p2a/p2a6-stack.ts`; no production file is edited for that.
- Every server is a separate process on the same SQLite file (`tests/p2a/p2a6-server.ts`); writer exit, then a reader with another PID, a new runner and the same DB.

## 2. Pre-fix observation (Step 1, production source unchanged)

`p2a-evidence/p2a6/pre-fix-observation.json`, client built from the unmodified `Chat.tsx`:

| thread               | current (writer)          | fresh load (reader, other PID)                                   |
| -------------------- | ------------------------- | ---------------------------------------------------------------- |
| E1 uncoded RUN_ERROR | error shown, Reconnect    | **error shown again** ("400 Synthetic model failure", Reconnect) |
| E2 coded RUN_ERROR   | usage-limit notice + link | **usage-limit notice + link shown again**                        |
| S1 real stop         | partial text, no error    | partial text once, no error                                      |

The stale banner **reproduces** (RED). The reader made 0 provider requests and the DB hash was unchanged, so the banner comes only from the replayed history. RED run of the new test file against that client: `p2a-evidence/p2a6/red/red-run-baseline-client.log`: B1, C1, C2, D1 and D2 fail with "expected 1 to be 0", i.e. the P2a-3 and P2a-4 recovered histories show it too.

## 3. Replay/current seam

Two paths set the Chat banner:

1. `agent.subscribe({ onRunErrorEvent })` in `Chat.tsx`.
2. `copilotkit.subscribe({ onError })`: CopilotKit core's agent error subscriber forwards **every** RUN_ERROR event (context `{ source: 'onRunErrorEvent', event, runtimeErrorCode }`).

Structural evidence available in both paths' neighbourhood (read from installed `@ag-ui/client` 0.0.59 / `@copilotkit/core`):

- every subscriber callback gets `input: RunAgentInput` of the **invocation**; `connectAgent` and `runAgent` each generate their own `input.runId` (`prepareRunAgentInput`);
- a replayed RUN_STARTED carries the **old** run's `runId`; the live RUN_STARTED of the run this client started carries the client's own `runId` (the runner pre-persists RUN_STARTED with the request's runId);
- `onEvent` is called for every event, for all subscribers, **before** any typed handler (including core's), and the same event object reaches `onRunErrorEvent` and core's `onError` context.

Rejected: timers, message text, "the run already ended" (RUN_ERROR sees `isRunning` false in the live case too).

## 4. Scratch remediation candidate (validated scratch seam, NOT a production-approved discriminator)

- New `src/client/run-origin.ts` (pure): per invocation it remembers the latest `RUN_STARTED.runId`; a RUN_ERROR is **historical** iff that runId differs from `input.runId`. With no RUN_STARTED seen the error is treated as current (a real failure is never hidden).
- `src/client/Chat.tsx` (+18/−4): an `onEvent` subscriber classifies each event; `onRunErrorEvent` and the `onError` forward (only when `context.source === 'onRunErrorEvent'`) skip the banner for a historical event; `onRunFinalized` releases the per-invocation entry.
- `chat-error.ts` is **unchanged**; P1 semantics (code preserved, no-response fallback does not overwrite, no text inference) are untouched. A new file was needed because the classifier is pure and separately testable; the rest stays in `Chat.tsx`.
- Diff: `p2a-evidence/p2a6/scratch-client-candidate.diff`, `run-origin.ts.txt`. Prettier clean, `git diff --check` clean.

## 5. Uncoded matrix (E1) — PASS 1, 3, 5, 6

Current failure: banner "400 Synthetic model failure" + Reconnect. Fresh load: no banner. History: RUN_ERROR exactly once, byte-equal. A new current failure on the reloaded thread: banner appears again. Second reload: no banner; history = 2 RUN_ERRORs, the first unchanged. (`current-vs-replay.json`, `historical-error-uncoded.json`)

## 6. Coded usage-limit matrix (E2) — PASS 2, 4, 5, 6

Current: dedicated notice + "Open ChatGPT usage" link, no Reconnect; history code `subscription_sharing_usage_limit_exceeded` verbatim. Fresh load: no notice, no link. New current failure: notice + link again, code verbatim in the second RUN_ERROR. Second reload: none. No usage URL, reset time or quota is invented. (`historical-error-coded.json`)

## 7. P2a-3 / P2a-4 / P2a-5 histories — PASS 7, 14

Real SIGKILL writers (existing P2a-3 T1 and P2a-4 gate B scenarios), recovery by the reader's `ready()`, then a fresh UI load (twice):

- P2a-3 open text: `…TEXT_MESSAGE_END, RUN_ERROR(INCOMPLETE_STREAM)`; no banner; partial text shown; DB hash unchanged by the UI.
- P2a-4 unknown outcome: `TOOL_CALL_RESULT` + `RUN_ERROR(INCOMPLETE_STREAM)`; no banner; hash unchanged.
- P2a-5 pending run (`RUN_FINISHED`, no RUN_ERROR): no banner (regression).
  (`recovered-error-replay.json`, `pending-run-no-banner.json`)

## 8. Stop lifecycle — PASS 8, 9, 10

Real client Stop button, slow fake model (`stop-before-restart.json`): partial text `chunk-01 chunk-02` kept, Send button back, `isRunning` false, provider saw the abort; durable log `RUN_STARTED, TEXT_MESSAGE_START, CONTENT×2, TEXT_MESSAGE_END, RUN_FINISHED`: END 1, FINISHED 1, **RUN_ERROR 0**. The HTTP stop response body is `{"stopped":true,"interrupt":{"type":"RUN_ERROR","message":"Run stopped by user","code":"STOPPED"}}` — recorded separately; it is not in the stream or the log, and the client does not show it. After writer exit (code 0, process gone) and a fresh reader (other PID): same log, partial text exactly once, no banner, 0 provider requests, 0 runner runs, DB hash unchanged (`stop-after-restart.json`). No new SIGKILL-during-stop class was introduced.

## 9. Source of the stop closers — PASS 11 (settles R13)

Runner instrumentation (`onFinalize`, test-only, pre-finalize event list plus finalizer output): the agent (BuiltInAgent/DotAgent) emitted `RUN_STARTED, TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT×2` and **neither** TEXT_MESSAGE_END nor RUN_FINISHED nor RUN_ERROR. `finalizeRunEvents` with `stopRequested: true` appended exactly `TEXT_MESSAGE_END, RUN_FINISHED`. So both closers come from the runner's stock finalizer, once each (no double closure). A runner that does not call the finalizer on stop would leave the message open.

## 10. Reader idempotence and fidelity — PASS 5, 12

Fresh reader on E1/E2/S1: connect replay, `getThreadEvents`, `getThreadMessages`, `getThreadState`, `listThreads`, `isRunning` (false), HTTP `/threads`, `/messages`, `/events`, `/state` all 200; RUN_ERROR in replay/events equals the durable one (message and code); DB hash and row counts unchanged; 0 provider requests; nothing deleted or rewritten to suppress the UI.

## 11. Negative controls — all red, source restored byte-identically (`negative-controls/`)

| #   | mutation                                     | failing tests      |
| --- | -------------------------------------------- | ------------------ |
| N1  | historical RUN_ERROR also reaches the banner | B1, C1, C2, D1, D2 |
| N2  | current RUN_ERROR suppressed too             | A1, A4, C1, C2     |
| N3  | historical RUN_ERROR removed from the replay | B2                 |
| N4  | `RUN_ERROR.code` dropped when persisted      | A4, B1, C2, D1, D2 |
| N5  | stop's RUN_FINISHED turned into RUN_ERROR    | A2, B2             |
| N6  | stop closers doubled                         | A2                 |

## 12. Regression

- `tests/p2a/p2a6.test.ts`: 13/13 on the final client; after the first comparator fix it passed in every later execution except one (open concern 4 in section 15).
- Whole scratch suite plus the P1 `tests/chat-error.test.tsx`, as executed:

```text
With the intentional scratch Chat.tsx patch:
151 tests passed, 5 baseline-invariance guards failed.

Those five tests assert that production client source is unchanged
from earlier P2a phases; the P2a-6 scratch experiment intentionally
violates that premise.

With the scratch client patch temporarily reverted:
those five guards passed.

The patch was then restored and its hash verified.
```

This is **not** an "all green" result. The five guards are the "production source is untouched" / "`aa2a415..X` is documentation-only" checks of P2a-1 to P2a-5; they must be re-pointed if the candidate is ever adopted.

- The actual-`SIGKILL` scenarios of P2a-3/4/5 ran in that suite and passed. Golden fixtures: 17 files, hash-identical to the pre-run list. The scratch runner gained only an optional test hook (`onFinalize`, no behaviour change).

## 13. Egress — PASS 16

All server processes: egress guard `fetches`/`connects` empty. Browser: 258 requests, host set `{127.0.0.1}`, 0 non-loopback. No OpenAI, SIWC, CopilotKit cloud, Slack, Voice, Keychain, `.env` or external web.

## 14. Browser scope

```text
headless Chromium + real Chat.tsx DOM path verified
desktop headed-browser rendering not verified
```

The DOM was observed (`.chat-error`, usage link, Reconnect). No screenshots or visual layout were assessed.

## 15. Open questions

1. **Live-join of another tab/client into an already-live run.** Under the candidate, a RUN_ERROR of a run this client did not start (its runId ≠ the connect's `input.runId`) is classified historical, so tab B joining tab A's live run would not show A's later failure in B. Not exercised here.
2. The candidate relies on `context.source`/`context.event` of CopilotKit core's `onError` and on `onEvent` running before typed handlers — a contract test is needed before production, and re-checking on CopilotKit upgrades.
3. CopilotKit core still `console.error`s every replayed RUN_ERROR (16 lines in this run); that is logging, not the Chat banner.
4. **Open test-stability concern: one unexplained non-reproducible test failure** (C1, with C2 following) was observed once, on the second execution of `p2a6.test.ts`, right after the test comparator was fixed; the failure message was not captured. Six subsequent runs passed. The cause is unknown and the concern is **not closed**.
5. R26 (complete_text_without_terminal), mixed lifecycle, multi-process writer, P2a-7 performance are untouched.

## 16. Decision D3 (accepted as a UX policy)

Historical RUN_ERROR remains authoritative conversation history. A replayed historical RUN_ERROR must not set or resurrect the ephemeral current top-level Chat error state. A new current/live RUN_ERROR still sets that state normally. This is not a persistence change: it separates durable history from ephemeral UI state.

## 17. PASS criteria

1 ✓ · 2 ✓ · 3 ✓ · 4 ✓ · 5 ✓ · 6 ✓ · 7 ✓ · 8 ✓ · 9 ✓ · 10 ✓ · 11 ✓ · 12 ✓ · 13 ✓ (P1 `chat-error` tests green, `chat-error.ts` unchanged) · 14 ✓ (with the 5 invariant tests noted in §12) · 15 ✓ · 16 ✓ · 17 ✓ (main `?? mise.toml`).

**Result: PASS (scratch). P2a-7: GO, not started** — with open questions 1, 2 and 4 carried forward. D3 accepted as a UX policy; the seam is a validated scratch candidate only.
