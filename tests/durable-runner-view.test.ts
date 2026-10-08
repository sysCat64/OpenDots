import { afterEach, describe, expect, it, vi } from 'vitest';
import { snapshotDatabase } from './helpers/db-snapshot';
import { user } from './helpers/event-fixtures';
import {
  collect,
  committedTypes,
  createHarness,
  restartRunner,
  runInput,
  runToEnd,
  startRun,
  typesOf,
  until,
  type Harness,
} from './helpers/runner-harness';
import {
  ScriptedAgent,
  createGate,
  finished,
  textMessage,
} from './helpers/scripted-agent';

// L9 (R34): the derived message view. The events and the run result are the
// authority; a failure to write the view never fails or re-statuses a run, is
// repaired once, and is caught up later. Readers fall back to the events. The
// view is full-rebuild only: no C8 checkpoint field exists.
const harnesses: Harness[] = [];
const make = () => {
  const harness = createHarness();
  harnesses.push(harness);
  return harness;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const harness of harnesses.splice(0)) harness.cleanup();
});

const reply = (id: string, text: string) =>
  new ScriptedAgent((input) => [...textMessage(id, text), finished(input)]);

const viewRow = (h: Harness, threadId = 't1') =>
  h.db
    .prepare(
      'SELECT messagesJson, lastEventId FROM conversation_messages WHERE threadId = ?',
    )
    .get(threadId) as { messagesJson: string; lastEventId: number } | undefined;

describe('a view write that fails', () => {
  it('does not fail or re-status a run whose events are durable, and readers derive from the events', async () => {
    const h = make();
    const logged = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    h.log.failRebuilds = 2;
    const events = await runToEnd(
      h.runner,
      reply('a1', 'hi'),
      runInput('t1', 'r1', [user('u1')]),
    );
    expect(typesOf(events).at(-1)).toBe('RUN_FINISHED');
    expect(h.log.getRun('t1', 'r1')?.status).toBe('finished');
    expect(h.log.checkInvariants()).toEqual([]);
    expect(viewRow(h)).toBeUndefined();
    // Exactly one repair attempt, and one note for the thread.
    expect(h.log.rebuildCalls).toBe(2);
    expect(logged).toHaveBeenCalledTimes(1);
    const read = await h.log.readMessages('t1', { runActive: false });
    expect(read.source).toBe('events');
    expect((await h.runner.messagesFor('t1')).map((m) => m.id)).toEqual([
      'u1',
      'a1',
    ]);
  });

  it('is repaired by the single in-line retry when the first attempt was a glitch', async () => {
    const h = make();
    const logged = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    h.log.failRebuilds = 1;
    await runToEnd(
      h.runner,
      reply('a1', 'hi'),
      runInput('t1', 'r1', [user('u1')]),
    );
    expect(h.log.rebuildCalls).toBe(2);
    expect(logged).not.toHaveBeenCalled();
    expect((await h.log.readMessages('t1', { runActive: false })).source).toBe(
      'cache',
    );
  });

  it('is caught up by the next finalization', async () => {
    const h = make();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.log.failRebuilds = 2;
    await runToEnd(
      h.runner,
      reply('a1', 'one'),
      runInput('t1', 'r1', [user('u1')]),
    );
    expect(viewRow(h)).toBeUndefined();
    await runToEnd(
      h.runner,
      reply('a2', 'two'),
      runInput('t1', 'r2', [user('u2')]),
    );
    expect(viewRow(h)).toBeDefined();
    expect((await h.log.readMessages('t1', { runActive: false })).source).toBe(
      'cache',
    );
    expect((await h.runner.messagesFor('t1')).map((m) => m.id)).toEqual([
      'u1',
      'a1',
      'u2',
      'a2',
    ]);
  });

  it('is caught up by ready()', async () => {
    const h = make();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.log.failRebuilds = 2;
    await runToEnd(
      h.runner,
      reply('a1', 'one'),
      runInput('t1', 'r1', [user('u1')]),
    );
    const fresh = restartRunner(h);
    expect(await fresh.runner.ready()).toMatchObject({
      checked: 1,
      rebuilt: 1,
    });
    expect(viewRow(h)).toBeDefined();
  });

  it('needs no reload: the events a client replays are already complete', async () => {
    const h = make();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.log.failRebuilds = 2;
    await runToEnd(
      h.runner,
      reply('a1', 'one'),
      runInput('t1', 'r1', [user('u1')]),
    );
    const replay = await collect(
      restartRunner(h).runner.connect({ threadId: 't1' }),
    );
    expect(typesOf(replay).at(-1)).toBe('RUN_FINISHED');
  });
});

