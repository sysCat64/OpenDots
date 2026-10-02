import { z } from 'zod';
import type { ChatGPTPlanSession } from './chatgpt-devkit.js';
import { ChatGPTPlanError, chatgptPlanProvider } from './chatgpt-plan.js';
import {
  CredentialStoreError,
  credentialFailureHint,
} from './credential-errors.js';
import {
  apiKeyProvider,
  type ApiKeyModelConfig,
  type ModelProvider,
} from './model-provider.js';
import {
  MODEL_SLUG_PATTERN,
  type ChatGPTState,
  type ModelFailure,
  type ModelList,
  type ModelProviderKind,
  type ModelSelection,
  type ModelStatus,
} from '../shared/model-types.js';

// Everything the Web UI can do with models, behind one object: which provider
// runs next, the ChatGPT connection (sign-in, sign-out, status), the live list
// of models, and the owner's saved choices. The browser only ever receives the
// objects built here, field by field, and checked against a strict schema.

const SIGN_IN_WINDOW_MS = 10 * 60_000; // the DevKit gives up after this
const RECOVERY_COMMAND = 'npm run chatgpt-plan -- reset --yes';
const RECOVERY_CODES = new Set([
  'credential_key_missing',
  'credential_key_invalid',
  'credential_ciphertext_invalid',
]);
const MODEL_MISSING = 'ChatGPT model (choose one in Model settings)';

export class ModelServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 409 | 502,
  ) {
    super(message);
    this.name = 'ModelServiceError';
  }
}

export interface ModelSelectionStore {
  modelSelection(): ModelSelection;
  setModelSelection(patch: ModelSelection): ModelSelection;
  clearModelSelection(): void;
}

export interface ModelServiceOptions {
  store: ModelSelectionStore;
  apiKey: ApiKeyModelConfig;
  /** What the environment says. Used when the owner has saved no choice. */
  server: { provider?: ModelProviderKind; chatgptModel?: string };
  /** Present when the DevKit is configured. */
  chatgpt?: {
    credentialStore: 'ephemeral' | 'keychain';
    createSession(
      openBrowser: (url: string) => void,
    ): Promise<ChatGPTPlanSession>;
  };
  /** Sign-in needs a browser on the machine running the server. */
  loopback: boolean;
  now?: () => number;
  /** A status check running longer than this is reported as still checking. */
  statusTimeoutMs?: number;
  statusIntervalMs?: number;
  modelRefreshIntervalMs?: number;
  signInUrlWaitMs?: number;
}

const failureSchema = z.strictObject({ code: z.string(), message: z.string() });
const providerSchema = z.enum(['api-key', 'chatgpt-plan']);
export const modelStatusSchema = z.strictObject({
  provider: providerSchema,
  providerSource: z.enum(['ui', 'server']),
  serverProvider: providerSchema,
  apiKey: z.strictObject({ available: z.boolean() }),
  selection: z.strictObject({
    provider: providerSchema.optional(),
    chatgptModel: z.string().optional(),
  }),
  chatgpt: z.strictObject({
    state: z.enum([
      'not_configured',
      'checking',
      'signed_out',
      'signing_in',
      'signed_in',
      'signing_out',
      'unavailable',
    ]),
    persistence: z.enum(['keychain', 'ephemeral']),
    canSignInHere: z.boolean(),
    refreshing: z.boolean(),
    signIn: z
      .strictObject({ url: z.string().optional(), expiresAt: z.number() })
      .optional(),
    failure: failureSchema.optional(),
    signInError: failureSchema.optional(),
    notice: z.literal('revocation_unconfirmed').optional(),
    recovery: z.string().optional(),
    model: z.strictObject({
      effective: z.string().optional(),
      source: z.enum(['ui', 'server']).optional(),
      saved: z.string().optional(),
      savedAvailable: z.boolean().optional(),
      serverDefault: z.string().optional(),
    }),
  }),
});
export const modelListSchema = z.strictObject({
  models: z.array(
    z.strictObject({ slug: z.string(), displayName: z.string() }),
  ),
  fetchedAt: z.number().nullable(),
  stale: z.boolean(),
  refreshing: z.boolean(),
  error: failureSchema.optional(),
});

// The authorization URL is handed to the owner's browser, so hold it to the
// minimum: https, and no embedded credentials.
export function isSafeAuthorizationUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

