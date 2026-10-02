import type { ModelStatus } from '../../src/shared/model-types.js';

type Chatgpt = Partial<ModelStatus['chatgpt']>;

export function modelStatus(
  overrides: Omit<Partial<ModelStatus>, 'chatgpt'> & { chatgpt?: Chatgpt } = {},
): ModelStatus {
  const { chatgpt, ...rest } = overrides;
  return {
    provider: 'chatgpt-plan',
    providerSource: 'server',
    serverProvider: 'chatgpt-plan',
    apiKey: { available: true },
    selection: {},
    ...rest,
    chatgpt: {
      state: 'signed_out',
      persistence: 'keychain',
      canSignInHere: true,
      refreshing: false,
      model: {},
      ...chatgpt,
    },
  };
}
