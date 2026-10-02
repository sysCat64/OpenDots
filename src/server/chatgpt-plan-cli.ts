import { rmdir } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createChatGPTPlanSession,
  type ChatGPTPlanSession,
} from './chatgpt-devkit.js';
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
  print(line: string): void;
  openSession?: (
    options: Parameters<typeof createChatGPTPlanSession>[0],
  ) => Promise<ChatGPTPlanSession>;
}

const yesNo = (value: boolean) => (value ? 'present' : 'absent');

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...flags] = argv;
  const { backend, stateDir, devkitDist, print } = deps;
  const open = (deps.openSession ?? createChatGPTPlanSession).bind(null);
  const session = () =>
    open({
      devkitDist: devkitDist!,
      credentialStore: 'keychain',
      stateDir,
      keyBackend: backend,
    });
  const inspection = () => inspectPersistentCredentials({ stateDir, backend });

  if (command === 'status') {
    const found = await inspection();
    print('Credential store: macOS Keychain');
    print(
      `State directory:  ${found.stateDir}${found.stateDirExists ? '' : ' (not created)'}`,
    );
    print(
      `Files:            chatgpt-auth.json ${yesNo(found.files.auth)}, opendots-key.json ${yesNo(found.files.key)}`,
    );
    print(
      `Keychain item:    ${found.keychainItem}${found.keyIdPrefix ? ` (key id ${found.keyIdPrefix}…)` : ''}`,
    );
    if (found.problem) {
      print(
        `Problem:          ${found.problem} - ${new CredentialStoreError(found.problem).message}`,
      );
      return 1;
    }
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

  print('Usage: npm run chatgpt-plan -- status | sign-out | reset [--yes]');
  return command ? 2 : 0;
}

async function main() {
  try {
    const code = await runCli(process.argv.slice(2), {
      backend: await KeychainKeyBackend.create(),
      stateDir: process.env.CHATGPT_STATE_DIR || defaultStateDir(),
      devkitDist: process.env.CHATGPT_DEVKIT_DIST || undefined,
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
