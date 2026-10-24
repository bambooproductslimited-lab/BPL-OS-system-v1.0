import { useCallback, useEffect, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';

// Bookings and the waitlist on the till (backend restaurantBookings): the
// day's bookings by time, guests waiting for a table (how long, against
// what they were told), and website requests to confirm. A guest waiting is
// texted when their table is ready; seated, they start an order at their
// table (onSeat). A text that cannot go by SMS opens WhatsApp with the words.

const STATUS = {
  requested: ['🌐', 'is-asked', () => tr('Asked on the website')], booked: ['📅', 'is-booked', () => tr('Booked')], waiting: ['⏳', 'is-waiting', () => tr('Waiting')],
  called: ['🔔', 'is-called', () => tr('Called')], seated: ['🪑', 'is-seated', () => tr('Seated')], cancelled: ['✕', 'is-off', () => tr('Cancelled')],
  no_show: ['👻', 'is-off', () => tr('No-show')], declined: ['✕', 'is-off', () => tr('Declined')]
};
const today = () => new Date().toISOString().slice(0, 10);
function addDays(day, n) { return new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
function hhmm(at) { return new Date(at).toISOString().slice(11, 16); }
function dayWords(day) { return new Date(day + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }); }
function nextSlot() { const d = new Date(Date.now() + 60 * 60000); d.setUTCMinutes(d.getUTCMinutes() < 30 ? 30 : 60, 0, 0); return hhmm(d); }

function Party({ value, onChange }) {
  return (
    <div className="bk-party" role="group" aria-label={tr('People')}>
      <button type="button" onClick={() => onChange(Math.max(1, value - 1))} aria-label={tr('One less')}>−</button>
      <b>{value}</b>
      <button type="button" onClick={() => onChange(Math.min(200, value + 1))} aria-label={tr('One more')}>+</button>
      <small>{value === 1 ? tr('person') : tr('people')}</small>
    </div>
  );
}

export default function Bookings({ token, tables, onSeat, onToast, onClose }) {
  const [day, setDay] = useState(today);
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('day');
  const [form, setForm] = useState(null); // a booking or someone for the waitlist, being written
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [seatFor, setSeatFor] = useState(null);

  const load = useCallback(async () => {
    try { setData(await posFetch('GET', '/pos/bookings?day=' + day, token)); setError(null); } catch (e) { setError(e.message); }
  }, [day, token]);
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);
  useEffect(() => { if (data && data.requests.length && tab === 'day' && !data.bookings.length) setTab('requests'); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const body = form.kind === 'waitlist'
        ? { id: form.id, kind: 'waitlist', name: form.name, phone: form.phone, party: form.party, quotedMinutes: form.quote, note: form.note }
        : { id: form.id, kind: 'booking', name: form.name, phone: form.phone, party: form.party, date: form.date, time: form.time, minutes: form.minutes, tableId: form.tableId || null, note: form.note };
      await posFetch('POST', '/pos/bookings', token, body);
      onToast(form.kind === 'waitlist' ? tr('{name} is on the waitlist.', { name: form.name }) : tr('Booked for {name}.', { name: form.name }));
      if (form.kind === 'booking' && form.date !== day) setDay(form.date);
      setTab(form.kind === 'waitlist' ? 'wait' : 'day');
      setForm(null);
      load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function act(b, action, extra) {
    setBusy(true); setError(null);
    try {
      const r = await posFetch('POST', '/pos/bookings/' + b.id + '/' + action, token, extra || {});
      if (r.text) {
        if (r.text.sent) onToast(tr('Texted {name}.', { name: b.name }));
        else if (r.text.whatsapp) window.open(r.text.whatsapp, '_blank', 'noopener');
      }
      if (action === 'seat') onSeat(r.booking);
      load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  function newBooking() { setForm({ kind: 'booking', name: '', phone: '', party: 2, date: day < today() ? today() : day, time: nextSlot(), minutes: data ? data.settings.minutes : 90, tableId: '', note: '' }); }
  function newWait() { setForm({ kind: 'waitlist', name: '', phone: '', party: 2, quote: 15, note: '' }); }

  const list = !data ? [] : tab === 'day' ? data.bookings : tab === 'wait' ? data.waitlist : data.requests;
  const live = (b) => ['requested', 'booked', 'waiting', 'called'].includes(b.status);
  const people = data ? data.bookings.filter((b) => b.status !== 'cancelled' && b.status !== 'declined' && b.status !== 'no_show').reduce((n, b) => n + b.party, 0) : 0;
  return (
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <div className="dialog pos-panel bk" role="dialog" aria-modal="true" aria-labelledby="bk-title" onClick={(e) => e.stopPropagation()}>
        <header className="bk-head">
          <span className="bk-ico" aria-hidden="true">📅</span>
          <div><h2 id="bk-title">{tr('Bookings and waitlist')}</h2><p className="dk-muted">{data && !data.smsOn ? tr('Texts open WhatsApp on this till: the server has no SMS set up.') : tr('Guests are texted when their table is booked or ready.')}</p></div>
          <div className="bk-new">
            <button type="button" className="btn btn-secondary tl-btn" onClick={newWait}>⏳ {tr('Walk-in waiting')}</button>
            <button type="button" className="btn btn-primary tl-btn" onClick={newBooking}>＋ {tr('New booking')}</button>
          </div>
        </header>

        {form ? (
          <form className="bk-form" onSubmit={save}>
            <h3>{form.kind === 'waitlist' ? tr('Waiting for a table') : form.id ? tr('Change the booking') : tr('New booking')}</h3>
            <div className="bk-grid">
              <label className="field"><span>{tr('Name')}</span><input className="input" required maxLength={80} autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
              <label className="field"><span>{tr('Phone (for the text)')}</span><input className="input" type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="024 000 0000" /></label>
              <div className="field"><span>{tr('People')}</span><Party value={form.party} onChange={(party) => setForm({ ...form, party })} /></div>
              {form.kind === 'booking' ? (
                <>
                  <label className="field"><span>{tr('Day')}</span><input className="input" type="date" min={today()} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></label>
                  <label className="field"><span>{tr('Time')}</span><input className="input" type="time" step="900" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} /></label>
                  <label className="field"><span>{tr('Table')}</span>
                    <select className="input" value={form.tableId} onChange={(e) => setForm({ ...form, tableId: e.target.value })}>
                      <option value="">{tr('Any table')}</option>
                      {tables.map((t) => <option key={t.id} value={t.id}>{t.name}{t.seats ? ' · ' + tr('{n} seats', { n: t.seats }) : ''}</option>)}
                    </select>
                  </label>
                  <label className="field"><span>{tr('Keep the table')}</span>
                    <select className="input" value={form.minutes} onChange={(e) => setForm({ ...form, minutes: Number(e.target.value) })}>
                      {[60, 90, 120, 150, 180, 240].map((m) => <option key={m} value={m}>{tr('{n} min', { n: m })}</option>)}
                    </select>
                  </label>
                </>
              ) : (
                <div className="field bk-quote"><span>{tr('Told to wait about')}</span>
                  <div className="tl-chips">{(data ? data.quotes : [5, 10, 15, 20, 30, 45, 60]).filter((q) => q > 0).map((q) => (
                    <button key={q} type="button" className={'tl-chip' + (form.quote === q ? ' is-on' : '')} aria-pressed={form.quote === q} onClick={() => setForm({ ...form, quote: q })}>{tr('{n} min', { n: q })}</button>
                  ))}</div>
                </div>
              )}
              <label className="field bk-wide"><span>{tr('Note')}</span><input className="input" maxLength={300} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder={tr('e.g. birthday, a high chair, by the window')} /></label>
            </div>
            {error && <div className="error-banner">{error}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => { setForm(null); setError(null); }}>{tr('Back')}</button>
              <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? tr('Saving…') : form.kind === 'waitlist' ? tr('Add to the waitlist') : tr('Book it')}</button>
            </div>
          </form>
        ) : (
          <>
            <div className="bk-bar">
              <div className="dk-segment" role="tablist">
                <button type="button" role="tab" aria-selected={tab === 'day'} className={tab === 'day' ? 'is-on' : ''} onClick={() => setTab('day')}>📅 {tr('Bookings')} <b>{data ? data.bookings.filter(live).length : '·'}</b></button>
                <button type="button" role="tab" aria-selected={tab === 'wait'} className={tab === 'wait' ? 'is-on' : ''} onClick={() => setTab('wait')}>⏳ {tr('Waitlist')} <b>{data ? data.waitlist.filter(live).length : '·'}</b></button>
                <button type="button" role="tab" aria-selected={tab === 'requests'} className={tab === 'requests' ? 'is-on' : ''} onClick={() => setTab('requests')}>🌐 {tr('Requests')} <b className={data && data.requests.length ? 'is-hot' : ''}>{data ? data.requests.length : '·'}</b></button>
              </div>
              {tab === 'day' && (
                <div className="bk-day">
                  <button type="button" className="pos-link" onClick={() => setDay(addDays(day, -1))} aria-label={tr('The day before')}>‹</button>
                  <strong>{day === today() ? tr('Today') : dayWords(day)}</strong>
                  <button type="button" className="pos-link" onClick={() => setDay(addDays(day, 1))} aria-label={tr('The day after')}>›</button>
                  {day !== today() && <button type="button" className="pos-link" onClick={() => setDay(today())}>{tr('Today')}</button>}
                  <small>{tr('{n} people expected', { n: people })}</small>
                </div>
              )}
            </div>
            {tab === 'day' && data && data.ahead.length > 0 && (
              <div className="bk-ahead">
                {data.ahead.map((a) => (
                  <button key={a.day} type="button" className={'bk-ahead-day' + (a.day === day ? ' is-on' : '')} onClick={() => setDay(a.day)}>
                    <small>{new Date(a.day + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { weekday: 'short', day: 'numeric', timeZone: 'UTC' })}</small>
                    <b>{a.n}</b><i>{tr('{n} people', { n: a.people })}</i>
                  </button>
                ))}
              </div>
            )}
            {error && <div className="error-banner">{error}</div>}
            {!data ? <p className="dk-muted">{tr('Loading…')}</p> : !list.length ? (
              <div className="dk-empty bk-empty"><span aria-hidden="true">{tab === 'wait' ? '🪑' : tab === 'requests' ? '🌐' : '📅'}</span>
                <p>{tab === 'wait' ? tr('Nobody is waiting. Add walk-ins when the tables are full.') : tab === 'requests' ? tr('No requests from the website to answer.') : tr('No bookings this day yet.')}</p></div>
            ) : (
              <ul className="bk-list is-plain">
                {list.map((b) => {
                  const st = STATUS[b.status] || STATUS.booked;
                  const late = b.kind === 'waitlist' && b.quotedMinutes != null && b.waited > b.quotedMinutes;
                  return (
                    <li key={b.id} className={'bk-item ' + st[1]}>
                      <div className="bk-when">
                        {b.kind === 'waitlist'
                          ? <><b className={late ? 'is-late' : ''}>{tr('{n} min', { n: b.waited })}</b><small>{b.quotedMinutes != null ? tr('told {n}', { n: b.quotedMinutes }) : tr('waiting')}</small></>
                          : <><b>{hhmm(b.at)}</b><small>{tab === 'requests' ? new Date(b.at).toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC' }) : tr('{n} min', { n: b.minutes })}</small></>}
                      </div>
                      <div className="bk-who">
                        <strong>{b.name} <span className="bk-pax">👥 {b.party}</span>{b.source === 'website' && <span className="bk-web">🌐 {tr('Website')}</span>}</strong>
                        <small>{[b.tableName ? '🪑 ' + b.tableName : null, b.phone || null, b.note ? '✎ ' + b.note : null].filter(Boolean).join(' · ')}</small>
                        <span className={'bk-status ' + st[1]}>{st[0]} {st[2]()}{b.texted.length > 0 && <em>💬 {tr('texted')}</em>}{b.texted.some((x) => x.what === 'reminder') && <em>⏰ {tr('Reminded')}</em>}</span>
                      </div>
                      <div className="bk-acts">
                        {b.status === 'requested' && <>
                          <button type="button" className="btn btn-primary tl-btn" disabled={busy} onClick={() => act(b, 'confirm')}>✓ {tr('Confirm')}</button>
                          <button type="button" className="btn btn-secondary tl-btn" disabled={busy} onClick={() => act(b, 'decline')}>{tr('Decline')}</button>
                        </>}
                        {(b.status === 'waiting' || (b.status === 'booked' && b.kind === 'booking')) && b.phone && (
                          <button type="button" className="btn tl-btn bk-call" disabled={busy} onClick={() => act(b, 'call')}>🔔 {tr('Table ready')}</button>
                        )}
                        {['booked', 'waiting', 'called'].includes(b.status) && <button type="button" className="btn btn-primary tl-btn" disabled={busy} onClick={() => (b.tableId ? act(b, 'seat') : setSeatFor(b))}>🪑 {tr('Seat')}</button>}
                        {['booked', 'waiting', 'called'].includes(b.status) && <button type="button" className="pos-link" disabled={busy} onClick={() => act(b, 'noShow')}>{tr('No-show')}</button>}
                        {live(b) && b.status !== 'requested' && <button type="button" className="pos-link is-bad" disabled={busy} onClick={() => act(b, 'cancel')}>{tr('Cancel')}</button>}
                        {b.status === 'booked' && <button type="button" className="pos-link" onClick={() => setForm({ kind: 'booking', id: b.id, name: b.name, phone: b.phone, party: b.party, date: b.at.slice(0, 10), time: hhmm(b.at), minutes: b.minutes, tableId: b.tableId || '', note: b.note })}>{tr('Edit')}</button>}
                        {['seated', 'cancelled', 'no_show', 'called'].includes(b.status) && <button type="button" className="pos-link" disabled={busy} onClick={() => act(b, 'undo')}>{tr('Undo')}</button>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Close')}</button></div>
          </>
        )}
        {seatFor && (
          <div className="bk-seat">
            <h3>{tr('Seat {name} at…', { name: seatFor.name })}</h3>
            <div className="tl-chips">
              {tables.map((t) => <button key={t.id} type="button" className="tl-chip" onClick={() => { const b = seatFor; setSeatFor(null); act(b, 'seat', { tableId: t.id }); }}>{t.name}{t.seats ? ' · ' + t.seats : ''}</button>)}
            </div>
            <button type="button" className="pos-link" onClick={() => setSeatFor(null)}>{tr('Back')}</button>
          </div>
        )}
      </div>
    </div>
  );
}
