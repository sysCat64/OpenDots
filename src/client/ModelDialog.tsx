import { useEffect, useRef, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import type {
  ModelList,
  ModelProviderKind,
  ModelStatus,
} from '../shared/model-types';
import { api, ApiError } from './api';
import { describeModel, modelBanner, type ModelView } from './model-view';

// Provider, ChatGPT connection and model, in one place. Every control here acts
// immediately (there is no Save), and the server stays the source of truth: the
// browser only ever receives the whitelisted status, never a credential.

export function ModelBanner({
  status,
  onOpen,
}: {
  status?: ModelStatus;
  onOpen: () => void;
}) {
  const text = status && modelBanner(status);
  if (!text) return null;
  return (
    <div className="notice model-notice" role="status">
      <span>{text}</span>
      <button type="button" className="link-button" onClick={onOpen}>
        Open Model settings
      </button>
    </div>
  );
}

// Presentational: everything it needs arrives as props, so each state can be
// rendered and checked without a browser.
export function ModelPanel({
  status,
  view,
  list,
  busy,
  error,
  actions,
}: {
  status: ModelStatus;
  view: ModelView;
  list?: ModelList;
  busy: boolean;
  error?: string;
  actions: {
    chooseProvider(kind: ModelProviderKind): void;
    signIn(): void;
    cancel(): void;
    signOut(): void;
    chooseModel(slug: string): void;
    refreshModels(): void;
    useServerDefault(): void;
  };
}) {
  const { chatgpt } = status;
  const effective = chatgpt.model.effective ?? '';
  const known = list?.models.some((m) => m.slug === effective);
  const locked = view.locked || busy;
  return (
    <>
      <span className="field-label">Provider</span>
      <div role="radiogroup" aria-label="Provider" className="provider-group">
        {view.providers.map((provider) => (
          <label
            key={provider.kind}
            className={`provider-option${provider.selected ? ' selected' : ''}${
              provider.disabled || busy ? ' disabled' : ''
            }`}
          >
            <input
              type="radio"
              name="provider"
              checked={provider.selected}
              disabled={provider.disabled || busy}
              onChange={() => actions.chooseProvider(provider.kind)}
            />
            <span>
              {provider.label}
              {provider.reason && <small>{provider.reason}</small>}
            </span>
          </label>
        ))}
      </div>
      <p className="muted model-source">{view.providerSource}</p>

      <span className="field-label">ChatGPT plan</span>
      <div className="model-card">
        <div className="model-status">
          <span className={`status-pill ${view.connection.tone}`}>
            {view.connection.label}
          </span>
          {view.connection.detail && (
            <p className="muted">{view.connection.detail}</p>
          )}
        </div>
        <div className="model-actions">
          {view.canSignIn && (
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={actions.signIn}
            >
              Sign in with ChatGPT
            </button>
          )}
          {view.signInUrl && (
            <a
              className="primary link-button-primary"
              href={view.signInUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Continue in ChatGPT ↗
            </a>
          )}
          {view.waitingForLink && (
            <span className="muted">Preparing the sign-in link…</span>
          )}
          {view.canCancel && (
            <button type="button" disabled={busy} onClick={actions.cancel}>
              Cancel
            </button>
          )}
          {view.canSignOut && (
            <button type="button" disabled={locked} onClick={actions.signOut}>
              Sign out
            </button>
          )}
        </div>
        {view.canSignOut && (
          <p className="muted">
            Signing out revokes OpenDots’ access and clears the tokens on this
            machine. Signing in again is quick.
          </p>
        )}
        {view.signInError && (
          <p className="chat-error" role="alert">
            {view.signInError}
          </p>
        )}
        {view.failure && (
          <p className="chat-error" role="alert">
            {view.failure}
          </p>
        )}
        {view.recovery && (
          <div className="recovery">
            <p className="muted">
              Stop the server, then run this in the OpenDots folder and sign in
              again:
            </p>
            <code>{view.recovery}</code>
          </div>
        )}
        {view.notice && <p className="muted">{view.notice}</p>}
        {view.persistenceNote && (
          <p className="muted persistence">{view.persistenceNote}</p>
        )}
      </div>

      {view.showModelPicker && (
        <>
          <label className="field-label" htmlFor="chatgpt-model">
            Model
          </label>
          <div className="model-picker">
            <select
              id="chatgpt-model"
              value={known ? effective : ''}
              disabled={locked || !list?.models.length}
              onChange={(e) =>
                e.target.value && actions.chooseModel(e.target.value)
              }
            >
              <option value="" disabled>
                {list?.models.length ? 'Choose a model' : 'Loading models…'}
              </option>
              {list?.models.map((model) => (
                <option key={model.slug} value={model.slug}>
                  {model.displayName === model.slug
                    ? model.slug
                    : `${model.displayName} (${model.slug})`}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="icon-button"
              aria-label="Refresh model list"
              disabled={locked || list?.refreshing}
              onClick={actions.refreshModels}
            >
              <RefreshCw size={15} />
            </button>
          </div>
          {view.modelLines.map((line) => (
            <p
              key={line.text}
              className={line.tone === 'neutral' ? 'muted' : 'model-line warn'}
            >
              {line.text}
            </p>
          ))}
          {list?.error && (
            <p className="muted">
              {list.stale
                ? 'Showing the last list; refreshing failed: '
                : 'The list could not be loaded: '}
              {list.error.message}
            </p>
          )}
        </>
      )}

      {view.hasOverride && (
        <div className="model-footer">
          <button
            type="button"
            disabled={locked}
            onClick={actions.useServerDefault}
          >
            Use server default
          </button>
          <span className="muted">{view.defaultLabel}</span>
        </div>
      )}
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

export function ModelDialog({
  status,
  statusError,
  onClose,
  onStatus,
}: {
  status?: ModelStatus;
  statusError?: string;
  onClose: () => void;
  onStatus: (next: ModelStatus) => void;
}) {
  const [list, setList] = useState<ModelList>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const close = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);

  const signedIn = status?.chatgpt.state === 'signed_in';
  const waiting = !list || list.refreshing || list.models.length === 0;
  useEffect(() => {
    if (!signedIn) {
      setList(undefined);
      return;
    }
    let active = true;
    const load = async () => {
      try {
        const next = await api<ModelList>('/model/chatgpt/models');
        if (active) setList(next);
      } catch {
        /* the status line already reports connection problems */
      }
    };
    void load();
    // The server loads the list in the background; follow it until it lands.
    const timer = waiting ? setInterval(() => void load(), 1500) : undefined;
    return () => {
      active = false;
      if (timer) clearInterval(timer);
    };
  }, [signedIn, waiting]);

  // Every action returns the new status, which replaces the polled one at once.
  const act = async (work: () => Promise<ModelStatus | ModelList>) => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await work();
      if (!alive.current) return;
      if ('chatgpt' in result) onStatus(result);
      else setList(result);
    } catch (e) {
      if (alive.current)
        setError(
          e instanceof ApiError || e instanceof Error
            ? e.message
            : 'That did not work. Try again.',
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const view = status && describeModel(status);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="modal model-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="modal-close icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <span className="eyebrow">OPENDOTS TEMPLATE</span>
        <h2 id="model-title">Model</h2>
        <p className="muted">
          Choose what powers your Dots. Changes apply to the next message.
        </p>
        {status && view ? (
          <ModelPanel
            status={status}
            view={view}
            list={list}
            busy={busy}
            error={error ?? statusError}
            actions={{
              chooseProvider: (kind) =>
                void act(() =>
                  api<ModelStatus>('/model/provider', 'PUT', {
                    provider: kind,
                  }),
                ),
              signIn: () =>
                void act(() =>
                  api<ModelStatus>('/model/chatgpt/sign-in', 'POST', {}),
                ),
              cancel: () =>
                void act(() =>
                  api<ModelStatus>('/model/chatgpt/sign-in/cancel', 'POST', {}),
                ),
              signOut: () => {
                if (
                  window.confirm(
                    'Sign out of ChatGPT? OpenDots’ access is revoked and the tokens are cleared from this machine.',
                  )
                )
                  void act(() =>
                    api<ModelStatus>('/model/chatgpt/sign-out', 'POST', {}),
                  );
              },
              chooseModel: (model) =>
                void act(() =>
                  api<ModelStatus>('/model/chatgpt/model', 'PUT', { model }),
                ),
              refreshModels: () =>
                void act(() =>
                  api<ModelList>('/model/chatgpt/models/refresh', 'POST', {}),
                ),
              useServerDefault: () =>
                void act(() => api<ModelStatus>('/model/selection', 'DELETE')),
            }}
          />
        ) : (
          <p className="muted">{statusError ?? 'Loading…'}</p>
        )}
      </section>
    </div>
  );
}
