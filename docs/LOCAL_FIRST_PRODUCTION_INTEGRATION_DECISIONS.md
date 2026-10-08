# Local-first production integration: decision record

**Status: DECISION RECORD.** This document records the owner's decisions on the production integration design review. It changes no production source, test, dependency, migration or configuration. It does not start C1, P2a-9 or P2b-1.

| Item                | Value                                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Design under review | `docs/LOCAL_FIRST_PRODUCTION_INTEGRATION_DESIGN.md`, commit `9413f123fe1bd0007ac6638b22f8adbaebc9e67c` (`docs: add local-first production integration design`)                                   |
| Design checkpoint   | Pushed unchanged to `origin/feat/chatgpt-plan-provider` on 2026-10-07 before this record was written                                                                                             |
| Branch              | `feat/chatgpt-plan-provider`                                                                                                                                                                     |
| C4 landing boundary | `docs/LOCAL_FIRST_C4_LANDING_BOUNDARY.md`. Its evidence directory is not in this repository; it is held in the persistent scratch and in a manifest-verified snapshot (`c4-boundary-closeout-*`) |
| Decided             | 2026-10-07, by the owner (DEC-18 to DEC-24: 2026-10-08)                                                                                                                                          |
| Decisions recorded  | DEC-1 to DEC-12 (answers to the design's section 20.1), DEC-13 to DEC-17 (new), and DEC-18 to DEC-24 (the C4 landing boundary, 2026-10-08)                                                       |

## How to read this record

- The design document is the **proposal and review record** and is **not amended**. Where this record differs from a recommendation in it, this record prevails for the decision concerned. The differences are listed in section 2.
- Each **Decision** block is the owner's decision. Each **Note** block was added when recording. A note is marked **verified** (read in source at `9413f12`, where `src/` is identical to the design's authority commit `82330a6`) or **derived** (a consequence of the decision, to be confirmed in the design of the commit it affects). Notes are not owner decisions.
- Section numbers (`§`) and risk ids (R36, D3, and so on) refer to the design document.

---

## 1. Summary

| Id     | Topic                                                          | Outcome                            | Design                 | Applies to                      |
| ------ | -------------------------------------------------------------- | ---------------------------------- | ---------------------- | ------------------------------- |
| DEC-1  | Telemetry suppression is unconditional                         | APPROVE                            | §5                     | C1                              |
| DEC-2  | `OWNER_TOKEN` on every binding                                 | APPROVE                            | §6                     | C2                              |
| DEC-3  | Busy headless task policy                                      | **MODIFY**                         | §10.3                  | Store/scheduler design, then C6 |
| DEC-4  | Cache-write failure does not fail a durable run                | APPROVE                            | §9.4                   | C4, C6, C8                      |
| DEC-5  | Stale-tool interlock contract                                  | APPROVE                            | §7.6                   | C4                              |
| DEC-6  | Initial local conversation schema                              | APPROVE                            | §7.4                   | C4 (defined), C6 (executed)     |
| DEC-7  | Pre-activation backup                                          | APPROVE                            | §7.5                   | C6                              |
| DEC-8  | Legacy Intelligence threads                                    | APPROVE                            | §7.5                   | C6                              |
| DEC-9  | Exact pin of `@copilotkit/runtime`                             | APPROVE                            | §7.6                   | C4 (dependency edit)            |
| DEC-10 | D3 stale `RUN_ERROR` replay                                    | APPROVE v1 scope; MECHANISM HOLD   | §18.2                  | Shipping                        |
| DEC-11 | Remove `@copilotkit/channels` and `core`                       | APPROVE (conditional)              | §16 C9                 | C9b                             |
| DEC-12 | `test:crash`, `test:browser`, `test:egress`, CI                | APPROVE                            | §16, §17               | C1 (setup file), C4 onward      |
| DEC-13 | R37 same-thread loser gets a conflict response                 | APPROVE                            | §10.4                  | C6                              |
| DEC-14 | R38 preserve `RUN_ERROR.code`                                  | APPROVE (information preservation) | §10.5                  | C5                              |
| DEC-15 | Thread rename / archive / delete                               | APPROVE v1 policy                  | §7.8                   | Before shipping                 |
| DEC-16 | `/threads/clear`                                               | APPROVE fail-closed                | §7.6                   | C4, C6                          |
| DEC-17 | `/agent/:id/suggest`                                           | APPROVE deny                       | §6.1                   | C2                              |
| DEC-18 | Schema naming: snake_case tables, camelCase columns            | APPROVE                            | C4 boundary §5.1       | C4a                             |
| DEC-19 | R23 tool classification (`clientExecutableToolNames`)          | APPROVE (clarified terminology)    | C4 boundary §14        | C4a, C4b                        |
| DEC-20 | C4 split; C4a contract frozen for C4                           | APPROVE                            | C4 boundary §24, §5.8  | C4a, C4b                        |
| DEC-21 | R26a complete closed text, no terminal                         | APPROVE CONDITIONALLY              | C4 boundary §23        | C4b                             |
| DEC-22 | SDK pin scope: `@copilotkit/runtime` 1.75.0 only               | APPROVE                            | C4 boundary §7.1       | C4a                             |
| DEC-23 | Local thread contract: `ownsThread`, refusing `clearThreads()` | APPROVE                            | C4 boundary §8         | C4b                             |
| DEC-24 | Database injection; no `workspace.ts` change                   | APPROVE                            | C4 boundary §4.2, §5.9 | C4a                             |

