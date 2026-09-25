import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Glossary, Hero, Insights, Section, fmtDate, jump } from '../components/DashKit';
import { tr, msg } from '../lib/i18n.jsx';
import SmsSettings from '../components/SmsSettings';
import EmailSettings from '../components/EmailSettings';
import './ToolRoomPage.css';
import './CompanySettingsPage.css';

// Company settings — the few company-wide choices everything else follows,
// in the same "explains itself" layout as the dashboards
// (components/DashKit.jsx): the default currency, when someone counts as
// late, whether text messages and email can go out, and when settings last
// changed; then each group of settings as its own card with its own Save
// (profile, working time, money), text messages and email, links to what
// is set up on other pages, and the latest changes from the audit log
// (settings.service.js: get, save, changes).
//
// Viewing needs only employee.read (the nav gate); saving needs
// settings.manage, so everyone else sees the same cards read-only. Only
// what a card sends changes, and the audit log says what changed.

const CARDS = {
  profile: ['companyName', 'shortName', 'country', 'timezone'],
  time: ['workWeek', 'standardHours', 'lateGraceMinutes', 'lateAfter', 'fiscalYearStart']
};
const ELSEWHERE = [
  { to: '/departments', perm: 'employee.read', label: msg('Companies'), what: msg('The companies in the group and their departments.'), count: (s) => s.structure.companies, unit: msg('{n} companies') },
  { to: '/leavetypes', perm: 'employee.write', label: msg('Leave types & balances'), what: msg('Kinds of leave, days per year, and public holidays.'), count: (s) => s.structure.leave_types, unit: msg('{n} leave types') },
  { to: '/billingsettings', perm: 'settings.manage', label: msg('Billing settings'), what: msg('Document numbers, tax rates, payment details and templates.') },
  { to: '/integrations', perm: 'settings.manage', label: msg('Integrations'), what: msg('Accounts the OS connects to, like social media channels.') },
  { to: '/roles', perm: 'role.manage', label: msg('Roles & permissions'), what: msg('What each role may see and do.') }
];

