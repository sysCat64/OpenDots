import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { startCounter, type Counter } from './helpers/counting-server';
import { snapshotDatabase } from './helpers/db-snapshot';
import { randomToken, spawnServer } from './helpers/server-entry';

// These tests start the real server entry (src/server/index.ts) in a fresh
// process, so they cover the wiring the unit tests cannot: that startup really
// refuses a missing or short token, and that the token it accepts really
// protects the runtime. Tokens are random per run; nothing is committed.
const SLOW = 120_000;
const STILL_RUNNING = 'still running';

async function refusedStart(ownerToken: string | null) {
  const server = spawnServer({ ownerToken });
  try {
    const outcome = await Promise.race([
      server.exited,
      new Promise<string>((resolve) =>
        setTimeout(() => resolve(STILL_RUNNING), 30_000),
      ),
    ]);
    return {
      outcome,
      output: server.output(),
      listening: /listening on/.test(server.output()),
      // Refusing must happen before the application opens its database.
      databaseCreated: existsSync(server.database),
    };
  } finally {
    await server.stop();
  }
}

describe('server startup without a usable owner token', () => {
  const cases: [string, () => string | null][] = [
    ['absent', () => null],
    ['empty', () => ''],
    ['23 characters', () => randomToken().slice(0, 23)],
  ];

  it.each(cases)(
    'refuses to start when OWNER_TOKEN is %s, even on loopback',
    async (_name, token) => {
      const supplied = token();
      const result = await refusedStart(supplied);
      expect(result.outcome).not.toBe(STILL_RUNNING);
      expect(result.outcome).not.toBe(0);
      expect(result.outcome).not.toBeNull();
      expect(result.output).toContain('OWNER_TOKEN');
      expect(result.output).toContain('24');
      expect(result.listening).toBe(false);
      expect(result.databaseCreated).toBe(false);
      // The value is never printed.
      if (supplied) expect(result.output).not.toContain(supplied);
    },
    SLOW,
  );
});

describe('server with a valid owner token on loopback', () => {
  let intelligence: Counter;
  let provider: Counter;
  afterEach(async () => {
    await intelligence?.close();
    await provider?.close();
  });

  it(
    'protects the app, the runtime and the threads, but not static files',
    async () => {
      intelligence = await startCounter();
      provider = await startCounter();
      const server = spawnServer({
        seedThread: true,
        env: {
          INTELLIGENCE_API_URL: intelligence.url,
          OPENAI_BASE_URL: provider.url,
          OPENAI_API_KEY: randomToken(),
          OPENAI_MODEL: 'fixture-model',
        },
      });
      try {
        const port = await server.ready;
        const base = `http://127.0.0.1:${port}`;
        const { dotId, threadId } = server;
        const body = JSON.stringify({
          threadId,
          runId: 'owner-startup-run',
          state: {},
          messages: [{ id: 'm1', role: 'user', content: 'hello' }],
          tools: [],
          context: [],
          forwardedProps: {},
        });
        const json = { 'content-type': 'application/json' };
        const requests: [string, string, string, string?][] = [
          ['GET', '/api/state', ''],
          ['GET', '/api/workspace', ''],
          ['GET', '/api/model', ''],
          ['GET', '/api/copilotkit/info', ''],
          ['GET', '/api/copilotkit/threads', ''],
          ['GET', `/api/copilotkit/threads/${threadId}/messages`, ''],
          ['POST', `/api/copilotkit/agent/${dotId}/run`, '', body],
          ['POST', `/api/copilotkit/agent/${dotId}/connect`, '', body],
          ['POST', `/api/copilotkit/agent/${dotId}/stop/${threadId}`, '', '{}'],
          ['POST', `/api/copilotkit/agent/${dotId}/suggest`, '', body],
          ['POST', '/api/copilotkit/threads/clear', '', '{}'],
        ];
        const seen: string[] = [];
        const send = async (
          [method, path, , payload]: (typeof requests)[number],
          authorization?: string,
        ) => {
          const response = await fetch(base + path, {
            method,
            headers: {
              ...(payload ? json : {}),
              ...(authorization ? { Authorization: authorization } : {}),
            },
            body: payload,
          });
          const text = await response.text();
          seen.push(text, JSON.stringify([...response.headers]));
          return response.status;
        };
        const before = snapshotDatabase(server.database);
        const wrong = `Bearer ${randomToken()}`;
        for (const request of requests) {
          expect(await send(request), `${request[0]} ${request[1]}`).toBe(401);
          expect(
            await send(request, wrong),
            `${request[0]} ${request[1]}`,
          ).toBe(401);
        }
        // Rejected before anything ran: no Intelligence call, no provider call,
        // no database write.
        expect(intelligence.count()).toBe(0);
        expect(provider.count()).toBe(0);
        expect(snapshotDatabase(server.database)).toBe(before);

        const bearer = `Bearer ${server.token}`;
        for (const request of requests.slice(0, 4))
          expect(await send(request, bearer), request[1]).toBe(200);
        // The token protects the API, not the static application shell.
        expect((await fetch(`${base}/`)).status).not.toBe(401);

        // The zeros above mean something: an authorized run for the bound
        // thread does reach Intelligence (it fails there, offline).
        const run = requests.find(([, path]) => path.endsWith('/run'));
        expect([401, 403]).not.toContain(await send(run!, bearer));
        expect(intelligence.count()).toBeGreaterThan(0);

        // Secret scan: the token is held in memory and used for comparison
        // only; it appears nowhere the server writes or sends.
        const haystacks = [
          server.output(),
          ...seen,
          intelligence.captured(),
          provider.captured(),
          server.trap.events.join('\n'),
          server.blocked().join('\n'),
          server.databaseBytes().toString('latin1'),
        ];
        const hits = (secret: string, texts: string[]) =>
          texts.filter((text) => text.includes(secret)).length;
        expect(hits(server.token as string, haystacks)).toBe(0);
        expect(hits(wrong.slice('Bearer '.length), haystacks)).toBe(0);
        // The scan can see a token when one is present.
        expect(
          hits(server.token as string, [...haystacks, `x${server.token}`]),
        ).toBe(1);
        // Nothing left the machine and no telemetry was attempted.
        expect(server.blocked()).toEqual([]);
        expect(server.trap.events).toEqual([]);
      } finally {
        await server.stop();
      }
    },
    SLOW,
  );
});
