# Local-first P2a-2 acceptance: de-duplication, `parentMessageId`, reconnect, duplicate `runId`, concurrent runs

**Status:** P2a-2 was **executed in a temporary scratch worktree** (`/private/tmp/opendots-p2a1.FV0LOx`, the P2a-1 / P2a-8b worktree) and **PASSED**. **P2a-4 is GO but not started.** This document was afterwards **copied to the main worktree as closeout documentation**. The scratch runner, tests and raw evidence (`tests/p2a/*`, including `sqlite-runner.ts`, `p2a2-*.ts` and `p2a2.test.ts`, and `p2a-evidence/*`) remain in the scratch worktree and are **not** part of the main worktree. **Production integration has not been done; no production source, test, migration, dependency or configuration was changed.** The scratch runner is an observed candidate, not an approved production implementation. The measurements, PIDs and evidence below are the record of that execution.
**Baseline:** the scratch tree is detached at `aa2a4157fa3b99b3176bdd7ea99cd8fb4d77266a`. The main branch is at `3127ad3111456ac05de5217538406c2b20404570`; `aa2a415..3127ad3` is documentation-only (section 1). P2a-0, P2a-8a, P2a-1 and P2a-8b are PASS.
**Scope:** P2a-2 only (A to G below). `kill -9` recovery, tool-crash recovery, HITL across a process restart, stop and error recovery, the stale error banner, 100-turn performance, provider continuation, P2b (live) and production integration were **not** started and are **not** accepted here.

## Verdict

```text
P2a-2: PASS
```

All sixteen PASS criteria hold. One divergence from the reference was approved in advance (G3: `[tool]` instead of `[assistant, tool]`) and is asserted explicitly. **One more difference from the reference was observed and is reported, not hidden:** the reference accepts a completed `runId` again, the durable runner rejects it (E1, section 9). **GO for P2a-4** (section 18). At execution time nothing was committed, pushed or tagged.

| #   | Criterion                                                                      | Result |
| --- | ------------------------------------------------------------------------------ | ------ |
| 1   | Three sequential turns: no message duplication                                 | PASS   |
| 2   | De-duplication survives a process restart                                      | PASS   |
| 3   | `parentMessageId` is in the message namespace; the HITL resume stores `[tool]` | PASS   |
| 4   | `toolCallId` never leaks into message sanitising                               | PASS   |
| 5   | Active reconnect: final text and events exactly once                           | PASS   |
| 6   | Completed reconnect: historic replay only, no provider call                    | PASS   |
| 7   | A completed duplicate `runId` is rejected and the database is unchanged        | PASS   |
| 8   | An active duplicate `runId` is rejected                                        | PASS   |
| 9   | The same `runId` on different threads is allowed                               | PASS   |
| 10  | A second run on the same thread is rejected                                    | PASS   |
| 11  | A rejected run never calls the provider                                        | PASS   |
| 12  | Different threads run at the same time                                         | PASS   |
| 13  | P2a-0 / P2a-8a / P2a-1 / P2a-8b regression: none                               | PASS   |
| 14  | Golden fixtures unchanged                                                      | PASS   |
| 15  | No unexpected external egress                                                  | PASS   |
| 16  | Main worktree status remains `?? mise.toml`                                    | PASS   |

## 1. Environment and baseline

| Item                     | Value                                                                                                                                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node / npm               | **v24.14.1 / 11.11.0** (installed binary first on `PATH`; `mise.toml` not used)                                                                                                                             |
| OS / SQLite              | macOS 12.7.6 / SQLite 3.51.2 (bundled with `node:sqlite`)                                                                                                                                                   |
| Packages                 | `@copilotkit/runtime` / `core` 1.75.0; `@ag-ui/client` 0.0.59; `@tanstack/ai` 0.63.0; vitest 4.1.11; tsx. No `npm install`; `package.json` and the lock are untouched.                                      |
| Env                      | `COPILOTKIT_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`, asserted in the orchestrator and in each child process                                                                                                 |
| Network                  | fake provider on `127.0.0.1` only; no OpenAI, SIWC, CopilotKit cloud, Slack, voice, Keychain, `.env` or external web; no external probe                                                                     |
| Documentation-only range | `git diff --name-only aa2a415 3127ad3` lists exactly `docs/LOCAL_FIRST_P2A1_ACCEPTANCE.md`, `docs/LOCAL_FIRST_P2A8B_ACCEPTANCE.md` and `docs/LOCAL_FIRST_P2A_DESIGN.md`. Checked by test 0 on every run.    |
| Production diff          | none: `git diff 3127ad3 -- src package.json package-lock.json` is empty and `package.json` / `package-lock.json` are byte-identical to the ones at `3127ad3`; the scratch tree has no modified tracked file |

