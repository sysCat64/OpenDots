# Local-first R32 acceptance: incremental message-cache materialization

**Status: PASS in a scratch worktree. R32 review: PASS accepted.** **Incremental message-cache materialization is the recommended design candidate; the full-history rebuild is retained as the authoritative boot / repair / verification path. Production adoption is NOT yet approved**; production integration has not been done. The scratch runner, checkpoint columns, tests, evidence and benchmark helpers are not in the main worktree; only this document and the design update are. P2b-0, P3, P5 and P2a-9 are not started.

Scope: `/private/tmp/opendots-p2a1.FV0LOx`. Nothing in main was changed by the experiment itself; nothing was committed, pushed or tagged by it. Production `src/`, `package.json` and the lock are at the scratch baseline (`git diff HEAD -- src package.json package-lock.json` is empty; `Chat.tsx` sha `6d6298cc…` = HEAD). The P2a-6 client patch was re-applied only for its regression and removed again. R32 only; no live API was used.

## 1. Baseline and environment

- main HEAD = origin = `45b13784bf8cf83cdc70df1821fff37185a78826`; `git status --short` = `?? mise.toml`; 0 tags.
- Node 24.14.1, npm 11.11.0, SQLite 3.51.2, macOS 12.7.6. `COPILOTKIT_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`, fake provider on 127.0.0.1, fail-closed egress guard in every process.
- SQLite write policy **W1** (every event in its own synchronous transaction, persist then publish) for **both** cache policies, so R27/W2 is not mixed in. PRAGMAs measured: WAL, `synchronous=FULL`, `busy_timeout=5000`.

## 2. Authority does not change

`conversation_events` stays the only authority. `conversation_messages` stays a rebuildable cache. Nothing in this PoC deletes or rewrites an event, demotes the log, or lets a repair run a provider or a tool. Every repair reads the log and writes only the cache row.

## 3. Inventory of the current cache contract (done before any change)

| Item                                                  | Current scratch behaviour                                                                                                                                                                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Table / granularity                                   | `conversation_messages(thread_id PRIMARY KEY, messages_json, last_event_id)`: **one row per thread**, the whole message array                                                                                                                    |
| Full rebuild                                          | `deriveMessages`: read **all** events of the thread in logical order (`conversation_runs.seq`, `conversation_events.seq`), fold them with the public reducer `defaultApplyEvents(input, events$, agent, [])` starting from `agent.messages = []` |
| Read                                                  | `getThreadMessages(threadId)` serves the cache synchronously; it throws when `last_event_id` differs from `MAX(id)` of the log and no run is active                                                                                              |
| Write                                                 | one synchronous transaction after the async reducer, at the end of **every** run (`finalize`)                                                                                                                                                    |
| Boot                                                  | `ready()`: recover dead runs, then rebuild a thread whose `last_event_id` differs from the log's `MAX(id)` (an **id** comparison; content is not compared)                                                                                       |
| Message-id de-dup (`parentMessageId`, history resend) | done at run start on `RUN_STARTED.input.messages` against the durable history, not in the cache                                                                                                                                                  |
| Tool-call / result folding                            | the reducer: a `TOOL_CALL_RESULT` becomes a `tool` message; the continuation text of the same run is appended to the assistant message that carries the call (P1-3)                                                                              |
| HITL                                                  | run 2's `RUN_STARTED.input.messages` carries the human `tool` message (the assistant message with the call, already seen, is filtered out); the reducer pushes it                                                                                |
| `RUN_ERROR` / interrupted                             | closers are ordinary events (`TEXT_MESSAGE_END`, `RUN_ERROR`); the reducer keeps the partial assistant text                                                                                                                                      |
| Stop                                                  | the finalizer's `TEXT_MESSAGE_END` + `RUN_FINISHED` (P2a-6)                                                                                                                                                                                      |
| Unknown-outcome recovery                              | an explicit `TOOL_CALL_RESULT` event with the "outcome unknown" content (P2a-4)                                                                                                                                                                  |

"Incremental is just an append" was **not** assumed. The reducer is the single semantics; the question is whether it can start from the cached messages. It can: it starts from `agent.messages`, so the cached messages are its initial state. Whether an old message can be edited by a later event is therefore not decided by reasoning but by comparison with the full derivation (sections 7 to 9). Evidence: `cache-contract.json`.

## 4. The incremental candidate (scratch, test-only switch `cachePolicy: 'full_rebuild' | 'incremental'`, default full)

