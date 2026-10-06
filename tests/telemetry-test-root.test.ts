import { expect, it } from 'vitest';
import { startTrap } from './helpers/telemetry-trap';

// This file deliberately imports CopilotKit itself, not through application
// code, the way tests that build their own runtime do. Application modules
// carry their own guard import, so only the vitest setup file can protect
// this path: without it the SDK latches telemetry on, and the trap below
// would see events.
it('is already suppressed when a test imports CopilotKit directly', async () => {
  // Not the developer's shell: the setup file itself must have applied this.
  expect(process.env.COPILOTKIT_TELEMETRY_DISABLED).toBe('1');
  const trap = await startTrap();
  // The SDK reads its telemetry destination when it first loads.
  process.env.COPILOTKIT_TELEMETRY_URL = trap.url;
  try {
    const { CopilotRuntime, createCopilotHonoHandler } =
      await import('@copilotkit/runtime/v2');
    const handler = createCopilotHonoHandler({
      runtime: new CopilotRuntime({ agents: {} }),
      basePath: '/api/copilotkit',
    });
    const response = await handler.fetch(
      new Request('http://127.0.0.1/api/copilotkit/info'),
    );
    expect(response.status).toBe(200);
    // Telemetry is sent in the background; loopback delivery takes milliseconds.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(trap.events).toEqual([]);
  } finally {
    delete process.env.COPILOTKIT_TELEMETRY_URL;
    await trap.close();
  }
});
