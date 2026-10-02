// Real-account check of the ChatGPT plan provider: sign in, pick a model that
// the account actually offers, then run OpenDots' own DotAgent loop through one
// server tool call to a final answer.
//
//   node --import tsx experiments/chatgpt-plan-smoke.ts [model]
//
// CHATGPT_DEVKIT_DIST defaults to the sibling DevKit checkout's built dist.
import { EventType, type RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { DotAgent } from '../src/server/dot-agent.js';
import { chatgptPlanProvider } from '../src/server/chatgpt-plan.js';
import { createChatGPTPlanSession } from '../src/server/chatgpt-devkit.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';

const session = await createChatGPTPlanSession({
  devkitDist:
    process.env.CHATGPT_DEVKIT_DIST ??
    '../sign-in-with-chatgpt-devkit/packages/local/dist',
});
const store = new Store(':memory:');
const workspace = new WorkspaceStore(':memory:', 'smoke-owner');
let ok = false;
try {
  console.log('Opening Sign in with ChatGPT...');
  await session.signIn();
  const models = await session.auth.listModels();
  console.log('Available models:', models.map((m) => m.slug).join(', '));
  const model = process.argv[2] ?? models[0]?.slug;
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
  console.log('Final answer:', text || '(none)');
  ok = toolResults.length > 0 && !!page && text.length > 0;
  console.log(ok ? '\nPASS' : '\nFAIL');
} catch (error) {
  console.error(
    'Smoke failed:',
    error instanceof Error ? error.message : error,
  );
} finally {
  await session.dispose();
  store.close();
  workspace.close();
  process.exitCode = ok ? 0 : 1;
}