describe('a stale, corrupt or missing row', () => {
  const finishedThread = async (h: Harness) => {
    await runToEnd(
      h.runner,
      reply('a1', 'one'),
      runInput('t1', 'r1', [user('u1')]),
    );
    return h.log.maxEventId('t1');
  };

  it.each([
    ['missing', (h: Harness) => h.db.exec('DELETE FROM conversation_messages')],
    [
      'corrupt',
      (h: Harness) =>
        h.db.exec(
          "UPDATE conversation_messages SET messagesJson = '{not json'",
        ),
    ],
    [
      'not a list',
      (h: Harness) =>
        h.db.exec(
          'UPDATE conversation_messages SET messagesJson = \'{"a":1}\'',
        ),
    ],
    [
      'behind the log',
      (h: Harness) =>
        h.db.exec(
          'UPDATE conversation_messages SET lastEventId = lastEventId - 1',
        ),
    ],
    [
      'ahead of the log',
      (h: Harness) =>
        h.db.exec(
          'UPDATE conversation_messages SET lastEventId = lastEventId + 5',
        ),
    ],
  ])(
    '%s: a reader derives from the events and writes nothing; ready() repairs it',
    async (_name, damage) => {
      const h = make();
      const newest = await finishedThread(h);
      damage(h);
      const damaged = snapshotDatabase(h.throwaway.path);
      const reader = restartRunner(h);
      expect((await reader.runner.messagesFor('t1')).map((m) => m.id)).toEqual([
        'u1',
        'a1',
      ]);
      expect(snapshotDatabase(h.throwaway.path)).toBe(damaged);
      expect(reader.log.rebuildCalls).toBe(0);
      const result = await reader.runner.ready();
      expect(result.rebuilt).toBe(1);
      expect(viewRow(h)).toMatchObject({ lastEventId: newest });
      expect(
        (await h.log.readMessages('t1', { runActive: false })).source,
      ).toBe('cache');
      expect(h.log.checkInvariants()).toEqual([]);
    },
  );

  it('serves a parseable row with the right stamp as it is: the known limit until C8 adds messagesSha256', async () => {
    const h = make();
    await finishedThread(h);
    h.db.exec(
      `UPDATE conversation_messages SET messagesJson = '[{"id":"forged","role":"user","content":"x"}]'`,
    );
    // The cache is not an authority: derivation and rebuild let the events win.
    expect(
      (await h.log.deriveMessages('t1')).messages.map((m) => m.id),
    ).toEqual(['u1', 'a1']);
    // The cheap read trusts the stamp, which is the accepted C4 limit.
    expect((await h.runner.messagesFor('t1')).map((m) => m.id)).toEqual([
      'forged',
    ]);
    await h.log.rebuildMessages('t1');
    expect((await h.runner.messagesFor('t1')).map((m) => m.id)).toEqual([
      'u1',
      'a1',
    ]);
  });
});

describe('while a run is active', () => {
  it('derives from the committed prefix, including partial text, and writes nothing', async () => {
    const h = make();
    await runToEnd(
      h.runner,
      reply('a1', 'old'),
      runInput('t1', 'r1', [user('u1')]),
    );
    const gate = createGate();
    const live = new ScriptedAgent((input) => [
      { type: 'TEXT_MESSAGE_START', messageId: 'a2', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a2', delta: 'typing' },
      gate,
      finished(input),
    ]);
    const running = collect(
      startRun(h.runner, live, runInput('t1', 'r2', [user('u2')])),
    );
    await until(() =>
      committedTypes(h.db, 't1', 'r2').includes('TEXT_MESSAGE_CONTENT'),
    );
    const before = snapshotDatabase(h.throwaway.path);
    const messages = await h.runner.messagesFor('t1');
    expect(messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(messages.at(-1)).toMatchObject({ content: 'typing' });
    expect(snapshotDatabase(h.throwaway.path)).toBe(before);
    gate.open();
    await running;
  });
});

describe('no C8 checkpoint exists', () => {
  it('the view table has exactly the three C4 columns', async () => {
    const h = make();
    await runToEnd(
      h.runner,
      reply('a1', 'x'),
      runInput('t1', 'r1', [user('u1')]),
    );
    expect(
      h.db
        .prepare('PRAGMA table_info(conversation_messages)')
        .all()
        .map((c) => c.name),
    ).toEqual(['threadId', 'messagesJson', 'lastEventId']);
  });
});
