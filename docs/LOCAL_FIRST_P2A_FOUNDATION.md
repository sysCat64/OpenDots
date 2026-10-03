# Local-first P2a foundation: golden traces (P2a-0) and reasoning-drop confirmation (P2a-8a)

**Status:** P2a-0 and P2a-8a were **executed in a temporary scratch worktree**. This document was afterwards **copied to the main worktree as closeout documentation**; it is not yet pushed. The scratch tests and raw evidence (`tests/p2a`, `p2a-evidence`) remain in the scratch worktree and are **not** part of the main worktree. Production source has not been changed. P2a-1 has not been started.
**Baseline:** `61b257cad62c768caa7d4cd2b3ac55b5293f0d87` (branch `feat/chatgpt-plan-provider`). P1 is PASS; the P2a design is committed and pushed.
**Scope:** P2a-0 and P2a-8a only. **No durable runner exists yet and P2a-1 and later were not started.** No production source was changed, not even a temporary patch.

## Verdicts

```text
P2a-0:  PASS
P2a-8a: PASS
```

**Go/Hold for P2a-1: GO.** Both verdicts are PASS, so the stated condition for P2a-1 is met. P2a-1 was **not** started.

## 1. Environment

| Item         | Value                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------- |
| Worktree     | `/tmp/opendots-p2a0.aC74Ip` (detached at `61b257c`)                                               |
| Node         | **v24.14.1** (installed binary placed first on `PATH`; no `mise.toml` involved)                   |
| npm          | **11.11.0**                                                                                       |
| OS           | macOS 12.7.6 (Darwin 21.6.0)                                                                      |
| CopilotKit   | `@copilotkit/runtime`, `core`, `react-core` 1.75.0                                                |
| AG-UI        | `@ag-ui/client`, `@ag-ui/core` 0.0.59                                                             |
| TanStack AI  | `@tanstack/ai` 0.63.0, `@tanstack/ai-openai` 0.25.1                                               |
| Test tooling | vitest 4.1.11                                                                                     |
| Required env | `COPILOTKIT_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`; both asserted at the start of each test file |

`node_modules` is an APFS clone of the main worktree's. No `npm install`, no update, no change to `package.json` or `package-lock.json`.

## 2. Isolation and egress

Fully offline. The only model is a **fake OpenAI-compatible server on `127.0.0.1`**, which also serves the repository's existing Responses fixtures for P2a-8a. No OpenAI, ChatGPT/SIWC, CopilotKit cloud, Slack, voice, external web, Keychain, `.env` or credential access. **No network probe of any kind was made.**

Egress was measured, not blocked at the operating-system level:

- the server process's `globalThis.fetch` refuses and records any non-loopback URL;
- `net.Socket.prototype.connect` refuses and records any non-loopback host.

Observed in the final runs (`p2a-evidence/golden.json`, `p2a-evidence/reasoning.json`): **non-loopback fetches 0, non-loopback sockets 0**. This covers the server process's `fetch` and sockets for the runs in these two test files; it is not an operating-system-level guarantee and not a full egress audit (that is P5).

## 3. P2a-0 methodology

**Path (all in one process, on loopback):**

```text
real CopilotKit client agent (ProxiedCopilotRuntimeAgent, transport "rest")
   │  HTTP, 127.0.0.1
   ▼
real CopilotSseRuntime + createCopilotHonoHandler (basePath /api/copilotkit)
   ▼
reference InMemoryAgentRunner   ← observed with rxjs `tap` (no behaviour change)
   ▼
real DotAgent → BuiltInAgent(tanstack) → TanStack chat() → fake model on 127.0.0.1
```

Why this shape:

- **The input is what a real client sends.** The conversation history that goes into run 2 of the HITL and two-turn scenarios is assembled by the real AG-UI client library, not by hand. (A hand-built assistant tool-call message would have been a guess; the real one has no `content` field.)
- **No production change is needed.** `DotAgent` only needs a non-empty `intelligenceKey`, the same trick the existing tests use; the harness builds the runtime directly instead of going through `Platform`.
- **The runner is injected**, so a durable runner can be dropped into the same suite later (`RUNNERS` in `golden.test.ts`).

