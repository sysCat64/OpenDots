# Local-first P2b-0 live acceptance: a real ChatGPT Plan tool turn, a fresh-process restart, a second real turn

**Status: P2b-0: PASS — real ChatGPT Plan live acceptance.** A real tool-using turn, then a fresh-process restart, then a second real turn from the durable local history, **passed without cross-run encrypted reasoning continuation**. Precisely: **status-quo second-run live acceptance passed without persisted cross-run encrypted reasoning continuation.** No claim is made about reasoning continuation itself: nothing of that kind was implemented or exercised.

Review outcome: **P2b-0: PASS accepted.** The manual / offline correction of one over-broad automated criterion (section 14) is an **accepted adjudication**; no live rerun was required. P2a-9 stays optional / HOLD. P3 is GO after this closeout but not started. Production integration is not approved by this result.

Scratch only: the live guard, the process helpers, the re-evaluation helper, the scratch database, `tests/p2b/*` and `p2b-evidence/*` are not in the main worktree; only this document and the design update are. Nothing in main was changed, committed, pushed or tagged by P2b-0 itself. Production `src/`, `package.json` and the lock are at the scratch baseline.

Scope: `/private/tmp/opendots-p2a1.FV0LOx`. P3, P5 and P2a-9 were not started. This is **not** reasoning continuation, performance, multi-tab, production integration or provider failover.

## 1. Explicit user approval

The user explicitly approved this live acceptance (the phase instruction: "User has explicitly approved this live acceptance. This phase WILL use the real ChatGPT Plan / SIWC service. Keep the live model-request budget minimal."). Budget: at most 3 Responses model requests. Used: 3.

## 2. Baseline and environment

- Before any live step: the R32 closeout commit `a28cc7affb7504e3500c5211871b1064c343ca48` was pushed; local HEAD == origin, ahead 0 / behind 0, `git status --short` = `?? mise.toml`, 0 tags. Main was re-read at the end (read-only): same HEAD, same status, 0 tags.
- Node 24.14.1, macOS 12.7.6, `COPILOTKIT_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`, `CHATGPT_CREDENTIAL_STORE=keychain`. `NODE_ENV` and `VITEST_WORKER_ID` unset (production-like; not run under vitest).
- Isolated scratch database under the OS temp directory; the owner's normal OpenDots workspace database was not used or touched. Write policy **W1**; cache policy **R32 incremental** with the full-history check on; boot verification is the full authoritative verification. The production schema was not changed.
- Test id `20261004T043445`; thread `p2b0-20261004T043445`; page title `P2b-0 live 20261004T043445`.

## 3. Auth preflight

The existing read-only status command (`chatgpt-plan-cli status`, Keychain store) was run before any model request: Keychain item present, DevKit `@siwc/local 0.1.0` verified build, **`Session: signed in`**. No credential was reset, no sign-out, no registration deleted, no Keychain edit, no API-key provider, no fallback. No token, cookie, header or credential envelope was printed or saved (the Keychain key id is redacted in the evidence). The harness gave the session an `openBrowser` that throws, so a browser could never open.

## 4. Model and budget

One model for the whole acceptance: **`gpt-5.6-luna`** (available to the account; every request carried it). The provider is the existing `chatgptPlanProvider` with the session's auth; the config carried no API key and no base URL. A hard cross-process budget (a shared file, checked before sending) allowed 3 requests; a failed response would have blocked every later request (no automatic retry); the guard was exercised on a loopback stub first (the 4th request is blocked before sending; nothing is sent after a failure; an unrelated host is blocked). Requests issued: **3** (process A 2, process B 1). The budget was never exhausted by a 4th attempt.

## 5. Turn 1 (process A)

Prompt intent: create exactly one local page with a unique title and fixed Markdown content using `create_space_page`, call no other tool, omit the space id, reply with one short sentence. Real path: fresh process, real CopilotKit client, `CopilotSseRuntime`, scratch SQLite runner, real `DotAgent`, real ChatGPT-plan provider.

|             | Result                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| events      | 84: `RUN_STARTED` 1, `RUN_FINISHED` 1, `RUN_ERROR` 0                                                 |
| tool        | `create_space_page` called **once**, one matching result; no other tool                              |
| page        | count 0 to **1**; title and content equal the requested values; `create` invoked once in the process |
| final reply | present ("Created the page “P2b-0 live 20261004T043445” successfully.")                              |
| state       | `isRunning` false; process A exited with code 0                                                      |

## 6. Live requests (sanitized: no header, token, cookie or message text; `provider-sanitized` evidence)

| #   | process | input items                                                                        | response                                                                                                                                       |
| --- | ------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A       | 1: the user message                                                                | 200; a reasoning item with **encrypted content (1,740 chars, hash prefix recorded, value not stored)** and a `create_space_page` function call |
| 2   | A       | 4: user, **reasoning with encrypted content**, function call, function-call output | 200; the final text                                                                                                                            |
| 3   | B       | 5: user, function call, assistant message, function-call output, user              | 200; the answer                                                                                                                                |

