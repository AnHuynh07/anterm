import { FormEvent, useState } from 'react';
import type { AuthType, Connection, ConnectionColor, Credential } from '../types';
import { COLOR_LABEL } from './colors';

export interface ConnectionFormValue {
  name: string;
  host: string;
  port: number;
  sshUsername: string;
  credentialId: string;
  authType: AuthType;
  secret: string;
  passphrase: string;
  initCommand: string;
  // login automation
  loginUsername: string;
  loginPassword: string;
  enableMode: boolean;
  enablePassword: string;
  setupCommands: string;
  // organisation
  groupName: string;
  tags: string;
  color: ConnectionColor | '';
  antiIdleSeconds: number;
}

interface Props {
  initial?: Connection;
  groups?: string[];
  credentials?: Credential[];
  busy?: boolean;
  error?: string;
  onCancel: () => void;
  onSubmit: (value: ConnectionFormValue) => void;
}

export function ConnectionForm({ initial, groups = [], credentials = [], busy, error, onCancel, onSubmit }: Props) {
  const [v, setV] = useState<ConnectionFormValue>({
    name: initial?.name ?? '',
    host: initial?.host ?? '',
    port: initial?.port ?? 22,
    sshUsername: initial?.sshUsername ?? '',
    credentialId: initial?.credentialId ?? '',
    authType: initial?.authType ?? 'password',
    secret: '',
    passphrase: '',
    initCommand: initial?.initCommand ?? '',
    loginUsername: initial?.loginUsername ?? '',
    loginPassword: '',
    enableMode: initial?.hasEnablePassword ?? false,
    enablePassword: '',
    setupCommands: initial?.setupCommands ?? '',
    groupName: initial?.groupName ?? '',
    tags: initial?.tags.join(', ') ?? '',
    color: initial?.color ?? '',
    antiIdleSeconds: initial?.antiIdleSeconds ?? 0,
  });
  const editing = Boolean(initial);
  const [showAuto, setShowAuto] = useState(
    Boolean(initial?.loginUsername || initial?.hasLoginPassword || initial?.setupCommands),
  );
  const [showAdvanced, setShowAdvanced] = useState(false);

  const set = <K extends keyof ConnectionFormValue>(k: K, val: ConnectionFormValue[K]) =>
    setV((prev) => ({ ...prev, [k]: val }));

  const cred = credentials.find((c) => c.id === v.credentialId);
  const useVault = Boolean(cred);

  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit(v);
  }

  return (
    <form className="card form-panel" onSubmit={submit}>
      <h2>{editing ? `Edit “${initial?.name}”` : 'New connection'}</h2>
      <div className="grid2">
        <label>
          Name
          <input value={v.name} onChange={(e) => set('name', e.target.value)} required />
        </label>
        <label>
          SSH user{' '}
          {useVault && cred?.sshUsername && (
            <span className="muted small">(optional — credential uses “{cred.sshUsername}”)</span>
          )}
          <input
            value={v.sshUsername}
            onChange={(e) => set('sshUsername', e.target.value)}
            required={!useVault || !cred?.sshUsername}
            placeholder={useVault && cred?.sshUsername ? cred.sshUsername : ''}
          />
        </label>
        <label>
          Host
          <input value={v.host} onChange={(e) => set('host', e.target.value)} required />
        </label>
        <label>
          Port
          <input type="number" value={v.port} min={1} max={65535} onChange={(e) => set('port', Number(e.target.value))} />
        </label>
        {!useVault && (
          <label>
            Auth method
            <select value={v.authType} onChange={(e) => set('authType', e.target.value as AuthType)}>
              <option value="password">Password</option>
              <option value="key">Private key</option>
              <option value="agent">SSH agent (server-side)</option>
            </select>
          </label>
        )}
        <label>
          Group / folder
          <input
            value={v.groupName}
            onChange={(e) => set('groupName', e.target.value)}
            list="conn-groups"
            placeholder="e.g. Site A / Core"
          />
          <datalist id="conn-groups">
            {groups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </label>
        <label>
          Tags
          <input
            value={v.tags}
            onChange={(e) => set('tags', e.target.value)}
            placeholder="cisco, edge, prod"
          />
        </label>
        <label>
          Colour label
          <select value={v.color} onChange={(e) => set('color', e.target.value as ConnectionColor | '')}>
            <option value="">None</option>
            {(Object.keys(COLOR_LABEL) as ConnectionColor[]).map((c) => (
              <option key={c} value={c}>
                {COLOR_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        {credentials.length > 0 && (
          <label>
            Credentials
            <select value={v.credentialId} onChange={(e) => set('credentialId', e.target.value)}>
              <option value="">Inline — only this connection</option>
              {credentials.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {useVault && (
        <div className="alert ok" style={{ marginTop: 14 }}>
          Auth{cred?.loginUsername || cred?.setupCommands ? ' & login automation' : ''} provided by credential
          “{cred?.name}”. Manage it on the Credentials page.
        </div>
      )}

      {!useVault && v.authType === 'password' && (
        <label>
          SSH password {editing && <span className="muted small">(leave blank to keep current)</span>}
          <input type="password" value={v.secret} onChange={(e) => set('secret', e.target.value)} autoComplete="off" />
        </label>
      )}

      {!useVault && v.authType === 'key' && (
        <>
          <label>
            Private key (PEM) {editing && <span className="muted small">(leave blank to keep current)</span>}
            <textarea
              rows={6}
              className="mono"
              value={v.secret}
              onChange={(e) => set('secret', e.target.value)}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
            />
          </label>
          <label>
            Key passphrase (optional)
            <input
              type="password"
              value={v.passphrase}
              onChange={(e) => set('passphrase', e.target.value)}
              autoComplete="off"
            />
          </label>
        </>
      )}

      {/* ---- Login automation ---- */}
      {!useVault && (
      <div className="section">
        <button type="button" className="section-toggle" onClick={() => setShowAuto((s) => !s)}>
          {showAuto ? '▾' : '▸'} Login automation <span className="muted small">(network device AAA / enable)</span>
        </button>
        {showAuto && (
          <div className="section-body">
            <p className="muted small">
              After SSH connects, AnTerm answers the device’s in-terminal <code>Username:</code> / <code>Password:</code>{' '}
              prompts, then disengages. Leave blank if SSH logs you straight into a shell.
            </p>
            <div className="grid2">
              <label>
                Login username
                <input
                  value={v.loginUsername}
                  onChange={(e) => set('loginUsername', e.target.value)}
                  autoComplete="off"
                  placeholder={v.sshUsername || 'e.g. netadmin'}
                />
              </label>
              <label>
                Login password {editing && v.loginUsername && <span className="muted small">(blank = keep)</span>}
                <input
                  type="password"
                  value={v.loginPassword}
                  onChange={(e) => set('loginPassword', e.target.value)}
                  autoComplete="off"
                />
                {v.authType === 'password' && (
                  <button
                    type="button"
                    className="btn ghost sm"
                    style={{ marginTop: 4 }}
                    onClick={() => set('loginPassword', v.secret)}
                    disabled={!v.secret}
                  >
                    same as SSH password
                  </button>
                )}
              </label>
            </div>
            <label className="checkbox">
              <input type="checkbox" checked={v.enableMode} onChange={(e) => set('enableMode', e.target.checked)} />
              Enter enable / privileged mode
            </label>
            {v.enableMode && (
              <label>
                Enable password {editing && initial?.hasEnablePassword && <span className="muted small">(blank = keep)</span>}
                <input
                  type="password"
                  value={v.enablePassword}
                  onChange={(e) => set('enablePassword', e.target.value)}
                  autoComplete="off"
                />
              </label>
            )}
            <label>
              Setup commands <span className="muted small">(one per line, run after login)</span>
              <textarea
                rows={3}
                className="mono"
                value={v.setupCommands}
                onChange={(e) => set('setupCommands', e.target.value)}
                placeholder={'terminal length 0\nterminal width 0'}
              />
            </label>
          </div>
        )}
      </div>
      )}

      {/* ---- Advanced ---- */}
      <div className="section">
        <button type="button" className="section-toggle" onClick={() => setShowAdvanced((s) => !s)}>
          {showAdvanced ? '▾' : '▸'} Advanced
        </button>
        {showAdvanced && (
          <div className="section-body">
            <label>
              Run a single command (exec mode) <span className="muted small">— instead of an interactive shell</span>
              <input value={v.initCommand} onChange={(e) => set('initCommand', e.target.value)} placeholder="e.g. show tech-support" />
            </label>
            <label>
              Anti-idle keepalive <span className="muted small">— send a null byte every N seconds of silence (0 = off)</span>
              <input
                type="number"
                min={0}
                max={3600}
                value={v.antiIdleSeconds}
                onChange={(e) => set('antiIdleSeconds', Number(e.target.value))}
              />
            </label>
          </div>
        )}
      </div>

      {error && <div className="alert error">{error}</div>}

      <div className="row end gap">
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
