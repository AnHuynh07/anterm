import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { Connection } from '../types';
import { Badge } from './Badge';

interface RunResult {
  connectionId: string;
  name: string;
  target: string;
  ok: boolean;
  output: string;
  error?: string;
  durationMs: number;
}

export function BulkRunDialog({
  connections,
  onClose,
}: {
  connections: Connection[];
  onClose: () => void;
}) {
  const [command, setCommand] = useState('');
  const [results, setResults] = useState<RunResult[] | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const run = useMutation({
    mutationFn: () =>
      api<{ results: RunResult[] }>('/connections/bulk-run', {
        method: 'POST',
        body: { connectionIds: connections.map((c) => c.id), command: command.trim() },
      }),
    onSuccess: (res) => setResults(res.results),
  });

  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  function downloadAll() {
    if (!results) return;
    const body = results
      .map(
        (r) =>
          `===== ${r.name}  (${r.target})  ${r.ok ? 'OK' : 'FAILED' + (r.error ? ': ' + r.error : '')}  ${r.durationMs}ms =====\n${r.output || ''}`,
      )
      .join('\n\n');
    const url = URL.createObjectURL(new Blob([`$ ${command}\n\n${body}\n`], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `bulk-run-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const okCount = results?.filter((r) => r.ok).length ?? 0;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="card modal" onClick={(e) => e.stopPropagation()}>
        <h2>Run a command on {connections.length} device{connections.length > 1 ? 's' : ''}</h2>
        <p className="muted small">
          Opens a throwaway SSH session per device, runs login automation if configured, sends one command and collects
          the output. Devices whose host key isn’t trusted yet are skipped — open them once first.
        </p>

        <div className="row gap" style={{ marginTop: 10 }}>
          <input
            className="mono"
            style={{ margin: 0, flex: 1 }}
            placeholder="show version"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && command.trim() && !run.isPending) run.mutate();
            }}
            autoFocus
          />
          <button className="btn primary" disabled={!command.trim() || run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? 'Running…' : 'Run'}
          </button>
        </div>
        {run.error && <div className="alert error">{(run.error as Error).message}</div>}

        {results && (
          <>
            <div className="row between" style={{ margin: '14px 0 6px' }}>
              <span className="small">
                <Badge tone="up">{okCount} ok</Badge>{' '}
                {results.length - okCount > 0 && <Badge tone="down">{results.length - okCount} failed</Badge>}
              </span>
              <button className="btn ghost sm" onClick={downloadAll}>
                Download all (.txt)
              </button>
            </div>
            <div className="bulk-results">
              {results.map((r) => (
                <div key={r.connectionId} className={`bulk-row ${r.ok ? '' : 'failed'}`}>
                  <button className="bulk-head" onClick={() => toggle(r.connectionId)}>
                    <span className={`dash-dot ${r.ok ? 'ok' : 'bad'}`} />
                    <b>{r.name}</b>
                    <span className="muted small mono">{r.target}</span>
                    <span className="spacer" />
                    {r.error ? (
                      <span className="muted small">{r.error}</span>
                    ) : (
                      <span className="muted small">{r.durationMs} ms</span>
                    )}
                    <span className="muted">{open.has(r.connectionId) ? '▾' : '▸'}</span>
                  </button>
                  {open.has(r.connectionId) && (
                    <pre className="paste-preview">{r.output || r.error || '(no output)'}</pre>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        <div className="row end gap" style={{ marginTop: 14 }}>
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
