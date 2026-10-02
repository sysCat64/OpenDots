import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createChatGPTPlanSession,
  inspectDevKit,
} from '../src/server/chatgpt-devkit.js';
import { ChatGPTPlanError } from '../src/server/chatgpt-plan.js';
import {
  DEVKIT_FINGERPRINT_FILES,
  VERIFIED_DEVKIT_BUILDS,
  fingerprintDevKit,
  type DevKitBuild,
} from '../src/server/devkit-compat.js';
import { FakeBackend } from './fixtures/key-backend.js';

vi.setConfig({ testTimeout: 20_000 });

// A scripted stand-in for the DevKit, with a store that records any write: the
// integration must never write, whatever it finds.
const fakeIndex = `
(globalThis.__devkitLoaded ??= []).push('index.js');
export function createChatGPT() {
  const f = globalThis.__devkit;
  const call = (name) => { f.calls[name] = (f.calls[name] ?? 0) + 1; };
  const client = {
    async signIn(options) { call('signIn'); f.signIns.push(options); return f.signInResult; },
    async getSession() { call('getSession'); return f.session; },
    async listProfiles() { call('listProfiles'); return f.profiles; },
    async listModels() {
      call('listModels');
      if (f.listModelsError) throw f.listModelsError;
      if (f.refresh) f.state = f.refresh(f.state);
      return [{ slug: 'gpt-5.6-luna', displayName: 'Luna' }];
    },
    async disconnect() { call('disconnect'); },
  };
  for (const name of f.omit ?? []) delete client[name];
  return client;
}
`;
const fakeStorage = (extra = '') => `
(globalThis.__devkitLoaded ??= []).push('storage.js');
export class ConnectionStore {
  async withLock(operation) { return operation(); }
  async read() {
    const f = globalThis.__devkit;
    f.calls.read = (f.calls.read ?? 0) + 1;
    if (f.readError) throw f.readError;
    return f.state;
  }
  async write() { const f = globalThis.__devkit; f.calls.write = (f.calls.write ?? 0) + 1; throw new Error('unexpected write'); }
  ${extra}
}
`;

type Fake = {
  state?: unknown;
  session: {
    status: string;
    sharing: boolean;
    error?: { code: string; message: string };
  };
  signInResult: { status: string; sharing: boolean };
  profiles: Array<{ id: string }>;
  signIns: Array<Record<string, unknown>>;
  calls: Record<string, number>;
  readError?: Error;
  listModelsError?: Error;
  refresh?: (state: unknown) => unknown;
  omit?: string[];
};
const g = globalThis as unknown as {
  __devkit: Fake;
  __devkitLoaded: string[];
};
// What the DevKit's own modules ran when they were loaded.
const loaded = () => g.__devkitLoaded ?? [];
const SECRET = 'secret-access-token';
const hour = 3_600_000;
const stateWith = (
  accessToken: string,
  expiresAt: number,
  over: object = {},
) => ({
  version: 2,
  activeProfileId: 'p',
  profiles: [
    { id: 'p', status: 'connected', credentials: { accessToken, expiresAt } },
  ],
  pendingRegistrations: [],
  ...over,
});
const devkitError = (code: string, message: string, retryable = false) =>
  Object.assign(new Error(message), { code, retryable });

