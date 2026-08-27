import { FormEvent, useState } from 'react';
import type { AuthType, Connection } from '../types';

export interface ConnectionFormValue {
  name: string;
  host: string;
  port: number;
  sshUsername: string;
  authType: AuthType;
  secret: string;
  passphrase: string;
  initCommand: string;
}

interface Props {
  initial?: Connection;
  busy?: boolean;
  error?: string;
  onCancel: () => void;
  onSubmit: (value: ConnectionFormValue) => void;
}

export function ConnectionForm({ initial, busy, error, onCancel, onSubmit }: Props) {
  const [v, setV] = useState<ConnectionFormValue>({
    name: initial?.name ?? '',
    host: initial?.host ?? '',
    port: initial?.port ?? 22,
    sshUsername: initial?.sshUsername ?? '',
    authType: initial?.authType ?? 'password',
    secret: '',
    passphrase: '',
    initCommand: initial?.initCommand ?? '',
  });
  const editing = Boolean(initial);
  const set = <K extends keyof ConnectionFormValue>(k: K, val: ConnectionFormValue[K]) =>
    setV((prev) => ({ ...prev, [k]: val }));

  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit(v);
  }

  return (
    <form className="card form-panel" onSubmit={submit}>
      <h2>{editing ? `Edit “${initial?.name}”` : 'New connection'}</h2>
      <div className="grid2">
        <label>
          Name
          <input value={v.name} onChange={(e) => set('name', e.target.value)} required />
        </label>
        <label>
          SSH user
          <input value={v.sshUsername} onChange={(e) => set('sshUsername', e.target.value)} required />
        </label>
        <label>
          Host
          <input value={v.host} onChange={(e) => set('host', e.target.value)} required />
        </label>
        <label>
          Port
          <input
            type="number"
            value={v.port}
            min={1}
            max={65535}
            onChange={(e) => set('port', Number(e.target.value))}
          />
        </label>
        <label>
          Auth method
          <select value={v.authType} onChange={(e) => set('authType', e.target.value as AuthType)}>
            <option value="password">Password</option>
            <option value="key">Private key</option>
            <option value="agent">SSH agent (server-side)</option>
          </select>
        </label>
        <label>
          Startup command (optional)
          <input value={v.initCommand} onChange={(e) => set('initCommand', e.target.value)} />
        </label>
      </div>

      {v.authType === 'password' && (
        <label>
          Password {editing && <span className="muted small">(leave blank to keep current)</span>}
          <input type="password" value={v.secret} onChange={(e) => set('secret', e.target.value)} autoComplete="off" />
        </label>
      )}

      {v.authType === 'key' && (
        <>
          <label>
            Private key (PEM) {editing && <span className="muted small">(leave blank to keep current)</span>}
            <textarea
              rows={6}
              className="mono"
              value={v.secret}
              onChange={(e) => set('secret', e.target.value)}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
            />
          </label>
          <label>
            Key passphrase (optional)
            <input
              type="password"
              value={v.passphrase}
              onChange={(e) => set('passphrase', e.target.value)}
              autoComplete="off"
            />
          </label>
        </>
      )}

      {error && <div className="alert error">{error}</div>}

      <div className="row end gap">
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
