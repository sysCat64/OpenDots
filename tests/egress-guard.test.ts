import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tls from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { EGRESS_GUARD_PATH, egress, egressGuardArgs } from './helpers/egress';

// The egress guard: every attempt to leave the machine is refused before any
// connection or name lookup leaves the process, and every attempt is recorded.
// All the destinations used for negative controls are unroutable by
// construction (RFC 5737 TEST-NET and RFC 2606 `.invalid`), and the guard
// refuses them before the operating system is asked, so nothing is sent to
// them. No live telemetry or provider endpoint is used as a control.
//
// Vocabulary (docs/LOCAL_FIRST_C4C_NETWORK_GATE_CLOSEOUT.md):
//   A  attempt observed and blocked
//   B  attempt observed and passed to the operating system
//   C  external connection established
//   D  transport the guard does not cover (UDP, native addons, code that
//      captured Socket.prototype.connect before the guard)
const root = fileURLToPath(new URL('../', import.meta.url));
const TEST_NET = '192.0.2.1';
const NAME = 'egress-control.invalid';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const undo of cleanup.splice(0).reverse()) await undo();
});

function loopbackServer(handler?: http.RequestListener) {
  const server = http.createServer(
    handler ?? ((_request, response) => response.end('loopback-ok')),
  );
  cleanup.push(
    () =>
      new Promise<void>(
        (done) => (server.closeAllConnections(), server.close(() => done())),
      ),
  );
  return new Promise<{ server: http.Server; port: number }>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: (server.address() as AddressInfo).port }),
    ),
  );
}

// Waits for the socket to fail or connect and says which.
const settle = (socket: net.Socket) =>
  new Promise<{ error?: NodeJS.ErrnoException; connected: boolean }>(
    (resolve) => {
      socket.once('error', (error) =>
        resolve({ error: error as NodeJS.ErrnoException, connected: false }),
      );
      socket.once('connect', () => resolve({ connected: true }));
    },
  );

describe('the guard is installed where tests run', () => {
  it('is present in this vitest worker, installed by the setup file', () => {
    expect(egress.installed()).toBe(true);
  });

  it('is the first import of the setup file, ahead of the SDK telemetry guard', () => {
    const setup = readFileSync(join(root, 'tests/setup-telemetry.ts'), 'utf8');
    const imports = [...setup.matchAll(/^import\s+['"]([^'"]+)['"];?$/gm)].map(
      (match) => match[1],
    );
    expect(imports[0]).toMatch(/fixtures\/egress\/egress-guard\.mjs$/);
    expect(imports.indexOf('../src/server/telemetry-guard')).toBeGreaterThan(0);
    const config = readFileSync(join(root, 'vite.config.ts'), 'utf8');
    expect(config).toContain("'./tests/setup-telemetry.ts'");
  });
});

