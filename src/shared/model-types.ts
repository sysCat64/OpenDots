// What the browser may know about model configuration. Deliberately small: no
// tokens, keys, base URLs, raw sessions or state-file contents are representable
// here, and the server builds these objects field by field.

export type ModelProviderKind = 'api-key' | 'chatgpt-plan';

export type ChatGPTState =
  | 'not_configured'
  | 'checking'
  | 'signed_out'
  | 'signing_in'
  | 'signed_in'
  | 'signing_out'
  | 'unavailable';

export interface ModelFailure {
  code: string;
  message: string;
}

export interface ChatGPTModelInfo {
  slug: string;
  displayName: string;
}

/** The owner's saved UI choices. Absent fields fall back to the server's environment. */
export interface ModelSelection {
  provider?: ModelProviderKind;
  chatgptModel?: string;
}

export interface ModelStatus {
  /** The provider the next run will use. */
  provider: ModelProviderKind;
  providerSource: 'ui' | 'server';
  /** What "Use server default" would select. */
  serverProvider: ModelProviderKind;
  apiKey: { available: boolean };
  /** The saved UI overrides, if any. */
  selection: { provider?: ModelProviderKind; chatgptModel?: string };
  chatgpt: {
    state: ChatGPTState;
    persistence: 'keychain' | 'ephemeral';
    /** Sign-in needs a browser on the machine running the server. */
    canSignInHere: boolean;
    /** A background status check is still running. */
    refreshing: boolean;
    /** Only while signing in. The URL is not a credential but is never logged or stored. */
    signIn?: { url?: string; expiresAt: number };
    /** Why the connection is unavailable. */
    failure?: ModelFailure;
    /** Why the last sign-in attempt failed. */
    signInError?: ModelFailure;
    notice?: 'revocation_unconfirmed';
    /**
     * What is known about the DevKit build in use. "untested" means it passed
     * every compatibility check but is not a build OpenDots was verified with.
     */
    devkit?: { compatibility: 'verified' | 'untested'; version?: string };
    /** A command for the owner, only for failures that need the CLI. */
    recovery?: string;
    model: {
      /** The model the next run will use, if one can be resolved. */
      effective?: string;
      source?: 'ui' | 'server';
      saved?: string;
      /** False when the saved model is not in the account's live list. */
      savedAvailable?: boolean;
      serverDefault?: string;
    };
  };
}

export interface ModelList {
  models: ChatGPTModelInfo[];
  fetchedAt: number | null;
  stale: boolean;
  refreshing: boolean;
  error?: ModelFailure;
}

// What the DevKit guarantees for a model's slug and display name: text, not
// empty once trimmed, at most 200 characters. OpenDots adds no character set of
// its own. What may be selected or run is limited by whether the account's live
// model list contains it, not by how it is spelled.
export const MODEL_TEXT_MAX_LENGTH = 200;
export const isModelText = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim() !== '' &&
  value.length <= MODEL_TEXT_MAX_LENGTH;
