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

const goodEntry = { slug: 'good-model', displayName: 'Good' };

it("accepts a slug of the DevKit's full supported length, and none longer", async () => {
  const longest = { slug: 'a'.repeat(200), displayName: 'Longest' };
  expect(await new ModelCatalog(async () => [longest]).list()).toEqual([
    longest,
  ]);
  const tooLong = new ModelCatalog(async () => [
    { slug: 'a'.repeat(201), displayName: 'Too long' },
  ]);
  await expect(tooLong.list()).rejects.toMatchObject({
    code: 'invalid_model_catalog',
  });
});

it('trims a display name and accepts an empty account', async () => {
  expect(
    await new ModelCatalog(async () => [
      { slug: 'm', displayName: '  Name  ' },
    ]).list(),
  ).toEqual([{ slug: 'm', displayName: 'Name' }]);
  expect(await new ModelCatalog(async () => []).list()).toEqual([]);
});

// OpenDots adds no character set of its own: whatever text the DevKit may
// return as a slug is a slug. Availability is decided by the list, not by spelling.
it.each([
  'openai/gpt-x@2026+beta',
  'ft:gpt-5:org::abc123',
  'gpt 5 (preview)',
  '../not-a-path-here',
  '<b>markup</b>',
  'モデル-1',
  "it's",
  '  padded  ',
])('accepts the slug %j, unchanged', async (slug) => {
  const catalog = new ModelCatalog(async () => [
    { slug, displayName: 'Whatever' },
  ]);
  expect(await catalog.list()).toEqual([{ slug, displayName: 'Whatever' }]);
});

// A contract violation fails the whole catalog. Nothing is dropped, and no
// good-looking part of a bad list is accepted.
it.each([
  ['an empty slug', [goodEntry, { slug: '', displayName: 'x' }]],
  ['a blank slug', [goodEntry, { slug: '   ', displayName: 'x' }]],
  [
    'a slug longer than the DevKit allows',
    [goodEntry, { slug: 'a'.repeat(201), displayName: 'x' }],
  ],
  ['a non-string slug', [goodEntry, { slug: 5, displayName: 'x' }]],
  ['a missing slug', [goodEntry, { displayName: 'no slug' }]],
  ['a missing display name', [goodEntry, { slug: 'no-name' }]],
  ['an empty display name', [goodEntry, { slug: 'blank', displayName: '  ' }]],
  [
    'an over-long display name',
    [goodEntry, { slug: 'long', displayName: 'x'.repeat(201) }],
  ],
  ['a non-object entry', [goodEntry, null]],
  ['a string entry', [goodEntry, 'gpt-5.5']],
  [
    'a duplicate slug',
    [goodEntry, { slug: 'good-model', displayName: 'Again' }],
  ],
  ['a catalog that is not a list', { models: [goodEntry] }],
  ['no catalog at all', undefined],
])('fails the whole catalog for %s', async (_name, payload) => {
  const catalog = new ModelCatalog(async () => payload as never);
  await expect(catalog.list()).rejects.toMatchObject({
    code: 'invalid_model_catalog',
    status: 502,
  });
  const snapshot = catalog.snapshot();
  expect(snapshot.models).toEqual([]); // nothing partly accepted
  expect(snapshot.fetchedAt).toBeUndefined();
  expect(snapshot.error?.code).toBe('invalid_model_catalog');
});

it('keeps the previous good list, marked stale, when a refresh comes back malformed', async () => {
  let payload: unknown = [goodEntry];
  const catalog = new ModelCatalog(async () => payload as never);
  await catalog.list();
  payload = [goodEntry, { slug: '', displayName: 'x' }];
  await expect(catalog.refresh()).rejects.toMatchObject({
    code: 'invalid_model_catalog',
  });
  expect(catalog.snapshot()).toMatchObject({
    models: [goodEntry],
    stale: true,
    error: { code: 'invalid_model_catalog' },
  });
});

it('names the position and the problem, never the content', async () => {
  const catalog = new ModelCatalog(
    async () =>
      [
        goodEntry,
        { slug: 'ok', displayName: 'secret-internal-detail'.padEnd(250, 'x') },
      ] as never,
  );
  const error = await catalog.list().catch((e) => e);
  expect(error.message).toContain('entry 2 has an invalid display name');
  expect(error.message).not.toContain('secret-internal-detail');
});
