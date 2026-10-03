# ChatGPT plan provider: Phase 6 closeout

This is the record of Phase 6 of the [ChatGPT plan model provider](CHATGPT_PLAN.md): what was done, what was observed on a real account, which decisions were deliberate, and the one acceptance still open. It covers the implementation up to commit `d190cd86953f31bafe0e77ec9f8428077d412318` on branch `feat/chatgpt-plan-provider`. The contract itself (what is public, what is not, how compatibility is decided) stays in `CHATGPT_PLAN.md`.

| Part                                             | Status                    | Commit                                     |
| ------------------------------------------------ | ------------------------- | ------------------------------------------ |
| 6A: DevKit compatibility hardening               | Complete                  | `5772a9083c4bd04af315720a81aae584896ff2dc` |
| 6B-1: `RUN_ERROR` code preservation              | Complete                  | `91923232b53c2b7c2d3007a6b439b533d44aad55` |
| 6B-2: Client usage-limit UX                      | Complete                  | `d190cd86953f31bafe0e77ec9f8428077d412318` |
| Astra external acceptance                        | Pass                      |                                            |
| Intelligence platform preserves `RUN_ERROR.code` | **Pending** (see the end) |                                            |

## Phase 6A: DevKit compatibility hardening

Status: **complete.** Commit `5772a9083c4bd04af315720a81aae584896ff2dc`.

