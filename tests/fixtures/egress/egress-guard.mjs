// The egress guard. Preloaded with `--import` into a test process (and imported
// first by tests/setup-telemetry.ts for every Vitest worker) it refuses every
// attempt to leave the machine BEFORE a connection or a name lookup leaves the
// process, and records each attempt. It is plain JavaScript so that it needs no
// loader and can run before anything that can load the SDK.
//
// What it decides on:
//  - a TCP connection by the destination ADDRESS: an IP literal, or the address a
//    lookup returned (the connection's own `lookup` option when it has one, which
//    is how a DNS-pinned transport names a public host and connects to a fixture).
//    Only 127.0.0.0/8 and ::1 (and ::ffff:127.0.0.0/8) are loopback.
//  - a name with no lookup of its own is refused without a lookup, except
//    `localhost`. So no resolver query leaves the process either.
//  - dns.lookup, dns.resolve* and the dns.promises forms, for the same reason.
//  - a unix-domain socket is no network and is passed on.
//
// It is NOT a hostname allowlist: nothing but loopback can be reached, whatever
// it is called. Every passed-on connection is re-checked when it connects
// ("established"), so a path that slipped past the decision is still recorded.
//
// What it does not cover (class D, stated rather than hidden): UDP (dgram),
// `new dns.Resolver()` instances, native addons and child programs that open
// sockets themselves, code that captured Socket.prototype.connect before this
// file ran, and any process that was not started with this preload.
//
// State is published on Symbol.for('opendots.egress-guard') for
// tests/helpers/egress.ts. OPENDOTS_EGRESS_LOG, when set, receives one JSON line
// per event (every process appends; a child process is not otherwise visible).
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import dns from 'node:dns';
import net from 'node:net';
import process from 'node:process';

const KEY = Symbol.for('opendots.egress-guard');
const MAX_EVENTS = 20_000;

if (!globalThis[KEY]) install();

