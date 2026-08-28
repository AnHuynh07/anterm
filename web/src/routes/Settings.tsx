import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../hooks/useAuth';
import { VaultBackup } from '../components/VaultBackup';
import { TwoFactorCard } from '../components/TwoFactorCard';
import { AlertSettingsCard } from '../components/AlertSettingsCard';
import type { Snippet } from '../types';

export function SettingsPage() {
  const { user, isAdmin } = useAuth();
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);

  const change = useMutation({
    mutationFn: () => api('/auth/password', { method: 'POST', body: { currentPassword, newPassword } }),
    onSuccess: () => {
      setDone(true);
      setCurrent('');
      setNew('');
      setConfirm('');
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setDone(false);
    if (newPassword !== confirm) return;
    change.mutate();
  }

  const mismatch = confirm.length > 0 && newPassword !== confirm;

  return (
    <div className="page narrow">
      <h1>Settings</h1>
      <div className="card">
        <h2>Account</h2>
        <dl className="kv">
          <div>
            <dt>Username</dt>
            <dd>{user?.username}</dd>
          </div>
          <div>
            <dt>Role</dt>
            <dd>{user?.role}</dd>
          </div>
        </dl>
      </div>

      <form className="card" onSubmit={submit}>
        <h2>Change password</h2>
        <label>
          Current password
          <input type="password" value={currentPassword} onChange={(e) => setCurrent(e.target.value)} required />
        </label>
        <label>
          New password
          <input type="password" value={newPassword} onChange={(e) => setNew(e.target.value)} minLength={8} required />
        </label>
        <label>
          Confirm new password
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </label>
        {mismatch && <div className="alert error">Passwords do not match</div>}
        {change.error && <div className="alert error">{(change.error as Error).message}</div>}
        {done && <div className="alert ok">Password changed. Other sessions were signed out.</div>}
        <button className="btn primary" disabled={change.isPending || mismatch}>
          {change.isPending ? 'Saving…' : 'Update password'}
        </button>
      </form>

      <TwoFactorCard />

      <SnippetsCard />

      {isAdmin && <AlertSettingsCard />}
      {isAdmin && <VaultBackup />}
    </div>
  );
}

function SnippetsCard() {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');

  const { data } = useQuery({ queryKey: ['snippets'], queryFn: () => api<{ snippets: Snippet[] }>('/snippets') });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['snippets'] });

  const add = useMutation({
    mutationFn: () => api('/snippets', { method: 'POST', body: { name, command } }),
    onSuccess: () => {
      setName('');
      setCommand('');
      void invalidate();
    },
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/snippets/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });

  return (
    <div className="card">
      <h2>Command snippets</h2>
      <p className="muted small">Saved commands you can click-send from the terminal (executed on the current session).</p>
      {data && data.snippets.length > 0 && (
        <table className="table">
          <tbody>
            {data.snippets.map((s) => (
              <tr key={s.id}>
                <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{s.name}</td>
                <td className="mono small">{s.command}</td>
                <td className="actions">
                  <button className="btn danger sm" onClick={() => del.mutate(s.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form
        className="grid2"
        style={{ marginTop: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && command.trim()) add.mutate();
        }}
      >
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="show run" />
        </label>
        <label>
          Command
          <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="show running-config" />
        </label>
        <div className="row end" style={{ gridColumn: '1 / -1' }}>
          <button className="btn primary" disabled={add.isPending || !name.trim() || !command.trim()}>
            Add snippet
          </button>
        </div>
      </form>
    </div>
  );
}
