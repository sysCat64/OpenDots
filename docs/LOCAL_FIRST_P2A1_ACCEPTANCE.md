# Local-first P2a-1 acceptance: durable SQLite runner, restart across real processes

**Status:** P2a-1 was **executed in a temporary scratch worktree** (`/private/tmp/opendots-p2a1.FV0LOx`, detached at `aa2a415`) and **PASSED**. This document was afterwards **copied to the main worktree as closeout documentation**. The scratch runner, tests and raw evidence (`tests/p2a/*`, including `sqlite-runner.ts`, `db-dump.ts` and `p2a1-*.ts`, and `p2a-evidence/*`) remain in the scratch worktree and are **not** part of the main worktree. **Production integration has not been done; no production source, test, migration, dependency or configuration was changed.** The scratch runner is a candidate that was observed to work, not an approved production implementation.
**Baseline:** branch `feat/chatgpt-plan-provider`, commit `aa2a4157fa3b99b3176bdd7ea99cd8fb4d77266a`. P2a-0 PASS, P2a-8a PASS.
**Scope:** P2a-1 only. At execution time P2a-8b and everything listed in section 12 had not been started. **Since then P2a-8b has been executed in the same scratch worktree and PASSED** ([`LOCAL_FIRST_P2A8B_ACCEPTANCE.md`](LOCAL_FIRST_P2A8B_ACCEPTANCE.md)). **P2a-2 is GO and not started**; the items in section 12 remain unevaluated.

## Verdict

```text
P2a-1: PASS
```

All fourteen PASS criteria hold. No golden divergence appeared. **GO for P2a-8b** (section 13), which has since been executed and passed. At execution time nothing was committed, pushed or tagged.

| #   | Criterion                                                                                    | Result |
| --- | -------------------------------------------------------------------------------------------- | ------ |
| 1   | G0 normal run succeeds through the real client / runtime path                                | PASS   |
| 2   | `RUN_STARTED` including the user input is durable in SQLite (before any agent or model work) | PASS   |
| 3   | Completed raw events are stored in ordered, event-per-row form                               | PASS   |
| 4   | Process A exits                                                                              | PASS   |
| 5   | A different-PID process B opens the same DB with a new runner                                | PASS   |
| 6   | `connect` replay equals the normalized G0 golden                                             | PASS   |
| 7   | `getThreadMessages` equals the G0 messages                                                   | PASS   |
| 8   | The message cache is reproducible from the authoritative events                              | PASS   |
| 9   | `listThreads` contains the thread                                                            | PASS   |
| 10  | `getThreadState` is `null`                                                                   | PASS   |
| 11  | `isRunning` is false after restart                                                           | PASS   |
| 12  | No provider request occurs in the reader / restart processes                                 | PASS   |
| 13  | No unexpected external egress                                                                | PASS   |
| 14  | Production / main worktree untouched                                                         | PASS   |

## 1. Baseline and environment

| Item                                   | Value                                                                                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scratch worktree                       | `/private/tmp/opendots-p2a1.FV0LOx` (detached at `aa2a415`)                                                                                                                                 |
| Reused from the P2a-0 scratch worktree | `tests/p2a/*` and `p2a-evidence/*` (copied; the golden evidence was not changed: the 17 files under `p2a-evidence/golden` hash identically before and after, and match the manifest hashes) |
| Node / npm                             | **v24.14.1 / 11.11.0** (installed binary first on `PATH`; `mise.toml` not used)                                                                                                             |
| OS                                     | macOS 12.7.6                                                                                                                                                                                |
| Packages                               | `@copilotkit/runtime`, `core`, `react-core` 1.75.0; `@ag-ui/client` 0.0.59; `@tanstack/ai` 0.63.0; SQLite 3.51.2 (bundled with `node:sqlite`)                                               |
| `node_modules`                         | APFS clone of the main worktree's; no `npm install`; `package.json` / lock unchanged                                                                                                        |
| Env                                    | `COPILOTKIT_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`, asserted in the orchestrator and in each child process                                                                                 |