## 2. Where this record departs from the design's recommendation

| Decision                  | Design said                                                                                                                              | This record                                                                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| DEC-3                     | Recommended: all busy headless tasks fail, no automatic retry, a repeating task stops until the owner presses Run (§10.3, §18.1, §20.1). | **Not adopted.** One-shot and recurring tasks get different semantics. C6 is held until the Store/scheduler design is updated and tested. |
| DEC-10                    | Add a commit and evaluate both mechanisms; whether D3 is v1 scope is an owner decision (§18.2, §20.1).                                   | D3 **is** v1 scope. Mechanism still undecided; neither candidate is approved.                                                             |
| DEC-13                    | Advisory 409 in `Platform.handle`; a lost race still degrades to the empty stream (§10.4).                                               | The loser of the race must not get a 200 with an empty stream. See the note on DEC-13.                                                    |
| maxIterations (section 5) | Collapse the expression to the constant 5 at C9b (§8, §16 C9).                                                                           | No `maxIterations` semantic change is approved. The collapse remains a proposal.                                                          |
| DEC-15, DEC-16, DEC-17    | Thread mutations are unsupported and the client does not use them (§7.8); the `suggest` removal is listed inside C2 (§16).               | Recorded as explicit decisions with fail-closed or deny semantics.                                                                        |
| DEC-19                    | Design §20 (R23) and the PoC: a tool is client-executed when the client declared it in the persisted `RUN_STARTED.input.tools`.          | Client-executed only if declared **and** in the server-owned `clientExecutableToolNames`. The client may narrow the set, never widen it.  |
| DEC-24                    | Design §16 (C4): edit `workspace.ts` to add an `openConversationLog()` seam.                                                             | Dropped. `ConversationLog` receives an injected `DatabaseSync`.                                                                           |

---

## 3. Decisions

### DEC-1: APPROVE

**Decision.** Application-owned telemetry suppression is unconditional. `COPILOTKIT_TELEMETRY_DISABLED=false` must not re-enable telemetry for the shipped local-first application. The first-import guard remains mandatory.

**Note (verified in the design).** C1 specifies a side-effect module that sets `COPILOTKIT_TELEMETRY_DISABLED=1` and `DO_NOT_TRACK=1` without consulting the existing values, imported first by `index.ts` and by every module that value-imports `@copilotkit/runtime`, `/channels` or `/core`, with an evaluation-order contract test (§5, §16 C1).

### DEC-2: APPROVE

**Decision.** `OWNER_TOKEN` is required on every binding, including loopback. Minimum length: 24 characters. There is no development or loopback opt-out in the shipping path. `sessionStorage` remains an accepted v1 open risk, subject to the conditions already documented.

