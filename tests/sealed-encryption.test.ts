import { expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { CredentialStoreError } from '../src/server/credential-errors.js';
import {
  memoryKeySource,
  sealedCredentialEncryption,
  type SealedKey,
} from '../src/server/sealed-encryption.js';

const source = (keyId = 'k1', key = randomBytes(32)) => {
  const opened = { keyId, key };
  return vi.fn(async () => opened);
};

it('round-trips, never repeats a nonce, and does not expose the plaintext', async () => {
  const enc = sealedCredentialEncryption({ id: 'p', openKey: source() });
  const a = await enc.encrypt('refresh-token-value');
  const b = await enc.encrypt('refresh-token-value');
  expect(Buffer.from(a).includes('refresh-token-value')).toBe(false);
  expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  expect(await enc.decrypt(a)).toBe('refresh-token-value');
  expect(a[0]).toBe(1);
});

it.each([
  ['a flipped body byte', (b: Buffer) => (b[b.length - 1] ^= 1)],
  ['a flipped tag byte', (b: Buffer) => (b[20] ^= 1)],
  ['a flipped nonce byte', (b: Buffer) => (b[2] ^= 1)],
  ['an unknown version', (b: Buffer) => (b[0] = 9)],
])('rejects %s without leaking details', async (_name, damage) => {
  const failures: Array<string | undefined> = [];
  const enc = sealedCredentialEncryption({
    id: 'p',
    openKey: source(),
    onFailure: (code) => failures.push(code),
  });
  const sealed = Buffer.from(await enc.encrypt('secret'));
  damage(sealed);
  const error = await enc.decrypt(sealed).catch((e) => e);
  expect(error).toBeInstanceOf(CredentialStoreError);
  expect(error.code).toBe('credential_ciphertext_invalid');
  expect(error.message).not.toContain('secret');
  expect(failures.at(-1)).toBe('credential_ciphertext_invalid');
});

it('rejects truncated input', async () => {
  const enc = sealedCredentialEncryption({ id: 'p', openKey: source() });
  await expect(enc.decrypt(new Uint8Array(10))).rejects.toMatchObject({
    code: 'credential_ciphertext_invalid',
  });
});

it('binds ciphertext to the provider id and key id', async () => {
  const key = randomBytes(32);
  const sealed = await sealedCredentialEncryption({
    id: 'one',
    openKey: source('k1', key),
  }).encrypt('x');
  for (const other of [
    sealedCredentialEncryption({ id: 'two', openKey: source('k1', key) }),
    sealedCredentialEncryption({ id: 'one', openKey: source('k2', key) }),
    sealedCredentialEncryption({ id: 'one', openKey: source('k1') }),
  ])
    await expect(other.decrypt(sealed)).rejects.toMatchObject({
      code: 'credential_ciphertext_invalid',
    });
});

it('loads the key once however often it is used, and shares an in-flight load', async () => {
  const open = source();
  const enc = sealedCredentialEncryption({ id: 'p', openKey: open });
  await Promise.all([enc.isAvailable(), enc.isAvailable(), enc.encrypt('a')]);
  for (let i = 0; i < 20; i++) await enc.isAvailable();
  expect(open).toHaveBeenCalledTimes(1);
});

it('remembers a failure briefly, then tries again, and reports recovery', async () => {
  let now = 1_000;
  let healthy = false;
  const key = randomBytes(32);
  const open = vi.fn(async (): Promise<SealedKey> => {
    if (!healthy) throw new CredentialStoreError('keychain_unavailable');
    return { keyId: 'k', key };
  });
  const failures: Array<string | undefined> = [];
  const enc = sealedCredentialEncryption({
    id: 'p',
    openKey: open,
    onFailure: (code) => failures.push(code),
    retryAfterMs: 3_000,
    now: () => now,
  });
  expect(await enc.isAvailable()).toBe(false);
  expect(await enc.isAvailable()).toBe(false);
  expect(open).toHaveBeenCalledTimes(1); // not hammered
  now += 3_001;
  healthy = true;
  expect(await enc.isAvailable()).toBe(true);
  expect(open).toHaveBeenCalledTimes(2);
  expect(failures).toEqual(['keychain_unavailable', undefined]);
  await expect(enc.encrypt('x')).resolves.toBeInstanceOf(Uint8Array);
});

it('wraps an unexpected backend failure without exposing its message', async () => {
  const enc = sealedCredentialEncryption({
    id: 'p',
    openKey: async () => {
      throw new Error('errSecAuthFailed for key 0xDEADBEEF');
    },
  });
  const error = await enc.encrypt('x').catch((e) => e);
  expect(error).toMatchObject({ code: 'keychain_unavailable' });
  expect(error.message).not.toContain('DEADBEEF');
});

it('wipes the cached key on close and refuses further use', async () => {
  const opened = { keyId: 'k', key: randomBytes(32) };
  const enc = sealedCredentialEncryption({
    id: 'p',
    openKey: async () => opened,
  });
  await enc.encrypt('x');
  enc.close();
  expect(opened.key.every((byte) => byte === 0)).toBe(true);
  expect(await enc.isAvailable()).toBe(false);
  await expect(enc.encrypt('x')).rejects.toBeInstanceOf(CredentialStoreError);
});

it('ephemeral keys differ per process-local source', async () => {
  const a = sealedCredentialEncryption({ id: 'e', openKey: memoryKeySource() });
  const b = sealedCredentialEncryption({ id: 'e', openKey: memoryKeySource() });
  const sealed = await a.encrypt('x');
  await expect(b.decrypt(sealed)).rejects.toBeDefined();
  expect(await a.decrypt(sealed)).toBe('x');
});
