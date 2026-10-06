// Preloaded into a probe child process (node --import). It refuses every
// non-loopback TCP connection and records the destination, so a test can assert
// that nothing tried to leave the machine and that a refused attempt never did.
import { appendFileSync } from 'node:fs';
import net from 'node:net';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const log = process.env.OPENDOTS_NET_GUARD_LOG;
const connect = net.Socket.prototype.connect;

net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  // net.connect() hands over an already normalised [options, callback] pair.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  let host: string | undefined;
  if (typeof first === 'object' && first !== null) {
    const options = first as { host?: string; path?: string };
    if (options.path) return Reflect.apply(connect, this, args);
    host = options.host ?? 'localhost';
  } else if (typeof first === 'number') {
    host = typeof args[1] === 'string' ? args[1] : 'localhost';
  } else {
    return Reflect.apply(connect, this, args);
  }
  if (LOOPBACK.has(host)) return Reflect.apply(connect, this, args);
  if (log) appendFileSync(log, `${host}\n`);
  process.nextTick(() =>
    this.destroy(new Error(`Blocked non-loopback connection to ${host}`)),
  );
  return this;
} as typeof net.Socket.prototype.connect;
