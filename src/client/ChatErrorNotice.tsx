import { chatErrorView, type ChatError } from './chat-error';

// Presentational: the only thing it can do is ask to reconnect. Generic errors
// keep the existing Reconnect behavior; a usage limit does not offer it and
// never touches the connection.
export function ChatErrorNotice({
  error,
  onReconnect,
}: {
  error: ChatError;
  onReconnect: () => void;
}) {
  const view = chatErrorView(error);
  if (view.kind === 'usage_limit')
    return (
      <div className="chat-error" role="alert">
        <span>{view.text}</span>
        <a
          className="link-button"
          href={view.usageUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open ChatGPT usage ↗
        </a>
      </div>
    );
  return (
    <div className="chat-error" role="alert">
      {view.text}
      <button onClick={onReconnect}>Reconnect</button>
    </div>
  );
}