The runner is observed at four points: what the runtime passed to `run` (`requestInput`), every event it emitted (`runnerEvents`, uncompacted), and, after the run, `getThreadEvents` (compacted), `getThreadMessages`, `getThreadState`, `listThreads`, plus the `connect` replay and the four HTTP thread endpoints. The client's own view of the stream (`clientEvents`) is recorded too.

Server tool used: `list_space_pages` (local SQLite, empty result `[]`, so its output is deterministic).

## 4. Golden scenarios

All eight scenarios pass the contract assertions on the reference runner (`golden.test.ts`, 12 tests). Counts come from `p2a-evidence/golden/manifest.json`.

| ID  | Scenario             | Raw events | Compacted | Messages | Result   | What is asserted                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | -------------------- | ---------- | --------- | -------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G0  | normal streaming     | 10         | 5         | 2        | **PASS** | `RUN_STARTED, TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT ×6, TEXT_MESSAGE_END, RUN_FINISHED`; compaction merges the six deltas into one; `RUN_STARTED.input` carries the user message; the client saw exactly the runner's events; `connect` replays the compacted log; messages `[user, assistant]`; state `null`; `isRunning` false                                                                                          |
| G1  | server tool          | 9          | 9         | 3        | **PASS** | `TOOL_CALL_START/ARGS/END/RESULT`, then text; **the tool call's `parentMessageId` equals the continuation text's `messageId`** (one assistant message); the tool result is its own message; snapshot `[user, assistant{content, toolCalls}, tool]`; two model calls (last roles `user`, `tool`)                                                                                                                              |
| G2  | HITL pending (run 1) | 5          | 5         | 2        | **PASS** | `RUN_STARTED, TOOL_CALL_START, TOOL_CALL_ARGS, TOOL_CALL_END, RUN_FINISHED`; no `TOOL_CALL_RESULT`, no text; `isRunning` false; replay equals the run; snapshot `[user, assistant{toolCalls}]` with the assistant id equal to `parentMessageId`; one model call                                                                                                                                                              |
| G3  | HITL resume (run 2)  | 5 (run 2)  | 10        | 4        | **PASS** | a **new `runId`**; request input `[user, assistant, tool]`; **stored `RUN_STARTED.input.messages` is `[assistant, tool]`** (details below); the answer text contains the approved result; the page was created through `createReviewed` and the receipt exists; snapshot `[user, assistant, tool, assistant]` with four distinct ids; the final answer is a **new** assistant message; replay equals run 1 followed by run 2 |
| G4  | stop                 | 7          | 5         | 2        | **PASS** | client `abortRun` → `runner.stop` → `DotAgent.abortRun` → `runner.stop -> true`, in that order; the fake model saw its connection close; the runner's last events are `TEXT_MESSAGE_END, RUN_FINISHED` (no `RUN_ERROR`); partial text starts `chunk-01 chunk-02 chunk-03`; `isRunning` false; snapshot `[user, assistant(partial)]` equals the text; the replay ends in `RUN_FINISHED`                                       |
| G5  | uncoded `RUN_ERROR`  | 2          | 2         | 1        | **PASS** | `RUN_STARTED, RUN_ERROR`; message contains `Synthetic model failure`; **`code` is not a key of the event**; no `RUN_FINISHED`; `isRunning` false; the user message is still in the snapshot                                                                                                                                                                                                                                  |
| G6  | coded `RUN_ERROR`    | 2          | 2         | 1        | **PASS** | same sequence; `code` is `subscription_sharing_usage_limit_exceeded` verbatim, in the run, in the compacted log and in the replay; provider traffic only to the fake `/v1/responses`                                                                                                                                                                                                                                         |
| G7  | two turns            | 20         | 10        | 4        | **PASS** | run 2 request input `[user, assistant, user]` with run 1's ids; **stored run 2 input is only the new user message**; snapshot `[user, assistant, user, assistant]`, four distinct ids, contents as sent; replay has two `RUN_STARTED` and each assistant message once; the client holds the same four ids                                                                                                                    |

