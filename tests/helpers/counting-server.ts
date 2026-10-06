import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Counter {
  url: string;
  // How many requests arrived.
  count(): number;
  // Method, URL, headers and body of every request, for secret scans.
  captured(): string;
  close(): Promise<void>;
}

// A loopback stand-in for a remote service (Intelligence, a model provider).
// Anything that reaches it is a call the server made.
export async function startCounter(): Promise<Counter> {
  const seen: string[] = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      seen.push(
        `${request.method} ${request.url}\n${JSON.stringify(request.headers)}\n${body}`,
      );
      response.statusCode = 503;
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    count: () => seen.length,
    captured: () => seen.join('\n'),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
