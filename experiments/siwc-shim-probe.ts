// Observes, on a real ChatGPT-plan account, the two facts that decide whether
// src/server/siwc-compat.ts is still needed (see "Removing the SIWC
// compatibility shim" in docs/CHATGPT_PLAN.md):
//
//   1. does a function-call turn still arrive with response.completed.output
//      empty (the complete call only in response.output_item.done)?
//   2. through TanStack's agent loop, does the turn still end as "stop" without
//      the shim (so the tool never runs)?
//
//   CHATGPT_CREDENTIAL_STORE=keychain node --import tsx experiments/siwc-shim-probe.ts [model]
//
// Uses the saved session read-only (no sign-in, no browser). It prints event
// names and counts, never a token or any message content.
import { chat, maxIterations, toolDefinition } from '@tanstack/ai';
import { openaiCompatibleText } from '@tanstack/ai-openai/compatible';
import { z } from 'zod';
import { createChatGPTPlanSession } from '../src/server/chatgpt-devkit.js';
import { withSiwcToolCallFinishReason } from '../src/server/siwc-compat.js';

const session = await createChatGPTPlanSession({
  devkitDist:
    process.env.CHATGPT_DEVKIT_DIST ??
    '../sign-in-with-chatgpt-devkit/packages/local/dist',
  credentialStore:
    process.env.CHATGPT_CREDENTIAL_STORE === 'keychain'
      ? 'keychain'
      : 'ephemeral',
  stateDir: process.env.CHATGPT_STATE_DIR || undefined,
  openBrowser: () => {
    throw new Error('The probe never signs in.');
  },
});
const BASE = 'https://api.openai.com/v1';
const results: string[] = [];
const note = (line: string) => {
  results.push(line);
  console.log(line);
};

try {
  const status = await session.status();
  if (status.state !== 'signed_in')
    throw new Error(
      `Not signed in (${status.state}). Sign in first; this probe never does.`,
    );
  note(
    `DevKit: ${session.devkit.package ?? '?'} ${session.devkit.version ?? ''} (${session.devkit.compatibility})`,
  );
  const models = await session.auth.listModels();
  const model =
    process.argv[2] ??
    models.find((m) => m.slug === 'gpt-5.6-luna')?.slug ??
    models[0]?.slug;
  if (!model) throw new Error('This account offers no models.');
  note(`Model: ${model}`);

  const tool = {
    type: 'function',
    name: 'lookup',
    description: 'Look something up.',
    parameters: {
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
      additionalProperties: false,
    },
    strict: true,
  };
  // The first turn is forced to call the tool, so the observation is repeatable.
  const authorized = async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const body = JSON.parse(String(init?.body));
    const answered = JSON.stringify(body.input ?? []).includes(
      'function_call_output',
    );
    body.tool_choice = answered ? 'none' : { type: 'function', name: 'lookup' };
    const headers = new Headers(init?.headers);
    headers.set(
      'Authorization',
      `Bearer ${await session.auth.getAccessToken()}`,
    );
    return fetch(url, { ...init, headers, body: JSON.stringify(body) });
  };

  // 1. The raw stream.
  const response = await authorized(`${BASE}/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content'],
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Use the lookup tool to find the answer to life.',
            },
          ],
        },
      ],
      tools: [tool],
    }),
  });
  if (!response.ok || !response.body)
    throw new Error(`The Responses request failed (HTTP ${response.status}).`);
  const events: Record<string, number> = {};
  let doneCalls = 0;
  let completedOutput: unknown[] | undefined;
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    for (
      let end = buffer.indexOf('\n\n');
      end !== -1;
      end = buffer.indexOf('\n\n')
    ) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block.split('\n').find((l) => l.startsWith('data: '));
      if (!data || data === 'data: [DONE]') continue;
      let event: {
        type?: string;
        item?: { type?: string };
        response?: { output?: unknown[] };
      };
      try {
        event = JSON.parse(data.slice(6));
      } catch {
        continue;
      }
      if (!event.type) continue;
      events[event.type] = (events[event.type] ?? 0) + 1;
      if (
        event.type === 'response.output_item.done' &&
        event.item?.type === 'function_call'
      )
        doneCalls += 1;
      if (event.type === 'response.completed')
        completedOutput = event.response?.output;
    }
  }
  const completedTypes = (completedOutput ?? []).map(
    (item) => (item as { type?: string })?.type,
  );
  note(
    `output_item.done with a function_call: ${doneCalls > 0 ? 'yes' : 'NO'}`,
  );
  note(
    `response.completed.output: ${
      completedOutput === undefined
        ? 'no response.completed event'
        : completedOutput.length === 0
          ? 'EMPTY'
          : `${completedOutput.length} item(s): ${completedTypes.join(', ')}`
    }`,
  );
  const hasCall = completedTypes.includes('function_call');

  // 2. TanStack's agent loop, without and with the shim.
  const loop = async (shim: boolean) => {
    let executions = 0;
    const base = openaiCompatibleText(model, {
      apiKey: 'unused',
      baseURL: BASE,
      api: 'responses',
      maxRetries: 0,
      fetch: authorized as typeof fetch,
    });
    const lookup = toolDefinition({
      name: 'lookup',
      description: 'Look something up.',
      inputSchema: z.object({ q: z.string() }),
    }).server(async () => {
      executions += 1;
      return { answer: 42 };
    });
    const finishReasons: string[] = [];
    let finalChars = 0;
    for await (const chunk of chat({
      adapter: shim ? withSiwcToolCallFinishReason(base) : base,
      messages: [
        {
          role: 'user',
          content:
            'Use the lookup tool to find the answer to life, then say it in one sentence.',
        },
      ],
      tools: [lookup],
      agentLoopStrategy: maxIterations(3),
      modelOptions: { store: false },
    })) {
      if (chunk.type === 'RUN_FINISHED')
        finishReasons.push(
          String(
            (chunk as { metadata?: { tanstack?: { finishReason?: string } } })
              .metadata?.tanstack?.finishReason ??
              (chunk as { finishReason?: string }).finishReason,
          ),
        );
      if (chunk.type === 'TEXT_MESSAGE_CONTENT')
        finalChars += ((chunk as { delta?: string }).delta ?? '').length;
    }
    return { executions, finishReasons, finalChars };
  };
  const without = await loop(false);
  const withShim = await loop(true);
  note(
    `TanStack loop WITHOUT the shim: finish ${without.finishReasons.join(' -> ')}; tool ran ${without.executions}x; final answer ${without.finalChars} chars`,
  );
  note(
    `TanStack loop WITH the shim:    finish ${withShim.finishReasons.join(' -> ')}; tool ran ${withShim.executions}x; final answer ${withShim.finalChars} chars`,
  );

  const needed =
    !hasCall && without.executions === 0 && withShim.executions > 0;
  note(
    needed
      ? 'RESULT: the shim is still needed (the tool only runs with it).'
      : without.executions > 0
        ? 'RESULT: the tool ran WITHOUT the shim; the premise no longer holds, see the removal conditions in docs/CHATGPT_PLAN.md.'
        : 'RESULT: inconclusive; the tool did not run in either loop. Re-run.',
  );
  process.exitCode = needed || without.executions > 0 ? 0 : 1;
} catch (error) {
  console.error(
    'Probe failed:',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
} finally {
  await session.close();
}
