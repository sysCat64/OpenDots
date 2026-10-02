import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatGPTPlanError } from '../src/server/chatgpt-plan.js';
import { DevKitIncompatibleError } from '../src/server/devkit-compat.js';
import {
  ModelService,
  isSafeAuthorizationUrl,
} from '../src/server/model-service.js';
import {
  ASTRA,
  AUTH_URL,
  LUNA,
  SECRETS,
  harness,
  until,
  type Harness,
} from './fixtures/fake-chatgpt-session.js';

vi.setConfig({ testTimeout: 20_000 });

const open: Harness[] = [];
const make = (overrides: Parameters<typeof harness>[0] = {}) => {
  const h = harness(overrides);
  open.push(h);
  return h;
};
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(open.splice(0).map((h) => h.service.close()));
  open.length = 0;
});
const signedIn = async (overrides: Parameters<typeof harness>[0] = {}) => {
  const h = make({ signedIn: true, ...overrides });
  await h.service.start();
  await until(() => h.session.models.snapshot().fetchedAt !== undefined);
  return h;
};

describe('without ChatGPT configured', () => {
  it('reports not_configured and uses the API key provider as before', () => {
    const store = make().store;
    const service = new ModelService({
      store,
      apiKey: { apiKey: 'k', model: 'm', baseUrl: 'https://x/v1' },
      server: {},
      loopback: true,
    });
    const status = service.status();
    expect(status).toMatchObject({
      provider: 'api-key',
      providerSource: 'server',
      apiKey: { available: true },
      chatgpt: { state: 'not_configured', canSignInHere: false },
    });
    expect(service.provider).toMatchObject({
      kind: 'api-key',
      configured: true,
    });
    expect(() => service.setProvider('chatgpt-plan')).toThrowError(
      expect.objectContaining({ status: 409 }),
    );
  });
});

describe('connection state', () => {
  it('starts checking, then reflects the saved session', async () => {
    const h = make({ signedIn: true });
    expect(h.service.status().chatgpt.state).toBe('checking');
    await h.service.start();
    expect(h.service.status().chatgpt.state).toBe('signed_in');
    expect(h.session.calls.signIn).toBe(0); // restoring never signs in
  });

  it('loads the model list in the background once signed in', async () => {
    const h = await signedIn();
    expect(h.service.models()).toMatchObject({
      models: [LUNA, ASTRA],
      stale: false,
    });
  });

  it('never waits for a slow connection check, and runs only one at a time', async () => {
    const h = make();
    let release!: () => void;
    h.session.statusImpl = () =>
      new Promise(
        (resolve) => (release = () => resolve({ state: 'signed_in' })),
      );
    void h.service.start();
    await until(() => h.session.calls.status === 1);
    const started = Date.now();
    for (let i = 0; i < 20; i++) h.service.status();
    expect(Date.now() - started).toBeLessThan(200);
    expect(h.session.calls.status).toBe(1); // deduplicated
    h.clock.now += 5_000;
    expect(h.service.status().chatgpt).toMatchObject({
      state: 'checking',
      refreshing: true,
    });
    release();
    await h.service.idle();
    expect(h.service.status().chatgpt.state).toBe('signed_in');
  });

  it('checks again no more often than the interval', async () => {
    const h = make({ statusIntervalMs: 5_000 });
    h.session.statusImpl = async () => ({ state: 'signed_out' });
    await h.service.start();
    const calls = h.session.calls.status;
    h.service.status();
    await h.service.idle();
    expect(h.session.calls.status).toBe(calls);
    h.clock.now += 5_001;
    h.service.status();
    await h.service.idle();
    expect(h.session.calls.status).toBe(calls + 1);
  });

  it('reports unavailable storage with its reason and a recovery command when needed', async () => {
    const h = make();
    h.session.statusImpl = async () => ({
      state: 'unavailable',
      failure: { code: 'credential_key_missing', hint: 'The key is missing.' },
    });
    await h.service.start();
    expect(h.service.status().chatgpt).toMatchObject({
      state: 'unavailable',
      failure: {
        code: 'credential_key_missing',
        message: 'The key is missing.',
      },
      recovery: 'npm run chatgpt-plan -- reset --yes',
    });
    // Each read starts at most one background check, so let it finish before
    // changing what the next one will see.
    await h.service.idle();
    h.session.statusImpl = async () => ({
      state: 'unavailable',
      failure: { code: 'keychain_unavailable', hint: 'Unlock it.' },
    });
    h.service.status();
    await h.service.idle();
    expect(h.service.status().chatgpt.failure?.code).toBe(
      'keychain_unavailable',
    );
    await h.service.idle();
    expect(h.service.status().chatgpt.recovery).toBeUndefined();
    // And it recovers by itself once the problem is fixed.
    await h.service.idle();
    h.session.statusImpl = async () => ({ state: 'signed_in' });
    h.service.status();
    await h.service.idle();
    expect(h.service.status().chatgpt).toMatchObject({ state: 'signed_in' });
    expect(h.service.status().chatgpt.failure).toBeUndefined();
  });

  it('reports a session that could not be created instead of crashing', async () => {
    const store = make().store;
    const service = new ModelService({
      store,
      apiKey: {},
      server: {},
      loopback: true,
      chatgpt: {
        credentialStore: 'keychain',
        createSession: async () => {
          throw new Error('secret-internal-detail');
        },
      },
    });
    await service.start();
    const status = service.status();
    expect(status.chatgpt.state).toBe('unavailable');
    expect(JSON.stringify(status)).not.toContain('secret-internal-detail');
    await expect(service.startSignIn()).rejects.toMatchObject({ status: 409 });
  });
});

