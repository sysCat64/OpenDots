export type CredentialStoreErrorCode =
  | 'keychain_unavailable'
  | 'credential_key_missing'
  | 'credential_key_invalid'
  | 'credential_ciphertext_invalid'
  | 'state_dir_unsafe'
  | 'unsupported_platform'
  | 'native_module_missing'
  | 'lock_timeout';

const RESET = 'npm run chatgpt-plan -- reset --yes';

// Owner-facing recovery text per failure. None of it carries credential
// material; the underlying error, when any, stays on `cause` and is never
// printed.
const hints: Record<CredentialStoreErrorCode, string> = {
  keychain_unavailable:
    'The macOS Keychain is locked or unavailable. Unlock it and try again; saved credentials are untouched.',
  credential_key_missing: `The encryption key for the saved ChatGPT session is missing from the Keychain. Run "${RESET}" and sign in again.`,
  credential_key_invalid: `The stored encryption key is damaged. Run "${RESET}" and sign in again.`,
  credential_ciphertext_invalid: `The saved ChatGPT session could not be decrypted. Run "${RESET}" and sign in again.`,
  state_dir_unsafe:
    'The ChatGPT state directory and its files must be private (owner-only) and owned by you.',
  unsupported_platform:
    'Keychain credential storage is available on macOS only.',
  native_module_missing:
    'Install the optional @napi-rs/keyring dependency to use CHATGPT_CREDENTIAL_STORE=keychain.',
  lock_timeout:
    'Another OpenDots process is initializing credential storage. Try again shortly. If none is running, delete .opendots-key.lock in the state directory.',
};

export const credentialFailureHint = (code: CredentialStoreErrorCode) =>
  hints[code];

export class CredentialStoreError extends Error {
  constructor(
    readonly code: CredentialStoreErrorCode,
    options?: { cause?: unknown },
  ) {
    super(hints[code], options);
    this.name = 'CredentialStoreError';
  }
}
