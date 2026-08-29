import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { Connection, ConfigSnapshot, DiffLine } from '../types';
import { Badge } from './Badge';

const when = (s: number) => new Date(s * 1000).toLocaleString();

export function ConfigHistory({ connection, onClose }: { connection: Connection; onClose: () => void }) {
  const qc = useQueryClient();
  const [diffB, setDiffB] = useState<string | null>(null);
  const [raw, setRaw] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ['config-snapshots', connection.id],
    queryFn: () =>
      api<{ snapshots: ConfigSnapshot[]; configCommand: string | null; protocol?: string }>(
        `/connections/${connection.id}/config-snapshots`,
      ),
  });
  const isWeb = connection.protocol === 'http';
  const snapshot = useMutation({
    mutationFn: () =>
      api<{ changed: boolean; lines: number }>(`/connections/${connection.id}/config-snapshot`, { method: 'POST' }),
    onSuccess: () => {
      setErr(null);
      void qc.invalidateQueries({ queryKey: ['config-snapshots', connection.id] });
    },
    onError: (e) => setErr((e as Error).message),
  });
  const { data: diff } = useQuery({
    queryKey: ['config-diff', connection.id, diffB],
    queryFn: () =>
      api<{ lines: DiffLine[]; added: number; removed: number; a: { capturedAt: number } | null; b: { capturedAt: number } }>(
        `/connections/${connection.id}/config-diff?b=${diffB}`,
      ),
    enabled: Boolean(diffB),
  });

  async function viewRaw(id: string) {
    const s = await api<{ content: string }>(`/connections/${connection.id}/config-snapshots/${id}`);
    setRaw(s.content);
  }

  const list = data?.snapshots ?? [];

  return (
    <div className="overlay" onClick={onClose}>
      <div className="card modal" onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <h2>Config history — {connection.name}</h2>
          <button className="btn primary sm" disabled={snapshot.isPending} onClick={() => snapshot.mutate()}>
            {snapshot.isPending ? 'Capturing…' : 'Snapshot now'}
          </button>
        </div>
        <p className="muted small">
          {isWeb ? (
            <>
              Downloads <code>{data?.configCommand ?? 'the config backup URL'}</code> through the device's logged-in
              session. With <code>--web-config-snapshot-min</code> set, AnTerm snapshots on a schedule and alerts on
              drift.
            </>
          ) : (
            <>
              Runs <code>{data?.configCommand ?? 'show running-config'}</code> on the device. AnTerm also snapshots
              automatically when a session writes the config (<code>write mem</code>, <code>copy run start</code>).
            </>
          )}
        </p>
        {err && <div className="alert error">{err}</div>}
        {snapshot.data && (
          <div className="alert ok">
            Snapshot saved — {snapshot.data.lines} lines, {snapshot.data.changed ? 'changed from previous' : 'no change'}.
          </div>
        )}

        {!raw && !diffB && (
          <table className="table" style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>When</th>
                <th>By</th>
                <th>Lines</th>
                <th>Source</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((s, i) => (
                <tr key={s.id}>
                  <td className="small">
                    {when(s.capturedAt)} {s.changed && i < list.length - 1 && <Badge tone="warn">changed</Badge>}
                  </td>
                  <td className="small">{s.user ?? '—'}</td>
                  <td className="small mono">{s.lines}</td>
                  <td className="small muted">{s.reason}</td>
                  <td className="actions">
                    <button className="btn ghost sm" onClick={() => viewRaw(s.id)}>
                      View
                    </button>
                    {i < list.length - 1 && (
                      <button className="btn ghost sm" onClick={() => setDiffB(s.id)}>
                        Diff ↑
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {list.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted small">
                    No snapshots yet — hit “Snapshot now”.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}

        {raw && (
          <>
            <div className="row between" style={{ margin: '10px 0 4px' }}>
              <b className="small">Snapshot contents</b>
              <button className="btn ghost sm" onClick={() => setRaw(null)}>
                ← back
              </button>
            </div>
            <pre className="paste-preview" style={{ maxHeight: '55vh' }}>
              {raw}
            </pre>
          </>
        )}

        {diffB && (
          <>
            <div className="row between" style={{ margin: '10px 0 4px' }}>
              <b className="small">
                {diff ? (
                  <>
                    <Badge tone="up">+{diff.added}</Badge> <Badge tone="down">−{diff.removed}</Badge>{' '}
                    <span className="muted">
                      {diff.a ? when(diff.a.capturedAt) : 'initial'} → {when(diff.b.capturedAt)}
                    </span>
                  </>
                ) : (
                  'Diffing…'
                )}
              </b>
              <button className="btn ghost sm" onClick={() => setDiffB(null)}>
                ← back
              </button>
            </div>
            <pre className="config-diff">
              {(diff?.lines ?? []).map((l, i) => (
                <div key={i} className={`dl dl-${l.type === ' ' ? 'ctx' : l.type === '+' ? 'add' : l.type === '-' ? 'del' : 'gap'}`}>
                  {l.type === '@' ? l.text : `${l.type} ${l.text}`}
                </div>
              ))}
            </pre>
          </>
        )}

        <div className="row end" style={{ marginTop: 12 }}>
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
