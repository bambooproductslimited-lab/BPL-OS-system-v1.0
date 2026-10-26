import { useEffect, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { restaurantLogoUrl } from '../../lib/restaurantLogos';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';
import { applyTheme, getInitialTheme } from '../../lib/theme';
import DeviceLanguage from '../../components/DeviceLanguage';

// Private events and room hire on the restaurant's website (backend
// restaurantEvents, migration 0195): "Hire our space" asks for a party —
// the occasion, the day and the hours, how many, which space — and the
// restaurant plans it; the guest's own page (/e/<its link>) shows it as it
// goes: asked for, then the menu and the price sent, the deposit paid
// online, booked.

const OCCASIONS = [['🎂', () => tr('Birthday')], ['💍', () => tr('Wedding')], ['💼', () => tr('Office party')], ['👶', () => tr('Naming ceremony')], ['🎓', () => tr('Graduation')], ['✨', () => tr('Something else')]];
function dayWords(iso) { return new Date(iso).toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }); }
function hhmm(iso) { return new Date(iso).toISOString().slice(11, 16); }

export function EventSheet({ code, ev, onClose, onAsked }) {
  const [occasion, setOccasion] = useState('');
  const [day, setDay] = useState(ev.firstDay);
  const [from, setFrom] = useState('18:00');
  const [to, setTo] = useState('22:00');
  const [guests, setGuests] = useState(Math.max(ev.minGuests, 30));
  const [space, setSpace] = useState(ev.spaces.length === 1 ? ev.spaces[0].name : '');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function send(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await posFetch('POST', '/pos/online/' + encodeURIComponent(code) + '/events', null, { occasion, day, from, to, guests: Number(guests), space, name, phone, email, note });
      onAsked(r.token);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  const tooFew = Number(guests) < ev.minGuests;
  return (
    <div className="on-sheet-back is-checkout" onClick={onClose}>
      <form className="on-sheet evq" role="dialog" aria-modal="true" aria-labelledby="evq-title" onClick={(e) => e.stopPropagation()} onSubmit={send}>
        <div className="on-co-head">
          <button type="button" className="on-x is-plain" onClick={onClose} aria-label={tr('Back')}>←</button>
          <h2 id="evq-title">🥂 {tr('Hire our space')}</h2>
        </div>
        <div className="evq-hero">
          <span className="evq-art" aria-hidden="true">🥂<i>🎈</i><i>✨</i></span>
          <div>
            <strong>{tr('Your party, our place')}</strong>
            <small>{tr('Tell us about it: we call you to plan the menu and send you the price.')}</small>
            {ev.note && <small className="evq-note">{ev.note}</small>}
          </div>
        </div>
        <fieldset className="on-fs"><legend>{tr('What is the occasion?')}</legend>
          <div className="evq-occ" role="radiogroup">
            {OCCASIONS.map(([icon, label]) => (
              <button key={label()} type="button" role="radio" aria-checked={occasion === label()} className={occasion === label() ? 'is-on' : ''} onClick={() => setOccasion(label())}><span aria-hidden="true">{icon}</span>{label()}</button>
            ))}
          </div>
        </fieldset>
        <fieldset className="on-fs"><legend>{tr('When')}</legend>
          <div className="evq-when">
            <label className="on-field"><span>{tr('Day')}</span><input className="input" type="date" required min={ev.firstDay} value={day} onChange={(e) => setDay(e.target.value)} /></label>
            <label className="on-field"><span>{tr('From')}</span><input className="input" type="time" required value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label className="on-field"><span>{tr('To')}</span><input className="input" type="time" required value={to} onChange={(e) => setTo(e.target.value)} /></label>
          </div>
          <p className="on-hint">{tr('At least {n} days ahead.', { n: ev.leadDays })}</p>
        </fieldset>
        <fieldset className="on-fs"><legend>{tr('How many guests?')}</legend>
          <div className="ctg-guests">
            <span>👥</span>
            <span className="on-qty is-big">
              <button type="button" onClick={() => setGuests(Math.max(1, Number(guests) - 5))} aria-label={tr('Five fewer')}>−</button>
              <input className="ctg-guests-in" type="number" inputMode="numeric" min={ev.minGuests} max={2000} value={guests} onChange={(e) => setGuests(e.target.value)} aria-label={tr('Guests')} />
              <button type="button" onClick={() => setGuests(Math.min(2000, Number(guests) + 5))} aria-label={tr('Five more')}>+</button>
            </span>
          </div>
          {tooFew && <p className="on-dist is-bad">{tr('Events are for {n} guests or more.', { n: ev.minGuests })}</p>}
          {ev.spaces.length > 1 && (
            <div className="evq-spaces" role="radiogroup" aria-label={tr('Where')}>
              {ev.spaces.map((s) => (
                <button key={s.name} type="button" role="radio" aria-checked={space === s.name} className={(space === s.name ? 'is-on' : '') + (s.seats && Number(guests) > s.seats ? ' is-small' : '')} onClick={() => setSpace(s.name)}>
                  <strong>{s.name}</strong>{s.seats > 0 && <small>{tr('up to {n}', { n: s.seats })}</small>}
                </button>
              ))}
            </div>
          )}
        </fieldset>
        <fieldset className="on-fs"><legend>{tr('You')}</legend>
          <div className="on-two">
            <label className="on-field"><span>{tr('Your name')}</span><input className="input" required maxLength={80} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label className="on-field"><span>{tr('Phone')}</span><input className="input" required type="tel" inputMode="tel" maxLength={30} autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
          </div>
          <label className="on-field"><span>{tr('Email (optional)')}</span><input className="input" type="email" maxLength={120} autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label className="on-field"><span>{tr('Anything we should know (optional)')}</span><textarea className="input" rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr('e.g. a cake at 8 pm, a vegetarian table, music')} /></label>
        </fieldset>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <button type="submit" className="on-go is-big evq-go" disabled={busy || tooFew || !name.trim() || !phone.trim()}>{busy ? tr('Sending…') : '🥂 ' + tr('Ask for it')}</button>
      </form>
    </div>
  );
}

