# Local-first P2a-5 acceptance: a pending HITL (`review_space_page`) across a process restart

**Status:** P2a-5 was **executed in a temporary scratch worktree** (`/private/tmp/opendots-p2a1.FV0LOx`, the P2a-1 / P2a-8b / P2a-2 / P2a-4 worktree) and **PASSED**. **P2a-3 is GO but not started.** This document was afterwards **copied to the main worktree as closeout documentation**. The scratch runner, tests and raw evidence (`tests/p2a/*`, including `sqlite-runner.ts`, `p2a5-proc.ts` and `p2a5.test.ts`, and `p2a-evidence/*`) remain in the scratch worktree and are **not** part of the main worktree. **Production integration has not been done; no production source, test, migration, dependency or configuration was changed.** The scratch runner is an observed candidate, not an approved production implementation. The PIDs, hashes and measurements below are the record of that execution.
**Baseline:** the scratch tree is detached at `aa2a4157fa3b99b3176bdd7ea99cd8fb4d77266a`. The main branch is at `26c0f31188bf11b82c3cc42261655d79725eec35`; `aa2a415..26c0f31` is documentation-only (section 1). P2a-0, P2a-8a, P2a-1, P2a-8b, P2a-2 and P2a-4 are PASS.
**Scope:** P2a-5 only: a pending human-in-the-loop (HITL) tool call, across a normal process restart (H1) and across a real `SIGKILL` in the window between `TOOL_CALL_END` and `RUN_FINISHED` (H2). Text-streaming crash recovery and incomplete tool arguments (P2a-3), stop and error recovery, the stale error banner, 100-turn performance, provider continuation, P2b (live) and production integration were **not** started and are **not** accepted here.

## Verdict

```text
P2a-5: PASS
```

All sixteen PASS criteria hold. A finished, pending HITL run is rebuilt after a process restart without executing anything or writing anything, and a fresh client can resolve it as a **new run**; after a real `SIGKILL` in the micro-window, the restart repairs the run to the **canonical pending form** by appending **only `RUN_FINISHED`** (status `finished`), which equals the reference golden G2, and the approval then works exactly as in H1. The approved G3 divergence (`[tool]` stored, `[assistant, tool]` in the reference) is unchanged and asserted. The P2a-4 server-tool behaviour did not regress, and the two recoveries are different branches. **GO for P2a-3** (section 20). At execution time nothing was committed, pushed or tagged.

| #   | Criterion                                                                            | Result |
| --- | ------------------------------------------------------------------------------------ | ------ |
| 1   | A normal finished pending HITL is rebuilt after a process restart                    | PASS   |
| 2   | Restart and connect alone cause no provider request and no tool execution            | PASS   |
| 3   | A fresh client can functionally resolve the pending decision                         | PASS   |
| 4   | The human result is sent as a new run                                                | PASS   |
| 5   | Run 2's durable input is `[tool]` (the approved divergence)                          | PASS   |
| 6   | A real `SIGKILL` produces `TOOL_CALL_END` durable / `RUN_FINISHED` absent            | PASS   |
| 7   | Micro-window recovery repairs to the canonical pending form with `RUN_FINISHED` only | PASS   |
| 8   | Micro-window recovery adds no `TOOL_CALL_RESULT`                                     | PASS   |
| 9   | Micro-window recovery adds no `RUN_ERROR` and no unknown outcome                     | PASS   |
| 10  | The recovered pending decision can be approved after the restart                     | PASS   |
| 11  | The page / effect happens exactly once                                               | PASS   |
| 12  | A second restart does not re-apply the recovery                                      | PASS   |
| 13  | The P2a-4 server-tool unknown-outcome behaviour does not regress                     | PASS   |
| 14  | P2a-0 / 8a / 1 / 8b / 2 / 4 regressions are green                                    | PASS   |
| 15  | No unexpected external egress                                                        | PASS   |
| 16  | The main worktree status remains `?? mise.toml`                                      | PASS   |

## 1. Environment and baseline