let root: string;
let dist: string;
let stateDir: string;
const recorded: DevKitBuild[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'devkit-hardening-'));
  dist = join(root, 'devkit', 'dist');
  stateDir = join(root, 'state');
  await makeDist(dist);
  g.__devkitLoaded = [];
  g.__devkit = {
    state: stateWith(SECRET, Date.now() + hour),
    session: { status: 'connected', sharing: true },
    signInResult: { status: 'connected', sharing: true },
    profiles: [],
    signIns: [],
    calls: {},
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const build of recorded.splice(0))
    VERIFIED_DEVKIT_BUILDS.splice(VERIFIED_DEVKIT_BUILDS.indexOf(build), 1);
  await rm(root, { recursive: true, force: true });
});
async function makeDist(
  target: string,
  storage = fakeStorage(),
  pkg: object | undefined = { name: '@siwc/local', version: '0.1.0' },
) {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'index.js'), fakeIndex);
  await writeFile(join(target, 'storage.js'), storage);
  for (const name of DEVKIT_FINGERPRINT_FILES.filter(
    (n) => !['index.js', 'storage.js'].includes(n),
  ))
    await writeFile(join(target, name), `// ${name}`);
  if (pkg)
    await writeFile(join(target, '..', 'package.json'), JSON.stringify(pkg));
}
const open = (
  extra: Parameters<typeof createChatGPTPlanSession>[0] extends infer O
    ? Partial<O>
    : never = {},
) => createChatGPTPlanSession({ devkitDist: dist, ...extra });
const ENVELOPE = (over: object = {}) =>
  JSON.stringify({
    version: 3,
    provider: 'opendots-keychain-aes-256-gcm-v1',
    ciphertext: 'AAAA',
    ...over,
  });
const keychain = (backend = new FakeBackend()) =>
  open({ credentialStore: 'keychain', stateDir, keyBackend: backend });

