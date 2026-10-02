import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('../src/client/api', () => ({
  api: vi.fn(),
  ApiError: class extends Error {},
}));
import { ModelBanner, ModelPanel } from '../src/client/ModelDialog';
import { describeModel } from '../src/client/model-view';
import type { ModelList, ModelStatus } from '../src/shared/model-types';
import { modelStatus } from './fixtures/model-status';

const none = () => undefined;
const actions = {
  chooseProvider: none,
  signIn: none,
  cancel: none,
  signOut: none,
  chooseModel: none,
  refreshModels: none,
  useServerDefault: none,
};
const render = (
  status: ModelStatus,
  list?: ModelList,
  busy = false,
  error?: string,
) =>
  renderToStaticMarkup(
    <ModelPanel
      status={status}
      view={describeModel(status)}
      list={list}
      busy={busy}
      error={error}
      actions={actions}
    />,
  );
const luna = { slug: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna' };
const astra = { slug: 'gpt-6-astra', displayName: 'GPT-6 Astra' };
const list = (extra: Partial<ModelList> = {}): ModelList => ({
  models: [luna, astra],
  fetchedAt: 1,
  stale: false,
  refreshing: false,
  ...extra,
});
const connected = (extra: object = {}, selection = {}) =>
  modelStatus({
    selection,
    chatgpt: {
      state: 'signed_in',
      model: {
        effective: luna.slug,
        source: 'ui',
        saved: luna.slug,
        savedAvailable: true,
      },
      ...extra,
    },
  });

it('signed out: offers Sign in, with no link and no model picker', () => {
  const html = render(modelStatus());
  expect(html).toContain('Sign in with ChatGPT');
  expect(html).toContain('Signed out');
  expect(html).not.toContain('Continue in ChatGPT');
  expect(html).not.toContain('chatgpt-model');
  expect(html).not.toContain('Sign out');
});

it('signing in: a new-tab link that cannot reach back, Cancel, and everything else locked', () => {
  const url = 'https://auth.example.com/authorize?state=abc&x=1';
  const html = render(
    modelStatus({
      chatgpt: { state: 'signing_in', signIn: { url, expiresAt: 1 } },
    }),
  );
  expect(html).toContain('Continue in ChatGPT ↗');
  expect(html).toContain(
    'href="https://auth.example.com/authorize?state=abc&amp;x=1"',
  );
  expect(html).toContain('target="_blank"');
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).toContain('Cancel');
  expect(html).not.toContain('Sign in with ChatGPT');
  expect(html).not.toContain('Sign out');
  // Both provider choices are locked while the sign-in is pending.
  expect(html.match(/<input[^>]*disabled=""/g)).toHaveLength(2);
});

it('signing in before the link is ready says so, and offers no link', () => {
  const html = render(modelStatus({ chatgpt: { state: 'signing_in' } }));
  expect(html).toContain('Preparing the sign-in link');
  expect(html).not.toContain('Continue in ChatGPT');
  expect(html).toContain('Cancel');
});

it('signing out locks the controls and offers neither Sign in nor Cancel', () => {
  const html = render(modelStatus({ chatgpt: { state: 'signing_out' } }));
  expect(html).toContain('Signing out…');
  expect(html).not.toContain('Cancel');
  expect(html).not.toContain('Sign in with ChatGPT');
  expect(html.match(/<input[^>]*disabled=""/g)).toHaveLength(2);
});

it('connected: lists the live models, selects the one in use, and can sign out', () => {
  const html = render(connected(), list());
  expect(html).toContain('Connected');
  expect(html).toContain('Sign out');
  expect(html).toContain('GPT-5.6 Luna (gpt-5.6-luna)');
  expect(html).toContain('GPT-6 Astra (gpt-6-astra)');
  expect(html).toMatch(/<option value="gpt-5\.6-luna" selected="">/);
  expect(html).toContain('aria-label="Refresh model list"');
  expect(html).toContain('Using gpt-5.6-luna (chosen here).');
});

it('connected with the list still loading: the picker waits rather than guessing', () => {
  const html = render(connected(), undefined);
  expect(html).toContain('Loading models…');
  expect(html).toMatch(/<select[^>]*disabled=""/);
});

it('a saved model that left the account is called out, never swapped in silently', () => {
  const html = render(
    connected(
      {
        model: {
          saved: 'gpt-retired',
          savedAvailable: false,
          effective: luna.slug,
          source: 'server',
          serverDefault: luna.slug,
        },
      },
      { chatgptModel: 'gpt-retired' },
    ),
    list(),
  );
  expect(html).toContain(
    'Your saved model “gpt-retired” is no longer available',
  );
  expect(html).toContain('Using gpt-5.6-luna (server default).');
  expect(html).toContain('Choose a model'); // the picker shows no model as chosen
  expect(html).not.toMatch(/<option value="gpt-retired"/);
});

it('shows a stale list with the reason refreshing failed', () => {
  const html = render(
    connected(),
    list({
      stale: true,
      error: { code: 'refresh_not_ready', message: 'Try again shortly.' },
    }),
  );
  expect(html).toContain(
    'Showing the last list; refreshing failed: Try again shortly.',
  );
});

