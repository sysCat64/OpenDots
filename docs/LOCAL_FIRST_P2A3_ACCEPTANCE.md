# Local-first P2a-3 acceptance: generic incomplete-stream crash recovery under a real `SIGKILL`

**Status:** P2a-3 was **executed in a temporary scratch worktree** (`/private/tmp/opendots-p2a1.FV0LOx`, the P2a-1 / P2a-8b / P2a-2 / P2a-4 / P2a-5 worktree) and **PASSED**. **P2a-6 is GO but not started.** This document was afterwards **copied to the main worktree as closeout documentation**. The scratch runner, tests and raw evidence (`tests/p2a/*`, including `sqlite-runner.ts`, `p2a3-proc.ts` and `p2a3.test.ts`, and `p2a-evidence/*`) remain in the scratch worktree and are **not** part of the main worktree. **Production integration has not been done; no production source, test, migration, dependency or configuration was changed.** The scratch runner is an observed candidate, not an approved production implementation. The PIDs, hashes and measurements below are the record of that execution.
**Baseline:** the scratch tree is detached at `aa2a4157fa3b99b3176bdd7ea99cd8fb4d77266a`. The main branch is at `d987c4771ea1ce124f49e0923b1f4d218afe6a41` (the P2a-5 closeout, pushed and confirmed equal to origin before this work started); `aa2a415..d987c47` is documentation-only (section 1). P2a-0, P2a-8a, P2a-1, P2a-8b, P2a-2, P2a-4 and P2a-5 are PASS.
**Scope:** P2a-3 only, three recovery classes: **T1** an open text message, **T2** a tool call whose arguments never completed, **T3** a run that has only its `RUN_STARTED`. The P2a-4 server-tool recovery and the P2a-5 client-tool recovery were not changed in behaviour. Stop and error recovery, the stale error banner, 100-turn performance, provider continuation, P2b (live) and production integration were **not** started and are **not** accepted here.

## Verdict

```text
P2a-3: PASS
```

All nineteen PASS criteria hold. Each of the three classes was produced by a real `SIGKILL` at a deterministic gate and was recovered on restart **once**, in **one** transaction, with the **stock finalizer's own events** (nothing replaced), to status `interrupted`; the recovery is idempotent across another restart, survives a fault injected inside the transaction, never calls a provider and never runs a tool, and a new ordinary turn works afterwards. For T2 the tool executor was measured to have **never started** (0 invocations, 0 side effects), which is what makes the stock "the call did not complete" closure truthful here, unlike the P2a-4 "outcome unknown" case. The P2a-4 and P2a-5 classes are not taken over by the new classifier. **GO for P2a-6** (section 21). At execution time nothing was committed, pushed or tagged.

| #   | Criterion                                                                | Result |
| --- | ------------------------------------------------------------------------ | ------ |
| 1   | T1, T2 and T3 were created with an actual `SIGKILL`                      | PASS   |
| 2   | T1 keeps the durable partial text exactly                                | PASS   |
| 3   | T1 recovery closes the open text exactly once                            | PASS   |
| 4   | T1 ends `RUN_ERROR(INCOMPLETE_STREAM)` and `interrupted`                 | PASS   |
| 5   | T2: the tool executor never started before the crash                     | PASS   |
| 6   | T2: the recovery does not run the tool either                            | PASS   |
| 7   | T2 is not confused with the P2a-4 ambiguous-side-effect case             | PASS   |
| 8   | T2 replay and reducer are valid                                          | PASS   |
| 9   | T3 keeps the user input and makes no synthetic assistant or tool message | PASS   |
| 10  | `isRunning` is false after recovery in T1, T2 and T3                     | PASS   |
| 11  | Recovery is DB-persisted and idempotent on a second restart              | PASS   |
| 12  | The recovery processes call no provider or model                         | PASS   |
| 13  | The recovery transaction is atomic and survives fault injection          | PASS   |
| 14  | A new turn can be sent to the same thread after recovery                 | PASS   |
| 15  | The P2a-4 / P2a-5 classification is not broken                           | PASS   |
| 16  | All earlier P2a regressions are green                                    | PASS   |
| 17  | Golden fixtures are unchanged                                            | PASS   |
| 18  | Unexpected external egress is 0                                          | PASS   |
| 19  | The main worktree status remains `?? mise.toml`                          | PASS   |

