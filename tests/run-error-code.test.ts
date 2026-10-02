import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { DotAgent } from '../src/server/dot-agent.js';
import {
  chatgptPlanProvider,
  type ChatGPTPlanAuth,
} from '../src/server/chatgpt-plan.js';
import { captureRunErrorCode } from '../src/server/run-error-code.js';
import { USAGE_LIMIT_CODE } from '../src/shared/run-errors.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import {
  responsesStreamError,
  responsesText,
} from './fixtures/responses-stream.js';

const SERVER_MESSAGE =
  'The ChatGPT user has reached their Subscription Sharing usage limit. Ask the user to try again after their usage limit resets or use an API key instead.';
const GENERIC =
  'OpenDots could not complete this request. Please check the app and try again.';

const databases: Array<{ close(): void }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  databases.splice(0).forEach((db) => db.close());
});

const auth: ChatGPTPlanAuth = {
  getAccessToken: async () => 'fixture-access-token-never-log',
  listModels: async () => [{ slug: 'gpt-6-astra', displayName: 'Astra' }],
};

// A real DotAgent, BuiltInAgent, TanStack chat() and chatgptPlanProvider; only
// the network is replaced.
function fixture(prompt = 'hello', channel = false) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  databases.push(store, workspace);
  const dot = workspace.dots()[0];
  workspace.bindThread('thread', dot.id, 'Run error code');
  const agent = new DotAgent(
    store,
    workspace,
    {
      intelligenceKey: 'fixture',
      baseUrl: 'https://unused.invalid/v1',
      modelProvider: chatgptPlanProvider({ auth, model: 'gpt-6-astra' }),
      runtimeUrl: '',
      voiceName: 'marin',
      slackUsers: [],
    },
    dot.id,
    channel,
  );
  const input: RunAgentInput = {
    threadId: 'thread',
    runId: `run-${prompt}`,
    state: {},
    context: [],
    messages: [{ id: 'user', role: 'user', content: prompt }],
    tools: [],
    forwardedProps: {},
  };
  return { agent, input };
}

// The run's events, and the error the stream finished with, if any.
function collect(agent: DotAgent, input: RunAgentInput) {
  return new Promise<{ events: BaseEvent[]; error?: unknown }>((resolve) => {
    const events: BaseEvent[] = [];
    agent.run(input).subscribe({
      next: (event) => events.push(event),
      error: (error: unknown) => resolve({ events, error }),
      complete: () => resolve({ events }),
    });
  });
}

const runErrors = (events: BaseEvent[]) =>
  events.filter((event) => event.type === EventType.RUN_ERROR);
const promptOf = (init?: RequestInit) =>
  JSON.stringify(JSON.parse(String(init?.body)).input);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('RUN_ERROR code through the real CopilotKit and TanStack stack', () => {
  it('restores the usage-limit code on the web RUN_ERROR, keeping the message and nothing else', async () => {
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        responsesStreamError(USAGE_LIMIT_CODE, SERVER_MESSAGE),
      );
    const f = fixture();
    const { events } = await collect(f.agent, f.input);
    const [error, ...more] = runErrors(events);
    expect(more).toEqual([]);
    expect(error).toMatchObject({
      type: EventType.RUN_ERROR,
      code: USAGE_LIMIT_CODE,
      message: SERVER_MESSAGE,
    });
    // Nothing from the provider's raw error reaches the browser.
    expect(Object.keys(error).sort()).toEqual([
      'code',
      'message',
      'runId',
      'threadId',
      'type',
    ]);
    expect(error).not.toHaveProperty('rawEvent');
    expect(network).toHaveBeenCalledTimes(1);
  });

  it('does not forward a code outside the allowlist', async () => {
    for (const code of [
      'subscription_sharing_user_not_eligible',
      'subscription_sharing_usage_unavailable',
      'some_new_code',
    ]) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        responsesStreamError(code, 'Provider text.'),
      );
      const f = fixture();
      const { events } = await collect(f.agent, f.input);
      const [error] = runErrors(events);
      expect(error, code).toMatchObject({ message: 'Provider text.' });
      expect(error, code).not.toHaveProperty('code');
    }
  });

  it('leaves a normal run untouched', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(responsesText('Hi.'));
    const f = fixture();
    const { events, error } = await collect(f.agent, f.input);
    expect(error).toBeUndefined();
    expect(runErrors(events)).toEqual([]);
    expect(events.some((event) => 'code' in event)).toBe(false);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: EventType.TEXT_MESSAGE_CHUNK,
          delta: 'Hi.',
        }),
      ]),
    );
  });

  it('keeps parallel runs apart: only the run that hit the limit gets the code', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const prompt = promptOf(init);
      // Interleave: the successful run finishes in the middle of the others.
      if (prompt.includes('limited')) {
        await wait(40);
        return responsesStreamError(USAGE_LIMIT_CODE, SERVER_MESSAGE);
      }
      if (prompt.includes('other')) {
        await wait(10);
        return responsesStreamError('some_new_code', 'Other failure.');
      }
      await wait(20);
      return responsesText('Fine.');
    });
    const runs = ['limited', 'fine', 'other', 'limited-2'].map((prompt) => {
      const f = fixture(prompt);
      return collect(f.agent, f.input);
    });
    const [limited, fine, other, limitedAgain] = await Promise.all(runs);
    expect(runErrors(limited.events)[0]).toMatchObject({
      code: USAGE_LIMIT_CODE,
    });
    expect(runErrors(limitedAgain.events)[0]).toMatchObject({
      code: USAGE_LIMIT_CODE,
    });
    expect(runErrors(other.events)[0]).toMatchObject({
      message: 'Other failure.',
    });
    expect(runErrors(other.events)[0]).not.toHaveProperty('code');
    expect(runErrors(fine.events)).toEqual([]);
    expect(fine.events.some((event) => 'code' in event)).toBe(false);
  });

  it('gives an aborted run no code', async () => {
    let started!: () => void;
    const requested = new Promise<void>((resolve) => (started = resolve));
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          started();
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const f = fixture();
    const finished = collect(f.agent, f.input);
    await requested;
    f.agent.abortRun();
    const { events } = await finished;
    expect(events.some((event) => 'code' in event)).toBe(false);
    expect(runErrors(events).every((event) => !('code' in event))).toBe(true);
  });

  it('keeps Slack and other channels generic', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      responsesStreamError(USAGE_LIMIT_CODE, SERVER_MESSAGE),
    );
    const f = fixture('hello', true);
    const { events } = await collect(f.agent, f.input);
    // Every RUN_ERROR a channel sees is exactly the generic payload. (Today
    // there are two: the converted event and the stream's own error; that
    // duplication predates the code restoration and is not asserted here.)
    const errors = runErrors(events);
    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors)
      expect(error).toEqual({ type: EventType.RUN_ERROR, message: GENERIC });
    expect(JSON.stringify(events)).not.toContain('subscription');
    expect(JSON.stringify(events)).not.toContain('usage limit');
  });
});