// Only messages written for the owner reach the browser.
function safeFailure(error: unknown, fallback: ModelFailure): ModelFailure {
  if (error instanceof ChatGPTPlanError)
    return { code: error.code, message: error.message };
  if (error instanceof CredentialStoreError)
    return { code: error.code, message: credentialFailureHint(error.code) };
  return fallback;
}

// A wait that never keeps the process alive on its own.
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

type Status =
  ReturnType<ChatGPTPlanSession['status']> extends Promise<infer T> ? T : never;

export class ModelService {
  /** What the agent loop uses. Answers follow the owner's current choices. */
  readonly provider: ModelProvider;
  private session?: ChatGPTPlanSession;
  private state: ChatGPTState;
  private failure?: ModelFailure;
  private signInError?: ModelFailure;
  private notice?: 'revocation_unconfirmed';
  private signIn?: {
    url?: string;
    expiresAt: number;
    controller: AbortController;
    operation: Promise<void>;
    urlReady: () => void;
  };
  private epoch = 0;
  private checking?: { promise: Promise<void>; startedAt: number };
  private lastCheckAt = 0;
  private modelAttemptAt = 0;
  private starting?: Promise<void>;
  private readonly now: () => number;
  private readonly statusTimeoutMs: number;
  private readonly statusIntervalMs: number;
  private readonly modelRefreshIntervalMs: number;
  private readonly signInUrlWaitMs: number;

  constructor(private options: ModelServiceOptions) {
    this.now = options.now ?? Date.now;
    this.statusTimeoutMs = options.statusTimeoutMs ?? 3_000;
    this.statusIntervalMs = options.statusIntervalMs ?? 5_000;
    this.modelRefreshIntervalMs = options.modelRefreshIntervalMs ?? 30_000;
    this.signInUrlWaitMs = options.signInUrlWaitMs ?? 5_000;
    this.state = options.chatgpt ? 'checking' : 'not_configured';
    const resolve = () => this.resolveProvider();
    this.provider = {
      get kind() {
        return resolve().kind;
      },
      get configured() {
        return resolve().configured;
      },
      get missing() {
        return resolve().missing;
      },
      get modelOptions() {
        return resolve().modelOptions;
      },
      createAdapter: () => resolve().createAdapter(),
      snapshot: resolve,
    };
  }

  /** Opens the ChatGPT session and reads its state. Never throws; never opens a browser. */
  start(): Promise<void> {
    this.starting ??= this.open();
    return this.starting;
  }

  private async open() {
    const chatgpt = this.options.chatgpt;
    if (!chatgpt) return;
    try {
      this.session = await chatgpt.createSession(this.captureUrl);
    } catch (error) {
      this.state = 'unavailable';
      this.failure =
        error instanceof CredentialStoreError
          ? { code: error.code, message: credentialFailureHint(error.code) }
          : {
              code: 'devkit_unavailable',
              message:
                error instanceof Error &&
                /CHATGPT_DEVKIT_DIST/.test(error.message)
                  ? error.message
                  : 'The Sign in with ChatGPT component could not be started.',
            };
      return;
    }
    this.kickCheck(true);
    await this.checking?.promise;
  }

  // --- status ------------------------------------------------------------

  /**
   * An instant snapshot. Reading the connection can wait on the DevKit's storage
   * lock for a long time, so it runs in the background (one at a time, at most
   * every few seconds) and this never waits for it.
   */
  status(): ModelStatus {
    this.kickCheck();
    return modelStatusSchema.parse(this.buildStatus());
  }

  private kickCheck(force = false) {
    const session = this.session;
    if (!session || this.checking) return;
    if (this.state === 'signing_in' || this.state === 'signing_out') return;
    if (!force && this.now() - this.lastCheckAt < this.statusIntervalMs) return;
    const epoch = this.epoch;
    const promise = session
      .status()
      .then(
        (status) => this.applyCheck(status, epoch),
        () => {
          if (epoch !== this.epoch) return;
          this.state = 'unavailable';
          this.failure = {
            code: 'status_failed',
            message: 'The ChatGPT connection could not be read.',
          };
        },
      )
      .finally(() => {
        this.checking = undefined;
        this.lastCheckAt = this.now();
      });
    this.checking = { promise, startedAt: this.now() };
  }

  private applyCheck(status: Status, epoch: number) {
    // A sign-in or sign-out began while this was running: its result wins.
    if (epoch !== this.epoch) return;
    const before = this.state;
    if (status.state === 'unavailable') {
      this.state = 'unavailable';
      this.failure = {
        code: status.failure.code,
        message: status.failure.hint,
      };
      return;
    }
    this.failure = undefined;
    this.state = status.state;
    if (status.state === 'signed_in' && before !== 'signed_in')
      this.refreshModelsInBackground(true);
  }

