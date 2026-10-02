import { mkdtemp, rm } from 'node:fs/promises';
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
  credentialFailureHint,
  type CredentialStoreErrorCode,
} from './credential-errors.js';
import {
  KeychainKeyBackend,
  defaultStateDir,
  openPersistentKey,
  type KeyBackend,
} from './credential-keys.js';
import { ensurePrivateDir } from './private-fs.js';
import {
  memoryKeySource,
  sealedCredentialEncryption,
} from './sealed-encryption.js';

// Adapter for the Sign in with ChatGPT DevKit. The DevKit is a separate,
// noncommercially licensed project: OpenDots neither bundles nor copies it. It
// is loaded at runtime from a directory the owner supplies, and everything
// OpenDots knows about it is declared here.
//
// The DevKit's public client can sign in and list models but exposes no access
// token, and its streamResponse() cannot carry tools. Tool calling therefore
// needs the token itself. The DevKit refreshes tokens internally, so we let
// listModels() trigger that refresh and then read the stored result. This is
// the only place that depends on DevKit internals; a public getAccessToken()
// upstream would replace readAccessToken() entirely.

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
}

const REFRESH_MARGIN_MS = 120_000;
const EPHEMERAL_ID = 'opendots-ephemeral-aes-256-gcm-v1';
export const KEYCHAIN_ENCRYPTION_ID = 'opendots-keychain-aes-256-gcm-v1';
const KEYCHAIN_ID = KEYCHAIN_ENCRYPTION_ID;

async function loadDevKit(distDir: string): Promise<DevKit> {
  const dist = resolve(distDir);
  try {
    const [main, storage] = await Promise.all([
      import(pathToFileURL(join(dist, 'index.js')).href),
      import(pathToFileURL(join(dist, 'storage.js')).href),
    ]);
    if (
      typeof main.createChatGPT !== 'function' ||
      typeof storage.ConnectionStore !== 'function'
    )
      throw new Error('unexpected exports');
    return {
      createChatGPT: main.createChatGPT,
      ConnectionStore: storage.ConnectionStore,
    };
  } catch (cause) {
    throw new Error(
      'CHATGPT_DEVKIT_DIST must point to the built packages/local/dist directory of the Sign in with ChatGPT DevKit.',
      { cause },
    );
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

async function readAccessToken(store: DevKitStore) {
  const state = record(await store.withLock(() => store.read()));
  const profiles = Array.isArray(state?.profiles) ? state.profiles : [];
  const profile = record(
    profiles.find((entry) => record(entry)?.id === state?.activeProfileId),
  );
  const credentials = record(profile?.credentials);
  return profile?.status === 'connected' &&
    typeof credentials?.accessToken === 'string' &&
    typeof credentials.expiresAt === 'number'
    ? { accessToken: credentials.accessToken, expiresAt: credentials.expiresAt }
    : undefined;
}

// Whether the owner, not the model, has to act before this can work.
export type ChatGPTPlanStatus =
  | { state: 'signed_in' | 'signed_out' }
  | { state: 'unavailable'; failure: { code: string; hint: string } };

export interface ChatGPTPlanSession {
  readonly credentialStore: 'ephemeral' | 'keychain';
  auth: ChatGPTPlanAuth;
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
  const devkit = await loadDevKit(options.devkitDist);
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

  const client = devkit.createChatGPT({
    appName: 'OpenDots',
    appId: 'opendots',
    redirectPort: 0,
    storageDir,
    credentialEncryption: encryption,
    ...(options.openBrowser ? { openBrowser: options.openBrowser } : {}),
  });
  const store = new devkit.ConnectionStore(storageDir, encryption);

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
    return new ChatGPTPlanError(
      code,
      error.message,
      retryable === true
        ? 503
        : /sign_in|sharing|reauth/.test(code)
          ? 401
          : 502,
    );
  };
  const listModels = async (signal?: AbortSignal) => {
    try {
      return await client.listModels({ signal });
    } catch (error) {
      throw toPlanError(error, signal);
    }
  };
  const signOut = async () => {
    try {
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
    auth: {
      listModels,
      async getAccessToken(signal) {
        try {
          let token = await readAccessToken(store);
          if (!token || token.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
            // Refreshes through the DevKit when the token is near expiry.
            await listModels(signal);
            token = await readAccessToken(store);
          }
          if (!token)
            throw new ChatGPTPlanError(
              'sign_in_required',
              'Sign in with ChatGPT to continue.',
              401,
            );
          return token.accessToken;
        } catch (error) {
          throw toPlanError(error, signal);
        }
      },
    },
    async status() {
      const session = await client.getSession();
      if (session.status === 'connected' && session.sharing)
        return { state: 'signed_in' };
      const code = session.error?.code;
      if (code && /^(storage_|host_identity)/.test(code))
        return {
          state: 'unavailable',
          failure: failure
            ? { code: failure, hint: credentialFailureHint(failure) }
            : { code, hint: session.error?.message ?? code },
        };
      return { state: 'signed_out' };
    },
    async signIn(signal) {
      let session: DevKitSession;
      try {
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
      encryption.close();
    },
  };
}
