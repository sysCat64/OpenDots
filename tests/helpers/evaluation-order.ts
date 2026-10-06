import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

// path (posix, relative to the repository root) -> source text
export type Sources = Record<string, string>;

const EXTENSIONS = ['.ts', '.tsx'];

// Every TypeScript source under a repository directory, keyed by posix path.
export function readSources(repoRoot: string, directory: string): Sources {
  const sources: Sources = {};
  const walk = (current: string) => {
    for (const name of readdirSync(join(repoRoot, current))) {
      const path = `${current}/${name}`;
      if (statSync(join(repoRoot, path)).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name))
        sources[path] = readFileSync(join(repoRoot, path), 'utf8');
    }
  };
  walk(directory);
  return sources;
}

// The imports a module keeps after TypeScript erases types, in source order.
// Reading the emitted JavaScript models import elision: `import type` and
// imports used only as types load nothing at run time.
export function emittedImports(path: string, source: string) {
  const { outputText } = ts.transpileModule(source, {
    fileName: path,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2023,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  const emitted = ts.createSourceFile(
    'emitted.js',
    outputText,
    ts.ScriptTarget.ES2023,
  );
  const staticImports: string[] = [];
  const dynamicImports: string[] = [];
  for (const statement of emitted.statements) {
    if (
      (ts.isImportDeclaration(statement) ||
        ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    )
      staticImports.push(statement.moduleSpecifier.text);
  }
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    )
      dynamicImports.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(emitted);
  return { staticImports, dynamicImports };
}

function resolve(from: string, specifier: string, sources: Sources) {
  const parts = from.split('/').slice(0, -1);
  for (const part of specifier.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.') parts.push(part);
  }
  const base = parts.join('/');
  const stem = base.replace(/\.js$/, '');
  return [
    ...EXTENSIONS.map((extension) => stem + extension),
    ...EXTENSIONS.map((extension) => `${base}/index${extension}`),
  ].find((candidate) => candidate in sources);
}

// Models ES module evaluation: a module's imports run in source order, depth
// first, each module once, before the module's own body. Returns source files
// and bare package specifiers in the order they would be evaluated.
export function evaluationOrder(root: string, sources: Sources): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const evaluate = (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    for (const specifier of emittedImports(path, sources[path]).staticImports) {
      if (specifier.startsWith('.')) {
        const target = resolve(path, specifier, sources);
        if (target) evaluate(target);
      } else if (!seen.has(specifier)) {
        seen.add(specifier);
        order.push(specifier);
      }
    }
    order.push(path);
  };
  evaluate(root);
  return order;
}

export interface GuardOrder {
  reachesCopilotKit: boolean;
  // True when no CopilotKit package can load before the guard module.
  guarded: boolean;
}

export function guardOrder(
  root: string,
  sources: Sources,
  guard: string,
): GuardOrder {
  const order = evaluationOrder(root, sources);
  const firstCopilotKit = order.findIndex((entry) =>
    entry.startsWith('@copilotkit/'),
  );
  const guardAt = order.indexOf(guard);
  return {
    reachesCopilotKit: firstCopilotKit !== -1,
    guarded:
      firstCopilotKit === -1 || (guardAt !== -1 && guardAt < firstCopilotKit),
  };
}