**Note (verified in the design, §6.5).** The documented conditions are:

1. `script-src 'self'` stays, and the L5 CSP probes keep proving it (C7).
2. No HTML-injection sinks in `src/client` (the L0 grep stays green).
3. The token never appears in a URL, log line, DOM text or error message (L5 canary).
4. It is documented as an open risk.

The server-issued `HttpOnly; SameSite=Strict` session upgrade stays deferred (OWNER-STORE).

### DEC-3: MODIFY

**Decision.** Do **not** adopt "all busy headless tasks fail permanently with no retry" as the production policy. Required semantics:

- **One-shot task:**
  - busy before the run starts
  - fail loudly
  - no automatic retry
- **Recurring task:**
  - busy before the run starts
  - no provider, tool or run side effect
  - mark the occurrence explicitly busy or skipped
  - preserve and advance the recurring schedule
  - do not immediately retry the same occurrence

This requires a Store/scheduler design update **before C6**. **C6 remains HOLD** until it is designed and tested.

**Note (verified).** Today a rejected turn reaches `Store.fail`, which marks the task `failed`; `claim()` selects only `queued` tasks and `completed` tasks whose `nextRunAt` is due (`src/server/store.ts:241`), so a failed repeating task stops until the owner presses Run. `claim()` also clears `nextRunAt` when it takes a task, and `release()` returns a claimed task to `queued` (§10.3 records that `Runner.tick` re-claims every second, so a naive release would hot-loop). Neither the current `fail` path nor `release` satisfies the recurring-task semantics above.

**Open for the Store/scheduler design update (not decided here).**

1. How an occurrence is recorded as busy or skipped (a task or run status, an event row, or both) without any provider, tool or conversation-log write.
2. How the schedule advances: from the occurrence's due time or from now, and whether missed intervals are coalesced.
3. How one-shot and recurring tasks are told apart (the existing `intervalSeconds` column is the obvious candidate).
4. What DEC-3 requires of the non-scheduled headless callers (voice compute and the voice receipt, §10.1), which the decision text does not mention.
5. What "run side effect" excludes: the conversation log and provider/tool calls, versus the Store's own record of the occurrence.

**Note (derived).** Minimum tests for the update: L1/L2 for both kinds against a thread held busy, asserting provider 0, tool 0 and conversation-log writes 0; one-shot fails with a precise message and is not re-claimed; recurring is recorded busy or skipped, its next occurrence still runs normally, and the same occurrence is not re-claimed on the next tick.

### DEC-4: APPROVE

**Decision.** A cache-write failure must not fail an otherwise durable run. Readers use the authoritative event log while the cache is stale. Allow one bounded in-process repair attempt and natural catch-up at a later finalization. Do not require a reload as the recovery mechanism.

**Note (verified in the design).** This is §9.4 option D. It also describes the reader seam `messagesFor(threadId)` of §7.7.

### DEC-5: APPROVE

**Decision.** Interlock contract:

- stale-tab input that omits a durable recorded tool result: **reject**
- prompt-only headless input: **accept**

Do not use the literal interpretation that would reject every prompt-only scheduled turn that has historical tools.

**Note (verified in the design, §7.6).** "Reject" means fail closed: no provider call, no tool call, no durable write. The design requires an L2 test in both directions.

### DEC-6: APPROVE

**Decision.** Initial local conversation schema:

- three production tables
- production camelCase naming
- no schema-version table introduced solely for this work
- R32 checkpoint columns deferred to C8

Do not copy the PoC snake_case schema literally.

**Note (verified in the design, §7.4).** The reference DDL is `conversation_runs`, `conversation_events` and `conversation_messages`, with `CREATE TABLE IF NOT EXISTS` and the `(threadId, id)` index. Production has no migration framework; the idiom is idempotent `CREATE` plus `PRAGMA table_info`-guarded `ALTER`.

**Note (derived).** C4 defines the DDL but nothing calls it, so no database changes. The DDL first executes against a real database at C6, which is on HOLD.

### DEC-7: APPROVE

**Decision.** Before C6 activation, create one persistent SQLite backup using `VACUUM INTO`. Requirements:

