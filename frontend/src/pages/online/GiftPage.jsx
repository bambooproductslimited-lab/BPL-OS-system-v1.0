import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { restaurantLogoUrl } from '../../lib/restaurantLogos';
import { tr } from '../../lib/i18n.jsx';
import { applyTheme, getInitialTheme } from '../../lib/theme';
import DeviceLanguage from '../../components/DeviceLanguage';

// /g/<link>: a gift card's own page (backend restaurantGiftCards
// publicCard), sent to whoever it is for: the card with its message, what
// is left on it, and its number and QR code to show at the till.

export default function GiftPage({ token }) {
  const [c, setC] = useState(null);
  const [error, setError] = useState(null);
  const [qr, setQr] = useState(null);
  const [flip, setFlip] = useState(false);
  useEffect(() => { applyTheme(getInitialTheme()); }, []);
  useEffect(() => {
    posFetch('GET', '/pos/online/gift/' + token).then((d) => { setC(d); document.title = tr('Gift card') + ' · ' + d.restaurant.name; }).catch((e) => setError(e.message));
  }, [token]);
  useEffect(() => {
    if (!c) return;
    QRCode.toDataURL(c.code, { margin: 1, width: 240, color: { dark: '#111827', light: '#ffffff' } }).then(setQr).catch(() => {});
  }, [c]);
  if (!c) return <div className="on-shell is-empty"><div className="on-empty"><span className="on-spin" aria-hidden="true">🎁</span><strong>{error ? tr('We cannot find that gift card') : tr('Opening your gift card…')}</strong>{error && <p>{error}</p>}</div></div>;
  const logo = restaurantLogoUrl(c.restaurant.code);
  const used = c.balance <= 0;
  return (
    <div className="on-shell on-track on-gift-page" data-brand={c.restaurant.code}>
      <header className="on-track-top">
        {logo ? <img src={logo} alt="" /> : <span aria-hidden="true">🍽️</span>}
        <div><strong>{c.restaurant.name}</strong><small>{tr('Gift card')}</small></div>
        <DeviceLanguage className="on-lang" />
      </header>
      {c.toName && <h1 className="on-gift-hi">{tr('A gift for you, {name}!', { name: c.toName.split(' ')[0] })}</h1>}
      <button type="button" className={'on-gift' + (flip ? ' is-flipped' : '') + (c.status === 'void' ? ' is-void' : used ? ' is-used' : '')} onClick={() => setFlip(!flip)} aria-label={tr('Turn the card over')}>
        <span className="on-gift-face is-front">
          <span className="on-gift-shine" aria-hidden="true" />
          <span className="on-gift-top"><span>🎁 {tr('Gift card')}</span>{logo ? <img src={logo} alt="" /> : <b>{c.restaurant.name}</b>}</span>
          <strong className="on-gift-amt">{money(c.balance)}</strong>
          <small>{c.balance < c.amount ? tr('left of {amount}', { amount: money(c.amount) }) : tr('to spend at {name}', { name: c.restaurant.name })}</small>
          <code>{c.codeWords}</code>
        </span>
        <span className="on-gift-face is-back">
          {qr && <img src={qr} alt={tr('QR code of the gift card')} />}
          <code>{c.codeWords}</code>
          <small>{tr('Show this at the till to pay with it.')}</small>
        </span>
      </button>
      <p className="on-hint is-center">{tr('Tap the card to turn it over.')}</p>
      {c.status === 'void' && <div className="error-banner" role="alert">{tr('This gift card was cancelled.')}</div>}
      {c.message && (
        <blockquote className="on-gift-msg">
          <p>“{c.message}”</p>
          {c.fromName && <footer>— {c.fromName}</footer>}
        </blockquote>
      )}
      <ul className="on-gift-how is-plain">
        <li><span aria-hidden="true">1</span>{tr('Order at {name} as usual.', { name: c.restaurant.name })}</li>
        <li><span aria-hidden="true">2</span>{tr('Pay with "Gift card" and show this card. The rest can be paid another way.')}</li>
        <li><span aria-hidden="true">3</span>{tr('What is left stays on the card for next time.')}</li>
      </ul>
      {c.restaurant.website && <a className="on-go" href={c.restaurant.website}>🍽️ {tr('See the menu')}</a>}
    </div>
  );
}
