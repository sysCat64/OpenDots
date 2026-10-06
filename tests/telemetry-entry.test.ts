import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readLines, repoRoot } from './helpers/server-entry';
import { runServerEntry } from './helpers/telemetry-probe';

// CopilotKit latches its telemetry setting while its modules initialise, so
// these tests start the real server entry (src/server/index.ts) in a fresh
// process for each ordering. Telemetry is pointed at a loopback trap and every
// non-loopback connection is refused, so nothing reaches the Internet.
const SLOW = 120_000;
const DISCLOSURE = 'telemetry enabled';

describe('CopilotKit telemetry at server startup', () => {
  it(
    'sends nothing when the application starts in production order',
    async () => {
      const result = await runServerEntry();
      expect(result.infoStatus).toBe(200);
      // The run request got past owner auth and scope into the CopilotKit handler.
      expect([401, 403]).not.toContain(result.runStatus);
      expect(result.events).toEqual([]);
      expect(result.output).not.toContain(DISCLOSURE);
      expect(result.blocked).toEqual([]);
    },
    SLOW,
  );

  it(
    'sends nothing when the environment asks for telemetry to stay on',
    async () => {
      const result = await runServerEntry({
        env: {
          COPILOTKIT_TELEMETRY_DISABLED: 'false',
          DO_NOT_TRACK: 'false',
        },
      });
      expect(result.infoStatus).toBe(200);
      expect([401, 403]).not.toContain(result.runStatus);
      expect(result.events).toEqual([]);
      expect(result.output).not.toContain(DISCLOSURE);
      expect(result.blocked).toEqual([]);
    },
    SLOW,
  );

  // The detector for the two tests above. With the SDK initialised before the
  // application's guard, telemetry must be visible at the trap; otherwise a
  // zero in the tests above would prove nothing. It does not pin an event count.
  it(
    'detects telemetry when CopilotKit initialises before the guard',
    async () => {
      const result = await runServerEntry({ sdkFirst: true });
      expect(result.infoStatus).toBe(200);
      expect(result.events.length).toBeGreaterThan(0);
      // The per-request path was exercised, not only the startup path.
      expect(result.events).toContain('oss.runtime.copilot_request_created');
      expect(result.blocked).toEqual([]);
    },
    SLOW,
  );
});

describe('probe network guard', () => {
  it(
    'refuses and records a non-loopback connection',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'opendots-net-guard-'));
      const log = join(dir, 'blocked.txt');
      try {
        // blocked.invalid never resolves (RFC 2606), so nothing could leave the
        // machine even if the guard failed.
        const output = await new Promise<string>((resolve) => {
          const child = spawn(
            process.execPath,
            [
              '--import',
              'tsx',
              '--import',
              './tests/fixtures/telemetry/net-guard.ts',
              '--input-type=module',
              '-e',
              "await fetch('http://blocked.invalid/').then(() => console.log('REACHED'), (e) => console.log('REFUSED', e.cause?.message ?? e.message));",
            ],
            {
              cwd: repoRoot,
              env: {
                PATH: process.env.PATH ?? '',
                OPENDOTS_NET_GUARD_LOG: log,
              },
            },
          );
          let text = '';
          child.stdout.on('data', (chunk) => (text += chunk));
          child.on('close', () => resolve(text));
        });
        expect(output).toContain('REFUSED');
        expect(output).not.toContain('REACHED');
        expect(readLines(log)).toEqual(['blocked.invalid']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    SLOW,
  );
});
