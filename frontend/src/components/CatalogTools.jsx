import { useMemo, useState } from 'react';
import { api } from '../api/client';
import { tr } from '../lib/i18n.jsx';
import './CatalogTools.css';

// Products & Services tools (backend catalogOptions.service.js): an item's
// options, which make its variations, and many variations' prices, costs
// and stock edited at once.

function combos(options) {
  let out = [{}];
  options.forEach((o) => { const next = []; out.forEach((c) => o.choices.forEach((ch) => next.push({ ...c, [o.name]: ch }))); out = next; });
  return options.length ? out : [];
}

export function OptionsDialog({ item, onClose, onDone }) {
  const first = item.variations.find((v) => v.active) || item.variations[0] || {};
  const [options, setOptions] = useState(() => (item.options && item.options.length ? item.options.map((o) => ({ name: o.name, choices: [...o.choices], draft: '' })) : [{ name: tr('Size'), choices: [], draft: '' }]));
  const [price, setPrice] = useState(first.unitPrice || 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ready = options.filter((o) => o.name.trim() && o.choices.length);
  const made = combos(ready);
  const existing = new Set(item.variations.filter((v) => v.active).map((v) => v.name.toLowerCase()));
  const nameOf = (c) => ready.map((o) => c[o.name]).join(' / ');

  function change(i, patch) { setOptions((list) => list.map((o, j) => (j === i ? { ...o, ...patch } : o))); }
  function addChoice(i) {
    const o = options[i];
    const parts = o.draft.split(',').map((x) => x.trim()).filter(Boolean);
    const choices = [...o.choices];
    parts.forEach((p) => { if (!choices.some((c) => c.toLowerCase() === p.toLowerCase())) choices.push(p); });
    change(i, { choices, draft: '' });
  }
  async function save() {
    setBusy(true); setError('');
    try {
      const r = await api.put('/catalog/items/' + item.id + '/options', { options: options.filter((o) => o.name.trim() || o.choices.length).map((o) => ({ name: o.name, choices: o.choices })), unitPrice: Number(price) || 0 });
      onDone(r);
    } catch (e) { setError(e.message); setBusy(false); }
  }

  return (
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <div className="dialog cto" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="cto-title">
        <div className="cto-head">
          <span className="cto-ico" aria-hidden="true">🎛️</span>
          <div>
            <h2 id="cto-title">{tr('Options for {item}', { item: item.name })}</h2>
            <p className="dk-muted">{tr('Size, colour, finish…: each combination becomes a variation with its own price, code and stock. Taking a choice away puts its variations away; nothing sold is lost.')}</p>
          </div>
        </div>
        {options.map((o, i) => (
          <div className="cto-opt" key={i}>
            <div className="cto-opt-head">
              <input className="input cto-name" value={o.name} maxLength={30} placeholder={tr('Option, e.g. Size')} onChange={(e) => change(i, { name: e.target.value })} aria-label={tr('Option name')} />
              <button type="button" className="pos-link" onClick={() => setOptions((list) => list.filter((_, j) => j !== i))}>{tr('Remove')}</button>
            </div>
            <div className="cto-chips">
              {o.choices.map((c) => (
                <span key={c} className="cto-chip">{c}<button type="button" onClick={() => change(i, { choices: o.choices.filter((x) => x !== c) })} aria-label={tr('Remove {name}', { name: c })}>×</button></span>
              ))}
              <input className="cto-chip-input" value={o.draft} placeholder={o.choices.length ? tr('Add another…') : tr('Small, Medium, Large')}
                onChange={(e) => change(i, { draft: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addChoice(i); } }}
                onBlur={() => o.draft.trim() && addChoice(i)} aria-label={tr('Choices for {name}', { name: o.name || tr('this option') })} />
            </div>
          </div>
        ))}
        {options.length < 3 && <button type="button" className="btn btn-secondary cto-add" onClick={() => setOptions([...options, { name: '', choices: [], draft: '' }])}>+ {tr('Add an option')}</button>}
        <div className="cto-made">
          <div className="cto-made-head">
            <strong>{made.length === 1 ? tr('Makes 1 variation') : tr('Makes {n} variations', { n: made.length })}</strong>
            <label className="cto-price">{tr('New ones at')} <input className="input" type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
          </div>
          <div className="cto-made-list">
            {made.slice(0, 24).map((c) => { const n = nameOf(c); const old = existing.has(n.toLowerCase()); return <span key={n} className={'cto-var' + (old ? ' is-kept' : ' is-new')}>{old ? '✓ ' : '+ '}{n}</span>; })}
            {made.length > 24 && <span className="cto-var">… {made.length - 24}</span>}
          </div>
          {made.length > 100 && <div className="sqe-warn">⚠ {tr('That is more than 100 variations: fewer choices, please.')}</div>}
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy || made.length > 100}>{busy ? tr('Saving…') : tr('Save options')}</button>
        </div>
      </div>
    </div>
  );
}