describe('which build is in use', () => {
  it('a recorded build is verified', async () => {
    const { files, aggregate } = await fingerprintDevKit(dist);
    const build = {
      commit: 'abc1234def',
      package: '@siwc/local',
      version: '0.1.0',
      files,
      aggregate,
    } as DevKitBuild;
    VERIFIED_DEVKIT_BUILDS.push(build);
    recorded.push(build);
    const session = await open();
    expect(session.devkit).toMatchObject({
      compatibility: 'verified',
      commit: 'abc1234def',
    });
    await session.close();
  });

  it('an unknown build with a valid contract is untested, and allowed', async () => {
    const session = await open();
    expect(session.devkit).toMatchObject({
      compatibility: 'untested',
      version: '0.1.0',
    });
    await expect(session.status()).resolves.toEqual({ state: 'signed_in' });
    await session.close();
  });

  it('strict mode refuses an unknown build, and leaves nothing behind', async () => {
    const before = process.listenerCount('exit');
    await expect(open({ devkitStrict: true })).rejects.toMatchObject({
      code: 'devkit_incompatible',
    });
    expect(process.listenerCount('exit')).toBe(before);
    expect(g.__devkit.calls.getSession).toBeUndefined();
  });

  describe('strict mode decides before the DevKit is loaded', () => {
    it('an unknown build is refused without running any of its code', async () => {
      await expect(open({ devkitStrict: true })).rejects.toMatchObject({
        code: 'devkit_incompatible',
        message: expect.stringContaining('strict mode'),
      });
      expect(loaded()).toEqual([]); // neither index.js nor storage.js was evaluated
    });

    it('so is the same build when only reporting on it', async () => {
      const found = await inspectDevKit(dist, { strict: true });
      expect(found).toMatchObject({
        outcome: 'incompatible',
        compatibility: { compatibility: 'untested' },
      });
      expect(found.reason).toMatch(/strict mode/);
      expect(loaded()).toEqual([]);
    });

    it('a package that is not @siwc/local is refused without running it either', async () => {
      await makeDist(dist, fakeStorage(), {
        name: 'something-else',
        version: '1',
      });
      await expect(open({ devkitStrict: true })).rejects.toMatchObject({
        code: 'devkit_incompatible',
      });
      expect(loaded()).toEqual([]);
    });

    it('a wrong path is still reported as a wrong path, not as an unrecorded build', async () => {
      await expect(
        open({ devkitDist: join(root, 'nowhere'), devkitStrict: true }),
      ).rejects.toThrow(/CHATGPT_DEVKIT_DIST must point/);
      expect(loaded()).toEqual([]);
    });

    it('a recorded build is loaded, and works', async () => {
      const { files, aggregate } = await fingerprintDevKit(dist);
      const build = {
        commit: 'abc1234def',
        package: '@siwc/local',
        version: '0.1.0',
        files,
        aggregate,
      } as DevKitBuild;
      VERIFIED_DEVKIT_BUILDS.push(build);
      recorded.push(build);
      const session = await open({ devkitStrict: true });
      expect(loaded().sort()).toEqual(['index.js', 'storage.js']);
      await session.close();
    });
  });

  describe('without strict mode the build is loaded first, then judged', () => {
    it('an unknown build is loaded and, its contract holding, used as untested', async () => {
      const session = await open();
      expect(loaded().sort()).toEqual(['index.js', 'storage.js']);
      expect(session.devkit.compatibility).toBe('untested');
      await session.close();
    });

    it('is also what reporting on it does', async () => {
      const found = await inspectDevKit(dist);
      expect(found).toMatchObject({
        outcome: 'ok',
        compatibility: { compatibility: 'untested' },
      });
      expect(loaded().sort()).toEqual(['index.js', 'storage.js']);
    });

    it('a contract violation is found only after loading it', async () => {
      g.__devkit.omit = ['getSession'];
      await expect(open()).rejects.toMatchObject({
        code: 'devkit_incompatible',
      });
      expect(loaded().sort()).toEqual(['index.js', 'storage.js']);
    });
  });

  it('strict mode accepts a recorded build', async () => {
    const { files, aggregate } = await fingerprintDevKit(dist);
    const build = {
      commit: 'abc1234def',
      package: '@siwc/local',
      version: '0.1.0',
      files,
      aggregate,
    } as DevKitBuild;
    VERIFIED_DEVKIT_BUILDS.push(build);
    recorded.push(build);
    const session = await open({ devkitStrict: true });
    expect(session.devkit.compatibility).toBe('verified');
    await session.close();
  });

  it('a contract violation is refused whatever the fingerprint says', async () => {
    const { files, aggregate } = await fingerprintDevKit(dist);
    const build = {
      commit: 'abc1234def',
      package: '@siwc/local',
      version: '0.1.0',
      files,
      aggregate,
    } as DevKitBuild;
    VERIFIED_DEVKIT_BUILDS.push(build);
    recorded.push(build);
    g.__devkit.omit = ['getSession']; // a "verified" build whose behaviour no longer matches
    const before = process.listenerCount('exit');
    await expect(open()).rejects.toMatchObject({
      code: 'devkit_incompatible',
      message: expect.stringContaining('client.getSession'),
    });
    expect(process.listenerCount('exit')).toBe(before);
  });

  it.each([
    [
      'a store without read()',
      fakeStorage().replace('async read()', 'async notRead()'),
      /ConnectionStore\.read/,
    ],
    [
      'a store without withLock()',
      fakeStorage().replace('async withLock(', 'async notLock('),
      /ConnectionStore\.withLock/,
    ],
  ])('refuses %s at load', async (_name, storage, problem) => {
    await makeDist(dist, storage);
    await expect(open()).rejects.toMatchObject({
      code: 'devkit_incompatible',
      message: expect.stringMatching(problem),
    });
  });

  it('refuses a missing ConnectionStore export', async () => {
    await makeDist(dist, 'export const Other = class {};');
    await expect(open()).rejects.toMatchObject({ code: 'devkit_incompatible' });
  });

  it('keeps the distinct, existing error for a path that holds no DevKit', async () => {
    await expect(open({ devkitDist: join(root, 'nowhere') })).rejects.toThrow(
      /CHATGPT_DEVKIT_DIST/,
    );
  });
});

