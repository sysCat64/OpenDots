# Local-first P2a-4 acceptance: server-tool lifecycle across a real `SIGKILL`

**Status:** P2a-4 was **executed in a temporary scratch worktree** (`/private/tmp/opendots-p2a1.FV0LOx`, the P2a-1 / P2a-8b / P2a-2 worktree) and **PASSED**. **P2a-5 is GO but not started.** This document was afterwards **copied to the main worktree as closeout documentation**. The scratch runner, tests and raw evidence (`tests/p2a/*`, including `sqlite-runner.ts`, `p2a4-*.ts` and `p2a4.test.ts`, and `p2a-evidence/*`) remain in the scratch worktree and are **not** part of the main worktree. **Production integration has not been done; no production source, test, migration, dependency or configuration was changed.** The scratch runner is an observed candidate, not an approved production implementation. The PIDs, hashes and measurements below are the record of that execution.
**Baseline:** the scratch tree is detached at `aa2a4157fa3b99b3176bdd7ea99cd8fb4d77266a`. The main branch is at `50c57ae98483f4c33772c3ecb7608f745acc0b24`; `aa2a415..50c57ae` is documentation-only (section 1). P2a-0, P2a-8a, P2a-1, P2a-8b and P2a-2 are PASS.
**Scope:** P2a-4 only: a **server-side** tool, a real `kill -9` at three deterministic boundaries, and what the runner does about it on restart. HITL (client tool) recovery (P2a-5), text-streaming crash recovery (P2a-3), stop and error recovery, the stale error banner, 100-turn performance, provider continuation, P2b (live) and production integration were **not** started and are **not** accepted here.

## Verdict

```text
P2a-4: PASS
```

All sixteen PASS criteria hold. The generic contract was proved: after a `SIGKILL`, an interrupted run is closed **once**, in **one** transaction, as `interrupted`; a server tool call with no recorded result gets an explicit **"outcome unknown"** result (neither success nor failure); the tool is **never** re-run by the runner; and **the runner cannot tell Case A (no side effect) from Case B (side effect done)** from the conversation log alone. One **significant finding** came out of the running-row observation (R19): the framework itself re-executes a tool call that has no result in the history it is given (section 13). The scratch runner carries a **provisional safety interlock** for it (recover before a new run, and refuse a stale input); that interlock is **not an accepted production API or UX**, and the finding is carried forward as an open design item. **GO for P2a-5** (section 19). At execution time nothing was committed, pushed or tagged.

| #   | Criterion                                                                  | Result |
| --- | -------------------------------------------------------------------------- | ------ |
| 1   | Actual `SIGKILL` at deterministic crash boundaries                         | PASS   |
| 2   | Case A leaves no side effect but recovers generically as outcome unknown   | PASS   |
| 3   | Case B shows the side effect exists while the conversation result does not | PASS   |
| 4   | Case B recovery claims neither success nor failure                         | PASS   |
| 5   | No case automatically re-executes the tool                                 | PASS   |
| 6   | Case C keeps the already-durable `TOOL_CALL_RESULT` exactly once           | PASS   |
| 7   | Recovery produces a valid, closed event history                            | PASS   |
| 8   | The recovered run is no longer `running`                                   | PASS   |
| 9   | Recovery is DB-persisted and idempotent across another process restart     | PASS   |
| 10  | Recovery does not call the provider                                        | PASS   |
| 11  | Generic recovery does not depend on the side-effect oracle                 | PASS   |
| 12  | Server-tool logic is not silently applied as accepted HITL behaviour       | PASS   |
| 13  | P2a-0 / 8a / 1 / 8b / 2 regressions stay green                             | PASS   |
| 14  | Golden fixtures unchanged                                                  | PASS   |
| 15  | No unexpected external egress                                              | PASS   |
| 16  | Main worktree status remains `?? mise.toml`                                | PASS   |

## 1. Environment and baseline

