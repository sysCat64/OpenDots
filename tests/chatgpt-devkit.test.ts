import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  KEYCHAIN_ENCRYPTION_ID,
  createChatGPTPlanSession,
} from '../src/server/chatgpt-devkit.js';
import { ChatGPTPlanError } from '../src/server/chatgpt-plan.js';
import {
  openPersistentKey,
  type KeyBackend,
} from '../src/server/credential-keys.js';
import { sealedCredentialEncryption } from '../src/server/sealed-encryption.js';
import { FakeBackend } from './fixtures/key-backend.js';

// These tests do real filesystem and process work; leave headroom on a loaded machine.
vi.setConfig({ testTimeout: 20_000 });

// A stand-in for the DevKit's built dist, shaped like its public contract. Like
// the real one, it refuses to touch storage unless the supplied credential
// encryption says it is available.
const fakeIndex = `
export function createChatGPT(config) {
  const fake = globalThis.__fakeDevKit;
  fake.config = config;
  const guard = async () => {
    if (!(await config.credentialEncryption.isAvailable()))
      throw Object.assign(new Error('Secure credential storage is unavailable.'), { code: 'storage_encryption_unavailable', retryable: true });
  };
  return {
    async signIn(options) {
      fake.signIns.push(options);
      return { status: 'connected', sharing: fake.sharing };
    },
    async getSession() {
      try { await guard(); } catch (error) {
        return { status: 'reauth_required', sharing: false, error: { code: error.code, message: error.message } };
      }
      return { status: fake.status, sharing: fake.sharing };
    },
    async listProfiles() { return fake.profiles; },
    async listModels() {
      await guard();
      fake.listCalls += 1;
      if (fake.failure) throw Object.assign(new Error(fake.failure.message), fake.failure);
      if (fake.refresh) fake.state = fake.refresh(fake.state);
      return [{ slug: 'gpt-5.6-luna', displayName: 'Luna' }];
    },
    async disconnect() { fake.disconnects += 1; },
  };
}
`;
const fakeStorage = `
export class ConnectionStore {
  constructor(directory, encryption) { this.encryption = encryption; }
  async withLock(operation) { return operation(); }
  async read() {
    if (!(await this.encryption.isAvailable()))
      throw Object.assign(new Error('Secure credential storage is unavailable.'), { code: 'storage_encryption_unavailable', retryable: true });
    return globalThis.__fakeDevKit.state;
  }
}
`;

type Fake = {
  state?: unknown;
  status: string;
  sharing: boolean;
  listCalls: number;
  disconnects: number;
  signIns: Array<Record<string, unknown>>;
  profiles: Array<{ id: string; requiresNewRegistration?: boolean }>;
  config?: Record<string, unknown>;
  failure?: { code: string; message: string; retryable?: boolean };
  refresh?: (state: unknown) => unknown;
};
const g = globalThis as unknown as { __fakeDevKit: Fake };
const connected = (accessToken: string, expiresAt: number) => ({
  version: 2, // the decrypted stored-state version, not the file envelope's
  activeProfileId: 'p',
  profiles: [
    { id: 'p', status: 'connected', credentials: { accessToken, expiresAt } },
  ],
});

// The auth file's outer envelope (version 3), as the DevKit writes it.
const ENVELOPE = JSON.stringify({
  version: 3,
  provider: 'opendots-keychain-aes-256-gcm-v1',
  ciphertext: 'AAAA',
});

let dist: string;
let stateDir: string;
beforeEach(async () => {
  dist = await mkdtemp(join(tmpdir(), 'fake-devkit-'));
  stateDir = join(
    await mkdtemp(join(tmpdir(), 'opendots-state-')),
    'chatgpt-plan',
  );
  await writeFile(join(dist, 'index.js'), fakeIndex);
  await writeFile(join(dist, 'storage.js'), fakeStorage);
  g.__fakeDevKit = {
    status: 'connected',
    sharing: true,
    listCalls: 0,
    disconnects: 0,
    signIns: [],
    profiles: [],
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dist, { recursive: true, force: true });
  await rm(join(stateDir, '..'), { recursive: true, force: true });
});