describe('getting an access token', () => {
  const token = async (session: Awaited<ReturnType<typeof open>>) =>
    session.auth.getAccessToken();

  it('does not ask the DevKit to refresh a token that has more than its refresh window left', async () => {
    g.__devkit.state = stateWith('long-lived', Date.now() + 100_000); // was inside the old 120 s margin
    const session = await open();
    expect(await token(session)).toBe('long-lived');
    expect(g.__devkit.calls.listModels).toBeUndefined();
    await session.close();
  });

  it("asks for a refresh inside the DevKit's window, then reads the state again", async () => {
    g.__devkit.state = stateWith('old-token', Date.now() + 30_000);
    g.__devkit.refresh = () => stateWith('new-token', Date.now() + hour);
    const session = await open();
    expect(await token(session)).toBe('new-token');
    expect(g.__devkit.calls.listModels).toBe(1);
    expect(g.__devkit.calls.read).toBe(2);
    await session.close();
  });

  it('does not take "the refresh call succeeded" to mean the token is fresh', async () => {
    g.__devkit.state = stateWith('stale-token', Date.now() + 10_000);
    // listModels succeeds but the DevKit left the token alone.
    const session = await open();
    const error = await token(session).catch((e) => e);
    expect(error).toBeInstanceOf(ChatGPTPlanError);
    expect(error).toMatchObject({ code: 'token_not_refreshed', status: 503 });
    expect(g.__devkit.calls.listModels).toBe(1);
    await session.close();
  });

  it('still uses a token the DevKit chose not to refresh yet, while it is usable', async () => {
    g.__devkit.state = stateWith('usable-token', Date.now() + 45_000);
    const session = await open();
    expect(await token(session)).toBe('usable-token');
    expect(g.__devkit.calls.listModels).toBe(1);
    await session.close();
  });

  it('checks the shape again after a refresh', async () => {
    g.__devkit.state = stateWith('old-token', Date.now() + 30_000);
    g.__devkit.refresh = () => stateWith('t', 1_800_000_000); // the DevKit now writes seconds
    const session = await open();
    await expect(token(session)).rejects.toMatchObject({
      code: 'devkit_incompatible',
    });
    await session.close();
  });

  it('shares one refresh between concurrent requests', async () => {
    g.__devkit.state = stateWith('old-token', Date.now() + 20_000);
    g.__devkit.refresh = () => stateWith('new-token', Date.now() + hour);
    const session = await open();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => token(session)),
    );
    expect(new Set(results)).toEqual(new Set(['new-token']));
    expect(g.__devkit.calls.listModels).toBe(1);
    await session.close();
  });

  it('is a sign-in error, without any refresh attempt, when nobody is signed in', async () => {
    g.__devkit.state = undefined;
    const session = await open();
    await expect(token(session)).rejects.toMatchObject({
      code: 'sign_in_required',
      status: 401,
    });
    expect(g.__devkit.calls.listModels).toBeUndefined();
    await session.close();
  });

  it('never refreshes OAuth tokens itself and never writes', async () => {
    g.__devkit.state = stateWith('old-token', Date.now() + 5_000);
    const session = await open();
    await token(session).catch(() => undefined);
    expect(g.__devkit.calls.write).toBeUndefined();
    await session.close();
  });

  it("maps request failures by the DevKit's own retryable flag, with an open set of codes", async () => {
    g.__devkit.state = stateWith('old-token', Date.now() + 10_000);
    const session = await open();
    const failWith = async (error: Error) => {
      g.__devkit.listModelsError = error;
      return token(session).catch((e) => e);
    };
    expect(
      await failWith(devkitError('some_new_code', 'Try later.', true)),
    ).toMatchObject({ status: 503, code: 'some_new_code' });
    expect(
      await failWith(devkitError('refresh_token_reused', 'Sign in again.')),
    ).toMatchObject({ status: 401 });
    expect(
      await failWith(devkitError('invalid_grant', 'Sign in again.')),
    ).toMatchObject({ status: 401 });
    expect(
      await failWith(devkitError('a_code_nobody_has_seen', 'Odd.')),
    ).toMatchObject({ status: 502 });
    await session.close();
  });
});

