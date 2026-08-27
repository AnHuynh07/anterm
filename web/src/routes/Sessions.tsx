import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { SshSessionRecord } from '../types';

const fmt = (secs: number | null) => (secs ? new Date(secs * 1000).toLocaleString() : '—');
const dur = (r: SshSessionRecord) => (r.endedAt ? `${Math.max(1, r.endedAt - r.startedAt)}s` : 'active');
const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1_048_576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1_048_576).toFixed(1)} MB`);

export function SessionsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api<{ sessions: SshSessionRecord[] }>('/sessions'),
  });

  return (
    <div className="page">
      <h1>Session history</h1>
      {isLoading && <p className="muted">Loading…</p>}
      {data && data.sessions.length === 0 && <p className="muted">No sessions recorded yet.</p>}
      {data && data.sessions.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Target</th>
              <th>Started</th>
              <th>Duration</th>
              <th>In / Out</th>
              <th>Client IP</th>
              <th>Ended</th>
            </tr>
          </thead>
          <tbody>
            {data.sessions.map((s) => (
              <tr key={s.id}>
                <td className="mono">{s.target}</td>
                <td>{fmt(s.startedAt)}</td>
                <td>{dur(s)}</td>
                <td className="mono small">
                  {bytes(s.bytesIn)} / {bytes(s.bytesOut)}
                </td>
                <td className="mono small">{s.clientIp ?? '—'}</td>
                <td className="small">{s.exitReason ?? (s.endedAt ? 'closed' : '—')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
