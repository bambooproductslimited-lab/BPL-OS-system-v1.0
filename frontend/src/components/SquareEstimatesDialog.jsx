import { useState } from 'react';
import { api } from '../api/client';
import { money } from '../lib/currency';
import { tr } from '../lib/i18n.jsx';
import { parseSquareEstimate, pdfRows, textRows } from '../lib/squareEstimates';
import CustomerPicker from './CustomerPicker';
import './SquareEstimatesDialog.css';

// Estimates made in Square, brought into Estimates. Square has no way for
// another app to read its estimates, so they come from the PDFs Square makes
// of them (or the text copied from one): read here, in the browser
// (lib/squareEstimates.js), shown to be checked and corrected, then saved
// (backend squareEstimates.service.js). Each keeps its Square number, so
// bringing the same one again finds it.

async function readPdf(file) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')).default;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  let rows = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    rows = rows.concat(pdfRows((await page.getTextContent()).items));
  }
  return rows;
}

const WARN = {
  number: 'No estimate number found: type it in.',
  customer: 'No customer found: pick one.',
  items: 'No items found: add them.',
  subtotal: 'The items do not add up to Square\'s subtotal: check them.'
};

function totalOf(e) { return Math.round(e.items.reduce((a, it) => a + (Number(it.qty) || 0) * (Number(it.unitPrice) || 0) - (Number(it.discount) || 0), 0) * 100) / 100; }