describe('an unsupported saved state is never a sign-out', () => {
  const secretState = (
    over: object,
    credentials: object = { accessToken: SECRET, expiresAt: Date.now() + hour },
  ) => ({
    version: 2,
    activeProfileId: 'p',
    profiles: [
      {
        id: 'p',
        status: 'connected',
        label: 'secret-profile-label',
        credentials,
      },
    ],
    pendingRegistrations: [],
    ...over, // the case's own change wins
  });
  const cases: Array<[string, unknown]> = [
    ['an unknown stored-state version', secretState({ version: 3 })],
    ['a version missing', secretState({ version: undefined })],
    ['profiles that are not a list', secretState({ profiles: 'x' })],
    [
      'an unknown profile status',
      stateWith(SECRET, Date.now() + hour, {
        profiles: [
          {
            id: 'p',
            status: 'suspended',
            credentials: { accessToken: SECRET, expiresAt: Date.now() + hour },
          },
        ],
      }),
    ],
    [
      'a connected profile with no credentials',
      stateWith(SECRET, 0, {
        profiles: [
          { id: 'p', status: 'connected', label: 'secret-profile-label' },
        ],
      }),
    ],
    [
      'expiresAt in seconds',
      secretState(
        {},
        {
          accessToken: SECRET,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        },
      ),
    ],
    [
      'expiresAt as text',
      secretState(
        {},
        { accessToken: SECRET, expiresAt: String(Date.now() + hour) },
      ),
    ],
    [
      'an access token that is not text',
      secretState({}, { accessToken: 12345, expiresAt: Date.now() + hour }),
    ],
    [
      'a state that is not an object',
      'a string with secret-access-token in it',
    ],
  ];

  it.each(cases)(
    '%s: asking for a token says devkit_incompatible',
    async (_name, state) => {
      g.__devkit.state = state;
      const session = await open();
      const error = await session.auth.getAccessToken().catch((e) => e);
      expect(error).toBeInstanceOf(ChatGPTPlanError);
      expect(error).toMatchObject({ code: 'devkit_incompatible', status: 503 });
      expect(error.code).not.toBe('sign_in_required');
      await session.close();
    },
  );

  it.each(cases)(
    '%s: the status is unavailable, not signed in or out',
    async (_name, state) => {
      g.__devkit.state = state;
      const session = await open();
      expect(await session.status()).toMatchObject({
        state: 'unavailable',
        failure: { code: 'devkit_incompatible' },
      });
      await session.close();
    },
  );

  it.each(cases)(
    '%s: nothing secret in the error, the status, or the logs',
    async (_name, state) => {
      const logs = [
        vi.spyOn(console, 'log'),
        vi.spyOn(console, 'warn'),
        vi.spyOn(console, 'error'),
      ];
      g.__devkit.state = state;
      const session = await open();
      const error = await session.auth.getAccessToken().catch((e) => e);
      const status = await session.status();
      const everything = JSON.stringify([
        error.message,
        error.code,
        status,
        logs.map((l) => l.mock.calls),
      ]);
      for (const secret of [SECRET, 'secret-profile-label'])
        expect(everything).not.toContain(secret);
      await session.close();
    },
  );

  it('is checked once per sign-in, not on every status poll', async () => {
    const session = await open();
    await session.status();
    await session.status();
    await session.status();
    expect(g.__devkit.calls.read).toBe(1);
    await session.close();
  });

  it('is checked again right after signing in, and reported as unavailable', async () => {
    g.__devkit.session = { status: 'disconnected', sharing: false };
    g.__devkit.state = undefined;
    const session = await open();
    await expect(session.status()).resolves.toEqual({ state: 'signed_out' });
    g.__devkit.state = stateWith(SECRET, 1_800_000_000); // saved in seconds
    await expect(session.signIn()).rejects.toMatchObject({
      code: 'devkit_incompatible',
    });
    await session.close();
  });
});

