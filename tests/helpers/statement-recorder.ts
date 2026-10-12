import type { DatabaseSync, StatementSync } from 'node:sqlite';

// Records the SQL text of every statement a connection EXECUTES (run, get, all,
// iterate, exec), not only the ones it prepares, so a read-only claim can be
// checked against what actually ran. Test-only: it wraps one connection object
// and changes nothing about what that connection does.
export interface StatementRecorder {
  readonly executed: string[];
  // Executed statements that are not a plain SELECT.
  nonSelect(): string[];
  reset(): void;
  stop(): void;
}

const EXECUTORS = new Set(['run', 'get', 'all', 'iterate']);

export function recordStatements(db: DatabaseSync): StatementRecorder {
  const executed: string[] = [];
  const target = db as unknown as {
    prepare: DatabaseSync['prepare'];
    exec: DatabaseSync['exec'];
  };
  const originalPrepare = target.prepare.bind(db);
  const originalExec = target.exec.bind(db);
  target.prepare = ((sql: string) => {
    const statement = originalPrepare(sql);
    return new Proxy(statement, {
      get(inner, property) {
        const value = Reflect.get(inner, property, inner) as unknown;
        if (typeof property === 'string' && EXECUTORS.has(property))
          return (...args: unknown[]) => {
            executed.push(sql);
            return (value as (...a: unknown[]) => unknown).apply(inner, args);
          };
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(inner)
          : value;
      },
    }) as StatementSync;
  }) as DatabaseSync['prepare'];
  target.exec = ((sql: string) => {
    executed.push(sql);
    return originalExec(sql);
  }) as DatabaseSync['exec'];
  return {
    executed,
    nonSelect: () => [
      ...new Set(executed.filter((sql) => !/^\s*SELECT\b/i.test(sql))),
    ],
    reset: () => {
      executed.length = 0;
    },
    stop: () => {
      target.prepare = originalPrepare;
      target.exec = originalExec;
    },
  };
}
