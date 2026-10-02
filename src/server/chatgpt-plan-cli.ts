import { rmdir } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createChatGPTPlanSession,
  inspectDevKit,
  type ChatGPTPlanSession,
  type DevKitInspection,
} from './chatgpt-devkit.js';
import { DEVKIT_LAYOUT } from './devkit-compat.js';
import { CredentialStoreError } from './credential-errors.js';
import {
  KeychainKeyBackend,
  defaultStateDir,
  inspectPersistentCredentials,
  resetPersistentCredentials,
  type KeyBackend,
} from './credential-keys.js';

// Recovery path for the Keychain-backed ChatGPT session while there is no UI:
//   npm run chatgpt-plan -- status | sign-out | reset [--yes]
// Output never includes keys, tokens, or credential contents.

export interface CliDeps {
  backend: KeyBackend;
  stateDir: string;
  devkitDist?: string;
  /** Refuse a DevKit build that is not recorded as verified. */
  devkitStrict?: boolean;
  inspectDevKit?: (dist: string) => Promise<DevKitInspection>;
  print(line: string): void;
  openSession?: (
    options: Parameters<typeof createChatGPTPlanSession>[0],
  ) => Promise<ChatGPTPlanSession>;
}

const yesNo = (value: boolean) => (value ? 'present' : 'absent');