- **One reducer seam.** `applyEvents(threadId, initialMessages, events)` is the only place the reducer is called. The full derivation passes `[]` and every event; the incremental one passes the cached messages and only the new events. There is no second copy of the semantics.
- **Incremental step** (end of a run): read and validate the cache row; read the events logically **after** its checkpoint; apply them to the cached messages; write payload, checkpoint and hash in **one** transaction. The whole history is **not** read.
- **The first run of a thread** has no cache: a full build (`fallback_full`, reason `missing`).
- **Boot** (`ready()` under the incremental policy): derive **every** thread from the authoritative log, compare payload, hash and checkpoint with the cache; identical means **no write**; missing, stale or corrupt means repair from the log; a cache **ahead** of the log fails closed. This is O(history) by design.
- A cache that cannot be updated must not fail a run whose events are durable: under the incremental policy the error is recorded in `notes.cacheErrors` and the cache stays stale (and `getThreadMessages` then fails closed). The full policy keeps its old behaviour.

## 5. Checkpoint and staleness strategy (design candidate, not a production migration)

Four columns added to `conversation_messages` (and added by `ALTER TABLE` to a database from an earlier phase):

| Column                                 | Meaning                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| `through_run_seq`, `through_event_seq` | the **logical position** (run seq, event seq) of the last materialised event |
| `event_count`                          | how many events are folded into the payload                                  |
| `messages_sha256`                      | SHA-256 of `messages_json`                                                   |

**No dependence on id order.** A late recovery write can append to an _older_ run after a newer run exists: its id is the largest, its logical position is earlier. An id-based "events after the checkpoint" would apply it out of order. The incremental step therefore also checks that the number of events at or before the checkpoint position still equals `event_count`; if not, it falls back to a full rebuild (`events_inside_prefix`). Fallback reasons: `missing`, `no_checkpoint`, `malformed`, `hash_mismatch`, `events_inside_prefix`. **Fail-closed**: a checkpoint ahead of the log (count or position) raises `CacheAheadOfLog`; `ready()` handles every other thread first and then throws, writing nothing for that thread.

The states required by the task: A events committed / cache not (checkpoint older: applied incrementally, or repaired at boot); B cache missing (rebuilt); C cache malformed or tampered (hash mismatch or boot comparison: rebuilt); D cache older than the log (checkpoint behind: incremental or repair); E cache newer than / inconsistent with the log (fail closed).

## 6. Oracle strategy

The full-history derivation `deriveMessages` (read every event, fold from `[]`) is the **oracle**. A test-only switch (`cacheCheck`, env `P2A_CACHE_CHECK=1`) re-derives after **every** incremental materialisation and compares with sorted-key JSON; a difference is recorded in `notes.cacheCheckFailures` (a thrown error alone can be lost on its way to the client, which a negative control showed) and thrown. An **independence guard** tampers the cache and shows that the oracle does not read it.

## 7. Golden and recovery equivalence

- Scenarios G0 to G7 through the incremental runner with the check on (`golden-comparison.json`): no cache error, no check failure. Single-run scenarios have no incremental step (first run = full build); G2/G3 (HITL, two runs) and G7 (two turns) have one each.
- Multi-run shapes in one thread (`multi-run.json`): tool turn, uncoded error, a normal turn after the error, a stopped partial answer, a normal turn after the stop: 4 incremental checks, all equal; message ids unique; 5 user messages exactly once; the failed turn's lone user message is kept.
- The **whole existing suite** was rerun with `P2A_CACHE_POLICY=incremental P2A_CACHE_CHECK=1`: P2a-0 golden, P2a-1, 8b, 2, 3, 4, 5 (including the real-SIGKILL recoveries, the recovered server tool followed by a new turn, the HITL restart and approval) and the P1 tests: **143 passed, 0 failed, 0 `R32_CHECK_MISMATCH` lines** (N1 and N3 turn the p2a2 part of that run red, so the incremental path really was exercised).

## 8. Crash windows (`crash-repair.json`)

- **C1, real SIGKILL**: the run's events are durable, the cache write has not started (a gate in front of the write). At the kill the log held 18 events and the cache 9. Restart: boot detects the stale cache, repairs (1 cache transaction), messages equal the oracle; **provider requests 0, runner runs 0, side-effect receipts unchanged (2)**. A second restart: rebuilt 0, transactions 0, DB hash unchanged.
- **C3, real SIGKILL**: the cache write is committed, then the process dies. Restart: identical to the oracle, **repair writes 0**, provider 0, receipts unchanged.
- **C2, fault injection** inside the cache transaction: the transaction rolls back (the previous cache, byte for byte), the run still completes (`RUN_FINISHED` durable), the log grew, `cacheErrors` has the fault, reads fail closed while the cache is stale, restart repairs and equals the oracle, the repair calls no provider. **Same-process degraded behavior after a cache-write failure is an open production-policy item (R34 in the Design); restart-only repair is not claimed to be the final UX / API contract.**

