# Local-first P2a-7 acceptance: 100 turns, SQLite durability and performance, W1 against W2

**Status: PASS in a scratch worktree.** Production integration has **not** been done. **W1 (persist every event synchronously) is the recommended production candidate; W2 (250 ms buffered deltas) is a retained fallback / experimental candidate, not recommended by the current measurements, and not production-approved.** The recommendation is not an adoption approval. P2a-9 is optional / HOLD; P2b is HOLD / re-scoped; P2b-0, P3 and P5 are not started. The scratch tests, evidence, helpers, the P2a-6 client patch and the runner's performance instrumentation are **not** in main; only this document and the design update are. Feasibility stays CONDITIONAL GO / L3.

Review outcome: **P2a-7 PASS accepted.** Caveats are in sections 12, 14 and 17.

Scope: `/private/tmp/opendots-p2a1.FV0LOx`. Nothing in main was changed by the experiment itself; nothing was pushed or tagged by it. Production `src/` was at the scratch baseline for the measurements (`git diff HEAD -- src package.json package-lock.json` empty); the P2a-6 client patch was saved, applied only for the P2a-6 regression, and removed again (production `src/` was restored to baseline after that run).

Question answered: is a `synchronous=FULL` SQLite durable runner practical for a personal-scale 100-turn conversation, which write policy should be the production candidate, and how large is the R27 durability window.

## Measurement clarification (added after R32; the original measurements below are unchanged)

The R32 investigation found that `@ag-ui/client` has a **development/test safety path**: when `NODE_ENV` is `test` or `development`, or `VITEST_WORKER_ID` is present, its event / subscriber processing **deep-clones and deep-freezes** the message and state tree (the check is made at call time; the package skips the safety path when messages plus state exceed 512 KB, which is recorded as observed package behavior only). The P2a-7 writer and reader child processes, and the in-process client, were spawned by a vitest worker and **inherited this environment**.

Therefore the absolute timings of the **full message-cache derivation** reported below (about 1.0–1.15 s at turn 100, about 36–49 s cumulative, the client `connectAgent` figures and the event-loop figures of the same runs) represent the development/test safety path, **not a production-like absolute measurement**. A later R32 measurement with the variables removed (production-like) gave about **275–340 ms** for the same operation at turn 100. The quadratic shape and the finding that the cache rebuild, not SQLite, dominates are unchanged.

**The W1 against W2 write-policy conclusion of this document remains valid**: both policies were measured in the same environment, alternating, and the comparison is relative. The original evidence is not replaced or deleted. See [`LOCAL_FIRST_R32_CACHE_ACCEPTANCE.md`](LOCAL_FIRST_R32_CACHE_ACCEPTANCE.md) section 12.

## 1. Baseline and environment

- Scratch worktree detached at `aa2a415`; main HEAD = origin = `37213ba` (P2a-6 closeout, pushed first: local == origin, ahead 0 / behind 0, `?? mise.toml`).
- Node 24.14.1, npm 11.11.0, SQLite 3.51.2 (`select sqlite_version()` in the writer), macOS 12.7.6, Intel i7-6700K iMac, 64 GB, APFS SSD. `COPILOTKIT_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`. Fake provider on 127.0.0.1 only. Every writer, reader and the orchestrator ran with a fail-closed egress guard.
- PRAGMAs measured in the writer, asserted for every run: `journal_mode = wal`, `synchronous = 2` (FULL), `busy_timeout = 5000`; also recorded `wal_autocheckpoint = 1000`, `page_size = 4096`.
- Production client source restored to baseline before the measurements (Chat.tsx sha `6d6298cc…` = HEAD; `run-origin.ts` removed). The P2a-6 patch is kept in `p2a-evidence/p2a6/client-patch/` (diff, patched copies, SHA-256 of both files, the baseline sha).

## 2. Workload (identical for W1 and W2)

One thread, 100 user turns, real CopilotKit client (`ProxiedCopilotRuntimeAgent`, the client keeps and resends its whole history) → real `CopilotSseRuntime` → scratch SQLite runner → real `DotAgent` → fake provider. Per turn: user message → one server tool call (`list_space_pages`, deterministic, no side effect, a unique tool-call id `call-perf-N`) → tool result → assistant text of 6 chunks 50 ms apart (about 300 ms) → `RUN_FINISHED`. That is 14 events per turn, 1,400 events, 200 provider requests. The 300 ms profile makes the 250 ms W2 timer fire (checked, not assumed).