## 1. Environment and baseline

| Item                     | Value                                                                                                                                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node / npm               | **v24.14.1 / 11.11.0** (installed binary first on `PATH`; `mise.toml` not used)                                                                                                                             |
| OS / SQLite              | macOS 12.7.6 / SQLite 3.51.2 (bundled with `node:sqlite`)                                                                                                                                                   |
| Packages                 | `@copilotkit/runtime` / `core` 1.75.0; `@ag-ui/client` 0.0.59; `@tanstack/ai` 0.63.0; vitest 4.1.11; tsx. No `npm install`; `package.json` and the lock are untouched.                                      |
| Env                      | `COPILOTKIT_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`, asserted in the orchestrator and in every child process                                                                                                |
| Network                  | fake provider on `127.0.0.1` only; no OpenAI, SIWC, CopilotKit cloud, Slack, voice, Keychain, `.env` or external web; no external probe                                                                     |
| Documentation-only range | `git diff --name-only aa2a415 d987c47` lists only files under `docs/`. Checked by test 0 on every run.                                                                                                      |
| Production diff          | none: `git diff d987c47 -- src package.json package-lock.json` is empty and `package.json` / `package-lock.json` are byte-identical to the ones at `d987c47`; the scratch tree has no modified tracked file |

## 2. The three recovery classes and the exact event shapes

All three are closed by **the stock finalizer's own output** (public `finalizeRunEvents`, installed 1.75.0, called with the runner's interruption text `Run interrupted: the server process ended before the run finished.`). The runner uses `createRunEventFinalizer` from the same module and the tests assert that the appended events are **deep-equal to `finalizeRunEvents(storedEvents, …)`**. Nothing is replaced, renamed or added.

| Class | Stored when the process died                                                            | Appended on restart (exact)                                                                                                                                                                                                                         | Run status    |
| ----- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| T1    | `RUN_STARTED`, `TEXT_MESSAGE_START`, 3 × `TEXT_MESSAGE_CONTENT`; no END, no terminal    | `{type: "TEXT_MESSAGE_END", messageId}` then `{type: "RUN_ERROR", message: <text>, code: "INCOMPLETE_STREAM"}`                                                                                                                                      | `interrupted` |
| T2    | `RUN_STARTED`, `TOOL_CALL_START`, `TOOL_CALL_ARGS` (partial `{"lab`); no END, no result | `{type: "TOOL_CALL_END", toolCallId}`, `{type: "TOOL_CALL_RESULT", toolCallId, messageId: "<id>-result", role: "tool", content: "{\"status\":\"error\",\"reason\":\"missing_terminal_event\",\"message\":\"<text>\"}"}`, then the `RUN_ERROR` above | `interrupted` |
| T3    | `RUN_STARTED` only                                                                      | `{type: "RUN_ERROR", message: <text>, code: "INCOMPLETE_STREAM"}`                                                                                                                                                                                   | `interrupted` |

**Stock-finalizer observation (offline, `stock-finalizer-observation.json`).** For an open text message the installed finalizer yields `TEXT_MESSAGE_END, RUN_ERROR`; for an incomplete tool call `TOOL_CALL_END, TOOL_CALL_RESULT (status "error", reason "missing_terminal_event"), RUN_ERROR`; for `RUN_STARTED` only, `RUN_ERROR`. It adds no text and no continuation. Truthfulness, case by case: T1 and T3 are truthful as they stand. **T2** is truthful **here** because the executor was measured never to have started and the framework runs a tool only after its arguments are complete (P2a-4 observed `TOOL_CALL_END` before the effect); the stock result says the call did not complete, but its `message` is the generic interruption text and does not itself say "not executed". No protocol value was invented, so the case was not BLOCKED.

