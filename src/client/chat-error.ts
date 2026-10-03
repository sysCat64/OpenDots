import { CHATGPT_USAGE_URL, USAGE_LIMIT_CODE } from '../shared/run-errors';

// What the chat shows when a run or a request fails. Pure, so each case can be
// checked without a browser.
//
// `code` exists only when the AG-UI RUN_ERROR carried one and may be absent.
// Generic error handling works without it; specialized views use the code
// when present. No code is ever inferred from message text.

export interface ChatError {
  message: string;
  code?: string;
}

export type ChatErrorView =
  | { kind: 'usage_limit'; text: string; usageUrl: string }
  | { kind: 'generic'; text: string; canReconnect: true };

// Written for the owner. It does not use the server's own message, which also
// suggests an API key: OpenDots never switches provider by itself.
export const USAGE_LIMIT_NOTICE =
  'You have reached the usage limit of your ChatGPT plan for apps. Try again after it resets. You can check your usage in ChatGPT Settings.';

/** Keeps the message and the code, and nothing else of the event. */
export function fromRunError(event: {
  message: string;
  code?: string;
}): ChatError {
  return typeof event.code === 'string' && event.code
    ? { message: event.message, code: event.code }
    : { message: event.message };
}

export const fromMessage = (message: string): ChatError => ({ message });

// Shown only when a run resolves without an assistant message and nothing else
// has been reported for it.
export const NO_RESPONSE_MESSAGE =
  'The current turn returned no response. Check the runtime connection and retry.';

/**
 * The error to show when a run resolved without an assistant message. Over SSE
 * a RUN_ERROR does not reject `runAgent`; it is reported first and the run then
 * resolves empty. `current` is what this run already reported (the chat clears
 * it when a turn starts), so a real error, with its code, is the reason and
 * keeps precedence. The synthetic message only fills the gap when nothing else
 * was reported.
 */
export const noResponseError = (current: ChatError | null): ChatError =>
  current ?? fromMessage(NO_RESPONSE_MESSAGE);

const isUsageLimit = (error: ChatError | null) =>
  error?.code === USAGE_LIMIT_CODE;

// The same failure can also reach the chat as a thrown error with the same
// message, or with the whole message inside a wrapper. One direction only: an
// incoming message that is merely a part of the original is another error.
function echoes(current: ChatError, incoming: ChatError) {
  const a = current.message.trim();
  const b = incoming.message.trim();
  return !!a && !!b && (a === b || b.includes(a));
}

/**
 * The error to show after `incoming` arrives. A usage limit is not replaced by a
 * later error without a code that is just the same failure reported again;
 * every other case replaces the error, as before.
 */
export function nextError(
  current: ChatError | null,
  incoming: ChatError,
): ChatError {
  return isUsageLimit(current) &&
    incoming.code === undefined &&
    echoes(current!, incoming)
    ? current!
    : incoming;
}

export function chatErrorView(error: ChatError): ChatErrorView {
  return error.code === USAGE_LIMIT_CODE
    ? {
        kind: 'usage_limit',
        text: USAGE_LIMIT_NOTICE,
        usageUrl: CHATGPT_USAGE_URL,
      }
    : { kind: 'generic', text: error.message, canReconnect: true };
}
