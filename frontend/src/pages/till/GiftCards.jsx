import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';

// Gift cards on the till (backend restaurantGiftCards): sold for cash or
// Mobile Money into the drawer, with a 16-digit number and a link to the
// card's own page (sent by WhatsApp or text, or its QR code shown); looked
// up by their number (what is left, what was spent); cancelled by a manager
// (what is left given back in cash).

const KIND = { sold: () => tr('Sold'), redeem: () => tr('Spent'), refund: () => tr('Back on the card'), void: () => tr('Cancelled') };

export function GiftCardFace({ card, companyName }) {
  const [qr, setQr] = useState(null);
  useEffect(() => {
    let live = true;
    if (card.link) QRCode.toDataURL(card.link, { margin: 1, width: 220, color: { dark: '#111827', light: '#ffffff' } }).then((d) => { if (live) setQr(d); }).catch(() => {});
    return () => { live = false; };
  }, [card.link]);
  return (
    <div className={'gc-face' + (card.status === 'void' ? ' is-void' : '')}>
      <span className="gc-face-shine" aria-hidden="true" />
      <div className="gc-face-top"><span>🎁 {tr('Gift card')}</span><b>{companyName}</b></div>
      <strong className="gc-face-amount">{money(card.amount)}</strong>
      {card.toName && <span className="gc-face-to">{tr('For {name}', { name: card.toName })}{card.fromName ? ' · ' + tr('from {name}', { name: card.fromName }) : ''}</span>}
      {card.message && <em className="gc-face-msg">“{card.message}”</em>}
      <div className="gc-face-foot">
        <code>{card.codeWords}</code>
        {qr && <img src={qr} alt={tr('QR code of the gift card')} />}
      </div>
    </div>
  );
}

