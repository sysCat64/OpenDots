import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Encrypts sign-in state with a random key that exists only in this process's
// memory. Nothing durable can decrypt the stored files, so a restart means
// signing in again. This is deliberately not a persistence mechanism; durable
// storage needs an OS-backed key (see docs/CHATGPT_PLAN.md).
export function ephemeralCredentialEncryption() {
  const key = randomBytes(32);
  return {
    id: 'opendots-ephemeral-aes-256-gcm-v1',
    isAvailable: () => true,
    encrypt(plaintext: string): Uint8Array {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const body = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
      ]);
      return Buffer.concat([nonce, cipher.getAuthTag(), body]);
    },
    decrypt(ciphertext: Uint8Array): string {
      const bytes = Buffer.from(ciphertext);
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        bytes.subarray(0, 12),
      );
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([
        decipher.update(bytes.subarray(28)),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}
