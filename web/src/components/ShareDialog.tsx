import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { Connection, ConnectionShareEntry, PickableUser } from '../types';
import { useAuth } from '../hooks/useAuth';

interface Row {
  userId: string;
  username: string;
  enabled: boolean;
  canEdit: boolean;
}

export function ShareDialog({ connection, onClose }: { connection: Connection; onClose: () => void }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [rows, setRows] = useState<Row[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const { data: pickable } = useQuery({
    queryKey: ['users-pickable'],
    queryFn: () => api<{ users: PickableUser[] }>('/users/pickable'),
  });
  const { data: current } = useQuery({
    queryKey: ['shares', connection.id],
    queryFn: () => api<{ shares: ConnectionShareEntry[] }>(`/connections/${connection.id}/shares`),
  });

  useEffect(() => {
    if (!pickable) return;
    const shared = new Map((current?.shares ?? []).map((s) => [s.userId, s.canEdit]));
    setRows(
      pickable.users
        .filter((u) => u.id !== user?.id && u.id !== connection.ownerId)
        .map((u) => ({
          userId: u.id,
          username: u.username,
          enabled: shared.has(u.id),
          canEdit: shared.get(u.id) ?? false,
        })),
    );
  }, [pickable, current, user?.id, connection.ownerId]);

  const save = useMutation({
    mutationFn: () =>
      api(`/connections/${connection.id}/shares`, {
        method: 'PUT',
        body: { shares: rows.filter((r) => r.enabled).map((r) => ({ userId: r.userId, canEdit: r.canEdit })) },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['connections'] });
      onClose();
    },
    onError: (e) => setErr((e as Error).message),
  });

  const patch = (userId: string, p: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.userId === userId ? { ...r, ...p } : r)));

  return (
    <div className="overlay" onClick={onClose}>
      <div className="card hostkey" onClick={(e) => e.stopPropagation()}>
        <h2>Share “{connection.name}”</h2>
        <p className="muted small">
          Shared users can open a session on this device. Tick <b>edit</b> to also let them change its settings.
          Stored credentials are never revealed.
        </p>
        {err && <div className="alert error">{err}</div>}

        <div style={{ maxHeight: 320, overflowY: 'auto', margin: '10px 0' }}>
          {rows.length === 0 && <p className="muted small">No other users to share with.</p>}
          {rows.map((r) => (
            <div key={r.userId} className="row between" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <label className="checkbox" style={{ margin: 0 }}>
                <input type="checkbox" checked={r.enabled} onChange={(e) => patch(r.userId, { enabled: e.target.checked })} />
                {r.username}
              </label>
              <label className="checkbox" style={{ margin: 0, opacity: r.enabled ? 1 : 0.4 }}>
                <input
                  type="checkbox"
                  disabled={!r.enabled}
                  checked={r.canEdit}
                  onChange={(e) => patch(r.userId, { canEdit: e.target.checked })}
                />
                edit
              </label>
            </div>
          ))}
        </div>

        <div className="row end gap">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save sharing'}
          </button>
        </div>
      </div>
    </div>
  );
}
