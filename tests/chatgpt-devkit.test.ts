import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatGPTPlanSession } from '../src/server/chatgpt-devkit.js';
import { ChatGPTPlanError } from '../src/server/chatgpt-plan.js';
import { ephemeralCredentialEncryption } from '../src/server/ephemeral-encryption.js';

// A stand-in for the DevKit's built dist, shaped like its public contract:
// createChatGPT() plus a ConnectionStore holding the saved state.
const fakeIndex = `
export function createChatGPT() {
  const fake = globalThis.__fakeDevKit;
  return {
    async signIn() { return { status: 'connected', sharing: fake.sharing }; },
    async getSession() { return { status: fake.status, sharing: fake.sharing }; },
    async listModels() {
      fake.listCalls += 1;
      if (fake.failure) throw Object.assign(new Error(fake.failure.message), fake.failure);
      if (fake.refresh) fake.state = fake.refresh(fake.state);
      return [{ slug: 'gpt-5.6-luna', displayName: 'Luna' }];
    },
    async disconnect() {},
  };
}
`;
const fakeStorage = `
export class ConnectionStore {
  async withLock(operation) { return operation(); }
  async read() { return globalThis.__fakeDevKit.state; }
}
`;

type Fake = {
  state?: unknown;
  status: string;
  sharing: boolean;
  listCalls: number;
  failure?: { code: string; message: string; retryable?: boolean };
  refresh?: (state: unknown) => unknown;
};
const g = globalThis as unknown as { __fakeDevKit: Fake };
const connected = (accessToken: string, expiresAt: number) => ({
  activeProfileId: 'p',
  profiles: [
    { id: 'p', status: 'connected', credentials: { accessToken, expiresAt } },
  ],
});

let dist: string;
beforeEach(async () => {
  dist = await mkdtemp(join(tmpdir(), 'fake-devkit-'));
  await writeFile(join(dist, 'index.js'), fakeIndex);
  await writeFile(join(dist, 'storage.js'), fakeStorage);
  g.__fakeDevKit = { status: 'connected', sharing: true, listCalls: 0 };
});
afterEach(async () => {
  await rm(dist, { recursive: true, force: true });
});

it('fails with an actionable message and keeps the underlying cause', async () => {
  const error = await createChatGPTPlanSession({
    devkitDist: join(dist, 'missing'),
  }).catch((e) => e);
  expect(error.message).toMatch(/CHATGPT_DEVKIT_DIST/);
  expect(error.cause).toBeInstanceOf(Error);
});

it('removes its exit listener and temp directory on dispose', async () => {
  const before = process.listenerCount('exit');
  const session = await createChatGPTPlanSession({ devkitDist: dist });
  expect(process.listenerCount('exit')).toBe(before + 1);
  await session.dispose();
  expect(process.listenerCount('exit')).toBe(before);
});

it('returns a fresh stored token without touching the network', async () => {
  g.__fakeDevKit.state = connected('fresh-token', Date.now() + 3_600_000);
  const session = await createChatGPTPlanSession({ devkitDist: dist });
  await expect(session.auth.getAccessToken()).resolves.toBe('fresh-token');
  expect(g.__fakeDevKit.listCalls).toBe(0);
  await session.dispose();
});

it('lets the DevKit refresh a near-expiry token before reading it', async () => {
  g.__fakeDevKit.state = connected('old-token', Date.now() + 30_000);
  g.__fakeDevKit.refresh = () => connected('new-token', Date.now() + 3_600_000);
  const session = await createChatGPTPlanSession({ devkitDist: dist });
  await expect(session.auth.getAccessToken()).resolves.toBe('new-token');
  expect(g.__fakeDevKit.listCalls).toBe(1);
  await session.dispose();
});

it('maps DevKit failures to HTTP-shaped plan errors', async () => {
  const session = await createChatGPTPlanSession({ devkitDist: dist });
  await expect(session.auth.getAccessToken()).rejects.toMatchObject({
    code: 'sign_in_required',
    status: 401,
  });
  g.__fakeDevKit.state = connected('old', Date.now() + 1_000);
  g.__fakeDevKit.failure = {
    code: 'refresh_not_ready',
    message: 'Try again shortly.',
    retryable: true,
  };
  await expect(session.auth.getAccessToken()).rejects.toMatchObject({
    code: 'refresh_not_ready',
    status: 503,
  });
  g.__fakeDevKit.failure = { code: 'reauth_required', message: 'Sign in.' };
  const error = await session.auth.getAccessToken().catch((e) => e);
  expect(error).toBeInstanceOf(ChatGPTPlanError);
  expect(error.status).toBe(401);
  await session.dispose();
});

it('treats an account without plan sharing as not signed in', async () => {
  g.__fakeDevKit.sharing = false;
  const session = await createChatGPTPlanSession({ devkitDist: dist });
  await expect(session.isSignedIn()).resolves.toBe(false);
  await expect(session.signIn()).rejects.toMatchObject({
    code: 'sharing_not_enabled',
  });
  await session.dispose();
});

it('encrypts with a per-process key that other instances cannot read', () => {
  const a = ephemeralCredentialEncryption();
  const b = ephemeralCredentialEncryption();
  const sealed = a.encrypt('secret-token');
  expect(Buffer.from(sealed).includes('secret-token')).toBe(false);
  expect(a.decrypt(sealed)).toBe('secret-token');
  expect(a.encrypt('secret-token')).not.toEqual(sealed);
  expect(() => b.decrypt(sealed)).toThrow();
  const tampered = Buffer.from(sealed);
  tampered[tampered.length - 1] ^= 1;
  expect(() => a.decrypt(tampered)).toThrow();
});
