# ChatGPT plan model provider

By default OpenDots calls a model with `OPENAI_API_KEY`. As an alternative for personal use, it can run the same agent loop on a ChatGPT plan through Sign in with ChatGPT (SIWC). The API-key path is unchanged and remains the default.

## Licensing

The SIWC DevKit is a separate project under a noncommercial license. OpenDots does not bundle or copy it and does not list it in `package.json`. You supply a built copy and OpenDots loads it at runtime. Review the DevKit license before using this provider in anything other than personal, noncommercial work.

## Setup

1. Build the DevKit: `npm run build -w @siwc/local` in its repository.
2. In `.env`, point OpenDots at it. This is all the server needs to offer ChatGPT plan:

   ```sh
   CHATGPT_DEVKIT_DIST=/path/to/sign-in-with-chatgpt-devkit/packages/local/dist
   # Optional server defaults (the Model settings can override both):
   # MODEL_PROVIDER=chatgpt-plan
   # OPENAI_MODEL=<a model slug your account offers>
   # Keep the sign-in across restarts (macOS):
   # CHATGPT_CREDENTIAL_STORE=keychain
   ```

3. Start the server on a loopback `HOST`, open OpenDots, and use **Model** (sidebar or rail icon) to sign in, see the models your account offers, and pick one. The server never opens a browser by itself.

`OPENAI_API_KEY` and `OPENAI_BASE_URL` apply only to the API key provider.

## Model settings in the web UI

The **Model** dialog shows and changes everything about which model runs next:

- **Provider:** OpenAI API key or ChatGPT plan. A provider the server has not configured is disabled, with the variable that is missing.
- **ChatGPT connection:** Connected, Signed out, Unavailable (with the reason), or in transition. **Sign in with ChatGPT** starts sign-in; the dialog then shows **Continue in ChatGPT ↗**, which opens ChatGPT in a new tab. Finish there and come back: the dialog notices on its own. **Cancel** stops a pending sign-in. **Sign out** revokes OpenDots' access and clears the tokens, but keeps the saved registration and the encryption key, so signing in again is quick.
- **Model:** a list read live from your account, never a built-in one. Refresh it with the circular arrow.
- **Use server default:** removes whatever you chose here, so the server's environment decides again.

Changes apply to the next message. A message already running finishes on the provider and model it started with. No restart is needed.

**Precedence.** The server's environment says what is _available_ and what to use by default (`MODEL_PROVIDER`, `OPENAI_MODEL`). What you choose in the dialog is saved in OpenDots' database (a provider name and a model name, never a key) and wins over those defaults; the dialog shows which one is in effect. Keys, the base URL, `CHATGPT_DEVKIT_DIST`, the credential store and the state directory are server-only and not editable from the browser.

**Which model runs.** The saved model if your account currently offers it; otherwise the server's `OPENAI_MODEL` if your account offers that; otherwise none, and the dialog says so. OpenDots never quietly substitutes some other model, and it never deletes your saved choice if it disappears: it tells you, and the choice works again if the model returns.

**Signed out** shows a notice and the Model dialog opens from it; chat is not blocked. A message sent while signed out fails with a clear sign-in error.

**Remote servers.** Sign-in completes through a loopback address on the machine running OpenDots, so it only works with a loopback `HOST` and a browser on that same machine. Elsewhere the dialog says to sign in on the server machine (or use the command-line tools).

**Reset is not in the UI.** If the connection is unavailable because the saved credentials are damaged or their key is gone, the dialog shows the recovery command (see Management commands) rather than a button.

To check a real account end to end, run `node --import tsx experiments/chatgpt-plan-smoke.ts [model]`. It signs in, lists models, and runs one `DotAgent` turn that calls a server tool and returns a final answer.

## How it works

`src/server/model-provider.ts` defines `ModelProvider`: the adapter for TanStack's agent loop plus the request options that go with it. `apiKeyProvider` is the existing Chat Completions path. `chatgptPlanProvider` (`chatgpt-plan.ts`) uses the Responses API, with `store: false`, and replaces the `Authorization` header on every request with a current access token from a `ChatGPTPlanAuth`. The token exists only inside that request; it is not stored or logged.

`siwc-compat.ts` corrects one SIWC difference. SIWC streams a complete `function_call` in `response.output_item.done` but leaves `response.completed.output` empty. TanStack's Responses adapter derives `finishReason` from that array, so a turn that called a tool would finish as `stop` and the loop would not run the tool. The shim changes `stop` to `tool_calls` only when a complete tool call was observed in the same turn.

`chatgpt-devkit.ts` and `devkit-compat.ts` are the only code that knows about the DevKit. Its public client can sign in, list models and sign out but does not expose an access token, so the token is read from its stored state through a `TokenSource`, checked against the minimum shape OpenDots relies on, and renewed only by asking the DevKit to refresh (it does so inside authenticated calls) and then reading the state again. See the compatibility contract below for what is public, what is not, and what happens when the DevKit changes.