  private buildStatus() {
    const selection = this.options.store.modelSelection();
    const current = this.effectiveProvider(selection);
    const server = this.effectiveProvider({});
    const model = this.resolveChatGPTModel(selection);
    const failure = this.state === 'unavailable' ? this.failure : undefined;
    return {
      provider: current.provider,
      providerSource: current.source,
      serverProvider: server.provider,
      apiKey: { available: this.apiKeyAvailable() },
      selection,
      chatgpt: {
        state: this.state,
        persistence: this.options.chatgpt?.credentialStore ?? 'ephemeral',
        canSignInHere: this.options.loopback && this.state !== 'not_configured',
        refreshing:
          !!this.checking &&
          this.now() - this.checking.startedAt >= this.statusTimeoutMs,
        ...(this.state === 'signing_in' && this.signIn
          ? {
              signIn: {
                ...(this.signIn.url ? { url: this.signIn.url } : {}),
                expiresAt: this.signIn.expiresAt,
              },
            }
          : {}),
        ...(failure ? { failure } : {}),
        ...(this.state === 'signed_out' && this.signInError
          ? { signInError: this.signInError }
          : {}),
        ...(this.state === 'signed_out' && this.notice
          ? { notice: this.notice }
          : {}),
        ...(failure && RECOVERY_CODES.has(failure.code)
          ? { recovery: RECOVERY_COMMAND }
          : {}),
        model,
      },
    };
  }

  // --- provider and model resolution --------------------------------------

  private apiKeyAvailable() {
    return apiKeyProvider(this.options.apiKey).configured;
  }

  private effectiveProvider(selection: ModelSelection): {
    provider: ModelProviderKind;
    source: 'ui' | 'server';
  } {
    const available = {
      'api-key': this.apiKeyAvailable(),
      'chatgpt-plan': !!this.options.chatgpt,
    };
    const saved = selection.provider;
    if (saved && available[saved]) return { provider: saved, source: 'ui' };
    const env = this.options.server.provider;
    if (env) return { provider: env, source: 'server' };
    if (available['api-key']) return { provider: 'api-key', source: 'server' };
    if (available['chatgpt-plan'])
      return { provider: 'chatgpt-plan', source: 'server' };
    return { provider: 'api-key', source: 'server' };
  }

  // The saved model if the account offers it, else the server's default if it
  // does, else none. While the list is unknown (signed out, or not loaded yet)
  // availability cannot be judged, so the choice is taken as is; every request
  // still checks the live list and refuses a model that is gone.
  private resolveChatGPTModel(selection: ModelSelection) {
    const snapshot = this.session?.models.snapshot();
    const known =
      snapshot && snapshot.fetchedAt !== undefined
        ? new Set(snapshot.models.map((model) => model.slug))
        : undefined;
    const has = (slug: string) => (known ? known.has(slug) : undefined);
    const saved = selection.chatgptModel;
    const configured = this.options.server.chatgptModel;
    const serverDefault =
      configured && MODEL_SLUG_PATTERN.test(configured)
        ? configured
        : undefined;
    let effective: string | undefined;
    let source: 'ui' | 'server' | undefined;
    if (saved && has(saved) !== false) {
      effective = saved;
      source = 'ui';
    } else if (serverDefault && has(serverDefault) !== false) {
      effective = serverDefault;
      source = 'server';
    }
    return {
      ...(effective ? { effective, source } : {}),
      ...(saved ? { saved, savedAvailable: has(saved) } : {}),
      ...(serverDefault ? { serverDefault } : {}),
    };
  }

  private resolveProvider(): ModelProvider {
    const selection = this.options.store.modelSelection();
    if (this.effectiveProvider(selection).provider === 'chatgpt-plan')
      return chatgptPlanProvider({
        auth: this.session?.auth,
        model: this.resolveChatGPTModel(selection).effective,
        modelMissing: MODEL_MISSING,
      });
    return apiKeyProvider(this.options.apiKey);
  }

  // --- choices -------------------------------------------------------------