The writer (server side) and the client run in different processes, so the writer's event-loop delay is the server's own. Each repetition is a fresh writer process on a fresh DB. Order: W1, W2, W1, W2, W1, W2. A 10-turn warm-up per policy ran first and is excluded from every number.

## 3. W1 and W2 as implemented (test-only switch `writePolicy`)

- **W1**: every event, including every text / tool-argument delta, is persisted in its own synchronous transaction, then published (persist-then-publish). The published-but-not-durable window does not exist.
- **W2** (the existing candidate): boundary events persist-then-publish; `TEXT_MESSAGE_CONTENT` / `TOOL_CALL_ARGS` are buffered, flushed by a 250 ms timer or by the next boundary; the terminal event is preceded by a flush.
- Schema unchanged: `conversation_runs`, `conversation_events`, `conversation_messages`. No new index or table. Measurement does not add transactions (it only reads `performance.now()` around each existing BEGIN…COMMIT and pushes to an array).

## 4. Correctness of 100 turns (before performance)

For every run (3 × W1, 3 × W2), from the durable log through a separate read-only connection: 100 `RUN_STARTED`, 100 `RUN_FINISHED`, 100 runs `finished`, 0 `RUN_ERROR`; 100 text messages (start and end), 100 tool calls and 100 results, ids unique, every result matches its call; the assistant text of every turn is exactly the expected 6-chunk string; 100 user / 100 assistant / 100 tool messages, ids unique, every user message exactly once; `isRunning` false; the message cache is fresh and **equals** the messages derived from the log with the public reducer; the client's final messages equal the cache. The ID-normalised conversation (events + messages, existing `Normalizer`) has **one** hash for all six runs: W1 and W2 produce the same logical history. A fresh reader's connect replay equals `compactEvents(log)` event by event.

## 5. Transaction metrics

Counts are exact: **W1 1,500 transactions** (1,400 events, one each, plus 100 message-cache writes); **W2 900** (−40%: 100 run-start, about 300–370 boundary, about 130–200 boundary+delta flush, 100 timer flush, 100 terminal, 100 cache). Per-transaction latency (ms, BEGIN to after COMMIT):

| campaign, host state                                 | policy | mean              | p50                | p95               | p99             | max             | total over 100 turns |
| ---------------------------------------------------- | ------ | ----------------- | ------------------ | ----------------- | --------------- | --------------- | -------------------- |
| campaign 1 and 2 (default flags, quiet host; 6 runs) | W1     | 0.43–0.60         | 0.42–0.45          | 0.60–0.81         | 0.72–2.4        | 2.4–69          | 0.65–0.89 s          |
| same                                                 | W2     | 0.47–0.68         | 0.45–0.46          | 0.66–0.79         | 0.77–2.0        | 2.7–91          | 0.42–0.62 s          |
| campaign 7 (final, `--single-threaded`, noisy host)  | W1     | 0.45 / 7.3 / 9.1  | 0.37 / 0.79 / 1.86 | 0.65 / 8.5 / 11.2 | 2.2 / 134 / 236 | 14 / 755 / 864  | 0.67 / 11.0 / 13.6 s |
| same                                                 | W2     | 3.8 / 10.0 / 11.8 | 0.46 / 2.2 / 2.3   | 0.80 / 9.8 / 33.6 | 89 / 345 / 375  | 469 / 531 / 528 | 3.4 / 9.0 / 10.6 s   |

(Three values per cell are repetitions 1/2/3.) Per kind, in quiet runs every kind is sub-millisecond at p95. The per-run files `w{1,2}-run-N.json` hold the raw per-transaction array and the per-kind statistics (run start, boundary, boundary+delta flush, delta timer flush, immediate delta, terminal, finalize, message cache; recovery was 0 as expected). Campaign 3 and 4 (default flags) are in `campaigns.json`; campaign 4 was also a noisy period.

**Host noise is real.** In campaigns 4 and 7 the same code showed mean latencies of 2–10 ms and single transactions of 0.5–0.9 s (fsync / CPU stalls on this machine, which also crashed other node processes, section 14). No numeric threshold was agreed in advance and none is applied. What the numbers do show: on a quiet host one durable commit costs about 0.45 ms at the median (isolated stalls of tens of ms also occur); with W2 there are 40% fewer commits.

