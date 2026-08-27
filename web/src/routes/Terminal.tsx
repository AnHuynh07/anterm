import { useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { Connection } from '../types';
import { useTerminalTabs } from '../hooks/useTerminalTabs';
import { TerminalView } from '../components/Terminal';

export function TerminalPage() {
  const { connectionId } = useParams();
  const navigate = useNavigate();
  const { tabs, activeKey, openTab, closeTab, setActive } = useTerminalTabs();

  const { data } = useQuery({
    queryKey: ['connections'],
    queryFn: () => api<{ connections: Connection[] }>('/connections'),
  });

  // Deep-link support: /terminal/:connectionId opens a fresh tab then normalises the URL.
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!connectionId || handled.current === connectionId) return;
    handled.current = connectionId;
    const title = data?.connections.find((c) => c.id === connectionId)?.name ?? 'session';
    openTab({ connectionId, title });
    navigate('/terminal', { replace: true });
  }, [connectionId, data, openTab, navigate]);

  if (tabs.length === 0) {
    return (
      <div className="page">
        <h1>Terminal</h1>
        <p className="muted">No open sessions. Open one from the Connections page.</p>
        <button className="btn primary" onClick={() => navigate('/connections')}>
          Go to connections
        </button>
      </div>
    );
  }

  return (
    <div className="terminal-page">
      <div className="tab-bar">
        {tabs.map((t) => (
          <div key={t.key} className={`tab ${t.key === activeKey ? 'active' : ''}`} onClick={() => setActive(t.key)}>
            <span>{t.title}</span>
            <button
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.key);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="terminal-stage">
        {tabs.map((t) => (
          <div key={t.key} className="terminal-slot" style={{ display: t.key === activeKey ? 'flex' : 'none' }}>
            <TerminalView connectionId={t.connectionId} adhoc={t.adhoc} onExit={() => undefined} />
          </div>
        ))}
      </div>
    </div>
  );
}