## 9. Corruption controls (`corruption-repair.json`)

| Control                                                 | Result                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| cache row deleted                                       | detected, repaired from the log, equals the oracle, repair idempotent                                  |
| payload truncated                                       | hash mismatch, repaired, idempotent                                                                    |
| valid JSON, **wrong** message, hash recomputed to match | not visible to the cheap per-run check, **detected by the boot comparison**, repaired                  |
| stale checkpoint                                        | detected, repaired, idempotent                                                                         |
| impossible / future checkpoint                          | **fail closed**: `CacheAheadOfLog`, nothing written for the thread, `notes.cacheInconsistent` recorded |
| corrupt cache met by an incremental run                 | falls back to a full rebuild (`hash_mismatch`), ends equal to the log                                  |
| an event appended into an older run (inside the prefix) | falls back to a full rebuild (`events_inside_prefix`), ends equal to the log                           |
| the oracle reading the cache (independence guard)       | the oracle does not; it equals the untampered truth                                                    |

In every case the log was unchanged (hash) and no provider was called. No silent acceptance.

## 10. 100-turn A/B

Same deterministic workload as P2a-7 (one thread, 100 turns, one server tool per turn, 14 events per turn, 300 ms of streaming per turn, the real client resending its history), W1 fixed, three measured repetitions per policy, alternating full / incremental / full / …, each in a fresh writer process on a fresh DB, a 10-turn warm-up per policy excluded. A separate **correctness-heavy run** (not a measurement) compared the incremental cache with the full derivation after every one of its 99 incremental runs: **0 differences, 0 cache errors**. Normalised conversation hash: identical for all 6 measured runs and the checked run. All runs: 100 runs, 1,400 events, 100 user / 100 assistant / 100 tool messages, cache equal to the log-derived messages, checkpoint count equal to the log's.

### Measurement condition (important, see section 12)

Final numbers: `NODE_ENV` unset and `VITEST_WORKER_ID` removed in every process (production-like), V8 `--single-threaded` (R33 mitigation), identical for both policies. Evidence: `materialization-comparison.json`, `turn-latency.json`, `full-run-N.json`, `incremental-run-N.json`.

### Cache materialization duration (ms; three repetitions; median of repetitions for the per-turn values)

| turn                                 | full                       | incremental                    |
| ------------------------------------ | -------------------------- | ------------------------------ |
| 1                                    | 1.6                        | 1.7 (full build)               |
| 25                                   | 31.9                       | 3.8                            |
| 50                                   | 80.8                       | 4.7                            |
| 75                                   | 164                        | 6.9                            |
| **100**                              | **332** (275 / 332 / 339)  | **9.0** (10.2 / 9.0 / 8.9)     |
| cumulative over 100 turns            | 10.1 / 10.4 / 11.4 s       | 0.57 / 0.51 / 0.63 s           |
| mean / p50 / p95 / p99 / max (run 1) | 101 / 75 / 248 / 332 / 334 | 5.7 / 5.3 / 10.3 / 16.2 / 16.6 |
| trend (linear fit, ms per turn)      | 2.9                        | 0.08                           |
| turn 100 over turn 25                | 10.4                       | 2.3                            |

At turn 100 the full rebuild is about 275–340 ms (reduce 270–335 ms, read 3.5 ms); the incremental step is about 9 ms (read the cache and the new events 2.2–2.5 ms, reduce 5.9–6.9 ms on 14 events, write 0.75 ms).

### Observed scaling (not asserted theory)

Full: grows faster than linearly (turn 25 to 100: ×10 for ×4 turns). Incremental: **still grows with the history, but about 30× slower**: 1.7 ms at turn 1 to 9 ms at turn 100. The reducer clones the message array for each event it applies and the cache payload is parsed and serialised whole, so a step costs O(new events × messages), not O(new events). This was not claimed away.

### Client-observed turn latency (ms; `turn-latency.json`; the fake provider waits the same fixed time for both)

|                                     | full                        | incremental                 |
| ----------------------------------- | --------------------------- | --------------------------- |
| turn 1 / 25 / 50 / 75 / 100 (run 1) | 423 / 354 / 402 / 490 / 663 | 401 / 326 / 342 / 336 / 339 |
| first-ten / last-ten median         | 330 / 575–621               | 324–326 / 335–341           |
| total for 100 turns                 | 43.0–44.5 s                 | 33.1–33.6 s                 |