  setProvider(provider: ModelProviderKind): ModelStatus {
    if (provider === 'api-key' && !this.apiKeyAvailable())
      throw new ModelServiceError(
        'api_key_not_configured',
        'The OpenAI API key provider is not configured on the server.',
        409,
      );
    if (provider === 'chatgpt-plan' && !this.options.chatgpt)
      throw new ModelServiceError(
        'chatgpt_not_configured',
        'ChatGPT plan sign-in is not configured on the server.',
        409,
      );
    this.options.store.setModelSelection({ provider });
    return this.status();
  }

  async setChatGPTModel(slug: string): Promise<ModelStatus> {
    if (!MODEL_SLUG_PATTERN.test(slug))
      throw new ModelServiceError(
        'invalid_model',
        'Choose a model from the list.',
        400,
      );
    const session = this.requireSignedIn();
    // A cached list that lacks the model gets one fresh check before refusing.
    let list = await this.listForSelection(session, false);
    if (!list.includes(slug)) list = await this.listForSelection(session, true);
    if (!list.includes(slug))
      throw new ModelServiceError(
        'model_unavailable',
        `Model "${slug}" is not available to this ChatGPT account.`,
        409,
      );
    this.options.store.setModelSelection({ chatgptModel: slug });
    return this.status();
  }

  private async listForSelection(session: ChatGPTPlanSession, force: boolean) {
    try {
      return (await session.models.list({ force })).map((model) => model.slug);
    } catch (error) {
      throw new ModelServiceError(
        'models_unavailable',
        safeFailure(error, {
          code: 'models_unavailable',
          message: 'The model list could not be loaded. Try again.',
        }).message,
        502,
      );
    }
  }

  /** Back to the server's defaults for both provider and model. */
  clearSelection(): ModelStatus {
    this.options.store.clearModelSelection();
    return this.status();
  }

  // --- model list ----------------------------------------------------------

  models(): ModelList {
    this.kickCheck();
    if (this.state === 'signed_in') this.refreshModelsInBackground(false);
    return this.buildList();
  }

  async refreshModels(): Promise<ModelList> {
    const session = this.requireSignedIn();
    this.modelAttemptAt = this.now();
    // A failure is recorded in the catalog and reported in the list itself.
    await session.models.refresh().catch(() => undefined);
    return this.buildList();
  }

  private buildList(): ModelList {
    const snapshot = this.session?.models.snapshot();
    return modelListSchema.parse({
      models: (snapshot?.models ?? []).map(({ slug, displayName }) => ({
        slug,
        displayName,
      })),
      fetchedAt: snapshot?.fetchedAt ?? null,
      stale: snapshot?.stale ?? false,
      refreshing: snapshot?.refreshing ?? false,
      ...(snapshot?.error ? { error: snapshot.error } : {}),
    });
  }

  // Not on every poll: a stale or missing list is refreshed, but a failing
  // refresh is not retried more often than every so often.
  private refreshModelsInBackground(force: boolean) {
    const snapshot = this.session?.models.snapshot();
    if (!snapshot || snapshot.refreshing) return;
    const needed = snapshot.fetchedAt === undefined || snapshot.stale;
    if (!force && !needed) return;
    if (
      !force &&
      this.now() - this.modelAttemptAt < this.modelRefreshIntervalMs
    )
      return;
    this.modelAttemptAt = this.now();
    void this.session!.models.refresh().catch(() => undefined);
  }

  // --- sign-in and sign-out -------------------------------------------------

  // Called by the DevKit when it is ready to send the owner to ChatGPT. The
  // URL is kept in memory only while signing in; it is never logged.
  private captureUrl = (url: string) => {
    const pending = this.signIn;
    if (!pending || this.state !== 'signing_in') return;
    if (!isSafeAuthorizationUrl(url)) {
      this.signInError = {
        code: 'invalid_authorization_url',
        message: 'Sign-in could not be started safely. Try again.',
      };
      pending.controller.abort();
      throw new Error('Unsafe authorization URL.');
    }
    pending.url = url;
    pending.urlReady();
  };