describe('captureRunErrorCode', () => {
  // The middleware is driven by hand here; the behaviour through the real stack
  // is above. A chunk whose rawEvent throws proves it is never read.
  const chunk = (fields: Record<string, unknown>) =>
    ({
      type: 'RUN_ERROR',
      message: 'm',
      get rawEvent(): never {
        throw new Error('rawEvent must not be read');
      },
      ...fields,
    }) as never;
  const feed = (...chunks: unknown[]) => {
    const capture = captureRunErrorCode();
    for (const next of chunks)
      capture.middleware.onChunk?.(undefined as never, next as never);
    return capture.take();
  };

  it('keeps the first allowed code and is not overwritten by a later error', () => {
    expect(
      feed(
        chunk({ code: 'some_new_code' }),
        chunk({ code: USAGE_LIMIT_CODE }),
        chunk({ code: 'some_new_code' }),
      ),
    ).toBe(USAGE_LIMIT_CODE);
    expect(feed(chunk({ code: USAGE_LIMIT_CODE }), chunk({ code: 'x' }))).toBe(
      USAGE_LIMIT_CODE,
    );
  });

  it('ignores other chunk types, missing and non-string codes, and unknown codes', () => {
    expect(feed()).toBeUndefined();
    expect(
      feed(
        { type: 'TEXT_MESSAGE_CONTENT', code: USAGE_LIMIT_CODE },
        chunk({}),
        chunk({ code: 429 }),
        chunk({ code: 'some_new_code' }),
      ),
    ).toBeUndefined();
  });

  it('never matches on the message', () => {
    expect(
      feed(chunk({ message: `${USAGE_LIMIT_CODE}: reached`, code: undefined })),
    ).toBeUndefined();
  });

  it('keeps separate captures separate', () => {
    const a = captureRunErrorCode();
    const b = captureRunErrorCode();
    a.middleware.onChunk?.(
      undefined as never,
      chunk({ code: USAGE_LIMIT_CODE }),
    );
    expect([a.take(), b.take()]).toEqual([USAGE_LIMIT_CODE, undefined]);
  });

  it('is one-shot: the code is handed over once, then the capture is empty', () => {
    const capture = captureRunErrorCode();
    capture.middleware.onChunk?.(
      undefined as never,
      chunk({ code: USAGE_LIMIT_CODE }),
    );
    expect(capture.take()).toBe(USAGE_LIMIT_CODE);
    expect(capture.take()).toBeUndefined();
    expect(capture.take()).toBeUndefined();
  });

  it('taking with nothing captured changes nothing; a new code can be captured after a take', () => {
    const capture = captureRunErrorCode();
    expect(capture.take()).toBeUndefined();
    capture.middleware.onChunk?.(
      undefined as never,
      chunk({ code: USAGE_LIMIT_CODE }),
    );
    expect(capture.take()).toBe(USAGE_LIMIT_CODE);
    capture.middleware.onChunk?.(
      undefined as never,
      chunk({ code: USAGE_LIMIT_CODE }),
    );
    expect(capture.take()).toBe(USAGE_LIMIT_CODE);
  });
});