describe('class A: external destinations are refused before anything leaves', () => {
  async function refused(attempt: () => net.Socket | http.ClientRequest) {
    const started = performance.now();
    const { result, events } = await egress.expectBlocked(async () => {
      const subject = attempt();
      const failure = await new Promise<NodeJS.ErrnoException>((resolve) => {
        subject.once('error', (error) =>
          resolve(error as NodeJS.ErrnoException),
        );
        subject.once('connect', () =>
          resolve(new Error('CONNECTED') as NodeJS.ErrnoException),
        );
      });
      return failure;
    });
    // An unroutable address would otherwise take seconds to fail.
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(result.message).not.toBe('CONNECTED');
    expect(result.code).toBe('ERR_EGRESS_BLOCKED');
    expect(events.filter((event) => event.outcome === 'blocked')).not.toEqual(
      [],
    );
    return events;
  }

  it('net.connect with options', async () => {
    const events = await refused(() =>
      net.connect({ host: TEST_NET, port: 9 }),
    );
    expect(events[0]).toMatchObject({
      outcome: 'blocked',
      via: 'connect',
      host: TEST_NET,
      intentional: true,
    });
  });

  it('net.connect with port and host (the normalised array form arrives at Socket.prototype.connect)', async () => {
    await refused(() => net.connect(9, TEST_NET));
  });

  it('new Socket().connect(options)', async () => {
    await refused(() => new net.Socket().connect({ host: TEST_NET, port: 9 }));
  });

  it('an IPv6 literal outside loopback', async () => {
    await refused(() => net.connect({ host: '2001:db8::1', port: 9 }));
  });

  it('a name, refused before any name lookup is made', async () => {
    const events = await refused(() => net.connect({ host: NAME, port: 80 }));
    expect(
      events.some((event) => event.via === 'lookup' || event.via === 'connect'),
    ).toBe(true);
    expect(events.every((event) => event.resolved === undefined)).toBe(true);
  });

  it('http.request through the default agent', async () => {
    await refused(() =>
      http.request({ host: TEST_NET, port: 80, path: '/' }).end(),
    );
  });

  it('http.request through a keep-alive agent', async () => {
    const agent = new http.Agent({ keepAlive: true });
    cleanup.push(() => agent.destroy());
    await refused(() =>
      http.request({ host: TEST_NET, port: 80, path: '/', agent }).end(),
    );
  });

  it('https.request', async () => {
    await refused(() =>
      https.request({ host: NAME, port: 443, path: '/' }).end(),
    );
  });

  it('tls.connect', async () => {
    await refused(
      () => tls.connect({ host: TEST_NET, port: 443 }) as unknown as net.Socket,
    );
  });

  it('fetch (undici)', async () => {
    const { result, events } = await egress.expectBlocked(async () => {
      try {
        await fetch(`http://${TEST_NET}:8080/`);
        return 'RESOLVED';
      } catch (error) {
        const cause = (error as { cause?: { code?: string } }).cause;
        return cause?.code ?? 'ERROR';
      }
    });
    expect(result).toBe('ERR_EGRESS_BLOCKED');
    expect(events.some((event) => event.outcome === 'blocked')).toBe(true);
  });

  it('fetch of a name', async () => {
    const { result } = await egress.expectBlocked(async () => {
      try {
        await fetch(`https://${NAME}/`);
        return 'RESOLVED';
      } catch (error) {
        return (error as { cause?: { code?: string } }).cause?.code ?? 'ERROR';
      }
    });
    expect(result).toBe('ERR_EGRESS_BLOCKED');
  });

  it('dns.lookup and dns.promises.lookup of a name', async () => {
    const { result } = await egress.expectBlocked(async () => {
      const callback = await new Promise<string | undefined>((resolve) =>
        dns.lookup(NAME, (error) =>
          resolve((error as NodeJS.ErrnoException | null)?.code),
        ),
      );
      const promise = await dns.promises.lookup(NAME).then(
        () => 'RESOLVED',
        (error: NodeJS.ErrnoException) => error.code,
      );
      return [callback, promise];
    });
    expect(result).toEqual(['ERR_EGRESS_BLOCKED', 'ERR_EGRESS_BLOCKED']);
  });

  it('a pinned lookup that resolves outside loopback (the destination is judged by the address, not the name)', async () => {
    const { result, events } = await egress.expectBlocked(async () => {
      const socket = net.connect({
        host: 'public.example',
        port: 80,
        lookup: (_name, _options, callback) =>
          (callback as (...a: unknown[]) => void)(null, TEST_NET, 4),
      } as net.NetConnectOpts);
      return (await settle(socket)).error?.code;
    });
    expect(result).toBe('ERR_EGRESS_BLOCKED');
    expect(events).toContainEqual(
      expect.objectContaining({
        outcome: 'blocked',
        via: 'lookup',
        host: 'public.example',
        resolved: [TEST_NET],
      }),
    );
  });

  it('a pinned lookup in all-addresses mode with one external entry', async () => {
    const { result } = await egress.expectBlocked(async () => {
      const socket = net.connect({
        host: 'public.example',
        port: 80,
        lookup: (_name: string, _options: unknown, callback: unknown) =>
          (callback as (...a: unknown[]) => void)(null, [
            { address: '127.0.0.1', family: 4 },
            { address: TEST_NET, family: 4 },
          ]),
      } as unknown as net.NetConnectOpts);
      return (await settle(socket)).error?.code;
    });
    expect(result).toBe('ERR_EGRESS_BLOCKED');
  });
});

