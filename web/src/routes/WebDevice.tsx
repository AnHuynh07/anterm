import { useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, API_BASE } from '../lib/api';
import type { Connection } from '../types';
import { renderMarkdown } from '../lib/markdown';

export function WebDevicePage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [showRunbook, setShowRunbook] = useState(false);
  const [copied, setCopied] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const { data } = useQuery({
    queryKey: ['connections'],
    queryFn: () => api<{ connections: Connection[] }>('/connections'),
  });
  const conn = useMemo(() => data?.connections.find((c) => c.id === id), [data, id]);

  // /webproxy/:id/ is a sibling of /api, not under it
  const proxyBase = API_BASE.replace(/\/api$/, '');
  const src = `${proxyBase}/webproxy/${id}/`;

  async function openInNewTab() {
    try {
      const w = await api<{ url: string; username: string | null; password: string | null }>(`/connections/${id}/web`);
      if (w.password) {
        try {
          await navigator.clipboard.writeText(w.password);
          setCopied(true);
          setTimeout(() => setCopied(false), 3000);
        } catch {
          /* clipboard blocked — user can still see it via Reveal */
        }
      }
      window.open(w.url, '_blank', 'noopener');
    } catch {
      if (conn?.web?.url) window.open(conn.web.url, '_blank', 'noopener');
    }
  }

  if (data && !conn) {
    return (
      <div className="page">
        <h1>Web device</h1>
        <p className="muted">This device is not available.</p>
        <button className="btn primary" onClick={() => navigate('/connections')}>
          Back to connections
        </button>
      </div>
    );
  }

  return (
    <div className="terminal-page">
      <div className="tab-bar">
        <div className="tab active">
          <span>{conn?.name ?? 'web device'}</span>
        </div>
        <span className="spacer" />
        {conn?.runbook && (
          <button
            className={`btn sm ${showRunbook ? 'primary' : 'ghost'}`}
            onClick={() => setShowRunbook((s) => !s)}
          >
            Runbook
          </button>
        )}
        <button className="btn sm ghost" onClick={() => setReloadKey((k) => k + 1)}>
          Reload
        </button>
        <button className="btn sm ghost" onClick={openInNewTab}>
          {copied ? 'Password copied ✓' : 'Open in new tab'}
        </button>
      </div>

      <div className="terminal-body">
        <div className="terminal-stage">
          <iframe
            key={reloadKey}
            ref={iframeRef}
            className="web-frame"
            src={src}
            title={conn?.name ?? 'web device'}
          />
        </div>

        {showRunbook && conn?.runbook && (
          <aside className="runbook-panel">
            <div className="runbook-head">
              <span>Runbook — {conn.name}</span>
              <button className="tab-close" title="Close" onClick={() => setShowRunbook(false)}>
                ×
              </button>
            </div>
            <div className="runbook-body md">{renderMarkdown(conn.runbook)}</div>
          </aside>
        )}
      </div>
    </div>
  );
}
