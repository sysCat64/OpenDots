import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  emittedImports,
  evaluationOrder,
  readSources,
  type Sources,
} from './helpers/evaluation-order';

// DORM-1 (docs/LOCAL_FIRST_C4_LANDING_BOUNDARY.md, section 19, layer D1). The
// conversation log, the run rules and the durable runner are dormant: nothing the application
// starts can load them, so nothing can construct a log or create a table.
// This is the static half; tests/dormancy-runtime.test.ts watches a real server.
const root = fileURLToPath(new URL('../', import.meta.url));
const LOG = 'src/server/conversation-log.ts';
const RULES = 'src/server/run-rules.ts';
const RUNNER = 'src/server/durable-runner.ts';
const DORMANT = [LOG, RULES, RUNNER];

// Every way the application starts: the server, the ChatGPT plan CLI, the
// browser worker and the web client (index.html loads src/client/main.tsx).
const ROOTS = [
  'src/server/index.ts',
  'src/server/chatgpt-plan-cli.ts',
  'src/browser/index.ts',
  'src/client/main.tsx',
];

// Source files reachable from `entry` over static imports.
const reachable = (entry: string, sources: Sources) =>
  new Set(evaluationOrder(entry, sources));

// Files whose emitted imports (static or dynamic) name the target module. The
// dormant modules may import one another (the runner uses the log and the rules);
// what must not exist is an importer outside them.
function importers(target: string, sources: Sources): string[] {
  const stem = target.replace(/^src\/server\//, '').replace(/\.ts$/, '');
  return Object.entries(sources)
    .filter(([path, text]) => {
      if (DORMANT.includes(path)) return false;
      const { staticImports, dynamicImports } = emittedImports(path, text);
      return [...staticImports, ...dynamicImports].some(
        (specifier) =>
          specifier.startsWith('.') &&
          specifier.replace(/\.js$/, '').endsWith(`/${stem}`),
      );
    })
    .map(([path]) => path)
    .sort();
}

describe('DORM-1: the dormant modules are unreachable from the production roots', () => {
  const sources = readSources(root, 'src');

  it('finds the sources and the roots, so the checks are not vacuous', () => {
    expect(Object.keys(sources)).toEqual(
      expect.arrayContaining([...ROOTS, ...DORMANT]),
    );
    for (const entry of ROOTS)
      expect(reachable(entry, sources).size, entry).toBeGreaterThan(1);
    expect(reachable('src/server/index.ts', sources)).toContain(
      'src/server/workspace.ts',
    );
  });

  it.each(ROOTS)(
    'no static import path from %s reaches either module',
    (entry) => {
      const graph = reachable(entry, sources);
      for (const dormant of DORMANT)
        expect(graph.has(dormant), dormant).toBe(false);
    },
  );

  it('no file under src outside them imports any of them (in-degree 0), statically or dynamically', () => {
    for (const dormant of DORMANT)
      expect(importers(dormant, sources), dormant).toEqual([]);
  });

  it('every source file taken as a root still cannot reach them', () => {
    // Stronger than the four entries: a file nobody imports today could become
    // an entry tomorrow.
    for (const path of Object.keys(sources).filter(
      (p) => !DORMANT.includes(p),
    )) {
      const graph = reachable(path, sources);
      for (const dormant of DORMANT)
        expect(graph.has(dormant), `${path} -> ${dormant}`).toBe(false);
    }
  });

  it('no dynamic import or require names either module', () => {
    for (const [path, text] of Object.entries(sources)) {
      if (DORMANT.includes(path)) continue;
      expect(text, path).not.toMatch(
        /conversation-log|run-rules|durable-runner/,
      );
    }
  });

  it('the table names appear in no source file but the log itself', () => {
    for (const [path, text] of Object.entries(sources))
      if (path !== LOG)
        expect(text, path).not.toMatch(
          /conversation_(runs|events|messages)|conversation_events_thread/,
        );
  });

  it('ensureSchema is mentioned by no source file but the log and, once, the runner', () => {
    for (const [path, text] of Object.entries(sources))
      if (path !== LOG && path !== RUNNER)
        expect(text, path).not.toMatch(/ensureSchema/);
    expect(readFileSync(`${root}${LOG}`, 'utf8')).toMatch(
      /ensureSchema\(\): void/,
    );
    // The runner, which only exists where someone constructs it on purpose,
    // creates the schema in exactly one place: its explicit initialization.
    const runner = sources[RUNNER];
    expect(runner.match(/ensureSchema/g)).toHaveLength(1);
    expect(runner).toMatch(
      /private initializeStorage\(\): void \{[^}]*this\.log\.ensureSchema\(\)/s,
    );
    // And neither constructor creates a table.
    expect(runner).not.toMatch(
      /constructor\([^)]*\)[^{]*\{[^}]*initializeStorage/s,
    );
  });

  it('adds no production import for the sake of a test', () => {
    // The dormant modules take everything by injection: they import no other
    // application module except the telemetry guard run-rules needs first.
    const local = (path: string) =>
      emittedImports(path, sources[path]).staticImports.filter((s) =>
        s.startsWith('.'),
      );
    expect(local(LOG)).toEqual([]);
    expect(local(RULES)).toEqual(['./telemetry-guard.js']);
    expect(local(RUNNER).sort()).toEqual([
      './conversation-log.js',
      './run-rules.js',
      './telemetry-guard.js',
    ]);
    // No file under src exists for test purposes only.
    expect(
      Object.keys(sources).filter((p) => /test|fixture|helper|mock/i.test(p)),
    ).toEqual([]);
  });
});

describe('the detector can fail (negative controls)', () => {
  const synthetic = (overrides: Sources): Sources => ({
    'src/server/index.ts': "import './app.js';\n",
    'src/server/app.ts': 'export const app = 1;\n',
    'src/server/conversation-log.ts': 'export const log = 1;\n',
    'src/server/run-rules.ts': 'export const rules = 1;\n',
    'src/server/durable-runner.ts': 'export const runner = 1;\n',
    ...overrides,
  });

  it('flags a production root that imports a dormant module', () => {
    const sources = synthetic({
      'src/server/index.ts': "import './conversation-log.js';\n",
    });
    expect(reachable('src/server/index.ts', sources).has(LOG)).toBe(true);
    expect(importers(LOG, sources)).toEqual(['src/server/index.ts']);
  });

  it('flags an indirect path through another module', () => {
    const sources = synthetic({
      'src/server/app.ts':
        "import { rules } from './run-rules.js';\nexport const app = rules;\n",
    });
    expect(reachable('src/server/index.ts', sources).has(RULES)).toBe(true);
  });

  it('flags a production module that imports the runner', () => {
    const sources = synthetic({
      'src/server/app.ts':
        "import { runner } from './durable-runner.js';\nexport const app = runner;\n",
    });
    expect(reachable('src/server/index.ts', sources).has(RUNNER)).toBe(true);
    expect(importers(RUNNER, sources)).toEqual(['src/server/app.ts']);
  });

  it('flags a dynamic import', () => {
    const sources = synthetic({
      'src/server/app.ts':
        "export const load = () => import('./conversation-log.js');\n",
    });
    expect(importers(LOG, sources)).toEqual(['src/server/app.ts']);
  });

  it('ignores a type-only import, which loads nothing', () => {
    const sources = synthetic({
      'src/server/app.ts':
        "import type { log } from './conversation-log.js';\nexport type A = typeof log;\n",
    });
    expect(reachable('src/server/index.ts', sources).has(LOG)).toBe(false);
  });
});
