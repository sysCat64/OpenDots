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

`chatgpt-devkit.ts` is the only code that knows about the DevKit. Its public client can sign in and list models but does not expose an access token, so the adapter has `listModels()` refresh the session and then reads the stored token. That read depends on the DevKit's internal storage format; asking the DevKit for a public `getAccessToken()` would remove it.

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
npm run chatgpt-plan -- status           # read-only; never creates a key or file
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

## Not covered

Resetting from the web UI, per-Dot models, Voice/Realtime, and scheduled-task research (`research.ts` still requires `OPENAI_API_KEY`).