| Item                     | Value                                                                                                                                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node / npm               | **v24.14.1 / 11.11.0** (installed binary first on `PATH`; `mise.toml` not used)                                                                                                                             |
| OS / SQLite              | macOS 12.7.6 / SQLite 3.51.2 (bundled with `node:sqlite`)                                                                                                                                                   |
| Packages                 | `@copilotkit/runtime` / `core` 1.75.0; `@ag-ui/client` 0.0.59; `@tanstack/ai` 0.63.0; vitest 4.1.11; tsx. No `npm install`; `package.json` and the lock are untouched.                                      |
| Env                      | `COPILOTKIT_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`, asserted in the orchestrator and in every child process                                                                                                |
| Network                  | fake provider on `127.0.0.1` only; no OpenAI, SIWC, CopilotKit cloud, Slack, voice, Keychain, `.env` or external web; no external probe                                                                     |
| Documentation-only range | `git diff --name-only aa2a415 26c0f31` lists only files under `docs/`. Checked by test 0 on every run.                                                                                                      |
| Production diff          | none: `git diff 26c0f31 -- src package.json package-lock.json` is empty and `package.json` / `package-lock.json` are byte-identical to the ones at `26c0f31`; the scratch tree has no modified tracked file |

## 2. The real path that was used, and what was not

**Used (real):** the real CopilotKit client (`ProxiedCopilotRuntimeAgent`), the real `CopilotSseRuntime` handler, the scratch runner, the **real `DotAgent`**, the fake OpenAI-compatible model, and the **real client-side tool contract**: the client declares `review_space_page` (`pageReviewTool`, the production definition) in `tools` on every run. The approval is the server call the review card makes through the REST route, `workspace.pages.createReviewed(spaceId, draft, threadId, toolCallId)` (idempotent per thread and tool call), followed by the human result sent back as a **tool message** and a new `runAgent`, exactly as the P2a-0 G3 scenario does.

**Not used / not verified:** the REST route itself (`POST /conversations/:id/reviewed-page`) was not called over HTTP (the same `createReviewed` call was made in process); the React `PageReviewCard` was **not** rendered, so **visual card rendering was not verified**. The required condition is functional actionability (section 6), not rendering.

## 3. Client-tool classification

How `review_space_page` is known to be a client-side tool, from the installed pipeline and the existing evidence:

- The browser **declares** it: golden G2's persisted `RUN_STARTED.input.tools` is `["review_space_page"]`, and so is the one the scratch runner persisted in H1 and H2.
- The server **has no executor** for it: no server tool of that name exists (`src/server/page-tools.ts` does not contain it), `DotAgent` only forwards the declared `pageReviewTool` to the model loop, so the loop ends at the call. The H1 run therefore ends `RUN_STARTED, TOOL_CALL_START, TOOL_CALL_ARGS, TOOL_CALL_END, RUN_FINISHED` with **no `TOOL_CALL_RESULT`**, identical to G2.
- **The recovery uses the persisted contract, not the name** (test 12): two interrupted runs with a tool of the same name `review_space_page` were recovered differently. The run whose input **declared** it was repaired as a pending HITL; the run whose input did **not** declare it was closed as a server tool left without a result (unknown-outcome result, `RUN_ERROR`, `interrupted`). No tool name is hard-coded in the recovery.

Because the two kinds can be told apart from stored data, no guess was needed (the case was not BLOCKED).

## 4. Runner revision (scratch)

`tests/p2a/sqlite-runner.ts` (P2a-4 version sha256 `36f00134…66d4dd`, now `80622f8a…37615a2`; +54 / −12 lines).

| Change                  | P2a-4                                                                                                    | P2a-5                                                                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pending client call     | a run with only a pending client tool call was **deferred** (`client_tool_pending`) and stayed `running` | **repaired to the canonical pending form**: `RUN_FINISHED` is appended, nothing else, status `finished`; the record has `kind: client_hitl_pending` |
| Pending server call     | unknown-outcome result + `RUN_ERROR`, `interrupted`                                                      | unchanged; the record has `kind: server_unknown_outcome`                                                                                            |
| Pending client + server | (deferred through the client case)                                                                       | deferred as `mixed_pending_tool_calls`: not decided, nothing written                                                                                |
| Test-only gate          | none                                                                                                     | `beforePersist` option: awaited before an event is persisted; **with no hook the run path is byte-for-byte the old one**                            |

