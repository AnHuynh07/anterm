import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api';
import type { AuthUser } from '../types';

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  isAdmin: boolean;
  /** admin or operator — may create/edit and open sessions */
  canWrite: boolean;
  /** resolves to a ticket when the account has 2FA, else completes the login */
  login: (username: string, password: string) => Promise<{ mfaTicket: string } | void>;
  loginMfa: (ticket: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await api<{ user: AuthUser }>('/auth/me');
      setUser(res.user);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (username: string, password: string) => {
    const res = await api<{ user?: AuthUser; mfaRequired?: boolean; ticket?: string }>('/auth/login', {
      method: 'POST',
      body: { username, password },
    });
    if (res.mfaRequired && res.ticket) return { mfaTicket: res.ticket };
    if (res.user) setUser(res.user);
  }, []);

  const loginMfa = useCallback(async (ticket: string, code: string) => {
    const res = await api<{ user: AuthUser }>('/auth/login/2fa', { method: 'POST', body: { ticket, code } });
    setUser(res.user);
  }, []);

  const logout = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' });
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({
      user,
      loading,
      isAdmin: user?.role === 'admin',
      canWrite: user?.role === 'admin' || user?.role === 'operator',
      login,
      loginMfa,
      logout,
      refresh,
    }),
    [user, loading, login, loginMfa, logout, refresh],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