- mode `0600`
- persistent location
- never auto-delete
- activation aborts if backup creation or verification fails

**Note (verified in the design, §7.5, §17.2).** The design places this on the first C6 boot against an existing database without a `conversation_runs` table, and lists "backup restore" as a C6 acceptance gate.

**Open for the C6 acceptance design.** The design says only that activation refuses if the backup cannot be written. "Verification" is the owner's requirement and must be defined there (for example, opening the backup and checking it).

### DEC-8: APPROVE

**Decision.** Legacy Intelligence threads in v1:

- remain visible
- local history may be empty
- document this as archive-only legacy behavior

Do not add an `origin` column solely for v1. Do not import old Intelligence history.

**Note (verified in the design, §7.5).** Those threads still list (the list comes from `thread_bindings`) and open empty; call receipts keep rendering.

### DEC-9: APPROVE

**Decision.** Pin `@copilotkit/runtime` to the exact validated version. This is an explicitly approved dependency edit **for C4**. Any future SDK upgrade must rerun the relevant contract gates, including telemetry/import order and local-thread endpoint contracts.

**Note (verified).** `package.json:33` currently reads `"@copilotkit/runtime": "^1.75.0"`, and the installed and validated version is `1.75.0`. The edit is **not** made by this record. Design §17.3 already lists a change to the `@copilotkit/runtime` version as a trigger for reconsidering a live P2b-0-shaped test, which needs the owner's explicit approval.

### DEC-10: APPROVE V1 SCOPE / MECHANISM HOLD

**Decision.** D3 (stale historical `RUN_ERROR` replay) is a v1 shipping issue. Do not ship the persistent stale-banner regression knowingly. Before selecting the implementation, evaluate:

- **A.** the P2a-6 client-origin seam
- **B.** a server-side replay filter

Choose the safer mechanism from evidence. **Do not treat either mechanism as approved yet.**

**Note (verified in the design, §18.2).** Known inputs: P5 M8 reproduced the stale banner; the P2a-6 client seam is not production-approved (R29 live-join misclassification, R30 depends on core internals); whether the legacy Intelligence path replayed errors the same way is unknown.

**Gate.** DEC-10 blocks **shipping**. It does not block the creation of dormant C4/C5 code.

### DEC-11: APPROVE

**Decision.** At C9b remove the unused `@copilotkit/channels` and the direct `@copilotkit/core` dependency, provided the source and reachability gates confirm they are no longer required.

**Note.** DEC-9 (C4) and DEC-11 (C9b) are the two approvals for the `package.json`/lockfile edits that design §20.2 lists as approval gates, each scoped to its own commit. DEC-11 approves the dependency removal only; it does not approve the `maxIterations` collapse that the design also lists under C9b (section 5).

### DEC-12: APPROVE

**Decision.** Add dedicated `test:crash`, `test:browser` and `test:egress` scripts and CI jobs. Add the vitest setup/import-order protection required by C1. Do not force the crash, browser and egress suites into every default unit-test run if they are intentionally heavier gates.

**Note (verified).** Today `package.json` has no such scripts, `vite.config.ts` has no `test` block, and `.github/workflows/ci.yml` has one `check` job (`check-format`, `lint`, `typecheck`, `test`, `build`). Which commit introduces each script follows the acceptance ladder (§17); this decision moves no gate.

### DEC-13: R37, APPROVE

**Decision.** When a browser/local run loses the same-thread concurrency race, preserve an explicit legacy-parity conflict response. Target: HTTP 409 / explicit busy-conflict semantics. Do not return HTTP 200 with an empty stream and a generic "no response" banner.

**Note (derived).** Design §10.4 recommended an advisory 409 in `Platform.handle` while a lost race "still degrades to the empty stream", and §7.6 records that the SDK turns the runner's synchronous rejection into a 200 with an empty stream. DEC-13 does not accept that degradation, so the C6 design must also cover a race lost between the advisory check and runner admission. L4 keeps asserting a visible message (§10.4, §17.1).

### DEC-14: R38, APPROVE INFORMATION PRESERVATION

