import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AgentRunner } from '@copilotkit/runtime/v2';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { RunFacts } from '../src/server/run-facts';
import { readSources } from './helpers/evaluation-order';

// C4c boundary: the five accessors are server-internal facts. The global
// enumerations (`activeRuns({ all: true })`, `unresolvedRuns({ all: true })`)
// perform no per-thread ownership check, because no thread is named. They are
// for trusted in-process callers only, never for an HTTP route or any other
// request-driven path, and nothing today reaches them: the runner itself is not
// reachable from the application (tests/dormancy.test.ts).
const root = fileURLToPath(new URL('../', import.meta.url));
const FACTS = 'src/server/run-facts.ts';
const RUNNER = 'src/server/durable-runner.ts';
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

describe('the facts surface stays server-internal', () => {
  it('finds the sources, so the scans are not vacuous', () => {
    expect(Object.keys(sources)).toEqual(
      expect.arrayContaining([FACTS, RUNNER, 'src/server/app.ts']),
    );
  });

  it('is named by no source file but the runner (which constructs it) and itself', () => {
    for (const [path, text] of Object.entries(sources)) {
      if (path === FACTS || path === RUNNER) continue;
      expect(text, path).not.toMatch(/run-facts|RunFacts/);
    }
  });

  it('no accessor name appears in any module an HTTP route could be written in', () => {
    // Includes the SDK-facing accessor names. `getThreadState` (the SDK's own
    // method) is a different identifier and is not matched.
    for (const [path, text] of Object.entries(sources)) {
      if (path === FACTS || path === RUNNER) continue;
      expect(text, path).not.toMatch(
        /\.facts\b|\bunresolvedRuns\b|\bactiveRuns\b|\battemptFacts\b|\bterminalResult\b/,
      );
    }
  });

  it('is not part of the SDK AgentRunner contract', () => {
    const sdk = Object.getOwnPropertyNames(AgentRunner.prototype);
    for (const name of [
      'facts',
      'threadState',
      'activeRuns',
      'attemptFacts',
      'terminalResult',
      'unresolvedRuns',
    ])
      expect(sdk).not.toContain(name);
  });

  it('exports no HTTP handler, route or request parser from the facts module', () => {
    const text = codeOf(FACTS);
    expect(text).not.toMatch(
      /from\s+['"]hono['"]|\bRequest\b|\bResponse\b|\bapp\.(get|post)\b/,
    );
  });

  it('keeps the class surface at five accessors, all synchronous', () => {
    for (const name of [
      'threadState',
      'activeRuns',
      'attemptFacts',
      'terminalResult',
      'unresolvedRuns',
    ]) {
      const fn = (RunFacts.prototype as unknown as Record<string, unknown>)[
        name
      ];
      expect(typeof fn).toBe('function');
      // An async function (or one returning a promise by declaration) would
      // read in more than one turn and could be interleaved with admission.
      expect((fn as { constructor: { name: string } }).constructor.name).toBe(
        'Function',
      );
    }
  });
});

describe('the read-only module cannot write', () => {
  it('names no log method that writes, and no recovery or schema call', () => {
    const text = codeOf(FACTS);
    for (const forbidden of [
      'startRun',
      'appendEvent',
      'appendEvents',
      'ensureSchema',
      'rebuildMessages',
      'readMessages',
      'recoverRuns',
      'finalizeRunEvents',
      'recoveryEvents',
      'abortRun',
      '.run(',
      'INSERT',
      'UPDATE ',
      'DELETE ',
      'CREATE ',
      'DROP ',
    ])
      expect(text, forbidden).not.toContain(forbidden);
  });
});