describe('sign-in', () => {
  const ready = async () => {
    const h = make();
    await h.service.start();
    expect(h.service.status().chatgpt.state).toBe('signed_out');
    return h;
  };

  it('returns once the URL is known, without waiting for the callback', async () => {
    const h = await ready();
    const started = Date.now();
    const status = await h.service.startSignIn();
    expect(Date.now() - started).toBeLessThan(150);
    expect(status.chatgpt).toMatchObject({
      state: 'signing_in',
      signIn: { url: AUTH_URL },
    });
    expect(status.chatgpt.signIn?.expiresAt).toBeGreaterThan(h.clock.now);
    // Still pending: it completes in the background.
    h.session.completeSignIn();
    await until(() => h.service.status().chatgpt.state === 'signed_in');
    const done = h.service.status().chatgpt;
    expect(done.signIn).toBeUndefined();
    expect(JSON.stringify(h.service.status())).not.toContain(AUTH_URL);
  });

  it('loads the models after signing in', async () => {
    const h = await ready();
    await h.service.startSignIn();
    h.session.completeSignIn();
    await until(() => h.session.models.snapshot().fetchedAt !== undefined);
    expect(h.service.models().models).toHaveLength(2);
  });

  it('allows only one sign-in at a time', async () => {
    const h = await ready();
    await h.service.startSignIn();
    await expect(h.service.startSignIn()).rejects.toMatchObject({
      status: 409,
      code: 'sign_in_in_progress',
    });
    expect(h.session.calls.signIn).toBe(1);
  });

  it('shows only the URL, only while signing in, and only if it is safe', async () => {
    expect(isSafeAuthorizationUrl('https://auth.openai.com/oauth?x=1')).toBe(
      true,
    );
    for (const bad of [
      'http://auth.example.com/x',
      'javascript:alert(1)',
      'data:text/html,hi',
      'https://user:pw@auth.example.com/x',
      'https://user@auth.example.com/x',
      'not a url',
      '',
    ])
      expect(isSafeAuthorizationUrl(bad), bad).toBe(false);

    const h = await ready();
    h.session.signInUrl = 'https://user:pw@auth.example.com/x';
    const status = await h.service.startSignIn();
    expect(JSON.stringify(status)).not.toContain('user:pw');
    expect(status.chatgpt.state).toBe('signed_out');
    expect(status.chatgpt.signInError?.code).toBe('invalid_authorization_url');
    expect(h.session.signInSignal?.aborted).toBe(true);
  });

  it('never logs the authorization URL', async () => {
    const logs = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
    ];
    const h = await ready();
    await h.service.startSignIn();
    h.session.completeSignIn();
    await h.service.idle();
    expect(JSON.stringify(logs.map((spy) => spy.mock.calls))).not.toContain(
      'auth.example.com',
    );
  });

  it('reports a failed sign-in with a safe message', async () => {
    const h = await ready();
    await h.service.startSignIn();
    h.session.failSignIn(
      new ChatGPTPlanError('sharing_not_enabled', 'Sharing is off.', 401),
    );
    await until(() => h.service.status().chatgpt.state === 'signed_out');
    expect(h.service.status().chatgpt.signInError).toEqual({
      code: 'sharing_not_enabled',
      message: 'Sharing is off.',
    });
    // An unknown error says nothing about its content.
    await h.service.startSignIn();
    h.session.failSignIn(new Error('secret-internal-detail'));
    await until(() => h.service.status().chatgpt.state === 'signed_out');
    const status = h.service.status();
    expect(status.chatgpt.signInError?.code).toBe('sign_in_failed');
    expect(JSON.stringify(status)).not.toContain('secret-internal-detail');
    // A new attempt clears the old error.
    await h.service.startSignIn();
    expect(h.service.status().chatgpt.signInError).toBeUndefined();
  });

  it('cancels cleanly: back to signed out, no error, and can start again', async () => {
    const h = await ready();
    await h.service.startSignIn();
    const status = await h.service.cancelSignIn();
    expect(h.session.signInSignal?.aborted).toBe(true);
    expect(status.chatgpt.state).toBe('signed_out');
    expect(status.chatgpt.signIn).toBeUndefined();
    expect(status.chatgpt.signInError).toBeUndefined();
    await expect(h.service.startSignIn()).resolves.toBeDefined();
    // Cancelling when nothing is pending is harmless.
    await h.service.cancelSignIn();
    await expect(h.service.cancelSignIn()).resolves.toBeDefined();
  });

  it('is refused away from the server machine, while checking, signed in, or unavailable', async () => {
    const remote = make({ loopback: false });
    await remote.service.start();
    await expect(remote.service.startSignIn()).rejects.toMatchObject({
      status: 403,
      code: 'not_local',
    });
    expect(remote.service.status().chatgpt.canSignInHere).toBe(false);

    const checking = make();
    await expect(checking.service.startSignIn()).rejects.toMatchObject({
      status: 409,
    });

    const connected = await signedIn();
    await expect(connected.service.startSignIn()).rejects.toMatchObject({
      status: 409,
    });
  });

  it('ignores a connection check that finishes after a sign-in began', async () => {
    const h = make();
    let release!: () => void;
    h.session.statusImpl = () =>
      new Promise(
        (resolve) => (release = () => resolve({ state: 'signed_in' })),
      );
    void h.service.start();
    await until(() => h.session.calls.status === 1);
    // Still "checking", so sign-in is refused rather than racing the check.
    await expect(h.service.startSignIn()).rejects.toMatchObject({
      status: 409,
    });
    release();
    await h.service.idle();
    expect(h.service.status().chatgpt.state).toBe('signed_in');
  });
});