All three: model `gpt-5.6-luna`, `store: false`, `include: ["reasoning.encrypted_content"]`, host `api.openai.com`, path `/v1/responses`, the same 6 tool names. Request 2 shows the **within-loop** encrypted reasoning replay that the status quo already does; request 3 shows that nothing of the kind crosses the run boundary.

## 7. Restart (process B, a genuinely fresh process)

Process A exited (code 0) before process B started (different PIDs: A 16442, B 17193). Same isolated database, same thread. Before any message, boot ran `ready()` (full authoritative verification under the incremental policy):

- cache equals the authoritative history: `rebuilt 0`; **repair write 0**; DB logical hash unchanged; no cache inconsistency;
- **model requests during boot 0; tool executions during boot 0**;
- page count exactly 1; `isRunning` false.

## 8. Reconstructed history (before Turn 2)

A fresh client's real connect replay gave the roles `user, reasoning, assistant, tool`: one user message (Turn 1), the assistant message carrying the one `create_space_page` call and its final text, the one matching tool result, and a `reasoning` message built from the empty lifecycle events (status quo). Message ids unique; no duplicate user message, call or result; the client's messages equal the runner's cache. Nothing was altered to make the model accept it.

## 9. Turn 2 (process B)

Prompt intent: "answer only from the conversation so far; do not create or modify a page and do not use tools; what exact page title did you create in the previous turn; include the marker `P2B0_TURN2_DONE`". The unique title was **not** in this prompt.

- Events 26: one new `RUN_STARTED`, `RUN_FINISHED` 1, `RUN_ERROR` 0, **0 tool calls**.
- The real request succeeded (request 3, status 200) and the reply was `P2b-0 live 20261004T043445 — P2B0_TURN2_DONE`: the **exact prior title** and the marker.
- `isRunning` false afterwards.

## 10. Outbound Turn-2 history (the observed adapter representation)

