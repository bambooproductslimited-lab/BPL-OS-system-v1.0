import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { getMe, getToken, login as apiLogin, verifyLogin as apiVerifyLogin, logout as apiLogout, setToken } from '../api/client';

// "Don't ask again on this device" for two-step sign-in: a token per email,
// kept in this browser only. Storage can be unavailable (private windows);
// then the code is simply asked for each time.
const DEVICE_KEY = 'bos.twoStepDevice.';
function readDeviceToken(email) {
  try { return localStorage.getItem(DEVICE_KEY + String(email || '').trim().toLowerCase()) || null; } catch { return null; }
}
function writeDeviceToken(email, token) {
  try { localStorage.setItem(DEVICE_KEY + String(email || '').trim().toLowerCase(), token); } catch { /* not remembered — fine */ }
}
import { adoptLocale } from '../lib/i18n.jsx';

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
        // The language belongs to the person, so the value on their row
        // wins whenever a session arrives — that is what makes the choice
        // follow them from a desk to a shop-floor tablet. Doing it here,
        // once per sign-in, rather than in a component below I18nProvider,
        // is deliberate: down there it re-ran on every language switch and
        // immediately undid the switch. See lib/i18n.jsx's adoptLocale.
        if (!cancelled) { adoptLocale(me.locale); setSession(me); }
      } catch {
        setToken(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    rehydrate();
    return () => { cancelled = true; };
  }, []);

  const startSession = useCallback((result) => {
    setToken(result.token);
    adoptLocale(result.session.locale); // same reasoning as the rehydrate above
    setSession(result.session);
    return result.session;
  }, []);

  // Returns the session, or { twoStepRequired, challenge } for an account
  // with two-step sign-in on — then verifyCode() finishes signing in.
  const login = useCallback(async (email, password) => {
    const result = await apiLogin(email, password, readDeviceToken(email));
    if (result.twoStepRequired) return result;
    return startSession(result);
  }, [startSession]);

  const verifyCode = useCallback(async (email, challenge, code, rememberDevice) => {
    const result = await apiVerifyLogin(challenge, code, rememberDevice);
    if (result.deviceToken) writeDeviceToken(email, result.deviceToken);
    return startSession(result);
  }, [startSession]);

  const logout = useCallback(async () => {
    try { await apiLogout(); } catch { /* token may already be invalid — clear locally regardless */ }
    setToken(null);
    setSession(null);
  }, []);

  // Re-fetches /api/me and replaces the in-memory session — used after a
  // forced password change so mustChangePassword flips to false without
  // requiring the user to log in again.
  const refreshSession = useCallback(async () => {
    const me = await getMe();
    setSession(me);
    return me;
  }, []);

  const can = useCallback((permission) => {
    return !!(session && session.permissions && session.permissions.indexOf(permission) >= 0);
  }, [session]);

  const value = useMemo(
    () => ({ session, loading, login, verifyCode, logout, can, refreshSession }),
    [session, loading, login, verifyCode, logout, can, refreshSession]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
