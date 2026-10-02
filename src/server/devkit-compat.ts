import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ChatGPTPlanError } from './chatgpt-plan.js';
import { readPrivateFile } from './private-fs.js';

// Everything OpenDots assumes about the Sign in with ChatGPT DevKit that the
// DevKit does not promise as public API. Kept in one place so an update can be
// reviewed against one file, and so nothing else hardcodes DevKit internals.
//
// Compatibility is decided by what the DevKit actually does (its runtime
// contract), never by a version number or a hash alone:
//   - a contract violation            -> devkit_incompatible (refused)
//   - contract holds + recorded build -> verified
//   - contract holds + unknown build  -> untested (allowed, and shown)
// Strict mode (CHATGPT_DEVKIT_STRICT=1) also refuses untested builds.

// Two different formats, deliberately named apart. "Envelope" is the outer JSON
// in chatgpt-auth.json that holds the ciphertext; "stored state" is what the
// ciphertext decrypts to. Neither is the DevKit's package version.
export const DEVKIT_AUTH_ENVELOPE_VERSION = 3;
export const DEVKIT_STORED_STATE_VERSION = 2;

export const DEVKIT_PACKAGE = '@siwc/local';

// The DevKit's on-disk layout inside its storage directory.
export const DEVKIT_LAYOUT = {
  authFile: 'chatgpt-auth.json',
  hostFile: 'chatgpt-host.json',
  lockDirectory: '.chatgpt-auth.lock',
  isTemporaryFile: (name: string) => /^\.chatgpt-auth\..*\.tmp$/.test(name),
  /** The DevKit refuses larger files, so none is ever valid. */
  maxFileBytes: 2 * 1024 * 1024,
} as const;

const PROFILE_STATUSES = ['connected', 'disconnected', 'reauth_required'];

// Observed behaviour: the DevKit refreshes an access token when 60 s or less
// remain. We ask for a refresh only inside that window (asking earlier would be
// a call the DevKit ignores), and accept the result only if it leaves this much.
export const DEVKIT_REFRESH_WINDOW_MS = 60_000;
export const MIN_VALID_TOKEN_MS = 30_000;

// An epoch in milliseconds is about 1.7e12 today; seconds would be 1.7e9 and
// microseconds 1.7e15. Anything outside this range is not milliseconds.
const MIN_EPOCH_MS = 1e12;
const MAX_EPOCH_MS = 1e14;

export class DevKitIncompatibleError extends ChatGPTPlanError {
  constructor(readonly reason: string) {
    super(
      'devkit_incompatible',
      `This Sign in with ChatGPT DevKit is not supported by this OpenDots (${reason}). Use the tested build described in docs/CHATGPT_PLAN.md, or update OpenDots.`,
      503,
    );
    this.name = 'DevKitIncompatibleError';
  }
}

// --- builds -----------------------------------------------------------------

// The runtime files whose behaviour OpenDots relies on, in the order they are
// hashed. Procedure: SHA-256 each file's bytes; the aggregate is the SHA-256 of
// the lines "<name>:<hex>\n" in this order.
export const DEVKIT_FINGERPRINT_FILES = [
  'index.js',
  'storage.js',
  'oauth.js',
  'models.js',
  'errors.js',
] as const;

export interface DevKitBuild {
  commit: string;
  package: string;
  version: string;
  files: Record<(typeof DEVKIT_FINGERPRINT_FILES)[number], string>;
  aggregate: string;
}

// Builds that the contract tests and a real-account run were done against.
export const VERIFIED_DEVKIT_BUILDS: DevKitBuild[] = [
  {
    commit: 'f723814abdccec135b519c451fb6e1992ee5e933',
    package: DEVKIT_PACKAGE,
    version: '0.1.0',
    files: {
      'index.js':
        '36d3ede094102d6d8aa2376e91dbb8f6a888039d4363ab876b51f46515e68e97',
      'storage.js':
        '20d762e04825a09f6cee76a7ce083cd0e61639b13526ef9261f3d7fbeaaf2058',
      'oauth.js':
        '7541d71f7e02ae51a4f0d3cc8c51e9f3a7fb71734fb73ed2e6804bd39ed6db0c',
      'models.js':
        '55d1a407f971fdae41ab8649be91c840b7938ed03fc379c69471c069b6a40157',
      'errors.js':
        '0573510815128fc33a148769d9a3619dc490db2198a74d33e60014f5558663f1',
    },
    aggregate:
      '66752b92d315e4dcb2ded1c8868d1aaf0e60b71b5463ac602fdae2d536ed0708',
  },
];

