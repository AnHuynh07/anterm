import { useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { Connection } from '../types';
import { useTerminalTabs } from '../hooks/useTerminalTabs';
import { TerminalView } from '../components/Terminal';
import { COLOR_HEX } from '../components/colors';

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
    const c = data?.connections.find((x) => x.id === connectionId);
    openTab({ connectionId, title: c?.name ?? 'session', color: c?.color ?? undefined });
    navigate('/terminal', { replace: true });
  }, [connectionId, data, openTab, navigate]);

  const activeTab = tabs.find((t) => t.key === activeKey) ?? tabs[0];

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
          <div
            key={t.key}
            className={`tab ${t.key === activeKey ? 'active' : ''}`}
            onClick={() => setActive(t.key)}
            style={t.color ? { borderTop: `2px solid ${COLOR_HEX[t.color]}` } : undefined}
          >
            {t.color && <span className="tab-dot" style={{ background: COLOR_HEX[t.color] }} />}
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
      {activeTab?.color && (
        <div className="conn-banner" style={{ background: COLOR_HEX[activeTab.color] }}>
          {activeTab.title}
        </div>
      )}
      <div className="terminal-stage">
        {/* Render only the active session — xterm needs a visible, sized container.
            Switching tabs (re)connects that session. */}
        {activeTab && (
          <div key={activeTab.key} className="terminal-slot">
            <TerminalView connectionId={activeTab.connectionId} adhoc={activeTab.adhoc} onExit={() => undefined} />
          </div>
        )}
      </div>
    </div>
  );
}
