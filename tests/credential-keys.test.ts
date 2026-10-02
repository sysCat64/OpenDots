import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KeychainKeyBackend,
  decodeKey,
  defaultStateDir,
  encodeKey,
  inspectPersistentCredentials,
  openPersistentKey,
  resetPersistentCredentials,
} from '../src/server/credential-keys.js';
import { FakeBackend } from './fixtures/key-backend.js';

// These tests do real filesystem and process work; leave headroom on a loaded machine.
vi.setConfig({ testTimeout: 20_000 });

let stateDir: string;
beforeEach(async () => {
  stateDir = join(await mkdtemp(join(tmpdir(), 'cred-keys-')), 'state');
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.doUnmock('@napi-rs/keyring');
  await rm(join(stateDir, '..'), { recursive: true, force: true });
});
const keyFile = () => join(stateDir, 'opendots-key.json');
const AUTH = () => join(stateDir, 'chatgpt-auth.json');

describe('key encoding', () => {
  it('round-trips exactly 32 bytes as canonical base64', () => {
    const key = randomBytes(32);
    expect(encodeKey(key)).toHaveLength(44);
    expect(decodeKey(encodeKey(key)).equals(key)).toBe(true);
  });

  it.each([
    ['too short', randomBytes(31).toString('base64')],
    ['too long', randomBytes(33).toString('base64')],
    // 0xfb bytes encode to '+' and '/' (base64) or '-' and '_' (url-safe).
    ['url-safe alphabet', Buffer.alloc(32, 0xfb).toString('base64url') + '='],
    ['no padding', randomBytes(32).toString('base64').replace(/=+$/, '')],
    ['trailing newline', encodeKey(randomBytes(32)) + '\n'],
    ['leading space', ' ' + encodeKey(randomBytes(32))],
    ['non-canonical padding bits', 'A'.repeat(42) + 'B='],
    ['empty', ''],
    ['not base64', 'x'.repeat(44)],
    ['hex', randomBytes(32).toString('hex')],
  ])('rejects %s', (_name, text) => {
    expect(() => decodeKey(text)).toThrow(/damaged/);
    try {
      decodeKey(text);
    } catch (error) {
      expect(error).toMatchObject({ code: 'credential_key_invalid' });
      if (text.trim().length > 8)
        expect((error as Error).message).not.toContain(text.trim());
    }
  });
});

