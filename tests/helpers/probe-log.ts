import type { BaseEvent } from '@ag-ui/core';
import {
  ConversationLog,
  type StoredEvent,
} from '../../src/server/conversation-log';

// A ConversationLog that lets a test watch or break storage without any test
// seam in the production classes: storage faults and ordering probes belong at
// the storage layer, which is where the real failures happen. Test-only.
export class ProbeLog extends ConversationLog {
  appendCalls = 0;
  startCalls = 0;
  rebuildCalls = 0;
  // Runs just before the real append; may throw to simulate a storage fault.
  beforeAppend?: (events: readonly BaseEvent[]) => void;
  // Runs after the real append has committed.
  afterAppend?: (stored: StoredEvent[]) => void;
  // Makes the next n rebuilds fail.
  failRebuilds = 0;
  // While set, a rebuild waits for it before touching the view.
  rebuildGate?: Promise<void>;

  override startRun(
    request: Parameters<ConversationLog['startRun']>[0],
  ): ReturnType<ConversationLog['startRun']> {
    this.startCalls += 1;
    return super.startRun(request);
  }

  override appendEvents(
    threadId: string,
    runId: string,
    events: readonly BaseEvent[],
    options: Parameters<ConversationLog['appendEvents']>[3] = {},
  ): StoredEvent[] {
    this.appendCalls += 1;
    this.beforeAppend?.(events);
    const stored = super.appendEvents(threadId, runId, events, options);
    this.afterAppend?.(stored);
    return stored;
  }

  override async rebuildMessages(
    threadId: string,
  ): ReturnType<ConversationLog['rebuildMessages']> {
    this.rebuildCalls += 1;
    await this.rebuildGate;
    if (this.failRebuilds > 0) {
      this.failRebuilds -= 1;
      throw new Error('injected view write failure');
    }
    return super.rebuildMessages(threadId);
  }
}
