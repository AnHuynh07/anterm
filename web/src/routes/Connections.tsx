import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import type { AuthType, Connection } from '../types';
import { useTerminalTabs } from '../hooks/useTerminalTabs';
import { ConnectionForm, type ConnectionFormValue } from '../components/ConnectionForm';
import { QuickConnect } from '../components/QuickConnect';

export function ConnectionsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { openTab } = useTerminalTabs();
  const [editing, setEditing] = useState<Connection | 'new' | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});

  const { data, isLoading } = useQuery({
    queryKey: ['connections'],
    queryFn: () => api<{ connections: Connection[] }>('/connections'),
  });

  const { data: serverInfo } = useQuery({
    queryKey: ['server-info'],
    queryFn: () => api<{ status: string; adhoc: boolean }>('/health'),
  });

  const save = useMutation({
    mutationFn: (value: ConnectionFormValue) => {
      const body = toBody(value);
      return editing && editing !== 'new'
        ? api(`/connections/${editing.id}`, { method: 'PUT', body })
        : api('/connections', { method: 'POST', body });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['connections'] });
      setEditing(null);
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/connections/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connections'] }),
  });

  const test = useMutation({
    mutationFn: (id: string) => api<{ ok: boolean; detail: string }>(`/connections/${id}/test`, { method: 'POST' }),
    onSuccess: (res, id) => setTestResult((r) => ({ ...r, [id]: `${res.ok ? '✓' : '✗'} ${res.detail}` })),
    onError: (err, id) => setTestResult((r) => ({ ...r, [id]: `✗ ${(err as Error).message}` })),
  });

  function open(conn: Connection) {
    openTab({ connectionId: conn.id, title: conn.name });
    navigate('/terminal');
  }

  return (
    <div className="page">
      <div className="row between">
        <h1>Connections</h1>
        <button className="btn primary" onClick={() => setEditing('new')}>
          New connection
        </button>
      </div>

      {serverInfo?.adhoc && <QuickConnect />}

      {isLoading && <p className="muted">Loading…</p>}

      {data && data.connections.length === 0 && !editing && (
        <p className="muted">No saved connections yet. Create one to get started.</p>
      )}

      {data && data.connections.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Target</th>
              <th>Auth</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.connections.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td className="mono">
                  {c.sshUsername}@{c.host}:{c.port}
                </td>
                <td>
                  {c.authType}
                  {testResult[c.id] && <div className="muted small">{testResult[c.id]}</div>}
                </td>
                <td className="row end gap">
                  <button className="btn primary sm" onClick={() => open(c)}>
                    Open
                  </button>
                  <button className="btn ghost sm" disabled={test.isPending} onClick={() => test.mutate(c.id)}>
                    Test
                  </button>
                  <button className="btn ghost sm" onClick={() => setEditing(c)}>
                    Edit
                  </button>
                  <button
                    className="btn danger sm"
                    onClick={() => {
                      if (confirm(`Delete connection "${c.name}"?`)) remove.mutate(c.id);
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
        <ConnectionForm
          initial={editing === 'new' ? undefined : editing}
          busy={save.isPending}
          error={save.error ? (save.error as Error).message : undefined}
          onCancel={() => setEditing(null)}
          onSubmit={(value) => save.mutate(value)}
        />
      )}
    </div>
  );
}

function toBody(value: ConnectionFormValue) {
  const base = {
    name: value.name.trim(),
    host: value.host.trim(),
    port: value.port,
    sshUsername: value.sshUsername.trim(),
    authType: value.authType as AuthType,
    initCommand: value.initCommand.trim() || null,
  };
  // Only send secret/passphrase when the user actually typed something,
  // so an edit that leaves them blank keeps the stored values.
  const secret = value.secret.length ? value.secret : undefined;
  const passphrase = value.authType === 'key' && value.passphrase.length ? value.passphrase : undefined;
  return { ...base, secret, passphrase };
}
