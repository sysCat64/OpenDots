import { afterEach, describe, expect, it, vi } from 'vitest';

// The browser's half of the owner boundary: where the token comes from, where
// it is kept, and how it is sent. These pin the existing mechanism, which C2
// deliberately keeps (DEC-2: sessionStorage stays an accepted v1 risk).
const KEY = 'opendots-token';

function browser(initial?: string) {
  const session = new Map<string, string>(initial ? [[KEY, initial]] : []);
  const localAccess: string[] = [];
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => session.get(key) ?? null,
    setItem: (key: string, value: string) => void session.set(key, value),
    removeItem: (key: string) => void session.delete(key),
  });
  // Any touch of localStorage is a failure of the storage contract.
  vi.stubGlobal(
    'localStorage',
    new Proxy(
      {},
      {
        get: (_target, property) => {
          localAccess.push(String(property));
          return undefined;
        },
      },
    ),
  );
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({ ok: true }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return { session, localAccess, fetchMock };
}

async function loadClient() {
  vi.resetModules();
  return import('../src/client/api');
}

afterEach(() => vi.unstubAllGlobals());

describe('owner token in the browser', () => {
  it('sends the token kept in sessionStorage as a bearer header, never in the URL', async () => {
    const { fetchMock } = browser('stored-owner-token');
    const client = await loadClient();
    await client.api('/state');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/state');
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer stored-owner-token',
    });
    // The CopilotKit runtime connection uses the same transport.
    expect(client.authHeaders()).toEqual({
      Authorization: 'Bearer stored-owner-token',
    });
  });

  it('survives a reload of the same tab and is cleared on sign-out', async () => {
    const { session, fetchMock } = browser();
    const first = await loadClient();
    first.setToken('typed-in-unlock-form');
    expect(session.get(KEY)).toBe('typed-in-unlock-form');
    // A reload evaluates the client again against the same sessionStorage.
    const reloaded = await loadClient();
    expect(reloaded.authHeaders()).toEqual({
      Authorization: 'Bearer typed-in-unlock-form',
    });
    reloaded.setToken('');
    expect(session.has(KEY)).toBe(false);
    await reloaded.api('/state');
    const init = fetchMock.mock.calls[0][1];
    expect(init?.headers).not.toHaveProperty('Authorization');
  });

  it('keeps the token out of localStorage', async () => {
    const { localAccess } = browser();
    const client = await loadClient();
    client.setToken('not-for-local-storage');
    await client.api('/state');
    expect(localAccess).toEqual([]);
  });

  it('sends no credential without a token and surfaces the 401 that opens the unlock form', async () => {
    const { fetchMock } = browser();
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { error: 'Enter your owner access token.' },
        { status: 401 },
      ),
    );
    const client = await loadClient();
    const failure = (await client
      .api('/state')
      .catch((error: unknown) => error)) as { status: number };
    expect(failure).toBeInstanceOf(client.ApiError);
    expect(failure.status).toBe(401);
    const init = fetchMock.mock.calls[0][1];
    // Nothing is invented or defaulted in place of the missing token.
    expect(init?.headers).not.toHaveProperty('Authorization');
    expect(client.authHeaders()).toEqual({});
  });
});
