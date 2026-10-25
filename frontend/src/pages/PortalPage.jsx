import { useCallback, useEffect, useState } from 'react';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import { loadToken, portalCall as call, saveToken } from '../lib/portal';
import DeviceLanguage from '../components/DeviceLanguage';
import MakeAccount from '../components/MakeAccount';
import './ShopPage.css';
import './PortalPage.css';

// "My account" on Bamboo Products' website, at /account (backend
// portal.service.js): the email or phone the customer gave us, a six-digit
// code sent there, then what is theirs — orders to follow, invoices to pay,
// quotations to approve, bookings and contracts to sign — what waits on
// them first. The session is kept on this phone (sign out to end it). A new
// customer makes an account the same way: their name, then the code.
function cedis(n) { return 'GHS ' + Number(n || 0).toLocaleString(activeIntlLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function dayWords(d) { return d ? new Date(String(d).length === 10 ? d + 'T12:00:00' : d).toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }
function whenWords(d) { return new Date(d).toLocaleString(activeIntlLocale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }); }

const ORDER = { unpaid: ['💳', () => tr('Waiting for payment')], new: ['🧾', () => tr('Received')], making: ['🛠️', () => tr('Being made')], ready: ['✅', () => tr('Ready')], out: ['🚚', () => tr('On its way')], done: ['🏁', () => tr('Done')], cancelled: ['✕', () => tr('Cancelled')] };

function SignIn({ onIn }) {
  const [mode, setMode] = useState(() => (/[?&]new=1/.test(window.location.search) ? 'new' : 'in'));
  const [address, setAddress] = useState('');
  const [sent, setSent] = useState(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function ask(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { setSent(await call('POST', '/portal/code', { address })); setCode(''); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function enter(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { const r = await call('POST', '/portal/login', { address, code }); onIn(r.token); } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <div className="ptl-in">
      <span className="ptl-in-art" aria-hidden="true"><i>🎋</i><i>🔐</i></span>
      <h1>{mode === 'new' ? tr('Create your account') : tr('My account')}</h1>
      <p>{tr('Your orders, invoices, quotations, bookings and contracts with Bamboo Products, in one place. No password: we send you a code.')}</p>
      <div className="ptl-tabs" role="tablist" aria-label={tr('My account')}>
        <button type="button" role="tab" aria-selected={mode === 'in'} className={mode === 'in' ? 'is-on' : ''} onClick={() => { setMode('in'); setError(null); }}>🔑 {tr('Sign in')}</button>
        <button type="button" role="tab" aria-selected={mode === 'new'} className={mode === 'new' ? 'is-on' : ''} onClick={() => { setMode('new'); setError(null); }}>✨ {tr('Create an account')}</button>
      </div>
      {mode === 'new' ? <MakeAccount onIn={onIn} /> : !sent ? (
        <form className="ptl-form" onSubmit={ask}>
          <label className="shp-field"><span>{tr('The email or phone number you gave us')}</span>
            <input className="input" required autoComplete="email" value={address} onChange={(e) => setAddress(e.target.value)} placeholder={tr('e.g. ama@example.com or 024 000 0000')} /></label>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <button type="submit" className="shp-go is-big" disabled={busy || address.trim().length < 5}>{busy ? tr('One moment…') : tr('Send me a code')}</button>
        </form>
      ) : (
        <form className="ptl-form" onSubmit={enter}>
          <p className="ptl-sent">{sent.kind === 'phone' ? '💬 ' : '✉️ '}{tr('If {to} is the one you gave us, a code is on its way. It works for {n} minutes.', { to: sent.to, n: sent.minutes })}</p>
          <label className="shp-field"><span>{tr('The six-digit code')}</span>
            <input className="input ptl-code" required inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="••••••" /></label>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <button type="submit" className="shp-go is-big" disabled={busy || code.length !== 6}>{busy ? tr('One moment…') : tr('Sign in')}</button>
          <button type="button" className="shp-link ptl-again" onClick={() => { setSent(null); setError(null); }}>{tr('Use another email or phone, or send it again')}</button>
        </form>
      )}
    </div>
  );
}

function Section({ icon, title, count, children, empty }) {
  return (
    <section className="ptl-sec">
      <h2><span aria-hidden="true">{icon}</span>{title}{count > 0 && <em>{count}</em>}</h2>
      {(Array.isArray(children) ? children.some(Boolean) : children) ? children : <p className="ptl-empty">{empty}</p>}
    </section>
  );
}

export default function PortalPage() {
  const [token, setToken] = useState(loadToken);
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => {
    if (!token) return;
    call('GET', '/portal/me', null, token).then((r) => { setD(r); document.title = tr('My account') + ' · Bamboo Products'; })
      .catch((e) => { if (e.status === 401) { saveToken(''); setToken(''); } else setError(e.message); });
  }, [token]);
  useEffect(() => { load(); }, [load]);
  function signIn(t) { saveToken(t); setToken(t); }
  async function signOut() { try { await call('POST', '/portal/logout', {}, token); } catch { /* the session ends here anyway */ } saveToken(''); setToken(''); setD(null); }

  return (
    <div className="shp ptl">
      <header className="ptl-head">
        <a href="/"><img src="/logo.png" alt="Bamboo Products" className="shp-logo" /></a>
        <nav className="ptl-nav"><a href="/">🛍️ {tr('Shop')}</a><a href="/book">📅 {tr('Book a visit')}</a></nav>
        <DeviceLanguage className="shp-lang ptl-lang" />
      </header>
      {!token ? <SignIn onIn={signIn} /> : !d ? (
        <div className="shp-mid ptl-wait">{error ? <p>{error}</p> : <><span className="shp-spin" aria-hidden="true">🎋</span><p>{tr('Loading…')}</p></>}</div>
      ) : (
        <>
          <section className="ptl-hero">
            <div>
              <small>{tr('Signed in as {who}', { who: d.signedInAs })}</small>
              <h1>{d.name ? tr('Hello, {name}', { name: d.name }) : tr('Hello!')}</h1>
            </div>
            <button type="button" className="ptl-out" onClick={signOut}>{tr('Sign out')}</button>
            {d.waiting && (
              <div className="ptl-chips">
                {d.waiting.toPay > 0 && <a href="#ptl-invoices" className="is-pay">💳 {tr('{amount} to pay', { amount: cedis(d.waiting.toPay) })}</a>}
                {d.waiting.toApprove > 0 && <a href="#ptl-quotes" className="is-approve">✍️ {d.waiting.toApprove === 1 ? tr('1 quotation to approve') : tr('{n} quotations to approve', { n: d.waiting.toApprove })}</a>}
                {d.waiting.toSign > 0 && <a href="#ptl-contracts" className="is-sign">📜 {d.waiting.toSign === 1 ? tr('1 contract to sign') : tr('{n} contracts to sign', { n: d.waiting.toSign })}</a>}
                {d.waiting.orders > 0 && <a href="#ptl-orders">📦 {d.waiting.orders === 1 ? tr('1 order on the way') : tr('{n} orders on the way', { n: d.waiting.orders })}</a>}
                {d.waiting.upcoming > 0 && <a href="#ptl-bookings">📅 {d.waiting.upcoming === 1 ? tr('1 booking coming up') : tr('{n} bookings coming up', { n: d.waiting.upcoming })}</a>}
                {!d.waiting.toPay && !d.waiting.toApprove && !d.waiting.toSign && !d.waiting.orders && !d.waiting.upcoming && <span>🎉 {tr('Nothing waiting on you.')}</span>}
              </div>
            )}
          </section>

          <div className="ptl-grid">
            <div id="ptl-orders"><Section icon="📦" title={tr('Orders')} count={d.waiting ? d.waiting.orders : 0} empty={tr('No orders from the shop yet.')}>
              {d.orders.length > 0 && <ul className="ptl-list">{d.orders.map((o) => (
                <li key={o.orderNo} className={o.status === 'unpaid' ? 'is-due' : ''}><span className="ptl-ico" aria-hidden="true">{ORDER[o.status][0]}</span>
                  <span className="ptl-main"><strong>{o.orderNo}</strong><small>{dayWords(o.placedAt)} · {o.items === 1 ? tr('1 item') : tr('{n} items', { n: o.items })} · {cedis(o.total)}</small></span>
                  <span className={'ptl-tag is-' + o.status}>{ORDER[o.status][1]()}</span>
                  {o.url && <a className={'ptl-btn' + (o.status === 'unpaid' ? ' is-go' : '')} href={o.url.replace(/^https?:\/\/[^/]+/, '')}>{o.status === 'unpaid' ? tr('Pay') : tr('Follow')}</a>}</li>))}</ul>}
            </Section></div>

            <div id="ptl-invoices"><Section icon="🧾" title={tr('Invoices')} count={d.waiting ? d.waiting.invoices : 0} empty={tr('No invoices yet.')}>
              {d.invoices.length > 0 && <ul className="ptl-list">{d.invoices.map((i) => (
                <li key={i.invoiceNo} className={i.status !== 'paid' ? 'is-due' + (i.overdue ? ' is-late' : '') : ''}><span className="ptl-ico" aria-hidden="true">{i.status === 'paid' ? '✅' : i.overdue ? '⏰' : '💳'}</span>
                  <span className="ptl-main"><strong>{i.invoiceNo}</strong><small>{i.status === 'paid' ? tr('Paid · {amount}', { amount: cedis(i.total) }) : i.overdue ? tr('{amount} overdue since {day}', { amount: cedis(i.balance), day: dayWords(i.dueDate) }) : tr('{amount} to pay by {day}', { amount: cedis(i.balance), day: dayWords(i.dueDate) })}</small></span>
                  <a className={'ptl-btn' + (i.status !== 'paid' ? ' is-go' : '')} href={i.url.replace(/^https?:\/\/[^/]+/, '')}>{i.status !== 'paid' ? tr('Pay') : tr('See')}</a></li>))}</ul>}
            </Section></div>

            <div id="ptl-quotes"><Section icon="📝" title={tr('Quotations and estimates')} count={d.waiting ? d.waiting.toApprove : 0} empty={tr('No quotations yet.')}>
              {(d.requests || []).length > 0 && <ul className="ptl-list ptl-requests">{d.requests.map((q) => (
                <li key={q.number} className="is-asked"><span className="ptl-ico" aria-hidden="true">📐</span>
                  <span className="ptl-main"><strong>{q.what}{q.qty > 1 ? ' × ' + q.qty : ''}</strong><small>{q.number} · {dayWords(q.createdAt)}</small></span>
                  <span className={'ptl-tag is-' + (q.status === 'quoted' ? 'making' : 'asked')}>{q.status === 'quoted' ? (q.quoteSent ? tr('Quotation sent') : tr('Being priced')) : tr('Asked for')}</span></li>))}</ul>}
              {d.quotes.length > 0 && <ul className="ptl-list">{d.quotes.map((q) => (
                <li key={q.no} className={q.toAnswer ? 'is-due' : ''}><span className="ptl-ico" aria-hidden="true">{q.answer === 'approved' || q.status === 'accepted' || q.status === 'converted' ? '✅' : q.answer === 'declined' || q.status === 'rejected' ? '✋' : '📝'}</span>
                  <span className="ptl-main"><strong>{q.no}{q.title ? ' · ' + q.title : ''}</strong><small>{cedis(q.total)}{q.validUntil ? ' · ' + tr('valid until {day}', { day: dayWords(q.validUntil) }) : ''}</small></span>
                  <a className={'ptl-btn' + (q.toAnswer ? ' is-go' : '')} href={q.url.replace(/^https?:\/\/[^/]+/, '')}>{q.toAnswer ? tr('Approve') : tr('See')}</a></li>))}</ul>}
            </Section></div>

            <div id="ptl-bookings"><Section icon="📅" title={tr('Bookings')} count={d.waiting ? d.waiting.upcoming : 0} empty={tr('No bookings. Book a visit any time.')}>
              {d.bookings.length > 0 && <ul className="ptl-list">{d.bookings.map((b, i) => (
                <li key={i}><span className="ptl-ico" aria-hidden="true">{b.status === 'cancelled' ? '✕' : b.upcoming ? '📅' : '✔️'}</span>
                  <span className="ptl-main"><strong>{b.service}</strong><small>{whenWords(b.startsAt)}{b.area ? ' · ' + b.area : ''}</small></span>
                  <a className="ptl-btn" href={b.url.replace(/^https?:\/\/[^/]+/, '')}>{tr('See')}</a></li>))}</ul>}
            </Section></div>

            <div id="ptl-contracts"><Section icon="📜" title={tr('Contracts')} count={d.waiting ? d.waiting.toSign : 0} empty={tr('No contracts yet.')}>
              {d.contracts.length > 0 && <ul className="ptl-list">{d.contracts.map((k) => (
                <li key={k.contractNo} className={k.status === 'sent' ? 'is-due' : ''}><span className="ptl-ico" aria-hidden="true">{k.status === 'signed' ? '✅' : k.status === 'declined' ? '✋' : '✍️'}</span>
                  <span className="ptl-main"><strong>{k.title}</strong><small>{k.contractNo} · {k.status === 'signed' ? tr('Signed {day}', { day: dayWords(k.signedAt) }) : k.status === 'declined' ? tr('Declined') : tr('To sign')}</small></span>
                  <a className={'ptl-btn' + (k.status === 'sent' ? ' is-go' : '')} href={k.url.replace(/^https?:\/\/[^/]+/, '')}>{k.status === 'sent' ? tr('Sign') : tr('See')}</a></li>))}</ul>}
            </Section></div>
          </div>
        </>
      )}
      <footer className="shp-foot">Bamboo Products Limited · {tr('Made in Ghana from bamboo')} 🎋</footer>
    </div>
  );
}