| Item                     | Value                                                                                                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node / npm               | **v24.14.1 / 11.11.0** (installed binary first on `PATH`; `mise.toml` not used)                                                                                                                                                             |
| OS / SQLite              | macOS 12.7.6 / SQLite 3.51.2 (bundled with `node:sqlite`)                                                                                                                                                                                   |
| Packages                 | `@copilotkit/runtime` / `core` 1.75.0; `@ag-ui/client` 0.0.59; `@tanstack/ai` 0.63.0; vitest 4.1.11; tsx. No `npm install`; `package.json` and the lock are untouched.                                                                      |
| Env                      | `COPILOTKIT_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`, asserted in the orchestrator and in every child process                                                                                                                                |
| Network                  | fake provider on `127.0.0.1` only; no OpenAI, SIWC, CopilotKit cloud, Slack, voice, Keychain, `.env` or external web; no external probe                                                                                                     |
| Documentation-only range | `git diff --name-only aa2a415 50c57ae` lists only files under `docs/` (`LOCAL_FIRST_P2A1_ACCEPTANCE.md`, `LOCAL_FIRST_P2A2_ACCEPTANCE.md`, `LOCAL_FIRST_P2A8B_ACCEPTANCE.md`, `LOCAL_FIRST_P2A_DESIGN.md`). Checked by test 0 on every run. |
| Production diff          | none: `git diff 50c57ae -- src package.json package-lock.json` is empty and `package.json` / `package-lock.json` are byte-identical to the ones at `50c57ae`; the scratch tree has no modified tracked file                                 |

## 2. Scratch worktree and files

`/private/tmp/opendots-p2a1.FV0LOx` (detached at `aa2a415`). New or changed files (all untracked) are listed in section 22. `harness.ts` gained one backward-compatible option (`agent`: a scratch agent instead of `DotAgent`); `fake-model.ts` gained the `[[p2a4]]` and `[[hold-after-tool:<name>]]` markers and a `toolContents` field on the recorded request.

## 3. Server-tool methodology

- **Real pipeline, no production change.** `P2a4Agent` (scratch) wraps the **real `BuiltInAgent` + TanStack `chat()`** against the fake OpenAI-compatible model, exactly as `DotAgent` does, with **one extra server tool**, `p2a4_side_effect`. The runtime, the real CopilotKit client, the scratch runner and the event conversion are the real ones. The produced events have the shape of golden G1: `RUN_STARTED, TOOL_CALL_START, TOOL_CALL_ARGS, TOOL_CALL_END, TOOL_CALL_RESULT, TEXT_MESSAGE_*, RUN_FINISHED`. `DotAgent` and every production tool are untouched.
- **Processes.** Every role is a separate Node process on one database file: **W** (writer, killed), **B** (recovery), **C** (recovery again), **D** (a new turn after recovery, the only role that reaches the model), **N** (a request that arrives before any recovery, section 13).
- **Boundaries used.** The tool waits until its own `TOOL_CALL_END` is **durable** (a database check, not a delay), so each gate sits at an exact point of the conversation log.

## 4. Side-effect oracle

Two **test-only** tables live in the scratch database next to the conversation tables: `p2a4_tool_attempts` (one row at every tool invocation) and `p2a4_side_effect_receipts` (one row per execution of the side effect, committed on its own). They exist **only so the test can know what really happened**. A second execution leaves a second receipt, so a re-execution is visible. **The runner never reads them** (test 9: its source contains no mention of the oracle, receipts or the tool; and Cases A and B, with opposite oracle states, produce identical recovery).

## 5. Crash gates and the `SIGKILL` proof

| Gate | Where the writer stops                                                                           | How the orchestrator knows                                                                 |
| ---- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| A    | `TOOL_CALL_END` durable, **before** the side effect is committed                                 | a marker file written by the tool, then a database check through a **separate** connection |
| B    | the side effect **committed**, the tool has **not** returned, `TOOL_CALL_RESULT` not emitted     | the same, plus the receipt is visible from the other connection **before** the kill        |
| C    | `TOOL_CALL_RESULT` durable, **before** any terminal event (the fake model holds the next answer) | the second model request arrives, then the `TOOL_CALL_RESULT` row is seen in the database  |

No timing guess decides any gate. Without the test hooks nothing changes: the tool and the fake model behave normally.

**`SIGKILL`.** The orchestrator sends `SIGKILL` itself (`child.kill('SIGKILL')`). In all five crashes the child's exit was `{code: null, signal: "SIGKILL"}`, the PID no longer existed, and the database (conversation rows and logical hash) was **identical before and after the kill**. No graceful shutdown, no exception and no `process.exit` was used.

