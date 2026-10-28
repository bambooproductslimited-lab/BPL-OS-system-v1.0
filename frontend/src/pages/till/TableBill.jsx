import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { tr } from '../../lib/i18n.jsx';
import { buildBillBytes } from '../../lib/thermalPrinter';
import './fifth.css';
import { modsWords, serviceWords } from './tillBill';

// The bill for a table's open order (backend restaurantTablePay link): its
// dishes and sums, what guests paid from their phones already, and — when
// the restaurant takes payment at the table — a QR code to pay it by card
// or Mobile Money, split or with a tip. Shown on the till to turn towards
// the guest, and printed: on the thermal printer with its QR code, or on
// any printer through the browser.

export default function TableBill({ token, tab, companyName, printer, onClose, onFail }) {
  const [link, setLink] = useState(null);
  const [qr, setQr] = useState(null);
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    let live = true;
    posFetch('GET', '/pos/table-pay/link?tabId=' + encodeURIComponent(tab.id), token).then(async (l) => {
      if (!live) return;
      setLink(l);
      if (l.on) { const pic = await QRCode.toDataURL(l.url, { margin: 1, width: 360, errorCorrectionLevel: 'M', color: { dark: '#111827', light: '#ffffff' } }); if (live) setQr(pic); }
    }).catch((e) => onFail(e));
    return () => { live = false; };
  }, [tab.id, token]); // eslint-disable-line react-hooks/exhaustive-deps
  const paid = (tab.paidAtTable || []).reduce((a, p) => a + p.amount - (p.tip || 0), 0);
  const left = Math.max(0, Math.round((tab.total - paid) * 100) / 100);
  const bill = tab.bill || {};
  async function print() {
    if (!printer) { window.print(); return; }
    setPrinting(true);
    try { await printer.write(buildBillBytes(tab, companyName, { payUrl: link && link.on ? link.url : null })); } catch (e) { onFail(e); } finally { setPrinting(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog tl-dialog tbill" role="dialog" aria-modal="true" aria-labelledby="tbill-title" onClick={(e) => e.stopPropagation()}>
        <div className="tbill-sheet print-solo">
          <header className="tbill-head">
            <span className="tl-dialog-ico is-qr" aria-hidden="true">🧾</span>
            <div><h2 id="tbill-title">{tr('The bill · {table}', { table: tab.tableName || tab.label })}</h2>
              <p className="dk-muted">{tab.waiterName ? tr('Served by {name}', { name: tab.waiterName }) : companyName}</p></div>
          </header>
          <div className="tbill-body">
            <div className="tbill-lines">
              <ul className="is-plain">
                {tab.lines.map((l, i) => (
                  <li key={i}><b>{l.qty}×</b><span>{l.name}{(l.modifiers || []).length > 0 && <small>+ {modsWords(l.modifiers, tr)}</small>}</span><i>{money(l.lineTotal)}</i></li>
                ))}
              </ul>
              <div className="tbill-sums">
                {bill.serviceCharge > 0 && <div><span>{serviceWords(bill.serviceName, tr)}</span><b>{money(bill.serviceCharge)}</b></div>}
                {(bill.taxes || []).filter((t) => !t.included).map((t) => <div key={t.name}><span>{t.name} {t.rate}%</span><b>{money(t.amount)}</b></div>)}
                <div className="is-total"><span>{tr('Total')}</span><strong>{money(tab.total)}</strong></div>
                {paid > 0 && <div className="is-paid"><span>✓ {tr('Paid from phones')}</span><b>−{money(paid)}</b></div>}
                {paid > 0 && <div className="is-left"><span>{tr('Left to pay')}</span><strong>{money(left)}</strong></div>}
              </div>
              {(tab.paidAtTable || []).length > 0 && (
                <ul className="tbill-paid is-plain">
                  {tab.paidAtTable.map((p) => <li key={p.ref}><span aria-hidden="true">{p.kind === 'deposit' ? '🎟️' : p.kind === 'online' ? '🌐' : '💳'}</span>{p.payer || tr('A guest')}{p.kind === 'deposit' && <small> · {tr('booking deposit')}</small>}{p.kind === 'online' && <small> · {tr('paid on the website')}</small>}<b>{money(p.amount - (p.tip || 0))}</b>{p.tip > 0 && <em>{tr('+ tip {amount}', { amount: money(p.tip) })}</em>}</li>)}
                </ul>
              )}
            </div>
            <aside className={'tbill-qr' + (link && !link.on ? ' is-off' : '')}>
              {!link ? <span className="tbill-wait" aria-hidden="true">⏳</span> : link.on ? (
                <>
                  {qr ? <img src={qr} alt={tr('QR code to pay the bill')} /> : <span className="tbill-wait" aria-hidden="true">⏳</span>}
                  <strong>{tr('Scan to pay')}</strong>
                  <small>{tr('Card or Mobile Money · split it · add a tip')}</small>
                </>
              ) : (
                <>
                  <span className="tbill-off" aria-hidden="true">💳</span>
                  <strong>{tr('Paying from the phone is off')}</strong>
                  <small>{tr('A manager turns it on in the settings (Payments), with Paystack.')}</small>
                </>
              )}
            </aside>
          </div>
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Close')}</button>
          <button type="button" className="btn btn-primary" disabled={printing} onClick={print}>{printing ? tr('Printing…') : printer ? '🖨️ ' + tr('Print via {name}', { name: printer.name }) : '🖨️ ' + tr('Print the bill')}</button>
        </div>
      </div>
    </div>
  );
}