describe('what the DevKit says about the session', () => {
  const status = async (session: object, state: unknown = g.__devkit.state) => {
    g.__devkit.session = session as Fake['session'];
    g.__devkit.state = state;
    const s = await open();
    const result = await s.status();
    await s.close();
    return result;
  };
  const profileState = (profileStatus: string) => ({
    version: 2,
    activeProfileId: 'p',
    profiles: [{ id: 'p', status: profileStatus }],
    pendingRegistrations: [],
  });

  it('an ordinary disconnected session is signed out', async () => {
    expect(
      await status(
        { status: 'disconnected', sharing: false },
        profileState('disconnected'),
      ),
    ).toEqual({ state: 'signed_out' });
  });

  it('a session that needs signing in again, with no error, is signed out', async () => {
    expect(
      await status(
        { status: 'reauth_required', sharing: false },
        profileState('reauth_required'),
      ),
    ).toEqual({ state: 'signed_out' });
  });

  it('a connection change under way is not a failure', async () => {
    expect(
      await status({ status: 'connecting', sharing: false }, undefined),
    ).toEqual({ state: 'signed_out' });
  });

  describe('a connected session: its saved state is checked whatever the sharing flag says', () => {
    const valid = () => stateWith(SECRET, Date.now() + hour);
    const noCredentials = {
      version: 2,
      activeProfileId: 'p',
      profiles: [{ id: 'p', status: 'connected' }],
      pendingRegistrations: [],
    };

    it('valid credentials and sharing on: signed in', async () => {
      expect(
        await status({ status: 'connected', sharing: true }, valid()),
      ).toEqual({ state: 'signed_in' });
    });

    it('valid credentials and sharing off: signed out', async () => {
      expect(
        await status({ status: 'connected', sharing: false }, valid()),
      ).toEqual({ state: 'signed_out' });
    });

    it.each([
      ['missing credentials', noCredentials],
      [
        'credentials that are null',
        {
          ...noCredentials,
          profiles: [{ id: 'p', status: 'connected', credentials: null }],
        },
      ],
      [
        'an access token that is not text',
        stateWith(5 as never, Date.now() + hour),
      ],
      ['expiresAt in seconds', stateWith(SECRET, 1_800_000_000)],
      ['an unknown stored-state version', { ...valid(), version: 3 }],
    ])(
      '%s: unavailable as devkit_incompatible, with sharing on or off',
      async (_name, state) => {
        for (const sharing of [true, false])
          expect(
            await status({ status: 'connected', sharing }, state),
          ).toMatchObject({
            state: 'unavailable',
            failure: { code: 'devkit_incompatible' },
          });
      },
    );

    it('does not carry on to a sign-in or a token as if all were well', async () => {
      g.__devkit.session = { status: 'connected', sharing: false };
      g.__devkit.state = noCredentials;
      const session = await open();
      expect(await session.status()).toMatchObject({ state: 'unavailable' });
      await expect(session.auth.getAccessToken()).rejects.toMatchObject({
        code: 'devkit_incompatible',
      });
      await session.close();
    });
  });

  it('an unknown status is unavailable, never signed out', async () => {
    expect(
      await status({ status: 'quarantined', sharing: true }),
    ).toMatchObject({
      state: 'unavailable',
      failure: { code: 'devkit_incompatible' },
    });
  });

  it('a remembered earlier error does not turn a valid sign-out into a failure', async () => {
    // The DevKit keeps the last request error on the session; here a failed revocation.
    expect(
      await status(
        {
          status: 'disconnected',
          sharing: false,
          error: { code: 'revocation_failed', message: 'Could not confirm.' },
        },
        profileState('disconnected'),
      ),
    ).toEqual({ state: 'signed_out' });
    expect(
      await status(
        {
          status: 'reauth_required',
          sharing: false,
          error: { code: 'invalid_grant', message: 'Expired.' },
        },
        profileState('reauth_required'),
      ),
    ).toEqual({ state: 'signed_out' });
  });

  it('an error with a code nobody knows is unavailable when the saved state cannot be read', async () => {
    g.__devkit.readError = devkitError(
      'brand_new_failure',
      'The vault is sealed.',
      true,
    );
    expect(
      await status({
        status: 'reauth_required',
        sharing: false,
        error: { code: 'brand_new_failure', message: 'The vault is sealed.' },
      }),
    ).toMatchObject({
      state: 'unavailable',
      failure: { code: 'brand_new_failure', hint: 'The vault is sealed.' },
    });
  });

  it('an unknown error beside a state in an unsupported shape is devkit_incompatible', async () => {
    expect(
      await status(
        {
          status: 'reauth_required',
          sharing: false,
          error: { code: 'whatever_it_is', message: 'x' },
        },
        { version: 9, profiles: [] },
      ),
    ).toMatchObject({
      state: 'unavailable',
      failure: { code: 'devkit_incompatible' },
    });
  });

  it('a storage failure is unavailable, as before', async () => {
    expect(
      await status({
        status: 'reauth_required',
        sharing: false,
        error: {
          code: 'storage_busy',
          message: 'Another process is updating this.',
        },
      }),
    ).toMatchObject({
      state: 'unavailable',
      failure: { code: 'storage_busy' },
    });
  });

  it('never calls an unexplained failure a sign-out', async () => {
    for (const error of [
      { code: 'x_unknown', message: 'a' },
      { code: 'storage_decryption_failed', message: 'b' },
      { code: 'host_identity_invalid', message: 'c' },
    ]) {
      g.__devkit.readError = devkitError(error.code, error.message);
      const result = await status({
        status: 'reauth_required',
        sharing: false,
        error,
      });
      expect(result.state).toBe('unavailable');
    }
  });
});

