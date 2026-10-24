import { useEffect, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { restaurantLogoUrl } from '../../lib/restaurantLogos';
import { tr } from '../../lib/i18n.jsx';
import { applyTheme, getInitialTheme } from '../../lib/theme';
import DeviceLanguage from '../../components/DeviceLanguage';

// Gift cards bought on the website (backend restaurantGiftCards buyOnline):
// the amount, who it is for and where to send it, a message on it; paid
// through Paystack, then back at /gp/<its secret> (GiftBoughtPage) where
// the card shows once it is paid, with its link to share.

const NOTES = [() => tr('Happy birthday! 🎂'), () => tr('Thank you! 🙏'), () => tr('Enjoy a meal on me 🍽️'), () => tr('Congratulations! 🎉')];

function CardFace({ code, name, amount, toName, fromName, message }) {
  const logo = restaurantLogoUrl(code);
  return (
    <div className="on-gift is-still" aria-hidden="true">
      <span className="on-gift-face is-front">
        <span className="on-gift-shine" />
        <span className="on-gift-top"><span>🎁 {tr('Gift card')}</span>{logo ? <img src={logo} alt="" /> : <b>{name}</b>}</span>
        <strong className="on-gift-amt">{money(amount || 0)}</strong>
        <small>{toName ? tr('For {name}', { name: toName }) : tr('to spend at {name}', { name })}{fromName ? ' · ' + tr('from {name}', { name: fromName }) : ''}</small>
        {message && <em className="on-gift-note">“{message}”</em>}
      </span>
    </div>
  );
}

export function GiftBuySheet({ code, restaurant, account, onClose }) {
  const amounts = (restaurant.gift && restaurant.gift.amounts) || [50, 100, 200];
  const [amount, setAmount] = useState(amounts[1] != null ? amounts[1] : amounts[0]);
  const [other, setOther] = useState('');
  const [toName, setToName] = useState('');
  const [via, setVia] = useState('sms');
  const [toPhone, setToPhone] = useState('');
  const [toEmail, setToEmail] = useState('');
  const [fromName, setFromName] = useState(account ? account.account.name || '' : '');
  const [message, setMessage] = useState('');
  const [buyerEmail, setBuyerEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const value = amount === 'other' ? Number(other) || 0 : amount;

  async function pay(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    const back = window.location.pathname.endsWith('-site.html') ? window.location.origin + window.location.pathname : window.location.origin + '/';
    try {
      const r = await posFetch('POST', '/pos/online/' + encodeURIComponent(code) + '/gift', null, {
        amount: value, toName, toPhone: via === 'sms' ? toPhone : '', toEmail: via === 'email' ? toEmail : '', fromName, message, buyerEmail,
        buyerPhone: account ? '+' + (account.account.phone || '') : '', back
      });
      window.location.href = r.url;
    } catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <div className="on-sheet-back" onClick={onClose}>
      <form className="on-sheet on-gb" role="dialog" aria-modal="true" aria-labelledby="on-gb-title" onClick={(e) => e.stopPropagation()} onSubmit={pay}>
        <div className="on-co-head">
          <button type="button" className="on-x is-plain" onClick={onClose} aria-label={tr('Close')}>←</button>
          <h2 id="on-gb-title">{tr('Send a gift card')}</h2>
        </div>
        <CardFace code={restaurant.code} name={restaurant.name} amount={value} toName={toName.trim()} fromName={fromName.trim()} message={message.trim()} />

        <fieldset className="on-fs">
          <legend>{tr('How much?')}</legend>
          <div className="on-gb-amts" role="radiogroup" aria-label={tr('How much?')}>
            {amounts.map((a) => (
              <button key={a} type="button" role="radio" aria-checked={amount === a} className={amount === a ? 'is-on' : ''} onClick={() => setAmount(a)}>{money(a)}</button>
            ))}
            <button type="button" role="radio" aria-checked={amount === 'other'} className={amount === 'other' ? 'is-on' : ''} onClick={() => setAmount('other')}>{tr('Other')}</button>
          </div>
          {amount === 'other' && (
            <label className="on-field"><span>{tr('Amount (GHS 10 to 5,000)')}</span>
              <input className="input" type="number" inputMode="decimal" min="10" max="5000" step="1" required autoFocus value={other} onChange={(e) => setOther(e.target.value)} /></label>
          )}
        </fieldset>

        <fieldset className="on-fs">
          <legend>{tr('Who is it for?')}</legend>
          <label className="on-field"><span>{tr('Their name')}</span><input className="input" required maxLength={60} value={toName} onChange={(e) => setToName(e.target.value)} placeholder={tr('e.g. Ama')} /></label>
          <div className="on-how is-pay" role="radiogroup" aria-label={tr('Send it by')}>
            <button type="button" role="radio" aria-checked={via === 'sms'} className={via === 'sms' ? 'is-on' : ''} onClick={() => setVia('sms')}><span aria-hidden="true">💬</span><strong>{tr('Text message')}</strong></button>
            <button type="button" role="radio" aria-checked={via === 'email'} className={via === 'email' ? 'is-on' : ''} onClick={() => setVia('email')}><span aria-hidden="true">✉️</span><strong>{tr('Email')}</strong></button>
          </div>
          {via === 'sms'
            ? <label className="on-field"><span>{tr('Their phone number')}</span><input className="input" type="tel" inputMode="tel" required value={toPhone} onChange={(e) => setToPhone(e.target.value)} placeholder="024 000 0000" /></label>
            : <label className="on-field"><span>{tr('Their email')}</span><input className="input" type="email" required value={toEmail} onChange={(e) => setToEmail(e.target.value)} placeholder="name@example.com" /></label>}
        </fieldset>

        <fieldset className="on-fs">
          <legend>{tr('From you')}</legend>
          <label className="on-field"><span>{tr('Your name')}</span><input className="input" required maxLength={60} autoComplete="name" value={fromName} onChange={(e) => setFromName(e.target.value)} /></label>
          <label className="on-field"><span>{tr('A message on the card (optional)')}</span>
            <textarea className="input" rows={2} maxLength={200} value={message} onChange={(e) => setMessage(e.target.value)} /></label>
          <div className="on-gb-notes">
            {NOTES.map((n) => <button key={n()} type="button" onClick={() => setMessage(n())}>{n()}</button>)}
          </div>
          <label className="on-field"><span>{tr('Your email, for a copy (optional)')}</span><input className="input" type="email" autoComplete="email" value={buyerEmail} onChange={(e) => setBuyerEmail(e.target.value)} /></label>
        </fieldset>

        {error && <div className="error-banner" role="alert">{error}</div>}
        <button type="submit" className="on-go is-big" disabled={busy || !(value >= 10)}>
          {busy ? tr('One moment…') : tr('Pay {amount}', { amount: money(value) })}
        </button>
        <p className="on-hint is-center">{tr('By card or Mobile Money through Paystack. The card is sent as soon as it is paid.')}</p>
      </form>
    </div>
  );
}

// /gp/<secret>: back from Paystack — paid or not, then the card to share.
export function GiftBoughtPage({ secret, onMenu }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { applyTheme(getInitialTheme()); }, []);
  useEffect(() => {
    let live = true, tries = 0, timer = null;
    const load = () => posFetch('GET', '/pos/online/gift-bought/' + secret)
      .then((r) => {
        if (!live) return;
        setD(r); document.title = tr('Gift card') + ' · ' + r.restaurant.name;
        if (r.status === 'pending' && ++tries < 40) timer = setTimeout(load, 3000);
      })
      .catch((e) => live && setError(e.message));
    load();
    return () => { live = false; clearTimeout(timer); };
  }, [secret]);
  async function copy() {
    try { await navigator.clipboard.writeText(d.card.link); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* the link is on the button too */ }
  }
  if (!d) return <div className="on-shell is-empty"><div className="on-empty"><span className="on-spin" aria-hidden="true">🎁</span><strong>{error ? tr('We cannot find that gift card payment') : tr('Checking your payment…')}</strong>{error && <p>{error}</p>}</div></div>;
  const logo = restaurantLogoUrl(d.restaurant.code);
  const failed = d.status === 'failed' || d.status === 'abandoned';
  return (
    <div className="on-shell on-track on-gift-page" data-brand={d.restaurant.code}>
      <header className="on-track-top">
        {logo ? <img src={logo} alt="" /> : <span aria-hidden="true">🍽️</span>}
        <div><strong>{d.restaurant.name}</strong><small>{tr('Gift card')}</small></div>
        <DeviceLanguage className="on-lang" />
      </header>
      {failed ? (
        <div className="on-bk is-declined">
          <span className="on-bk-art" aria-hidden="true">😕</span>
          <h1>{tr('The payment did not go through')}</h1>
          <p className="on-hint">{tr('Nothing was taken. You can try again.')}</p>
          <button type="button" className="on-go" onClick={() => onMenu(d.restaurant.code)}>{tr('Back to the menu')}</button>
        </div>
      ) : !d.card ? (
        <div className="on-bk">
          <span className="on-bk-art on-spin" aria-hidden="true">⏳</span>
          <h1>{tr('Checking your payment…')}</h1>
          <p className="on-hint">{tr('This takes a few seconds. Mobile Money may ask you to approve on your phone.')}</p>
        </div>
      ) : (
        <>
          <div className="on-gb-done">
            <span className="on-gb-confetti" aria-hidden="true">{['🎉', '✨', '🎁', '💛', '🎊'].map((x, i) => <i key={i} style={{ '--i': i }}>{x}</i>)}</span>
            <h1>{tr('Your gift card for {name} is paid!', { name: d.toName.replace(/^zq\s+/i, '').split(' ')[0] })}</h1>
            <p>{d.toPhone ? tr('We are texting it to them now.') : d.toEmail ? tr('We are emailing it to them now.') : tr('Send them its link below.')}</p>
          </div>
          <CardFace code={d.restaurant.code} name={d.restaurant.name} amount={d.amount} toName={d.toName} fromName={d.fromName} message={d.message} />
          <div className="on-gb-share">
            <a className="on-go" href={d.card.whatsapp} target="_blank" rel="noreferrer">💬 {tr('Send it on WhatsApp too')}</a>
            <button type="button" className="on-go is-ghost" onClick={copy}>{copied ? '✓ ' + tr('Copied') : '🔗 ' + tr('Copy the link')}</button>
            <a className="on-go is-ghost" href={d.card.link}>🎁 {tr('Open the card')}</a>
          </div>
          <p className="on-hint is-center">{tr('Card number {code}', { code: d.card.codeWords })}</p>
          <button type="button" className="on-go is-ghost" onClick={() => onMenu(d.restaurant.code)}>🍽️ {tr('Back to the menu')}</button>
        </>
      )}
    </div>
  );
}