### Important observed shapes

1. **The runner stores the user's message.** It lives in the `RUN_STARTED.input` that the runner attaches (G0, G7). A durable runner that omits this loses the user's turn on a crash.
2. **Input sanitising, now observed with a real client.** Run 2 of G7 stores only the new user message; both earlier messages are dropped because their ids are in history. In G3 the stored input is `[assistant tool-call message, tool message]`: the user message is dropped but **the assistant message is kept**, because its id only ever appeared as `TOOL_CALL_START.parentMessageId`, which the reference's id set ignores. This is the `parentMessageId` gap from the P2a design (section 9), confirmed dynamically.
3. **The real client's assistant tool-call message has no `content` property** (G3, `'content' in message` is false).
4. **HITL is two ordinary runs.** `isRunning` is false after run 1; run 2 has a different `runId`; the runner needs no HITL-specific state (G2, G3).
5. **One assistant message per run.** The continuation text shares the tool call's assistant message (G1); a resumed run produces a new assistant message (G3).
6. **Stop ends with `RUN_FINISHED`**, preceded by `TEXT_MESSAGE_END` for the open message, and keeps the partial text (G4). Whether those closers come from the finalizer or from `BuiltInAgent` is still not distinguished.
7. **Errors:** the run is stored, the input stays in the snapshot, there is no `RUN_FINISHED`, and a `code` survives compaction and replay (G5, G6).
8. **Compaction merges deltas only** (six content events become one; ids and order are kept). `getThreadState` is `null` for every scenario.
9. **The HTTP thread endpoints are a lossy projection** of the same data (recorded under `snapshot.http`); the thread record has `name: null` and empty `organizationId`/`createdById`.
10. **`RUN_STARTED.input` repeats the tool schemas on every run** (visible in G2/G3), a size factor for retention (P7).

## 5. Raw versus normalized fixtures

```text
p2a-evidence/golden/
  manifest.json
  raw/         normal, server-tool, hitl-pending, hitl-resume, stop, error-uncoded, error-coded, two-turns  (.json)
  normalized/  the same eight names
```

**Raw:** exactly what the reference runner produced (events, input, messages, thread record, replay, HTTP responses), with real UUIDs, written with `JSON.stringify` in capture order. Only fixture data is present: no secret exists in any scenario.

**Normalized:** only identifiers (and two timestamps) are rewritten; nothing else is dropped, added or reordered, and unknown event fields are kept.

- Namespaces are separate: `thread-N`, `run-N`, `msg-N`, `toolcall-N`, `space-N`, `page-N`, `agent-N`. **A tool-call id is never normalized as a message id, or the reverse.**
- Numbering follows first appearance, and **one normalizer is shared by the files of a group**, so the same real id is the same symbol in every file of that group (`hitl-pending` and `hitl-resume` share one: the tool call is `toolcall-1` in both, run 1 is `run-1`, run 2 is `run-2`). Different scenarios are different groups.
- Rules (also in the manifest): keys `threadId`, `runId`/`parentRunId`, `messageId`/`parentMessageId`, `toolCallId`, `agentId`; objects with `id` and `role` are messages; entries of `toolCalls` are tool calls; an object with `organizationId` and `agentId` is a thread record; known ids are also replaced inside strings (tool results, text, URLs), longest first, for ids of 8 or more characters; space and page ids are registered by the scenario.
- **The only removed value:** the thread record's `createdAt` and `updatedAt` become `"<timestamp>"` (nondeterministic). Nothing else is removed.
- Normalized files use sorted keys (canonical form) so they can be hashed and diffed; raw files keep capture order.

**Manifest** (`manifest.json`): source commit `61b257c…`, Node `v24.14.1`, runner name, the normalization rules, the removed-field note, and per scenario the raw and normalized file, event count, compacted event count, message count, and the SHA-256 of the normalized and raw files.