**Decision.** Preserve `RUN_ERROR.code` durably and on the thrown `Error` object. The v1 headless caller API may remain message-oriented. A richer code-aware caller contract may be deferred, but the code itself must not be discarded.

**Note (verified in the design, §10.2, §10.5, §16 C5).** The durable runner stores events verbatim; C5 attaches the code to the thrown error without changing its message; no caller uses the code in v1.

### DEC-15: THREAD RENAME / ARCHIVE / DELETE, APPROVE V1 POLICY

**Decision.** Local implementation of these operations is not required for the first local-first activation. Do not ship owner-visible controls that deterministically return 422. Before shipping, either:

- **A.** implement the local operation safely, or
- **B.** disable or hide the corresponding UI and explicitly mark it unsupported.

Do not silently fail.

**Note (verified).** `src/client/ThreadList.tsx` at `9413f12` renders select, new conversation and load-more only, so no control returns 422 today. `PATCH`/`DELETE threads/:id` and `POST threads/:id/archive` pass `runtime-scope.ts` and answer HTTP 422 under the SSE runtime (§7.8). The §7.8/§17.1 L4 gate (no 4xx/5xx from `/api/copilotkit/threads/*`) is unchanged by this decision.

**Not decided here.** Whether those API routes should also be denied at `runtime-scope.ts`, and the A/B choice per operation.

### DEC-16: `/threads/clear`, APPROVE FAIL-CLOSED

**Decision.** Local-first v1 must refuse `/threads/clear`. Do not map it to deletion of every local conversation. It may only be enabled later after safe scoped semantics are designed and accepted.

**Note (verified).** `src/server/runtime-scope.ts` already denies `threads/clear` (it is in the reserved-suffix list, line 47). The design also has the local runner's `clearThreads()` refuse (§7.6, P-2). This decision keeps both layers.

**Note (derived).** C4 and C6 tests should assert that `clearThreads()` refuses and deletes nothing, and that the route is denied.

### DEC-17: `/agent/:id/suggest`, APPROVE DENY

**Decision.** The current production allowlist includes `suggest`. C2 must remove or deny this path because it bypasses the durable runner and is currently unused. Do not leave it accessible merely for legacy parity.

**Note (verified).** `src/server/runtime-scope.ts:29` matches `agent/:id/(run|connect|suggest)`. No client code calls a `suggest` route. The design's C2 already lists removing it (§16 C2); this makes it a decision, and `tests/runtime-scope.test.ts` is already in C2's file list.

### DEC-18: SCHEMA NAMING, APPROVE

**Decision.** Table names: snake_case. Column names: camelCase. `conversation_runs`, `conversation_events` and `conversation_messages` remain the table names. "Production camelCase naming" means production **column** naming, not camelCase table names.

**Note (verified).** This is the production convention (`thread_bindings(id, dotId, ownerId, title, createdAt)`) and the shape used in design §7.4.

### DEC-19: R23 TOOL CLASSIFICATION, APPROVE WITH CLARIFIED TERMINOLOGY

**Decision.** Use a server-owned set named conceptually `clientExecutableToolNames`. A tool is classified as client-executed only when:

1. it was declared by the client in the persisted `RUN_STARTED.input.tools`, **and**
2. its name exists in the server-owned `clientExecutableToolNames` set.

The client may narrow the effective set. It may never widen it. Do not hardcode arbitrary string literals throughout recovery logic; prefer names obtained from the production tool definitions, for example `pageReviewTool.name`. Any disagreement must fail in the safe direction. Add a precise contract test before C4a/C4b is considered complete.

**Note (terminology).** `clientExecutableToolNames` is server-owned configuration describing which tools are legally client-executed. It is **not** a list of server-executed tools. The earlier phrase "server allow-list" is retired.

**Note (verified).** The only client-executed tool today is `review_space_page` (`src/client/Chat.tsx:192`), and `DotAgent` forwards a client tool only when its name equals `pageReviewTool.name` (`src/server/dot-agent.ts:259`). The design and the PoC rule (declared names only) trusted the client; this decision replaces it.

### DEC-20: C4 SPLIT, APPROVE

