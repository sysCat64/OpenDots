import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  CredentialStoreError,
  type CredentialStoreErrorCode,
} from './credential-errors.js';

// The DevKit's CredentialEncryption contract, implemented once for every key
// source. Envelope: [version][nonce][tag][ciphertext], AES-256-GCM, with the
// provider id and key id bound in as associated data so ciphertext can neither
// be replayed under another provider nor decrypted with the wrong key.

const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface SealedKey {
  keyId: string;
  key: Buffer;
}

export interface SealedEncryptionOptions {
  /** Stable id the DevKit records in the file; a different id will not open it. */
  id: string;
  openKey(): Promise<SealedKey>;
  /** Called with a failure code, or undefined once things work again. */
  onFailure?(code: CredentialStoreErrorCode | undefined): void;
  /** How long a failed key lookup is remembered before trying again. */
  retryAfterMs?: number;
  now?: () => number;
}

export function sealedCredentialEncryption(options: SealedEncryptionOptions) {
  const { id, openKey, onFailure, retryAfterMs = 3_000 } = options;
  const now = options.now ?? Date.now;
  let cached: SealedKey | undefined;
  let failure: { at: number; error: CredentialStoreError } | undefined;
  let loading: Promise<SealedKey> | undefined;
  let closed = false;

  // The DevKit asks isAvailable() before every read and write: the key is
  // loaded once and kept in memory (as the tokens are), and a failed lookup is
  // not retried for a few seconds so a locked Keychain is not hammered.
  const key = async (): Promise<SealedKey> => {
    if (closed) throw new CredentialStoreError('keychain_unavailable');
    if (cached) return cached;
    if (failure && now() - failure.at < retryAfterMs) throw failure.error;
    loading ??= openKey()
      .then(
        (opened) => {
          cached = opened;
          failure = undefined;
          onFailure?.(undefined);
          return opened;
        },
        (cause: unknown) => {
          const error =
            cause instanceof CredentialStoreError
              ? cause
              : new CredentialStoreError('keychain_unavailable', { cause });
          failure = { at: now(), error };
          onFailure?.(error.code);
          throw error;
        },
      )
      .finally(() => {
        loading = undefined;
      });
    return loading;
  };
  const aad = (keyId: string) => Buffer.from(`opendots:${id}:${keyId}`);

  return {
    id,
    async isAvailable() {
      try {
        await key();
        return true;
      } catch {
        return false;
      }
    },
    async encrypt(plaintext: string): Promise<Uint8Array> {
      const { key: secret, keyId } = await key();
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', secret, nonce);
      cipher.setAAD(aad(keyId));
      const body = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
      ]);
      return Buffer.concat([
        Buffer.from([VERSION]),
        nonce,
        cipher.getAuthTag(),
        body,
      ]);
    },
    async decrypt(ciphertext: Uint8Array): Promise<string> {
      const { key: secret, keyId } = await key();
      const bytes = Buffer.from(ciphertext);
      const header = 1 + NONCE_BYTES + TAG_BYTES;
      try {
        if (bytes.length < header || bytes[0] !== VERSION)
          throw new Error('unsupported envelope');
        const decipher = createDecipheriv(
          'aes-256-gcm',
          secret,
          bytes.subarray(1, 1 + NONCE_BYTES),
        );
        decipher.setAAD(aad(keyId));
        decipher.setAuthTag(bytes.subarray(1 + NONCE_BYTES, header));
        const plaintext = Buffer.concat([
          decipher.update(bytes.subarray(header)),
          decipher.final(),
        ]).toString('utf8');
        onFailure?.(undefined);
        return plaintext;
      } catch {
        onFailure?.('credential_ciphertext_invalid');
        throw new CredentialStoreError('credential_ciphertext_invalid');
      }
    },
    /** Wipes the in-memory key. Stored credentials and the Keychain are untouched. */
    close() {
      closed = true;
      cached?.key.fill(0);
      cached = undefined;
    },
  };
}

// Ephemeral mode: a key that exists only in this process.
export function memoryKeySource(): () => Promise<SealedKey> {
  const opened = { keyId: 'ephemeral', key: randomBytes(32) };
  return async () => opened;
}