## 2. What was built (scratch only)

| File                                    | Role                                                                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `tests/p2a/sqlite-runner.ts`            | the scratch durable `AgentRunner` (about 560 lines, comments included)                                                              |
| `tests/p2a/db-dump.ts`                  | logical dump and hash of the conversation tables                                                                                    |
| `tests/p2a/p2a1-writer.ts`              | process A (and the boundary-flush variant)                                                                                          |
| `tests/p2a/p2a1-reader.ts`              | process B and C                                                                                                                     |
| `tests/p2a/p2a1.test.ts`                | orchestrator: spawns the real processes, asserts the 14 criteria                                                                    |
| `tests/p2a/fake-model.ts`, `harness.ts` | two small backward-compatible additions: an `onRequest` hook, and `buildEnv` accepting a file-backed workspace and a runner factory |

The runner uses only public contracts: `AgentRunner`, `createRunEventFinalizer` and the `LocalThreadEndpointRunner` method set (`@copilotkit/runtime/v2`), and `compactEvents`, `defaultApplyEvents` (`@ag-ui/client`). It takes an **externally opened `DatabaseSync`** and never opens a connection of its own. In the scratch harness it is handed the **`WorkspaceStore`'s own connection**, so there is no third connection. (The handle is read from a private field in the harness; a real design would need the workspace to expose it or host the conversation store. This is a PoC shortcut.) The only other connection to the database file in the writer process is a **read-only probe**, used by the test to observe what is committed; it is not part of the runner. (The scratch `Store` uses a separate in-memory database that never touches the file.)

### Schema used (baseline candidate, not the final production schema)

```sql
CREATE TABLE conversation_runs(      -- run metadata / ordering / status
  thread_id TEXT NOT NULL, run_id TEXT NOT NULL, seq INTEGER NOT NULL,
  agent_id TEXT NOT NULL, parent_run_id TEXT, status TEXT NOT NULL,
  started_at INTEGER NOT NULL, finished_at INTEGER,
  PRIMARY KEY(thread_id, run_id), UNIQUE(thread_id, seq));

CREATE TABLE conversation_events(    -- AUTHORITATIVE, append-only, one row per AG-UI event
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL, run_id TEXT NOT NULL, seq INTEGER NOT NULL,
  event_type TEXT NOT NULL, message_id TEXT,       -- helper index columns, not authoritative
  event_json TEXT NOT NULL,                        -- the WHOLE event; no field projection
  UNIQUE(thread_id, run_id, seq));

CREATE TABLE conversation_messages(  -- rebuildable CACHE only
  thread_id TEXT PRIMARY KEY, messages_json TEXT NOT NULL, last_event_id INTEGER NOT NULL);
```

`event_json` holds the event exactly as received, so unknown fields survive. The runner creates these tables itself in the scratch database; no production migration exists.

## 3. `RUN_STARTED` durability

**Why it matters.** The user's message exists durably only inside `RUN_STARTED.input.messages`, so the run-start state must be committed before any model work.

**Laziness, checked before implementing.** `BuiltInAgent.runFactory` returns an `Observable` that, **on subscription**, emits `RUN_STARTED` synchronously and then starts its asynchronous work (`await prepareLearnedSkills(...)`, then the factory, which reaches the model). `DotAgent.run` is likewise a lazy `Observable`. The AG-UI client pipeline awaits each `onEvent` callback (`concatMap(async …)`), but the source keeps running while the callback executes, so **persisting inside `onEvent` would race with model work**: it would very probably win, but nothing guarantees it. Observed order in the writer (one ordered log shared by the probes and the runner):

```text
persist:RUN_STARTED(pre-agent)
probe:DotAgent.run() called
probe:DotAgent observable subscribed (first agent code)
publish:RUN_STARTED                        (the agent's RUN_STARTED reached onEvent)
probe:fake model: first/next request arrived
persist:TEXT_MESSAGE_START …
```

