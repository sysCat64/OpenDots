# Local-first C4 landing boundary review

**Status: APPROVED BOUNDARY (owner decision GO, 2026-10-08). C4 implementation has NOT started.** This review was design and preflight work: it changed no production file, test, dependency, migration or configuration, nothing in it executes anywhere in production, and the commits it defines (C4a, C4b) are **not activations**. C4a, C4b and C5 are not started, and P2a-9 and P2b-1 stay HOLD. The review used no network and opened only throwaway databases under the OS temp directory. The evidence directory `c4-design-evidence/` is **not part of this repository**: it is held in the persistent scratch and in a manifest-verified snapshot under `/Users/martha/Documents/Repositories/opendots-local-first-snapshots/` (directory `c4-boundary-closeout-*`).

| Item               | Value                                                                                                                                                                                                                                                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authority (main)   | `ad0f1459670a4e41fc9aff656b1716b550796622`, branch `feat/chatgpt-plan-provider`, equal to origin, status `?? mise.toml`. C1 `b325d66`, C2 `5f04507`, C3 `b83ce70` and the hardening record `ad0f145` are integrated and pushed                                                                                                            |
| Persistent scratch | `/Users/martha/Documents/Repositories/opendots-local-first-scratch` (HEAD `0686e0b`, detached). Its PoC runner (`tests/p2a/sqlite-runner.ts`) is read only as the record of the accepted P2a semantics; none of it is copied                                                                                                              |
| Evidence           | `c4-design-evidence/`, in the persistent scratch and in the verified snapshot above (eight generator scripts, eight JSON outputs, a README). Not copied into this repository                                                                                                                                                              |
| Acceptance runtime | **Node 24.14.1** (installed by mise under `/Users/martha/.local/share/mise/installs/node/24.14.1`, used by putting its `bin` directory first on `PATH`; `mise.toml` is untouched). The default shell `node` is v22.23.1, which is **not** the acceptance runtime: `engines.node` is `>=24.0.0` and CI runs Node 24. Baseline in section 0 |

Reading guide. **Verified** means read in production source at `ad0f145`, in the installed SDK 1.75.0, or measured by a script in `c4-design-evidence/`. **Design** is a proposal of this review. **Not validated by the PoC** marks anything the P2a series never exercised; those are the places where production will deliberately differ from the reconstructed runner. Source references are `file:line` and are listed with their text in `c4-design-evidence/sdk-contract.json`.

---

## 0. Approval record (2026-10-08)

The owner reviewed this document and approved the boundary: **GO, C4a then C4b; C4 is not activated in either commit.** The decisions below carry the same numbers in `docs/LOCAL_FIRST_PRODUCTION_INTEGRATION_DECISIONS.md`, which is authoritative if the wording ever differs.

| Decision | Subject                 | What it fixes                                                                                                                                                                                                                                    | Section  |
| -------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| DEC-18   | Schema naming           | Table names snake_case, column names camelCase. `conversation_runs`, `conversation_events`, `conversation_messages` stay. "Production camelCase naming" means production **column** naming                                                       | 5.1      |
| DEC-19   | R23 tool classification | A tool is client-executed only if the client declared it in the persisted `RUN_STARTED.input.tools` **and** its name is in the server-owned `clientExecutableToolNames`. The client may narrow, never widen. A precise contract test is required | 14       |
| DEC-20   | C4 split                | C4a (storage, schema, pure rules, SDK pin) and C4b (dormant runner, recovery, crash tests). **Once C4a is accepted its schema and storage contract are frozen for C4**; a real defect means STOP and an explicit C4a correction                  | 24, 5.8  |
| DEC-21   | R26a                    | Approved **conditionally**: `RUN_ERROR` `INCOMPLETE_STREAM`, status `interrupted`, never `finished`; accepted behaviour only after its real-process `SIGKILL` test passes; R26b stays OPEN and is not generalized                                | 23       |
| DEC-22   | SDK pin scope           | Pin only `@copilotkit/runtime` to `1.75.0`, at C4a. A new semi-public dependency on `core`, `react-core` or `channels` means stop and request review                                                                                             | 7.1      |
| DEC-23   | Local thread contract   | C4b includes the required `ownsThread` option with a direct contract test (an OpenDots-defined seam; see the precision note in 8.1); `clearThreads()` refuses and throws, never deletes                                                          | 8        |
| DEC-24   | Database injection      | No `workspace.ts` change in C4. `ConversationLog` receives an injected `DatabaseSync`. R16 stays resolved                                                                                                                                        | 4.2, 5.9 |

**Disposition of the eight confirmation points** (the points themselves are in section 27):

| Point | Disposition                                                                                                                                        |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1    | Approved as **DEC-18**                                                                                                                             |
| Q2    | Approved as **DEC-19**, with the clarified name `clientExecutableToolNames` (replacing "server allow-list")                                        |
| Q3    | Approved as **DEC-20**, with the added freeze rule                                                                                                 |
| Q4    | Approved **conditionally** as **DEC-21**                                                                                                           |
| Q5    | Approved as **DEC-22**                                                                                                                             |
| Q6    | Approved as **DEC-23**                                                                                                                             |
| Q7    | Approved as **DEC-24**                                                                                                                             |
| Q8    | Approved: the H2 classification is recorded in the decision record (OPEN; must resolve before shipping; does **not** block C4; no policy accepted) |

**`lastEventId` and the C8 checkpoint (owner request, resolved).** The apparent ambiguity is resolved from the exact DDL: `conversation_messages.lastEventId` is a minimal C4 freshness watermark required by the full-rebuild implementation (option A), **not** part of the deferred R32 checkpoint. The four R32 fields that stay deferred to C8 are `throughRunSeq`, `throughEventSeq`, `eventCount` and `messagesSha256`. **The proposed C4a schema does not change.** Section 5.7.

**Node 24 preflight (owner requirement before C4a): AVAILABLE.** An installed Node `24.14.1` runs on this machine (macOS 12.7.6, x64; V8 13.6; SQLite 3.51.2; npm 11.11.0). Execution method: prefix `PATH` with `/Users/martha/.local/share/mise/installs/node/24.14.1/bin`, so `node`, `npm`, `npx` and the child processes the tests spawn all use it; nothing was installed or downloaded and `mise.toml` was not touched. Baseline at `ad0f145` under Node 24: C1 telemetry 4 files / 16 tests passed; C2 authorization and startup 5 files / 44 passed; C3 DotAgent 7 files / 32 passed; **full suite 66 files passed, 1 skipped; 714 tests passed, 1 skipped, in two consecutive runs**; `check-format`, `lint`, `typecheck` and `build` clean. The counts equal the Node 22 results. No R31 or R33 observation. Node 22 results stay useful evidence but are not the acceptance authority: **C4 is accepted on Node 24.**

## 1. Verdict and the twelve answers

**Verdict: C4 is GO, as two commits (C4a, then C4b), approved by the owner on 2026-10-08 (section 0).** No HOLD condition was found. In particular the condition "if production cannot express R23 robustly, C4 is HOLD" does **not** trigger: tool classification needs no hardcoded tool name (section 14). R26 stays **OPEN** and the conservative rule does not depend on closing it (section 23). C4 changes no current production behaviour (answer L).

| #   | Question                                    | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | Exact C4 production files?                  | **Three new dormant modules and no change to any existing `src/` module.** C4a: `src/server/conversation-log.ts`, `src/server/run-rules.ts`. C4b: `src/server/durable-runner.ts`. Plus `package.json` and `package-lock.json` (the exact pin, C4a), and in C4b the `test:crash` script, a vitest exclude, a crash vitest config and a CI job (DEC-12). Section 24                                                                      |
| B   | One commit or split?                        | **Split into C4a (data contract and rules) and C4b (the runner).** The split is by review concern and each half is complete, tested and dormant on its own. A single C4 would be roughly 5,000 lines. Section 24.4                                                                                                                                                                                                                     |
| C   | Exact three-table schema?                   | `conversation_runs`, `conversation_events`, `conversation_messages`, camelCase columns, one extra index, no foreign key, no `CHECK`, no version table. Section 5                                                                                                                                                                                                                                                                       |
| D   | DDL only, zero production execution?        | **Yes.** `ConversationLog` has a constructor that touches nothing and an explicit `ensureSchema()`; no `src/` module calls it, and no `src/` module imports the new modules. Tests call it on throwaway databases only. Sections 5.4 and 20                                                                                                                                                                                            |
| E   | Exact `AgentRunner` method contract?        | Section 8: `run`, `connect`, `isRunning`, `stop`, plus the five local-thread methods (`clearThreads` **refuses**), plus OpenDots-only `messagesFor`, `ready`, `stopAll`                                                                                                                                                                                                                                                                |
| F   | Exact R23 predicate?                        | `isClientExecuted(name) := declaredIn(RUN_STARTED.input.tools, name) AND clientExecutableToolNames.has(name)`, where `clientExecutableToolNames` is server-owned configuration naming the tools that may legally run on the client, **injected** by the composition root (at C6, built from `pageReviewTool.name`). Anything else is a server tool. The client may narrow the set, never widen it. Section 14 (DEC-19)                 |
| G   | Exact DEC-5 predicate?                      | Reject iff some `assistant` message in the **input** carries a tool call whose id has a **durable `TOOL_CALL_RESULT` in the thread's log** and the input has **no `tool` message for it**. A prompt-only input has no assistant tool calls, so it is accepted. Section 15                                                                                                                                                              |
| H   | Exact R34 full-rebuild-era fallback?        | The run's outcome never depends on the cache. Readers use `messagesFor()`, which returns the cache only when `lastEventId` equals the thread's `MAX(id)` and nothing is running, and otherwise derives from the events. One in-line repair attempt at finalization, natural catch-up at the next finalization and at `ready()`. The SDK's synchronous messages endpoint fails closed while stale (OpenDots never calls it). Section 16 |
| I   | R26 status and conservative behaviour?      | **OPEN.** Rule R26a (DEC-21, conditional): a run holding only fully closed text messages, no tool call and no other event family is closed with `RUN_ERROR(INCOMPLETE_STREAM)`, status `interrupted`, never `finished`, and becomes accepted behaviour only after its real-process `SIGKILL` test passes. R26b stays deferred and is not generalized. Section 23                                                                       |
| J   | How is dormancy proved?                     | Four layers: static unreachability from every production root, a runtime module-load trace in a real server process, "no conversation tables" after real flows, and the existing Intelligence-path suites staying green and unmodified. Section 19                                                                                                                                                                                     |
| K   | Exact `@copilotkit/runtime` version pinned? | **`1.75.0`**, the installed and lockfile-resolved version, written as `"1.75.0"` with no range. Section 7                                                                                                                                                                                                                                                                                                                              |
| L   | Does current production behaviour change?   | **No.** Only the dependency specifier changes (to the version already installed and resolved). All other C4 content is dormant code, tests and test infrastructure. Section 19                                                                                                                                                                                                                                                         |

---

## 2. Later-discovered corrections to earlier documents

These were found while preparing this boundary. **The historical production integration design proposal is deliberately not rewritten**: it keeps the statements below as written, and the corrections live here and in the decision record.

