import type { DatabaseSync } from 'node:sqlite';
import type { BaseEvent, Message, RunAgentInput } from '@ag-ui/core';
import type { Observable } from 'rxjs';
import { lastValueFrom, toArray } from 'rxjs';
import {
  ConversationLog,
  type TerminalStatus,
} from '../../src/server/conversation-log';
import { DurableAgentRunner } from '../../src/server/durable-runner';
import { CLIENT_EXECUTABLE } from './event-fixtures';
import { ProbeLog } from './probe-log';
import type { ScriptedAgent } from './scripted-agent';
import {
  createThrowawayDatabase,
  openThrowawayDatabase,
  type ThrowawayDatabase,
} from './throwaway-db';

// Shared setup for the durable runner tests: a throwaway database, a log that
// can be probed, a runner over it, and the same priming of the agent that the
// SDK handler does before it calls the runner. Test-only.

export const AGENT_ID = 'dot-1';

export interface Harness {
  throwaway: ThrowawayDatabase;
  db: DatabaseSync;
  log: ProbeLog;
  runner: DurableAgentRunner;
  // An independent connection to the same file, as another process sees it.
  observer(): DatabaseSync;
  cleanup(): void;
}

export function createHarness(
  options: {
    clientExecutableToolNames?: ReadonlySet<string>;
    ownsThread?: (threadId: string, agentId: string) => boolean;
  } = {},
): Harness {
  const throwaway = createThrowawayDatabase();
  const log = new ProbeLog(throwaway.db);
  const runner = new DurableAgentRunner({
    log,
    clientExecutableToolNames:
      options.clientExecutableToolNames ?? CLIENT_EXECUTABLE,
    ownsThread: options.ownsThread ?? (() => true),
  });
  const observers: DatabaseSync[] = [];
  return {
    throwaway,
    db: throwaway.db,
    log,
    runner,
    observer() {
      const db = openThrowawayDatabase(throwaway.path);
      observers.push(db);
      return db;
    },
    cleanup() {
      for (const db of observers) {
        try {
          db.close();
        } catch {
          // already closed
        }
      }
      throwaway.cleanup();
    },
  };
}

// A fresh runner over the same database, as a restarted process would build.
export function restartRunner(
  harness: Harness,
  options: { clientExecutableToolNames?: ReadonlySet<string> } = {},
): { runner: DurableAgentRunner; log: ProbeLog } {
  const log = new ProbeLog(harness.db);
  const runner = new DurableAgentRunner({
    log,
    clientExecutableToolNames:
      options.clientExecutableToolNames ?? CLIENT_EXECUTABLE,
    ownsThread: () => true,
  });
  return { runner, log };
}

export function runInput(
  threadId: string,
  runId: string,
  messages: Message[],
  tools: string[] = [],
): RunAgentInput {
  return {
    threadId,
    runId,
    state: {},
    messages,
    tools: tools.map((name) => ({ name, description: name, parameters: {} })),
    context: [],
    forwardedProps: {},
  };
}

// What the SDK handler does to its per-request clone before calling the runner.
export function prime(
  agent: ScriptedAgent,
  input: RunAgentInput,
  agentId = AGENT_ID,
): ScriptedAgent {
  agent.agentId = agentId;
  agent.setMessages(input.messages);
  agent.setState(input.state);
  agent.threadId = input.threadId;
  return agent;
}

export function startRun(
  runner: DurableAgentRunner,
  agent: ScriptedAgent,
  input: RunAgentInput,
  agentId = AGENT_ID,
): Observable<BaseEvent> {
  return runner.run({
    threadId: input.threadId,
    agent: prime(agent, input, agentId),
    input,
  });
}

export const collect = (events: Observable<BaseEvent>) =>
  lastValueFrom(events.pipe(toArray()), { defaultValue: [] as BaseEvent[] });

export async function runToEnd(
  runner: DurableAgentRunner,
  agent: ScriptedAgent,
  input: RunAgentInput,
  agentId = AGENT_ID,
): Promise<BaseEvent[]> {
  return collect(startRun(runner, agent, input, agentId));
}

// Waits until the condition holds (the runs under test are asynchronous but
// need no real time).
export async function until(
  condition: () => boolean | Promise<boolean>,
  what = 'condition',
): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

export const typesOf = (events: readonly BaseEvent[]) =>
  events.map((event) => event.type as string);

export function committedTypes(
  db: DatabaseSync,
  threadId: string,
  runId: string,
): string[] {
  return db
    .prepare(
      'SELECT eventType FROM conversation_events WHERE threadId = ? AND runId = ? ORDER BY seq',
    )
    .all(threadId, runId)
    .map((row) => String(row.eventType));
}

export const runStatus = (
  log: ConversationLog,
  threadId: string,
  runId: string,
) => log.getRun(threadId, runId)?.status;

// Writes the durable state a process leaves when it dies: a run row and the
// events committed so far, with no terminal event unless the caller adds one.
// Goes through the log, the same writes the runner makes.
export function seedRun(
  log: ConversationLog,
  options: {
    threadId?: string;
    runId?: string;
    agentId?: string;
    start: BaseEvent;
    events?: readonly BaseEvent[];
    status?: TerminalStatus;
  },
): void {
  const threadId = options.threadId ?? 't';
  const runId = options.runId ?? 'r';
  if (!log.hasSchema()) log.ensureSchema();
  log.startRun({
    threadId,
    runId,
    agentId: options.agentId ?? AGENT_ID,
    startEvent: options.start,
  });
  if (options.events?.length)
    log.appendEvents(threadId, runId, options.events, {
      status: options.status,
    });
}
