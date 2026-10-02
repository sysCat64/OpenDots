import { createShutdown } from './shutdown.js';
import { reportChannelFailure, safeFailure } from './slack-channel.js';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Store } from './store.js';
import { Runner } from './runner.js';
import { createApp } from './app.js';
import { WorkspaceStore } from './workspace.js';
import { Platform } from './platform.js';
import type { PlatformConfig } from './platform-config.js';
import { chatgptPlanProvider } from './chatgpt-plan.js';
import { createChatGPTPlanSession } from './chatgpt-devkit.js';
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 4310);
const ownerToken = process.env.OWNER_TOKEN;
if (
  !['127.0.0.1', '::1', 'localhost'].includes(host) &&
  (!ownerToken || ownerToken.length < 24)
)
  throw new Error(
    'External binding requires an OWNER_TOKEN of at least 24 characters.',
  );
const database = process.env.DATABASE_PATH ?? 'data/opendots.sqlite';
const store = new Store(database);
const workspace = new WorkspaceStore(
  database,
  process.env.OWNER_ID ?? 'opendots-owner',
);
const modelProvider = process.env.MODEL_PROVIDER ?? 'api-key';
if (!['api-key', 'chatgpt-plan'].includes(modelProvider))
  throw new Error('MODEL_PROVIDER must be api-key or chatgpt-plan.');
const chatgptPlan =
  modelProvider === 'chatgpt-plan' && process.env.CHATGPT_DEVKIT_DIST
    ? await createChatGPTPlanSession({
        devkitDist: process.env.CHATGPT_DEVKIT_DIST,
      })
    : undefined;
const config: PlatformConfig = {
  intelligenceKey: process.env.INTELLIGENCE_API_KEY,
  intelligenceApiUrl: process.env.INTELLIGENCE_API_URL || undefined,
  intelligenceWsUrl: process.env.INTELLIGENCE_WS_URL || undefined,
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL,
  baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  modelProvider:
    modelProvider === 'chatgpt-plan'
      ? chatgptPlanProvider({
          auth: chatgptPlan?.auth,
          model: process.env.OPENAI_MODEL,
        })
      : undefined,
  browserUrl: process.env.BROWSER_URL,
  browserSecret: process.env.BROWSER_SECRET,
  computerSupervisorUrl: process.env.COMPUTER_SUPERVISOR_URL,
  computerSupervisorToken: process.env.COMPUTER_SUPERVISOR_TOKEN,
  computerToken: process.env.COMPUTER_TOKEN,
  computerNamespace: process.env.COMPUTER_NAMESPACE,
  voiceKey: process.env.VOICE_API_KEY,
  voiceModel: process.env.VOICE_MODEL,
  voiceName: process.env.VOICE_NAME ?? 'marin',
  slackChannel: process.env.SLACK_CHANNEL_NAME,
  slackTeam: process.env.SLACK_TEAM_ID,
  slackUsers: (process.env.SLACK_USER_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  slackDotId: process.env.SLACK_DOT_ID || undefined,
  runtimeUrl: `http://${host === '::1' ? '[::1]' : '127.0.0.1'}:${port}/api/copilotkit`,
  ownerToken,
};
const platform = new Platform(store, workspace, config);
const researchConfig = {
  mode: 'live' as const,
  apiKey: config.apiKey,
  model: config.model,
  baseUrl: config.baseUrl,
  browserUrl: config.browserUrl,
  browserSecret: config.browserSecret,
};
const runner = new Runner(
  store,
  researchConfig,
  async (claim, _memories, signal, progress) => {
    const threadId = workspace.taskThread(claim.id);
    if (!threadId)
      throw new Error(
        'This legacy task has no Intelligence conversation. Create a new scheduled task from a conversation.',
      );
    progress('Running this task in its Intelligence conversation.');
    const text = await platform.turn(threadId, claim.prompt, signal);
    return { text, sources: [], sample: false };
  },
);
const wsOrigin = new URL(
  config.intelligenceWsUrl ?? 'wss://realtime.intelligence.copilotkit.ai',
).origin;
const app = createApp({
  store,
  runner,
  config: researchConfig,
  ownerToken,
  origin:
    process.env.APP_ORIGIN ??
    (process.env.NODE_ENV === 'development'
      ? 'http://127.0.0.1:5173'
      : undefined),
  platform,
});
app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header(
    'Content-Security-Policy',
    `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${wsOrigin}; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
  );
  await next();
});
app.get('/api/*', (c) => c.json({ error: 'Not found.' }, 404));
app.use('/*', serveStatic({ root: './dist/client' }));
app.get('*', serveStatic({ path: './dist/client/index.html' }));
const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`OpenDots template listening on http://${host}:${info.port}`);
  runner.start();
  if (chatgptPlan) {
    // The sign-in browser opens on this machine, so only offer it locally.
    const failed = (error: unknown) =>
      console.warn(
        'ChatGPT sign-in failed:',
        error instanceof Error ? error.message : 'unknown error',
      );
    if (['127.0.0.1', '::1', 'localhost'].includes(host))
      void chatgptPlan
        .isSignedIn()
        .then((signedIn) => (signedIn ? undefined : chatgptPlan.signIn()))
        .catch(failed);
    else
      console.warn(
        'ChatGPT plan sign-in requires HOST to be a loopback address.',
      );
  }
  void platform
    .start()
    .catch((error) =>
      reportChannelFailure(
        'Slack Channels activation failed; check setup status',
        [safeFailure(error)],
      ),
    );
});
const shutdown = createShutdown({
  stopRunner: () => runner.stop(),
  stopPlatform: async () => {
    try {
      await platform.stop();
    } finally {
      await chatgptPlan?.dispose();
    }
  },
  closeServer: () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ),
  exit: (code) => process.exit(code),
  report: (operation, error) =>
    reportChannelFailure(operation, [safeFailure(error)]),
});
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