**Decision.**

- **C4a:** storage, schema, pure rules and the SDK pin.
- **C4b:** dormant durable AgentRunner, recovery and crash tests.

Once C4a is accepted, **its schema and storage contract are frozen for C4.** C4b may **NOT** silently amend the C4a schema merely because the DDL has not yet executed in production. If C4b discovers a real schema defect: **STOP**, and propose an explicit C4a correction for review before proceeding.

**Note.** `docs/LOCAL_FIRST_C4_LANDING_BOUNDARY.md` section 24 lists each commit's files. Neither commit activates anything.

### DEC-21: R26a, APPROVE CONDITIONALLY

**Decision.** For a run with complete closed text, no tool-call family, no reasoning, state or other unresolved event family, and a missing terminal lifecycle, the production recovery candidate may write `RUN_ERROR` with `code = INCOMPLETE_STREAM` and set `status = interrupted`. It must never infer `finished`. This rule becomes accepted implementation behavior only after its real-process `SIGKILL` test passes.

R26b remains OPEN and deferred. Do not generalize R26a to reasoning or state event families.

### DEC-22: SDK PIN SCOPE, APPROVE

**Decision.** Pin only `@copilotkit/runtime` to `1.75.0`, at C4a. Do not expand this decision to `@copilotkit/core`, `@copilotkit/react-core` or `@copilotkit/channels` in C4. If C4 introduces a new semi-public contract dependency on one of those packages, stop and request review rather than silently expanding the pin set.

**Note.** DEC-9 already approved the runtime pin for C4; DEC-22 fixes its scope and its commit.

### DEC-23: LOCAL THREAD CONTRACT, APPROVE

**Decision.** C4b includes the `ownsThread` option. It must have a direct contract test because this seam was not validated by the original PoC. Also: `clearThreads()` must explicitly refuse and throw in the dormant local runner. It must never translate into deleting all local conversations.

**Note (terminology; added when recording).** The decision describes `ownsThread` as required by the installed SDK. It is not: `ownsThread(threadId, agentId)` is an OpenDots-defined required constructor option of the dormant runner (design P-1), and the SDK's `AgentRunner` contract has no such option. What it relies on from the SDK is what `runner.run` receives: the SDK sets `agent.agentId` to the route's agent id (`handle-run.mjs:23`) and passes `input.threadId`. The decision's "direct contract test" is therefore read as a test through the real SDK handler that pins exactly that, together with the ownership behaviour itself. If a different reading was intended, the owner should say so before C4b.

### DEC-24: DATABASE INJECTION, APPROVE

**Decision.** Drop the proposed `workspace.ts` modification from C4. `ConversationLog` receives an injected `DatabaseSync` (database) seam. This is preferred for dormancy, isolated tests, explicit lifecycle and production activation control. R16 remains resolved by this boundary.

### Clarification of DEC-6: `lastEventId` is not an R32 checkpoint column (derived; not a new decision)

DEC-6 defers the "R32 checkpoint columns" to C8. The C4 schema's `conversation_messages.lastEventId` is **not** one of them: it is a minimal freshness watermark required by the full-rebuild implementation, and it predates R32 (it is in the P2a-1 schema, before R32 added its fields). The R32 fields that stay deferred to C8 are exactly four: `throughRunSeq`, `throughEventSeq`, `eventCount` and `messagesSha256`. DEC-6's text above is unchanged, and the proposed C4a schema does not change. Derivation and evidence: `docs/LOCAL_FIRST_C4_LANDING_BOUNDARY.md` section 5.7.

---

## 4. Implementation readiness

"GO" means cleared to start when the owner instructs it, subject to the per-commit acceptance levels in design §17.2. "PASS / integrated" means the commit passed the owner's review and is pushed on `feat/chatgpt-plan-provider`. C1, C2 and C3 are integrated; the C4 landing boundary is approved (DEC-18 to DEC-24), **C4a is next and has not been started**, and no later commit has been started. The acceptance runtime for C4 is Node 24 (24.14.1 is installed and its baseline is recorded in the boundary document).

