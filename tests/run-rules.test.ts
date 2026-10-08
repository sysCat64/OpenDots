import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BaseEvent } from '@ag-ui/core';
import {
  INTERRUPTION_MESSAGE,
  UNKNOWN_OUTCOME_CONTENT,
  classifyRun,
  declaredToolNames,
  findStaleToolHistory,
  isClientExecuted,
  recoveryEvents,
  type RecoveryKind,
} from '../src/server/run-rules';
import { emittedImports } from './helpers/evaluation-order';
import {
  CLIENT_EXECUTABLE,
  CLIENT_TOOL,
  SERVER_TOOL,
  assistant,
  callEvents,
  custom,
  deepFreeze,
  inputOf,
  reasoningEvents,
  runError,
  runFinished,
  runStarted,
  textEvents,
  toolMessage,
  types,
  user,
} from './helpers/event-fixtures';

// L1 (rule tables) and L8 (pure interlock tests) for docs/LOCAL_FIRST_C4_LANDING_BOUNDARY.md
// sections 11 to 15 and 23. Every function under test is pure: no database,
// no clock, no network.
const classify = (events: BaseEvent[], executable = CLIENT_EXECUTABLE) =>
  classifyRun(deepFreeze(events), executable);
const recover = (events: BaseEvent[], executable = CLIENT_EXECUTABLE) => {
  const frozen = deepFreeze(events);
  return recoveryEvents('t', 'r', frozen, classifyRun(frozen, executable));
};

describe('constants', () => {
  it('fixes the interruption text', () => {
    expect(INTERRUPTION_MESSAGE).toBe(
      'Run interrupted: the server process ended before the run finished.',
    );
  });

  it('fixes the unknown-outcome tool result content', () => {
    expect(JSON.parse(UNKNOWN_OUTCOME_CONTENT)).toEqual({
      outcome: 'unknown',
      reason: 'run_interrupted',
      message:
        'The run was interrupted before the result of this tool call was recorded. The tool may or may not have run. Do not assume that it succeeded or that it failed, and do not retry it automatically: verify its effect before retrying.',
    });
  });
});