## 2. Runner and schema revision

**Schema: unchanged from P2a-1** (`conversation_runs`, `conversation_events` with `event_json`, `conversation_messages` as a rebuildable cache). No table, column or index was added; no message-id index table exists. The identity `(threadId, runId)` is the existing primary key of `conversation_runs`.

**Runner: revised** (`tests/p2a/sqlite-runner.ts`; P2a-1 version sha256 `7f08d887…05919d0`, P2a-2 version `9720f8bd…41279ca89`; +69 / −17 lines). Scratch only.

| Change            | P2a-1                                                                                                                                                  | P2a-2                                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duplicate `runId` | an existing `(threadId, runId)` ended in a raw SQLite UNIQUE failure, never tested                                                                     | explicit check inside the run-start transaction; `run()` throws `RunRejectedError` (`DUPLICATE_RUN_ID`) synchronously, before anything is written; the agent is never started |
| Active run        | `Error('Thread already running')`                                                                                                                      | the same message, now a `RunRejectedError` (`THREAD_ALREADY_RUNNING`); the check and `active.set` are one synchronous stretch                                                 |
| `connect()`       | persisted history, then the live subject, **skipping live events whose `messageId` had already been emitted from history** (copied from the reference) | persisted history of every run **except** the active one, then the live subject, which replays the active run from its first event. **No filtering by message id.**           |
| `notes`           | transactions, trace                                                                                                                                    | adds `rejected[]` (every refused run)                                                                                                                                         |

The harness (`harness.ts`) is unchanged. `fake-model.ts` gained one backward-compatible feature: a `[[gated:<name>]]` request streams ten chunks (`g01 ` … `g10 `), each sent only when the test releases a gate step (no sleeps decide ordering). The P2a-0 golden scenarios do not use it.

## 3. Message-id and namespace strategy

- **Dedup strategy: history scan.** At run start the runner reads the thread's stored events and builds the message-id set; nothing is kept in process memory between runs. It is O(history) per run and per connect. P2a-2 does **not** decide that an O(1) index is needed; that is a P2a-7 question.
- **Message namespace** (sanitises `RUN_STARTED.input.messages`): `RUN_STARTED.input.messages[].id`, `event.messageId`, `TOOL_CALL_START.parentMessageId`.
- **Tool-call namespace:** `toolCallId`, separate, **never** used for sanitising. There is no tool-call index; the separation is observable behaviour (B3).
- **Run identity:** `(threadId, runId)`, from the durable `conversation_runs` primary key, for any status.

## 4. Process restart path

| Role                  | PID   | Notes                                                                                                                                            |
| --------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Orchestrator (vitest) | 67868 | also runs the in-process cases (B, C, E, F, G)                                                                                                   |
| **A**                 | 68138 | turn 1 of a conversation through the real client, runtime, scratch runner, `DotAgent` and fake model; exits cleanly                              |
| **B**                 | 68181 | **new process**, same database, new runner. Reloads the conversation like a browser (`connectAgent`), sends turns 2 and 3, then E1 and E3; exits |
| **C**                 | 68464 | **new process**, replay only, no model                                                                                                           |

All four are distinct and A and B are gone (`kill -0` fails). The PIDs are those of the final run recorded in `p2a-evidence/p2a2/summary.json`; each rerun records new ones. Child stderr contains no error except the one expected server-side log line of the rejected E1 request.

## 5. A. Sequential turns (and G7)

Process B had nothing in memory: its history came from the durable replay (`connectAgent` returned `[user, assistant]`), then the **real client** sent its **full history** each time. Nothing was trimmed by hand.

| Turn  | Request input (what the client sent) | Stored `RUN_STARTED.input.messages` |
| ----- | ------------------------------------ | ----------------------------------- |
| 1 (A) | `[u1]`                               | `[u1]`                              |
| 2 (B) | `[u1, a1, u2]`                       | `[u2]`                              |
| 3 (B) | `[u1, a1, u2, a2, u3]`               | `[u3]`                              |

