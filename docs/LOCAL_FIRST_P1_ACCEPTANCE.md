# Local-first P1 acceptance: offline SSE runtime (P1-R, Node 24 rerun)

**Status:** executed. Lives only in the temporary worktree. Not copied to the main worktree, not committed, not pushed.
**Base commit:** `dd7492a2a413ac8432ca0e6806c533e18752e6c7`.
**Scope:** P1 only (including the P1-8 remediation). P2a, P2b, P3, P4, P5, P6, P7 and P8 were not started.
**Supersedes:** the first P1 run in `/tmp/opendots-p1.UNocjR` (kept unchanged as evidence; overall result there: FAIL).

## Overall verdict

```text
P1 overall: PASS
```

All of P1-1 to P1-8 pass on Node 24.14.1 in a fresh worktree, including the P1-8 dedicated usage-limit UX, with the focused regression written first and shown failing on the unmodified client.

| Case                                   | Result                                        |
| -------------------------------------- | --------------------------------------------- |
| P1-1 Runtime mode                      | **PASS**                                      |
| P1-2 Streaming text                    | **PASS**                                      |
| P1-3 Server tool call                  | **PASS**                                      |
| P1-4 HITL / human review               | **PASS**                                      |
| P1-5 Stop / abort                      | **PASS**                                      |
| P1-6 Disconnect, then reconnect        | **PASS**                                      |
| P1-7 Thread behavior                   | **PASS**                                      |
| P1-8 `RUN_ERROR.code` and dedicated UX | **PASS** (after the remediation in section 4) |

Final run: `3 test files, 22 tests passed` (`npx vitest run tests/p1 --no-file-parallelism`). Four existing client suites that touch the changed files (`chat-error`, `page-review`, `transcript`, `controls`) also pass: 27 tests.

## 1. Environment

