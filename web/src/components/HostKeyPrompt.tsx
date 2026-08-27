import type { HostKeyPromptMsg } from '../types';

interface Props {
  msg: HostKeyPromptMsg;
  onDecision: (accept: boolean) => void;
}

export function HostKeyPrompt({ msg, onDecision }: Props) {
  const changed = msg.status === 'changed';
  return (
    <div className="overlay">
      <div className={`card hostkey ${changed ? 'danger' : ''}`}>
        <h2>{changed ? '⚠ Host key changed' : 'Unknown host key'}</h2>
        <p className="muted">
          {changed
            ? 'The host key for this server does not match the one previously trusted. This could be a man-in-the-middle attack — or the server was legitimately rebuilt.'
            : `The authenticity of host ${msg.hostport} can't be established.`}
        </p>
        <dl className="kv">
          <div>
            <dt>Host</dt>
            <dd>{msg.hostport}</dd>
          </div>
          <div>
            <dt>Key type</dt>
            <dd>{msg.keyType}</dd>
          </div>
          <div>
            <dt>Fingerprint</dt>
            <dd className="mono">{msg.fingerprint}</dd>
          </div>
          {msg.knownFingerprint && (
            <div>
              <dt>Previously</dt>
              <dd className="mono">{msg.knownFingerprint}</dd>
            </div>
          )}
        </dl>
        <div className="row end gap">
          <button className="btn ghost" onClick={() => onDecision(false)}>
            Reject
          </button>
          <button className={`btn ${changed ? 'danger' : 'primary'}`} onClick={() => onDecision(true)}>
            {changed ? 'Trust the new key' : 'Trust and continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