export default function GiftCards({ token, settings, companyName, can, onToast, onClose, onSold }) {
  const amounts = (settings.giftCards && settings.giftCards.amounts) || [50, 100, 200, 500];
  const [tab, setTab] = useState('sell');
  const [form, setForm] = useState({ amount: amounts[1] || amounts[0], own: '', method: 'cash', toName: '', toPhone: '', fromName: '', message: '' });
  const [card, setCard] = useState(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [voiding, setVoiding] = useState(null);

  const amount = form.own !== '' ? Number(form.own) : form.amount;
  async function sell(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const c = await posFetch('POST', '/pos/gift-cards', token, { amount, method: form.method, toName: form.toName, toPhone: form.toPhone, fromName: form.fromName, message: form.message });
      setCard(c);
      onToast(tr('Gift card of {amount} sold.', { amount: money(c.amount) }));
      if (onSold) onSold(c);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function find(e) {
    if (e) e.preventDefault();
    setBusy(true); setError(null); setCard(null);
    try { setCard(await posFetch('GET', '/pos/gift-cards/' + encodeURIComponent(code.replace(/\D/g, '')), token)); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function send(channel) {
    setBusy(true); setError(null);
    try {
      const r = await posFetch('POST', '/pos/gift-cards/' + card.id + '/send', token, { channel, phone: card.toPhone });
      if (r.url) window.open(r.url, '_blank', 'noopener'); else onToast(tr('Texted the gift card.'));
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function cancelCard(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      setCard(await posFetch('POST', '/pos/gift-cards/' + card.id + '/void', token, { managerPin: voiding.pin, reason: voiding.reason }));
      setVoiding(null);
      onToast(tr('Gift card cancelled.'));
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <div className="dialog pos-panel gc" role="dialog" aria-modal="true" aria-labelledby="gc-title" onClick={(e) => e.stopPropagation()}>
        <header className="bk-head">
          <span className="bk-ico is-gift" aria-hidden="true">🎁</span>
          <div><h2 id="gc-title">{tr('Gift cards')}</h2><p className="dk-muted">{tr('Sold into the drawer, spent like money at the till.')}</p></div>
        </header>
        <div className="dk-segment" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'sell'} className={tab === 'sell' ? 'is-on' : ''} onClick={() => { setTab('sell'); setCard(null); setError(null); }}>{tr('Sell a card')}</button>
          <button type="button" role="tab" aria-selected={tab === 'find'} className={tab === 'find' ? 'is-on' : ''} onClick={() => { setTab('find'); setCard(null); setError(null); }}>{tr('Look up a card')}</button>
        </div>

        {card ? (
          <div className="gc-done">
            <GiftCardFace card={card} companyName={companyName} />
            <div className="gc-side">
              <p className="gc-left"><span>{tr('Left on it')}</span><b>{money(card.balance)}</b></p>
              {card.status === 'void' && <p className="tl-pay-acct is-bad"><span>{tr('Cancelled: {why}', { why: card.voidReason })}</span></p>}
              {card.status === 'active' && (
                <div className="gc-send">
                  <button type="button" className="btn btn-primary tl-btn" disabled={busy} onClick={() => send('whatsapp')}>💬 {tr('Send by WhatsApp')}</button>
                  <button type="button" className="btn btn-secondary tl-btn" disabled={busy} onClick={() => send('sms')}>📱 {tr('Send by text')}</button>
                  <button type="button" className="btn btn-secondary tl-btn" onClick={() => { if (navigator.clipboard) navigator.clipboard.writeText(card.link); onToast(tr('Link copied.')); }}>🔗 {tr('Copy the link')}</button>
                </div>
              )}
              {(card.entries || []).length > 0 && (
                <ul className="gc-entries is-plain">
                  {card.entries.map((x) => (
                    <li key={x.id}><span>{(KIND[x.kind] || KIND.sold)()}{x.orderNo ? ' · ' + x.orderNo : ''}<small>{new Date(x.createdAt).toLocaleString(activeIntlLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}{x.by ? ' · ' + x.by : ''}</small></span>
                      <b className={x.amount < 0 ? 'gc-out' : 'gc-in'}>{x.amount < 0 ? '−' : '+'}{money(Math.abs(x.amount))}</b></li>
                  ))}
                </ul>
              )}
              {card.status === 'active' && can('giftCards') && !voiding && <button type="button" className="pos-link is-bad" onClick={() => setVoiding({ pin: '', reason: '' })}>{tr('Cancel this card…')}</button>}
              {voiding && (
                <form className="gc-void" onSubmit={cancelCard}>
                  <p className="dk-muted">{tr('What is left on it ({amount}) is given back in cash from your drawer.', { amount: money(card.balance) })}</p>
                  <input className="input" required minLength={3} value={voiding.reason} onChange={(e) => setVoiding({ ...voiding, reason: e.target.value })} placeholder={tr('Why, e.g. sold by mistake')} />
                  <input className="input" type="password" inputMode="numeric" maxLength={4} required value={voiding.pin} onChange={(e) => setVoiding({ ...voiding, pin: e.target.value.replace(/\D/g, '') })} placeholder={tr('Manager PIN')} />
                  <button type="submit" className="btn btn-danger tl-btn" disabled={busy}>{tr('Cancel the card')}</button>
                </form>
              )}
            </div>
          </div>
        ) : tab === 'sell' ? (
          <form className="gc-sell" onSubmit={sell}>
            <div className="field"><span>{tr('Amount')}</span>
              <div className="tl-chips">
                {amounts.map((a) => <button key={a} type="button" className={'tl-chip gc-amt' + (form.own === '' && form.amount === a ? ' is-on' : '')} onClick={() => setForm({ ...form, amount: a, own: '' })}>{money(a)}</button>)}
                <input className="input gc-own" type="number" min="1" step="1" inputMode="decimal" value={form.own} onChange={(e) => setForm({ ...form, own: e.target.value })} placeholder={tr('Other')} aria-label={tr('Another amount')} />
              </div>
            </div>
            <div className="bk-grid">
              <label className="field"><span>{tr('For (optional)')}</span><input className="input" maxLength={60} value={form.toName} onChange={(e) => setForm({ ...form, toName: e.target.value })} /></label>
              <label className="field"><span>{tr('Their phone (to send it)')}</span><input className="input" type="tel" value={form.toPhone} onChange={(e) => setForm({ ...form, toPhone: e.target.value })} placeholder="024 000 0000" /></label>
              <label className="field"><span>{tr('From (optional)')}</span><input className="input" maxLength={60} value={form.fromName} onChange={(e) => setForm({ ...form, fromName: e.target.value })} /></label>
              <label className="field bk-wide"><span>{tr('A message (optional)')}</span><input className="input" maxLength={200} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} placeholder={tr('e.g. Happy birthday!')} /></label>
            </div>
            <div className="field"><span>{tr('Paid with')}</span>
              <div className="dk-segment" role="radiogroup">
                {['cash', 'mobile_money'].map((m) => <button key={m} type="button" role="radio" aria-checked={form.method === m} className={form.method === m ? 'is-on' : ''} onClick={() => setForm({ ...form, method: m })}>{m === 'cash' ? '💵 ' + tr('Cash') : '📱 ' + tr('Mobile Money')}</button>)}
              </div>
            </div>
            {error && <div className="error-banner">{error}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Close')}</button>
              <button type="submit" className="btn btn-primary" disabled={busy || !(amount >= 1) || !can('giftCards')}>{busy ? tr('Selling…') : tr('Sell a card of {amount}', { amount: money(amount || 0) })}</button>
            </div>
          </form>
        ) : (
          <form className="gc-find" onSubmit={find}>
            <label className="pos-big-label" htmlFor="gc-code">{tr('The number on the gift card')}</label>
            <input id="gc-code" className="input pos-big-input" inputMode="numeric" autoFocus value={code} placeholder="0000 0000 0000 0000"
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 16).replace(/(\d{4})(?=\d)/g, '$1 '))} />
            {error && <div className="error-banner">{error}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Close')}</button>
              <button type="submit" className="btn btn-primary" disabled={busy || code.replace(/\D/g, '').length !== 16}>{tr('Look it up')}</button>
            </div>
          </form>
        )}
        {card && (
          <div className="dialog-actions">
            <button type="button" className="btn btn-secondary" onClick={() => { setCard(null); setCode(''); setForm({ ...form, toName: '', toPhone: '', fromName: '', message: '' }); }}>{tab === 'sell' ? tr('Sell another') : tr('Look up another')}</button>
            <button type="button" className="btn btn-primary" onClick={onClose}>{tr('Done')}</button>
          </div>
        )}
      </div>
    </div>
  );
}
