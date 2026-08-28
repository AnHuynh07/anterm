import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { Connection } from '../types';
import { useTerminalTabs } from '../hooks/useTerminalTabs';
import { TerminalView } from '../components/Terminal';
import { COLOR_HEX } from '../components/colors';
import { renderMarkdown } from '../lib/markdown';

type Layout = 'single' | 'split' | 'grid';
const LAYOUT_KEY = 'anterm.term.layout';
const NEXT: Record<Layout, Layout> = { single: 'split', split: 'grid', grid: 'single' };
const LABEL: Record<Layout, string> = { single: 'Split view', split: 'Grid view', grid: 'Single view' };
const CAP: Record<Layout, number> = { single: 1, split: 2, grid: 4 };

function readLayout(): Layout {
  try {
    const v = localStorage.getItem(LAYOUT_KEY);
    if (v === 'single' || v === 'split' || v === 'grid') return v;
  } catch {
    /* private mode */
  }
  return 'single';
}

/** Absolute geometry for pane `idx` of a `layout` grid — keeps every slot
 *  positioned (never `display:none`) so background tabs stay connected. */
function paneStyle(layout: Layout, idx: number): CSSProperties {
  const cols = 2;
  const rows = layout === 'grid' ? 2 : 1;
  const r = Math.floor(idx / cols);
  const c = idx % cols;
  return {
    position: 'absolute',
    top: `${(r / rows) * 100}%`,
    left: `${(c / cols) * 100}%`,
    width: `${100 / cols}%`,
    height: `${100 / rows}%`,
    visibility: 'visible',
    zIndex: 1,
  };
}

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
  // switching, split view and Broadcast keep all sessions connected). New tabs
  // are added as they open; a session that dropped resumes from its stored token.
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
  const activeConn = data?.connections.find((c) => c.id === activeTab?.connectionId);
  const [showRunbook, setShowRunbook] = useState(false);

  const [layout, setLayout] = useState<Layout>(readLayout);
  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, layout);
    } catch {
      /* private mode */
    }
  }, [layout]);

  // effective layout collapses when there aren't enough tabs to fill it
  const effLayout: Layout =
    tabs.length <= 1 ? 'single' : layout === 'grid' && tabs.length === 2 ? 'split' : layout;

  // which tabs get a pane, in stable tab order, with the active tab forced in
  const paneKeys = useMemo(() => {
    if (effLayout === 'single') return activeTab ? [activeTab.key] : [];
    const cap = CAP[effLayout];
    let keys = tabs.slice(0, cap).map((t) => t.key);
    if (activeKey && !keys.includes(activeKey)) keys = [...keys.slice(0, cap - 1), activeKey];
    return keys;
  }, [effLayout, tabs, activeKey, activeTab]);

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
            className={`tab ${t.key === activeKey ? 'active' : ''} ${
              effLayout !== 'single' && paneKeys.includes(t.key) ? 'in-pane' : ''
            }`}
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
        {activeConn?.runbook && (
          <button
            className={`btn sm ${showRunbook ? 'primary' : 'ghost'}`}
            title="Show this device's runbook notes"
            onClick={() => setShowRunbook((s) => !s)}
          >
            Runbook
          </button>
        )}
        {tabs.length > 1 && (
          <button
            className="btn sm ghost"
            title="Cycle terminal layout: single · split · grid"
            onClick={() => setLayout((l) => NEXT[l])}
          >
            {LABEL[layout]}
          </button>
        )}
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
      {activeConn?.protocol === 'telnet' && !broadcast && (
        <div className="conn-banner telnet">🔓 Telnet — this session is unencrypted; anything you type is sent in clear text</div>
      )}
      {activeTab?.color && !broadcast && activeConn?.protocol !== 'telnet' && (
        <div className="conn-banner" style={{ background: COLOR_HEX[activeTab.color] }}>
          {activeTab.title}
        </div>
      )}

      <div className="terminal-body">
        <div className={`terminal-stage layout-${effLayout}`}>
          {liveTabs.map((t) => {
            const paneIdx = paneKeys.indexOf(t.key);
            const inPane = paneIdx !== -1;
            const multi = effLayout !== 'single';
            const style: CSSProperties = inPane
              ? multi
                ? paneStyle(effLayout, paneIdx)
                : { visibility: 'visible', zIndex: 1 }
              : { visibility: 'hidden', zIndex: 0 };
            return (
              <div
                key={t.key}
                className={`terminal-slot ${multi && inPane ? 'pane' : ''} ${
                  multi && inPane && t.key === activeKey ? 'pane-active' : ''
                }`}
                style={style}
                onMouseDownCapture={() => {
                  if (multi && inPane) setActive(t.key);
                }}
              >
                <TerminalView
                  tabKey={t.key}
                  connectionId={t.connectionId}
                  adhoc={t.adhoc}
                  sharedToken={t.sharedToken}
                  onExit={() => undefined}
                />
              </div>
            );
          })}
        </div>

        {showRunbook && activeConn?.runbook && (
          <aside className="runbook-panel">
            <div className="runbook-head">
              <span>Runbook — {activeConn.name}</span>
              <button className="tab-close" title="Close" onClick={() => setShowRunbook(false)}>
                ×
              </button>
            </div>
            <div className="runbook-body md">{renderMarkdown(activeConn.runbook)}</div>
          </aside>
        )}
      </div>
    </div>
  );
}