describe('sign-out', () => {
  it('revokes, keeps the saved choices, and returns to signed out', async () => {
    const h = await signedIn();
    await h.service.setChatGPTModel(LUNA.slug);
    h.service.setProvider('chatgpt-plan');
    h.session.statusImpl = async () => ({ state: 'signed_out' });
    const status = await h.service.signOut();
    expect(h.session.calls.signOut).toBe(1);
    expect(status.chatgpt.state).toBe('signed_out');
    expect(status.chatgpt.notice).toBeUndefined();
    expect(h.store.modelSelection()).toEqual({
      provider: 'chatgpt-plan',
      chatgptModel: LUNA.slug,
    });
    expect(h.service.models().models).toEqual([]); // the account's list is gone
    expect(h.session.calls.close).toBe(0); // sign-out is not close, and not reset
  });

  it('says so when remote revocation could not be confirmed', async () => {
    const h = await signedIn();
    h.session.revoked = false;
    h.session.statusImpl = async () => ({ state: 'signed_out' });
    const status = await h.service.signOut();
    expect(status.chatgpt).toMatchObject({
      state: 'signed_out',
      notice: 'revocation_unconfirmed',
    });
  });

  it('is single-flight, and not allowed while signing in', async () => {
    const h = await signedIn();
    let release!: () => void;
    h.session.signOut = () =>
      new Promise((resolve) => (release = () => resolve({ revoked: true })));
    const first = h.service.signOut();
    expect(h.service.status().chatgpt.state).toBe('signing_out');
    await expect(h.service.signOut()).rejects.toMatchObject({
      status: 409,
      code: 'sign_out_in_progress',
    });
    await expect(h.service.startSignIn()).rejects.toMatchObject({
      status: 409,
    });
    release();
    await first;

    const other = make();
    await other.service.start();
    await other.service.startSignIn();
    await expect(other.service.signOut()).rejects.toMatchObject({
      status: 409,
      code: 'cancel_first',
    });
  });

  it('is harmless when already signed out', async () => {
    const h = make();
    await h.service.start();
    const status = await h.service.signOut();
    expect(status.chatgpt.state).toBe('signed_out');
    expect(h.session.calls.signOut).toBe(0);
  });

  it('re-reads the connection when sign-out fails midway', async () => {
    const h = await signedIn();
    h.session.signOutError = new Error('secret-internal-detail');
    await expect(h.service.signOut()).rejects.toMatchObject({
      status: 502,
      code: 'sign_out_failed',
    });
    expect(h.service.status().chatgpt.state).toBe('checking');
  });
});

