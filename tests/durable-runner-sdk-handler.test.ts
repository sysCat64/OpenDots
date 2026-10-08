import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentRunner,
  CopilotSseRuntime,
  createCopilotRuntimeHandler,
  type AgentRunnerRunRequest,
} from '@copilotkit/runtime/v2';
import type { BaseEvent } from '@ag-ui/core';
import { of } from 'rxjs';
import { snapshotDatabase } from './helpers/db-snapshot';
import { user } from './helpers/event-fixtures';
import {
  createHarness,
  runInput,
  type Harness,
} from './helpers/runner-harness';
import { ScriptedAgent, finished, textMessage } from './helpers/scripted-agent';

// The real installed CopilotSseRuntime, offline, behind its real fetch handler.
// Three distinct contracts are kept apart here:
//  A. the SDK handler contract: what the framework hands to runner.run;
//  B. the OpenDots ownsThread predicate, tested on its own in
//     durable-runner.test.ts (an OpenDots seam, never attributed to the SDK);
//  C. the integration: the identity the handler really supplies is what the
//     OpenDots predicate receives and decides on.
// No network: the handler is called as a function with a Request.
const harnesses: Harness[] = [];
let network: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  network = vi.spyOn(globalThis, 'fetch');
});
afterEach(() => {
  // The handler is a function called with a Request: nothing may go out.
  expect(network).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  for (const harness of harnesses.splice(0)) harness.cleanup();
});

// A recording runner double: it keeps exactly what the handler gave it.
class RecordingRunner extends AgentRunner {
  readonly requests: AgentRunnerRunRequest[] = [];
  readonly stops: unknown[] = [];
  clears = 0;
  readonly ɵsupportsLocalThreadEndpoints = true as const;
  run(request: AgentRunnerRunRequest) {
    this.requests.push(request);
    return of(
      {
        type: 'RUN_STARTED',
        threadId: request.threadId,
        runId: request.input.runId,
      } as unknown as BaseEvent,
      {
        type: 'RUN_FINISHED',
        threadId: request.threadId,
        runId: request.input.runId,
      } as unknown as BaseEvent,
    );
  }
  connect() {
    return of();
  }
  async isRunning() {
    return false;
  }
  async stop(request: unknown) {
    this.stops.push(request);
    return false;
  }
  listThreads() {
    return [];
  }
  getThreadMessages() {
    return [];
  }
  getThreadEvents() {
    return [];
  }
  getThreadState() {
    return null;
  }
  clearThreads() {
    this.clears += 1;
  }
}

