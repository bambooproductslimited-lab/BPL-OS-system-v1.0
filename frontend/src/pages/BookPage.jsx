import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { API_URL } from '../api/client';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import './ShopPage.css';
import './BookPage.css';
import { StoreFoot, StoreTop } from './StoreChrome';

// Booking a consultation with Bamboo Products at /book (backend
// bookings.service.js): public, outside the OS's frame. What to book (a
// showroom visit, a site measurement, a call), the day and the time (full
// ones greyed out), who and where; then the booking's own page at
// /book/<its link> to see it, add it to a calendar, or cancel it. Ghana
// keeps UTC all year, so times are shown as the business gives them. A
// booking with a fee (the service's, or for a visit the area's) is
// invoiced at once: its page offers to pay it (on /share/<its link>).

async function call(method, path, body) {
  const r = await fetch(API_URL + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || tr('Something went wrong. Please try again.'));
  return j;
}
function cedis(n) { return 'GHS ' + Number(n || 0).toLocaleString(activeIntlLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
const ICON = { showroom: '🏬', measure: '📐', call: '📞' };
function iconOf(s) { return ICON[s.id] || (s.visit ? '📐' : '📅'); }
function dayBits(d) {
  const dt = new Date(d + 'T12:00:00Z');
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  return {
    top: d === today ? tr('Today') : d === tomorrow ? tr('Tomorrow') : dt.toLocaleDateString(activeIntlLocale(), { weekday: 'short', timeZone: 'UTC' }),
    num: dt.toLocaleDateString(activeIntlLocale(), { day: 'numeric', timeZone: 'UTC' }),
    month: dt.toLocaleDateString(activeIntlLocale(), { month: 'short', timeZone: 'UTC' })
  };
}
function whenLong(iso) { return new Date(iso).toLocaleString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }); }
const PARTS = [['morning', '🌅', () => tr('Morning')], ['afternoon', '☀️', () => tr('Afternoon')], ['evening', '🌙', () => tr('Evening')]];
function partOf(t) { const h = Number(t.slice(0, 2)); return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'; }

// A calendar file for the booking, made on the phone.
function icsFor(b) {
  const z = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = (s) => String(s || '').replace(/[\\,;]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
  const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Bamboo Products//Booking//EN', 'BEGIN:VEVENT', 'UID:' + z(b.startsAt) + '-' + Math.random().toString(36).slice(2) + '@bamboo',
    'DTSTAMP:' + z(new Date().toISOString()), 'DTSTART:' + z(b.startsAt), 'DTEND:' + z(b.endsAt), 'SUMMARY:' + esc(b.serviceName + ' · Bamboo Products'),
    b.location ? 'LOCATION:' + esc(b.location) : null, 'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).join('\r\n');
  return URL.createObjectURL(new Blob([body], { type: 'text/calendar' }));
}

function Shell({ children }) {
  return (
    <div className="shp bkp">
      <StoreTop active="book" />
      {children}
      <StoreFoot />
    </div>
  );
}

function Booking({ token }) {
  const [b, setB] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { call('GET', '/book/' + token).then(setB).catch((e) => setError(e.message)); }, [token]);
  async function cancel() {
    if (!window.confirm(tr('Cancel your booking?'))) return;
    setBusy(true);
    try { setB(await call('POST', '/book/' + token + '/cancel')); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  if (!b) return <Shell><div className="shp-mid bkp-mid"><span className="shp-spin" aria-hidden="true">📅</span><p>{error || tr('Finding your booking…')}</p></div></Shell>;
  const STATE = {
    requested: ['⏳', tr('Waiting for us to confirm'), tr('We will text or call you shortly.')],
    confirmed: ['🎉', tr('Your booking is confirmed'), tr('See you then!')],
    cancelled: ['✕', tr('This booking was cancelled'), tr('Book another time whenever you like.')],
    done: ['✅', tr('Thank you for coming'), tr('We will be in touch about your project.')]
  }[b.status];
  return (
    <Shell>
      <section className={'bkp-ticket is-' + b.status}>
        <span className="bkp-art" aria-hidden="true">{STATE[0]}</span>
        <h1>{STATE[1]}</h1>
        <p>{STATE[2]}</p>
        <dl>
          <div><dt>{tr('What')}</dt><dd>{b.serviceName}</dd></div>
          <div><dt>{tr('When')}</dt><dd>{whenLong(b.startsAt)}</dd></div>
          {b.location && <div className="is-wide"><dt>{tr('Where')}</dt><dd>{b.location}{b.area ? ' · ' + b.area : ''}</dd></div>}
          <div className="is-wide"><dt>{tr('Name')}</dt><dd>{b.name}</dd></div>
        </dl>
        {b.fee && !b.fee.void && (
          <div className={'bkp-fee' + (b.fee.paid ? ' is-paid' : '')}>
            <span aria-hidden="true">{b.fee.paid ? '✅' : '💳'}</span>
            <span className="bkp-fee-main">
              <strong>{b.fee.paid ? tr('Booking fee paid · {amount}', { amount: cedis(b.fee.amount) }) : tr('Booking fee: {amount}', { amount: cedis(b.fee.amount) })}</strong>
              <small>{b.fee.invoiceNo ? tr('On invoice {no}', { no: b.fee.invoiceNo }) : ''}</small>
            </span>
            {b.fee.token && b.status !== 'cancelled' && <a className="shp-go" href={'/share/' + b.fee.token}>{b.fee.paid ? tr('See the receipt') : tr('Pay now')}</a>}
          </div>
        )}
        {(b.status === 'requested' || b.status === 'confirmed') && <a className="shp-go is-ghost" href={icsFor(b)} download="bamboo-booking.ics">🗓️ {tr('Add to my calendar')}</a>}
        {b.canCancel && <button type="button" className="shp-go is-ghost bkp-cancel" disabled={busy} onClick={cancel}>{tr('Cancel the booking')}</button>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        <a className="shp-go" href="/book">📅 {tr('Book something else')}</a>
      </section>
    </Shell>
  );
}

export default function BookPage() {
  const { token } = useParams();
  const [opts, setOpts] = useState(null);
  const [service, setService] = useState(null);
  const [date, setDate] = useState(null);
  const [time, setTime] = useState(null);
  const [f, setF] = useState({ name: '', phone: '', email: '', location: '', note: '' });
  const [area, setArea] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [made, setMade] = useState(null);
  useEffect(() => { document.title = tr('Book a consultation') + ' · Bamboo Products'; }, []);
  // Booked: the address becomes the booking's own page, to keep or share.
  useEffect(() => { if (made) window.history.replaceState({}, '', '/book/' + made); }, [made]);
  useEffect(() => {
    if (token) return undefined;
    let live = true;
    const q = new URLSearchParams();
    if (service) q.set('service', service);
    if (date) q.set('date', date);
    call('GET', '/book' + (q.toString() ? '?' + q : '')).then((d) => {
      if (!live) return;
      setOpts(d);
      if (d.on && !service) setService(d.service);
      if (d.on && !date && d.date) setDate(d.date);
    }).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [token, service, date]); // eslint-disable-line react-hooks/exhaustive-deps

  if (token) return <Booking token={token} />;
  if (made) return <Booking token={made} />;
  if (!opts) return <Shell><div className="shp-mid bkp-mid"><span className="shp-spin" aria-hidden="true">📅</span><p>{error || tr('Loading…')}</p></div></Shell>;
  if (!opts.on) return <Shell><div className="shp-mid bkp-mid"><span aria-hidden="true" className="bkp-big">📞</span><h1>{tr('Booking online is closed for now')}</h1><p>{tr('Please call us to arrange a visit.')}</p></div></Shell>;

  const svc = opts.services.find((s) => s.id === service) || opts.services[0];
  const areas = opts.areas || [];
  const byArea = !!(svc && svc.visit && areas.length);
  const picked = byArea ? areas.find((a) => a.name === area) : null;
  const fee = byArea ? (picked ? picked.fee : null) : (svc && svc.fee) || 0;
  const feeLabel = (s) => {
    if (s.visit && areas.length) { const lo = Math.min(...areas.map((a) => a.fee)); return lo > 0 ? tr('fee from {amount}', { amount: cedis(lo) }) : tr('fee by area'); }
    return s.fee > 0 ? tr('fee {amount}', { amount: cedis(s.fee) }) : tr('free');
  };
  const slots = opts.date === date && opts.service === service ? opts.slots : [];
  async function book(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { const r = await call('POST', '/book', { ...f, area: byArea ? area : '', service, date, time, website: '' }); setMade(r.token); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <Shell>
      <section className="bkp-hero">
        <span className="bkp-hero-art" aria-hidden="true">🎋</span>
        <h1>{tr('Book a consultation')}</h1>
        <p>{opts.intro || tr('Visit our showroom, have us measure your space, or talk your project through. Pick a time that suits you.')}</p>
      </section>
      <form className="bkp-form" onSubmit={book}>
        <fieldset className="bkp-fs">
          <legend><b>1</b>{tr('What would you like?')}</legend>
          <div className="bkp-svcs" role="radiogroup" aria-label={tr('What would you like?')}>
            {opts.services.map((s) => (
              <button key={s.id} type="button" role="radio" aria-checked={service === s.id} className={'bkp-svc' + (service === s.id ? ' is-on' : '')} onClick={() => { setService(s.id); setTime(null); }}>
                <span className="bkp-svc-ico" aria-hidden="true">{iconOf(s)}</span>
                <strong>{s.name}</strong>
                <small>{tr('{n} min', { n: s.minutes })}{s.visit ? ' · ' + tr('we come to you') : ''}</small>
                <span className={'bkp-svc-fee' + (feeLabel(s) === tr('free') ? ' is-free' : '')}>{feeLabel(s)}</span>
                {s.note && <em>{s.note}</em>}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset className="bkp-fs">
          <legend><b>2</b>{tr('When?')}</legend>
          <div className="bkp-days" role="radiogroup" aria-label={tr('Day')}>
            {opts.days.map((d) => { const l = dayBits(d); return (
              <button key={d} type="button" role="radio" aria-checked={date === d} className={date === d ? 'is-on' : ''} onClick={() => { setDate(d); setTime(null); }}><small>{l.top}</small><b>{l.num}</b><small>{l.month}</small></button>
            ); })}
          </div>
          {date && !slots.some((x) => !x.full) && <p className="shp-hint">{tr('No free times on this day. Pick another.')}</p>}
          {PARTS.map(([k, icon, label]) => {
            const list = slots.filter((x) => partOf(x.time) === k);
            if (!list.length) return null;
            return (
              <div key={k} className="bkp-part">
                <span className="bkp-part-h">{icon} {label()}</span>
                <div className="bkp-times">
                  {list.map((x) => <button key={x.time} type="button" disabled={x.full} className={(time === x.time ? 'is-on' : '') + (x.full ? ' is-full' : '')} aria-pressed={time === x.time} onClick={() => setTime(x.time)}>{x.time}</button>)}
                </div>
              </div>
            );
          })}
        </fieldset>
        <fieldset className="bkp-fs">
          <legend><b>3</b>{tr('Your details')}</legend>
          <label className="shp-field"><span>{tr('Your name')}</span><input className="input" required maxLength={120} autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <div className="shp-two">
            <label className="shp-field"><span>{tr('Phone number')}</span><input className="input" type="tel" inputMode="tel" required autoComplete="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="024 000 0000" /></label>
            <label className="shp-field"><span>{tr('Email (optional)')}</span><input className="input" type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
          </div>
          {byArea && (
            <div className="shp-field"><span>{tr('Your area')}</span>
              <div className="bkp-areas" role="radiogroup" aria-label={tr('Your area')}>
                {areas.map((a) => (
                  <button key={a.name} type="button" role="radio" aria-checked={area === a.name} className={area === a.name ? 'is-on' : ''} onClick={() => setArea(a.name)}>
                    <b>{a.name}</b><small>{a.fee > 0 ? cedis(a.fee) : tr('free')}</small>
                  </button>
                ))}
              </div>
            </div>
          )}
          {svc && svc.visit && <label className="shp-field"><span>{tr('Where should we come?')}</span><input className="input" required maxLength={300} autoComplete="street-address" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} placeholder={tr('Address or landmark')} /></label>}
          <label className="shp-field"><span>{tr('Tell us about your project (optional)')}</span><textarea className="input" rows={3} maxLength={500} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder={tr('e.g. blinds for 4 windows, a bamboo ceiling, office furniture')} /></label>
        </fieldset>
        {fee > 0 && (
          <div className="bkp-fee is-before">
            <span aria-hidden="true">💳</span>
            <span className="bkp-fee-main">
              <strong>{tr('Booking fee: {amount}', { amount: cedis(fee) })}{picked ? ' · ' + picked.name : ''}</strong>
              <small>{opts.feeNote || (opts.payOnline ? tr('Paid online by card or Mobile Money right after booking.') : tr('Invoiced to you right after booking.'))}</small>
            </span>
          </div>
        )}
        {error && <div className="error-banner" role="alert">{error}</div>}
        <button type="submit" className="shp-go is-big" disabled={busy || !service || !date || !time || (byArea && !picked)}>
          {busy ? tr('One moment…') : !time ? tr('Pick a time') : byArea && !picked ? tr('Choose your area') : fee > 0 ? tr('Book for {time} · fee {amount}', { time, amount: cedis(fee) }) : tr('Book {what} at {time}', { what: svc.name.toLowerCase(), time })}
        </button>
        <p className="shp-hint is-center">{tr('We confirm every booking by text or a call.')}</p>
      </form>
    </Shell>
  );
}
