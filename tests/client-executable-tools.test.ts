import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventType, type RunAgentInput } from '@ag-ui/core';
import { BuiltInAgent } from '@copilotkit/runtime/v2';
import { lastValueFrom, of, toArray } from 'rxjs';
import { DotAgent } from '../src/server/dot-agent';
import { isClientExecuted } from '../src/server/run-rules';
import { Store } from '../src/server/store';
import { WorkspaceStore } from '../src/server/workspace';
import { pageReviewTool } from '../src/shared/page-review';
import { CLIENT_EXECUTABLE, SERVER_TOOL } from './helpers/event-fixtures';

// DEC-19: the precise contract test. A tool is client-executed in recovery only
// if the client declared it AND its name is in the server-owned
// clientExecutableToolNames. For that to be safe, what the browser can really
// execute, what DotAgent forwards to the model as a client tool, and the
// permitted set must not drift apart. Three assertions hold them together.
// (The recovery rows themselves are in tests/run-rules.test.ts; the real
// SIGKILL row belongs to C4b.)
const root = fileURLToPath(new URL('../', import.meta.url));

describe('the permitted set is built from the production tool definition', () => {
  it('is exactly the canonical review tool name', () => {
    expect([...CLIENT_EXECUTABLE]).toEqual([pageReviewTool.name]);
    expect(pageReviewTool.name).toBe('review_space_page');
    expect(CLIENT_EXECUTABLE.has(SERVER_TOOL)).toBe(false);
  });
});

