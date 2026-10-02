import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { chat, maxIterations, toolDefinition } from '@tanstack/ai';
import { openaiCompatibleText } from '@tanstack/ai-openai/compatible';
import { z } from 'zod';
import { withSiwcToolCallFinishReason } from '../src/server/siwc-compat.js';
import {
  responsesText,
  responsesToolCall,
} from './fixtures/responses-stream.js';

vi.setConfig({ testTimeout: 20_000 });

// The behaviour OpenDots needs from "Sign in with ChatGPT" streaming and the
// TanStack Responses adapter, checked end to end through TanStack's real agent
// loop. SIWC sends a complete function_call in response.output_item.done but
// leaves response.completed.output empty; TanStack derives finishReason from
// that array. src/server/siwc-compat.ts bridges the gap.
//
// The version list at the bottom only says "a human should look again". What
// decides compatibility is the behaviour tested here.

interface Run {
  executions: Array<{ q: string }>;
  requests: Array<{
    url: string;
    body: { input?: Array<Record<string, unknown>> };
  }>;
  finishReasons: string[];
  chunkTypes: string[];
  text: string;
}

async function run(options: {
  shim: boolean;
  responses: Array<() => Response>;
}): Promise<Run> {
  const result: Run = {
    executions: [],
    requests: [],
    finishReasons: [],
    chunkTypes: [],
    text: '',
  };
  const queue = [...options.responses];
  const base = openaiCompatibleText('contract-model', {
    apiKey: 'unused',
    baseURL: 'https://siwc.example.invalid/v1',
    api: 'responses',
    maxRetries: 0,
    fetch: async (input, init) => {
      result.requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
      });
      const next = queue.shift();
      if (!next) throw new Error('an unexpected extra request');
      return next();
    },
  });
  const lookup = toolDefinition({
    name: 'lookup',
    description: 'Look something up.',
    inputSchema: z.object({ q: z.string() }),
  }).server(async ({ q }) => {
    result.executions.push({ q });
    return { answer: 42 };
  });
  const stream = chat({
    adapter: options.shim ? withSiwcToolCallFinishReason(base) : base,
    messages: [{ role: 'user', content: 'What is the answer?' }],
    tools: [lookup],
    agentLoopStrategy: maxIterations(3),
    modelOptions: { store: false },
  });
  for await (const chunk of stream) {
    result.chunkTypes.push(chunk.type);
    if (chunk.type === 'RUN_FINISHED')
      result.finishReasons.push(
        String(
          (chunk as { metadata?: { tanstack?: { finishReason?: string } } })
            .metadata?.tanstack?.finishReason ??
            (chunk as { finishReason?: string }).finishReason,
        ),
      );
    if (chunk.type === 'TEXT_MESSAGE_CONTENT')
      result.text += (chunk as { delta?: string }).delta ?? '';
  }
  return result;
}
const toolCall = (options?: Parameters<typeof responsesToolCall>[2]) => () =>
  responsesToolCall('lookup', { q: 'life' }, options);
const answer =
  (text = 'It is 42.') =>
  () =>
    responsesText(text);

