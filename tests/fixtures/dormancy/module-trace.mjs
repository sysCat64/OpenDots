// Preloaded into a real process through NODE_OPTIONS=--import. Appends the URL
// of every module under src/ that gets resolved to the file named by
// OPENDOTS_MODULE_TRACE_LOG, so a test can tell which application modules a
// process loaded. A module that was never resolved was never evaluated.
// It is a .mjs file because NODE_OPTIONS imports run before tsx is registered.
import { appendFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import process from 'node:process';

const log = process.env.OPENDOTS_MODULE_TRACE_LOG;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (log && /\/src\//.test(resolved.url))
      appendFileSync(log, `${resolved.url}\n`);
    return resolved;
  },
});