function describeDevKit(found: DevKitInspection | undefined, strict?: boolean) {
  if (!found) return 'not configured (set CHATGPT_DEVKIT_DIST)';
  const mode = strict ? ' [strict mode]' : '';
  if (found.outcome === 'not_found')
    return 'not found: CHATGPT_DEVKIT_DIST must point to the built packages/local/dist';
  const info = found.compatibility;
  const name = info
    ? `${info.package ?? 'unknown package'} ${info.version ?? ''}`.trim()
    : '';
  if (found.outcome === 'incompatible')
    return `incompatible${name ? ` (${name})` : ''} - ${found.reason}${mode}`;
  return info?.compatibility === 'verified'
    ? `${name}, verified build (commit ${info.commit?.slice(0, 7)})${mode}`
    : `${name}, untested build (fingerprint ${info?.aggregate.slice(0, 8)}…); compatibility checks passed${mode}`;
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...flags] = argv;
  const { backend, stateDir, devkitDist, devkitStrict, print } = deps;
  const open = (deps.openSession ?? createChatGPTPlanSession).bind(null);
  const session = () =>
    open({
      devkitDist: devkitDist!,
      devkitStrict,
      credentialStore: 'keychain',
      stateDir,
      keyBackend: backend,
    });
  const inspection = () => inspectPersistentCredentials({ stateDir, backend });
  const inspect = (dist: string) =>
    (deps.inspectDevKit ?? ((d) => inspectDevKit(d, { strict: devkitStrict })))(
      dist,
    );

  if (command === 'status') {
    const found = await inspection();
    print('Credential store: macOS Keychain');
    print(
      `State directory:  ${found.stateDir}${found.stateDirExists ? '' : ' (not created)'}`,
    );
    print(
      `Files:            ${DEVKIT_LAYOUT.authFile} ${yesNo(found.files.auth)}, opendots-key.json ${yesNo(found.files.key)}`,
    );
    print(
      `Keychain item:    ${found.keychainItem}${found.keyIdPrefix ? ` (key id ${found.keyIdPrefix}…)` : ''}`,
    );
    const devkit = devkitDist ? await inspect(devkitDist) : undefined;
    print(`DevKit:           ${describeDevKit(devkit, devkitStrict)}`);
    if (found.problem) {
      print(
        `Problem:          ${found.problem} - ${new CredentialStoreError(found.problem).message}`,
      );
      return 1;
    }
    if (devkit && devkit.outcome !== 'ok') return 1;
    if (!found.files.auth) {
      print('Session:          no saved session');
      return 0;
    }
    if (!devkitDist) {
      print('Session:          not checked (set CHATGPT_DEVKIT_DIST)');
      return 0;
    }
    const opened = await session();
    try {
      const status = await opened.status();
      print(
        status.state === 'unavailable'
          ? `Session:          unavailable - ${status.failure.hint}`
          : `Session:          ${status.state === 'signed_in' ? 'signed in' : 'signed out'}`,
      );
      return status.state === 'unavailable' ? 1 : 0;
    } finally {
      await opened.close();
    }
  }

  if (command === 'devkit') {
    if (!devkitDist) {
      print('Set CHATGPT_DEVKIT_DIST to inspect a DevKit build.');
      return 1;
    }
    const found = await inspect(devkitDist);
    print(`DevKit: ${describeDevKit(found, devkitStrict)}`);
    if (found.compatibility)
      // The entry to add to VERIFIED_DEVKIT_BUILDS once the build has been
      // reviewed (docs/CHATGPT_PLAN.md). The commit cannot be read from a build.
      print(
        JSON.stringify(
          {
            commit: '<the upstream commit this build was made from>',
            package: found.compatibility.package,
            version: found.compatibility.version,
            files: found.compatibility.files,
            aggregate: found.compatibility.aggregate,
          },
          null,
          2,
        ),
      );
    return found.outcome === 'ok' ? 0 : 1;
  }

  if (command === 'sign-out') {
    const found = await inspection();
    if (found.problem) {
      print(
        `Cannot sign out: ${found.problem} - ${new CredentialStoreError(found.problem).message}`,
      );
      return 1;
    }
    if (!found.files.auth) {
      print('Nothing to sign out: no saved session.');
      return 0;
    }
    if (!devkitDist) {
      print('Set CHATGPT_DEVKIT_DIST to sign out.');
      return 1;
    }
    const opened = await session();
    try {
      const { revoked } = await opened.signOut();
      print(
        revoked
          ? 'Signed out. The saved tokens were revoked and cleared; the encryption key and registration are kept.'
          : 'Signed out locally, but remote revocation could not be confirmed. Disconnect OpenDots in ChatGPT Settings.',
      );
      return 0;
    } finally {
      await opened.close();
    }
  }

  if (command === 'reset') {
    const found = await inspection();
    const confirmed = flags.includes('--yes');
    print(
      `Reset removes the saved ChatGPT session in ${found.stateDir} and its Keychain item${found.keyIdPrefix ? ` (key id ${found.keyIdPrefix}…)` : ''}.`,
    );
    if (!confirmed) {
      print('Nothing was changed. Re-run with --yes to confirm.');
      return 2;
    }
    if (devkitDist && found.files.auth && !found.problem) {
      // Revoke while the key still works; if it cannot be done, say so.
      const opened = await session().catch(() => undefined);
      try {
        const result = await opened?.signOut();
        if (result && !result.revoked)
          print(
            'Remote revocation could not be confirmed. Disconnect OpenDots in ChatGPT Settings.',
          );
      } catch {
        print(
          'Could not revoke the saved session remotely. Disconnect OpenDots in ChatGPT Settings.',
        );
      } finally {
        await opened?.close();
      }
    } else if (found.files.auth) {
      print(
        'The saved session was not revoked remotely. Disconnect OpenDots in ChatGPT Settings.',
      );
    }
    const report = await resetPersistentCredentials({ stateDir, backend });
    // The default layout puts the state under an OpenDots folder of its own;
    // remove it too once nothing else lives there.
    if (basename(dirname(stateDir)) === 'OpenDots')
      await rmdir(dirname(stateDir)).catch(() => undefined);
    print(`Keychain item: ${report.keychainItem}`);
    if (report.keychainItem === 'unknown')
      print(
        'The key id could not be read, so an old Keychain item may remain. In Keychain Access, look for service "OpenDots ChatGPT plan credential key" and delete it.',
      );
    print(`Removed files: ${report.removed.join(', ') || 'none'}`);
    return 0;
  }

  print(
    'Usage: npm run chatgpt-plan -- status | sign-out | reset [--yes] | devkit',
  );
  return command ? 2 : 0;
}

async function main() {
  try {
    const code = await runCli(process.argv.slice(2), {
      backend: await KeychainKeyBackend.create(),
      stateDir: process.env.CHATGPT_STATE_DIR || defaultStateDir(),
      devkitDist: process.env.CHATGPT_DEVKIT_DIST || undefined,
      devkitStrict: process.env.CHATGPT_DEVKIT_STRICT === '1',
      print: (line) => console.log(line),
    });
    process.exitCode = code;
  } catch (error) {
    console.error(
      error instanceof CredentialStoreError
        ? `${error.code}: ${error.message}`
        : `Failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main();
