import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { CatalogImage } from '../../components/CatalogPhotos';
import { fmtDate } from '../../components/DashKit';
import { money } from '../../lib/currency';
import { osOrigin } from '../../lib/osOrigin';
import { tr } from '../../lib/i18n.jsx';
import './SendProducts.css';

// Products to a customer on WhatsApp, from a lead or a customer (backend
// crmProductSheets.service.js): pick from the catalogue — photo, name and
// price — with how many and a note; Send opens WhatsApp on this phone with
// the message written (each product, its price, and a link to a page with
// the photos, ProductSheetPage.jsx). What was sent before is listed with
// whether the customer opened it; the rep is told when they do.

const SHOWN = 60;

function WaGlyph() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20l1.2-4.1A8 8 0 1 1 8.3 19z" /><path d="M9 8.6c0 3.3 3 6.4 6.4 6.4l1-1.6-2-1-1 .9a4.4 4.4 0 0 1-2.7-2.7l.9-1-1-2z" /></svg>;
}

// The button beside a lead's or a customer's call and WhatsApp buttons.
export function SendProductsButton({ leadId, customerId, name, phone }) {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  if (!can('crm.manage') || !can('catalog.read')) return null;
  return (
    <>
      <button type="button" className="wsp-open" onClick={(e) => { e.stopPropagation(); setOpen(true); }}>
        <WaGlyph /> {tr('Send products')}
      </button>
      {open && createPortal(<SendProducts leadId={leadId} customerId={customerId} name={name} phone={phone} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function SendProducts({ leadId, customerId, name, phone, onClose }) {
  const [catalog, setCatalog] = useState(null);
  const [before, setBefore] = useState([]);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState(() => new Map());
  const [note, setNote] = useState('');
  const [number, setNumber] = useState(phone || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(null);
  const [copied, setCopied] = useState(false);
  const whose = leadId ? 'leadId=' + leadId : 'customerId=' + customerId;

  useEffect(() => {
    api.get('/catalog').then((list) => setCatalog(list.filter((v) => v.active))).catch((e) => { setCatalog([]); setError(e.message); });
    api.get('/crm/product-sheets?' + whose).then(setBefore).catch(() => {});
  }, [whose]);
  useEffect(() => {
    function key(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  const byId = useMemo(() => new Map((catalog || []).map((v) => [v.id, v])), [catalog]);
  const list = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (catalog || []).filter((v) => words.every((w) => (v.name + ' ' + (v.code || '') + ' ' + (v.description || '')).toLowerCase().includes(w)));
  }, [catalog, q]);
  const chosen = [...picked.entries()].map(([id, qty]) => ({ v: byId.get(id), qty })).filter((x) => x.v);
  const total = chosen.reduce((a, x) => a + x.v.unitPrice * x.qty, 0);

  function setQty(id, qty) {
    const next = new Map(picked);
    if (qty <= 0) next.delete(id); else next.set(id, Math.min(999, qty));
    setPicked(next);
  }
  async function send() {
    setBusy(true); setError(null);
    try {
      const r = await api.post('/crm/product-sheets', {
        leadId, customerId, note, phone: number, origin: osOrigin(),
        items: chosen.map((x) => ({ variationId: x.v.id, qty: x.qty }))
      });
      setSent(r);
      window.open(r.whatsappUrl, '_blank', 'noopener');
      api.get('/crm/product-sheets?' + whose).then(setBefore).catch(() => {});
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(sent.message); setCopied(true); } catch { /* the message is shown to copy by hand */ }
  }

  return (
    <div className="dialog-backdrop wsp-back" onClick={onClose}>
      <div className="dialog wsp" role="dialog" aria-modal="true" aria-labelledby="wsp-t" onClick={(e) => e.stopPropagation()}>
        <header className="wsp-head">
          <span className="wsp-head-icon"><WaGlyph /></span>
          <div>
            <h2 id="wsp-t">{tr('Send products to {name}', { name })}</h2>
            <p>{tr('Pick from the catalogue. WhatsApp opens with the message written: each product and its price, and a link to a page with the photos.')}</p>
          </div>
          <button type="button" className="crm-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </header>

        {error && <div className="error-banner" role="alert">{error}</div>}

        {sent ? (
          <div className="wsp-sent">
            <span className="wsp-sent-art" aria-hidden="true">🚀</span>
            <h3>{tr('Ready in WhatsApp')}</h3>
            <p>{sent.hasNumber ? tr('Press send in WhatsApp. If it did not open, open it from here.') : tr('There is no WhatsApp number for them yet, so WhatsApp asks who to send it to.')}</p>
            <pre className="wsp-message">{sent.message}</pre>
            <div className="wsp-sent-acts">
              <a className="btn btn-primary wsp-wa" href={sent.whatsappUrl} target="_blank" rel="noopener noreferrer"><WaGlyph /> {tr('Open WhatsApp')}</a>
              <button type="button" className="btn btn-secondary" onClick={copy}>{copied ? tr('Copied') : tr('Copy the message')}</button>
              <a className="btn btn-secondary" href={sent.url + '?preview=1'} target="_blank" rel="noopener noreferrer">{tr('See their page')}</a>
            </div>
            <p className="wsp-muted">{tr('You will be told when {name} opens it.', { name })}</p>
            <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Done')}</button>
          </div>
        ) : (
          <div className="wsp-body">
            <div className="wsp-pick">
              <input className="input wsp-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Find a product: name or code')} aria-label={tr('Find a product')} />
              {!catalog ? <p className="wsp-muted">{tr('Loading…')}</p> : !list.length ? <p className="wsp-muted">{tr('No product matches.')}</p> : (
                <div className="wsp-grid">
                  {list.slice(0, SHOWN).map((v) => {
                    const qty = picked.get(v.id) || 0;
                    return (
                      <div key={v.id} className={'wsp-card' + (qty ? ' is-on' : '')}>
                        <button type="button" className="wsp-card-main" onClick={() => setQty(v.id, qty ? 0 : 1)} aria-pressed={!!qty}>
                          <span className="wsp-photo">{v.photoId ? <CatalogImage id={v.photoId} /> : <span aria-hidden="true">🎋</span>}{qty > 0 && <i className="wsp-tick">✓</i>}</span>
                          <b>{v.name}</b>
                          <span className="wsp-price">{money(v.unitPrice)}{v.unit && v.unit !== 'each' ? <small> / {v.unit}</small> : null}</span>
                        </button>
                        {qty > 0 && (
                          <span className="wsp-qty">
                            <button type="button" onClick={() => setQty(v.id, qty - 1)} aria-label={tr('One less')}>−</button>
                            <b>{qty}</b>
                            <button type="button" onClick={() => setQty(v.id, qty + 1)} aria-label={tr('One more')}>+</button>
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {list.length > SHOWN && <p className="wsp-muted">{tr('{n} more: search to find them.', { n: list.length - SHOWN })}</p>}
            </div>

            <aside className="wsp-tray">
              <h3>{chosen.length ? tr('{n} picked', { n: chosen.length }) : tr('Nothing picked yet')}</h3>
              {chosen.length > 0 && (
                <ul className="wsp-chosen">
                  {chosen.map((x) => (
                    <li key={x.v.id}><span>{x.v.name}{x.qty > 1 ? ' × ' + x.qty : ''}</span><b>{money(x.v.unitPrice * x.qty)}</b></li>
                  ))}
                  <li className="wsp-total"><span>{tr('Total')}</span><b>{money(total)}</b></li>
                </ul>
              )}
              <label className="field"><span>{tr('A note (optional)')}</span>
                <textarea className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={600} placeholder={tr('e.g. Delivery in Accra is free this month.')} />
              </label>
              <label className="field"><span>{tr('Their WhatsApp number')}</span>
                <input className="input" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="024 000 0000" inputMode="tel" />
              </label>
              <button type="button" className="btn btn-primary wsp-send" disabled={!chosen.length || busy} onClick={send}>
                <WaGlyph /> {busy ? tr('Getting it ready…') : tr('Send on WhatsApp')}
              </button>
              {before.length > 0 && (
                <div className="wsp-before">
                  <h4>{tr('Sent before')}</h4>
                  {before.slice(0, 4).map((b) => (
                    <div key={b.id} className="wsp-before-row">
                      <span>{fmtDate(b.sentAt)} · {b.items.length === 1 ? b.items[0].name : tr('{n} products', { n: b.items.length })}</span>
                      <span className={'wsp-seen' + (b.views ? ' is-seen' : '')}>{b.views ? (b.views === 1 ? tr('Opened once') : tr('Opened {n} times', { n: b.views })) : tr('Not opened yet')}</span>
                    </div>
                  ))}
                </div>
              )}
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}