## 3. Classification and precedence

The runner decides from the stored events alone. The new classes are tested first **only for states the P2a-4 and P2a-5 classes never produce** (an incomplete call, an open text message); everything else falls through unchanged.

| Stored state                                                                                                                          | Class (owner)                                                                 | Recovery                                            |
| ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------- |
| a server tool, `TOOL_CALL_END` durable, no result                                                                                     | `server_unknown_outcome` (P2a-4)                                              | unknown-outcome result + `RUN_ERROR`; `interrupted` |
| a client-declared tool, `TOOL_CALL_END` durable, no result                                                                            | `client_hitl_pending` (P2a-5)                                                 | `RUN_FINISHED` only; `finished`                     |
| a tool call with `TOOL_CALL_START` / `ARGS`, no `END` (server or client-declared)                                                     | `tool_args_incomplete` (P2a-3)                                                | stock closure; `interrupted`                        |
| an open text message (also after a resolved tool call)                                                                                | `open_text_message` (P2a-3)                                                   | stock closure; `interrupted`                        |
| `RUN_STARTED` only                                                                                                                    | `no_tool_lifecycle` (P2a-3)                                                   | `RUN_ERROR`; `interrupted`                          |
| open text **and** a pending complete call; incomplete **and** a pending complete call; a pending client **and** a pending server call | **deferred** (`open_text_with_pending_tool_call`, `mixed_pending_tool_calls`) | nothing written; stays `running`                    |
| a complete text message (or any other event) with no tool call, no terminal                                                           | **deferred** (`unclassified_lifecycle`)                                       | nothing written; stays `running`                    |

Test 12 builds eleven abandoned runs, one per row (and both server and client-declared forms of the incomplete call), and asserts each class, the exact appended events (stock-equal for the P2a-3 classes), and that the deferred ones wrote nothing. **P2a-3 did not take a P2a-4 / P2a-5 case** (the first two rows are unchanged; negative control N7 shows what would happen otherwise). Mixed states keep the existing deferral and were **not** generalized. Three P2a-4 deferral tests and one P2a-5 deferral test were **replaced on purpose** (section 17) because P2a-3 settles what they had deferred.

## 4. Actual `SIGKILL` evidence

The orchestrator polls a marker written by the writer at its gate, checks the database through a **separate connection**, sends `SIGKILL` itself and waits for the child. In all four crashes the exit was **`{code: null, signal: "SIGKILL"}`**, the PID was gone, the run row was `running`, and the database was identical before and after the kill. Gates are deterministic (no sleeps decide ordering):

- **T1:** the fake model streams `g01 g02 g03 …` and holds chunk 4; the writer proceeds only when 3 `TEXT_MESSAGE_CONTENT` rows are durable.
- **T2:** a new fake-model request type streams a server tool call (`p2a4_side_effect`) with the first fragment of its arguments and then stalls; the writer proceeds only when the `TOOL_CALL_ARGS` row is durable.
- **T3:** the fake model holds the request (it **arrived**, nothing is answered); the gate is the arrival of the provider request.

| Case | Writer PID | Rows durable at the crash                                                                                | Status    | Provider requests at the gate |
| ---- | ---------- | -------------------------------------------------------------------------------------------------------- | --------- | ----------------------------: |
| T1   | 74146      | `RUN_STARTED`, `TEXT_MESSAGE_START`, 3 × `TEXT_MESSAGE_CONTENT`; **no** END, `RUN_FINISHED`, `RUN_ERROR` | `running` |                             1 |
| T2   | 74296      | `RUN_STARTED`, `TOOL_CALL_START`, `TOOL_CALL_ARGS`; **no** END, result, terminal                         | `running` |                             1 |
| T3   | 74422      | `RUN_STARTED` (exactly one); **no** text or tool event, no terminal                                      | `running` |                             1 |
| T2s  | 74819      | as T2 (a second crash, for the stale-client check in section 9)                                          | `running` |                             1 |

(The PIDs are those of the final run recorded in `p2a-evidence/p2a3/summary.json`; each rerun records new ones.)