// Many variations at once: price, cost, stock, on sale.
export function BulkEditDialog({ items, categories, onClose, onDone }) {
  const rows = useMemo(() => {
    const out = [];
    items.forEach((it) => it.variations.forEach((v) => out.push({ it, v })));
    return out;
  }, [items]);
  const [edits, setEdits] = useState({}); // id → { unitPrice, costPrice, stockQty, active }
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [archived, setArchived] = useState(false);
  const [pct, setPct] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const shown = rows.filter(({ it, v }) => (archived || (it.active && v.active) || edits[v.id])
    && (!cat || it.categoryId === cat)
    && (!q.trim() || (it.name + ' ' + v.name + ' ' + v.code).toLowerCase().includes(q.trim().toLowerCase())));
  const val = (v, k) => (edits[v.id] && edits[v.id][k] !== undefined ? edits[v.id][k] : v[k]);
  function set(v, k, x) {
    setEdits((e) => {
      const next = { ...(e[v.id] || {}), [k]: x };
      if (String(x) === String(v[k])) delete next[k];
      const out = { ...e, [v.id]: next };
      if (!Object.keys(next).length) delete out[v.id];
      return out;
    });
  }
  function bump() {
    const n = Number(pct);
    if (!n) return;
    shown.forEach(({ v }) => set(v, 'unitPrice', Math.max(0, Math.round(Number(val(v, 'unitPrice')) * (1 + n / 100) * 100) / 100)));
    setPct('');
  }
  const changed = Object.keys(edits);
  async function save() {
    setBusy(true); setError('');
    try {
      const r = await api.post('/catalog/bulk', { changes: changed.map((id) => ({ id, ...edits[id] })), note });
      onDone(r);
    } catch (e) { setError(e.message); setBusy(false); }
  }

  return (
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <div className="dialog ctb" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="ctb-title">
        <div className="cto-head">
          <span className="cto-ico" aria-hidden="true">🧮</span>
          <div>
            <h2 id="ctb-title">{tr('Edit many at once')}</h2>
            <p className="dk-muted">{tr('Change prices, costs, stock counts and what is on sale in one go. Every change is kept in the activity log.')}</p>
          </div>
        </div>
        <div className="ctb-tools">
          <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Search items or codes…')} aria-label={tr('Search')} />
          <select className="input" value={cat} onChange={(e) => setCat(e.target.value)} aria-label={tr('Category')}>
            <option value="">{tr('Every category')}</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <label className="ctb-check"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> {tr('Archived too')}</label>
          <span className="ctb-pct">
            <input className="input" type="number" step="1" value={pct} onChange={(e) => setPct(e.target.value)} placeholder="+10" aria-label={tr('Percent')} />%
            <button type="button" className="btn btn-secondary" onClick={bump} disabled={!Number(pct) || !shown.length}>{tr('Prices of these {n}', { n: shown.length })}</button>
          </span>
        </div>
        <div className="ctb-table-wrap">
          <table className="ctb-table">
            <thead><tr><th>{tr('Item')}</th><th>{tr('Price')}</th><th>{tr('Cost')}</th><th>{tr('Margin')}</th><th>{tr('Stock')}</th><th>{tr('On sale')}</th></tr></thead>
            <tbody>
              {shown.map(({ it, v }) => {
                const p = Number(val(v, 'unitPrice')), c = Number(val(v, 'costPrice'));
                const m = p > 0 && c > 0 ? Math.round(((p - c) / p) * 100) : null;
                const e = edits[v.id] || {};
                return (
                  <tr key={v.id} className={(Object.keys(e).length ? 'is-changed' : '') + (!val(v, 'active') ? ' is-off' : '')}>
                    <td><strong>{it.name}</strong>{v.name !== 'Regular' && <span className="dk-muted"> · {v.name}</span>}<small className="dk-muted">{v.code}</small></td>
                    <td><input className={'input' + (e.unitPrice !== undefined ? ' is-set' : '')} type="number" min="0" step="0.01" value={val(v, 'unitPrice')} onChange={(ev) => set(v, 'unitPrice', ev.target.value)} aria-label={tr('Price')} /></td>
                    <td><input className={'input' + (e.costPrice !== undefined ? ' is-set' : '')} type="number" min="0" step="0.01" value={val(v, 'costPrice')} onChange={(ev) => set(v, 'costPrice', ev.target.value)} aria-label={tr('Cost')} /></td>
                    <td className={'ctb-m' + (m !== null && m < 0 ? ' is-bad' : m !== null && m < 15 ? ' is-warn' : '')}>{m === null ? '—' : m + '%'}</td>
                    <td>{v.product ? <small className="dk-muted" title={v.product.name}>{tr('from stock')}</small>
                      : <input className={'input' + (e.stockQty !== undefined ? ' is-set' : '')} type="number" min="0" step="1" value={val(v, 'stockQty')} onChange={(ev) => set(v, 'stockQty', ev.target.value)} aria-label={tr('Stock')} />}</td>
                    <td><input type="checkbox" checked={!!val(v, 'active')} onChange={(ev) => set(v, 'active', ev.target.checked)} aria-label={tr('On sale')} /></td>
                  </tr>
                );
              })}
              {!shown.length && <tr><td colSpan={6} className="dk-muted ctb-none">{tr('Nothing matches.')}</td></tr>}
            </tbody>
          </table>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions ctb-foot">
          <input className="input ctb-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr('Why, for the log (e.g. new price list)')} maxLength={200} aria-label={tr('Why')} />
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !changed.length}>{busy ? tr('Saving…') : changed.length === 1 ? tr('Save 1 change') : tr('Save {n} changes', { n: changed.length })}</button>
        </div>
      </div>
    </div>
  );
}

