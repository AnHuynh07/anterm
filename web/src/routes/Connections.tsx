import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import type { AuthType, Connection, Credential } from '../types';
import { useAuth } from '../hooks/useAuth';
import { useTerminalTabs } from '../hooks/useTerminalTabs';
import { ConnectionForm, type ConnectionFormValue } from '../components/ConnectionForm';
import { QuickConnect } from '../components/QuickConnect';
import { ImportExport } from '../components/ImportExport';
import { ShareDialog } from '../components/ShareDialog';
import { Badge, type BadgeTone } from '../components/Badge';
import { COLOR_HEX } from '../components/colors';

type TestState = { ok: boolean; detail: string; pending?: boolean };
const authTone: Record<AuthType, BadgeTone> = { password: 'neutral', key: 'info', agent: 'warn' };
const UNGROUPED = ' ungrouped';

export function ConnectionsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { canWrite } = useAuth();
  const { openTab } = useTerminalTabs();
  const [editing, setEditing] = useState<Connection | 'new' | null>(null);
  const [sharing, setSharing] = useState<Connection | null>(null);
  const [testResult, setTestResult] = useState<Record<string, TestState>>({});
  const [query, setQuery] = useState('');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [showIO, setShowIO] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['connections'],
    queryFn: () => api<{ connections: Connection[] }>('/connections'),
  });
  const { data: serverInfo } = useQuery({
    queryKey: ['server-info'],
    queryFn: () => api<{ status: string; adhoc: boolean }>('/health'),
  });
  const { data: credData } = useQuery({
    queryKey: ['credentials'],
    queryFn: () => api<{ credentials: Credential[] }>('/credentials'),
  });

  const conns = useMemo(() => data?.connections ?? [], [data]);
  const allGroups = useMemo(
    () => [...new Set(conns.map((c) => c.groupName).filter((g): g is string => !!g))].sort(),
    [conns],
  );
  const allTags = useMemo(() => [...new Set(conns.flatMap((c) => c.tags))].sort(), [conns]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return conns.filter((c) => {
      if (tagFilter && !c.tags.includes(tagFilter)) return false;
      if (!q) return true;
      return [c.name, c.host, c.sshUsername, c.groupName ?? '', c.tags.join(' ')]
        .join(' ')
        .toLowerCase()
        .includes(q);
    });
  }, [conns, query, tagFilter]);

  const grouped = useMemo(() => {
    const m = new Map<string, Connection[]>();
    for (const c of filtered) {
      const k = c.groupName || UNGROUPED;
      const list = m.get(k);
      if (list) list.push(c);
      else m.set(k, [c]);
    }
    return [...m.entries()].sort(([a], [b]) => (a === UNGROUPED ? 1 : b === UNGROUPED ? -1 : a.localeCompare(b)));
  }, [filtered]);

  const save = useMutation({
    mutationFn: (value: ConnectionFormValue) => {
      const body = toBody(value);
      return editing && editing !== 'new'
        ? api(`/connections/${editing.id}`, { method: 'PUT', body })
        : api('/connections', { method: 'POST', body });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['connections'] });
      setEditing(null);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/connections/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connections'] }),
  });
  const test = useMutation({
    mutationFn: (id: string) => api<{ ok: boolean; detail: string }>(`/connections/${id}/test`, { method: 'POST' }),
    onMutate: (id) => setTestResult((r) => ({ ...r, [id]: { ok: false, detail: 'testing…', pending: true } })),
    onSuccess: (res, id) => setTestResult((r) => ({ ...r, [id]: { ok: res.ok, detail: res.detail } })),
    onError: (err, id) => setTestResult((r) => ({ ...r, [id]: { ok: false, detail: (err as Error).message } })),
  });

  function open(c: Connection) {
    openTab({ connectionId: c.id, title: c.name, color: c.color ?? undefined });
    navigate('/terminal');
  }

  return (
    <div className="page">
      <div className="row between">
        <h1>Connections</h1>
        <div className="row gap">
          <button className="btn ghost" onClick={() => setShowIO((s) => !s)}>
            Import / Export
          </button>
          {canWrite && (
            <button className="btn primary" onClick={() => setEditing('new')}>
              New connection
            </button>
          )}
        </div>
      </div>

      {showIO && <ImportExport onClose={() => setShowIO(false)} />}
      {serverInfo?.adhoc && <QuickConnect />}

      {conns.length > 0 && (
        <div className="filterbar">
          <input
            className="search"
            placeholder="Search name, host, tag…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {allTags.length > 0 && (
            <div className="chips">
              {allTags.map((t) => (
                <button
                  key={t}
                  className={`chip ${tagFilter === t ? 'on' : ''}`}
                  onClick={() => setTagFilter((cur) => (cur === t ? null : t))}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {isLoading && <p className="muted">Loading…</p>}
      {conns.length === 0 && !editing && !isLoading && (
        <p className="muted">
          {canWrite
            ? 'No saved connections yet. Create one to get started.'
            : 'No connections are shared with you yet.'}
        </p>
      )}
      {conns.length > 0 && filtered.length === 0 && <p className="muted">No connections match the filter.</p>}

      {grouped.map(([group, list]) => (
        <div key={group} className="conn-group">
          <div className="conn-group-head">
            {group === UNGROUPED ? 'Ungrouped' : group}
            <span className="muted small"> · {list.length}</span>
          </div>
          <table className="table">
            <tbody>
              {list.map((c) => {
                const t = testResult[c.id];
                const linkedCred = c.credentialId
                  ? credData?.credentials.find((k) => k.id === c.credentialId)
                  : undefined;
                const hasAutoLogin = Boolean(c.loginUsername || linkedCred?.loginUsername);
                const jumpName = c.jumpConnectionId
                  ? (conns.find((x) => x.id === c.jumpConnectionId)?.name ?? 'unknown')
                  : null;
                return (
                  <tr key={c.id} style={c.color ? { boxShadow: `inset 3px 0 0 ${COLOR_HEX[c.color]}` } : undefined}>
                    <td>
                      <div className="conn-name">{c.name}</div>
                      <div className="mono small muted">
                        {jumpName && <span title="jump host">↳ via {jumpName} · </span>}
                        {c.sshUsername}@{c.host}:{c.port}
                      </div>
                      {c.tags.length > 0 && (
                        <div className="tag-row">
                          {c.tags.map((tag) => (
                            <span key={tag} className="tag">
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td>
                      {linkedCred ? (
                        <Badge tone="info">{linkedCred.name}</Badge>
                      ) : (
                        <Badge tone={authTone[c.authType]}>{c.authType}</Badge>
                      )}
                      {hasAutoLogin && (
                        <div className="muted small" title="in-band login automation">
                          auto-login
                        </div>
                      )}
                      {c.relation === 'shared' && (
                        <div className="muted small" title={`shared by ${c.ownerName ?? 'owner'}`}>
                          shared{c.ownerName ? ` · ${c.ownerName}` : ''}
                        </div>
                      )}
                      {c.relation === 'admin' && c.ownerName && (
                        <div className="muted small">owner: {c.ownerName}</div>
                      )}
                    </td>
                    <td>
                      {t ? (
                        <>
                          <Badge tone={t.pending ? 'info' : t.ok ? 'up' : 'down'} dot>
                            {t.pending ? 'Testing' : t.ok ? 'Up' : 'Down'}
                          </Badge>
                          <div className="muted small">{t.detail}</div>
                        </>
                      ) : (
                        <span className="muted small">not tested</span>
                      )}
                    </td>
                    <td className="actions">
                      {c.canOpen !== false && (
                        <button className="btn primary sm" onClick={() => open(c)}>
                          Open
                        </button>
                      )}
                      {c.canOpen !== false && (
                        <button className="btn ghost sm" disabled={test.isPending} onClick={() => test.mutate(c.id)}>
                          Test
                        </button>
                      )}
                      {c.canEdit !== false && (
                        <button className="btn ghost sm" onClick={() => setEditing(c)}>
                          Edit
                        </button>
                      )}
                      {c.canShare && (
                        <button className="btn ghost sm" onClick={() => setSharing(c)}>
                          Share
                        </button>
                      )}
                      {c.canDelete && (
                        <button
                          className="btn danger sm"
                          onClick={() => {
                            if (confirm(`Delete connection "${c.name}"?`)) remove.mutate(c.id);
                          }}
                        >
                          Delete
                        </button>
                      )}
                      {c.canOpen === false && c.canEdit === false && (
                        <span className="muted small">read-only</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}

      {sharing && <ShareDialog connection={sharing} onClose={() => setSharing(null)} />}

      {editing && (
        <ConnectionForm
          initial={editing === 'new' ? undefined : editing}
          groups={allGroups}
          credentials={credData?.credentials ?? []}
          connections={conns}
          busy={save.isPending}
          error={save.error ? (save.error as Error).message : undefined}
          onCancel={() => setEditing(null)}
          onSubmit={(value) => save.mutate(value)}
        />
      )}
    </div>
  );
}

function toBody(value: ConnectionFormValue) {
  const base = {
    name: value.name.trim(),
    host: value.host.trim(),
    port: value.port,
    sshUsername: value.sshUsername.trim(),
    credentialId: value.credentialId || null,
    jumpConnectionId: value.jumpConnectionId || null,
    authType: value.authType as AuthType,
    initCommand: value.initCommand.trim() || null,
    loginUsername: value.loginUsername.trim() || null,
    setupCommands: value.setupCommands.trim() || null,
    groupName: value.groupName.trim() || null,
    tags: value.tags.trim() || null,
    color: value.color || null,
    antiIdleSeconds: Math.max(0, Math.floor(value.antiIdleSeconds || 0)),
  };
  // Only send passwords when the user actually typed something, so an edit that
  // leaves them blank keeps the stored values.
  const secret = value.secret.length ? value.secret : undefined;
  const passphrase = value.authType === 'key' && value.passphrase.length ? value.passphrase : undefined;
  const loginPassword = value.loginPassword.length ? value.loginPassword : undefined;
  // clearing the enable checkbox explicitly wipes the stored enable password
  const enablePassword = !value.enableMode ? null : value.enablePassword.length ? value.enablePassword : undefined;
  return { ...base, secret, passphrase, loginPassword, enablePassword };
}