function install() {
  const handle = {
    events: [],
    // Greater than zero while a test declared that refused attempts are expected.
    intentional: 0,
    internals: { verifyEstablished },
  };
  globalThis[KEY] = handle;
  const log = process.env.OPENDOTS_EGRESS_LOG;

  function record(event) {
    const full = { ...event, intentional: handle.intentional > 0 };
    handle.events.push(full);
    if (handle.events.length > MAX_EVENTS) {
      // Keep every refusal and every external connection; thin out the rest.
      const keep = handle.events.filter(
        (e) => e.outcome === 'blocked' || e.outcome === 'established_external',
      );
      const rest = handle.events
        .filter(
          (e) =>
            e.outcome !== 'blocked' && e.outcome !== 'established_external',
        )
        .slice(-Math.floor(MAX_EVENTS / 2));
      handle.events.splice(0, handle.events.length, ...keep, ...rest);
    }
    if (log) {
      try {
        appendFileSync(
          log,
          `${JSON.stringify({ pid: process.pid, ...full })}\n`,
        );
      } catch {
        // the log is evidence, never a reason to fail the process
      }
    }
  }

  const isLoopbackAddress = (value) => {
    if (typeof value !== 'string') return false;
    const address = value
      .replace(/^\[|\]$/g, '')
      .replace(/%.*$/, '')
      .toLowerCase();
    if (net.isIPv4(address)) return address.startsWith('127.');
    if (net.isIPv6(address))
      return (
        address === '::1' ||
        address === '0:0:0:0:0:0:0:1' ||
        /^::ffff:127\./.test(address)
      );
    return false;
  };

  const blockedError = (what) =>
    Object.assign(new Error(`Egress blocked: ${what}`), {
      code: 'ERR_EGRESS_BLOCKED',
    });

  function verifyEstablished(socket) {
    const peer = socket && socket.remoteAddress;
    if (peer && !isLoopbackAddress(peer))
      record({ outcome: 'established_external', via: 'connect', host: peer });
  }

  // ------------------------------------------------------------- connections

  const realLookup = dns.lookup.bind(dns);
  const originalConnect = net.Socket.prototype.connect;

  // The lookup a connection will use, wrapped so that every address it returns
  // is checked before the connection is made.
  function guardedLookup(inner, context, recordPassed) {
    return function lookup(hostname, options, callback) {
      if (typeof options === 'function') {
        callback = options;
        options = {};
      }
      inner(hostname, options, (error, address, family) => {
        if (error) return callback(error, address, family);
        const list = Array.isArray(address)
          ? address.map((entry) => entry.address)
          : [address];
        if (list.length && list.every(isLoopbackAddress)) {
          if (recordPassed)
            record({
              outcome: 'allowed_loopback',
              via: 'lookup',
              host: context.host,
              port: context.port,
              resolved: list,
            });
          return callback(null, address, family);
        }
        record({
          outcome: 'blocked',
          via: 'lookup',
          host: context.host,
          port: context.port,
          resolved: list,
          reason: 'resolved_outside_loopback',
        });
        return callback(
          blockedError(`${context.host} resolved outside loopback`),
        );
      });
    };
  }

  net.Socket.prototype.connect = function guardedConnect(...args) {
    // net.connect() and the HTTP agent hand over an already normalised
    // [options, callback] array that carries a private marker; keep it intact.
    const wrapped = Array.isArray(args[0]);
    const first = wrapped ? args[0][0] : args[0];
    const callback = wrapped
      ? args[0][1]
      : typeof args[args.length - 1] === 'function'
        ? args[args.length - 1]
        : undefined;

    let options;
    if (first && typeof first === 'object') options = first;
    else if (
      typeof first === 'number' ||
      (typeof first === 'string' && /^\d+$/.test(first))
    )
      options = {
        port: Number(first),
        host: typeof args[1] === 'string' ? args[1] : undefined,
      };
    else if (typeof first === 'string') {
      record({ outcome: 'allowed_unix', via: 'connect', host: first });
      return originalConnect.apply(this, args);
    } else return originalConnect.apply(this, args); // not a shape Node accepts; let it throw

    if (options.path) {
      record({
        outcome: 'allowed_unix',
        via: 'connect',
        host: String(options.path),
      });
      return originalConnect.apply(this, args);
    }

    const host = options.host ?? 'localhost';
    const port = options.port;
    const refuse = (reason) => {
      record({
        outcome: 'blocked',
        via: 'connect',
        host: String(host),
        port,
        reason,
      });
      process.nextTick(() =>
        this.destroy(blockedError(`${host}:${port ?? ''} (${reason})`)),
      );
      return this;
    };

    let rewritten;
    if (net.isIP(String(host).replace(/^\[|\]$/g, ''))) {
      if (!isLoopbackAddress(host)) return refuse('address_outside_loopback');
      record({
        outcome: 'allowed_loopback',
        via: 'connect',
        host: String(host),
        port,
      });
      rewritten = options;
    } else if (typeof options.lookup === 'function') {
      // A DNS-pinned connection: the address its own lookup returns decides.
      rewritten = {
        ...options,
        lookup: guardedLookup(
          options.lookup,
          { host: String(host), port },
          true,
        ),
      };
    } else if (host === 'localhost') {
      record({ outcome: 'allowed_loopback', via: 'connect', host, port });
      rewritten = {
        ...options,
        lookup: guardedLookup(realLookup, { host, port }, false),
      };
    } else return refuse('name_without_pinned_lookup');

    this.once('connect', () => handle.internals.verifyEstablished(this));
    if (wrapped) {
      const copy = [...args[0]];
      for (const symbol of Object.getOwnPropertySymbols(args[0]))
        copy[symbol] = args[0][symbol];
      copy[0] = rewritten;
      return originalConnect.call(this, copy, ...args.slice(1));
    }
    if (first && typeof first === 'object')
      return originalConnect.call(this, rewritten, ...args.slice(1));
    return originalConnect.call(
      this,
      rewritten,
      ...(callback ? [callback] : []),
    );
  };

  // -------------------------------------------------------------------- dns

  // Names go to the resolver, which is a network. Only an IP literal, an empty
  // name (which means localhost) and `localhost` are answered locally.
  const local = (name) =>
    name === undefined ||
    name === null ||
    name === '' ||
    name === 'localhost' ||
    net.isIP(String(name)) !== 0;

  const blockedName = (api, name) => {
    record({
      outcome: 'blocked',
      via: 'dns',
      host: String(name),
      reason: `${api}`,
    });
    return blockedError(`${api}(${name})`);
  };

  const callbackStyle = [
    'lookup',
    'resolve',
    'resolve4',
    'resolve6',
    'resolveAny',
    'resolveCaa',
    'resolveCname',
    'resolveMx',
    'resolveNaptr',
    'resolveNs',
    'resolvePtr',
    'resolveSoa',
    'resolveSrv',
    'resolveTxt',
    'reverse',
  ];
  for (const name of callbackStyle) {
    const original = dns[name];
    if (typeof original !== 'function') continue;
    dns[name] = function guardedDns(target, ...rest) {
      if (
        name === 'lookup'
          ? local(target)
          : name === 'reverse' &&
            net.isIP(String(target)) !== 0 &&
            isLoopbackAddress(target)
      )
        return original.call(this, target, ...rest);
      const error = blockedName(`dns.${name}`, target);
      const callback = rest.at(-1);
      if (typeof callback === 'function') process.nextTick(callback, error);
      return undefined;
    };
  }
  for (const name of callbackStyle) {
    const original = dns.promises[name];
    if (typeof original !== 'function') continue;
    dns.promises[name] = function guardedPromise(target, ...rest) {
      if (
        name === 'lookup'
          ? local(target)
          : name === 'reverse' &&
            net.isIP(String(target)) !== 0 &&
            isLoopbackAddress(target)
      )
        return original.call(this, target, ...rest);
      return Promise.reject(blockedName(`dns.promises.${name}`, target));
    };
  }
  syncBuiltinESMExports();
}