**Strategy chosen: pre-persist a synthetic `RUN_STARTED`.** `run()` builds `{type: RUN_STARTED, threadId, runId, input: {…input, messages: sanitised}}`, inserts the run row and event row 0 in one synchronous transaction, **commits, and only then starts the agent**. The agent's own `RUN_STARTED` is not stored a second time: when it arrives in `onEvent` the runner sets its `input` to the persisted one (as the reference does), publishes it, and records whether it matched. Evidence:

- **Exactly one** `RUN_STARTED` row exists, and the published stream has exactly one.
- The agent's own event had exactly the keys `type, threadId, runId` and the same ids (`startEventMatchedAgent: [true]`), so the synthetic event is equivalent to it plus `input`.
- Probed through a **separate read-only connection**, the run row (status `running`) and a `RUN_STARTED` row whose `input.messages` contains the user message were **already committed at all three points**: when `DotAgent.run()` was called, when its Observable was subscribed (the first agent code), and when the fake provider received its first request.

If an agent ever emitted no `RUN_STARTED` (a startup failure), the runner publishes the persisted one at finalise so the live stream stays consistent (code path present, **not exercised** here).

## 4. Event write policy (W2, baseline candidate)

- **Boundary events** (`RUN_STARTED`, `TEXT_MESSAGE_START`, `TEXT_MESSAGE_END`, `RUN_FINISHED`, and every non-delta event) are **persisted, then published**, in one synchronous transaction that also writes any buffered deltas ahead of them.
- **Deltas** (`TEXT_MESSAGE_CONTENT`, `TOOL_CALL_ARGS`, `REASONING_MESSAGE_CONTENT`) are published immediately and **buffered** for a timer flush (default 250 ms) or the next boundary.
- No transaction spans an `await`. The message cache is rebuilt after the terminal transaction, outside any transaction.
- Raw events are stored uncompacted (six content rows for G0); compaction happens at read time, in `connect` and `getThreadEvents`.

Observed (default 250 ms; the stream emits a delta every 150 ms): `persist:flush(2 buffered)` three times, so all six deltas were flushed by the timer; then `persist:TEXT_MESSAGE_END`, `persist:RUN_FINISHED`; **8 transactions** in the writer (start, text start, three flushes, text end, run finished, cache rebuild). A supplementary writer with a 5 000 ms interval flushed nothing by timer and wrote all six deltas **with** the boundary: `persist:TEXT_MESSAGE_END+6 buffered` (5 transactions). Both variants restart into the identical golden.

Crash tolerance was **not evaluated** (clean runs only).

## 5. Processes and results

| Process                                | PID           | Role                                                                                                             | Exit                                        |
| -------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| orchestrator (vitest)                  | 50859         | spawns and observes                                                                                              | n/a                                         |
| **A**                                  | **50875**     | writer: G0 through real client → real `CopilotSseRuntime` → scratch SQLite runner → real `DotAgent` → fake model | 0 (clean); confirmed gone (`kill -0` fails) |
| **B**                                  | **50925**     | reader: new process, same DB file, new runner instance                                                           | 0                                           |
| **C**                                  | **50940**     | reader: one more restart (idempotence)                                                                           | 0                                           |
| writer (boundary variant) / its reader | 50977 / 51047 | supplementary                                                                                                    | 0 / 0                                       |

All six PIDs are distinct. (The PIDs are those of the run recorded when this document was written. Each rerun of the test records fresh PIDs in the scratch `p2a-evidence/p2a1/summary.json`, so the scratch file now shows different ones; only distinctness is asserted.)

**Writer (A).** `status = finished`, `isRunning = false`, event sequence `0..9` contiguous, exactly one `RUN_STARTED` and one `RUN_FINISHED`. The 10 stored rows are, in order: `RUN_STARTED`, `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT ×6`, `TEXT_MESSAGE_END`, `RUN_FINISHED`, and **each row's `event_json` is deep-equal to the event the runner emitted**. Provider requests: 1.