**Determinism.** The fixtures were generated once and then verified three separate times; each verification re-ran every scenario against the reference runner, re-normalized, and compared byte-for-byte with the stored files and the manifest hash. Regenerating produced identical hashes (for example G0 `3507922d…`, G3 `6011e4c7…`, G7 `c79363ec…`). G4 (stop) is the only timing-sensitive scenario; it stops at a defined point (the runner's third content event), and its asserted partial text is stable.

## 6. Differential-test preparation

Test helpers live only under `tests/p2a/` and are not imported by production code:

| File                                        | Role                                                                                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `golden-normalize.ts`                       | `Normalizer`, `canonicalJson`, `sha256`, the rule list                                                                            |
| `harness.ts`                                | builds the runtime and the real client agent around **any `AgentRunner`**; `snapshot()` reads the runner's local thread endpoints |
| `scenarios.ts`                              | G0 to G7, each taking a `RunnerFactory`                                                                                           |
| `golden.test.ts`                            | contract assertions, normalization checks, fixture comparison (`P2A_WRITE_GOLDEN=1` regenerates)                                  |
| `fake-model.ts`, `egress.ts`, `evidence.ts` | fake provider (also serves Responses fixtures), egress instrumentation, evidence writer                                           |

To compare a durable runner later: add `{name, make}` to `RUNNERS`. The runner must implement the `LocalThreadEndpointRunner` methods that `snapshot()` calls. Cases a durable runner can only pass after a restart (P2a-1 and later) compare against these stored normalized files.

## 7. P2a-8a: the reasoning path

The path, as measured:

```text
Responses fixture (reasoning item with encrypted_content)
  → TanStack Responses adapter
  → TanStack chat() output: REASONING_ENCRYPTED_VALUE chunk   ← the blob is here
  → CopilotKit convertTanStackStream                          ← dropped here
  → DotAgent/BuiltInAgent AG-UI events                         ← absent
  → runner (raw, compacted, replay, messages, HTTP)            ← absent
```

All proofs run offline on the repository's existing fixture (`tests/fixtures/responses-stream.ts`, sentinel `encrypted-reasoning-blob`, reasoning id `rs-1`), served by the local fake. `chatgptPlanProvider` is the real production adapter with a fixture `auth` object.

| Proof                           | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Result                                    |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| **A** source fixture            | A reasoning item with a **non-empty `encrypted_content`** (24 characters, the sentinel) exists in `response.output_item.done`                                                                                                                                                                                                                                                                                                                                                                                                     | **present**                               |
| **B** TanStack boundary         | `chat()` is run with the real adapter and a server tool. Its output contains the provider signature as a **`REASONING_ENCRYPTED_VALUE`** chunk (`subtype: "message"`, an `entityId`, `encryptedValue` = a JSON string that decodes, in the test only, to the fixture's id `rs-1` and the sentinel). The request's `include` was `["reasoning.encrypted_content"]`. The loop's second model request carried a `reasoning` item with the same id and blob (`input` types `message, reasoning, function_call, function_call_output`) | **present** (and replayed inside the run) |
| **C** AG-UI boundary            | The same fixture through `DotAgent`/`BuiltInAgent` and the runner. All AG-UI events recorded: `REASONING_ENCRYPTED_VALUE` **0**, `STEP_FINISHED` **0**, `STEP_STARTED` **0**. The sentinel and the string `encrypted_content` appear **nowhere** in the about 10 400 characters searched (the exact count varies by a few characters per run) (runner events, client events, compacted events, replay, messages, the HTTP projections, the client's own messages)                                                                 | **absent**                                |
| **D** (supplementary) cross-run | A second run on the same conversation, history resent by the client: the provider request has `input` types `message:user, function_call, message:assistant, function_call_output, message:user`: **no `reasoning` item, the sentinel absent**; the `function_call` item has only `type, call_id, name, arguments` (no item `id`)                                                                                                                                                                                                 | **absent**                                |

**Reasoning text events versus the opaque payload.** At the AG-UI boundary the run carries empty reasoning lifecycle events (`REASONING_START`, `REASONING_MESSAGE_START`, `REASONING_MESSAGE_END`, `REASONING_END`, then a second `REASONING_MESSAGE_END` and `REASONING_END` after the tool call). None has a `delta`, and none carries the blob: they hold `type`, `messageId` and (for the start) `role` only. The fixture's reasoning item has an empty summary, so there is no reasoning text to forward.

**P2a-8a verdict: PASS.** The blob exists in the source fixture and at the TanStack boundary and does not exist in any AG-UI event or in anything the runner can store. The assumption of P2a design section 5 holds.

## 8. Deviations from the static design

| Static design said                                                                                                                  | Observed                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The signature leaves the adapter as `STEP_FINISHED.signature` and is "hidden in TanStack's internal message state" (stages 4 and 5) | At `chat()`'s **output**, `STEP_FINISHED` has no `signature` (its keys are `type, stepName, timestamp, metadata`); the blob is delivered as a separate **`REASONING_ENCRYPTED_VALUE`** chunk, a public spec event. It is therefore visible to anything that wraps `chat()`'s stream before CopilotKit's converter, which makes the AG-UI-native continuation route (route 1) simpler than the design assumed. Dropping still happens in the converter |
| The converter forwards reasoning text events                                                                                        | It forwards empty lifecycle events, **and the end pair appears twice** per reasoning item (a second `REASONING_MESSAGE_END`/`REASONING_END` after the tool call). Harmless for replay, but the event log will hold them                                                                                                                                                                                                                               |
| A cross-run replay lists the tool call, then the assistant text, then the output                                                    | Confirmed dynamically (Proof D): `function_call`, `message:assistant`, `function_call_output`. Whether the provider accepts text between a call and its output stays Unknown (P2b-0)                                                                                                                                                                                                                                                                  |
| The stop closers come from the finalizer or from `BuiltInAgent`                                                                     | Still not distinguished (design item R13)                                                                                                                                                                                                                                                                                                                                                                                                             |
| Static: `compactEvents` merges deltas and otherwise preserves order                                                                 | Confirmed on all eight scenarios                                                                                                                                                                                                                                                                                                                                                                                                                      |

Nothing contradicted the design's central claims, so the design needs no correction before P2a-1.

## 9. Open points carried forward

- The real client's tool-call assistant message has no `content`; a durable runner's message snapshot must not add one.
- The `parentMessageId` gap is now a recorded reference behavior; the durable runner is meant to close it, so the differential test for G3 will differ **on purpose** at that one point (stored input `[tool]` instead of `[assistant, tool]`). That divergence must be asserted explicitly in P2a-2, not hidden.
- G4's closers (finalizer versus `BuiltInAgent`) remain open.
- `getThreadState` is always `null` here; no AG-UI state is used by OpenDots.
- Timestamps of the thread record are not compared; a durable runner will have its own `createdAt` semantics.

## 10. Evidence and files (temporary worktree)

Changed files (all untracked; no tracked file changed): `tests/p2a/{fake-model,egress,evidence,harness,golden-normalize,scenarios,golden.test,reasoning-drop.test}.ts`, `p2a-evidence/golden/*`, `p2a-evidence/golden.json`, `p2a-evidence/reasoning.json`, and this document.

Test runs on Node 24.14.1: `tests/p2a` is **17 tests passing** (12 golden, 5 reasoning-drop); five existing offline suites that exercise the same pipeline (`tanstack-agent`, `chatgpt-plan`, `siwc-contract`, `run-error-contract`, `dot-agent-channel`) pass, 30 tests. The full `npm test` was not run, as agreed.

## 11. Verdicts and Go/Hold

```text
P2a-0:  PASS
P2a-8a: PASS
```

**P2a-1: GO**, because both are PASS. Not started.