## DevKit compatibility contract

OpenDots talks to the Sign in with ChatGPT DevKit, which is a separate project with no published releases (its package is private and stays at `0.1.0`). Part of what OpenDots uses is the DevKit's public API; part is not. This section is the whole list, so an update can be reviewed against it. All of it lives in `src/server/devkit-compat.ts` and `src/server/chatgpt-devkit.ts`; nothing else in OpenDots touches DevKit internals.

### What is public, what is not

| What OpenDots uses                                                                                                                                                         | Status                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `createChatGPT(config)`; `signIn`, `getSession`, `listProfiles`, `listModels`, `disconnect`; `config.openBrowser`; the `SessionState` shape (`status`, `sharing`, `error`) | Public API                                                                                            |
| The `CredentialEncryption` hook (`id`, `isAvailable`, `encrypt`, `decrypt`) and its documented behaviour                                                                   | Public, documented                                                                                    |
| Error `code` and `retryable`                                                                                                                                               | Public fields; the set of codes is **open** (some come from the server), so no code list is relied on |
| **`ConnectionStore`** (`dist/storage.js`), imported by file path because the package exports only its main entry                                                           | **Internal**                                                                                          |
| The **stored state** it returns, to read the access token (the DevKit marks these types internal)                                                                          | **Internal**                                                                                          |
| `expiresAt` is a millisecond timestamp; a token is refreshed when 60 s or less remain; refreshing happens inside authenticated calls such as `listModels()`                | Observed behaviour, not promised                                                                      |
| File names in the DevKit's state directory (`chatgpt-auth.json`, `chatgpt-host.json`, `.chatgpt-auth.lock`)                                                                | **Internal**                                                                                          |
| `listModels()` returns only models the DevKit marks `visibility: "list"`, as a list, with slugs of up to 200 characters                                                    | Observed behaviour                                                                                    |

The DevKit has no public way to get an access token (and its `streamResponse()` cannot carry tools), so the token is read from its stored state. That is the one deliberate use of internals.

### Two formats, two versions

These are different things and are never called just "version":

- **Auth envelope version, `3`** (`DEVKIT_AUTH_ENVELOPE_VERSION`): the outer JSON in `chatgpt-auth.json` (`{version, provider, ciphertext}`).
- **Stored-state version, `2`** (`DEVKIT_STORED_STATE_VERSION`): what that ciphertext decrypts to.

Neither is the DevKit's package version.

### How compatibility is decided

By what the DevKit does, never by a version or a hash alone:

| Result                    | Meaning                                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **`devkit_incompatible`** | A runtime contract check failed. Refused; shown with the reason.                                                              |
| **`verified`**            | The contract holds and the build is recorded below.                                                                           |
| **`untested`**            | The contract holds but the build is not recorded. **Used normally**, with a small notice in the Model dialog and in `status`. |

`CHATGPT_DEVKIT_STRICT=1` additionally refuses `untested` builds.

The runtime contract:

- **At load:** the DevKit has `createChatGPT`, a `ConnectionStore` with `read` and `withLock`, and a client with the five methods used. Otherwise the DevKit is refused at start.
- **Before every DevKit call, in the persistent store:** the saved `chatgpt-auth.json` must be an envelope of version 3. An unrecognized or older format is **never** handed to the DevKit: nothing is decrypted, read, migrated, written or reset, and the file is left byte for byte as it was. (The DevKit migrates and rewrites formats it knows when it reads them; this keeps that away from files OpenDots did not create.) OpenDots never migrates a format it does not recognize either.
- **Whenever it reads the stored state:** it checks only the minimum it relies on: stored-state version 2; `profiles` is a list; the active profile is in it and has a known status; a connected profile has a `credentials` object with a non-empty access token and a finite `expiresAt` in the millisecond range. A state with nothing signed in is fine: no active profile, or a profile whose status is `disconnected` or `reauth_required` (such a profile has no credentials). A `connected` profile **without** credentials is not allowed by the stored-state contract. **Anything that does not fit is `devkit_incompatible`, never "signed out".** Messages name the field, never a value.
- **After requesting a refresh:** the state is read again and the token must have at least 30 s left. A successful `listModels()` is not taken to mean the token is fresh. OpenDots never refreshes OAuth tokens itself.
- **Status:** an unknown connection status, or an error beside a signed-out status that the saved state does not explain, is **unavailable**, not signed out. The DevKit remembers an earlier request's error (a failed revocation, an expired refresh) on the session; whether that is a real failure is decided by reading the saved state, never by the error's name.

When any of this fails, the saved credentials are left untouched and nothing falls back to something else: no switch to the API key, no `streamResponse()`, no home-made refresh.

