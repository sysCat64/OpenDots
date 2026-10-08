import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  AbstractAgent,
  defaultApplyEvents,
  type BaseEvent,
  type Message,
  type RunAgentInput,
} from '@ag-ui/client';
import {
  AgentRunner,
  InMemoryAgentRunner,
  finalizeRunEvents,
  supportsLocalThreadEndpoints,
} from '@copilotkit/runtime/v2';
import { Observable, lastValueFrom, of, toArray } from 'rxjs';

// L0 for C4 (docs/LOCAL_FIRST_C4_LANDING_BOUNDARY.md, section 21). The dormant
// conversation log and rules depend on a few semi-public corners of
// @copilotkit/runtime. Each is pinned here against the installed package, so an
// SDK change fails this default suite before it can change recovery behaviour.
//
// Nothing here instantiates an AgentRunner or a runtime: the contracts are read
// from the declarations, the sources and the pure functions the SDK exports.
// `ownsThread` is not among them. It is an OpenDots-owned seam of the later
// durable runner (C4b), not part of the SDK's AgentRunner contract.
const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const json = (path: string) => JSON.parse(read(path));
const squash = (text: string) => text.replace(/\s+/g, ' ');

const RUNTIME = 'node_modules/@copilotkit/runtime';
const HANDLERS = `${RUNTIME}/dist/v2/runtime/handlers`;
const RUNNER = `${RUNTIME}/dist/v2/runtime/runner`;