- Replay (new process C): three assistant messages `[a1, a2, a3]`, each `TEXT_MESSAGE_START` and `END` once; user ids from the three `RUN_STARTED` inputs `[u1, u2, u3]`.
- Cache ids and the real client's rebuilt ids: `[u1, a1, u2, a2, u3, a3]`, all unique; roles alternate; the user texts are the three sent texts; each assistant text is the fake model's output.
- B's database at start equals the database after A (same logical hash), and `ready()` rebuilt nothing.
- **Golden oracle:** G7 (two sequential turns, same process) on the durable runner equals `normalized/two-turns.json` **strictly**, whole file; nothing normalized away.

## 6. B. `parentMessageId` and the namespaces

**B1, G2 and G3 against the reference golden.**

- G2 (HITL pending): strict whole-file equality.
- G3 (HITL resume): the request input is `[user, assistant, tool]`; the reference stored `[assistant, tool]`; **the durable runner stored `[tool]`**. The comparison is **not** made equal by the normalizer or by editing a fixture: (a) the raw durable capture differs from the golden; (b) the **approved divergence is applied to the reference golden only** (the leading assistant message of the `run-2` `RUN_STARTED` is removed), at exactly five places the golden repeats that event (`runs[0].clientEvents[0]`, `runs[0].runnerEvents[0]`, `snapshot.compactedEvents[5]`, `snapshot.http.events.body.events[5]`, `snapshot.replay[5]`); (c) after that the durable capture equals it strictly, so there is no other difference.

**B2.** After the resume, a fresh real client replays the thread to four messages `[user, assistant, tool, assistant]` with unique ids, without a model call. The assistant tool-call message that was not re-stored is rebuilt from the `TOOL_CALL_*` events.

**B3, synthetic collision.** The strings `dup-1` and `dup-2` are used as a **message id and as a toolCallId**. Stored inputs: run 1 `[u-1]`; run 2 `[dup-1]` (the new user message whose id equals an earlier toolCallId is **kept**; `u-1` and `asst-1` are dropped as seen); run 3 `[tm-3, u-3]` (a tool message whose `toolCallId` equals a message id is kept). Final cache ids `[u-1, asst-1, dup-1, dup-2, asst-2, tm-3, u-3, a-3]`, unique, equal to the reducer's derivation; the two namespaces really did share the strings `dup-1` and `dup-2`.

## 7. C. Reconnect during an active run

Setup (real runtime): a thread with one completed turn (persisted history), then a gated run. Client 1 (raw SSE) reads four chunks and **disconnects**; the run continues (the gated model request is not aborted). Two more chunks are published while nobody listens. Then client 2 (the real client, plus a raw SSE reader) connects, and a **storm** of direct `runner.connect` calls is made at different points of the run while the remaining chunks are released one by one.

| Case | Flush interval | At connect time (persisted / published)                                                      | Result                                                                                              |
| ---- | -------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| C1   | 60 s           | persisted: `RUN_STARTED`, `TEXT_MESSAGE_START` only; 6 deltas **published, not persisted**   | every late client receives the active run exactly once                                              |
| C2   | 30 ms          | persisted: the two boundaries **and all 6 deltas**; 6 deltas published (**maximum overlap**) | the same, with the persisted rows of the active run present in the database and in the live subject |

In both cases, for the raw SSE connect and for every storm connect that joined while the run was active (4 of 5; the fifth connected after completion and correctly received compacted history), the stream is: persisted history compacted `[RUN_STARTED, START, CONTENT, END, RUN_FINISHED]`, then the active run raw: **`RUN_STARTED` once, `TEXT_MESSAGE_START` once, ten `TEXT_MESSAGE_CONTENT` deltas `g01 … g10` once each in order, `TEXT_MESSAGE_END` once, `RUN_FINISHED` once** (14 events), assembled text `g01 g02 … g10 `, equal to what the model sent. The real client rebuilt four messages (`user, assistant, user, assistant`) with unique ids and the full text. The durable log holds the run once (14 rows) and its stored input is only the new message. Provider requests: 2 (the history turn and the gated run); the connects called no model.

**C3.** The synthetic case that a message-id filter would fail: run 2 re-uses the **same message id** as persisted run 1. A late client joining run 2 still receives all of run 2's events (`first text`, then `second text`).

**Boundary design.** The active run's rows are in the database too (boundaries are persisted before they are published), so they are **excluded** from the history read and served by the live subject, which replays that run from its first event. The two sets are disjoint by construction and the split is one synchronous stretch. Event identity is therefore never guessed from a message id.