  /**
   * Starts sign-in and returns as soon as the owner can be sent to ChatGPT; it
   * does not wait for the OAuth callback. Completion or failure shows up in
   * status().
   */
  async startSignIn(): Promise<ModelStatus> {
    const session = this.requireSession();
    if (!this.options.loopback)
      throw new ModelServiceError(
        'not_local',
        'Sign in on the machine that runs OpenDots.',
        403,
      );
    const blocked: Partial<Record<ChatGPTState, string>> = {
      signing_in: 'Sign-in is already in progress.',
      signing_out: 'Wait for sign-out to finish.',
      signed_in: 'Already signed in.',
      checking: 'Still checking the ChatGPT connection. Try again in a moment.',
      unavailable:
        this.failure?.message ?? 'The ChatGPT connection is unavailable.',
    };
    const reason = blocked[this.state];
    if (reason)
      throw new ModelServiceError(
        this.state === 'signing_in' ? 'sign_in_in_progress' : 'sign_in_blocked',
        reason,
        409,
      );
    this.epoch += 1;
    const epoch = this.epoch;
    this.state = 'signing_in';
    this.signInError = undefined;
    this.notice = undefined;
    const controller = new AbortController();
    let urlReady!: () => void;
    const ready = new Promise<void>((resolve) => (urlReady = resolve));
    // Registered before the DevKit is called: it may ask for the URL at once.
    const pending: NonNullable<typeof this.signIn> = {
      expiresAt: this.now() + SIGN_IN_WINDOW_MS,
      controller,
      operation: Promise.resolve(),
      urlReady,
    };
    this.signIn = pending;
    const operation = session.signIn(controller.signal).then(
      () => {
        if (epoch !== this.epoch) return;
        this.state = 'signed_in';
        this.failure = undefined;
        this.refreshModelsInBackground(true);
      },
      (error: unknown) => {
        if (epoch !== this.epoch) return;
        this.state = 'signed_out';
        // An abort here is not a failure to report: either the owner cancelled
        // (the epoch changed, so we returned above) or captureUrl already
        // recorded why it stopped.
        if (!controller.signal.aborted)
          this.signInError ??= safeFailure(error, {
            code: 'sign_in_failed',
            message: 'Sign-in could not be completed. Try again.',
          });
      },
    );
    const finished = operation.finally(() => {
      if (this.signIn === pending) this.signIn = undefined;
      urlReady();
    });
    pending.operation = finished;
    await Promise.race([ready, finished, sleep(this.signInUrlWaitMs)]);
    return this.status();
  }

  /** Stops a pending sign-in. Safe to call when none is pending. */
  async cancelSignIn(): Promise<ModelStatus> {
    const pending = this.signIn;
    if (pending && this.state === 'signing_in') {
      this.epoch += 1;
      this.state = 'signed_out';
      this.signInError = undefined;
      pending.controller.abort();
      // The DevKit refuses a new sign-in until the old one has wound down.
      await Promise.race([pending.operation, sleep(2_000)]);
    }
    return this.status();
  }

  /**
   * Revokes the tokens and clears them from this machine. The saved
   * registration and the encryption key stay, so signing in again is quick.
   * This is not reset.
   */
  async signOut(): Promise<ModelStatus> {
    const session = this.requireSession();
    if (this.state === 'signing_in')
      throw new ModelServiceError(
        'cancel_first',
        'Cancel the sign-in first.',
        409,
      );
    if (this.state === 'signing_out')
      throw new ModelServiceError(
        'sign_out_in_progress',
        'Sign-out is already in progress.',
        409,
      );
    if (this.state !== 'signed_in') return this.status();
    this.epoch += 1;
    this.state = 'signing_out';
    try {
      const { revoked } = await session.signOut();
      this.state = 'signed_out';
      this.failure = undefined;
      this.signInError = undefined;
      this.notice = revoked ? undefined : 'revocation_unconfirmed';
    } catch {
      // Unknown what is left: have the connection read again.
      this.state = 'checking';
      this.lastCheckAt = 0;
      throw new ModelServiceError(
        'sign_out_failed',
        'Sign-out could not be completed. Check the connection status.',
        502,
      );
    }
    return this.status();
  }

  private requireSession() {
    if (!this.session)
      throw new ModelServiceError(
        'chatgpt_unavailable',
        this.state === 'unavailable' && this.failure
          ? this.failure.message
          : 'ChatGPT plan sign-in is not configured on the server.',
        409,
      );
    return this.session;
  }

  private requireSignedIn() {
    const session = this.requireSession();
    if (this.state !== 'signed_in')
      throw new ModelServiceError(
        'not_signed_in',
        'Sign in with ChatGPT first.',
        409,
      );
    return session;
  }

  /** Resolves when background work started by the service has finished. */
  async idle(): Promise<void> {
    await this.starting;
    await this.checking?.promise;
    await this.signIn?.operation;
  }

  async close(): Promise<void> {
    const pending = this.signIn;
    this.epoch += 1;
    pending?.controller.abort();
    await Promise.race([pending?.operation, sleep(2_000)]);
    await this.session?.close();
  }
}
