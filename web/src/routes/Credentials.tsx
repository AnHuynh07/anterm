import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { AuthType, Credential } from '../types';
import { Badge } from '../components/Badge';

interface FormValue {
  name: string;
  sshUsername: string;
  authType: AuthType;
  secret: string;
  passphrase: string;
  loginUsername: string;
  loginPassword: string;
  enableMode: boolean;
  enablePassword: string;
  setupCommands: string;
}

const empty: FormValue = {
  name: '',
  sshUsername: '',
  authType: 'password',
  secret: '',
  passphrase: '',
  loginUsername: '',
  loginPassword: '',
  enableMode: false,
  enablePassword: '',
  setupCommands: '',
};

export function CredentialsPage() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Credential | 'new' | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['credentials'],
    queryFn: () => api<{ credentials: Credential[] }>('/credentials'),
  });

  const save = useMutation({
    mutationFn: (v: FormValue) => {
      const body = toBody(v);
      return editing && editing !== 'new'
        ? api(`/credentials/${editing.id}`, { method: 'PUT', body })
        : api('/credentials', { method: 'POST', body });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['credentials'] });
      void qc.invalidateQueries({ queryKey: ['connections'] });
      setEditing(null);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/credentials/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['credentials'] }),
  });

  return (
    <div className="page">
      <div className="row between">
        <h1>Credentials</h1>
        <button className="btn primary" onClick={() => setEditing('new')}>
          New credential
        </button>
      </div>
      <p className="muted">
        A reusable login profile — SSH auth plus optional in-band login automation. Attach one to many
        connections and rotate the password in a single place.
      </p>

      {isLoading && <p className="muted">Loading…</p>}
      {data && data.credentials.length === 0 && !editing && (
        <p className="muted">No credentials yet.</p>
      )}

      {data && data.credentials.length > 0 && (
        <table className="table">
          <tbody>
            {data.credentials.map((c) => (
              <tr key={c.id}>
                <td>
                  <div className="conn-name">{c.name}</div>
                  <div className="muted small">
                    {c.sshUsername ? `ssh: ${c.sshUsername}` : 'ssh user set per-connection'}
                    {c.loginUsername ? ` · login: ${c.loginUsername}` : ''}
                  </div>
                </td>
                <td>
                  <Badge tone={c.authType === 'key' ? 'info' : c.authType === 'agent' ? 'warn' : 'neutral'}>
                    {c.authType}
                  </Badge>
                  {c.hasEnablePassword && (
                    <Badge tone="neutral" >enable</Badge>
                  )}
                </td>
                <td className="actions">
                  <button className="btn ghost sm" onClick={() => setEditing(c)}>
                    Edit
                  </button>
                  <button
                    className="btn danger sm"
                    onClick={() => {
                      if (confirm(`Delete credential "${c.name}"? Connections using it fall back to their own settings.`))
                        remove.mutate(c.id);
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <CredentialForm
          initial={editing === 'new' ? undefined : editing}
          busy={save.isPending}
          error={save.error ? (save.error as Error).message : undefined}
          onCancel={() => setEditing(null)}
          onSubmit={(v) => save.mutate(v)}
        />
      )}
    </div>
  );
}

function CredentialForm({
  initial,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  initial?: Credential;
  busy?: boolean;
  error?: string;
  onCancel: () => void;
  onSubmit: (v: FormValue) => void;
}) {
  const [v, setV] = useState<FormValue>({
    ...empty,
    name: initial?.name ?? '',
    sshUsername: initial?.sshUsername ?? '',
    authType: initial?.authType ?? 'password',
    loginUsername: initial?.loginUsername ?? '',
    enableMode: initial?.hasEnablePassword ?? false,
    setupCommands: initial?.setupCommands ?? '',
  });
  const editing = Boolean(initial);
  const set = <K extends keyof FormValue>(k: K, val: FormValue[K]) => setV((p) => ({ ...p, [k]: val }));

  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit(v);
  }

  return (
    <form className="card form-panel" onSubmit={submit}>
      <h2>{editing ? `Edit “${initial?.name}”` : 'New credential'}</h2>
      <div className="grid2">
        <label>
          Name
          <input value={v.name} onChange={(e) => set('name', e.target.value)} required placeholder="core-admin" />
        </label>
        <label>
          Default SSH user <span className="muted small">(optional)</span>
          <input value={v.sshUsername} onChange={(e) => set('sshUsername', e.target.value)} placeholder="netadmin" />
        </label>
        <label>
          Auth method
          <select value={v.authType} onChange={(e) => set('authType', e.target.value as AuthType)}>
            <option value="password">Password</option>
            <option value="key">Private key</option>
            <option value="agent">SSH agent (server-side)</option>
          </select>
        </label>
      </div>

      {v.authType === 'password' && (
        <label>
          SSH password {editing && <span className="muted small">(blank = keep)</span>}
          <input type="password" value={v.secret} onChange={(e) => set('secret', e.target.value)} autoComplete="off" />
        </label>
      )}
      {v.authType === 'key' && (
        <>
          <label>
            Private key (PEM) {editing && <span className="muted small">(blank = keep)</span>}
            <textarea rows={5} className="mono" value={v.secret} onChange={(e) => set('secret', e.target.value)} />
          </label>
          <label>
            Passphrase (optional)
            <input type="password" value={v.passphrase} onChange={(e) => set('passphrase', e.target.value)} autoComplete="off" />
          </label>
        </>
      )}

      <div className="section">
        <div className="section-toggle" style={{ cursor: 'default' }}>
          Login automation <span className="muted small">(network device)</span>
        </div>
        <div className="section-body">
          <div className="grid2">
            <label>
              Login username
              <input value={v.loginUsername} onChange={(e) => set('loginUsername', e.target.value)} autoComplete="off" />
            </label>
            <label>
              Login password {editing && v.loginUsername && <span className="muted small">(blank = keep)</span>}
              <input
                type="password"
                value={v.loginPassword}
                onChange={(e) => set('loginPassword', e.target.value)}
                autoComplete="off"
              />
            </label>
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={v.enableMode} onChange={(e) => set('enableMode', e.target.checked)} />
            Enter enable / privileged mode
          </label>
          {v.enableMode && (
            <label>
              Enable password {editing && initial?.hasEnablePassword && <span className="muted small">(blank = keep)</span>}
              <input
                type="password"
                value={v.enablePassword}
                onChange={(e) => set('enablePassword', e.target.value)}
                autoComplete="off"
              />
            </label>
          )}
          <label>
            Setup commands <span className="muted small">(one per line)</span>
            <textarea
              rows={3}
              className="mono"
              value={v.setupCommands}
              onChange={(e) => set('setupCommands', e.target.value)}
              placeholder={'terminal length 0'}
            />
          </label>
        </div>
      </div>

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

function toBody(v: FormValue) {
  const base = {
    name: v.name.trim(),
    sshUsername: v.sshUsername.trim() || null,
    authType: v.authType,
    loginUsername: v.loginUsername.trim() || null,
    setupCommands: v.setupCommands.trim() || null,
  };
  const secret = v.secret.length ? v.secret : undefined;
  const passphrase = v.authType === 'key' && v.passphrase.length ? v.passphrase : undefined;
  const loginPassword = v.loginPassword.length ? v.loginPassword : undefined;
  const enablePassword = !v.enableMode ? null : v.enablePassword.length ? v.enablePassword : undefined;
  return { ...base, secret, passphrase, loginPassword, enablePassword };
}
