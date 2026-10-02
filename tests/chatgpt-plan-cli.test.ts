import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliDeps } from '../src/server/chatgpt-plan-cli.js';
import type { DevKitInspection } from '../src/server/chatgpt-devkit.js';
import { openPersistentKey } from '../src/server/credential-keys.js';
import { FakeBackend } from './fixtures/key-backend.js';

// These tests do real filesystem and process work; leave headroom on a loaded machine.
vi.setConfig({ testTimeout: 20_000 });

let stateDir: string;
let backend: FakeBackend;
let lines: string[];
let session: {
  status: ReturnType<typeof vi.fn>;
  signOut: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};
beforeEach(async () => {
  stateDir = join(await mkdtemp(join(tmpdir(), 'cli-')), 'state');
  backend = new FakeBackend();
  lines = [];
  session = {
    status: vi.fn(async () => ({ state: 'signed_in' })),
    signOut: vi.fn(async () => ({ revoked: true })),
    close: vi.fn(async () => undefined),
  };
});
afterEach(async () => {
  await rm(join(stateDir, '..'), { recursive: true, force: true });
});
const verified: DevKitInspection = {
  outcome: 'ok',
  compatibility: {
    compatibility: 'verified',
    package: '@siwc/local',
    version: '0.1.0',
    commit: 'f723814abdccec135b519c451fb6e1992ee5e933',
    aggregate: 'ab'.repeat(32),
    files: { 'index.js': 'cd'.repeat(32) },
  },
};
const deps = (extra: Partial<CliDeps> = {}): CliDeps => ({
  inspectDevKit: async () => verified,
  backend,
  stateDir,
  devkitDist: '/devkit',
  print: (line) => lines.push(line),
  openSession: async () => session as never,
  ...extra,
});
const saveSession = async () => {
  await openPersistentKey({ stateDir, backend });
  await writeFile(join(stateDir, 'chatgpt-auth.json'), '{}', { mode: 0o600 });
};
const output = () => lines.join('\n');

it('status reports a pristine system without creating anything', async () => {
  expect(await runCli(['status'], deps())).toBe(0);
  expect(output()).toMatch(/no saved session/);
  expect(output()).toMatch(/not created/);
  expect(existsSync(stateDir)).toBe(false);
  expect(backend.sets).toBe(0);
});

it('status shows the saved session, and never a key or token', async () => {
  await saveSession();
  expect(await runCli(['status'], deps())).toBe(0);
  expect(output()).toMatch(/Keychain item:\s+present \(key id [0-9a-f]{8}…\)/);
  expect(output()).toMatch(/signed in/);
  const key = [...backend.keys.values()][0];
  expect(output()).not.toContain(key.toString('base64'));
  expect(output()).not.toContain(key.toString('hex'));
  expect(session.close).toHaveBeenCalled();
});

it('status exits non-zero with recovery guidance when the key is missing', async () => {
  await saveSession();
  backend.keys.clear();
  expect(await runCli(['status'], deps())).toBe(1);
  expect(output()).toMatch(/credential_key_missing/);
  expect(output()).toMatch(/chatgpt-plan -- reset --yes/);
  expect(session.status).not.toHaveBeenCalled();
});

it('status surfaces an unavailable session', async () => {
  await saveSession();
  session.status.mockResolvedValue({
    state: 'unavailable',
    failure: { code: 'keychain_unavailable', hint: 'Unlock the Keychain.' },
  });
  expect(await runCli(['status'], deps())).toBe(1);
  expect(output()).toMatch(/unavailable - Unlock the Keychain\./);
});

it('sign-out revokes and keeps the key and registration', async () => {
  await saveSession();
  expect(await runCli(['sign-out'], deps())).toBe(0);
  expect(session.signOut).toHaveBeenCalledTimes(1);
  expect(backend.deletes).toBe(0);
  expect(existsSync(join(stateDir, 'opendots-key.json'))).toBe(true);
  expect(output()).toMatch(/Signed out/);
});

it('sign-out says when revocation could not be confirmed', async () => {
  await saveSession();
  session.signOut.mockResolvedValue({ revoked: false });
  expect(await runCli(['sign-out'], deps())).toBe(0);
  expect(output()).toMatch(/Disconnect OpenDots in ChatGPT Settings/);
});

it('sign-out with nothing saved does nothing', async () => {
  expect(await runCli(['sign-out'], deps())).toBe(0);
  expect(output()).toMatch(/Nothing to sign out/);
  expect(session.signOut).not.toHaveBeenCalled();
});

it('reset without --yes changes nothing', async () => {
  await saveSession();
  expect(await runCli(['reset'], deps())).toBe(2);
  expect(output()).toMatch(/Nothing was changed/);
  expect(backend.keys.size).toBe(1);
  expect(existsSync(join(stateDir, 'chatgpt-auth.json'))).toBe(true);
  expect(session.signOut).not.toHaveBeenCalled();
});

it('reset --yes revokes, then removes the files and the Keychain item', async () => {
  await saveSession();
  expect(await runCli(['reset', '--yes'], deps())).toBe(0);
  expect(session.signOut).toHaveBeenCalledTimes(1);
  expect(backend.keys.size).toBe(0);
  expect(existsSync(stateDir)).toBe(false);
  expect(output()).toMatch(/Keychain item: deleted/);
  expect(output()).not.toMatch(/Keychain Access/);
  // Repeatable.
  expect(await runCli(['reset', '--yes'], deps())).toBe(0);
});