**Restart readers (B, C).** Each process creates a new runner on the same file, calls `ready()` (`{checked: 1, rebuilt: 0}`: nothing stale, nothing written), then reads `connect` (HTTP replay), `getThreadEvents`, `getThreadMessages`, `getThreadState`, `listThreads`, `isRunning` through the same `snapshot()` used for the P2a-0 goldens, and finally runs the **real client's `connectAgent`** against the restarted runtime. Results: replay `RUN_STARTED, TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT, TEXT_MESSAGE_END, RUN_FINISHED`; thread record `{name: null, archived: false, organizationId: "", createdById: ""}` with the Dot id as `agentId`; `getThreadState` `null` (also over HTTP: `{"state": null}`); `isRunning` false; the real client rebuilt the same two messages (ids, roles, content). **Zero write transactions, zero provider requests.**

## 6. Golden differential result

The comparison is strict and whole-file. A durable capture is assembled in the **same structure** as the P2a-0 G0 fixture (`{scenario, runs: [writer's run], snapshot: reader B's snapshot}`), normalized with the **existing P2a normalizer**, and compared as canonical JSON with `p2a-evidence/golden/normalized/normal.json`:

```text
durable normalized capture  ==  G0 golden (byte for byte, canonical form)     PASS
```

That one comparison covers, in a single equality: the writer's raw events and request input and client events, the restart `connect` replay (equal to the G0 compacted golden), `getThreadEvents`, `getThreadMessages`, `getThreadState` (`null`), the thread record, `isRunning` (false), and the four HTTP thread projections. Reader C's capture equals B's; process A's own snapshot and the boundary-flush variant also equal the golden. **No divergence appeared, so nothing was normalized away and no fixture was edited.** P2a-1 is not G3, so no intentional divergence applies.

## 7. Message-cache rebuild

| Check                                                                                                      | Result                                                    |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| messages derived from the authoritative events with the public reducer (`defaultApplyEvents`), in writer A | equals the cache                                          |
| the same derivation in a **new process** (B)                                                               | equals the cache and A's derivation                       |
| cache `last_event_id`                                                                                      | 10, equal to the log's last event id (the staleness test) |
| cache equals the G0 golden messages                                                                        | yes                                                       |
| `ready()` at restart                                                                                       | `{checked: 1, rebuilt: 0}`                                |

The event log is the only authority; the cache can always be rebuilt from it.

## 8. Database state

| Item                                                                                       | Value                                                                                                                                |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Temporary DB                                                                               | created per run under the OS temp directory, e.g. `…/T/p2a1-HP16sX/conversation.sqlite` (as recorded when this document was written) |
| Logical rows after A                                                                       | `conversation_runs` 1, `conversation_events` 10, `conversation_messages` 1                                                           |
| Logical hash (runs, events, messages)                                                      | `296bc0669d6694423fc00817451207f636d4091deb4c6d1908fbc24a45b964ce`                                                                   |
| After reader B (before / after), reader C (before / after), and a fresh third-process read | the **same counts and the same hash**; the run timing columns are identical too (`timingSha256`)                                     |

Reader-only restarts therefore change nothing: not the run count, the event count, the cache, or any row. The dump is logical (rows), not file bytes.

## 9. Egress

Server-process instrumentation (`fetch` and socket connect to any non-loopback host are refused and recorded), in **all five processes**: non-loopback fetches **0**, non-loopback sockets **0**. The fake provider is on `127.0.0.1`. No OpenAI, ChatGPT/SIWC, CopilotKit cloud, Slack, voice, Keychain, `.env` or external-web access; no network probe. This is instrumentation of these processes' `fetch` and sockets, not an operating-system-level guarantee.

## 10. Test results