## 8. D. Completed reconnect

Process C (new PID, same database, new runner): provider requests **0**, write transactions **0**, `ready()` `{checked: 2, rebuilt: 0}`. The direct `connect` (twice), the runtime's HTTP replay (twice), a raw SSE connect and `getThreadEvents` all **equal `compactEvents` of the events the writers' runners emitted** (same order, same ids, three runs); the cache equals the reducer's derivation; the real client rebuilds the same ids. The logical database dump before and after the connects is identical to the dump after process B, and a third read by the orchestrator agrees.

## 9. E. Duplicate `runId`

**Reference behaviour, observed offline first** (`InMemoryAgentRunner`, same harness):

| Case                                           | Reference                                                                                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1 completed `runId` reused on the same thread | **accepted**: the model is called and a second run with the same id is recorded (two `RUN_STARTED` with `ref-run`)                                                        |
| E2 active `runId` reused                       | `run()` throws `Thread already running`; the runtime answers **HTTP 200 with an empty `text/event-stream`** and logs `Error running agent: Error: Thread already running` |
| F different `runId` while active               | the same                                                                                                                                                                  |

The reference has no explicit HTTP semantics for a rejected run (the 200 with an empty stream is how the installed runtime reacts to a synchronous throw). **The durable runner therefore does not define an HTTP status**: it throws synchronously and fails closed. The same HTTP requests against the durable runner give the identical surface (200, `text/event-stream`, no events, a server log line), asserted as parity with the reference only, **not** as a production contract.

**Results (durable runner).**

| Case                                    | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **E1** completed `runId`, same thread   | **rejected** (`DUPLICATE_RUN_ID`, synchronous). Runner level: the logical dump (rows, content hash, run timing columns) and the cache row are identical before and after; the agent never started; the thread is usable with a new id. **Across a restart:** process B (new process) rejected turn 1's `runId` from the durable history alone; 0 provider requests, 0 runner events, database identical to its state after the three accepted turns, the original run still has exactly its 10 event rows. Over HTTP: empty stream, database unchanged. |
| **E2** active `runId`, same thread      | **rejected** (`THREAD_ALREADY_RUNNING`, message `Thread already running`); the agent never started; the active run finished normally and alone                                                                                                                                                                                                                                                                                                                                                                                                          |
| **E3** same `runId`, **another** thread | **allowed**, also while the E2 run was still active; each thread has its own run row, its own event rows and its own cache; across a restart, process B created `runId = A's turn-1 run id` on a new thread and it completed                                                                                                                                                                                                                                                                                                                            |

**Observed difference from the reference (E1).** The reference accepts a completed `runId` again and records a second run with the same id; the durable runner rejects it, as the design requires (a unique `(threadId, runId)`, section 9.2 of the design). This is a deliberate fail-closed choice, not an approved golden divergence. Open question (section 17): a client that **retries** a `POST /run` whose response was lost now receives an empty stream instead of a reconnect.

## 10. F. Concurrent run exclusion

- **F1 (real client, slow run).** While run 1 was active, a second request with another `runId` arrived on the same thread: refused. Run 1 continued and finished with the full text `g01 … g10`. **No second run row** (two rows: history turn and run 1), **no event rows for the rejected run**, **0 provider requests** for it, and the **cache row was byte-identical** (including its `last_event_id`) while run 1 was active; at the end the cache is `[user, assistant, user, assistant]` and does not contain the rejected message.
- **F2 (two real clients, same instant, HTTP).** A barrier released both `runAgent` calls together: exactly **one provider request, one run row**, one server-side rejection log; the winner finished normally.
- **F3 (runner level).** `run()` called twice in the **same synchronous tick**, 30 times, alternating which goes first: every time exactly one starts and the other throws `THREAD_ALREADY_RUNNING`; the loser's agent emitted nothing; one run row and one set of event rows per trial. The check and `active.set` have no `await` between them.

## 11. G. Thread-local concurrency

Thread A runs a gated (slow) run with `runId = shared-run-id` and has persisted its first five rows; thread B then runs a complete normal turn with the **same textual `runId`**. B finished while A was still running (`isRunning(A) = true`, `isRunning(B) = false`); **A's persisted rows were identical before and after B's run**, A's cache appeared only when A finalised; A then finished with its full text and B kept its own text; the two run rows share a `run_id` on different threads. Provider requests 2. With a global lock instead (negative control M4) this test fails.