describe('provider choice', () => {
  const withApiKey = (extra: Parameters<typeof harness>[0] = {}) =>
    make({ apiKey: { apiKey: 'k', model: 'm' }, signedIn: true, ...extra });

  it('follows the server when nothing is saved, the UI once it is, and back', async () => {
    const h = withApiKey({ server: { provider: 'api-key' } });
    await h.service.start();
    expect(h.service.status()).toMatchObject({
      provider: 'api-key',
      providerSource: 'server',
      serverProvider: 'api-key',
    });
    expect(h.service.setProvider('chatgpt-plan')).toMatchObject({
      provider: 'chatgpt-plan',
      providerSource: 'ui',
      serverProvider: 'api-key',
      selection: { provider: 'chatgpt-plan' },
    });
    expect(h.service.clearSelection()).toMatchObject({
      provider: 'api-key',
      providerSource: 'server',
      selection: {},
    });
  });

  it('picks what is available when the server names no provider', async () => {
    const onlyChatGPT = make();
    expect(onlyChatGPT.service.status()).toMatchObject({
      provider: 'chatgpt-plan',
      apiKey: { available: false },
    });
    const both = withApiKey();
    expect(both.service.status().provider).toBe('api-key');
  });

  it('ignores, without deleting, a saved provider that is no longer available', async () => {
    const h = make({ apiKey: { apiKey: 'k', model: 'm' } });
    h.store.setModelSelection({ provider: 'chatgpt-plan' });
    const noChatGPT = new ModelService({
      store: h.store,
      apiKey: { apiKey: 'k', model: 'm' },
      server: {},
      loopback: true,
    });
    expect(noChatGPT.status()).toMatchObject({
      provider: 'api-key',
      providerSource: 'server',
      selection: { provider: 'chatgpt-plan' },
    });
    expect(h.store.modelSelection().provider).toBe('chatgpt-plan');
  });

  it('refuses a provider that is not configured', async () => {
    const h = make();
    expect(() => h.service.setProvider('api-key')).toThrowError(
      expect.objectContaining({ status: 409, code: 'api_key_not_configured' }),
    );
  });

  it('survives a restart of the service', async () => {
    const h = withApiKey();
    h.service.setProvider('chatgpt-plan');
    await h.service.start();
    await h.service.setChatGPTModel(ASTRA.slug);
    const again = new ModelService({
      store: h.store,
      apiKey: { apiKey: 'k', model: 'm' },
      server: {},
      loopback: true,
    });
    expect(again.status().selection).toEqual({
      provider: 'chatgpt-plan',
      chatgptModel: ASTRA.slug,
    });
  });
});

