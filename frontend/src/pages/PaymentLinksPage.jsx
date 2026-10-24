import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useSearchParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { money } from '../lib/currency';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import './PaymentLinksPage.css';

// Payment links (Quotations & Invoicing → Payment links, and the sales app;
// backend paymentLinks.service.js): a link for an amount, for items from
// the catalogue, or for whatever the customer types, to send on WhatsApp,
// copy, or show as a QR code. Paid on Bamboo Products' customer website,
// each payment an invoice for whoever paid. A link is paused, opened again,
// or closed; single use, it is done once paid.

const KINDS = [
  ['amount', '💵', () => tr('A set amount'), () => tr('e.g. a deposit or a balance')],
  ['items', '🪑', () => tr('Items'), () => tr('from the catalogue, at today\'s prices')],
  ['open', '✍️', () => tr('Customer types it'), () => tr('they choose how much to pay')]
];
const STATE = {
  open: ['🟢', () => tr('Open')], paused: ['⏸️', () => tr('Paused')], closed: ['🔒', () => tr('Closed')], expired: ['⌛', () => tr('Expired')], paid: ['✅', () => tr('Paid')]
};
const FILTERS = [['open', () => tr('Open')], ['done', () => tr('Done')], ['', () => tr('All')]];
function shortDate(d) { return new Date(String(d).length === 10 ? d + 'T12:00:00' : d).toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short' }); }
function shareText(l) { return tr('Hello! You can pay "{title}" to Bamboo Products here, by card or Mobile Money: {url}', { title: l.title, url: l.url }); }

function useQr(url) {
  const [qr, setQr] = useState(null);
  useEffect(() => {
    let live = true;
    if (url) QRCode.toDataURL(url, { margin: 1, width: 360, color: { dark: '#1f3d1c', light: '#ffffff' } }).then((d) => { if (live) setQr(d); }).catch(() => {});
    return () => { live = false; };
  }, [url]);
  return qr;
}

// A link to share: its QR code, copied, on WhatsApp.
function ShareCard({ link, onToast }) {
  const qr = useQr(link.url);
  async function copy() {
    try { await navigator.clipboard.writeText(link.url); onToast(tr('Link copied.')); } catch { window.prompt(tr('Copy the link'), link.url); }
  }
  return (
    <div className="plk-share">
      <div className="plk-qr">{qr ? <img src={qr} alt={tr('QR code for {title}', { title: link.title })} /> : <span aria-hidden="true">🔗</span>}</div>
      <div className="plk-share-main">
        <code className="plk-url">{link.url}</code>
        <div className="plk-share-acts">
          <button type="button" className="btn btn-primary" onClick={copy}>📋 {tr('Copy link')}</button>
          <a className="btn plk-wa" href={'https://wa.me/?text=' + encodeURIComponent(shareText(link))} target="_blank" rel="noreferrer">💬 WhatsApp</a>
          {qr && <a className="btn btn-secondary" href={qr} download={'payment-link-' + link.token + '.png'}>⬇️ {tr('QR code')}</a>}
        </div>
      </div>
    </div>
  );
}

function NewLinkDialog({ onClose, onMade }) {
  const [f, setF] = useState({ title: '', description: '', kind: 'amount', amount: '', customerId: '', singleUse: false, expiresOn: '' });
  const [lines, setLines] = useState([]);
  const [catalog, setCatalog] = useState(null);
  const [customers, setCustomers] = useState(null);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    api.get('/catalog').then((r) => setCatalog(r.filter((v) => v.active && v.unitPrice > 0))).catch(() => setCatalog([]));
    api.get('/customers').then((r) => setCustomers(r.filter((c) => c.status !== 'inactive'))).catch(() => setCustomers([]));
  }, []);
  const found = useMemo(() => (catalog || []).filter((v) => pick.trim() && (v.name + ' ' + (v.code || '')).toLowerCase().includes(pick.trim().toLowerCase())).slice(0, 8), [catalog, pick]);
  const itemsTotal = lines.reduce((a, l) => a + l.qty * l.unitPrice, 0);
  function addLine(v) { setLines(lines.some((l) => l.variationId === v.id) ? lines.map((l) => (l.variationId === v.id ? { ...l, qty: l.qty + 1 } : l)) : lines.concat([{ variationId: v.id, name: v.name, unitPrice: v.unitPrice, qty: 1 }])); setPick(''); }
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api.post('/payment-links', { ...f, amount: f.kind === 'amount' ? Number(f.amount) : undefined, lines: f.kind === 'items' ? lines.map((l) => ({ variationId: l.variationId, qty: l.qty })) : undefined, customerId: f.customerId || null, expiresOn: f.expiresOn || null });
      onMade(r);
    } catch (err) { setError(err.message); setBusy(false); }
  }
  return createPortal(
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <form className="dialog plk-dlg" onClick={(e) => e.stopPropagation()} onSubmit={save} role="dialog" aria-modal="true" aria-labelledby="plk-new-title">
        <h2 id="plk-new-title">🔗 {tr('New payment link')}</h2>
        <label className="plk-field">{tr('What it is for (the customer sees it)')}<input className="input" required maxLength={120} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder={tr('e.g. Deposit for the kitchen cabinets')} /></label>
        <div className="plk-kinds" role="radiogroup" aria-label={tr('What they pay')}>
          {KINDS.map(([k, ico, label, note]) => (
            <button key={k} type="button" role="radio" aria-checked={f.kind === k} className={f.kind === k ? 'is-on' : ''} onClick={() => setF({ ...f, kind: k })}>
              <span aria-hidden="true">{ico}</span><strong>{label()}</strong><small>{note()}</small>
            </button>
          ))}
        </div>
        {f.kind === 'amount' && (
          <label className="plk-field">{tr('Amount')}
            <span className="plk-cedi"><b>GHS</b><input className="input" type="number" min="1" step="0.01" required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="0.00" /></span>
          </label>
        )}
        {f.kind === 'items' && (
          <div className="plk-items">
            <input className="input" type="search" value={pick} onChange={(e) => setPick(e.target.value)} placeholder={catalog ? tr('Find an item to add') : tr('Loading…')} aria-label={tr('Find an item to add')} />
            {found.length > 0 && (
              <ul className="plk-found">{found.map((v) => <li key={v.id}><button type="button" onClick={() => addLine(v)}><span>{v.name}</span><b>{money(v.unitPrice)}</b></button></li>)}</ul>
            )}
            {lines.map((l) => (
              <div key={l.variationId} className="plk-line">
                <span>{l.name}</span>
                <input className="input" type="number" min="1" max="999" value={l.qty} onChange={(e) => setLines(lines.map((x) => (x.variationId === l.variationId ? { ...x, qty: Math.max(1, Number(e.target.value) || 1) } : x)))} aria-label={tr('Quantity')} />
                <b>{money(l.qty * l.unitPrice)}</b>
                <button type="button" className="plk-x" onClick={() => setLines(lines.filter((x) => x.variationId !== l.variationId))} aria-label={tr('Remove')}>✕</button>
              </div>
            ))}
            {lines.length > 0 && <p className="plk-sum">{tr('Before tax: {amount}', { amount: money(itemsTotal) })}</p>}
          </div>
        )}
        <label className="plk-field">{tr('A line of detail (optional)')}<input className="input" maxLength={500} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder={tr('e.g. 50% before we start production')} /></label>
        <div className="plk-two">
          <label className="plk-field">{tr('For one customer (optional)')}
            <select className="input" value={f.customerId} onChange={(e) => setF({ ...f, customerId: e.target.value })}>
              <option value="">{tr('Anyone with the link')}</option>
              {(customers || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select></label>
          <label className="plk-field">{tr('Last day (optional)')}<input className="input" type="date" value={f.expiresOn} onChange={(e) => setF({ ...f, expiresOn: e.target.value })} /></label>
        </div>
        <label className="plk-check"><input type="checkbox" checked={f.singleUse} onChange={(e) => setF({ ...f, singleUse: e.target.checked })} />
          <span><strong>{tr('Single use')}</strong><small>{tr('Done once it is paid. Otherwise anyone can pay it again, e.g. a fee.')}</small></span></label>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || (f.kind === 'items' && !lines.length)}>{busy ? tr('Saving…') : tr('Make the link')}</button>
        </div>
      </form>
    </div>, document.body
  );
}