describe('what the guard passes on', () => {
  it('a loopback connection, recorded as loopback and not as external', async () => {
    const { port } = await loopbackServer();
    egress.reset();
    const body = await new Promise<string>((resolve, reject) =>
      http
        .get({ host: '127.0.0.1', port }, (response) => {
          let text = '';
          response.on('data', (chunk) => (text += chunk));
          response.on('end', () => resolve(text));
        })
        .on('error', reject),
    );
    expect(body).toBe('loopback-ok');
    expect(egress.counts()).toMatchObject({
      blocked: 0,
      allowed_loopback: 1,
      established_external: 0,
    });
    egress.reset();
  });

  it('a name pinned by lookup to loopback keeps its Host header and is passed on', async () => {
    const { port } = await loopbackServer((request, response) =>
      response.end(String(request.headers.host)),
    );
    egress.reset();
    const body = await new Promise<string>((resolve, reject) =>
      http
        .get(
          {
            host: 'public.example',
            port,
            // The shape a DNS-pinned transport answers with (all-addresses
            // mode, as Node 24 asks for).
            lookup: ((
              _name: string,
              _options: unknown,
              callback: (...a: unknown[]) => void,
            ) =>
              callback(null, [
                { address: '127.0.0.1', family: 4 },
              ])) as unknown as net.LookupFunction,
          },
          (response) => {
            let text = '';
            response.on('data', (chunk) => (text += chunk));
            response.on('end', () => resolve(text));
          },
        )
        .on('error', reject),
    );
    expect(body).toBe(`public.example:${port}`);
    expect(egress.unexpected()).toEqual([]);
    expect(egress.counts().allowed_loopback).toBe(1);
    egress.reset();
  });

  it('localhost, and a unix-domain socket (which is no network)', async () => {
    const { port } = await loopbackServer();
    egress.reset();
    const socket = net.connect({ host: 'localhost', port });
    expect((await settle(socket)).connected).toBe(true);
    socket.destroy();
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'opendots-egress-')));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 's.sock');
    const server = net.createServer((client) => client.end());
    await new Promise<void>((resolve) => server.listen(path, resolve));
    cleanup.push(() => new Promise<void>((done) => server.close(() => done())));
    const unix = net.connect(path);
    expect((await settle(unix)).connected).toBe(true);
    unix.destroy();
    expect(egress.counts()).toMatchObject({
      allowed_loopback: 1,
      allowed_unix: 1,
      blocked: 0,
    });
    egress.reset();
  });
});

describe('a refused attempt cannot be mistaken for success', () => {
  it('an attempt nobody declared is reported as unexpected even when its error is swallowed', () => {
    egress.reset();
    const socket = net.connect({ host: TEST_NET, port: 9 });
    socket.on('error', () => undefined); // a caller that ignores the failure
    expect(egress.unexpected()).toHaveLength(1);
    expect(egress.unexpected()[0]).toMatchObject({
      outcome: 'blocked',
      intentional: false,
    });
    // The per-test check run after every test would fail this test; run it
    // here and expect the failure, which also clears the record.
    expect(() => egress.assertNone()).toThrow(
      /Unexpected egress: blocked connect 192\.0\.2\.1/,
    );
    expect(egress.unexpected()).toEqual([]);
  });

  it('a declared refusal passes the per-test check', async () => {
    await egress.expectBlocked(async () => {
      const socket = net.connect({ host: TEST_NET, port: 9 });
      await settle(socket);
    });
    expect(() => egress.assertNone()).not.toThrow();
  });

  it('the setup file runs that check after every test', () => {
    const setup = readFileSync(join(root, 'tests/setup-telemetry.ts'), 'utf8');
    expect(setup).toMatch(/afterEach\(\(\) => egress\.assertNone\(\)\)/);
  });

  it('every connection the guard passed on is re-checked when it connects', async () => {
    const { port } = await loopbackServer();
    const seen: Array<string | undefined> = [];
    const restore = egress.watchEstablished((socket) =>
      seen.push(socket.remoteAddress),
    );
    cleanup.push(restore);
    const socket = net.connect({ host: '127.0.0.1', port });
    expect((await settle(socket)).connected).toBe(true);
    socket.destroy();
    expect(seen).toEqual(['127.0.0.1']);
    egress.reset();
  });

  it('a connection that turns out to be external is recorded as class C', () => {
    egress.reset();
    egress.verifyEstablished({ remoteAddress: TEST_NET });
    egress.verifyEstablished({ remoteAddress: '127.0.0.1' });
    expect(egress.counts().established_external).toBe(1);
    expect(egress.unexpected()).toHaveLength(1);
    expect(() => egress.assertNone()).toThrow(/established_external/);
  });
});