describe('model choice', () => {
  it('lists the account live and saves a model that is in it', async () => {
    const h = await signedIn();
    const status = await h.service.setChatGPTModel(ASTRA.slug);
    expect(status.chatgpt.model).toMatchObject({
      effective: ASTRA.slug,
      source: 'ui',
      saved: ASTRA.slug,
      savedAvailable: true,
    });
    expect(h.store.modelSelection().chatgptModel).toBe(ASTRA.slug);
  });

  it('refuses a model the account does not offer, after one fresh check', async () => {
    const h = await signedIn();
    const loads = h.session.calls.load;
    await expect(h.service.setChatGPTModel('gpt-9-nope')).rejects.toMatchObject(
      {
        status: 409,
        code: 'model_unavailable',
      },
    );
    expect(h.session.calls.load).toBe(loads + 1); // a cached list was re-checked
    expect(h.store.modelSelection().chatgptModel).toBeUndefined();
  });

  it('accepts a model that appeared since the list was cached', async () => {
    const h = await signedIn();
    h.session.available = [
      LUNA,
      ASTRA,
      { slug: 'gpt-7-new', displayName: 'New' },
    ];
    await h.service.setChatGPTModel('gpt-7-new');
    expect(h.store.modelSelection().chatgptModel).toBe('gpt-7-new');
  });

  it.each(['', '   ', 'x'.repeat(201)])(
    'rejects the name %j as malformed, before looking at the account',
    async (name) => {
      const h = await signedIn();
      await expect(h.service.setChatGPTModel(name)).rejects.toMatchObject({
        status: 400,
      });
    },
  );

  it.each(['../x', 'a b', '<script>', 'gpt-9-nope'])(
    'refuses %j because the account does not list it, however it is spelled',
    async (name) => {
      const h = await signedIn();
      await expect(h.service.setChatGPTModel(name)).rejects.toMatchObject({
        status: 409,
        code: 'model_unavailable',
      });
      expect(h.store.modelSelection().chatgptModel).toBeUndefined();
    },
  );

  it('accepts and uses any slug the account lists, whatever characters it has', async () => {
    const h = await signedIn();
    const unusual = 'openai/gpt-x@2026+beta (preview)';
    h.session.available = [LUNA, { slug: unusual, displayName: 'Unusual' }];
    await h.service.refreshModels();
    const status = await h.service.setChatGPTModel(unusual);
    expect(status.chatgpt.model).toMatchObject({
      effective: unusual,
      source: 'ui',
      saved: unusual,
      savedAvailable: true,
    });
    expect(h.store.modelSelection().chatgptModel).toBe(unusual);
    h.service.setProvider('chatgpt-plan');
    expect(h.service.provider.snapshot!()).toMatchObject({
      kind: 'chatgpt-plan',
      configured: true,
    });
  });

  it('needs a signed-in account', async () => {
    const h = make();
    await h.service.start();
    await expect(h.service.setChatGPTModel(LUNA.slug)).rejects.toMatchObject({
      status: 409,
      code: 'not_signed_in',
    });
    await expect(h.service.refreshModels()).rejects.toMatchObject({
      status: 409,
    });
  });

  describe('which model the next run uses', () => {
    const resolved = (h: Harness) => h.service.status().chatgpt.model;

    it('the saved model if the account offers it', async () => {
      const h = await signedIn({ server: { chatgptModel: LUNA.slug } });
      h.store.setModelSelection({ chatgptModel: ASTRA.slug });
      expect(resolved(h)).toMatchObject({
        effective: ASTRA.slug,
        source: 'ui',
        savedAvailable: true,
        serverDefault: LUNA.slug,
      });
    });

    it('else the server default if the account offers it, saying the saved one is gone', async () => {
      const h = await signedIn({ server: { chatgptModel: LUNA.slug } });
      h.store.setModelSelection({ chatgptModel: 'gpt-retired' });
      expect(resolved(h)).toMatchObject({
        effective: LUNA.slug,
        source: 'server',
        saved: 'gpt-retired',
        savedAvailable: false,
      });
      // The preference itself is never deleted.
      expect(h.store.modelSelection().chatgptModel).toBe('gpt-retired');
    });

    it('else none: it never substitutes another model', async () => {
      const h = await signedIn({ server: { chatgptModel: 'gpt-also-gone' } });
      h.store.setModelSelection({ chatgptModel: 'gpt-retired' });
      expect(resolved(h).effective).toBeUndefined();
      const provider = h.service.provider.snapshot!();
      expect(provider.configured).toBe(false);
      expect(provider.missing).toEqual([
        'ChatGPT model (choose one in Model settings)',
      ]);
      expect(() => provider.createAdapter()).toThrow();
    });

    it('while the list is unknown the choice is kept, and each request still checks it', async () => {
      const h = make({ server: { chatgptModel: LUNA.slug } });
      h.store.setModelSelection({ chatgptModel: ASTRA.slug });
      expect(resolved(h)).toMatchObject({
        effective: ASTRA.slug,
        source: 'ui',
      });
      expect(resolved(h).savedAvailable).toBeUndefined();
    });

    it('follows the account as the live list changes', async () => {
      const h = await signedIn();
      h.store.setModelSelection({ chatgptModel: ASTRA.slug });
      expect(resolved(h).effective).toBe(ASTRA.slug);
      h.session.available = [LUNA];
      await h.service.refreshModels();
      expect(resolved(h)).toMatchObject({ savedAvailable: false });
      expect(resolved(h).effective).toBeUndefined();
      h.session.available = [LUNA, ASTRA];
      await h.service.refreshModels();
      expect(resolved(h)).toMatchObject({
        effective: ASTRA.slug,
        savedAvailable: true,
      });
    });
  });
});

