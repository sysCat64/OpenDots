import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app.js';
import { Runner } from '../src/server/runner.js';
import type { Config } from '../src/server/research.js';
import {
  ASTRA,
  AUTH_URL,
  LUNA,
  SECRETS,
  harness,
  type Harness,
} from './fixtures/fake-chatgpt-session.js';

vi.setConfig({ testTimeout: 20_000 });

const config: Config = { mode: 'sample', baseUrl: 'https://api.openai.com/v1' };
const TOKEN = 'owner-token-at-least-24-characters';
const open: Harness[] = [];
async function fixture(options: { token?: string; signedIn?: boolean } = {}) {
  const h = harness({ signedIn: options.signedIn });
  open.push(h);
  await h.service.start();
  const runner = new Runner(h.store, config);
  const app = createApp({
    store: h.store,
    runner,
    config,
    ownerToken: options.token,
    models: h.service,
  });
  const call = (
    path: string,
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.request(`/api${path}`, {
      method,
      headers: {
        ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { ...h, app, call };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(open.splice(0).map((h) => h.service.close()));
  open.length = 0;
});

describe('model API', () => {
  it('reports status as JSON that is never cached', async () => {
    const { call } = await fixture();
    const response = await call('/model');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      provider: 'chatgpt-plan',
      chatgpt: { state: 'signed_out', canSignInHere: true },
    });
  });

  it('starts sign-in in the background and answers 202 with the link', async () => {
    const { call, session } = await fixture();
    const started = Date.now();
    const response = await call('/model/chatgpt/sign-in', 'POST', {});
    expect(Date.now() - started).toBeLessThan(150);
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.chatgpt).toMatchObject({
      state: 'signing_in',
      signIn: { url: AUTH_URL },
    });
    expect((await call('/model/chatgpt/sign-in', 'POST', {})).status).toBe(409);
    session.completeSignIn();
    await vi.waitFor(async () =>
      expect((await (await call('/model')).json()).chatgpt.state).toBe(
        'signed_in',
      ),
    );
    expect(JSON.stringify(await (await call('/model')).json())).not.toContain(
      'auth.example.com',
    );
  });

  it('cancels, signs out, lists and selects models, and uses server defaults', async () => {
    const { call, session } = await fixture({ signedIn: true });
    await vi.waitFor(async () =>
      expect(
        (await (await call('/model/chatgpt/models')).json()).models,
      ).toHaveLength(2),
    );
    expect(await (await call('/model/chatgpt/models')).json()).toMatchObject({
      models: [LUNA, ASTRA],
    });
    const refreshed = await call('/model/chatgpt/models/refresh', 'POST', {});
    expect(refreshed.status).toBe(200);

    let response = await call('/model/chatgpt/model', 'PUT', {
      model: ASTRA.slug,
    });
    expect(response.status).toBe(200);
    expect((await response.json()).chatgpt.model).toMatchObject({
      effective: ASTRA.slug,
      source: 'ui',
    });

    response = await call('/model/provider', 'PUT', {
      provider: 'chatgpt-plan',
    });
    expect((await response.json()).selection).toEqual({
      provider: 'chatgpt-plan',
      chatgptModel: ASTRA.slug,
    });

    response = await call('/model/selection', 'DELETE');
    expect((await response.json()).selection).toEqual({});

    session.statusImpl = async () => ({ state: 'signed_out' });
    response = await call('/model/chatgpt/sign-out', 'POST', {});
    expect((await response.json()).chatgpt.state).toBe('signed_out');
    response = await call('/model/chatgpt/sign-in/cancel', 'POST', {});
    expect(response.status).toBe(200);
  });

  it('turns service errors into their status and a message, not a stack', async () => {
    const { call } = await fixture();
    let response = await call('/model/chatgpt/model', 'PUT', {
      model: LUNA.slug,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'not_signed_in' });
    response = await call('/model/provider', 'PUT', { provider: 'api-key' });
    expect(response.status).toBe(409);
    response = await call('/model/chatgpt/sign-out', 'POST', {});
    expect(response.status).toBe(200); // already signed out: harmless
  });

  it('rejects malformed bodies and unknown fields', async () => {
    const { call } = await fixture({ signedIn: true });
    for (const [path, body] of [
      ['/model/provider', { provider: 'nope' }],
      ['/model/provider', {}],
      ['/model/provider', { provider: 'chatgpt-plan', extra: 1 }],
      ['/model/chatgpt/model', { model: '' }],
      ['/model/chatgpt/model', { model: 5 }],
      ['/model/chatgpt/model', { model: LUNA.slug, apiKey: 'x' }],
    ] as const) {
      const response = await call(path, 'PUT', body);
      expect(response.status, `${path} ${JSON.stringify(body)}`).toBe(400);
    }
    const bad = await call('/model/provider', 'PUT', undefined);
    expect(bad.status).toBe(400);
  });

  it('answers an unexpected failure generically', async () => {
    const { call, service } = await fixture();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(service, 'status').mockImplementation(() => {
      throw new Error('secret-internal-detail');
    });
    const response = await call('/model');
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain(
      'secret-internal-detail',
    );
  });

  it('never returns a token, key or other secret from any route', async () => {
    const { call } = await fixture({ signedIn: true });
    await vi.waitFor(async () =>
      expect(
        (await (await call('/model/chatgpt/models')).json()).models.length,
      ).toBe(2),
    );
    const seen: string[] = [];
    for (const [path, method, body] of [
      ['/model', 'GET'],
      ['/model/chatgpt/models', 'GET'],
      ['/model/chatgpt/models/refresh', 'POST', {}],
      ['/model/chatgpt/model', 'PUT', { model: LUNA.slug }],
      ['/model/provider', 'PUT', { provider: 'chatgpt-plan' }],
      ['/model/selection', 'DELETE'],
      ['/model/chatgpt/model', 'PUT', { model: 'gpt-9-nope' }],
    ] as const)
      seen.push(await (await call(path, method, body)).text());
    for (const secret of SECRETS)
      for (const text of seen) expect(text).not.toContain(secret);
  });
});