describe('openPersistentKey', () => {
  it('creates a private directory, a key id file and one key on first start', async () => {
    const backend = new FakeBackend();
    const { keyId, key } = await openPersistentKey({ stateDir, backend });
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
    expect((await stat(keyFile())).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(keyFile(), 'utf8'))).toEqual({
      version: 1,
      keyId,
    });
    expect(key).toHaveLength(32);
    expect(backend.keys.get(keyId)?.equals(key)).toBe(true);
    expect(existsSync(join(stateDir, '.opendots-key.lock'))).toBe(false);
  });

  it('keeps the key out of every file', async () => {
    const backend = new FakeBackend();
    const { key } = await openPersistentKey({ stateDir, backend });
    for (const name of await readdir(stateDir)) {
      const text = await readFile(join(stateDir, name), 'utf8').catch(() => '');
      expect(text).not.toContain(key.toString('base64'));
      expect(text).not.toContain(key.toString('hex'));
    }
  });

  it('returns the same key on the next start', async () => {
    const backend = new FakeBackend();
    const first = await openPersistentKey({ stateDir, backend });
    const second = await openPersistentKey({ stateDir, backend });
    expect(second.keyId).toBe(first.keyId);
    expect(second.key.equals(first.key)).toBe(true);
    expect(backend.sets).toBe(1);
  });

  it('creates exactly one key when several processes start together', async () => {
    const backend = new FakeBackend();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => openPersistentKey({ stateDir, backend })),
    );
    expect(backend.sets).toBe(1);
    expect(new Set(results.map((r) => r.key.toString('hex'))).size).toBe(1);
  });

  it('recovers when a crash left a key id but no key', async () => {
    const backend = new FakeBackend();
    await mkdir(stateDir, { mode: 0o700 });
    const keyId = 'a'.repeat(32);
    await writeFile(keyFile(), JSON.stringify({ version: 1, keyId }), {
      mode: 0o600,
    });
    const opened = await openPersistentKey({ stateDir, backend });
    expect(opened.keyId).toBe(keyId);
    expect(backend.keys.get(keyId)).toBeDefined();
  });

  it('reuses a key created just before a crash, before any file was saved', async () => {
    const backend = new FakeBackend();
    const first = await openPersistentKey({ stateDir, backend });
    const again = await openPersistentKey({ stateDir, backend });
    expect(again.key.equals(first.key)).toBe(true);
    expect(backend.sets).toBe(1);
  });

  it('refuses to create a key next to an existing encrypted file', async () => {
    const backend = new FakeBackend();
    await openPersistentKey({ stateDir, backend });
    await writeFile(AUTH(), '{"version":3}', { mode: 0o600 });
    backend.keys.clear();
    const sets = backend.sets;
    await expect(
      openPersistentKey({ stateDir, backend }),
    ).rejects.toMatchObject({ code: 'credential_key_missing' });
    expect(backend.sets).toBe(sets);
    // No key id file either: still not a first start.
    await rm(keyFile());
    await expect(
      openPersistentKey({ stateDir, backend }),
    ).rejects.toMatchObject({ code: 'credential_key_missing' });
    expect(existsSync(keyFile())).toBe(false);
    expect(await readFile(AUTH(), 'utf8')).toBe('{"version":3}');
  });

  it('treats a non-private encrypted file as present rather than overwriting', async () => {
    const backend = new FakeBackend();
    await mkdir(stateDir, { mode: 0o700 });
    await writeFile(AUTH(), 'x', { mode: 0o644 });
    await expect(
      openPersistentKey({ stateDir, backend }),
    ).rejects.toMatchObject({ code: 'credential_key_missing' });
  });

  it.each([
    ['malformed JSON', '{nope'],
    ['wrong version', JSON.stringify({ version: 2, keyId: 'a'.repeat(32) })],
    ['bad key id', JSON.stringify({ version: 1, keyId: '../../etc' })],
  ])('fails closed on a key id file with %s', async (_name, content) => {
    await mkdir(stateDir, { mode: 0o700 });
    await writeFile(keyFile(), content, { mode: 0o600 });
    await expect(
      openPersistentKey({ stateDir, backend: new FakeBackend() }),
    ).rejects.toMatchObject({ code: 'credential_key_invalid' });
  });

  it('fails closed on a wrong-length key', async () => {
    const backend = new FakeBackend();
    const { keyId } = await openPersistentKey({ stateDir, backend });
    backend.keys.set(keyId, randomBytes(16));
    await expect(
      openPersistentKey({ stateDir, backend }),
    ).rejects.toMatchObject({ code: 'credential_key_invalid' });
  });

  it('does not trust a key that does not read back', async () => {
    const backend = new FakeBackend();
    backend.set = async () => {
      backend.sets += 1;
    };
    await expect(
      openPersistentKey({ stateDir, backend }),
    ).rejects.toMatchObject({ code: 'credential_key_invalid' });
  });

  it('does not leave a permanent lock behind when the backend fails', async () => {
    const backend = new FakeBackend();
    backend.failing = true;
    await expect(
      openPersistentKey({ stateDir, backend }),
    ).rejects.toBeDefined();
    expect(existsSync(join(stateDir, '.opendots-key.lock'))).toBe(false);
    backend.failing = false;
    await expect(
      openPersistentKey({ stateDir, backend }),
    ).resolves.toBeDefined();
  });
});