| Commit | State                              | Basis                                                                                                                                                                                                        |
| ------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1     | **PASS / integrated** (`b325d66`)  | DEC-1 and the vitest setup file in DEC-12 are decided.                                                                                                                                                       |
| C2     | **PASS / integrated** (`5f04507`)  | DEC-2 and DEC-17 are decided.                                                                                                                                                                                |
| C3     | **PASS / integrated** (`b83ce70`)  | No open decision.                                                                                                                                                                                            |
| C4a    | **Boundary approved**, not started | Storage, schema, pure rules and the exact `@copilotkit/runtime` 1.75.0 pin (DEC-18 to DEC-20, DEC-22, DEC-24). Dormant. DEC-4, DEC-5, DEC-6, DEC-9, DEC-12 and DEC-16 are decided; DEC-10 does not block it. |
| C4b    | Sequenced after C4a                | The dormant durable `AgentRunner`, recovery and crash tests (DEC-19, DEC-21, DEC-23). Dormant. The C4a schema and storage contract are frozen for it (DEC-20).                                               |
| C5     | **GO**                             | DEC-14 is decided. Dormant code; DEC-10 does not block it.                                                                                                                                                   |
| C6     | **HOLD**                           | DEC-3 requires the recurring-task busy/scheduling semantics to be redesigned and tested before activation. See the open items below.                                                                         |
| C7     | Sequenced after C6                 | As designed.                                                                                                                                                                                                 |
| C8     | Sequenced after C6                 | As designed.                                                                                                                                                                                                 |
| C9     | Sequenced after C6 and C7          | As designed. C9b has its dependency approval (DEC-11), conditional on the reachability gates.                                                                                                                |

The "Note (verified)" lines in section 3 describe the source as it was when this record was written (`9413f12`). For example, `suggest` was still in the scope allowlist then; C2 removed it.

DEC-10 blocks **shipping**, not the creation of dormant C4/C5 code. **Shipping remains HOLD**, with the design's before-shipping risks (§18.2) still open, DEC-10's mechanism and implementation, and DEC-15's A/B choice.

The design's other C6 conditions are unchanged: the full acceptance ladder, the upgrade fixture, the backup restore and the before-integration risks (§17.2, §18.1).

### Open items created by these decisions

| Item                                                                                      | Gate                                     | Owner of the work                          |
| ----------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------ |
| DEC-3 Store/scheduler design update and tests                                             | Before C6                                | Design update, then tests                  |
| DEC-13 loser-of-the-race conflict response                                                | C6 design                                | C6 design                                  |
| DEC-7 definition of backup "verification"                                                 | C6 acceptance                            | C6 design                                  |
| DEC-10 evaluation of mechanisms A and B, from evidence                                    | Shipping                                 | Added commit, after evaluation             |
| DEC-15 A or B per operation                                                               | Before shipping                          | C6/C7 UI work                              |
| DEC-19 contract test for `clientExecutableToolNames`                                      | Before C4a and C4b are complete          | C4a (source and behaviour), C4b (recovery) |
| DEC-21 real-process `SIGKILL` test of the R26a window                                     | Before R26a counts as accepted behaviour | C4b                                        |
| DEC-20 freeze: a real schema defect found in C4b means STOP and a proposed C4a correction | During C4b                               | Review                                     |

## 5. `maxIterations`

**No production `maxIterations` semantic change is approved.** Preserve the current production behaviour (`src/server/dot-agent.ts`: `maxIterations(dot.skillDeliveryEnabled && conversation.learningContainerId ? 10 : 5)`) until the later cleanup makes the learning path unreachable. Do **not** carry the P5 fixed-5 test candidate into C3 or C4.

The design's proposal to collapse the expression to the constant 5 at C9b (§8) stays a proposal. DEC-11 does not approve it.

## 6. Housekeeping and state

- The design document and commit `9413f12` are unchanged by this record.
- This record changes no `src/`, `tests/`, `package.json` or lockfile.
- P2a-9 and P2b-1 remain HOLD.
- The four prunable `/private/tmp` worktrees (§19.1) were pruned on 2026-10-07, after the design checkpoint and this record had both been reviewed and pushed.
- The C4 landing boundary is `docs/LOCAL_FIRST_C4_LANDING_BOUNDARY.md`. Its evidence directory is not in this repository; it is held in the persistent scratch and in a manifest-verified snapshot named `c4-boundary-closeout-*`.