const STATUS = {
  enquiry: ['📨', () => tr('We have your request'), () => tr('We will call you to plan the menu, then send you the price here.')],
  quoted: ['📋', () => tr('Your plan is ready'), () => tr('Here is the menu and the price. Pay the deposit to book the day.')],
  confirmed: ['🎉', () => tr('Your event is booked'), () => tr('See you then! Call us with any change.')],
  done: ['🥂', () => tr('Thank you for celebrating with us'), null],
  cancelled: ['✕', () => tr('This event was cancelled'), () => tr('Call us with any question.')]
};

// /e/<link>: the guest's own page.
export function EventPage({ token, onMenu }) {
  const [e, setE] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { applyTheme(getInitialTheme()); }, []);
  useEffect(() => {
    let live = true;
    const load = () => posFetch('GET', '/pos/online/events/' + token).then((d) => { if (live) { setE(d); document.title = tr('Your event') + ' · ' + d.restaurant.name; } }).catch((err) => live && setError(err.message));
    load();
    const t = setInterval(load, 30000);
    return () => { live = false; clearInterval(t); };
  }, [token]);
  async function pay() {
    setBusy(true); setError(null);
    try { const r = await posFetch('POST', '/pos/online/events/' + token + '/pay'); window.location.assign(r.url); } catch (err) { setError(err.message); setBusy(false); }
  }
  if (!e) return <div className="on-shell is-empty"><div className="on-empty"><span className="on-spin" aria-hidden="true">🥂</span><strong>{error ? tr('We cannot find that event') : tr('Finding your event…')}</strong>{error && <p>{error}</p>}</div></div>;
  const st = STATUS[e.status] || STATUS.enquiry;
  const logo = restaurantLogoUrl(e.restaurant.code);
  const extras = e.extras.reduce((a, x) => a + x.amount, 0);
  return (
    <div className="on-shell on-track on-bk-page" data-brand={e.restaurant.code}>
      <header className="on-track-top">
        {logo ? <img src={logo} alt="" /> : <span aria-hidden="true">🍽️</span>}
        <div><strong>{e.restaurant.name}</strong><small>{tr('Your event')} · {e.ref}</small></div>
        <DeviceLanguage className="on-lang" />
      </header>
      <article className={'on-bk evp is-' + e.status}>
        <span className="on-bk-art" aria-hidden="true">{st[0]}</span>
        <h1>{st[1]()}</h1>
        {st[2] && <p className="on-hint is-center">{st[2]()}</p>}
        <div className="on-bk-ticket">
          <div className="is-wide"><small>{tr('Occasion')}</small><strong>{e.occasion || tr('Your event')}</strong></div>
          <div><small>{tr('When')}</small><strong>{dayWords(e.startsAt)}</strong></div>
          <div><small>{tr('Hours')}</small><strong>{hhmm(e.startsAt)}–{hhmm(e.endsAt)}</strong></div>
          <div><small>{tr('Guests')}</small><strong>{e.guests}</strong></div>
          <div><small>{tr('Where')}</small><strong>{e.space || '—'}</strong></div>
        </div>
        {e.menu.length > 0 && (
          <section className="evp-menu">
            <h2>🍽️ {tr('The menu')}</h2>
            <ul>{e.menu.map((m) => <li key={m.menuItemId}><span>{m.name}</span>{m.perGuest !== 1 && <small>{tr('{n} a guest', { n: m.perGuest })}</small>}</li>)}</ul>
          </section>
        )}
        {e.total > 0 && (
          <div className="evp-price">
            <div><span>{tr('{amount} a guest × {n}', { amount: money(e.perHead), n: e.guests })}</span><b>{money(e.perHead * e.guests)}</b></div>
            {e.extras.map((x, i) => <div key={i}><span>{x.text}</span><b>{money(x.amount)}</b></div>)}
            <div className="is-total"><span>{tr('Total')}</span><b>{money(e.perHead * e.guests + extras)}</b></div>
            {e.deposit.amount > 0 && <div className={'is-dep is-' + e.deposit.status}><span>{e.deposit.status === 'paid' ? '✅ ' + tr('Deposit paid') : tr('Deposit to book it')}</span><b>{money(e.deposit.amount)}</b></div>}
          </div>
        )}
        {e.note && <p className="on-hint is-center">💬 {e.note}</p>}
        {e.canPay && <button type="button" className="on-go is-big" disabled={busy} onClick={pay}>🔒 {tr('Pay the deposit · {amount}', { amount: money(e.deposit.amount) })}</button>}
        {e.deposit.status === 'due' && !e.canPay && e.status === 'quoted' && <p className="on-hint is-center">{tr('Call us to pay the deposit: by Mobile Money or at the restaurant.')}</p>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        {e.restaurant.phone && <a className="on-go is-ghost" href={'tel:' + e.restaurant.phone.replace(/[^\d+]/g, '')}>📞 {tr('Call {name}', { name: e.restaurant.name })}</a>}
        <button type="button" className="on-go" onClick={() => onMenu(e.restaurant.code)}>🍽️ {tr('See the menu')}</button>
      </article>
    </div>
  );
}