| #   | Where                               | What it said                                                                                        | What the evidence shows                                                                                                                                                                                                                               | Consequence                                                                                                                                                                        |
| --- | ----------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Design §7.4                         | "`PRAGMA foreign_keys` is off in production, so [a foreign key] would be inert"                     | **False.** `new DatabaseSync(path)`, exactly how `store.ts:28` and `workspace.ts:18` open, reports `foreign_keys = 1`; it is off only with `enableForeignKeyConstraints: false` (`ddl.json`, section 5.5). No production table declares a foreign key | "No foreign key to `thread_bindings`" stands, for a different reason: it would be **enforced** and would tie log inserts to rows another module owns. Ownership is checked in code |
| 2   | Design §7.6, P3 notes               | The SDK turns a synchronous `RunRejectedError` into "a 200 with an empty stream (`sse/run.mjs:18`)" | The behaviour is real but the **source is `handlers/shared/sse-response.mjs`**: `await observableFactory()` at line 52, its `.catch` at line 121, the already-built `200` at line 130. `sse/run.mjs:18` only builds the factory                       | For DEC-13 at C6 the interception point is the stream factory, not the handler body. C4 only needs a typed error with a stable `code`, thrown before any side effect               |
| 3   | P2a-5 acceptance, table in §14      | A client tool call whose arguments were still streaming is "deferred, nothing written, `running`"   | **Superseded by P2a-3.** Its final table closes it (stock closure, `interrupted`) and the PoC code does the same (`predicates.json`)                                                                                                                  | The class table in section 11 follows P2a-3                                                                                                                                        |
| 4   | Design §16, C4 file list            | "EDIT `src/server/workspace.ts` (explicit `openConversationLog()` seam; NOT called)"                | **No longer required.** The PoC took an injected `DatabaseSync` and "never opens a connection of its own", which also removes R16. Only `store.ts` and `workspace.ts` open connections today (`production-inventory.json`)                            | Dropped from C4 (**DEC-24**). The composition root decides how the connection is opened at C6, keeping C4 free of edits to active code                                             |
| 5   | The usual way to check an exact pin | That `npm ci --dry-run --offline` validates the edited lockfile                                     | **Not sufficient.** It exits 0 for the pinned copy **and** for a control whose lockfile root spec was left stale (`version-pin.json`), so it cannot discriminate                                                                                      | Section 7.1 gives the verification that is used instead (a lockfile diff of exactly one line, `npm ls`, an L0 test)                                                                |

**A deliberate deviation, not a correction.** The design and the PoC classify a tool as client-executed when the client declared it. DEC-19 replaces that with "declared **and** in the server-owned `clientExecutableToolNames`" (section 14). It is not PoC-validated.

---

## 3. What C4 is, and what it is not

**C4 is** the production-capable, **dormant** half of local durable runs: an authoritative event log, a pure rule module (recovery classification, unknown-outcome representation, stale-history interlock), and a durable `AgentRunner` that implements the installed SDK abstraction. It is written so C6 can activate it by wiring alone.

**C4 is not** an activation. After C4 lands:

- the current Intelligence runtime still owns every chat, scheduled, headless and voice request (answer L, section 19);
- no `src/` module imports the new modules, so no runner is ever constructed;
- no code path creates, reads or writes `conversation_*` tables outside tests;
- no user-visible behaviour, response, log line or configuration variable changes.

C4 does **not**: activate `CopilotSseRuntime`; touch headless turns (C5); add R32 checkpoint columns or incremental caching (C8); address D3; implement DEC-3, DEC-7 or DEC-13 (all C6); change `maxIterations`, `OWNER_TOKEN`, telemetry or CSP.

---

## 4. Production file inventory at the pushed C3 checkpoint

Generated by `production-inventory.mjs` against `ad0f145` (41 server modules, 7,020 lines; `src`, `tests` and the package files verified clean first).

### 4.1 New dormant modules

| Module                           | Commit | Role                                                                                                                                       | Imports `@copilotkit/*`?  | Needs the C1 guard first? |
| -------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- | ------------------------- |
| `src/server/conversation-log.ts` | C4a    | DDL, explicit `ensureSchema()`, transactions, typed reads and writes over an **injected** `DatabaseSync`, invariant check                  | No (`@ag-ui/core` types)  | No                        |
| `src/server/run-rules.ts`        | C4a    | Pure functions: `classifyRun`, `recoveryEvents`, `findStaleToolHistory`; the two constants (interruption text, unknown outcome)            | Yes (`finalizeRunEvents`) | **Yes**                   |
| `src/server/durable-runner.ts`   | C4b    | `DurableAgentRunner extends AgentRunner` (+ local thread endpoints), recovery orchestration, full-rebuild messages, `ready()`, `stopAll()` | Yes                       | **Yes**                   |

The C1 invariant is enforced automatically: `tests/telemetry-order.test.ts` evaluates **every** module under `src/server` as a root, so a new importer of the SDK that forgets `import './telemetry-guard.js'` first fails the default suite.

### 4.2 Existing production modules, and whether C4 touches them

| Existing module                                   | Why it is relevant                                                                               | Change in C4                                                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `workspace.ts` (`:18` opens a connection)         | Owns `thread_bindings`, `requireThread`; holds the connection `Pages` and `ComputerStore` borrow | **None.** The runner takes an injected `ownsThread` callback that `WorkspaceStore` can satisfy at C6 |
| `store.ts` (`:28` opens a connection)             | Tasks, runs, settings. Already has a table named `events`, hence the `conversation_` prefix      | **None**                                                                                             |
| `index.ts`                                        | Composition root; the only place a runner could be constructed                                   | **None.** C6 changes it                                                                              |
| `platform.ts`                                     | Builds `CopilotRuntime({ intelligence })` and `createCopilotHonoHandler` (`:65`, `:83`)          | **None**                                                                                             |
| `dot-agent.ts`                                    | The agent the runner will drive; `:259` is the only client tool it honours                       | **None** (C3 already made it key-optional)                                                           |
| `headless.ts`, `voice.ts`, `page-service.ts`      | Current callers of the Intelligence path                                                         | **None** (C5 and C6)                                                                                 |
| `runtime-scope.ts`, `app.ts`, `startup-config.ts` | Owner boundary (C2)                                                                              | **None**                                                                                             |
| `telemetry-guard.ts`                              | Imported first by the two new SDK-importing modules                                              | **None**                                                                                             |
| `pages.ts`, `computer-store.ts`                   | Borrow the workspace connection                                                                  | **None**                                                                                             |

**No existing `src/` file is modified by C4.** This is stricter than the design's §16 (which listed a `workspace.ts` seam) and is the review's strong recommendation: it makes "C4 changes no behaviour" checkable from `git diff --name-status` alone.

### 4.3 Non-source files C4 does edit

| File                       | Commit | Edit                                                                                                        | Authority       |
| -------------------------- | ------ | ----------------------------------------------------------------------------------------------------------- | --------------- |
| `package.json`             | C4a    | `"@copilotkit/runtime": "^1.75.0"` becomes `"1.75.0"`                                                       | DEC-9, explicit |
| `package-lock.json`        | C4a    | root `packages[""].dependencies["@copilotkit/runtime"]` mirrors it (the resolved entry is already `1.75.0`) | DEC-9, explicit |
| `package.json`             | C4b    | adds the script `"test:crash"`                                                                              | DEC-12          |
| `vite.config.ts`           | C4b    | `test.exclude` gains `tests/crash/**` so the default `npm test` stays light                                 | DEC-12          |
| `vitest.crash.config.ts`   | C4b    | new; same `setupFiles` as the default config; `include: ['tests/crash/**/*.test.ts']`; longer timeouts      | DEC-12          |
| `.github/workflows/ci.yml` | C4b    | a `crash` job (`npm run test:crash`) alongside `check`                                                      | DEC-12          |

---

## 5. Schema contract (DEC-6)

### 5.1 The exact DDL (defined by C4a, executed by nothing in production)

```sql
CREATE TABLE IF NOT EXISTS conversation_runs(
  threadId TEXT NOT NULL, runId TEXT NOT NULL, seq INTEGER NOT NULL,
  agentId TEXT NOT NULL, parentRunId TEXT, status TEXT NOT NULL,
  startedAt INTEGER NOT NULL, finishedAt INTEGER,
  PRIMARY KEY(threadId, runId), UNIQUE(threadId, seq));
CREATE TABLE IF NOT EXISTS conversation_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, threadId TEXT NOT NULL, runId TEXT NOT NULL,
  seq INTEGER NOT NULL, eventType TEXT NOT NULL, messageId TEXT, eventJson TEXT NOT NULL,
  UNIQUE(threadId, runId, seq));
CREATE INDEX IF NOT EXISTS conversation_events_thread ON conversation_events(threadId, id);
CREATE TABLE IF NOT EXISTS conversation_messages(
  threadId TEXT PRIMARY KEY, messagesJson TEXT NOT NULL, lastEventId INTEGER NOT NULL);
```

Executed unchanged in `ddl-validation.mjs` against throwaway databases: idempotent on a second run, no collision with any production table, and no production source mentions the new names (`ddl.json`).

**Naming (DEC-18).** "Production camelCase naming" (DEC-6) means production **column** naming. Table names are snake_case and column names are camelCase, matching the production convention (`thread_bindings(id, dotId, ownerId, title, createdAt)`). The three table names above therefore stay exactly as written.

### 5.2 `conversation_runs`: run metadata and lifecycle

| Column        | Type    | Null     | Key / constraint                      | Logical meaning                                                                                  | Authority                                                                  | Index                              |
| ------------- | ------- | -------- | ------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ---------------------------------- |
| `threadId`    | TEXT    | NOT NULL | PK part 1; UNIQUE part 1 (with `seq`) | The conversation. Same value as `thread_bindings.id`                                             | Authoritative                                                              | PK autoindex                       |
| `runId`       | TEXT    | NOT NULL | PK part 2                             | The run, as supplied by the client in `RunAgentInput.runId`. Unique **per thread**, not globally | Authoritative                                                              | PK autoindex (Q7: covering lookup) |
| `seq`         | INTEGER | NOT NULL | UNIQUE with `threadId`                | 1-based order of runs in the thread. The ordering authority for replay                           | Authoritative                                                              | autoindex (Q5: last run)           |
| `agentId`     | TEXT    | NOT NULL |                                       | The Dot that owns the run (`agent.agentId`). Used by `listThreads` and the ownership check       | Authoritative                                                              | none                               |
| `parentRunId` | TEXT    | NULL     |                                       | `runId` of the previous run (NULL for the first). Informational; `seq` is the ordering authority | Authoritative (redundant with `seq`)                                       | none                               |
| `status`      | TEXT    | NOT NULL |                                       | `running`, `finished`, `error`, `stopped`, `interrupted`. See 5.6                                | Authoritative for lifecycle; **must agree with the events** (invariant I1) | none (Q4 scans)                    |
| `startedAt`   | INTEGER | NOT NULL |                                       | Epoch ms at which the start transaction committed                                                | Authoritative                                                              | none                               |
| `finishedAt`  | INTEGER | NULL     |                                       | Epoch ms of the terminal commit; NULL while `running`                                            | Authoritative                                                              | none                               |

### 5.3 `conversation_events`: the authoritative history

| Column      | Type    | Null     | Key / constraint            | Logical meaning                                                                                                                                        | Authority                            | Index                            |
| ----------- | ------- | -------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ | -------------------------------- |
| `id`        | INTEGER | PK       | `PRIMARY KEY AUTOINCREMENT` | Global insertion order. **The cache watermark** (`lastEventId`). `AUTOINCREMENT` never reuses a value, even after deleting the newest row (`ddl.json`) | Authoritative (order of commit)      | rowid                            |
| `threadId`  | TEXT    | NOT NULL | UNIQUE part 1               | The conversation                                                                                                                                       | Authoritative                        | `conversation_events_thread`     |
| `runId`     | TEXT    | NOT NULL | UNIQUE part 2               | The run this event belongs to                                                                                                                          | Authoritative                        | autoindex                        |
| `seq`       | INTEGER | NOT NULL | UNIQUE part 3               | 0-based position within the run; `0` is `RUN_STARTED`                                                                                                  | Authoritative                        | autoindex                        |
| `eventType` | TEXT    | NOT NULL |                             | The AG-UI `type`, denormalised from `eventJson` so the interlock and terminal detection can filter without parsing                                     | Derived from `eventJson` (redundant) | via `(threadId, id)` then filter |
| `messageId` | TEXT    | NULL     |                             | The event's `messageId` when it has one. **Informational. It is not event identity and is not unique** (many content events share one)                 | Derived from `eventJson` (redundant) | none                             |
| `eventJson` | TEXT    | NOT NULL |                             | The complete serialised AG-UI event. **The content authority**                                                                                         | **Authoritative**                    | none                             |