export interface DevKitCompatibility {
  compatibility: 'verified' | 'untested';
  package?: string;
  version?: string;
  /** The recorded upstream commit, only for a verified build. */
  commit?: string;
  aggregate: string;
  files: Record<string, string>;
}

const sha256 = (data: Buffer | string) =>
  createHash('sha256').update(data).digest('hex');

export async function fingerprintDevKit(dist: string) {
  const files: Record<string, string> = {};
  for (const name of DEVKIT_FINGERPRINT_FILES)
    files[name] = await readFile(join(dist, name)).then(
      sha256,
      () => 'missing',
    );
  const aggregate = sha256(
    DEVKIT_FINGERPRINT_FILES.map((name) => `${name}:${files[name]}\n`).join(''),
  );
  return { files, aggregate };
}

async function readPackage(dist: string) {
  try {
    const parsed = JSON.parse(
      await readFile(join(dist, '..', 'package.json'), 'utf8'),
    ) as { name?: unknown; version?: unknown };
    return {
      name: typeof parsed.name === 'string' ? parsed.name : undefined,
      version: typeof parsed.version === 'string' ? parsed.version : undefined,
    };
  } catch {
    return {}; // not next to the dist (a copied build): nothing to compare
  }
}

/**
 * Identifies the build. A build that is not in the table is "untested", not
 * broken: the runtime contract is what decides whether it can be used.
 */
export async function assessDevKit(
  dist: string,
  options: { strict?: boolean } = {},
): Promise<DevKitCompatibility> {
  const pkg = await readPackage(dist);
  if (pkg.name !== undefined && pkg.name !== DEVKIT_PACKAGE)
    throw new DevKitIncompatibleError('this is not the @siwc/local package');
  const { files, aggregate } = await fingerprintDevKit(dist);
  const known = VERIFIED_DEVKIT_BUILDS.find((b) => b.aggregate === aggregate);
  if (!known && options.strict)
    throw new DevKitIncompatibleError(
      'strict mode refuses a build that is not recorded as verified',
    );
  return {
    compatibility: known ? 'verified' : 'untested',
    package: pkg.name,
    version: pkg.version,
    ...(known ? { commit: known.commit } : {}),
    aggregate,
    files,
  };
}

// --- runtime contract: shape of the DevKit's exports and client -------------

const isFunction = (value: unknown) => typeof value === 'function';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function exportProblems(main: unknown, storage: unknown): string[] {
  const problems: string[] = [];
  if (!isFunction((main as Record<string, unknown>)?.createChatGPT))
    problems.push('createChatGPT is missing');
  const store = (storage as Record<string, unknown>)?.ConnectionStore;
  if (!isFunction(store)) problems.push('ConnectionStore is missing');
  else {
    const proto = (store as { prototype?: Record<string, unknown> }).prototype;
    for (const method of ['read', 'withLock'])
      if (!isFunction(proto?.[method]))
        problems.push(`ConnectionStore.${method} is missing`);
  }
  return problems;
}

export const CLIENT_METHODS = [
  'signIn',
  'getSession',
  'listProfiles',
  'listModels',
  'disconnect',
] as const;

export function clientProblems(client: unknown): string[] {
  return CLIENT_METHODS.filter(
    (name) => !isFunction((client as Record<string, unknown>)?.[name]),
  ).map((name) => `client.${name} is missing`);
}

// --- stored state: the minimum OpenDots needs from it ------------------------

export interface StoredAccessToken {
  accessToken: string;
  expiresAt: number;
}

/**
 * Reads the active profile's access token out of what the DevKit's store
 * returned, checking only the minimum shape that is relied on.
 *
 * - no saved state, no active profile, or an active profile whose status is
 *   disconnected or reauth_required (such a profile keeps no credentials): a
 *   valid "not signed in" -> undefined.
 * - a connected profile must have valid credentials; one without them is a
 *   contract violation, like anything else that does not look as expected:
 *   DevKitIncompatibleError. It is never turned into undefined, because that
 *   would show up as a false sign-out.
 * Messages name the field and the expectation, never a value.
 */
