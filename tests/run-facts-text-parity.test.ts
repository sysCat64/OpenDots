import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { BaseEvent, Message } from '@ag-ui/core';
import { afterEach, describe, expect, it } from 'vitest';
import { foldEvents } from '../src/server/conversation-log';
import { currentTurnText } from '../src/server/headless';
import { runLocalTurn } from '../src/server/headless-local';
import { ownAssistantText } from '../src/server/run-facts';
import {
  AGENT_ID,
  createHarness,
  type Harness,
} from './helpers/runner-harness';
import {
  ScriptedAgent,
  finished,
  textMessage,
  toolCall,
  toolResult,
} from './helpers/scripted-agent';

// UD2: terminal text extraction preserves the existing currentTurnText
// semantics. The run's text is "the last assistant message the run created,
// when its content is a non-blank string"; anything else is "no text" and an
// earlier message is never substituted. The SDK reducer (foldEvents, the
// production derivation of the message view) is the oracle, and currentTurnText
// itself and the real adapter are exercised directly.
const root = fileURLToPath(new URL('../', import.meta.url));
const ev = (value: Record<string, unknown>) => value as unknown as BaseEvent;

// The text currentTurnText yields for the messages a run created, or undefined
// when it throws "no assistant response".
async function oracle(events: BaseEvent[]): Promise<string | undefined> {
  const folded: Message[] = await foldEvents(events);
  const start = events[0] as unknown as {
    input: { messages: Array<{ id: string }> };
  };
  const known = new Set(start.input.messages.map((m) => m.id));
  const fresh = folded.filter((m) => !known.has(m.id));
  try {
    return currentTurnText(fresh);
  } catch {
    return undefined;
  }
}

const started = (
  n: number,
  messages: Array<Record<string, unknown>> = [
    { id: `u${n}`, role: 'user', content: 'hi' },
  ],
) =>
  ev({
    type: 'RUN_STARTED',
    threadId: 't',
    runId: `r${n}`,
    input: {
      threadId: 't',
      runId: `r${n}`,
      state: {},
      messages,
      tools: [],
      context: [],
      forwardedProps: {},
    },
  });

