import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConversationLog } from '../../src/server/conversation-log';
import { RUN, THREAD } from './scenarios';
import { inspect, type Workspace } from './orchestrator';

// What the parent process sees in the database and in the counter files.
export interface Observed {
  status: string | undefined;
  types: string[];
  events: Array<Record<string, unknown>>;
  invariants: unknown[];
  viewRows: number;
  eventRows: number;
  provider: number;
  tool: number;
}

const lines = (path: string) =>
  existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter(Boolean).length
    : 0;

export function observe(workspace: Workspace, runId = RUN): Observed {
  return inspect(workspace, (db) => {
    const log = new ConversationLog(db);
    const stored = log.hasSchema() ? log.runEvents(THREAD, runId) : [];
    return {
      status: log.hasSchema() ? log.getRun(THREAD, runId)?.status : undefined,
      types: stored.map((s) => s.eventType),
      events: stored.map((s) => s.event as unknown as Record<string, unknown>),
      invariants: log.hasSchema() ? log.checkInvariants() : [],
      viewRows: log.hasSchema()
        ? Number(
            (
              db
                .prepare('SELECT COUNT(*) AS n FROM conversation_messages')
                .get() as { n: number }
            ).n,
          )
        : 0,
      eventRows: log.hasSchema()
        ? Number(
            (
              db
                .prepare('SELECT COUNT(*) AS n FROM conversation_events')
                .get() as { n: number }
            ).n,
          )
        : 0,
      provider: lines(join(workspace.dir, 'provider.log')),
      tool: lines(join(workspace.dir, 'tool.log')),
    };
  });
}
