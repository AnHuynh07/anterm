import { useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, API_BASE } from '../lib/api';
import type { Connection, WebFactsResponse } from '../types';
import { renderMarkdown } from '../lib/markdown';

export function WebDevicePage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [showRunbook, setShowRunbook] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [copied, setCopied] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const { data } = useQuery({
    queryKey: ['connections'],
    queryFn: () => api<{ connections: Connection[] }>('/connections'),
  });
  const conn = useMemo(() => data?.connections.find((c) => c.id === id), [data, id]);
  const hasFacts = Boolean(conn?.web?.factsUrl);

  const facts = useQuery({
    queryKey: ['web-facts', id],
    queryFn: () => api<WebFactsResponse>(`/connections/${id}/web-facts`),
    enabled: showInfo && hasFacts,
    staleTime: 60_000,
    retry: false,
  });

  // /webproxy/:id/ is a sibling of /api, not under it
  const proxyBase = API_BASE.replace(/\/api$/, '');
  const src = `${proxyBase}/webproxy/${id}/`;

  // Reload the page the iframe is *currently* on (same origin, so this works),
  // not the entry URL — a switch root usually only ever shows its login screen.
  function reloadFrame() {
    try {
      iframeRef.current?.contentWindow?.location.reload();
    } catch {
      setReloadKey((k) => k + 1); // cross-origin somehow: fall back to a full remount
    }
  }

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
        {hasFacts && (
          <button
            className={`btn sm ${showInfo ? 'primary' : 'ghost'}`}
            onClick={() => setShowInfo((s) => !s)}
          >
            Device info
          </button>
        )}
        {conn?.runbook && (
          <button
            className={`btn sm ${showRunbook ? 'primary' : 'ghost'}`}
            onClick={() => setShowRunbook((s) => !s)}
          >
            Runbook
          </button>
        )}
        <button className="btn sm ghost" onClick={reloadFrame}>
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

        {showInfo && hasFacts && (
          <aside className="runbook-panel">
            <div className="runbook-head">
              <span>Device info — {conn?.name}</span>
              <span className="spacer" />
              <button
                className="btn sm ghost"
                disabled={facts.isFetching}
                onClick={() => facts.refetch()}
              >
                {facts.isFetching ? 'Reading…' : 'Refresh'}
              </button>
              <button className="tab-close" title="Close" onClick={() => setShowInfo(false)}>
                ×
              </button>
            </div>
            <div className="runbook-body">
              {facts.isLoading && <p className="muted small">Reading the device…</p>}
              {facts.error && (
                <div className="alert error">{(facts.error as Error).message}</div>
              )}
              {facts.data && (
                <>
                  {facts.data.baseline && facts.data.firmware && (
                    <div className={`alert ${facts.data.firmwareOk ? 'ok' : 'error'}`}>
                      Firmware {facts.data.firmware}
                      {facts.data.firmwareOk ? ' — matches baseline' : ` — expected ${facts.data.baseline}`}
                    </div>
                  )}
                  <table className="table">
                    <tbody>
                      {facts.data.facts.map((f) => (
                        <tr key={f.label}>
                          <td className="small muted">{f.label}</td>
                          <td className="small mono">{f.value}</td>
                        </tr>
                      ))}
                      {facts.data.facts.length === 0 && (
                        <tr>
                          <td className="muted small">
                            Nothing matched — adjust the scrape rules on this connection.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                  <p className="muted small">
                    Read {new Date(facts.data.fetchedAt * 1000).toLocaleTimeString()} · read-only, straight from the
                    device’s status page
                  </p>
                </>
              )}
            </div>
          </aside>
        )}

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
