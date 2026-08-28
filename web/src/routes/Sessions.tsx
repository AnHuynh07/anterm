import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import type { CommandRecord, Connection, LiveSession, SshSessionRecord } from '../types';
import { useAuth } from '../hooks/useAuth';
import { useTerminalTabs } from '../hooks/useTerminalTabs';
import { Badge, statusTone } from '../components/Badge';
import { SessionReplay } from '../components/SessionReplay';

const fmt = (secs: number | null) => (secs ? new Date(secs * 1000).toLocaleString() : '—');
const dur = (r: SshSessionRecord) => (r.endedAt ? `${Math.max(1, r.endedAt - r.startedAt)}s` : 'active');
const bytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1_048_576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1_048_576).toFixed(1)} MB`;

function ago(secs: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - secs);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function RunningSessions() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { openTab } = useTerminalTabs();
  const { data } = useQuery({
    queryKey: ['sessions-live'],
    queryFn: () => api<{ sessions: LiveSession[] }>('/sessions/live'),
    refetchInterval: 10_000,
  });
  const { data: connData } = useQuery({
    queryKey: ['connections'],
    queryFn: () => api<{ connections: Connection[] }>('/connections'),
  });
  const stop = useMutation({
    mutationFn: (token: string) => api(`/sessions/live/${token}/stop`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions-live'] }),
  });

  const rows = data?.sessions ?? [];
  if (rows.length === 0) return null;

  const nameFor = (s: LiveSession) =>
    connData?.connections.find((c) => c.id === s.connectionId)?.name ?? s.target;

  function reattach(s: LiveSession) {
    openTab({ connectionId: s.connectionId ?? undefined, title: nameFor(s), resumeToken: s.token });
    navigate('/terminal');
  }

  return (
    <div className="card">
      <h2>Running sessions</h2>
      <p className="muted small">
        Sessions still alive on the server — attached elsewhere or waiting to be picked back up. Re-attach from here on any
        device.
      </p>
      <table className="table">
        <tbody>
          {rows.map((s) => (
            <tr key={s.token}>
              <td>
                <Badge tone={s.attached > 0 ? 'up' : 'info'} dot>
                  {s.attached > 0 ? `attached${s.attached > 1 ? ` ×${s.attached}` : ''}` : 'detached'}
                </Badge>
              </td>
              <td style={{ fontWeight: 600 }}>{nameFor(s)}</td>
              <td className="mono small muted">{s.target}</td>
              <td className="small muted">
                started {ago(s.startedAt)}
                {s.detachedAt ? ` · left ${ago(s.detachedAt)}` : ''}
                {s.observers > 0 ? ` · 👁 ${s.observers}` : ''}
              </td>
              <td className="actions">
                <button className="btn primary sm" onClick={() => reattach(s)}>
                  Re-attach
                </button>
                <button className="btn danger sm" disabled={stop.isPending} onClick={() => stop.mutate(s.token)}>
                  Stop
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SessionsPage() {
  const { isAdmin } = useAuth();
  const [replay, setReplay] = useState<SshSessionRecord | null>(null);
  const [cmdQuery, setCmdQuery] = useState('');
  const [showCmds, setShowCmds] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api<{ sessions: SshSessionRecord[] }>('/sessions'),
  });
  const { data: cmdData, isFetching: cmdFetching } = useQuery({
    queryKey: ['commands', cmdQuery],
    queryFn: () => api<{ commands: CommandRecord[] }>(`/commands?q=${encodeURIComponent(cmdQuery)}`),
    enabled: showCmds,
  });

  return (
    <div className="page">
      <div className="row between">
        <h1>Session history</h1>
        <button className="btn ghost" onClick={() => setShowCmds((s) => !s)}>
          {showCmds ? 'Hide command log' : 'Command log'}
        </button>
      </div>
      {isAdmin && <p className="muted small">Showing sessions for every user.</p>}

      <RunningSessions />

      {showCmds && (
        <div className="card">
          <h2>Command log</h2>
          <input
            className="search"
            placeholder="Search commands across all sessions…"
            value={cmdQuery}
            onChange={(e) => setCmdQuery(e.target.value)}
            style={{ marginTop: 8 }}
          />
          {cmdFetching && <p className="muted small">Searching…</p>}
          {cmdData && cmdData.commands.length === 0 && <p className="muted small">No matching commands.</p>}
          {cmdData && cmdData.commands.length > 0 && (
            <table className="table">
              <tbody>
                {cmdData.commands.map((c) => (
                  <tr key={c.id}>
                    <td className="small" style={{ whiteSpace: 'nowrap' }}>
                      {fmt(c.ts)}
                    </td>
                    <td className="mono small">{c.target}</td>
                    <td className="mono">{c.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {isLoading && <p className="muted">Loading…</p>}
      {data && data.sessions.length === 0 && <p className="muted">No sessions recorded yet.</p>}
      {data && data.sessions.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>State</th>
              {isAdmin && <th>User</th>}
              <th>Target</th>
              <th>Started</th>
              <th>Duration</th>
              <th>In / Out</th>
              <th>Cmds</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.sessions.map((s) => {
              const active = !s.endedAt;
              const tone = active ? 'info' : statusTone(s.exitReason);
              return (
                <tr key={s.id}>
                  <td>
                    <Badge tone={tone} dot>
                      {active ? 'Active' : tone === 'down' ? 'Error' : tone === 'warn' ? 'Warn' : 'Ended'}
                    </Badge>
                  </td>
                  {isAdmin && <td className="small">{s.user ?? '—'}</td>}
                  <td className="mono">{s.target}</td>
                  <td className="small">{fmt(s.startedAt)}</td>
                  <td className="small">{dur(s)}</td>
                  <td className="mono small">
                    {bytes(s.bytesIn)} / {bytes(s.bytesOut)}
                  </td>
                  <td className="small">{s.commandCount || '—'}</td>
                  <td className="actions">
                    {s.hasRecording && (
                      <button className="btn primary sm" onClick={() => setReplay(s)}>
                        ▶ Replay
                      </button>
                    )}
                    <span className="muted small" title={s.exitReason ?? ''}>
                      {s.clientIp ?? ''}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {replay && <SessionReplay sessionId={replay.id} target={replay.target} onClose={() => setReplay(null)} />}
    </div>
  );
}
