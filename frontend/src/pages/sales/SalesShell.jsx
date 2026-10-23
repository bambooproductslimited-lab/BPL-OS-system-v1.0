import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import Icon from '../../layout/navIcons';
import NotificationsBell from '../../components/NotificationsBell';
import LanguagePicker from '../../components/LanguagePicker';
import ErrorBoundary from '../../components/ErrorBoundary';
import { FollowUpsAtSignIn } from '../crm/FollowUps';
import { FileViewerHost } from '../../components/FileViewer';
import { CallsProvider } from '../../components/calls/CallsContext';
import { getInitialTheme, applyTheme, clearTheme, saveTheme } from '../../lib/theme';
import ThemeSwitch, { ThemeChoice } from '../../components/ThemeSwitch';
import { installUnlock } from '../../lib/notificationSound';
import { activeIntlLocale, msg, tr } from '../../lib/i18n.jsx';
import { OS_URL, SALES_GROUPS, SALES_ITEMS, TABS, allowed } from './salesNav';
import '../../layout/AppShell.css';
import './SalesShell.css';

// The sales app's frame (SalesApp.jsx): on a computer, a sidebar of the
// rep's pages — My day, Pipeline, Results — with who is signed in, the
// way to the full OS and Sign out; on a phone, a bar of four tabs at the
// bottom (board, inbox, leads, customers) and More for the rest, the
// look, the language and Sign out. The theme, the notifications, calls,
// the follow-ups at sign-in and the file viewer are the OS's own
// (layout/AppShell.jsx), so the pages behave exactly as they do there.