const keychain = (backend: FakeBackend) =>
  createChatGPTPlanSession({
    devkitDist: dist,
    credentialStore: 'keychain',
    stateDir,
    keyBackend: backend,
  });

it('fails with an actionable message and keeps the underlying cause', async () => {
  const error = await createChatGPTPlanSession({
    devkitDist: join(dist, 'missing'),
  }).catch((e) => e);
  expect(error.message).toMatch(/CHATGPT_DEVKIT_DIST/);
  expect(error.cause).toBeInstanceOf(Error);
});

describe('token access', () => {
  it('returns a fresh stored token without touching the network', async () => {
    g.__fakeDevKit.state = connected('fresh-token', Date.now() + 3_600_000);
    const session = await createChatGPTPlanSession({ devkitDist: dist });
    await expect(session.auth.getAccessToken()).resolves.toBe('fresh-token');
    expect(g.__fakeDevKit.listCalls).toBe(0);
    await session.close();
  });

  it('lets the DevKit refresh a near-expiry token before reading it', async () => {
    g.__fakeDevKit.state = connected('old-token', Date.now() + 30_000);
    g.__fakeDevKit.refresh = () =>
      connected('new-token', Date.now() + 3_600_000);
    const session = await createChatGPTPlanSession({ devkitDist: dist });
    await expect(session.auth.getAccessToken()).resolves.toBe('new-token');
    expect(g.__fakeDevKit.listCalls).toBe(1);
    await session.close();
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
    await session.close();
  });
});

describe('sign-in', () => {
  it('reuses a saved profile instead of registering another', async () => {
    g.__fakeDevKit.profiles = [{ id: 'saved' }];
    const session = await createChatGPTPlanSession({ devkitDist: dist });
    await session.signIn();
    expect(g.__fakeDevKit.signIns[0]).toMatchObject({ profileId: 'saved' });
    expect(g.__fakeDevKit.signIns[0]).not.toHaveProperty('newProfile');
    await session.close();
  });

  it('registers a new profile only when none can be reused', async () => {
    const session = await createChatGPTPlanSession({ devkitDist: dist });
    await session.signIn();
    g.__fakeDevKit.profiles = [{ id: 'old', requiresNewRegistration: true }];
    await session.signIn();
    expect(g.__fakeDevKit.signIns).toEqual([
      expect.objectContaining({ newProfile: true }),
      expect.objectContaining({ newProfile: true }),
    ]);
    await session.close();
  });

  it('treats an account without plan sharing as an error', async () => {
    g.__fakeDevKit.sharing = false;
    const session = await createChatGPTPlanSession({ devkitDist: dist });
    await expect(session.status()).resolves.toEqual({ state: 'signed_out' });
    await expect(session.signIn()).rejects.toMatchObject({
      code: 'sharing_not_enabled',
    });
    await session.close();
  });

  it('passes a custom browser opener through to the DevKit', async () => {
    const openBrowser = vi.fn();
    const session = await createChatGPTPlanSession({
      devkitDist: dist,
      openBrowser,
    });
    expect(g.__fakeDevKit.config?.openBrowser).toBe(openBrowser);
    await session.close();
  });
});

describe('close() versus signOut()', () => {
  it('ephemeral close() signs out and deletes its temporary state', async () => {
    const before = process.listenerCount('exit');
    const session = await createChatGPTPlanSession({ devkitDist: dist });
    const directory = String(g.__fakeDevKit.config?.storageDir);
    expect(existsSync(directory)).toBe(true);
    expect(process.listenerCount('exit')).toBe(before + 1);
    await session.close();
    expect(g.__fakeDevKit.disconnects).toBe(1);
    expect(existsSync(directory)).toBe(false);
    expect(process.listenerCount('exit')).toBe(before);
  });

  it('keychain close() releases only: no revoke, no deletion, no Keychain change', async () => {
    const backend = new FakeBackend();
    const session = await keychain(backend);
    await session.status(); // first start creates the key
    await session.close();
    expect(g.__fakeDevKit.disconnects).toBe(0);
    expect(backend.deletes).toBe(0);
    expect(backend.keys.size).toBe(1);
    expect(existsSync(join(stateDir, 'opendots-key.json'))).toBe(true);
    // Closed: the cached key is gone, so nothing more can be sealed.
    await expect(session.status()).resolves.toMatchObject({
      state: 'unavailable',
    });
  });

  it('signOut() revokes, and reports when revocation could not be confirmed', async () => {
    const session = await keychain(new FakeBackend());
    await expect(session.signOut()).resolves.toEqual({ revoked: true });
    expect(g.__fakeDevKit.disconnects).toBe(1);
    await session.close();
  });
});