describe("the SIWC tool-call contract, through TanStack's agent loop", () => {
  it('with the shim: TOOL_CALL_END, a terminal stop rewritten to tool_calls, the tool runs, the next iteration happens', async () => {
    const r = await run({ shim: true, responses: [toolCall(), answer()] });
    // 1. the tool call is observed complete
    expect(r.chunkTypes).toContain('TOOL_CALL_END');
    // 2. the first turn ends as tool_calls (not stop), the second as stop
    expect(r.finishReasons).toEqual(['tool_calls', 'stop']);
    // 3. TanStack executed the tool, once, with the model's arguments
    expect(r.executions).toEqual([{ q: 'life' }]);
    // 4. a next model iteration took place, carrying the tool's result
    expect(r.requests).toHaveLength(2);
    expect(r.requests[1].body.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'function_call_output',
          call_id: 'call-1',
          output: expect.stringContaining('42'),
        }),
      ]),
    );
    // 5. and it produced the final answer
    expect(r.text).toBe('It is 42.');
  });

  it('with the shim and a reasoning item: it is replayed ahead of its call and output', async () => {
    const r = await run({
      shim: true,
      responses: [toolCall({ reasoning: true }), answer()],
    });
    expect(r.executions).toHaveLength(1);
    const types = r.requests[1].body.input!.map((item) => String(item.type));
    expect(types.indexOf('reasoning')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('reasoning')).toBeLessThan(
      types.indexOf('function_call'),
    );
    expect(types.indexOf('function_call')).toBeLessThan(
      types.indexOf('function_call_output'),
    );
  });

  it('leaves a turn without a tool call alone', async () => {
    const r = await run({ shim: true, responses: [answer('Just text.')] });
    expect(r.finishReasons).toEqual(['stop']);
    expect(r.executions).toEqual([]);
    expect(r.requests).toHaveLength(1);
  });

  it('does not invent a tool call that never completed', async () => {
    // A call that starts but whose item never finishes: nothing to execute.
    const unfinished = () =>
      new Response(
        [
          {
            type: 'response.created',
            sequence_number: 0,
            response: {
              id: 'r',
              object: 'response',
              created_at: 1,
              model: 'm',
              status: 'in_progress',
              output: [],
            },
          },
          {
            type: 'response.output_item.added',
            sequence_number: 1,
            output_index: 0,
            item: {
              type: 'function_call',
              id: 'fc',
              call_id: 'c',
              name: 'lookup',
              arguments: '',
              status: 'in_progress',
            },
          },
          {
            type: 'response.completed',
            sequence_number: 2,
            response: {
              id: 'r',
              object: 'response',
              created_at: 1,
              model: 'm',
              status: 'completed',
              output: [],
            },
          },
        ]
          .map(
            (event) =>
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          )
          .join(''),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    const r = await run({ shim: true, responses: [unfinished] });
    expect(r.executions).toEqual([]);
    expect(r.finishReasons).not.toContain('tool_calls');
  });

  it('is harmless if SIWC fills response.completed.output: the tool still runs exactly once', async () => {
    for (const shim of [true, false]) {
      const r = await run({
        shim,
        responses: [toolCall({ completedOutput: true }), answer()],
      });
      expect(r.executions, `shim ${shim}`).toHaveLength(1);
      expect(r.finishReasons, `shim ${shim}`).toEqual(['tool_calls', 'stop']);
      expect(r.requests, `shim ${shim}`).toHaveLength(2);
    }
  });

  // A removal signal, not a regression: while it passes, the shim is needed.
  // If TanStack (or SIWC) changes so that it fails, the premise is gone; see
  // "Removing the SIWC compatibility shim" in docs/CHATGPT_PLAN.md.
  it('premise: without the shim, a SIWC-shaped tool call ends as stop and the tool never runs', async () => {
    const r = await run({ shim: false, responses: [toolCall(), answer()] });
    expect(r.chunkTypes).toContain('TOOL_CALL_END');
    expect(r.finishReasons).toEqual(['stop']);
    expect(r.executions).toEqual([]);
    expect(r.requests).toHaveLength(1);
  });
});

describe('dependency review', () => {
  // Not a compatibility decision (the behaviour tests above are). A different
  // version only means: run them, look at what changed, and record the version.
  const reviewed: Record<string, string[]> = {
    '@tanstack/openai-base': ['0.12.1'],
    '@tanstack/ai-openai': ['0.25.1'],
    '@tanstack/ai': ['0.63.0'],
  };
  it.each(Object.keys(reviewed))(
    '%s is a version the shim was reviewed against',
    (name) => {
      const { version } = JSON.parse(
        readFileSync(
          new URL(`../node_modules/${name}/package.json`, import.meta.url),
          'utf8',
        ),
      );
      expect(
        reviewed[name],
        `Review required: ${name} is now ${version}. The behaviour tests above are what decide whether the SIWC shim still works; ` +
          'if they pass, add this version to the reviewed list (and check whether the shim can be removed).',
      ).toContain(version);
    },
  );
});