describe('ownAssistantText equals the SDK reducer under currentTurnText', () => {
  const cases: Array<[string, BaseEvent[]]> = [
    [
      'one message',
      [
        started(1),
        ev({ type: 'TEXT_MESSAGE_START', messageId: 'a', role: 'assistant' }),
        ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'a', delta: 'hello' }),
        ev({ type: 'TEXT_MESSAGE_END', messageId: 'a' }),
      ],
    ],
    [
      'content in several deltas',
      [
        started(2),
        ev({ type: 'TEXT_MESSAGE_START', messageId: 'a', role: 'assistant' }),
        ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'a', delta: 'he' }),
        ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'a', delta: 'llo' }),
        ev({ type: 'TEXT_MESSAGE_END', messageId: 'a' }),
      ],
    ],
    [
      'two messages: the last one',
      [
        started(3),
        ...['a', 'b'].flatMap((id, i) => [
          ev({ type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' }),
          ev({
            type: 'TEXT_MESSAGE_CONTENT',
            messageId: id,
            delta: `m${i}`,
          }),
          ev({ type: 'TEXT_MESSAGE_END', messageId: id }),
        ]),
      ],
    ],
    [
      'the last message is blank: no text, not the earlier one',
      [
        started(4),
        ev({ type: 'TEXT_MESSAGE_START', messageId: 'a', role: 'assistant' }),
        ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'a', delta: 'real' }),
        ev({ type: 'TEXT_MESSAGE_END', messageId: 'a' }),
        ev({ type: 'TEXT_MESSAGE_START', messageId: 'b', role: 'assistant' }),
        ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'b', delta: '  ' }),
        ev({ type: 'TEXT_MESSAGE_END', messageId: 'b' }),
      ],
    ],
    [
      'the last assistant message only carries a tool call',
      [
        started(5),
        ev({ type: 'TEXT_MESSAGE_START', messageId: 'a', role: 'assistant' }),
        ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'a', delta: 'real' }),
        ev({ type: 'TEXT_MESSAGE_END', messageId: 'a' }),
        ev({
          type: 'TOOL_CALL_START',
          toolCallId: 'c',
          toolCallName: 'read_space_page',
          parentMessageId: 'p',
        }),
        ev({ type: 'TOOL_CALL_ARGS', toolCallId: 'c', delta: '{}' }),
        ev({ type: 'TOOL_CALL_END', toolCallId: 'c' }),
      ],
    ],
    [
      'a tool call without a parent message',
      [
        started(6),
        ev({
          type: 'TOOL_CALL_START',
          toolCallId: 'c',
          toolCallName: 'read_space_page',
        }),
        ev({ type: 'TOOL_CALL_END', toolCallId: 'c' }),
      ],
    ],
    [
      'a message of another role',
      [
        started(7),
        ev({ type: 'TEXT_MESSAGE_START', messageId: 'a', role: 'user' }),
        ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'a', delta: 'echo' }),
        ev({ type: 'TEXT_MESSAGE_END', messageId: 'a' }),
      ],
    ],
    ['no message at all', [started(8)]],
    [
      'a message start without a role is an assistant message',
      [
        started(9),
        ev({ type: 'TEXT_MESSAGE_START', messageId: 'a' }),
        ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'a', delta: 'no role' }),
        ev({ type: 'TEXT_MESSAGE_END', messageId: 'a' }),
      ],
    ],
    [
      'content for a message of the input history is not the run answer',
      [
        started(10, [
          { id: 'u10', role: 'user', content: 'hi' },
          { id: 'old', role: 'assistant', content: 'from before' },
        ]),
        ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'old', delta: ' more' }),
      ],
    ],
    [
      'a tool call hosted by an assistant message of the input history',
      [
        started(11, [
          { id: 'u11', role: 'user', content: 'hi' },
          { id: 'old', role: 'assistant', content: 'from before' },
        ]),
        ev({
          type: 'TOOL_CALL_START',
          toolCallId: 'c',
          toolCallName: 'read_space_page',
          parentMessageId: 'old',
        }),
        ev({ type: 'TOOL_CALL_END', toolCallId: 'c' }),
      ],
    ],
    [
      'a tool call whose parent is a user message gets its own assistant message',
      [
        started(12),
        ev({
          type: 'TOOL_CALL_START',
          toolCallId: 'c',
          toolCallName: 'read_space_page',
          parentMessageId: 'u12',
        }),
        ev({ type: 'TOOL_CALL_END', toolCallId: 'c' }),
      ],
    ],
    [
      'a text message after the tool call that created its parent',
      [
        started(13),
        ev({
          type: 'TOOL_CALL_START',
          toolCallId: 'c',
          toolCallName: 'read_space_page',
          parentMessageId: 'p',
        }),
        ev({ type: 'TOOL_CALL_END', toolCallId: 'c' }),
        ev({ type: 'TEXT_MESSAGE_START', messageId: 'p', role: 'assistant' }),
        ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'p', delta: 'joined' }),
        ev({ type: 'TEXT_MESSAGE_END', messageId: 'p' }),
      ],
    ],
    [
      'the same tool call id started twice creates no second message',
      [
        started(14),
        ev({ type: 'TEXT_MESSAGE_START', messageId: 'a', role: 'assistant' }),
        ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'a', delta: 'answer' }),
        ev({ type: 'TEXT_MESSAGE_END', messageId: 'a' }),
        ev({
          type: 'TOOL_CALL_START',
          toolCallId: 'c',
          toolCallName: 'x',
          parentMessageId: 'a',
        }),
        ev({
          type: 'TOOL_CALL_START',
          toolCallId: 'c',
          toolCallName: 'x',
          parentMessageId: 'b',
        }),
      ],
    ],
    [
      'a messages snapshot that replaces and appends',
      [
        started(15),
        ev({ type: 'TEXT_MESSAGE_START', messageId: 'a', role: 'assistant' }),
        ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'a', delta: 'one' }),
        ev({ type: 'TEXT_MESSAGE_END', messageId: 'a' }),
        ev({
          type: 'MESSAGES_SNAPSHOT',
          messages: [
            { id: 'u15', role: 'user', content: 'hi' },
            { id: 'a', role: 'assistant', content: 'replaced' },
            { id: 'z', role: 'assistant', content: 'appended' },
          ],
        }),
      ],
    ],
    [
      'a messages snapshot that drops the run messages',
      [
        started(16),
        ev({ type: 'TEXT_MESSAGE_START', messageId: 'a', role: 'assistant' }),
        ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'a', delta: 'gone' }),
        ev({ type: 'TEXT_MESSAGE_END', messageId: 'a' }),
        ev({
          type: 'MESSAGES_SNAPSHOT',
          messages: [{ id: 'u16', role: 'user', content: 'hi' }],
        }),
      ],
    ],
    [
      'an activity snapshot that takes over an assistant message id',
      [
        started(17),
        ev({ type: 'TEXT_MESSAGE_START', messageId: 'a', role: 'assistant' }),
        ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'a', delta: 'taken' }),
        ev({ type: 'TEXT_MESSAGE_END', messageId: 'a' }),
        ev({
          type: 'ACTIVITY_SNAPSHOT',
          messageId: 'a',
          activityType: 'x',
          content: { k: 1 },
        }),
      ],
    ],
    [
      'a reasoning content event that names an assistant message',
      [
        started(18),
        ev({ type: 'TEXT_MESSAGE_START', messageId: 'a', role: 'assistant' }),
        ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'a', delta: 'x' }),
        ev({ type: 'TEXT_MESSAGE_END', messageId: 'a' }),
        ev({
          type: 'REASONING_MESSAGE_CONTENT',
          messageId: 'a',
          delta: ' + thought',
        }),
      ],
    ],
    [
      'state, custom and step events change nothing',
      [
        started(19),
        ev({ type: 'STEP_STARTED', stepName: 's' }),
        ev({ type: 'TEXT_MESSAGE_START', messageId: 'a', role: 'assistant' }),
        ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'a', delta: 'kept' }),
        ev({ type: 'TEXT_MESSAGE_END', messageId: 'a' }),
        ev({ type: 'STATE_SNAPSHOT', snapshot: { a: 1 } }),
        ev({ type: 'CUSTOM', name: 'n', value: 1 }),
        ev({ type: 'STEP_FINISHED', stepName: 's' }),
      ],
    ],
  ];

  it.each(cases)('%s', async (_label, events) => {
    expect(ownAssistantText(events.slice(1))).toBe(await oracle(events));
  });

  it('agrees on 600 generated runs', async () => {
    let seed = 20261012;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
    let withText = 0;
    let withoutText = 0;
    for (let n = 0; n < 600; n++) {
      const events: BaseEvent[] = [started(n)];
      for (let m = 0; m < 1 + Math.floor(rnd() * 4); m++) {
        const id = `m${n}-${m}`;
        const kind = pick([
          'assistant',
          'assistant',
          'assistant',
          'tool-only',
          'reasoning',
          'state',
          'user-role',
          'blank',
          'text-then-tool',
          'tool-no-parent',
          'no-role',
          'snapshot',
          'activity-takeover',
          'reasoning-onto-assistant',
        ]);
        if (['assistant', 'blank', 'user-role'].includes(kind)) {
          events.push(
            ev({
              type: 'TEXT_MESSAGE_START',
              messageId: id,
              role: kind === 'user-role' ? 'user' : 'assistant',
            }),
          );
          for (
            let p = 0;
            p < (kind === 'blank' ? 1 : 1 + Math.floor(rnd() * 3));
            p++
          )
            events.push(
              ev({
                type: 'TEXT_MESSAGE_CONTENT',
                messageId: id,
                delta:
                  kind === 'blank'
                    ? '  '
                    : pick(['alpha', 'beta ', 'γ', '{"j":1}', '\n']),
              }),
            );
          if (rnd() < 0.85)
            events.push(ev({ type: 'TEXT_MESSAGE_END', messageId: id }));
        } else if (kind === 'text-then-tool') {
          events.push(
            ev({
              type: 'TEXT_MESSAGE_START',
              messageId: id,
              role: 'assistant',
            }),
            ev({
              type: 'TEXT_MESSAGE_CONTENT',
              messageId: id,
              delta: 'checking',
            }),
            ev({ type: 'TEXT_MESSAGE_END', messageId: id }),
            ev({
              type: 'TOOL_CALL_START',
              toolCallId: `c${n}-${m}`,
              toolCallName: 'read_space_page',
              parentMessageId: id,
            }),
            ev({ type: 'TOOL_CALL_END', toolCallId: `c${n}-${m}` }),
          );
        } else if (kind === 'tool-no-parent') {
          events.push(
            ev({
              type: 'TOOL_CALL_START',
              toolCallId: `c${n}-${m}`,
              toolCallName: 'read_space_page',
            }),
            ev({ type: 'TOOL_CALL_END', toolCallId: `c${n}-${m}` }),
          );
        } else if (kind === 'tool-only') {
          events.push(
            ev({
              type: 'TOOL_CALL_START',
              toolCallId: `c${n}-${m}`,
              toolCallName: 'read_space_page',
              parentMessageId: id,
            }),
            ev({ type: 'TOOL_CALL_END', toolCallId: `c${n}-${m}` }),
            ev({
              type: 'TOOL_CALL_RESULT',
              toolCallId: `c${n}-${m}`,
              messageId: `${id}-r`,
              role: 'tool',
              content: '{"ok":true}',
            }),
          );
        } else if (kind === 'reasoning') {
          events.push(
            ev({ type: 'REASONING_START', messageId: id }),
            ev({
              type: 'REASONING_MESSAGE_START',
              messageId: id,
              role: 'reasoning',
            }),
            ev({
              type: 'REASONING_MESSAGE_CONTENT',
              messageId: id,
              delta: 'think',
            }),
            ev({ type: 'REASONING_MESSAGE_END', messageId: id }),
            ev({ type: 'REASONING_END', messageId: id }),
          );
        } else if (kind === 'no-role') {
          events.push(
            ev({ type: 'TEXT_MESSAGE_START', messageId: id }),
            ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta: 'nr' }),
          );
        } else if (kind === 'snapshot') {
          // Replaces whatever the run built so far with a fixed list.
          const keep = rnd() < 0.5;
          events.push(
            ev({
              type: 'MESSAGES_SNAPSHOT',
              messages: [
                { id: `u${n}`, role: 'user', content: 'hi' },
                ...(keep
                  ? [{ id: `s${n}-${m}`, role: 'assistant', content: 'snap' }]
                  : []),
              ],
            }),
          );
        } else if (kind === 'activity-takeover') {
          events.push(
            ev({
              type: 'ACTIVITY_SNAPSHOT',
              messageId: `m${n}-${Math.floor(rnd() * 3)}`,
              activityType: 'x',
              content: { k: m },
            }),
          );
        } else if (kind === 'reasoning-onto-assistant') {
          events.push(
            ev({
              type: 'REASONING_MESSAGE_CONTENT',
              messageId: `m${n}-${Math.floor(rnd() * 3)}`,
              delta: '+r',
            }),
          );
        } else events.push(ev({ type: 'STATE_SNAPSHOT', snapshot: { n } }));
      }
      const expected = await oracle(events);
      const actual = ownAssistantText(events.slice(1));
      if (actual !== expected)
        throw new Error(
          `run ${n}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`,
        );
      if (expected === undefined) withoutText++;
      else withText++;
    }
    // The generator exercises both outcomes, so agreement is not vacuous.
    expect(withText).toBeGreaterThan(50);
    expect(withoutText).toBeGreaterThan(50);
  });
});

