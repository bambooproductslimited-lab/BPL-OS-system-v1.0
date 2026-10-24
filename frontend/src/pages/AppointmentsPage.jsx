import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { money } from '../lib/currency';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import './ShopOrdersPage.css';
import './AppointmentsPage.css';

// Appointments (Sales & CRM → Appointments; backend bookings.service.js):
// the consultations customers booked on the website at /book, day by day —
// each a lead in the CRM, and a site visit when we go to them. Confirmed
// (the customer is texted and emailed), given to someone, done or
// cancelled. The booking page's own settings: open or closed, what can be
// booked, for how long and its fee, the visit fees by area, the days and
// hours, how many at once. A booking's fee is invoiced to the customer at
// once; its chip says whether it is paid.

const STATUS = {
  requested: ['⏳', () => tr('To confirm')], confirmed: ['✅', () => tr('Confirmed')], done: ['🏁', () => tr('Done')], cancelled: ['✕', () => tr('Cancelled')]
};
const DAYS = [[1, () => tr('Mon')], [2, () => tr('Tue')], [3, () => tr('Wed')], [4, () => tr('Thu')], [5, () => tr('Fri')], [6, () => tr('Sat')], [0, () => tr('Sun')]];
function dayHead(iso) { return new Date(iso).toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }); }
function hm(iso) { return new Date(iso).toISOString().slice(11, 16); }

