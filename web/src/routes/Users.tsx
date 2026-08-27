import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { ManagedUser, Role } from '../types';
import { Badge, type BadgeTone } from '../components/Badge';

const ROLES: Role[] = ['admin', 'operator', 'viewer'];
const roleTone = (r: Role): BadgeTone => (r === 'admin' ? 'info' : r === 'viewer' ? 'neutral' : 'warn');

export function UsersPage() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['users'] });
  const [err, setErr] = useState<string | null>(null);

  const { data } = useQuery({ queryKey: ['users'], queryFn: () => api<{ users: ManagedUser[] }>('/users') });

  const create = useMutation({
    mutationFn: (b: { username: string; password: string; role: Role }) =>
      api('/users', { method: 'POST', body: b }),
    onSuccess: () => {
      setErr(null);
      void invalidate();
    },
    onError: (e) => setErr((e as Error).message),
  });
  const patch = useMutation({
    mutationFn: ({ id, ...b }: { id: string; role?: Role; disabled?: boolean }) =>
      api(`/users/${id}`, { method: 'PATCH', body: b }),
    onSuccess: () => {
      setErr(null);
      void invalidate();
    },
    onError: (e) => setErr((e as Error).message),
  });
  const resetPw = useMutation({
    mutationFn: ({ id, newPassword }: { id: string; newPassword: string }) =>
      api(`/users/${id}/password`, { method: 'POST', body: { newPassword } }),
    onSuccess: () => setErr(null),
    onError: (e) => setErr((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/users/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setErr(null);
      void invalidate();
    },
    onError: (e) => setErr((e as Error).message),
  });

  return (
    <div className="page">
      <div className="row between">
        <h1>Users</h1>
      </div>
      <p className="muted small">
        <b>Admin</b> manages users and sees every connection. <b>Operator</b> uses connections they own or that were
        shared with them. <b>Viewer</b> is read-only — no terminal sessions, no edits.
      </p>

      {err && <div className="alert error">{err}</div>}

      <table className="table">
        <thead>
          <tr>
            <th>User</th>
            <th>Role</th>
            <th>Status</th>
            <th>Sessions</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(data?.users ?? []).map((u) => (
            <tr key={u.id}>
              <td>
                <span className="conn-name">{u.username}</span>
                {u.isSelf && <span className="muted small"> · you</span>}
              </td>
              <td>
                {u.isSelf ? (
                  <Badge tone={roleTone(u.role)}>{u.role}</Badge>
                ) : (
                  <select
                    value={u.role}
                    style={{ width: 'auto', margin: 0 }}
                    onChange={(e) => patch.mutate({ id: u.id, role: e.target.value as Role })}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                )}
              </td>
              <td>
                {u.disabled ? <Badge tone="down">disabled</Badge> : <Badge tone="up">active</Badge>}
              </td>
              <td className="small muted">{u.activeSessions}</td>
              <td className="actions">
                {!u.isSelf && (
                  <button
                    className="btn ghost sm"
                    onClick={() => patch.mutate({ id: u.id, disabled: !u.disabled })}
                  >
                    {u.disabled ? 'Enable' : 'Disable'}
                  </button>
                )}
                <button
                  className="btn ghost sm"
                  onClick={() => {
                    const pw = prompt(`New password for "${u.username}" (min 8 chars):`);
                    if (pw && pw.length >= 8) resetPw.mutate({ id: u.id, newPassword: pw });
                  }}
                >
                  Reset password
                </button>
                {!u.isSelf && (
                  <button
                    className="btn danger sm"
                    onClick={() => {
                      if (confirm(`Delete user "${u.username}"? Their connections and history are removed too.`))
                        remove.mutate(u.id);
                    }}
                  >
                    Delete
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <NewUserForm busy={create.isPending} onCreate={(b) => create.mutate(b)} />
    </div>
  );
}

function NewUserForm({
  busy,
  onCreate,
}: {
  busy: boolean;
  onCreate: (b: { username: string; password: string; role: Role }) => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('operator');

  function submit(e: FormEvent) {
    e.preventDefault();
    if (username.trim() && password.length >= 8) {
      onCreate({ username: username.trim(), password, role });
      setUsername('');
      setPassword('');
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>Add a user</h2>
      <div className="grid2">
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="jdoe" />
        </label>
        <label>
          Temporary password
          <input
            type="text"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="at least 8 characters"
          />
        </label>
        <label>
          Role
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="row end" style={{ marginTop: 12 }}>
        <button className="btn primary" disabled={busy || !username.trim() || password.length < 8}>
          Create user
        </button>
      </div>
    </form>
  );
}
