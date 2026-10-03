# Local-first P2a-8b acceptance: opaque `REASONING_ENCRYPTED_VALUE` fidelity through the durable runner

**Status:** P2a-8b was **executed in a temporary scratch worktree** (`/private/tmp/opendots-p2a1.FV0LOx`, the P2a-1 worktree, detached at `aa2a415`) and **PASSED**. This document was afterwards **copied to the main worktree as closeout documentation**. The scratch tests, helpers and raw evidence (`tests/p2a/p2a8b-*.ts`, `tests/p2a/p2a8b.test.ts`, the scratch runner, `p2a-evidence/p2a8b/*`) remain in the scratch worktree and are **not** part of the main worktree. **Production integration has not been done; no production source, test, migration, dependency or configuration was changed.**
**Baseline:** branch `feat/chatgpt-plan-provider`, commit `aa2a4157fa3b99b3176bdd7ea99cd8fb4d77266a`. P2a-0 PASS, P2a-8a PASS, P2a-1 PASS.
**Scope:** P2a-8b only. P2a-2 to P2a-7, P2a-9, P2b (live) and any production integration or migration were not started, and **P2a-2 is GO but still not started**.

## Verdict

```text
P2a-8b: PASS
```

All fifteen PASS criteria hold. Every `encryptedValue` in the corpus survived the full path (runner → SQLite `event_json` → process exit → new process, same database → read, replay, message cache) with **exact JS string equality and identical UTF-16 code units**. No normalization was applied anywhere, and no fixture was rewritten. **GO for P2a-2** (section 18). At execution time nothing was committed, pushed or tagged.

| #   | Criterion                                                                           | Result |
| --- | ----------------------------------------------------------------------------------- | ------ |
| 1   | Synthetic events pass through the durable runner path (`runner.run`, no direct SQL) | PASS   |
| 2   | Both subtypes (`message`, `tool-call`) are tested, on valid entities                | PASS   |
| 3   | The authoritative events deep-equal the originals after restart (unknown fields in) | PASS   |
| 4   | Exact JS string equality for every `encryptedValue`                                 | PASS   |
| 5   | Identical UTF-16 code units for every `encryptedValue`                              | PASS   |
| 6   | `connect` replay preserves the events and the strings                               | PASS   |
| 7   | The direct runner message cache (`getThreadMessages`) preserves `encryptedValue`    | PASS   |
| 8   | The HTTP `/messages` projection stays lossy; no production change                   | PASS   |
| 9   | Reader-only restarts perform no write transaction                                   | PASS   |
| 10  | Readers B and C see identical logical database contents                             | PASS   |
| 11  | No provider request                                                                 | PASS   |
| 12  | No unexpected external egress                                                       | PASS   |
| 13  | P2a-1 regression (`tests/p2a/p2a1.test.ts`) passes                                  | PASS   |
| 14  | P2a-0 / P2a-8a evidence (golden fixtures) is unchanged                              | PASS   |
| 15  | Main worktree status remains `?? mise.toml`                                         | PASS   |

## 1. Baseline and environment

| Item              | Value                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Scratch worktree  | `/private/tmp/opendots-p2a1.FV0LOx` (the P2a-1 worktree, detached at `aa2a415`; no new worktree)                                            |
| Node / npm        | **v24.14.1 / 11.11.0** (installed binary first on `PATH`; `mise.toml` not used)                                                             |
| OS                | macOS 12.7.6                                                                                                                                |
| Packages          | `@copilotkit/runtime` 1.75.0; `@ag-ui/client` 0.0.59; `@tanstack/ai` 0.63.0; SQLite 3.51.2 (bundled with `node:sqlite`); vitest 4.1.11; tsx |
| Env               | `COPILOTKIT_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`, asserted in the orchestrator and in each child process                                 |
| Main worktree     | `feat/chatgpt-plan-provider` = origin = `aa2a415`, status `?? mise.toml` before and after                                                   |
| Provider / secret | none used: no model, no credential, no `.env`                                                                                               |

## 2. Runner and scratch path

