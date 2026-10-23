import { useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { saveFile } from '../../lib/saveFile';
import { activeIntlLocale, msg, tr } from '../../lib/i18n.jsx';
import './growth.css';

// Downloads from the till itself (More → Downloads), in Square's own
// layouts (backend restaurantSquareExport): the item library as Square's
// "Export library" spreadsheet, and the item sales of some days as Square's
// "Item sales" file — the same columns, so they open in Excel or Google
// Sheets, or go back into Square, exactly like Square's. A manager signed
// in downloads at once; anyone else types a manager's PIN.

function iso(d) { return d.toISOString().slice(0, 10); }
function addDays(s, n) { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); }
const PRESETS = [
  ['today', msg('Today')], ['yesterday', msg('Yesterday')], ['week', msg('This week')], ['7', msg('Last 7 days')],
  ['month', msg('This month')], ['lastMonth', msg('Last month')], ['custom', msg('Pick the days')]
];
function rangeOf(k, custom) {
  const today = iso(new Date());
  if (k === 'today') return { from: today, to: today };
  if (k === 'yesterday') { const y = addDays(today, -1); return { from: y, to: y }; }
  if (k === 'week') { const dow = (new Date(today + 'T12:00:00Z').getUTCDay() + 6) % 7; return { from: addDays(today, -dow), to: today }; }
  if (k === '7') return { from: addDays(today, -6), to: today };
  if (k === 'month') return { from: today.slice(0, 8) + '01', to: today };
  if (k === 'lastMonth') { const end = addDays(today.slice(0, 8) + '01', -1); return { from: end.slice(0, 8) + '01', to: end }; }
  return custom;
}
// Square's columns, as the files have them (in English, like Square's).
const LIBRARY_COLS = ['Reference Handle', 'Token', 'Item Name', 'Variation Name', 'SKU', 'Description', 'Categories', 'Item Type', 'Price', 'Sellable', 'Stockable', 'Current Quantity'];
const SALES_COLS = ['Date', 'Time', 'Category', 'Item', 'Qty', 'Price Point Name', 'Modifiers Applied', 'Gross Sales', 'Discounts', 'Net Sales', 'Tax', 'Transaction ID', 'Dining Option', 'Channel', 'Card Brand', 'PAN Suffix'];

export default function Downloads({ token, isManager, companyName, onToast, onClose }) {
  const today = iso(new Date());
  const [preset, setPreset] = useState('today');
  const [custom, setCustom] = useState({ from: addDays(today, -6), to: today });
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [done, setDone] = useState({});
  const range = rangeOf(preset, custom);
  const needPin = !isManager && pin.length < 4;
  const fmt = (s) => new Date(s + 'T12:00:00').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', year: 'numeric' });

  async function get(kind) {
    setBusy(kind); setError(null);
    try {
      const f = await posFetch('POST', '/pos/settings/export', token, { managerPin: isManager ? undefined : pin, kind, from: range.from, to: range.to });
      saveFile(f);
      setDone({ ...done, [kind]: f.filename });
      onToast(tr('Saved: {file}', { file: f.filename }));
    } catch (err) { setError(err.message || tr('No answer from the server: downloads need the internet.')); } finally { setBusy(null); }
  }

  return (
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <div className="dialog pos-panel dl" role="dialog" aria-modal="true" aria-labelledby="dl-title" onClick={(e) => e.stopPropagation()}>
        <header className="bk-head">
          <span className="bk-ico is-dl" aria-hidden="true">⬇️</span>
          <div>
            <h2 id="dl-title">{tr('Downloads (Square format)')}</h2>
            <p className="dk-muted">{tr('{name}: the same files Square gives, with the same columns. They open in Excel or Google Sheets, and go back into Square.', { name: companyName })}</p>
          </div>
        </header>

        {!isManager && (
          <label className="dl-pin">
            <span className="dl-pin-ico" aria-hidden="true">🔑</span>
            <span className="dl-pin-text"><strong>{tr('A manager\'s PIN')}</strong><small>{tr('Sales figures are for managers: a manager types their PIN.')}</small></span>
            <input className="input tl-mgr-pin" type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} placeholder="••••" aria-label={tr('Manager\'s PIN')} />
          </label>
        )}

        <section className="dl-card is-sales">
          <div className="dl-file" aria-hidden="true"><span className="dl-file-fold" /><b>{'CSV'}</b></div>
          <div className="dl-main">
            <h3>{tr('Item sales')}</h3>
            <p className="dk-muted">{tr('Every dish sold and refunded on these days: one line each, with its sale, its payment, its channel (the till, the website, the kiosk, a delivery app) and the card.')}</p>
            <div className="ts-chips dl-presets" role="radiogroup" aria-label={tr('Which days')}>
              {PRESETS.map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={preset === k} className={preset === k ? 'is-on' : ''} onClick={() => setPreset(k)}>{tr(label)}</button>)}
            </div>
            {preset === 'custom' && (
              <div className="dl-days">
                <label><span>{tr('From')}</span><input className="input" type="date" max={today} value={custom.from} onChange={(e) => e.target.value && setCustom({ ...custom, from: e.target.value })} /></label>
                <label><span>{tr('To')}</span><input className="input" type="date" max={today} value={custom.to} onChange={(e) => e.target.value && setCustom({ ...custom, to: e.target.value })} /></label>
              </div>
            )}
            <p className="dl-range"><span aria-hidden="true">📆</span> {range.from === range.to ? fmt(range.from) : tr('{from} to {to}', { from: fmt(range.from), to: fmt(range.to) })}</p>
            <ul className="dl-cols" aria-label={tr('Its columns')}>{SALES_COLS.map((c) => <li key={c}>{c}</li>)}<li className="is-more">{tr('+{n} more', { n: 13 })}</li></ul>
          </div>
          <button type="button" className="btn btn-primary tl-btn dl-go" disabled={!!busy || needPin} onClick={() => get('items')}>
            {busy === 'items' ? tr('Making the file…') : done.items ? '✓ ' + tr('Download again') : tr('Download the sales')}
          </button>
        </section>

        <section className="dl-card is-library">
          <div className="dl-file" aria-hidden="true"><span className="dl-file-fold" /><b>{'XLSX'}</b></div>
          <div className="dl-main">
            <h3>{tr('Item library')}</h3>
            <p className="dk-muted">{tr('The whole menu as it is now: each dish and size with its price, SKU, category, add-ons, stock and whether it is sold.')}</p>
            <ul className="dl-cols" aria-label={tr('Its columns')}>{LIBRARY_COLS.map((c) => <li key={c}>{c}</li>)}<li className="is-more">{tr('and more')}</li></ul>
          </div>
          <button type="button" className="btn btn-primary tl-btn dl-go" disabled={!!busy || needPin} onClick={() => get('catalog')}>
            {busy === 'catalog' ? tr('Making the file…') : done.catalog ? '✓ ' + tr('Download again') : tr('Download the library')}
          </button>
        </section>

        {error && <div className="error-banner">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={!!busy}>{tr('Close')}</button>
        </div>
      </div>
    </div>
  );
}
