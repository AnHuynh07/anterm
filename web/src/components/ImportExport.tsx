import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, API_BASE } from '../lib/api';

type ImportResult = {
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
  needsCredentials: string[];
};

async function download(format: 'json' | 'csv') {
  const res = await fetch(`${API_BASE}/connections/export?format=${format}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`export failed (${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `anterm-connections-${new Date().toISOString().slice(0, 10)}.${format}`;
  a.click();
  URL.revokeObjectURL(url);
}

export function ImportExport({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [format, setFormat] = useState<'json' | 'csv'>('json');
  const [mode, setMode] = useState<'skip' | 'replace'>('skip');
  const [data, setData] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const run = useMutation({
    mutationFn: () => api<ImportResult>('/connections/import', { method: 'POST', body: { format, data, mode } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['connections'] });
    },
  });

  return (
    <form
      className="card form-panel"
      onSubmit={(e) => {
        e.preventDefault();
        run.mutate();
      }}
    >
      <div className="row between">
        <h2>Import / Export</h2>
        <button type="button" className="btn ghost sm" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="muted small">
        Exports carry the inventory and organisation — <strong>never passwords or keys</strong>. Credentials are
        referenced by name; create matching entries in the vault so imports link up.
      </p>

      <div className="row gap" style={{ marginTop: 8 }}>
        <button type="button" className="btn" onClick={() => download('json')}>
          Export JSON
        </button>
        <button type="button" className="btn" onClick={() => download('csv')}>
          Export CSV
        </button>
      </div>

      <div className="section">
        <div className="section-toggle" style={{ cursor: 'default' }}>
          Import
        </div>
        <div className="section-body">
          <div className="grid2">
            <label>
              Format
              <select value={format} onChange={(e) => setFormat(e.target.value as 'json' | 'csv')}>
                <option value="json">JSON</option>
                <option value="csv">CSV</option>
              </select>
            </label>
            <label>
              On name clash
              <select value={mode} onChange={(e) => setMode(e.target.value as 'skip' | 'replace')}>
                <option value="skip">Skip existing</option>
                <option value="replace">Replace existing</option>
              </select>
            </label>
          </div>
          <label>
            Paste {format.toUpperCase()} or choose a file
            <textarea
              rows={6}
              className="mono"
              value={data}
              onChange={(e) => setData(e.target.value)}
              placeholder={
                format === 'csv'
                  ? 'name,host,port,sshUsername,credential,group,tags,color'
                  : '[{ "name": "sw1", "host": "10.0.0.1", "credential": "core-admin" }]'
              }
            />
          </label>
          <input
            ref={fileRef}
            type="file"
            accept=".json,.csv,text/*"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) setData(await f.text());
            }}
          />

          {run.data && (
            <div className={`alert ${run.data.errors.length ? 'error' : 'ok'}`}>
              Created {run.data.created}, updated {run.data.updated}, skipped {run.data.skipped}.
              {run.data.needsCredentials.length > 0 && (
                <div>
                  Missing credentials (linked as “inline”): {run.data.needsCredentials.join(', ')}
                </div>
              )}
              {run.data.errors.map((err) => (
                <div key={err}>· {err}</div>
              ))}
            </div>
          )}
          {run.error && <div className="alert error">{(run.error as Error).message}</div>}

          <div className="row end">
            <button className="btn primary" disabled={run.isPending || !data.trim()}>
              {run.isPending ? 'Importing…' : 'Import'}
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
