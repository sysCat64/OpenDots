import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readdir, rm, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CredentialStoreError } from './credential-errors.js';
import {
  ensurePrivateDir,
  readPrivateFile,
  withFileLock,
  writePrivateFile,
} from './private-fs.js';

// Where the credential-encryption key lives, and how it is created, found and
// removed. The key is the only secret kept outside the DevKit's encrypted
// file; it never touches the filesystem.

const KEY_BYTES = 32;
export const KEYCHAIN_SERVICE = 'OpenDots ChatGPT plan credential key';

// Files the DevKit owns in the state directory (names are its storage layout)
// and the ones OpenDots adds.
const DEVKIT_AUTH_FILE = 'chatgpt-auth.json';
const DEVKIT_HOST_FILE = 'chatgpt-host.json';
const DEVKIT_LOCK = '.chatgpt-auth.lock';
const KEY_FILE = 'opendots-key.json';
const KEY_LOCK = '.opendots-key.lock';

export interface KeyBackend {
  /** Undefined when there is no key under this account. */
  get(account: string): Promise<Buffer | undefined>;
  /** Replaces any existing key: callers must have ruled out a concurrent create. */
  set(account: string, key: Buffer): Promise<void>;
  /** True when a key was removed. */
  delete(account: string): Promise<boolean>;
}

// randomBytes(32) -> base64 -> Keychain. Reading is strict: canonical base64
// of exactly 32 bytes, nothing else.
export const encodeKey = (key: Buffer) => key.toString('base64');
export function decodeKey(text: string) {
  const key = /^[A-Za-z0-9+/]{43}=$/.test(text)
    ? Buffer.from(text, 'base64')
    : undefined;
  if (key?.length !== KEY_BYTES || key.toString('base64') !== text)
    throw new CredentialStoreError('credential_key_invalid');
  return key;
}

interface KeyringEntry {
  setPassword(password: string, signal?: AbortSignal): Promise<void>;
  getPassword(signal?: AbortSignal): Promise<string | null | undefined>;
  deleteCredential(signal?: AbortSignal): Promise<boolean>;
}
interface KeyringModule {
  AsyncEntry: new (service: string, account: string) => KeyringEntry;
}
const KEYRING_MODULE = '@napi-rs/keyring';
const KEYCHAIN_TIMEOUT_MS = 10_000;

// macOS Keychain through the optional @napi-rs/keyring addon, which calls
// Security.framework directly (no `security` process, nothing in argv). Loaded
// on demand so no other mode needs it.
export class KeychainKeyBackend implements KeyBackend {
  private constructor(private keyring: KeyringModule) {}

  static async create() {
    if (process.platform !== 'darwin')
      throw new CredentialStoreError('unsupported_platform');
    let keyring: unknown;
    try {
      keyring = await import(KEYRING_MODULE);
    } catch (cause) {
      throw new CredentialStoreError('native_module_missing', { cause });
    }
    if (typeof (keyring as KeyringModule)?.AsyncEntry !== 'function')
      throw new CredentialStoreError('native_module_missing');
    return new KeychainKeyBackend(keyring as KeyringModule);
  }

  // Any native failure (locked, denied, no GUI session, ambiguous items, timed
  // out) means the store cannot be trusted right now.
  private async call<T>(
    account: string,
    operation: (entry: KeyringEntry, signal: AbortSignal) => Promise<T>,
  ) {
    try {
      return await operation(
        new this.keyring.AsyncEntry(KEYCHAIN_SERVICE, account),
        AbortSignal.timeout(KEYCHAIN_TIMEOUT_MS),
      );
    } catch (cause) {
      throw new CredentialStoreError('keychain_unavailable', { cause });
    }
  }

  async get(account: string) {
    const value = await this.call(account, (entry, signal) =>
      entry.getPassword(signal),
    );
    return value === null || value === undefined ? undefined : decodeKey(value);
  }

  async set(account: string, key: Buffer) {
    await this.call(account, (entry, signal) =>
      entry.setPassword(encodeKey(key), signal),
    );
  }

  delete(account: string) {
    return this.call(account, (entry, signal) =>
      entry.deleteCredential(signal),
    );
  }
}

export function defaultStateDir() {
  if (process.platform !== 'darwin')
    throw new CredentialStoreError('unsupported_platform');
  return join(
    homedir(),
    'Library',
    'Application Support',
    'OpenDots',
    'chatgpt-plan',
  );
}

const KEY_ID = /^[0-9a-f]{32}$/;

// The key id is not secret: it only names the Keychain item, so the state
// directory can move and several instances never share a key.
async function readKeyId(stateDir: string) {
  const text = await readPrivateFile(join(stateDir, KEY_FILE));
  if (text === undefined) return undefined;
  let parsed: { version?: unknown; keyId?: unknown };
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new CredentialStoreError('credential_key_invalid', { cause });
  }
  if (
    parsed.version !== 1 ||
    typeof parsed.keyId !== 'string' ||
    !KEY_ID.test(parsed.keyId)
  )
    throw new CredentialStoreError('credential_key_invalid');
  return parsed.keyId;
}