| Case        | Writer PID    | Marker reached             | Run status at the crash | Rows at the crash                                   | Receipts | Tool attempts | Provider requests |
| ----------- | ------------- | -------------------------- | ----------------------- | --------------------------------------------------- | -------: | ------------: | ----------------: |
| A           | 56084         | `gate-A`                   | `running`               | `RUN_STARTED, TOOL_CALL_START, ARGS, TOOL_CALL_END` |    **0** |             1 |                 1 |
| B           | 56088         | `gate-B`                   | `running`               | the same four                                       |    **1** |             1 |                 1 |
| C           | 56092         | `model-request-after-tool` | `running`               | the four plus `TOOL_CALL_RESULT` (5 rows)           |        1 |             1 |                 2 |
| R19u / R19s | 56120 / 56128 | `gate-B`                   | `running`               | as B                                                |        1 |             1 |                 1 |

(The PIDs are those of the final run recorded in `p2a-evidence/p2a4/summary.json`; each rerun records new ones.)

## 6. Exact recovery event representation, and why it asserts neither success nor failure

**What the installed types allow** (read in `@ag-ui/core` 0.0.59 and `@ag-ui/client` 0.0.59):

- `TOOL_CALL_RESULT` = `{type, messageId: string, toolCallId: string, content: string, role?: "tool", subagentRunId?, timestamp?, rawEvent?, metadata?}`; the schema is `passthrough`. **`content` is a free-form string.**
- The client reducer (`defaultApplyEvents`) turns it into a tool message `{id: messageId, toolCallId, role: "tool", content}` placed after the assistant message that holds the call. It sets no `error` and applies no status.
- The stock finalizer (`@copilotkit/shared`, used by the reference runner) closes a call that has no result with `TOOL_CALL_RESULT {messageId: "<toolCallId>-result", role: "tool", content: JSON.stringify({status: "error", reason: "missing_terminal_event", message})}` and then `RUN_ERROR {code: "INCOMPLETE_STREAM"}` (or `{status: "stopped", …}` and `RUN_FINISHED` for a stop). The `status` and `reason` keys and values are **a CopilotKit convention inside `content`**, and `"error"` **asserts a failure**.

**Choice.** The runner uses the stock finalizer only for the **structure** (closers and the terminal event) and **replaces its synthetic result before anything is persisted**. The stock error result is never written. A server tool call with no recorded result gets exactly:

```json
{
  "type": "TOOL_CALL_RESULT",
  "toolCallId": "<the call>",
  "messageId": "<the call>-unknown-outcome",
  "role": "tool",
  "content": "{\"outcome\":\"unknown\",\"reason\":\"run_interrupted\",\"message\":\"The run was interrupted before the result of this tool call was recorded. The tool may or may not have run. Do not assume that it succeeded or that it failed, and do not retry it automatically: verify its effect before retrying.\"}"
}
```

followed by the ordinary terminal of an interrupted run:

```json
{
  "type": "RUN_ERROR",
  "message": "Run interrupted: the server process ended before the run finished.",
  "code": "INCOMPLETE_STREAM"
}
```

and the run row becomes `status = interrupted`. The `content` JSON (`outcome`, `reason`, `message`) is **a scratch candidate, not a protocol value**: AG-UI fixes only that it is a string. It has no `status` and no `error` key (asserted), it says the tool "may or may not have run", and it tells the model to verify before retrying. The final wording, and whether a machine-readable marker is wanted, are later design decisions.

**Why a result at all (and not just a closed call).** A history in which an assistant tool call has no tool message is not usable by the next model request, and the framework acts on it (section 13).

## 7. Case A: after `TOOL_CALL_END`, before the side effect

At the crash: four rows, run `running`, **0 receipts**, 1 attempt. Recovery in process B appended exactly the two events of section 6. **The runner did not know that no side effect had happened** and did not assert it: the recovery is the generic "outcome unknown". Afterwards: six rows (the four unchanged plus the two), status `interrupted`, `isRunning` false, the thread appears in `listThreads` (it was not listed while its run was `running`), 0 receipts, 1 attempt, **0 provider requests**.

## 8. Case B: the side effect is committed, `TOOL_CALL_RESULT` is not durable (the centre)

