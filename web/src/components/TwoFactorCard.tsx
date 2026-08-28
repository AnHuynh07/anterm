import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import qrcode from 'qrcode-generator';
import { api } from '../lib/api';
import { useAuth } from '../hooks/useAuth';

function qrDataUri(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createDataURL(4, 12);
}

export function TwoFactorCard() {
  const { user, refresh } = useAuth();
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [pwd, setPwd] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const begin = useMutation({
    mutationFn: () => api<{ secret: string; otpauthUri: string }>('/auth/2fa/setup', { method: 'POST' }),
    onSuccess: (d) => {
      setErr(null);
      setSetup(d);
    },
    onError: (e) => setErr((e as Error).message),
  });
  const enable = useMutation({
    mutationFn: () => api<{ recoveryCodes: string[] }>('/auth/2fa/enable', { method: 'POST', body: { code: code.trim() } }),
    onSuccess: (d) => {
      setErr(null);
      setSetup(null);
      setCode('');
      setRecovery(d.recoveryCodes);
      void refresh();
    },
    onError: (e) => setErr((e as Error).message),
  });
  const disable = useMutation({
    mutationFn: () => api('/auth/2fa/disable', { method: 'POST', body: { password: pwd } }),
    onSuccess: () => {
      setErr(null);
      setPwd('');
      setRecovery(null);
      void refresh();
    },
    onError: (e) => setErr((e as Error).message),
  });

  return (
    <div className="card">
      <h2>Two-factor authentication</h2>
      <p className="muted small">
        A time-based one-time code (TOTP) on top of your password. Works with Google Authenticator, Authy, 1Password, etc.
      </p>
      {err && <div className="alert error">{err}</div>}

      {recovery && (
        <div className="alert ok" style={{ display: 'block' }}>
          <b>Save your recovery codes</b> — each works once if you lose your device. This is the only time they’re shown.
          <div className="recovery-grid">
            {recovery.map((c) => (
              <code key={c}>{c}</code>
            ))}
          </div>
        </div>
      )}

      {user?.totpEnabled && !setup ? (
        <>
          <p>
            <span className="badge badge-up">On</span> Your account is protected by 2FA.
          </p>
          <div className="grid2" style={{ marginTop: 6 }}>
            <label>
              Confirm your password to turn it off
              <input type="password" value={pwd} onChange={(e) => setPwd(e.target.value)} autoComplete="off" />
            </label>
          </div>
          <div className="row end" style={{ marginTop: 10 }}>
            <button className="btn danger" disabled={disable.isPending || !pwd} onClick={() => disable.mutate()}>
              Disable 2FA
            </button>
          </div>
        </>
      ) : setup ? (
        <>
          <p className="muted small">
            Scan this with your authenticator app, or enter the key manually, then type the current 6-digit code.
          </p>
          <div className="totp-setup">
            <img src={qrDataUri(setup.otpauthUri)} alt="TOTP QR code" width={180} height={180} />
            <div>
              <div className="muted small">Setup key</div>
              <code className="totp-key">{setup.secret}</code>
              <label>
                Current code
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  inputMode="numeric"
                  placeholder="123456"
                  autoComplete="off"
                />
              </label>
              <div className="row gap" style={{ marginTop: 8 }}>
                <button className="btn primary" disabled={enable.isPending || code.trim().length < 6} onClick={() => enable.mutate()}>
                  {enable.isPending ? 'Verifying…' : 'Enable'}
                </button>
                <button className="btn ghost" onClick={() => setSetup(null)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className="row end">
          <button className="btn" disabled={begin.isPending} onClick={() => begin.mutate()}>
            Set up 2FA
          </button>
        </div>
      )}
    </div>
  );
}