// Only a missing directory means "nothing saved"; anything else (permissions,
// a file in its place) must not be mistaken for it.
async function listStateDir(stateDir: string) {
  try {
    return await readdir(stateDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new CredentialStoreError('state_dir_unsafe', { cause: error });
  }
}

const exists = async (path: string) =>
  (await readPrivateFile(path).catch(() => '')) !== undefined;

// Finds the key, or creates it only on a truly first start. A missing key next
// to an existing encrypted file is never "fixed" by minting a new key: that
// would silently orphan the saved session, so it fails closed instead.
// Everything is idempotent, so any interruption (including kill -9) leaves a
// state the next start recovers from or reports.
export async function openPersistentKey(options: {
  stateDir: string;
  backend: KeyBackend;
}): Promise<{ keyId: string; key: Buffer }> {
  const { stateDir, backend } = options;
  await ensurePrivateDir(stateDir);
  return withFileLock(join(stateDir, KEY_LOCK), async () => {
    const saved = await exists(join(stateDir, DEVKIT_AUTH_FILE));
    let keyId = await readKeyId(stateDir);
    if (!keyId) {
      if (saved) throw new CredentialStoreError('credential_key_missing');
      keyId = randomBytes(16).toString('hex');
      await writePrivateFile(
        join(stateDir, KEY_FILE),
        JSON.stringify({ version: 1, keyId }),
      );
    }
    let key = await backend.get(keyId);
    if (!key) {
      if (saved) throw new CredentialStoreError('credential_key_missing');
      key = randomBytes(KEY_BYTES);
      await backend.set(keyId, key);
      const stored = await backend.get(keyId);
      if (!stored || !equalKeys(stored, key))
        throw new CredentialStoreError('credential_key_invalid');
    }
    if (key.length !== KEY_BYTES)
      throw new CredentialStoreError('credential_key_invalid');
    return { keyId, key };
  });
}

const equalKeys = (a: Buffer, b: Buffer) =>
  a.length === b.length && timingSafeEqual(a, b);

export interface CredentialInspection {
  stateDir: string;
  stateDirExists: boolean;
  files: { auth: boolean; host: boolean; key: boolean };
  keyIdPrefix?: string;
  keychainItem: 'present' | 'missing' | 'unreadable' | 'unknown';
  problem?: CredentialStoreError['code'];
}

// Read-only: never creates a key, a directory, or a file.
export async function inspectPersistentCredentials(options: {
  stateDir: string;
  backend: KeyBackend;
}): Promise<CredentialInspection> {
  const { stateDir, backend } = options;
  const listing = await listStateDir(stateDir);
  const result: CredentialInspection = {
    stateDir,
    stateDirExists: listing !== undefined,
    files: {
      auth: !!listing?.includes(DEVKIT_AUTH_FILE),
      host: !!listing?.includes(DEVKIT_HOST_FILE),
      key: !!listing?.includes(KEY_FILE),
    },
    keychainItem: 'unknown',
  };
  if (!result.files.key) {
    if (result.files.auth) result.problem = 'credential_key_missing';
    return result;
  }
  try {
    const keyId = await readKeyId(stateDir);
    result.keyIdPrefix = keyId?.slice(0, 8);
    result.keychainItem = (await backend.get(keyId!)) ? 'present' : 'missing';
    if (result.keychainItem === 'missing' && result.files.auth)
      result.problem = 'credential_key_missing';
  } catch (error) {
    result.keychainItem = 'unreadable';
    result.problem =
      error instanceof CredentialStoreError
        ? error.code
        : 'keychain_unavailable';
  }
  return result;
}

// Only files OpenDots or the DevKit created here; anything else in the
// directory is left alone.
const ownedName = (name: string) =>
  [DEVKIT_AUTH_FILE, DEVKIT_HOST_FILE, DEVKIT_LOCK, KEY_FILE].includes(name) ||
  /^\.chatgpt-auth\..*\.tmp$/.test(name) ||
  /^opendots-key\.json\..*\.tmp$/.test(name) ||
  /^\.opendots-key\.lock\.stale-/.test(name);

export interface ResetReport {
  keychainItem: 'deleted' | 'absent' | 'unknown';
  removed: string[];
}

// Removes everything OpenDots keeps for a saved session. The Keychain item goes
// first: if the process dies midway, the leftover files point at a missing key
// (reported and re-runnable), never the reverse (an unreachable orphan key).
export async function resetPersistentCredentials(options: {
  stateDir: string;
  backend: KeyBackend;
}): Promise<ResetReport> {
  const { stateDir, backend } = options;
  const listing = await listStateDir(stateDir);
  if (!listing) return { keychainItem: 'unknown', removed: [] };
  await ensurePrivateDir(stateDir);
  return withFileLock(join(stateDir, KEY_LOCK), async () => {
    const keyId = await readKeyId(stateDir).catch(() => undefined);
    let keychainItem: ResetReport['keychainItem'] = 'unknown';
    if (keyId)
      keychainItem = (await backend.delete(keyId)) ? 'deleted' : 'absent';
    const removed: string[] = [];
    for (const name of await listStateDir(stateDir).then(
      (names) => names ?? [],
    )) {
      if (!ownedName(name)) continue;
      await rm(join(stateDir, name), { recursive: true, force: true });
      removed.push(name);
    }
    return { keychainItem, removed };
  }).finally(() => rmdir(stateDir).catch(() => undefined));
}