describe('inspectPersistentCredentials', () => {
  it('reports a pristine system without creating anything', async () => {
    const backend = new FakeBackend();
    const found = await inspectPersistentCredentials({ stateDir, backend });
    expect(found).toMatchObject({
      stateDirExists: false,
      files: { auth: false, key: false },
      keychainItem: 'unknown',
    });
    expect(found.problem).toBeUndefined();
    expect(existsSync(stateDir)).toBe(false);
    expect(backend.sets).toBe(0);
  });

  it('flags a saved session whose key is gone, or a Keychain that cannot be read', async () => {
    const backend = new FakeBackend();
    await openPersistentKey({ stateDir, backend });
    await writeFile(AUTH(), '{}', { mode: 0o600 });
    expect(
      await inspectPersistentCredentials({ stateDir, backend }),
    ).toMatchObject({
      keychainItem: 'present',
    });
    backend.keys.clear();
    expect(
      await inspectPersistentCredentials({ stateDir, backend }),
    ).toMatchObject({
      keychainItem: 'missing',
      problem: 'credential_key_missing',
    });
    backend.failing = true;
    expect(
      await inspectPersistentCredentials({ stateDir, backend }),
    ).toMatchObject({
      keychainItem: 'unreadable',
      problem: 'keychain_unavailable',
    });
  });

  it('shows only a short key id prefix', async () => {
    const backend = new FakeBackend();
    const { keyId } = await openPersistentKey({ stateDir, backend });
    const found = await inspectPersistentCredentials({ stateDir, backend });
    expect(found.keyIdPrefix).toBe(keyId.slice(0, 8));
    expect(JSON.stringify(found)).not.toContain(keyId);
  });
});

describe('state directory that cannot be listed', () => {
  // Only a missing directory means "nothing saved". A file in its place, or a
  // directory we may not read, is reported, never treated as absent.
  const breakers: Array<[string, () => Promise<void>]> = [
    [
      'a file where the directory should be (ENOTDIR)',
      async () => {
        await mkdir(join(stateDir, '..'), { recursive: true });
        await writeFile(stateDir, 'not a directory');
      },
    ],
  ];
  if (process.getuid?.() !== 0)
    breakers.push([
      'a directory that cannot be read (EACCES)',
      async () => {
        await mkdir(stateDir, { recursive: true, mode: 0o700 });
        await chmod(stateDir, 0o000);
      },
    ]);
  afterEach(async () => {
    await chmod(stateDir, 0o700).catch(() => undefined);
  });

  it.each(breakers)(
    'inspect reports %s as state_dir_unsafe',
    async (_name, arrange) => {
      await arrange();
      await expect(
        inspectPersistentCredentials({ stateDir, backend: new FakeBackend() }),
      ).rejects.toMatchObject({ code: 'state_dir_unsafe' });
    },
  );

  it.each(breakers)(
    'reset reports %s as state_dir_unsafe and touches nothing',
    async (_name, arrange) => {
      await arrange();
      const backend = new FakeBackend();
      await expect(
        resetPersistentCredentials({ stateDir, backend }),
      ).rejects.toMatchObject({ code: 'state_dir_unsafe' });
      expect(backend.deletes).toBe(0);
    },
  );

  it('still treats a missing directory as nothing saved', async () => {
    const backend = new FakeBackend();
    expect(
      await inspectPersistentCredentials({ stateDir, backend }),
    ).toMatchObject({ stateDirExists: false });
    expect(await resetPersistentCredentials({ stateDir, backend })).toEqual({
      keychainItem: 'unknown',
      removed: [],
    });
  });
});

describe('resetPersistentCredentials', () => {
  it('removes the Keychain item first, then every file of ours, and is repeatable', async () => {
    const backend = new FakeBackend();
    const { keyId } = await openPersistentKey({ stateDir, backend });
    await writeFile(AUTH(), '{}', { mode: 0o600 });
    await writeFile(join(stateDir, 'chatgpt-host.json'), '{}', { mode: 0o600 });
    await mkdir(join(stateDir, '.chatgpt-auth.lock'));
    await writeFile(join(stateDir, '.chatgpt-auth.1234.tmp'), 'x');
    await writeFile(join(stateDir, 'unrelated.txt'), 'keep me');
    backend.onDelete = async () => {
      expect(existsSync(AUTH())).toBe(true); // files still there when the key goes
    };
    const report = await resetPersistentCredentials({ stateDir, backend });
    expect(report.keychainItem).toBe('deleted');
    expect(backend.keys.has(keyId)).toBe(false);
    expect(report.removed.sort()).toEqual(
      [
        '.chatgpt-auth.1234.tmp',
        '.chatgpt-auth.lock',
        'chatgpt-auth.json',
        'chatgpt-host.json',
        'opendots-key.json',
      ].sort(),
    );
    expect(await readdir(stateDir)).toEqual(['unrelated.txt']);
    const again = await resetPersistentCredentials({ stateDir, backend });
    expect(again.removed).toEqual([]);
  });

  it('removes the now-empty state directory and tolerates a missing one', async () => {
    const backend = new FakeBackend();
    await openPersistentKey({ stateDir, backend });
    await resetPersistentCredentials({ stateDir, backend });
    expect(existsSync(stateDir)).toBe(false);
    await expect(
      resetPersistentCredentials({ stateDir, backend }),
    ).resolves.toEqual({ keychainItem: 'unknown', removed: [] });
  });

  it('can be re-run after being interrupted once the Keychain item is gone', async () => {
    const backend = new FakeBackend();
    const { keyId } = await openPersistentKey({ stateDir, backend });
    await writeFile(AUTH(), '{}', { mode: 0o600 });
    backend.keys.delete(keyId); // died right after deleting the item
    const report = await resetPersistentCredentials({ stateDir, backend });
    expect(report.keychainItem).toBe('absent');
    expect(existsSync(AUTH())).toBe(false);
  });
});

