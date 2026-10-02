import { describe, expect, it } from 'vitest';
import { describeModel, modelBanner } from '../src/client/model-view';
import { setupNote } from '../src/client/WorkspaceDialog';
import { modelStatus } from './fixtures/model-status';

describe('connection states', () => {
  it.each([
    ['not_configured', 'Not set up', 'neutral', false],
    ['checking', 'Checking…', 'neutral', true],
    ['signed_out', 'Signed out', 'warn', false],
    ['signing_in', 'Waiting for ChatGPT…', 'neutral', true],
    ['signed_in', 'Connected', 'ok', false],
    ['signing_out', 'Signing out…', 'neutral', true],
    ['unavailable', 'Unavailable', 'error', false],
  ] as const)('%s', (state, label, tone, locked) => {
    const view = describeModel(modelStatus({ chatgpt: { state } }));
    expect(view.connection).toMatchObject({ label, tone });
    expect(view.locked).toBe(locked);
  });

  it('offers sign-in only when signed out and on the server machine', () => {
    expect(describeModel(modelStatus()).canSignIn).toBe(true);
    const away = describeModel(
      modelStatus({ chatgpt: { canSignInHere: false } }),
    );
    expect(away.canSignIn).toBe(false);
    expect(away.connection.detail).toMatch(/machine that runs OpenDots/);
    for (const state of [
      'checking',
      'signing_in',
      'signed_in',
      'unavailable',
    ] as const)
      expect(describeModel(modelStatus({ chatgpt: { state } })).canSignIn).toBe(
        false,
      );
  });

  it('offers cancel only while signing in, and sign-out only when connected', () => {
    const signingIn = describeModel(
      modelStatus({ chatgpt: { state: 'signing_in' } }),
    );
    expect([signingIn.canCancel, signingIn.canSignOut]).toEqual([true, false]);
    const connected = describeModel(
      modelStatus({ chatgpt: { state: 'signed_in' } }),
    );
    expect([connected.canCancel, connected.canSignOut]).toEqual([false, true]);
  });

  it('shows the link only while signing in, and says when it is not ready yet', () => {
    const url = 'https://auth.example.com/authorize?x=1';
    const waiting = describeModel(
      modelStatus({ chatgpt: { state: 'signing_in' } }),
    );
    expect(waiting).toMatchObject({
      signInUrl: undefined,
      waitingForLink: true,
    });
    const ready = describeModel(
      modelStatus({
        chatgpt: { state: 'signing_in', signIn: { url, expiresAt: 1 } },
      }),
    );
    expect(ready).toMatchObject({ signInUrl: url, waitingForLink: false });
    // A stray URL outside signing in is never shown.
    const stray = describeModel(
      modelStatus({
        chatgpt: { state: 'signed_out', signIn: { url, expiresAt: 1 } },
      }),
    );
    expect(stray.signInUrl).toBeUndefined();
  });

  it('carries failures, recovery and the revocation notice', () => {
    const view = describeModel(
      modelStatus({
        chatgpt: {
          state: 'unavailable',
          failure: {
            code: 'credential_key_missing',
            message: 'The key is missing.',
          },
          recovery: 'npm run chatgpt-plan -- reset --yes',
        },
      }),
    );
    expect(view).toMatchObject({
      failure: 'The key is missing.',
      recovery: 'npm run chatgpt-plan -- reset --yes',
    });
    expect(
      describeModel(
        modelStatus({ chatgpt: { notice: 'revocation_unconfirmed' } }),
      ).notice,
    ).toMatch(/could not confirm/);
    expect(
      describeModel(
        modelStatus({
          chatgpt: { signInError: { code: 'x', message: 'Sharing is off.' } },
        }),
      ).signInError,
    ).toBe('Sharing is off.');
  });

  it('says whether the sign-in survives a restart', () => {
    expect(describeModel(modelStatus()).persistenceNote).toMatch(/Keychain/);
    expect(
      describeModel(modelStatus({ chatgpt: { persistence: 'ephemeral' } }))
        .persistenceNote,
    ).toMatch(/CHATGPT_CREDENTIAL_STORE=keychain/);
    expect(
      describeModel(modelStatus({ chatgpt: { state: 'not_configured' } }))
        .persistenceNote,
    ).toBeUndefined();
  });
});

