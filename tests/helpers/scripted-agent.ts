import { AbstractAgent } from '@ag-ui/client';
import type { BaseEvent, RunAgentInput } from '@ag-ui/core';
import { Observable } from 'rxjs';

// A deterministic stand-in for the model: it emits a script of AG-UI events,
// runs side effects at chosen points (the tool executor) and can wait at a gate
// or hang until it is aborted. It makes no network call. Test-only.

export interface Gate {
  readonly opened: Promise<void>;
  open(): void;
}

export function createGate(): Gate {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

// Blocks until the run is aborted; the stream then ends without a terminal
// event, as an aborted HTTP stream does.
export const HANG = Symbol('hang');

export type Step =
  Record<string, unknown> | Gate | (() => void | Promise<void>) | typeof HANG;

export type Script = (input: RunAgentInput) => Step[];

// Shared by every clone of one agent, because the SDK hands the runner a
// per-request clone.
export interface AgentStats {
  // How many times the model would have been called.
  invocations: number;
  // Events emitted to the runner.
  emitted: number;
  aborts: number;
  inputs: RunAgentInput[];
}

export class ScriptedAgent extends AbstractAgent {
  readonly stats: AgentStats;
  private released?: () => void;

  constructor(
    private readonly script: Script,
    agentId = 'scripted',
    stats?: AgentStats,
    // Called the moment the model would be invoked, before any event.
    private readonly onInvoke?: (input: RunAgentInput) => void,
  ) {
    super({ agentId });
    this.stats = stats ?? { invocations: 0, emitted: 0, aborts: 0, inputs: [] };
  }

  clone(): ScriptedAgent {
    return new ScriptedAgent(
      this.script,
      this.agentId,
      this.stats,
      this.onInvoke,
    );
  }

  abortRun(): void {
    this.stats.aborts += 1;
    this.released?.();
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      this.stats.invocations += 1;
      this.stats.inputs.push(input);
      this.onInvoke?.(input);
      let aborted = false;
      const next = (event: Record<string, unknown>) => {
        this.stats.emitted += 1;
        subscriber.next(event as unknown as BaseEvent);
      };
      const hang = new Promise<void>((resolve) => {
        this.released = () => {
          aborted = true;
          resolve();
        };
      });
      void (async () => {
        try {
          next({
            type: 'RUN_STARTED',
            threadId: input.threadId,
            runId: input.runId,
          });
          for (const step of this.script(input)) {
            if (aborted) break;
            if (step === HANG) await hang;
            else if (typeof step === 'function') await step();
            else if ('opened' in step) await (step as Gate).opened;
            else next(step);
          }
          subscriber.complete();
        } catch (error) {
          subscriber.error(error);
        }
      })();
    });
  }
}

export const finished = (input: RunAgentInput) => ({
  type: 'RUN_FINISHED',
  threadId: input.threadId,
  runId: input.runId,
});

// A complete assistant text message.
export const textMessage = (messageId: string, text: string) => [
  { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: text },
  { type: 'TEXT_MESSAGE_END', messageId },
];

// A tool call as the model streams it, up to and including its end.
export const toolCall = (
  toolCallId: string,
  toolCallName: string,
  parentMessageId: string,
  args = '{}',
) => [
  { type: 'TOOL_CALL_START', toolCallId, toolCallName, parentMessageId },
  { type: 'TOOL_CALL_ARGS', toolCallId, delta: args },
  { type: 'TOOL_CALL_END', toolCallId },
];

export const toolResult = (toolCallId: string, content = '{"ok":true}') => ({
  type: 'TOOL_CALL_RESULT',
  toolCallId,
  messageId: `${toolCallId}-r`,
  role: 'tool',
  content,
});