it('reset --yes still works when the key is gone, and says it could not revoke', async () => {
  await saveSession();
  backend.keys.clear();
  expect(await runCli(['reset', '--yes'], deps())).toBe(0);
  expect(session.signOut).not.toHaveBeenCalled();
  expect(output()).toMatch(/not revoked remotely/);
  expect(existsSync(stateDir)).toBe(false);
});

it('reset --yes completes even if revocation fails', async () => {
  await saveSession();
  session.signOut.mockRejectedValue(new Error('network'));
  expect(await runCli(['reset', '--yes'], deps())).toBe(0);
  expect(output()).toMatch(/Could not revoke/);
  expect(await readdir(join(stateDir, '..'))).toEqual([]);
});

it('reset points to Keychain Access when the key id is unknown and an item may remain', async () => {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(join(stateDir, 'chatgpt-auth.json'), '{}', { mode: 0o600 });
  expect(await runCli(['reset', '--yes'], deps())).toBe(0);
  expect(output()).toMatch(/Keychain item: unknown/);
  expect(output()).toMatch(/Keychain Access/);
  expect(output()).toMatch(/OpenDots ChatGPT plan credential key/);
  expect(existsSync(join(stateDir, 'chatgpt-auth.json'))).toBe(false);
});

it('reset also removes an empty OpenDots parent folder, but never a non-empty one', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cli-home-'));
  try {
    for (const [name, keep] of [
      ['empty', false],
      ['shared', true],
    ] as const) {
      const dir = join(home, name, 'OpenDots', 'chatgpt-plan');
      await openPersistentKey({ stateDir: dir, backend });
      if (keep)
        await writeFile(join(home, name, 'OpenDots', 'other.txt'), 'keep');
      expect(await runCli(['reset', '--yes'], deps({ stateDir: dir }))).toBe(0);
      expect(existsSync(dir)).toBe(false);
      expect(existsSync(join(home, name, 'OpenDots'))).toBe(keep);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it('prints usage for an unknown command', async () => {
  expect(await runCli(['frobnicate'], deps())).toBe(2);
  expect(output()).toMatch(/Usage/);
});

describe('DevKit compatibility in status', () => {
  const inspecting = (found: DevKitInspection) =>
    deps({ inspectDevKit: async () => found });

  it('names a verified build and its commit, and adds nothing alarming', async () => {
    expect(await runCli(['status'], deps())).toBe(0);
    expect(output()).toMatch(
      /DevKit:\s+@siwc\/local 0\.1\.0, verified build \(commit f723814\)/,
    );
    expect(output()).not.toMatch(/untested|incompatible/);
  });

  it('shows an untested build as such, still usable', async () => {
    const found: DevKitInspection = {
      outcome: 'ok',
      compatibility: {
        ...verified.compatibility!,
        compatibility: 'untested',
        commit: undefined,
      },
    };
    expect(await runCli(['status'], inspecting(found))).toBe(0);
    expect(output()).toMatch(
      /untested build \(fingerprint abababab…\); compatibility checks passed/,
    );
  });

  it('shows strict mode refusing an unrecorded build, and stops there', async () => {
    const found: DevKitInspection = {
      outcome: 'incompatible',
      compatibility: {
        ...verified.compatibility!,
        compatibility: 'untested',
        commit: undefined,
      },
      reason: 'strict mode refuses a build that is not recorded as verified',
    };
    await saveSession();
    expect(
      await runCli(['status'], { ...inspecting(found), devkitStrict: true }),
    ).toBe(1);
    expect(output()).toMatch(
      /incompatible \(@siwc\/local 0\.1\.0\) - strict mode refuses .* \[strict mode\]/,
    );
    expect(session.status).not.toHaveBeenCalled(); // no session is opened on a refused build
  });

  it('reports a contract violation with its reason', async () => {
    expect(
      await runCli(
        ['status'],
        inspecting({
          outcome: 'incompatible',
          reason: 'ConnectionStore.read is missing',
        }),
      ),
    ).toBe(1);
    expect(output()).toMatch(
      /DevKit:\s+incompatible - ConnectionStore\.read is missing/,
    );
  });

  it('says plainly when the path is wrong or unset', async () => {
    expect(await runCli(['status'], inspecting({ outcome: 'not_found' }))).toBe(
      1,
    );
    expect(output()).toMatch(/not found: CHATGPT_DEVKIT_DIST must point/);
    lines.length = 0;
    expect(await runCli(['status'], deps({ devkitDist: undefined }))).toBe(0);
    expect(output()).toMatch(/not configured \(set CHATGPT_DEVKIT_DIST\)/);
  });

  it('prints the table entry for a build, to record it after review', async () => {
    expect(await runCli(['devkit'], deps())).toBe(0);
    const entry = JSON.parse(lines.slice(1).join('\n'));
    expect(entry).toMatchObject({
      package: '@siwc/local',
      version: '0.1.0',
      aggregate: 'ab'.repeat(32),
      files: { 'index.js': 'cd'.repeat(32) },
    });
    expect(entry.commit).toMatch(/upstream commit/); // cannot be read from a build
  });

  it('refuses to print an entry when there is nothing to inspect', async () => {
    expect(await runCli(['devkit'], deps({ devkitDist: undefined }))).toBe(1);
  });
});