The turn time that grew with the history under the full rebuild is flat under the incremental policy.

### SQLite metrics (W1 in both)

1,500 transactions in both; commit p50 0.42–0.45 ms, p95 0.60–0.83 ms, total 0.70–0.84 s, the cache transaction mean about 0.5 ms; no difference worth reporting, and the durability policy was not touched. Event-loop delay (writer, resolution 10 ms): full p99 about 145–151 ms, max 313–370 ms; incremental p99 about 17–19 ms, max 60–93 ms. WAL about 4.13–4.17 MB, DB 709–725 KB before one `wal_checkpoint(FULL)` and 766–778 KB after, identical in both; VACUUM not run.

### Boot and replay (fresh reader process, 10 per DB; OS file cache not controlled; not a cold-disk benchmark)

|                                                      | full policy                   | incremental policy                                                                   |
| ---------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------ |
| boot (`ready()`)                                     | 0.6–0.7 ms (an id comparison) | **377–465 ms p50** (a full derivation of 1,400 events and a comparison; p95 541–632) |
| raw connect replay p50                               | 102–138 ms                    | 158–177 ms                                                                           |
| `getThreadEvents` / `getThreadMessages` (first call) | 3.2–3.6 / 0.5–0.6 ms          | 3.2–3.6 / 0.5–0.6 ms                                                                 |
| real client `connectAgent` p50                       | 378–478 ms                    | 226–262 ms                                                                           |

Per the task, the incremental policy's O(history) boot is not a failure; it is the cost of verifying the cache against the log. In **every** reader of both policies: repair write 0 (`ready()` rebuilt 0, write transactions 0, DB hash unchanged), provider requests 0, runner run calls 0. (The connect and client figures of the incremental readers follow a heavy boot derivation in the same process; they are reported, not interpreted.)

## 11. Negative controls (`negative-controls.json`)

All red; the scratch runner was restored byte-identically after each (sha checked).

| #   | mutation                                                                     | detected by                                                                                                  |
| --- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| N1  | the first new event (the `RUN_STARTED` with the user message) is not applied | golden scenarios, multi-run, C3, the existing p2a2 suite under the incremental env, the benchmark            |
| N2  | every new event applied twice                                                | golden scenarios, multi-run, C3                                                                              |
| N3  | the HITL human tool message not applied                                      | golden scenarios and the p2a2 suite (G3)                                                                     |
| N4  | the checkpoint advances but the old payload is written                       | multi-run, C3, the benchmark (boot / replay)                                                                 |
| N5  | a stale cache is not repaired at boot                                        | C1, C2 and four of the corruption controls (deleted row, truncated payload, stale checkpoint, wrong message) |
| N6  | the oracle reads the incremental cache                                       | the independence guard and the tampered-cache control                                                        |

**Lesson recorded.** N3 was first not detected: a mismatch thrown inside the post-run materialization did not reach the client, so a test that only watched for a failing run missed it. The runner now records every check failure in `notes.cacheCheckFailures`, and the tests assert it is empty.

## 12. Finding: the 4× slowdown of P2a-7 is a measurement condition (resolves the open item of R32)

`@ag-ui/client` runs a dev/test safety path in the code that applies a subscriber's mutation to every event: when `process.env.NODE_ENV` is `test` or `development`, or `VITEST_WORKER_ID` is set, it deep-clones **and deep-freezes** the messages and the state for each event and each subscriber (skipped when messages + state exceed 512 KB). The check is made at call time. Under vitest every spawned child inherits `VITEST_WORKER_ID` (and the worker has `NODE_ENV=test`), so every writer, reader and the in-process client of P2a-7 and of the first R32 campaigns ran in that slow mode. The same reducer on the same log: 250–290 ms with `NODE_ENV` unset or `production`, 1.0–1.15 s with `NODE_ENV=test`, `NODE_ENV=development` or `VITEST_WORKER_ID` set; deleting `VITEST_WORKER_ID` during a run makes the next run fast (`ag-ui-dev-safety-mode.json`; the matrix of that file was taken on a noisy host, the quieter pass is quoted in its `hostNote`). Hypotheses ruled out first: loading the CopilotKit runtime, an enabled `async_hooks` hook, the harness modules, the egress guard, `--single-threaded`.

Consequences:

