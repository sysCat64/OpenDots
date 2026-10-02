import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { BuiltInAgent } from '@copilotkit/runtime/v2';
import { chat } from '@tanstack/ai';
import { chatgptPlanProvider } from '../src/server/chatgpt-plan.js';
import { captureRunErrorCode } from '../src/server/run-error-code.js';
import { USAGE_LIMIT_CODE } from '../src/shared/run-errors.js';
import { responsesStreamError } from './fixtures/responses-stream.js';

vi.setConfig({ testTimeout: 20_000 });

// The dependency behaviour that src/server/run-error-code.ts and DotAgent rely
// on to carry a RUN_ERROR `code` to the browser:
//
//   1. TanStack's `middleware.onChunk` sees the RUN_ERROR chunk, with its code,
//      before the stream is consumed any further.
//   2. CopilotKit's TanStack converter drops that code (it throws a plain
//      Error carrying only the message).
//
// (2) is the premise of the workaround. If it stops holding, CopilotKit keeps
// the code itself and the capture in DotAgent is redundant.

const input: RunAgentInput = {
  threadId: 'thread',
  runId: 'run',
  state: {},
  context: [],
  messages: [{ id: 'user', role: 'user', content: 'hi' }],
  tools: [],
  forwardedProps: {},
};

describe('TanStack: the public middleware sees the code first', () => {
  it('onChunk receives the RUN_ERROR chunk with its code before the consumer does', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      responsesStreamError(USAGE_LIMIT_CODE, 'Limit reached.'),
    );
    const provider = chatgptPlanProvider({
      auth: {
        getAccessToken: async () => 'fixture-token',
        listModels: async () => [{ slug: 'm', displayName: 'M' }],
      },
      model: 'm',
    });
    const capture = captureRunErrorCode();
    const consumed: Array<{ type: string; capturedBefore: boolean }> = [];
    for await (const chunk of chat({
      adapter: provider.createAdapter(),
      messages: [{ role: 'user', content: 'hi' }],
      modelOptions: provider.modelOptions,
      middleware: [capture.middleware],
    }))
      consumed.push({
        type: chunk.type,
        capturedBefore: capture.take() === USAGE_LIMIT_CODE,
      });
    expect(consumed.find((entry) => entry.type === 'RUN_ERROR')).toEqual({
      type: 'RUN_ERROR',
      capturedBefore: true,
    });
  });
});

describe('CopilotKit: the TanStack converter currently drops the code', () => {
  async function run(chunk: Record<string, unknown>) {
    const agent = new BuiltInAgent({
      type: 'tanstack',
      factory: async function* () {
        yield chunk;
      },
    });
    return new Promise<{ events: BaseEvent[]; error?: unknown }>((resolve) => {
      const events: BaseEvent[] = [];
      agent.run(input).subscribe({
        next: (event) => events.push(event),
        error: (error: unknown) => resolve({ events, error }),
        complete: () => resolve({ events }),
      });
    });
  }

  it('premise: the emitted RUN_ERROR and the thrown error carry the message but not the code', async () => {
    const { events, error } = await run({
      type: 'RUN_ERROR',
      message: 'Limit reached.',
      code: USAGE_LIMIT_CODE,
    });
    const runError = events.find((event) => event.type === EventType.RUN_ERROR);
    const review =
      'Review required: CopilotKit now keeps the RUN_ERROR code itself. ' +
      'DotAgent no longer needs to restore it: check src/server/run-error-code.ts and ' +
      'DotAgent.run, and remove them if they are redundant.';
    expect(runError, review).toMatchObject({ message: 'Limit reached.' });
    expect(runError, review).not.toHaveProperty('code');
    expect(error, review).toBeInstanceOf(Error);
    expect(error, review).not.toHaveProperty('code');
  });
});

describe('dependency review', () => {
  // Not a compatibility decision (the behaviour tests above are). A different
  // version only means: run them, look at what changed, and record the version.
  const reviewed: Record<string, string[]> = {
    '@copilotkit/runtime': ['1.75.0'],
    '@tanstack/ai': ['0.63.0'],
    '@tanstack/openai-base': ['0.12.1'],
    '@ag-ui/core': ['0.0.59'],
  };
  it.each(Object.keys(reviewed))(
    '%s is a version the RUN_ERROR code path was reviewed against',
    (name) => {
      const { version } = JSON.parse(
        readFileSync(
          new URL(`../node_modules/${name}/package.json`, import.meta.url),
          'utf8',
        ),
      );
      expect(
        reviewed[name],
        `Review required: ${name} is now ${version}. The behaviour tests above decide whether the RUN_ERROR code path still works; ` +
          'if they pass, add this version to the reviewed list.',
      ).toContain(version);
    },
  );
});
