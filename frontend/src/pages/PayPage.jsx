import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { API_URL } from '../api/client';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import DeviceLanguage from '../components/DeviceLanguage';
import './ShopPage.css';
import './PayPage.css';

// A payment link's page at /pay/<its link> (backend paymentLinks.service.js):
// public, outside the OS's frame, on Bamboo Products' customer website. What
// it is for and how much (or a box to type the amount), who is paying (a
// link made for a customer asks nothing), then Paystack's page to pay by
// card or Mobile Money — or, without online payments, the invoice's page
// with the bank details.

async function call(method, path, body) {
  const r = await fetch(API_URL + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || tr('Something went wrong. Please try again.'));
  return j;
}
function cedis(n) { return 'GHS ' + Number(n || 0).toLocaleString(activeIntlLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
const QUICK = [100, 200, 500, 1000];
const STATES = {
  paid: ['🎉', () => tr('This link has been paid'), () => tr('Thank you! Nothing more to pay here.')],
  expired: ['⌛', () => tr('This link has expired'), () => tr('Ask us for a new one and we will send it right away.')],
  paused: ['⏸️', () => tr('This link is paused'), () => tr('It is not taking payments for now. Please contact us.')],
  closed: ['🔒', () => tr('This link is closed'), () => tr('Ask us for a new one and we will send it right away.')]
};

export default function PayPage() {
  const { token } = useParams();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [f, setF] = useState({ name: '', phone: '', email: '', amount: '', note: '' });
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState(null);
  useEffect(() => { call('GET', '/pay/' + encodeURIComponent(token)).then((r) => { setD(r); document.title = r.title + ' · Bamboo Products'; }).catch((e) => setError(e.message)); }, [token]);

  async function pay(e) {
    e.preventDefault();
    setBusy(true); setSendError(null);
    try {
      const r = await call('POST', '/pay/' + encodeURIComponent(token), { ...f, amount: d.kind === 'open' ? Number(f.amount) : undefined, website: '' });
      window.location.assign(r.payUrl || '/share/' + r.token);
    } catch (err) { setSendError(err.message); setBusy(false); }
  }

  if (error) return <div className="shp shp-mid pyl"><img src="/logo.png" alt="Bamboo Products Limited" className="shp-logo" /><h1>{tr('We cannot find that payment link')}</h1><p>{error}</p></div>;
  if (!d) return <div className="shp shp-mid pyl"><span className="shp-spin" aria-hidden="true">💳</span><p>{tr('Loading…')}</p></div>;
  const amount = d.kind === 'open' ? Number(f.amount) || 0 : d.total;
  const st = STATES[d.state];
  return (
    <div className="shp pyl">
      <div className="pyl-wrap">
        <header className="pyl-card">
          <span className="pyl-glow" aria-hidden="true" />
          <div className="pyl-top">
            <img src="/logo.png" alt="" className="shp-logo" />
            <span className="pyl-brand">Bamboo Products<small>{tr('Secure payment')}</small></span>
            <DeviceLanguage className="shp-lang" />
          </div>
          {d.forName && <p className="pyl-hi">{tr('Hello {name} 👋', { name: d.forName })}</p>}
          <h1>{d.title}</h1>
          {d.description && <p className="pyl-desc">{d.description}</p>}
          {d.kind !== 'open' && <div className="pyl-amount"><small>{tr('To pay')}</small><strong>{cedis(d.total)}</strong></div>}
          {d.kind === 'items' && (
            <ul className="pyl-lines">
              {d.lines.map((l, i) => <li key={i}><b>{l.qty}×</b><span>{l.description}</span><em>{cedis(l.unitPrice * l.qty * (1 + (l.taxRate || 0) / 100))}</em></li>)}
            </ul>
          )}
        </header>

        {st ? (
          <section className="pyl-state">
            <span aria-hidden="true">{st[0]}</span>
            <h2>{st[1]()}</h2>
            <p>{st[2]()}</p>
          </section>
        ) : (
          <form className="pyl-form" onSubmit={pay}>
            {d.kind === 'open' && (
              <div className="pyl-open">
                <label className="shp-field"><span>{tr('How much would you like to pay?')}</span>
                  <span className="pyl-cedi"><b>GHS</b><input className="input" type="number" inputMode="decimal" min="1" step="0.01" required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="0.00" /></span>
                </label>
                <div className="pyl-quick">{QUICK.map((q) => <button key={q} type="button" className={Number(f.amount) === q ? 'is-on' : ''} onClick={() => setF({ ...f, amount: String(q) })}>{cedis(q).replace('.00', '')}</button>)}</div>
              </div>
            )}
            {!d.forName && (
              <>
                <label className="shp-field"><span>{tr('Your name')}</span><input className="input" required maxLength={120} autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
                <div className="shp-two">
                  <label className="shp-field"><span>{tr('Phone number')}</span><input className="input" type="tel" inputMode="tel" required autoComplete="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="024 000 0000" /></label>
                  <label className="shp-field"><span>{tr('Email (for the receipt)')}</span><input className="input" type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
                </div>
              </>
            )}
            <label className="shp-field"><span>{tr('A note for us (optional)')}</span><input className="input" maxLength={300} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder={tr('e.g. your order or invoice number')} /></label>
            {sendError && <div className="error-banner" role="alert">{sendError}</div>}
            <button type="submit" className="shp-go is-big pyl-go" disabled={busy || !(amount >= 1)}>
              {busy ? tr('One moment…') : d.payOnline ? '💳 ' + tr('Pay {amount}', { amount: cedis(amount) }) : '🧾 ' + tr('Continue · {amount}', { amount: cedis(amount) })}
            </button>
            <p className="pyl-safe">{d.payOnline ? <>🔒 {tr('Card or Mobile Money, through Paystack. We never see your card.')}</> : <>🏦 {tr('Next: your invoice, with our bank and Mobile Money details.')}</>}</p>
            <div className="pyl-ways" aria-hidden="true">{d.payOnline && <><span>VISA</span><span>Mastercard</span><span>MTN MoMo</span><span>Telecel Cash</span><span>AT Money</span></>}</div>
          </form>
        )}
        <footer className="shp-foot">Bamboo Products Limited · {tr('Made in Ghana from bamboo')} 🎋</footer>
      </div>
    </div>
  );
}
