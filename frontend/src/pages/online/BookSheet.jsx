import { useEffect, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { restaurantLogoUrl } from '../../lib/restaurantLogos';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';
import { applyTheme, getInitialTheme } from '../../lib/theme';
import DeviceLanguage from '../../components/DeviceLanguage';

// Booking a table on the website (backend restaurantBookings onlineOptions
// / onlineBook): how many, the day and the time (the restaurant's times,
// a full one greyed out), a name and a phone to text; then the booking's
// own page (/b/<its link>, BookingPage) to see or cancel it. Ghana keeps
// UTC all year, so times are shown as the restaurant gives them.

function dayLabel(d) {
  const dt = new Date(d + 'T12:00:00Z');
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  return {
    top: d === today ? tr('Today') : d === tomorrow ? tr('Tomorrow') : dt.toLocaleDateString(activeIntlLocale(), { weekday: 'short', timeZone: 'UTC' }),
    num: dt.toLocaleDateString(activeIntlLocale(), { day: 'numeric', timeZone: 'UTC' }),
    month: dt.toLocaleDateString(activeIntlLocale(), { month: 'short', timeZone: 'UTC' })
  };
}
function bookingWhen(at) {
  return new Date(at).toLocaleString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
}
const PARTS = [['morning', '🌅', () => tr('Morning')], ['afternoon', '☀️', () => tr('Afternoon')], ['evening', '🌙', () => tr('Evening')]];
function partOf(t) { const h = Number(t.slice(0, 2)); return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'; }

export default function BookSheet({ code, account, onClose, onBooked }) {
  const [opts, setOpts] = useState(null);
  const [date, setDate] = useState(null);
  const [party, setParty] = useState(2);
  const [time, setTime] = useState(null);
  const [name, setName] = useState(account ? account.account.name || '' : '');
  const [phone, setPhone] = useState(account ? '+' + (account.account.phone || '') : '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    posFetch('GET', '/pos/online/' + encodeURIComponent(code) + '/book' + (date ? '?date=' + date : ''))
      .then((d) => { if (!live) return; setOpts(d); if (!date && d.date) setDate(d.date); })
      .catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [code, date]);

  async function book(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await posFetch('POST', '/pos/online/' + encodeURIComponent(code) + '/book', account ? account.token : null, { name, phone, party, date, time, note, website: '' });
      // A big party: on to pay the deposit; Paystack brings them back to the booking's page.
      if (r.payUrl) { window.location.assign(r.payUrl); return; }
      onBooked(r);
    } catch (err) { setError(err.message); setBusy(false); }
  }

  const slots = opts && opts.date === date ? opts.slots : [];
  const deposit = opts && opts.deposit && party >= opts.deposit.fromParty ? Math.round(opts.deposit.perGuest * party * 100) / 100 : 0;
  return (
    <div className="on-sheet-back" onClick={onClose}>
      <form className="on-sheet on-book" role="dialog" aria-modal="true" aria-labelledby="on-book-title" onClick={(e) => e.stopPropagation()} onSubmit={book}>
        <div className="on-co-head">
          <button type="button" className="on-x is-plain" onClick={onClose} aria-label={tr('Close')}>←</button>
          <h2 id="on-book-title">{tr('Book a table')}</h2>
        </div>
        {!opts ? <p className="on-hint">{error || tr('Loading…')}</p> : !opts.on ? (
          <div className="on-empty"><span aria-hidden="true">📞</span><strong>{tr('Bookings are by phone')}</strong>{opts.restaurant.phone && <p>{tr('Call {phone} to book.', { phone: opts.restaurant.phone })}</p>}</div>
        ) : (
          <>
            <div className="on-book-party">
              <span>{tr('How many people?')}</span>
              <div className="on-qty is-big">
                <button type="button" onClick={() => setParty(Math.max(1, party - 1))} disabled={party <= 1} aria-label={tr('Fewer')}>−</button>
                <b aria-live="polite">{party}</b>
                <button type="button" onClick={() => setParty(Math.min(opts.maxParty, party + 1))} disabled={party >= opts.maxParty} aria-label={tr('More')}>+</button>
              </div>
            </div>
            {party >= opts.maxParty && <p className="on-hint">{tr('More than {n}? Call {phone} and we will make room.', { n: opts.maxParty, phone: opts.restaurant.phone || tr('the restaurant') })}</p>}

            <div className="on-book-days" role="radiogroup" aria-label={tr('Day')}>
              {opts.days.map((d) => {
                const l = dayLabel(d);
                return (
                  <button key={d} type="button" role="radio" aria-checked={date === d} className={date === d ? 'is-on' : ''} onClick={() => { setDate(d); setTime(null); }}>
                    <small>{l.top}</small><b>{l.num}</b><small>{l.month}</small>
                  </button>
                );
              })}
            </div>

            {date && !slots.length && <p className="on-hint">{tr('No times on this day. Pick another.')}</p>}
            {PARTS.map(([k, icon, label]) => {
              const list = slots.filter((s) => partOf(s.time) === k);
              if (!list.length) return null;
              return (
                <div key={k} className="on-book-part">
                  <span className="on-book-part-h">{icon} {label()}</span>
                  <div className="on-book-times">
                    {list.map((s) => (
                      <button key={s.time} type="button" disabled={s.full} className={(time === s.time ? 'is-on' : '') + (s.full ? ' is-full' : '')} onClick={() => setTime(s.time)} aria-pressed={time === s.time}>
                        {s.time}{s.full && <small>{tr('Full')}</small>}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}

            <label className="on-field"><span>{tr('Your name')}</span><input className="input" required maxLength={80} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label className="on-field"><span>{tr('Phone number')}</span><input className="input" type="tel" inputMode="tel" required autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="024 000 0000" />
              <small className="on-hint">{tr('We text you when your table is confirmed.')}</small></label>
            <label className="on-field"><span>{tr('Anything we should know? (optional)')}</span><input className="input" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr('e.g. A birthday, a high chair, by the window')} /></label>
            {deposit > 0 && (
              <div className="on-bk-deposit" role="note">
                <span aria-hidden="true">🎟️</span>
                <span><strong>{tr('A deposit of {amount} to hold the table', { amount: money(deposit) })}</strong>
                  <small>{tr('{per} a guest for parties of {n} or more, paid now by card or Mobile Money and taken off your bill.', { per: money(opts.deposit.perGuest), n: opts.deposit.fromParty })}
                    {' '}{opts.deposit.refundHours > 0 ? tr('Cancel up to {h} hours before and it is given back.', { h: opts.deposit.refundHours }) : tr('Cancel before your time and it is given back.')}</small></span>
              </div>
            )}
            {error && <div className="error-banner" role="alert">{error}</div>}
            <button type="submit" className="on-go is-big" disabled={busy || !date || !time}>
              {busy ? tr('One moment…') : !time ? tr('Pick a time') : deposit > 0 ? '🔒 ' + tr('Pay {amount} and book', { amount: money(deposit) }) : tr('Book for {n} at {time}', { n: party, time })}
            </button>
            <p className="on-hint is-center">{deposit > 0 ? tr('Booked for {n} at {time} once the deposit is paid.', { n: party, time: time || '…' }) : opts.autoConfirm ? tr('Your table is booked as soon as you press the button.') : tr('The restaurant confirms your booking by text.')}</p>
          </>
        )}
      </form>
    </div>
  );
}

const BK_STATUS = {
  requested: ['⏳', () => tr('Waiting for the restaurant to confirm'), () => tr('We will text you as soon as they do.')],
  booked: ['🎉', () => tr('Your table is booked'), () => tr('See you then!')],
  called: ['🔔', () => tr('Your table is ready'), () => tr('Please come to the front.')],
  seated: ['🍽️', () => tr('Enjoy your meal'), null],
  cancelled: ['✕', () => tr('This booking was cancelled'), null],
  declined: ['😔', () => tr('The restaurant could not take this booking'), () => tr('Please call them for another time.')],
  no_show: ['⌛', () => tr('This booking has passed'), null]
};

function depositWords(d) {
  return { due: tr('to pay'), paid: tr('paid, taken off your bill'), applied: tr('taken off your bill'), kept: tr('kept'), refunded: tr('given back'), refund_failed: tr('to be given back: the restaurant will call you') }[d.status] || d.status;
}
function bookingTime(iso) { return new Date(iso).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }); }

// /b/<link>: a booking's own page — its state, and cancelling it while it can be.
export function BookingPage({ token, onMenu }) {
  const [b, setB] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { applyTheme(getInitialTheme()); }, []);
  useEffect(() => {
    let live = true;
    const load = () => posFetch('GET', '/pos/online/bookings/' + token).then((d) => { if (live) { setB(d); document.title = tr('Your booking') + ' · ' + d.restaurant.name; } }).catch((e) => live && setError(e.message));
    load();
    const t = setInterval(load, 20000);
    return () => { live = false; clearInterval(t); };
  }, [token]);
  async function payDeposit() {
    setBusy(true); setError(null);
    try { const r = await posFetch('POST', '/pos/online/bookings/' + token + '/pay'); window.location.assign(r.url); } catch (e) { setError(e.message); setBusy(false); }
  }
  async function cancel() {
    const dep = b.deposit;
    const late = dep && dep.status === 'paid' && dep.refundUntil && Date.now() > new Date(dep.refundUntil).getTime();
    if (!window.confirm(late ? tr('Cancel your booking? It is too late to give the deposit back: it is kept.') : dep && dep.status === 'paid' ? tr('Cancel your booking? Your deposit is given back.') : tr('Cancel your booking?'))) return;
    setBusy(true);
    try { setB(await posFetch('POST', '/pos/online/bookings/' + token + '/cancel')); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  if (!b) return <div className="on-shell is-empty"><div className="on-empty"><span className="on-spin" aria-hidden="true">📅</span><strong>{error ? tr('We cannot find that booking') : tr('Finding your booking…')}</strong>{error && <p>{error}</p>}</div></div>;
  const st = BK_STATUS[b.status] || BK_STATUS.requested;
  const logo = restaurantLogoUrl(b.restaurant.code);
  return (
    <div className="on-shell on-track on-bk-page" data-brand={b.restaurant.code}>
      <header className="on-track-top">
        {logo ? <img src={logo} alt="" /> : <span aria-hidden="true">🍽️</span>}
        <div><strong>{b.restaurant.name}</strong><small>{tr('Your booking')}</small></div>
        <DeviceLanguage className="on-lang" />
      </header>
      <article className={'on-bk is-' + b.status}>
        <span className="on-bk-art" aria-hidden="true">{st[0]}</span>
        <h1>{st[1]()}</h1>
        {st[2] && <p className="on-hint is-center">{st[2]()}</p>}
        <div className="on-bk-ticket">
          <div><small>{tr('When')}</small><strong>{bookingWhen(b.at)}</strong></div>
          <div><small>{tr('People')}</small><strong>{b.party}</strong></div>
          <div><small>{tr('Name')}</small><strong>{b.name}</strong></div>
          {b.note && <div className="is-wide"><small>{tr('Note')}</small><strong>{b.note}</strong></div>}
          {b.deposit && <div className={'is-wide on-bk-dep is-' + b.deposit.status}><small>{tr('Deposit')}</small><strong>{money(b.deposit.amount)} · {depositWords(b.deposit)}</strong></div>}
        </div>
        {b.deposit && b.deposit.status === 'due' && ['requested', 'booked'].includes(b.status) && (
          <>
            <p className="on-hint is-center">{tr('Your table is held once the deposit is paid{by}.', { by: b.deposit.payBy ? ' ' + tr('(by {time})', { time: bookingTime(b.deposit.payBy) }) : '' })}</p>
            <button type="button" className="on-go is-big" disabled={busy} onClick={payDeposit}>🔒 {tr('Pay the deposit · {amount}', { amount: money(b.deposit.amount) })}</button>
          </>
        )}
        {b.deposit && b.deposit.status === 'paid' && b.deposit.refundUntil && b.canCancel && <p className="on-hint is-center">{tr('Cancel by {when} and your deposit is given back.', { when: bookingWhen(b.deposit.refundUntil) })}</p>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        {b.restaurant.phone && <a className="on-go is-ghost" href={'tel:' + b.restaurant.phone.replace(/[^\d+]/g, '')}>📞 {tr('Call {name}', { name: b.restaurant.name })}</a>}
        {b.canCancel && <button type="button" className="on-go is-stop" disabled={busy} onClick={cancel}>{tr('Cancel my booking')}</button>}
        <button type="button" className="on-go" onClick={() => onMenu(b.restaurant.code)}>🍽️ {tr('See the menu')}</button>
      </article>
    </div>
  );
}
