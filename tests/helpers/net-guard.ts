import net from 'node:net';

// Counts every socket connection attempt of this process. Loopback is allowed
// (and counted separately); anything else is recorded as an unexpected
// non-loopback attempt. A test that uses it ends with zero of those.
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);
export const netStats = { loopback: 0, nonLoopback: [] as string[] };

let installed = false;
export function installNetworkGuard(): void {
  if (installed) return;
  installed = true;
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (
    this: net.Socket,
    ...args: unknown[]
  ) {
    const first = args[0] as
      { host?: string; port?: number; path?: string } | number | string;
    const host =
      typeof first === 'object' && first !== null
        ? (first.host ?? (first.path ? 'unix' : 'localhost'))
        : typeof args[1] === 'string'
          ? (args[1] as string)
          : 'localhost';
    if (host === 'unix' || LOOPBACK.has(host)) netStats.loopback += 1;
    else netStats.nonLoopback.push(String(host));
    return (original as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
}
