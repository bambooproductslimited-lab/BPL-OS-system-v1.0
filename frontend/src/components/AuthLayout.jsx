import { useEffect, useState } from 'react';
import { LOCALES, msg, tr } from '../lib/i18n.jsx';
import { useI18n } from '../lib/i18nContext.js';
import { applyTheme, clearTheme, getInitialTheme, THEME_KEY } from '../lib/theme';
import '../pages/LoginPage.css';

// The frame every sign-in screen shares (LoginPage, ForcedPasswordChangePage):
// the brand side saying what Bamboo OS is, and the form side. Like the till
// and the kiosk, it follows the light/dark choice on this device, with a
// switch in the corner.

const AREAS = [
  ['people', msg('People, attendance and leave')],
  ['box', msg('Production, stock and suppliers')],
  ['doc', msg('Quotations, invoices and payments')],
  ['plate', msg('Restaurants and Poki Rentals')],
  ['chart', msg('Finance, payroll and reports')],
  ['spark', msg('An AI assistant that knows the business')]
];
const ICONS = {
  people: <><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" /><path d="M15.5 5.2a3 3 0 0 1 0 5.6M17.5 14.3c1.7.6 2.7 2.2 3 4.7" /></>,
  box: <><path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5v-9Z" /><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9" /></>,
  doc: <><path d="M6 3h8l4 4v14H6V3Z" /><path d="M14 3v4h4M9 12h6M9 16h6" /></>,
  plate: <><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="3.5" /><path d="M2.5 4v5.5M4 4v16M20.5 4c-1.5 1-2 3-2 6h2v10" /></>,
  chart: <><path d="M4 20V4M4 20h16" /><path d="M8 16v-4M12 16V8M16 16v-6" /></>,
  spark: <><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" /></>,
  lock: <><rect x="5" y="10" width="14" height="10" rx="1.5" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" /></>,
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />,
  eye: <><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" /><circle cx="12" cy="12" r="2.6" /></>,
  eyeOff: <><path d="M3 3l18 18" /><path d="M9.9 5.1A10.7 10.7 0 0 1 12 5c6.5 0 10 6.5 10 6.5a15.4 15.4 0 0 1-3.2 4M6.5 6.8C3.6 8.6 2 12 2 12s3.5 6.5 10 6.5c1.4 0 2.6-.3 3.7-.8" /><path d="M9.9 9.9a2.6 2.6 0 0 0 3.6 3.6" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M4 7l8 6 8-6" /></>,
  phone: <><rect x="7" y="2.5" width="10" height="19" rx="2" /><path d="M11 18.5h2" /></>,
  app: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6M9 12h6M9 16h3" /></>,
  key: <><circle cx="8" cy="15" r="4" /><path d="M11 12l8-8M16 7l2 2M14 9l2 2" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7" />,
  dot: <circle cx="12" cy="12" r="3" />,
  warn: <><path d="M12 3.5 2.5 20h19L12 3.5Z" /><path d="M12 10v4.5M12 17.2v.3" /></>,
  back: <path d="M15 5l-7 7 7 7" />
};
export function AuthIcon({ name, className }) {
  return <svg className={'auth-icon' + (className ? ' ' + className : '')} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[name]}</svg>;
}

export default function AuthLayout({ children, heading, sub }) {
  const { locale, setLocale } = useI18n();
  const [theme, setTheme] = useState(getInitialTheme);
  useEffect(() => {
    applyTheme(theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* remembered for this visit only */ }
  }, [theme]);
  useEffect(() => () => clearTheme(), []);

  return (
    <div className="auth">
      <aside className="auth-brand">
        <img src="/logo.png" alt="Bamboo Products Limited" className="auth-logo" />
        <div className="auth-brand-main">
          <p className="auth-eyebrow">{tr('Bamboo Products Limited')}</p>
          <h1 className="auth-brand-title">{heading || tr('Company Operating System')}</h1>
          <p className="auth-brand-sub">{sub || tr('Everything the company runs on, in one place.')}</p>
          <ul className="auth-areas">
            {AREAS.map(([icon, label]) => <li key={icon}><AuthIcon name={icon} />{tr(label)}</li>)}
          </ul>
        </div>
        <p className="auth-brand-foot"><AuthIcon name="lock" />{tr('Internal system · authorised staff only')}</p>
      </aside>
      <main className="auth-side">
        <div className="auth-tools">
        <label className="auth-lang">
          <span className="sr-only">{tr('Language')}</span>
          <select value={locale} onChange={(e) => setLocale(e.target.value)} title={tr('Language')}>
            {LOCALES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
        </label>
        <button type="button" className="auth-theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={theme === 'dark' ? tr('Light mode') : tr('Dark mode')} title={theme === 'dark' ? tr('Light mode') : tr('Dark mode')}>
          <AuthIcon name={theme === 'dark' ? 'sun' : 'moon'} />
        </button>
        </div>
        <div className="auth-card">{children}</div>
      </main>
    </div>
  );
}

// A password box with show/hide and a Caps Lock warning.
export function PasswordField({ id, label, value, onChange, autoComplete, autoFocus, required = true, shown, onToggle }) {
  const [caps, setCaps] = useState(false);
  function check(e) { if (e.getModifierState) setCaps(e.getModifierState('CapsLock')); }
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="auth-input">
        <AuthIcon name="lock" />
        <input id={id} className="input" type={shown ? 'text' : 'password'} autoComplete={autoComplete} autoFocus={autoFocus}
          value={value} onChange={(e) => onChange(e.target.value)} onKeyUp={check} onKeyDown={check} onBlur={() => setCaps(false)} required={required} />
        {onToggle && (
          <button type="button" className="auth-input-btn" onClick={onToggle} aria-label={shown ? tr('Hide password') : tr('Show password')} tabIndex={-1}>
            <AuthIcon name={shown ? 'eyeOff' : 'eye'} />
          </button>
        )}
      </div>
      {caps && <p className="auth-caps"><AuthIcon name="warn" />{tr('Caps Lock is on.')}</p>}
    </div>
  );
}

// What a new password needs, ticked off as it is typed.
export function passwordProblems(pw, confirm, email) {
  const local = String(email || '').split('@')[0].toLowerCase();
  return {
    length: pw.length >= 8,
    mixed: /[a-z]/i.test(pw) && /[0-9]/.test(pw),
    notEmail: !!pw && (!local || !pw.toLowerCase().includes(local)),
    match: !!pw && pw === confirm
  };
}
export function PasswordRules({ password, confirm, email }) {
  const p = passwordProblems(password, confirm, email);
  const rows = [
    ['length', tr('At least 8 characters')],
    ['mixed', tr('Letters and numbers')],
    ['notEmail', tr('Not your name or email')],
    ['match', tr('Both boxes match')]
  ];
  return (
    <ul className="auth-rules" aria-label={tr('Your new password')}>
      {rows.map(([k, label]) => <li key={k} className={p[k] ? 'is-ok' : ''}><AuthIcon name={p[k] ? 'check' : 'dot'} />{label}</li>)}
    </ul>
  );
}