## 6. Event-loop delay (writer)

_Clarification: these figures were measured in the inherited development/test environment (see the clarification above)._

`monitorEventLoopDelay`, resolution 10 ms (the reported values include about one timer interval even on an idle loop: min about 9 ms, p50 10–11.5 ms). All campaigns, both policies: mean 22–30 ms, p95 14–31 ms, **p99 about 510–820 ms, max 1.0–2.0 s**. The stalls are not SQLite writes: they coincide with the **message-cache rebuild** (section 7). A raw histogram dump and the "above the resolution floor" values are in `comparison.json`. Fake-provider waiting is not event-loop delay.

## 7. Where the time goes: the message-cache rebuild (key finding)

_Clarification: the absolute timings in this section were measured in the inherited development/test environment; production-like, turn 100 is about 275–340 ms (see the clarification above and the R32 acceptance document). The "unexplained 4x gap" below was this environment._

At the end of every run the runner re-derives the whole thread's messages with the public reducer (`rebuildMessages` → `deriveMessages`) and writes the cache. Measured in the writer per turn (campaign 1, W1 and W2 alike; campaign 7 shows the same): turn 1 about 1.2–1.6 ms, turn 10 about 17–19 ms, turn 50 about 270–290 ms, **turn 100 about 1.0–1.15 s**; per-run totals 36–49 s of a 70–94 s wall clock. The reducer step is CPU-bound (CPU time ≈ wall time, `derive_reduce_cpu`); reading and parsing the 1,400 rows is 1–3 ms. The cost grows faster than linearly with history. The client-observed turn time grows from about 330 ms (first ten turns) to 1.26–1.8 s (last ten): the run's stream completes only after the rebuild, and `RUN_FINISHED` itself is published earlier. Whether the real Chat would keep its running state about a second longer is an inference, not measured here.