describe('Keychain-backed storage', () => {
  it('creates a private state directory, key id file and one key on first start', async () => {
    const backend = new FakeBackend();
    const session = await keychain(backend);
    g.__fakeDevKit.status = 'disconnected';
    await expect(session.status()).resolves.toEqual({ state: 'signed_out' });
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
    const file = join(stateDir, 'opendots-key.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const { keyId } = JSON.parse(await readFile(file, 'utf8'));
    expect(backend.keys.get(keyId)?.length).toBe(32);
    expect(backend.sets).toBe(1);
    await session.close();
  });

  it('reuses the same key after a restart', async () => {
    const backend = new FakeBackend();
    const first = await keychain(backend);
    await first.status();
    await first.close();
    const second = await keychain(backend);
    await expect(second.status()).resolves.toEqual({ state: 'signed_in' });
    expect(backend.sets).toBe(1);
    await second.close();
  });

  it('fails closed, and says why, when the Keychain cannot be read', async () => {
    const backend = new FakeBackend();
    backend.failing = true;
    const session = await keychain(backend);
    const status = await session.status();
    expect(status).toMatchObject({
      state: 'unavailable',
      failure: { code: 'keychain_unavailable' },
    });
    const error = await session.auth.getAccessToken().catch((e) => e);
    expect(error).toBeInstanceOf(ChatGPTPlanError);
    expect(error).toMatchObject({ code: 'keychain_unavailable', status: 503 });
    expect(error.message).toMatch(/Keychain/);
    await session.close();
  });

  it('refuses to mint a new key next to an existing encrypted file', async () => {
    const backend = new FakeBackend();
    const first = await keychain(backend);
    await first.status();
    await first.close();
    await writeFile(join(stateDir, 'chatgpt-auth.json'), ENVELOPE, {
      mode: 0o600,
    });
    backend.keys.clear(); // Keychain wiped, or a restore on another machine
    const session = await keychain(backend);
    expect(await session.status()).toMatchObject({
      state: 'unavailable',
      failure: { code: 'credential_key_missing' },
    });
    expect(backend.keys.size).toBe(0);
    expect(backend.sets).toBe(1); // only the original creation
    expect(await readFile(join(stateDir, 'chatgpt-auth.json'), 'utf8')).toBe(
      ENVELOPE,
    );
    const error = await session.auth.getAccessToken().catch((e) => e);
    expect(error).toMatchObject({
      code: 'credential_key_missing',
      status: 401,
    });
    expect(error.message).toMatch(/chatgpt-plan -- reset/);
    await session.close();
  });

  it('fails closed on a key id file that is not private', async () => {
    const backend = new FakeBackend();
    const first = await keychain(backend);
    await first.status();
    await first.close();
    await chmod(join(stateDir, 'opendots-key.json'), 0o644);
    const session = await keychain(backend);
    expect(await session.status()).toMatchObject({
      state: 'unavailable',
      failure: { code: 'state_dir_unsafe' },
    });
    await session.close();
  });

  it('never prints key material', async () => {
    const logs = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
    ];
    const backend = new FakeBackend();
    const session = await keychain(backend);
    await session.status();
    const key = [...backend.keys.values()][0];
    backend.keys.clear();
    const error = await session.auth.getAccessToken().catch((e) => e);
    const printed = JSON.stringify([
      logs.map((spy) => spy.mock.calls),
      String(error?.message),
    ]);
    expect(printed).not.toContain(key.toString('base64'));
    expect(printed).not.toContain(key.toString('hex'));
    await session.close();
  });
});

