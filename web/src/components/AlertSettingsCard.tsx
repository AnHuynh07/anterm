import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { AlertSettings } from '../types';

export function AlertSettingsCard() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['alert-settings'], queryFn: () => api<AlertSettings>('/settings/alerts') });
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (data) {
      setEnabled(data.enabled);
      setUrl(data.webhookUrl);
    }
  }, [data]);

  const save = useMutation({
    mutationFn: () => api('/settings/alerts', { method: 'PUT', body: { enabled, webhookUrl: url.trim() } }),
    onSuccess: () => {
      setErr(null);
      setMsg('Saved.');
      void qc.invalidateQueries({ queryKey: ['alert-settings'] });
    },
    onError: (e) => {
      setMsg(null);
      setErr((e as Error).message);
    },
  });
  const test = useMutation({
    mutationFn: () => api<{ ok: boolean; detail: string }>('/settings/alerts/test', { method: 'POST', body: { webhookUrl: url.trim() } }),
    onSuccess: (r) => {
      setErr(r.ok ? null : r.detail);
      setMsg(r.ok ? `Test alert ${r.detail}` : null);
    },
    onError: (e) => {
      setMsg(null);
      setErr((e as Error).message);
    },
  });

  return (
    <div className="card">
      <h2>Alerting</h2>
      <p className="muted small">
        POST a message to a webhook whenever a device goes <b>up</b> or <b>down</b> (confirmed over two probes). The
        payload has a <code>text</code> field for Slack / Mattermost / Discord and a full <code>anterm</code> object for
        anything else.
      </p>
      {err && <div className="alert error">{err}</div>}
      {msg && <div className="alert ok">{msg}</div>}

      <label>
        Webhook URL
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://hooks.slack.com/services/…"
          autoComplete="off"
        />
      </label>
      <label className="checkbox" style={{ marginTop: 10 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Send alerts to this webhook
      </label>

      <div className="row end gap" style={{ marginTop: 12 }}>
        <button className="btn ghost" disabled={test.isPending || !/^https?:\/\//i.test(url.trim())} onClick={() => test.mutate()}>
          {test.isPending ? 'Sending…' : 'Send test'}
        </button>
        <button className="btn primary" disabled={save.isPending} onClick={() => save.mutate()}>
          Save
        </button>
      </div>
    </div>
  );
}