describe('providers', () => {
  it('marks the selected one and says where the choice came from', () => {
    const view = describeModel(modelStatus({ providerSource: 'ui' }));
    expect(view.providers.map((p) => [p.kind, p.selected])).toEqual([
      ['api-key', false],
      ['chatgpt-plan', true],
    ]);
    expect(view.providerSource).toBe('Chosen here');
    expect(describeModel(modelStatus()).providerSource).toMatch(/server/);
  });

  it('disables a provider the server has not configured, with the reason', () => {
    const noKey = describeModel(modelStatus({ apiKey: { available: false } }));
    expect(noKey.providers[0]).toMatchObject({ disabled: true });
    expect(noKey.providers[0].reason).toMatch(/OPENAI_API_KEY/);
    const noChatGPT = describeModel(
      modelStatus({ chatgpt: { state: 'not_configured' } }),
    );
    expect(noChatGPT.providers[1]).toMatchObject({ disabled: true });
    expect(noChatGPT.providers[1].reason).toMatch(/CHATGPT_DEVKIT_DIST/);
  });

  it('locks both while something is changing', () => {
    const view = describeModel(
      modelStatus({ chatgpt: { state: 'signing_in' } }),
    );
    expect(view.providers.every((p) => p.disabled)).toBe(true);
  });
});

describe('model line', () => {
  const signedIn = (model: object, selection = {}) =>
    describeModel(
      modelStatus({ selection, chatgpt: { state: 'signed_in', model } }),
    );

  it('names the model in use and where it came from', () => {
    expect(
      signedIn({ effective: 'gpt-5.6-luna', source: 'ui' }).modelLines[0].text,
    ).toBe('Using gpt-5.6-luna (chosen here).');
    expect(
      signedIn({ effective: 'gpt-5.5', source: 'server' }).modelLines[0].text,
    ).toMatch(/server default/);
  });

  it('warns that a saved model is gone, and what is used instead (never silently)', () => {
    const view = signedIn({
      saved: 'gpt-retired',
      savedAvailable: false,
      effective: 'gpt-5.5',
      source: 'server',
    });
    expect(view.modelLines.map((l) => l.text)).toEqual([
      'Your saved model “gpt-retired” is no longer available on this account.',
      'Using gpt-5.5 (server default).',
    ]);
    expect(view.modelLines[0].tone).toBe('warn');
  });

  it('says plainly when no model can be used', () => {
    const view = signedIn({ saved: 'gpt-retired', savedAvailable: false });
    expect(view.modelLines.at(-1)).toMatchObject({ tone: 'error' });
    expect(view.modelLines.at(-1)?.text).toMatch(/No model is chosen/);
  });

  it('shows only the picker, and the override reset, when they apply', () => {
    expect(describeModel(modelStatus()).showModelPicker).toBe(false);
    expect(signedIn({}).showModelPicker).toBe(true);
    expect(signedIn({}).hasOverride).toBe(false);
    const view = describeModel(
      modelStatus({
        serverProvider: 'api-key',
        selection: { provider: 'chatgpt-plan' },
      }),
    );
    expect(view.hasOverride).toBe(true);
    expect(view.defaultLabel).toBe('Server default: OpenAI API key');
    expect(
      describeModel(
        modelStatus({
          selection: { chatgptModel: 'gpt-6-astra' },
          chatgpt: { model: { serverDefault: 'gpt-5.5' } },
        }),
      ).defaultLabel,
    ).toBe('Server default: ChatGPT plan, gpt-5.5');
  });
});

describe('soft banner', () => {
  it('prompts, never gates, for the states that need the owner', () => {
    expect(modelBanner(modelStatus())).toMatch(/signed out/);
    expect(
      modelBanner(modelStatus({ chatgpt: { state: 'unavailable' } })),
    ).toMatch(/unavailable/);
    expect(
      modelBanner(modelStatus({ chatgpt: { state: 'signed_in', model: {} } })),
    ).toMatch(/no model is chosen/);
  });

  it('stays quiet when all is well, while transitioning, or on another provider', () => {
    expect(
      modelBanner(
        modelStatus({
          chatgpt: { state: 'signed_in', model: { effective: 'gpt-5.5' } },
        }),
      ),
    ).toBeUndefined();
    for (const state of [
      'checking',
      'signing_in',
      'signing_out',
      'not_configured',
    ] as const)
      expect(modelBanner(modelStatus({ chatgpt: { state } }))).toBeUndefined();
    expect(modelBanner(modelStatus({ provider: 'api-key' }))).toBeUndefined();
  });
});

describe('setup note', () => {
  it('separates environment variables from things fixed in Model settings', () => {
    expect(setupNote([])).toMatch(/Text configuration is present/);
    expect(setupNote(['INTELLIGENCE_API_KEY', 'OPENAI_MODEL'])).toBe(
      'Add INTELLIGENCE_API_KEY, OPENAI_MODEL to the server environment, then restart.',
    );
    expect(
      setupNote([
        'CHATGPT_DEVKIT_DIST',
        'ChatGPT model (choose one in Model settings)',
      ]),
    ).toBe(
      'Add CHATGPT_DEVKIT_DIST to the server environment, then restart. Still needed: ChatGPT model (choose one in Model settings).',
    );
  });
});
