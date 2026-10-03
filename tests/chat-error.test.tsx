import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  chatErrorView,
  fromMessage,
  fromRunError,
  nextError,
  USAGE_LIMIT_NOTICE,
  type ChatError,
} from '../src/client/chat-error';
import { ChatErrorNotice } from '../src/client/ChatErrorNotice';
import { CHATGPT_USAGE_URL, USAGE_LIMIT_CODE } from '../src/shared/run-errors';

// What the server sends with this code (observed). The owner never sees it.
const SERVER_MESSAGE =
  'The ChatGPT user has reached their Subscription Sharing usage limit. Ask the user to try again after their usage limit resets or use an API key instead.';
const limit: ChatError = { message: SERVER_MESSAGE, code: USAGE_LIMIT_CODE };
const html = (error: ChatError) =>
  renderToStaticMarkup(
    <ChatErrorNotice error={error} onReconnect={() => {}} />,
  );

describe('usage-limit display', () => {
  it('shows OpenDots wording, not the server message', () => {
    const markup = html(limit);
    expect(markup).toContain(USAGE_LIMIT_NOTICE);
    expect(markup).not.toContain(SERVER_MESSAGE);
    expect(markup).not.toMatch(/API key/i);
    expect(markup).not.toContain(USAGE_LIMIT_CODE);
  });

  it('does not invent a reset time, a quota or a window', () => {
    expect(USAGE_LIMIT_NOTICE).not.toMatch(
      /\d|hour|week|daily|remaining|left|resets? (at|in|on)/i,
    );
  });

  it('links to the usage settings in a new tab, safely', () => {
    expect(CHATGPT_USAGE_URL).toBe('https://chatgpt.com/settings/usage');
    const markup = html(limit);
    expect(markup).toContain(`href="${CHATGPT_USAGE_URL}"`);
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
  });

  it('offers no Reconnect, because it is not a connection failure', () => {
    expect(html(limit)).not.toMatch(/Reconnect|<button/);
    expect(chatErrorView(limit).kind).toBe('usage_limit');
  });
});

describe('every other error keeps the existing display', () => {
  it.each([
    ['no code', { message: 'Provider text.' }],
    ['another code', { message: 'Provider text.', code: 'some_new_code' }],
    [
      'a different Subscription Sharing code',
      {
        message: 'Provider text.',
        code: 'subscription_sharing_user_not_eligible',
      },
    ],
  ])(
    '%s: the message as-is, with Reconnect and no usage link',
    (_name, error) => {
      const markup = html(error);
      expect(markup).toContain('Provider text.');
      expect(markup).toContain('<button>Reconnect</button>');
      expect(markup).not.toContain('chatgpt.com');
      expect(markup).not.toContain(USAGE_LIMIT_NOTICE);
      expect(chatErrorView(error).kind).toBe('generic');
    },
  );

  it('shows a usage-limit message without its code as an ordinary error', () => {
    // Transport may drop the code. Nothing reads one out of the message.
    const markup = html(fromRunError({ message: SERVER_MESSAGE }));
    expect(markup).toContain(SERVER_MESSAGE);
    expect(markup).toContain('Reconnect');
    expect(markup).not.toContain(USAGE_LIMIT_NOTICE);
  });
});

describe('fromRunError keeps only the message and the code', () => {
  it('drops rawEvent, metadata and everything else', () => {
    const event = {
      type: 'RUN_ERROR',
      message: 'm',
      code: USAGE_LIMIT_CODE,
      rawEvent: { secret: 'x' },
      metadata: { cpki_event_id: 'id' },
      timestamp: 1,
    };
    expect(fromRunError(event)).toEqual({
      message: 'm',
      code: USAGE_LIMIT_CODE,
    });
  });

  it('has no code property when the event has none', () => {
    const result = fromRunError({ message: 'm' });
    expect(result).toEqual({ message: 'm' });
    expect(result).not.toHaveProperty('code');
    expect(fromRunError({ message: 'm', code: '' })).not.toHaveProperty('code');
  });
});

describe('nextError: state transitions', () => {
  it('a usage limit is not lost to the same failure reported again without a code', () => {
    // e.g. the stream's own error, or the error runAgent throws
    expect(nextError(limit, fromMessage(SERVER_MESSAGE))).toBe(limit);
    expect(nextError(limit, fromMessage(`Error: ${SERVER_MESSAGE}`))).toBe(
      limit,
    );
    expect(nextError(limit, fromMessage(`${SERVER_MESSAGE} (retry)`))).toBe(
      limit,
    );
  });

  it('an incoming message that is only a part of the original is another error', () => {
    // Substring in the other direction must not be swallowed as an echo.
    for (const part of [
      'usage limit',
      'Subscription Sharing usage limit',
      SERVER_MESSAGE.slice(0, 40),
      SERVER_MESSAGE.slice(0, -1),
    ]) {
      const shorter = fromMessage(part);
      expect(nextError(limit, shorter)).toBe(shorter);
    }
  });

  it('an unrelated error still replaces it, as before', () => {
    const other = fromMessage('Could not save conversation.');
    expect(nextError(limit, other)).toBe(other);
    expect(nextError(limit, fromMessage(''))).toEqual({ message: '' });
  });

  it('an error with a code replaces whatever was shown', () => {
    expect(nextError(fromMessage('Earlier.'), limit)).toBe(limit);
    const again: ChatError = { message: 'Again.', code: USAGE_LIMIT_CODE };
    expect(nextError(limit, again)).toBe(again);
    const coded: ChatError = { message: 'x', code: 'some_new_code' };
    expect(nextError(limit, coded)).toBe(coded);
  });

  it('ordinary errors behave exactly as before: the latest one wins', () => {
    const a = fromMessage('First.');
    const b = fromMessage('Second.');
    expect(nextError(null, a)).toBe(a);
    expect(nextError(a, b)).toBe(b);
    expect(nextError(a, fromMessage('First.')).message).toBe('First.');
    // a generic error, even with the usage-limit text, is not protected
    const generic = fromMessage(SERVER_MESSAGE);
    expect(nextError(generic, fromMessage('Other.')).message).toBe('Other.');
  });

  it('clearing and the next run start from nothing', () => {
    // send() and Reconnect set null; the next error is judged on its own.
    const afterClear = nextError(null, fromMessage(SERVER_MESSAGE));
    expect(afterClear).toEqual({ message: SERVER_MESSAGE });
    expect(chatErrorView(afterClear).kind).toBe('generic');
    expect(nextError(null, limit)).toBe(limit);
  });
});
