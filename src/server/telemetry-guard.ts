// Turns CopilotKit telemetry off for OpenDots.
//
// This module must be evaluated before any CopilotKit module: the SDK reads its
// telemetry setting while it initialises and keeps the result, so setting the
// variable afterwards switches nothing off. Every server module that imports
// CopilotKit therefore imports this one first; tests/telemetry-order.test.ts
// enforces that, and tests/setup-telemetry.ts does the same for test files.
//
// The values are assigned, never defaulted, on purpose: a setting such as
// COPILOTKIT_TELEMETRY_DISABLED=false must not bring telemetry back.
process.env.COPILOTKIT_TELEMETRY_DISABLED = '1';
process.env.DO_NOT_TRACK = '1';

export {};
