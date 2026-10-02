import { afterEach, expect, it, vi } from 'vitest';
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { Observable } from 'rxjs';
import { DotAgent } from '../src/server/dot-agent.js';
import { chatgptPlanProvider } from '../src/server/chatgpt-plan.js';
import { USAGE_LIMIT_CODE } from '../src/shared/run-errors.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import {
  responsesStreamError,
  responsesText,
} from './fixtures/responses-stream.js';

// Today CopilotKit emits one RUN_ERROR per run. This stands in for a future
// where it emits more: the real DotAgent and its real TanStack stream run, but
// the BuiltInAgent is replaced by one that drains the factory's stream (so the
// capture happens exactly as in production) and then emits two RUN_ERRORs.
vi.mock('@copilotkit/runtime/v2', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@copilotkit/runtime/v2')>();
  return {
    ...original,
    BuiltInAgent: class {
      constructor(
        private options: Extract<
          ConstructorParameters<typeof original.BuiltInAgent>[0],
          { type: 'tanstack' }
        >,
      ) {}
      run(input: RunAgentInput) {
        return new Observable<BaseEvent>((subscriber) => {
          const abortController = new AbortController();
          void (async () => {
            const stream = await this.options.factory({
              input,
              abortController,
              abortSignal: abortController.signal,
              interrupt: async () => [],
              learnedSkills: { catalog: undefined, tools: {} },
            } as never);
            for await (const chunk of stream) void chunk;
            subscriber.next({
              type: EventType.RUN_ERROR,
              message: 'first',
            } as BaseEvent);
            subscriber.next({
              type: EventType.RUN_ERROR,
              message: 'second',
            } as BaseEvent);
            subscriber.complete();
          })();
        });
      }
      abortRun() {}
    },
  };
});

const databases: Array<{ close(): void }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  databases.splice(0).forEach((db) => db.close());
});

async function runWith(response: Response, channel = false) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  databases.push(store, workspace);
  const dot = workspace.dots()[0];
  workspace.bindThread('thread', dot.id, 'One-shot');
  const agent = new DotAgent(
    store,
    workspace,
    {
      intelligenceKey: 'fixture',
      baseUrl: 'https://unused.invalid/v1',
      modelProvider: chatgptPlanProvider({
        auth: {
          getAccessToken: async () => 'fixture-access-token-never-log',
          listModels: async () => [{ slug: 'm', displayName: 'M' }],
        },
        model: 'm',
      }),
      runtimeUrl: '',
      voiceName: 'marin',
      slackUsers: [],
    },
    dot.id,
    channel,
  );
  const input: RunAgentInput = {
    threadId: 'thread',
    runId: 'run',
    state: {},
    context: [],
    messages: [{ id: 'user', role: 'user', content: 'hi' }],
    tools: [],
    forwardedProps: {},
  };
  return new Promise<BaseEvent[]>((resolve) => {
    const events: BaseEvent[] = [];
    agent.run(input).subscribe({
      next: (event) => events.push(event),
      error: () => resolve(events),
      complete: () => resolve(events),
    });
  });
}

const runErrors = (events: BaseEvent[]) =>
  events.filter((event) => event.type === EventType.RUN_ERROR);

it('gives the captured code to the first RUN_ERROR only, never to a later one in the same run', async () => {
  const events = await runWith(
    responsesStreamError(USAGE_LIMIT_CODE, 'Limit reached.'),
  );
  const errors = runErrors(events);
  expect(errors).toHaveLength(2);
  expect(errors[0]).toMatchObject({ message: 'first', code: USAGE_LIMIT_CODE });
  expect(errors[1]).toMatchObject({ message: 'second' });
  expect(errors[1]).not.toHaveProperty('code');
});

it('gives no RUN_ERROR a code when none was captured', async () => {
  const events = await runWith(responsesText('Fine.'));
  const errors = runErrors(events);
  expect(errors).toHaveLength(2);
  for (const error of errors) expect(error).not.toHaveProperty('code');
});

it('keeps channels generic and never attaches a code', async () => {
  const events = await runWith(
    responsesStreamError(USAGE_LIMIT_CODE, 'Limit reached.'),
    true,
  );
  const errors = runErrors(events);
  expect(errors.length).toBeGreaterThan(0);
  for (const error of errors) {
    expect(error).not.toHaveProperty('code');
    expect(error).toEqual({
      type: EventType.RUN_ERROR,
      message:
        'OpenDots could not complete this request. Please check the app and try again.',
    });
  }
});