function LinkDialog({ id, canManage, onClose, onChanged, onToast }) {
  const [l, setL] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/payment-links/' + id).then(setL).catch((e) => setError(e.message)); }, [id]);
  async function status(s) {
    if (s === 'closed' && !window.confirm(tr('Close "{title}" for good? It stops taking payments.', { title: l.title }))) return;
    setBusy(true);
    try { setL(await api.patch('/payment-links/' + id, { status: s })); onChanged(); } catch (e) { onToast(e.message); } finally { setBusy(false); }
  }
  return createPortal(
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog plk-dlg" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="plk-one-title">
        {!l ? <p className="muted">{error || tr('Loading…')}</p> : (
          <>
            <div className="plk-one-head">
              <span className={'plk-state is-' + l.state}>{STATE[l.state][0]} {STATE[l.state][1]()}</span>
              <h2 id="plk-one-title">{l.title}</h2>
              <strong className="plk-one-amt">{l.total != null ? money(l.total) : tr('Customer types the amount')}</strong>
            </div>
            {l.state === 'open' && <ShareCard link={l} onToast={onToast} />}
            <div className="plk-one-stats">
              <span><b>{l.paidCount}</b>{tr('paid')}</span><span><b>{money(l.paidTotal)}</b>{tr('received')}</span><span><b>{l.openCount}</b>{tr('started, not paid')}</span>
            </div>
            <h3 className="plk-h3">{tr('Invoices from this link')}</h3>
            {!l.invoices.length ? <p className="muted">{tr('Nobody has paid with it yet.')}</p> : (
              <ul className="plk-invs">
                {l.invoices.map((i) => (
                  <li key={i.id}><Link to={'/invoices?open=' + i.id}>🧾 {i.invoiceNo}</Link><span>{i.customer}</span><small>{shortDate(i.issuedAt)}</small>
                    <b className={'plk-inv is-' + i.status}>{i.status === 'paid' ? '✅ ' + money(i.paid) : i.status === 'void' ? tr('Voided') : tr('{amount} due', { amount: money(i.total - i.paid) })}</b></li>
                ))}
              </ul>
            )}
            <div className="dialog-actions">
              {canManage && l.status === 'active' && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => status('paused')}>⏸️ {tr('Pause')}</button>}
              {canManage && l.status === 'paused' && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => status('active')}>▶️ {tr('Open again')}</button>}
              {canManage && l.status !== 'closed' && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => status('closed')}>🔒 {tr('Close for good')}</button>}
              <button type="button" className="btn btn-primary" onClick={onClose}>{tr('Done')}</button>
            </div>
          </>
        )}
      </div>
    </div>, document.body
  );
}

