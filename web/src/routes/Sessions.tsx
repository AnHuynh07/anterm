import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { CommandRecord, SshSessionRecord } from '../types';
import { Badge, statusTone } from '../components/Badge';
import { SessionReplay } from '../components/SessionReplay';

const fmt = (secs: number | null) => (secs ? new Date(secs * 1000).toLocaleString() : '—');
const dur = (r: SshSessionRecord) => (r.endedAt ? `${Math.max(1, r.endedAt - r.startedAt)}s` : 'active');
const bytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1_048_576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1_048_576).toFixed(1)} MB`;

export function SessionsPage() {
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