At the crash: the **same four rows**, run `running`, **1 receipt**, visible from a **separate** connection before the kill, and no `TOOL_CALL_RESULT` row. Recovery appended **the same two events as in Case A**. After recovery: 1 receipt (the same row), 1 attempt: **the tool was not run again**, and the conversation does not say it succeeded or failed.

**The generic runner cannot tell A from B** (test 3b, asserted): the two conversation logs that survived the crash are equal (same event types, tool name and arguments; only generated ids differ), and the recovery decision and the appended events are **deep-equal**, while the oracle is opposite (0 receipts against 1). So the conversation log alone cannot say whether the effect happened, and the runner, which never reads the oracle, treats both the same.

## 9. Case C: `TOOL_CALL_RESULT` already durable

At the crash: five rows including the real result `{"done":true,"label":"p2a4"}`, 1 receipt. Recovery appended **only** `RUN_ERROR(INCOMPLETE_STREAM)`: no synthetic result and no `-unknown-outcome` message exists. The stored `TOOL_CALL_RESULT` row is **byte-for-byte the same text** before and after, and there is exactly one `TOOL_CALL_RESULT` in the run. The run is `interrupted`. 1 receipt, 1 attempt, 0 provider requests. The tool message the browser holds and the one the next model request carries is the **real** result.

## 10. Recovery transaction and exactly-once

- `ready()` calls `recoverInterruptedRuns()`: it selects runs whose status is `running` and that this process is not running itself, decides **from the stored events alone** whether the run is one it may close, and then, in **one synchronous `BEGIN IMMEDIATE … COMMIT`**, re-checks the status, appends the missing closure, the unknown-outcome result(s) and the terminal event, and updates the status to `interrupted`. No `await` is inside it. The message cache is rebuilt afterwards (outside the transaction; a crash in between is repaired by the next boot).
- **Measured:** process B's boot used **2 write transactions** in every case that B recovered (A, B, C and R19u): 1 recovery + 1 cache rebuild. In R19s the recovery had already happened inside the new run, and B's boot used 0.
- **Atomicity (fault injection, test 10).** A trigger that raises on the terminal event makes the recovery fail after its first appended event: **everything was rolled back** (no result, no terminal, still `running`, 0 committed transactions). With the fault removed the next attempt applied the recovery **in 1 transaction**, and a further call found nothing and wrote nothing. This test uses a simulated abandonment, **not** a `SIGKILL`, and is not crash evidence.
- **Exactly once is decided from the database**, not from a process flag: only `status = running` rows qualify, and the status flips in the same transaction as the events. The database holds one `RUN_ERROR` per recovered run and at most one unknown-outcome result per pending call.

## 11. Idempotence across another restart

Process C (a new PID, same database, a new runner) after B, in every case: **no recovery record, 0 write transactions**, `ready()` `{checked: 1, rebuilt: 0}`; events, run status, tool-result and unknown-marker counts, receipts and attempts, and the **logical database hash** (conversation tables, plus the run timing hash) are **identical** to the state after B, and a third read by the orchestrator agrees; 0 provider requests.

| Case | Logical SHA-256 after B = after C                                  |
| ---- | ------------------------------------------------------------------ |
| A    | `76a5bbaadcf81e2d12f93d71d0760bf0eb182e200b36e434d58ffd99b1f9d73f` |
| B    | `451d5a555e4d72d28ad3da4f84ea2f0032596e0c3decf11a2655fa5bdd5dc53d` |
| C    | `5006dc3a95efb85528449e378f15addf3b7081d2f7fa9b015b1dffd106f74984` |
| R19u | `620690495bec37823841aba4896139604432e2c888a1dc044e8f7787d263f52e` |
| R19s | `e6e3f334c3902103c55dc5b7a3b3f0d46d1c78ca6450f98425defd79bdc67f1d` |

(Pre-crash hashes, row counts and the rest are in the per-case evidence. The hash covers rows with random ids and timestamps, so it differs from run to run; the assertions compare values within one run.)

## 12. No automatic retry; the side-effect receipt observations

