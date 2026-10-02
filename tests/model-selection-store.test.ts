import { afterEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';

const stores: Store[] = [];
const dirs: string[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  dirs
    .splice(0)
    .forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
const make = (path = ':memory:') => {
  const store = new Store(path);
  stores.push(store);
  return store;
};

it('starts with no saved choice, merges updates, and clears', () => {
  const store = make();
  expect(store.modelSelection()).toEqual({});
  expect(store.setModelSelection({ provider: 'chatgpt-plan' })).toEqual({
    provider: 'chatgpt-plan',
  });
  expect(store.setModelSelection({ chatgptModel: 'gpt-5.6-luna' })).toEqual({
    provider: 'chatgpt-plan',
    chatgptModel: 'gpt-5.6-luna',
  });
  store.clearModelSelection();
  expect(store.modelSelection()).toEqual({});
  store.clearModelSelection(); // repeatable
});

it('persists across a restart, separately from the other settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-selection-'));
  dirs.push(dir);
  const path = join(dir, 'db.sqlite');
  const first = make(path);
  first.setModelSelection({ provider: 'api-key', chatgptModel: 'gpt-6-astra' });
  first.close();
  stores.pop();
  const second = make(path);
  expect(second.modelSelection()).toEqual({
    provider: 'api-key',
    chatgptModel: 'gpt-6-astra',
  });
  expect(second.settings()).toMatchObject({ paused: false });
});

it('ignores anything in a damaged or tampered row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-selection-'));
  dirs.push(dir);
  const path = join(dir, 'db.sqlite');
  make(path).close();
  stores.pop();
  const raw = new DatabaseSync(path);
  const write = (value: string) =>
    raw
      .prepare('INSERT OR REPLACE INTO model_selection VALUES (1, ?)')
      .run(value);
  const store = make(path);
  write('{not json');
  expect(store.modelSelection()).toEqual({});
  write(
    JSON.stringify({
      provider: 'evil',
      chatgptModel: '   ',
      apiKey: 'sk-secret',
    }),
  );
  expect(store.modelSelection()).toEqual({});
  write(JSON.stringify({ chatgptModel: 5 }));
  expect(store.modelSelection()).toEqual({});
  write(JSON.stringify({ chatgptModel: 'x'.repeat(201) }));
  expect(store.modelSelection()).toEqual({});
  // Spelling is not restricted; whether a model may be used is decided by the
  // account's live list when it is selected and again on every request.
  write(JSON.stringify({ chatgptModel: 'openai/gpt-x@2026+beta' }));
  expect(store.modelSelection()).toEqual({
    chatgptModel: 'openai/gpt-x@2026+beta',
  });
  write(
    JSON.stringify({ provider: 'chatgpt-plan', chatgptModel: 'gpt-5.6-luna' }),
  );
  expect(store.modelSelection()).toEqual({
    provider: 'chatgpt-plan',
    chatgptModel: 'gpt-5.6-luna',
  });
  raw.close();
});
