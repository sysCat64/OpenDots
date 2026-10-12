import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AgentRunner } from '@copilotkit/runtime/v2';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  emittedImports,
  evaluationOrder,
  readSources,
} from './helpers/evaluation-order';

// R-DIAG boundary: the diagnosis is server-internal, advisory and read-only. It
// is named by no other source file, reachable from no application root, cannot
// call a log method that writes, and exposes no HTTP surface. It is not the
// resolver and not an admission check: nothing here may be read as either.
const root = fileURLToPath(new URL('../', import.meta.url));
const DIAG = 'src/server/run-diagnosis.ts';
const sources = readSources(root, 'src');

// The module's code without its comments, so a scan reads what it does and not
// what it explains.
const codeOf = (path: string) =>
  ts.transpileModule(readFileSync(`${root}${path}`, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2023,
      removeComments: true,
    },
  }).outputText;

describe('the diagnosis stays server-internal', () => {
  it('finds the source, so the scans are not vacuous', () => {
    expect(Object.keys(sources)).toEqual(
      expect.arrayContaining([DIAG, 'src/server/app.ts']),
    );
    expect(sources[DIAG].length).toBeGreaterThan(1_000);
  });

  it('is named by no other source file', () => {
    for (const [path, text] of Object.entries(sources)) {
      if (path === DIAG) continue;
      expect(text, path).not.toMatch(
        /run-diagnosis|RunDiagnosis|diagnoseThread|diagnoseRun|confirmEvidence/,
      );
    }
  });

  it('is imported by no module, statically or dynamically, and no application root reaches it', () => {
    for (const [path, text] of Object.entries(sources)) {
      if (path === DIAG) continue;
      const { staticImports, dynamicImports } = emittedImports(path, text);
      for (const specifier of [...staticImports, ...dynamicImports])
        expect(specifier, path).not.toMatch(/run-diagnosis/);
    }
    for (const entry of [
      'src/server/index.ts',
      'src/server/chatgpt-plan-cli.ts',
      'src/browser/index.ts',
      'src/client/main.tsx',
    ])
      expect(new Set(evaluationOrder(entry, sources)).has(DIAG), entry).toBe(
        false,
      );
  });

  it('adds no dependency beyond the log, the facts, the rules and the guard', () => {
    const local = emittedImports(DIAG, sources[DIAG])
      .staticImports.filter((specifier) => specifier.startsWith('.'))
      .sort();
    expect(local).toEqual([
      './conversation-log.js',
      './run-facts.js',
      './run-rules.js',
      './telemetry-guard.js',
    ]);
  });

  it('loads the telemetry guard first', () => {
    const { staticImports } = emittedImports(DIAG, sources[DIAG]);
    expect(staticImports[0]).toBe('./telemetry-guard.js');
  });

  it('is not part of the SDK AgentRunner contract and the runner exposes no diagnosis', () => {
    const sdk = Object.getOwnPropertyNames(AgentRunner.prototype);
    for (const name of ['diagnoseThread', 'diagnoseRun', 'confirmEvidence'])
      expect(sdk).not.toContain(name);
    expect(sources['src/server/durable-runner.ts']).not.toMatch(/diagnos/i);
  });

  it('exports no HTTP handler, route or request parser', () => {
    expect(codeOf(DIAG)).not.toMatch(
      /from\s+['"]hono['"]|\bRequest\b|\bResponse\b|\bapp\.(get|post|put|delete)\b|\bfetch\(/,
    );
  });
});

describe('the diagnosis cannot write, recover, run or touch the outside', () => {
  it('names no log method that writes, no schema, recovery or rebuild call and no SQL that changes data', () => {
    const text = codeOf(DIAG);
    for (const forbidden of [
      'startRun',
      'appendEvent',
      'appendEvents',
      'ensureSchema',
      'rebuildMessages',
      'readMessages',
      'deriveMessages',
      'recoverRuns',
      'finalizeRunEvents',
      'abortRun',
      'stopAll',
      '.stop(',
      '.run(',
      '.ready(',
      'INSERT',
      'UPDATE ',
      'DELETE ',
      'CREATE ',
      'DROP ',
      'BEGIN',
      'COMMIT',
    ])
      expect(text, forbidden).not.toContain(forbidden);
  });

  it('takes the log as a read-only structural subset, so a writer cannot be passed by mistake', () => {
    const source = sources[DIAG];
    expect(source).toMatch(
      /Pick<\s*ConversationLog,\s*'hasSchema'\s*\|\s*'runs'\s*\|\s*'runEvents'\s*>/,
    );
  });

  it('reaches no file system, process, network or environment API', () => {
    const text = codeOf(DIAG);
    expect(text).not.toMatch(
      /node:(fs|child_process|net|http|https|dns|tls|os|worker_threads|vm)|process\.env|require\(|import\(/,
    );
    const imports = emittedImports(DIAG, sources[DIAG]).staticImports.filter(
      (specifier) => !specifier.startsWith('.'),
    );
    expect(imports.sort()).toEqual(
      ['@ag-ui/client', '@copilotkit/runtime/v2', 'node:crypto', 'rxjs'].sort(),
    );
  });

  it('keeps the pure recovery planner away from the log: its result is read for event types only', () => {
    const text = codeOf(DIAG);
    expect(text).not.toMatch(/\blog\.(append|start|ensure|rebuild)/);
    expect(text).not.toMatch(/\.runningRuns\(|\.threadEvents\(/);
  });
});
