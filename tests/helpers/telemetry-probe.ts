import { spawnServer } from './server-entry';

export interface EntryOptions {
  // Import the CopilotKit runtime before the application starts, the way an
  // entry that initialises the SDK ahead of the guard would.
  sdkFirst?: boolean;
  // Extra environment for the server, e.g. a hostile telemetry setting.
  env?: Record<string, string>;
}

export interface EntryResult {
  // One element per telemetry POST that reached the loopback trap.
  events: string[];
  // Destinations of refused non-loopback connection attempts.
  blocked: string[];
  output: string;
  infoStatus: number;
  runStatus: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Starts the real server entry in a fresh process, sends it an /info request
// and a run request for a bound thread, then reports what it tried to send.
export async function runServerEntry(
  options: EntryOptions = {},
): Promise<EntryResult> {
  const server = spawnServer({
    sdkFirst: options.sdkFirst,
    env: options.env,
    seedThread: true,
  });
  try {
    const port = await server.ready;
    const base = `http://127.0.0.1:${port}/api/copilotkit`;
    const headers = { Authorization: `Bearer ${server.token}` };
    const info = await fetch(`${base}/info`, { headers });
    const run = await fetch(`${base}/agent/${server.dotId}/run`, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({
        threadId: server.threadId,
        runId: 'telemetry-probe-run',
        state: {},
        messages: [{ id: 'probe-message', role: 'user', content: 'hello' }],
        tools: [],
        context: [],
        forwardedProps: {},
      }),
    });
    await run.text();
    // Telemetry is sent in the background; loopback delivery takes milliseconds.
    await sleep(1500);
    return {
      events: [...server.trap.events],
      blocked: server.blocked(),
      output: server.output(),
      infoStatus: info.status,
      runStatus: run.status,
    };
  } finally {
    await server.stop();
  }
}