- **The R32 / P2a-7 absolute numbers were inflated about 4×.** Production-like, the full rebuild at turn 100 is about 0.27–0.34 s (not 1.0–1.15 s) and cumulatively about 10 s (not 36–49 s). The **shape is the same** (faster than linear), so the finding of R32 stands, in a smaller size. P2a-7's W1/W2 comparison is relative and both were measured in the same mode, so that conclusion is unchanged, but its event-loop and replay absolute figures were measured in the slow mode.
- The first two R32 A/B campaigns (kept in the scratch evidence as `r32-campaign1-node-env-test` and `r32-campaign2-test-mode-vitest-worker-id`; the second one's `nodeEnv: production` label is misleading, `VITEST_WORKER_ID` was still set) give, in that slow mode: full at turn 100 1.02–1.16 s and cumulative 35–39 s; incremental 24–27 ms and 1.3–1.5 s; client turn 330 ms to 1.26–1.37 s against 327 ms to 366–372 ms. A third, production-like campaign made before the check-failure record was added (`r32-campaign3-production-like-before-check-record`) gave full 250–271 ms / 9.0–9.2 s and incremental 8.6–8.9 ms / 0.49–0.50 s. The **ratio** is about 30–40× at turn 100 in all of them.
- **`npm run dev` sets `NODE_ENV=development`**, so a developer running OpenDots from source meets the slow path (and the larger history cost of the full rebuild) on every event of every run. Not a production concern, but a development-experience one.

## 13. Regressions, egress

- Production `src/` at baseline throughout. Default policy: 146 passed, 11 skipped, and **one suite failed**: `p2a4.test.ts`, whose `N` role child died before writing its output. Two short-lived node children crashed inside V8 (a `SIGSEGV` in a builtin of the main thread; a `SIGTRAP` in the concurrent marker): the R33 class (not a semantic regression). `p2a4.test.ts` then passed 7 consecutive runs (19/19); a diagnostic that reports a dead role's signal and stderr was added to that test (`regression-notes/`). Incremental policy with the full-history check: **143/143**. P2a-7 small (20 turns): 14/14. R32 tests: 14/14 and 10/10.
- P2a-6 UX with the saved patch re-applied: the first attempt failed 11 tests because the client bundle built inside the regression script was broken (`__name$4 is not defined` in the page; the same source built interactively is fine; not a product defect, cause of the broken build not established). Rebuilt: **33/33** (13 + 20), hashes of the patch equal to the saved ones, patch removed and the baseline hash verified afterwards.
- Golden fixtures: 17 files hash-identical. `prettier --check` and `git diff --check` clean. Egress: 0 in 53 restart roles, 6 benchmark writers and the orchestrator.

## 14. R31 and R33

- **R31**: no C1/C2 failure of `p2a6.test.ts` (it passed 13/13 in the regression run). **Still OPEN** (the original one-off was never explained).
- **R33 recurred**: the two `p2a4` child crashes above, plus the earlier P2a-7 history. No DB corruption evidence; cause unknown. Harness mitigations (V8 `--single-threaded`, READY timeout and restart before writes, recorded reader retries, a started writer never retried) were used for the benchmark and none was needed in the final campaign. The final campaign was not retried selectively; invalid / aborted earlier attempts are named above.

## 15. Open issues

1. The incremental step is still history-dependent (about 9 ms at turn 100); only 100 turns, one thread, were measured.
2. The boot verification is a full derivation (about 0.4 s at 100 turns production-like) and grows with the thread (R35 in the Design).
3. How often `events_inside_prefix` happens in practice (late recovery writes) is unmeasured; it costs a full rebuild.
4. Concurrent threads, a multi-process writer (R17), real-provider texts and larger tool outputs were not exercised. A message array above 512 KB would change the dev-mode behaviour of the client library.
5. The checkpoint columns are a scratch design candidate; the real schema and migration are undecided.
6. One broken client build in a regression script is unexplained.

## 16. R32 verdict and recommendation

**R32: PASS (scratch).** The incremental cache equals the full-history oracle in every golden, multi-run, recovery and 100-turn case (after every run in the checked run); the log stayed authoritative; stale, missing and corrupt caches are detected and repaired from the log, an impossible cache fails closed; the cache-update crash windows (real SIGKILL before and after the write, a fault inside the transaction) restart cleanly with no provider, tool or side-effect replay; the materialization cost per turn dropped about 30–40× at turn 100 with no new pathological cost; the existing P2a semantics and the P2a-6 UX did not regress; golden unchanged; egress 0.

**Recommendation: A, the incremental candidate is recommended** (as a design candidate; `full rebuild` stays as the boot / repair verification path). This is **not** production adoption approval: the checkpoint schema, the fail-closed handling and the cost of the boot verification still need a production design, and the measurements are one host, one thread, 100 turns. R32 can be considered resolved as a finding and answered as a candidate; adoption belongs to the production integration phase.
