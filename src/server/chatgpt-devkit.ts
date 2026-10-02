import { access, mkdtemp, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ChatGPTPlanError,
  type ChatGPTPlanAuth,
  type ChatGPTPlanModel,
} from './chatgpt-plan.js';
import {
  CredentialStoreError,
  credentialFailureHint,
  type CredentialStoreErrorCode,
} from './credential-errors.js';
import {
  KeychainKeyBackend,
  defaultStateDir,
  openPersistentKey,
  type KeyBackend,
} from './credential-keys.js';
import {
  DEVKIT_REFRESH_WINDOW_MS,
  DevKitIncompatibleError,
  MIN_VALID_TOKEN_MS,
  assessDevKit,
  clientProblems,
  exportProblems,
  preflightAuthEnvelope,
  storedStateTokenSource,
  type DevKitCompatibility,
  type TokenSource,
} from './devkit-compat.js';
import { ModelCatalog } from './model-catalog.js';
import { ensurePrivateDir } from './private-fs.js';
import {
  memoryKeySource,
  sealedCredentialEncryption,
} from './sealed-encryption.js';

// Adapter for the Sign in with ChatGPT DevKit. The DevKit is a separate,
// noncommercially licensed project: OpenDots neither bundles nor copies it. It
// is loaded at runtime from a directory the owner supplies.
//
// What is public API and what is not is spelled out in devkit-compat.ts and
// docs/CHATGPT_PLAN.md. In short: signing in, the session status, the model
// list, sign-out and the credential-encryption hook are public. Reading the
// access token is not: the DevKit offers no public way to get one (and its
// streamResponse() cannot carry tools), so the token is read from its stored
// state through a TokenSource, checked against the minimum shape relied on.
// Anything that does not match is reported as devkit_incompatible. It is never
// turned into a sign-out, never worked around, and never written to.

interface DevKitSession {
  status: string;
  sharing: boolean;
  error?: { code: string; message: string };
}
interface DevKitProfile {
  id: string;
  requiresNewRegistration?: boolean;
}
interface DevKitClient {
  signIn(options?: {
    newProfile?: boolean;
    profileId?: string;
    label?: string;
    signal?: AbortSignal;
  }): Promise<DevKitSession>;
  getSession(): Promise<DevKitSession>;
  listProfiles(): Promise<DevKitProfile[]>;
  listModels(options?: { signal?: AbortSignal }): Promise<ChatGPTPlanModel[]>;
  disconnect(): Promise<void>;
}
interface DevKitStore {
  withLock<T>(operation: () => Promise<T>): Promise<T>;
  read(): Promise<unknown>;
}
type Encryption = ReturnType<typeof sealedCredentialEncryption>;
interface DevKit {
  createChatGPT(config: Record<string, unknown>): DevKitClient;
  ConnectionStore: new (
    directory: string,
    encryption: Encryption,
  ) => DevKitStore;
  info: DevKitCompatibility;
}

const EPHEMERAL_ID = 'opendots-ephemeral-aes-256-gcm-v1';
export const KEYCHAIN_ENCRYPTION_ID = 'opendots-keychain-aes-256-gcm-v1';
const KEYCHAIN_ID = KEYCHAIN_ENCRYPTION_ID;

// The public SessionState.status values.
const KNOWN_STATUSES = [
  'disconnected',
  'connecting',
  'connected',
  'reauth_required',
];
// The DevKit's own list of failures that mean "sign in again". The set of error
// codes is open (some come from the server), so this only sharpens the HTTP
// status of requests; it never decides whether the owner is signed out.
const NEEDS_SIGN_IN_CODES = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);
const isStorageCode = (code: string) =>
  code.startsWith('storage_') || code.startsWith('host_identity');

const wrongPath = (cause?: unknown) =>
  new Error(
    'CHATGPT_DEVKIT_DIST must point to the built packages/local/dist directory of the Sign in with ChatGPT DevKit.',
    { cause },
  );

// So that a wrong path reads as a wrong path (and not, in strict mode, as an
// unrecorded build) before anything is assessed or loaded.
async function requireDist(dist: string) {
  try {
    await Promise.all(
      ['index.js', 'storage.js'].map((file) => access(join(dist, file))),
    );
  } catch (cause) {
    throw wrongPath(cause);
  }
}

