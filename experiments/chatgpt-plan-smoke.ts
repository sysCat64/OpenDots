// Real-account check of the ChatGPT plan provider: get a session, pick a model
// that the account actually offers, then run OpenDots' own DotAgent loop through
// one server tool call to a final answer.
//
//   node --import tsx experiments/chatgpt-plan-smoke.ts [model] [--no-browser]
//
// CHATGPT_DEVKIT_DIST defaults to the sibling DevKit checkout's built dist.
// CHATGPT_CREDENTIAL_STORE=keychain keeps the sign-in across runs (and
// CHATGPT_STATE_DIR overrides where); the default is ephemeral. With
// --no-browser, any attempt to open the sign-in page fails the run, which
// proves a saved session was restored.
import { EventType, type RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { DotAgent } from '../src/server/dot-agent.js';
import { chatgptPlanProvider } from '../src/server/chatgpt-plan.js';
import { createChatGPTPlanSession } from '../src/server/chatgpt-devkit.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';

const args = process.argv.slice(2);
const noBrowser = args.includes('--no-browser');
const requestedModel = args.find((arg) => !arg.startsWith('--'));
let browserAttempted = false;
const credentialStore =
  process.env.CHATGPT_CREDENTIAL_STORE === 'keychain'
    ? 'keychain'
    : 'ephemeral';

const session = await createChatGPTPlanSession({
  devkitDist:
    process.env.CHATGPT_DEVKIT_DIST ??
    '../sign-in-with-chatgpt-devkit/packages/local/dist',
  credentialStore,
  stateDir: process.env.CHATGPT_STATE_DIR || undefined,
  ...(noBrowser
    ? {
        openBrowser: () => {
          browserAttempted = true;
          throw new Error('Sign-in tried to open a browser (--no-browser).');
        },
      }
    : {}),
});
const store = new Store(':memory:');
const workspace = new WorkspaceStore(':memory:', 'smoke-owner');
let ok = false;
try {
  console.log('Credential store:', credentialStore);
  const status = await session.status();
  if (status.state === 'unavailable')
    throw new Error(`Credential storage unavailable: ${status.failure.hint}`);
  if (status.state === 'signed_in')
    console.log('Session: restored (no sign-in)');
  else {
    console.log('Session: signing in (opens the browser)...');
    await session.signIn();
  }
  const models = await session.auth.listModels();
  console.log('Available models:', models.map((m) => m.slug).join(', '));
  const model = requestedModel ?? models[0]?.slug;
  if (!model) throw new Error('This account offers no models.');
  console.log('Using model:', model);

  const dot = workspace.dots()[0];
  workspace.bindThread('smoke', dot.id, 'ChatGPT plan smoke');
  const agent = new DotAgent(
    store,
    workspace,
    {
      intelligenceKey: 'smoke-not-used',
      baseUrl: '',
      modelProvider: chatgptPlanProvider({ auth: session.auth, model }),
      runtimeUrl: '',
      voiceName: 'marin',
      slackUsers: [],
    },
    dot.id,
  );
  const input: RunAgentInput = {
    threadId: 'smoke',
    runId: 'smoke-run',
    state: {},
    context: [],
    messages: [
      {
        id: 'u1',
        role: 'user',
        content:
          'Create a page titled "ChatGPT plan smoke" with the content "# It works", then confirm in one sentence.',
      },
    ],
    tools: [],
    forwardedProps: {},
  };
  const events = await lastValueFrom(agent.run(input).pipe(toArray()));
  const text = events
    .map((e) =>
      e.type === EventType.TEXT_MESSAGE_CHUNK
        ? (e as { delta?: string }).delta
        : '',
    )
    .join('');
  const toolCalls = events
    .filter((e) => e.type === EventType.TOOL_CALL_START)
    .map((e) => (e as { toolCallName?: string }).toolCallName);
  const toolResults = events.filter(
    (e) => e.type === EventType.TOOL_CALL_RESULT,
  );
  const page = workspace.pages
    .list(dot.spaceId)
    .find((p) => p.title === 'ChatGPT plan smoke');
  console.log('Tool calls:', toolCalls.join(', ') || '(none)');
  console.log('Tool results:', toolResults.length);
  console.log('Page created:', !!page);
  if (noBrowser)
    console.log('Browser opened:', browserAttempted ? 'yes' : 'no');
  console.log('Final answer:', text || '(none)');
  ok = toolResults.length > 0 && !!page && text.length > 0;
  console.log(ok ? '\nPASS' : '\nFAIL');
} catch (error) {
  console.error(
    'Smoke failed:',
    error instanceof Error ? error.message : error,
  );
} finally {
  await session.close();
  store.close();
  workspace.close();
  process.exitCode = ok ? 0 : 1;
}
