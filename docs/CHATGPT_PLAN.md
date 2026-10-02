# ChatGPT plan model provider

By default OpenDots calls a model with `OPENAI_API_KEY`. As an alternative for personal use, it can run the same agent loop on a ChatGPT plan through Sign in with ChatGPT (SIWC). The API-key path is unchanged and remains the default.

## Licensing

The SIWC DevKit is a separate project under a noncommercial license. OpenDots does not bundle or copy it and does not list it in `package.json`. You supply a built copy and OpenDots loads it at runtime. Review the DevKit license before using this provider in anything other than personal, noncommercial work.

## Setup

1. Build the DevKit: `npm run build -w @siwc/local` in its repository.
2. In `.env`:

   ```sh
   MODEL_PROVIDER=chatgpt-plan
   CHATGPT_DEVKIT_DIST=/path/to/sign-in-with-chatgpt-devkit/packages/local/dist
   OPENAI_MODEL=<a model slug your account offers>
   ```

3. Start the server on a loopback `HOST`. If no session exists it opens the sign-in page in your browser. Sign-in must be done on the same machine.

`OPENAI_MODEL` is checked against the models your account actually offers (the DevKit `listModels()`), never against a built-in list. An unavailable model fails the request with the current list in the message. `OPENAI_API_KEY` and `OPENAI_BASE_URL` are ignored in this mode.

To check a real account end to end, run `node --import tsx experiments/chatgpt-plan-smoke.ts [model]`. It signs in, lists models, and runs one `DotAgent` turn that calls a server tool and returns a final answer.

## How it works

`src/server/model-provider.ts` defines `ModelProvider`: the adapter for TanStack's agent loop plus the request options that go with it. `apiKeyProvider` is the existing Chat Completions path. `chatgptPlanProvider` (`chatgpt-plan.ts`) uses the Responses API, with `store: false`, and replaces the `Authorization` header on every request with a current access token from a `ChatGPTPlanAuth`. The token exists only inside that request; it is not stored or logged.

`siwc-compat.ts` corrects one SIWC difference. SIWC streams a complete `function_call` in `response.output_item.done` but leaves `response.completed.output` empty. TanStack's Responses adapter derives `finishReason` from that array, so a turn that called a tool would finish as `stop` and the loop would not run the tool. The shim changes `stop` to `tool_calls` only when a complete tool call was observed in the same turn.

`chatgpt-devkit.ts` is the only code that knows about the DevKit. Its public client can sign in and list models but does not expose an access token, so the adapter has `listModels()` refresh the session and then reads the stored token. That read depends on the DevKit's internal storage format; asking the DevKit for a public `getAccessToken()` would remove it.

## Credential storage

Not persistent yet. Sign-in state is encrypted with a random key that exists only in the server process's memory, in a private temporary directory removed on exit. Restarting the server means signing in again. This fails safe: nothing durable can decrypt the stored state.

Durable storage needs a key held by the OS, not by OpenDots:

- macOS Keychain and Linux libsecret, called through a native API. The `security` command is not suitable because the secret would appear in the process arguments.
- The same `CredentialEncryption` contract the DevKit already requires (`id`, `isAvailable`, `encrypt`, `decrypt`), so only `ephemeral-encryption.ts` and its wiring change.
- Fail closed if the OS store is locked or unavailable; never fall back to a plaintext or file-held key.

## Not covered

Sign-in and model selection in the web UI, Voice/Realtime, and scheduled-task research (`research.ts` still requires `OPENAI_API_KEY`).
