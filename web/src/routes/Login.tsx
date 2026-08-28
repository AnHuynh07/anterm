import { FormEvent, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

// Dev convenience: prefill credentials so you don't retype them during local
// work. Stripped from production builds. Override via VITE_DEV_USER /
// VITE_DEV_PASSWORD (e.g. in web/.env.local).
const DEV_USER = import.meta.env.DEV ? (import.meta.env.VITE_DEV_USER ?? 'admin') : '';
const DEV_PASSWORD = import.meta.env.DEV ? (import.meta.env.VITE_DEV_PASSWORD ?? 'changeme') : '';

export function LoginPage() {
  const { user, login, loginMfa } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState(DEV_USER);
  const [password, setPassword] = useState(DEV_PASSWORD);
  const [ticket, setTicket] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  const from = (location.state as { from?: string } | null)?.from ?? '/';

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (ticket) {
        await loginMfa(ticket, code.trim());
        navigate(from, { replace: true });
      } else {
        const res = await login(username.trim(), password);
        if (res?.mfaTicket) {
          setTicket(res.mfaTicket);
          setCode('');
        } else {
          navigate(from, { replace: true });
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-screen">
      <form className="card login-card" onSubmit={onSubmit}>
        <h1>
          <span className="brand-mark">❯_</span>
          AnTerm
        </h1>

        {ticket ? (
          <>
            <p className="muted">Enter the 6-digit code from your authenticator app.</p>
            <label>
              Authentication code
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoFocus
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
              />
            </label>
            <p className="muted small">Lost your device? Enter one of your recovery codes instead.</p>
            {error && <div className="alert error">{error}</div>}
            <div className="row gap" style={{ marginTop: 4 }}>
              <button className="btn primary" disabled={busy || code.trim().length < 6}>
                {busy ? 'Verifying…' : 'Verify'}
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  setTicket(null);
                  setError(null);
                }}
              >
                Back
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="muted">Sign in to open SSH sessions</p>
            {import.meta.env.DEV && DEV_USER && (
              <p className="muted small">Dev credentials prefilled — set VITE_DEV_USER/PASSWORD to change.</p>
            )}
            <label>
              Username
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
            </label>
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </label>
            {error && <div className="alert error">{error}</div>}
            <button className="btn primary" disabled={busy || !username || !password}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
