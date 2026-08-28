import { useEffect, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import type { Connection, ReachResult } from '../types';
import { useAuth } from '../hooks/useAuth';
import { useTerminalTabs } from '../hooks/useTerminalTabs';
import { Badge } from '../components/Badge';
import { markAlertsSeen, useAlertEvents } from '../lib/alerts';

const UNGROUPED = 'Ungrouped';

export function DashboardPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { canWrite } = useAuth();
  const { openTab } = useTerminalTabs();

  const { data: connData } = useQuery({
    queryKey: ['connections'],
    queryFn: () => api<{ connections: Connection[] }>('/connections'),
  });
  const { data: healthData, dataUpdatedAt } = useQuery({
    queryKey: ['connections-health'],
    queryFn: () => api<{ health: Record<string, ReachResult> }>('/connections/health'),
    refetchInterval: 30_000,
  });

  const check = useMutation({
    mutationFn: () => api<{ health: Record<string, ReachResult> }>('/connections/health/check', { method: 'POST' }),
    onSuccess: (res) => qc.setQueryData(['connections-health'], res),
  });

  const { data: eventsData } = useAlertEvents();
  const events = useMemo(() => eventsData?.events ?? [], [eventsData]);

  useEffect(() => {
    const newest = events[0];
    if (newest) markAlertsSeen(newest.ts);
  }, [events]);

  const conns = useMemo(() => connData?.connections ?? [], [connData]);
  const health = useMemo<Record<string, ReachResult>>(() => healthData?.health ?? {}, [healthData]);

  const counts = useMemo(() => {
    let up = 0,
      down = 0,
      unknown = 0;
    for (const c of conns) {
      const s = health[c.id]?.status ?? 'unknown';
      if (s === 'up') up++;
      else if (s === 'down') down++;
      else unknown++;
    }
    return { up, down, unknown };
  }, [conns, health]);

  const grouped = useMemo(() => {
    const m = new Map<string, Connection[]>();
    for (const c of conns) {
      const k = c.groupName || UNGROUPED;
      (m.get(k) ?? m.set(k, []).get(k)!).push(c);
    }
    return [...m.entries()].sort(([a], [b]) => (a === UNGROUPED ? 1 : b === UNGROUPED ? -1 : a.localeCompare(b)));
  }, [conns]);

  function open(c: Connection) {
    if (c.canOpen === false || !canWrite) return;
    if (c.protocol === 'http') {
      navigate(`/web/${c.id}`);
      return;
    }
    openTab({ connectionId: c.id, title: c.name, color: c.color ?? undefined });
    navigate('/terminal');
  }

  return (
    <div className="page">
      <div className="row between">
        <h1>Dashboard</h1>
        <button className="btn primary" disabled={check.isPending} onClick={() => check.mutate()}>
          {check.isPending ? 'Checking…' : 'Check now'}
        </button>
      </div>

      <div className="stat-row">
        <div className="stat up">
          <span className="stat-n">{counts.up}</span> up
        </div>
        <div className="stat down">
          <span className="stat-n">{counts.down}</span> down
        </div>
        <div className="stat neutral">
          <span className="stat-n">{counts.unknown}</span> unknown
        </div>
        {dataUpdatedAt > 0 && (
          <span className="muted small">checked {new Date(dataUpdatedAt).toLocaleTimeString()}</span>
        )}
      </div>

      {events.length > 0 && (
        <div className="card" style={{ marginBottom: 18 }}>
          <h2>Recent status changes</h2>
          <table className="table">
            <tbody>
              {events.slice(0, 12).map((e) => (
                <tr key={e.id}>
                  <td style={{ width: 1, whiteSpace: 'nowrap' }}>
                    <Badge tone={e.status === 'up' ? 'up' : e.status === 'down' ? 'down' : 'warn'} dot>
                      {e.status.toUpperCase()}
                    </Badge>
                  </td>
                  <td style={{ fontWeight: 600 }}>{e.name}</td>
                  <td className="muted small">
                    {e.status === 'up' && e.latencyMs != null ? `${e.latencyMs} ms` : (e.detail ?? '')}
                  </td>
                  <td className="muted small" style={{ width: 1, whiteSpace: 'nowrap', textAlign: 'right' }}>
                    {new Date(e.ts).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {conns.length === 0 && <p className="muted">No connections to monitor.</p>}

      {grouped.map(([group, list]) => (
        <div key={group} className="conn-group">
          <div className="conn-group-head">
            {group}
            <span className="muted small"> · {list.length}</span>
          </div>
          <div className="dash-grid">
            {list.map((c) => {
              const r = health[c.id];
              const st = r?.status ?? 'unknown';
              const openable = canWrite && c.canOpen !== false;
              return (
                <button
                  key={c.id}
                  className={`dash-card ${st}`}
                  onClick={() => open(c)}
                  disabled={!openable}
                  style={openable ? undefined : { cursor: 'default' }}
                  title={r?.detail ?? ''}
                >
                  <div className="dash-top">
                    <span className="dash-dot" />
                    <span className={`dash-proto ${c.protocol}`}>{c.protocol === 'http' ? 'web' : c.protocol}</span>
                  </div>
                  <div className="dash-name">{c.name}</div>
                  <div className="mono small muted">
                    {c.host}:{c.port}
                  </div>
                  <div className="small">
                    {st === 'up' && r?.latencyMs != null ? `${r.latencyMs} ms` : st.toUpperCase()}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