// Shorter names for the tab bar, where there is room for a word or two.
const SHORT = { crmboard: msg('Board'), crminbox: msg('Messages'), crmleads: msg('Leads'), crmcustomers: msg('Customers') };
const COLORS = ['#16a34a', '#0d9488', '#2563eb', '#7c3aed', '#db2777', '#ea580c', '#ca8a04', '#0891b2'];
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return ((parts[0] ? parts[0][0] : '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
function colorOf(name) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return COLORS[Math.abs(h) % COLORS.length];
}
function today() {
  try { return new Date().toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long' }); } catch { return new Date().toDateString(); }
}

function Dots() {
  return <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="6" cy="6" r="2" /><circle cx="12" cy="6" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="6" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="18" cy="12" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="12" cy="18" r="2" /><circle cx="18" cy="18" r="2" /></svg>;
}
function Out() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>;
}

function Brand() {
  return (
    <div className="sa-brand">
      <span className="sa-brand-logo"><img src="/logo.png" alt="" /></span>
      <span className="sa-brand-text">
        <b>Bamboo <em>Sales</em></b>
        <small>{tr('Sales & CRM')}</small>
      </span>
    </div>
  );
}

function Who({ name, role }) {
  return (
    <div className="sa-who">
      <span className="sa-avatar" style={{ '--av': colorOf(name) }}>{initials(name)}</span>
      <span className="sa-who-text"><b>{name}</b><small>{role}</small></span>
    </div>
  );
}

// Everything on a phone that is not one of the four tabs.
function More({ items, theme, onTheme, onClose, onSignOut, name, role }) {
  useEffect(() => {
    function key(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div className="sa-sheet-wrap" role="presentation" onClick={onClose}>
      <div className="sa-sheet" role="dialog" aria-modal="true" aria-label={tr('More')} onClick={(e) => e.stopPropagation()}>
        <span className="sa-sheet-grip" aria-hidden="true" />
        <Who name={name} role={role} />
        <div className="sa-sheet-grid">
          {items.map((item, i) => (
            <NavLink key={item.key} to={'/' + item.key} onClick={onClose} style={{ '--i': i }}
              className={({ isActive }) => 'sa-tile' + (isActive ? ' is-on' : '')}>
              <span className="sa-tile-icon"><Icon name={item.icon} /></span>
              <span>{tr(item.label)}</span>
            </NavLink>
          ))}
        </div>
        <div className="sa-sheet-row">
          <span className="sa-sheet-label">{tr('Appearance')}</span>
          <ThemeChoice theme={theme} onChange={onTheme} compact />
        </div>
        <div className="sa-sheet-row">
          <span className="sa-sheet-label">{tr('Language')}</span>
          <LanguagePicker />
        </div>
        <div className="sa-sheet-actions">
          <a className="btn btn-secondary" href={OS_URL + '/dashboard'} target="_blank" rel="noopener noreferrer"><Out /> {tr('Open the full OS')}</a>
          <button type="button" className="btn btn-secondary sa-sheet-out" onClick={onSignOut}>{tr('Sign out')}</button>
        </div>
      </div>
    </div>
  );
}

export default function SalesShell() {
  const { session, logout, can } = useAuth();
  const location = useLocation();
  const [theme, setTheme] = useState(getInitialTheme);
  const [more, setMore] = useState(false);

  // As in the OS: the look lives on <html> while the app is open.
  useEffect(() => {
    applyTheme(theme);
    return clearTheme;
  }, [theme]);
  useEffect(installUnlock, []);
  useEffect(() => { setMore(false); }, [location.pathname]);

  function pickTheme(next) {
    setTheme(next);
    saveTheme(next);
  }

  const employee = session && session.employee;
  const name = employee ? employee.firstName + ' ' + employee.lastName : '';
  const role = session ? ((employee && employee.positionTitle) || (session.roleNames || []).join(', ')) : '';
  const groups = SALES_GROUPS.map((g) => ({ ...g, items: g.items.filter((item) => allowed(item, can)) })).filter((g) => g.items.length);
  const mine = SALES_ITEMS.filter((item) => allowed(item, can));
  const tabs = TABS.map((k) => mine.find((item) => item.key === k)).filter(Boolean);
  const rest = mine.filter((item) => !TABS.includes(item.key));
  const key = location.pathname.split('/')[1];
  const current = SALES_ITEMS.find((item) => item.key === key);
  const group = SALES_GROUPS.find((g) => g.items.some((item) => item.key === key));
  const inMore = rest.some((item) => item.key === key);

  return (
    <CallsProvider>
      <div className={'sa is-' + theme}>
        <aside className="sa-side">
          <Brand />
          <div className="sa-today">
            <span className="sa-today-dot" aria-hidden="true" />
            <span>{today()}</span>
          </div>
          <nav className="sa-nav" aria-label={tr('Sales')}>
            {groups.map((g) => (
              <div className="sa-nav-group" key={g.label}>
                <div className="sa-nav-label">{tr(g.label)}</div>
                {g.items.map((item) => (
                  <NavLink key={item.key} to={'/' + item.key} title={tr(item.label)}
                    className={({ isActive }) => 'sa-nav-item' + (isActive ? ' is-on' : '')}>
                    <span className="sa-nav-icon"><Icon name={item.icon} /></span>
                    <span className="sa-nav-text">{tr(item.label)}</span>
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>
          <div className="sa-side-foot">
            <a className="sa-os" href={OS_URL + '/dashboard'} target="_blank" rel="noopener noreferrer" title={tr('Open the full OS')}>
              <Out /><span>{tr('Open the full OS')}</span>
            </a>
            <Who name={name} role={role} />
            <button type="button" className="sa-signout" onClick={logout}>{tr('Sign out')}</button>
          </div>
        </aside>

        <main className={'sa-main' + (theme === 'dark' ? ' shell-main-dark' : '')}>
          <header className="sa-top">
            <span className="sa-top-logo"><img src="/logo.png" alt="" /></span>
            <div className="sa-title">
              {current && <span className="sa-title-icon"><Icon name={current.icon} /></span>}
              <div>
                <div className="sa-eyebrow">{group ? tr(group.label) : tr('Sales')}</div>
                <h1>{current ? tr(current.label) : tr('Sales')}</h1>
              </div>
            </div>
            <div className="sa-actions">
              <span className="sa-wide"><ThemeSwitch theme={theme} onChange={pickTheme} className="btn btn-secondary theme-toggle-btn" /></span>
              <span className="sa-wide"><LanguagePicker /></span>
              <NotificationsBell />
              <button type="button" className="sa-me" onClick={() => setMore(true)} aria-label={tr('More')}>
                <span className="sa-avatar" style={{ '--av': colorOf(name) }}>{initials(name)}</span>
              </button>
            </div>
          </header>
          <div className="sa-content shell-content">
            <ErrorBoundary key={location.pathname} scope="this page">
              <Outlet />
            </ErrorBoundary>
          </div>
          <FollowUpsAtSignIn />
          <FileViewerHost />
        </main>

        <nav className="sa-tabs" aria-label={tr('Sales')}>
          {tabs.map((item) => (
            <NavLink key={item.key} to={'/' + item.key} className={({ isActive }) => 'sa-tab' + (isActive ? ' is-on' : '')}>
              <span className="sa-tab-icon"><Icon name={item.icon} /></span>
              <span className="sa-tab-text">{tr(SHORT[item.key] || item.label)}</span>
            </NavLink>
          ))}
          <button type="button" className={'sa-tab' + (inMore || more ? ' is-on' : '')} onClick={() => setMore(true)}>
            <span className="sa-tab-icon"><Dots /></span>
            <span className="sa-tab-text">{tr('More')}</span>
          </button>
        </nav>

        {more && <More items={rest} theme={theme} onTheme={pickTheme} onClose={() => setMore(false)} onSignOut={logout} name={name} role={role} />}
      </div>
    </CallsProvider>
  );
}
