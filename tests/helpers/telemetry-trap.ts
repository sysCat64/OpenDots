import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Trap {
  url: string;
  events: string[];
  close(): Promise<void>;
}

// A loopback stand-in for the telemetry sink. Every POST is one telemetry
// attempt; the SDK reads its destination from COPILOTKIT_TELEMETRY_URL.
export async function startTrap(): Promise<Trap> {
  const events: string[] = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      try {
        events.push(String(JSON.parse(body).event));
      } catch {
        events.push('unparsed');
      }
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/ingest`,
    events,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
