# Local-first production integration design review

**Status: DESIGN ONLY.** No production file, dependency, migration or configuration was changed. Nothing was committed, pushed or tagged, nothing was copied to main, P2a-9 and P2b-1 were not started, and no live or network call was made. This document exists only in the persistent scratch. It is a review of an **offline validated candidate built from a post-reboot reconstruction**; it does not say the candidate is implemented or approved.

| Item               | Value                                                                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authority (main)   | `82330a615739a4230fdf4ce0356fdf2fbb595c8a`, branch `feat/chatgpt-plan-provider`, status `?? mise.toml`                                                                           |
| Persistent scratch | `/Users/martha/Documents/Repositories/opendots-local-first-scratch` (reconstruction base `0686e0b`, detached)                                                                    |
| P5 snapshot        | `/Users/martha/Documents/Repositories/opendots-local-first-snapshots/p5-closeout-20261006T100420Z` (verified 144 OK / 0 FAILED, manifest `8aedf3cd…fea2e9`)                      |
| Evidence           | `integration-design-evidence/` (13 JSON files, the generator `gen-evidence.mjs`, the authored data `design-data.mjs`); every cited source anchor is re-verified when it is built |

Reading guide. "**Verified**" = read in production source at 82330a6 (git objects, not the working tree) or in the installed SDK 1.75.0, and re-checked by the generator. "**Design**" = a recommendation of this review. "**Not validated by the PoC**" = new design that no acceptance document exercised (listed in Appendix A, ids P-1 to P-15). Source references are `file:line` at 82330a6; Appendix B lists every one.

---

## 1. Executive recommendation

**Verdict: CONDITIONAL GO for integration, as nine commits (C1 to C9). GO now for C1 (telemetry guard), C2 (owner boundary) and C3 (DotAgent guard). HOLD on C4 onward until the owner answers the decisions in section 20.** The first implementation step is **C1, the telemetry first-import guard**.

What the review found, in order of consequence:

1. **The proposed order I1→I7 is not safe as written.** Activating the local runtime (I3) while DotAgent still requires `intelligenceKey` (I4) makes every chat run fail at `dot-agent.ts:84`, and while headless turns still call `/info` expecting `mode: "intelligence"` (I6) makes scheduled tasks, voice compute and the voice receipt fail at `headless.ts:18`, because the local runtime reports `mode: "sse"`. The smallest change keeps your seven phases and adds two moves and one split: I4(A) moves before I3; I6's adapter lands, dormant, before I3; I3 splits into a dormant runner and one activation commit. Section 4.
2. **"CopilotRuntime without Intelligence" is `CopilotSseRuntime`.** `CopilotRuntime` is a legacy shim that delegates to it unless an `intelligence` option is present. Construct `CopilotSseRuntime` directly. It cannot be switched into Intelligence mode by a stray option, and it **throws** on `channels` and on learning options, so managed Slack and Automatic Learning are not "disabled by configuration", they are structurally impossible in this runtime. Section 7.2.
3. **`PageService` is a second, unlisted Intelligence consumer** (page conversations and "save conversation as page"), next to `Platform.createConversation` and `history()`. It must move in the same activation commit. Section 7.9.
4. **Capabilities that disappear with the SSE runtime**, and are not implementation failures: thread rename/archive/delete over the runtime API (HTTP 422), automatic conversation titles, managed Slack, learned skills. The OpenDots UI uses none of the thread mutations. Section 12.
5. **`maxIterations` needs no change.** The `10 : 5` expression was added together with learned-skill delivery (`f2616a2`); before that the cap was 5 for every Dot. Removing `learnedSkills` does **not** by itself select 5, because the expression reads stored Dot data. Leave it alone; collapse it to the constant 5 only when learning is retired. Section 8.
6. **R32 is separable from I3.** The first landing keeps the P2a-validated eager full-rebuild cache and minimal schema; the checkpoint columns are an additive migration in C8. Every OpenDots reader goes through one seam that falls back to the authoritative log, which also settles R34. Section 7.7 and 9.
7. **`OWNER_TOKEN` should be required on every binding, with no opt-out; keeping the token in `sessionStorage` is not a ship blocker** under four stated conditions. Section 6.
8. **Telemetry suppression must be a property of module load order, not of an environment variable.** A module-level first-import guard plus an evaluation-order contract test; `enableInspector={false}` for the dev inspector. Section 5.
9. **Rollback stops being a plain code revert at C6**, the activation commit. Everything before it is revertible without any data consideration. A one-time pre-activation backup is recommended to make the revert real. Section 15.
10. **No integration phase needs another live ChatGPT Plan test.** Section 17.
11. **One risk sits outside I1-I7 and bites users:** the stale error banner when a historical `RUN_ERROR` replays (D3). A usage-limit error would reappear every time that thread is opened. It needs an owner decision. Section 18.
12. **Fifteen details of the integration are new design that no PoC validated** (Appendix A). They are the places where the production code will deviate from the reconstructed runner on purpose.

### Answers A to J

| #   | Question                                               | Answer                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | Is the I1→I7 order correct?                            | **No, not as separate shippable steps.** I3 breaks DotAgent (I4) and headless turns (I6) at the moment it activates. Smallest fix: **C1 I1, C2 I2, C3 I4a, C4 I3a (dormant), C5 I6a (dormant), C6 I3b activation (carries I4b and the I6 wiring), C7 I7a, C8 I5, C9 I7b.**                                                                                                        |
| B   | Should OWNER_TOKEN be required for shipping?           | **Yes**, on every `HOST` including loopback, at least 24 characters, no opt-out, enforced in a testable startup function. `sessionStorage` is **not** a ship blocker under the conditions in 6.5; it stays an open, documented risk.                                                                                                                                              |
| C   | I3: full rebuild first, or R32 immediately?            | **Full rebuild first.** The checkpoint columns and incremental policy are separable (additive migration in C8). I3 ships the minimal P2a-validated cache and a reader seam with an authoritative fallback.                                                                                                                                                                        |
| D   | In-process behaviour after an R32 cache-write failure? | **Never fail the run. OpenDots readers derive from the authoritative log while the cache is stale; one bounded single-flight repair attempt; the next finalization catches up; only the SDK's synchronous messages endpoint fails closed** (OpenDots does not call it). A "reload to repair" policy is rejected: a reload repairs nothing.                                        |
| E   | Does production need `maxIterations` changed?          | **No.** Leave the expression untouched in C3 and C6. Collapse it to the constant 5 at C9b, when the learning columns stop driving behaviour.                                                                                                                                                                                                                                      |
| F   | Which of R36/R37/R38 blocks I6?                        | **None blocks the I6 adapter (C5).** R36 needs one owner decision before the C6 wiring (recommended: fail loudly, no retry). R37 is a parity gap with a small fix (advisory 409), not a blocker. R38 is deferred; keep the code on the error object.                                                                                                                              |
| G   | Which Intelligence references must go before shipping? | Everything **reachable** from an entry point or visible to the owner: runtime/Slack/learning construction and `INTELLIGENCE_*`/`SLACK_*` reads (C6), the CSP origin and the learning/Slack UI (C7). Dead code (C9) must go before any note claims "removed"; the **shipping gate is reachability plus egress tests**, not a file count. Classes B and C are retained or reworded. |
| H   | Another live ChatGPT Plan test?                        | **No.** Provider-facing code is untouched; P2b-0 evidence is inherited. A trigger list in 17.3 says when that stops being true.                                                                                                                                                                                                                                                   |
| I   | When does rollback stop being a simple code revert?    | **At C6 (I3b, activation)**: conversations created afterwards exist only in local SQLite and are invisible to the code before it. C8 adds columns but stays revertible. C1-C5 and C7-C9 are plain reverts.                                                                                                                                                                        |
| J   | Smallest first implementation phase after this review? | **C1: the telemetry first-import guard.** It is independent, touches no data, and must exist before C4 adds a new CopilotKit import.                                                                                                                                                                                                                                              |

---

## 2. Current checkpoint and provenance

**Authority hierarchy.** (1) Production source at main `82330a6`, read from git objects. (2) The installed SDK (`@copilotkit/runtime` 1.75.0 and neighbours) for behaviour the application does not own. (3) The committed `docs/LOCAL_FIRST_*` documents. (4) The persistent reconstructed PoC (`tests/p2a`, `tests/p3`, `tests/p5`).

| Package                   | Installed |
| ------------------------- | --------- |
| @copilotkit/runtime       | 1.75.0    |
| @copilotkit/core          | 1.75.0    |
| @copilotkit/react-core    | 1.75.0    |
| @copilotkit/channels      | 0.11.0    |
| @copilotkit/channels-core | 0.11.0    |
| @copilotkit/shared        | 1.75.0    |
| @copilotkit/web-inspector | 1.75.0    |
| @tanstack/ai              | 0.63.0    |
| @ag-ui/client             | 0.0.59    |
| hono                      | 4.13.11   |
| typescript                | 6.0.3     |
| vitest                    | 4.1.11    |
| playwright                | 1.63.0    |

- **Production source tree:** `src/` is `eec8cbc9…` at 82330a6; 87 tracked `.ts/.tsx` files; `src/server` is about 7.0k lines; 56 test files. The reconstruction's `src/`, `package.json` and lock are **identical** to main's: the only changes between `0686e0b` and `82330a6` are three documents.
- **Document drift (not a problem for the PoC code):** main's committed `LOCAL_FIRST_P2A_DESIGN.md` (297,360 B) and `LOCAL_FIRST_P5_SECURITY_EGRESS_ACCEPTANCE.md` (36,823 B) are newer than the scratch copies (281,307 B and 34,477 B). Main's committed versions were used.
- **What the PoC is.** A **reconstruction**, not the deleted original scratch. Golden wording that must be kept: _regenerated, counts matched, rebuilt runner matched except the accepted G3 divergence, original hashes unavailable._ Three rebuild interpretations remain interpretations, not recovered source: (a) the **stale-tool interlock** reading, (b) **cache hash-before-parse**, (c) the **residual recovery classification** choices. P5 depends materially on (a); section 7.6 turns it into an explicit contract so production does not depend on an interpretation.
- **What this review did.** Static reading of production source and of the installed SDK; a TypeScript-emit import-graph analysis; a read-only comparison of the four prunable worktrees' index files against their HEAD trees; verification of the snapshot manifest. **It did not run the test suite** (vitest writes its cache under main's `node_modules`, and this phase leaves main untouched). The production baseline quoted below, **644/645 passed with one pre-existing skip**, is P5's report on the identical-`src` reconstruction.
- **Not verified, stated so it is not mistaken for verified.** Intelligence-mode behaviour (lock semantics, whether `IntelligenceAgent` loads history) is read from SDK source and from P3's findings, never observed live. Voice/WebRTC and the dev-server inspector were never run in a browser. Full-rebuild cache timings beyond 100 turns are extrapolated, not measured. That SQLite gives `-wal`/`-shm` the database file's mode is SQLite behaviour that the L5 file-mode gate must prove, not assume.
- **Host.** R33 (V8 crashes on the measurement host) and R31 (one unexplained non-reproducible failure) remain open; section 18. During this review one `node` process (the Prettier run that formats this document) died with `Bus error: 10`; the document on disk was untouched by the crash and the run was repeated. Recorded, not hidden.

---

## 3. Dependency graph

```text
C1 telemetry guard ──────────────────────────────┐ (must exist before C4's new CopilotKit import)
C2 owner boundary (independent) ─────────────────┤
C3 DotAgent: provider-only guard ────────────────┤
C4 durable runner + log (dormant) ───────────────┼──►  C6 ACTIVATION ──┬──► C7 CSP / UI / config contract
C5 local headless adapter (dormant) ─────────────┘   (the one switch)  │
                                                                         ├──► C8 incremental cache (additive migration)
                                                                         └──► C9 dead-code and dependency removal (needs C7)
```

