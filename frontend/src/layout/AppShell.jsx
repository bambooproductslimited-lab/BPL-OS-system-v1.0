import { useState, useEffect } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { NAV_GROUPS, ALL_NAV_ITEMS } from './navModel';
import Icon from './navIcons';
import NotificationsBell from '../components/NotificationsBell';
import ErrorBoundary from '../components/ErrorBoundary';
import { THEME_KEY, getInitialTheme, applyTheme, clearTheme } from '../lib/theme';
import { installUnlock } from '../lib/notificationSound';
import './AppShell.css';

// Redesigned around the icon/avatar language established across every
// page: an icon per nav item (navModel.js's `icon` field, rendered via
// navIcons.jsx), an accent-tinted active state, an initials avatar for
// the signed-in user, and a matching icon badge on the page header.

const AVATAR_COLORS = ['#3f7d3b', '#2f5f2c', '#7d5c3f', '#3f5a7d', '#7d3f5c', '#5c3f7d', '#7d6b3f', '#3f7d6b'];
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return ((parts[0] ? parts[0][0] : '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function avatarColor(name) { return AVATAR_COLORS[hashStr(name || '') % AVATAR_COLORS.length]; }

// The dark, glowing-stat-tile redesign — piloted on Dashboard + Attendance
// first (see shell-main-dark in AppShell.css), then rolled out app-wide,
// and now user-toggleable via the header button below. It works app-wide
// with no per-page rewrite because it re-themes the *existing* design
// tokens locally: every shared class already built on top of them — .btn,
// .table, .dialog, .tag, .card, .input, .seg — re-themes for free. Pages
// outside this shell (the login screen, /pos, /kiosk) are untouched —
// they already have their own separate visual identity.

export default function AppShell() {
  const { session, logout, can } = useAuth();
  const location = useLocation();
  const [theme, setTheme] = useState(getInitialTheme);
  const isDarkPage = theme === 'dark';

  // The colours live on <html> so that html, body and the .shell grid are
  // themed too, not just what is inside <main> — see lib/theme.js for the
  // white-band bug that came of getting this wrong. Removed on unmount so
  // that logging out, or opening /pos or /kiosk, leaves those screens on
  // their own palette.
  useEffect(() => {
    applyTheme(theme);
    return clearTheme;
  }, [theme]);

  // Browsers won't let anything make a sound until the person has
  // interacted with the page. Arming that here, once, means the first
  // click or keypress of the session is what unlocks the notification
  // chime — see lib/notificationSound.js.
  useEffect(installUnlock, []);

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* storage blocked — theme just won't persist */ }
  }

  const currentKey = location.pathname.split('/')[1] || 'dashboard';
  const currentItem = ALL_NAV_ITEMS.find((item) => item.key === currentKey);
  const currentGroup = NAV_GROUPS.find((group) => group.items.some((item) => item.key === currentKey));

  const employee = session && session.employee;
  const employeeName = employee ? employee.firstName + ' ' + employee.lastName : '';
  const roleLine = session
    ? (session.roleNames || []).join(', ') + (employee ? ' · ' + employee.positionTitle : '')
    : '';

  async function handleLogout() {
    await logout();
  }

  return (
    <div className="shell">
      <aside className="shell-sidebar">
        <div className="shell-brand">
          <img src="/logo.png" alt="" className="shell-brand-logo" />
          <div className="shell-brand-text">
            <div className="shell-brand-name">Bamboo Products</div>
            <div className="shell-brand-sub">Company OS · Phase 1</div>
          </div>
        </div>

        <nav className="shell-nav">
          {NAV_GROUPS.map((group) => {
            const visibleItems = group.items.filter((item) => !item.perm || can(item.perm));
            if (!visibleItems.length) return null;
            return (
              <div className="shell-nav-group" key={group.label}>
                <div className="shell-nav-group-label">{group.label}</div>
                {visibleItems.map((item) => (
                  <NavLink
                    key={item.key}
                    to={'/' + item.key}
                    className={({ isActive }) => 'shell-nav-item' + (isActive ? ' is-active' : '')}
                    title={item.label}
                  >
                    <span className="shell-nav-icon"><Icon name={item.icon} /></span>
                    <span className="shell-nav-label">{item.label}</span>
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>

        <div className="shell-user">
          <div className="shell-user-row">
            <span className="shell-user-avatar" style={{ background: avatarColor(employeeName) }}>{initials(employeeName)}</span>
            <div className="shell-user-text">
              <div className="shell-user-name">{employeeName}</div>
              <div className="shell-user-role">{roleLine}</div>
            </div>
          </div>
          <button type="button" className="btn btn-secondary shell-signout" onClick={handleLogout}>
            Sign out
          </button>
        </div>
      </aside>

      <main className={'shell-main' + (isDarkPage ? ' shell-main-dark' : '')}>
        <header className="shell-header">
          <div className="shell-header-title-row">
            {currentItem && <span className="shell-header-icon"><Icon name={currentItem.icon} /></span>}
            <div>
              <div className="eyebrow">{currentGroup ? currentGroup.label : 'Bamboo OS'}</div>
              <h1 className="shell-header-title">{currentItem ? currentItem.label : 'Not found'}</h1>
            </div>
          </div>
          <div className="shell-header-actions">
            <button
              type="button"
              className="btn btn-secondary theme-toggle-btn"
              onClick={toggleTheme}
              aria-label={isDarkPage ? 'Switch to light mode' : 'Switch to dark mode'}
              title={isDarkPage ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              <span className="theme-toggle-icon"><Icon name={isDarkPage ? 'sun' : 'moon'} /></span>
            </button>
            <NotificationsBell />
          </div>
        </header>
        <div className="shell-content">
          {/* Keyed on the path so navigating away from a broken page clears
              the error instead of carrying it to the next one. */}
          <ErrorBoundary key={location.pathname} scope="this page">
            <Outlet />
          </ErrorBoundary>
        </div>
      </main>
    </div>
  );
}