describe('model list', () => {
  it('refreshes on demand and reports a failed refresh without losing the list', async () => {
    const h = await signedIn();
    const failing = h.session.models;
    (failing as unknown as { load: unknown }).load = async () => {
      throw new ChatGPTPlanError('refresh_not_ready', 'Try later.', 503);
    };
    const list = await h.service.refreshModels();
    expect(list.models).toHaveLength(2);
    expect(list).toMatchObject({
      stale: true,
      error: { code: 'refresh_not_ready' },
    });
  });

  it('does not fetch from every poll, and does not hammer a failing refresh', async () => {
    const h = make({ signedIn: true, modelRefreshIntervalMs: 30_000 });
    await h.service.start();
    await until(() => h.session.models.snapshot().fetchedAt !== undefined);
    for (let i = 0; i < 20; i++) h.service.models();
    expect(h.session.calls.load).toBe(1);
    // Once stale, one refresh per interval, even when it keeps failing.
    h.clock.now += 10 * 60_000;
    h.session.models.clear();
    (h.session.models as unknown as { load: unknown }).load = vi.fn(
      async () => {
        throw new Error('down');
      },
    );
    h.service.models();
    await h.service.idle();
    await new Promise((r) => setTimeout(r, 20));
    const load = (
      h.session.models as unknown as { load: ReturnType<typeof vi.fn> }
    ).load;
    const first = load.mock.calls.length;
    for (let i = 0; i < 10; i++) h.service.models();
    await new Promise((r) => setTimeout(r, 20));
    expect(load.mock.calls.length).toBe(first);
  });
});

describe('what the browser can see', () => {
  it('never contains a token, key, state content, or base URL', async () => {
    const h = make({
      signedIn: true,
      apiKey: {
        apiKey: 'secret-api-key',
        model: 'm',
        baseUrl: 'https://internal.example/v1',
      },
    });
    await h.service.start();
    await until(() => h.session.models.snapshot().fetchedAt !== undefined);
    await h.service.setChatGPTModel(LUNA.slug);
    const everything = JSON.stringify([
      h.service.status(),
      h.service.models(),
      await h.service.refreshModels(),
    ]);
    for (const secret of [...SECRETS, 'secret-api-key', 'internal.example'])
      expect(everything).not.toContain(secret);
  });

  it('builds responses from a closed set of fields', async () => {
    const h = await signedIn();
    const status = h.service.status();
    expect(Object.keys(status).sort()).toEqual(
      [
        'apiKey',
        'chatgpt',
        'provider',
        'providerSource',
        'selection',
        'serverProvider',
      ].sort(),
    );
    expect(Object.keys(status.chatgpt).sort()).toEqual(
      [
        'canSignInHere',
        'devkit',
        'model',
        'persistence',
        'refreshing',
        'state',
      ].sort(),
    );
  });
});

