import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTerminalTabs } from '../hooks/useTerminalTabs';

/**
 * WeTTY-style ad-hoc connect, shown only when the server enables ad-hoc mode
 * (`--ssh-host`). With all fields blank it uses the server's configured
 * defaults (or a local shell); fill them in to override the target.
 */
export function QuickConnect() {
  const navigate = useNavigate();
  const { openTab } = useTerminalTabs();
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState('');
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  function go(e: FormEvent) {
    e.preventDefault();
    const useAdhoc = host.trim() && username.trim();
    openTab({
      title: useAdhoc ? `${username}@${host}` : 'ad-hoc session',
      adhoc: useAdhoc
        ? { host: host.trim(), port, username: username.trim(), password: password || undefined }
        : undefined,
    });
    navigate('/terminal');
  }

  return (
    <form className="card" onSubmit={go}>
      <div className="row between">
        <h2>Quick connect</h2>
        <button type="button" className="btn ghost sm" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide options' : 'Custom target'}
        </button>
      </div>
      <p className="muted small">Ad-hoc mode is enabled. Connect using the server defaults, or specify a target.</p>
      {open && (
        <div className="grid2">
          <label>
            Host
            <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="server defaults" />
          </label>
          <label>
            Port
            <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} />
          </label>
          <label>
            User
            <input value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
          </label>
        </div>
      )}
      <div className="row end">
        <button className="btn primary">Open session</button>
      </div>
    </form>
  );
}
