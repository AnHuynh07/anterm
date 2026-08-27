import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, API_BASE } from '../lib/api';
import type { AuditEvent } from '../types';
import { Badge } from '../components/Badge';

const ACTION_GROUPS: Record<string, string> = {
  'auth.login': 'auth',
  'auth.login_failed': 'auth',
  'auth.logout': 'auth',
  'auth.password_changed': 'auth',
  'connection.create': 'connection',
  'connection.update': 'connection',
  'connection.delete': 'connection',
  'connection.share': 'connection',
  'connection.import': 'connection',
  'credential.create': 'credential',
  'credential.update': 'credential',
  'credential.delete': 'credential',
  'user.create': 'user',
  'user.update': 'user',
  'user.delete': 'user',
  'user.password_reset': 'user',
  'hostkey.trusted': 'hostkey',
  'hostkey.changed_accepted': 'hostkey',
};

const FILTERS = ['all', 'auth', 'connection', 'credential', 'user', 'hostkey'] as const;

function tone(action: string) {
  if (action === 'auth.login_failed' || action.endsWith('.delete') || action === 'hostkey.changed_accepted')
    return 'down' as const;
  if (action.startsWith('user.') || action === 'connection.share') return 'info' as const;
  if (action.startsWith('hostkey.')) return 'warn' as const;
  return 'neutral' as const;
}

function fmtDetail(d: unknown): string {
  if (!d || typeof d !== 'object') return '';
  return Object.entries(d as Record<string, unknown>)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join('  ');
}

export function ActivityPage() {
  const [group, setGroup] = useState<(typeof FILTERS)[number]>('all');
  const { data } = useQuery({
    queryKey: ['activity'],
    queryFn: () => api<{ events: AuditEvent[] }>('/activity?limit=500'),
    refetchInterval: 20_000,
  });

  const events = (data?.events ?? []).filter(
    (e) => group === 'all' || ACTION_GROUPS[e.action] === group,
  );

  return (
    <div className="page">
      <div className="row between">
        <h1>Activity</h1>
        <a className="btn ghost" href={`${API_BASE}/activity.csv`}>
          Export CSV
        </a>
      </div>
      <p className="muted small">Management actions — logins, connection &amp; credential changes, user admin, host-key trust.</p>

      <div className="chips" style={{ marginTop: 14 }}>
        {FILTERS.map((f) => (
          <button key={f} className={`chip ${group === f ? 'on' : ''}`} onClick={() => setGroup(f)}>
            {f}
          </button>
        ))}
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>When</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Target</th>
            <th>Detail</th>
            <th>IP</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id}>
              <td className="small muted" style={{ whiteSpace: 'nowrap' }}>
                {new Date(e.ts * 1000).toLocaleString()}
              </td>
              <td className="small">{e.actor ?? '—'}</td>
              <td>
                <Badge tone={tone(e.action)}>{e.action}</Badge>
              </td>
              <td className="mono small">{e.target ?? ''}</td>
              <td className="mono small muted">{fmtDetail(e.detail)}</td>
              <td className="mono small muted">{e.ip ?? ''}</td>
            </tr>
          ))}
          {events.length === 0 && (
            <tr>
              <td colSpan={6} className="muted small">
                No activity recorded yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
