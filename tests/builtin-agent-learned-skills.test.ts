import { LearnedSkillsError, BuiltInAgent } from '@copilotkit/runtime/v2';
import { lastValueFrom, toArray } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startCounter, type Counter } from './helpers/counting-server';

// The installed SDK decides whether to build its Intelligence-backed skill
// registry from the `learnedSkills` option, and the registry reads
// CPK_INTELLIGENCE_API_KEY and INTELLIGENCE_API_URL from the environment when
// the option omits them. DotAgent relies on both facts: it leaves the option
// out when it has no Intelligence key. If a CopilotKit upgrade changes either,
// these fail first (DEC-9: rerun the contract gates on every SDK upgrade).
let remote: Counter;

beforeEach(async () => {
  remote = await startCounter();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await remote.close();
});

// Stale remote-learning settings, aimed at the loopback counter.
function staleEnvironment() {
  vi.stubEnv('CPK_INTELLIGENCE_API_KEY', 'stale-sentinel-key');
  vi.stubEnv('INTELLIGENCE_API_URL', remote.url);
}

function agent(config: Record<string, unknown> = {}) {
  const factory = vi.fn(() => (async function* () {})());
  return {
    factory,
    agent: new BuiltInAgent({ type: 'tanstack', factory, ...config }),
  };
}

async function run(subject: BuiltInAgent) {
  await lastValueFrom(
    subject
      .run({
        threadId: 'thread',
        runId: 'run',
        messages: [{ id: 'm1', role: 'user', content: 'hello' }],
        state: {},
        tools: [],
        context: [],
        forwardedProps: {},
      })
      .pipe(toArray()),
  ).catch(() => undefined);
}

describe('BuiltInAgent learned skills (installed SDK contract)', () => {
  it('builds no registry and contacts nothing when the option is absent, even with stale environment', async () => {
    staleEnvironment();
    const { agent: subject, factory } = agent();
    await run(subject);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(remote.count()).toBe(0);
  });

  it('treats an undefined option the same as an absent one', async () => {
    staleEnvironment();
    const { agent: subject, factory } = agent({ learnedSkills: undefined });
    await run(subject);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(remote.count()).toBe(0);
  });

  it('builds a registry from the environment when the option is present without a key', async () => {
    // The hazard that makes DotAgent leave the option out entirely: any
    // learnedSkills value, even without an apiKey, can pick up stale settings.
    staleEnvironment();
    const { agent: subject, factory } = agent({
      learnedSkills: { containers: [{ id: 'research' }] },
    });
    await run(subject);
    expect(remote.count()).toBeGreaterThan(0);
    expect(factory).not.toHaveBeenCalled();
  });

  it('refuses a keyless option when there is nothing to fall back on', () => {
    vi.stubEnv('CPK_INTELLIGENCE_API_KEY', '');
    expect(() =>
      agent({ learnedSkills: { containers: [{ id: 'research' }] } }),
    ).toThrow(LearnedSkillsError);
  });

  it('uses the key and URL it is given when the option is complete', async () => {
    const { agent: subject, factory } = agent({
      learnedSkills: {
        containers: [{ id: 'research' }],
        apiKey: 'explicit-key',
        apiUrl: remote.url,
      },
    });
    await run(subject);
    expect(remote.count()).toBeGreaterThan(0);
    expect(factory).not.toHaveBeenCalled();
  });
});
