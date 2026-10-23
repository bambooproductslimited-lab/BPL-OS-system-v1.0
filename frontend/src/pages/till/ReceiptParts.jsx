import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { tr } from '../../lib/i18n.jsx';
import { modsWords, serviceWords } from './tillBill';

// A sale's receipt on the till (RestaurantPosPage.jsx): its dishes with
// their add-ons, discounts and dishes on the house, then the dishes'
// total, the discounts, the service charge and the taxes (backend
// restaurantPos rowToOrder); and the receipt sent to the customer — a QR
// code to scan, or a WhatsApp or text message with its link
// (restaurantPos sendReceipt).

export function ReceiptLines({ receipt: r }) {
  const extras = (r.discountTotal || 0) > 0 || (r.serviceCharge || 0) > 0 || (r.taxes || []).length > 0;
  return (
    <>
      <div className="pos-receipt-lines">
        {r.items.map((it, i) => (
          <div key={i} className="pos-receipt-line">
            <span>
              {it.qty} × {it.name}
              {(it.modifiers || []).length > 0 && <small className="pos-receipt-mods">+ {modsWords(it.modifiers, tr)}</small>}
              {it.note ? <small className="pos-receipt-note">✎ {it.note}</small> : null}
              {it.compReason ? <small className="pos-receipt-off">{tr('On the house')} · {it.compReason}</small>
                : it.discount > 0 && it.discountName && !(r.billDiscount && it.discountName === r.billDiscount.name) ? <small className="pos-receipt-off">{it.discountName} −{money(it.discount)}</small> : null}
            </span>
            <span>{it.discount > 0 && it.gross != null ? <s>{money(it.gross)}</s> : null}{money(it.lineTotal)}</span>
          </div>
        ))}
      </div>
      <div className="pos-receipt-rule" />
      {extras && (
        <div className="pos-receipt-lines pos-receipt-sums">
          <div className="pos-receipt-line"><span>{tr('Dishes')}</span><span>{money(r.itemsGross != null ? r.itemsGross : r.subtotal)}</span></div>
          {r.discountTotal > 0 && <div className="pos-receipt-line"><span>{tr('Discounts')}{r.billDiscount ? ' (' + r.billDiscount.name + ')' : ''}</span><span>−{money(r.discountTotal)}</span></div>}
          {r.serviceCharge > 0 && <div className="pos-receipt-line"><span>{serviceWords(r.serviceName, tr)} {r.serviceRate ? r.serviceRate + '%' : ''}</span><span>{money(r.serviceCharge)}</span></div>}
          {(r.taxes || []).filter((t) => !t.included).map((t) => <div key={t.name} className="pos-receipt-line"><span>{t.name} {t.rate}%</span><span>{money(t.amount)}</span></div>)}
        </div>
      )}
      <div className="pos-receipt-total">
        <span>{tr('Total')}</span><span>{money(r.total)}</span>
      </div>
      {(r.taxes || []).some((t) => t.included) && (
        <div className="pos-receipt-taxes">
          {r.taxes.filter((t) => t.included).map((t) => <div key={t.name} className="pos-receipt-line"><span>{tr('incl. {tax} {rate}%', { tax: t.name, rate: t.rate })}</span><span>{money(t.amount)}</span></div>)}
        </div>
      )}
      {r.tip > 0 && (
        <div className="pos-receipt-lines pos-receipt-sums">
          <div className="pos-receipt-line"><span>{tr('Tip')}</span><span>{money(r.tip)}</span></div>
          <div className="pos-receipt-line is-paid"><span>{tr('Paid')}</span><span>{money(r.total + r.tip)}</span></div>
        </div>
      )}
      {(() => {
        const pts = r.points || { earned: r.pointsEarned || 0, used: r.pointsUsed || 0, balance: null };
        if (!pts.earned && !pts.used) return null;
        return (
          <p className="pos-receipt-points">⭐ {[pts.used ? tr('{n} points spent', { n: pts.used }) : null, pts.earned ? tr('{n} points earned', { n: pts.earned }) : null,
            pts.balance != null ? tr('{n} points now', { n: pts.balance }) : null].filter(Boolean).join(' · ')}</p>
        );
      })()}
    </>
  );
}

// The receipt's link as a QR code, for the customer to scan, and printed.
export function ReceiptQr({ url, className }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let live = true;
    if (url) QRCode.toDataURL(url, { margin: 1, width: 240, errorCorrectionLevel: 'M', color: { dark: '#111827', light: '#ffffff' } }).then((d) => { if (live) setSrc(d); }).catch(() => {});
    return () => { live = false; };
  }, [url]);
  if (!url || !src) return null;
  return <img className={className} src={src} alt={tr('QR code of the receipt')} />;
}

// Sent to the customer's phone: WhatsApp opens with the message written
// (the cashier presses send), or a text message goes from the restaurant.
export function SendReceipt({ token, receipt, companyName, onToast, onSent }) {
  const [phone, setPhone] = useState(receipt.customerPhone || receipt.guestPhone || '');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [sends, setSends] = useState(receipt.receiptSends || []);
  if (!receipt.receiptUrl || receipt.offline) return null;
  async function send(channel) {
    setBusy(channel); setError(null);
    // A window opened now, before the server answers, is not blocked as a pop-up.
    const win = channel === 'whatsapp' ? window.open('', '_blank') : null;
    try {
      const text = tr('Thank you for coming to {name}. Your receipt {no} ({amount}): {link}', { name: companyName, no: receipt.orderNo, amount: money(receipt.total), link: receipt.receiptUrl });
      const r = await posFetch('POST', '/pos/orders/' + receipt.id + '/receipt/send', token, { channel, phone, text });
      if (channel === 'whatsapp') { if (win) win.location.href = r.url; else window.open(r.url, '_blank'); }
      else onToast(tr('Receipt texted to {phone}.', { phone }));
      const next = sends.concat([{ channel, to: phone, at: new Date().toISOString() }]);
      setSends(next);
      if (onSent) onSent(next);
    } catch (e) {
      if (win) win.close();
      setError(e.message || tr('No answer from the server.'));
    } finally { setBusy(null); }
  }
  return (
    <div className="tl-send-receipt">
      <ReceiptQr url={receipt.receiptUrl} className="tl-send-qr" />
      <div className="tl-send-receipt-main">
        <strong>{tr('A receipt on their phone')}</strong>
        <small>{tr('They scan the code, or it goes to their WhatsApp or by text message.')}</small>
        <div className="tl-send-receipt-row">
          <input className="input" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={tr('Their phone, e.g. 024 412 3456')} aria-label={tr('Customer\'s phone')} />
          <button type="button" className="btn tl-wa" disabled={!phone.trim() || !!busy} onClick={() => send('whatsapp')}>{busy === 'whatsapp' ? tr('Opening…') : 'WhatsApp'}</button>
          <button type="button" className="btn btn-secondary" disabled={!phone.trim() || !!busy} onClick={() => send('sms')}>{busy === 'sms' ? tr('Sending…') : tr('Text it')}</button>
        </div>
        {error && <div className="error-banner">{error}</div>}
        {sends.length > 0 && (
          <ul className="tl-send-receipt-sent is-plain">
            {sends.map((x, i) => <li key={i}>✓ {x.channel === 'sms' ? tr('Texted to {phone}', { phone: x.to }) : tr('WhatsApp to {phone}', { phone: x.to })}</li>)}
          </ul>
        )}
      </div>
    </div>
  );
}