function SettingsDialog({ onClose, onSaved }) {
  const [d, setD] = useState(null);
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { api.get('/appointments/settings').then((r) => { setD(r); setS(r.settings); }).catch((e) => setError(e.message)); }, []);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await api.put('/appointments/settings', s); onSaved(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  const setSvc = (i, patch) => setS({ ...s, services: s.services.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  return createPortal(
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <form className="dialog apt-dlg" onClick={(e) => e.stopPropagation()} onSubmit={save} role="dialog" aria-modal="true" aria-labelledby="apt-set-title">
        <h2 id="apt-set-title">⚙️ {tr('The booking page')}</h2>
        {!s ? <p className="muted">{error || tr('Loading…')}</p> : (
          <>
            <label className="sho-switch apt-switch"><input type="checkbox" checked={s.on} onChange={(e) => setS({ ...s, on: e.target.checked })} />
              <span><strong>{s.on ? tr('Open: customers can book') : tr('Closed')}</strong><small>{d.url}</small></span></label>
            <label className="apt-field">{tr('A few words at the top')}<textarea className="input" rows={2} maxLength={400} value={s.intro} onChange={(e) => setS({ ...s, intro: e.target.value })} /></label>
            <fieldset className="apt-fs">
              <legend>{tr('What can be booked')}</legend>
              {s.services.map((x, i) => (
                <div key={i} className="apt-svc-row">
                  <input className="input" value={x.name} maxLength={60} onChange={(e) => setSvc(i, { name: e.target.value, id: x.id || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30) })} aria-label={tr('Name')} />
                  <input className="input apt-num" type="number" min="15" max="480" step="15" value={x.minutes} onChange={(e) => setSvc(i, { minutes: Number(e.target.value) })} aria-label={tr('Minutes')} />
                  <label className="apt-fee-in" title={tr('Fee (GHS), 0 for free')}>GHS<input className="input" type="number" min="0" max="100000" step="1" value={x.fee || 0} onChange={(e) => setSvc(i, { fee: Number(e.target.value) })} aria-label={tr('Fee (GHS), 0 for free')} /></label>
                  <label className="apt-check"><input type="checkbox" checked={x.visit} onChange={(e) => setSvc(i, { visit: e.target.checked })} />{tr('We go to them')}</label>
                  <button type="button" className="apt-x" onClick={() => setS({ ...s, services: s.services.filter((_, j) => j !== i) })} aria-label={tr('Remove')}>×</button>
                  <input className="input apt-note" value={x.note} maxLength={200} onChange={(e) => setSvc(i, { note: e.target.value })} placeholder={tr('A line about it for the customer')} />
                </div>
              ))}
              <button type="button" className="btn btn-secondary" disabled={s.services.length >= 8} onClick={() => setS({ ...s, services: s.services.concat([{ id: 'service-' + (s.services.length + 1), name: '', minutes: 60, visit: false, note: '', fee: 0 }]) })}>+ {tr('Something to book')}</button>
            </fieldset>
            <fieldset className="apt-fs">
              <legend>{tr('Visit fees by area')}</legend>
              <p className="muted apt-help">{tr('For what we go to them for: each area with its fee, in place of the fee above. None: the fee above everywhere.')}</p>
              {(s.areas || []).map((a, i) => (
                <div key={i} className="apt-area-row">
                  <input className="input" value={a.name} maxLength={60} placeholder={tr('e.g. Accra, Tema, Kumasi')} onChange={(e) => setS({ ...s, areas: s.areas.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} aria-label={tr('Area')} />
                  <label className="apt-fee-in">GHS<input className="input" type="number" min="0" max="100000" step="1" value={a.fee} onChange={(e) => setS({ ...s, areas: s.areas.map((x, j) => (j === i ? { ...x, fee: Number(e.target.value) } : x)) })} aria-label={tr('Fee (GHS), 0 for free')} /></label>
                  <button type="button" className="apt-x" onClick={() => setS({ ...s, areas: s.areas.filter((_, j) => j !== i) })} aria-label={tr('Remove')}>×</button>
                </div>
              ))}
              <button type="button" className="btn btn-secondary" disabled={(s.areas || []).length >= 20} onClick={() => setS({ ...s, areas: (s.areas || []).concat([{ name: '', fee: 0 }]) })}>+ {tr('An area')}</button>
              <label className="apt-field">{tr('A line about fees for the customer')}<input className="input" maxLength={200} value={s.feeNote || ''} onChange={(e) => setS({ ...s, feeNote: e.target.value })} placeholder={tr('e.g. Deducted from your order if you go ahead with us.')} /></label>
            </fieldset>
            <fieldset className="apt-fs">
              <legend>{tr('When')}</legend>
              <div className="apt-days">
                {DAYS.map(([n, label]) => <label key={n} className={'apt-day' + (s.days.includes(n) ? ' is-on' : '')}><input type="checkbox" checked={s.days.includes(n)} onChange={() => setS({ ...s, days: s.days.includes(n) ? s.days.filter((x) => x !== n) : s.days.concat([n]) })} />{label()}</label>)}
              </div>
              <div className="apt-grid">
                <label className="apt-field">{tr('From')}<input className="input" type="time" value={s.from} onChange={(e) => setS({ ...s, from: e.target.value })} /></label>
                <label className="apt-field">{tr('To')}<input className="input" type="time" value={s.to} onChange={(e) => setS({ ...s, to: e.target.value })} /></label>
                <label className="apt-field">{tr('Every')}<select className="input" value={s.step} onChange={(e) => setS({ ...s, step: Number(e.target.value) })}>{[15, 30, 60].map((m) => <option key={m} value={m}>{tr('{n} min', { n: m })}</option>)}</select></label>
                <label className="apt-field">{tr('At the same time')}<input className="input" type="number" min="1" max="10" value={s.perSlot} onChange={(e) => setS({ ...s, perSlot: Number(e.target.value) })} /></label>
                <label className="apt-field">{tr('Days ahead')}<input className="input" type="number" min="1" max="90" value={s.daysAhead} onChange={(e) => setS({ ...s, daysAhead: Number(e.target.value) })} /></label>
                <label className="apt-field">{tr('Notice (hours)')}<input className="input" type="number" min="0" max="72" value={s.noticeHours} onChange={(e) => setS({ ...s, noticeHours: Number(e.target.value) })} /></label>
                <label className="apt-field">{tr('Reminder')}<select className="input" value={s.remindHours} onChange={(e) => setS({ ...s, remindHours: Number(e.target.value) })}>
                  <option value={0}>{tr('No reminder')}</option>
                  <option value={3}>{tr('3 hours before')}</option>
                  <option value={24}>{tr('The day before')}</option>
                  <option value={48}>{tr('Two days before')}</option>
                </select></label>
              </div>
              <small className="apt-hint">⏰ {tr('Confirmed bookings get a text and an email, with the fee if it is still to pay.')}</small>
            </fieldset>
            <label className="apt-field">{tr('New bookings go to')}
              <select className="input" value={s.assignTo || ''} onChange={(e) => setS({ ...s, assignTo: e.target.value || null })}>
                <option value="">{tr('Everyone who manages the CRM')}</option>
                {d.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select></label>
            {error && <div className="error-banner" role="alert">{error}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? tr('Saving…') : tr('Save')}</button>
            </div>
          </>
        )}
      </form>
    </div>, document.body
  );
}

export default function AppointmentsPage() {
  const { can } = useAuth();
  const [params] = useSearchParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [toast, setToast] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showPast, setShowPast] = useState(false);
  const openId = params.get('open');
  const load = useCallback(() => api.get('/appointments').then(setData).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(null), 3500); return () => clearTimeout(t); }, [toast]);
  useEffect(() => {
    if (!data || !openId) return;
    const el = document.getElementById('apt-' + openId);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [data, openId]);

  async function change(a, body, said) {
    setBusy(a.id);
    try { const r = await api.patch('/appointments/' + a.id, body); setToast(said(r)); load(); } catch (e) { setToast(e.message); } finally { setBusy(null); }
  }

  if (error) return <div className="apt"><div className="error-banner" role="alert">{error}</div></div>;
  if (!data) return <div className="apt"><p className="muted">{tr('Loading…')}</p></div>;
  const now = Date.now();
  const list = data.appointments.filter((a) => showPast || new Date(a.endsAt).getTime() > now - 3600000 || a.status === 'requested');
  const byDay = [];
  list.forEach((a) => { const k = a.startsAt.slice(0, 10); let g = byDay.find((x) => x.day === k); if (!g) { g = { day: k, items: [] }; byDay.push(g); } g.items.push(a); });
  const t = data.totals;
  return (
    <div className="apt">
      <section className="apt-hero">
        <span className="apt-hero-art" aria-hidden="true">📅</span>
        <div className="apt-hero-main">
          <span className={'sho-state' + (data.settings.on ? ' is-on' : '')}><i />{data.settings.on ? tr('Booking page open') : tr('Booking page closed')}</span>
          <h1>{tr('Appointments')}</h1>
          <p>{tr('Showroom visits, site measurements and calls customers booked on the website. Each is a lead in the CRM; a visit to them is on the site visits map too.')}</p>
        </div>
        <div className="apt-hero-acts">
          <a className="btn btn-secondary" href={data.url} target="_blank" rel="noreferrer">↗ {tr('Open the booking page')}</a>
          {can('crm.manage') && <button type="button" className="btn btn-primary" onClick={() => setSettingsOpen(true)}>⚙️ {tr('Booking settings')}</button>}
        </div>
      </section>

      <div className="sho-stats">
        <div className={'sho-stat' + (t.waiting ? ' is-hot' : '')}><small>{tr('To confirm')}</small><strong>{t.waiting}</strong><span>{tr('call or text them back')}</span></div>
        <div className="sho-stat"><small>{tr('Today')}</small><strong>{t.today}</strong><span>{tr('booked for today')}</span></div>
        <div className="sho-stat"><small>{tr('Next 7 days')}</small><strong>{t.week}</strong><span>{tr('coming up')}</span></div>
        <div className="sho-stat"><small>{tr('Last 30 days')}</small><strong>{t.month}</strong><span>{tr('booked on the website')}</span></div>
      </div>

      <label className="apt-past"><input type="checkbox" checked={showPast} onChange={(e) => setShowPast(e.target.checked)} />{tr('Show past ones')}</label>
      {!byDay.length ? (
        <div className="sho-empty"><span aria-hidden="true">🗓️</span><strong>{tr('Nothing booked yet')}</strong>
          <p>{data.settings.on ? tr('Share the booking page with customers: {url}', { url: data.url }) : tr('Open the booking page in its settings, then share its address with customers.')}</p></div>
      ) : byDay.map((g) => (
        <section key={g.day} className="apt-day-sec">
          <h3>{dayHead(g.items[0].startsAt)}<small>{g.items.length === 1 ? tr('1 booking') : tr('{n} bookings', { n: g.items.length })}</small></h3>
          <ul className="apt-list">
            {g.items.map((a) => (
              <li key={a.id} id={'apt-' + a.id} className={'apt-item is-' + a.status + (openId === a.id ? ' is-picked' : '')}>
                <span className="apt-time"><b>{hm(a.startsAt)}</b><small>{hm(a.endsAt)}</small></span>
                <span className="apt-main">
                  <span className="apt-line"><strong>{a.name}</strong><span className={'apt-tag is-' + a.status}>{STATUS[a.status][0]} {STATUS[a.status][1]()}</span></span>
                  <small>{a.serviceName} · <a href={'tel:' + a.phone}>{a.phone}</a>{a.email ? ' · ' + a.email : ''}</small>
                  {a.location && <small>📍 {a.location}{a.area ? ' · ' + a.area : ''}</small>}
                  {a.note && <em>“{a.note}”</em>}
                  <span className="apt-links">
                    {a.leadRef && <Link to={'/crmleads?lead=' + a.leadId}>🎯 {tr('Lead {ref}', { ref: a.leadRef })}</Link>}
                    {a.siteVisitId && <Link to="/crmvisits">📐 {tr('Site visit')}</Link>}
                    {a.fee && (
                      <Link to={'/invoices?open=' + a.fee.invoiceId} className={'apt-fee' + (a.fee.paid ? ' is-paid' : a.fee.void ? ' is-void' : '')}>
                        💳 {a.fee.paid ? tr('Fee paid · {amount}', { amount: money(a.fee.amount) }) : a.fee.void ? tr('Fee cancelled') : tr('Fee due · {amount}', { amount: money(a.fee.due) })}
                      </Link>
                    )}
                    {a.remindedAt && <span className="apt-reminded" title={new Date(a.remindedAt).toLocaleString(activeIntlLocale())}>⏰ {tr('Reminded')}</span>}
                  </span>
                </span>
                {can('crm.manage') && (
                  <span className="apt-acts">
                    <select className="input apt-who" value={a.assignedTo ? a.assignedTo.id : ''} disabled={busy === a.id} aria-label={tr('Who takes it')}
                      onChange={(e) => change(a, { assignedTo: e.target.value || null }, (r) => (r.assignedTo ? tr('Given to {name}.', { name: r.assignedTo.name }) : tr('Given to nobody.')))}>
                      <option value="">{tr('Nobody yet')}</option>
                      {data.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                    {a.status === 'requested' && <button type="button" className="btn btn-primary" disabled={busy === a.id} onClick={() => change(a, { status: 'confirmed' }, (r) => (r.texted ? tr('Confirmed: {name} was texted.', { name: a.name }) : tr('Confirmed.')))}>✅ {tr('Confirm')}</button>}
                    {a.status === 'confirmed' && <button type="button" className="btn btn-primary" disabled={busy === a.id} onClick={() => change(a, { status: 'done' }, () => tr('Marked done.'))}>🏁 {tr('Done')}</button>}
                    {(a.status === 'requested' || a.status === 'confirmed') && <button type="button" className="btn btn-secondary" disabled={busy === a.id}
                      onClick={() => { if (window.confirm(tr('Cancel {name}\'s booking? They are told.', { name: a.name }))) change(a, { status: 'cancelled' }, () => tr('Cancelled.')); }}>{tr('Cancel')}</button>}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} onSaved={() => { setSettingsOpen(false); setToast(tr('Booking settings saved.')); load(); }} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
