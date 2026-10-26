import { useCallback, useEffect, useMemo, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { activeIntlLocale, msg, tr } from '../../lib/i18n.jsx';
import './thirteenth.css';

// Stock sent between the restaurants (backend restaurantTransfers.service,
// migration 0194). The back office sends ingredients and supplies to the
// other restaurant and lists what went and came; what is on its way here is
// counted in — on the till too (More → Stock coming in) — matched to this
// restaurant's own items by name, or added as new.

function when(iso) { return new Date(iso).toLocaleString(activeIntlLocale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
function qtyText(n, unit) { return (Math.round(Number(n) * 100) / 100) + (unit && unit !== 'each' ? ' ' + unit : '×'); }
const STATUS = { sent: ['🚚', msg('On its way')], received: ['✅', msg('Counted in')], cancelled: ['↩️', msg('Taken back')] };

// Counting in one transfer: how many arrived of each, and which item it is here.
function Receive({ t, items, busy, onReceive }) {
  const [lines, setLines] = useState(() => t.lines.map((l) => ({ qty: String(l.qty), toId: l.match ? l.match.id : 'new' })));
  const [note, setNote] = useState('');
  function set(i, patch) { setLines(lines.map((x, k) => (k === i ? { ...x, ...patch } : x))); }
  return (
    <form className="xfr-recv" onSubmit={(e) => { e.preventDefault(); onReceive({ id: t.id, note, lines: lines.map((x) => ({ qty: Number(x.qty), toId: x.toId })) }); }}>
      <header>
        <span className="xfr-truck" aria-hidden="true">🚚</span>
        <div><strong>{tr('{ref} from {name}', { ref: t.ref, name: t.from.name })}</strong><small>{tr('Sent by {name}, {when}', { name: t.sentBy, when: when(t.sentAt) })}{t.note ? ' · “' + t.note + '”' : ''}</small></div>
        <b>{money(t.value)}</b>
      </header>
      <ul>
        {t.lines.map((l, i) => {
          const mine = items.filter((x) => x.type === l.type);
          const less = Number(lines[i].qty) < Number(l.qty);
          return (
            <li key={i} className={less ? 'is-short' : ''}>
              <span className="xfr-what"><strong>{l.name}</strong><small>{tr('{n} sent', { n: qtyText(l.qty, l.unit) })} · {l.type === 'supply' ? tr('Supply') : tr('Ingredient')}</small></span>
              <label className="xfr-got"><span>{tr('Arrived')}</span><input className="input" type="number" min="0" step="any" inputMode="decimal" value={lines[i].qty} onChange={(e) => set(i, { qty: e.target.value })} /></label>
              <label className="xfr-to"><span>{tr('Here it is')}</span>
                <select className="input" value={lines[i].toId} onChange={(e) => set(i, { toId: e.target.value })}>
                  <option value="new">＋ {tr('New: {name}', { name: l.name })}</option>
                  {mine.map((x) => <option key={x.id} value={x.id}>{x.name} ({qtyText(x.stock, x.unit)})</option>)}
                </select></label>
            </li>
          );
        })}
      </ul>
      <input className="input" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr('A note (optional), e.g. one bag torn')} aria-label={tr('Note')} />
      <button type="submit" className="btn btn-primary xfr-go" disabled={busy}>✅ {tr('Count it in')}</button>
    </form>
  );
}

function TransferRow({ t, busy, onCancel }) {
  const [icon, label] = STATUS[t.status];
  return (
    <li className={'xfr-row is-' + t.status + ' xfr-' + t.direction}>
      <span className="xfr-dir" aria-hidden="true">{t.direction === 'out' ? '↗' : '↙'}</span>
      <span className="xfr-row-main">
        <strong>{t.ref} · {t.direction === 'out' ? tr('to {name}', { name: t.to.name }) : tr('from {name}', { name: t.from.name })}</strong>
        <small>{t.lines.map((l) => qtyText(t.status === 'received' ? (l.receivedQty ?? l.qty) : l.qty, l.unit) + ' ' + l.name).join(', ')}</small>
        <small>{when(t.sentAt)} · {t.sentBy}{t.receivedAt ? ' → ' + t.receivedBy + ', ' + when(t.receivedAt) : ''}{t.short ? ' · ⚠️ ' + tr('{n} short', { n: t.short }) : ''}{t.receivedNote ? ' · “' + t.receivedNote + '”' : ''}</small>
      </span>
      <span className="xfr-row-end">
        <span className={'xfr-status is-' + t.status}>{icon} {tr(label)}</span>
        <b>{money(t.value)}</b>
        {t.status === 'sent' && t.direction === 'out' && <button type="button" className="pos-link is-bad" disabled={busy} onClick={() => onCancel(t)}>{tr('Take back')}</button>}
      </span>
    </li>
  );
}

export function TransfersTab({ token, pin, onFail }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [to, setTo] = useState('');
  const [lines, setLines] = useState([]);
  const [pick, setPick] = useState('');
  const [note, setNote] = useState('');
  const [flash, setFlash] = useState(null);
  const call = useCallback((body) => posFetch('POST', '/pos/transfers', token, { managerPin: pin || undefined, ...body }), [token, pin]);
  useEffect(() => { call({ action: 'view' }).then((d) => { setData(d); if (d.restaurants[0]) setTo(d.restaurants[0].id); }).catch(onFail); }, [call, onFail]);
  async function run(body, done) {
    setBusy(true); setFlash(null);
    try { setData(await call(body)); if (done) done(); } catch (e) { onFail(e); } finally { setBusy(false); }
  }
  const byKey = useMemo(() => new Map((data ? data.items : []).map((x) => [x.type + ':' + x.id, x])), [data]);
  if (!data) return <section className="ts-sec"><p className="dk-muted">{tr('Loading…')}</p></section>;
  if (!data.restaurants.length) return <section className="ts-sec"><div className="dk-empty"><span aria-hidden="true">🏠</span><p>{tr('There is no other restaurant to send stock to.')}</p></div></section>;
  const value = lines.reduce((a, l) => { const x = byKey.get(l.key); return a + (x ? x.unitCost * (Number(l.qty) || 0) : 0); }, 0);
  const free = data.items.filter((x) => x.stock > 0 && !lines.some((l) => l.key === x.type + ':' + x.id));
  return (
    <section className="ts-sec xfr">
      {flash && <div className="ts-flash" role="status">{flash}</div>}
      {data.incoming.map((t) => (
        <Receive key={t.id} t={t} items={data.items} busy={busy} onReceive={(body) => run({ action: 'receive', ...body }, () => setFlash(tr('{ref} counted in: it is on the stock now.', { ref: t.ref })))} />
      ))}
      <form className="xfr-send" onSubmit={(e) => { e.preventDefault(); run({ action: 'send', to, note, lines: lines.map((l) => { const [type, id] = l.key.split(':'); return { type, id, qty: Number(l.qty) }; }) }, () => { setLines([]); setNote(''); setFlash(tr('Sent: it is off your stock, on its way.')); }); }}>
        <header><span className="xfr-truck" aria-hidden="true">📦</span><div><strong>{tr('Send stock to another restaurant')}</strong><small>{tr('It comes off this restaurant\'s stock now, at what it cost; they count it in when it arrives.')}</small></div></header>
        <div className="xfr-send-top">
          <label><span>{tr('To')}</span><select className="input" value={to} onChange={(e) => setTo(e.target.value)}>{data.restaurants.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
          <label><span>{tr('Add')}</span>
            <select className="input" value={pick} onChange={(e) => { if (e.target.value) setLines(lines.concat([{ key: e.target.value, qty: '' }])); setPick(''); }}>
              <option value="">{tr('Pick an ingredient or a supply…')}</option>
              {free.map((x) => <option key={x.type + ':' + x.id} value={x.type + ':' + x.id}>{(x.type === 'supply' ? '📦 ' : '🧺 ') + x.name} ({qtyText(x.stock, x.unit)})</option>)}
            </select></label>
        </div>
        {lines.length > 0 && (
          <ul className="xfr-lines">
            {lines.map((l, i) => {
              const x = byKey.get(l.key);
              return (
                <li key={l.key}>
                  <span><strong>{x.name}</strong><small>{tr('{n} in stock', { n: qtyText(x.stock, x.unit) })} · {money(x.unitCost)}</small></span>
                  <input className="input" type="number" min="0" step="any" inputMode="decimal" max={x.stock} value={l.qty} onChange={(e) => setLines(lines.map((y, k) => (k === i ? { ...y, qty: e.target.value } : y)))} aria-label={tr('How many of {name}', { name: x.name })} autoFocus={i === lines.length - 1} />
                  <span className="xfr-unit">{x.unit === 'each' ? '' : x.unit}</span>
                  <button type="button" className="pos-link is-bad" onClick={() => setLines(lines.filter((y, k) => k !== i))} aria-label={tr('Take it off')}>✕</button>
                </li>
              );
            })}
          </ul>
        )}
        <input className="input" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr('A note (optional), e.g. for the weekend')} aria-label={tr('Note')} />
        <div className="xfr-send-foot">
          <span>{lines.length ? tr('{n} things · {amount}', { n: lines.length, amount: money(value) }) : tr('Nothing picked yet')}</span>
          <button type="submit" className="btn btn-primary xfr-go" disabled={busy || !lines.length || lines.some((l) => !(Number(l.qty) > 0))}>🚚 {tr('Send')}</button>
        </div>
      </form>
      <h3 className="xfr-h">{tr('The last 60 days')}</h3>
      {!data.list.length ? <p className="dk-muted">{tr('Nothing sent or received yet.')}</p> : (
        <ul className="xfr-list">{data.list.map((t) => <TransferRow key={t.id} t={t} busy={busy} onCancel={(x) => { if (window.confirm(tr('Take {ref} back? It goes back onto your stock.', { ref: x.ref }))) run({ action: 'cancel', id: x.id }); }} />)}</ul>
      )}
    </section>
  );
}

// On the till: what is on its way here, to count in.
export function IncomingDialog({ token, onClose }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  useEffect(() => { posFetch('POST', '/pos/transfers', token, { action: 'view' }).then(setData).catch((e) => setError(e.message)); }, [token]);
  async function receive(body, t) {
    setBusy(true); setError(null);
    try { setData(await posFetch('POST', '/pos/transfers', token, { action: 'receive', ...body })); setDone(t.ref); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={() => onClose(data)}>
      <div className="dialog xfr-dlg" role="dialog" aria-modal="true" aria-labelledby="xfr-title" onClick={(e) => e.stopPropagation()}>
        <div className="ckl-head">
          <span className="ckl-head-art is-xfr" aria-hidden="true">🚚</span>
          <div><h2 id="xfr-title">{tr('Stock coming in')}</h2><p>{!data ? tr('Loading…') : data.incoming.length ? tr('Count what arrived, then it goes onto the stock.') : tr('Nothing on its way here now.')}</p></div>
        </div>
        {done && <div className="ts-flash" role="status">✅ {tr('{ref} counted in: it is on the stock now.', { ref: done })}</div>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        {data && data.incoming.map((t) => <Receive key={t.id} t={t} items={data.items} busy={busy} onReceive={(body) => receive(body, t)} />)}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => onClose(data)}>{tr('Close')}</button></div>
      </div>
    </div>
  );
}