describe('an unrecognized saved session never reaches the DevKit', () => {
  const authFile = () => join(stateDir, 'chatgpt-auth.json');
  const place = async (content: string) => {
    const session = await keychain();
    await session.close();
    await writeFile(authFile(), content, { mode: 0o600 });
    g.__devkit.calls = {};
  };

  it.each([
    ['an older envelope', ENVELOPE({ version: 2 })],
    ['a newer envelope', ENVELOPE({ version: 4 })],
    ['a plaintext legacy state', JSON.stringify({ version: 2, profiles: [] })],
    ['something that is not JSON', 'garbage'],
  ])(
    '%s: every operation is refused before any DevKit call, and the file is untouched',
    async (_name, content) => {
      await place(content);
      const before = {
        bytes: await readFile(authFile()),
        at: (await stat(authFile())).mtimeMs,
      };
      const session = await keychain();
      expect(await session.status()).toMatchObject({
        state: 'unavailable',
        failure: { code: 'devkit_incompatible' },
      });
      await expect(session.signIn()).rejects.toMatchObject({
        code: 'devkit_incompatible',
      });
      await expect(session.signOut()).rejects.toMatchObject({
        code: 'devkit_incompatible',
      });
      await expect(session.auth.getAccessToken()).rejects.toMatchObject({
        code: 'devkit_incompatible',
      });
      await expect(session.auth.listModels()).rejects.toMatchObject({
        code: 'devkit_incompatible',
      });
      await session.close();
      // Nothing was decrypted, read, migrated, written or reset.
      expect(g.__devkit.calls).toEqual({});
      expect((await readFile(authFile())).equals(before.bytes)).toBe(true);
      expect((await stat(authFile())).mtimeMs).toBe(before.at);
    },
  );

  it('a recognized envelope goes through to the DevKit as usual', async () => {
    await place(ENVELOPE());
    const session = await keychain();
    expect(await session.status()).toEqual({ state: 'signed_in' });
    expect(g.__devkit.calls.getSession).toBe(1);
    await session.close();
  });

  it('the check is skipped for a session that has no saved file (first start)', async () => {
    const session = await keychain();
    expect(await session.status()).toEqual({ state: 'signed_in' });
    await session.close();
  });

  it('applies only to the persistent store OpenDots manages', async () => {
    const session = await open(); // ephemeral: a fresh temporary directory
    expect(await session.status()).toEqual({ state: 'signed_in' });
    await session.close();
  });
});

describe('a stored state in an unsupported shape never changes the credential file', () => {
  it('leaves the encrypted file byte for byte the same, and writes nothing', async () => {
    const first = await keychain();
    await first.close();
    const file = join(stateDir, 'chatgpt-auth.json');
    await writeFile(file, ENVELOPE(), { mode: 0o600 });
    const before = {
      bytes: await readFile(file),
      at: (await stat(file)).mtimeMs,
    };
    g.__devkit.state = stateWith(SECRET, 1_800_000_000);
    const session = await keychain();
    await session.status();
    await session.auth.getAccessToken().catch(() => undefined);
    await session.signIn().catch(() => undefined);
    await session.close();
    expect((await readFile(file)).equals(before.bytes)).toBe(true);
    expect((await stat(file)).mtimeMs).toBe(before.at);
    expect(g.__devkit.calls.write).toBeUndefined();
  });
});
