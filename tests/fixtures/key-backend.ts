import type { KeyBackend } from '../../src/server/credential-keys.js';

// An in-memory stand-in for the Keychain that records what was done to it.
export class FakeBackend implements KeyBackend {
  keys = new Map<string, Buffer>();
  sets = 0;
  deletes = 0;
  failing = false;
  onDelete?: () => void | Promise<void>;
  async get(account: string) {
    if (this.failing) throw new Error('locked');
    return this.keys.get(account);
  }
  async set(account: string, key: Buffer) {
    if (this.failing) throw new Error('locked');
    this.sets += 1;
    this.keys.set(account, Buffer.from(key));
  }
  async delete(account: string) {
    await this.onDelete?.();
    this.deletes += 1;
    return this.keys.delete(account);
  }
}
