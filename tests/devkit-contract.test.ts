import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectDevKit, loadDevKit } from '../src/server/chatgpt-devkit.js';
import {
  DEVKIT_AUTH_ENVELOPE_VERSION,
  DEVKIT_LAYOUT,
  DEVKIT_REFRESH_WINDOW_MS,
  DEVKIT_STORED_STATE_VERSION,
  clientProblems,
  exportProblems,
  preflightAuthEnvelope,
  readStoredAccessToken,
} from '../src/server/devkit-compat.js';
import { sealedCredentialEncryption } from '../src/server/sealed-encryption.js';

vi.setConfig({ testTimeout: 30_000 });

// Runs against the real DevKit build, when one is present (CHATGPT_DEVKIT_DIST,
// or the sibling checkout). It pins every fact OpenDots relies on that the
// DevKit does not promise as public API. A failure here means the DevKit
// changed something OpenDots assumes: review it against docs/CHATGPT_PLAN.md
// before touching the test.
const dist = resolve(
  process.env.CHATGPT_DEVKIT_DIST ??
    '../sign-in-with-chatgpt-devkit/packages/local/dist',
);
const present = existsSync(join(dist, 'storage.js'));
const source = (file: string) => readFileSync(join(dist, file), 'utf8');

describe.skipIf(!present)('the real DevKit build', () => {
  it('loads and meets the runtime contract', async () => {
    const found = await inspectDevKit(dist);
    expect(found.outcome).toBe('ok');
    const devkit = await loadDevKit(dist);
    const main = await import(pathToFileURL(join(dist, 'index.js')).href);
    const storage = await import(pathToFileURL(join(dist, 'storage.js')).href);
    expect(exportProblems(main, storage)).toEqual([]);
    expect(devkit.info.package).toBe('@siwc/local');
  });

  it('is a recorded, verified build', async () => {
    const { info } = await loadDevKit(dist);
    expect(
      info.compatibility,
      `This DevKit build (${info.version}, fingerprint ${info.aggregate}) is not in VERIFIED_DEVKIT_BUILDS. ` +
        'It may still work (the runtime contract is what counts); review it and record it as described in docs/CHATGPT_PLAN.md.',
    ).toBe('verified');
  });

  describe('with a real encrypted round trip', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'devkit-contract-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    const encryption = () =>
      sealedCredentialEncryption({
        id: 'opendots-contract-test-v1',
        openKey: async () => ({ keyId: 'k', key: Buffer.alloc(32, 7) }),
      });
    const synthetic = {
      version: DEVKIT_STORED_STATE_VERSION,
      activeProfileId: 'p1',
      profiles: [
        {
          version: 1,
          id: 'p1',
          label: 'Contract test',
          clientId: 'client_contract',
          status: 'connected',
          scopes: ['chatgpt.tokens.use.direct'],
          savedAt: new Date().toISOString(),
          credentials: {
            accessToken: 'synthetic-access-token',
            expiresAt: Date.now() + 3_600_000,
          },
        },
      ],
      pendingRegistrations: [],
    };
    const openStore = async (enc = encryption()) => {
      const { ConnectionStore } = await import(
        pathToFileURL(join(dist, 'storage.js')).href
      );
      return { store: new ConnectionStore(dir, enc), enc };
    };

    it('writes the layout, envelope and stored state that OpenDots reads', async () => {
      const { store, enc } = await openStore();
      await store.withLock(() => store.write(synthetic));

      const file = join(dir, DEVKIT_LAYOUT.authFile);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const envelope = JSON.parse(readFileSync(file, 'utf8'));
      expect(envelope.version).toBe(DEVKIT_AUTH_ENVELOPE_VERSION);
      expect(envelope.provider).toBe(enc.id);
      expect(
        Buffer.from(envelope.ciphertext, 'base64').toString('base64'),
      ).toBe(envelope.ciphertext);
      await expect(preflightAuthEnvelope(dir)).resolves.toBeUndefined();

      // What the ciphertext decrypts to is a different format, with its own version.
      const decrypted = JSON.parse(
        await enc.decrypt(Buffer.from(envelope.ciphertext, 'base64')),
      );
      expect(decrypted.version).toBe(DEVKIT_STORED_STATE_VERSION);
      expect(DEVKIT_STORED_STATE_VERSION).not.toBe(envelope.version);

      const read = await store.withLock(() => store.read());
      expect(readStoredAccessToken(read)).toEqual({
        accessToken: 'synthetic-access-token',
        expiresAt: synthetic.profiles[0].credentials.expiresAt,
      });
    });

    it('names its lock and host files as OpenDots expects', async () => {
      const { store } = await openStore();
      await store.withLock(async () => {
        expect(existsSync(join(dir, DEVKIT_LAYOUT.lockDirectory))).toBe(true);
        await store.getHostId();
      });
      expect(existsSync(join(dir, DEVKIT_LAYOUT.hostFile))).toBe(true);
      expect(existsSync(join(dir, DEVKIT_LAYOUT.lockDirectory))).toBe(false);
    });

    it('is not a format OpenDots would let the DevKit migrate', async () => {
      const { store } = await openStore();
      await store.withLock(() => store.write(synthetic));
      const file = join(dir, DEVKIT_LAYOUT.authFile);
      const envelope = JSON.parse(await readFile(file, 'utf8'));
      await writeFile(
        file,
        JSON.stringify({
          ...envelope,
          version: DEVKIT_AUTH_ENVELOPE_VERSION + 1,
        }),
        { mode: 0o600 },
      );
      await expect(preflightAuthEnvelope(dir)).rejects.toMatchObject({
        code: 'devkit_incompatible',
      });
    });

    it('provides a client with the methods OpenDots calls', async () => {
      const { createChatGPT } = await import(
        pathToFileURL(join(dist, 'index.js')).href
      );
      const client = createChatGPT({
        appName: 'contract',
        appId: 'opendots-contract',
        redirectPort: 0,
        storageDir: dir,
        credentialEncryption: encryption(),
      });
      expect(clientProblems(client)).toEqual([]);
    });
  });

  // Behaviour OpenDots depends on, read from the build itself. Each pattern is a
  // fact from docs/CHATGPT_PLAN.md; if one stops matching, the assumption is
  // gone and needs a deliberate decision.
  describe('facts about the build that OpenDots assumes', () => {
    it('refreshes a token when 60 seconds or less remain (OpenDots asks only inside that window)', () => {
      expect(DEVKIT_REFRESH_WINDOW_MS).toBe(60_000);
      expect(source('index.js')).toMatch(
        /credentials\.expiresAt\s*<=\s*Date\.now\(\)\s*\+\s*60_000/,
      );
    });

    it('does the refresh inside authenticated requests such as listModels()', () => {
      expect(source('index.js')).toMatch(
        /async listModels\([^)]*\)\s*\{\s*return authenticated\(listModels/,
      );
    });

    it('stores expiresAt as a millisecond timestamp', () => {
      expect(source('oauth.js')).toMatch(
        /expiresAt:\s*Date\.now\(\)\s*\+\s*data\.expires_in\s*\*\s*1000/,
      );
    });

    it('writes envelope version 3 and reads stored-state version 2', () => {
      expect(DEVKIT_AUTH_ENVELOPE_VERSION).toBe(3);
      expect(DEVKIT_STORED_STATE_VERSION).toBe(2);
      expect(source('storage.js')).toMatch(
        /version:\s*3,\s*provider:\s*this\.#encryption\.id/,
      );
      expect(source('storage.js')).toMatch(/value\.version\s*!==\s*2/);
    });

    it('keeps the file names OpenDots manages around', () => {
      const storage = source('storage.js');
      for (const name of [
        DEVKIT_LAYOUT.authFile,
        DEVKIT_LAYOUT.hostFile,
        DEVKIT_LAYOUT.lockDirectory,
      ])
        expect(storage).toContain(`"${name}"`);
    });

    it('lists only models with visibility "list", as a list under `models`, slugs up to 200 characters', () => {
      const models = source('models.js');
      expect(models).toMatch(/Array\.isArray\(body\.models\)/);
      expect(models).toMatch(/model\.visibility\s*!==\s*"list"/);
      expect(models).toMatch(/model\.slug\.length\s*>\s*200/);
      expect(models).toMatch(/invalid_model_catalog/);
    });

    it('signals a failed revocation and a cancelled operation with the codes OpenDots recognises', () => {
      const everything = ['index.js', 'errors.js', 'oauth.js']
        .map(source)
        .join('\n');
      expect(everything).toContain('"revocation_failed"');
      expect(everything).toContain('"cancelled"');
    });
  });
});
