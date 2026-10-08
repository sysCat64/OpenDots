import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { BaseEvent } from '@ag-ui/core';
import { toArray, lastValueFrom } from 'rxjs';
import {
  ConversationLog,
  type StoredEvent,
} from '../../src/server/conversation-log';
import { DurableAgentRunner } from '../../src/server/durable-runner';
import { CLIENT_EXECUTABLE } from '../helpers/event-fixtures';
import { ScriptedAgent } from '../helpers/scripted-agent';
import { openThrowawayDatabase } from '../helpers/throwaway-db';
import {
  RUN,
  SCENARIOS,
  THREAD,
  startMessages,
  type Scenario,
} from './scenarios';

// The process the crash tests start and kill. Everything it needs comes from argv:
//   child.ts run <db> <scenario> <dir>          drive a scenario and freeze
//   child.ts run-to-end <db> <scenario> <dir>   drive it to the end and exit
//   child.ts recover <db> <dir>                 ready(), then read everything
//   child.ts recover-frozen <db> <dir>          ready(), frozen inside recovery
//   child.ts read <db> <dir>                    read only: no ready()
// It never reads the environment to find a database; the path is refused unless
// it is a throwaway one (the same check the tests use).

const [mode, dbPath, ...rest] = process.argv.slice(2);

function freezeForever(marker: string, detail: Record<string, unknown>): never {
  writeFileSync(marker, JSON.stringify({ pid: process.pid, ...detail }));
  // Blocks this thread for good. The parent sends SIGKILL.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error('unreachable');
}

class GateLog extends ConversationLog {
  constructor(
    db: DatabaseSync,
    private readonly scenario: Scenario,
    private readonly marker: string,
    private readonly enabled: boolean,
  ) {
    super(db);
  }
  override startRun(request: Parameters<ConversationLog['startRun']>[0]) {
    const started = super.startRun(request);
    if (this.enabled && this.scenario.freeze.at === 'start')
      freezeForever(this.marker, { after: 'start' });
    return started;
  }
  override appendEvents(
    ...args: Parameters<ConversationLog['appendEvents']>
  ): StoredEvent[] {
    const stored = super.appendEvents(...args);
    const { freeze } = this.scenario;
    if (
      this.enabled &&
      freeze.at === 'event' &&
      stored.some((s) => s.eventType === freeze.type)
    )
      freezeForever(this.marker, { after: freeze.type });
    return stored;
  }
}

const counters = (dir: string) => ({
  provider: lines(join(dir, 'provider.log')),
  tool: lines(join(dir, 'tool.log')),
});
function lines(path: string): number {
  return existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter(Boolean).length
    : 0;
}

function newRunner(log: ConversationLog) {
  return new DurableAgentRunner({
    log,
    clientExecutableToolNames: CLIENT_EXECUTABLE,
    ownsThread: () => true,
  });
}

async function drive(scenarioName: string, dir: string, untilEnd: boolean) {
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) throw new Error(`unknown scenario ${scenarioName}`);
  const marker = join(dir, 'marker.json');
  const db = openThrowawayDatabase(dbPath);
  const log = new GateLog(db, scenario, marker, !untilEnd);
  const runner = newRunner(log);
  const reader = openThrowawayDatabase(dbPath);
  const context = {
    awaitDurable: async (eventType: string) => {
      for (;;) {
        const row = reader
          .prepare(
            'SELECT 1 AS found FROM conversation_events WHERE threadId = ? AND runId = ? AND eventType = ?',
          )
          .get(THREAD, RUN, eventType);
        if (row) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    executeTool: (id: string) =>
      appendFileSync(join(dir, 'tool.log'), `${id}\n`),
    freeze: () => {
      if (!untilEnd) freezeForever(marker, { after: 'script' });
    },
  };
  const agent = new ScriptedAgent(
    (input) => scenario.script(input, context),
    'dot-1',
    undefined,
    () => appendFileSync(join(dir, 'provider.log'), 'invoked\n'),
  );
  const input = {
    threadId: THREAD,
    runId: RUN,
    state: {},
    messages: startMessages(),
    tools: scenario.tools.map((name) => ({
      name,
      description: name,
      parameters: {},
    })),
    context: [],
    forwardedProps: {},
  };
  agent.agentId = 'dot-1';
  agent.threadId = THREAD;
  agent.setMessages(input.messages);
  const events = await lastValueFrom(
    runner.run({ threadId: THREAD, agent, input }).pipe(toArray()),
    {
      defaultValue: [] as BaseEvent[],
    },
  );
  // Not killed: the scenario ran to its end.
  report({ completed: true, types: events.map((e) => e.type) });
  db.close();
  reader.close();
}

function report(value: unknown) {
  process.stdout.write(`RESULT ${JSON.stringify(value)}\n`);
}

async function readEverything(runner: DurableAgentRunner) {
  const replay = await lastValueFrom(
    runner.connect({ threadId: THREAD }).pipe(toArray()),
    {
      defaultValue: [] as BaseEvent[],
    },
  );
  const messages = await runner.messagesFor(THREAD);
  return {
    replay: replay.map((event) => event.type),
    replayEvents: replay,
    messages,
    threads: runner.listThreads().map((t) => t.id),
  };
}

async function recover(dir: string, frozen: boolean) {
  const raw = openThrowawayDatabase(dbPath);
  let db: DatabaseSync = raw;
  if (frozen) {
    // Freeze inside the recovery transaction, after its first insert.
    db = new Proxy(raw, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property !== 'prepare')
          return typeof value === 'function' ? value.bind(target) : value;
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!/^\s*INSERT INTO conversation_events/.test(sql))
            return statement;
          return new Proxy(statement, {
            get(inner, key) {
              const member = Reflect.get(inner, key, inner);
              if (key !== 'run')
                return typeof member === 'function'
                  ? member.bind(inner)
                  : member;
              return (...args: unknown[]) => {
                const result = (inner.run as (...a: unknown[]) => unknown)(
                  ...args,
                );
                if (target.isTransaction)
                  freezeForever(join(dir, 'marker.json'), {
                    after: 'recovery-insert',
                  });
                return result;
              };
            },
          });
        };
      },
    });
  }
  const log = new ConversationLog(db);
  const runner = newRunner(log);
  const ready = await runner.ready();
  report({ ready, ...(await readEverything(runner)), counters: counters(dir) });
  raw.close();
}

async function read(dir: string) {
  const db = openThrowawayDatabase(dbPath);
  const runner = newRunner(new ConversationLog(db));
  report({ ...(await readEverything(runner)), counters: counters(dir) });
  db.close();
}

const dir =
  mode === 'recover' || mode === 'recover-frozen' || mode === 'read'
    ? rest[0]
    : rest[1];
mkdirSync(dir, { recursive: true });
if (mode === 'run') await drive(rest[0], dir, false);
else if (mode === 'run-to-end') await drive(rest[0], dir, true);
else if (mode === 'recover') await recover(dir, false);
else if (mode === 'recover-frozen') await recover(dir, true);
else if (mode === 'read') await read(dir);
else throw new Error(`unknown mode ${mode}`);