## 12. Database state

| Evidence (final run)                        |   Runs |            Events |    Cache rows | Logical SHA-256                                                                                      |
| ------------------------------------------- | -----: | ----------------: | ------------: | ---------------------------------------------------------------------------------------------------- |
| After A                                     |      1 |                10 |             1 | `91b16ac9568839bbc9c4446f51bf1c7598175b59f4f5ed2a84b747015ec36467`                                   |
| After B (3 turns, E1 rejected, E3 accepted) |      4 |                40 |             2 | `8e53786784ffd79f344ab09b362ad8ce3f277ffcb024dbf81b94fa3cd8e7f358`                                   |
| After C (replay only) and a third read      |      4 |                40 |             2 | the same as after B (and the same run timing hash)                                                   |
| In-process C1 / C2 / F1 / G1 (final)        | 2 each | 24 / 24 / 24 / 24 | 1 / 1 / 1 / 2 | recorded per case in `reconnect-active.json`, `concurrent-run.json`, `thread-local-concurrency.json` |

The hash covers rows (with random ids and timestamps), so it differs from run to run; the assertions compare values **within** one run. Dump = logical rows, not file bytes.

## 13. Provider request counts

A: 1. B: 3 (turn 2, turn 3, E3; **E1: 0**). C: **0**. C1 / C2: 2 each (the history turn and the gated run; the connects: 0). F1: 2 (the rejected request: 0). F2: 1. G1: 2. Every rejected run: **0**.

## 14. Egress

Server-process instrumentation of `fetch` and socket connect (`127.0.0.1` allowed, everything else refused and recorded): **0 fetches and 0 connects** in the orchestrator (all in-process cases) and in A, B and C. No external probe was made. This measures what these processes attempted; it is not an operating-system-level guarantee.

## 15. Negative controls

Eight temporary mutations of `sqlite-runner.ts`, each run against the full P2a-2 test and each **reverted** (the file was restored and compared byte-for-byte by hash after every run; the final runner is the `9720f8bd…` version). No mutation remains.

| Mutation                                                                             | Detected by (tests that went red)                                    |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| M1 `parentMessageId` removed from the message-id set                                 | 3: B1 (golden / stored input), B2, B3                                |
| M2 completed duplicate `runId` allowed                                               | 6: processes, A, D, E1 across a restart, E runner level, E over HTTP |
| M3 `connect()` includes the active run's persisted rows (no persisted/live boundary) | 3: C1, C2, C3                                                        |
| M4 per-thread lock becomes a global lock                                             | 2: E runner level (E3 while E2 is active), G1                        |
| M5 `toolCallId` added to the message-id set                                          | 1: B3                                                                |
| M6 a second run on a running thread is allowed                                       | 5: E runner level, E over HTTP, F1, F2, F3                           |
| M7 `connect()` skips live events whose `messageId` was emitted from history (P2a-1)  | 1: C3                                                                |
| M8 sanitising ignores the durable history                                            | 7: A, B1, B2, B3, C1, C2, G7                                         |

Details in `p2a-evidence/p2a2/negative-controls.json`. The mutated runs wrote their evidence elsewhere (`P2A2_OUT`) and that directory was deleted, so they could not overwrite the real evidence.

## 16. Regressions

| Check                                                                                                        | Result                                 |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| `tests/p2a` as a whole (`golden` 12, `reasoning-drop` 5, `p2a1` 19, `p2a8b` 15, `p2a2` 21), file by file     | **72 / 72 passed**, 5 files            |
| `p2a1.test.ts` (P2a-1, includes the G0 strict whole-file comparison with the durable runner, revised runner) | 19 / 19                                |
| `p2a8b.test.ts` (opaque-string fidelity)                                                                     | 15 / 15                                |
| Golden fixtures, 17 files (`raw/*`, `normalized/*`, `manifest.json`) vs the SHA-256 list taken before P2a-2  | **identical**; nothing was rewritten   |
| `p2a2.test.ts` alone, 5 times in a row after the last edit, plus 2 full-suite runs                           | 21 / 21 every time (no flakiness seen) |
| `prettier --check tests/p2a docs/LOCAL_FIRST_P2A2_ACCEPTANCE.md`, `git diff --check`                         | clean                                  |

## 17. Deviations, surprises and open issues

**Deviations and surprises**

