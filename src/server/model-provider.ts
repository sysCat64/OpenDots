import { openaiCompatibleText } from '@tanstack/ai-openai/compatible';

export type ModelAdapter = ReturnType<typeof openaiCompatibleText>;

// The server's model boundary: which adapter drives the TanStack agent loop,
// and what provider-specific request options go with it. Credentials never
// leave the provider.
export interface ModelProvider {
  readonly kind: 'api-key' | 'chatgpt-plan';
  /** Static configuration is complete. Says nothing about sign-in state. */
  readonly configured: boolean;
  /** Environment variables the owner still has to set. */
  readonly missing: string[];
  readonly modelOptions: Record<string, unknown>;
  createAdapter(): ModelAdapter;
  /**
   * A provider whose answers can change between calls (the owner may switch in
   * the UI) returns a fixed one here. A run takes one snapshot and uses it
   * throughout, so its adapter and request options always belong together.
   */
  snapshot?(): ModelProvider;
}

export interface ApiKeyModelConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

export function apiKeyProvider(config: ApiKeyModelConfig): ModelProvider {
  const { apiKey, model } = config;
  return {
    kind: 'api-key',
    configured: !!(apiKey && model),
    missing: [!apiKey && 'OPENAI_API_KEY', !model && 'OPENAI_MODEL'].filter(
      (item): item is string => !!item,
    ),
    modelOptions: { max_completion_tokens: 2200 },
    createAdapter() {
      if (!apiKey || !model)
        throw new Error('Intelligence and model configuration are required.');
      return openaiCompatibleText(model, {
        apiKey,
        baseURL: config.baseUrl ?? 'https://api.openai.com/v1',
        api: 'chat-completions',
        maxRetries: 1,
      });
    },
  };
}