describe('model API security boundaries', () => {
  it('requires the owner token when one is configured', async () => {
    const { app } = await fixture({ token: TOKEN });
    for (const [path, method] of [
      ['/api/model', 'GET'],
      ['/api/model/chatgpt/models', 'GET'],
      ['/api/model/chatgpt/sign-in', 'POST'],
      ['/api/model/chatgpt/sign-out', 'POST'],
      ['/api/model/provider', 'PUT'],
      ['/api/model/selection', 'DELETE'],
    ] as const) {
      const bare = await app.request(path, {
        method,
        headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
        ...(method === 'GET' ? {} : { body: '{}' }),
      });
      expect(bare.status, `${method} ${path}`).toBe(401);
      const wrong = await app.request(path, {
        method,
        headers: { Authorization: 'Bearer wrong-token' },
      });
      expect(wrong.status).toBe(401);
    }
  });

  it('refuses cross-origin and cross-site requests, including a sign-in start', async () => {
    const { app, session } = await fixture();
    const attacks: Array<Record<string, string>> = [
      { Origin: 'https://evil.example' },
      { 'Sec-Fetch-Site': 'cross-site' },
    ];
    for (const headers of attacks) {
      for (const [path, method] of [
        ['/api/model', 'GET'],
        ['/api/model/chatgpt/sign-in', 'POST'],
        ['/api/model/chatgpt/sign-out', 'POST'],
      ] as const) {
        const response = await app.request(path, {
          method,
          headers: { 'Content-Type': 'application/json', ...headers },
          ...(method === 'GET' ? {} : { body: '{}' }),
        });
        expect(
          response.status,
          `${method} ${path} ${JSON.stringify(headers)}`,
        ).toBe(403);
      }
    }
    expect(session.calls.signIn).toBe(0);
  });

  it('refuses a write that is not JSON, which a cross-site form could send', async () => {
    const { app, session } = await fixture();
    const response = await app.request('/api/model/chatgpt/sign-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'a=b',
    });
    expect(response.status).toBe(415);
    expect(session.calls.signIn).toBe(0);
  });

  it('refuses an unrecognised host when there is no owner token', async () => {
    const { app } = await fixture();
    const response = await app.request(
      'http://opendots.attacker.example/api/model',
    );
    expect(response.status).toBe(403);
  });

  it('will not start sign-in when the server is not on the owner machine', async () => {
    const h = harness({ loopback: false });
    open.push(h);
    await h.service.start();
    const app = createApp({
      store: h.store,
      runner: new Runner(h.store, config),
      config,
      models: h.service,
    });
    const response = await app.request('/api/model/chatgpt/sign-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'not_local' });
    expect(h.session.calls.signIn).toBe(0);
  });
});