### Verified builds

`VERIFIED_DEVKIT_BUILDS` in `devkit-compat.ts` records, per build: the upstream commit, the package name and version, a fingerprint of each selected runtime file, and an aggregate fingerprint. Currently:

|           |                                                                    |
| --------- | ------------------------------------------------------------------ |
| Commit    | `f723814abdccec135b519c451fb6e1992ee5e933`                         |
| Package   | `@siwc/local` `0.1.0`                                              |
| Aggregate | `66752b92d315e4dcb2ded1c8868d1aaf0e60b71b5463ac602fdae2d536ed0708` |

**Fingerprint procedure.** Take `index.js`, `storage.js`, `oauth.js`, `models.js` and `errors.js` from the DevKit's `dist/`, in that order. The file fingerprint is the SHA-256 of the file's bytes. The aggregate is the SHA-256 of the text made of one line `<file name>:<file fingerprint>\n` per file, in that order. `npm run chatgpt-plan -- devkit` prints exactly these for the DevKit at `CHATGPT_DEVKIT_DIST`. The commit cannot be read from a build; it is recorded by hand.

An unknown fingerprint alone never blocks use. It also changes with the compiler used to build, which is why the build table is an allow-list for "verified" and not a gate.

### Updating the DevKit

1. Build the new DevKit and point `CHATGPT_DEVKIT_DIST` at it.
2. `npm run chatgpt-plan -- status` shows whether it is usable and whether it is `verified` or `untested`.
3. Run the contract tests against it: `CHATGPT_DEVKIT_DIST=... npx vitest run tests/devkit-contract.test.ts tests/devkit-compat.test.ts tests/chatgpt-devkit-hardening.test.ts`. A failure names the assumption that changed; decide, and update `devkit-compat.ts` and this document.
4. Check on a real account (`experiments/chatgpt-plan-smoke.ts`, Luna and Astra).
5. Record the build (`npm run chatgpt-plan -- devkit`, then add the commit) in `VERIFIED_DEVKIT_BUILDS`.

### Models

The models OpenDots treats as available are exactly those the DevKit's `listModels()` returns, and nothing else. A model the DevKit does not list (including ones it hides with `visibility` other than `"list"`) is not guessed at and cannot be typed in: it is refused with the list of what is available. If the DevKit's list does not match the expected shape (an entry that is not an object, a slug or display name that is missing, empty, or longer than 200 characters, a repeated slug, or a response that is not a list), **the whole list fails** (`invalid_model_catalog`). Nothing is dropped and no part of a bad list is used; the last good list stays, marked stale. What counts as well-formed is exactly what the DevKit guarantees, and nothing more: a slug and a display name are each text that is not empty once trimmed and at most 200 characters, and no slug is repeated. OpenDots adds no character set of its own, so a model the DevKit lists is never rejected for how it is spelled. Which model may be selected or run is decided only by whether the account's live list contains it.

### If the DevKit gets a public token API

Where the token comes from is behind one interface, `TokenSource`, with a single implementation today (the stored state). If the DevKit adds a public way to obtain a token, or better an authorized `fetch` that never exposes the token to OpenDots, a second implementation is added then, and the stored-state one, the `ConnectionStore` import and the envelope check are removed. Nothing is guessed in advance: no feature detection for an API that does not exist.

### Removing the SIWC compatibility shim

`src/server/siwc-compat.ts` exists because SIWC streams a complete `function_call` in `response.output_item.done` but leaves `response.completed.output` empty, and TanStack's Responses adapter derives `finishReason` from that array, so a turn that called a tool would end as `stop` and the tool would never run. The shim rewrites `stop` to `tool_calls` only after a tool call was completely observed in the same turn.

It can be removed when **either**:

- SIWC fills `response.completed.output` for function calls (check with `experiments/siwc-shim-probe.ts` on a real account, over several runs), **or**
- the TanStack adapter derives `finishReason` from the items it saw during the stream.

Both show up as the test "premise: without the shim, a SIWC-shaped tool call ends as stop and the tool never runs" failing in `tests/siwc-contract.test.ts`. The shim is harmless if SIWC starts filling the output (also tested). What it must keep doing is covered by the behaviour tests in that file (tool-call end, rewritten finish reason, the tool runs once, the next model iteration happens). A change in `@tanstack/openai-base`, `@tanstack/ai-openai` or `@tanstack/ai` makes a version-review test fail as a prompt to look again; the behaviour tests, not the version number, decide whether it still works.

## Credential storage

Two stores, chosen with `CHATGPT_CREDENTIAL_STORE`. Neither ever falls back to the other, and neither writes a plaintext credential.

**`ephemeral` (default).** The sign-in state is encrypted with a random key that exists only in the server process's memory, in a private temporary directory removed on exit. Restarting means signing in again. On shutdown the tokens are also revoked.

