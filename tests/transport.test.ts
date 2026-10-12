import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readResource } from '../src/browser/transport.js';
import { egress } from './helpers/egress';
// Only DNS validation is replaced: all requests below use real Node HTTP sockets
// to a controlled loopback fixture while retaining the public URL's Host header.
// The name `public.example` never reaches a resolver: the transport pins every
// connection to the address validateUrl returned (here 127.0.0.1), and the
// egress guard (tests/fixtures/egress) judges the connection by that address.
// A test that needs another address says so through `pinned`.
const pinned = vi.hoisted(() => ({ address: '127.0.0.1', family: 4 }));
vi.mock('../src/browser/security.js', () => ({
  validateUrl: async (input: string) => ({
    url: new URL(input),
    address: pinned.address,
    family: pinned.family,
  }),
}));
let server: Server;
let base: string;
let privateHits: number;
let slowOpened: number;
let slowClosed: number;
beforeEach(async () => {
  privateHits = 0;
  slowOpened = 0;
  slowClosed = 0;
  pinned.address = '127.0.0.1';
  pinned.family = 4;
  server = createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { Location: `${base}/private` });
      response.end();
    } else if (request.url === '/private') {
      privateHits++;
      response.end('secret');
    } else if (request.url === '/slow') {
      slowOpened++;
      request.on('close', () => {
        slowClosed++;
        response.destroy();
      });
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(`<h1>Public fixture</h1><p>${request.headers.host}</p>`);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://public.example:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
describe('DNS-pinned transport', () => {
  it('supports Node 24 lookup all mode on an actual HTTP connection', async () => {
    const response = await readResource(base);
    expect(response.status).toBe(200);
    expect(response.body.toString()).toContain('Public fixture');
    expect(response.body.toString()).toContain('public.example');
  });
  it('rejects redirects before returning them to a browser or contacting the destination', async () => {
    await expect(readResource(`${base}/redirect`)).rejects.toThrow(
      'Redirects are blocked',
    );
    expect(privateHits).toBe(0);
  });
  it('aborts in-flight transport when the browser client disconnects', async () => {
    const controller = new AbortController();
    const pending = readResource(`${base}/slow`, controller.signal);
    // The rejection must be the abort itself, not any failure to connect: the
    // fixture has to have received the request first, and has to see the
    // connection closed afterwards.
    const rejected = expect(pending).rejects.toMatchObject({
      name: 'AbortError',
    });
    for (let i = 0; i < 500 && slowOpened === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(slowOpened).toBe(1);
    controller.abort();
    await rejected;
    for (let i = 0; i < 500 && slowClosed === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(slowClosed).toBe(1);
  });

  it('refuses to connect when the pinned address is not loopback, before any connection', async () => {
    // The production transport pins whatever address it is given; under test the
    // egress guard is what stops a non-loopback address from being used.
    pinned.address = '192.0.2.1';
    const { result, events } = await egress.expectBlocked(() =>
      readResource(`${base}/`).then(
        () => 'RESOLVED',
        (error: NodeJS.ErrnoException) => error.code,
      ),
    );
    expect(result).toBe('ERR_EGRESS_BLOCKED');
    expect(events).toContainEqual(
      expect.objectContaining({
        outcome: 'blocked',
        via: 'lookup',
        host: 'public.example',
        resolved: ['192.0.2.1'],
      }),
    );
    expect(privateHits).toBe(0);
  });
});
