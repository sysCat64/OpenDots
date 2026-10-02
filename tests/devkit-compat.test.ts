import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEVKIT_AUTH_ENVELOPE_VERSION,
  DEVKIT_FINGERPRINT_FILES,
  DEVKIT_LAYOUT,
  DEVKIT_STORED_STATE_VERSION,
  DevKitIncompatibleError,
  VERIFIED_DEVKIT_BUILDS,
  assessDevKit,
  clientProblems,
  exportProblems,
  fingerprintDevKit,
  preflightAuthEnvelope,
  readStoredAccessToken,
  type DevKitBuild,
} from '../src/server/devkit-compat.js';

vi.setConfig({ testTimeout: 20_000 });

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'devkit-compat-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it('keeps the two format versions apart, in name and in meaning', () => {
  // The auth file's outer envelope and what it decrypts to are different formats.
  expect(DEVKIT_AUTH_ENVELOPE_VERSION).toBe(3);
  expect(DEVKIT_STORED_STATE_VERSION).toBe(2);
});

describe('builds', () => {
  const makeDist = async (
    name: string,
    contents: Record<string, string> = {},
    pkg?: object,
  ) => {
    const dist = join(root, name, 'dist');
    await mkdir(dist, { recursive: true });
    for (const file of DEVKIT_FINGERPRINT_FILES)
      await writeFile(join(dist, file), contents[file] ?? `// ${file}`);
    if (pkg)
      await writeFile(join(dist, '..', 'package.json'), JSON.stringify(pkg));
    return dist;
  };
  const recorded: DevKitBuild[] = [];
  afterEach(() => {
    for (const build of recorded.splice(0))
      VERIFIED_DEVKIT_BUILDS.splice(VERIFIED_DEVKIT_BUILDS.indexOf(build), 1);
  });
  const record = async (dist: string, commit = 'abc1234def') => {
    const { files, aggregate } = await fingerprintDevKit(dist);
    const build = {
      commit,
      package: '@siwc/local',
      version: '0.1.0',
      files,
      aggregate,
    } as DevKitBuild;
    VERIFIED_DEVKIT_BUILDS.push(build);
    recorded.push(build);
  };

  it('fingerprints each selected runtime file, then all of them in order', async () => {
    const dist = await makeDist('a');
    const { files, aggregate } = await fingerprintDevKit(dist);
    for (const file of DEVKIT_FINGERPRINT_FILES)
      expect(files[file]).toBe(sha(`// ${file}`));
    const expected = sha(
      DEVKIT_FINGERPRINT_FILES.map((f) => `${f}:${sha(`// ${f}`)}\n`).join(''),
    );
    expect(aggregate).toBe(expected);
  });

  it('changes the fingerprint when any covered file changes', async () => {
    const one = await fingerprintDevKit(await makeDist('one'));
    const two = await fingerprintDevKit(
      await makeDist('two', { 'storage.js': '// changed' }),
    );
    expect(two.aggregate).not.toBe(one.aggregate);
    expect(two.files['storage.js']).not.toBe(one.files['storage.js']);
    expect(two.files['index.js']).toBe(one.files['index.js']);
  });

  it('a missing file is recorded as missing, not an error', async () => {
    const dist = await makeDist('b');
    await rm(join(dist, 'models.js'));
    expect((await fingerprintDevKit(dist)).files['models.js']).toBe('missing');
  });

  it('known fingerprint -> verified, with its commit', async () => {
    const dist = await makeDist(
      'known',
      {},
      { name: '@siwc/local', version: '0.1.0' },
    );
    await record(dist, 'f723814abdcc');
    expect(await assessDevKit(dist)).toMatchObject({
      compatibility: 'verified',
      commit: 'f723814abdcc',
      package: '@siwc/local',
      version: '0.1.0',
    });
  });

  it('unknown fingerprint -> untested, and still allowed', async () => {
    const dist = await makeDist(
      'unknown',
      { 'oauth.js': '// a newer build' },
      { name: '@siwc/local', version: '0.2.0' },
    );
    const info = await assessDevKit(dist);
    expect(info).toMatchObject({ compatibility: 'untested', version: '0.2.0' });
    expect(info.commit).toBeUndefined();
  });

  it('strict mode refuses an unknown build, and accepts a recorded one', async () => {
    const unknown = await makeDist('strict-unknown');
    const error = await assessDevKit(unknown, { strict: true }).catch((e) => e);
    expect(error).toBeInstanceOf(DevKitIncompatibleError);
    expect(error).toMatchObject({ code: 'devkit_incompatible', status: 503 });
    expect(error.message).toMatch(/strict mode/);
    const known = await makeDist('strict-known');
    await record(known);
    expect((await assessDevKit(known, { strict: true })).compatibility).toBe(
      'verified',
    );
  });

  it('works for a build copied away from its package.json', async () => {
    const dist = await makeDist('copied');
    expect(await assessDevKit(dist)).toMatchObject({
      compatibility: 'untested',
      version: undefined,
    });
  });

  it('refuses a package that is not @siwc/local', async () => {
    const dist = await makeDist(
      'other',
      {},
      { name: 'something-else', version: '1.0.0' },
    );
    await expect(assessDevKit(dist)).rejects.toMatchObject({
      code: 'devkit_incompatible',
    });
  });

  it('records the verified build with its commit, package, version and fingerprints', () => {
    for (const build of VERIFIED_DEVKIT_BUILDS) {
      expect(build.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(build.package).toBe('@siwc/local');
      expect(build.version).toBeTruthy();
      expect(Object.keys(build.files).sort()).toEqual(
        [...DEVKIT_FINGERPRINT_FILES].sort(),
      );
      for (const hash of Object.values(build.files))
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
      const aggregate = sha(
        DEVKIT_FINGERPRINT_FILES.map((f) => `${f}:${build.files[f]}\n`).join(
          '',
        ),
      );
      expect(build.aggregate).toBe(aggregate); // the recorded aggregate matches its parts
    }
  });
});

describe('the DevKit exports and client', () => {
  class Store {
    read() {}
    withLock() {}
  }
  const good = [{ createChatGPT() {} }, { ConnectionStore: Store }] as const;

  it('accepts what the DevKit provides today', () => {
    expect(exportProblems(...good)).toEqual([]);
    const client = {
      signIn() {},
      getSession() {},
      listProfiles() {},
      listModels() {},
      disconnect() {},
    };
    expect(clientProblems(client)).toEqual([]);
  });

  it.each([
    [
      'no createChatGPT',
      [{}, { ConnectionStore: Store }],
      'createChatGPT is missing',
    ],
    [
      'createChatGPT not a function',
      [{ createChatGPT: 1 }, { ConnectionStore: Store }],
      'createChatGPT is missing',
    ],
    [
      'no ConnectionStore',
      [{ createChatGPT() {} }, {}],
      'ConnectionStore is missing',
    ],
    [
      'no store read()',
      [
        { createChatGPT() {} },
        {
          ConnectionStore: class {
            withLock() {}
          },
        },
      ],
      'ConnectionStore.read is missing',
    ],
    [
      'no store withLock()',
      [
        { createChatGPT() {} },
        {
          ConnectionStore: class {
            read() {}
          },
        },
      ],
      'ConnectionStore.withLock is missing',
    ],
    ['modules are not objects', [undefined, null], 'createChatGPT is missing'],
  ] as const)('reports %s', (_name, modules, problem) => {
    expect(exportProblems(modules[0], modules[1])).toContain(problem);
  });

  it.each(['signIn', 'getSession', 'listProfiles', 'listModels', 'disconnect'])(
    'reports a client without %s()',
    (method) => {
      const client: Record<string, () => void> = {
        signIn() {},
        getSession() {},
        listProfiles() {},
        listModels() {},
        disconnect() {},
      };
      delete client[method];
      expect(clientProblems(client)).toEqual([`client.${method} is missing`]);
    },
  );
});

describe('reading the access token out of the stored state', () => {
  const NOW = 1_800_000_000_000; // a plausible millisecond timestamp
  const profile = (extra: object = {}) => ({
    id: 'p',
    status: 'connected',
    credentials: { accessToken: 'secret-access-token', expiresAt: NOW },
    ...extra,
  });
  const state = (over: object = {}, p: object = profile()) => ({
    version: DEVKIT_STORED_STATE_VERSION,
    activeProfileId: 'p',
    profiles: [p],
    pendingRegistrations: [],
    ...over,
  });
  const incompatible = (value: unknown) => {
    try {
      readStoredAccessToken(value);
    } catch (error) {
      expect(error).toBeInstanceOf(DevKitIncompatibleError);
      expect(error).toMatchObject({ code: 'devkit_incompatible', status: 503 });
      return error as DevKitIncompatibleError;
    }
    throw new Error('expected the stored state to be refused');
  };

  it("returns the active profile's token", () => {
    expect(readStoredAccessToken(state())).toEqual({
      accessToken: 'secret-access-token',
      expiresAt: NOW,
    });
  });

  it('picks the active profile among several', () => {
    const other = {
      id: 'q',
      status: 'connected',
      credentials: { accessToken: 'other-token', expiresAt: NOW + 1 },
    };
    expect(
      readStoredAccessToken(state({ profiles: [other, profile()] }))
        ?.accessToken,
    ).toBe('secret-access-token');
  });

  it.each([
    ['no saved state at all', undefined],
    ['no active profile', state({ activeProfileId: undefined, profiles: [] })],
    [
      'a disconnected profile',
      state({}, profile({ status: 'disconnected', credentials: undefined })),
    ],
    [
      'a profile that needs sign-in again',
      state({}, profile({ status: 'reauth_required', credentials: undefined })),
    ],
  ])(
    '%s is a valid "not signed in", not an incompatibility',
    (_name, value) => {
      expect(readStoredAccessToken(value)).toBeUndefined();
    },
  );

  it.each([
    ['null', null],
    ['text', 'state'],
    ['a list', []],
    ['a missing version', state({ version: undefined })],
    ['an older version', state({ version: 1 })],
    ['a newer version', state({ version: 3 })],
    [
      'the envelope version in its place',
      state({ version: DEVKIT_AUTH_ENVELOPE_VERSION }),
    ],
    ['a version given as text', state({ version: '2' })],
    ['profiles that are not a list', state({ profiles: { p: profile() } })],
    ['missing profiles', state({ profiles: undefined })],
    ['an active profile id that is not text', state({ activeProfileId: 7 })],
    [
      'an active profile that is not in the list',
      state({ activeProfileId: 'missing' }),
    ],
    ['an active profile that is not an object', state({ profiles: ['p'] })],
    ['an unknown profile status', state({}, profile({ status: 'suspended' }))],
    ['a missing profile status', state({}, profile({ status: undefined }))],
    ['a status that is not text', state({}, profile({ status: 2 }))],
    [
      'credentials that are not an object',
      state({}, profile({ credentials: 'x' })),
    ],
    [
      'a connected profile that has no credentials',
      state({}, profile({ credentials: undefined })),
    ],
    [
      'a connected profile whose credentials are null',
      state({}, profile({ credentials: null })),
    ],
    [
      'an empty access token',
      state({}, profile({ credentials: { accessToken: '', expiresAt: NOW } })),
    ],
    [
      'a missing access token',
      state({}, profile({ credentials: { expiresAt: NOW } })),
    ],
    [
      'an access token that is not text',
      state({}, profile({ credentials: { accessToken: 5, expiresAt: NOW } })),
    ],
    [
      'expiresAt as text',
      state(
        {},
        profile({ credentials: { accessToken: 't', expiresAt: String(NOW) } }),
      ),
    ],
    [
      'a missing expiresAt',
      state({}, profile({ credentials: { accessToken: 't' } })),
    ],
    [
      'expiresAt that is NaN',
      state({}, profile({ credentials: { accessToken: 't', expiresAt: NaN } })),
    ],
    [
      'expiresAt that is infinite',
      state(
        {},
        profile({ credentials: { accessToken: 't', expiresAt: Infinity } }),
      ),
    ],
    [
      'expiresAt in seconds',
      state(
        {},
        profile({
          credentials: { accessToken: 't', expiresAt: 1_800_000_000 },
        }),
      ),
    ],
    [
      'expiresAt in microseconds',
      state(
        {},
        profile({
          credentials: { accessToken: 't', expiresAt: 1_800_000_000_000_000 },
        }),
      ),
    ],
    [
      'a negative expiresAt',
      state({}, profile({ credentials: { accessToken: 't', expiresAt: -1 } })),
    ],
    [
      'a zero expiresAt',
      state({}, profile({ credentials: { accessToken: 't', expiresAt: 0 } })),
    ],
  ])(
    'refuses %s as devkit_incompatible (never as signed out)',
    (_name, value) => {
      expect(incompatible(value).reason).toBeTruthy();
    },
  );

  describe('a profile without credentials depends on its status', () => {
    const without = (status: string, credentials: unknown = undefined) =>
      state({}, profile({ status, credentials }));

    it('disconnected: a valid signed-out state', () => {
      expect(readStoredAccessToken(without('disconnected'))).toBeUndefined();
    });

    it('needs sign-in again: a valid re-authorization state', () => {
      expect(readStoredAccessToken(without('reauth_required'))).toBeUndefined();
    });

    it('connected: a contract violation, not a sign-out', () => {
      const error = incompatible(without('connected'));
      expect(error.reason).toMatch(/connected profile has no credentials/);
      incompatible(without('connected', null));
      // The same profile with credentials is perfectly good.
      expect(
        readStoredAccessToken(
          without('connected', { accessToken: 't', expiresAt: NOW }),
        ),
      ).toEqual({ accessToken: 't', expiresAt: NOW });
    });
  });

  it('accepts the edges of the millisecond range and refuses just outside', () => {
    const at = (expiresAt: number) =>
      state({}, profile({ credentials: { accessToken: 't', expiresAt } }));
    expect(readStoredAccessToken(at(1e12))?.expiresAt).toBe(1e12);
    expect(readStoredAccessToken(at(1e14))?.expiresAt).toBe(1e14);
    incompatible(at(1e12 - 1));
    incompatible(at(1e14 + 1));
  });

  it('never puts credential values, ids or labels in what it says', () => {
    const secrets = [
      'secret-access-token',
      'secret-refresh-token',
      'secret-profile-label',
      'secret-client-id',
    ];
    const dirty = (over: object) =>
      state(
        over,
        profile({
          label: 'secret-profile-label',
          clientId: 'secret-client-id',
          credentials: {
            accessToken: 'secret-access-token',
            refreshToken: 'secret-refresh-token',
            expiresAt: 'soon',
          },
          ...over,
        }),
      );
    for (const value of [
      dirty({}),
      dirty({ status: 'secret-profile-label' }),
      dirty({ version: 'secret-access-token' }),
    ]) {
      const error = incompatible(value);
      const everything = `${error.message} ${error.reason} ${JSON.stringify(error)} ${error.stack}`;
      for (const secret of secrets) expect(everything).not.toContain(secret);
    }
  });
});

describe('the auth envelope check before the DevKit sees the file', () => {
  const auth = () => join(root, DEVKIT_LAYOUT.authFile);
  const write = async (content: string, mode = 0o600) =>
    writeFile(auth(), content, { mode });
  const envelope = (over: object = {}) =>
    JSON.stringify({
      version: DEVKIT_AUTH_ENVELOPE_VERSION,
      provider: 'p',
      ciphertext: 'AAAA',
      ...over,
    });

  it('accepts no file, and a version 3 envelope', async () => {
    await expect(preflightAuthEnvelope(root)).resolves.toBeUndefined();
    await write(envelope());
    await expect(preflightAuthEnvelope(root)).resolves.toBeUndefined();
  });

  it.each([
    ['an older envelope version', envelope({ version: 2 })],
    ['the oldest envelope version', envelope({ version: 1 })],
    ['a newer envelope version', envelope({ version: 4 })],
    [
      'the stored-state version in its place',
      envelope({ version: DEVKIT_STORED_STATE_VERSION }),
    ],
    ['an envelope version given as text', envelope({ version: '3' })],
    ['no version', envelope({ version: undefined })],
    ['no provider', envelope({ provider: undefined })],
    ['no ciphertext', envelope({ ciphertext: undefined })],
    ['a ciphertext that is not text', envelope({ ciphertext: [1, 2] })],
    [
      'a plaintext legacy state',
      JSON.stringify({ version: 2, profiles: [], pendingRegistrations: [] }),
    ],
    ['text that is not JSON', 'not json at all'],
    ['an empty file', ''],
    ['a list', '[]'],
    ['null', 'null'],
  ])('refuses %s as devkit_incompatible', async (_name, content) => {
    await write(content);
    await expect(preflightAuthEnvelope(root)).rejects.toMatchObject({
      code: 'devkit_incompatible',
      status: 503,
    });
  });

  it('never modifies, migrates, or removes the file, whatever it finds', async () => {
    for (const content of [envelope(), envelope({ version: 2 }), '{{{', '[]']) {
      await write(content);
      const before = {
        bytes: await readFile(auth()),
        at: (await stat(auth())).mtimeMs,
      };
      await preflightAuthEnvelope(root).catch(() => undefined);
      expect((await readFile(auth())).equals(before.bytes)).toBe(true);
      expect((await stat(auth())).mtimeMs).toBe(before.at);
      expect(readdirSync(root)).toEqual([DEVKIT_LAYOUT.authFile]); // nothing created beside it
    }
  });

  it("does not echo the file's content in what it says", async () => {
    await write(
      envelope({
        version: 9,
        ciphertext: 'secret-ciphertext-value',
        provider: 'secret-provider',
      }),
    );
    const error = await preflightAuthEnvelope(root).catch((e) => e);
    const everything = `${error.message} ${JSON.stringify(error)}`;
    expect(everything).not.toContain('secret-ciphertext-value');
    expect(everything).not.toContain('secret-provider');
  });

  it("reads an envelope larger than the usual private-file limit, up to the DevKit's own", async () => {
    await write(envelope({ ciphertext: 'A'.repeat(200 * 1024) }));
    await expect(preflightAuthEnvelope(root)).resolves.toBeUndefined();
    await write(
      envelope({ ciphertext: 'A'.repeat(DEVKIT_LAYOUT.maxFileBytes) }),
    );
    await expect(preflightAuthEnvelope(root)).rejects.toBeDefined();
  });

  it('still refuses a file that is not owner-only', async () => {
    await write(envelope());
    await chmod(auth(), 0o644);
    await expect(preflightAuthEnvelope(root)).rejects.toMatchObject({
      code: 'state_dir_unsafe',
    });
  });
});

describe('the DevKit layout lives in one place', () => {
  it('knows the DevKit files by name, including its temporary ones', () => {
    expect(DEVKIT_LAYOUT.authFile).toBe('chatgpt-auth.json');
    expect(DEVKIT_LAYOUT.hostFile).toBe('chatgpt-host.json');
    expect(DEVKIT_LAYOUT.lockDirectory).toBe('.chatgpt-auth.lock');
    expect(DEVKIT_LAYOUT.isTemporaryFile('.chatgpt-auth.1234.tmp')).toBe(true);
    expect(DEVKIT_LAYOUT.isTemporaryFile('opendots-key.json')).toBe(false);
  });

  it('is the only place in the server code that spells those names', () => {
    const dir = new URL('../src/server/', import.meta.url).pathname;
    const spelled = readdirSync(dir)
      .filter((name) => name.endsWith('.ts') && name !== 'devkit-compat.ts')
      .filter((name) =>
        /['"`][^'"`\n]*(chatgpt-auth|chatgpt-host|\.chatgpt-auth\.lock)/.test(
          readFileSync(join(dir, name), 'utf8'),
        ),
      );
    expect(spelled).toEqual([]);
  });
});
