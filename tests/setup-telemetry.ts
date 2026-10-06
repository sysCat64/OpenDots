// Runs before every test file (vite.config.ts, test.setupFiles). A test can
// import CopilotKit directly, bypassing the application modules that import the
// guard, and CopilotKit latches its telemetry setting when it first loads.
import '../src/server/telemetry-guard';