const BASE = 'http://opendots.test/api/copilotkit';
const handlerFor = (
  runner: AgentRunner,
  agentId: string,
  agent: ScriptedAgent,
) => {
  const runtime = new CopilotSseRuntime({
    agents: { [agentId]: agent },
    runner,
  });
  return createCopilotRuntimeHandler({ runtime, basePath: '/api/copilotkit' });
};
const post = (path: string, body: unknown) =>
  new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('A. the SDK handler contract (real CopilotSseRuntime, recording runner)', () => {
  it('hands runner.run exactly threadId, agent and input, with the route agent id and the body thread id', async () => {
    const runner = new RecordingRunner();
    const handler = handlerFor(
      runner,
      'dot-route',
      new ScriptedAgent(() => []),
    );
    const body = runInput('thread-body', 'run-body', [user('m1', 'hello')]);
    const response = await handler(post('/agent/dot-route/run', body));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    await response.text();

    expect(runner.requests).toHaveLength(1);
    const [request] = runner.requests;
    expect(Object.keys(request).sort()).toEqual(['agent', 'input', 'threadId']);
    expect(request.threadId).toBe('thread-body');
    expect(request.threadId).toBe(request.input.threadId);
    expect(request.agent.agentId).toBe('dot-route');
    expect(request.agent.threadId).toBe('thread-body');
    expect(request.input.runId).toBe('run-body');
    expect(request.input.messages).toEqual(body.messages);
    expect(request.agent.messages).toEqual(body.messages);
    expect(request.authToken).toBeUndefined();
    expect(request.persistedInputMessages).toBeUndefined();
  });

  it('hands the agent a per-request clone, not the registered instance', async () => {
    const runner = new RecordingRunner();
    const registered = new ScriptedAgent(() => []);
    const handler = handlerFor(runner, 'dot-route', registered);
    await (
      await handler(
        post('/agent/dot-route/run', runInput('t', 'r', [user('m')])),
      )
    ).text();
    expect(runner.requests[0].agent).not.toBe(registered);
  });

  it('takes the agent id from the route, never from the body', async () => {
    const runner = new RecordingRunner();
    const handler = handlerFor(
      runner,
      'dot-route',
      new ScriptedAgent(() => []),
    );
    await (
      await handler(
        post('/agent/dot-route/run', {
          ...runInput('t', 'r', [user('m')]),
          agentId: 'dot-forged',
          forwardedProps: { agentId: 'dot-forged' },
        }),
      )
    ).text();
    expect(runner.requests[0].agent.agentId).toBe('dot-route');
  });

  it('calls stop with the thread id from the route and the optional run id', async () => {
    const runner = new RecordingRunner();
    const handler = handlerFor(
      runner,
      'dot-route',
      new ScriptedAgent(() => []),
    );
    await handler(post('/agent/dot-route/stop/thread-9', {}));
    expect(runner.stops).toEqual([{ threadId: 'thread-9' }]);
  });

  it('answers a synchronous rejection from run() with a 200 event stream that carries nothing (why DEC-13 must close the race at C6)', async () => {
    class Rejecting extends RecordingRunner {
      override run(): never {
        throw new Error('rejected');
      }
    }
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = handlerFor(
      new Rejecting(),
      'dot-route',
      new ScriptedAgent(() => []),
    );
    const response = await handler(
      post('/agent/dot-route/run', runInput('t', 'r', [user('m')])),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });
});

describe('C. the identity the handler supplies is what the ownership seam receives', () => {
  const durable = (
    ownsThread: (threadId: string, agentId: string) => boolean,
  ) => {
    const h = createHarness({ ownsThread });
    harnesses.push(h);
    return h;
  };

  it('asks ownsThread with the body thread id and the route agent id, and runs when it is owned', async () => {
    const asked: Array<[string, string]> = [];
    const h = durable((threadId, agentId) => {
      asked.push([threadId, agentId]);
      return threadId === 'thread-1' && agentId === 'dot-route';
    });
    const agent = new ScriptedAgent((input) => [
      ...textMessage('a1', 'hi'),
      finished(input),
    ]);
    const handler = handlerFor(h.runner, 'dot-route', agent);
    const response = await handler(
      post('/agent/dot-route/run', runInput('thread-1', 'run-1', [user('m1')])),
    );
    const text = await response.text();
    expect(asked).toEqual([['thread-1', 'dot-route']]);
    expect(text).toContain('RUN_FINISHED');
    expect(h.log.getRun('thread-1', 'run-1')).toMatchObject({
      status: 'finished',
      agentId: 'dot-route',
    });
  });

  it('refuses a thread the route agent does not own: nothing written, no model call, an empty stream', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = durable(
      (threadId, agentId) => agentId === 'dot-owner' && threadId === 'thread-1',
    );
    const agent = new ScriptedAgent((input) => [
      ...textMessage('a1', 'hi'),
      finished(input),
    ]);
    const handler = handlerFor(h.runner, 'dot-intruder', agent);
    h.log.ensureSchema();
    const before = snapshotDatabase(h.throwaway.path);
    const response = await handler(
      post(
        '/agent/dot-intruder/run',
        runInput('thread-1', 'run-1', [user('m1')]),
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(agent.stats.invocations).toBe(0);
    expect(snapshotDatabase(h.throwaway.path)).toBe(before);
  });

  it('runs a second run of the same thread through the handler and replays both through connect', async () => {
    const h = durable(() => true);
    const agent = new ScriptedAgent((input) => [
      ...textMessage(`a-${input.runId}`, 'x'),
      finished(input),
    ]);
    const handler = handlerFor(h.runner, 'dot-route', agent);
    for (const runId of ['run-1', 'run-2'])
      await (
        await handler(
          post(
            '/agent/dot-route/run',
            runInput('thread-1', runId, [user(`m-${runId}`)]),
          ),
        )
      ).text();
    const connected = await (
      await handler(
        post('/agent/dot-route/connect', runInput('thread-1', 'conn', [])),
      )
    ).text();
    expect(connected.match(/"type":"RUN_STARTED"/g)).toHaveLength(2);
  });
});

describe('clearThreads through the real handler (DEC-16 defence in depth)', () => {
  it('answers an error and deletes nothing, though the handler calls it unguarded', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = createHarness();
    harnesses.push(h);
    const agent = new ScriptedAgent((input) => [
      ...textMessage('a1', 'x'),
      finished(input),
    ]);
    const handler = handlerFor(h.runner, 'dot-route', agent);
    await (
      await handler(
        post(
          '/agent/dot-route/run',
          runInput('thread-1', 'run-1', [user('m1')]),
        ),
      )
    ).text();
    const before = snapshotDatabase(h.throwaway.path);
    const response = await handler(
      new Request(`${BASE}/threads/clear`, { method: 'POST' }),
    );
    expect(response.status).toBe(500);
    expect(snapshotDatabase(h.throwaway.path)).toBe(before);
    expect(h.log.runs('thread-1')).toHaveLength(1);
  });

  it('reads the thread list and messages through the real endpoints', async () => {
    const h = createHarness();
    harnesses.push(h);
    const agent = new ScriptedAgent((input) => [
      ...textMessage('a1', 'x'),
      finished(input),
    ]);
    const handler = handlerFor(h.runner, 'dot-route', agent);
    await (
      await handler(
        post(
          '/agent/dot-route/run',
          runInput('thread-1', 'run-1', [user('m1')]),
        ),
      )
    ).text();
    const list = await (
      await handler(new Request(`${BASE}/threads?agentId=dot-route`))
    ).json();
    expect(list.threads.map((t: { id: string }) => t.id)).toEqual(['thread-1']);
  });
});
