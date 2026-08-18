import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { getMe, getToken, login as apiLogin, logout as apiLogout, setToken } from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);

  // Rehydrate the session on load if a token is already stored — mirrors
  // kernel.js's session() lookup on boot, but via a real /api/me round trip
  // instead of reading localStorage directly.
  useEffect(() => {
    let cancelled = false;
    async function rehydrate() {
      if (!getToken()) { setLoading(false); return; }
      try {
        const me = await getMe();
        if (!cancelled) setSession(me);
      } catch {
        setToken(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    rehydrate();
    return () => { cancelled = true; };
  }, []);

  const login = useCallback(async (email, password) => {
    const result = await apiLogin(email, password);
    setToken(result.token);
    setSession(result.session);
    return result.session;
  }, []);

  const logout = useCallback(async () => {
    try { await apiLogout(); } catch { /* token may already be invalid — clear locally regardless */ }
    setToken(null);
    setSession(null);
  }, []);

  const can = useCallback((permission) => {
    return !!(session && session.permissions && session.permissions.indexOf(permission) >= 0);
  }, [session]);

  const value = useMemo(
    () => ({ session, loading, login, logout, can }),
    [session, loading, login, logout, can]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