| Id  | Commit   | Needs                           | Reason                                                                                                                                                                                                               | Source                                                 |
| --- | -------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| D1  | C6 (I3b) | C3 (I4a)                        | Without intelligenceKey, DotAgent.run throws before any model call (dot-agent.ts:84). Chat would break at activation.                                                                                                | `src/server/dot-agent.ts:84`                           |
| D2  | C6 (I3b) | C5 (I6a)                        | runThreadTurn requires /info mode "intelligence" (headless.ts:18); the SSE runtime reports mode "sse" (get-runtime-info.mjs:91). Scheduled tasks, voice compute and the voice receipt would all fail.                | `src/server/headless.ts:18`, `src/server/index.ts:112` |
| D3  | C6 (I3b) | C4 (I3a)                        | The runtime needs the runner that the activation wires in.                                                                                                                                                           | `src/server/platform.ts:63`                            |
| D4  | C6 (I3b) | C1 (I1)                         | C4 adds a new value import of @copilotkit/runtime/v2; the first-import contract must already exist so the new module is covered from its first commit.                                                               | `src/server/platform.ts:9`                             |
| D5  | C7 (I7a) | C6 (I3b)                        | Until activation the legacy browser client opens the Intelligence WebSocket; the origin must stay in connect-src until then (index.ts:116-118,137).                                                                  | `src/server/index.ts:117`, `src/server/index.ts:137`   |
| D6  | C8 (I5)  | C4 (I3a) and C6 (I3b)           | I5 changes the cache production policy inside the runner module and migrates a table that only exists after activation.                                                                                              | -                                                      |
| D7  | C9 (I7b) | C6 + C7 + the reachability gate | Deletion is safe only when no entry point reaches the class-A code.                                                                                                                                                  | -                                                      |
| D8  | C2 (I2)  | nothing                         | The owner boundary is enforced in app.ts (/api/* middleware) and index.ts, which do not depend on the runtime. Its "durable writes = 0" assertions are re-run at C6, when durable writes become local and countable. | `src/server/app.ts:59`, `src/server/index.ts:21`       |

---

## 4. Proposed phase order

| #   | Commit | Phase            | Title                                                                            | Origin in the proposal                | Kind                                                | Why here                                                                                                                                                                                                                                 |
| --- | ------ | ---------------- | -------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | C1     | I1               | Telemetry first-import guard                                                     | I1 (unchanged position)               | active, no data                                     | Independent and zero-data. Must precede every commit that adds a CopilotKit value import (C4 does), so the contract test exists before the new import does.                                                                              |
| 2   | C2     | I2               | Owner authorization boundary                                                     | I2 (unchanged position)               | active, config change                               | Security boundary, independent of the runtime. Kept separate from every storage/runtime commit so it is reviewable alone.                                                                                                                |
| 3   | C3     | I4a              | DotAgent requires only a configured model provider                               | I4 part A, MOVED before I3            | preserving                                          | After activation a keyless DotAgent would emit RUN_ERROR on every run (dot-agent.ts:84). Landing the guard change first, while the legacy path still runs, makes the activation commit smaller and this change independently revertible. |
| 4   | C4     | I3a              | Durable local AgentRunner and conversation log (not wired)                       | I3 part 1, SPLIT from activation      | dormant                                             | The largest new code (the runner) lands reviewed and tested but called by nothing, and creates no table in any deployed database.                                                                                                        |
| 5   | C5     | I6a              | Local headless turn adapter (not wired)                                          | I6 part 1, MOVED before I3 activation | dormant                                             | headless.ts:18 requires /info mode "intelligence"; the SSE runtime reports "sse". Without this adapter, activation would break scheduled tasks, voice compute and voice receipts.                                                        |
| 6   | C6     | I3b (+I4b, +I6b) | Activation: serve conversations from the local durable runner                    | I3 part 2 + I4 part B + I6 wiring     | activation                                          | The one behaviour switch. It replaces (does not branch on) the Intelligence construction in Platform; there is no transitional runtime flag, so activation is never ambiguous.                                                           |
| 7   | C7     | I7a              | Confine browser connections; hide unsupported controls; config and docs contract | I7 part 1                             | active, no data                                     | Only after activation is the Intelligence WebSocket origin dead in CSP (the legacy browser client needed it before).                                                                                                                     |
| 8   | C8     | I5               | Incremental conversation cache with verified checkpoints                         | I5 (after activation, as proposed)    | active, additive migration                          | Pure optimisation of an already-correct cache. Kept after activation so the first schema that reaches user data is the minimal, P2a-validated one.                                                                                       |
| 9   | C9     | I7b              | Remove dead Intelligence, managed-Slack and learned-skills code                  | I7 part 2                             | cleanup (dependency change needs separate approval) | Mechanical deletion after the reachability gate has proved the code is unreachable. Dependency removal is a distinct, separately approved step (C9b).                                                                                    |

**The smallest change to your sequence.** Your seven phases survive. I4 part A moves ahead of I3 (it is behaviour-preserving while the legacy path still runs). I6's adapter moves ahead of I3's activation (it is dormant until C6 wires it). I3 splits into the runner module (dormant) and the activation. CSP stays after activation (D5) and I5 stays after activation (D6), as you proposed.

**Why no transitional runtime flag.** A flag such as `OPENDOTS_RUNTIME=local|intelligence` would make activation configurable and rollback "flip it back". It would also keep two runtimes alive in `Platform`, `DotAgent` and the headless path for as long as the flag exists, and every ambiguity about which one is active would have to be tested. This design uses **dormant modules plus one replacing commit** instead: before C6 behaviour does not change; at C6 the Intelligence construction is replaced, not branched on.

**Commit invariant.** After every commit `check-format`, `lint`, `typecheck`, `test` and `build` are green, behaviour changes only as the table says, and the commit can be reverted alone (C6 with the data caveat in section 15).

---

## 5. I1: telemetry first-import guard (C1)

### 5.1 Facts (verified)

- The runtime's telemetry singleton `new TelemetryClient()` evaluates `isTelemetryDisabled()` **when the module is loaded** (`telemetry-client.mjs:20,106`); only the exact values `"true"` or `"1"` count (`:10`). The sink URL is a module constant read at load (`lambda-client.mjs:2`). The first event is sent when a runtime is constructed, and a "telemetry enabled" line is logged then (`runtime.mjs:35`). `ChannelTelemetry` reads the setting at construction (and also disables itself under test environments), and **writes an install id file under `node_modules/.cache/copilotkit/telemetry-id`** when it runs (`install-id.js:36`).
- P5 measured: guard imported **after** the SDK, 4 events leak; guard imported **first**, 0; caller forgot the variable, 1 event at boot and 4 after the first run. An unrecognised value such as `yes` disables nothing.
- The browser inspector is mounted only when `isBrowser && isDevelopment && enableInspector !== false` (`inspector-visibility.mjs:7`). OpenDots never passes `enableInspector` (`App.tsx:929`), so **`npm run dev` mounts it**, and it posts to `https://telemetry.copilotkit.ai/ingest` unless the browser's local storage opts out. The production bundle replaces `process.env.NODE_ENV`, so none mounts (P5: 0 requests). The dev-server path itself was **never run**.

### 5.2 Inventory of every entry point that can import CopilotKit

| Entry point                      | Kind                                                                                      | Reaches CopilotKit? | First CopilotKit module evaluated | Modules evaluated before it | Guard evaluated first if module-level guards are added |
| -------------------------------- | ----------------------------------------------------------------------------------------- | ------------------- | --------------------------------- | --------------------------- | ------------------------------------------------------ |
| `src/server/index.ts`            | node-esm: npm start (dist/server/server/index.js) and npm run dev (tsx --watch)           | yes                 | `@copilotkit/channels`            | `src/server/shutdown.ts`    | true                                                   |
| `src/server/chatgpt-plan-cli.ts` | node-esm: npm run chatgpt-plan (tsx)                                                      | no                  | -                                 | -                           | n/a (does not reach CopilotKit)                        |
| `src/browser/index.ts`           | node-esm: npm run browser / browser:start, separate container (Dockerfile target browser) | no                  | -                                 | -                           | n/a (does not reach CopilotKit)                        |

Modules that value-import a CopilotKit package (type-only importers `learning.ts` and `tanstack-tools.ts` are elided by TypeScript and load nothing):

| Module                         | CopilotKit packages value-imported |
| ------------------------------ | ---------------------------------- |
| `src/client/App.tsx`           | @copilotkit/react-core/v2          |
| `src/client/Chat.tsx`          | @copilotkit/react-core/v2          |
| `src/client/ThreadList.tsx`    | @copilotkit/react-core/v2          |
| `src/server/computer-tools.ts` | @copilotkit/runtime/v2             |
| `src/server/dot-agent.ts`      | @copilotkit/runtime/v2             |
| `src/server/headless.ts`       | @copilotkit/core                   |
| `src/server/page-tools.ts`     | @copilotkit/runtime/v2             |
| `src/server/platform.ts`       | @copilotkit/runtime/v2             |
| `src/server/slack-channel.ts`  | @copilotkit/channels               |

- **Server entry (`index.ts`).** Its **second** import, `./slack-channel.js`, is the first CopilotKit module evaluated (`@copilotkit/channels`); only `shutdown.ts` precedes it. `@copilotkit/runtime/v2` follows through `platform.js`.
- **`chatgpt-plan-cli.ts` and the browser service (`src/browser/index.ts`) do not reach CopilotKit today** (12 and 3 local modules). The guard is vacuous for them; the contract test still covers them so a future import cannot slip in.
- **Scheduled/background processes and voice** run inside the server process (the scheduler `Runner`, `VoiceService`); there is no separate entry point.
- **Client bundle.** Three components import `@copilotkit/react-core/v2` (`App.tsx`, `Chat.tsx`, `ThreadList.tsx`). A Node-style guard is meaningless there; the control is `enableInspector={false}`.
- **Test roots.** 15 of 56 test files reach CopilotKit through application modules and 3 import it directly (`learning-delivery`, `run-error-contract`, `slack-channel-wiring`). `vite.config.ts` has no `test` block. Today's suite constructs **no** runtime (the only `new Platform(` in tests has no key and returns early), so nothing is emitted now; from C4 the L2 tests construct `CopilotSseRuntime`, and without a setup file they would emit.

### 5.3 Answers to A to E

- **A. Earliest application-owned safe point.** The first statement the Node process evaluates that precedes any CopilotKit module. Because ES module `import` statements are hoisted, an inline `process.env.X = '1'` at the top of `index.ts` runs **after** every import; the guard must be a separate side-effect module imported first.
- **B. Is one shared side-effect module sufficient?** As code, yes (`src/server/telemetry-guard.ts`, two assignments, unconditional). As wiring, no: it only works if it is evaluated before the first CopilotKit module in the process, whatever the root.
- **C. Multiple explicit entry-point imports?** Entry-point imports alone are the fragile design P5 warned about (a new entry point or a test root forgets). **Design:** the guard is the **first import of every module that value-imports a CopilotKit package** (platform, dot-agent, computer-tools, page-tools, slack-channel, headless) **and** of `index.ts`, plus a vitest setup file for test roots. Then evaluation order is correct for any root that reaches those modules.
- **D. Contract tests.** (1) **L0 evaluation-order simulation:** from TypeScript-emitted imports (so import elision is modelled), simulate ESM evaluation from each entry and each test root and assert the guard precedes the first `@copilotkit/*` module. The generator already computes the what-if: with module-level guards `index.ts` evaluates the guard at index 0 and the first CopilotKit module at index 2. (2) **L0 first-import rule** for every importer, which is the simple discipline that makes (1) hold. (3) **L5 subprocess** against the **built** `dist` entry with `COPILOTKIT_TELEMETRY_URL` pointing at a loopback trap and the variables scrubbed: 0 hits at boot and after a run, and no "telemetry enabled" line on stdout. (4) **Negative controls that must go RED:** guard imported after the SDK (expect the 4 hits P5 saw), no guard at all, and a module that value-imports the SDK without the guard.
- **E. Could build tooling or tree shaking defeat the guard?** The server has **no bundler**: `tsc -p tsconfig.server.json` (`module: NodeNext`) emits per-file ESM, and `npm run dev` uses `tsx`. A bare side-effect import is never elided by TypeScript or esbuild, and `package.json` has no `"sideEffects"` field. The remaining risks are a **future** bundler for the server, an import-sorting lint plugin, and a package-level `sideEffects: false`; the L0 test and the **built-artifact** L5 test catch all three. The client bundle needs no guard.

### 5.4 Design

- New `src/server/telemetry-guard.ts`: sets `COPILOTKIT_TELEMETRY_DISABLED='1'` and `DO_NOT_TRACK='1'` **unconditionally** (an explicit `false` is ignored; DEC-1). `DO_NOT_TRACK` is inherited by child processes, which is accepted.
- `src/client/App.tsx`: `<CopilotKitProvider … enableInspector={false}>` plus an L0 source assertion. This does not prove the dev-server path at runtime (DEV-INSPECTOR stays deferred).
- `tests/setup-telemetry.ts` and `vite.config.ts` `test.setupFiles` (DEC-12): preventive today, required from C4.
- **Considered and rejected:** a facade module that re-exports every CopilotKit symbol with an ESLint `no-restricted-imports` rule (cleaner invariant, but it rewrites import specifiers across the server and still needs the evaluation-order test); redirecting `COPILOTKIT_TELEMETRY_URL` to an unroutable loopback sink as defence in depth (a leak would stop being visible as non-loopback egress, and the inspector's URL is hard-coded anyway).
- The guard does not depend on the user remembering any variable. It is also **not** a substitute for the contract test on every CopilotKit upgrade: the latch semantics belong to the SDK.

### 5.5 Behaviour, config, rollback

Behaviour: telemetry is never sent and the disclosure line disappears. Config: none required. DB: none. **Rollback: `git revert`, no data.** C1 must precede C4.

---

## 6. I2: owner authorization (C2)

### 6.1 Every endpoint, by what it does

All routes below sit behind the same `/api/*` middleware: body limit, `Cache-Control: no-store`, Host allowlist when no token is set (`app.ts:52`), Origin and Sec-Fetch-Site checks (`app.ts:56,58`), the bearer token when configured (`app.ts:59`), and `application/json` for non-GET (`app.ts:77`).

| Route                                                  | Kind    | Defined at                         | Note                                                                 |
| ------------------------------------------------------ | ------- | ---------------------------------- | -------------------------------------------------------------------- |
| `GET /api/state`                                       | read    | src/server/app.ts:84               | settings, tasks, memories                                            |
| `POST /api/tasks`                                      | write   | src/server/app.ts:93               | creates a scheduled task bound to a conversation                     |
| `GET /api/tasks/:id`                                   | read    | src/server/app.ts:140              |                                                                      |
| `POST /api/tasks/:id/actions`                          | write   | src/server/app.ts:144              | run/pause/cancel; run queues an execute                              |
| `PUT /api/tasks/:id/schedule`                          | write   | src/server/app.ts:156              |                                                                      |
| `PATCH /api/settings`                                  | write   | src/server/app.ts:169              | pause/permissions; aborts runs                                       |
| `POST /api/memories`                                   | write   | src/server/app.ts:192              |                                                                      |
| `PUT /api/memories/:id`                                | write   | src/server/app.ts:204              |                                                                      |
| `DELETE /api/memories/:id`                             | write   | src/server/app.ts:218              |                                                                      |
| `GET /api/workspace`                                   | read    | src/server/workspace-routes.ts:25  | spaces, dots, conversations, setup, calls                            |
| `POST /api/spaces`                                     | write   | src/server/workspace-routes.ts:34  |                                                                      |
| `POST /api/dots`                                       | write   | src/server/workspace-routes.ts:52  | tool permissions                                                     |
| `PUT /api/dots/:id`                                    | write   | src/server/workspace-routes.ts:94  | tool permissions                                                     |
| `POST /api/conversations`                              | write   | src/server/workspace-routes.ts:120 | creates a thread binding (Intelligence createThread today)           |
| `GET /api/conversations/:id/capture`                   | read    | src/server/workspace-routes.ts:140 |                                                                      |
| `POST /api/voice/calls`                                | execute | src/server/workspace-routes.ts:143 | server calls OpenAI Realtime; reads thread history                   |
| `GET /api/voice/calls/:id`                             | read    | src/server/workspace-routes.ts:158 |                                                                      |
| `POST /api/voice/calls/:id/active`                     | write   | src/server/workspace-routes.ts:161 |                                                                      |
| `POST /api/voice/calls/:id/compute`                    | execute | src/server/workspace-routes.ts:164 | headless model turn with tools                                       |
| `POST /api/voice/calls/:id/end`                        | execute | src/server/workspace-routes.ts:186 | writes receipt, headless receipt turn                                |
| `ALL /api/copilotkit/*`                                | mixed   | src/server/workspace-routes.ts:202 | runtime sub-routes; see runtime table                                |
| `GET /api/conversations/:id/reviewed-page/:toolCallId` | read    | src/server/page-routes.ts:8        |                                                                      |
| `POST /api/conversations/:id/reviewed-page`            | write   | src/server/page-routes.ts:24       | creates a page from a human-approved draft                           |
| `GET /api/conversations/:id/page-context`              | read    | src/server/page-routes.ts:47       |                                                                      |
| `GET /api/spaces/:spaceId/pages`                       | read    | src/server/page-routes.ts:57       |                                                                      |
| `GET /api/spaces/:spaceId/pages/:id`                   | read    | src/server/page-routes.ts:60       |                                                                      |
| `POST /api/spaces/:spaceId/pages`                      | write   | src/server/page-routes.ts:65       |                                                                      |
| `PATCH /api/spaces/:spaceId/pages/:id`                 | write   | src/server/page-routes.ts:80       |                                                                      |
| `POST /api/spaces/:spaceId/pages/:id/conversation`     | write   | src/server/page-routes.ts:95       | creates/binds the page thread (Intelligence getOrCreateThread today) |
| `POST /api/conversations/:id/page`                     | write   | src/server/page-routes.ts:109      | reads thread history, creates a page                                 |
| `GET /api/model`                                       | read    | src/server/model-routes.ts:27      | status only, never a key                                             |
| `PUT /api/model/provider`                              | write   | src/server/model-routes.ts:28      |                                                                      |
| `DELETE /api/model/selection`                          | write   | src/server/model-routes.ts:36      |                                                                      |
| `POST /api/model/chatgpt/sign-in`                      | execute | src/server/model-routes.ts:37      | starts the ChatGPT sign-in flow                                      |
| `POST /api/model/chatgpt/sign-in/cancel`               | write   | src/server/model-routes.ts:40      |                                                                      |
| `POST /api/model/chatgpt/sign-out`                     | write   | src/server/model-routes.ts:43      | removes the stored session                                           |
| `GET /api/model/chatgpt/models`                        | read    | src/server/model-routes.ts:46      |                                                                      |
| `POST /api/model/chatgpt/models/refresh`               | execute | src/server/model-routes.ts:47      | network call to the provider                                         |
| `PUT /api/model/chatgpt/model`                         | write   | src/server/model-routes.ts:50      |                                                                      |
| `GET /api/dots/:id/computer`                           | read    | src/server/computer-routes.ts:18   |                                                                      |
| `PATCH /api/dots/:id/computer/permissions`             | write   | src/server/computer-routes.ts:21   |                                                                      |
| `POST /api/dots/:id/computer/start`                    | execute | src/server/computer-routes.ts:24   | container control                                                    |
| `POST /api/dots/:id/computer/stop`                     | execute | src/server/computer-routes.ts:27   | container control                                                    |
| `POST /api/dots/:id/computer/take`                     | write   | src/server/computer-routes.ts:30   | human takeover                                                       |
| `POST /api/dots/:id/computer/release`                  | write   | src/server/computer-routes.ts:33   |                                                                      |
| `POST /api/dots/:id/computer/actions`                  | execute | src/server/computer-routes.ts:36   | browser/shell inside the Dot computer                                |

The runtime sub-routes behind `ALL /api/copilotkit/*` are first filtered by `validateRuntimeScope` (a deny-by-default allowlist that also validates thread-to-Dot ownership) and then by the SDK. With a local runner (SDK 1.75.0, verified):

| Runtime route                                                                                        | Kind                | Behaviour with a local runner (SDK 1.75.0)                                           | validateRuntimeScope                                                              |
| ---------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `GET /info`                                                                                          | read                | served; reports mode "sse"                                                           | allowed                                                                           |
| `GET /threads`                                                                                       | read                | served from runner.listThreads()                                                     | allowed                                                                           |
| `POST /threads/subscribe`                                                                            | read                | HTTP 422 (needs the Intelligence runtime)                                            | allowed                                                                           |
| `POST /agent/:id/run`                                                                                | execute             | runner.run: provider + server tools + durable writes                                 | allowed (thread must be bound to that Dot)                                        |
| `POST /agent/:id/connect`                                                                            | read                | replay + live join (a POST that does not execute)                                    | allowed                                                                           |
| `POST /agent/:id/suggest`                                                                            | execute             | runs the agent WITHOUT the runner (no durable record); unused by the OpenDots client | allowed today -> deny in C2                                                       |
| `POST /agent/:id/stop/:threadId`                                                                     | write               | runner.stop: aborts the run; finalization writes closers                             | allowed                                                                           |
| `GET /threads/:id/messages`                                                                          | read                | runner.getThreadMessages (synchronous, cache-backed)                                 | allowed                                                                           |
| `GET /threads/:id/events`                                                                            | read                | runner.getThreadEvents                                                               | allowed                                                                           |
| `GET /threads/:id/state`                                                                             | read                | runner.getThreadState                                                                | allowed                                                                           |
| `POST /threads/:id/archive`                                                                          | write               | HTTP 422 (needs the Intelligence runtime)                                            | allowed                                                                           |
| `PATCH\|DELETE /threads/:id`                                                                         | write               | HTTP 422 (needs the Intelligence runtime)                                            | allowed                                                                           |
| `POST /threads/clear`                                                                                | write (destructive) | runner.clearThreads() deletes EVERY conversation                                     | denied by validateRuntimeScope (reserved name); the runner must also refuse (P-2) |
| `GET /inspector-metadata, /inspector-learning, /transcribe, /cpk-debug-events, annotate, memories/*` | n/a                 | SDK routes OpenDots never uses                                                       | denied (not in the allowlist)                                                     |

Three findings come out of this table:

1. **`POST /agent/:id/suggest` is allowed by the scope today, is unused by the client, and executes the agent without the runner**: no durable record, the SDK says so itself (`handle-suggest.mjs:15`). It is an execute path outside the durable boundary. **C2 denies it.**
2. **`POST /threads/clear` calls `runner.clearThreads()` and would delete every conversation** (`threads.mjs:84`). Only `validateRuntimeScope`'s reserved-name list (`runtime-scope.ts:47`) stops it. The production runner must also refuse (P-2).
3. The SDK router matches **suffixes** (`fetch-router.mjs:47`); `validateRuntimeScope` already matches the whole path for that reason. Keep it that way.

### 6.2 Token acquisition, storage, callers

- **Acquisition.** The first `/api/state` or `/api/workspace` answering 401 flips `needsAuth` (`App.tsx:124`); the unlock form (`App.tsx:241`) calls `setToken`, retries, and the `CopilotKitProvider` receives `headers={authHeaders()}` (`App.tsx:929`).
- **Storage.** `sessionStorage['opendots-token']` (`api.ts:1`): per tab, survives a reload in that tab, gone when the tab closes, readable by same-origin script. It is never rendered into the DOM (P5 canary, 0 hits). There is no `dangerouslySetInnerHTML`, `innerHTML`, `eval` or `new Function` in `src/client` (grep, 0 hits).
- **Headless/server callers.** Today `Platform.turn` self-calls the runtime over HTTP with `Authorization: Bearer <ownerToken>` (`platform.ts:186`). After C6 the call is in-process and involves no token.
- **Startup with `OWNER_TOKEN` absent.** Loopback starts with the boundary reduced to Host/Origin/Sec-Fetch-Site; only a non-loopback `HOST` demands a token (`index.ts:16-22`). Docker is already stricter: `compose.yml:9` requires it and `Dockerfile:9` binds `0.0.0.0`.

### 6.3 Impact analysis of "required on every binding"

| Scenario                       | Effect                                                                                                                                                                                     | Verdict                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| First run / dev                | A fresh checkout without a token refuses to start with an actionable message (including how to generate one). One-time `.env` edit. `npm run dev` then shows the unlock form once per tab. | Accept                    |
| Browser reload                 | The token survives a reload in the same tab; the provider reads it at mount.                                                                                                               | Verify at L4              |
| New tab or window              | Prompts again (per-tab storage).                                                                                                                                                           | Accept for v1, document   |
| Scheduled / headless           | In-process after C6; before C6 it already sends the token.                                                                                                                                 | No impact                 |
| Voice calls                    | Browser calls go through `api()`/`authHeaders()`, including the unload `fetch(..., keepalive)`; Realtime media does not use the token.                                                     | No impact; L2/L4          |
| CLI / local automation         | A script that called loopback without a token breaks and must send `Authorization: Bearer`.                                                                                                | Document; accept          |
| Test harnesses                 | The enforcement lives in the startup function, **not** in `createApp`, so the 56 existing test files and the library contract are unchanged; the L4/L5 harness passes a token.             | No churn                  |
| Desktop / local deployment     | There is no packaged desktop app; local use is `npm run build && npm start` with `.env`, i.e. the same as dev.                                                                             | Accept                    |
| Docker                         | Already required.                                                                                                                                                                          | No change                 |
| Other local users or processes | The reason for the change: Host/Origin checks stop browsers and DNS rebinding, **not** another process on the machine. With local-first the API fronts the owner's full plaintext history. | Strongest argument for it |

### 6.4 Design

- New `src/server/startup-config.ts`: pure `validateStartupConfig(env)` returning `{ config, warnings }` or throwing: token required and at least 24 characters on every `HOST`; reject `OWNER_TOKEN === BROWSER_SECRET` (the docs already say they must differ); the existing `MODEL_PROVIDER` and `CHATGPT_CREDENTIAL_STORE` checks move here unchanged. **No opt-out variable** (DEC-2): an opt-out that exists is an opt-out that ships. Auto-generating and persisting a token (Jupyter style) is a redesign and is deferred.
- `runtime-scope.ts`: remove `suggest` from the agent allowlist.
- `.env.example`, `docs/SETUP.md`: token wording; no code in the client changes except optional first-run copy.

### 6.5 Is `sessionStorage` a ship blocker for v1? No, under four conditions

1. `script-src 'self'` stays and the L5 CSP probes keep proving it (C7).
2. No HTML-injection sinks in `src/client` (L0 grep stays green; Markdown goes through `react-markdown`, the editor through TipTap).
3. The token never appears in a URL, log line, DOM text or error message (L5 canary).
4. It is documented as an open risk.

Why: an XSS that could read `sessionStorage` could equally call the API with the in-memory token, so moving it to `localStorage` would be worse and an `HttpOnly` cookie would reduce persistence but not same-page abuse. The real upgrade is a server-issued `HttpOnly; SameSite=Strict` session, which is an auth redesign and is **deferred** (OWNER-STORE).

### 6.6 Acceptance and rollback

L1 table-driven `validateStartupConfig`; L2 the **13-case owner matrix** from P5 against the production app (authorized allowed; missing token for run, connect, workspace API and runtime info: 401; wrong token including a same-length one: 401; wrong scope: 403 for unknown thread, cross-Dot route, unknown agent, body/route mismatch, stop on another Dot's thread, an unenabled route, another thread's events; every unauthorized case: provider 0, tool 0, durable/remote writes 0, the rejected credential never echoed); L4 unlock, wrong token, reload, new tab; L5 token canary. **Before C6 "durable writes" means Intelligence calls and workspace rows; the same matrix is re-run at C6 against local rows.** Rollback: `git revert`; the token becomes optional again; existing tokens keep working.

---

## 7. I3: local CopilotSseRuntime and durable runner (C4 dormant, C6 activation)

### 7.1 What the production code constructs today and what replaces it

| Production construction point                                                         | Where (main@82330a6)         | Change                                                                               |
| ------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| Store (tasks/settings/memories, own DatabaseSync)                                     | `src/server/index.ts:24`     | unchanged                                                                            |
| WorkspaceStore (own DatabaseSync; sub-stores share it)                                | `src/server/index.ts:25`     | C4 adds openConversationLog(); C6 calls it                                           |
| ModelService (provider selection)                                                     | `src/server/index.ts:40`     | unchanged                                                                            |
| PlatformConfig incl. intelligence* and slack*                                         | `src/server/index.ts:67`     | C6: stop reading `INTELLIGENCE_*`/`SLACK_*`; C9: delete the fields                   |
| Platform                                                                              | `src/server/index.ts:93`     | C6: constructor rewritten                                                            |
| Scheduler Runner (task claim loop)                                                    | `src/server/index.ts:102`    | unchanged; C6 changes the callback text only                                         |
| HTTP server listen                                                                    | `src/server/index.ts:144`    | C6: await runner.ready() BEFORE listen                                               |
| Shutdown wiring                                                                       | `src/server/index.ts:159`    | C4/C6: add runner.stopAll()                                                          |
| PageService (before the early return)                                                 | `src/server/platform.ts:35`  | C6: local port                                                                       |
| Early return without a key (no runtime, handle() answers 503)                         | `src/server/platform.ts:39`  | C6: removed (always local)                                                           |
| CopilotKitIntelligence client                                                         | `src/server/platform.ts:40`  | C6: removed                                                                          |
| CopilotRuntime({ intelligence, identifyUser, agents, channels, generateThreadNames }) | `src/server/platform.ts:63`  | C6: CopilotSseRuntime({ agents, runner })                                            |
| createCopilotHonoHandler                                                              | `src/server/platform.ts:81`  | unchanged                                                                            |
| DotAgent per Dot (runtime agents factory)                                             | `src/server/platform.ts:75`  | C6: same factory, shared with headless turns                                         |
| DotAgent for managed Slack                                                            | `src/server/platform.ts:59`  | C6: removed; C9: DotAgent channel mode deleted                                       |
| createConversation -> Intelligence createThread                                       | `src/server/platform.ts:121` | C6: local bindThread only                                                            |
| history() -> Intelligence getThreadMessages                                           | `src/server/platform.ts:137` | C6: messagesFor()                                                                    |
| handle(): 503 without a key                                                           | `src/server/platform.ts:154` | C6: removed                                                                          |
| handle(): validateRuntimeScope then handler.fetch                                     | `src/server/platform.ts:164` | unchanged (+ advisory 409)                                                           |
| turn() -> runThreadTurn (/info + IntelligenceAgent + WebSocket)                       | `src/server/platform.ts:186` | C6: runLocalTurn (C5 module)                                                         |
| Thread/run state, stop, connect/replay                                                | `src/server/dot-agent.ts:60` | today owned by Intelligence; C4 runner owns them (DotAgent keeps its own 90 s abort) |

### 7.2 `CopilotRuntime` or `CopilotSseRuntime`

`CopilotRuntime` is `CopilotRuntimeShim`; its constructor does `hasIntelligenceOptions(options) ? new CopilotIntelligenceRuntime(options) : new CopilotSseRuntime(options)` (`runtime.mjs:139`) and the SDK comments that new code should prefer the explicit classes (`:131`). **Use `new CopilotSseRuntime({ agents, runner })`.** Reasons: it cannot become an Intelligence runtime by accident; it already rejects `channels` and learning options (`runtime.mjs:64-65`); the PoC validated it. `CopilotIntelligenceRuntime` in turn refuses a `runner` (`:80`), so the two cannot be mixed.

### 7.3 Files

- **C4 (dormant):** new `src/server/conversation-log.ts`, `src/server/durable-runner.ts`; edit `src/server/workspace.ts` (an explicit `openConversationLog()`, resolving R16: the PoC reached the connection through the private field `workspace.ts:10`; production follows the existing sub-store pattern of `Pages` and `ComputerStore`, `workspace.ts:53`, but **lazily**, so C4 creates no table anywhere).
- **C6:** `platform.ts`, `platform-config.ts`, `page-service.ts`, `dot-agent.ts`, `index.ts`, `workspace.ts`, new `legacy-config.ts`.
- Test-only seams present in the PoC runner (`beforePersist`, `faults`, `onFinalize`, `beforeCacheWrite`, the `notes` ledger, the `interlock` switch) are **not** carried into the production class; fault injection uses a subclass in the test tree.

### 7.4 Schema and migration (design, not applied, not an approved migration)

Existing schema (verified, four modules own it):

| Table                | Defined in                      | Columns                                                                                        |
| -------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------- |
| settings             | src/server/store.ts:30          | id, value                                                                                      |
| tasks                | src/server/store.ts:31          | id, prompt, status, intervalSeconds, nextRunAt, createdAt, updatedAt, error, lease, leaseUntil |
| runs                 | src/server/store.ts:32          | id, taskId, status, startedAt, finishedAt, result, error                                       |
| events               | src/server/store.ts:33          | id, taskId, runId, text, createdAt                                                             |
| memories             | src/server/store.ts:34          | id, text, createdAt                                                                            |
| model_selection      | src/server/store.ts:35          | id, value                                                                                      |
| spaces               | src/server/workspace.ts:20      | id, name, description, createdAt                                                               |
| dots                 | src/server/workspace.ts:21      | id, spaceId, name, instructions, researchAllowed, memoryAllowed, createdAt                     |
| thread_bindings      | src/server/workspace.ts:22      | id, dotId, ownerId, title, createdAt                                                           |
| task_threads         | src/server/workspace.ts:23      | taskId, threadId                                                                               |
| calls                | src/server/workspace.ts:24      | id, threadId, startedAt, endedAt, status, transcript, error                                    |
| captures             | src/server/workspace.ts:25      | threadId, value                                                                                |
| dot_spaces           | src/server/workspace.ts:48      | dotId, spaceId                                                                                 |
| page_reviews         | src/server/pages.ts:44          | threadId, toolCallId, pageId, spaceId                                                          |
| pages                | src/server/pages.ts:46          | id, spaceId, parentId, title, content, revision, createdAt, updatedAt, sourceThreadId          |
| page_threads         | src/server/pages.ts:47          | pageId, dotId, threadId, ready, leaseUntil                                                     |
| computer_permissions | src/server/computer-store.ts:9  | dotId, value                                                                                   |
| computer_audit       | src/server/computer-store.ts:10 | id, dotId, action, actor, outcome, createdAt                                                   |

Additive columns added later by guarded ALTER: calls.anchorMessageId, dots.learningContainerId, dots.skillDeliveryEnabled, thread_bindings.learningContainerId, page_threads.leaseUntil.

Production has **no migration framework** (no `user_version`, no version table). The idiom is idempotent `CREATE TABLE IF NOT EXISTS` plus `PRAGMA table_info`-guarded `ALTER TABLE ADD COLUMN`. This design uses exactly that and adds no mechanism (DEC-6).

```sql
CREATE TABLE IF NOT EXISTS conversation_runs(threadId TEXT NOT NULL, runId TEXT NOT NULL, seq INTEGER NOT NULL,
  agentId TEXT NOT NULL, parentRunId TEXT, status TEXT NOT NULL, startedAt INTEGER NOT NULL, finishedAt INTEGER,
  PRIMARY KEY(threadId, runId), UNIQUE(threadId, seq));
CREATE TABLE IF NOT EXISTS conversation_events(id INTEGER PRIMARY KEY AUTOINCREMENT, threadId TEXT NOT NULL,
  runId TEXT NOT NULL, seq INTEGER NOT NULL, eventType TEXT NOT NULL, messageId TEXT, eventJson TEXT NOT NULL,
  UNIQUE(threadId, runId, seq));
CREATE INDEX IF NOT EXISTS conversation_events_thread ON conversation_events(threadId, id);
CREATE TABLE IF NOT EXISTS conversation_messages(threadId TEXT PRIMARY KEY, messagesJson TEXT NOT NULL,
  lastEventId INTEGER NOT NULL);
```

- **Authority.** `conversation_events` is append-only and authoritative; `conversation_runs.status` is a cache of the last terminal event; `conversation_messages` is a rebuildable cache and is never authoritative.
- **Differences from the PoC DDL (P-6):** camelCase columns to match the production convention (snake_case tables, camelCase columns); index on `(threadId, id)` so `MAX(id)` per thread is a seek (the PoC indexed `(thread_id, event_type)`); no checkpoint columns until C8.
- **Not declared:** a `FOREIGN KEY` to `thread_bindings`. `PRAGMA foreign_keys` is off in production, so it would be inert. Ownership is enforced by `validateRuntimeScope`, `WorkspaceStore.requireThread` and a runner-level bound-thread check (P-1).
- **Migration required at C6:** yes, additive and idempotent (3 tables). **At C4: none.**
- **Name clash:** `Store` already has an `events` table (task events); the new names are prefixed.

### 7.5 Fresh start, existing databases, old conversations

- **Fresh start.** A new database gets the existing tables and, when the log is opened, these three. A new conversation has no run rows until its first run; `connect` on a never-run thread returns an empty completed stream.
- **Existing local SQLite.** No existing table is altered. `thread_bindings` rows written by the Intelligence path remain, so those threads **still list** (the list comes from `thread_bindings`, not from the runner) and **open empty**. Call receipts keep rendering (a receipt whose anchor message is absent is shown, `ChatTranscript.tsx:49`). Page conversations marked `ready` reopen as empty local threads.
- **Old Intelligence-hosted history.** It stays in the Intelligence project, **is not imported, and no export tool is promised.** Archive-only. DEC-8 asks whether to label those threads (that needs a nullable `origin` column) or leave them visible and document it; recommended: document first.
- **Restart semantics.** `await runner.ready()` runs before `serve()` listens: recover dead runs (server tool: explicit "outcome unknown" result then `RUN_ERROR`; pending client tool: `RUN_FINISHED` only; open text, incomplete tool arguments and a bare start: the stock finalizer's closers; status `interrupted`), then check each thread's cache. A reader process writes nothing (P2a-1, P2b-0: repair write 0, DB hash unchanged).
- **Pre-activation backup (DEC-7, P-10).** On the first boot of C6 against an **existing** database that has no `conversation_runs` table, run `VACUUM INTO '<db>.pre-local-first-<UTC>.bak'`, then `chmod 0600`; if it cannot be written, **refuse to activate** (the activation is a one-way door; no backup, no activation). Never auto-deleted. This is what makes the C6 rollback real.
- **File modes (P-11).** Today no code sets a mode on the database (`DatabaseSync(path)` and `mkdirSync` with the default umask; `private-fs.ts:16` is for credential-adjacent state only). Local-first makes that file hold whole conversations and tool outputs, so: create it `0600` (and a directory the app creates `0700`), tighten an existing file owned by the user with a logged `chmod 0600`, and **prove with a `stat` gate** that `-wal` and `-shm` inherit it.

### 7.6 Runner contract

- **Surface.** `AgentRunner` (`run`, `connect`, `isRunning`, `stop`) plus the semi-public `ɵsupportsLocalThreadEndpoints` (`listThreads`, `getThreadMessages`, `getThreadEvents`, `getThreadState`, `clearThreads`). **R10:** the marker is unversioned and the ranges are caret `^1.75.0` (`package.json:33`); C4 pins the contract with an L0 test of the installed SDK and DEC-9 asks for an exact pin.
- **Write policy W1.** Every event in its own `BEGIN IMMEDIATE` transaction, **persist then publish**, never across an `await`; `RUN_STARTED` with its sanitised input is committed **before** the agent is started (the user's message lives only there). p50 commit about 0.42-0.45 ms; 1,500 transactions per 100 turns; `synchronous=FULL` default, power-loss durability not demonstrated.
- **Single writer per thread.** One active run per thread; the `active` check and `set` are one synchronous stretch. A same-thread loser executes **no** provider, **no** tool and writes **no** durable state (P3: 20 attempts, exactly one winner each). Rejection is a synchronous `RunRejectedError` (`DUPLICATE_RUN_ID`, `THREAD_ALREADY_RUNNING`, `STALE_TOOL_HISTORY`); over HTTP the SDK turns it into a 200 with an empty stream (`sse/run.mjs:18`). Exclusion is **process-local** (R17: document single process per database).
- **Stop.** `POST agent/:id/stop/:threadId` → `runner.stop` → `agent.abortRun()` → finalization appends `TEXT_MESSAGE_END` and `RUN_FINISHED` (status `stopped`), partial text kept, `RUN_ERROR` 0. `DotAgent` also aborts itself after 90 s (`dot-agent.ts:60`); **that path was never characterised against the durable finalizer** and C4 must add a test rather than assume. `stopAll()` on graceful shutdown (P-4) stops and finalizes active runs inside the existing 8 s deadline so a deploy does not leave `interrupted` runs.
- **Connect/replay.** All finished runs compacted, then the active run only from the live subject (never filtered by `messageId`: the reference's hazard); a completed `runId` is rejected rather than re-run.
- **Interlock (R20/R21, P-7).** The framework re-runs a tool call that has no result in the history it is given (P2a-4: a real double side effect). The contract this design writes down, because the original source is lost and P5 leans on an interpretation: **refuse (fail closed, no provider, no tool, no write) an input that omits a tool result the log holds** (a stale tab must reload); **accept a prompt-only input** (every headless turn) on a thread that has tool history. The literal alternative, "refuse any input missing any recorded result", would refuse every scheduled turn on any thread with tool history. Both directions get an L2 test.
- **R26 (P-5).** Add the classification for a complete text message with no terminal event; test with a real `SIGKILL` between `TEXT_MESSAGE_END` and `RUN_FINISHED`.
- **Defence in depth (P-1, P-2).** The runner refuses an unbound thread or an agent that does not own the thread, and `clearThreads()` refuses.

### 7.7 Cache strategy for the first landing

**Full rebuild at every run finalization, with the minimal cache table and a reader seam.** Reasons: it is the policy every P2a, P2b-0, P3 and P5 PASS used; the checkpoint design is not an approved schema; and a rebuild is simple to verify against the oracle. Measured cost (production-like, one host, W1): **about 32 / 81 / 164 / 275-340 ms at turns 25 / 50 / 75 / 100**, 10.1-11.4 s cumulative per 100 turns, event-loop p99 about 145-151 ms, and the stream does not complete until the cache is written. Beyond 100 turns is **not measured** and the trend is super-linear. That is acceptable for the first landing and a reason C8 follows promptly; it is **not** acceptable to ship long-thread users without C8 (R35 gate).

**Reader seam (P-3).** `messagesFor(threadId)` returns the cache when its `lastEventId` equals the thread's `MAX(id)` and otherwise derives from the authoritative log. `Platform.history()` and `PageService.saveConversation()` are async and use it; the SDK's synchronous `getThreadMessages` endpoint (which the OpenDots client never calls) fails closed while stale. This is also the R34 policy; section 9.4.

### 7.8 Thread endpoints with a local runner (verified)

`GET /threads` is served from `listThreads()`. `POST /threads/subscribe`, `PATCH|DELETE /threads/:id` and `POST /threads/:id/archive` answer **HTTP 422** (they require the Intelligence runtime). The client does not use them; `ThreadList` already falls back to `thread.title` when the remote name is empty. `generateThreadNames` (`platform.ts:79`) is ignored in SSE mode. L4 asserts the thread list renders with no 4xx/5xx from `/api/copilotkit/threads/*` and no "Conversation sync unavailable" banner.

### 7.9 Page and history ports

`PageService` calls `getOrCreateThread` and `getThreadMessages` on an Intelligence-shaped port (`page-service.ts:4-15`). C6 renames it `PageConversationPort` and implements it locally: `getOrCreateThread` binds the thread (idempotent); `getThreadMessages` goes through `messagesFor`. The 30-second `bounded()` wrapper stays (harmless locally). `Platform.createConversation` becomes a local `bindThread`; `Platform.history` uses `messagesFor` and keeps its contract (user/assistant only, last 12, at most 12,000 characters).

### 7.10 Platform and index wiring at C6

`Platform` takes the runner; the constructor builds `CopilotSseRuntime({ agents, runner })` with the same per-Dot `DotAgent` factory that headless turns use; `handle()` drops the 503; `setupStatus` stops demanding `INTELLIGENCE_API_KEY`; `index.ts` opens the log, awaits `ready()`, stops reading `INTELLIGENCE_*` and `SLACK_*`, and prints **one** warning that names (never prints values of) any obsolete variable that is non-empty. `handle()` also gets the advisory 409 for a busy thread (P-9, section 10.5).

### 7.11 Acceptance and rollback

L0 SDK pins and reachability; L1; L2 differential against the SDK's own `InMemoryAgentRunner` as a live oracle for the G0-G7 shapes (no frozen golden files: their original hashes are unavailable); L3 real `SIGKILL` windows, fresh-process replay, upgrade fixture from a pre-activation database, backup restore; L4 real Chromium; L5 egress. Rollback: C4 deletes files; **C6 needs the caveat in section 15.**

---

## 8. I4: DotAgent without Intelligence (C3 and inside C6)

Three decisions, separated.

**A. Remove the OpenDots-owned requirement for `intelligenceKey` when a provider exists (C3).** `dot-agent.ts:84` is OpenDots-owned: CopilotKit's `BuiltInAgent` has no such guard and reads the key only through `learnedSkills`. C3 changes the guard to the provider alone and builds the `learnedSkills` option from one explicit predicate (key present **and** `skillDeliveryEnabled` **and** a conversation container), so the legacy path is unchanged. Two user-visible error strings that say "Intelligence and model configuration are required." (`model-provider.ts:41`, `chatgpt-plan.ts:91`; the guard itself is `dot-agent.ts:85`) become "Model configuration is required."; **two** tests pin the old wording through the regex `/configuration are required/` (`model-provider.test.ts:19`, `model-switching.test.ts:197`). The many other tests that pass `intelligenceKey: 'fixture'` only set a config value, which stays valid until C9.

**B. Do not pass `learnedSkills` in the local-first baseline (C6).** The option, the learned-skill tools (`dot-agent.ts:238`) and the system-prompt catalog use are removed together. No `SkillRegistry` or Intelligence client can then be constructed; the SDK's own env fallbacks (`INTELLIGENCE_API_URL`, `CPK_INTELLIGENCE_API_KEY`) are unreachable because the registry is never created.

**C. `maxIterations`.** Exact source behaviour (`dot-agent.ts:230`): `maxIterations(dot.skillDeliveryEnabled && conversation.learningContainerId ? 10 : 5)`.

- **Was fixed 5 necessary only for P5 bounded testing?** It was needed only to make the generated candidate independent of stored learning data. Local-first does not require it.
- **Does removing `learnedSkills` naturally select 5?** **No.** The expression reads stored Dot and conversation data, not whether `learnedSkills` was passed. A legacy Dot with `skillDeliveryEnabled` and a conversation container still evaluates to 10 after `learnedSkills` is removed. For every Dot without those values (all new Dots, once the control is hidden) it evaluates to 5.
- **Can production preserve non-learning behaviour without a new iteration policy?** **Yes.** Git history: before `f2616a2` (Automatic Learning, 2026-09-30) the cap was `maxSteps: 5` for every Dot; the 10 arrived with skill delivery (two extra skill tools consume loop steps). Leave the expression untouched. At C9b, when the learning columns stop driving behaviour, replace it with the constant 5, the pre-learning baseline.

**Tests.** L1/L2 (C3): keyless config with a configured provider runs; with a key and a learning Dot, `learnedSkills` is still passed (the existing `learning-delivery.test.ts`); a fake provider that always answers with a tool call gets exactly **5** provider requests for a non-learning Dot and **10** for a legacy learning Dot. L2 (C6): a learning Dot with no key constructs `BuiltInAgent` with no `learnedSkills` key, `CopilotKitIntelligence.prototype.getLearnedSkillsSnapshots` is never called, and no `copilotkit_*` tool reaches any provider request. L5 (C6): a poisoned environment (sentinel key and URLs, `CPK_INTELLIGENCE_API_KEY`) plus a learning Dot produces loopback HTTP and WebSocket trap hits of **0**, and the legacy path **does** reach the trap (detector validity).

**Stale Intelligence configuration.** After C6, `index.ts` never reads `INTELLIGENCE_*` into `PlatformConfig`, so the predicate cannot become true from the environment, and one warning names the ignored variables. After C9 the fields do not exist. `check()` (`dot-agent.ts:96`) keeps aborting a run when a Dot's learning settings change mid-run; with the control hidden it never fires, and it is left alone to keep the diff small.

---

## 9. I5: incremental message cache (C8)

### 9.1 Production form

`conversation_events` stays authoritative; `conversation_messages` stays a rebuildable cache. After a normal run the cache is updated from the existing materialized state plus the newly durable events through the **same public reducer** (`defaultApplyEvents`) the full path uses, so semantics are not duplicated. Measured (R32, production-like, one thread, 100 turns, W1): update at turn 100 about 9 ms against about 275-340 ms; cumulative about 0.5-0.6 s against about 10-11 s; **not O(1)** (about 1.7 ms at turn 1, about 9 ms at turn 100).

### 9.2 Schema and migration

Four **nullable** columns on `conversation_messages`, added with the `PRAGMA table_info` guard idiom: `throughRunSeq`, `throughEventSeq`, `eventCount`, `messagesSha256`. There is no version table; **column presence is the version.** NULL means "no checkpoint": treated as unverified, repaired by one authoritative derivation per thread, no SQL backfill. Existing databases (created at C6) migrate on the first C8 boot. The checkpoint does not depend on id ordering: a late recovery event written into an earlier run is caught by the position/count check.

| Cache state         | Behaviour                                                                                                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing             | Authoritative rebuild, then write.                                                                                                                                                       |
| Stale               | Authoritative rebuild, then write.                                                                                                                                                       |
| Corrupt             | The payload hash is checked **before** parsing (a truncated payload is a hash mismatch); a hash mismatch or an unparsable payload triggers an authoritative rebuild.                     |
| Impossible / future | The checkpoint claims more events or a later run than the log holds: **fail closed for that thread only** (in-memory quarantine, loud log, no write); other threads keep working (P-12). |

The PoC threw at boot for this case; quarantining the thread is a deliberate, **not validated** deviation, because refusing to boot because of one thread is user-hostile while the underlying signal (a log that may have lost events) must not be silently "repaired".

### 9.3 N-1 compatibility

C6-era code ignores the four columns, and its upsert leaves them stale; C8 sees a hash or count mismatch and repairs. An L3 test opens a C8-migrated database with the C6 build and completes a turn.

### 9.4 R34: what happens in-process after a cache-write failure

| Option                                                       | Assessment                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Repair immediately in-process                             | Right idea, wrong if unbounded: a persistent fault (disk full, locked database) would loop and burn the event loop on repeated full derivations.                                                                                                                                                        |
| B. Serve directly from the authoritative log temporarily     | Always correct; cost is O(history) per read until repaired; impossible for the **synchronous** SDK endpoint.                                                                                                                                                                                            |
| C. Mark degraded and require a reload                        | **Rejected.** A reload repairs nothing: the browser does not read the cache and only boot or the next finalization rewrites it.                                                                                                                                                                         |
| **D. B for OpenDots readers + bounded A + natural catch-up** | **Recommended.** Never fail the run (the log is already durable); readers fall back to the log; one single-flight repair attempt; the next finalization's incremental step catches up from the old checkpoint; the synchronous SDK endpoint fails closed; the degraded state is logged once per thread. |

### 9.5 R35: boot verification at scale

Today's incremental policy derives every thread in full at every boot: about 377-465 ms p50 per 100-turn thread, growing with history and thread count. **Do not weaken the authority check for speed; move it.** Staged strategy:

1. **Boot (O(threads)):** per thread, compare the checkpoint tuple with the log's position and check the payload hash. Any mismatch repairs that thread authoritatively.
2. **First touch after boot:** before a thread is used incrementally or served to a reader, derive it once from the log and compare (in memory, a `verified` flag). The cost is one thread's size, once per process, never paid by threads that are not opened. No cache is ever **used** unverified in this process, so the authority invariant holds.
3. **Not in v1:** a periodic background verifier and an operator `verify` command.

The C8 design review must also cost **Option N** before building checkpoint machinery: the only readers of the cache in C6 are `history()` (voice start), `saveConversation` and an SDK endpoint the UI never calls. If lazy, on-demand derivation meets a budget there, the per-run cache could be dropped altogether and R34 would disappear. It is **not recommended now** because every PASS in this series used an eagerly materialized cache.

### 9.6 Acceptance and rollback

L1-L3 R32 port: incremental equals the full-history oracle at every turn (mismatch 0); the three crash windows (events durable/cache stale, a fault inside the cache transaction, SIGKILL after the cache committed); corruption controls; healthy boot repair write 0; the migration from a C6-schema database that holds real data; N-1; a boot budget for 10 threads of 100 turns. Rollback: `git revert`; the columns remain harmlessly.

---

## 10. I6: local headless turns (C5 dormant, wired in C6)

### 10.1 Production path and callers

`Platform.turn` → `runThreadTurn` → `GET {runtimeUrl}/info` (must say `intelligence`) → `new IntelligenceAgent` → Intelligence WebSocket (`headless.ts:18,33,41`; `platform.ts:186`). Callers: the scheduled-task callback (`index.ts:112`), voice compute (`voice.ts:184`), the voice receipt (`voice.ts:222`); `history()` is called by `VoiceService.begin` (`voice.ts:65`) and `PageService.saveConversation`.

### 10.2 Replacement and parity (P3, offline PASS)

| Aspect                   | Production now                                                                                              | Local adapter (C5)                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport                | HTTP `/info`, WebSocket                                                                                     | In-process `runner.run`, the call `handleSseRun` makes; no `/info`, no socket                                                                                  |
| Agent availability check | `Object.hasOwn(info.agents, dotId)` → "The selected Dot is unavailable in the runtime."                     | `workspace.dot(thread.dotId)` with the same message                                                                                                            |
| Implicit history         | **None**: the provider sees only the caller-supplied prompt                                                 | **None** (confirmed parity); `history()` is explicit retrieval, composed by the caller                                                                         |
| Message                  | `{id, role:'user', content, metadata?}`; receipt id prefixed with `voice_receipt`                           | identical                                                                                                                                                      |
| Result                   | `currentTurnText(newMessages, runError)`                                                                    | the **production function used directly as the oracle**: string-for-string equal, no normalizer                                                                |
| Abort                    | `agent.abortRun()`                                                                                          | `runner.stop(threadId, runId)`: partial text durable, `TEXT_MESSAGE_END` once, `RUN_FINISHED` once, `RUN_ERROR` 0; the caller rejects with the signal's reason |
| Errors                   | `new Error(event.message)`; code dropped                                                                    | same message; `RUN_ERROR.code` stays durable and is also attached to the thrown error object (R38)                                                             |
| Busy thread              | In-process runner throws "Thread already running" (`runner/intelligence.mjs:116`); service lock answers 409 | typed `ThreadBusyError`; provider 0, tool 0, durable writes 0                                                                                                  |

### 10.3 R36: busy headless scheduling

What a collision does today, verified: a rejected turn reaches `Store.fail` (`store.ts:297`), which sets the task to `failed`; `claim()` selects only `queued` tasks and `completed` tasks whose `nextRunAt` is due (`store.ts:241`), so a **failed repeating task stops** until the owner presses Run. That is the legacy behaviour for every error, and it is the behaviour this design keeps (DEC-3).

- **Recommended: fail loudly, no automatic retry**, with a precise message ("This conversation is busy; the scheduled run did not start.") instead of the generic runner text. It matches your default of not silently retrying scheduled side effects.
- **Why a retry would actually be safe, and why not now:** an admission-rejected run is side-effect free (provider 0, tool 0, durable writes 0), so deferring it would not duplicate anything. But `Runner.tick` re-claims every second, so a naive release would hot-loop claim/release rows; doing it properly needs a backoff column or a Store change. That is a v1.1 candidate, not an I6 change.
- **Consequence to accept:** a repeating task that fires while the owner is mid-run in its thread stops and shows an error.

### 10.4 R37: browser loser UX

Today the loser is **not silent**: `Chat.send` shows `NO_RESPONSE_MESSAGE` ("The current turn returned no response. Check the runtime connection and retry.", `Chat.tsx:160`, `chat-error.ts:39`), and the user's typed message stays visible until reload because it was never persisted. The **parity gap**: the legacy Intelligence path returned HTTP 409 and the client raised its own `AgentThreadLockedError` ("Thread … is locked", `index.mjs:405,215`). **Recommended (P-9):** an advisory 409 in `Platform.handle` for `POST agent/:id/run` when `runner.isRunning({threadId})`; the runner remains the authority and a lost race still degrades to the empty stream. This invents no UX inside the runner. It does not block I6; L4 asserts a visible message either way.

### 10.5 R38: error-code propagation

No caller uses the code. Keep it durable (it already is) and on the error object (`HeadlessTurnError.code`); do not change any caller or message.

### 10.6 Which of R36-R38 blocks I6

**None blocks the adapter.** R36 needs the owner's confirmation (DEC-3) before the C6 wiring; R37 and R38 do not block anything.

### 10.7 Voice side effects

The voice receipt wording and a persisted string contract are in section 11.5. `VoiceService` itself is unchanged apart from where `history()` and `turn()` resolve.

---

## 11. I7: CSP and residual Intelligence removal (C7, C9)

### 11.1 Residual inventory, re-done from main (not the earlier count)

| File                             | Class | Commit                                 | Matches (intel / learn / slack / endpoint) | What                                                                                                                            |
| -------------------------------- | ----- | -------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `src/client/App.tsx`             | A     | C7                                     | 0 / 0 / 2 / 0                              | the "Slack · status" line for an unsupported feature (hide); no Intelligence reference                                          |
| `src/server/dot-agent.ts`        | A     | C3 / C6                                | 4 / 10 / 2 / 0                             | credential guard (C3); learnedSkills option and learned-skill tools (C6); channel mode (C9)                                     |
| `src/server/headless.ts`         | A     | C6 unreachable / C9 delete             | 7 / 0 / 0 / 0                              | runThreadTurn, /info schema, IntelligenceAgent; currentTurnText stays                                                           |
| `src/server/index.ts`            | A     | C6 / C7                                | 6 / 0 / 6 / 4                              | `INTELLIGENCE_*` reads, `SLACK_*` reads, wsOrigin and the CSP default, scheduler text                                           |
| `src/server/learning.ts`         | A     | C9                                     | 2 / 2 / 2 / 0                              | learningSelector for CopilotKitIntelligence.getLearningContainerId                                                              |
| `src/server/page-service.ts`     | A     | C6                                     | 5 / 0 / 0 / 0                              | PageIntelligence port -> PageConversationPort                                                                                   |
| `src/server/platform-config.ts`  | A     | C6 (setup) / C9 (fields)               | 5 / 0 / 14 / 1                             | intelligenceKey/ApiUrl/WsUrl, slack*, the INTELLIGENCE_API_KEY setup gate                                                       |
| `src/server/platform.ts`         | A     | C6                                     | 14 / 2 / 10 / 1                            | CopilotKitIntelligence, CopilotRuntime({intelligence}), managed Slack channels, createConversation/history/handle/turn          |
| `src/server/slack-channel.ts`    | A     | C9                                     | 0 / 0 / 28 / 0                             | managed Channels; @copilotkit/channels                                                                                          |
| `src/server/tanstack-tools.ts`   | A     | C9                                     | 0 / 5 / 0 / 0                              | learnedSkillTools bridge (type import only from the runtime)                                                                    |
| `src/client/WorkspaceDialog.tsx` | B     | C7                                     | 2 / 5 / 1 / 0                              | Automatic Learning fieldset hidden, legacy values preserved on save; the Slack status sentence in the setup panel is hidden too |
| `src/server/workspace-routes.ts` | B     | C7                                     | 1 / 11 / 0 / 0                             | accepts legacy learning fields; refuses new enablement; known-error regex still lists the old prefix                            |
| `src/server/workspace.ts`        | B     | retain                                 | 0 / 27 / 0 / 0                             | learningContainerId / skillDeliveryEnabled columns kept as archive-compatible schema                                            |
| `src/shared/learning.ts`         | B     | retain                                 | 0 / 2 / 0 / 0                              | validation of legacy values                                                                                                     |
| `src/shared/types.ts`            | B     | retain / C9 (SetupStatus.intelligence) | 1 / 3 / 1 / 0                              | learning fields on Dot/Conversation; SetupStatus.intelligence                                                                   |
| `src/server/chatgpt-plan.ts`     | C     | C3                                     | 1 / 0 / 0 / 0                              | the same error text                                                                                                             |
| `src/server/model-provider.ts`   | C     | C3                                     | 1 / 0 / 0 / 0                              | error text "Intelligence and model configuration are required."                                                                 |
| `src/server/page-routes.ts`      | C     | C7                                     | 1 / 0 / 0 / 0                              | user-facing message                                                                                                             |
| `src/server/shutdown.ts`         | C     | C6/C9                                  | 0 / 0 / 1 / 0                              | "Stopping Channels failed" label; no Intelligence reference                                                                     |
| `src/server/voice.ts`            | C     | C7                                     | 3 / 0 / 0 / 0                              | two user-visible messages and the persisted "pending Intelligence sync" marker matched by resumePending                         |
| `src/shared/voice-receipt.ts`    | C     | C7                                     | 1 / 0 / 0 / 0                              | comment only                                                                                                                    |

`intelligence-residuals.json` also lists the per-pattern line numbers, the tests that pin Intelligence behaviour, and the docs/config counts. **The SDK package itself still contains Intelligence code that is loaded but never constructed**, so the correct claim after C9 is "no OpenDots code path reaches it", proved by reachability and egress tests, never "the package contains none".

**Must go before shipping (reachable or owner-visible):** `INTELLIGENCE_*`/`SLACK_*` reads and the Intelligence/Slack construction in `index.ts` and `platform.ts` (C6); the CSP WebSocket origin and the Automatic Learning and Slack UI (C7). **Must go before any "removed" claim:** the dead code listed for C9. **Retained:** class B (legacy learning columns and validation). **Reworded:** class C.

### 11.2 URLs and destinations

Intelligence WebSocket `wss://realtime.intelligence.copilotkit.ai` (default even when unconfigured, `index.ts:117,137`); the learned-skills API `POST <INTELLIGENCE_API_URL | https://api.intelligence.copilotkit.ai>/api/v1/learning/skills/batch`; telemetry `https://telemetry.copilotkit.ai/ingest` (runtime, channels, inspector); the managed Slack gateway through `@copilotkit/channels`. Allowed live destinations when ChatGPT Plan is selected: `api.openai.com`, `auth.openai.com`, loopback.

### 11.3 CSP design

Current: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${wsOrigin}; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`

Proposed (C7): `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`

- `connect-src 'self'` is correct for the shipping matrix: chat, tools and pages use same-origin fetch and SSE; every external URL in `src/client` is a navigation link (not a subresource). The full chat + tool turn adds **zero** violations relative to the current policy (P5). The one pre-existing `script-src` `eval` block from the shipped bundle is unchanged and not fixed here.
- **`connect-src` does not confine WebRTC.** ICE/STUN/DTLS media and the peer endpoint negotiated in the SDP answer are outside CSP. **Voice Realtime is a documented egress exception** for an optional, provider-gated feature. The controls are feature gating (the Voice control is disabled and calls are refused before any request without both `VOICE_API_KEY` and `VOICE_MODEL`), the microphone permission prompt, and the same-origin server-brokered SDP exchange. Network-layer filtering is the only real enforcement and is outside the application. A real Realtime session was **never exercised** in P5 or here.
- Optional hardening, may defer: `Permissions-Policy: microphone=(self), camera=(), geolocation=()`.
- The repository has **no CSP test today**; C7 adds the first (a pure `csp.ts` builder plus string equality) and the real-Chromium probe set (fetch, XHR, WebSocket, EventSource, image, script, form post to a non-self origin: all blocked).

### 11.4 UI and server gating

Hide the Automatic Learning fieldset (`WorkspaceDialog.tsx:310`) and the Slack status (`App.tsx:706`). A legacy Dot that already has a container keeps it: the form re-sends stored values unchanged. The server **rejects new enablement** with 400 (P-14) and tolerates unchanged legacy values, so an API client cannot enable a feature that would silently do nothing.

### 11.5 A persisted string is a contract

`voice.ts:217` writes `calls.error` text containing "pending Intelligence sync"; `resumePending` matches that substring (`voice.ts:237`); `voice.test.ts` pins it. Rows with that text may exist in user databases. C7 may reword the message but **must keep matching the legacy marker** (P-15). Similarly `workspace-routes.ts` has a known-error regex that starts with the old "Intelligence could not" prefix.

### 11.6 Docs, environment and startup validation

`.env.example`, `compose.yml` (still passes `INTELLIGENCE_*`, `SLACK_*`), `docs/SETUP.md` (about 19 mentions, Slack and Automatic Learning sections), `README.md`, `SECURITY.md` and `OWNER_ID`'s comment ("it owns the persistent Intelligence conversations") change in C7. `OWNER_ID` must stay stable: it scopes `thread_bindings.ownerId`.

### 11.7 Dependencies (C9b, separate approval)

After C9, `@copilotkit/channels` (only `slack-channel.ts`) and the **direct** `@copilotkit/core` dependency (only `headless.ts`'s `IntelligenceAgent`; the client still reaches it through `@copilotkit/react-core`) are unused. Removal edits `package.json` and the lockfile; **nothing in this phase touches either.**

---

## 12. Feature matrix

| Feature                                                            | Local-first v1 | Notes                                                                                                                                                                                              |
| ------------------------------------------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser chat (text, streaming, stop, human review card)            | supported      | C6. Local durable runner; CopilotSseRuntime; browser client adapts through /info (mode "sse").                                                                                                     |
| Local durable history (restart, replay, reconnect)                 | supported      | C4+C6. Authoritative event log; plaintext SQLite (not encrypted); files 0600.                                                                                                                      |
| Tools (pages, computer tools, read_public_page, review_space_page) | supported      | Unchanged. Computer and browser services stay optional/configured.                                                                                                                                 |
| Page conversations and "save conversation as page"                 | supported      | C6. Local page port; history derived from the authoritative log.                                                                                                                                   |
| Scheduled / headless turns                                         | supported      | C5+C6. Prompt-only, no implicit history. Busy thread = loud failure, no retry (R36).                                                                                                               |
| Voice compute backend (ask_compute, call receipt)                  | supported      | C5+C6. Needs a configured model provider; idempotent per tool-call id; six-turn call limit unchanged.                                                                                              |
| Voice Realtime session (WebRTC)                                    | optional       | Provider-gated: VOICE_API_KEY + VOICE_MODEL (an OpenAI API key, separate from ChatGPT Plan). Egress exception: server to api.openai.com; browser WebRTC is outside CSP. Not exercised in P5.       |
| ChatGPT Plan provider                                              | optional       | Provider-gated; Keychain-backed credential; api.openai.com and auth.openai.com. Provider-facing code is untouched; P2b-0 live evidence is inherited.                                               |
| API-key provider                                                   | optional       | Provider-gated: OPENAI_API_KEY + OPENAI_MODEL.                                                                                                                                                     |
| Automatic Learning / learned skills                                | unsupported    | Requires the Intelligence learning API; SSE runtime throws on learning options. Stored settings are kept archive-only; new enablement refused (C7). Re-entry needs a new, non-Intelligence design. |
| Managed Slack channel                                              | unsupported    | CopilotSseRuntime throws when channels are passed; managed Channels need the Intelligence gateway. `SLACK_*` ignored with a warning. A direct Slack integration would be a new feature.            |
| Historical Intelligence-hosted conversations                       | archive-only   | Stay in the Intelligence project; NOT imported; their thread bindings, call receipts and page links remain and the threads open empty. No export/import tool in v1.                                |
| Automatic conversation titles (generateThreadNames)                | unsupported    | Intelligence-runtime option; ThreadList already falls back to the stored title.                                                                                                                    |
| Thread rename / archive / delete through the runtime API           | unsupported    | threads/update, threads/archive and threads/subscribe require the Intelligence runtime (HTTP 422 in SSE mode); the OpenDots UI does not expose them.                                               |
| CopilotKit suggestions endpoint                                    | unsupported    | Unused by the client; executes the agent without the runner; denied in C2.                                                                                                                         |
| CopilotKit dev inspector and telemetry                             | unsupported    | Disabled (C1).                                                                                                                                                                                     |
| Multiple server processes on one database                          | unsupported    | R17. Documented constraint.                                                                                                                                                                        |
| Encryption of conversation data at rest                            | unsupported    | SQLite is plaintext; only the ChatGPT Plan credential uses the Keychain. Do not describe the database as encrypted.                                                                                |
| Cross-run encrypted reasoning continuation                         | deferred       | D1: not required; P2a-9 / P2b-1 stay HOLD.                                                                                                                                                         |
| Import of old Intelligence history                                 | deferred       | Would reintroduce the dependency; no plan in v1.                                                                                                                                                   |

Feature loss is listed as feature loss, not as an implementation failure: the unsupported rows exist because the SSE runtime or the Intelligence service no longer provides them.

---

## 13. Configuration contract

Target model: **required** is only the local owner and security configuration; **provider-specific** variables are required only when that provider or feature is selected; **Intelligence variables are not required and not read**.

| Variable(s)                                                                                              | Class             | When                     | Behaviour                                                                                                                                                                                                                              | Note                                                                                           |
| -------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `OWNER_TOKEN`                                                                                            | required          | always, every HOST       | Missing or shorter than 24 characters: refuse to start with an actionable message. Never logged.                                                                                                                                       | Docker compose already requires it.                                                            |
| `DATABASE_PATH`                                                                                          | default           | always                   | Default data/opendots.sqlite. DB, -wal and -shm are kept 0600; a directory the app creates is 0700.                                                                                                                                    | Plaintext SQLite.                                                                              |
| `OWNER_ID`                                                                                               | default           | always                   | Default opendots-owner. Must stay stable: it scopes thread_bindings.ownerId, so changing it hides every conversation.                                                                                                                  | .env.example wording changes from "Intelligence conversations".                                |
| `HOST, PORT, APP_ORIGIN`                                                                                 | network           | always                   | Loopback by default; APP_ORIGIN is the exact allowed browser origin (dev proxy).                                                                                                                                                       |                                                                                                |
| `MODEL_PROVIDER`                                                                                         | optional          | validated if set         | api-key or chatgpt-plan; anything else refuses to start (unchanged).                                                                                                                                                                   |                                                                                                |
| `OPENAI_API_KEY, OPENAI_MODEL, OPENAI_BASE_URL`                                                          | provider-specific | api-key provider         | Required only when that provider is selected; reported in setup.missing otherwise.                                                                                                                                                     |                                                                                                |
| `CHATGPT_DEVKIT_DIST, CHATGPT_DEVKIT_STRICT, CHATGPT_CREDENTIAL_STORE, CHATGPT_STATE_DIR`                | provider-specific | ChatGPT Plan provider    | Unchanged. keychain never falls back to ephemeral.                                                                                                                                                                                     |                                                                                                |
| `VOICE_API_KEY, VOICE_MODEL, VOICE_NAME`                                                                 | provider-specific | Voice Realtime enabled   | Voice UI disabled and calls refused before any request without both key and model.                                                                                                                                                     |                                                                                                |
| `BROWSER_URL, BROWSER_SECRET (+BROWSER_HOST/PORT for the service)`                                       | optional          | public-page reads        | Unchanged; the service has its own 24-character secret check.                                                                                                                                                                          |                                                                                                |
| `COMPUTER_SUPERVISOR_URL, COMPUTER_SUPERVISOR_TOKEN, COMPUTER_TOKEN, COMPUTER_NAMESPACE`                 | optional          | persistent computers     | Unchanged.                                                                                                                                                                                                                             |                                                                                                |
| `INTELLIGENCE_API_KEY, INTELLIGENCE_API_URL, INTELLIGENCE_WS_URL, CPK_INTELLIGENCE_*`                    | obsolete          | if present and non-empty | IGNORED with ONE startup warning that names the variables (never values) and says old Intelligence history is not shown. Empty strings count as absent (.env.example and compose pass empty defaults). Never read into PlatformConfig. | Explicit, not silent, not fatal: rejecting would break every .env copied from the old example. |
| `SLACK_CHANNEL_NAME, SLACK_TEAM_ID, SLACK_USER_IDS, SLACK_DOT_ID`                                        | obsolete          | if present and non-empty | Ignored with the same single warning (the feature is unsupported).                                                                                                                                                                     |                                                                                                |
| `COPILOTKIT_TELEMETRY_DISABLED, DO_NOT_TRACK`                                                            | not configuration | always                   | Overridden to 1 by the first-import guard regardless of the environment; setting them is unnecessary and setting them false is ignored.                                                                                                | DO_NOT_TRACK=1 is also inherited by child processes; accepted.                                 |
| `COPILOTKIT_TELEMETRY_URL, CPK_TELEMETRY_ID, COPILOTKIT_LICENSE_TOKEN, COPILOTKIT_TELEMETRY_SAMPLE_RATE` | unused            | never read by OpenDots   | No effect while telemetry is disabled.                                                                                                                                                                                                 |                                                                                                |

**Obsolete variables: ignore with one warning** (recommended; section 11). Silent ignoring hides a changed product; rejecting would break every `.env` copied from the old example, which passes empty `INTELLIGENCE_*` defaults. The warning names the variables, never their values, and says the old history is not shown. A poisoned configuration is proved harmless by the L5 trap test, not asserted.

**Startup validation, in order:** token (C2); provider enums; database path creatable with the required modes; backup (existing database, first C6 boot); `runner.ready()`; then listen. Any failure exits non-zero with an actionable message.

---

## 14. Security and storage boundaries

Carried forward exactly:

- **Conversation, event and tool data are plaintext SQLite** (`conversation_events.eventJson` holds whole AG-UI events; the canary text was readable in the database files in P5). **Do not call the database encrypted.**
- **The ChatGPT Plan persistent credential** is a macOS-Keychain-backed sealed envelope when `CHATGPT_CREDENTIAL_STORE=keychain`; it is **not** stored in SQLite (P5 canary: 0 credential values in db/wal/shm, logs, DOM, errors, provider bodies). That path was not exercised by P5 (no Keychain access).
- **The owner token is a separate secret** from the provider credential and from `BROWSER_SECRET`.
- **File permissions get an explicit gate** (L5/L2 `stat`): database, `-wal`, `-shm` mode `0600`; a directory the app creates `0700`.
- **Browser exposure** of the token in `sessionStorage` is an **open, documented risk** (OWNER-STORE), accepted for v1 under the four conditions in 6.5.
- **Backups** produced by DEC-7 are plaintext copies with the same sensitivity and the same mode.
- **Single process per database** (R17).

---

## 15. Migration and rollback map

| Phase                         | Production files                                                                                                           | DB migration?                                                                                                                                   | Config change?                                                                           | Behavior change?                                                                                                         | Backward-compatible?                                    | Acceptance gate                                                                  | Rollback procedure                                                                                                     | Blocks next phase?       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| C1 / I1                       | telemetry-guard.ts (new); first import of 7 modules; App.tsx                                                               | No                                                                                                                                              | No (the variable is now overridden, not required)                                        | Yes: telemetry is never sent                                                                                             | Yes                                                     | L0 order contract; L5 telemetry trap = 0 incl. built dist; negative controls RED | git revert                                                                                                             | No (but must precede C4) |
| C2 / I2                       | startup-config.ts (new); index.ts; runtime-scope.ts; .env.example; docs                                                    | No                                                                                                                                              | Yes: OWNER_TOKEN (>=24 chars) required on every HOST                                     | Yes: refuses to start without it; /suggest denied                                                                        | No for tokenless loopback installs (one-time .env edit) | L1 config; L2 owner matrix; L4 unlock flows; L5 canary                           | git revert (token optional again)                                                                                      | No                       |
| C3 / I4a                      | dot-agent.ts; model-provider.ts; chatgpt-plan.ts; 2 test pins                                                              | No                                                                                                                                              | No                                                                                       | No on the legacy path (error text only)                                                                                  | Yes                                                     | existing suite + L1/L2 additions                                                 | git revert                                                                                                             | Yes: C6                  |
| C4 / I3a                      | conversation-log.ts, durable-runner.ts (new); workspace.ts seam                                                            | Defined, NOT executed (no caller)                                                                                                               | No                                                                                       | No (dead code)                                                                                                           | Yes                                                     | L0 SDK contract; L1; L2 differential; L3 SIGKILL                                 | git revert / delete; no deployed database changed                                                                      | Yes: C5 tests, C6        |
| C5 / I6a                      | headless-local.ts (new); headless.ts unchanged API                                                                         | No                                                                                                                                              | No                                                                                       | No (dead code)                                                                                                           | Yes                                                     | L1/L2 P3 matrix                                                                  | git revert                                                                                                             | Yes: C6                  |
| C6 / I3b+I4b+I6b (ACTIVATION) | platform.ts; platform-config.ts; page-service.ts; dot-agent.ts; index.ts; workspace.ts; legacy-config.ts (new)             | Yes, additive: 3 CREATE TABLE IF NOT EXISTS (conversation_runs, conversation_events, conversation_messages); no existing table altered          | Yes: `INTELLIGENCE_*`/`SLACK_*` ignored with one warning; nothing new required beyond C2 | Yes: conversations local; Intelligence and managed Slack unreachable; learning inert; old Intelligence history not shown | No: new data is unreadable by the old path              | L0-L5 complete; upgrade fixture; backup restore; file modes                      | revert code + restore the pre-activation backup (loses post-activation conversations) or accept orphaned local threads | Yes: C7, C8, C9          |
| C7 / I7a                      | csp.ts (new); index.ts; WorkspaceDialog.tsx; App.tsx; workspace-routes.ts; voice.ts; docs; compose.yml                     | No                                                                                                                                              | Yes: INTELLIGENCE_WS_URL no longer read; compose/.env cleanup                            | Yes: browser may connect only to self; learning/Slack UI hidden; new learning enablement refused                         | Yes (legacy values preserved on save)                   | L0 CSP; L4/L5 probes; UI tests                                                   | git revert                                                                                                             | No (C9 needs it)         |
| C8 / I5                       | conversation-log.ts; durable-runner.ts                                                                                     | Yes, additive: 4 nullable columns on conversation_messages (PRAGMA table_info guard); NULL = unverified -> one authoritative rebuild per thread | No                                                                                       | Performance and verification only; results identical to the oracle                                                       | Yes: C6-era code ignores the columns                    | L1-L3 R32 port; migration + N-1 tests; boot budget                               | git revert; columns remain harmlessly; stale checkpoints repaired on re-landing                                        | No                       |
| C9 / I7b                      | slack-channel.ts, learning.ts, headless.ts, tanstack-tools.ts, platform-config.ts, types; tests; (C9b) package.json + lock | No (legacy columns are retained)                                                                                                                | No                                                                                       | No (code was unreachable)                                                                                                | Yes                                                     | L0 reachability + dependency tree; full regression                               | git revert (+ lockfile for C9b)                                                                                        | No                       |

**The first phase after which rollback requires data-compatibility logic rather than a code revert is C6 (I3b).** Before it, the DDL has never run in any deployed database and no behaviour has changed. After it: reverting the code restores the Intelligence path, but conversations created since activation exist only in local SQLite, their `thread_bindings` rows point at thread ids the Intelligence service has never seen, and a scheduled task bound to such a thread would run in a new remote thread with no history. The honest options are (1) **restore the pre-activation backup** (loses everything since activation), (2) accept the orphaning, or (3) forward-fix. There is no export from local to Intelligence. No **schema** downgrade is ever needed: C6's tables are additive and stay in the file, unused.

C8 is the only other migration, and it is additive: reverting the code leaves four ignored columns.

---

## 16. Proposed production commit sequence

Nine commits. Security-boundary changes (C1, C2, C7) are separate from the runtime and storage changes (C4, C6, C8) so each can be reviewed alone.

### C1 (I1): `fix(server): disable CopilotKit telemetry before any CopilotKit module loads`

- **Files / classes:**
  - NEW src/server/telemetry-guard.ts (side-effect module: sets COPILOTKIT_TELEMETRY_DISABLED=1 and DO_NOT_TRACK=1, unconditionally)
  - EDIT first import of src/server/index.ts and of every module that value-imports @copilotkit/runtime, /channels or /core: platform.ts, dot-agent.ts, computer-tools.ts, page-tools.ts, slack-channel.ts, headless.ts
  - EDIT src/client/App.tsx (CopilotKitProvider enableInspector={false})
  - NEW tests/setup-telemetry.ts and EDIT vite.config.ts (test.setupFiles) so every vitest root runs the guard first; preventive today (the suite constructs no runtime: the only new Platform( in tests has no key) and REQUIRED from C4, when L2 tests construct CopilotSseRuntime
  - NEW tests/telemetry-guard.test.ts (L0 evaluation-order simulation + L1) and a subprocess egress test against the built entry
- **Prerequisite:** none
- **Tests required:** L0 evaluation-order and first-import contract; L1 guard; L5 subprocess against the built dist entry with a loopback telemetry trap; negative controls (late guard, missing guard, entry that forgets) must go RED; npm test/lint/typecheck/build green
- **Rollback scope:** git revert; no data, no config

### C2 (I2): `feat(security): require OWNER_TOKEN for every binding and deny the unused suggest route`

- **Files / classes:**
  - NEW src/server/startup-config.ts (pure validateStartupConfig(env): token required and >=24 chars on every HOST; MODEL_PROVIDER and CHATGPT_CREDENTIAL_STORE validation moves here unchanged)
  - EDIT src/server/index.ts (call it; remove the inline external-host check)
  - EDIT src/server/runtime-scope.ts (remove "suggest" from the agent route allowlist)
  - EDIT .env.example, docs/SETUP.md (token wording)
  - NEW tests/startup-config.test.ts, tests/owner-boundary.test.ts; EDIT tests/runtime-scope.test.ts
- **Prerequisite:** none (independent of C1)
- **Tests required:** L1 table-driven startup config; L2 the 13-case P5 owner matrix against the production app (provider 0, tool 0, durable/Intelligence writes 0, rejected credential never echoed); L4 unlock/reload/new-tab flows; L5 token canary; L0 no dangerouslySetInnerHTML/eval/new Function in src/client and one sessionStorage key
- **Rollback scope:** git revert; the server accepts an unset token again; existing tokens keep working

### C3 (I4a): `refactor(server): DotAgent requires only a configured model provider`

- **Files / classes:**
  - EDIT src/server/dot-agent.ts (guard checks provider.configured only; learnedSkills option built by one explicit predicate; maxIterations expression UNCHANGED)
  - EDIT src/server/model-provider.ts, src/server/chatgpt-plan.ts (error text: "Model configuration is required.")
  - EDIT the two tests that pin the old text through the regex /configuration are required/: tests/model-provider.test.ts:19 and tests/model-switching.test.ts:197 (the other tests only pass intelligenceKey: 'fixture' as a config value, which stays valid until C9)
- **Prerequisite:** none
- **Tests required:** existing suite unchanged except the two text pins; new L1/L2: keyless + provider-configured run proceeds; learned-skills path still works when a key is present (learning-delivery.test.ts unchanged); loop bound observed 5 for a non-learning Dot and 10 for a learning Dot
- **Rollback scope:** git revert; no data

### C4 (I3a): `feat(server): add durable local AgentRunner and conversation log (not wired)`

- **Files / classes:**
  - NEW src/server/conversation-log.ts (DDL and queries; takes a DatabaseSync; creates nothing until constructed)
  - NEW src/server/durable-runner.ts (AgentRunner + LocalThreadEndpointRunner; W1; persist-then-publish; recovery; interlock; full-rebuild cache; messagesFor reader seam; ready(); stopAll())
  - EDIT src/server/workspace.ts (explicit openConversationLog() seam; NOT called by production code in this commit)
  - NEW tests/durable-runner*.test.ts (L1/L2 differential against the SDK InMemoryAgentRunner as a live oracle) and tests/crash/*.test.ts (L3, real SIGKILL)
- **Prerequisite:** C1 (the new module imports @copilotkit/runtime/v2 and must be covered by the guard contract)
- **Tests required:** L0 SDK contract pins (abstract AgentRunner shape, the semi-public local-thread marker, exact installed version); L1 units; L2 differential vs InMemoryAgentRunner for the G0-G7 shapes; L3 SIGKILL windows, restart, interlock, cache repair, R26 classification; 100-turn smoke
- **Rollback scope:** git revert (delete files); nothing in any deployed database changes because the DDL never ran

### C5 (I6a): `feat(server): add local headless turn adapter (not wired)`

- **Files / classes:**
  - NEW src/server/headless-local.ts (runLocalTurn through runner.run, in-process; typed ThreadBusyError; RUN_ERROR.code kept on the thrown error without changing its message)
  - EDIT src/server/headless.ts only to keep currentTurnText exported unchanged
  - NEW tests/headless-local.test.ts (P3 matrix at L1/L2)
- **Prerequisite:** C4
- **Tests required:** L1/L2: prompt-only (no implicit history); currentTurnText string equality against the production function as oracle; tool-using turn; abort reaches runner.stop and the caller rejects with the signal reason; busy thread -> typed error, provider 0, tool 0, durable writes 0; voice_receipt id prefix and metadata; code preserved on the error
- **Rollback scope:** git revert; no data

### C6 (I3b (+I4b, +I6b)): `feat(server)!: serve conversations from the local durable runner (activation)`

- **Files / classes:**
  - EDIT src/server/platform.ts (replace the Intelligence construction: CopilotSseRuntime({agents, runner}); local createConversation/history/turn/handle; no Slack channels)
  - EDIT src/server/platform-config.ts (setupStatus no longer demands INTELLIGENCE_API_KEY)
  - EDIT src/server/page-service.ts (port renamed PageConversationPort; local implementation)
  - EDIT src/server/dot-agent.ts (remove the learnedSkills option and learned-skill tools: I4b)
  - EDIT src/server/index.ts (open the log, await runner.ready() before listen, stop reading `INTELLIGENCE_*`/`SLACK_*`, one-time warning for obsolete variables, scheduler text, pre-activation backup, DB file modes)
  - EDIT src/server/workspace.ts (call the seam); NEW src/server/legacy-config.ts (obsolete-variable detection)
  - EDIT tests: setup.test.ts, page-service.test.ts, page-routes.test.ts (new Platform( takes a runner), voice.test.ts (setup() fixture shape), runtime-scope.test.ts, headless-runtime.test.ts (superseded by C5); learning-delivery.test.ts and the learned-skills cases of dot-agent-channel.test.ts test an option that C6 removes from DotAgent, so they are deleted or converted to the "no learnedSkills" assertions in C6
- **Prerequisite:** C1, C3, C4, C5 (C2 recommended first)
- **Tests required:** L0 reachability (no class-A symbol reachable from any entry point); L1; L2 full chat/tool/HITL/stop/headless/page/voice-compute matrix; L3 restart/replay (provider 0, DB hash unchanged for a reader), upgrade fixture from a pre-activation database, backup restore; L4 real Chromium flows; L5 egress with poisoned Intelligence/Slack/telemetry configuration; file-mode gate
- **Rollback scope:** git revert restores the Intelligence path in code, but conversations created after activation exist only in local SQLite and are invisible to it (data compatibility logic needed: restore the pre-activation backup, or accept the loss). First phase where rollback is not a plain code revert.

### C7 (I7a): `feat(security): confine browser connections to self; hide unsupported learning and Slack controls`

- **Files / classes:**
  - NEW src/server/csp.ts (pure builder); EDIT src/server/index.ts (connect-src 'self'; no INTELLIGENCE_WS_URL)
  - EDIT src/client/WorkspaceDialog.tsx (hide the Automatic Learning fieldset; keep legacy values on save), src/client/App.tsx (hide the Slack status line)
  - EDIT src/server/workspace-routes.ts (reject NEW learning enablement with 400; tolerate unchanged legacy values)
  - EDIT src/server/voice.ts (message wording with the legacy marker still matched), src/server/page-routes.ts, src/client/model-view.ts copy
  - EDIT .env.example, compose.yml, docs/SETUP.md, README.md, SECURITY.md
  - NEW tests/csp.test.ts (first CSP test in the repo), UI tests
- **Prerequisite:** C6
- **Tests required:** L0 CSP string equality and no third-party origin in src/client; L4/L5 every connect probe (HTTP, WebSocket, fetch, XHR, EventSource) blocked, app unchanged, pre-existing eval block unchanged; UI hidden-control tests; legacy Dot round-trips its stored learning values; voice.test.ts legacy marker still resumes pending syncs
- **Rollback scope:** git revert; no data

### C8 (I5): `perf(server): incremental conversation cache with verified checkpoints`

- **Files / classes:**
  - EDIT src/server/conversation-log.ts (additive ALTER: throughRunSeq, throughEventSeq, eventCount, messagesSha256 on conversation_messages; each guarded by PRAGMA table_info like workspace.ts)
  - EDIT src/server/durable-runner.ts (incremental policy; cheap boot verification; first-touch authoritative verification; per-thread quarantine; R34 repair hooks)
  - NEW tests (R32 port: oracle equality over 100 turns, crash windows C1-C3, corruption controls, impossible-checkpoint quarantine, migration from a C6-schema database that holds real data, N-1 compatibility)
- **Prerequisite:** C6
- **Tests required:** L1-L3 as listed; incremental result equals the full-history oracle for every turn (mismatch 0); healthy boot repair write 0; boot time bounded for 10 threads of 100 turns; code of C6 opens a database migrated by C8 and completes a turn (N-1)
- **Rollback scope:** git revert; the four columns stay (ignored by the C6 code); a stale checkpoint is detected and repaired on the next C8 boot

### C9 (I7b): `chore: remove dead Intelligence, managed Slack and learned-skills code`

- **Files / classes:**
  - DELETE src/server/slack-channel.ts, src/server/learning.ts, learnedSkillTools in tanstack-tools.ts, runThreadTurn and runtimeInfoSchema in headless.ts, DotAgent channel mode, intelligence*/slack* fields in platform-config.ts, SetupStatus.intelligence
  - DELETE tests: slack-channel*.test.ts, learning*.test.ts, headless-runtime.test.ts, fixtures/learning-skills.zip
  - C9b (separate approval): package.json / package-lock.json remove @copilotkit/channels and the direct @copilotkit/core dependency if nothing imports them; collapse maxIterations to the constant 5
- **Prerequisite:** C6, C7
- **Tests required:** L0 reachability and dependency-tree assertions; full regression; L5 smoke
- **Rollback scope:** git revert (and restore the lockfile for C9b); no data

**Test movement.** Existing tests that pin Intelligence behaviour move with the commit that changes the behaviour: C2 `runtime-scope.test.ts`; C3 `model-provider` and `model-switching` (the two text pins); C6 `setup`, `page-service`, `page-routes`, `voice` (the `setup()` fixture), `runtime-scope`, `headless-runtime` (superseded by C5's tests), and `learning-delivery` plus the learned-skills cases of `dot-agent-channel` (their subject, the `learnedSkills` option, is removed from `DotAgent` in C6); C7 `voice` (legacy marker) and `model-view` (its setup note uses `INTELLIGENCE_API_KEY` as the example); C9 deletes `slack-channel*`, `learning.test.ts` and the rest of the learned-skills tests. There is **no CSP test today**; C7 adds the first. Heavy suites become separate scripts (`test:crash`, `test:browser`, `test:egress`, DEC-12) so default `npm test` stays fast and the real-`SIGKILL` and Chromium suites run in their own CI jobs.

---

## 17. Acceptance ladder

### 17.1 Levels

| Level | Name                            | Asserts                                                                                                                                                                                                                                                                                                                                                                         | Runs as                                                                   | Ported from                                                 |
| ----- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------- |
| L0    | Static / source contract        | Evaluation-order simulation of every entry point (guard before any CopilotKit module); class-A reachability; CSP string; enableInspector={false}; no HTML-injection sinks; one sessionStorage key; installed-SDK contract pins (AgentRunner shape, local-thread marker, CopilotSseRuntime throws on channels/learning, thread routes 422 in SSE mode, /info mode); DDL snapshot | npm test (CI)                                                             | new; P5 static-inventory.mjs as the model                   |
| L1    | Unit                            | validateStartupConfig; guard; runner units (classification, finalization, interlock, dedup, reducer seam); typed errors; CSP builder; legacy-config detection                                                                                                                                                                                                                   | npm test (CI)                                                             | ported from tests/p2a, tests/p3, tests/p5 where unit-shaped |
| L2    | Local fake-provider integration | Real createApp + Platform + SSE handler + fake model: owner matrix (13 cases), chat/tool/HITL/stop, headless, scheduler Runner, page conversation, voice-compute with a fake transport; differential check against the SDK InMemoryAgentRunner                                                                                                                                  | npm test (CI)                                                             | tests/p2a fake-model + p5 owner-auth + p3                   |
| L3    | Restart / crash / replay        | New runner on the same file (CI default); real SIGKILL windows in child processes; fresh-process replay with provider 0 / DB hash unchanged for readers; interlock; cache repair; upgrade fixture from a pre-activation database; backup restore; N-1 compatibility                                                                                                             | npm run test:crash (separate CI job; local gate before C4, C6, C8)        | tests/p2a p2a1-p2a5, r32                                    |
| L4    | Real Chromium                   | Built client + real Chat.tsx: chat, tool turn, HITL review card after restart, stop, thread list, unlock/reload/new-tab, busy-thread message, no console errors or 4xx/5xx from /api/copilotkit/threads/*                                                                                                                                                                       | npm run test:browser (CI job installs Chromium; local gate before C6, C7) | tests/p5/browser.ts + matrix                                |
| L5    | Security / egress               | Server child with network interceptor and loopback traps (Intelligence HTTP/WS, telemetry sink) against the BUILT dist; poisoned Intelligence/Slack/telemetry environment; browser network matrix; CSP probes incl. WebSocket; secret canary; file modes; negative controls (mutations) all detected                                                                            | npm run test:egress (separate CI job; local gate before C1, C6, C7)       | tests/p5 interceptor, traps, secret-scan, negative-controls |
| L6    | Live ChatGPT Plan               | Not required by any phase                                                                                                                                                                                                                                                                                                                                                       | only on the triggers in section 17                                        | P2b-0 evidence is inherited                                 |

### 17.2 Which levels each commit must pass

| Commit | Levels that must pass                    |
| ------ | ---------------------------------------- |
| C1     | L0 L1 L5(telemetry)                      |
| C2     | L0 L1 L2 L4(unlock) L5(canary)           |
| C3     | L0 L1 L2                                 |
| C4     | L0 L1 L2 L3 (+ 100-turn smoke)           |
| C5     | L0 L1 L2                                 |
| C6     | L0 L1 L2 L3 L4 L5 (all)                  |
| C7     | L0 L1 L4 L5(csp)                         |
| C8     | L0 L1 L2 L3 (+ boot and A/B measurement) |
| C9     | L0 + full regression + L5 smoke          |

Additional gates that are not a level of their own: **file modes** (`stat` of database, `-wal`, `-shm`); **upgrade fixture** (a database created by main@82330a6 code boots under C6, lists its threads, creates a new conversation and survives a restart); **backup restore**; **N-1** at C8; **R31** (10 consecutive green runs of the error/stale/stop browser tests before C6 merges); **R33** (L0-L3 also green on a second host, CI Linux).

### 17.3 Does any phase need another live test? No.

C1-C5 and C7-C9 do not change what is sent to or received from the provider (C3's edit to `chatgpt-plan.ts` is an error-message string only). **C6 changes wiring, not the provider path:** `DotAgent` → TanStack adapter → ChatGPT Plan is untouched, and P2b-0 already ran that exact `DotAgent` against the real service with a durable runner. **Do not assume P2b-0 must be rerun.** Re-run a **P2b-0-shaped, three-request** test **only if** something that shapes the provider conversation changes before release: the adapter construction or its fetch wrapper in `chatgpt-plan.ts`, the `modelOptions` it passes, `chatgpt-devkit.ts`, `siwc-compat.ts`, or the version of `@tanstack/ai*` or `@copilotkit/runtime`. It needs the owner's explicit approval. Not covered by any plan: a real Voice Realtime session, and R28 (real-provider acceptance of a recovered partial-arguments history).

---

## 18. Risk map

Gates: **before integration** = resolved or decided before C6 merges; **before shipping** = resolved before the first release that makes local-first the default; **may defer** = may stay open after v1, documented. No risk is closed merely because the PoC passed.

### 18.1 Must resolve before production integration

| Risk        | What                                                                                                                                                                    | Phase      | Disposition                                                                                                                                                                                                                                                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TELEM-ORDER | Telemetry import-order fragility (latched at import; first event at runtime construction)                                                                               | C1         | Resolved by C1: guard-first contract tested by evaluation-order simulation, a subprocess trap against the built entry, and negative controls. Re-run on every CopilotKit upgrade.                                                                                                                                                   |
| R10         | Dependence on the semi-public local-thread marker and on exact SDK behaviour (caret ^1.75.0 ranges)                                                                     | C4         | C4 adds an L0 contract test of the installed SDK (AgentRunner shape, marker, CopilotSseRuntime option behaviour, thread-route behaviour, /info mode). Decision requested: pin @copilotkit/runtime exactly (a dependency edit; not done here).                                                                                       |
| R16         | The PoC runner reaches the WorkspaceStore database connection through a private field                                                                                   | C4         | Resolved by design: WorkspaceStore.openConversationLog() (the existing sub-store pattern of Pages/ComputerStore), lazy so C4 changes no database.                                                                                                                                                                                   |
| R20/R21     | Framework re-runs a tool call that has no result in the history it is given; the stale-tool interlock is provisional and its source was lost (rebuild interpretation a) | C4, C5     | C4 must define the interlock contract from first principles and test it: refuse an input that omits a tool result the log holds (stale tab); ACCEPT a prompt-only input on a thread with tool history (headless). UX of the refusal stays generic (see R37).                                                                        |
| R23         | Client/server tool classification depends on tools declared in the persisted RUN_STARTED.input.tools                                                                    | C4         | C4 contract test: the same tool name declared vs not declared recovers differently; the fixture is the production review_space_page.                                                                                                                                                                                                |
| R34         | Same-process behaviour after a cache-write failure                                                                                                                      | C4, C6, C8 | Decided here: never fail the run; OpenDots readers go through messagesFor() which derives from the authoritative log while the cache is stale; one bounded single-flight repair attempt, then the next finalization catches up; only the SDK synchronous messages endpoint fails closed (OpenDots does not call it). See section 9. |
| R36         | Busy headless scheduling policy                                                                                                                                         | C5, C6     | Decision requested; recommended: fail loudly, no automatic retry (parity with the legacy "Thread already running"). Consequence to accept: Store.fail leaves the task failed and a repeating task stops until the owner presses Run.                                                                                                |

### 18.2 Must resolve before shipping

| Risk      | What                                                                                                | Phase         | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OWNER-OPT | OWNER_TOKEN optional on loopback (boundary = Host/Origin/Sec-Fetch-Site only)                       | C2            | Resolved by C2 (required everywhere, >=24 characters, fail-fast).                                                                                                                                                                                                                                                                                                                                                                                               |
| R26       | complete_text_without_terminal stays "running" and unclassified                                     | C4            | Small extension in C4 (classifier + real-SIGKILL test). The window is between TEXT_MESSAGE_END and RUN_FINISHED under W1.                                                                                                                                                                                                                                                                                                                                       |
| R35       | Boot verification derives every thread in full (about 377-465 ms p50 per 100-turn thread)           | C8            | Staged: boot = O(threads) checkpoint and payload-hash verification; first touch after boot = full authoritative derivation before any incremental use; authority is never weakened. Not needed while C4 uses the full-rebuild policy (its boot compares ids only).                                                                                                                                                                                              |
| R37       | Browser loser UX (busy thread)                                                                      | C6            | Not silent today: the client shows its NO_RESPONSE banner. Parity gap: the legacy path answered HTTP 409 -> client AgentThreadLockedError. Recommended: advisory 409 in Platform.handle. L4 asserts a visible message.                                                                                                                                                                                                                                          |
| D3        | Stale error banner when a historical RUN_ERROR replays (R3/R29/R30); seam never built in production | outside I1-I7 | Reproduced by P5 M8. The P2a-6 client seam is not production-approved (R29 live-join misclassification, R30 core internals). A usage-limit error would re-appear on every open of that thread. Whether the legacy Intelligence path replayed errors the same way is unknown (P2a design 8.3); if it did not, local replay introduces a visible regression. Decide a mechanism (client seam vs a server replay filter) as an added commit; needs owner approval. |
| R17       | Active-run exclusion is process-local; two server processes on one database are unsupported         | C6            | Document as a deployment constraint (single process per database). By construction (BEGIN IMMEDIATE, UNIQUE(threadId, runId, seq), per-run ordering, append-only rows) a second writer interleaves runs rather than corrupting rows, but that was NEVER tested with two processes, so R17 stays open. A pid/lock file is a deferred option.                                                                                                                     |
| VOICE-CSP | Voice/WebRTC is outside CSP; a real Realtime session was never exercised in P5                      | C7            | Documented egress exception for an optional provider-gated feature; connect-src cannot confine WebRTC. Gate: the Voice UI stays disabled without VOICE_API_KEY/VOICE_MODEL; no browser-direct third-party origin in src/client. A live Voice test is not part of this plan.                                                                                                                                                                                     |
| RESIDUAL  | Residual Intelligence source paths                                                                  | C6, C7, C9    | Reachability gate at C6 (no class-A symbol reachable from any entry point); CSP origin and UI at C7; deletion at C9. Do not write "removed" until C9 lands. The SDK package itself still contains Intelligence code that is loaded but never constructed.                                                                                                                                                                                                       |
| R31       | One unexplained non-reproducible test failure (p2a-6, C1 then C2)                                   | C6            | Cannot be explained retroactively. Gate: no recurrence in 10 consecutive runs of the production error/stale/stop browser tests; any recurrence is recorded and investigated, never retried silently.                                                                                                                                                                                                                                                            |
| R33       | V8 crashes on the measurement host (SIGSEGV/SIGTRAP/SIGABRT)                                        | C4, C6, C8    | Environmental, not a product defect. Gate: L0-L3 also green on a second host (CI Linux); on this host the harness policy (restart roles that die before starting; retry whole tests only on HostInstabilityError; record every crash) is used.                                                                                                                                                                                                                  |

### 18.3 May defer after local-first v1

| Risk          | What                                                                                                        | Phase | Disposition                                                                                                                                                                                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DEV-INSPECTOR | Dev-server inspector path never run (npm run dev, NODE_ENV=development)                                     | C1    | enableInspector={false} added in C1 (source-level assertion; shouldEnableInspector requires enableInspector !== false). A real dev-server Chromium run is still untested and may be deferred; the shipped production bundle mounts no inspector (P5: 0 requests). |
| OWNER-STORE   | Owner token kept in browser sessionStorage                                                                  | C2    | Accepted for v1 under conditions (script-src self retained, no HTML injection sinks, token never in URL/logs/DOM, documented). Not a ship blocker. Upgrade path: server-issued HttpOnly SameSite=Strict session (a redesign, deferred).                           |
| R22/R24       | Mixed pending (client + server) and open-text-with-pending lifecycles stay unrecovered                      | C4    | Rare shapes; remain unprotected and documented. Not closed.                                                                                                                                                                                                       |
| R38           | Headless error-code propagation                                                                             | C5    | Keep RUN_ERROR.code durable (already) and on the thrown error object; no caller consumes it in v1; the message-only contract is unchanged.                                                                                                                        |
| R28           | Real-provider acceptance of a recovered tool_args_incomplete history (partial JSON arguments) is unverified | C4    | Rare crash shape; only a fake model accepted it. Would need a live call; not part of this plan.                                                                                                                                                                   |
| R15           | Retention and growth of the plaintext conversation log                                                      | C6    | No pruning in v1; documented. Event size growth (R7) and replay cost (R6) were measured acceptable at 100 turns.                                                                                                                                                  |

### 18.4 Resolved by the design (with their tests)

- R16: explicit sub-store seam instead of a private-field read.
- `docs/CHATGPT_PLAN_PHASE6.md` pending item "Intelligence platform preserves `RUN_ERROR.code`": moot on the local path; the durable runner stores and replays every event verbatim (P2a goldens).
- Dependence on a remote conversation service for chat, history, page conversations and scheduled turns.
- TELEM-ORDER and OWNER-OPT, by C1 and C2.

---

## 19. Deferred items

- Auto-generated persistent owner token; server-issued `HttpOnly` session (OWNER-STORE).
- Defer-and-retry for a busy scheduled turn (needs a backoff column or a Store change).
- Lazy on-demand cache instead of an eager one (Option N; costed in C8).
- Background cache verifier; an operator `verify` command.
- A pid/lock file for single-process enforcement (R17).
- Thread labelling for legacy Intelligence threads (DEC-8); any import of old Intelligence history (would reintroduce the dependency).
- Cross-run encrypted reasoning continuation (D1; P2a-9 and P2b-1 stay HOLD).
- A real dev-server inspector run, a real Voice Realtime session, `Permissions-Policy`.
- Retention/pruning of the conversation log (R15).
- Mixed pending lifecycles (R22/R24).

### 19.1 The prunable `/private/tmp` worktrees

**No evidentiary value remains.** Git lists four, all prunable (their directories are gone). Their administrative directories under `.git/worktrees/` each hold `HEAD`, `ORIG_HEAD`, `gitdir`, `commondir`, `logs` and a 20 KB `index`. Read-only, on copies, the four indexes were compared with the tree of their own HEAD: **211, 211, 213 and 214 entries, 0 differing lines**. Nothing was ever staged that is not in a commit, so no scratch content can be recovered from that metadata, and the three commits they point at (`dd7492a`, `61b257c`, `aa2a415`) are ancestors of main. **Recommendation: `git worktree prune` after this design is accepted; no action now.** They were not used or pruned in this phase.

---

## 20. GO / HOLD for implementation

| Scope                                 | Decision                                                               | Why                                                                                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **C1** telemetry first-import guard   | **GO**                                                                 | Independent, no data, and it must exist before C4. Needs DEC-1 and the vitest setup file in DEC-12.                                         |
| **C2** owner boundary                 | **GO** after DEC-2                                                     | A one-time `.env` edit for tokenless loopback installs is the only cost.                                                                    |
| **C3** DotAgent guard                 | **GO**                                                                 | Behaviour-preserving on the legacy path; two test text pins to update.                                                                      |
| **C4, C5** dormant runner and adapter | **HOLD** pending DEC-4 to DEC-6, DEC-9, DEC-12                         | They fix the schema, the R34 policy, the interlock contract and the SDK pin. Once decided they are safe to land because nothing calls them. |
| **C6** activation                     | **HOLD** pending DEC-3, DEC-7, DEC-8 and every before-integration risk | The one-way door. Do not merge until the full ladder, the upgrade fixture and the backup restore pass.                                      |
| **C7, C8, C9**                        | **HOLD** behind C6                                                     | C8 also needs the Option N cost study; C9b needs DEC-11.                                                                                    |
| **Shipping**                          | **HOLD**                                                               | Needs the before-shipping risks resolved, DEC-10 (D3) decided, and the second-host and R31 gates.                                           |

### 20.1 Decisions requested

| Id     | Decision requested                                                                                                                        | Recommended                                            | Blocks                                  |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------- |
| DEC-1  | Telemetry is overridden unconditionally; COPILOTKIT_TELEMETRY_DISABLED=false is ignored                                                   | approve                                                | C1                                      |
| DEC-2  | OWNER_TOKEN (>=24 chars) required on every binding including loopback; no opt-out                                                         | approve                                                | C2                                      |
| DEC-3  | R36 busy headless policy: fail loudly, no automatic retry (a repeating task stops until Run)                                              | approve                                                | C6 wiring                               |
| DEC-4  | R34 policy: the run never fails on a cache-write failure; OpenDots readers fall back to the authoritative log; one bounded repair attempt | approve                                                | C4                                      |
| DEC-5  | Interlock contract: refuse a stale-tab input that omits a recorded tool result; accept a prompt-only headless input                       | approve                                                | C4                                      |
| DEC-6  | Schema: three tables, production camelCase naming, no version table, checkpoint columns deferred to C8                                    | approve                                                | C4                                      |
| DEC-7  | One-time pre-activation backup of the SQLite file (VACUUM INTO, mode 0600, never auto-deleted)                                            | approve                                                | C6                                      |
| DEC-8  | Legacy Intelligence threads: leave visible and empty (document), or label them (needs a nullable origin column)                           | leave visible and document; label later only if wanted | C6 (cosmetic)                           |
| DEC-9  | Pin @copilotkit/runtime to an exact version (a dependency edit)                                                                           | pin exact                                              | C4 (needs explicit dependency approval) |
| DEC-10 | D3 stale-banner mechanism (client seam vs server replay filter) and whether it is v1 scope                                                | add a commit; evaluate both                            | shipping                                |
| DEC-11 | Remove @copilotkit/channels and the direct @copilotkit/core dependency                                                                    | approve at C9b                                         | C9b                                     |
| DEC-12 | New npm scripts/CI jobs (test:crash, test:browser, test:egress) and a vitest setup file (vite.config.ts test block)                       | approve                                                | C1 (setup file) and C4+                 |

### 20.2 Approval gates (things this review did not and will not do on its own)

Any `package.json`/lockfile edit (DEC-9, DEC-11); a new migration reaching a real database; new npm scripts and CI jobs (DEC-12); any live or network call; copying this document to main; pruning worktrees.

**Stop here.** Nothing is implemented. P2a-9 and P2b-1 were not started.

---

## Appendix A. Details the PoC did not validate

These are the places the production code deliberately deviates from, or adds to, the reconstructed runner and the P5 candidate. Each has a test in its commit.

| Id   | Not validated by the PoC (new design)                                                                                                              | Commit | How it is tested                                                       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------- |
| P-1  | Runner refuses an unbound thread or an agent that does not own the thread (defence in depth behind validateRuntimeScope)                           | C4     | L2: unbound id and cross-Dot id rejected, provider 0, durable writes 0 |
| P-2  | clearThreads() refuses (the SDK threads/clear route calls it; only validateRuntimeScope denies the route today)                                    | C4     | L1 direct call leaves rows untouched; L2 route 403                     |
| P-3  | messagesFor() reader seam with authoritative fallback (R34)                                                                                        | C4     | L1/L3 fault injection in the cache transaction; readers still correct  |
| P-4  | stopAll() on graceful shutdown (finalize active runs within the existing 8 s deadline)                                                             | C4/C6  | L3 SIGTERM mid-run -> status stopped, not interrupted                  |
| P-5  | R26 classification (complete text without terminal)                                                                                                | C4     | L3 real SIGKILL between TEXT_MESSAGE_END and RUN_FINISHED              |
| P-6  | Production column naming (threadId, runId, createdAt style) instead of the PoC snake_case; index (threadId, id) instead of (thread_id, event_type) | C4     | L0 DDL snapshot                                                        |
| P-7  | Interlock contract written explicitly (stale browser history refused; prompt-only headless input accepted)                                         | C4     | L2 both directions on a thread with tool history                       |
| P-8  | Typed ThreadBusyError and RUN_ERROR.code carried on the headless error object                                                                      | C5     | L1                                                                     |
| P-9  | Advisory HTTP 409 for a busy thread in Platform.handle (restores the legacy client path)                                                           | C6     | L4: the client shows its locked-thread message                         |
| P-10 | Pre-activation backup of the SQLite file (VACUUM INTO, 0600, once)                                                                                 | C6     | L3 backup opens and equals the pre-activation logical hash             |
| P-11 | Database file modes 0600 (and 0700 for a directory the app creates)                                                                                | C6     | L5/L2 stat of db, wal, shm                                             |
| P-12 | Per-thread quarantine for an impossible checkpoint instead of a boot-time throw                                                                    | C8     | L3 other threads still serve                                           |
| P-13 | First-touch authoritative verification replacing the every-boot full derivation                                                                    | C8     | L3 boot timing and equality with the oracle                            |
| P-14 | Server rejects NEW learning enablement (400) while tolerating stored legacy values                                                                 | C7     | L1/L2 route tests                                                      |
| P-15 | Legacy "pending Intelligence sync" call-error marker still matched after the wording changes                                                       | C7     | voice.test.ts with a legacy row                                        |

## Appendix B. Source anchors (verified when the evidence was generated)

| Anchor                         | Location                             | Text                                                                                                                                                     |
| ------------------------------ | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| dot-agent.ts#guard             | `src/server/dot-agent.ts:84`         | `if (!this.config.intelligenceKey \|\| !provider.configured)`                                                                                            |
| dot-agent.ts#learned-skills    | `src/server/dot-agent.ts:197`        | `learnedSkills:`                                                                                                                                         |
| dot-agent.ts#max-iterations    | `src/server/dot-agent.ts:230`        | `agentLoopStrategy: maxIterations(`                                                                                                                      |
| dot-agent.ts#learned-tools     | `src/server/dot-agent.ts:238`        | `...learnedSkillTools(ctx, check),`                                                                                                                      |
| dot-agent.ts#watch-learning    | `src/server/dot-agent.ts:96`         | `current.learningContainerId !== dot.learningContainerId \|\|`                                                                                           |
| dot-agent.ts#channel-param     | `src/server/dot-agent.ts:35`         | `private channel = false,`                                                                                                                               |
| dot-agent.ts#timeout-90s       | `src/server/dot-agent.ts:60`         | `const timeout = setTimeout(() => this.abortRun(), 90_000);`                                                                                             |
| headless.ts#mode-literal       | `src/server/headless.ts:18`          | `mode: z.literal('intelligence'),`                                                                                                                       |
| headless.ts#intelligence-agent | `src/server/headless.ts:41`          | `const agent = new IntelligenceAgent({`                                                                                                                  |
| headless.ts#current-turn-text  | `src/server/headless.ts:7`           | `export function currentTurnText(messages: Message[], error?: Error): string {`                                                                          |
| headless.ts#info-fetch         | `src/server/headless.ts:33`          | `const response = await fetch('${runtimeUrl}/info', { headers, signal });`                                                                               |
| index.ts#token-startup         | `src/server/index.ts:21`             | `'External binding requires an OWNER_TOKEN of at least 24 characters.',`                                                                                 |
| index.ts#intel-env             | `src/server/index.ts:67`             | `intelligenceKey: process.env.INTELLIGENCE_API_KEY,`                                                                                                     |
| index.ts#slack-env             | `src/server/index.ts:83`             | `slackChannel: process.env.SLACK_CHANNEL_NAME,`                                                                                                          |
| index.ts#ws-origin             | `src/server/index.ts:117`            | `config.intelligenceWsUrl ?? 'wss://realtime.intelligence.copilotkit.ai',`                                                                               |
| index.ts#csp                   | `src/server/index.ts:137`            | `'default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${wsOrigin}; media-src 'self' blob:` |
| index.ts#scheduler-turn        | `src/server/index.ts:112`            | `const text = await platform.turn(threadId, claim.prompt, signal);`                                                                                      |
| index.ts#legacy-task-text      | `src/server/index.ts:109`            | `'This legacy task has no Intelligence conversation. Create a new scheduled task from a conversation.',`                                                 |
| index.ts#platform-new          | `src/server/index.ts:93`             | `const platform = new Platform(store, workspace, config);`                                                                                               |
| index.ts#listen                | `src/server/index.ts:144`            | `const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {`                                                                           |
| index.ts#store-new             | `src/server/index.ts:24`             | `const store = new Store(database);`                                                                                                                     |
| index.ts#workspace-new         | `src/server/index.ts:25`             | `const workspace = new WorkspaceStore(`                                                                                                                  |
| index.ts#shutdown              | `src/server/index.ts:159`            | `const shutdown = createShutdown({`                                                                                                                      |
| index.ts#models-new            | `src/server/index.ts:40`             | `const models = new ModelService({`                                                                                                                      |
| index.ts#scheduler-new         | `src/server/index.ts:102`            | `const runner = new Runner(`                                                                                                                             |
| app.ts#token-check             | `src/server/app.ts:59`               | `if (ownerToken) {`                                                                                                                                      |
| app.ts#host-allowlist          | `src/server/app.ts:52`               | `return c.json({ error: 'Unrecognized host.' }, 403);`                                                                                                   |
| app.ts#origin                  | `src/server/app.ts:56`               | `return c.json({ error: 'Cross-origin requests are not allowed.' }, 403);`                                                                               |
| app.ts#sec-fetch               | `src/server/app.ts:58`               | `return c.json({ error: 'Cross-site requests are not allowed.' }, 403);`                                                                                 |
| app.ts#json-only               | `src/server/app.ts:77`               | `return c.json({ error: 'Use application/json.' }, 415);`                                                                                                |
| platform.ts#early-return       | `src/server/platform.ts:39`          | `if (!config.intelligenceKey) return;`                                                                                                                   |
| platform.ts#intelligence-new   | `src/server/platform.ts:40`          | `this.intelligence = new CopilotKitIntelligence({`                                                                                                       |
| platform.ts#runtime            | `src/server/platform.ts:63`          | `const runtime = new CopilotRuntime({`                                                                                                                   |
| platform.ts#handler            | `src/server/platform.ts:81`          | `this.handler = createCopilotHonoHandler({`                                                                                                              |
| platform.ts#thread-names       | `src/server/platform.ts:79`          | `generateThreadNames: true,`                                                                                                                             |
| platform.ts#agents-factory     | `src/server/platform.ts:75`          | `new DotAgent(store, workspace, config, dot.id),`                                                                                                        |
| platform.ts#slack-agent        | `src/server/platform.ts:59`          | `agent: () => new DotAgent(store, workspace, config, dotId, true),`                                                                                      |
| platform.ts#create-thread      | `src/server/platform.ts:121`         | `await this.intelligence!.createThread({`                                                                                                                |
| platform.ts#history            | `src/server/platform.ts:137`         | `const history = await this.intelligence!.getThreadMessages({`                                                                                           |
| platform.ts#handle-503         | `src/server/platform.ts:154`         | `{ error: 'Setup required: INTELLIGENCE_API_KEY.' },`                                                                                                    |
| platform.ts#scope              | `src/server/platform.ts:164`         | `validateRuntimeScope(request, this.workspace, body);`                                                                                                   |
| platform.ts#turn               | `src/server/platform.ts:186`         | `return runThreadTurn(`                                                                                                                                  |
| platform.ts#pages              | `src/server/platform.ts:35`          | `this.pages = new PageService(workspace, () => {`                                                                                                        |
| platform.ts#imports            | `src/server/platform.ts:9`           | `} from '@copilotkit/runtime/v2';`                                                                                                                       |
| platform-config.ts#gate        | `src/server/platform-config.ts:35`   | `!config.intelligenceKey && 'INTELLIGENCE_API_KEY',`                                                                                                     |
| runtime-scope.ts#suggest       | `src/server/runtime-scope.ts:29`     | `else if ((match = path.match(/^agent\/([^/]+)\/(run\|connect\|suggest)$/))) {`                                                                          |
| runtime-scope.ts#reserved      | `src/server/runtime-scope.ts:47`     | `'clear',`                                                                                                                                               |
| page-service.ts#port           | `src/server/page-service.ts:4`       | `export interface PageIntelligence {`                                                                                                                    |
| page-service.ts#get-or-create  | `src/server/page-service.ts:71`      | `sdk.getOrCreateThread({`                                                                                                                                |
| page-service.ts#save-history   | `src/server/page-service.ts:105`     | `this.intelligence().getThreadMessages({`                                                                                                                |
| voice.ts#history-call          | `src/server/voice.ts:65`             | `.history(threadId)`                                                                                                                                     |
| voice.ts#compute-turn          | `src/server/voice.ts:184`            | `const pending = this.platform.turn(`                                                                                                                    |
| voice.ts#receipt-turn          | `src/server/voice.ts:222`            | `await this.platform.turn(`                                                                                                                              |
| voice.ts#marker-write          | `src/server/voice.ts:217`            | `'Transcript saved locally; pending Intelligence sync until workspace resumes.',`                                                                        |
| voice.ts#marker-match          | `src/server/voice.ts:237`            | `if (call.error?.includes('pending Intelligence sync')) {`                                                                                               |
| voice.ts#realtime-url          | `src/server/voice.ts:108`            | `'https://api.openai.com/v1/realtime/calls',`                                                                                                            |
| workspace.ts#thread-bindings   | `src/server/workspace.ts:22`         | `CREATE TABLE IF NOT EXISTS thread_bindings(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, ownerId TEXT NOT NULL, title TEXT NOT NULL, createdAt INTEGER NOT` |
| workspace.ts#alter-learning    | `src/server/workspace.ts:27`         | `['dots', 'learningContainerId', 'TEXT'],`                                                                                                               |
| workspace.ts#private-db        | `src/server/workspace.ts:10`         | `private db: DatabaseSync;`                                                                                                                              |
| workspace.ts#pages-substore    | `src/server/workspace.ts:53`         | `this.pages = new Pages(this.db, (id) =>`                                                                                                                |
| store.ts#fail                  | `src/server/store.ts:297`            | `fail(claim: Claim, error: string) {`                                                                                                                    |
| store.ts#claim                 | `src/server/store.ts:241`            | `"SELECT * FROM tasks WHERE status='queued' OR (status='completed' AND nextRunAt IS NOT NULL AND nextRunAt<=?) ORDER BY createdAt LIMIT 1",`             |
| store.ts#release               | `src/server/store.ts:292`            | `release(claim: Claim, reason: string) {`                                                                                                                |
| api.ts#session                 | `src/client/api.ts:1`                | `let token = sessionStorage.getItem('opendots-token') ?? '';`                                                                                            |
| App.tsx#provider               | `src/client/App.tsx:929`             | `<CopilotKitProvider runtimeUrl="/api/copilotkit" headers={authHeaders()}>`                                                                              |
| App.tsx#unlock                 | `src/client/App.tsx:241`             | `<button className="primary">Unlock OpenDots</button>`                                                                                                   |
| App.tsx#slack-status           | `src/client/App.tsx:706`             | `Slack · {workspace.setup.slack.replaceAll('_', ' ')}`                                                                                                   |
| App.tsx#configured             | `src/client/App.tsx:175`             | `const configured = !!workspace && workspace.setup.missing.length === 0;`                                                                                |
| WorkspaceDialog.tsx#learning   | `src/client/WorkspaceDialog.tsx:310` | `<legend>Automatic Learning</legend>`                                                                                                                    |
| Chat.tsx#no-response           | `src/client/Chat.tsx:160`            | `setError(noResponseError);`                                                                                                                             |
| chat-error.ts#no-response      | `src/client/chat-error.ts:39`        | `'The current turn returned no response. Check the runtime connection and retry.';`                                                                      |
| compose.yml#token              | `compose.yml:9`                      | `OWNER_TOKEN: ${OWNER_TOKEN:?Set a 24+ character OWNER_TOKEN in .env}`                                                                                   |
| compose.yml#intelligence       | `compose.yml:12`                     | `INTELLIGENCE_API_KEY: ${INTELLIGENCE_API_KEY:-}`                                                                                                        |
| Dockerfile#host                | `Dockerfile:9`                       | `ENV NODE_ENV=production HOST=0.0.0.0 PORT=4310 DATABASE_PATH=/data/opendots.sqlite`                                                                     |
| .env.example#intelligence      | `.env.example:12`                    | `INTELLIGENCE_API_KEY=`                                                                                                                                  |
| package.json#runtime           | `package.json:33`                    | `"@copilotkit/runtime": "^1.75.0",`                                                                                                                      |
| private-fs.ts#ensure           | `src/server/private-fs.ts:16`        | `export async function ensurePrivateDir(directory: string) {`                                                                                            |
| tsconfig.server.json#nodenext  | `tsconfig.server.json:7`             | `"module": "NodeNext",`                                                                                                                                  |
| package.json#build             | `package.json:12`                    | `"build": "vite build && tsc -p tsconfig.server.json",`                                                                                                  |
| package.json#start             | `package.json:13`                    | `"start": "node --env-file-if-exists=.env dist/server/server/index.js",`                                                                                 |
| package.json#dev               | `package.json:11`                    | `"dev": "concurrently -k \"NODE_ENV=development node --env-file-if-exists=.env --import tsx --watch src/server/index.ts\" \"vite\"",`                    |

| SDK anchor (installed 1.75.0, not part of the commit) | Location                                                                   | Text                                                                                                                                                                               |
| ----------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sse-runtime-throws-on-channels                        | `@copilotkit/runtime/dist/v2/runtime/core/runtime.mjs:64`                  | `if (Array.isArray(channels) && channels.length > 0) throw new Error("'channels' requires the Intelligence runtime (pass 'intelligence'); Intelligence Channels are not ava`       |
| sse-runtime-throws-on-learning                        | `@copilotkit/runtime/dist/v2/runtime/core/runtime.mjs:65`                  | `if (options.ɵlearning !== void 0) throw new Error("'ɵlearning' requires the Intelligence runtime (pass 'intelligence'); Learning Containers are not available in SSE mode.`       |
| sse-runtime-default-runner                            | `@copilotkit/runtime/dist/v2/runtime/core/runtime.mjs:66`                  | `super(options, options.runner ?? new InMemoryAgentRunner());`                                                                                                                     |
| intelligence-runtime-rejects-runner                   | `@copilotkit/runtime/dist/v2/runtime/core/runtime.mjs:80`                  | `if (rawOptions.runner !== void 0) throw new Error("Intelligence Runtime auto-wires its own 'runner'; passing 'runner' alongside 'intelligence' is not supported. Durabilit`       |
| copilotruntime-shim-delegate                          | `@copilotkit/runtime/dist/v2/runtime/core/runtime.mjs:139`                 | `this.delegate = hasIntelligenceOptions(options) ? new CopilotIntelligenceRuntime(options) : new CopilotSseRuntime(options);`                                                      |
| copilotruntime-legacy-comment                         | `@copilotkit/runtime/dist/v2/runtime/core/runtime.mjs:131`                 | `* New code should prefer 'CopilotSseRuntime' or 'CopilotIntelligenceRuntime'.`                                                                                                    |
| runtime-telemetry-disclosure                          | `@copilotkit/runtime/dist/v2/runtime/core/runtime.mjs:35`                  | `logRuntimeTelemetryDisclosure();`                                                                                                                                                 |
| telemetry-singleton                                   | `@copilotkit/runtime/dist/v2/runtime/telemetry/telemetry-client.mjs:106`   | `const telemetry = new TelemetryClient();`                                                                                                                                         |
| telemetry-latch-at-construction                       | `@copilotkit/runtime/dist/v2/runtime/telemetry/telemetry-client.mjs:20`    | `this.telemetryDisabled = telemetryDisabled \|\| isTelemetryDisabled();`                                                                                                           |
| telemetry-env-values                                  | `@copilotkit/runtime/dist/v2/runtime/telemetry/telemetry-client.mjs:10`    | `return process.env.COPILOTKIT_TELEMETRY_DISABLED === "true" \|\| process.env.COPILOTKIT_TELEMETRY_DISABLED === "1" \|\| process.env.DO_NOT_TRACK === "true" \|\| process.env.DO_` |
| telemetry-sink-const                                  | `@copilotkit/shared/dist/telemetry/lambda-client.mjs:2`                    | `const TELEMETRY_SINK_URL = typeof process !== "undefined" && process.env?.COPILOTKIT_TELEMETRY_URL \|\| "https://telemetry.copilotkit.ai/ingest";`                                |
| channel-telemetry-writes-install-id                   | `@copilotkit/channels-core/dist/telemetry/install-id.js:36`                | `writeFileSync(file, id, "utf8");`                                                                                                                                                 |
| channel-telemetry-disabled-test                       | `@copilotkit/channels-core/dist/telemetry/channel-telemetry.js:31`         | `this.disabled = opts.disabled ?? (isTelemetryDisabled() \|\| isTestEnv());`                                                                                                       |
| info-mode                                             | `@copilotkit/runtime/dist/v2/runtime/handlers/get-runtime-info.mjs:91`     | `mode: runtime.mode,`                                                                                                                                                              |
| threads-list-local                                    | `@copilotkit/runtime/dist/v2/runtime/handlers/intelligence/threads.mjs:63` | `if (supportsLocalThreadEndpoints(runtime.runner)) {`                                                                                                                              |
| threads-update-needs-intelligence                     | `@copilotkit/runtime/dist/v2/runtime/handlers/intelligence/threads.mjs:87` | `async function handleUpdateThread({ runtime, request, threadId }) {`                                                                                                              |
| threads-require-intelligence-422                      | `@copilotkit/runtime/dist/v2/runtime/handlers/intelligence/threads.mjs:19` | `if (!isIntelligenceRuntime(runtime)) return errorResponse("Missing CopilotKitIntelligence configuration. Thread operations require a CopilotKitIntelligence instance to be`       |
| threads-clear-calls-runner                            | `@copilotkit/runtime/dist/v2/runtime/handlers/intelligence/threads.mjs:84` | `if (supportsLocalThreadEndpoints(runtime.runner)) runtime.runner.clearThreads();`                                                                                                 |
| suggest-bypasses-runner                               | `@copilotkit/runtime/dist/v2/runtime/handlers/handle-suggest.mjs:15`       | `* It deliberately does not go through 'runtime.runner': the runner's`                                                                                                             |
| sse-run-calls-runner                                  | `@copilotkit/runtime/dist/v2/runtime/handlers/sse/run.mjs:18`              | `observableFactory: () => runtime.runner.run({`                                                                                                                                    |
| intelligence-runner-busy-throw                        | `@copilotkit/runtime/dist/v2/runtime/runner/intelligence.mjs:116`          | `if (this.threads.get(threadId)?.isRunning) throw new Error("Thread already running");`                                                                                            |
| intelligence-lock-409                                 | `@copilotkit/runtime/dist/v2/runtime/handlers/intelligence/run.mjs:98`     | `return Response.json({ error: "Thread lock denied" }, { status: platformStatus === 409 ? 409 : 502 });`                                                                           |
| client-409-locked                                     | `@copilotkit/core/dist/index.mjs:405`                                      | `if (response.status === 409 && mode === "run") throw new AgentThreadLockedError(input.threadId);`                                                                                 |
| client-locked-message                                 | `@copilotkit/core/dist/index.mjs:215`                                      | `super(threadId ? 'Thread ${threadId} is locked' : "Thread is locked");`                                                                                                           |
| inspector-gate                                        | `@copilotkit/shared/dist/utils/inspector-visibility.mjs:7`                 | `return isBrowser && isDevelopment && enableInspector !== false;`                                                                                                                  |
| inspector-telemetry-url                               | `@copilotkit/web-inspector/dist/lib/telemetry.mjs:50`                      | `const TELEMETRY_INGEST_URL = "https://telemetry.copilotkit.ai/ingest";`                                                                                                           |
| provider-mounts-inspector                             | `@copilotkit/react-core/dist/copilotkit-CoWG8EAX.mjs:3376`                 | `setShouldRenderInspector(shouldEnableInspector({`                                                                                                                                 |
| router-suffix-match                                   | `@copilotkit/runtime/dist/v2/runtime/core/fetch-router.mjs:47`             | `if (len >= 3 && segments[len - 3] === "agent" && segments[len - 1] === "suggest") {`                                                                                              |
