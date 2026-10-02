# Legacy probes

Historical proofs of concept, kept for reference. **They are not production code.**

- `siwc-tool-call.mjs`: Responses API function calling with a ChatGPT-plan token.
- `siwc-tanstack-shim.mjs`: TanStack's agent loop with the `finishReason` shim.

Both read the DevKit's access token by importing its internal `dist/storage.js`
and reading its stored state directly. That is exactly the dependency the
production code isolates, validates, and guards (`src/server/chatgpt-devkit.ts`,
`src/server/devkit-compat.ts`, and the compatibility contract in
`docs/CHATGPT_PLAN.md`). These scripts have no such checks and may break whenever
the DevKit changes. Use `experiments/chatgpt-plan-smoke.ts` for a real-account
check of the supported path.
