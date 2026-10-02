import type { ChatGPTPlanSession } from '../../src/server/chatgpt-devkit.js';
import type { ChatGPTPlanModel } from '../../src/server/chatgpt-plan.js';
import { ModelCatalog } from '../../src/server/model-catalog.js';
import {
  ModelService,
  type ModelServiceOptions,
} from '../../src/server/model-service.js';
import { Store } from '../../src/server/store.js';

export const LUNA = { slug: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna' };
export const ASTRA = { slug: 'gpt-6-astra', displayName: 'GPT-6 Astra' };
// Planted inside the fake: nothing the browser receives may contain these.
export const SECRETS = [
  'secret-access-token',
  'secret-refresh-token',
  'secret-id-token',
  'secret-encryption-key',
  'secret-internal-detail',
];
export const AUTH_URL = 'https://auth.example.com/authorize?state=abc&x=1';

type SessionStatus = Awaited<ReturnType<ChatGPTPlanSession['status']>>;

// A scripted stand-in for the real session: every step can be held, completed
// or failed by the test.
export class FakeSession {
  calls = { status: 0, signIn: 0, signOut: 0, close: 0, load: 0 };
  statusImpl: () => Promise<SessionStatus> = async () => ({
    state: 'signed_out',
  });
  revoked = true;
  signOutError?: Error;
  available: ChatGPTPlanModel[] = [LUNA, ASTRA];
  openBrowser: (url: string) => void = () => undefined;
  // Settle the pending sign-in.
  private finishSignIn?: { resolve: () => void; reject: (e: Error) => void };
  signInUrl = AUTH_URL;
  signInSignal?: AbortSignal;
  readonly credentialStore = 'ephemeral' as const;
  readonly models = new ModelCatalog(async () => {
    this.calls.load += 1;
    return this.available;
  });
  readonly auth = {
    getAccessToken: async () => SECRETS[0],
    listModels: (signal?: AbortSignal, options?: { force?: boolean }) =>
      this.models.list({ signal, force: options?.force }),
  };

  status() {
    this.calls.status += 1;
    return this.statusImpl();
  }
  signIn(signal?: AbortSignal) {
    this.calls.signIn += 1;
    this.signInSignal = signal;
    return new Promise<void>((resolve, reject) => {
      this.finishSignIn = { resolve, reject };
      signal?.addEventListener('abort', () =>
        reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })),
      );
      try {
        this.openBrowser(this.signInUrl);
      } catch (error) {
        reject(error as Error);
      }
    });
  }
  completeSignIn() {
    this.finishSignIn?.resolve();
  }
  failSignIn(error: Error) {
    this.finishSignIn?.reject(error);
  }
  async signOut() {
    this.calls.signOut += 1;
    if (this.signOutError) throw this.signOutError;
    this.models.clear();
    return { revoked: this.revoked };
  }
  async close() {
    this.calls.close += 1;
  }
}

export interface Harness {
  service: ModelService;
  session: FakeSession;
  store: Store;
  clock: { now: number };
}

export function harness(
  overrides: Partial<ModelServiceOptions> & { signedIn?: boolean } = {},
): Harness {
  const store = new Store(':memory:');
  const session = new FakeSession();
  if (overrides.signedIn)
    session.statusImpl = async () => ({ state: 'signed_in' });
  const clock = { now: 1_000_000 };
  const service = new ModelService({
    store,
    apiKey: {},
    server: {},
    chatgpt: {
      credentialStore: 'ephemeral',
      createSession: async (openBrowser) => {
        session.openBrowser = openBrowser;
        return session as unknown as ChatGPTPlanSession;
      },
    },
    loopback: true,
    now: () => clock.now,
    statusIntervalMs: 0,
    signInUrlWaitMs: 200,
    ...overrides,
  });
  return { service, session, store, clock };
}

export async function until(check: () => boolean, ms = 2_000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('condition not reached');
    await new Promise((done) => setTimeout(done, 5));
  }
}