export default function SquareEstimatesDialog({ customers, onClose, onDone }) {
  const [found, setFound] = useState([]);
  const [reading, setReading] = useState(false);
  const [paste, setPaste] = useState('');
  const [pasting, setPasting] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [drag, setDrag] = useState(false);

  function add(parsed, from) {
    setFound((list) => list.concat({ ...parsed, from, keep: true, customerId: '', status: 'finalized', key: from + ':' + list.length + ':' + Date.now() }));
  }
  async function files(list) {
    setError(''); setReading(true);
    for (const f of Array.from(list || [])) {
      if (!/pdf$/i.test(f.type) && !/\.pdf$/i.test(f.name)) { setError(tr('{name} is not a PDF.', { name: f.name })); continue; }
      try { add(parseSquareEstimate(await readPdf(f)), f.name); }
      catch { setError(tr('{name} could not be read. Copy its text from Square instead.', { name: f.name })); }
    }
    setReading(false);
  }
  function fromText() {
    if (!paste.trim()) return;
    add(parseSquareEstimate(textRows(paste)), tr('Pasted text'));
    setPaste(''); setPasting(false);
  }
  function change(key, patch) { setFound((list) => list.map((e) => (e.key === key ? { ...e, ...patch } : e))); }
  function changeItem(key, i, patch) { setFound((list) => list.map((e) => (e.key === key ? { ...e, items: e.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) } : e))); }

  const chosen = found.filter((e) => e.keep);
  const ready = chosen.length > 0 && chosen.every((e) => e.squareNo && (e.customerId || e.customer.name) && e.items.some((it) => it.description && Number(it.qty) > 0));
  async function save() {
    setSaving(true); setError('');
    try {
      const r = await api.post('/estimates/import-square', {
        estimates: chosen.map((e) => ({
          squareNo: e.squareNo, customerId: e.customerId || null, customer: e.customer, date: e.date, validUntil: e.validUntil,
          items: e.items.filter((it) => it.description).map((it) => ({ description: it.description, notes: it.notes, qty: Number(it.qty), unitPrice: Number(it.unitPrice), discount: Number(it.discount) || 0 })),
          discount: e.discount, taxRate: e.taxRate, notes: e.notes, status: e.status, currency: e.currency
        }))
      });
      onDone(r);
    } catch (err) { setError(err.message); setSaving(false); }
  }

  return (
    <div className="dialog-backdrop ed-over no-print" onClick={() => !saving && onClose()}>
      <div className="dialog sqe" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="sqe-title">
        <div className="sqe-head">
          <span className="sqe-logo" aria-hidden="true">◼︎</span>
          <div>
            <h2 id="sqe-title">{tr('Bring estimates over from Square')}</h2>
            <p className="dk-muted">{tr('Square does not let other apps read its estimates, so bring the PDFs Square makes: in Square, open Invoices → Estimates, open one, then ⋯ → Download PDF. Bring as many as you like at once.')}</p>
          </div>
        </div>

        <label className={'sqe-drop' + (drag ? ' is-over' : '')}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); files(e.dataTransfer.files); }}>
          <input type="file" accept="application/pdf,.pdf" multiple onChange={(e) => { files(e.target.files); e.target.value = ''; }} />
          <span className="sqe-drop-ico" aria-hidden="true">📄</span>
          <strong>{reading ? tr('Reading…') : tr('Drop Square estimate PDFs here, or tap to choose')}</strong>
          <small className="dk-muted">{tr('Read on this device: the PDFs are not uploaded.')}</small>
        </label>
        {!pasting
          ? <button type="button" className="pos-link sqe-paste-open" onClick={() => setPasting(true)}>{tr('No PDF? Paste the estimate\'s text instead')}</button>
          : (
            <div className="sqe-paste">
              <textarea className="input" rows={6} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={tr('Open the estimate in Square, select all its text, copy it and paste it here.')} />
              <div className="sqe-row"><button type="button" className="btn btn-secondary" onClick={fromText} disabled={!paste.trim()}>{tr('Read it')}</button><button type="button" className="pos-link" onClick={() => setPasting(false)}>{tr('Cancel')}</button></div>
            </div>
          )}

        {found.length > 0 && (
          <div className="sqe-list">
            {found.map((e) => {
              const sum = totalOf(e);
              return (
                <section key={e.key} className={'sqe-card' + (e.keep ? '' : ' is-off')}>
                  <div className="sqe-card-head">
                    <label className="sqe-keep"><input type="checkbox" checked={e.keep} onChange={(ev) => change(e.key, { keep: ev.target.checked })} /> <span className="sqe-no">#</span>
                      <input className="input sqe-no-input" value={e.squareNo} onChange={(ev) => change(e.key, { squareNo: ev.target.value })} aria-label={tr('Square estimate number')} placeholder="000123" />
                    </label>
                    <span className="dk-muted tl-small sqe-from">{e.from}</span>
                    <strong className="sqe-sum">{money(sum, e.currency)}</strong>
                  </div>
                  {e.warnings.filter((w) => !(w === 'number' && e.squareNo) && !(w === 'customer' && (e.customerId || e.customer.name))).map((w) => <div key={w} className="sqe-warn">⚠ {tr(WARN[w])}</div>)}
                  <div className="sqe-grid">
                    <label>{tr('Customer')}
                      <CustomerPicker customers={customers} value={e.customerId} onChange={(id) => change(e.key, { customerId: id })} placeholder={e.customer.name ? tr('{name} (found by email, phone or name, or added)', { name: e.customer.name }) : tr('Pick a customer')} />
                    </label>
                    <label>{tr('Made on')}<input className="input" type="date" value={e.date || ''} onChange={(ev) => change(e.key, { date: ev.target.value })} /></label>
                    <label>{tr('Valid until')}<input className="input" type="date" value={e.validUntil || ''} onChange={(ev) => change(e.key, { validUntil: ev.target.value })} /></label>
                    <label>{tr('In Square it was')}
                      <select className="input" value={e.status} onChange={(ev) => change(e.key, { status: ev.target.value })}>
                        <option value="finalized">{tr('Sent, waiting')}</option>
                        <option value="accepted">{tr('Accepted')}</option>
                        <option value="declined">{tr('Declined')}</option>
                        <option value="draft">{tr('A draft')}</option>
                      </select>
                    </label>
                  </div>
                  {!e.customerId && (e.customer.email || e.customer.phone) && <div className="dk-muted tl-small sqe-contact">{[e.customer.email, e.customer.phone].filter(Boolean).join(' · ')}</div>}
                  <table className="sqe-items">
                    <thead><tr><th>{tr('Item')}</th><th>{tr('Qty')}</th><th>{tr('Price')}</th><th>{tr('Amount')}</th></tr></thead>
                    <tbody>
                      {e.items.map((it, i) => (
                        <tr key={i}>
                          <td><input className="input" value={it.description} onChange={(ev) => changeItem(e.key, i, { description: ev.target.value })} aria-label={tr('Item')} />{it.notes && <small className="dk-muted">{it.notes}</small>}</td>
                          <td><input className="input sqe-num" inputMode="decimal" value={it.qty} onChange={(ev) => changeItem(e.key, i, { qty: ev.target.value })} aria-label={tr('Qty')} /></td>
                          <td><input className="input sqe-num" inputMode="decimal" value={it.unitPrice} onChange={(ev) => changeItem(e.key, i, { unitPrice: ev.target.value })} aria-label={tr('Price')} /></td>
                          <td className="sqe-amt">{money((Number(it.qty) || 0) * (Number(it.unitPrice) || 0) - (Number(it.discount) || 0), e.currency)}{it.discount > 0 && <small className="dk-muted">{tr('−{amount} off', { amount: money(it.discount, e.currency) })}</small>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="sqe-row">
                    <button type="button" className="pos-link" onClick={() => change(e.key, { items: e.items.concat({ description: '', notes: '', qty: 1, unitPrice: 0, discount: 0 }) })}>+ {tr('Add an item')}</button>
                    <span className="dk-muted tl-small">
                      {e.subtotal != null && <>{tr('Square\'s subtotal')} {money(e.subtotal, e.currency)}{Math.abs(e.subtotal - sum) <= 0.02 ? ' ✓' : ' ≠'}</>}
                      {e.taxRate > 0 && <> · {tr('tax {rate}%', { rate: e.taxRate })}</>}
                      {e.total != null && <> · {tr('total {amount}', { amount: money(e.total, e.currency) })}</>}
                    </span>
                  </div>
                </section>
              );
            })}
          </div>
        )}

        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>{tr('Cancel')}</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={!ready || saving}>
            {saving ? tr('Bringing them over…') : chosen.length === 1 ? tr('Bring 1 estimate over') : tr('Bring {n} estimates over', { n: chosen.length })}
          </button>
        </div>
      </div>
    </div>
  );
}