| Measure                                                          | A         | B         | C         |
| ---------------------------------------------------------------- | --------- | --------- | --------- |
| Tool invocations (attempts) before the crash                     | 1         | 1         | 1         |
| After recovery by B and after C                                  | 1 and 1   | 1 and 1   | 1 and 1   |
| After the **next turn** after recovery (process D)               | 1         | 1         | 1         |
| Receipts before the crash / after recovery / after the next turn | 0 / 0 / 0 | 1 / 1 / 1 | 1 / 1 / 1 |
| Provider requests during recovery (B and C)                      | 0 and 0   | 0 and 0   | 0 and 0   |

Process D, a new process that reloads the conversation and sends a **new turn**, reached the model exactly once (1 provider request) and the model request carried the history with the tool message: the **"outcome unknown" content** for A and B, the **real result** for C. The tool was not invoked again.

**Optional extra, not a PASS condition.** After recovery, the tool's **own** receipt table still says what really happened: no receipt for A, one for B, one for C. A tool-specific reconciler **could** therefore confirm the effect later from its own durable evidence. The generic runner recorded "outcome unknown" in A and B and kept the real result in C, and does not depend on any of it. No reconciler was built or designed.

## 13. The running row (R19), and a significant finding

**Observed (carried from P2a-2).** A crash leaves a run row with `status = running`; boot recovery detects it and closes it; afterwards the thread works normally (D's new turn: `[interrupted, finished]`). The thread is **not** blocked by the stale row.

**Finding: the framework re-runs a tool call that has no result in the history it is given.** In case **R19u** the first request after a Case-B crash arrived at a process that had **not** recovered the dead run (its own protection switched off for this observation). The client's history was the unrecovered log (an assistant tool call with no tool message). The new run's events began `RUN_STARTED, TOOL_CALL_RESULT, …`: **TanStack executed the unresolved call again** (a result with no `TOOL_CALL_START` in that run). The tool's attempts went from 1 to 2 and **its receipts from 1 to 2: a double side effect.** So "never re-execute" is not only about the runner's own code: it also requires that the history handed to the agent never contains an unresolved server tool call whose result the log already holds.

**What the scratch runner does about it.** `run()` first recovers that thread's dead runs, then **refuses an input that leaves out a tool result the durable log holds** as a `TOOL_CALL_RESULT` event (`STALE_TOOL_HISTORY`, thrown synchronously before anything is written or executed). In case **R19s** the same request: the stale run was recovered inside `run()` (the same two events as Case B), the request was **refused** (the client's history was `[user, assistant]`; 0 events, 0 provider requests, attempts and receipts unchanged at 1 and 1, run `interrupted`); the client **reloaded**, now saw `[user, assistant, tool]`, and the same turn went through (the model received the unknown-outcome message; the framework executed nothing; attempts and receipts still 1 and 1). The later boot found nothing to do (0 recovery records, 0 transactions).

Unit check (test 12b): an input missing the tool message of call X is refused when the durable log holds a `TOOL_CALL_RESULT` for X (the agent is never started, the database is unchanged); the true history is accepted; and the **client-tool (HITL) flow is unaffected**, because a human's result is a tool **message** in the input, not a `TOOL_CALL_RESULT` event.

**This is a provisional scratch safety interlock, not an accepted production API or UX.** The code name `STALE_TOOL_HISTORY` and the way the refusal is shown are **not** a production contract and must not be fixed by this document. It is an observed candidate and an open design item (section 20): the refusal reaches the browser as an empty stream like every rejected run, a stale browser tab must reload, and the protection covers only results the log holds.

## 14. Server tool versus client tool (HITL): the guard

The recovery is a **server-tool-only** logic. A tool call counts as a **client** tool when its name is in the `tools` the browser declared in the **persisted `RUN_STARTED.input`**; every other tool is a server tool. A `running` run is **not** closed, and nothing is written for it (not even an empty transaction), when it is any of: `client_tool_pending` (P2a-5), `tool_args_incomplete`, `open_text_message`, `no_tool_lifecycle` (P2a-3), `terminal_already_present`. They stay `running`, are reported on every boot (`notes.recovery`), and do not block the thread.

Tests (simulated abandonment, **not** crash and **not** HITL acceptance): each of the four reasons deferred with **0 write transactions**, the logical hash unchanged, the status still `running`, and the thread still accepting a new run. **Client-tool behaviour remains unaccepted (P2a-5).** The negative control M6 removes the guard and the client-tool test goes red.

