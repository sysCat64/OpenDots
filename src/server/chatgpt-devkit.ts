import { mkdtemp, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ephemeralCredentialEncryption } from './ephemeral-encryption.js';
import {
  ChatGPTPlanError,
  type ChatGPTPlanAuth,
  type ChatGPTPlanModel,
} from './chatgpt-plan.js';

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
}
interface DevKitClient {
  signIn(options?: {
    newProfile?: boolean;
    label?: string;
    signal?: AbortSignal;
  }): Promise<DevKitSession>;
  getSession(): Promise<DevKitSession>;
  listModels(options?: { signal?: AbortSignal }): Promise<ChatGPTPlanModel[]>;
  disconnect(): Promise<void>;
}
interface DevKitStore {
  withLock<T>(operation: () => Promise<T>): Promise<T>;
  read(): Promise<unknown>;
}
interface DevKit {
  createChatGPT(config: Record<string, unknown>): DevKitClient;
  ConnectionStore: new (
    directory: string,
    encryption: ReturnType<typeof ephemeralCredentialEncryption>,
  ) => DevKitStore;
}

const REFRESH_MARGIN_MS = 120_000;

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

// DevKit errors carry a code, a user-safe message and a retryable flag.
function toPlanError(error: unknown, signal?: AbortSignal): unknown {
  if (signal?.aborted || !(error instanceof Error)) return error;
  const { code, retryable } = error as { code?: unknown; retryable?: unknown };
  if (typeof code !== 'string' || code === 'cancelled') return error;
  return new ChatGPTPlanError(
    code,
    error.message,
    retryable === true ? 503 : /sign_in|sharing|reauth/.test(code) ? 401 : 502,
  );
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

export interface ChatGPTPlanSession {
  auth: ChatGPTPlanAuth;
  isSignedIn(): Promise<boolean>;
  signIn(signal?: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
}

export async function createChatGPTPlanSession(options: {
  devkitDist: string;
}): Promise<ChatGPTPlanSession> {
  const devkit = await loadDevKit(options.devkitDist);
  const encryption = ephemeralCredentialEncryption();
  const storageDir = await mkdtemp(join(tmpdir(), 'opendots-chatgpt-'));
  // Last resort if the process exits without a graceful dispose().
  const removeStorageDir = () =>
    rmSync(storageDir, { recursive: true, force: true });
  process.once('exit', removeStorageDir);
  const client = devkit.createChatGPT({
    appName: 'OpenDots',
    appId: 'opendots',
    redirectPort: 0,
    storageDir,
    credentialEncryption: encryption,
  });
  const store = new devkit.ConnectionStore(storageDir, encryption);
  const listModels = async (signal?: AbortSignal) => {
    try {
      return await client.listModels({ signal });
    } catch (error) {
      throw toPlanError(error, signal);
    }
  };
  return {
    auth: {
      listModels,
      async getAccessToken(signal) {
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
      },
    },
    async isSignedIn() {
      const session = await client.getSession();
      return session.status === 'connected' && session.sharing;
    },
    async signIn(signal) {
      const session = await client.signIn({ newProfile: true, signal });
      if (!session.sharing)
        throw new ChatGPTPlanError(
          'sharing_not_enabled',
          'ChatGPT plan sharing is not enabled for this account.',
          401,
        );
    },
    async dispose() {
      process.removeListener('exit', removeStorageDir);
      await client.disconnect().catch(() => undefined);
      await rm(storageDir, { recursive: true, force: true });
    },
  };
}