describe('DEC-19 / R23: a tool is client-executed only if declared AND server-permitted', () => {
  const declared = (...names: string[]) => new Set(names);

  it('isClientExecuted is the conjunction, over all four cells', () => {
    const permitted = new Set(['x']);
    expect(isClientExecuted('x', declared('x'), permitted)).toBe(true);
    expect(isClientExecuted('x', declared('x'), new Set())).toBe(false);
    expect(isClientExecuted('x', declared(), permitted)).toBe(false);
    expect(isClientExecuted('x', declared(), new Set())).toBe(false);
  });

  it('reads the declared names from the persisted RUN_STARTED input', () => {
    expect(
      declaredToolNames([runStarted(['a', 'b']), ...textEvents('m')]),
    ).toEqual(new Set(['a', 'b']));
    expect(declaredToolNames([runStarted()])).toEqual(new Set());
    expect(declaredToolNames([])).toEqual(new Set());
    expect(
      declaredToolNames([{ type: 'RUN_STARTED' } as unknown as BaseEvent]),
    ).toEqual(new Set());
  });

  // A pending call, END durable and no result, classified for each cell.
  const pending = (declaredTools: string[], executable: ReadonlySet<string>) =>
    classify(
      [runStarted(declaredTools), ...callEvents('c1', CLIENT_TOOL, 1)],
      executable,
    );

  it('A. declared by the client and permitted by the server: client-executed (human-in-the-loop pending)', () => {
    const result = pending([CLIENT_TOOL], new Set([CLIENT_TOOL]));
    expect(result.kind).toBe('client_hitl_pending');
    expect(result.pendingClient.map((c) => c.toolCallId)).toEqual(['c1']);
    expect(result.pendingServer).toEqual([]);
  });

  it('B. declared by the client but not permitted by the server: NOT client-executed', () => {
    for (const executable of [new Set<string>(), new Set(['something_else'])]) {
      const result = pending([CLIENT_TOOL], executable);
      expect(result.kind).toBe('server_unknown_outcome');
      expect(result.pendingClient).toEqual([]);
      expect(result.pendingServer.map((c) => c.toolCallId)).toEqual(['c1']);
    }
  });

  it('C. permitted by the server but not declared by the client: NOT client-executed', () => {
    const result = pending([], new Set([CLIENT_TOOL]));
    expect(result.kind).toBe('server_unknown_outcome');
    expect(result.pendingClient).toEqual([]);
  });

  it('D. neither declared nor permitted: NOT client-executed', () => {
    expect(pending([], new Set()).kind).toBe('server_unknown_outcome');
  });

  it('the client may narrow the permitted set but never widen it', () => {
    const permitted = new Set([CLIENT_TOOL, 'also_permitted']);
    // Narrowing: the client declares only one of the two permitted names.
    const narrowed = classify(
      [runStarted([CLIENT_TOOL]), ...callEvents('c1', 'also_permitted', 1)],
      permitted,
    );
    expect(narrowed.kind).toBe('server_unknown_outcome');
    // Widening: the client declares a server tool's name (the hostile row).
    const widened = classify(
      [runStarted([SERVER_TOOL]), ...callEvents('c1', SERVER_TOOL, 1)],
      permitted,
    );
    expect(widened.kind).toBe('server_unknown_outcome');
    expect(
      recover([runStarted([SERVER_TOOL]), ...callEvents('c1', SERVER_TOOL, 1)])
        ?.status,
    ).toBe('interrupted');
  });

  it('holds no tool name of its own: the permitted set is the only source', () => {
    // An empty server set makes even the real client tool a server tool.
    const events = [
      runStarted([CLIENT_TOOL]),
      ...callEvents('c1', CLIENT_TOOL, 1),
    ];
    expect(classify(events, new Set()).kind).toBe('server_unknown_outcome');
    expect(classify(events, new Set([CLIENT_TOOL])).kind).toBe(
      'client_hitl_pending',
    );
    const source = readFileSync(
      fileURLToPath(new URL('../src/server/run-rules.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toContain(CLIENT_TOOL);
    expect(source).not.toContain(SERVER_TOOL);
    expect(source).not.toMatch(/page-review/);
  });
});

// Section 11: the stored state, the class, what recovery appends, the status.
describe('recovery classes (section 11)', () => {
  const R = runStarted();
  const RC = runStarted([CLIENT_TOOL]);
  const rows: Array<{
    name: string;
    events: BaseEvent[];
    kind: RecoveryKind;
    deferred: boolean;
    appended: string[] | null;
    status?: 'finished' | 'interrupted';
  }> = [
    {
      name: '1. RUN_STARTED only',
      events: [R],
      kind: 'no_tool_lifecycle',
      deferred: false,
      appended: ['RUN_ERROR'],
      status: 'interrupted',
    },
    {
      name: '2. an open text message',
      events: [R, ...textEvents('m1', false)],
      kind: 'open_text_message',
      deferred: false,
      appended: ['TEXT_MESSAGE_END', 'RUN_ERROR'],
      status: 'interrupted',
    },
    {
      name: '3. a server tool call with START/ARGS but no END',
      events: [R, ...callEvents('c1', SERVER_TOOL, 0)],
      kind: 'tool_args_incomplete',
      deferred: false,
      appended: ['TOOL_CALL_END', 'TOOL_CALL_RESULT', 'RUN_ERROR'],
      status: 'interrupted',
    },
    {
      name: '3b. a client tool call with START/ARGS but no END',
      events: [RC, ...callEvents('c1', CLIENT_TOOL, 0)],
      kind: 'tool_args_incomplete',
      deferred: false,
      appended: ['TOOL_CALL_END', 'TOOL_CALL_RESULT', 'RUN_ERROR'],
      status: 'interrupted',
    },
    {
      name: '4. a server tool call with END durable and no result',
      events: [R, ...callEvents('c1', SERVER_TOOL, 1)],
      kind: 'server_unknown_outcome',
      deferred: false,
      appended: ['TOOL_CALL_RESULT', 'RUN_ERROR'],
      status: 'interrupted',
    },
    {
      name: '5. a durable result for every call, no open text, no terminal',
      events: [R, ...callEvents('c1', SERVER_TOOL, 2)],
      kind: 'server_result_durable',
      deferred: false,
      appended: ['RUN_ERROR'],
      status: 'interrupted',
    },
    {
      name: '6. a pending client (HITL) tool call',
      events: [RC, ...callEvents('c1', CLIENT_TOOL, 1)],
      kind: 'client_hitl_pending',
      deferred: false,
      appended: ['RUN_FINISHED'],
      status: 'finished',
    },
    {
      name: '7. only fully closed text (R26a, conditionally approved)',
      events: [R, ...textEvents('m1', true)],
      kind: 'complete_text_no_terminal',
      deferred: false,
      appended: ['RUN_ERROR'],
      status: 'interrupted',
    },
    {
      name: '8. a pending client and a pending server call (R22, open)',
      events: [
        RC,
        ...callEvents('c1', CLIENT_TOOL, 1),
        ...callEvents('c2', SERVER_TOOL, 1),
      ],
      kind: 'mixed_pending_tool_calls',
      deferred: true,
      appended: null,
    },
    {
      name: '9. open text and a pending complete call (R24, open)',
      events: [
        R,
        ...textEvents('m1', false),
        ...callEvents('c1', SERVER_TOOL, 1),
      ],
      kind: 'open_text_with_pending_tool_call',
      deferred: true,
      appended: null,
    },
    {
      name: '9b. an incomplete call and a pending complete call (R24, open)',
      events: [
        R,
        ...callEvents('c1', SERVER_TOOL, 0),
        ...callEvents('c2', SERVER_TOOL, 1),
      ],
      kind: 'open_text_with_pending_tool_call',
      deferred: true,
      appended: null,
    },
    {
      name: '10. anything else with no tool call: reasoning (R26b, open)',
      events: [R, ...reasoningEvents('z1', false)],
      kind: 'unclassified_lifecycle',
      deferred: true,
      appended: null,
    },
  ];

  it.each(rows)('$name', ({ events, kind, deferred, appended, status }) => {
    const classification = classify(events);
    expect(classification.kind).toBe(kind);
    expect(classification.deferred).toBe(deferred);
    const plan = recover(events);
    if (appended === null) {
      // A deferred run writes nothing and stays running.
      expect(plan).toBeNull();
      return;
    }
    expect(types(plan!.appended)).toEqual(appended);
    expect(plan!.status).toBe(status);
  });

  it('never appends RUN_FINISHED to a dead run unless it is a pending client call', () => {
    for (const row of rows) {
      const plan = recover(row.events);
      if (!plan || row.kind === 'client_hitl_pending') continue;
      expect(types(plan.appended), row.name).not.toContain('RUN_FINISHED');
      expect(plan.status, row.name).toBe('interrupted');
    }
  });

  it('always ends an interrupted recovery with RUN_ERROR INCOMPLETE_STREAM and the interruption text', () => {
    for (const row of rows) {
      const plan = recover(row.events);
      if (!plan || plan.status !== 'interrupted') continue;
      expect(plan.appended.at(-1), row.name).toEqual({
        type: 'RUN_ERROR',
        message: INTERRUPTION_MESSAGE,
        code: 'INCOMPLETE_STREAM',
      });
    }
  });

  it('closes an open text message with its own id', () => {
    expect(recover([R, ...textEvents('m1', false)])?.appended[0]).toEqual({
      type: 'TEXT_MESSAGE_END',
      messageId: 'm1',
    });
  });

  it('gives an incomplete call the stock error result, not the unknown-outcome one', () => {
    const plan = recover([R, ...callEvents('c1', SERVER_TOOL, 0)]);
    expect(plan?.appended[1]).toMatchObject({
      type: 'TOOL_CALL_RESULT',
      toolCallId: 'c1',
      messageId: 'c1-result',
      role: 'tool',
    });
  });

  it('represents a server tool with an unknown outcome exactly (section 12), never retrying it', () => {
    const plan = recover([R, ...callEvents('c1', SERVER_TOOL, 1)]);
    expect(plan?.appended[0]).toEqual({
      type: 'TOOL_CALL_RESULT',
      toolCallId: 'c1',
      messageId: 'c1-unknown-outcome',
      role: 'tool',
      content: UNKNOWN_OUTCOME_CONTENT,
    });
    expect(plan?.appended[0]).not.toMatchObject({ messageId: 'c1-result' });
  });

  it('replaces only the pending server results and leaves a durable real result untouched', () => {
    const events = [
      R,
      ...callEvents('c1', SERVER_TOOL, 2),
      ...callEvents('c2', SERVER_TOOL, 1),
      ...callEvents('c3', SERVER_TOOL, 1),
    ];
    const plan = recover(events);
    expect(
      plan?.appended.map((e) => [
        e.type,
        (e as { toolCallId?: string }).toolCallId,
      ]),
    ).toEqual([
      ['TOOL_CALL_RESULT', 'c2'],
      ['TOOL_CALL_RESULT', 'c3'],
      ['RUN_ERROR', undefined],
    ]);
    expect(
      plan?.appended
        .slice(0, 2)
        .map((e) => (e as unknown as { messageId: string }).messageId),
    ).toEqual(['c2-unknown-outcome', 'c3-unknown-outcome']);
  });

  it('repairs a pending client call to the canonical pending form: RUN_FINISHED only, no synthetic result', () => {
    const plan = recover([RC, ...callEvents('c1', CLIENT_TOOL, 1)]);
    expect(plan).toEqual({
      appended: [{ type: 'RUN_FINISHED', threadId: 't', runId: 'r' }],
      status: 'finished',
    });
  });

  it('treats a hostile declaration as a server call, not a pending human step', () => {
    const events = [
      runStarted([SERVER_TOOL]),
      ...callEvents('c1', SERVER_TOOL, 1),
    ];
    expect(classify(events).kind).toBe('server_unknown_outcome');
    const plan = recover(events);
    expect(plan?.status).toBe('interrupted');
    expect(types(plan!.appended)).not.toContain('RUN_FINISHED');
  });

  it('does not mutate the stored events it is given', () => {
    // deepFreeze in the helpers makes any mutation throw; this restates it.
    const events = deepFreeze([R, ...textEvents('m1', false)]);
    const copy = JSON.stringify(events);
    classifyRun(events, CLIENT_EXECUTABLE);
    recoveryEvents('t', 'r', events, classifyRun(events, CLIENT_EXECUTABLE));
    expect(JSON.stringify(events)).toBe(copy);
  });

  it('leaves a run that already holds a terminal event alone (nothing is written)', () => {
    for (const terminal of [runFinished(), runError('x')]) {
      const events = [R, ...textEvents('m1', false), terminal];
      expect(classify(events).deferred).toBe(true);
      expect(recover(events)).toBeNull();
    }
  });

  it('defers an empty or start-less event list', () => {
    expect(classify([]).deferred).toBe(true);
    expect(recover([])).toBeNull();
    expect(classify([...textEvents('m1', true)]).deferred).toBe(true);
  });
});

// R26a is CONDITIONALLY APPROVED (DEC-21). This is only the pure classification
// and the shape of the conservative recovery. It is accepted behaviour only
// after C4b's real-process SIGKILL test passes; R26 stays OPEN and R26b is not
// generalized.
describe('R26a narrow classification (CONDITIONALLY APPROVED, DEC-21)', () => {
  const R = runStarted();
  const eligible = (events: BaseEvent[]) =>
    classify(events).kind === 'complete_text_no_terminal';

  it('accepts closed complete text with no tool call, no other family and no terminal', () => {
    expect(eligible([R, ...textEvents('m1', true)])).toBe(true);
    expect(
      eligible([R, ...textEvents('m1', true), ...textEvents('m2', true)]),
    ).toBe(true);
  });

  it('recovers it conservatively: RUN_ERROR INCOMPLETE_STREAM, status interrupted, never finished', () => {
    const plan = recover([R, ...textEvents('m1', true)]);
    expect(plan).toEqual({
      appended: [
        {
          type: 'RUN_ERROR',
          message: INTERRUPTION_MESSAGE,
          code: 'INCOMPLETE_STREAM',
        },
      ],
      status: 'interrupted',
    });
    expect(plan!.status).not.toBe('finished');
    expect(types(plan!.appended)).not.toContain('RUN_FINISHED');
  });

  it('is not generalized to reasoning (R26b)', () => {
    for (const events of [
      [R, ...reasoningEvents('z1', false)],
      [R, ...reasoningEvents('z1', true)],
      [R, ...reasoningEvents('z1', true), ...textEvents('m1', true)],
      [R, ...textEvents('m1', true), ...reasoningEvents('z1', true)],
    ]) {
      expect(eligible(events)).toBe(false);
      expect(classify(events).kind).toBe('unclassified_lifecycle');
      expect(recover(events)).toBeNull();
    }
  });

  it('is not generalized to state, activity, custom, raw or step events (R26b)', () => {
    const others: Array<Record<string, unknown>> = [
      { type: 'STATE_SNAPSHOT', snapshot: { a: 1 } },
      { type: 'STATE_DELTA', delta: [] },
      { type: 'MESSAGES_SNAPSHOT', messages: [] },
      {
        type: 'ACTIVITY_SNAPSHOT',
        messageId: 'x',
        activityType: 'a',
        content: {},
      },
      { type: 'ACTIVITY_DELTA', messageId: 'x', activityType: 'a', patch: [] },
      { type: 'RAW', event: {} },
      { type: 'STEP_STARTED', stepName: 's' },
      { type: 'STEP_FINISHED', stepName: 's' },
    ];
    for (const other of others) {
      const events = [
        R,
        ...textEvents('m1', true),
        other as unknown as BaseEvent,
      ];
      expect(eligible(events), String(other.type)).toBe(false);
      expect(recover(events), String(other.type)).toBeNull();
    }
    expect(eligible([R, ...textEvents('m1', true), custom()])).toBe(false);
  });

  it('is not generalized to a text chunk event, which has no START/END lifecycle', () => {
    const chunk = {
      type: 'TEXT_MESSAGE_CHUNK',
      messageId: 'm1',
      delta: 'x',
    } as unknown as BaseEvent;
    expect(eligible([R, chunk])).toBe(false);
    expect(eligible([R, ...textEvents('m1', true), chunk])).toBe(false);
  });

  it('requires at least one closed message', () => {
    expect(eligible([R])).toBe(false);
    expect(classify([R]).kind).toBe('no_tool_lifecycle');
  });

  it('counts a message as closed only if the same message was opened', () => {
    const orphanEnd = {
      type: 'TEXT_MESSAGE_END',
      messageId: 'never-opened',
    } as unknown as BaseEvent;
    expect(eligible([R, orphanEnd])).toBe(false);
    // A closed message elsewhere does not make a stray END eligible by itself.
    expect(eligible([R, ...textEvents('m1', false), orphanEnd])).toBe(false);
  });

  it('requires every text message to be closed', () => {
    expect(
      eligible([R, ...textEvents('m1', true), ...textEvents('m2', false)]),
    ).toBe(false);
    expect(
      classify([R, ...textEvents('m1', true), ...textEvents('m2', false)]).kind,
    ).toBe('open_text_message');
  });

  it('excludes any tool-call family', () => {
    for (const upto of [0, 1, 2] as const)
      expect(
        eligible([
          R,
          ...textEvents('m1', true),
          ...callEvents('c1', SERVER_TOOL, upto),
        ]),
      ).toBe(false);
  });

  it('excludes a run that already has a terminal event', () => {
    expect(eligible([R, ...textEvents('m1', true), runFinished()])).toBe(false);
    expect(eligible([R, ...textEvents('m1', true), runError()])).toBe(false);
  });
});

// DEC-5. REJECT iff an input assistant message carries a tool call whose id has
// a durable result in the thread's log and the input has no tool message for it.
describe('stale-tool-result interlock (DEC-5)', () => {
  const held = new Set(['t1', 't2']);

  it('browser stale continuation: rejects', () => {
    expect(
      findStaleToolHistory(inputOf(user('u1'), assistant('a1', 't1')), held),
    ).toBe('t1');
  });

  it('browser complete continuation: accepts', () => {
    expect(
      findStaleToolHistory(
        inputOf(
          user('u1'),
          assistant('a1', 't1'),
          toolMessage('r1', 't1'),
          user('u2'),
        ),
        held,
      ),
    ).toBeNull();
  });

  it('prompt-only headless input: accepts', () => {
    expect(findStaleToolHistory(inputOf(user('u9')), held)).toBeNull();
  });

  it('thread with historical tools but a fresh prompt-only input: accepts', () => {
    // Every scheduled and voice turn on a thread that has ever used a tool.
    expect(
      findStaleToolHistory(inputOf(user('scheduled-1', 'run the task')), held),
    ).toBeNull();
    expect(
      findStaleToolHistory(inputOf(user('a'), user('b')), held),
    ).toBeNull();
    expect(findStaleToolHistory(inputOf(), held)).toBeNull();
  });

  const table: Array<
    [string, ReturnType<typeof inputOf>, ReadonlySet<string>, string | null]
  > = [
    [
      'A. stale tab: assistant tool call present, its recorded result absent',
      inputOf(user('u1'), assistant('a1', 't1')),
      held,
      't1',
    ],
    [
      'B. prompt-only input on a thread that has tool history',
      inputOf(user('u9')),
      held,
      null,
    ],
    [
      'C. complete history: call and result both present',
      inputOf(
        user('u1'),
        assistant('a1', 't1'),
        toolMessage('r1', 't1'),
        user('u2'),
      ),
      held,
      null,
    ],
    [
      'D. two calls in one assistant message, one answered, the unanswered one recorded',
      inputOf(user('u1'), assistant('a1', 't1', 't2'), toolMessage('r1', 't1')),
      held,
      't2',
    ],
    [
      'E. unanswered call whose result the log does not hold (pending client/HITL call)',
      inputOf(user('u1'), assistant('a1', 't9')),
      held,
      null,
    ],
    [
      'F. client supplies the HITL result for a call the log does not hold',
      inputOf(user('u1'), assistant('a1', 't9'), toolMessage('r9', 't9')),
      held,
      null,
    ],
    [
      'G. truncated history that mentions neither the call nor its result',
      inputOf(user('u1'), user('u2')),
      held,
      null,
    ],
    [
      'H. empty log',
      inputOf(user('u1'), assistant('a1', 't1')),
      new Set<string>(),
      null,
    ],
    [
      'I. tool message present, its assistant message omitted',
      inputOf(toolMessage('r1', 't1'), user('u2')),
      held,
      null,
    ],
  ];
  it.each(table)('%s', (_name, input, heldIds, expected) => {
    expect(findStaleToolHistory(input, heldIds)).toBe(expected);
  });

  it('answers by tool call id, not by message position or message id', () => {
    // The tool message for t2 does not answer t1.
    expect(
      findStaleToolHistory(
        inputOf(assistant('a1', 't1'), toolMessage('r', 't2')),
        held,
      ),
    ).toBe('t1');
    // A tool message whose own id equals a call id is not an answer.
    expect(
      findStaleToolHistory(
        inputOf(assistant('a1', 't1'), toolMessage('t1', 'other')),
        held,
      ),
    ).toBe('t1');
  });

  it('ignores assistant messages that carry no tool calls', () => {
    expect(
      findStaleToolHistory(inputOf(user('u'), assistant('a1')), held),
    ).toBeNull();
  });

  it('does not infer the caller: only the input history is consulted', () => {
    // Fields that could label a caller as headless or as a browser change nothing.
    const stale = {
      ...inputOf(user('u1'), assistant('a1', 't1')),
      forwardedProps: { headless: true, caller: 'scheduler' },
      state: { headless: true },
      context: [],
      tools: [],
    };
    expect(findStaleToolHistory(stale, held)).toBe('t1');
    const promptOnly = {
      ...inputOf(user('u9')),
      forwardedProps: { browser: true, caller: 'browser' },
    };
    expect(findStaleToolHistory(promptOnly, held)).toBeNull();
    expect(findStaleToolHistory.length).toBe(2);
  });

  it('does not mutate its arguments', () => {
    const input = deepFreeze(inputOf(user('u1'), assistant('a1', 't1')));
    expect(
      findStaleToolHistory(
        input,
        deepFreeze(new Set(['t1'])) as ReadonlySet<string>,
      ),
    ).toBe('t1');
  });
});

describe('purity', () => {
  const path = 'src/server/run-rules.ts';
  const source = readFileSync(
    fileURLToPath(new URL(`../${path}`, import.meta.url)),
    'utf8',
  );

  it('imports the telemetry guard first and then only the SDK finalizer (no database, file or network module)', () => {
    expect(emittedImports(path, source).staticImports).toEqual([
      './telemetry-guard.js',
      '@copilotkit/runtime/v2',
    ]);
    expect(emittedImports(path, source).dynamicImports).toEqual([]);
  });

  it('performs no I/O, reads no clock and no environment', () => {
    for (const forbidden of [
      /\bfetch\(/,
      /process\.env/,
      /Date\.now/,
      /new Date\(/,
      /Math\.random/,
      /node:/,
      /\.prepare\(/,
      /\.exec\(/,
    ])
      expect(source).not.toMatch(forbidden);
  });
});
