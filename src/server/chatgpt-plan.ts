import { openaiCompatibleText } from '@tanstack/ai-openai/compatible';
import type { ModelProvider } from './model-provider.js';
import { withSiwcToolCallFinishReason } from './siwc-compat.js';

export interface ChatGPTPlanModel {
  slug: string;
  displayName: string;
}

// What OpenDots needs from "Sign in with ChatGPT". Implementations own the
// OAuth session, refresh and credential storage; this boundary only ever
// carries a short-lived access token, which must never be logged or stored.
export interface ChatGPTPlanAuth {
  getAccessToken(signal?: AbortSignal): Promise<string>;
  /**
   * The models this account can use. Implementations may serve a cached list;
   * `force` asks for a fresh one.
   */
  listModels(
    signal?: AbortSignal,
    options?: { force?: boolean },
  ): Promise<ChatGPTPlanModel[]>;
}

// `status` is the HTTP status the failure surfaces as to the model client.
export class ChatGPTPlanError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ChatGPTPlanError';
  }
}

export interface ChatGPTPlanConfig {
  auth?: ChatGPTPlanAuth;
  model?: string;
  baseUrl?: string;
  /** What to tell the owner when no model is chosen. Defaults to the env var. */
  modelMissing?: string;
}

// The SDK reduces a throwing fetch to "Connection error.". Known failures are
// returned as HTTP errors instead so the owner sees the real reason.
function failure(error: ChatGPTPlanError) {
  return new Response(
    JSON.stringify({
      error: {
        message: error.message,
        type: 'chatgpt_plan_error',
        code: error.code,
      },
    }),
    { status: error.status, headers: { 'Content-Type': 'application/json' } },
  );
}

export function chatgptPlanProvider(config: ChatGPTPlanConfig): ModelProvider {
  const { auth, model } = config;
  // The list is cached by the auth (one shared cache for the UI and this
  // provider). A model missing from a cached list is re-checked once against a
  // fresh one before the run is refused.
  const assertModelAvailable = async (auth: ChatGPTPlanAuth, model: string) => {
    let list = await auth.listModels();
    if (!list.some((entry) => entry.slug === model))
      list = await auth.listModels(undefined, { force: true });
    if (list.some((entry) => entry.slug === model)) return;
    const available = list.map((entry) => entry.slug).join(', ') || 'none';
    throw new ChatGPTPlanError(
      'model_unavailable',
      `Model "${model}" is not available to this ChatGPT account. Available models: ${available}.`,
      404,
    );
  };
  return {
    kind: 'chatgpt-plan',
    configured: !!(auth && model),
    missing: [
      !auth && 'CHATGPT_DEVKIT_DIST',
      !model && (config.modelMissing ?? 'OPENAI_MODEL'),
    ].filter((item): item is string => !!item),
    // Stateless: the loop replays history, including reasoning items. The
    // generic Responses adapter does not request encrypted reasoning the way
    // the OpenAI-specific one does, so ask for it explicitly or a reasoning
    // model's next tool turn has nothing to replay.
    modelOptions: { store: false, include: ['reasoning.encrypted_content'] },
    createAdapter() {
      if (!auth || !model) throw new Error('Model configuration is required.');
      const authorizedFetch: typeof fetch = async (input, init) => {
        try {
          await assertModelAvailable(auth, model);
          const headers = new Headers(init?.headers);
          headers.set(
            'Authorization',
            `Bearer ${await auth.getAccessToken(init?.signal ?? undefined)}`,
          );
          return await globalThis.fetch(input, { ...init, headers });
        } catch (error) {
          if (error instanceof ChatGPTPlanError) return failure(error);
          throw error;
        }
      };
      return withSiwcToolCallFinishReason(
        openaiCompatibleText(model, {
          // Replaced per request by authorizedFetch; not a credential.
          apiKey: 'chatgpt-plan',
          baseURL: config.baseUrl ?? 'https://api.openai.com/v1',
          api: 'responses',
          maxRetries: 1,
          fetch: authorizedFetch,
        }),
      );
    },
  };
}