describe('KeychainKeyBackend', () => {
  const entries = new Map<string, string>();
  const calls: string[] = [];
  function mockKeyring(behaviour: { fail?: boolean } = {}) {
    vi.doMock('@napi-rs/keyring', () => ({
      AsyncEntry: class {
        constructor(
          private service: string,
          private account: string,
        ) {}
        private id() {
          return `${this.service}/${this.account}`;
        }
        async setPassword(value: string) {
          if (behaviour.fail) throw new Error('errSecInteractionNotAllowed');
          calls.push(value);
          entries.set(this.id(), value);
        }
        async getPassword() {
          if (behaviour.fail) throw new Error('errSecInteractionNotAllowed');
          return entries.get(this.id()) ?? null;
        }
        async deleteCredential() {
          return entries.delete(this.id());
        }
      },
    }));
  }
  const platform = (value: string) =>
    vi
      .spyOn(process, 'platform', 'get')
      .mockReturnValue(value as NodeJS.Platform);

  it('stores base64 and returns the same 32 bytes; a missing item is undefined', async () => {
    platform('darwin');
    mockKeyring();
    const backend = await KeychainKeyBackend.create();
    const key = randomBytes(32);
    expect(await backend.get('acct')).toBeUndefined();
    await backend.set('acct', key);
    expect(calls.at(-1)).toBe(key.toString('base64'));
    expect((await backend.get('acct'))?.equals(key)).toBe(true);
    expect(await backend.delete('acct')).toBe(true);
    expect(await backend.delete('acct')).toBe(false);
  });

  it('rejects a stored value that is not strict base64 of 32 bytes', async () => {
    platform('darwin');
    mockKeyring();
    const backend = await KeychainKeyBackend.create();
    entries.set('OpenDots ChatGPT plan credential key/acct', 'not-a-key');
    await expect(backend.get('acct')).rejects.toMatchObject({
      code: 'credential_key_invalid',
    });
  });

  it('reports any native failure as an unavailable Keychain', async () => {
    platform('darwin');
    mockKeyring({ fail: true });
    const backend = await KeychainKeyBackend.create();
    const error = await backend.get('acct').catch((e) => e);
    expect(error).toMatchObject({ code: 'keychain_unavailable' });
    expect(error.message).not.toContain('errSec');
    await expect(backend.set('acct', randomBytes(32))).rejects.toMatchObject({
      code: 'keychain_unavailable',
    });
  });

  it('is macOS-only and says so, including for the default directory', async () => {
    platform('linux');
    await expect(KeychainKeyBackend.create()).rejects.toMatchObject({
      code: 'unsupported_platform',
    });
    expect(() => defaultStateDir()).toThrow(/macOS only/);
  });

  it('names the missing optional dependency when the addon cannot load', async () => {
    platform('darwin');
    vi.doMock('@napi-rs/keyring', () => {
      throw new Error('Cannot find module');
    });
    await expect(KeychainKeyBackend.create()).rejects.toMatchObject({
      code: 'native_module_missing',
    });
  });

  it('defaults the state directory to Application Support on macOS', () => {
    platform('darwin');
    expect(defaultStateDir()).toMatch(
      /Library\/Application Support\/OpenDots\/chatgpt-plan$/,
    );
  });
});
