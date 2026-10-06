import { fileURLToPath } from 'node:url';
import { shouldEnableInspector } from '@copilotkit/shared';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { readSources } from './helpers/evaluation-order';

// In development the CopilotKit provider mounts a browser inspector that posts
// its own telemetry, outside the server-side guard. The only control is the
// provider's enableInspector prop.
const root = fileURLToPath(new URL('../', import.meta.url));
const PROVIDERS = new Set(['CopilotKitProvider', 'CopilotKit']);

describe('CopilotKit inspector', () => {
  it('is mounted in development unless the provider opts out', () => {
    // The premise of the control below, pinned against the installed SDK.
    const development = { isBrowser: true, isDevelopment: true };
    expect(
      shouldEnableInspector({ ...development, enableInspector: undefined }),
    ).toBe(true);
    expect(
      shouldEnableInspector({ ...development, enableInspector: false }),
    ).toBe(false);
  });

  it('is switched off on every CopilotKit provider the client renders', () => {
    const rendered: { file: string; optedOut: boolean }[] = [];
    const sources = readSources(root, 'src/client');
    for (const [file, source] of Object.entries(sources)) {
      const parsed = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.ES2023,
        true,
        ts.ScriptKind.TSX,
      );
      const visit = (node: ts.Node) => {
        if (
          (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
          PROVIDERS.has(node.tagName.getText(parsed))
        ) {
          const attributes = node.attributes.properties;
          const flag = attributes.find(
            (attribute) =>
              ts.isJsxAttribute(attribute) &&
              attribute.name.getText(parsed) === 'enableInspector',
          );
          rendered.push({
            file,
            // A spread could override the prop, so it cannot be trusted.
            optedOut:
              !attributes.some(ts.isJsxSpreadAttribute) &&
              !!flag &&
              ts.isJsxAttribute(flag) &&
              !!flag.initializer &&
              ts.isJsxExpression(flag.initializer) &&
              flag.initializer.expression?.kind === ts.SyntaxKind.FalseKeyword,
          });
        }
        ts.forEachChild(node, visit);
      };
      visit(parsed);
    }
    // The client does render a provider, so "every provider" is not vacuous.
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.filter((provider) => !provider.optedOut)).toEqual([]);
  });
});