export function readStoredAccessToken(
  state: unknown,
): StoredAccessToken | undefined {
  if (state === undefined) return undefined;
  if (!isRecord(state))
    throw new DevKitIncompatibleError('the stored state is not an object');
  if (state.version !== DEVKIT_STORED_STATE_VERSION)
    throw new DevKitIncompatibleError(
      `the stored state version is not ${DEVKIT_STORED_STATE_VERSION}`,
    );
  if (!Array.isArray(state.profiles))
    throw new DevKitIncompatibleError('stored state: profiles is not a list');
  if (state.activeProfileId === undefined) return undefined;
  if (typeof state.activeProfileId !== 'string')
    throw new DevKitIncompatibleError(
      'stored state: the active profile id is not text',
    );
  const profile = state.profiles.find(
    (entry) => isRecord(entry) && entry.id === state.activeProfileId,
  );
  if (!isRecord(profile))
    throw new DevKitIncompatibleError(
      'stored state: the active profile is not in the profile list',
    );
  if (
    typeof profile.status !== 'string' ||
    !PROFILE_STATUSES.includes(profile.status)
  )
    throw new DevKitIncompatibleError(
      'stored state: the active profile has an unknown status',
    );
  // A disconnected or re-authorize profile keeps no credentials: a valid "not
  // signed in". A connected one without them is not something the DevKit's
  // stored-state contract allows.
  if (profile.status !== 'connected') return undefined;
  if (!isRecord(profile.credentials))
    throw new DevKitIncompatibleError(
      'stored state: a connected profile has no credentials object',
    );
  const { accessToken, expiresAt } = profile.credentials;
  if (typeof accessToken !== 'string' || !accessToken)
    throw new DevKitIncompatibleError(
      'stored state: the access token is missing or not text',
    );
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt))
    throw new DevKitIncompatibleError(
      'stored state: expiresAt is not a finite number',
    );
  if (expiresAt < MIN_EPOCH_MS || expiresAt > MAX_EPOCH_MS)
    throw new DevKitIncompatibleError(
      'stored state: expiresAt is not a millisecond timestamp',
    );
  return { accessToken, expiresAt };
}

// Where OpenDots gets the access token. Today only the DevKit's stored state
// (an internal format) can supply it. If the DevKit ever offers a public way to
// get a token or an authorized fetch, that becomes a second implementation of
// this interface and the stored-state one is removed (docs/CHATGPT_PLAN.md).
export interface TokenSource {
  /** Undefined when not signed in. Throws DevKitIncompatibleError on an unsupported shape. */
  read(): Promise<StoredAccessToken | undefined>;
}

export function storedStateTokenSource(store: {
  withLock<T>(operation: () => Promise<T>): Promise<T>;
  read(): Promise<unknown>;
}): TokenSource {
  return {
    read: async () =>
      readStoredAccessToken(await store.withLock(() => store.read())),
  };
}

// --- the auth envelope, before the DevKit sees it ----------------------------

/**
 * Looks at the plain outer envelope of the saved session, and nothing else, so
 * an unrecognised format never reaches the DevKit's read(), which migrates and
 * rewrites formats it knows. Nothing is decrypted, written, or removed.
 * A missing file is fine (nothing saved yet).
 */
export async function preflightAuthEnvelope(stateDir: string) {
  const text = await readPrivateFile(
    join(stateDir, DEVKIT_LAYOUT.authFile),
    DEVKIT_LAYOUT.maxFileBytes,
  );
  if (text === undefined) return;
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new DevKitIncompatibleError(
      'the saved session file is not in a recognized format',
    );
  }
  if (
    !isRecord(envelope) ||
    envelope.version !== DEVKIT_AUTH_ENVELOPE_VERSION ||
    typeof envelope.provider !== 'string' ||
    typeof envelope.ciphertext !== 'string'
  )
    throw new DevKitIncompatibleError(
      `the saved session file is not a version ${DEVKIT_AUTH_ENVELOPE_VERSION} envelope`,
    );
}