| Run                                                                                                                                          | Result                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `tests/p2a/p2a1.test.ts` (the 14 criteria, plus idempotence and the boundary variant)                                                        | **19 passed**                                                                           |
| all of `tests/p2a` (P2a-0 golden, P2a-8a, P2a-1)                                                                                             | **36 passed** (P2a-0 golden tests re-run in verify mode against the unchanged fixtures) |
| existing offline suites (`tanstack-agent`, `chatgpt-plan`, `siwc-contract`, `run-error-contract`, `dot-agent-channel`, `workspace`, `pages`) | 35 passed                                                                               |
| `prettier --check tests/p2a`                                                                                                                 | passed                                                                                  |

**Negative controls** (the assertions have teeth). Four temporary mutations of the runner were each caught and then reverted (the file was restored byte-identical and the suite re-run green): publishing before persisting a boundary failed the persist-then-publish test; writing an empty message cache failed the replay, message and cache tests; dropping the persisted input from `RUN_STARTED` failed the verbatim-storage and golden tests; making `connect` skip history failed the golden and real-client tests.

## 11. Deviations from the P2a design

| Design said                                                   | Observed                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persist the agent's `RUN_STARTED` as a boundary, then publish | A **synthetic** `RUN_STARTED` is committed before the agent starts, and the agent's own event is merged into it. This is stronger (committed before any agent code) and was needed because `onEvent` can race with the model work                                                                                     |
| The message snapshot can be rebuilt on read                   | `getThreadMessages` is **synchronous** by contract, but `defaultApplyEvents` is **asynchronous** and starts from `agent.messages`, not `input.messages`. The cache must therefore be maintained **eagerly** (at finalise) and repaired at startup (`ready()`); a stale cache can only be reported, not rebuilt lazily |
| The runner shares the `WorkspaceStore` connection             | Done in the harness through a private field. A real design needs an explicit seam                                                                                                                                                                                                                                     |
| `listThreads` timestamps                                      | The PoC uses run start/finish times; the reference uses finalise time. Normalized away, not compared; a design choice for later                                                                                                                                                                                       |
| Raw events stored, compaction at read                         | Confirmed: 6 content rows store; `connect` and `getThreadEvents` compact to the same 5 events as the reference                                                                                                                                                                                                        |

## 12. Implemented but not evaluated (do not read as accepted)

The runner contract needs these methods, so a basic version exists; **none was exercised or accepted here**: `stop` and the stop closers, the finalise path for errors and interrupted runs, the concurrent-run refusal, live join of `connect` to an active run, multi-run input sanitising (the PoC adds `parentMessageId` to the message-id set, which diverges from the reference on purpose and is untested), `clearThreads` (scratch only; a production runner should refuse it). Also out of scope and untouched: `kill -9` recovery, interrupted `RUN_ERROR`, server-tool crash, HITL restart, multi-turn dedup, 100-turn performance, provider continuation, P2a-8b, P2b, production migration and runner integration.

## 13. Open issues and Go/Hold

Open issues carried forward:

- A `running` row left by a crashed process is ignored today (not listed, not running). Recovery is P2a-3.
- Per-boundary `synchronous=FULL` cost and event-loop impact are unmeasured (P2a-7).
- The cache-repair strategy (`ready()` at startup versus another seam) and how production would obtain the shared connection need a decision before integration.
- `getThreadMessages` throws on a stale cache outside an active run; whether that or a best-effort return is right is a design choice.

```text
P2a-1: PASS
```

**GO for P2a-8b** (opaque string fidelity through the durable runner, restart included): the runner stores whole events as JSON text and replays them through `compactEvents`, which is exactly what 8b exercises. **Update:** P2a-8b was run afterwards and PASSED ([`LOCAL_FIRST_P2A8B_ACCEPTANCE.md`](LOCAL_FIRST_P2A8B_ACCEPTANCE.md)); **P2a-2 is GO and not started.**