## 7. Deferred hardening items

**These are not decisions.** They carry no DEC numbers, none has been approved or rejected, and none blocks C4. They record questions raised while reviewing C1 to C3 so they are not lost. The behaviour described under "Current" is today's compatibility behaviour; it is **not an approval** of that behaviour for shipping. Nothing here changes DEC-1 to DEC-17: **DEC-2 remains exactly** "`OWNER_TOKEN` required, minimum 24 characters, no loopback or development opt-out". An item becomes a decision only if the owner explicitly decides it and it is given a DEC number. If this section and DEC-1 to DEC-17 could be read to conflict, DEC-1 to DEC-17 govern.

### H1: `OWNER_TOKEN` versus `BROWSER_SECRET`

**Question.** Should shipping configuration refuse to start when `OWNER_TOKEN === BROWSER_SECRET`? Separate trust domains may be better served by separate secrets.

**Current (verified).** Nothing in `src` compares the two. `docs/SETUP.md` tells the owner to use different secrets for the browser service, so the difference is documented, not enforced.

**Status: OPEN.** Not a blocker for C1 to C4.

### H2: `OWNER_TOKEN` whitespace and strength policy

**Question.** Beyond a length of at least 24, should the policy require non-whitespace content (after trimming), a minimum entropy, a generated-token format, or another explicit strength rule?

**Current (verified).** `requireOwnerToken` (`src/server/startup-config.ts`) checks only that the value is present and at least 24 characters long, so 24 whitespace characters satisfy it. Node's `fetch` strips trailing whitespace from header values (checked against a local server), so a token that ends in whitespace, or is only whitespace, can pass startup and still not be presentable by a standard HTTP client.

**Status: OPEN.** The accepted DEC-2 contract is not changed by this item.

**Classification (owner, 2026-10-08).** **OPEN; must resolve before shipping; does NOT block C4.** Reason: the startup validator currently accepts token strings that the standard HTTP transport may not preserve identically, because header values can normalize leading and trailing whitespace. No fix is implemented, and no specific future entropy or trim policy is accepted yet.

### H3: Authorization syntax

**Question.** Should shipping require strict `Authorization: Bearer <token>` and stop accepting a bare token?

**Current (verified).** The `/api/*` middleware (`src/server/app.ts`) removes a leading `Bearer ` if there is one and compares the rest, so both `Bearer <token>` and a bare `<token>` are accepted. The browser service (`src/browser/index.ts`) parses its own secret the same way.

**Before any change, inventory every caller.** The senders of the owner token known in this repository are the browser client (`src/client/api.ts`: `api()` and `authHeaders()`, which the CopilotKit provider and the voice code reuse) and the server's self-call in `Platform.turn` (`src/server/platform.ts`); all of them send `Bearer`. This is not an exhaustive inventory: scripts and local automation outside the repository are unknown (design §6.3).

**Status: OPEN.**

### H4: Startup configuration centralisation

**Question.** Should the existing `MODEL_PROVIDER` and `CHATGPT_CREDENTIAL_STORE` validations move into the application-owned startup-config seam (`src/server/startup-config.ts`)?

**Current (verified).** Both are validated inline in `src/server/index.ts`. Design §6.4 proposed moving them; the C2 contract did not include it. This is a maintainability and configuration-centralisation question, not part of C2 authorization correctness.

**Status: OPEN.**

### H5: `DO_NOT_TRACK` process inheritance

**Question.** If OpenDots ever launches a child process whose own do-not-track policy must differ, the inherited setting needs a compatibility review.

**Current (verified).** C1 (`src/server/telemetry-guard.ts`) sets `DO_NOT_TRACK=1` in the server process, so child processes inherit it. This was accepted for C1. Today `src` imports no `child_process` and no deployment file sets the variable, so there is nothing to review yet.

**Status: OPEN.** Non-blocking.