Request 3 input, in the order **observed** (this is the observed adapter representation, not a canonical order): `message:user` (Turn 1; mentions the unique title) → `function_call` `create_space_page` (mentions the title) → `message:assistant` (Turn 1's final completion) → `function_call_output` → `message:user` (Turn 2; does not mention the title). So Turn-1 user context, assistant tool call, tool result, assistant completion and the Turn-2 message are all present. The order (call, assistant text, output) is the one P2a-8a already recorded. No history item was hidden by a normalizer. **Live evidence:** the real service accepted this representation and the model correctly referred to the Turn-1 title.

## 11. Side effects

`create_space_page` executions: process A 1, process B 0 (during boot and during Turn 2), process C 0: **1 in total**. Page count 1 after Turn 1, after boot, after Turn 2 and in the final reader. No side-effect replay after the restart.

## 12. Reasoning: three observed layers (status quo; no reasoning-continuation claim)

| Layer                     | Observation                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Same tool loop**        | Encrypted reasoning **was observed and replayed**: response 1 contained one encrypted reasoning value (1,740 chars; hash prefix recorded, value not stored) and request 2 sent it back inside the same tool loop.                                                                                                                                                                                                                                                                       |
| **Durable AG-UI history** | **Encrypted reasoning payload persistence = 0:** no durable event type names an encrypted value and no event contains "encrypted" (0 of 110). The empty reasoning **lifecycle** events (`REASONING_START`, `REASONING_MESSAGE_START`, `REASONING_MESSAGE_END`, `REASONING_END`) **do exist** in the durable history, 6 events in Turn 1 with the known doubled end pair, each carrying only its message id (and role): this is the P2a-8a status quo, maintained. Turn 2 produced none. |
| **Cross-run Turn 2**      | Request 3 contained **no** reasoning item; Turn 2 **succeeded without encrypted reasoning continuation**.                                                                                                                                                                                                                                                                                                                                                                               |

Recorded as: **status-quo second-run live acceptance passed without persisted cross-run encrypted reasoning continuation.** The measurement gives evidence that cross-run encrypted reasoning persistence is **not required for baseline functional local-first continuation**. Whether implementing a continuation would improve quality or efficiency is **not evaluated**. P2a-9 is not exercised.

## 13. R32 cache, reader and network

**R32 during the live test (not a production adoption approval):**

- healthy restart verification: **PASS**; cache mismatch **0**; repair write **0**; provider and tool activity during boot **0**;
- Turn-2 full-history comparison (the incremental cache against the full derivation): **difference 0** (1 check, 0 failures);
- the full-rebuild-only mode was not used to make anything pass.

**Process C** (reader only, no provider session, a budget of 0 model requests): two runs `finished`, page count 1, **provider 0, tool 0, repair write 0, DB logical hash unchanged**, messages stable. Final database: 2 runs, 110 events, hash `aaa4b0ca…`.

**Network** (`network-summary.json`), the permitted live egress:

| Host              | What                                                                                                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.openai.com`  | Responses / model calls: **3**; model-list retrieval: **2** (one per live process)                                                                                                     |
| `auth.openai.com` | saved-session refresh: **1**, in process A only (the DevKit's own renewal of the stored session: OpenID configuration, token refresh, JWKS; not a model request; no reset or sign-out) |
| loopback          | the local runtime                                                                                                                                                                      |

Unexpected: CopilotKit Intelligence 0, telemetry 0, Slack 0, Voice / Realtime 0, other hosts 0; 0 blocked attempts. No credential or secret is in this document or in the evidence.

## 14. External-error policy and the one correction

No external error occurred (no usage limit, no auth, model or service failure), so the BLOCKED_EXTERNAL policy (preserve the code, no retry, no API-key fallback, no provider change) was not triggered; the guard was built to enforce it.

**Initial automated verdict (kept, not erased):**

```text
Initial automated verdict:
FAIL_LOCAL

Reason:
criterion 17 implementation classified every event type whose
name contained REASONING as persisted encrypted reasoning.

Observed durable events were only the already-known empty
reasoning lifecycle events.

Encrypted reasoning value persisted across runs:
0

Offline re-adjudication:
PASS
```

**Accepted adjudication.** Four facts matter: (1) **no live request was re-issued**; (2) **the evidence and the database were not rewritten**; (3) **only the intended meaning of criterion 17 was re-evaluated** (no encrypted reasoning persistence), offline, from the saved evidence and the local scratch database; (4) **the original automated summary is preserved** as `summary.initial-automated.json`, and `summary.json` carries the corrected verdict with a `correction` block. The reviewer accepted this adjudication.

**How it happened.** The orchestrator's first automated verdict was **FAIL_LOCAL**, caused by criterion 17 alone: its rule counted any durable event type containing "REASONING" as persisted reasoning, so it flagged the empty lifecycle events that P2a-8a had already documented as the status quo. The rule was too broad; nothing in the runner was wrong. Criterion 17 was re-scored **offline** (no network, no live request) from the saved evidence and the local scratch database with the intended meaning, "no encrypted reasoning persistence": no encrypted event type, no event containing "encrypted", every reasoning event an empty lifecycle event, no event type outside the pre-existing AG-UI set. Result: it holds. The original automated result is kept untouched as `summary.initial-automated.json`; `summary.json` carries the corrected verdict with a `correction` block. The orchestrator source was corrected for future runs. A reader who disagrees with the re-scoring has all the evidence to re-judge it.

## 15. PASS criteria

1 R32 closeout pushed and matched ✓ · 2 persistent auth usable without reset ✓ · 3 budget ≤ 3 (3) ✓ · 4 Turn 1 real model ✓ · 5 `create_space_page` exactly once ✓ · 6 exactly one page, title and content as requested ✓ · 7 Turn 1 no `RUN_ERROR` ✓ · 8 A exited, B fresh ✓ · 9 restart: provider 0, tool 0 ✓ · 10 healthy incremental cache: repair write 0 ✓ · 11 history reconstructed without duplicates ✓ · 12 Turn-2 request contained the required prior history ✓ · 13 Turn 2 completed ✓ · 14 Turn 2 named the correct title ✓ · 15 one `create_space_page` execution in total ✓ · 16 page count 1 throughout ✓ · 17 no cross-run encrypted reasoning persistence added ✓ (after the correction in section 14) · 18 status-quo Turn 2 succeeded without such continuation ✓ · 19 no API-key fallback or provider mutation ✓ · 20 no unexpected egress ✓ · 21 main `?? mise.toml` only ✓ · 22 no commit, push or tag ✓.

## 16. Open observations

1. One model, one prompt each, one account and one run: this is an acceptance, not a statistical result. The model followed both the "one tool" and the "no tool" instructions here; a non-compliant model would have been reported as MODEL_BEHAVIOR_INCONCLUSIVE, not retried.
2. The service produced a reasoning item in Turn 1 and none in Turn 2; whether history without reasoning stays acceptable for longer or more complex conversations is untested.
3. `x-request-id` was not present on the responses, so no service-side correlation id is recorded.
4. The DevKit renewed the stored session once during process A (the credential file's modification time changed); this is its normal operation.

## 17. Verdict and next step

**P2b-0: PASS — real ChatGPT Plan live acceptance.** The current local-first durable runner completed a real ChatGPT Plan tool-using turn, survived a fresh-process restart with a healthy incremental cache (repair write 0, no provider or tool activity at boot), and completed a second real turn from the durable history, with no side-effect replay and no persisted cross-run encrypted reasoning, within 3 live model requests. **Status-quo second-run live acceptance passed without persisted cross-run encrypted reasoning continuation.**

Recommendation: the status quo can continue across runs, so P2a-9 (a reasoning continuation channel) stays **optional / HOLD**. Production integration is not approved by this result. P3 is GO after this closeout, not started.
