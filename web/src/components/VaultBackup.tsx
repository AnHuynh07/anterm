import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, API_BASE } from '../lib/api';

type ExportFormat = 'encrypted' | 'json' | 'csv';

function csrf(): string {
  return (
    document.cookie
      .split('; ')
      .find((r) => r.startsWith('anterm_csrf='))
      ?.split('=')[1] ?? ''
  );
}

/** POST that returns a file — pull it as a blob and save it. */
async function download(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf() },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(JSON.parse(t || '{}').error ?? `request failed (${res.status})`);
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'anterm-export';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

interface ImportResult {
  credentials: { created: number; updated: number; skipped: number };
  connections: { created: number; updated: number; skipped: number };
  errors: string[];
}

export function VaultBackup() {
  const { data: health } = useQuery({
    queryKey: ['server-info'],
    queryFn: () => api<{ secretExport?: boolean }>('/health'),
  });

  if (health && health.secretExport === false) {
    return (
      <div className="card">
        <h2>Backup &amp; vault export</h2>
        <p className="muted small">
          Disabled on this server (<code>--allow-secret-export=false</code>).
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Backup &amp; vault export</h2>
      <p className="muted small">
        Admin-only. These downloads contain <b>decrypted</b> SSH passwords and keys for every user. Store them
        somewhere safe and delete them when done.
      </p>
      <ExportForm />
      <ImportForm />
      <DbBackup />
    </div>
  );
}

function ExportForm() {
  const [password, setPassword] = useState('');
  const [format, setFormat] = useState<ExportFormat>('encrypted');
  const [passphrase, setPassphrase] = useState('');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const plaintext = format === 'json' || format === 'csv';
  const disabled =
    busy || !password || (format === 'encrypted' && passphrase.length < 8) || (plaintext && !ack);

  async function run() {
    setBusy(true);
    setErr(null);
    setOk(false);
    try {
      await download('/vault/export', {
        password,
        format,
        passphrase: format === 'encrypted' ? passphrase : undefined,
        acknowledgePlaintext: plaintext ? ack : undefined,
      });
      setOk(true);
      setPassword('');
      setPassphrase('');
      setAck(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="section">
      <div className="section-toggle" style={{ cursor: 'default' }}>
        Export vault
      </div>
      <div className="section-body">
        <label>
          Your password (confirm it&apos;s you)
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
        </label>
        <label>
          Format
          <select value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
            <option value="encrypted">Encrypted archive (.anterm) — recommended, portable</option>
            <option value="json">Plaintext JSON — secrets in the clear</option>
            <option value="csv">Plaintext CSV — secrets in the clear</option>
          </select>
        </label>
        {format === 'encrypted' && (
          <label>
            Archive passphrase <span className="muted small">(needed to open the file — not stored)</span>
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="at least 8 characters"
              autoComplete="off"
            />
          </label>
        )}
        {plaintext && (
          <label className="checkbox" style={{ marginTop: 10 }}>
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span style={{ color: 'var(--down-ink)', fontWeight: 600 }}>
              I understand this file holds every password in plain text.
            </span>
          </label>
        )}
        {err && <div className="alert error">{err}</div>}
        {ok && <div className="alert ok">Export downloaded.</div>}
        <div className="row end" style={{ marginTop: 12 }}>
          <button className="btn primary" disabled={disabled} onClick={run}>
            {busy ? 'Preparing…' : 'Export'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ImportForm() {
  const [password, setPassword] = useState('');
  const [format, setFormat] = useState<'encrypted' | 'json'>('encrypted');
  const [passphrase, setPassphrase] = useState('');
  const [mode, setMode] = useState<'skip' | 'replace'>('skip');
  const [data, setData] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  function pickFile(f: File | undefined) {
    if (!f) return;
    setFormat(f.name.endsWith('.anterm') ? 'encrypted' : 'json');
    const r = new FileReader();
    r.onload = () => setData(String(r.result ?? ''));
    r.readAsText(f);
  }

  async function run() {
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const res = await api<ImportResult>('/vault/import', {
        method: 'POST',
        body: { password, format, data, passphrase: format === 'encrypted' ? passphrase : undefined, mode },
      });
      setResult(res);
      setData('');
      setPassword('');
      setPassphrase('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="section">
      <div className="section-toggle" style={{ cursor: 'default' }}>
        Import vault
      </div>
      <div className="section-body">
        <label>
          Backup file <span className="muted small">(.anterm or .json)</span>
          <input type="file" accept=".anterm,.json,application/json" onChange={(e) => pickFile(e.target.files?.[0])} />
        </label>
        {format === 'encrypted' && (
          <label>
            Archive passphrase
            <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="off" />
          </label>
        )}
        <div className="grid2">
          <label>
            On name conflict
            <select value={mode} onChange={(e) => setMode(e.target.value as 'skip' | 'replace')}>
              <option value="skip">Skip existing</option>
              <option value="replace">Overwrite existing</option>
            </select>
          </label>
          <label>
            Your password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
          </label>
        </div>
        {err && <div className="alert error">{err}</div>}
        {result && (
          <div className="alert ok">
            Credentials: +{result.credentials.created} ~{result.credentials.updated} ·{result.credentials.skipped} skipped.
            Connections: +{result.connections.created} ~{result.connections.updated} ·{result.connections.skipped}{' '}
            skipped.
            {result.errors.length > 0 && ` ${result.errors.length} error(s).`}
          </div>
        )}
        <div className="row end" style={{ marginTop: 12 }}>
          <button className="btn" disabled={busy || !data || !password} onClick={run}>
            {busy ? 'Importing…' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
}

function DbBackup() {
  return (
    <div className="section">
      <div className="section-toggle" style={{ cursor: 'default' }}>
        Database backup
      </div>
      <div className="section-body">
        <p className="muted small">
          The whole SQLite file. Restore by stopping the server, replacing the DB file, and starting it again — keep a
          copy of <code>ANTERM_APP_SECRET</code> with it or the secrets stay locked.
        </p>
        <div className="row end">
          <a className="btn ghost" href={`${API_BASE}/vault/db-backup`}>
            Download database
          </a>
        </div>
      </div>
    </div>
  );
}
