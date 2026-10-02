import { expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { KeychainKeyBackend } from '../src/server/credential-keys.js';

// Talks to the real macOS Keychain. Opt in with OPENDOTS_KEYCHAIN_TESTS=1; it
// uses one throwaway account and always removes it.
it.skipIf(
  process.platform !== 'darwin' || !process.env.OPENDOTS_KEYCHAIN_TESTS,
)('round-trips a key through the real macOS Keychain', async () => {
  const backend = await KeychainKeyBackend.create();
  const account = `test-${randomBytes(6).toString('hex')}`;
  try {
    expect(await backend.get(account)).toBeUndefined();
    const key = randomBytes(32);
    await backend.set(account, key);
    expect((await backend.get(account))?.equals(key)).toBe(true);
    const replacement = randomBytes(32);
    await backend.set(account, replacement); // overwrites silently
    expect((await backend.get(account))?.equals(replacement)).toBe(true);
  } finally {
    expect(await backend.delete(account)).toBe(true);
  }
  expect(await backend.delete(account)).toBe(false);
  expect(await backend.get(account)).toBeUndefined();
});