describe('a child process is guarded by an explicit preload, not by the environment', () => {
  const script = `
    import net from 'node:net';
    const socket = net.connect({ host: ${JSON.stringify(TEST_NET)}, port: 9 });
    socket.on('error', (error) => { console.log('RESULT ' + error.code); process.exit(0); });
    socket.on('connect', () => { console.log('RESULT CONNECTED'); process.exit(0); });
  `;
  const run = (args: readonly string[], env: Record<string, string>) =>
    spawnSync(
      process.execPath,
      [...args, '--input-type=module', '--eval', script],
      { cwd: root, encoding: 'utf8', timeout: 20_000, env },
    );

  it('refuses the attempt even when the parent environment is replaced', () => {
    const result = run(egressGuardArgs, { PATH: process.env.PATH ?? '' });
    expect(result.stdout).toContain('RESULT ERR_EGRESS_BLOCKED');
  });

  it('refuses it with NODE_OPTIONS overridden to something else', () => {
    const result = run(egressGuardArgs, {
      PATH: process.env.PATH ?? '',
      NODE_OPTIONS: '--no-warnings',
    });
    expect(result.stdout).toContain('RESULT ERR_EGRESS_BLOCKED');
  });

  it('records the refusal in the log file named by the caller', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'opendots-egress-')));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const log = join(dir, 'egress.jsonl');
    run(egressGuardArgs, {
      PATH: process.env.PATH ?? '',
      OPENDOTS_EGRESS_LOG: log,
    });
    const lines = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines).toContainEqual(
      expect.objectContaining({ outcome: 'blocked', host: TEST_NET }),
    );
  });

  it('the guard file is plain JavaScript that needs no loader', () => {
    expect(EGRESS_GUARD_PATH).toMatch(/\.mjs$/);
  });
});

describe('every spawn site that can load the SDK preloads the guard before it', () => {
  // A child started with an explicit env cannot inherit a preload from the
  // parent's NODE_OPTIONS, so the guard is named in its argument list, ahead of
  // the loader and of any script. The servers started by spawnServer and the
  // telemetry entry tests use the P5 fixture (tests/fixtures/telemetry/net-guard.ts),
  // which refuses a non-loopback connection by the same normalised arguments.
  const sites = [
    'tests/dormancy-runtime.test.ts',
    'tests/crash/orchestrator.ts',
    'tests/crash/dot-sigkill.test.ts',
  ];
  it.each(sites)('%s', (path) => {
    const text = readFileSync(join(root, path), 'utf8');
    const spawns = [
      ...text.matchAll(/\.\.\.egressGuardArgs,\s*'--import',\s*'tsx'/g),
    ];
    const tsxLoads = [...text.matchAll(/'--import',\s*'tsx'/g)];
    expect(tsxLoads.length).toBeGreaterThan(0);
    expect(spawns).toHaveLength(tsxLoads.length);
  });

  it('the P5 fixture used by the server children also reads the normalised array', () => {
    const text = readFileSync(
      join(root, 'tests/fixtures/telemetry/net-guard.ts'),
      'utf8',
    );
    expect(text).toMatch(/Array\.isArray\(args\[0\]\)\s*\?\s*args\[0\]\[0\]/);
  });
});