**`keychain` (macOS only).** The sign-in survives restarts, so a valid saved session never opens the browser.

- A random 32-byte key is kept in the macOS Keychain (generic password, service `OpenDots ChatGPT plan credential key`, stored as base64 and read back strictly as exactly 32 bytes). The `@napi-rs/keyring` addon calls the Keychain API directly: no `security` process, nothing in argv or the environment. It is an optional dependency, loaded only in this mode.
- The DevKit's own encrypted file (`chatgpt-auth.json`: tokens, client registration, identity) is sealed with that key using AES-256-GCM and stays in the state directory, `~/Library/Application Support/OpenDots/chatgpt-plan` by default (`CHATGPT_STATE_DIR` overrides it). The key is never written to a file.
- The directory is `0700` and every file `0600`; anything looser is refused.
- `opendots-key.json` holds only a random key id, which names the Keychain item. Copying the directory to another machine, or restoring a backup after the Keychain item is gone, cannot decrypt anything.

What this protects: copies of the state directory (backups, sync, disk images) and other OS users. What it does not: other code running as you. The Keychain item is readable without a prompt by the program that created it (here, the `node` binary), so any script run by that same `node` can read it. After switching Node versions macOS may ask for permission; choose Always Allow.

### Lifecycle

- **Start:** nothing touches the network. A saved, valid session is restored. The server never opens a browser on its own: signing in is something you do from the Model dialog (or the command line). If storage is unavailable or damaged it reports why in the dialog.
- **Refresh:** unchanged; the DevKit rotates tokens and the new state is re-encrypted with the same key.
- **Shutdown:** only releases resources. It does not sign out, revoke, or delete anything.
- **Sign-out and reset:** explicit actions only, below.

### Management commands

```sh
npm run chatgpt-plan -- status           # read-only; never creates a key or file; also reports the DevKit build
npm run chatgpt-plan -- devkit           # the DevKit build's fingerprints, as a table entry
npm run chatgpt-plan -- sign-out         # revoke tokens; keep the key and registration
npm run chatgpt-plan -- reset            # shows what would be removed, changes nothing
npm run chatgpt-plan -- reset --yes      # revoke if possible, then delete files and the Keychain item
```

For a built server use `node dist/server/server/chatgpt-plan-cli.js <command>`. Stop the server before `reset`. If `reset` cannot revoke remotely (the key is already gone), disconnect OpenDots in ChatGPT Settings. Remove the saved session with `reset --yes` before uninstalling; deleting the project alone leaves the Keychain item behind.

### When it fails closed

| Situation                                                | What happens                                                                      |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Keychain locked or unreadable                            | Requests fail with a retryable 503; nothing is changed. Unlock and retry.         |
| Encrypted file exists but its Keychain key is missing    | `credential_key_missing`. No new key is created. Run `reset --yes`, then sign in. |
| Ciphertext damaged                                       | `credential_ciphertext_invalid`; the file is preserved. Run `reset --yes`.        |
| File written under the other store                       | The DevKit rejects it (`storage_provider_mismatch`); the file is preserved.       |
| `opendots-key.json` unreadable, or a file is not private | Refused until fixed or reset.                                                     |
| Not macOS, or `@napi-rs/keyring` not installed           | Startup stops with an explanation.                                                |

If the server is killed during first-time key creation, the next start recovers: the creation lock names its owner's process id, and a lock whose owner is gone is taken over at once. A lock whose owner is still running is never taken, however old it is. Only a lock with no usable owner (empty or damaged) is judged by its age. One corner case: if the operating system hands a dead owner's process id to an unrelated program, the lock looks held and startup stops with `lock_timeout`. If no OpenDots process is running, delete `.opendots-key.lock` in the state directory.

**Cleanup limit.** The Keychain item is found through the key id in `opendots-key.json`. If that file is missing or damaged, `reset` cannot tell which Keychain item belonged to this session, reports `Keychain item: unknown`, and an orphaned item may remain. The leftover is only a random encryption key for data that no longer exists, so it cannot be used to recover anything; it just wastes an entry. To remove it, open Keychain Access, search for the service `OpenDots ChatGPT plan credential key`, and delete the entries. Check which ones are current first if you also run other OpenDots state directories.

Linux (libsecret) is not implemented. When added it must require a persistent Secret Service and never use the kernel keyring as a fallback.

## Phase 6 closeout

What Phase 6 delivered, the real-account results, the 403/429 decision and the one open acceptance are recorded in [CHATGPT_PLAN_PHASE6.md](CHATGPT_PLAN_PHASE6.md).

## Not covered

Resetting from the web UI, per-Dot models, Voice/Realtime, and scheduled-task research (`research.ts` still requires `OPENAI_API_KEY`).