1. **The P2a-1 `connect()` carried a latent hazard.** It was copied from the reference and skipped live events whose `messageId` had already been emitted from history. P2a-1 never exercised it. In P2a-2 it is replaced by the active-run exclusion (section 7); C3 and mutation M7 show the difference. The reference has the same filter; the durable runner now deliberately differs in this one synthetic case.
2. **E1 differs from the reference** (accepted there, rejected here; section 9). It is fail-closed by design but it is not covered by a golden fixture.
3. A rejected run reaches the browser as an **HTTP 200 with an empty stream** plus a `console.error` on the server (stack included). This is the runtime's reaction to a synchronous throw, identical for the reference. The real client's `runAgent` simply resolves.
4. A late client that joins an **active** run receives that run raw (one event per delta), but a client that connects after completion receives it compacted (observed; same as the reference).
5. Two assertions in my first run of the new test were wrong: a `git show` comparison that trimmed the trailing newline, and the expectation that a client connecting **after** completion receives the run raw (it correctly receives it compacted). Both were fixed in the test; the runner was not changed for them.

**Open issues (carried forward, none blocks P2a-4)**

- **Cross-process exclusion is not enforced.** The active-run check is process-local, as accepted for this scope. Two server processes on the same database could both start a run on one thread. The durable `(threadId, runId)` key only protects against the same `runId`. Single-process operation is assumed.
- **Reject versus reconnect for a retried `runId` (E1)** is a product decision. Today a retried completed run gets an empty stream.
- **How a rejection is shown to the owner** (empty stream, "no response" handling in the client, a typed error) belongs to the UX phases (P2a-6 / P3), not to the runner.
- A crashed process leaves a `running` run row. The duplicate rule treats any existing row as taken, and the thread is not blocked by it (the active map is process-local). Recovery is P2a-3 / P2a-4.
- **History scan is O(history)** at run start and at connect (P2a-7). The active run is held in a `ReplaySubject` in memory, as in the reference.
- `getThreadMessages()` still throws on a stale cache outside an active run (P2a-1 note).
- Duplicate detection was tested for a completed (`finished`) run; the same rule applies to every status but errored, stopped and interrupted runs were not exercised.
- The runner still reaches the `WorkspaceStore` connection through a private field in the scratch harness (R16 in the design).

## 18. Verdict and recommendation

```text
P2a-2: PASS
P2a-4: GO
```

De-duplication works from the durable history alone (including across a process restart), the `parentMessageId` gap is fixed and asserted as the one approved divergence, message and tool-call ids stay in separate namespaces, late clients receive the active run exactly once, completed reconnects are history-only and read-only, duplicate run ids and concurrent runs fail closed without touching the database or the provider, and the exclusion is per thread. **GO for P2a-4** (server-tool lifecycle and crash recovery), the next step in the design's recommended order; it is a recommendation only and P2a-4 was not started. Keep in mind for P2a-4 that a crashed run leaves a `running` row that the duplicate rule treats as an existing run. P2a-3 stays after P2a-4 and P2a-5, as in the design.

## 19. Files changed (all scratch, all untracked)

| File                                  | Change                                                                                                                                                                                             |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/p2a/sqlite-runner.ts`          | revised (section 2)                                                                                                                                                                                |
| `tests/p2a/fake-model.ts`             | added the `[[gated:<name>]]` stream and `gate()` (backward compatible)                                                                                                                             |
| `tests/p2a/p2a2-common.ts`            | new: helpers, raw SSE, probes, golden transformation, scripted agent                                                                                                                               |
| `tests/p2a/p2a2-proc.ts`              | new: process roles A, B, C                                                                                                                                                                         |
| `tests/p2a/p2a2.test.ts`              | new: orchestrator and in-process cases (21 tests)                                                                                                                                                  |
| `docs/LOCAL_FIRST_P2A2_ACCEPTANCE.md` | new: this document                                                                                                                                                                                 |
| `p2a-evidence/p2a2/*`                 | new: `summary`, `sequential-turns`, `parent-message-id`, `reconnect-active`, `reconnect-complete`, `duplicate-run-id`, `concurrent-run`, `thread-local-concurrency`, `negative-controls` (`.json`) |

`harness.ts`, `golden-normalize.ts`, `scenarios.ts`, the P2a-0 / 8a / 1 / 8b tests and `p2a-evidence/golden/*` were **not** changed. At execution time no tracked file in any worktree changed and the main worktree was not touched; this document was copied to the main worktree afterwards, without the scratch files above.
