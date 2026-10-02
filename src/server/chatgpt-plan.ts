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
  listModels(signal?: AbortSignal): Promise<ChatGPTPlanModel[]>;
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
}

const MODEL_LIST_TTL_MS = 5 * 60_000;

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
  let models: { at: number; slugs: string[] } | undefined;
  const assertModelAvailable = async (auth: ChatGPTPlanAuth, model: string) => {
    if (!models || Date.now() - models.at > MODEL_LIST_TTL_MS)
      models = {
        at: Date.now(),
        slugs: (await auth.listModels()).map((entry) => entry.slug),
      };
    if (models.slugs.includes(model)) return;
    const available = models.slugs.join(', ') || 'none';
    models = undefined;
    throw new ChatGPTPlanError(
      'model_unavailable',
      `Model "${model}" is not available to this ChatGPT account. Available models: ${available}.`,
      404,
    );
  };
  return {
    kind: 'chatgpt-plan',
    configured: !!(auth && model),
    missing: [!auth && 'CHATGPT_DEVKIT_DIST', !model && 'OPENAI_MODEL'].filter(
      (item): item is string => !!item,
    ),
    // Stateless: the loop replays history, including reasoning items. The
    // generic Responses adapter does not request encrypted reasoning the way
    // the OpenAI-specific one does, so ask for it explicitly or a reasoning
    // model's next tool turn has nothing to replay.
    modelOptions: { store: false, include: ['reasoning.encrypted_content'] },
    createAdapter() {
      if (!auth || !model)
        throw new Error('Intelligence and model configuration are required.');
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
