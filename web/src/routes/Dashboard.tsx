import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import type { Connection, ReachResult } from '../types';
import { useTerminalTabs } from '../hooks/useTerminalTabs';

const UNGROUPED = 'Ungrouped';

export function DashboardPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
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
              return (
                <button key={c.id} className={`dash-card ${st}`} onClick={() => open(c)} title={r?.detail ?? ''}>
                  <div className="dash-dot" />
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