describe('exact @copilotkit/runtime pin (DEC-9, DEC-22)', () => {
  const pkg = json('package.json');
  const lock = json('package-lock.json');
  const spec: string = pkg.dependencies['@copilotkit/runtime'];

  it('is written as the exact version, not a range', () => {
    expect(spec).toBe('1.75.0');
    expect(spec).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('agrees across package.json, the lockfile root, the lockfile entry and the installed package', () => {
    const installed = json(`${RUNTIME}/package.json`).version;
    expect(lock.packages[''].dependencies['@copilotkit/runtime']).toBe(spec);
    expect(lock.packages['node_modules/@copilotkit/runtime'].version).toBe(
      spec,
    );
    expect(installed).toBe(spec);
  });

  it('freezes the finalizer and the AG-UI types the runner uses', () => {
    const entry = lock.packages['node_modules/@copilotkit/runtime'];
    expect(entry.dependencies['@copilotkit/shared']).toBe(spec);
    expect(json('node_modules/@copilotkit/shared/package.json').version).toBe(
      spec,
    );
    expect(entry.dependencies['@ag-ui/client']).toBe('0.0.59');
    expect(json('node_modules/@ag-ui/client/package.json').version).toBe(
      '0.0.59',
    );
    expect(json('node_modules/@ag-ui/core/package.json').version).toBe(
      '0.0.59',
    );
  });

  it('pins only the runtime: core, react-core and channels stay on their ranges (DEC-22)', () => {
    for (const name of [
      '@copilotkit/core',
      '@copilotkit/react-core',
      '@copilotkit/channels',
    ])
      expect(pkg.dependencies[name], name).toMatch(/^\^/);
  });
});

describe('AgentRunner declaration (installed 1.75.0)', () => {
  const declaration = ts.createSourceFile(
    'agent-runner.d.mts',
    read(`${RUNNER}/agent-runner.d.mts`),
    ts.ScriptTarget.ES2023,
    true,
  );
  const classes = declaration.statements.filter(ts.isClassDeclaration);
  const interfaces = declaration.statements.filter(ts.isInterfaceDeclaration);
  const interfaceMembers = (name: string) =>
    interfaces
      .filter((declared) => declared.name.text === name)
      .flatMap((declared) => declared.members)
      .map((member) => ({
        name: (member.name as ts.Identifier).text,
        optional: Boolean(member.questionToken),
        text: squash(member.getText(declaration)),
      }));

  it('has exactly the four abstract methods C4b implements', () => {
    const [runner] = classes.filter(
      (declared) => declared.name?.text === 'AgentRunner',
    );
    const modifiers = (member: ts.ClassElement) =>
      ts.getModifiers(member as ts.HasModifiers)?.map((m) => m.kind) ?? [];
    const abstractMethods = runner.members
      .filter((member) =>
        modifiers(member).includes(ts.SyntaxKind.AbstractKeyword),
      )
      .map((member) => squash(member.getText(declaration)));
    expect(abstractMethods).toEqual([
      'abstract run(request: AgentRunnerRunRequest): Observable<BaseEvent>;',
      'abstract connect(request: AgentRunnerConnectRequest): Observable<BaseEvent>;',
      'abstract isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean>;',
      'abstract stop(request: AgentRunnerStopRequest): Promise<boolean | undefined>;',
    ]);
    // Everything else on the class is the optional capability marker.
    expect(
      runner.members
        .filter(
          (member) =>
            !modifiers(member).includes(ts.SyntaxKind.AbstractKeyword),
        )
        .map((member) => squash(member.getText(declaration))),
    ).toEqual(['readonly ɵsupportsLocalThreadEndpoints?: boolean;']);
  });

  it('keeps the request shapes the runner reads', () => {
    expect(
      interfaceMembers('AgentRunnerRunRequest').map((m) => m.name),
    ).toEqual([
      'threadId',
      'agent',
      'input',
      'persistedInputMessages',
      'authToken',
    ]);
    expect(
      interfaceMembers('AgentRunnerRunRequest')
        .filter((m) => m.optional)
        .map((m) => m.name),
    ).toEqual(['persistedInputMessages', 'authToken']);
    expect(
      interfaceMembers('AgentRunnerConnectRequest').map((m) => m.name),
    ).toEqual(['threadId', 'agentId', 'headers', 'joinCode']);
    expect(
      interfaceMembers('AgentRunnerIsRunningRequest').map((m) => m.name),
    ).toEqual(['threadId']);
    const stop = interfaceMembers('AgentRunnerStopRequest');
    expect(stop.map((m) => m.name)).toEqual(['threadId', 'runId']);
    expect(stop.find((m) => m.name === 'runId')?.optional).toBe(true);
  });

  it('keeps the local-thread endpoint record and the five endpoint methods', () => {
    expect(
      interfaceMembers('LocalThreadEndpointRecord').map((m) => m.text),
    ).toEqual([
      'id: string;',
      'name: string | null;',
      'agentId: string;',
      'organizationId: string;',
      'createdById: string;',
      'archived: boolean;',
      'createdAt: string;',
      'updatedAt: string;',
    ]);
    expect(
      interfaceMembers('LocalThreadEndpointRunner').map((m) => m.text),
    ).toEqual([
      'readonly ɵsupportsLocalThreadEndpoints: true;',
      'listThreads(): LocalThreadEndpointRecord[];',
      'getThreadMessages(threadId: string): Message[];',
      'getThreadEvents(threadId: string): BaseEvent[];',
      'getThreadState(threadId: string): Record<string, unknown> | null;',
      'clearThreads(): void;',
    ]);
  });

  it('exports the runner base class and the in-memory runner the tests compare against', () => {
    expect(typeof AgentRunner).toBe('function');
    expect(typeof InMemoryAgentRunner).toBe('function');
    const methods = Object.getOwnPropertyNames(InMemoryAgentRunner.prototype);
    for (const method of [
      'run',
      'connect',
      'isRunning',
      'stop',
      'listThreads',
      'getThreadMessages',
      'getThreadEvents',
      'getThreadState',
      'clearThreads',
    ])
      expect(methods).toContain(method);
  });
});

describe('local-thread endpoint marker (R10: unversioned and ɵ-prefixed)', () => {
  const runnerLike = (marker: unknown) =>
    ({ ɵsupportsLocalThreadEndpoints: marker }) as unknown as AgentRunner;

  it('is honoured only for the boolean true', () => {
    expect(supportsLocalThreadEndpoints(runnerLike(true))).toBe(true);
    for (const marker of [false, undefined, 'true', 1, {}, null])
      expect(
        supportsLocalThreadEndpoints(runnerLike(marker)),
        String(marker),
      ).toBe(false);
    expect(supportsLocalThreadEndpoints({} as AgentRunner)).toBe(false);
  });

  it('is the property name the SDK source reads', () => {
    expect(squash(read(`${RUNNER}/agent-runner.mjs`))).toContain(
      'return runner.ɵsupportsLocalThreadEndpoints === true;',
    );
  });

  it('selects the local thread methods in the thread handlers and the runtime info', () => {
    const threads = squash(read(`${HANDLERS}/intelligence/threads.mjs`));
    // Listing, clearing, reading messages: each behind the strict marker check.
    expect(threads).toContain(
      'if (supportsLocalThreadEndpoints(runtime.runner)) { const agentId = new URL(request.url).searchParams.get("agentId"); let threads = runtime.runner.listThreads();',
    );
    expect(threads).toContain(
      'if (supportsLocalThreadEndpoints(runtime.runner)) runtime.runner.clearThreads(); return new Response(null, { status: 204 });',
    );
    expect(threads).toContain(
      'if (supportsLocalThreadEndpoints(runtime.runner)) { const mapped = runtime.runner.getThreadMessages(threadId)',
    );
    expect(squash(read(`${HANDLERS}/get-runtime-info.mjs`))).toContain(
      'const hasRestThreadBackend = isIntelligenceRuntime(runtime) || supportsLocalThreadEndpoints(runtime.runner);',
    );
  });
});

describe('what the SDK hands to runner.run (SDK handler contract)', () => {
  // Source anchors. They fix what the framework passes to a runner; the
  // OpenDots ownership decision that consumes it is a separate contract.
  it('sets the route agent id and the body thread id on the cloned agent before running', () => {
    const run = squash(read(`${HANDLERS}/handle-run.mjs`));
    expect(run).toContain('agent.agentId = agentId;');
    expect(run).toContain('agent.setMessages(input.messages);');
    expect(run).toContain('agent.threadId = input.threadId;');
    expect(run.indexOf('agent.agentId = agentId;')).toBeLessThan(
      run.indexOf('return handleSseRun('),
    );
  });

  it('calls runner.run with only threadId, agent and input on the SSE path', () => {
    expect(squash(read(`${HANDLERS}/sse/run.mjs`))).toContain(
      'observableFactory: () => runtime.runner.run({ threadId: input.threadId, agent, input })',
    );
  });

  it('answers a synchronous throw from runner.run with the already-built 200 event stream', () => {
    const sse = squash(read(`${HANDLERS}/shared/sse-response.mjs`));
    expect(sse).toContain('const observable = await observableFactory();');
    expect(sse).toContain('reportAgentError(error, "sse.factory");');
    expect(sse).toContain(
      'return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream"',
    );
  });

  it('stops by thread id and an optional run id', () => {
    expect(squash(read(`${HANDLERS}/handle-stop.mjs`))).toContain(
      'await runtime.runner.stop({ threadId: stopThreadId, ...runId === void 0 ? {} : { runId } })',
    );
  });
});

describe('finalizeRunEvents (the stock finalizer recovery builds on)', () => {
  const INTERRUPTED =
    'Run interrupted: the server process ended before the run finished.';
  const text = (id: string, closed: boolean): BaseEvent[] =>
    [
      { type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta: 'hi' },
      ...(closed ? [{ type: 'TEXT_MESSAGE_END', messageId: id }] : []),
    ] as unknown as BaseEvent[];
  const call = (id: string, upto: 0 | 1 | 2): BaseEvent[] =>
    [
      {
        type: 'TOOL_CALL_START',
        toolCallId: id,
        toolCallName: 'x',
        parentMessageId: 'a',
      },
      { type: 'TOOL_CALL_ARGS', toolCallId: id, delta: '{}' },
      ...(upto >= 1 ? [{ type: 'TOOL_CALL_END', toolCallId: id }] : []),
      ...(upto >= 2
        ? [
            {
              type: 'TOOL_CALL_RESULT',
              toolCallId: id,
              messageId: `${id}-r`,
              role: 'tool',
              content: '{}',
            },
          ]
        : []),
    ] as unknown as BaseEvent[];
  const finalize = (events: BaseEvent[], options = {}) =>
    finalizeRunEvents([...events], options);
  const types = (events: BaseEvent[]) => events.map((event) => event.type);

  it('closes an open text message and ends with RUN_ERROR INCOMPLETE_STREAM', () => {
    const appended = finalize(text('m', false), {
      interruptionMessage: INTERRUPTED,
    });
    expect(appended).toEqual([
      { type: 'TEXT_MESSAGE_END', messageId: 'm' },
      { type: 'RUN_ERROR', message: INTERRUPTED, code: 'INCOMPLETE_STREAM' },
    ]);
  });

  it('appends only RUN_ERROR to fully closed text (the shape R26a recovery relies on)', () => {
    expect(
      finalize([...text('m1', true), ...text('m2', true)], {
        interruptionMessage: INTERRUPTED,
      }),
    ).toEqual([
      { type: 'RUN_ERROR', message: INTERRUPTED, code: 'INCOMPLETE_STREAM' },
    ]);
  });

  it('closes a tool call that never ended, with a stock error result', () => {
    const appended = finalize(call('t1', 0), {
      interruptionMessage: INTERRUPTED,
    });
    expect(types(appended)).toEqual([
      'TOOL_CALL_END',
      'TOOL_CALL_RESULT',
      'RUN_ERROR',
    ]);
    expect(appended[1]).toMatchObject({
      toolCallId: 't1',
      messageId: 't1-result',
      role: 'tool',
    });
  });

  it('writes a stock error result for an ended call with no result (recovery replaces it for server tools)', () => {
    const appended = finalize(call('t1', 1), {
      interruptionMessage: INTERRUPTED,
    });
    expect(types(appended)).toEqual(['TOOL_CALL_RESULT', 'RUN_ERROR']);
    expect(
      JSON.parse((appended[0] as unknown as { content: string }).content),
    ).toMatchObject({ status: 'error', reason: 'missing_terminal_event' });
  });

  it('appends only RUN_ERROR when every call already has its result', () => {
    expect(types(finalize(call('t1', 2)))).toEqual(['RUN_ERROR']);
  });

  it('on a stop request closes and ends with RUN_FINISHED, never RUN_ERROR', () => {
    expect(types(finalize(text('m', false), { stopRequested: true }))).toEqual([
      'TEXT_MESSAGE_END',
      'RUN_FINISHED',
    ]);
  });

  it('does not close an open reasoning lifecycle: it appends only RUN_ERROR (why R26b stays open)', () => {
    const reasoning = [
      { type: 'REASONING_START', messageId: 'z' },
      { type: 'REASONING_MESSAGE_START', messageId: 'z', role: 'reasoning' },
      { type: 'REASONING_MESSAGE_CONTENT', messageId: 'z', delta: '..' },
    ] as unknown as BaseEvent[];
    expect(types(finalize(reasoning))).toEqual(['RUN_ERROR']);
  });

  it('is a no-op once a terminal event was observed', () => {
    expect(
      finalize([...text('m', true), { type: 'RUN_FINISHED' } as BaseEvent]),
    ).toEqual([]);
    expect(
      finalize([...text('m', false), { type: 'RUN_ERROR' } as BaseEvent]),
    ).toEqual([]);
  });
});

describe('the public reducer folds stored events into messages', () => {
  class StateAgent extends AbstractAgent {
    run(): Observable<BaseEvent> {
      return of();
    }
  }
  const input: RunAgentInput = {
    threadId: 't',
    runId: 'r',
    state: {},
    messages: [],
    tools: [],
    context: [],
    forwardedProps: {},
  };
  const fold = async (events: BaseEvent[]): Promise<Message[]> => {
    const mutations = await lastValueFrom(
      defaultApplyEvents(input, of(...events), new StateAgent(), []).pipe(
        toArray(),
      ),
    );
    let messages: Message[] = [];
    for (const mutation of mutations)
      if (mutation && 'messages' in mutation && mutation.messages)
        messages = mutation.messages as Message[];
    return messages;
  };

  it('derives user, assistant text, tool call and tool result messages', async () => {
    const messages = await fold([
      {
        type: 'RUN_STARTED',
        threadId: 't',
        runId: 'r',
        input: {
          ...input,
          messages: [{ id: 'u1', role: 'user', content: 'hello' }],
        },
      },
      { type: 'TEXT_MESSAGE_START', messageId: 'a1', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: 'Hi ' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: 'there' },
      { type: 'TEXT_MESSAGE_END', messageId: 'a1' },
      {
        type: 'TOOL_CALL_START',
        toolCallId: 'c1',
        toolCallName: 'lookup',
        parentMessageId: 'a1',
      },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: '{"q":1}' },
      { type: 'TOOL_CALL_END', toolCallId: 'c1' },
      {
        type: 'TOOL_CALL_RESULT',
        toolCallId: 'c1',
        messageId: 'c1-r',
        role: 'tool',
        content: '{"ok":true}',
      },
      { type: 'RUN_FINISHED', threadId: 't', runId: 'r' },
    ] as unknown as BaseEvent[]);
    expect(messages).toEqual([
      { id: 'u1', role: 'user', content: 'hello' },
      {
        id: 'a1',
        role: 'assistant',
        content: 'Hi there',
        toolCalls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"q":1}' },
          },
        ],
      },
      { id: 'c1-r', role: 'tool', content: '{"ok":true}', toolCallId: 'c1' },
    ]);
  });
});
