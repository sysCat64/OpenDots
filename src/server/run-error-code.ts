import type { ChatMiddleware } from '@tanstack/ai';
import { FORWARDED_RUN_ERROR_CODES } from '../shared/run-errors.js';

// CopilotKit's TanStack converter turns a RUN_ERROR chunk into
// `throw new Error(raw.message)`, so the `code` is gone by the time the AG-UI
// RUN_ERROR reaches DotAgent. TanStack's public `middleware.onChunk` sees the
// chunk first, so the code is captured there and restored by DotAgent.
//
// One capture belongs to one run: create it inside `DotAgent.run()` and let its
// closure carry the value. There is deliberately no module-level or instance
// state, and nothing is keyed by thread or run id, so concurrent runs cannot
// see each other's failures.
//
// The capture is one-shot, not sticky: `take()` hands the code over once and
// empties it, so a later RUN_ERROR in the same run never inherits it.
export interface RunErrorCodeCapture {
  middleware: ChatMiddleware;
  /**
   * The forwardable code captured since the last call, if any. Returns it once:
   * the capture is empty afterwards.
   */
  take(): string | undefined;
}

export function captureRunErrorCode(): RunErrorCodeCapture {
  let captured: string | undefined;
  return {
    middleware: {
      name: 'opendots-run-error-code',
      // Observe only: returning nothing passes the chunk on unchanged.
      onChunk(_context, chunk) {
        // A code still waiting to be taken is not overwritten by a later one.
        if (captured !== undefined || chunk.type !== 'RUN_ERROR') return;
        const { code } = chunk;
        // Only the code is read: not the message, and not rawEvent.
        if (typeof code === 'string' && FORWARDED_RUN_ERROR_CODES.has(code))
          captured = code;
      },
    },
    take() {
      const code = captured;
      captured = undefined;
      return code;
    },
  };
}