The runner under test is the P2a-1 scratch runner `tests/p2a/sqlite-runner.ts` (`SqliteAgentRunner extends AgentRunner`). It was **reused, not extended**: no behaviour was added for P2a-8b. It takes an externally opened `DatabaseSync` (here the `WorkspaceStore`'s own connection, as in P2a-1; the handle is read from a private field in the scratch harness, which is a PoC shortcut and not a design). Persistence is the normal W2 path: boundary events are committed (together with any buffered deltas) before they are published, buffered deltas are flushed by a 250 ms timer or by the next boundary, and finalization persists the terminal closers and rebuilds the message cache.

`tests/p2a/sqlite-runner.ts` was temporarily mutated five times as a negative control (section 17) and restored each time by copying the pre-mutation file back and diffing it. Its modification time is therefore later than the other P2a-1 files. Equality with the P2a-1 version rests on that diff and on the 19 P2a-1 tests passing; no separate P2a-1-time hash was recorded.

## 3. Schema reuse

The P2a-1 baseline candidate schema was reused unchanged (`conversation_runs`, `conversation_events` with `event_json TEXT` holding the whole event, `conversation_messages` as a rebuildable cache). No column, table, index or migration was added. The runner creates the tables itself in the scratch database; no production migration exists.

## 4. Synthetic-agent methodology

| Step                 | What was done                                                                                                                                                                                                                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent                | `SyntheticAgent extends AbstractAgent` (test-only, in `p2a8b-writer.ts`). It emits `RUN_STARTED`, a fixed valid body, `RUN_FINISHED`, and records a `structuredClone` of everything it emitted. No model, no provider code, no runtime HTTP in process A.                                                 |
| Entry point          | `runner.run({threadId, agent, input})`, the same entry the runtime uses. **There is no direct INSERT and no direct use of the runner's persistence functions.** The only other connection to the file in the writer is the read-only probe used by the orchestrator.                                      |
| Threads              | Two threads (two runs). **`main`**: 155 events, one delta per message / args, so compaction is the identity. **`open`**: 12 events, `REASONING_ENCRYPTED_VALUE` arrives **while** a text message and a tool call are still open, with multi-delta text and args (so compaction really moves them).        |
| Valid entities first | Every encrypted-value event is emitted after the `TEXT_MESSAGE_START` / `TOOL_CALL_START` (or `REASONING_MESSAGE_START`) of its `entityId`. Message ids and tool-call ids are separate namespaces; no tool-call id is used to sanitise message input.                                                     |
| Unknown fields       | Every encrypted-value event also carries `timestamp`, `rawEvent` (nested object) and `x_p2a8b_unknown` (null, false, 0, empty string, nested U+2028), to prove `event_json` keeps the whole event.                                                                                                        |
| Expectations         | The expected strings come from **in-code** values (`p2a8b-corpus.ts`, written with explicit `\u` escapes so the source file cannot alter them), never from a captured file. The orchestrator also reads `event_json` directly from the database file, in a third independent process, and compares again. |
| Processes            | **A** writes and exits cleanly (exit code 0, empty stderr apart from the Node SQLite experimental warning). **B** is a new process on the same file with a new runner, no model. **C** is a second new process, repeating B to prove idempotence.                                                         |

## 5. Subtype results

| Subtype     | Where used                                                                                                              | Result |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- | ------ |
| `message`   | each corpus message (17), a `reasoning` message (`rsn-message-1`), the shared-id message, the open message (`msg-open`) | PASS   |
| `tool-call` | each corpus tool call (17, `parentMessageId` = its message), the shared-id tool call, the open tool call (`call-open`)  | PASS   |

In total **39** encrypted values: main = 17 × 2 + 1 (reasoning message) + 2 (shared id) = 37; open = 2. The shared id `ns-shared-id` is used as a message id **and** as a tool-call id with different payloads; both survive independently and the cache keeps each on its own entity (the message has no `toolCalls`, the carrier message's tool call carries the other payload).

## 6. Corpus

Fourteen required cases plus three extras (marked **E**). `mixed` joins every case except the long one with U+0001.

| Case                    | Content (summary)                                                          | UTF-16 units | UTF-8 byte check |
| ----------------------- | -------------------------------------------------------------------------- | -----------: | ---------------- |
| `ascii`                 | ASCII, base64-looking characters                                           |           39 | yes              |
| `japanese`              | Japanese text                                                              |           20 | yes              |
| `astral`                | emoji, ZWJ sequences, math script, CJK extension B                         |           33 | yes              |
| `combining`             | composed, decomposed and compatibility-equivalent forms (must not change)  |           24 | yes              |
| `backslash`             | backslashes, literal `\n` / `\\` / `A` text, trailing backslash            |           67 | yes              |
| `double-quote`          | double, single and back quotes                                             |           42 | yes              |
| `newline`               | LF                                                                         |           19 | yes              |
| `carriage-return`       | CR and CRLF                                                                |            7 | yes              |
| `tab`                   | tabs                                                                       |           16 | yes              |
| `nul`                   | U+0000                                                                     |           18 | yes              |
| `line-separators`       | U+2028 and U+2029                                                          |           11 | yes              |
| `json-looking`          | JSON object text as an opaque string                                       |           78 | yes              |
| `json-array-and-quoted` | JSON array text, quoted and escaped text                                   |           33 | yes              |
| `long-64k`              | repeated mixed content (Japanese, emoji, quote, backslash, tab, LF)        |       65,552 | yes              |
| `lone-surrogates` **E** | unpaired high and low surrogates, a split pair                             |           28 | skipped          |
| `empty` **E**           | the empty string                                                           |            0 | yes              |
| `mixed` **E**           | all of the above except `long-64k`, joined by U+0001 (has lone surrogates) |          449 | skipped          |

The `lone-surrogates` and `mixed` strings contain unpaired surrogates. `TextEncoder` does not fail on them: it converts each unpaired surrogate to U+FFFD (USVString conversion), so their UTF-8 bytes cannot show that the original UTF-16 code units survived. The optional byte check therefore skips them (section 7).

## 7. Exact-string, UTF-16 and UTF-8 results

| Check                                                                                                                  | Scope                                                                 | Result |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------ |
| `replayed.encryptedValue === original.encryptedValue` (JS `===`)                                                       | all 39 expectations, stored events read by B and C, and read directly | PASS   |
| Explicit UTF-16 code-unit comparison (`charCodeAt` loop) and equal `length`, also after a `JSON.parse(JSON.stringify)` | all 39                                                                | PASS   |
| Explicit `TextEncoder` UTF-8 byte comparison                                                                           | **34** of the 39 (skipped for the 5 that contain unpaired surrogates) | PASS   |

**Authoritative fidelity criteria** are rows 1 and 2: exact JS string equality and exact UTF-16 code-unit equality. They apply to all 39 values, including the ones with unpaired surrogates.

The UTF-8 comparison is an **auxiliary check** that is meaningful only for payloads where no replacement occurs. All 34 byte-checked values are well-formed strings (`String.prototype.isWellFormed()` is true for each; checked once separately from the test suite), so `TextEncoder` encodes them without substitution, and for them the UTF-8 encoding of the original equals the UTF-8 encoding of the string read back. "Byte-identical" is claimed **only** for those 34 explicit `TextEncoder` comparisons. **Nothing is claimed about SQLite's physical byte representation.**

The five skipped expectations are the `lone-surrogates` and `mixed` strings on both subtypes plus the reasoning-message value (also `mixed`). For them a byte comparison would prove nothing: `TextEncoder` encodes `\ud800`, `\udc00` and `\ufffd` all as `EF BF BD` (checked), so different UTF-16 strings give identical bytes. They are compared by `===` and by code units only. JSON escapes unpaired surrogates (`\ud800`) and so round-trips them as code units. No string was normalized, trimmed, re-encoded or truncated. The `combining` case would have changed under NFC; it did not.

## 8. `event_json` fidelity

- After restart (readers B and C) the parsed `event_json` of every row deep-equals the events the writer emitted. The one intended difference is `RUN_STARTED`, to which the runner attaches the sanitised input (the user message lives only there), and the test computes that expectation explicitly.
- Unknown fields (`timestamp`, `rawEvent`, `x_p2a8b_unknown`, including the nested U+2028) are present on all 39 encrypted events after restart, with the exact key set `encryptedValue, entityId, rawEvent, subtype, timestamp, type, x_p2a8b_unknown`.
- The AG-UI pipeline between `agent.runAgent` and the runner's `onEvent` did not alter or strip anything: on the `main` thread, the published JSON of each of the 154 non-`RUN_STARTED` events equals the emitted JSON.
- **Auxiliary result (raw text):** for 167 of 167 rows, the stored `event_json` text is identical to `JSON.stringify` of the event the runner published (`event-json-text.json`). The contract is parse-and-compare; raw text equality is reported only as a bonus. Note that `JSON.stringify` leaves U+2028 and U+2029 raw (it does not escape them), while it escapes lone surrogates (`\ud800`).

## 9. `connect` replay

| Replay                                  | `main` (identity compaction)    | `open` (compaction moves entities)           |
| --------------------------------------- | ------------------------------- | -------------------------------------------- |
| Direct `runner.connect` in B and C      | deep-equals the writer's events | deep-equals `compactEvents(writer's events)` |
| Over the runtime's SSE (HTTP `connect`) | same                            | same                                         |
| Through `compactEvents` again           | same (idempotent)               | same                                         |
| Encrypted strings after replay          | all 37 `===` the in-code values | both `===` the in-code values                |

On the `open` thread the raw log is `…TEXT_MESSAGE_CONTENT, REASONING_ENCRYPTED_VALUE, TEXT_MESSAGE_CONTENT, TEXT_MESSAGE_END…`; replay yields `…TEXT_MESSAGE_CONTENT, TEXT_MESSAGE_END, REASONING_ENCRYPTED_VALUE…` (12 events become 10, deltas merged, each encrypted value moved after its entity's END). The order differs from the log by design of `compactEvents`; the strings are untouched.

## 10. Message cache (`getThreadMessages`, direct)

- Direct `getThreadMessages` in B and C returns messages carrying `encryptedValue`: on the 17 text messages, on the reasoning message (`role: reasoning`), and on each tool call (`toolCalls[].encryptedValue`), all `===` the in-code values; the `open` message also has its merged content `part-1 part-2` with both values attached.
- The cache equals what the public reducer (`defaultApplyEvents`) derives from the authoritative events **in the reader process**, and equals the cache that the writer's process produced at finalize. `ready()` found 2 caches and rebuilt 0 (`{checked: 2, rebuilt: 0}`), so reading wrote nothing.
- Direct message keys: `id, role, content, encryptedValue, toolCalls`; tool-call keys: `id, type, function, encryptedValue`.

## 11. HTTP projection note

The runtime's HTTP `GET /threads/:id/messages` projection is **expected to be lossy** and was not changed: its message keys are `id, role, content, toolCalls`, its tool-call keys are `id, name, args`, and `encryptedValue` is absent from both threads. The projection is applied downstream of the runner's `getThreadMessages`, which does return the value, so it is not a defect of the durable runner. Consequences for design: anything that needs the opaque value must read the event log or the runner's direct cache, not that HTTP projection. The HTTP `GET /threads/:id/events` endpoint is **not** lossy: it served all 37 main-thread encrypted values with exact equality. No production code was touched to change either endpoint.

## 12. Process identities

| Role                  | PID   | Notes                                                                       |
| --------------------- | ----- | --------------------------------------------------------------------------- |
| Orchestrator (vitest) | 82562 | also reads the database directly, read-only                                 |
| **A (writer)**        | 82563 | wrote 2 runs, 167 events; exited with code 0; `process.kill(pid, 0)` throws |
| **B (reader)**        | 82601 | new process, same file, new runner, no model                                |
| **C (reader)**        | 82626 | second new process; identical to B                                          |

The four PIDs are distinct. These are the PIDs of the final recorded run in `p2a-evidence/p2a8b/summary.json`; each run of the test uses fresh ones.

## 13. Database row counts and hash

| Item                                 | Value                                                                                  |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| Location                             | the OS temp directory (`…/T/p2a8b-Fisb0e/conversation.sqlite`), outside the repository |
| `conversation_runs`                  | 2 (both `finished`)                                                                    |
| `conversation_events`                | 167 (main 155, open 12)                                                                |
| `conversation_messages`              | 2                                                                                      |
| Logical SHA-256 (runs, events, msgs) | `a175c28863c7d72981f552342c5d1acc7597d53307f4104173136af3e1215c22`                     |
| Writer transactions                  | 127                                                                                    |

The logical hash covers every row of the three tables (the run rows include timestamps and random ids), so it **differs from run to run**; the assertion is that it is the same everywhere within one run, not that it is a constant. An earlier passing run of the same test recorded `c2ddd09525e946ae94b0c7b47331b7bc1e4eb3ce8b8ca0de89aac7f2fbe1ce22` for that reason.

## 14. Reader idempotence

- B and C each performed **0 write transactions** (the runner counts every `BEGIN IMMEDIATE … COMMIT` it performs; the unchanged database hash covers any other writer), and neither found a stale cache to repair.
- The logical dump (counts, hash and a separate timing hash) taken by the writer's probe after A, by B before and after, by C before and after, and by the orchestrator after C are all identical to each other.
- The JSON of B's and C's complete observations (stored rows, direct and HTTP replay, compacted replay, messages, derived messages, HTTP bodies) is byte-for-byte equal after removing the PID, label, dump and transaction fields.

## 15. Egress

Process A, B and C each installed the fail-closed instrumentation of `globalThis.fetch` and `net.Socket.prototype.connect`: **0 fetches and 0 connects** were recorded in each. Provider requests: **0 / 0 / 0**. No external probe was made. This measures what the instrumented server process attempted; it is not an operating-system-level network guarantee.

## 16. P2a-1 regression and unchanged evidence

| Check                                                                                                          | Result                               |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `tests/p2a/p2a1.test.ts` (rerun)                                                                               | **19 / 19 passed**                   |
| Whole `tests/p2a` suite (`golden` 12, `reasoning-drop` 5, `p2a1` 19, `p2a8b` 15)                               | **51 / 51 passed**, 4 files          |
| Golden fixtures, 17 files (`raw/*`, `normalized/*`, `manifest.json`) vs the SHA-256 list taken before P2a-8b   | **identical**; nothing was rewritten |
| Seven existing production test files run inside the scratch worktree (smoke check, no production file differs) | 35 / 35 passed                       |

## 17. Negative controls, deviations and surprises

Negative controls (each applied in `sqlite-runner.ts` where the event is serialized to `event_json`, then reverted):

| Mutation                                  | Tests that failed |
| ----------------------------------------- | ----------------- |
| NFC-normalize every string in the event   | 7                 |
| Drop one unknown field                    | 3                 |
| Truncate strings longer than 60,000 units | 7                 |
| Replace raw U+2028 with a space           | 7                 |
| Replace lone surrogates with U+FFFD       | 7                 |

All five were detected, so the corpus and the equality checks are able to fail. The runner was restored after each.

Deviations and surprises:

1. **A first version of the U+2028 mutation passed.** My regex matched the escaped text ` ` instead of the raw character, so it never changed anything. That was a mutation-design error, not a weakness of the test; the corrected mutation was detected (table above).
2. Early mutation attempts targeted pre-Prettier source text and silently did not apply; they were redone against the formatted anchor. The table lists only effective mutations.
3. `JSON.stringify` keeps U+2028/U+2029 raw and escapes unpaired surrogates, so both round-trip as code units. `TextEncoder` behaves differently: it substitutes U+FFFD for an unpaired surrogate, so a byte comparison cannot tell such a string from one containing U+FFFD. That is why the byte claim is limited to the 34 well-formed expectations, and why the U+FFFD mutation above is caught by the string and code-unit checks (the byte check is skipped for those values and would not detect it).
4. `open/message` was first mislabelled `utf8Safe: false` in the corpus; its value is well-formed and it is now byte-checked (34, not 33).
5. The corpus has three extras beyond the requested list (`lone-surrogates`, `empty`, `mixed`) and a reasoning-message check; they strengthen the result and do not change any criterion.
6. This is a runner / persistence contract. It says nothing about whether the ChatGPT-plan pipeline produces such events: in the CopilotKit 1.75.0 / TanStack AI 0.63.0 path observed in P2a-8a, the blob does not reach AG-UI (version-specific, not a contract).
7. The runner reads the `WorkspaceStore`'s private `db` field and the HTTP `/messages` projection stays lossy. Both are known and carried forward (section 19).

## 18. Verdict and recommendation

```text
P2a-8b: PASS
P2a-2 : GO
```

The durable runner preserves AG-UI `REASONING_ENCRYPTED_VALUE` opaque strings with no transformation across a real process restart, for both subtypes, for the whole corpus including a 64 KiB value, in the authoritative `event_json`, in replay (direct and over SSE) and in the direct message cache. The only lossy surface is the HTTP `/messages` projection, which is existing behaviour and unchanged. **GO for P2a-2.** That is a recommendation only; P2a-2 was not started, and the scratch runner remains an observed candidate, not an approved production implementation.

Carried forward into later P2a stages: keep `event_json` as the whole-event authority and never project fields into columns; keep `getThreadMessages` as the lossless path and document that the HTTP projection is lossy by design; keep exact-string tests for any future change to the serializer, the schema or the compaction; the connection seam between the workspace and the conversation store still needs a real design.

## 19. Files changed (all untracked, scratch only)

| File                                   | Change                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `tests/p2a/p2a8b-corpus.ts`            | new: corpus, shared-id values, synthetic event bodies, equality helpers                        |
| `tests/p2a/p2a8b-writer.ts`            | new: process A, synthetic agent through `runner.run`                                           |
| `tests/p2a/p2a8b-reader.ts`            | new: process B and C                                                                           |
| `tests/p2a/p2a8b.test.ts`              | new: orchestrator, 15 tests                                                                    |
| `docs/LOCAL_FIRST_P2A8B_ACCEPTANCE.md` | new: this document                                                                             |
| `p2a-evidence/p2a8b/*`                 | new: `summary.json`, `writer-A.json`, `reader-B.json`, `reader-C.json`, `event-json-text.json` |

No existing file under `tests/p2a` or `p2a-evidence/golden` was changed by P2a-8b (`sqlite-runner.ts` was mutated and restored, see section 2). At execution time no tracked file in any worktree changed and the main worktree was not touched; this document was copied to the main worktree afterwards, without the scratch files above.