The Sign in with ChatGPT DevKit has no published releases, and OpenDots reads part of its internal state, so Phase 6A made every assumption explicit and made OpenDots stop when one stops holding. The details are in [DevKit compatibility contract](CHATGPT_PLAN.md#devkit-compatibility-contract); in short:

- **Runtime contract, with a fingerprint on top.** A DevKit is judged by what it does: the exports and client methods OpenDots uses, the saved state's shape, and the refresh postcondition. A build is additionally fingerprinted (SHA-256 of selected `dist/` files, and an aggregate) and compared with `VERIFIED_DEVKIT_BUILDS`. The fingerprint never decides compatibility by itself.
- **`verified`, `untested`, strict.** A contract that holds on a recorded build is `verified`. A contract that holds on an unrecorded build is `untested`: it is used normally, with a notice in the Model dialog and in `status`. `CHATGPT_DEVKIT_STRICT=1` refuses `untested` builds, and does so before any of the build's code is imported. A contract that fails is `devkit_incompatible` and is refused with the reason.
- **Two formats, two versions.** The auth envelope (`chatgpt-auth.json`) is version `3`; the stored state it decrypts to is version `2`. They are checked separately. An envelope OpenDots does not recognize is never decrypted, read, migrated, written or reset, and never reaches the DevKit.
- **`TokenSource` seam.** The access token is read from the DevKit's stored state behind one interface, `TokenSource`. It is the only deliberate use of DevKit internals, and what gets removed if the DevKit gains a public token API.
- **Refresh postcondition.** OpenDots never refreshes OAuth tokens itself. After asking the DevKit to refresh, it reads the state again and requires a token with at least 30 s left. A successful `listModels()` is not taken as proof.
- **Status classification.** An unknown connection status, or an error beside a signed-out status that the saved state does not explain, is `unavailable`, not signed out.
- **One DevKit layout.** A single explicit layout contract (`DEVKIT_LAYOUT`, `DEVKIT_FINGERPRINT_FILES`) is shared by the code and the tests that need it.
- **Model catalog validation.** The DevKit's model list is accepted whole or not at all. A malformed or ambiguous entry fails the whole list (`invalid_model_catalog`); the last good list stays, marked stale.
- **Shim compatibility tripwire.** `siwc-compat.ts` (the `stop` to `tool_calls` correction) is covered by behavioural contract tests in `tests/siwc-contract.test.ts` and probed on a real account with `experiments/siwc-shim-probe.ts`. The test "premise: without the shim, a SIWC-shaped tool call ends as stop and the tool never runs" fails when the shim is no longer needed. The earlier proof-of-concept scripts moved to `experiments/legacy/` as renames.
- **Persistent Keychain credentials.** Already established in an earlier phase (`CHATGPT_CREDENTIAL_STORE=keychain`) and unchanged here; Phase 6A made its envelope handling stricter.

## Phase 6B-1: `RUN_ERROR` code preservation

Status: **complete.** Commit `91923232b53c2b7c2d3007a6b439b533d44aad55`.

### What was observed

On a real account that had reached its usage limit, the wire shape was:

```
HTTP 200
→ Responses SSE  event: error
→ code: subscription_sharing_usage_limit_exceeded
```

The HTTP response starts with status 200; the failure is delivered inside the stream rather than as a non-2xx HTTP response.

### What happens to the code

| Layer                  | Behaviour                                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| TanStack               | Preserves the code on its `RUN_ERROR` chunk.                                                                               |
| CopilotKit's converter | Turns that chunk into `new Error(message)`. **The code is dropped.**                                                       |
| OpenDots               | Captures the code in TanStack's public `middleware.onChunk`, before the converter, and restores it on the web `RUN_ERROR`. |

The capture (`src/server/run-error-code.ts`):

- reads **only** the code, and only if it is on the allowlist (`FORWARDED_RUN_ERROR_CODES` in `src/shared/run-errors.ts`, today just the usage-limit code). The set is closed on purpose: a code that is not listed is never forwarded, whatever the provider sent.
- is **run-local**: created inside `DotAgent.run()` and carried by a closure. There is no module-level or instance state and nothing keyed by thread or run id, so concurrent runs cannot see each other's failures.
- is **one-shot**: `take()` returns the code once and empties it, so a later `RUN_ERROR` in the same run never inherits it.
- does not forward `rawEvent` or any other metadata; the message is not read.
- leaves **channel** errors (Slack and others) **generic**. A channel never receives the code and leaves the capture alone.

DevKit errors are now classified by **explicit code**, replacing the earlier inference from the spelling of a code's name. A code is never an authentication failure because of how it is spelled, and `subscription_sharing_*` is not treated as a family.

## Phase 6B-2: Client usage-limit UX

Status: **complete.** Commit `d190cd86953f31bafe0e77ec9f8428077d412318`.

The dedicated notice appears **only** when `event.code === 'subscription_sharing_usage_limit_exceeded'`. No message is parsed anywhere. With the code absent or unknown, the existing generic error UX applies unchanged.

For the usage limit, the chat shows:

- a message written for the owner (not the server's own text, which also suggests an API key);
- a link to ChatGPT usage settings (`https://chatgpt.com/settings/usage`);
- **no Reconnect** button;
- **no automatic fallback to the API key**, and no change to the chosen provider or model. OpenDots never switches provider by itself.

Error replacement rules:

- A later error that is only the **same failure reported again** (the same message, or the same message inside a wrapper) and carries no code does not overwrite the coded usage-limit state.
- Any other later error replaces it, including a different coded error.
- The comparison goes one way: an incoming message that is merely a part of the original is another error.

## Astra external acceptance

Status: **PASS.** A real-account smoke (`experiments/chatgpt-plan-smoke.ts`) with the final result:

| Check            |                             |
| ---------------- | --------------------------- |
| Credential store | `keychain`                  |
| Session          | restored without signing in |
| Model            | `gpt-6-astra`               |
| Tool call        | `create_space_page`         |
| Tool results     | 1                           |
| Page created     | true                        |
| Final answer     | returned                    |
| Result           | **PASS**                    |

## Usage-limit investigation

The first Astra smoke failed with `subscription_sharing_usage_limit_exceeded`.

- More than 12 hours later it still failed, before the visible usage window changed.
- After the visible usage period reset, the same Astra smoke passed.
- The error is therefore treated as an **external usage-limit condition**, not a failure of the Phase 6 implementation.
- The exact usage bucket responsible was **not identified and must not be guessed.**

The usage-limit response carried **no reset time and no remaining quota.** OpenDots must not invent either: the notice says only that the limit was reached, to try again after it resets, and where to check usage.

## Why the status is 403 here and 429 at OpenAI

The numbers differ on purpose, and they describe different things.

- **OpenAI's external HTTP semantics** for `subscription_sharing_usage_limit_exceeded` are **429**. Nothing here claims that OpenAI returns 403.
- **`planErrorStatus()`** (`src/server/chatgpt-devkit.ts`) deliberately keeps an **internal, synthetic** status of **403** for this code.

That status is used in exactly one place: `failure()` in `chatgpt-plan.ts` builds a synthetic `Response` from a `ChatGPTPlanError` for the OpenAI SDK. It reaches no UI, no HTTP route and no CopilotKit code. `planErrorStatus()` is reached only when a DevKit call (`listModels`, `signIn`, `disconnect`) throws an error with a code. The observed `/responses` usage limit (HTTP 200 plus an SSE `error`) **never passes through it.**

Checked offline, with a stubbed `fetch` and no OpenAI request:

| Synthetic status | SDK attempts (`maxRetries: 1`) | Extra work on retry                                             | Code on the final `RUN_ERROR` |
| ---------------- | ------------------------------ | --------------------------------------------------------------- | ----------------------------- |
| 403              | 1                              | none                                                            | preserved                     |
| 429              | 2, after about 0.4 to 0.5 s    | the model check and token read run again (a second DevKit call) | preserved                     |

The SDK retries 408, 409, 429 and every status of 500 or above, and TanStack and CopilotKit add no status-based retry of their own. A 429 would therefore cost a pointless retry and an extra DevKit call, and would contradict the DevKit's own `retryable: false` for this code. A 403 avoids both.

**Decision: keep 403.** It is an intentional internal adapter behaviour. The final `RUN_ERROR` code and client UX are the same either way, but the internal retry behaviour and latency are not. A real HTTP 429 from OpenAI would not pass through `planErrorStatus()` at all and would be retried once by the SDK today, independent of this mapping.

## SIWC registration cleanup

Repeated ephemeral and proof-of-concept experiments each created a remote registration with ChatGPT. The obsolete ones, named explicitly, were disconnected by hand:

- `OpenDots SIWC PoC`
- `OpenDots SIWC TanStack Shim PoC`
- `OpenDots SIWC Tool PoC`

Registrations named plain `OpenDots` were **left untouched on purpose**: the one the persistent Keychain session uses cannot be identified safely from the ChatGPT UI alone, and disconnecting it would sign that session out.

Do **not** use repeated `reset --yes` as a cleanup mechanism. It removes the local registration identity, so the next sign-in creates a **new** remote registration and the pile grows instead of shrinking. Use `sign-out` to end a session and keep the registration.

## Remaining external acceptance

Only one Phase 6 external acceptance is open:

> **The Intelligence platform preserves the AG-UI `RUN_ERROR.code`.**

Status: **PENDING.** The test session has no configured `INTELLIGENCE_API_KEY`, and no credential was looked for or substituted.

What it covers: OpenDots restores the code on the web `RUN_ERROR` it emits (verified by tests). Whether that code then survives the transport through the remote Intelligence platform to the browser has not been observed.

What this means for behaviour today:

- **Safe by construction.** If the code does not arrive, the client sees an error without a code and shows the existing generic error UX. Nothing mis-fires and nothing is parsed out of the message.
- **No further implementation is needed** unless the transport check shows the code is dropped. Then the answer is a separate decision, not a workaround added now.

To close it, run a chat through a server that has `INTELLIGENCE_API_KEY` set, produce a `RUN_ERROR` with the usage-limit code, and check that the browser receives `code`. This is not done and no result is claimed.

## Phase 6 implementation baseline

A historical record of where the repository stood when this closeout documentation was started. It is not a statement about the current `HEAD`.

- Branch `feat/chatgpt-plan-provider`.
- Phase 6 implementation baseline commit: `d190cd86953f31bafe0e77ec9f8428077d412318`.
- When the closeout documentation was started, the local `HEAD` and `origin/feat/chatgpt-plan-provider` were the same commit, and ahead and behind were 0 and 0.
- The only untracked file was `mise.toml`, which is not part of this work.
