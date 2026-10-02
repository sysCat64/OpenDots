import { expect, it, vi } from 'vitest';
import { ChatGPTPlanError } from '../src/server/chatgpt-plan.js';
import { ModelCatalog } from '../src/server/model-catalog.js';

const models = [
  { slug: 'a-model', displayName: 'A' },
  { slug: 'b-model', displayName: 'B' },
];
const clock = () => {
  const t = { now: 0 };
  return { t, now: () => t.now };
};

it('serves a fresh list from cache and shares one load between callers', async () => {
  const load = vi.fn(async () => models);
  const catalog = new ModelCatalog(load);
  const results = await Promise.all([
    catalog.list(),
    catalog.list(),
    catalog.list(),
  ]);
  expect(results.every((r) => r.length === 2)).toBe(true);
  await catalog.list();
  expect(load).toHaveBeenCalledTimes(1);
});

it('reloads after the TTL and on force', async () => {
  const { t, now } = clock();
  const load = vi.fn(async () => models);
  const catalog = new ModelCatalog(load, { ttlMs: 1_000, now });
  await catalog.list();
  t.now = 999;
  await catalog.list();
  expect(load).toHaveBeenCalledTimes(1);
  t.now = 1_500;
  await catalog.list();
  expect(load).toHaveBeenCalledTimes(2);
  await catalog.refresh();
  expect(load).toHaveBeenCalledTimes(3);
});

it('reports stale after the TTL or a failed refresh, keeping the last good list', async () => {
  const { t, now } = clock();
  let fail = false;
  const catalog = new ModelCatalog(
    async () => {
      if (fail)
        throw new ChatGPTPlanError('refresh_not_ready', 'Try later.', 503);
      return models;
    },
    { ttlMs: 1_000, now },
  );
  await catalog.list();
  expect(catalog.snapshot()).toMatchObject({ stale: false, refreshing: false });
  fail = true;
  await expect(catalog.refresh()).rejects.toBeInstanceOf(ChatGPTPlanError);
  const snapshot = catalog.snapshot();
  expect(snapshot.models).toHaveLength(2);
  expect(snapshot).toMatchObject({
    stale: true,
    error: { code: 'refresh_not_ready', message: 'Try later.' },
  });
  fail = false;
  await catalog.refresh();
  expect(catalog.snapshot()).toMatchObject({ stale: false, error: undefined });
  t.now = 5_000;
  expect(catalog.snapshot().stale).toBe(true);
});

it('does not expose an unknown error message', async () => {
  const catalog = new ModelCatalog(async () => {
    throw new Error('secret-internal-detail');
  });
  await expect(catalog.list()).rejects.toThrow();
  expect(JSON.stringify(catalog.snapshot())).not.toContain(
    'secret-internal-detail',
  );
  expect(catalog.snapshot().error?.code).toBe('models_unavailable');
});

it('ignores a load that finishes after clear()', async () => {
  let release!: () => void;
  const catalog = new ModelCatalog(
    () => new Promise((resolve) => (release = () => resolve(models))),
  );
  const pending = catalog.list();
  catalog.clear();
  release();
  await pending;
  expect(catalog.snapshot().fetchedAt).toBeUndefined();
  expect(catalog.snapshot().models).toEqual([]);
});

it('gives up on a load that takes too long, without retrying by itself', async () => {
  const load = vi.fn(
    (signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason)),
      ),
  );
  const catalog = new ModelCatalog(load, { timeoutMs: 30 });
  await expect(catalog.list()).rejects.toBeDefined();
  expect(load).toHaveBeenCalledTimes(1);
  expect(catalog.snapshot().refreshing).toBe(false);
  expect(catalog.snapshot().error).toBeDefined();
});

it('lets one caller stop waiting without cancelling the shared load', async () => {
  let release!: () => void;
  const load = vi.fn(
    () => new Promise<typeof models>((r) => (release = () => r(models))),
  );
  const catalog = new ModelCatalog(load);
  const controller = new AbortController();
  const waiting = catalog.list({ signal: controller.signal });
  controller.abort(new Error('caller left'));
  await expect(waiting).rejects.toThrow('caller left');
  release();
  expect(await catalog.list()).toHaveLength(2);
  expect(load).toHaveBeenCalledTimes(1);
});

it('keeps only well-formed entries from the outside', async () => {
  const catalog = new ModelCatalog(
    async () =>
      [
        { slug: 'good-model', displayName: '  Good  ' },
        { slug: 'good-model', displayName: 'duplicate' },
        { slug: '../bad', displayName: 'x' },
        { slug: '<script>', displayName: 'x' },
        { slug: 'no-name' },
        { displayName: 'no slug' },
        null,
        { slug: 'x'.repeat(200), displayName: 'long' },
      ] as never,
  );
  expect(await catalog.list()).toEqual([
    { slug: 'good-model', displayName: 'Good' },
    { slug: 'no-name', displayName: 'no-name' },
  ]);
});