export async function loadDevKit(
  distDir: string,
  options: { strict?: boolean } = {},
): Promise<DevKit> {
  const dist = resolve(distDir);
  await requireDist(dist);
  // 1. Identify the build, and apply strict mode, before any of its code runs:
  //    a build that strict mode refuses is never imported.
  const info = await assessDevKit(dist, options);
  // 2. Load it.
  let main: Record<string, unknown>;
  let storage: Record<string, unknown>;
  try {
    [main, storage] = await Promise.all([
      import(pathToFileURL(join(dist, 'index.js')).href),
      import(pathToFileURL(join(dist, 'storage.js')).href),
    ]);
  } catch (cause) {
    throw wrongPath(cause);
  }
  // 3. Check what it provides.
  const problems = exportProblems(main, storage);
  if (problems.length) throw new DevKitIncompatibleError(problems.join('; '));
  return {
    createChatGPT: main.createChatGPT as DevKit['createChatGPT'],
    ConnectionStore: storage.ConnectionStore as DevKit['ConnectionStore'],
    info,
  };
}

export interface DevKitInspection {
  /** ok: usable. incompatible: found, but refused. not_found: no usable DevKit at the path. */
  outcome: 'ok' | 'incompatible' | 'not_found';
  compatibility?: DevKitCompatibility;
  reason?: string;
}

// For reporting (the CLI): never throws, and still shows what the build is when
// it is refused.
export async function inspectDevKit(
  distDir: string,
  options: { strict?: boolean } = {},
): Promise<DevKitInspection> {
  try {
    const dist = resolve(distDir);
    await requireDist(dist);
    // Same order as loading: a build strict mode refuses is not imported here
    // either, even just to report on it.
    const info = await assessDevKit(dist);
    if (options.strict && info.compatibility === 'untested')
      return {
        outcome: 'incompatible',
        compatibility: info,
        reason: 'strict mode refuses a build that is not recorded as verified',
      };
    await loadDevKit(dist);
    return { outcome: 'ok', compatibility: info };
  } catch (error) {
    if (error instanceof DevKitIncompatibleError)
      return { outcome: 'incompatible', reason: error.reason };
    return { outcome: 'not_found' };
  }
}

// Whether the owner, not the model, has to act before this can work.
export type ChatGPTPlanStatus =
  | { state: 'signed_in' | 'signed_out' }
  | { state: 'unavailable'; failure: { code: string; hint: string } };

export interface ChatGPTPlanSession {
  readonly credentialStore: 'ephemeral' | 'keychain';
  /** What is known about the DevKit build in use. */
  readonly devkit: DevKitCompatibility;
  auth: ChatGPTPlanAuth;
  /** The one cache of this account's models; `auth.listModels` reads it. */
  readonly models: ModelCatalog;
  /** Reads the saved session. Never opens a browser. */
  status(): Promise<ChatGPTPlanStatus>;
  /** Opens the browser. Reuses a saved profile rather than registering another. */
  signIn(signal?: AbortSignal): Promise<void>;
  /** Revokes the tokens remotely and clears them locally; keeps the key and registration. */
  signOut(): Promise<{ revoked: boolean }>;
  /**
   * Releases this process's resources. A persistent session stays signed in:
   * nothing is revoked, deleted, or removed from the Keychain. An ephemeral
   * session has no future, so it also signs out and deletes its temporary state.
   */
  close(): Promise<void>;
}

export interface ChatGPTPlanSessionOptions {
  devkitDist: string;
  /** Refuse a DevKit build that is not recorded as verified. */
  devkitStrict?: boolean;
  /** Defaults to ephemeral: the sign-in does not outlive the process. */
  credentialStore?: 'ephemeral' | 'keychain';
  /** Keychain mode. Defaults to ~/Library/Application Support/OpenDots/chatgpt-plan. */
  stateDir?: string;
  /** Keychain mode: a replacement for the macOS Keychain (tests). */
  keyBackend?: KeyBackend;
  openBrowser?: (url: string) => Promise<void> | void;
}

