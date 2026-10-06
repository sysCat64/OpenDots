import { describe, expect, it } from 'vitest';
import { requireOwnerToken } from '../src/server/startup-config';

// The owner token is the only credential in front of the owner's conversations,
// so the server must refuse to start with a missing or short one on every
// binding, loopback included. This is the single place that rule lives.
describe('requireOwnerToken', () => {
  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['23 characters', 'x'.repeat(23)],
  ])('refuses a token that is %s', (_name, value) => {
    expect(() => requireOwnerToken(value)).toThrow(/OWNER_TOKEN.*24/);
  });

  it('accepts a token of exactly 24 characters and returns it unchanged', () => {
    expect(requireOwnerToken('k'.repeat(24))).toBe('k'.repeat(24));
  });

  it('accepts a longer token', () => {
    expect(requireOwnerToken('k'.repeat(200))).toBe('k'.repeat(200));
  });

  it('never repeats the supplied value in the error', () => {
    const short = 'topsecret-' + 'z'.repeat(10);
    let message = '';
    try {
      requireOwnerToken(short);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('OWNER_TOKEN');
    expect(message).not.toContain('topsecret');
    expect(message).not.toContain('zzzz');
  });
});
