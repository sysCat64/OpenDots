import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  emittedImports,
  guardOrder,
  readSources,
} from './helpers/evaluation-order';

// CopilotKit reads its telemetry setting while its modules initialise, so the
// application guard must be evaluated first on every path that can load it.
// ES module evaluation order is fixed by the import graph, so it is checked
// here from the TypeScript-emitted imports instead of trusting that an import
// "happens to run first".
const root = fileURLToPath(new URL('../', import.meta.url));
const GUARD = 'src/server/telemetry-guard.ts';

describe('telemetry guard evaluation order in the shipped sources', () => {
  const sources = readSources(root, 'src');
  const serverModules = Object.keys(sources).filter(
    (path) => path.startsWith('src/server/') && path !== GUARD,
  );

  it('evaluates the guard before CopilotKit from the server entry', () => {
    const entry = guardOrder('src/server/index.ts', sources, GUARD);
    // The entry really does reach CopilotKit, so "guarded" is not vacuous.
    expect(entry.reachesCopilotKit).toBe(true);
    expect(entry.guarded).toBe(true);
    // The entry owns its protection instead of relying on a later import, which
    // would also miss a package that loads CopilotKit on its own.
    expect(
      emittedImports('src/server/index.ts', sources['src/server/index.ts'])
        .staticImports[0],
    ).toBe('./telemetry-guard.js');
  });

  it('evaluates the guard first when any server module is the root', () => {
    // A test, or a future entry point, can import any server module directly.
    const unguarded = serverModules.filter(
      (path) => !guardOrder(path, sources, GUARD).guarded,
    );
    expect(unguarded).toEqual([]);
    expect(
      serverModules.some(
        (path) => guardOrder(path, sources, GUARD).reachesCopilotKit,
      ),
    ).toBe(true);
  });

  it('keeps the other shipped entries clear of unguarded CopilotKit', () => {
    for (const entry of [
      'src/server/chatgpt-plan-cli.ts',
      'src/browser/index.ts',
    ])
      expect(guardOrder(entry, sources, GUARD).guarded).toBe(true);
  });

  it('never loads CopilotKit through a dynamic import in server code', () => {
    // A dynamic import runs whenever it is called, outside the static order.
    const dynamic = Object.keys(sources)
      .filter((path) => path.startsWith('src/server/'))
      .flatMap((path) =>
        emittedImports(path, sources[path]).dynamicImports.filter((target) =>
          target.startsWith('@copilotkit/'),
        ),
      );
    expect(dynamic).toEqual([]);
  });
});

describe('guard order analysis on constructed module graphs', () => {
  const sdk = "import '@copilotkit/runtime/v2';";
  const guard = '// guard';

  it('accepts a guard imported before CopilotKit', () => {
    const sources = {
      'src/server/guard.ts': guard,
      'src/server/entry.ts': "import './guard.js'; import './app.js';",
      'src/server/app.ts': sdk,
    };
    expect(
      guardOrder('src/server/entry.ts', sources, 'src/server/guard.ts'),
    ).toEqual({ reachesCopilotKit: true, guarded: true });
  });

  it('rejects a guard imported after CopilotKit', () => {
    const sources = {
      'src/server/guard.ts': guard,
      'src/server/entry.ts': "import './app.js'; import './guard.js';",
      'src/server/app.ts': sdk,
    };
    expect(
      guardOrder('src/server/entry.ts', sources, 'src/server/guard.ts'),
    ).toEqual({ reachesCopilotKit: true, guarded: false });
  });

  it('rejects a module that loads CopilotKit when no guard is imported', () => {
    const sources = {
      'src/server/guard.ts': guard,
      'src/server/app.ts': sdk,
    };
    expect(
      guardOrder('src/server/app.ts', sources, 'src/server/guard.ts'),
    ).toEqual({ reachesCopilotKit: true, guarded: false });
  });

  it('ignores imports that TypeScript erases', () => {
    const sources = {
      'src/server/guard.ts': guard,
      'src/server/app.ts':
        "import type { X } from '@copilotkit/runtime/v2'; export const y: X | undefined = undefined;",
    };
    expect(
      guardOrder('src/server/app.ts', sources, 'src/server/guard.ts'),
    ).toEqual({ reachesCopilotKit: false, guarded: true });
  });

  it('finds a dynamic import of CopilotKit', () => {
    const imports = emittedImports(
      'src/server/lazy.ts',
      "export const load = () => import('@copilotkit/runtime/v2');",
    );
    expect(imports.dynamicImports).toEqual(['@copilotkit/runtime/v2']);
  });
});