export async function createChatGPTPlanSession(
  options: ChatGPTPlanSessionOptions,
): Promise<ChatGPTPlanSession> {
  const devkit = await loadDevKit(options.devkitDist, {
    strict: options.devkitStrict,
  });
  const credentialStore = options.credentialStore ?? 'ephemeral';

  let failure: CredentialStoreErrorCode | undefined;
  const onFailure = (code: CredentialStoreErrorCode | undefined) => {
    failure = code;
  };
  let storageDir: string;
  let encryption: Encryption;
  let removeStorageDir: (() => void) | undefined;
  if (credentialStore === 'keychain') {
    const backend = options.keyBackend ?? (await KeychainKeyBackend.create());
    const stateDir = options.stateDir ?? defaultStateDir();
    await ensurePrivateDir(stateDir);
    storageDir = stateDir;
    encryption = sealedCredentialEncryption({
      id: KEYCHAIN_ID,
      openKey: () => openPersistentKey({ stateDir, backend }),
      onFailure,
    });
  } else {
    const directory = await mkdtemp(join(tmpdir(), 'opendots-chatgpt-'));
    storageDir = directory;
    encryption = sealedCredentialEncryption({
      id: EPHEMERAL_ID,
      openKey: memoryKeySource(),
    });
    // Last resort if the process exits without a graceful close().
    removeStorageDir = () =>
      rmSync(directory, { recursive: true, force: true });
    process.once('exit', removeStorageDir);
  }

  let client: DevKitClient;
  let store: DevKitStore;
  try {
    client = devkit.createChatGPT({
      appName: 'OpenDots',
      appId: 'opendots',
      redirectPort: 0,
      storageDir,
      credentialEncryption: encryption,
      ...(options.openBrowser ? { openBrowser: options.openBrowser } : {}),
    });
    const problems = clientProblems(client);
    if (problems.length) throw new DevKitIncompatibleError(problems.join('; '));
    store = new devkit.ConnectionStore(storageDir, encryption);
  } catch (error) {
    // Do not leave the temporary directory of a session that never started.
    if (removeStorageDir) {
      process.removeListener('exit', removeStorageDir);
      removeStorageDir();
    }
    throw error;
  }
  const tokenSource: TokenSource = storedStateTokenSource(store);

  // In the persistent store, look at the saved session's outer envelope before
  // any DevKit call that reads it: the DevKit migrates and rewrites formats it
  // knows, and an unrecognized one must reach neither its read() nor a write.
  const guard = async () => {
    if (credentialStore === 'keychain') await preflightAuthEnvelope(storageDir);
  };

  // The DevKit hides why its storage failed. When we know (a missing key, an
  // unreadable Keychain), say so and say how to recover.
  const toPlanError = (error: unknown, signal?: AbortSignal): unknown => {
    if (
      signal?.aborted ||
      !(error instanceof Error) ||
      error instanceof ChatGPTPlanError
    )
      return error;
    const { code, retryable } = error as {
      code?: unknown;
      retryable?: unknown;
    };
    if (typeof code !== 'string' || code === 'cancelled') return error;
    if (failure && code.startsWith('storage_'))
      return new ChatGPTPlanError(
        failure,
        credentialFailureHint(failure),
        failure === 'keychain_unavailable' || failure === 'lock_timeout'
          ? 503
          : 401,
      );
    // The DevKit's own `retryable` is authoritative; the code set is open.
    return new ChatGPTPlanError(
      code,
      error.message,
      retryable === true
        ? 503
        : NEEDS_SIGN_IN_CODES.has(code) || /sign_in|sharing|reauth/.test(code)
          ? 401
          : 502,
    );
  };
  const listModels = async (signal?: AbortSignal) => {
    try {
      await guard();
      return await client.listModels({ signal });
    } catch (error) {
      throw toPlanError(error, signal);
    }
  };
  // Uncached `listModels` above is how a token refresh is requested; everything
  // else reads the shared catalog.
  const catalog = new ModelCatalog((signal) => listModels(signal));

  // The DevKit refreshes inside authenticated requests such as listModels(), and
  // only when 60 s or less remain. Ask only then, and do not assume the call
  // worked: read the state again and require a usable token. OpenDots never
  // refreshes OAuth tokens itself (the DevKit's rotation checkpoint would break).
  let refreshing: Promise<void> | undefined;
  const refresh = (signal?: AbortSignal) =>
    (refreshing ??= listModels(signal)
      .then(() => undefined)
      .finally(() => {
        refreshing = undefined;
      }));
  const freshAccessToken = async (signal?: AbortSignal) => {
    await guard();
    let token = await tokenSource.read();
    if (token && token.expiresAt - Date.now() <= DEVKIT_REFRESH_WINDOW_MS) {
      await refresh(signal);
      token = await tokenSource.read();
    }
    if (!token)
      throw new ChatGPTPlanError(
        'sign_in_required',
        'Sign in with ChatGPT to continue.',
        401,
      );
    if (token.expiresAt - Date.now() < MIN_VALID_TOKEN_MS)
      throw new ChatGPTPlanError(
        'token_not_refreshed',
        'The ChatGPT access token could not be renewed. Try again shortly.',
        503,
      );
    return token.accessToken;
  };

  // Checked once per sign-in: that the saved state has the shape we read.
  let shapeVerified = false;
  const unavailable = (error: unknown): ChatGPTPlanStatus => {
    if (error instanceof CredentialStoreError)
      return {
        state: 'unavailable',
        failure: { code: error.code, hint: credentialFailureHint(error.code) },
      };
    const converted = toPlanError(error);
    return {
      state: 'unavailable',
      failure:
        converted instanceof ChatGPTPlanError
          ? { code: converted.code, hint: converted.message }
          : {
              code: 'status_failed',
              hint: 'The ChatGPT connection could not be read.',
            },
    };
  };
  const signOut = async () => {
    shapeVerified = false;
    catalog.clear();
    try {
      await guard();
      await client.disconnect();
      return { revoked: true };
    } catch (error) {
      // The DevKit has already cleared the local tokens; only the remote
      // revocation could not be confirmed.
      if ((error as { code?: unknown })?.code === 'revocation_failed')
        return { revoked: false };
      throw toPlanError(error);
    }
  };
  let closed = false;

  return {
    credentialStore,
    devkit: devkit.info,
    models: catalog,
    auth: {
      listModels: (signal, options) =>
        catalog.list({ signal, force: options?.force }),
      async getAccessToken(signal) {
        try {
          return await freshAccessToken(signal);
        } catch (error) {
          throw toPlanError(error, signal);
        }
      },
    },
    async status() {
      try {
        await guard();
      } catch (error) {
        return unavailable(error);
      }
      const session = await client.getSession();
      if (!KNOWN_STATUSES.includes(session.status))
        return unavailable(
          new DevKitIncompatibleError('an unrecognized connection status'),
        );
      if (session.status === 'connected') {
        // The saved state of a connected profile must have the shape OpenDots
        // reads, whatever the sharing flag says: check it before looking at that.
        if (!shapeVerified)
          try {
            await tokenSource.read();
            shapeVerified = true;
          } catch (error) {
            return unavailable(error);
          }
        return { state: session.sharing ? 'signed_in' : 'signed_out' };
      }
      const code = session.error?.code;
      if (!code) return { state: 'signed_out' };
      if (isStorageCode(code))
        return {
          state: 'unavailable',
          failure: failure
            ? { code: failure, hint: credentialFailureHint(failure) }
            : { code, hint: session.error?.message ?? code },
        };
      // An error comes with a signed-out status. It may be a failure to read
      // the saved session, or only an earlier request's error that the DevKit
      // remembers (a failed revocation, an expired refresh). What the saved
      // state itself says decides, never the error's name.
      try {
        await tokenSource.read();
        return { state: 'signed_out' };
      } catch (error) {
        return unavailable(error);
      }
    },
    async signIn(signal) {
      shapeVerified = false;
      let session: DevKitSession;
      try {
        await guard();
        const saved = (await client.listProfiles()).find(
          (profile) => !profile.requiresNewRegistration,
        );
        session = await client.signIn({
          ...(saved ? { profileId: saved.id } : { newProfile: true }),
          signal,
        });
      } catch (error) {
        throw toPlanError(error, signal);
      }
      if (!session.sharing)
        throw new ChatGPTPlanError(
          'sharing_not_enabled',
          'ChatGPT plan sharing is not enabled for this account.',
          401,
        );
      // Possibly a different account than before.
      catalog.clear();
      // The DevKit has saved the session. Make sure it is one OpenDots can use.
      try {
        await tokenSource.read();
        shapeVerified = true;
      } catch (error) {
        throw toPlanError(error);
      }
    },
    signOut,
    async close() {
      if (closed) return;
      closed = true;
      if (credentialStore === 'ephemeral') {
        await signOut().catch(() => undefined);
        if (removeStorageDir) process.removeListener('exit', removeStorageDir);
        await rm(storageDir, { recursive: true, force: true });
      }
      catalog.clear();
      encryption.close();
    },
  };
}
