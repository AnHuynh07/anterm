import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { Connection } from '../types';
import { useTerminalTabs } from '../hooks/useTerminalTabs';
import { TerminalView } from '../components/Terminal';
import { COLOR_HEX } from '../components/colors';

export function TerminalPage() {
  const { connectionId, sharedToken } = useParams();
  const navigate = useNavigate();
  const { tabs, activeKey, openTab, closeTab, setActive, broadcast, setBroadcast } = useTerminalTabs();

  const { data } = useQuery({
    queryKey: ['connections'],
    queryFn: () => api<{ connections: Connection[] }>('/connections'),
  });

  // Deep-link support: /terminal/:connectionId (or /terminal/shared/:token) opens a
  // fresh tab then normalises the URL.
  const handled = useRef<string | null>(null);
  useEffect(() => {
    const key = connectionId ?? (sharedToken ? `s:${sharedToken}` : null);
    if (!key || handled.current === key) return;
    handled.current = key;
    if (sharedToken) {
      openTab({ sharedToken, title: 'shared session' });
    } else if (connectionId) {
      const c = data?.connections.find((x) => x.id === connectionId);
      openTab({ connectionId, title: c?.name ?? 'session', color: c?.color ?? undefined });
    }
    navigate('/terminal', { replace: true });
  }, [connectionId, sharedToken, data, openTab, navigate]);

  // Every open tab keeps a live terminal while this page is mounted (so tab
  // switching and Broadcast keep all sessions connected). New tabs are added as
  // they open; a session that dropped resumes from its stored token.
  const [mounted, setMounted] = useState<Set<string>>(() => new Set(tabs.map((t) => t.key)));
  useEffect(() => {
    setMounted((prev) => {
      const next = new Set(prev);
      for (const t of tabs) next.add(t.key);
      return next.size === prev.size ? prev : next;
    });
  }, [tabs]);
  const liveTabs = useMemo(() => tabs.filter((t) => mounted.has(t.key)), [tabs, mounted]);

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
        <span className="spacer" />
        {tabs.length > 1 && (
          <button
            className={`btn sm ${broadcast ? 'danger' : 'ghost'}`}
            title="Send keystrokes typed in any tab to every open session"
            onClick={() => setBroadcast(!broadcast)}
          >
            Broadcast {broadcast ? 'ON' : 'off'}
          </button>
        )}
      </div>

      {broadcast && tabs.length > 1 && (
        <div className="conn-banner broadcast">⚡ Broadcast — you are typing to all {tabs.length} sessions</div>
      )}
      {activeTab?.color && !broadcast && (
        <div className="conn-banner" style={{ background: COLOR_HEX[activeTab.color] }}>
          {activeTab.title}
        </div>
      )}

      <div className="terminal-stage">
        {liveTabs.map((t) => (
          <div
            key={t.key}
            className="terminal-slot"
            style={{ visibility: t.key === activeKey ? 'visible' : 'hidden', zIndex: t.key === activeKey ? 1 : 0 }}
          >
            <TerminalView
              tabKey={t.key}
              connectionId={t.connectionId}
              adhoc={t.adhoc}
              sharedToken={t.sharedToken}
              onExit={() => undefined}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