export default function PaymentLinksPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState('open');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [making, setMaking] = useState(false);
  const [made, setMade] = useState(null);
  const [toast, setToast] = useState(null);
  const openId = params.get('open');
  const load = useCallback(() => api.get('/payment-links' + (filter ? '?state=' + filter : '')).then(setData).catch((e) => setError(e.message)), [filter]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(null), 3000); return () => clearTimeout(t); }, [toast]);

  if (error) return <div className="plk"><div className="error-banner" role="alert">{error}</div></div>;
  if (!data) return <div className="plk"><p className="muted">{tr('Loading…')}</p></div>;
  const sm = data.summary;
  return (
    <div className="plk">
      <section className="plk-hero">
        <span className="plk-hero-art" aria-hidden="true"><i>🔗</i><i>💳</i><i>📱</i></span>
        <div className="plk-hero-main">
          <h1>{tr('Payment links')}</h1>
          <p>{tr('A link to get paid by card or Mobile Money, without an invoice first: send it on WhatsApp, or show its QR code. Each payment becomes an invoice for whoever paid.')}</p>
          {!data.payOnline && <p className="plk-warn">🏦 {tr('Online payments are not set up (PAYSTACK_BPL_SECRET_KEY on the server): customers get the invoice with the bank details instead.')}</p>}
        </div>
        {can('invoice.manage') && <button type="button" className="btn btn-primary plk-new" onClick={() => setMaking(true)}>＋ {tr('New payment link')}</button>}
      </section>
      <div className="plk-stats">
        <div className="plk-stat"><small>{tr('Open links')}</small><strong>{sm.open}</strong></div>
        <div className="plk-stat"><small>{tr('Payments')}</small><strong>{sm.paidCount}</strong></div>
        <div className="plk-stat is-money"><small>{tr('Received through links')}</small><strong>{money(sm.paidTotal)}</strong></div>
      </div>
      <div className="plk-filters" role="tablist" aria-label={tr('Which links')}>
        {FILTERS.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={filter === k} className={filter === k ? 'is-on' : ''} onClick={() => setFilter(k)}>{label()}</button>)}
      </div>
      {!data.links.length ? (
        <div className="plk-empty"><span aria-hidden="true">🔗</span><strong>{tr('No links here')}</strong><p>{tr('Make one for a deposit, a balance or a few items, and send it to the customer.')}</p></div>
      ) : (
        <ul className="plk-grid">
          {data.links.map((l, i) => (
            <li key={l.id} className={'plk-card is-' + l.state} style={{ '--i': Math.min(i, 10) }}>
              <button type="button" className="plk-card-main" onClick={() => setParams({ open: l.id })}>
                <span className="plk-card-top">
                  <span className={'plk-state is-' + l.state}>{STATE[l.state][0]} {STATE[l.state][1]()}</span>
                  <span className="plk-kind">{KINDS.find((k) => k[0] === l.kind)[1]} {KINDS.find((k) => k[0] === l.kind)[2]()}</span>
                </span>
                <strong className="plk-title">{l.title}</strong>
                <b className="plk-amt">{l.total != null ? money(l.total) : tr('Any amount')}</b>
                <span className="plk-meta">
                  {l.customer && <em>👤 {l.customer.name}</em>}
                  {l.singleUse && <em>1️⃣ {tr('Single use')}</em>}
                  {l.expiresOn && <em>⏳ {tr('Until {day}', { day: shortDate(l.expiresOn) })}</em>}
                </span>
                <span className="plk-took">{l.paidCount ? tr('{n} paid · {amount}', { n: l.paidCount, amount: money(l.paidTotal) }) : tr('Not paid yet')}</span>
              </button>
              {l.state === 'open' && (
                <span className="plk-card-acts">
                  <button type="button" className="plk-mini" onClick={async () => { try { await navigator.clipboard.writeText(l.url); setToast(tr('Link copied.')); } catch { window.prompt(tr('Copy the link'), l.url); } }}>📋 {tr('Copy')}</button>
                  <a className="plk-mini is-wa" href={'https://wa.me/?text=' + encodeURIComponent(shareText(l))} target="_blank" rel="noreferrer">💬 WhatsApp</a>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {making && <NewLinkDialog onClose={() => setMaking(false)} onMade={(l) => { setMaking(false); setMade(l); setFilter('open'); load(); }} />}
      {made && createPortal(
        <div className="dialog-backdrop" onClick={() => setMade(null)}>
          <div className="dialog plk-dlg plk-made" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="plk-made-title">
            <span className="plk-made-art" aria-hidden="true">🎉</span>
            <h2 id="plk-made-title">{tr('Your link is ready')}</h2>
            <p className="muted">{made.title} · {made.total != null ? money(made.total) : tr('Customer types the amount')}</p>
            <ShareCard link={made} onToast={setToast} />
            <div className="dialog-actions"><button type="button" className="btn btn-primary" onClick={() => setMade(null)}>{tr('Done')}</button></div>
          </div>
        </div>, document.body
      )}
      {openId && <LinkDialog id={openId} canManage={can('invoice.manage')} onClose={() => setParams({})} onChanged={load} onToast={setToast} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