// The same restart story against the real DevKit storage, when it is present.
const realDist = resolve(
  process.env.CHATGPT_DEVKIT_DIST ??
    '../sign-in-with-chatgpt-devkit/packages/local/dist',
);
describe.skipIf(!existsSync(join(realDist, 'storage.js')))(
  'restart with the real DevKit storage',
  () => {
    const synthetic = {
      version: 2,
      activeProfileId: 'p1',
      profiles: [
        {
          version: 1,
          id: 'p1',
          label: 'Test',
          clientId: 'client_test',
          status: 'connected',
          scopes: ['chatgpt.tokens.use.direct'],
          savedAt: new Date().toISOString(),
          credentials: {
            accessToken: 'synthetic-access-token',
            expiresAt: Date.now() + 3_600_000,
          },
        },
      ],
      pendingRegistrations: [],
    };
    const realSession = (backend: KeyBackend) =>
      createChatGPTPlanSession({
        devkitDist: realDist,
        credentialStore: 'keychain',
        stateDir,
        keyBackend: backend,
      });
    // Writes a saved session the way the DevKit would, with our encryption.
    async function saveSession(backend: KeyBackend) {
      const { ConnectionStore } = await import(
        pathToFileURL(join(realDist, 'storage.js')).href
      );
      const encryption = sealedCredentialEncryption({
        id: KEYCHAIN_ENCRYPTION_ID,
        openKey: () => openPersistentKey({ stateDir, backend }),
      });
      const store = new ConnectionStore(stateDir, encryption);
      await store.withLock(() => store.write(synthetic));
      encryption.close();
    }

    it('restores a saved session without signing in, and fails closed otherwise', async () => {
      const backend = new FakeBackend();
      await saveSession(backend);
      const file = join(stateDir, 'chatgpt-auth.json');
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      const saved = await readFile(file, 'utf8');
      expect(saved).not.toContain('synthetic-access-token');

      const restarted = await realSession(backend);
      expect(await restarted.status()).toEqual({ state: 'signed_in' });
      expect(await restarted.auth.getAccessToken()).toBe(
        'synthetic-access-token',
      );
      await restarted.close();

      // Key gone: unavailable, never a silent re-key.
      const wiped = new FakeBackend();
      const noKey = await realSession(wiped);
      expect(await noKey.status()).toMatchObject({
        state: 'unavailable',
        failure: { code: 'credential_key_missing' },
      });
      expect(wiped.sets).toBe(0);
      await noKey.close();

      // Ciphertext damaged: unavailable, file preserved.
      const damaged = JSON.parse(saved);
      const bytes = Buffer.from(damaged.ciphertext, 'base64');
      bytes[bytes.length - 1] ^= 1;
      damaged.ciphertext = bytes.toString('base64');
      await writeFile(file, JSON.stringify(damaged), { mode: 0o600 });
      const tampered = await realSession(backend);
      expect(await tampered.status()).toMatchObject({
        state: 'unavailable',
        failure: { code: 'credential_ciphertext_invalid' },
      });
      expect(JSON.parse(await readFile(file, 'utf8')).ciphertext).toBe(
        damaged.ciphertext,
      );
      await tampered.close();
    });

    it('does not open a file written by another provider', async () => {
      const backend = new FakeBackend();
      await saveSession(backend);
      const { ConnectionStore } = await import(
        pathToFileURL(join(realDist, 'storage.js')).href
      );
      const other = sealedCredentialEncryption({
        id: 'opendots-ephemeral-aes-256-gcm-v1',
        openKey: async () => ({ keyId: 'x', key: Buffer.alloc(32, 1) }),
      });
      const store = new ConnectionStore(stateDir, other);
      await expect(store.withLock(() => store.read())).rejects.toMatchObject({
        code: 'storage_provider_mismatch',
      });
    });
  },
);