describe('terminalResult text equals what the real adapter returns', () => {
  const harnesses: Harness[] = [];
  afterEach(() => {
    while (harnesses.length) harnesses.pop()!.cleanup();
  });

  const scripts: Array<
    [
      string,
      (
        i: Parameters<ConstructorParameters<typeof ScriptedAgent>[0]>[0],
      ) => Array<Record<string, unknown>>,
    ]
  > = [
    ['one message', (i) => [...textMessage('a1', 'plain answer'), finished(i)]],
    [
      'several messages',
      (i) => [
        ...textMessage('a1', 'first'),
        ...textMessage('a2', 'final answer'),
        finished(i),
      ],
    ],
    [
      'text, a tool call and its answer',
      (i) => [
        ...textMessage('a1', 'looking'),
        ...toolCall('c1', 'read_space_page', 'a2'),
        toolResult('c1'),
        ...textMessage('a3', 'found it'),
        finished(i),
      ],
    ],
  ];

  it.each(scripts)('%s', async (_label, script) => {
    const h = createHarness();
    harnesses.push(h);
    const text = await runLocalTurn(
      {
        runner: h.runner,
        dotIdOf: () => AGENT_ID,
        agentFor: () => new ScriptedAgent(script),
        newId: () => 'run-1',
      },
      'thread-1',
      'prompt',
      new AbortController().signal,
    );
    const result = h.runner.facts.terminalResult({
      threadId: 'thread-1',
      runId: 'run-1',
      agentId: AGENT_ID,
    });
    expect(result).toMatchObject({ available: true, outcome: 'success', text });
  });

  it('a turn the adapter fails as "no assistant response" is finished_without_text', async () => {
    const h = createHarness();
    harnesses.push(h);
    await expect(
      runLocalTurn(
        {
          runner: h.runner,
          dotIdOf: () => AGENT_ID,
          agentFor: () => new ScriptedAgent((i) => [finished(i)]),
          newId: () => 'run-1',
        },
        'thread-1',
        'prompt',
        new AbortController().signal,
      ),
    ).rejects.toThrow(/no assistant response/);
    expect(
      h.runner.facts.terminalResult({
        threadId: 'thread-1',
        runId: 'run-1',
        agentId: AGENT_ID,
      }),
    ).toMatchObject({ available: true, outcome: 'finished_without_text' });
  });
});

describe('the SDK versions the parity was established on', () => {
  const json = (path: string) =>
    JSON.parse(readFileSync(join(root, path), 'utf8')) as { version: string };

  // If one of these fails, an SDK upgrade changed the reducer or the AG-UI
  // message model underneath ownAssistantText. Re-run the parity above on
  // the new versions and update this pin in the same change.
  it('pins the reducer and the message model', () => {
    expect(json('node_modules/@ag-ui/client/package.json').version).toBe(
      '0.0.59',
    );
    expect(json('node_modules/@ag-ui/core/package.json').version).toBe(
      '0.0.59',
    );
    expect(json('node_modules/@copilotkit/runtime/package.json').version).toBe(
      '1.75.0',
    );
  });
});