Constraint `UNIQUE(threadId, runId, seq)` is the event identity. The extra index `conversation_events_thread(threadId, id)` exists for the watermark query.

### 5.4 `conversation_messages`: the derived message view

| Column         | Type    | Null     | Key / constraint | Logical meaning                                                                                                                             | Authority                                     | Index        |
| -------------- | ------- | -------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------ |
| `threadId`     | TEXT    | PK       | `PRIMARY KEY`    | One row per thread                                                                                                                          | Derived                                       | PK autoindex |
| `messagesJson` | TEXT    | NOT NULL |                  | The AG-UI message list obtained by folding **every** event of the thread from an empty state with the public reducer (`defaultApplyEvents`) | **Derived, rebuildable, never authoritative** | none         |
| `lastEventId`  | INTEGER | NOT NULL |                  | `MAX(conversation_events.id)` for the thread when the row was derived. The row is fresh iff it equals the current `MAX(id)`                 | Derived (the freshness stamp)                 | none         |

The R32 checkpoint columns (`throughRunSeq`, `throughEventSeq`, `eventCount`, `messagesSha256`) are **not** in C4. C8 adds them with `ALTER TABLE ... ADD COLUMN`, each guarded by `PRAGMA table_info`, which is the idiom `workspace.ts` already uses.

### 5.5 Design choices, with the evidence behind each

| Choice                              | Reason                                                                                                                                                                                                           | Evidence                                                                                                                                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No foreign keys                     | Enforcement is **on** (correction 1). A key to `thread_bindings` would couple the log to another module's lifecycle; event-to-run integrity is carried by the single start/append transactions and invariant I2  | `ddl.json` probes: an event for a missing run is accepted by design                                                                                                                        |
| No `CHECK` on `status`              | SQLite cannot alter a `CHECK`; with no migration framework, adding a status later would mean rebuilding a table that holds conversations. The five values are a closed union in code and invariant I1 is tested  | probe: `abandoned` is accepted by the table, rejected by code                                                                                                                              |
| Extra index `(threadId, id)`        | The watermark query is `MAX(id) WHERE threadId = ?`. Without the index it reads every event of the thread; with it, one entry                                                                                    | 1,000 lookups on 200,000 rows: **141.8 ms to 4.1 ms** (about 35 times). Cost: per-event commit p50 **0.195 ms to 0.269 ms** (+0.074 ms). Single host, median of three (`index-bench.json`) |
| Join for replay order               | Events are read ordered by `(runs.seq, events.seq)`, not by `id`. `id` order equals it today only because recovery runs before any later run; the join stays correct if a later phase ever appends to an old run | `ddl.json` plan Q1: `SEARCH e USING INDEX conversation_events_thread` + `SEARCH r USING INDEX sqlite_autoindex_conversation_runs_1`                                                        |
| `Q4` full scan of runs for recovery | `WHERE status='running'` scans `conversation_runs` once at `ready()`. Cheap at any realistic run count and not wired into production boot in C4                                                                  | `ddl.json` plan Q4; R35 (section 17)                                                                                                                                                       |

### 5.6 Lifecycle values and invariants (tested in C4a, re-checked after every crash test in C4b)

`status` is one of `running`, `finished` (an agent `RUN_FINISHED`, or recovery of a pending client tool), `error` (an agent or finalizer `RUN_ERROR`), `stopped` (user stop), `interrupted` (recovery closed a dead run with an error).

| Invariant | Statement                                                                                                                                                                                            |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1        | `status = 'running'` **if and only if** the run has no `RUN_FINISHED` or `RUN_ERROR` event. The terminal event and the status update are written in the same transaction, so this never has a window |
| I2        | Event `seq` values of a run are exactly `0..n-1` with no gap; run `seq` values of a thread are exactly `1..m`                                                                                        |
| I3        | `conversation_messages.lastEventId` is never greater than the thread's `MAX(id)`                                                                                                                     |
| I4        | A thread has at most one run with `status = 'running'` that this process owns                                                                                                                        |

### 5.7 `lastEventId` is the minimal C4 freshness watermark, not an R32 checkpoint

DEC-6 defers the R32 checkpoint columns to C8, while the C4 reader logic compares `conversation_messages.lastEventId` with `MAX(conversation_events.id)`. These are consistent, not in tension. From the exact DDL in 5.1 the question has a definite answer: **A, a minimal C4 freshness watermark required by the full-rebuild implementation.**

| Source                                                            | Finding                                                                                                                                                               |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2a-1 acceptance (`docs/LOCAL_FIRST_P2A1_ACCEPTANCE.md:74,145`)   | `conversation_messages(thread_id PK, messages_json, last_event_id)` already existed in P2a-1, "equal to the log's last event id (the staleness test)", **before R32** |
| R32 acceptance (`docs/LOCAL_FIRST_R32_CACHE_ACCEPTANCE.md:45-51`) | R32 **added four columns on top of it**: `through_run_seq`, `through_event_seq`, `event_count`, `messages_sha256`                                                     |
| Production integration design §9.2                                | C8 adds exactly those four nullable columns, each behind a `PRAGMA table_info` guard                                                                                  |

**C4 contains exactly one freshness field.** The R32 fields that remain deferred to C8 are exactly four: **`throughRunSeq`, `throughEventSeq`, `eventCount`, `messagesSha256`**. The C4 table has exactly the three columns `threadId`, `messagesJson`, `lastEventId`.

**The C4 freshness rule.** A cached row is trusted only if it exists, its `lastEventId` equals the thread's current `MAX(id)`, no run is active, and `messagesJson` parses to an array. Anything else is stale and the reader derives from the events. Checked in `freshness-watermark.json`:

| Case                                                                          | Detected as stale? | Why                                                                                                                                                                         |
| ----------------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Healthy row                                                                   | no (fresh)         | the stamp equals the newest event id                                                                                                                                        |
| A newer run appends an event                                                  | yes                | `MAX(id)` moved                                                                                                                                                             |
| A **late recovery append to an older run** after a newer run exists           | yes                | its id is the largest, so the stamp differs. Staleness needs no ordering; an "events after this id" cursor would (that is R32's reason for logical positions, and it is C8) |
| Row **ahead** of the log (newest event removed out of band)                   | yes                | `lastEventId > MAX(id)`; C4 treats it as stale. The C8 checkpoint additionally quarantines this impossible state; C4 does not                                               |
| A deleted id is never reused                                                  | yes                | `AUTOINCREMENT`                                                                                                                                                             |
| Payload does not parse                                                        | yes                | treated as stale                                                                                                                                                            |
| Payload parses but is **wrong** while the stamp is correct (tampering, a bug) | **no**             | **Known limit.** This is exactly what the deferred `messagesSha256` adds. C4 accepts it because every C4 write recomputes the whole payload from the full log               |

**What the deferred fields add, so C4 does not pretend to have them:** `messagesSha256` detects a parseable-but-wrong payload; `throughRunSeq` and `throughEventSeq` give a logical position so an incremental step can apply only the events after it in `(run seq, event seq)` order, independent of `id`; `eventCount` detects events hiding inside the already-folded prefix; and the set together supports the fail-closed quarantine of an impossible state. None is needed while every write is a full rebuild.

**Impact on the schema: none.** The proposed C4a schema stands unchanged and DEC-6's text is not altered; the decision record carries a clarification, not a rewrite.

### 5.8 The C4a contract is frozen for C4 (DEC-20)

Once C4a is accepted, **its schema and storage contract are frozen for C4.** C4b may **not** amend them, silently or otherwise, merely because the DDL has not yet executed in production. If C4b discovers a real schema or storage defect, the rule is: **STOP**, and propose an explicit C4a correction for review before proceeding. What is frozen: the DDL text, every column's name, type, nullability and constraint, the index, the `status` vocabulary, invariants I1 to I4, the freshness rule of 5.7, the public surface of `ConversationLog`, and the exported constants of `run-rules.ts`.

### 5.9 DDL dormancy confirmations

1. **C4a defines the DDL**, as an exported constant used by `ConversationLog.ensureSchema()`. Nothing else in C4a or C4b contains a conversation `CREATE TABLE`.
2. **Production startup executes none of it.** No module reachable from `src/server/index.ts`, `src/server/chatgpt-plan-cli.ts` or `src/browser/index.ts` imports the log, the rules or the runner (D1 static check, D2 runtime module-load trace).
3. **Constructing a `ConversationLog` does not create tables.** The constructor stores the handle and does nothing else. An L1 test constructs one on a database that already holds C3-era tables and asserts that the **database file is byte-identical** (SHA-256 before and after) and that `hasSchema()` is false.
4. **`ensureSchema()` is explicit**, and its only callers are tests on throwaway databases; D1 asserts that no `src/` file calls it.
5. **An existing production database is unaffected by upgrading through C4a and C4b.** What is checked: (a) schema identity, meaning the `sqlite_master` rows (type, name, SQL) and `PRAGMA user_version` are identical before and after boot plus normal flows against a database created by C3-era code (D3); (b) no `conversation_` identifier appears anywhere in the file bytes; (c) the new modules are never loaded (D2), so they cannot have written anything. Byte identity of the **whole file after the application has run** is not claimed: WAL checkpoints and ordinary application writes legitimately change bytes. Byte identity is asserted where it is meaningful, for constructing the log (item 3).

Throwaway tests may call `ensureSchema()` explicitly.

---

## 6. Authority model

| Table                   | Role                                     | May be rewritten?                                                         | What reads it as truth                                                                                     |
| ----------------------- | ---------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `conversation_events`   | **Authoritative history.** Append-only   | Never, except by appending (including recovery appends to a dead run)     | `connect`, `getThreadEvents`, `getThreadState`, recovery, the interlock, message derivation                |
| `conversation_runs`     | Run metadata and lifecycle               | `status` and `finishedAt` change once, atomically with the terminal event | exclusivity bookkeeping, `listThreads`, recovery candidate selection                                       |
| `conversation_messages` | **Derived and rebuildable. Never truth** | Freely; dropping it loses nothing                                         | Nothing authoritative. Readers must check `lastEventId` against `MAX(id)` and otherwise derive from events |

Rules that keep the convenience table from becoming a second authority: the cache is written only after the run's terminal commit; no recovery decision, no interlock decision and no replay reads it; a stale or missing row is repaired from events, never the other way round; deleting the table must leave every conversation fully recoverable. Full rebuild is the initial correctness implementation; R32 incremental checkpoints belong to C8.

---

## 7. SDK pin (DEC-9) and the semi-public contracts C4 depends on

### 7.1 The pin

| Fact                                               | Value                                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `package.json` today                               | `"@copilotkit/runtime": "^1.75.0"`                                                                           |
| `package-lock.json` root spec today                | `^1.75.0`                                                                                                    |
| Lockfile-resolved version                          | `1.75.0` (integrity recorded in `version-pin.json`)                                                          |
| Installed version                                  | `1.75.0`                                                                                                     |
| `@copilotkit/shared` (home of `finalizeRunEvents`) | installed `1.75.0`; **runtime 1.75.0 depends on it as the exact `1.75.0`**                                   |
| `@ag-ui/client` / `@ag-ui/core`                    | runtime depends on the exact `0.0.59`; OpenDots' own `^0.0.59` cannot move past `0.0.59` (caret on `0.0.x`)  |
| **To pin**                                         | **`"@copilotkit/runtime": "1.75.0"`**, in `package.json` and mirrored in the lockfile root entry. No upgrade |

One exact pin therefore also freezes the finalizer and the AG-UI types the runner uses. **DEC-22:** only `@copilotkit/runtime` is pinned, at C4a. `@copilotkit/core ^1.75.0`, `@copilotkit/react-core ^1.75.0` and `@copilotkit/channels ^0.11.0` stay on carets and are not touched in C4. **C4 introduces no dependency on any of them**: the new modules import `@copilotkit/runtime/v2`, `@ag-ui/client` and `@ag-ui/core` only. If implementation discovers a new semi-public contract dependency on one of them, the rule is to **stop and request review**, not to widen the pin set.

**How the edit is verified (stated honestly).** `npm ci --dry-run --offline` exits 0 for the pinned copy, **and also exits 0 for a control whose lockfile root spec was deliberately left stale** (`version-pin.json`). So that command cannot confirm the lockfile edit, and it is not offered as evidence. The C4a verification is instead: (1) `npm install --package-lock-only` produces a lockfile diff of exactly the one root line; (2) `npm ls @copilotkit/runtime` reports `1.75.0`; (3) an L0 test fails if the `package.json` spec is anything other than the installed version, written as an exact version (negative control N10).

### 7.2 Contracts relied on (all verified in the installed 1.75.0; line anchors in `sdk-contract.json`)

| #   | Contract                                                                                                                                                                                                                                                                                                                                                      | Where                                                                                      | Risk if it changes                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| 1   | `AgentRunner` has exactly four abstract methods: `run`, `connect`, `isRunning`, `stop`, with the request types in section 8                                                                                                                                                                                                                                   | `runtime/runner/agent-runner.d.mts`                                                        | Compile error (typecheck) and L0                                                    |
| 2   | **`ɵsupportsLocalThreadEndpoints`**: an **unversioned, `ɵ`-prefixed** boolean checked with a strict `=== true`; selects the five local thread methods                                                                                                                                                                                                         | `runner/agent-runner.mjs:4`, used at `handlers/intelligence/threads.mjs:65,84,192,241,270` | **R10.** Silent: a rename makes the endpoints answer 422 instead of failing a build |
| 3   | `LocalThreadEndpointRecord` fields: `id, name, agentId, organizationId, createdById, archived, createdAt, updatedAt`                                                                                                                                                                                                                                          | `agent-runner.d.mts`                                                                       | `GET /threads` shape                                                                |
| 4   | The SSE run handler calls `runner.run({ threadId, agent, input })` **only**; `persistedInputMessages` and `authToken` are never supplied on this path                                                                                                                                                                                                         | `handlers/sse/run.mjs:18`                                                                  | The runner ignores both                                                             |
| 5   | A **synchronous throw** from `runner.run` is caught by the stream factory's `.catch` and the already-built **`200 text/event-stream`** is closed empty                                                                                                                                                                                                        | `handlers/shared/sse-response.mjs:52,121,130`                                              | DEC-13 at C6; pinned by an L0 characterization                                      |
| 6   | The cloned agent is primed with the **client's** history (`agent.setMessages(input.messages)`) before the runner is called                                                                                                                                                                                                                                    | `handlers/handle-run.mjs:40`                                                               | Why the interlock (section 15) is needed                                            |
| 7   | `stop` is called as `runner.stop({ threadId, runId? })`; a truthy result answers `{stopped:true, interrupt:{... code:"STOPPED"}}` (a response body, not a durable event)                                                                                                                                                                                      | `handlers/handle-stop.mjs:56`                                                              | Stop semantics                                                                      |
| 8   | `POST /threads/clear` calls `runner.clearThreads()` **unguarded** and answers 204                                                                                                                                                                                                                                                                             | `threads.mjs:84`                                                                           | DEC-16: the runner must refuse                                                      |
| 9   | `GET /threads/:id/messages` calls `runner.getThreadMessages(threadId)` **synchronously**                                                                                                                                                                                                                                                                      | `threads.mjs:192`                                                                          | Why the sync endpoint fails closed while the cache is stale                         |
| 10  | `finalizeRunEvents(events, { stopRequested?, interruptionMessage? })` (in `@copilotkit/shared`, re-exported by `@copilotkit/runtime/v2`) closes open text (`TEXT_MESSAGE_END`) and open tool calls, then appends `RUN_FINISHED` when stopping or `RUN_ERROR` with **`code: "INCOMPLETE_STREAM"`** otherwise; it is a no-op once a terminal event was observed | `shared/dist/finalize-events.mjs:59,94`                                                    | The recovery event shapes. Unit-pinned with the real function in L0                 |
| 11  | It closes **only** text and tool lifecycles. For an open `REASONING_*` lifecycle it appends only `RUN_ERROR`, leaving the reasoning events unclosed                                                                                                                                                                                                           | `sdk-contract.json` fixtures                                                               | Why R26b stays open (section 23)                                                    |
| 12  | `InMemoryAgentRunner` exists in the same package and is the live differential oracle for L2                                                                                                                                                                                                                                                                   | `runner/in-memory.mjs`                                                                     | Test-only                                                                           |
| 13  | The TanStack converter can emit `REASONING_*`, `STATE_SNAPSHOT`, `STATE_DELTA`, `TEXT_MESSAGE_CHUNK`, `TOOL_CALL_*` (so these are real in production)                                                                                                                                                                                                         | `agent/converters/tanstack.mjs`                                                            | R26b scope                                                                          |

L0 (C4a) turns rows 1, 2, 4, 5, 8, 10, 11 and 12 into assertions against the installed package, so an SDK change fails the default suite before it can change recovery behaviour.

---

## 8. The `AgentRunner` contract (installed SDK, not the PoC)

Constructed as `new DurableAgentRunner({ log, clientExecutableToolNames, ownsThread, now? })`. The three required options are injected so the runner holds no tool name, no workspace and no clock of its own, and carries **no test hooks**: fault injection in tests goes through a `ConversationLog` subclass (storage-level faults are the real failure surface), never through a production seam.

### 8.1 `run(request: AgentRunnerRunRequest): Observable<BaseEvent>`

| Aspect                | Contract                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inputs used           | `threadId`; `agent` (a per-request clone supplied by the SDK, already primed with the client history); `input: RunAgentInput` (`runId`, `messages`, `tools`, `state`, `context`, `forwardedProps`). **Ignored:** `persistedInputMessages`, `authToken` (never set on the SSE path)                                                                                                                                                     |
| Synchronous rejection | Throws `RunRejectedError` **before returning the observable**, with nothing written, no agent started, no provider call, no tool execution. Order of checks: (1) `THREAD_NOT_OWNED` (`ownsThread` is false, P-1); (2) `THREAD_ALREADY_RUNNING`; (3) recover this thread's dead runs; (4) `STALE_TOOL_HISTORY`; (5) `DUPLICATE_RUN_ID` (checked inside the start transaction). Each error has a stable `code` so C6 can map it (DEC-13) |
| Output                | An observable that replays **this run's events from its first event** (`RUN_STARTED` carrying the persisted, sanitised input) to the terminal event, then completes. It completes only after finalization and the message-view attempt (section 16)                                                                                                                                                                                    |
| Lifecycle             | start transaction (run row `running` + event 0) → register as active → `agent.runAgent(input, { onEvent })` → per event persist then publish → finalize (stock closers + terminal + status in one transaction, then publish) → message view → release the thread → complete                                                                                                                                                            |
| Error behaviour       | If the agent throws, the run is finalized with the error message (`RUN_ERROR`, code `INCOMPLETE_STREAM`, status `error`). If the agent itself emitted a terminal event the finalizer does nothing. If **persisting** fails, the event is not published, the run is finalized with that error, and if even finalization cannot be written the row stays `running` for recovery                                                          |
| Concurrency           | One active run per thread; different threads run concurrently. The `active` check and `active.set` are one synchronous stretch with no `await` between them (the start transaction is synchronous)                                                                                                                                                                                                                                     |
| Ownership             | The `active` map is process-local; its owner is this runner instance. Recovery never touches a run this instance owns. A second instance or process is not recognised (R17, section 18)                                                                                                                                                                                                                                                |

**`ownsThread` (DEC-23), stated precisely.** `ownsThread(threadId, agentId)` is an **OpenDots-defined** required constructor option of the dormant runner (design P-1). It is _not_ an option of the SDK's `AgentRunner` contract, which has none. What it relies on from the SDK is only what `runner.run` receives: the SDK sets `agent.agentId` to the route's agent id (`handlers/handle-run.mjs:23`) and `agent.threadId` from the body (`:42`) before calling the runner, which is called with `input.threadId`. The **direct contract test** DEC-23 requires therefore pins exactly that: through the real SDK handler, a recording runner double must observe `request.threadId === input.threadId` and `request.agent.agentId ===` the route's agent id. It lives in the L0 test of C4a, and C4b's ownership test exercises the seam again. It matters because this seam was not validated by the PoC. `clearThreads()` refuses and throws; it never translates into deleting local conversations.

### 8.2 `connect(request): Observable<BaseEvent>`

Emits the compacted events (`compactEvents`) of every **finished** run of the thread in order, then, if a run is active, joins its live subject, which replays that run from its first event. **No filtering by `messageId`** (the reference runner's hazard). A thread with no runs completes empty. Never writes. `agentId`, `headers` and `joinCode` are ignored.

### 8.3 `isRunning({ threadId }): Promise<boolean>`

True iff a run is active, not yet finalized and not stopping. **Known property for C6/DEC-13:** the thread slot is held until the message view has been attempted, so for a short window after the terminal commit `isRunning` is `false` while `run()` still answers `THREAD_ALREADY_RUNNING`. C6 must treat both signals; the 409 design must not rely on `isRunning` alone.

### 8.4 `stop({ threadId, runId? }): Promise<boolean | undefined>`

Returns `false` when there is no active run, it is already finalized or stopping, or `runId` is given and differs from the active run's. Otherwise marks the run stopping, calls `agent.abortRun()` and returns `true`; if aborting throws, the stopping mark is undone and `false` is returned. Finalization then uses `stopRequested: true` (closers, `RUN_FINISHED`, status `stopped`, partial text kept). A run that ends **without** a terminal event for any other reason (including `DotAgent`'s own 90 s abort at `dot-agent.ts`) is finalized as an error. **Not characterised against the durable finalizer before** (design §7.6); C4b adds the test (L5).

### 8.5 The five local-thread methods and the OpenDots-only additions

| Method                                      | Contract                                                                                                                                                                                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listThreads()`                             | One record per thread that has at least one run with `status != 'running'`; `name: null`, `archived: false`, `organizationId` and `createdById` empty, ISO timestamps from `startedAt`/`finishedAt`; `agentId` from the first run |
| `getThreadMessages(threadId)` (sync)        | Returns the cached list. Throws when the row is missing or stale and no run is active (**fails closed**). While a run is active it returns the last cached list. OpenDots never calls it                                          |
| `getThreadEvents(threadId)`                 | Committed events of finished runs, compacted. The active run is excluded                                                                                                                                                          |
| `getThreadState(threadId)`                  | The last `STATE_SNAPSHOT` in those events, or `null`                                                                                                                                                                              |
| **`clearThreads()`**                        | **Refuses** (DEC-16): throws `ClearThreadsRefusedError`, deletes nothing. The scope layer already denies the route with 403; this is the defence in depth                                                                         |
| `messagesFor(threadId): Promise<Message[]>` | The OpenDots reader seam (P-3): cache if fresh and the thread is idle, otherwise a derivation from the committed events (including the active run's committed prefix). **A reader writes nothing**                                |
| `ready(): Promise<{ checked, rebuilt }>`    | Recovery of dead runs, then a watermark check of every thread's view (section 17). Called by tests in C4, by the composition root at C6                                                                                           |
| `stopAll(deadlineMs)`                       | Stops and finalizes every active run inside the deadline so a graceful shutdown leaves no `interrupted` runs (P-4). Defined in C4b, wired at C6                                                                                   |

---

## 9. Write policy W1: persist, commit, publish

Production candidate stays **W1: persist before publish**. No W2 buffering.

| Event class                                                                          | Persisted in                                                          | Committed before                                   | Published                                                                                                          |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `RUN_STARTED` (synthetic, sanitised input)                                           | The start transaction: the `running` run row **and** event `seq 0`    | Before `agent.runAgent` is called                  | When the agent's own `RUN_STARTED` arrives (the persisted input is attached) or, if it never does, at finalization |
| Every agent event (`TEXT_*`, `TOOL_CALL_*`, `REASONING_*`, `STATE_*`, `CUSTOM`, ...) | One `BEGIN IMMEDIATE ... COMMIT` per event                            | The `onEvent` callback returns only after `COMMIT` | After `COMMIT`, in the same synchronous stretch, to the live subject and the run observable. **Never before**      |
| Agent `RUN_FINISHED` / `RUN_ERROR`                                                   | The same transaction as the event also sets `status` and `finishedAt` | As above                                           | As above                                                                                                           |
| Finalizer closers and terminal                                                       | **One** transaction for all appended events plus the status           | Before any of them is published                    | Each, after that single `COMMIT`                                                                                   |
| Recovery events                                                                      | **One** transaction; the run's status is re-checked inside it         | n/a (no live subscribers)                          | Never published; visible through `connect` and `getThreadEvents`                                                   |
| Message view                                                                         | A separate transaction **after** the terminal commit                  | n/a                                                | Not an event                                                                                                       |

**No event type is exempt:** every event a client can observe was committed first. The one-event-per-transaction cost was measured earlier at about 0.42 to 0.45 ms p50 (design §7.6) and, in this review's isolated probe, 0.195 to 0.269 ms depending on the extra index (`index-bench.json`); `synchronous=FULL` is the SQLite default and power-loss durability is not claimed.

---

## 10. Identity rules (the accepted P2a rules, restated)

| Thing                     | Identity / rule                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Run**                   | `(threadId, runId)` = the primary key of `conversation_runs`, for **any** status. `runId` is client-supplied. **A duplicate `(threadId, runId)` is rejected synchronously with `DUPLICATE_RUN_ID` inside the start transaction, before anything is written and before the agent starts**, including across a restart. The same `runId` on another thread is a different run |
| **Event**                 | `(threadId, runId, seq)`, enforced by `UNIQUE`. `id` is commit order and the cache watermark. **`messageId` is never event identity**                                                                                                                                                                                                                                       |
| **Message**               | `messageId` within a thread. The message namespace is `RUN_STARTED.input.messages[].id`, every event's `messageId`, and `TOOL_CALL_START.parentMessageId`. It sanitises the persisted `RUN_STARTED.input.messages`: messages whose ids are already known are dropped, so each user message is stored once                                                                   |
| **`toolCallId`**          | A **separate** namespace; never used for sanitising. P2a-2 test B3 proves a message id and a `toolCallId` may share a string. It keys tool results, recovery classification and the interlock                                                                                                                                                                               |
| **`parentMessageId`**     | On `TOOL_CALL_START`; it ties a tool call to its assistant message and is **in the message namespace** (the reference runner left a gap here; P2a-2 closed it, and G3's stored input being `[tool]` instead of `[assistant, tool]` is the one approved divergence from the reference)                                                                                       |
| **Synthetic message ids** | Stock results use `<toolCallId>-result`; the unknown-outcome result uses `<toolCallId>-unknown-outcome`                                                                                                                                                                                                                                                                     |
| **Exclusivity**           | One active run per thread, decided synchronously in this process. Another thread is independent. A same-thread loser executes no provider, no tool and writes no durable state (P3: 20 attempts, exactly one winner each)                                                                                                                                                   |

---

## 11. Crash recovery classes

Recovery runs from the stored events alone, at `ready()` and again for a thread just before a new run starts on it. It never re-drives the agent: **no provider call and no tool execution is ever repeated by recovery**, for any class. Reproduced with the real stock finalizer in `predicates.json`; the classifier below is a reference implementation (`predicates.mjs`) that C4a turns into production code and unit tests.

| #   | Stored state (no terminal event)                                                                 | Class                                      | Synthetic events appended (one transaction)                                             | Final status    | Auto retry of provider or tool | Still open?                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------------ | --------------------------------------------------------------------------------------- | --------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `RUN_STARTED` only                                                                               | `no_tool_lifecycle`                        | `RUN_ERROR(INCOMPLETE_STREAM)`                                                          | `interrupted`   | **Forbidden**                  | Closed (P2a-3)                                                                                                                                                                   |
| 2   | An open text message                                                                             | `open_text_message`                        | `TEXT_MESSAGE_END`, `RUN_ERROR(INCOMPLETE_STREAM)`                                      | `interrupted`   | **Forbidden**                  | Closed (P2a-3)                                                                                                                                                                   |
| 3   | A tool call with `START`/`ARGS` but no `END`: the executor **cannot** have run                   | `tool_args_incomplete`                     | `TOOL_CALL_END`, `TOOL_CALL_RESULT` (stock error), `RUN_ERROR(INCOMPLETE_STREAM)`       | `interrupted`   | **Forbidden**                  | Closed (P2a-3). **R28 open**: a real provider's acceptance of this partial-argument history is unverified                                                                        |
| 4   | A **server** tool call with `END` durable and no result: the effect may or may not have happened | `server_unknown_outcome`                   | the **unknown-outcome** `TOOL_CALL_RESULT` (section 12), `RUN_ERROR(INCOMPLETE_STREAM)` | `interrupted`   | **Forbidden**                  | Closed (P2a-4)                                                                                                                                                                   |
| 5   | A durable `TOOL_CALL_RESULT` for every call, no open text, no terminal                           | `server_result_durable`                    | `RUN_ERROR(INCOMPLETE_STREAM)` only; the real result is untouched                       | `interrupted`   | **Forbidden**                  | Closed (P2a-4)                                                                                                                                                                   |
| 6   | A pending **client/HITL** tool call (`END` durable, no result)                                   | `client_hitl_pending`                      | `RUN_FINISHED` only (the canonical pending form); **no** synthetic result               | `finished`      | n/a (the human answers)        | Closed (P2a-5)                                                                                                                                                                   |
| 7   | Only fully closed text messages, no tool call, no other event family                             | `complete_text_no_terminal` (R26a, DEC-21) | `RUN_ERROR(INCOMPLETE_STREAM)` only                                                     | `interrupted`   | **Forbidden**                  | **OPEN (R26).** Conditional (DEC-21): accepted implementation behaviour only after C4b's real-process `SIGKILL` test of exactly this window passes. Never `finished`. Section 23 |
| 8   | A pending client **and** a pending server call                                                   | `mixed_pending_tool_calls`                 | **Nothing written**                                                                     | stays `running` | n/a                            | **OPEN (R22)**, deferred                                                                                                                                                         |
| 9   | Open text or an incomplete call **and** a pending complete call                                  | `open_text_with_pending_tool_call`         | **Nothing written**                                                                     | stays `running` | n/a                            | **OPEN (R24)**, deferred                                                                                                                                                         |
| 10  | Anything else with no tool call: reasoning, state, activity, or text mixed with them             | `unclassified_lifecycle` (R26b)            | **Nothing written**                                                                     | stays `running` | n/a                            | **OPEN (R26)**. Real in production: the converter emits `REASONING_*` and `STATE_*` (section 23)                                                                                 |

A deferred run does not block its thread (a new run may start) and is reported at every `ready()`. If a crash lands **inside** the recovery transaction nothing is written (atomic, P2a-3 fault injection).

The stop path is not a crash class: a user stop finalizes with `stopRequested`, producing the closers, `RUN_FINISHED` and status `stopped`.

---

## 12. Server-tool ambiguity (P2a-4, preserved exactly)

If the durable evidence cannot distinguish "the side effect did not happen" from "it was committed but its result was not recorded", the tool is **not retried and no result is invented**. The recorded representation is the following `TOOL_CALL_RESULT`, which replaces the stock error result that would otherwise assert a failure:

```json
{
  "type": "TOOL_CALL_RESULT",
  "toolCallId": "<id>",
  "messageId": "<id>-unknown-outcome",
  "role": "tool",
  "content": "{\"outcome\":\"unknown\",\"reason\":\"run_interrupted\",\"message\":\"The run was interrupted before the result of this tool call was recorded. The tool may or may not have run. Do not assume that it succeeded or that it failed, and do not retry it automatically: verify its effect before retrying.\"}"
}
```

followed by `RUN_ERROR` with `code: "INCOMPLETE_STREAM"` and the interruption message `Run interrupted: the server process ended before the run finished.`, status `interrupted`. No automatic retry policy is introduced. Two real-`SIGKILL` windows that the log cannot tell apart (before the executor ran, after it ran) are both recovered this way (P2a-4 cases A and B).

---

## 13. HITL / client-tool contract

A pending client tool is a normal state of a healthy run, not an ambiguity. A crash after the client tool's `TOOL_CALL_END` and before `RUN_FINISHED` is repaired to the **canonical pending form**: `RUN_FINISHED` is appended, nothing else, status `finished`, so the approval that arrives afterwards works exactly as it does for a run that finished normally (P2a-5, including a real `SIGKILL` in that micro-window and an approval delivered before any boot recovery).

The production classifier seam is the injected predicate in section 14. A pending client call must **never** be turned into a fake server-tool unknown outcome, and a pending server call must never be treated as awaiting a human; both directions have a negative control (N4, N11).

---

## 14. R23: tool classification (DEC-19)

**Question.** After a crash, is a tool call with no result waiting for a human (client-executed) or did a server executor possibly run (server-executed)?

**Production facts (verified).**

- The browser registers exactly **one** client-executed tool: `review_space_page`, through `useHumanInTheLoop` (`src/client/Chat.tsx:192`).
- `DotAgent` forwards a client tool to the model **only** when its name equals `pageReviewTool.name` (`dot-agent.ts:259`); every other tool the browser declares is dropped. Existing tests pin this: `tests/tanstack-agent.test.ts:127` and `:191` assert that an `untrusted_tool` declared by the browser never reaches the model request.
- The runner persists the **raw** `RunAgentInput` (including the browser's `tools`) in `RUN_STARTED`.

**The PoC rule** (names declared in the persisted `RUN_STARTED.input.tools` are client tools) trusts the client: a client that declares a **server** tool's name would make a pending server call look like a harmless pending human step, and recovery would write `RUN_FINISHED` instead of the unknown-outcome result. That is exactly the unsafe direction (fixture "R23 hostile" in `predicates.json`: the PoC rule says `client_hitl_pending`, this rule says `server_unknown_outcome`).

**Terminology (DEC-19).** `clientExecutableToolNames` is **server-owned configuration**: the set of tool names that may legally be executed on the **client**. It is **not** a list of server-executed tools; a server tool is simply any tool that is not in it. (Earlier drafts called it a "server allow-list"; that name was ambiguous and is retired.)

**The C4 predicate.**

```
isClientExecuted(name) :=
      persistedRunStarted.input.tools contains name       // what the client declared
  AND clientExecutableToolNames.has(name)                 // what the server says may run on the client
```

- `clientExecutableToolNames` is a **required option** of `DurableAgentRunner`. The runner and the recovery logic contain **no tool-name string literal**. The set is built from the production tool definitions: at C6 the composition root passes `new Set([pageReviewTool.name])`, and C4 tests pass the same imported constant, so the fixture is the real `review_space_page`.
- **The client may narrow the effective set; it may never widen it.** A declared tool that is not in the set is a server tool. A tool in the set that was not declared is a server tool. Only a tool that satisfies both is client-executed.
- **Every disagreement fails in the safe direction.** The call is treated as a server call, the unknown-outcome result is written and nothing is retried. The cost is that a legitimate pending review whose declaration is missing from `RUN_STARTED` would be reported as an error instead of being offered for approval: rare and recoverable.

**The precise contract test (DEC-19: required before C4a or C4b is considered complete).** `tests/client-executable-tools.test.ts`, in C4a, with the runner-level part in C4b's L7. It asserts three things:

1. **Source contract**, over the TypeScript AST of `src/client`: every `useHumanInTheLoop` or `useFrontendTool` registration names its tool with a member of `clientExecutableToolNames` (today the single registration at `Chat.tsx:192-194` uses `pageReviewTool.name`). A new client-side tool with any other name fails here, which forces an explicit decision to add it to the set.
2. **Behaviour contract on the real `DotAgent`:** for an input that declares `[{ name: 'untrusted_tool' }, pageReviewTool]`, the tools forwarded to the inner agent are exactly the declared members of the set, `[pageReviewTool]`. What the client may execute and what the server classifies as client-executed therefore cannot drift apart. (`DotAgent` still compares against `pageReviewTool.name` directly and C4 may not edit it; at C6 both can share one exported set.)
3. **Recovery contract:** the rows of section 11 for the same name declared and not declared; declared but not in the set; in the set but not declared; and `pageReviewTool` pending at a real `SIGKILL` between `TOOL_CALL_END` and `RUN_FINISHED` reaching the canonical pending form.

An empty set (N4) and a runner that trusts declarations alone (N11) must turn these RED.

Approved as DEC-19. It is a deliberate deviation from the PoC and was not PoC-validated.

---

## 15. DEC-5: the stale-tool-history interlock

**Why it exists (verified).** The SDK primes the cloned agent with the **client's** message history before calling the runner (`handle-run.mjs:40`). A tool call that has no result in the history the framework is given is run again. P2a-4 observed a real double side effect from exactly this. A browser tab that was open before a tool finished is such a client.

**The predicate** (`findStaleToolHistory(input, thread)`, pure, in `run-rules.ts`):

```
held     := toolCallIds that have a durable TOOL_CALL_RESULT in this thread's log
answered := toolCallIds of the input's role='tool' messages
REJECT   iff there is an input message with role='assistant' and a toolCalls[i].id
             such that held.has(id) AND NOT answered.has(id)
             → run() throws RunRejectedError('STALE_TOOL_HISTORY'), synchronously, before any write
otherwise ACCEPT
```

**How it separates the two cases the review was asked to distinguish.**

| Case                                                                                                        | Input shape                                                                 | Verdict    |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------- |
| **A.** A browser that claims continuity but is missing a result the log holds                               | contains the assistant tool-call message, lacks the matching tool message   | **REJECT** |
| **B.** An intentionally prompt-only headless input (every scheduled and voice turn, parity with production) | `messages` is just the new user message: **no assistant tool calls at all** | **ACCEPT** |

The rule never inspects who the caller is, a flag, or a header. It looks only at what the input itself claims, so there is nothing for a caller to label itself into. The rejected alternative, "refuse any input that lacks any recorded result", would refuse every scheduled turn on any thread that has ever used a tool.

Full truth table (all nine rows ran, all match; `predicates.json`):

| Case                                                                                | Verdict |
| ----------------------------------------------------------------------------------- | ------- |
| Stale tab: assistant tool call `t1` present, its recorded result absent             | REJECT  |
| Prompt-only input on a thread with tool history                                     | ACCEPT  |
| Complete history (call and result)                                                  | ACCEPT  |
| One assistant message with two calls, one answered, the unanswered one is recorded  | REJECT  |
| Unanswered call whose result the log does **not** hold (a pending client/HITL call) | ACCEPT  |
| Client supplies the HITL result for a call the log does not hold                    | ACCEPT  |
| Truncated history that mentions neither the call nor its result                     | ACCEPT  |
| Empty log                                                                           | ACCEPT  |
| Tool message present, its assistant message omitted                                 | ACCEPT  |

The accepted-but-lossy rows (truncated history) are a context problem, not a double-execution risk: nothing in the input names a call that could be re-run. The interlock is evaluated after exclusivity and after this thread's dead runs have been recovered (so a result written by recovery counts as held), and before the start transaction.

---

## 16. R34 in C4: what "cache failure" means, and the fallback

**Definition at C4.** A _cache failure_ is any failure to derive or write the `conversation_messages` row for a thread: the derivation throws, the write transaction throws (busy, full, I/O), or the process dies after the run's terminal commit and before the row is written. The authoritative commits (events, run status) are **already durable** in every one of those cases.

**Behaviour (recommended, = DEC-4).**

1. The run's outcome is decided by its events. A message-view failure never rolls back a completed run and never changes its status.
2. Finalization attempts the full rebuild once. On failure it makes **one** in-line repair attempt (single flight per thread, bounded), logs once per thread, and then releases the thread.
3. Readers use `messagesFor()`: the row if `lastEventId = MAX(id)` and no run is active, otherwise a derivation from the events. A reader never writes.
4. The next finalization's full rebuild is the natural catch-up; `ready()` also repairs missing or stale rows.
5. **No reload is required.** A reload repairs nothing (the browser never reads the cache).
6. The SDK's **synchronous** `getThreadMessages` cannot derive (the reducer is asynchronous), so it **fails closed** while stale. OpenDots never calls it.

**Is `conversation_messages` needed at all in dormant C4?** It exists because DEC-6 approved three tables and schema stability matters more than saving one table, and because two OpenDots readers (`Platform.history()` for voice start, `PageService.saveConversation`) will want a cheap read. It costs no R32 complexity: the C4 write path is the P2a full rebuild (about 32 / 81 / 164 / 275 to 340 ms at 25 / 50 / 75 / 100 turns, measured earlier, one host). Whether the table can be dropped entirely in favour of on-demand derivation is "Option N" (design §9.5) and is a C8 study, not a C4 question.

---

## 17. R35: boot verification

C4's `ready()` is correctness-first and **not wired into production startup**.

- Recovery: one scan of `conversation_runs WHERE status = 'running'` (plan Q4), then a classification per dead run (cost proportional to that run's events).
- View check: per thread, **one watermark seek** (`MAX(id)`, plan Q2, covering index) compared with `lastEventId`. A healthy boot derives nothing and writes nothing. Only a missing or stale row costs a derivation, of that thread only.

Expensive full verification is therefore not needed in C4, and tests may run it explicitly (for example, a 100-turn derivation compared with the cache). **R35 stays OPEN as shipping and performance work:** under C4's full-rebuild policy a healthy boot is O(threads) seeks, but the O(history) boot cost described in the design belongs to the incremental policy (C8), and the real measurement belongs to C6 acceptance.

---

## 18. R17: multi-process writer

**Shipping assumption for local-first v1: one OpenDots server process owns the database and the runtime** (`npm start`, and the single `app` service in `compose.yml`). Exclusion (`active`) is process-local; `BEGIN IMMEDIATE`, `UNIQUE(threadId, runId, seq)` and `UNIQUE(threadId, seq)` make a second writer interleave or fail loudly rather than silently corrupt rows, **but that was never tested with two processes, and a second process's `ready()` would wrongly "recover" the first process's live run.** C4 therefore does **not** claim multi-process safety and adds no lock file or distributed lock. R17 is recorded as a **deployment constraint and open risk** for the C6 documentation.

---

## 19. Dormancy proof

The goal is to show, with checks that fail loudly, that after C4 normal boot, browser chat, scheduled/headless turns and voice still use the **current Intelligence runtime** and that **the local runner's production construction count is 0**.

| Layer | Check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Runs in                          | Fails if                                                                                  |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------- |
| D1    | **Static unreachability.** Over TypeScript-emitted imports, none of the three new modules is reachable from `src/server/index.ts`, `src/server/chatgpt-plan-cli.ts` or `src/browser/index.ts`; no `src/` file imports them (in-degree 0); no dynamic import names them; no `src/` file other than `conversation-log.ts` contains `conversation_runs`, `conversation_events` or `conversation_messages`; `ensureSchema` is referenced only by tests                                                                                                                                                                    | Default suite (C4a)              | Anyone imports a dormant module from production code, or writes the table names elsewhere |
| D2    | **Runtime module-load trace.** A real server process (same helper as the C1/C2 tests) is started with a `module.registerHooks` resolve hook preloaded, then driven through `/info`, an authorized run (which must reach the loopback Intelligence stub), thread reads, connect and stop. The trace of resolutions matching `conversation-log`, `run-rules` or `durable-runner` must be **empty**. A module that is never loaded cannot have constructed anything. Feasibility was proved in a spike on this Node and with `tsx`: 0 trace lines when unreferenced, 1 when dynamically imported (`dormancy-spike.json`) | Default suite (C4b)              | Anything loads a dormant module during boot or normal flows                               |
| D3    | **No conversation tables, schema identity.** After D2's flows, on a database created by C3-era code: no table matching `conversation\_%`, `PRAGMA user_version` is `0`, the `sqlite_master` rows (type, name, SQL) are identical to those before boot, and the file bytes contain no `conversation_` identifier. Separately, constructing a `ConversationLog` leaves the database file byte-identical (5.9, item 3)                                                                                                                                                                                                   | Default suite (C4b)              | Startup or normal use creates or alters the schema                                        |
| D4    | **The current path is the oracle.** The existing suites for the Intelligence path stay green **and unmodified**: `headless-runtime`, `headless`, `voice`, `page-service`, `page-routes`, `setup`, `dot-agent-channel`, `learning-delivery`, `tanstack-agent`, `app`, `owner-boundary`, `owner-startup`. D2's "authorized run reaches Intelligence" assertion is the same one C2 already makes. At review time `git diff --name-status` for C4a and C4b must list only the files in section 24                                                                                                                         | Default suite + review checklist | An active module or its test had to change to make C4 pass                                |

The scheduled/headless path and the voice path call `runThreadTurn`/`IntelligenceAgent` and `platform.history()`; none of them can reach a module that nothing imports, and their existing tests pin their wiring. The browser chat path is exercised end to end by D2.

"Production construction count = 0" is deliberately **not** implemented with a counter inside the runner: a test-only counter would be exactly the kind of production seam the project avoids. Unreachability (D1) plus a never-loaded trace (D2) is a stronger statement than a counter that someone could forget to increment.

---

## 20. Throwaway databases: the isolation mechanism

C4 integration tests construct the dormant runner directly. The guarantees that they can never touch a real OpenDots database:

1. **One entry point.** `tests/helpers/throwaway-db.ts` is the only way conversation tests obtain a database. It calls `mkdtemp` under `realpath(os.tmpdir())` with the prefix `opendots-c4-`, opens `DatabaseSync` on a file inside it, and **refuses** (throws) if the resolved path is not under that real temp root. It never reads `DATABASE_PATH` or any other environment variable.
2. **Safe cleanup.** Its cleanup removes only the directory it created and re-checks the same prefix before deleting.
3. **Nothing happens by accident.** `new ConversationLog(db)` touches nothing; the schema exists only after an explicit `ensureSchema()`, and D1 proves no `src/` module calls it.
4. **Child processes** (L6, L7) receive the database path through `argv` from the parent, never through the environment, and re-apply the same check before opening it.
5. **A negative control** tries to open a path outside the temp root (for example `data/opendots.sqlite`) and must see the refusal.

Applied already in this review: every database `ddl-validation.mjs`, `index-bench.mjs` and the foreign-key probe opened passed that rule, and all of their directories were removed (`ddl.json`: `throwawayDirectoriesRemoved: true`).

---

## 21. C4 acceptance ladder

All levels are offline; no live ChatGPT Plan, OpenAI or CopilotKit call. "Default" is `npm test`; "crash" is the new `npm run test:crash`.

| Level | Asserts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Files                                                                              | Runs in      | Commit |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------ | ------ |
| L0    | SDK, version and source contracts: the exact pin; installed runtime and shared versions; the four-method abstract shape; the `ɵ` marker and `supportsLocalThreadEndpoints`; the real `finalizeRunEvents` outputs; the synchronous-throw-becomes-empty-200 behaviour (a throwing runner behind the real handler); the thread routes use the runner methods; `InMemoryAgentRunner` exists; **what `run()` receives** (`threadId` equals `input.threadId`, `agent.agentId` equals the route's agent id), the direct contract test DEC-23 requires for `ownsThread` | `tests/agent-runner-sdk-contract.test.ts`                                          | Default      | C4a    |
| L1    | Schema and serialisation: DDL is idempotent; `table_info`, indexes and constraints equal literals; every event type round-trips; invariants I1 to I4; **constructing a `ConversationLog` leaves the file byte-identical**; the freshness rule of 5.7 (all rows); table-driven `classifyRun` and `recoveryEvents` (every row of section 11, the hostile R23 rows, the R26a/R26b split); table-driven `findStaleToolHistory` (all nine rows); the DEC-19 contract test                                                                                            | `conversation-log.test.ts`, `run-rules.test.ts`, `client-executable-tools.test.ts` | Default      | C4a    |
| L2    | Normal durable run and replay: differential against the live `InMemoryAgentRunner` for the P2a shapes G0 to G7 (text, server tool, HITL pending, HITL resume, errors) with the approved G3 divergence asserted explicitly; `connect` before, during and after a run; persist-then-publish observed from a subscriber                                                                                                                                                                                                                                            | `durable-runner.test.ts`                                                           | Default      | C4b    |
| L3    | Tool run and HITL: a server tool executes once and its result is durable; a pending client tool survives a restart and is approved afterwards                                                                                                                                                                                                                                                                                                                                                                                                                   | `durable-runner-tools.test.ts`                                                     | Default      | C4b    |
| L4    | Same-thread exclusion and different-thread concurrency: exactly one winner among N attempts, losers do no provider, tool or durable work; two threads run concurrently with independent ordering; duplicate `runId` rejected, also after a restart                                                                                                                                                                                                                                                                                                              | `durable-runner-concurrency.test.ts`                                               | Default      | C4b    |
| L5    | Stop: runner stop, partial text kept, `TEXT_MESSAGE_END` once, `RUN_FINISHED` once, no `RUN_ERROR`, status `stopped`; stop with the wrong `runId`; stop during an in-flight tool; **an agent that ends or aborts itself without a terminal event** (the `DotAgent` 90 s path); `stopAll` inside a deadline                                                                                                                                                                                                                                                      | `durable-runner-stop.test.ts`                                                      | Default      | C4b    |
| L6    | Real-process restart: a fresh process on the same file replays identically with the provider never called, the database unchanged by a pure reader, and `ready()` repairing a stale view                                                                                                                                                                                                                                                                                                                                                                        | `tests/crash/restart.test.ts`                                                      | Crash        | C4b    |
| L7    | Real `SIGKILL` recovery classes at deterministic gates (marker files, no sleeps): every closed class of section 11; the **R26a window** (after `TEXT_MESSAGE_END`, before the terminal event); both server-tool windows; the HITL micro-window; a kill **inside** the recovery transaction; the cache window (terminal committed, view not written). Invariants I1 and I2 re-checked after every kill; exit signals classified so a host V8 crash (R33) is never mistaken for the injected kill                                                                 | `tests/crash/*.test.ts`                                                            | Crash        | C4b    |
| L8    | Stale-tool interlock: the nine-row truth table end to end through `run()`; rejection happens before any write, provider or tool; a result added by recovery counts as held; a prompt-only turn on a thread with tool history is accepted                                                                                                                                                                                                                                                                                                                        | `durable-runner-interlock.test.ts`                                                 | Default      | C4b    |
| L9    | Derived-message rebuild and repair (R34): a cache write failure injected through a `ConversationLog` subclass does not fail or re-status the run; readers fall back to the events; one repair attempt; the next finalization catches up; a deleted, corrupt or stale row is repaired; a reader writes nothing; the synchronous endpoint fails closed while stale                                                                                                                                                                                                | `durable-runner-view.test.ts`                                                      | Default      | C4b    |
| L10   | Dormancy: D1 (C4a) and D2 plus D3 (C4b)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `dormancy.test.ts`, `dormancy-runtime.test.ts`                                     | Default      | C4a/b  |
| L11   | C1, C2 and C3 suites unchanged and green; the full production suite; `check-format`, `lint`, `typecheck`, `build`; the C1 any-module-as-root order test covers the new modules automatically                                                                                                                                                                                                                                                                                                                                                                    | existing                                                                           | Default + CI | both   |

Level-specific gates that are not levels: **the acceptance runtime is Node 24** (section 0), and results on Node 22 are supporting evidence only; **R33**, L0 to L5 and L8 to L11 also green on the second host (CI, Node 24 on Linux), and on this host the established policy (record every V8 crash, rerun a whole test only on a host-instability error, never retry an assertion failure); **R31**, any non-reproducing assertion failure is recorded, not retried silently.

---

## 22. Negative controls (to exist in C4; not executed in this design step)

Each is a deliberate production-code mutation that a named test must catch.

| #   | Mutation                                                                                                     | Must go RED in                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| N1  | Publish an event before it is persisted                                                                      | L2 persist-then-publish (a subscriber checks the log at the moment it receives the event) |
| N2  | Accept a duplicate `(threadId, runId)`                                                                       | L1 constraint, L2/L4 duplicate-run tests (and the database must be unchanged)             |
| N3  | Retry a server tool automatically during recovery                                                            | L7 server-tool windows: agent invocations and tool executions after recovery must be 0    |
| N4  | Classify a HITL call as a server tool (for example an empty `clientExecutableToolNames`)                     | L1 table, L7 HITL kill                                                                    |
| N5  | Accept stale browser history                                                                                 | L8 case A                                                                                 |
| N6  | Reject a prompt-only headless input (the literal reading of DEC-5)                                           | L8 case B                                                                                 |
| N7  | Treat the cache as authority (return the row without the watermark check)                                    | L9 stale and corrupt-row tests                                                            |
| N8  | A production module constructs the runner or imports a dormant module                                        | L10 D1 and D2                                                                             |
| N9  | Normal startup creates the conversation tables (for example calling `ensureSchema()`)                        | L10 D3                                                                                    |
| N10 | SDK drift: the `package.json` spec becomes a range, or installed and spec disagree                           | L0 pin test                                                                               |
| N11 | A pending **server** call is closed as a pending client call (trust the browser's declaration, the PoC rule) | L1 hostile row, L7                                                                        |
| N12 | A cache-write failure fails or re-statuses the run                                                           | L9                                                                                        |
| N13 | Terminal event written without the status update (or the reverse)                                            | L1 invariant I1, re-checked after every L7 kill                                           |
| N14 | `clearThreads()` deletes                                                                                     | L2 (the local-thread endpoint through the real handler returns without deleting anything) |
| N15 | Event identity taken from `messageId` (replay filters by it)                                                 | L2 `connect` with repeated `messageId`s across runs                                       |
| N16 | An unbound thread or an agent that does not own the thread is accepted                                       | L4 ownership test                                                                         |

---

## 23. R26

**Question.** Can "complete text + no terminal lifecycle" be classified safely from existing evidence?

**Two different questions are hiding in it.**

1. _Is it safe to close the run?_ **Yes, for text alone.** With no tool call in the run there is no executor that could have run, so no side effect is in doubt. The stock finalizer, applied to a run holding only closed text, appends exactly `RUN_ERROR(INCOMPLETE_STREAM)` and nothing else (`sdk-contract.json`), the same as for an open text run minus its closer.
2. _Was the answer complete?_ **Unknowable.** The crash may have hit the end of a final answer, or the middle of a multi-step turn whose next step never started. So the rule never says `finished`; it says **error / `interrupted`**.

**Rule R26a (DEC-21, approved conditionally; C4b).** A run whose events consist only of `RUN_STARTED` and text-message events, every opened text message closed, at least one message, no tool call and no reasoning, state or other unresolved event family, is closed with `RUN_ERROR` carrying `code: INCOMPLETE_STREAM`, status `interrupted`. **It must never infer `finished`.** It becomes accepted implementation behaviour **only after its real-process `SIGKILL` test passes**; until then it is a candidate. Provider and tool retry are forbidden, as for every class.

**Rule R26b (unchanged, deferred).** Any other no-tool-call state (reasoning, state snapshots or deltas, activity, custom, raw, or text mixed with them) is **not classified**, and **R26a is not generalized to those families** (DEC-21). Nothing is written, the run stays `running`, does not block its thread, and is reported at every `ready()`. Why: the stock finalizer does **not** close open `REASONING_*` lifecycles (it appends only the `RUN_ERROR`), so closing such a run would leave a dangling reasoning lifecycle whose effect on the reducer and on the client is not validated. This matters in production: the TanStack converter really emits `REASONING_*` and `STATE_*` events, so a crash after a reasoning phase is an expected shape, not a theoretical one.

**Status: R26 stays OPEN.** R26a has a rule but not yet evidence: the window between `TEXT_MESSAGE_END` and the terminal event has never been hit by a real `SIGKILL`. C4b's L7 adds exactly that test; if it passes, R26a can be closed in the C4b acceptance report with that evidence. R26b stays open into C6, where L4 must also establish how the client renders a replayed run that has no terminal event. C4 recovery is not unsafe for ordinary use because of R26: every state R26 leaves open is one in which nothing is written, nothing is retried and the thread keeps working.

---

## 24. Exact C4 commit content

### 24.1 C4a: `feat(server): add dormant conversation log and run rules`

| File                                      | New/Mod | Purpose                                                                                                                          | Active/dormant     | Why in C4a                                                                                  |
| ----------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------- |
| `src/server/conversation-log.ts`          | NEW     | DDL constant, explicit `ensureSchema()`, transaction helper, typed event/run/view reads and writes, invariant check              | Dormant            | The storage contract (DEC-6) reviewed on its own                                            |
| `src/server/run-rules.ts`                 | NEW     | `classifyRun`, `recoveryEvents`, `findStaleToolHistory`, the two constants. Guard-first import                                   | Dormant            | The recovery vocabulary (R23, R26a, section 11) and DEC-5 as pure, table-testable functions |
| `package.json`                            | MOD     | `"@copilotkit/runtime": "1.75.0"`                                                                                                | Active (spec only) | DEC-9; `run-rules.ts` is the first code to depend on the SDK contract (`finalizeRunEvents`) |
| `package-lock.json`                       | MOD     | root spec mirror                                                                                                                 | Active (spec only) | Same                                                                                        |
| `tests/helpers/throwaway-db.ts`           | NEW     | The isolation helper of section 20                                                                                               | Test               | Every later test needs it                                                                   |
| `tests/helpers/event-fixtures.ts`         | NEW     | Builders for the P2a event shapes                                                                                                | Test               | Shared by L1 and C4b                                                                        |
| `tests/agent-runner-sdk-contract.test.ts` | NEW     | L0                                                                                                                               | Test               | Pins the pin                                                                                |
| `tests/conversation-log.test.ts`          | NEW     | L1 schema, constraints, serialisation, invariants                                                                                | Test               | Reviews the schema independently of any runner                                              |
| `tests/run-rules.test.ts`                 | NEW     | L1 classifier and L8-style predicate tables, hostile R23 rows, R26a/R26b                                                         | Test               | Freezes the recovery vocabulary before the runner exists                                    |
| `tests/client-executable-tools.test.ts`   | NEW     | The DEC-19 contract test: client registrations, `DotAgent` forwarding and the recovery rows agree on `clientExecutableToolNames` | Test               | Required before C4a or C4b is complete                                                      |
| `tests/dormancy.test.ts`                  | NEW     | L10 D1                                                                                                                           | Test               | Dormancy is proved from the first commit                                                    |

### 24.2 C4b: `feat(server): add dormant durable AgentRunner`

| File                                                                           | New/Mod | Purpose                                                                                         | Active/dormant | Why in C4b                                                  |
| ------------------------------------------------------------------------------ | ------- | ----------------------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------- |
| `src/server/durable-runner.ts`                                                 | NEW     | `DurableAgentRunner`, `RunRejectedError`, `ClearThreadsRefusedError`                            | Dormant        | The runner (sections 8 to 11, 15, 16)                       |
| `tests/helpers/scripted-agent.ts`, `tests/helpers/faulty-log.ts`               | NEW     | A scripted `AbstractAgent`; a `ConversationLog` subclass for storage faults and ordering probes | Test           | Fault injection without production seams                    |
| `tests/durable-runner*.test.ts` (five files)                                   | NEW     | L2 to L5, L8, L9                                                                                | Test           |                                                             |
| `tests/crash/*.test.ts`, `tests/crash/child.ts`, `tests/crash/orchestrator.ts` | NEW     | L6, L7 (real processes, real `SIGKILL`)                                                         | Test (crash)   | The evidence for the recovery claims                        |
| `tests/dormancy-runtime.test.ts`, `tests/fixtures/dormancy/module-trace.ts`    | NEW     | L10 D2, D3                                                                                      | Test           |                                                             |
| `package.json`                                                                 | MOD     | `"test:crash"` script                                                                           | Tooling        | DEC-12                                                      |
| `vitest.crash.config.ts`                                                       | NEW     | Crash suite config                                                                              | Tooling        | DEC-12                                                      |
| `vite.config.ts`                                                               | MOD     | `test.exclude` gains `tests/crash/**`                                                           | Tooling        | Default `npm test` stays light                              |
| `.github/workflows/ci.yml`                                                     | MOD     | A `crash` job                                                                                   | Tooling        | DEC-12; also gives the second host (Node 24, Linux) for R33 |

### 24.3 Forbidden in both commits

- Any edit to an existing `src/` module (`index.ts`, `platform.ts`, `workspace.ts`, `store.ts`, `dot-agent.ts`, `headless.ts`, `page-service.ts`, `voice.ts`, `app.ts`, `runtime-scope.ts`, ...).
- Any import of a dormant module from `src/` other than between the dormant modules themselves; any dynamic import of them.
- Any call to `ensureSchema()` or any `CREATE TABLE` of a conversation table outside tests; any migration, `ALTER`, `user_version` or version table.
- Any flag, environment variable or option that could switch the runner on. A switch would be a half-activation.
- `CopilotSseRuntime`, an `intelligence` option change, `INTELLIGENCE_*` handling, CSP, `maxIterations`, headless wiring, DEC-3 semantics, DEC-13 response mapping, D3, R32 columns or incremental caching.
- Any test seam in a production class (`beforePersist`, `faults`, a notes ledger, an interlock switch, a cache policy switch).
- Any dependency change other than the one pin.
- Any real network or live provider call; any test that can open a non-throwaway database.

### 24.4 Is C4 still a reasonably reviewable single commit? No. Recommended split.

An unsplit C4 would be on the order of **5,000 lines**: roughly 1,100 to 1,400 lines of production code and 3,500 or more lines of tests and harness. (Estimates, not measurements. The PoC runner is 1,259 lines but includes R32 incremental caching, test hooks and a notes ledger that the production class does not carry.) The split follows concerns that are reviewed in different ways, not line counts:

| Commit | Reviewed by                                                                                         | Size (estimate)             | Complete and valid alone?                                                                                  |
| ------ | --------------------------------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| C4a    | Reading the schema and the rule tables; the tests are table-driven literals                         | about 500 src + 1,000 tests | **Yes.** A tested log and a tested pure rule module, both dormant, with the pin and the SDK contract guard |
| C4b    | Concurrency, stream ordering and crash behaviour; read with the differential and real-kill evidence | about 800 src + 2,500 tests | **Yes**, given C4a. It is the complete `AgentRunner`; it is not split further                              |

C4a is not a half-valid API: it exposes no runner surface at all, so nothing can be mistaken for an activation path. C4b cannot be cut smaller without producing a runner that lacks recovery, stop or the interlock, which would violate the `AgentRunner` contract or its safety claims, and separating the crash tests from the runner would leave the runner's recovery claims without their evidence. **DEC-20: once C4a is accepted, its schema and storage contract are frozen for C4** (5.8). C4b may not silently amend them merely because the DDL has not yet executed in production; if C4b finds a real schema defect it stops and proposes an explicit C4a correction for review before proceeding. C4b remains the largest commit of the series; that is stated, not hidden.

---

## 25. Risk register after this review

| Risk / item                                     | Status after this review                                                                                                                   | Closes at                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| R10 SDK semi-public contracts                   | Pinned (K) and guarded by L0. The `ɵ` marker remains unversioned                                                                           | C4a; re-verified on every upgrade |
| R16 private-field reach into `WorkspaceStore`   | **Resolved by design:** the log takes an injected `DatabaseSync`                                                                           | C4a                               |
| R17 multi-process writer                        | **OPEN, deployment constraint:** one server process per database                                                                           | Documented at C6                  |
| R20 / R21 stale-tool interlock                  | Contract fixed (DEC-5, section 15)                                                                                                         | C4b L8                            |
| R22 mixed pending / R24 open text + pending     | **OPEN**, deferred, nothing written                                                                                                        | After v1                          |
| R23 tool classification                         | **Resolved enough for C4 (DEC-19):** the persisted declaration intersected with the server-owned `clientExecutableToolNames`               | C4a L1 + contract test, C4b L7    |
| R26 complete text + no terminal                 | **OPEN.** R26a approved conditionally (DEC-21): accepted only after the real-process `SIGKILL` test passes; R26b deferred, not generalized | R26a at C4b; R26b at C6           |
| R28 partial-argument history at a real provider | **OPEN**, unchanged, not testable offline                                                                                                  | Needs a live call; not planned    |
| R33 host V8 crashes                             | OPEN. Host policy applies; CI (Node 24, Linux) is the second host                                                                          | C4b CI job                        |
| R34 cache failure                               | **Decided** (section 16)                                                                                                                   | C4b L9                            |
| R35 boot verification at scale                  | **OPEN.** C4's healthy boot is O(threads) seeks; the O(history) concern belongs to C8                                                      | C6 measurement, C8                |
| P-1 runner ownership check                      | In C4b as the required `ownsThread` option. **Not PoC-validated**                                                                          | C4b L4                            |
| P-2 `clearThreads` refusal                      | In C4b (DEC-16)                                                                                                                            | C4b                               |
| P-3 reader seam, P-4 `stopAll`, P-5 R26         | In C4b                                                                                                                                     | C4b                               |

**New observations from this review.**

- **Environment (resolved):** the default shell runs Node 22.23.1 while `engines.node` is `>=24.0.0` and CI uses Node 24. The owner's preflight found Node 24.14.1 installed and working; the baseline is recorded in section 0, and **C4 is accepted on Node 24**. The CI result of the pushed commits was not examined (no network use in this review).
- **`isRunning` versus `run()` window** (section 8.3) is a C6/DEC-13 design input.
- **A deferred (R26b) run leaves an unterminated run in replays.** How the client treats a replayed run with no terminal event is unverified and belongs to C6's real-browser acceptance.

---

## 26. Carry-forward items (recorded, not implemented)

- **H2 classification (owner, 2026-10-08), recorded in the decision record:** **OPEN; must resolve before shipping; does not block C4.** Reason: the startup validator currently accepts token strings that the standard HTTP transport may not preserve identically, because header values can normalise leading and trailing whitespace. No fix is implemented, and no future entropy or trim policy is accepted. The accepted DEC-2 contract is unchanged.
- H1, H3, H4 and H5 are unchanged and non-blocking.
- **DEC-3** (recurring busy semantics) still holds C6. **DEC-7** (backup verification: exists, mode `0600`, SQLite opens read-only, `PRAGMA quick_check` returns `ok`) is defined before C6. **DEC-10** (D3 mechanism) is undecided and blocks shipping. **DEC-13** requires C6 to close the race to an explicit conflict result; an advisory-only 409 is insufficient. **DEC-16:** the runner-level refusal is delivered by C4b; the authorization-level denial already exists.
- **P2a-9 and P2b-1** stay HOLD.

---

## 27. Owner decisions: disposition of the eight confirmation points

The points were put to the owner with this review's position. All eight were answered on 2026-10-08; section 0 has the recorded decisions.

| #   | Point put to the owner                                                                                              | This review's position                 | Owner's answer                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------ |
| Q1  | Table naming: does "production camelCase naming" (DEC-6) mean camelCase columns only, or camelCase table names too? | Columns only, as in design §7.4        | **DEC-18:** approved                                                           |
| Q2  | R23: approve the deviation from the PoC (declared **and** server-owned)?                                            | Approve                                | **DEC-19:** approved, with `clientExecutableToolNames`                         |
| Q3  | Split C4 into C4a and C4b?                                                                                          | Approve                                | **DEC-20:** approved, with the freeze rule                                     |
| Q4  | R26a in C4b, closed only if its real-kill test passes; R26b left deferred?                                          | Approve                                | **DEC-21:** approved conditionally                                             |
| Q5  | Pin scope: `@copilotkit/runtime` only?                                                                              | Leave `core`, `react-core`, `channels` | **DEC-22:** approved                                                           |
| Q6  | `ownsThread` and the refusing `clearThreads()` in C4b?                                                              | Agreed                                 | **DEC-23:** approved (with the precision note in 8.1)                          |
| Q7  | Drop the `workspace.ts` edit from C4?                                                                               | Agreed                                 | **DEC-24:** approved                                                           |
| Q8  | Write the H2 "must resolve before shipping" classification into the decision record?                                | Write it, before C4a                   | Approved; recorded (H2: OPEN, must resolve before shipping, does not block C4) |

---

## 28. Evidence index (`c4-design-evidence/`)

| File                                   | What it proves                                                                                                                                                                                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sdk-contract.mjs` / `.json`           | Versions; the `AgentRunner` declarations verbatim; 17 anchored SDK lines (all resolved, including `agent.agentId = agentId` for the `ownsThread` contract); the converter's event families; the real stock finalizer applied to eight crash fixtures, abrupt and stop |
| `ddl-validation.mjs` / `ddl.json`      | The DDL executed on throwaway databases: tables, columns, indexes, constraint probes, `foreign_keys = 1`, idempotence, AUTOINCREMENT, seven query plans, no name collisions, directories removed                                                                      |
| `index-bench.mjs` / `index-bench.json` | Read benefit (about 35 times) and write cost (+0.074 ms p50) of the `(threadId, id)` index; median of three; one host                                                                                                                                                 |
| `freshness-watermark.mjs` / `.json`    | What the single `lastEventId` watermark detects (a baseline and six scenarios) and its one known limit; the sources showing it predates R32; the four deferred R32 fields; no schema change needed                                                                    |
| `production-inventory.mjs` / `.json`   | 41 server modules at `ad0f145`; the only connection openers; every runtime construction point; none of the proposed modules exist or are reachable; no production mention of the new tables; no dynamic imports; the single client tool                               |
| `predicates.mjs` / `predicates.json`   | The recovery classifier, `recoveryEvents` and the stale-history predicate as executable specifications over 16 and 9 fixtures; where this proposal differs from the PoC (one row)                                                                                     |
| `dormancy-spike.mjs` / `.json`         | `module.registerHooks` plus `tsx`: 0 trace lines when a module is unreferenced, 1 when it is loaded                                                                                                                                                                   |
| `pin-check.mjs` / `version-pin.json`   | The pin's exact scope; runtime's exact dependency on shared and `@ag-ui/*`; the finding that `npm ci --dry-run` cannot discriminate a stale lockfile root spec                                                                                                        |

Also held in the manifest-verified snapshot `c4-boundary-closeout-*` under `/Users/martha/Documents/Repositories/opendots-local-first-snapshots/`; not copied into this repository. Regenerate with `node <script>.mjs` from `c4-design-evidence/` (each script reads main's pushed source read-only and uses only OS-temp throwaway paths).

---

## 29. What this review did not do

It did not implement C4, did not edit `package.json`, the lockfile or any production file, did not run a migration or create a conversation table in any real database, did not use the network (including CI and GitHub), did not run the test suite, and did not run any negative control (they are specified, not executed). Timings (`index-bench.json`) are from one host. The reference classifier and predicate are executable specifications, not production code. The estimates of commit size in section 24.4 are estimates.

Since the owner's approval this document was revised (section 0, 5.7 to 5.9, the DEC-19 contract test and terminology, the DEC-21 wording, section 27) and the evidence was regenerated only for the `clientExecutableToolNames` rename and two extra SDK anchors, plus the new freshness probe. No review conclusion changed.