One P2a-4 **test** was changed on purpose, because P2a-5 settles what P2a-4 had deferred: the guard case "a pending client tool call is deferred" (P2a-4 test 11, first entry) is replaced by test 11a, which asserts the new repair. The other three P2a-4 deferrals (`tool_args_incomplete`, `open_text_message`, `no_tool_lifecycle`) are unchanged. The P2a-4 negative control M6 (removing the client guard) belonged to the old code path and is superseded by P2a-5's N1.

## 5. H1: a normal pending run across a restart

Processes: **W1** (PID 82616) writes run 1 and **exits cleanly**; **B** (PID 82641), a new process on the same database, only restarts and reads; **D** (PID 82666), another new process, resolves the decision.

**Run 1** (process W1): `RUN_STARTED, TOOL_CALL_START, TOOL_CALL_ARGS, TOOL_CALL_END, RUN_FINISHED`, status `finished`, no `TOOL_CALL_RESULT`, no `RUN_ERROR`, no unknown outcome; 1 provider request; 0 pages.

**Restart (B), connect only:**

| Check                                                     | Result                                                                                                                                                          |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider requests / runner `run()` calls (tool execution) | **0 / 0**                                                                                                                                                       |
| Recovery records, boot-time write transactions            | **0 and 0** (`ready()` `{checked: 1, rebuilt: 0}`)                                                                                                              |
| Logical database hash before and after                    | identical: `bf8ac9ba7c63828823e71ae660de717dce2bb16b40bfe368fc5ae6e3faa42e16`                                                                                   |
| Pages / effects                                           | 0                                                                                                                                                               |
| `connect`, `getThreadEvents`, HTTP replay                 | the five events (compacted); `verifyEvents` accepts them                                                                                                        |
| `getThreadMessages`                                       | `[user, assistant{toolCalls: [call-review_space_page]}]`, equal to the reducer's derivation                                                                     |
| `isRunning` / `getThreadState` / `listThreads`            | false / null / lists the thread                                                                                                                                 |
| A **fresh real client** (`connectAgent`)                  | holds `[user, assistant{toolCalls}]` and recognises **one pending call**: `call-review_space_page`, `review_space_page`, arguments valid for `pageReviewSchema` |
| **Strict G2**                                             | the restart snapshot equals the reference golden `hitl-pending` snapshot **strictly**, whole object, after only the identifier and timestamp normalisation      |

## 6. Functional actionability, the human result, and G3