describe('1. source contract: every client tool registration names a permitted tool', () => {
  // Hooks that register a tool the browser executes.
  const REGISTRATION_HOOKS = new Set([
    'useHumanInTheLoop',
    'useFrontendTool',
    'useFrontendTools',
    'useComponent',
    'useCopilotAction',
  ]);
  // The only names the scan can resolve statically, from production values.
  const KNOWN: Record<string, string> = {
    'pageReviewTool.name': pageReviewTool.name,
  };

  function sourceFiles(directory: string): string[] {
    return readdirSync(join(root, directory)).flatMap((name) => {
      const path = `${directory}/${name}`;
      if (statSync(join(root, path)).isDirectory()) return sourceFiles(path);
      return /\.tsx?$/.test(name) ? [path] : [];
    });
  }

  interface Registration {
    file: string;
    hook: string;
    name: string | undefined;
    text: string;
  }

  // The registrations in a set of sources (path -> text).
  function scan(files: Record<string, string>): Registration[] {
    const found: Registration[] = [];
    for (const [file, text] of Object.entries(files)) {
      const source = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.ES2023,
        true,
        file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const resolve = (expression: ts.Expression) =>
        ts.isStringLiteralLike(expression)
          ? expression.text
          : Object.hasOwn(KNOWN, expression.getText(source))
            ? KNOWN[expression.getText(source)]
            : undefined;
      const nameOf = (config: ts.Expression): string | undefined => {
        if (!ts.isObjectLiteralExpression(config)) return undefined;
        const property = config.properties.find(
          (candidate): candidate is ts.PropertyAssignment =>
            ts.isPropertyAssignment(candidate) &&
            ts.isIdentifier(candidate.name) &&
            candidate.name.text === 'name',
        );
        return property ? resolve(property.initializer) : undefined;
      };
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          REGISTRATION_HOOKS.has(node.expression.text)
        ) {
          const hook = node.expression.text;
          const [first] = node.arguments;
          const configs =
            hook === 'useFrontendTools' && ts.isArrayLiteralExpression(first)
              ? [...first.elements]
              : first
                ? [first]
                : [];
          for (const config of configs)
            found.push({
              file,
              hook,
              name: nameOf(config),
              text: config.getText(source).slice(0, 60),
            });
          if (!configs.length)
            found.push({ file, hook, name: undefined, text: '' });
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    return found;
  }

  const registrations = () =>
    scan(
      Object.fromEntries(
        sourceFiles('src/client').map((file) => [
          file,
          readFileSync(join(root, file), 'utf8'),
        ]),
      ),
    );

  // True when a registration would pass the contract below.
  const permitted = (registration: Registration) =>
    registration.name !== undefined && CLIENT_EXECUTABLE.has(registration.name);

  it('finds the real registration, so the scan is not vacuous', () => {
    const found = registrations();
    expect(found.map((r) => `${r.file}:${r.hook}`)).toEqual([
      'src/client/Chat.tsx:useHumanInTheLoop',
    ]);
  });

  it('names every registered tool with a member of the permitted set', () => {
    // An unresolvable name fails too: a new client tool must be an explicit
    // decision, not something that slips past the server-owned set.
    for (const registration of registrations())
      expect(
        permitted(registration),
        `${registration.file}: ${registration.hook}(${registration.text}) must name a tool in clientExecutableToolNames`,
      ).toBe(true);
  });

  it('registers every permitted tool, so the set is not wider than the client', () => {
    expect(new Set(registrations().map((r) => r.name))).toEqual(
      CLIENT_EXECUTABLE,
    );
  });

  it('rejects a new client tool, however it is registered', () => {
    const rogue = (code: string) =>
      scan({ 'src/client/Rogue.tsx': code }).map(permitted);
    // A new name.
    expect(rogue("useHumanInTheLoop({ name: 'delete_everything' })")).toEqual([
      false,
    ]);
    expect(rogue("useFrontendTool({ name: 'delete_everything' }, [])")).toEqual(
      [false],
    );
    expect(
      rogue("useFrontendTools([{ name: 'a' }, { name: 'delete_everything' }])"),
    ).toEqual([false, false]);
    expect(rogue("useComponent({ name: 'widget' })")).toEqual([false]);
    expect(rogue("useCopilotAction({ name: 'legacy' })")).toEqual([false]);
    // A name the scan cannot resolve is not trusted either.
    expect(rogue('useHumanInTheLoop({ name: someVariable })')).toEqual([false]);
    expect(rogue('useHumanInTheLoop(config)')).toEqual([false]);
    expect(rogue('useHumanInTheLoop({ name: constructor })')).toEqual([false]);
    expect(rogue('useHumanInTheLoop()')).toEqual([false]);
    // The canonical tool, by its production definition or its literal name.
    expect(rogue('useHumanInTheLoop({ name: pageReviewTool.name })')).toEqual([
      true,
    ]);
    expect(
      rogue(`useHumanInTheLoop({ name: '${pageReviewTool.name}' })`),
    ).toEqual([true]);
  });
});

describe('2. behaviour contract on the real DotAgent', () => {
  const databases: Array<{ close(): void }> = [];
  afterEach(() => {
    vi.restoreAllMocks();
    databases.splice(0).forEach((db) => db.close());
  });

  function fixture() {
    const store = new Store(':memory:');
    const workspace = new WorkspaceStore(':memory:', 'owner');
    databases.push(store, workspace);
    const dot = workspace.dots()[0];
    workspace.bindThread('thread', dot.id, 'Contract');
    const agent = new DotAgent(
      store,
      workspace,
      {
        intelligenceKey: 'fixture',
        apiKey: 'fixture',
        model: 'custom-model',
        baseUrl: 'https://unused.invalid/v1',
        runtimeUrl: '',
        voiceName: 'marin',
        slackUsers: [],
      },
      dot.id,
    );
    return agent;
  }

  const inputWith = (...names: string[]): RunAgentInput => ({
    threadId: 'thread',
    runId: 'run',
    state: {},
    context: [],
    messages: [{ id: 'user', role: 'user', content: 'hello' }],
    tools: names.map((name) => ({ name, description: name, parameters: {} })),
    forwardedProps: {},
  });

  // What DotAgent hands its inner agent as client tools.
  async function forwardedTools(...declared: string[]): Promise<string[]> {
    const inner = vi
      .spyOn(BuiltInAgent.prototype, 'run')
      .mockImplementation(
        () => of({ type: EventType.RUN_FINISHED } as never) as never,
      );
    await lastValueFrom(
      fixture()
        .run(inputWith(...declared))
        .pipe(toArray()),
    );
    expect(inner).toHaveBeenCalledTimes(1);
    const forwarded = inner.mock.calls[0][0].tools.map((tool) => tool.name);
    inner.mockRestore();
    return forwarded;
  }

  it('forwards exactly the declared members of the permitted set', async () => {
    expect(await forwardedTools('untrusted_tool', pageReviewTool.name)).toEqual(
      [pageReviewTool.name],
    );
    expect(await forwardedTools(pageReviewTool.name)).toEqual([
      pageReviewTool.name,
    ]);
    expect(await forwardedTools('untrusted_tool')).toEqual([]);
    expect(await forwardedTools()).toEqual([]);
  });

  it('never widens: a declared server tool name is not forwarded as a client tool', async () => {
    expect(await forwardedTools(SERVER_TOOL, 'create_space_page')).toEqual([]);
  });

  it('agrees with the recovery rule for every declared set', async () => {
    // What the model is offered as a client tool is exactly what recovery would
    // call client-executed, so the two cannot drift apart.
    for (const declared of [
      [],
      ['untrusted_tool'],
      [pageReviewTool.name],
      ['untrusted_tool', pageReviewTool.name],
      [SERVER_TOOL, pageReviewTool.name],
      [SERVER_TOOL],
    ]) {
      const names = new Set(declared);
      const recoveryView = declared
        .filter((name) => isClientExecuted(name, names, CLIENT_EXECUTABLE))
        .sort();
      expect(await forwardedTools(...declared), declared.join(',')).toEqual(
        recoveryView,
      );
    }
  });
});