function Field({ id, label, hint, children }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

export default function CompanySettingsPage() {
  const { can } = useAuth();
  const canManage = can('settings.manage');
  const locked = !canManage;

  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState({});
  const [changes, setChanges] = useState([]);
  const [sms, setSms] = useState(null);
  const [mail, setMail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [cardError, setCardError] = useState({});
  const [toast, setToast] = useState(null);
  const [saving, setSaving] = useState(null);
  const [currencyDraft, setCurrencyDraft] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const s = await api.get('/settings');
      setSettings(s);
      setForm({
        companyName: s.companyName || '', shortName: s.shortName || '', country: s.country || '', timezone: s.timezone || '',
        workWeek: s.workWeek || '', standardHours: s.standardHours == null ? '' : String(s.standardHours), lateAfter: s.lateAfter || '',
        fiscalYearStart: s.fiscalYearStart || '', lateGraceMinutes: s.lateGraceMinutes == null ? '' : String(s.lateGraceMinutes), currency: s.currency || ''
      });
      if (canManage) {
        const [ch, sm, ml] = await Promise.all([api.get('/settings/changes'), api.get('/sms').catch(() => null), api.get('/mail').catch(() => null)]);
        setChanges(ch);
        setSms(sm);
        setMail(ml);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [canManage]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  async function saveCard(card, payload) {
    setSaving(card);
    setCardError({ ...cardError, [card]: null });
    try {
      await api.patch('/settings', payload);
      setToast(tr('Company settings saved.'));
      await load();
    } catch (err) {
      setCardError({ ...cardError, [card]: err.message });
    } finally {
      setSaving(null);
    }
  }
  const pick = (keys) => Object.fromEntries(keys.map((k) => [k, form[k]]));
  const dirty = (keys) => settings && keys.some((k) => String(form[k] ?? '') !== String((k === 'lateGraceMinutes' ? settings.lateGraceMinutes : settings[k]) ?? ''));
  const currencyList = (settings && settings.commercial && settings.commercial.currencies) || ['GHS'];
  function addCurrency(e) {
    e.preventDefault();
    const code = currencyDraft.trim().toUpperCase();
    if (!code) return;
    if (currencyList.includes(code)) { setCardError({ ...cardError, money: tr('"{code}" is already enabled.', { code }) }); return; }
    setCurrencyDraft('');
    saveCard('money', { currencies: [...currencyList, code] });
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;
  if (!settings) return <div className="error-banner">{error}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const s = settings;
  const graceSince = s.lateGraceHistory && s.lateGraceHistory[0] ? s.lateGraceHistory[0].from : null;
  const last = changes[0];
  const smsOn = sms && sms.configured;
  const stats = [
    { icon: 'cash', value: s.currency, label: tr('default currency'), note: tr('{n} enabled for documents', { n: currencyList.length }), onClick: () => jump('cs-money') },
    { icon: 'clock', value: tr('{n} min', { n: s.lateGraceMinutes }), label: tr('before someone counts as late'), note: graceSince ? tr('since {date}', { date: fmtDate(graceSince) }) : tr('past the start of their shift'), onClick: () => jump('cs-time') },
    canManage
      ? { icon: 'send', value: smsOn ? tr('On') : tr('Off'), label: tr('text messages'), note: smsOn ? (sms.balance ? tr('{n} credits left', { n: sms.balance.balance }) : tr('connected to mNotify')) : tr('not connected yet'), tone: smsOn ? 'good' : 'warn', onClick: () => jump('cs-sms') }
      : { icon: 'people', value: String(s.structure.employees), label: tr('people employed'), note: tr('in {n} departments', { n: s.structure.departments }) },
    { icon: 'calendar', value: last ? fmtDate(last.at) : s.updatedAt ? fmtDate(s.updatedAt) : '—', label: tr('last change'), note: last ? tr('by {name}', { name: last.actorName }) : tr('to company settings'), onClick: canManage ? () => jump('cs-changes') : undefined }
  ];

  const insights = [];
  if (locked) insights.push({ tone: 'info', icon: 'info', text: tr('You can see these settings but your role can\'t change them. Ask someone with Company settings access.'), action: null });
  if (canManage && sms && !sms.configured) insights.push({ tone: 'warn', icon: 'send', text: tr('Text messages aren\'t connected, so payment reminders, booking notices and sign-in codes by text can\'t go out. Add MNOTIFY_API_KEY and MNOTIFY_SENDER_ID in Render.'), action: { label: tr('How'), run: () => jump('cs-sms') } });
  if (canManage && sms && sms.configured && sms.balance && sms.balance.balance < 100) insights.push({ tone: 'warn', icon: 'send', text: tr('Only {n} text message credits are left on mNotify. Top up before reminders stop.', { n: sms.balance.balance }), action: { label: tr('Show'), run: () => jump('cs-sms') } });
  if (canManage && mail && !mail.configured) insights.push({ tone: 'info', icon: 'send', text: tr('Email isn\'t set up, so two-step sign-in codes can\'t be sent by email. Add the SMTP settings in Render.'), action: { label: tr('How'), run: () => jump('cs-email') } });
  if (!s.shortName || !s.country) insights.push({ tone: 'info', icon: 'info', text: tr('The company profile is missing a short name or country.'), action: canManage ? { label: tr('Fill it in'), run: () => jump('cs-profile') } : null });
  if (last && Date.now() - new Date(last.at).getTime() < 7 * 86400000) insights.push({ tone: 'info', icon: 'clock', text: tr('{name} changed settings on {date}: {what}', { name: last.actorName, date: fmtDate(last.at), what: last.summary }), action: { label: tr('Show them'), run: () => jump('cs-changes') } });
  if (!insights.length) insights.push({ tone: 'good', icon: 'check', text: tr('Everything the company needs is set up.') });

  function CardFooter({ card, keys, payload }) {
    if (locked) return null;
    return (
      <div className="cs-card-foot">
        {cardError[card] && <div className="error-banner">{cardError[card]}</div>}
        <button type="button" className="btn btn-primary" disabled={saving === card || (keys && !dirty(keys))} onClick={() => saveCard(card, payload || pick(keys))}>{saving === card ? tr('Saving…') : tr('Save')}</button>
        {keys && dirty(keys) && <span className="dk-muted tl-small">{tr('Not saved yet')}</span>}
      </div>
    );
  }

  return (
    <div className="dk cs">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <Hero
        eyebrow={tr('Governance')}
        title={tr('Company settings')}
        sub={tr('The company-wide choices everything else follows: names, working time, currencies, text messages and email. Every change is written to the audit log.')}
        stats={stats} />

      <Insights items={insights.slice(0, 5)} />

      <div className="cs-grid">
        <Section id="cs-profile" title={tr('Company profile')} sub={tr('How the company is named on documents and screens.')} card>
          <div className="cs-fields">
            <Field id="cs-cn" label={tr('Registered company name')}><input id="cs-cn" className="input" value={form.companyName} disabled={locked} onChange={(e) => setForm({ ...form, companyName: e.target.value })} /></Field>
            <Field id="cs-sn" label={tr('Short name')}><input id="cs-sn" className="input" value={form.shortName} disabled={locked} onChange={(e) => setForm({ ...form, shortName: e.target.value })} /></Field>
            <Field id="cs-cy" label={tr('Country')}><input id="cs-cy" className="input" value={form.country} disabled={locked} onChange={(e) => setForm({ ...form, country: e.target.value })} /></Field>
            <Field id="cs-tz" label={tr('Time zone')} hint={tr('Ghana uses GMT all year (Africa/Accra).')}><input id="cs-tz" className="input" value={form.timezone} disabled={locked} onChange={(e) => setForm({ ...form, timezone: e.target.value })} /></Field>
          </div>
          <CardFooter card="profile" keys={CARDS.profile} />
        </Section>

        <Section id="cs-time" title={tr('Working time')} sub={tr('When people are expected, and when they count as late.')} card>
          <div className="cs-fields">
            <Field id="cs-ww" label={tr('Work week')}><input id="cs-ww" className="input" value={form.workWeek} disabled={locked} onChange={(e) => setForm({ ...form, workWeek: e.target.value })} placeholder={tr('Mon–Sat')} /></Field>
            <Field id="cs-sh" label={tr('Standard hours a day')}><input id="cs-sh" className="input" type="number" min="1" max="12" step="0.5" value={form.standardHours} disabled={locked} onChange={(e) => setForm({ ...form, standardHours: e.target.value })} /></Field>
            <Field id="cs-lg" label={tr('Late after (minutes past the shift start)')} hint={tr('Everyone is judged against their own shift: with 10, a 07:00 shift is late from 07:11 and an 18:00 shift from 18:11. A change applies from today — earlier days keep the rule they had.')}>
              <input id="cs-lg" className="input" type="number" min="0" max="240" step="1" value={form.lateGraceMinutes} disabled={locked} onChange={(e) => setForm({ ...form, lateGraceMinutes: e.target.value })} placeholder="10" />
            </Field>
            <Field id="cs-la" label={tr('Counted late after')} hint={tr('Only for staff with no shift assigned: a fixed time of day.')}><input id="cs-la" className="input" value={form.lateAfter} disabled={locked} onChange={(e) => setForm({ ...form, lateAfter: e.target.value })} placeholder="07:10" /></Field>
            <Field id="cs-fy" label={tr('Fiscal year starts')} hint={tr('Month and day, like 01-01 for 1 January.')}><input id="cs-fy" className="input" value={form.fiscalYearStart} disabled={locked} onChange={(e) => setForm({ ...form, fiscalYearStart: e.target.value })} placeholder="01-01" /></Field>
          </div>
          {s.lateGraceHistory && s.lateGraceHistory.length > 1 && (
            <div className="cs-history">
              <span className="dk-muted tl-small">{tr('Earlier rules')}:</span>
              {s.lateGraceHistory.slice(1).map((h) => <span key={h.from} className="cs-hist-item">{tr('{n} min from {date}', { n: h.minutes, date: fmtDate(h.from) })}</span>)}
            </div>
          )}
          <p className="dk-muted tl-small cs-chain">{tr('Leave is approved by')}: {(s.leaveApprovalNames || []).join(' → ') || '—'}</p>
          <CardFooter card="time" keys={CARDS.time} />
        </Section>

        <Section id="cs-money" title={tr('Currencies')} sub={tr('The default is used for reports, which total one currency at a time. Documents can use any enabled currency.')} card>
          <div className="cs-fields">
            <Field id="cs-cu" label={tr('Default currency')} hint={tr('Used for P&L, cash flow, balance sheet and tax reports, which only ever total one currency at a time.')}>
              <select id="cs-cu" className="input" value={form.currency} disabled={locked} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
                {currencyList.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
          </div>
          <div className="cs-currency-list" aria-label={tr('Enabled currencies')}>
            {currencyList.map((c) => (
              <span key={c} className={'cs-currency-chip' + (c === s.currency ? ' is-default' : '')}>
                {c}{c === s.currency && <span className="dk-muted tl-small"> · {tr('default')}</span>}
                {!locked && c !== s.currency && <button type="button" className="cs-currency-remove" disabled={saving === 'money'} onClick={() => saveCard('money', { currencies: currencyList.filter((x) => x !== c) })} aria-label={tr('Remove {c}', { c })}>×</button>}
              </span>
            ))}
          </div>
          {!locked && (
            <form className="cs-currency-add" onSubmit={addCurrency}>
              <input className="input" maxLength={3} placeholder={tr('e.g. NGN')} value={currencyDraft} onChange={(e) => setCurrencyDraft(e.target.value.toUpperCase())} aria-label={tr('Currency code')} />
              <button type="submit" className="btn btn-secondary" disabled={saving === 'money' || currencyDraft.trim().length !== 3}>{tr('+ Add currency')}</button>
            </form>
          )}
          <p className="dk-muted tl-small">{tr('Removing a currency only stops it being offered for new documents — existing documents in it are unaffected.')}</p>
          <CardFooter card="money" keys={['currency']} />
        </Section>

        <Section id="cs-elsewhere" title={tr('Set up on other pages')} sub={tr('Company-wide choices that have a page of their own.')} card>
          <ul className="cs-links">
            {ELSEWHERE.filter((l) => can(l.perm)).map((l) => (
              <li key={l.to}>
                <Link to={l.to}>
                  <strong>{tr(l.label)}</strong>
                  <span className="dk-muted tl-small">{tr(l.what)}</span>
                  {l.count && <span className="cs-link-n">{tr(l.unit, { n: l.count(s) })}</span>}
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      </div>

      {canManage && (
        <>
          <Section id="cs-sms" title={tr('Text messages (SMS)')} sub={tr('Sign-in codes, payment reminders and booking notices by text, through the company\'s mNotify account.')} card>
            <SmsSettings />
          </Section>
          <Section id="cs-email" title={tr('Email')} sub={tr('Two-step sign-in codes by email, sent from one of the company\'s own mailboxes.')} card>
            <EmailSettings />
          </Section>
          <Section id="cs-changes" title={tr('Latest changes')} sub={tr('From the audit log: settings, integrations, text messages and email.')}>
            {!changes.length ? <div className="dk-empty"><p>{tr('No changes recorded yet.')}</p></div> : (
              <ul className="cs-changes">
                {changes.slice(0, 12).map((c, i) => (
                  <li key={i}><span>{c.summary}</span><span className="dk-muted tl-small">{c.actorName} · {fmtDate(c.at)}</span></li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}

      <Glossary items={[
        [tr('Default currency'), tr('The currency reports add up in. Documents in other currencies are shown separately, never converted.')],
        [tr('Late after'), tr('Minutes after someone\'s own shift start before they count as late. Changing it never re-judges past days.')],
        [tr('Counted late after'), tr('A fixed time of day, only for staff with no shift assigned.')],
        [tr('Fiscal year'), tr('The twelve months the yearly reports cover, starting on this month and day.')],
        [tr('Text messages'), tr('Sent through the company\'s mNotify account. The key lives only in the server\'s settings on Render, never on this page.')],
        [tr('Audit log'), tr('Every save here is recorded with what changed, from what, to what, and by whom.')]
      ]} />

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