Process D (fresh client, after `ready()`): it finds the pending call, calls `createReviewed` (and once more, as a retry), and sends the human result back as a **tool message** `{role: "tool", toolCallId, content: {approved, pageId, spaceId, url}}` with a **new `runId`** (`c3279387…`, not run 1's). Nothing about it became an event: run 2's events are `RUN_STARTED, TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT, TEXT_MESSAGE_END, RUN_FINISHED` and contain **no `TOOL_CALL_RESULT`**.

| Check                                               | Result                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run 2 **request** input (what the real client sent) | `[user, assistant, tool]`                                                                                                                                                                                                                                                                                                    |
| Run 2 **durable** `RUN_STARTED.input.messages`      | **`[tool]`**: the approved divergence (the reference stores `[assistant, tool]`)                                                                                                                                                                                                                                             |
| Page / effect                                       | 0 pages before, **1 after**, one `page_reviews` row; the retried `createReviewed` returned the same page                                                                                                                                                                                                                     |
| Final continuation                                  | exactly **one** assistant text message (`Review outcome received: …`); the thread is `[user, assistant{toolCalls}, tool, assistant]`, ids unique                                                                                                                                                                             |
| Run statuses                                        | `[finished, finished]`; 1 provider request (run 2 only)                                                                                                                                                                                                                                                                      |
| Strict G2 and G3 across the restart                 | the pending capture equals the golden `hitl-pending` file strictly; the resume capture equals the golden `hitl-resume` file strictly **after the approved divergence is applied to the reference golden** (the same five places as in P2a-2), and the un-transformed comparison fails, so the divergence is real, not hidden |

The "functional actionability" evidence is: the fresh client recognised the pending call from its own state (an assistant tool call with no tool message), the call's arguments were valid, and the answer started a new, normal run. Rendering the card was not part of it (section 2).

## 7. H2: the micro-window under a real `SIGKILL`

**Gate (test-only, deterministic).** The scratch runner's `beforePersist` hook, used only in the writer process W2, blocks **before `RUN_FINISHED` is persisted**; `TOOL_CALL_END` had been persisted just before (a boundary event is persisted when it arrives). The hook writes a marker file; there is no delay or race.

**What the orchestrator saw, through a separate connection, before killing** (writer PID 82703): events `RUN_STARTED, TOOL_CALL_START, TOOL_CALL_ARGS, TOOL_CALL_END`; **`RUN_FINISHED` absent; `TOOL_CALL_RESULT` absent; run status `running`**; 0 pages; 1 provider request; database hash `ebef78c6b693e4313da47d48f8de586ebb5600eb62a547a9a989ef707418171c`. The orchestrator then sent `SIGKILL`; the child's exit was **`{code: null, signal: "SIGKILL"}`**, the PID was gone, and the database was identical before and after the kill.

## 8. The exact recovery representation

Process B (PID 82728, a new process) booted with `ready()`. The recovery record:

```json
{
  "outcome": "recovered",
  "kind": "client_hitl_pending",
  "pendingClientToolCalls": [
    {
      "toolCallId": "call-review_space_page",
      "toolCallName": "review_space_page"
    }
  ],
  "appended": [
    { "type": "RUN_FINISHED", "threadId": "<thread>", "runId": "<run>" }
  ]
}
```

The stored history is the four rows unchanged followed by exactly that one event, and the run row is `status = finished`. **Nothing else was appended:** no `TOOL_CALL_RESULT`, no `RUN_ERROR`, no unknown-outcome result, no tool execution, no provider request, no page. The event has exactly the shape of the `RUN_FINISHED` the agent would have emitted (golden G2: `{type, threadId, runId}`), so the repaired run is **the canonical pending run**, not an "interrupted" run.

**Why this is not the server-tool recovery.** A server tool call with no result is a call the server was executing, so its outcome is genuinely unknown (P2a-4). A pending **client** tool call is waiting for the **human**, not for the server: the run's real end state is "finished, waiting for a human result". The missing `RUN_FINISHED` is the only thing the crash removed. Closing it with an unknown-outcome result and `RUN_ERROR` would destroy the pending decision (it would put a tool message in the history before the human answered). This follows working default D2 of the design: the pending client-HITL micro-window is a special case and must not destroy the decision.

## 9. Comparison with the G2 golden

After the recovery, process B captured the thread with the same `snapshot()` the P2a-0 golden used (messages, compacted events, `listThreads` record, `connect` replay, the four HTTP projections, `isRunning`, state). After normalising **only identifiers and the thread record's timestamps**, the recovered snapshot **equals the golden G2 snapshot strictly** (whole object). The micro-window recovered history is therefore indistinguishable from a run that finished normally. (For H2 the first model request lived in the killed process, so only the snapshot, run 2 and the page are compared strictly; the model-call list is not compared in this flow.)

## 10. Recovery transaction

The recovery (append `RUN_FINISHED`, set `status = finished`) is **one synchronous `BEGIN IMMEDIATE … COMMIT`**, re-checked inside it, with no `await`. **Measured in two ways, which must not be confused:**

- **The recovery transaction is 1.** In the fault-injection test (14), a fault on the status change after `RUN_FINISHED` was inserted **rolled everything back** (rows and status unchanged, 0 committed transactions); with the fault removed the repair took **1 transaction**, and a further call found nothing and wrote nothing. (That test is a simulated abandonment, not a `SIGKILL`.)
- **The recovering boot used 2 write transactions** (process B, real `SIGKILL`): the recovery, then the **message-cache rebuild**, which is a separate transaction. A later boot used 0.

Logical hash before the recovery `ebef78c6…8171c`, after it `b8208153905c1f6c2eb72126e2d6475df3d0e88bc364ef1b672090787de4d53a`.

## 11. Idempotence across a second restart

Process C (PID 82753, a new process, same database): **0 recovery records, 0 recovery write transactions, 0 boot-time write transactions** (`ready()` `{checked: 1, rebuilt: 0}`); the logical hash is **identical** to the state after B (`b8208153…d53a`) and a third read by the orchestrator agrees; the stored rows are unchanged; `RUN_FINISHED` count **1**, `TOOL_CALL_RESULT` count **0**, `RUN_ERROR` count **0**; 0 provider requests; the pending call is still recognised. Whether the recovery is needed is decided from the **database** (`status = running`, and not run by this process), not from a process-local flag; the status flips in the same transaction as the event.

## 12. Approval after the recovered micro-window

Process D (PID 82790): the fresh client sees `[user, assistant{toolCalls}]` and the one pending call; the approval goes through exactly as in H1: new `runId`, request `[user, assistant, tool]`, durable input **`[tool]`**, no `TOOL_CALL_RESULT` event, **1 page / 1 review row** (a retried `createReviewed` returned the same page), one final assistant message, statuses `[finished, finished]`, final thread `[user, assistant, tool, assistant]` with unique ids, 1 provider request. Run 2, the thread snapshot after the approval and the page record equal the golden `hitl-resume` **strictly after the approved divergence is applied to the reference** (the model-call list is not compared in this flow). Database hash after the approval in H1: `97fbd20cdf5c33eff15e90fb9c8939b2c5fcfdae31a1891093a340101f8f670c`.

## 13. Interaction with the P2a-4 `STALE_TOOL_HISTORY` interlock

The provisional P2a-4 interlock (recover the thread's dead run before a new run; refuse an input that omits a tool result the log holds as a `TOOL_CALL_RESULT` event) **did not refuse the human result** in any approval (`rejected` is empty in H1, H2 and H2b). It could not: a human's result is a tool **message** in the next run's input, and the log holds **no `TOOL_CALL_RESULT` event** for a client tool call, so there is nothing for the input to "omit". No change to the interlock was needed and the double-side-effect protection of P2a-4 is intact. The negative control N5 shows what would break: a guard that also refused a tool message the log holds no result event for would make the approval impossible.

**H2b** (extra): a second process, killed in the same micro-window (writer PID 82815), received the approval **before any boot-time recovery** (process D2, PID 82840, no `ready()`). The history the client saw was the unrecovered log (`[user, assistant]`); `run()` first repaired the dead run (`RUN_FINISHED` only, `client_hitl_pending`), then accepted the human result; run 1 ended as the canonical five events, run 2's durable input was `[tool]`, 1 page, statuses `[finished, finished]`, nothing refused. The name `STALE_TOOL_HISTORY` is a scratch name and is not a production contract (as recorded after P2a-4).

## 14. The server-tool recovery does not regress

- The **P2a-4 suite was rerun unchanged apart from the one intended test replacement** (section 4), including its three **real `SIGKILL`** cases A, B and C and the R19 pair: all green. Server tool ambiguous recovery still gives the unknown-outcome result, `RUN_ERROR(INCOMPLETE_STREAM)` and `interrupted`; A and B are still indistinguishable from the log.
- The two branches are **different code paths with different outcomes** (tests 12 and 13, simulated abandonment, not crash evidence):

| Interrupted run                                      | Recovery                                                            | Status        |
| ---------------------------------------------------- | ------------------------------------------------------------------- | ------------- |
| a server tool call with no result                    | unknown-outcome `TOOL_CALL_RESULT` + `RUN_ERROR(INCOMPLETE_STREAM)` | `interrupted` |
| a pending **client** tool call                       | `RUN_FINISHED` only                                                 | `finished`    |
| a resolved server call **and** a pending client call | `RUN_FINISHED` only; the real server result is untouched            | `finished`    |
| a pending client call **and** a pending server call  | **deferred** (`mixed_pending_tool_calls`), nothing written          | `running`     |
| a client call whose arguments were still streaming   | **deferred** (`tool_args_incomplete`, P2a-3), nothing written       | `running`     |

## 15. Replay after restart, both flows

Pending state (H1 after the restart, H2 after the recovery): `connect`, `getThreadEvents` and the HTTP replay equal `compactEvents` of the stored rows and pass `verifyEvents`; `getThreadMessages` is `[user, assistant{toolCalls}]` and equals the reducer's derivation; `isRunning` false; `getThreadState` null; `listThreads` lists the thread (in H2 it was **not** listed while its run was `running` and is listed after the recovery). After the approval: `[user, assistant{toolCalls}, tool, assistant]`; the assistant, tool and message ids are unique and the client's ids equal the cache's.

## 16. Negative controls

Six temporary mutations of `sqlite-runner.ts`, each run against the full P2a-5 test and each **reverted** (restored and compared byte-for-byte by hash after every run; the final runner is the `80622f8a…37615a2` version).

| Mutation                                                          | Tests that went red                                                                                      |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| N1 a pending client call is classified as a server ambiguous call | 7: micro-window recovery, idempotence, approval after recovery, H2b, classification, branches, atomicity |
| N2 the micro-window run is left `running`                         | 7: the same seven                                                                                        |
| N3 `RUN_FINISHED` is added again at every restart                 | 6: normal restart, strict G2, H1 approval, idempotence, approval after recovery, atomicity               |
| N4 recovery also adds a synthetic `TOOL_CALL_RESULT`              | 7: micro-window recovery, idempotence, approval after recovery, H2b, classification, branches, atomicity |
| N5 the stale-history guard also refuses a human result            | 3: H1 approval, approval after recovery, H2b                                                             |
| N6 `parentMessageId` is removed from the message-id set           | 3: H1 approval (run 2 stores `[assistant, tool]`), approval after recovery, H2b                          |

Details: `p2a-evidence/p2a5/negative-controls.json`. The mutated runs wrote their evidence elsewhere (`P2A5_OUT`), which was deleted. A first version of the test aborted its whole setup when a child crashed under a mutation (the real-kill tests were then reported "skipped", not failed); it was changed so a wrong recovery shows up as failed assertions, and the controls were re-run on the final test.

## 17. Regressions

| Check                                                                                                                         | Result                               |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `tests/p2a` as a whole, file by file: `golden` 12, `reasoning-drop` 5, `p2a1` 19, `p2a8b` 15, `p2a2` 21, `p2a4` 19, `p2a5` 14 | **105 / 105 passed**, 7 files        |
| Golden fixtures, 17 files (`raw/*`, `normalized/*`, `manifest.json`) vs the SHA-256 list taken before P2a-2                   | **identical**; nothing was rewritten |
| `prettier --check tests/p2a docs/LOCAL_FIRST_P2A5_ACCEPTANCE.md`, `git diff --check`                                          | clean                                |

The evidence of earlier phases in the scratch tree was regenerated by the same full run (new PIDs); the numbers those phases documented refer to the runs in which they were recorded.

## 18. External egress

Server-process instrumentation of `fetch` and socket connect (`127.0.0.1` allowed, everything else refused and recorded): **0 fetches and 0 connects** in the orchestrator, in every restart, recovery and approval process (W1, B, C, D, D2), and in each killed writer **at the moment it reached its gate**. No external probe was made. This measures what these processes attempted; it is not an operating-system-level guarantee.

## 19. Deviations, surprises and open questions

**Deviations and surprises**

1. P2a-4 had **deferred** `client_tool_pending`; P2a-5 settles it, so one P2a-4 test was replaced (section 4). The P2a-4 acceptance document in the main worktree still says the case was deferred; that is historically true and is superseded here.
2. **The approval was exercised through the same server call the REST route makes, not through HTTP, and the React card was not rendered.** The harness has no browser; "visual card rendering verified" is **not** claimed.
3. The first version of the P2a-5 test hid mutation detection behind a setup abort (section 16); fixed.
4. For H2 the first model request was in the killed process, so the model-call list is not compared with the golden in that flow (everything else listed in sections 9 and 12 is).
5. The `pendingToolCalls` check in the scratch scripts is the same notion the real client uses (an assistant tool call with no tool message); the real `respond()` plumbing of CopilotKit was not exercised.

**Open questions (carried forward)**

- **What happens if the owner ignores the pending decision and sends an ordinary message**, leaving a client tool call unresolved in the history? The framework's behaviour with an unresolved _client_ tool call in the history was not examined (P2a-4 showed it re-runs an unresolved _server_ call). Not evaluated here.
- **`mixed_pending_tool_calls`** (a pending client call and a pending server call in one run) is deferred, not decided.
- `tool_args_incomplete`, `open_text_message` and `no_tool_lifecycle` remain with **P2a-3**; a pending client call whose arguments were still streaming is not repaired.
- The classification depends on the browser having declared the tool in the persisted `input.tools`. A run whose input did not declare it would be recovered as a server tool (a possible loss of the pending decision). The real client declares it on every run (observed); a contract test is advisable before integration.
- Single process (R17), recovery before serving, the provisional nature of the P2a-4 interlock and the UX of a refused run are unchanged from P2a-4.
- R19 is now resolved for server-tool ambiguity (P2a-4) and for the pending client tool (P2a-5); text streaming and incomplete arguments remain (P2a-3).

## 20. Verdict and recommendation

```text
P2a-5: PASS
P2a-3: GO
```

Both flows hold: a normal pending HITL survives a restart, and a pending HITL cut by a real `SIGKILL` between `TOOL_CALL_END` and `RUN_FINISHED` is repaired to the canonical pending form (equal to G2) and approved afterwards, once, as a new run with `[tool]` stored. **GO for P2a-3** (a crash during text streaming), the next step in the design's recommended order; it is a recommendation only and P2a-3 was not started. P2a-3 inherits `open_text_message`, `tool_args_incomplete` and `no_tool_lifecycle`, and the question of what an interrupted text message becomes (D2: a truthful `RUN_ERROR(INCOMPLETE_STREAM)`). P2a-6 and P2a-7 follow.

## 21. Evidence

`p2a-evidence/p2a5/`: `summary.json`, `normal-pending-before-restart.json`, `normal-pending-after-restart.json`, `approval-after-normal-restart.json`, `micro-window-before-kill.json`, `micro-window-after-recovery.json`, `approval-after-recovery.json`, `idempotent-restart.json`, `approval-without-boot-recovery.json`, `classification.json`, `negative-controls.json`. Each scenario file records the PIDs, thread / run / tool-call ids, event counts and types, the logical database hashes, provider request counts, the human result, the page / effect counts, the recovery transaction counts and the egress. No credential or secret is stored.

## 22. Files changed (all scratch, all untracked)

| File                                  | Change                                            |
| ------------------------------------- | ------------------------------------------------- |
| `tests/p2a/sqlite-runner.ts`          | revised (section 4)                               |
| `tests/p2a/p2a5-proc.ts`              | new: process roles W1, W2, B, C, D, D2            |
| `tests/p2a/p2a5.test.ts`              | new: orchestrator and in-process cases (14 tests) |
| `tests/p2a/p2a4.test.ts`              | one guard case replaced by test 11a (section 4)   |
| `docs/LOCAL_FIRST_P2A5_ACCEPTANCE.md` | new: this document                                |
| `p2a-evidence/p2a5/*`                 | new (section 21)                                  |

`harness.ts`, `fake-model.ts`, `p2a4-tool.ts`, the P2a-0 / 8a / 1 / 8b / 2 tests and `p2a-evidence/golden/*` were **not** changed. At execution time no tracked file in any worktree changed and the main worktree was not touched; this document was copied to the main worktree afterwards, without the scratch files above.