## 15. Replay and reducer

After recovery, for every case: the runner's `connect`, the runtime's HTTP replay and `getThreadEvents` all equal `compactEvents` of the stored events; the event sequence passes the AG-UI `verifyEvents` (a valid, **closed** run); `isRunning` is false; `listThreads` lists the thread; the cache equals the reducer's derivation; and the real client rebuilds `[user, assistant, tool]` where the assistant holds the one call and the tool message holds the unknown-outcome content (A, B) or the real result (C). No tool call stays open for the browser or for the next model request. The display wording is not fixed here.

## 16. Negative controls

Eight temporary mutations of `sqlite-runner.ts`, each run against the full P2a-4 test and each **reverted** (restored and compared byte-for-byte by hash after every run; the final runner is the `36f00134…66d4dd` version).

| Mutation                                                                                  | Tests that went red                                                                         |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| M1 recovery **re-executes** the ambiguous tool                                            | 7: Cases A and B, no-retry, R19, oracle independence, the optional receipt check, atomicity |
| M2 an ambiguous call is finalized as a **plain failure** (the stock error result is kept) | 4: Cases A and B, idempotence, R19                                                          |
| M3 recovery is **re-applied every restart**                                               | 3: idempotence, one transaction, atomicity                                                  |
| M4 Case C: a **synthetic result is added** next to the durable one                        | 3: Case C, idempotence, R19                                                                 |
| M5 the run is **left `running`**                                                          | 7                                                                                           |
| M6 the server-tool recovery is applied to a **client (HITL) tool** (guard removed)        | 1: the client-tool guard                                                                    |
| M7 a new run is **not protected** (no recover-before-run, no stale-history refusal)       | 4: one transaction, no retry, R19, stale-history unit                                       |
| M8 the **stale-history refusal** is removed                                               | 3: no retry, R19, stale-history unit                                                        |

Details: `p2a-evidence/p2a4/negative-controls.json`. The mutated runs wrote their evidence elsewhere (`P2A4_OUT`), which was deleted, so they could not overwrite the real evidence. M1 is expressed as an extra call to the test tool's side-effect function from the runner, which is what a re-executing recovery would do to the oracle.

## 17. Regressions

| Check                                                                                                              | Result                               |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| `tests/p2a` as a whole, file by file: `golden` 12, `reasoning-drop` 5, `p2a1` 19, `p2a8b` 15, `p2a2` 21, `p2a4` 19 | **91 / 91 passed**, 6 files          |
| Golden fixtures, 17 files (`raw/*`, `normalized/*`, `manifest.json`) vs the SHA-256 list taken before P2a-2        | **identical**; nothing was rewritten |
| The revised runner against P2a-2 (`p2a2` 21/21), P2a-1 (`p2a1` 19/19, G0 strict) and P2a-8b (15/15)                | green                                |
| `prettier --check tests/p2a docs/LOCAL_FIRST_P2A4_ACCEPTANCE.md`, `git diff --check`                               | clean                                |

The P2a-2 evidence directory was regenerated by the same full run (new PIDs); its documented numbers refer to the run in which they were recorded.

## 18. External egress

Server-process instrumentation of `fetch` and socket connect (`127.0.0.1` allowed, everything else refused and recorded): **0 fetches and 0 connects** in the orchestrator, in every recovery/new-turn/N process (B, C, D, N), and in each writer **at the moment it reached its gate** (the writers were then killed and could not report later). No external probe was made. This measures what these processes attempted; it is not an operating-system-level guarantee.

## 19. Verdict and recommendation

```text
P2a-4: PASS
P2a-5: GO
```

The generic contract held across five real `SIGKILL`s. **GO for P2a-5** (pending HITL across a process restart), the next step in the design's recommended order; it is a recommendation only and P2a-5 was not started. P2a-5 inherits: the `client_tool_pending` deferral seam (such a run stays `running` and is untouched), the rule that a human's tool result is a tool **message** in the input (not a `TOOL_CALL_RESULT` event), and the D2 working default for the "client tool call ended, `RUN_FINISHED` not yet written" micro-window. P2a-3 stays after P2a-5, as in the design.

