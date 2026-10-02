import type { ChatGPTPlanModel } from './chatgpt-plan.js';
import { ChatGPTPlanError } from './chatgpt-plan.js';
import { isModelText } from '../shared/model-types.js';

// The one cache of the models an account can use. The UI and the runtime
// provider both read it, so they cannot disagree about what is available.
// Loads are shared (a burst of callers causes one request), time-limited, and
// discarded if the session changed while they ran.

export interface CatalogSnapshot {
  models: ChatGPTPlanModel[];
  fetchedAt?: number;
  /** Older than the TTL, or the last refresh failed. */
  stale: boolean;
  refreshing: boolean;
  error?: { code: string; message: string };
}

export interface CatalogOptions {
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

// The list comes from outside, and the DevKit guarantees its shape: a list of
// entries, each with a slug and a display name. Anything else means the
// contract has drifted. A repeated slug is also rejected, not because the
// DevKit promises uniqueness, but because OpenDots selects models by slug and a
// duplicate would make a selection ambiguous. Problems are reported, not
// repaired: no entry is dropped, nothing is partly accepted, and the previous
// list stays as it was.
// Messages name the entry's position and the problem, never its content.
function validate(models: unknown): ChatGPTPlanModel[] {
  const invalid = (detail: string) =>
    new ChatGPTPlanError(
      'invalid_model_catalog',
      `The model list did not match the expected format (${detail}). Update OpenDots or the Sign in with ChatGPT DevKit.`,
      502,
    );
  if (!Array.isArray(models)) throw invalid('it is not a list');
  const seen = new Set<string>();
  return models.map((entry, index) => {
    const at = `entry ${index + 1}`;
    if (typeof entry !== 'object' || entry === null)
      throw invalid(`${at} is not an object`);
    const { slug, displayName } = entry as Record<string, unknown>;
    if (!isModelText(slug)) throw invalid(`${at} has an invalid slug`);
    if (seen.has(slug)) throw invalid(`${at} repeats an earlier slug`);
    seen.add(slug);
    if (!isModelText(displayName))
      throw invalid(`${at} has an invalid display name`);
    return { slug, displayName: displayName.trim() };
  });
}

export class ModelCatalog {
  private models?: ChatGPTPlanModel[];
  private fetchedAt?: number;
  private error?: { code: string; message: string };
  private loading?: Promise<ChatGPTPlanModel[]>;
  private generation = 0;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(
    private load: (signal: AbortSignal) => Promise<ChatGPTPlanModel[]>,
    options: CatalogOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  snapshot(): CatalogSnapshot {
    const old =
      this.fetchedAt !== undefined && this.now() - this.fetchedAt > this.ttlMs;
    return {
      models: (this.models ?? []).map((model) => ({ ...model })),
      fetchedAt: this.fetchedAt,
      stale: this.fetchedAt !== undefined && (old || !!this.error),
      refreshing: !!this.loading,
      error: this.error && { ...this.error },
    };
  }

  /** Cached while fresh; otherwise one shared load. `force` skips the cache. */
  async list(
    options: { signal?: AbortSignal; force?: boolean } = {},
  ): Promise<ChatGPTPlanModel[]> {
    const fresh =
      this.models &&
      this.fetchedAt !== undefined &&
      this.now() - this.fetchedAt <= this.ttlMs;
    const pending = !options.force && fresh ? this.models! : this.start();
    const result = await abortable(Promise.resolve(pending), options.signal);
    return result.map((model) => ({ ...model }));
  }

  refresh() {
    return this.list({ force: true });
  }

  /** Forget everything, and ignore any load still in flight (sign-out, new account). */
  clear() {
    this.generation += 1;
    this.models = undefined;
    this.fetchedAt = undefined;
    this.error = undefined;
    this.loading = undefined;
  }

  private start(): Promise<ChatGPTPlanModel[]> {
    if (this.loading) return this.loading;
    const generation = this.generation;
    const timer = AbortSignal.timeout(this.timeoutMs);
    const run = (async () => {
      try {
        const models = validate(await abortable(this.load(timer), timer));
        if (generation === this.generation) {
          this.models = models;
          this.fetchedAt = this.now();
          this.error = undefined;
        }
        return models;
      } catch (error) {
        const known = error instanceof ChatGPTPlanError;
        if (generation === this.generation)
          this.error = known
            ? { code: error.code, message: error.message }
            : {
                code: 'models_unavailable',
                message: 'The model list could not be loaded. Try again.',
              };
        throw error;
      }
    })();
    this.loading = run;
    const release = () => {
      if (this.loading === run) this.loading = undefined;
    };
    run.then(release, release);
    return run;
  }
}

function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