| Item         | Value                                                                                                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worktree     | `/tmp/opendots-p1r.aOSsXy` (detached at `dd7492a`)                                                                                                                                |
| Node         | **v24.14.1** (the repo's `engines` is `>=24`)                                                                                                                                     |
| npm          | **11.11.0**                                                                                                                                                                       |
| OS           | macOS 12.7.6 (Darwin 21.6.0)                                                                                                                                                      |
| CopilotKit   | `@copilotkit/runtime`, `core`, `react-core` 1.75.0                                                                                                                                |
| AG-UI        | `@ag-ui/client`, `@ag-ui/core` 0.0.59                                                                                                                                             |
| TanStack AI  | `@tanstack/ai` 0.63.0, `@tanstack/ai-openai` 0.25.1                                                                                                                               |
| Test tooling | vitest 4.1.11, `playwright` 1.63.0 (library only)                                                                                                                                 |
| Browser      | Chrome Headless Shell 149.0.7827.55 (`chromium_headless_shell-1228`) through `executablePath` (Playwright 1.63 expects build 1243, which is not installed and was not downloaded) |
| Required env | `COPILOTKIT_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`, set before anything started; each test file asserts both                                                                     |

Node 24 was selected by putting the installed `24.14.1` binary first on `PATH`. No install, no download, no `package.json` or `package-lock.json` change. `node_modules` is an APFS clone of the main worktree's.

**Note on the earlier run (environment note, not part of this run):** the first P1 run used Node 22.23.1, and during it I made two stray TCP connect attempts to `1.1.1.1:443` while testing whether a `sandbox-exec` profile could enforce a network deny. They were bare TCP handshakes with no TLS and no data, unrelated to any OpenDots code path, and both connected (the profile did not block them). That approach was dropped. **No such probe was made in this run.**

## 2. Network and egress observation

No claim is made that the OS or the machine was network-isolated. The evidence is instrumentation of the P1 code paths only:

- **Server process:** `globalThis.fetch` is wrapped to refuse and log any non-loopback URL; `net.Socket.prototype.connect` is wrapped to refuse and log any non-loopback host.
- **Browser:** Chromium launched with `--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"`, a request inventory over every request, and a WebSocket inventory.
- **CSP:** production's policy with `connect-src 'self'`.

Observed in the final run:

| Source                                  | Observed                           |
| --------------------------------------- | ---------------------------------- |
| Server outbound `fetch` to non-loopback | **0**                              |
| Server outbound socket to non-loopback  | **0**                              |
| Browser requests                        | **229, all with host `127.0.0.1`** |
| Browser WebSockets                      | **0**                              |

Model traffic went to a fake OpenAI-compatible server on `127.0.0.1` (and, for P1-8, the real `chatgptPlanProvider` with a fixture `auth` object against the same local host). No OpenAI, SIWC, CopilotKit cloud, Slack, voice or external-research request, no Keychain read, no `.env`, no credential search.

Scope of the claim: these counters cover `fetch` and `net.Socket.connect` in the server process and everything the browser requested. They are not a complete egress audit (that is P5).

## 3. Temporary architecture

Unchanged from the first run:

```text
Chromium (real built client)
   │  local HTTP, same-origin, 127.0.0.1
   ▼
Hono app (real createApp + workspaceRoutes + Platform.handle + validateRuntimeScope)
   ▼
CopilotSseRuntime   ── no CopilotKitIntelligence is created
   ▼
InMemoryAgentRunner (stop and DotAgent.abortRun wrapped only to record call order)
   ▼
DotAgent → BuiltInAgent(tanstack) → TanStack chat() → fake model on 127.0.0.1
```

Temporary source changes:

| File                                                           | Change                                                                           | Kind                            |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------- |
| `src/server/platform.ts`, `platform-config.ts`, `dot-agent.ts` | SSE-mode harness patch (`p1-evidence/server-temp-patch.diff`)                    | temporary, not a proposal       |
| `src/client/chat-error.ts`                                     | + `NO_RESPONSE_MESSAGE`, + `noResponseError()`                                   | **P1-8 production remediation** |
| `src/client/Chat.tsx`                                          | the "no response" fallback now goes through `noResponseError` instead of `throw` | **P1-8 production remediation** |

Test files (temporary): `tests/p1/{fake-model,harness,sse,evidence}.ts`, `tests/p1/p1-protocol.test.ts` (9 tests), `tests/p1/p1-browser.test.ts` (9 tests), `tests/p1/p1r-chat-error.test.ts` (4 tests). Evidence: `p1-evidence/*`.

## 4. Original P1 FAIL and remediation

### 4.1 Cause of the original FAIL

`RUN_ERROR.code` was never lost. In the first run it was observed on the wire, on the CopilotKit client, and at `agent.subscribe({onRunErrorEvent})`. The failure was in `Chat.tsx`.

### 4.2 The error call flow (read again before changing anything)

Over SSE a `RUN_ERROR` does **not** reject `copilotkit.runAgent()`. Sequence for one failing turn (`src/client/Chat.tsx` before the fix):

1. `send()` calls `setError(null)` (line ~146): the error state is cleared when a turn starts.
2. Server stream: `RUN_STARTED`, then `RUN_ERROR {message, code}`.
3. **Receives the code:** `agent.subscribe({onRunErrorEvent})` (line ~111) → `setError(current => nextError(current, fromRunError(event)))` → state is `{message, code}`.
4. `copilotkit.subscribe({onError})` (line ~106) also fires with the same message and **no code** → `nextError(current, fromMessage(message))`. This is the case `echoes()` exists for (see 4.3): a later uncoded error that merely repeats the coded one does not replace it.
5. `runAgent()` **resolves** with `newMessages: []`.
6. **Generates the generic fallback:** `Chat.send` checks "no assistant message" and executes `throw new Error('The current turn returned no response…')`.
7. The `catch` (line ~164) → `setError(current => nextError(current, fromMessage(e.message)))`.
8. `nextError` returns the incoming error because `echoes(current, incoming)` is false (the synthetic text does not contain the original message). **The coded error is replaced**, and the owner sees the generic message with a Reconnect button.

### 4.3 What `echoes()` does (and does not)

`echoes(current, incoming)` is true when the incoming message equals, or contains, the current one. It exists so that the **same** failure reported a second time without its code (step 4, or a wrapped thrown error) does not erase the code. It is deliberately one-directional. It cannot cover step 8: the synthetic message is a different sentence, so it is treated as "another error" and wins. The helper was written for a flow where the thrown error echoes the original message; over SSE that flow never occurs.

### 4.4 Contract and design

Contract: **a real `RUN_ERROR` already received for the current run takes precedence over the synthetic "no response" fallback.**

Chosen fix: make the synthetic fallback a pure function that only fills a gap.

```ts
// chat-error.ts
export const NO_RESPONSE_MESSAGE =
  'The current turn returned no response. Check the runtime connection and retry.';
export const noResponseError = (current: ChatError | null): ChatError =>
  current ?? fromMessage(NO_RESPONSE_MESSAGE);

// Chat.tsx, send()
if (!result.newMessages.some((message) => message.role === 'assistant')) {
  setError(noResponseError); // functional update: sees the error this run already reported
  return; // same as the old throw: onSaved() is not called; finally still runs
}
```

Why this and not the diagnostic P1-8b patch (a `useRef` flag, `runFailed`, set in `onRunErrorEvent` and checked before the throw):

|                                                                                                 | Ref flag (P1-8b)            | `noResponseError` (chosen)                                  |
| ----------------------------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------- |
| Needs new mutable state                                                                         | yes (a ref, reset per send) | no                                                          |
| Reads state in an async closure                                                                 | via a ref                   | via the functional `setError` update, which cannot be stale |
| Decision testable without a DOM                                                                 | no                          | yes, pure function, unit-tested                             |
| Covers a real error that arrived through `copilotkit.onError` but not through `onRunErrorEvent` | no                          | yes                                                         |
| Preserves the real message of an _uncoded_ `RUN_ERROR`                                          | yes                         | yes                                                         |

Why "`current` non-null" is a sound proxy for "an error was already reported for this run": `send()` clears the state at the start of the turn (step 1), and the only writers during a turn are the two subscriptions and the catch. So a non-null state at step 6 was put there by this run. The semantics are intentionally slightly broader than "RUN_ERROR only": any real error that already surfaced for the run is the cause, and the synthetic sentence should never override it.

Not used, as required: no message-string parsing, no regex, no dependence on provider wording, no API-key fallback, no provider or model change, no reconnect retry. `nextError` and `echoes()` are untouched.

### 4.5 Regression tests written first

Written before the production change and run on the **unmodified** client under Node 24 (`p1-evidence/red-run-unmodified-client.txt`):

| Test                                                                            | Unmodified client                                          |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `p1r-chat-error` (4 unit tests)                                                 | 4 failed (`noResponseError` did not exist)                 |
| P1-8 browser: coded RUN_ERROR → dedicated UX                                    | **failed**: shows "The current turn returned no response…" |
| P1-R browser: empty completion, no RUN_ERROR → generic no-response              | passed (baseline preserved)                                |
| P1-R browser: uncoded RUN_ERROR (`400 Synthetic model failure`) shown as itself | **failed**: replaced by "no response"                      |

The third row is a finding in its own right: before the fix **every** `RUN_ERROR` over SSE, coded or not, was replaced by the synthetic sentence, so a real provider failure message never reached the owner.

Focused regression, after the fix (all pass):

- SSE sequence `RUN_ERROR(code=subscription_sharing_usage_limit_exceeded)` → `copilotkit onError` duplicate → run resolves with no assistant message → fallback reached → surfaced error is exactly `{message, code}` and `chatErrorView(...)` is `usage_limit`.
- Message parsing is not involved: an arbitrary message with the code selects the usage-limit view; the exact usage-limit notice text **without** the code stays `generic`.
- An uncoded `RUN_ERROR` keeps its own message.
- No `RUN_ERROR` at all: the result is still exactly the generic `{message: NO_RESPONSE_MESSAGE}` with a reconnect option.
- Browser, real client: coded error → usage-limit notice with "Open ChatGPT usage ↗" and no Reconnect button; empty completion → generic no-response with Reconnect; uncoded provider failure → `400 Synthetic model failure`.

## 5. Results (all on Node 24.14.1)

### P1-1 Runtime mode: PASS

`GET /api/copilotkit/info` through `Platform.handle` → `CopilotSseRuntime`:

```json
{
  "version": "1.75.0",
  "agents": {
    "<dotId>": { "name": "<dotId>", "description": "", "className": "DotAgent" }
  },
  "audioFileTranscriptionEnabled": false,
  "mode": "sse",
  "threadEndpoints": {
    "list": true,
    "inspect": true,
    "mutations": false,
    "realtimeMetadata": false
  },
  "suggestions": true,
  "a2uiEnabled": false,
  "openGenerativeUIEnabled": false,
  "telemetryDisabled": true
}
```

No `intelligence`, `wsUrl`, `joinToken`, `licenseStatus` or `runtimeEntitlements`. `platform.intelligence` is `undefined`; `/api/workspace` reports `setup.missing = []`.

### P1-2 Streaming text: PASS

Wire: `RUN_STARTED, TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT ×6 (≈150 ms apart), TEXT_MESSAGE_END, RUN_FINISHED`; one start, one finish, no error. Browser: six distinct, strictly growing transcript states ending in `Hello streaming from the fake model.`; stored events start with `RUN_STARTED` and end with `RUN_FINISHED`.

### P1-3 Server tool call: PASS

`list_authorized_spaces`: `TOOL_CALL_START/ARGS/END/RESULT`, then the final text echoing `Everyday`; two model calls (last role `user`, then `tool`). Observation kept from the first run: the post-tool text is attached to the **same assistant message** as the tool call, so the snapshot is `[user, assistant{content, toolCalls}, tool]`.

### P1-4 HITL / human review: PASS

The existing `review_space_page` registration and `PageReviewCard`, unmodified: the card rendered, the run parked (`RUN_FINISHED`, pending tool call, one model call), **Approve & save** created the page in SQLite, the client resumed on its own, and the final answer arrived (second model call with last role `tool`).

### P1-5 Stop / abort: PASS

Real **Stop response** button and a wire variant. Timeline `runner.stop` → `DotAgent.abortRun` → `runner.stop -> true`; the fake model saw its connection closed; the stream ended cleanly (`RUN_FINISHED`); partial text kept; `isRunning` false; the same thread accepted a new turn.

### P1-6 Disconnect, then reconnect: PASS

Not a restart test. Dropping the client mid-run left the run running and the model request unaborted. `connect` after completion replayed the full 274-character text once; `connect` mid-run replayed the past and joined the live remainder, full text once. In the browser, closing the tab mid-run and opening a fresh page rebuilt the conversation with **one** user bubble and **one** assistant bubble, and a later reload still showed one copy.

### P1-7 Thread behavior: PASS (matches prediction)

`GET /threads?agentId=…&limit=20` → 200 (8 calls), local titles in the sidebar, runner `name: null` so the UI falls back to the local title, no sidebar error, `PATCH`/`DELETE`/`archive`/`subscribe` → 422, `clear` → 403 from OpenDots' own scope check, foreign thread → 403, a locally bound but never-run thread absent from the runner list, **0 WebSockets**, `threads/subscribe` never called.

### P1-8 `RUN_ERROR.code` and dedicated UX: PASS

Setup: the real `chatgptPlanProvider` (fixture auth, no Keychain) against a fake `/v1/responses` returning the existing `responsesStreamError(subscription_sharing_usage_limit_exceeded, …)` fixture.

Event and error flow (final, after the fix):

```text
wire (SSE)            RUN_STARTED → RUN_ERROR {message, code:"subscription_sharing_usage_limit_exceeded"}
client                onRunErrorEvent receives {message, code}   (CopilotKit also logs runtimeErrorCode)
Chat state            nextError(null, fromRunError(event)) = {message, code}
                      nextError(that, fromMessage(message))      = unchanged (echoes)
runAgent()            resolves, newMessages = []
fallback              setError(noResponseError) → current is already set → unchanged
UI                    chatErrorView → usage_limit: dedicated notice + "Open ChatGPT usage ↗", no Reconnect
```

Observed notice: `You have reached the usage limit of your ChatGPT plan for apps. Try again after it resets. You can check your usage in ChatGPT Settings.` with one usage link and no Reconnect button; the server's own message text is not shown. No message parsing is involved anywhere.

Hand-off note for Phase 6: in the **local-first SSE path**, `RUN_ERROR.code` is preserved from the model adapter through DotAgent, the runtime and the SSE wire to the client and now to the UX (**observed**). The Phase 6 item "Intelligence transport preserves `RUN_ERROR.code`" is therefore **not a blocker for the local-first path**. This says nothing about Intelligence mode itself: that behavior remains **untested**, and the Phase 6 global pending item is **not** thereby proven.

## 6. Evidence

| Artifact                                                | Content                                                           |
| ------------------------------------------------------- | ----------------------------------------------------------------- |
| `tests/p1/p1-protocol.test.ts`                          | 9 wire-level tests (P1-1…P1-8)                                    |
| `tests/p1/p1-browser.test.ts`                           | 9 real-client tests (P1-2…P1-8, plus two P1-R contract tests)     |
| `tests/p1/p1r-chat-error.test.ts`                       | 4 focused regression tests (pure logic)                           |
| `p1-evidence/protocol.json`, `browser.json`             | raw events, `/info`, stop/replay/thread payloads, egress counters |
| `p1-evidence/red-run-unmodified-client.txt`             | the failing run on the unmodified client                          |
| `p1-evidence/client-fix.diff`, `server-temp-patch.diff` | the production remediation and the temporary harness patch        |

## 7. Deviations from the feasibility assumptions

| Feasibility assumption                              | Observed                                                                                                                                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool rendering, HITL and error UX are mode-agnostic | True for tools and HITL. **Error UX was not**: over SSE, `runAgent()` resolves after a `RUN_ERROR`, and the client's fallback overrode the error. One small client change fixes it (section 4) |
| A real RUN_ERROR reaches the owner                  | Not for _any_ `RUN_ERROR` before the fix, coded or not (section 4.5)                                                                                                                           |
| `TEXT_MESSAGE_CHUNK` from `DotAgent`                | The wire has `TEXT_MESSAGE_START/CONTENT/END`                                                                                                                                                  |
| Post-tool answer as a separate assistant message    | Same assistant message as the tool call                                                                                                                                                        |
| Playwright's own Chromium                           | Playwright 1.63 wants build 1243 (absent); Chrome Headless Shell 149 via `executablePath` worked                                                                                               |
| Node                                                | This run used Node 24.14.1, the repo's declared engine (the first run used 22.23.1)                                                                                                            |

## 8. Open questions

1. Whether the production client change belongs in `chat-error.ts` + `Chat.tsx` as done here, or in `nextError`; this run chose the pure-fallback form (section 4.4). Needs a decision when the local-first client work is scheduled.
2. Whether Intelligence mode had the same "`runAgent()` resolves after `RUN_ERROR`" behavior is unknown and cannot be tested here.
3. The stop contract returns the `STOPPED` `RUN_ERROR` in the HTTP body while the stream ends with `RUN_FINISHED`; confirm this is intended before relying on it.
4. While reconnecting to an in-flight run, the UI's "Thinking…" state was not examined; only the transcript was.
5. The post-tool text sharing the tool call's assistant message may matter for history replay to the model and for ChatGPT-plan reasoning replay (P2a/P2b).

## 9. What P1 does not establish

Durability across restart (P2a), reasoning-item replay (P2a/P2b), in-process headless turns (P3), a complete egress inventory (P5), authorization of the full route set (P6), size and retention (P7), migration (P8) and Slack (P4) were not touched. The egress counters in section 2 cover the P1 paths only.

## 10. Final verdict

```text
P1 overall: PASS
```

P1-1 to P1-8 all pass on Node 24.14.1. The only production change is the P1-8 remediation in `chat-error.ts` and `Chat.tsx`, covered by regression tests that failed before the change and pass after it, with the generic no-response behavior for genuinely empty runs preserved.