## 5. T1: open text

Partial text, deterministic: **`g01 g02 g03 `**. Recovery (process B) appended `TEXT_MESSAGE_END` for that message and `RUN_ERROR(INCOMPLETE_STREAM)`; the stored rows are unchanged, the log still holds exactly three content deltas and the concatenated text is **`g01 g02 g03 `** (no character lost, none added, no continuation text); exactly one END and one `RUN_ERROR`; status `interrupted`; 0 provider requests, 0 runner `run()` calls. `getThreadMessages` is `[user, assistant("g01 g02 g03 ")]` (equal to the reducer's derivation and to what a fresh real client rebuilds); `isRunning` false; the thread is listed after the recovery (it was not while `running`); `verifyEvents` accepts the history (a closed run).

## 6. T2: incomplete tool arguments, and why it is not the P2a-4 case

**Proof that the executor never started.** The test tool counts every invocation at its entry and records every side effect in a test-only table (the oracle of P2a-4; the runner never reads it). Before the crash: **0 invocations and 0 side effects**, read both by the writer at its gate and through the separate connection; after the recovery by B and after C: still 0 and 0; after a following new turn: still 0 (section 9).

**The recovery** closed the call with the stock events (section 2) and kept the partial arguments: the log still holds `TOOL_CALL_ARGS` with `{"lab`. The reducer yields `[user, assistant{toolCalls: [call-args-partial, arguments "{\"lab\"}], tool(stock result)}]`, and `verifyEvents` accepts the history. The tool was not executed by the recovery, the runner or the framework.

**Difference from P2a-4, stated plainly:**

| P2a-4 (Cases A and B)                                                                | P2a-3 T2                                                                              |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `TOOL_CALL_END` is durable                                                           | `TOOL_CALL_END` is **absent** (the arguments never completed)                         |
| the tool **may or may not** have executed; the log cannot say                        | the executor **never started** (measured), and cannot start with incomplete arguments |
| closed with an **"outcome unknown"** result (the stock error would assert a failure) | closed with the **stock** "the call did not complete" result and `RUN_ERROR`          |

The appended events contain no unknown-outcome content and no `-unknown-outcome` message id (asserted), and the record's kind is `tool_args_incomplete`, not `server_unknown_outcome`.

## 7. T3: `RUN_STARTED` only

The provider request had arrived and nothing came back. The log held exactly one `RUN_STARTED` (with the user message in its `input.messages`). Recovery appended **`RUN_ERROR(INCOMPLETE_STREAM)` only**; the stored `RUN_STARTED` is unchanged; no synthetic assistant message, no tool result; the cache is `[user]`; the client rebuilds `[user]`; `interrupted`; 0 provider requests; `isRunning` false.

## 8. Atomicity, idempotence and fault injection

- **One transaction.** The appended events and the status change are one synchronous `BEGIN IMMEDIATE … COMMIT`, re-checked inside it, with no `await`. **The recovery transaction is one; the recovering boot used two write transactions** (the recovery, then the separate message-cache rebuild). A later boot used none.
- **Idempotence across another restart** (process C, a new PID, same database; T1, T2 and T3): **0 recovery records, 0 recovery write transactions, 0 boot-time write transactions**, `ready()` `{checked: 1, rebuilt: 0}`; stored rows, event count, terminal count (one `RUN_ERROR`), run status and the logical database hash are identical to the state after B, and a third read by the orchestrator agrees; 0 provider requests. Whether recovery is needed is decided from the **database** (`status = running`, not run by this process), not from a process-local flag.
- **Fault injection** (all three classes; simulated abandonment, not a crash): a trigger made the terminal insert fail **after** the earlier events of the recovery had been inserted (the `TEXT_MESSAGE_END`; the call closure and its result). The whole recovery rolled back (rows and status unchanged, 0 committed transactions); with the fault removed the next `ready()`-style attempt recovered once in **1 transaction**, and a further call found nothing and wrote nothing.

| Case | Logical SHA-256 before the crash                                   | After B = after C                                                  |
| ---- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| T1   | `517996d234301b70452e503602e9439023abb24213e3bf473225cf58003cd24c` | `2840fcac44eddc130733b371a97e3d975484e63935d031264eb3ec314dba6a9c` |
| T2   | `0543d8e0af7dfeafdbe53b762fe16027b491a28d46d3f44ae9ad58d674a2c69c` | `b99de6af677ea3de708e6ef667f65d3d48d8e39519f5178b96fb3283e39da7d7` |
| T3   | `ff230ea51c7ff0c544cf574e21e0ade805abba0571366deb61788df10028b5d9` | `65f5a3c8b2d51188f20816d82baf08fab057f56b845aff5134ca21d923c5dd0a` |

(The hash covers rows with random ids and timestamps, so it differs from run to run; the assertions compare values within one run.)

## 9. Continuation after recovery

Process D (a new process): `ready()`, a fresh real client reloads the recovered thread, then a **new ordinary user turn**. This is a fake-model runner/history check, not live API acceptance.

- **T1:** request `[user, assistant, user]`; durable input `[new user]` only; the thread ends `[user, assistant, user, assistant]`, ids unique, **the partial assistant message appears exactly once**; statuses `[interrupted, finished]`; 1 provider request.
- **T2:** request ends `assistant, tool, user` (the stock result is part of the history); durable input `[new user]`; the framework **ran no tool** (no `TOOL_CALL_RESULT` in the new run; invocations still **0**). **T2s:** a second crash, then a request that arrived **before any recovery** carrying the client's stale history (an assistant tool call with no result): `run()` recovered the dead run, **refused** the stale input (the provisional P2a-4 interlock; 0 events, 0 provider requests, **0 tool invocations**), the client reloaded and the same turn went through with invocations still 0. This shows an unfinished call is not run by a new turn either way.
- **T3:** request `[user, user]`; durable input `[new user]` only (the original user message is **not duplicated**); the thread ends `[user, user, assistant]`; statuses `[interrupted, finished]`.

## 10. P2a-4 and P2a-5 regressions

The P2a-4 suite (its real `SIGKILL` Cases A, B, C and the R19 pair) and the P2a-5 suite (real `SIGKILL` micro-window H2, H1, H2b) were **rerun** and are green: server tool ambiguous still gives unknown-outcome + `RUN_ERROR` + `interrupted` (A and B still indistinguishable from the log), and a pending client tool still gives `RUN_FINISHED` + `finished` and an approvable pending decision. Test 12 asserts the two classes beside the three new ones.

## 11. R19 assessment

R19 (a crash leaves a run row with `status = running`) has been split across the phases. Status after P2a-3:

| Single-class crash                              | Resolved by    |
| ----------------------------------------------- | -------------- |
| server tool, `TOOL_CALL_END` durable, no result | P2a-4          |
| client tool pending after `TOOL_CALL_END`       | P2a-5          |
| open text message                               | **P2a-3 (T1)** |
| tool arguments incomplete                       | **P2a-3 (T2)** |
| `RUN_STARTED` only                              | **P2a-3 (T3)** |

All five are accepted. **The simple single-class crash recovery for the classes tested can be considered closed.** R19 should **not** be called fully closed, because three families remain deferred and are **not** resolved: (1) mixed states (`mixed_pending_tool_calls`, `open_text_with_pending_tool_call`; R22 / R24); (2) a **complete** text message (or other events such as state or reasoning) with no tool call and no terminal (`unclassified_lifecycle`): a run cut between `TEXT_MESSAGE_END` and `RUN_FINISHED` stays `running`; this is a plain single-class case that P2a-3 did not take (its stock closure would be a bare `RUN_ERROR`, like P2a-4 Case C); (3) several writer processes on one database (R17). Recommendation: close R19 for the five classes above, keep (2) as a named residual (a small extension), and keep (1) and (3) as the independent risks R22 / R24 / R17.

## 12. Negative controls

Seven temporary mutations of `sqlite-runner.ts`, each run against the full P2a-3 test and each **reverted** (restored and compared byte-for-byte by hash after every run; the final runner is the `4c137761…79f38` version).

| Mutation                                                                                        | Tests that went red                                             |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| N1 open text: `TEXT_MESSAGE_END` is not added                                                   | 3: T1 recovery, idempotence, classification                     |
| N2 open text: the partial text is thrown away during the recovery                               | 3: T1 recovery, T1 continuation, classification                 |
| N3 incomplete tool arguments: the tool is executed during the recovery                          | 2: T2 recovery, T2 continuation                                 |
| N4 an incomplete call is treated like the P2a-4 outcome-unknown case                            | 3: T2 recovery, T2 is not P2a-4, classification                 |
| N5 a `RUN_STARTED`-only run is left `running`                                                   | 4: T3 recovery, idempotence, classification, T3 fault injection |
| N6 the recovery / terminal events are added again at every restart                              | 6: T1 and T2 continuation, idempotence, fault injection (three) |
| N7 the P2a-3 classifier is applied **before** P2a-5 (a pending client call becomes `RUN_ERROR`) | 1: classification                                               |

Details: `p2a-evidence/p2a3/negative-controls.json`. The mutated runs wrote their evidence elsewhere (`P2A3_OUT`), which was deleted. N3 is expressed as an extra call to the test tool's side-effect function from the runner.

## 13. Regressions

| Check                                                                                                                                    | Result                               |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `tests/p2a` as a whole, file by file: `golden` 12, `reasoning-drop` 5, `p2a1` 19, `p2a8b` 15, `p2a2` 21, `p2a4` 19, `p2a5` 14, `p2a3` 18 | **123 / 123 passed**, 8 files        |
| Golden fixtures, 17 files (`raw/*`, `normalized/*`, `manifest.json`) vs the SHA-256 list taken before P2a-2                              | **identical**; nothing was rewritten |
| `prettier --check tests/p2a docs/LOCAL_FIRST_P2A3_ACCEPTANCE.md`, `git diff --check`                                                     | clean                                |

The evidence of earlier phases in the scratch tree was regenerated by the same full run (new PIDs); the numbers those phases documented refer to the runs in which they were recorded.

## 14. External egress

Server-process instrumentation of `fetch` and socket connect (`127.0.0.1` allowed, everything else refused and recorded): **0 fetches and 0 connects** in the orchestrator, in every recovery, restart, continuation and stale-client process (B, C, D, N), and in each killed writer **at the moment it reached its gate**. No external probe was made. This measures what these processes attempted; it is not an operating-system-level guarantee.

## 15. Deviations, surprises and open issues

**Deviations and surprises**

1. P2a-3 settles four cases that earlier phases had deferred, so **four tests were replaced on purpose** (section 17).
2. A tool call whose arguments are incomplete is recovered the same way whether the tool is a server tool or a client-declared one (the call never completed and was never presented or run); P2a-5 had noted it as left to P2a-3.
3. The stock T2 result `{status: "error", …}` is the CopilotKit convention; it is accepted here only because the executor was measured never to have started. It would be wrong for a call whose `TOOL_CALL_END` is durable (P2a-4).
4. Partial text is exactly what had been **flushed**: deltas are buffered and flushed by a timer or the next boundary, so deltas that were published but not yet flushed when the process died are lost. The test flushes three deltas before the kill; the "no character lost" claim is about the durable text, not the unflushed tail (W2 write policy, section 7.3 of the design).
5. The fault-injection, classification and stock-finalizer tests use a simulated abandonment or the pure finalizer, not a `SIGKILL`; they are not crash evidence.

**Open issues (carried forward)**

- **`unclassified_lifecycle`**: a run cut after a complete text message (or with only state, reasoning or other events) and no terminal stays `running` (section 11).
- **Mixed states** stay deferred (R22 / R24); no generalization was made.
- **Live provider acceptance of the T2 history** is unverified: the stored assistant tool call has invalid partial JSON arguments (`{"lab`) and a stock error result; a real provider may reject such a history (P2b). Only the fake model was used.
- Single process (R17), recovery before serving, and the provisional nature of the P2a-4 interlock are unchanged.
- The wording of `RUN_ERROR` and how the owner sees an interrupted answer with partial text (D3, the stale error banner) belong to P2a-6.

## 16. Evidence

`p2a-evidence/p2a3/`: `summary.json`, `open-text-before-kill.json`, `open-text-after-recovery.json`, `incomplete-tool-args-before-kill.json`, `incomplete-tool-args-after-recovery.json`, `no-lifecycle-before-kill.json`, `no-lifecycle-after-recovery.json`, `idempotent-restart.json`, `classification.json`, `fault-injection.json`, `stock-finalizer-observation.json`, `negative-controls.json`. Each case file records the writer, B, C and D PIDs, the crash signal, thread / run / message / tool-call ids, the events before the crash and after the recovery (with their JSON), the run status, the partial text, the tool invocation counts, the provider request counts, the write transaction counts, the logical hashes and the egress. No credential or secret is stored.

## 17. Files changed (all scratch, all untracked)

| File                                               | Change                                                                                                                                                     |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/p2a/sqlite-runner.ts`                       | revised: the three classes, new deferral reasons, stock-verbatim closure (P2a-5 version `80622f8a…`; +72 / −16 lines; now `4c137761…`)                     |
| `tests/p2a/p2a3-proc.ts`                           | new: process roles W (T1, T2, T3), B, C, D, N                                                                                                              |
| `tests/p2a/p2a3.test.ts`                           | new: orchestrator, classification matrix, stock-finalizer observation, fault injection (18 tests)                                                          |
| `tests/p2a/fake-model.ts`                          | backward-compatible additions: `[[args-partial]]` and `[[hold-request:<name>]]`                                                                            |
| `tests/p2a/p2a4.test.ts`, `tests/p2a/p2a5.test.ts` | the deferral cases that P2a-3 now recovers were changed to assert the new recovery (three P2a-4 guard entries; the P2a-5 "arguments still streaming" case) |
| `docs/LOCAL_FIRST_P2A3_ACCEPTANCE.md`              | new: this document                                                                                                                                         |
| `p2a-evidence/p2a3/*`                              | new (section 16)                                                                                                                                           |

`harness.ts`, `p2a4-tool.ts`, the P2a-0 / 8a / 1 / 8b / 2 tests and `p2a-evidence/golden/*` were **not** changed. At execution time no tracked file in any worktree changed and the main worktree was not touched; this document was copied to the main worktree afterwards, without the scratch files above.

## 18. P2a-3 verdict

```text
P2a-3: PASS
```

## 19. Server tool, client tool, text and run-start recovery side by side

| Crash                               | Recovery                                            | Class    |
| ----------------------------------- | --------------------------------------------------- | -------- |
| server tool, END durable, no result | unknown-outcome result + `RUN_ERROR`; `interrupted` | P2a-4    |
| client tool pending after END       | `RUN_FINISHED`; `finished`                          | P2a-5    |
| tool arguments incomplete           | stock closure; `interrupted`                        | P2a-3 T2 |
| open text                           | `TEXT_MESSAGE_END` + `RUN_ERROR`; `interrupted`     | P2a-3 T1 |
| `RUN_STARTED` only                  | `RUN_ERROR`; `interrupted`                          | P2a-3 T3 |

## 20. What this does not decide

How an interrupted answer with partial text, and the `RUN_ERROR` in the history, are shown to the owner (the stale error banner, working default D3); live-provider acceptance; mixed states; complete-text-without-terminal; multi-process writers.

## 21. GO / HOLD

```text
P2a-6: GO
```

**GO for P2a-6** (`RUN_ERROR` and stop recovery, and the stale error banner), the next step in the design's recommended order; it is a recommendation only and P2a-6 was not started. P2a-6 inherits the `RUN_ERROR(INCOMPLETE_STREAM)` terminal that every P2a-3 / P2a-4 recovery writes (D2 / D3) and the open residual `unclassified_lifecycle`. P2a-7 follows.