describe('the provider the agent loop uses', () => {
  it('answers for the current choice and is fixed once snapshotted', async () => {
    const h = make({
      apiKey: { apiKey: 'k', model: 'm' },
      signedIn: true,
    });
    await h.service.start();
    const before = h.service.provider.snapshot!();
    expect(before.kind).toBe('api-key');
    h.service.setProvider('chatgpt-plan');
    expect(h.service.provider.kind).toBe('chatgpt-plan'); // live view moved
    expect(before.kind).toBe('api-key'); // the snapshot did not
    expect(h.service.provider.snapshot!().kind).toBe('chatgpt-plan');
  });

  it('reflects the model choice and offers a request option set that matches', async () => {
    const h = await signedIn();
    h.service.setProvider('chatgpt-plan');
    await h.service.setChatGPTModel(LUNA.slug);
    const provider = h.service.provider.snapshot!();
    expect(provider).toMatchObject({ kind: 'chatgpt-plan', configured: true });
    expect(provider.modelOptions).toMatchObject({ store: false });
  });

  it('closes the session and cancels a pending sign-in on close', async () => {
    const h = make();
    await h.service.start();
    await h.service.startSignIn();
    await h.service.close();
    expect(h.session.signInSignal?.aborted).toBe(true);
    expect(h.session.calls.close).toBe(1);
  });
});

describe('DevKit compatibility', () => {
  it("shows the build's compatibility and version, and nothing more of it", async () => {
    const h = make();
    await h.service.start();
    expect(h.service.status().chatgpt.devkit).toEqual({
      compatibility: 'verified',
      version: '0.1.0',
    });
    h.session.devkit = {
      ...h.session.devkit,
      compatibility: 'untested',
      version: undefined,
      commit: undefined,
    };
    expect(h.service.status().chatgpt.devkit).toEqual({
      compatibility: 'untested',
    });
    expect(JSON.stringify(h.service.status())).not.toContain('aaaaaaaa'); // no fingerprint
  });

  it('reports an incompatible DevKit at start as unavailable, with the reason, and offers no sign-in', async () => {
    const store = make().store;
    const service = new ModelService({
      store,
      apiKey: {},
      server: {},
      loopback: true,
      chatgpt: {
        credentialStore: 'ephemeral',
        createSession: async () => {
          throw new DevKitIncompatibleError('ConnectionStore.read is missing');
        },
      },
    });
    await service.start();
    const status = service.status();
    expect(status.chatgpt.state).toBe('unavailable');
    expect(status.chatgpt.failure).toMatchObject({
      code: 'devkit_incompatible',
    });
    expect(status.chatgpt.failure?.message).toContain(
      'ConnectionStore.read is missing',
    );
    await expect(service.startSignIn()).rejects.toMatchObject({ status: 409 });
  });

  it('a sign-in that saves an unusable session ends unavailable, not as a failed attempt', async () => {
    const h = make();
    await h.service.start();
    await h.service.startSignIn();
    // As the real session does: the saved state stays unusable on every check.
    h.session.statusImpl = async () => ({
      state: 'unavailable',
      failure: {
        code: 'devkit_incompatible',
        hint: 'This DevKit is not supported.',
      },
    });
    h.session.failSignIn(
      new DevKitIncompatibleError('expiresAt is not a millisecond timestamp'),
    );
    await until(() => h.service.status().chatgpt.state === 'unavailable');
    const status = h.service.status();
    expect(status.chatgpt.failure?.code).toBe('devkit_incompatible');
    expect(status.chatgpt.signInError).toBeUndefined();
  });
});
