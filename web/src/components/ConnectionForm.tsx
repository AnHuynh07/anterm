import { FormEvent, useState } from 'react';
import type { AuthType, Connection, ConnectionColor, Credential, Protocol, WebAuthMode } from '../types';
import { COLOR_LABEL } from './colors';

export interface ConnectionFormValue {
  name: string;
  host: string;
  port: number;
  protocol: Protocol;
  // web-managed device (protocol 'http')
  webUrl: string;
  webAuthMode: WebAuthMode;
  webUsername: string;
  webPassword: string;
  webInsecureTls: boolean;
  sshUsername: string;
  credentialId: string;
  jumpConnectionId: string;
  authType: AuthType;
  secret: string;
  passphrase: string;
  initCommand: string;
  configCommand: string;
  // login automation
  loginUsername: string;
  loginPassword: string;
  enableMode: boolean;
  enablePassword: string;
  setupCommands: string;
  runbook: string;
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
  connections?: Connection[];
  allowTelnet?: boolean;
  allowWebProxy?: boolean;
  busy?: boolean;
  error?: string;
  onCancel: () => void;
  onSubmit: (value: ConnectionFormValue) => void;
}

export function ConnectionForm({
  initial,
  groups = [],
  credentials = [],
  connections = [],
  allowTelnet = false,
  allowWebProxy = false,
  busy,
  error,
  onCancel,
  onSubmit,
}: Props) {
  const [v, setV] = useState<ConnectionFormValue>({
    name: initial?.name ?? '',
    host: initial?.host ?? '',
    port: initial?.port ?? 22,
    protocol: initial?.protocol ?? 'ssh',
    webUrl: initial?.web?.url ?? '',
    webAuthMode: initial?.web?.authMode ?? 'form',
    webUsername: initial?.web?.username ?? '',
    webPassword: '',
    webInsecureTls: initial?.web?.insecureTls ?? false,
    sshUsername: initial?.sshUsername ?? '',
    credentialId: initial?.credentialId ?? '',
    jumpConnectionId: initial?.jumpConnectionId ?? '',
    authType: initial?.authType ?? 'password',
    configCommand: initial?.configCommand ?? '',
    secret: '',
    passphrase: '',
    initCommand: initial?.initCommand ?? '',
    loginUsername: initial?.loginUsername ?? '',
    loginPassword: '',
    enableMode: initial?.hasEnablePassword ?? false,
    enablePassword: '',
    setupCommands: initial?.setupCommands ?? '',
    runbook: initial?.runbook ?? '',
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

  const telnet = v.protocol === 'telnet';
  const web = v.protocol === 'http';
  const DEFAULT_PORT: Record<Protocol, number> = { ssh: 22, telnet: 23, http: 443 };
  const setProtocol = (p: Protocol) =>
    setV((prev) => ({
      ...prev,
      protocol: p,
      // nudge the port to the well-known default if it's still on another one
      port: (Object.values(DEFAULT_PORT) as number[]).includes(prev.port) ? DEFAULT_PORT[p] : prev.port,
    }));

  const cred = credentials.find((c) => c.id === v.credentialId);
  const useVault = Boolean(cred) && !telnet && !web;
  const showProtocol =
    allowTelnet || allowWebProxy || initial?.protocol === 'telnet' || initial?.protocol === 'http';

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
        {showProtocol && (
          <label>
            Protocol
            <select value={v.protocol} onChange={(e) => setProtocol(e.target.value as Protocol)}>
              <option value="ssh">SSH</option>
              <option value="telnet">Telnet (plaintext)</option>
              {(allowWebProxy || initial?.protocol === 'http') && <option value="http">Web GUI (HTTP proxy)</option>}
            </select>
          </label>
        )}
        {!web && (
          <label>
            {telnet ? 'Login user' : 'SSH user'}{' '}
            {telnet ? (
              <span className="muted small">(optional — usually handled by login automation)</span>
            ) : (
              useVault &&
              cred?.sshUsername && <span className="muted small">(optional — credential uses “{cred.sshUsername}”)</span>
            )}
            <input
              value={v.sshUsername}
              onChange={(e) => set('sshUsername', e.target.value)}
              required={!telnet && (!useVault || !cred?.sshUsername)}
              placeholder={useVault && cred?.sshUsername ? cred.sshUsername : ''}
            />
          </label>
        )}
        <label>
          Host {web && <span className="muted small">(for the reachability probe)</span>}
          <input value={v.host} onChange={(e) => set('host', e.target.value)} required />
        </label>
        {!web && (
          <label>
            Port
            <input type="number" value={v.port} min={1} max={65535} onChange={(e) => set('port', Number(e.target.value))} />
          </label>
        )}
        {!useVault && !telnet && !web && (
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
        {credentials.length > 0 && !telnet && !web && (
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

      {telnet && (
        <div className="alert error" style={{ marginTop: 14 }}>
          <strong>Telnet is unencrypted.</strong> Everything typed on this session — including any password entered at
          the device’s login prompt — crosses the network in clear text, and the device’s identity cannot be verified.
          Use it only on a trusted management network.
        </div>
      )}

      {web && (
        <div className="section-body" style={{ marginTop: 4 }}>
          <p className="muted small">
            AnTerm reverse-proxies the device’s web GUI: it signs you in with the stored credentials and frames the
            page inside AnTerm. No SSH/CLI needed.
          </p>
          <label>
            Web UI URL
            <input
              value={v.webUrl}
              onChange={(e) => set('webUrl', e.target.value)}
              placeholder="http://10.195.32.34/"
              required
            />
          </label>
          <div className="grid2">
            <label>
              Sign-in
              <select value={v.webAuthMode} onChange={(e) => set('webAuthMode', e.target.value as WebAuthMode)}>
                <option value="form">Login form (POST)</option>
                <option value="basic">HTTP Basic</option>
                <option value="none">No login</option>
              </select>
            </label>
            <label>
              Username
              <input value={v.webUsername} onChange={(e) => set('webUsername', e.target.value)} autoComplete="off" />
            </label>
          </div>
          {v.webAuthMode !== 'none' && (
            <label>
              Password {editing && <span className="muted small">(leave blank to keep current)</span>}
              <input
                type="password"
                value={v.webPassword}
                onChange={(e) => set('webPassword', e.target.value)}
                autoComplete="off"
              />
            </label>
          )}
          <label className="checkbox">
            <input
              type="checkbox"
              checked={v.webInsecureTls}
              onChange={(e) => set('webInsecureTls', e.target.checked)}
            />
            Accept a self-signed HTTPS certificate
          </label>
          <p className="muted small">
            Login form fields default to Allied Telesis (<code>/iss/redirect.html</code>, <code>Login</code> /{' '}
            <code>Password</code>). Change them on the device’s API if needed later.
          </p>
        </div>
      )}

      {useVault && (
        <div className="alert ok" style={{ marginTop: 14 }}>
          Auth{cred?.loginUsername || cred?.setupCommands ? ' & login automation' : ''} provided by credential
          “{cred?.name}”. Manage it on the Credentials page.
        </div>
      )}

      {!useVault && !telnet && !web && v.authType === 'password' && (
        <label>
          SSH password {editing && <span className="muted small">(leave blank to keep current)</span>}
          <input type="password" value={v.secret} onChange={(e) => set('secret', e.target.value)} autoComplete="off" />
        </label>
      )}

      {!useVault && !telnet && !web && v.authType === 'key' && (
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
      {!useVault && !web && (
      <div className="section">
        <button type="button" className="section-toggle" onClick={() => setShowAuto((s) => !s)}>
          {showAuto ? '▾' : '▸'} Login automation <span className="muted small">(network device AAA / enable)</span>
        </button>
        {showAuto && (
          <div className="section-body">
            <p className="muted small">
              Once connected, AnTerm answers the device’s in-terminal <code>Username:</code> / <code>Password:</code>{' '}
              prompts, then disengages. {telnet ? 'This is the usual way to log a Telnet device in.' : 'Leave blank if SSH logs you straight into a shell.'}
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
            {!web && connections.filter((c) => c.id !== initial?.id).length > 0 && (
              <label>
                Connect through (jump host){' '}
                <span className="muted small">— tunnel via another saved connection (ProxyJump)</span>
                <select value={v.jumpConnectionId} onChange={(e) => set('jumpConnectionId', e.target.value)}>
                  <option value="">Direct — no jump host</option>
                  {connections
                    .filter((c) => c.id !== initial?.id)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.host})
                      </option>
                    ))}
                </select>
              </label>
            )}
            {!telnet && !web && (
              <label>
                Run a single command (exec mode) <span className="muted small">— instead of an interactive shell</span>
                <input value={v.initCommand} onChange={(e) => set('initCommand', e.target.value)} placeholder="e.g. show tech-support" />
              </label>
            )}
            {!telnet && !web && (
              <label>
                Config snapshot command <span className="muted small">— what “Config history” dumps &amp; diffs</span>
                <input
                  value={v.configCommand}
                  onChange={(e) => set('configCommand', e.target.value)}
                  placeholder="show running-config"
                />
              </label>
            )}
            {!web && (
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
            )}
            <label>
              Runbook <span className="muted small">— markdown notes shown beside the {web ? 'device' : 'terminal'} (console location, reboot time, gotchas…)</span>
              <textarea
                rows={6}
                value={v.runbook}
                onChange={(e) => set('runbook', e.target.value)}
                placeholder={'## Reboot\n- Console is in **rack 3**, port 12\n- `reload` takes ~4 min to come back\n- On-call: [runbook wiki](https://wiki.example.com/core-sw)'}
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