## 20. Deviations, surprises and open questions

**Deviations and surprises**

1. **The framework executes unresolved tool calls from history** (section 13). This was not expected and changed the scope of "no automatic retry". The scratch protections (recover-before-run, `STALE_TOOL_HISTORY`) were added in P2a-4 for it; they are candidates, not decisions.
2. The stock finalizer's synthetic tool result **asserts failure** (`status: "error"`); it is not used for a server tool whose outcome is unknown. The representation chosen is a scratch candidate (section 6).
3. `ready()` keeps its P2a-1 return shape `{checked, rebuilt}`; the recovery decisions are in `runner.notes.recovery`.
4. A recovered run's `finished_at` is the **recovery** time, not the crash time.
5. The side-effect oracle tables live in the same database file as the conversation tables (scratch convenience).
6. The atomicity and guard tests use a **simulated abandonment** (a runner that is closed in mid-run), not a `SIGKILL`; they are not counted as crash evidence.

**Open issues (carried forward)**

- **Stale input.** A refused run reaches the browser as an empty stream (as every rejected run does); how the owner sees "reload and send again" is a UX decision. The refusal covers results the log holds as `TOOL_CALL_RESULT` events; whether to refuse, or to inject the durable result into the agent's input instead, is open. The protection must not depend on the browser being up to date.
- **Deferred runs that hold an unresolved server tool call** (for example a run that crashed with a pending server tool call and an open text message) are left `running` and are **not** closed by P2a-4; until P2a-3 / P2a-5 decide them, the framework could still re-execute such a call if a client sends a history that lacks its result.
- **Single process.** Recovery assumes that no other live process runs on the same database (R17): a second process would wrongly treat a live run as dead.
- **Recovery must complete before the server accepts requests** (`ready()` awaited before serving); `run()` repeats it for its own thread as a safety net.
- The "outcome unknown" wording, whether it carries a machine-readable marker, and how the model reacts to it (only a fake model was used) are undecided. A tool-specific reconciler is **not** designed.
- `tool_args_incomplete` (a crash while arguments streamed) is deferred to P2a-3: such a call cannot have run, but the generic runner does not claim it.
- Duplicate-run and stop/error recovery semantics are unchanged from P2a-2 and not evaluated here.

## 21. Evidence

`p2a-evidence/p2a4/`: `summary.json`, `case-a-before-effect.json`, `case-b-after-effect-before-result.json`, `case-c-result-durable.json`, `recovery-idempotence.json`, `r19-running-row.json`, `reconciliation-observation.json`, `negative-controls.json`. Each case file records the writer, B, C and D PIDs, the crash signal, thread / run / tool-call ids, the conversation rows (with the events) before the crash, the receipts and attempts before the crash, the rows after recovery, the exact recovery events, the run status, the tool invocation and provider request counts, the logical hashes, the transaction counts and egress. No credential or secret is stored.

## 22. Files changed (all scratch, all untracked)

| File                                              | Change                                                                                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/p2a/sqlite-runner.ts`                      | revised: `recoverInterruptedRuns`, recovery in `ready()`, recover-before-run and `STALE_TOOL_HISTORY` (P2a-2 version `9720f8bd…`; +268 / −3 lines; now `36f00134…`) |
| `tests/p2a/p2a4-tool.ts`                          | new: the test tool, the oracle tables and the scratch agent                                                                                                         |
| `tests/p2a/p2a4-proc.ts`                          | new: process roles W, N, B, C, D                                                                                                                                    |
| `tests/p2a/p2a4.test.ts`                          | new: orchestrator and in-process cases (19 tests)                                                                                                                   |
| `tests/p2a/fake-model.ts`, `tests/p2a/harness.ts` | backward-compatible additions (markers and `toolContents`; the `agent` option)                                                                                      |
| `docs/LOCAL_FIRST_P2A4_ACCEPTANCE.md`             | new: this document                                                                                                                                                  |
| `p2a-evidence/p2a4/*`                             | new (section 21)                                                                                                                                                    |

The P2a-0 / 8a / 1 / 8b / 2 tests and `p2a-evidence/golden/*` were **not** changed. At execution time no tracked file in any worktree changed and the main worktree was not touched; this document was copied to the main worktree afterwards, without the scratch files above.
