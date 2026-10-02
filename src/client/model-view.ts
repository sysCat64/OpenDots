import type { ModelProviderKind, ModelStatus } from '../shared/model-types';

// Turns what the server says into what the Model dialog shows and allows. Kept
// free of React so every state can be checked directly.

export type Tone = 'ok' | 'warn' | 'error' | 'neutral';

export const providerLabel = (kind: ModelProviderKind) =>
  kind === 'api-key' ? 'OpenAI API key' : 'ChatGPT plan';

export interface ModelView {
  connection: { label: string; tone: Tone; detail?: string };
  /** A transition is under way, so provider and model controls stay locked. */
  locked: boolean;
  canSignIn: boolean;
  canCancel: boolean;
  canSignOut: boolean;
  /** Only while signing in. */
  signInUrl?: string;
  waitingForLink: boolean;
  providers: Array<{
    kind: ModelProviderKind;
    label: string;
    selected: boolean;
    disabled: boolean;
    reason?: string;
  }>;
  providerSource: string;
  showModelPicker: boolean;
  modelLines: Array<{ tone: Tone; text: string }>;
  hasOverride: boolean;
  defaultLabel: string;
  persistenceNote?: string;
  notice?: string;
  signInError?: string;
  failure?: string;
  recovery?: string;
}

export function describeModel(status: ModelStatus): ModelView {
  const { chatgpt } = status;
  const state = chatgpt.state;
  const transition =
    state === 'signing_in' || state === 'signing_out' || state === 'checking';

  const connections: Record<
    typeof state,
    { label: string; tone: Tone; detail?: string }
  > = {
    not_configured: {
      label: 'Not set up',
      tone: 'neutral',
      detail:
        'Set CHATGPT_DEVKIT_DIST on the server to enable Sign in with ChatGPT.',
    },
    checking: { label: 'Checking…', tone: 'neutral' },
    signed_out: {
      label: 'Signed out',
      tone: 'warn',
      detail: chatgpt.canSignInHere
        ? undefined
        : 'Sign in on the machine that runs OpenDots.',
    },
    signing_in: {
      label: 'Waiting for ChatGPT…',
      tone: 'neutral',
      detail: 'Finish signing in in the new tab, then come back here.',
    },
    signed_in: { label: 'Connected', tone: 'ok' },
    signing_out: { label: 'Signing out…', tone: 'neutral' },
    unavailable: { label: 'Unavailable', tone: 'error' },
  };

  const model = chatgpt.model;
  const modelLines: ModelView['modelLines'] = [];
  if (model.saved && model.savedAvailable === false)
    modelLines.push({
      tone: 'warn',
      text: `Your saved model “${model.saved}” is no longer available on this account.`,
    });
  if (model.effective)
    modelLines.push({
      tone: 'neutral',
      text: `Using ${model.effective} (${
        model.source === 'ui' ? 'chosen here' : 'server default'
      }).`,
    });
  else
    modelLines.push({
      tone: model.saved ? 'error' : 'neutral',
      text: 'No model is chosen, so chats cannot start yet. Pick one below.',
    });

  const override = status.selection.provider || status.selection.chatgptModel;
  const serverModel = chatgpt.model.serverDefault;

  return {
    connection: connections[state],
    locked: transition,
    canSignIn: state === 'signed_out' && chatgpt.canSignInHere,
    canCancel: state === 'signing_in',
    canSignOut: state === 'signed_in',
    signInUrl: state === 'signing_in' ? chatgpt.signIn?.url : undefined,
    waitingForLink: state === 'signing_in' && !chatgpt.signIn?.url,
    providers: (['api-key', 'chatgpt-plan'] as const).map((kind) => {
      const unavailable =
        kind === 'api-key'
          ? !status.apiKey.available
          : state === 'not_configured';
      return {
        kind,
        label: providerLabel(kind),
        selected: status.provider === kind,
        disabled: transition || unavailable,
        ...(unavailable
          ? {
              reason:
                kind === 'api-key'
                  ? 'Add OPENAI_API_KEY and OPENAI_MODEL on the server.'
                  : 'Set CHATGPT_DEVKIT_DIST on the server.',
            }
          : {}),
      };
    }),
    providerSource:
      status.providerSource === 'ui'
        ? 'Chosen here'
        : 'From the server’s settings',
    showModelPicker: state === 'signed_in',
    modelLines,
    hasOverride: !!override,
    defaultLabel: `Server default: ${providerLabel(status.serverProvider)}${
      serverModel && status.serverProvider === 'chatgpt-plan'
        ? `, ${serverModel}`
        : ''
    }`,
    persistenceNote:
      state === 'not_configured'
        ? undefined
        : chatgpt.persistence === 'keychain'
          ? 'Your sign-in is kept in the macOS Keychain and survives restarts.'
          : 'This sign-in is forgotten when the server restarts. To keep it, set CHATGPT_CREDENTIAL_STORE=keychain on the server (macOS).',
    notice:
      chatgpt.notice === 'revocation_unconfirmed'
        ? 'Signed out here, but ChatGPT could not confirm the revocation. Disconnect OpenDots in your ChatGPT settings.'
        : undefined,
    signInError: chatgpt.signInError?.message,
    failure: chatgpt.failure?.message,
    recovery: chatgpt.recovery,
  };
}

/** A soft prompt, never a gate: chats are not blocked by it. */
export function modelBanner(status: ModelStatus): string | undefined {
  if (status.provider !== 'chatgpt-plan') return undefined;
  const { state, model } = status.chatgpt;
  if (state === 'signed_out')
    return 'ChatGPT plan is selected, but you are signed out.';
  if (state === 'unavailable')
    return 'ChatGPT plan is selected, but its connection is unavailable.';
  if (state === 'signed_in' && !model.effective)
    return 'ChatGPT plan is connected, but no model is chosen.';
  return undefined;
}
