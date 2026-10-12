// Runs before every test file (vite.config.ts, test.setupFiles). The egress
// guard comes first: a test can import CopilotKit directly, bypassing the
// application modules that import the telemetry guard, and CopilotKit latches
// its telemetry setting and can open a connection as soon as it is used.
import './fixtures/egress/egress-guard.mjs';
import '../src/server/telemetry-guard';
import { afterEach } from 'vitest';
import { egress } from './helpers/egress';

// An attempt that was refused and that the test did not declare, or a
// connection that turned out to be external, fails the test that made it, even
// when the code under test swallowed the error. Tests whose point is a refusal
// declare it with egress.expectBlocked().
afterEach(() => egress.assertNone());
