const MIN_OWNER_TOKEN_LENGTH = 24;

// The one rule for the owner token. OpenDots refuses to start without a usable
// token on every binding, loopback included, and nothing relaxes that: another
// process on the machine can reach a loopback port, and the API fronts the
// owner's conversations. The message names the setting, never its value.
export function requireOwnerToken(value: string | undefined): string {
  if (!value || value.length < MIN_OWNER_TOKEN_LENGTH)
    throw new Error(
      `OWNER_TOKEN is required and must be at least ${MIN_OWNER_TOKEN_LENGTH} characters. Set it in .env, for example with: node -p "require('node:crypto').randomBytes(32).toString('hex')"`,
    );
  return value;
}