The same reducer on the same 100-turn log in a fresh process takes about 242 ms (`derive-attribution.json`: 10 turns 4 ms, 25 → 19, 50 → 66, 75 → 141, 100 → 242 ms). Inside the live writer it takes about four times longer; the cause was not found (a first suspect, the harness's per-run structuredClone observation, was switched off in campaigns 2 to 7 and changed nothing). This is open.

It is the same for W1 and W2, so it does not decide the write policy, but it is the dominant cost of a 100-turn conversation, far above all SQLite writes combined (0.4–0.9 s per 100 turns on a quiet host); SQLite transaction time is not the dominant cost.

**Candidate direction (not decided, not a production contract):** update the cache incrementally per completed run or per event, and keep the full rebuild as the boot / repair verification path (what `ready()` and the cache-equals-log check do today). This needs a design and a measurement before production integration; it is not stated here that the incremental approach is chosen.

## 8. R27 durability window (W2, published to durable)

Per delta, in the writer, `persistedAt − publishedAt` (700 deltas per run). **Nominal flush interval = 250 ms; observed maximum durable lag = X ms** (not "at most 250 ms": the timer is not a hard real-time bound).

| campaign | p50             | p95             | p99             | max (3 runs)              | deltas over 250 ms |
| -------- | --------------- | --------------- | --------------- | ------------------------- | ------------------ |
| 1, quiet | about 100       | 251.7           | 252.6           | 253.5 / 253.4 / 254.6     | 97–100 of 700      |
| 2, quiet | about 100       | 251             | 252.7           | 253.6 / **354.8** / 285.4 | —                  |
| 7, noisy | 101 / 108 / 109 | 251 / 436 / 276 | 252 / 619 / 584 | **401.9 / 707.0 / 707.7** | 99 / 137 / 128     |

By cause (campaign 7): 540–567 deltas became durable by the timer and 133–160 at the next boundary (boundary flush: p50 2–9 ms, max up to 533 ms). In this workload no delta was left to the terminal or finalize flush, because `TEXT_MESSAGE_END` is a boundary that flushes first. **W1: 0 deltas were published before they were durable** in all three runs (the window does not exist). R27 (P2a-3: a published but unflushed tail is lost on SIGKILL) therefore means, for W2 here, a tail of text the owner has already seen. The window is **not** "250 ms or less": the nominal timer is 250 ms, the observed published-to-durable lag can exceed the timer interval, and the observed maximum in these campaigns is **about 708 ms** (about 253–255 ms on a quiet host, 355 ms once, 0.40–0.71 s on a noisy one). It was **not** exercised with a new SIGKILL (not required). For W1 this process-crash window does not exist by construction. R27 is therefore **quantified, and avoided by the current W1 recommendation**; it is not formally closed until a production write policy is approved.

Scope of the claim: R27 is about a **process** crash (SIGKILL). It says nothing about power loss (section 12).

## 9. Replay benchmark (fresh process, same DB, after a clean writer exit)

10 reader processes per DB (60 total). Fresh process; the OS file-cache state is **not** controlled; this is **not** a cold-disk benchmark. Provider requests 0, runner run calls 0, write transactions 0, DB logical hash unchanged, `ready()` rebuilt 0 and took about 0.5–0.7 ms, `isRunning` false, egress 0, in every reader.

| (ms)                                                     | quiet host (campaigns 1–2)                                 | noisy host (campaign 7), p50 / p95 / max |
| -------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------- |
| raw HTTP connect replay to completion (1,400 events)     | p50 67–73, p95 69–108 (with 10 readers p95 is the maximum) | p50 100–137, p95 106–248, max 248        |
| real client `connectAgent` (rebuilding its 300 messages) | p50 840–899, p95 860–1,460                                 | p50 1,049–1,366, p95 1,200–1,569         |
| `getThreadEvents` (first call; later median)             | about 2.8–3.0 (2.6–3.0)                                    | 3.1–4.0 (3.2–4.4)                        |
| `getThreadMessages` (first; later)                       | 0.43–0.63 (0.32–0.35)                                      | 0.42–0.67 (0.33–0.43)                    |
| `listThreads`                                            | 0.19–0.22                                                  | 0.22–0.36                                |

The runner's side of a reload is about 0.1 s; the real CopilotKit client spends **about 0.85–1.4 s** applying 1,400 events into messages in Node. That client cost is not the runner's and was not compared with the in-memory runner here.

## 10. Storage

Logical (identical for W1 and W2, every run): 100 run rows, 1,400 event rows (100 user, 100 assistant and 100 tool messages in the cache), 1 message-cache row, `sum(length(event_json))` = 173,404 bytes, message cache 47,821 bytes. Physical (taken inside the writer, before it closes; a clean close auto-checkpoints and deletes the WAL): main DB 680–725 KB, WAL **about 4.13–4.17 MB** (the high-water mark of `wal_autocheckpoint = 1000` pages; both policies), shm 32 KB. Then **one** explicit `PRAGMA wal_checkpoint(FULL)` (all frames, waits for readers, does not truncate; no VACUUM): busy 0, 566–723 frames, all checkpointed; main DB afterwards 766–778 KB, WAL file size unchanged (it is reused, not shrunk). W1 and W2 do not differ in logical data, in the bounded WAL size, or after checkpoint; they differ only in how many commits wrote it (1,500 against 900). The message cache is rewritten whole every turn (about 48 KB at turn 100).

## 11. Wall clock and memory

Wall clock of the 100 turns: 68–94 s. The fake provider's waits (about 35 s) and the cache rebuild (36–49 s) dominate; it is **not** a measure of SQLite. Peak RSS of the writer about 385–400 MB (not a PASS condition).

## 12. W1 against W2, and the recommendation

|                                        | W1                                           | W2                                           |
| -------------------------------------- | -------------------------------------------- | -------------------------------------------- |
| correctness, normalised history        | identical                                    | identical                                    |
| transactions per 100 turns             | 1,500                                        | 900 (−40%)                                   |
| per-commit latency, quiet host         | mean 0.43–0.60, p50 0.42–0.45, p95 0.60–0.81 | mean 0.47–0.68, p50 0.45–0.46, p95 0.66–0.79 |
| total commit time, quiet host          | 0.65–0.89 s                                  | 0.42–0.62 s                                  |
| total commit time, noisy host          | 11.0 and 13.6 s (and 0.67 s)                 | 9.0 and 10.6 s (and 3.4 s)                   |
| event-loop stalls                      | the same (cache rebuild)                     | the same                                     |
| replay, storage                        | same                                         | same                                         |
| published-but-not-durable window (R27) | none                                         | nominal 250 ms, observed 0.25–0.71 s         |

There is no agreed numeric threshold and none is invented. Reading the numbers: at personal scale the entire write path costs about 0.65–0.9 s per 100 turns on a quiet host with W1, and W2 saves about 0.2–0.3 s of that in exchange for a durability window of a few hundred milliseconds of already-displayed text. **Recommendation (from these measurements; accepted at review): W1 is the recommended production candidate.** Its measured cost is small, it has no published-but-not-durable window, and the transaction reduction of W2 (about 0.2–0.3 s per 100 turns on a quiet host) is too small a gain at personal scale to justify accepting the R27 window. W2 is retained as a fallback / experimental candidate to be re-evaluated if future concurrency or fsync pressure makes W1 a problem (campaign 4 and 7 showed commits of 0.5–0.9 s on this host); it is not recommended by the current measurements. The 250 ms value is not changed or fixed in this phase. This is a **recommendation, not production adoption approval** for W1, W2 or any value.

**Tune before production integration (separate from W1 against W2):** the message-cache materialization (section 7, risk R32). A per-run rebuild of the whole thread costs about 1 s at turn 100 and grows faster than linearly. This is a design and measurement item, not done here.

Limits of these conclusions: one host (macOS 12.7.6, APFS SSD), one active stream, a fake provider with small texts, a single writer process. `synchronous=FULL` and WAL were confirmed by measurement, but **power-loss durability was not demonstrated**: the scope here is process-crash and durable SQLite commit semantics. macOS hardware-cache flushing (`PRAGMA fullfsync` / `F_FULLFSYNC`) was **not** measured, so the commit cost above is a lower bound for any power-loss-grade durability. R27 (a process SIGKILL; the OS page cache survives it) must not be confused with power-loss durability.

## 13. R31

No C1/C2 failure during P2a-7. In the P2a-6 regression run with the patch re-applied (13/13 and the P1 `chat-error` tests, 33/33 in total) the failure did not recur. R31 stays **OPEN** (one unexplained non-reproducible failure, then seven passing runs of that file in total); it is not a P2a-7 blocker. No stdout/stderr archive was needed, so `p2a-evidence/p2a6/r31/` was not created.

## 14. Node / V8 host instability (open, new: R33)

Observed facts. During the work this host's node processes crashed repeatedly inside **V8 worker threads** (concurrent GC marking, TurboFan compilation): two reader processes in campaign 3 (SIGSEGV, in `ScavengeObject` and in the Turboshaft pipeline), one in campaign 4, the vitest orchestrator itself in campaign 5 (SIGSEGV, `ConcurrentMarking`), and unrelated node processes (an MCP server, an npx status-line helper, `tsc` via npx) as well. The database was checked after the crashes (`integrity_check` and `quick_check` ok, 1,400 rows; the other eight readers on the same DB gave the identical hash): **no durable-DB corruption evidence**. The crash reports are summarised in `p2a-evidence/p2a7-campaign3-reader-crashes/crash-reports/` and `…campaign4…` (scratch only). The faulting stacks are V8 internals, so this is not attributed to the runner or SQLite. **The cause is unknown**; it is not asserted to be a Node / macOS incompatibility.

Measurement-harness mitigations (applied only to the harness, always recorded, never silent):

- V8 `--single-threaded` for every measurement process (campaign 7; identical for W1 and W2);
- a writer that does not print READY within 40 s is killed and restarted before any write (campaign 6 had one silent start hang before any data existed);
- a crashed or hung reader is relaunched at most three times, every attempt recorded (campaign 7: none needed);
- a writer that has started is never retried.

Consequence: the absolute performance numbers in this document are **host-specific and were taken under the single-threaded-V8 measurement condition (final campaign)**; they are not a production absolute-performance prediction. W1 and W2 were measured under the same conditions, alternating, so the numbers are used for the **relative** policy comparison.

## Evidence provenance

- **Used for the decision:** campaign 7 (final, `--single-threaded`): saved as `w1-run-1..3`, `w2-run-1..3`, `comparison`, `replay-benchmark`, `storage`, `durability-window`, `summary`, `derive-attribution`, `campaigns` and `negative-controls` in the scratch evidence directory (scratch only, not in main), with campaigns 1–4 (default flags; campaigns 3 and 4 each had reader-process crashes, campaign 1 had the harness's per-run clone observation on) kept as cross-checks.
- **Invalid / aborted attempts, no evidence generated:** campaign 5 (the vitest orchestrator process crashed, SIGSEGV) and campaign 6 (a writer never printed READY). Nothing from them is used.

## 15. Negative controls (reduced size: 15 turns, 1 repetition, 2 readers; control run without mutation 14/14)

| #   | mutation                                                                           | failing tests                                                                    |
| --- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| N1  | W2 does not write the buffered deltas at boundaries (see the note below the table) | correctness of all turns; normalised W1 == W2; replay                            |
| N2  | W2 timer flush disabled                                                            | "the 250 ms timer really fires"; durable-lag measurement                         |
| N3  | W1 actually buffers                                                                | "W1 opens exactly one transaction per event"; lag-measurement (W1 has no window) |
| N4  | message cache not updated                                                          | correctness (fresh and equal to the log); replay / reader writes                 |
| N5  | replay drops one event                                                             | replay equals `compactEvents(log)`                                               |

N1 note: the mutation that only removes the flush just before the terminal event is **not a meaningful mutation for this workload**, because the `TEXT_MESSAGE_END` boundary already flushes the buffer first; the boundary flush was therefore disabled instead, which was detected. The scratch runner was restored byte-identically after each mutation (sha checked); results in the scratch `negative-controls/`.

## 16. Regressions, egress, files

- Production `src/` at baseline: P2a-0, 8a, 1, 8b, 2, 4, 5, 3 and the P1 `chat-error` tests: **143 passed, 0 failed** (including every actual-SIGKILL scenario and the five "production source is untouched" guards, which pass at baseline). P2a-7 itself: 14/14 (final campaign).
- P2a-6 UX with the saved patch re-applied (hashes verified equal to the saved ones), client rebuilt: **33/33**; then the patch was removed and the baseline hash verified.
- Golden fixtures: 17 files, hash-identical. `prettier --check` and `git diff --check` clean. Main worktree `?? mise.toml` only.
- Egress: 0 for every writer, reader and the orchestrator; all runs 200 provider requests per 100 turns, nothing else.
- Changed / new scratch files: `tests/p2a/sqlite-runner.ts` (test-only `writePolicy`, `metrics`, `onFinalize`; derive timing), `tests/p2a/fake-model.ts` (the `[[perf:N]]` scenario, unique tool-call id), `tests/p2a/harness.ts` (`observeRuns` option), `tests/p2a/p2a7-writer.ts`, `p2a7-reader.ts`, `p2a7-attribution.ts`, `p2a7.test.ts`, `p2a-evidence/p2a7*`, `p2a-evidence/p2a6/client-patch/`, this document.

## 17. Open issues

1. **R32:** message-cache rebuild cost (section 7), and the unexplained 4× gap between the live writer and a fresh process. _(The 4× gap was later explained by R32: the inherited development/test environment, see the clarification near the top.)_
2. The real client's `connectAgent` of a 100-turn thread takes about 0.85–1.4 s in Node (not compared with the in-memory runner; not the runner's cost).
3. **R27:** the durable lag exceeded the nominal 250 ms (observed maximum about 0.71 s); not exercised under SIGKILL again; quantified and avoided by the W1 recommendation, not formally closed.
4. `fullfsync` / power-loss durability was not measured (process-crash and commit semantics only); single host, single stream.
5. **R31** open (cause of the one-off failure unknown); **R33** host / Node-V8 instability open (section 14).
6. Concurrent conversations, a larger tool output, real-provider timing and the multi-process writer (R17) were not measured.

## 18. Verdict

**P2a-7: PASS (scratch).** Both policies completed the 100-turn workload in three alternating repetitions; the conversation stayed correct and identical for W1 and W2; transaction counts, latency distributions, event-loop delay, the R27 published-to-durable lag (timer against boundary) and the fresh-process replay were measured; the database was never corrupted and no committed event was lost; the existing P2a recovery semantics and the P2a-6 UX did not regress; golden unchanged; egress 0.

**Recommendation: W1 is the recommended production candidate; W2 is a retained fallback / experimental candidate, not recommended by the current measurements.** Message-cache materialization needs tuning before adoption. No production approval for W1, W2 or the 250 ms value. R27 is quantified and avoided by the W1 recommendation, not formally closed; R31 stays OPEN; R32 and R33 are new open items.