it('unavailable: explains why, and gives the recovery command only when there is one', () => {
  const html = render(
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
  expect(html).toContain('Unavailable');
  expect(html).toContain('The key is missing.');
  expect(html).toContain('Stop the server');
  expect(html).toContain('<code>npm run chatgpt-plan -- reset --yes</code>');
  // No reset button exists in the UI.
  expect(html.toLowerCase()).not.toMatch(/<button[^>]*>\s*reset/);
  const plain = render(
    modelStatus({
      chatgpt: {
        state: 'unavailable',
        failure: {
          code: 'keychain_unavailable',
          message: 'Unlock the Keychain.',
        },
      },
    }),
  );
  expect(plain).not.toContain('<code>');
});

it('not configured: both unavailable providers are disabled with the reason', () => {
  const html = render(
    modelStatus({
      apiKey: { available: false },
      provider: 'api-key',
      chatgpt: { state: 'not_configured' },
    }),
  );
  expect(html).toContain('Not set up');
  expect(html).toContain('Add OPENAI_API_KEY and OPENAI_MODEL on the server.');
  expect(html).toContain('Set CHATGPT_DEVKIT_DIST on the server.');
  expect(html.match(/<input[^>]*disabled=""/g)).toHaveLength(2);
});

it('lets the owner return to the server default only when something is overridden', () => {
  expect(render(connected(), list())).not.toContain('Use server default');
  const html = render(
    modelStatus({
      providerSource: 'ui',
      serverProvider: 'api-key',
      selection: { provider: 'chatgpt-plan' },
    }),
  );
  expect(html).toContain('Use server default');
  expect(html).toContain('Server default: OpenAI API key');
  expect(html).toContain('Chosen here');
});

it('disables actions while a request is in flight', () => {
  const html = render(connected(), list(), true);
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Sign out/);
  expect(html).toMatch(/<select[^>]*disabled=""/);
});

it('shows an action error and the last sign-in failure', () => {
  const html = render(
    modelStatus({
      chatgpt: {
        signInError: {
          code: 'sharing_not_enabled',
          message: 'Sharing is off.',
        },
      },
    }),
    undefined,
    false,
    'That did not work.',
  );
  expect(html).toContain('Sharing is off.');
  expect(html).toContain('That did not work.');
  expect(html).toContain('role="alert"');
});

it('renders names from the account as text, not markup', () => {
  const html = render(
    connected(),
    list({
      models: [{ slug: 'gpt-x', displayName: '<img src=x onerror=alert(1)>' }],
    }),
  );
  expect(html).not.toContain('<img');
  expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
});

it('says whether the sign-in survives a restart', () => {
  expect(render(modelStatus())).toContain('macOS Keychain');
  expect(
    render(modelStatus({ chatgpt: { persistence: 'ephemeral' } })),
  ).toContain('CHATGPT_CREDENTIAL_STORE=keychain');
});

it('the banner prompts without blocking', () => {
  const html = renderToStaticMarkup(
    <ModelBanner status={modelStatus()} onOpen={none} />,
  );
  expect(html).toContain('ChatGPT plan is selected, but you are signed out.');
  expect(html).toContain('Open Model settings');
  expect(
    renderToStaticMarkup(<ModelBanner status={undefined} onOpen={none} />),
  ).toBe('');
  expect(
    renderToStaticMarkup(
      <ModelBanner
        status={modelStatus({ provider: 'api-key' })}
        onOpen={none}
      />,
    ),
  ).toBe('');
});

it('shows a small warning for an untested DevKit build, and nothing extra for a verified one', () => {
  const untested = render(
    modelStatus({
      chatgpt: {
        state: 'signed_in',
        model: { effective: 'gpt-5.5' },
        devkit: { compatibility: 'untested', version: '0.2.0' },
      },
    }),
    list(),
  );
  expect(untested).toContain('is not one OpenDots was tested with');
  expect(untested).toContain('role="note"');
  const verified = render(
    modelStatus({
      chatgpt: {
        state: 'signed_in',
        model: { effective: 'gpt-5.5' },
        devkit: { compatibility: 'verified', version: '0.1.0' },
      },
    }),
    list(),
  );
  expect(verified).not.toContain('tested with');
  expect(verified).not.toContain('role="note"');
  // The warning lives in the dialog only; the page-level banner stays quiet.
  expect(
    renderToStaticMarkup(
      <ModelBanner
        status={modelStatus({
          chatgpt: {
            state: 'signed_in',
            model: { effective: 'gpt-5.5' },
            devkit: { compatibility: 'untested' },
          },
        })}
        onOpen={none}
      />,
    ),
  ).toBe('');
});

it('shows an incompatible DevKit as an unavailable connection with its reason', () => {
  const html = render(
    modelStatus({
      chatgpt: {
        state: 'unavailable',
        failure: {
          code: 'devkit_incompatible',
          message:
            'This DevKit is not supported by this OpenDots (expiresAt is not a millisecond timestamp).',
        },
      },
    }),
  );
  expect(html).toContain('Unavailable');
  expect(html).toContain('not supported by this OpenDots');
  expect(html).not.toContain('Sign in with ChatGPT</button>'); // signing in cannot help
});
