// Machine-readable run-failure codes that OpenDots forwards to the browser as
// the AG-UI RUN_ERROR `code`. The set is closed on purpose: a code that is not
// listed here is never forwarded, whatever the provider sent.

/** The ChatGPT account's Subscription Sharing usage limit has been reached. */
export const USAGE_LIMIT_CODE = 'subscription_sharing_usage_limit_exceeded';

export const FORWARDED_RUN_ERROR_CODES: ReadonlySet<string> = new Set([
  USAGE_LIMIT_CODE,
]);
