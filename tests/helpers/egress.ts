import { fileURLToPath } from 'node:url';

// Test-side view of the egress guard (tests/fixtures/egress/egress-guard.mjs).
// The guard itself is a plain module so that it can be preloaded into any Node
// process with `--import`; it publishes its state on a global symbol and this
// file reads it. Test-only.
//
// Outcomes the guard distinguishes:
//   blocked              the attempt was refused before any connection or name
//                        lookup left the process (class A)
//   allowed_loopback     a connection to a loopback destination was passed on
//   allowed_unix         a unix-domain socket (no network) was passed on
//   established_external a connection that was passed on turned out to be
//                        connected to a non-loopback peer (class C). It must
//                        never occur; it is the guard's own cross-check.
export type EgressOutcome =
  'blocked' | 'allowed_loopback' | 'allowed_unix' | 'established_external';

export interface EgressEvent {
  outcome: EgressOutcome;
  // What the attempt went through.
  via: 'connect' | 'lookup' | 'dns';
  host?: string;
  port?: string | number;
  // The addresses a lookup returned, when one was run.
  resolved?: string[];
  reason?: string;
  // Declared by the test through expectBlocked().
  intentional: boolean;
}

interface EgressHandle {
  events: EgressEvent[];
  intentional: number;
  internals: {
    verifyEstablished(socket: { remoteAddress?: string }): void;
  };
}

const KEY = Symbol.for('opendots.egress-guard');
const handle = (): EgressHandle | undefined =>
  (globalThis as Record<symbol, EgressHandle | undefined>)[KEY];

// The module to preload with `--import` into a child process, before anything
// that can load the SDK.
export const EGRESS_GUARD_PATH = fileURLToPath(
  new URL('../fixtures/egress/egress-guard.mjs', import.meta.url),
);
export const egressGuardArgs: readonly string[] = [
  '--import',
  EGRESS_GUARD_PATH,
];

export const egress = {
  installed(): boolean {
    return handle() !== undefined;
  },
  events(): readonly EgressEvent[] {
    return [...(handle()?.events ?? [])];
  },
  // Attempts that were refused and nobody declared, plus anything that was
  // established externally.
  unexpected(): EgressEvent[] {
    return (handle()?.events ?? []).filter(
      (event) =>
        event.outcome === 'established_external' ||
        (event.outcome === 'blocked' && !event.intentional),
    );
  },
  counts(): Record<EgressOutcome | 'blockedIntentional', number> {
    const counts = {
      blocked: 0,
      blockedIntentional: 0,
      allowed_loopback: 0,
      allowed_unix: 0,
      established_external: 0,
    };
    for (const event of handle()?.events ?? []) {
      counts[event.outcome] += 1;
      if (event.outcome === 'blocked' && event.intentional)
        counts.blockedIntentional += 1;
    }
    return counts;
  },
  // The per-test check (tests/setup-telemetry.ts runs it after every test): an
  // undeclared refusal, or a connection that turned out to be external, is an
  // error even when the code that made the attempt swallowed its failure.
  // Clears the record, so one test's attempts are never charged to the next.
  assertNone(): void {
    const unexpected = egress.unexpected();
    egress.reset();
    if (unexpected.length)
      throw new Error(
        `Unexpected egress: ${unexpected
          .map(
            (event) =>
              `${event.outcome} ${event.via} ${event.host ?? ''}:${event.port ?? ''}`,
          )
          .join(', ')}`,
      );
  },
  reset(): void {
    const current = handle();
    if (current) current.events.length = 0;
  },
  // Runs work in which refused attempts are the point of the test. They are
  // recorded as intentional, so the per-test check does not fail them, and
  // the events observed during the run are returned.
  async expectBlocked<T>(
    work: () => Promise<T>,
  ): Promise<{ result: T; events: EgressEvent[] }> {
    const current = handle();
    if (!current) throw new Error('The egress guard is not installed.');
    const from = current.events.length;
    current.intentional += 1;
    try {
      const result = await work();
      return { result, events: current.events.slice(from) };
    } finally {
      current.intentional -= 1;
    }
  },
  verifyEstablished(socket: { remoteAddress?: string }): void {
    handle()?.internals.verifyEstablished(socket);
  },
  // Lets a test see that the guard re-checks every connection it passed on.
  // Returns the function that puts the real check back.
  watchEstablished(
    watcher: (socket: { remoteAddress?: string }) => void,
  ): () => void {
    const current = handle();
    if (!current) throw new Error('The egress guard is not installed.');
    const real = current.internals.verifyEstablished;
    current.internals.verifyEstablished = (socket) => {
      watcher(socket);
      real(socket);
    };
    return () => {
      current.internals.verifyEstablished = real;
    };
  },
};
