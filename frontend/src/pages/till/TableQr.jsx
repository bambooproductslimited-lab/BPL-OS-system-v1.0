import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { posFetch } from '../../lib/posApi';
import { tr } from '../../lib/i18n.jsx';
import { restaurantLogoUrl } from '../../lib/restaurantLogos';

// Till settings → Table QR codes (backend restaurantTableOrders qrCodes):
// whether tables order from their QR codes, and whether those orders go
// straight to the kitchen (saved with the other settings); and each
// table's code, to print and stand on the table. A new code (one table's,
// or every table's) stops the old one working — for a code taken away.

export function TableQrTab({ token, pin, draft, set, onFail }) {
  const [data, setData] = useState(null);
  const [pics, setPics] = useState({});
  const [busy, setBusy] = useState(false);
  async function load(renew) {
    setBusy(true);
    try {
      const d = await posFetch('POST', '/pos/settings/table-qr', token, { managerPin: pin || undefined, renew });
      setData(d);
      const out = {};
      for (const t of d.tables) out[t.id] = await QRCode.toDataURL(t.url, { margin: 1, width: 420, errorCorrectionLevel: 'M', color: { dark: '#111827', light: '#ffffff' } });
      setPics(out);
    } catch (e) { onFail(e); } finally { setBusy(false); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  function renew(id) {
    if (!window.confirm(id === 'all' ? tr('New codes for every table? The printed ones stop working: print the new ones.') : tr('A new code for this table? Its printed one stops working.'))) return;
    load(id);
  }
  // The cards in a page of their own, three to a row, to print and cut out.
  function print() {
    const w = window.open('', '_blank');
    if (!w) { onFail({ message: tr('Let the till open a new window (pop-ups) to print the codes.') }); return; }
    const esc = (v) => String(v || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const logoAbs = logo ? new URL(logo, window.location.href).href : '';
    const cards = data.tables.map((t) => '<article>' + (logoAbs ? '<img class="logo" src="' + esc(logoAbs) + '" alt="">' : '') + '<b class="co">' + esc(data.restaurant.name) + '</b>' +
      '<p class="say">' + esc(tr('Scan to order')) + '</p><img class="qr" src="' + pics[t.id] + '" alt="">' +
      '<strong>' + esc(t.name) + '</strong>' + (t.area ? '<small>' + esc(t.area) + '</small>' : '') + '<p class="how">' + esc(tr('Order, call the waiter or ask for the bill from your phone.')) + '</p></article>').join('');
    w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>' + esc(tr('Table QR codes')) + ' · ' + esc(data.restaurant.name) + '</title><style>' +
      '@page{margin:10mm}body{margin:0;font-family:Archivo,system-ui,sans-serif;color:#111827}main{display:grid;grid-template-columns:repeat(3,1fr);gap:8mm}' +
      'article{break-inside:avoid;display:flex;flex-direction:column;align-items:center;gap:4px;padding:6mm 4mm;text-align:center;border:2px dashed #cbd5e1;border-radius:6mm}' +
      '.logo{width:12mm;height:12mm;object-fit:contain}.co{font-size:11pt}.say{margin:2mm 0 0;font-size:15pt;font-weight:800}.qr{width:42mm;height:42mm;image-rendering:pixelated}' +
      'strong{font-size:20pt;line-height:1.1}small{font-size:9pt;color:#64748b}.how{margin:1mm 0 0;font-size:8.5pt;color:#475569}' +
      '</style></head><body><main>' + cards + '</main></body></html>');
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 500);
  }
  const q = draft.qrOrders;
  const logo = data ? restaurantLogoUrl(data.restaurant.code) : null;
  return (
    <section className="ts-sec tq-set">
      <div className="ts-toggles">
        <button type="button" role="switch" aria-checked={q.on} className="ts-toggle-row" onClick={() => set(['qrOrders', 'on'], !q.on)}>
          <span><strong>{tr('Tables order from their QR code')}</strong><small>{tr('Customers scan the code on the table, see the menu on their phone and send their order. They can also call the waiter or ask for the bill.')}</small></span>
          <span className={'ts-switch' + (q.on ? ' is-on' : '')} aria-hidden="true"><i /></span>
        </button>
        <button type="button" role="switch" aria-checked={q.straightToKitchen} disabled={!q.on} className="ts-toggle-row" onClick={() => set(['qrOrders', 'straightToKitchen'], !q.straightToKitchen)}>
          <span><strong>{tr('Straight to the kitchen')}</strong><small>{tr('Off: a waiter or the cashier accepts each order on the till first (the till rings). On: it goes to the kitchen at once, onto the table\'s open order.')}</small></span>
          <span className={'ts-switch' + (q.straightToKitchen ? ' is-on' : '')} aria-hidden="true"><i /></span>
        </button>
      </div>
      <div className="tq-set-bar">
        <div><strong>{tr('The codes to put on the tables')}</strong><small className="dk-muted">{tr('Print them, cut them out and stand one on each table. Save the switches above with Save.')}</small></div>
        <button type="button" className="btn btn-secondary" disabled={busy || !data || !data.tables.length} onClick={() => renew('all')}>{tr('New codes for every table')}</button>
        <button type="button" className="btn btn-primary" disabled={busy || !data || !data.tables.length} onClick={print}>🖨️ {tr('Print the codes')}</button>
      </div>
      {!data ? <p className="dk-muted">{tr('Loading…')}</p> : !data.tables.length ? <p className="dk-muted">{tr('No tables yet: add them on the Floor map first.')}</p> : (
        <div className="tq-sheet">
          {data.tables.map((t) => (
            <article key={t.id} className="tq-qr">
              <header>{logo ? <img src={logo} alt="" /> : <span aria-hidden="true">🍽️</span>}<b>{data.restaurant.name}</b></header>
              <p className="tq-qr-say">{tr('Scan to order')}</p>
              {pics[t.id] ? <img className="tq-qr-code" src={pics[t.id]} alt={tr('QR code for {name}', { name: t.name })} /> : <span className="tq-qr-code is-wait" />}
              <strong className="tq-qr-table">{t.name}</strong>
              {t.area && <small className="tq-qr-area">{t.area}</small>}
              <p className="tq-qr-how">{tr('Order, call the waiter or ask for the bill from your phone.')}</p>
              <div className="tq-qr-tools">
                <a href={t.url} target="_blank" rel="noopener noreferrer">{tr('Try it')}</a>
                <button type="button" className="pos-link" disabled={busy} onClick={() => renew(t.id)}>{tr('New code')}</button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
