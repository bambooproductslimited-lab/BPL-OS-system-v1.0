import { useCallback, useEffect, useMemo, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { activeIntlLocale, msg, tr } from '../../lib/i18n.jsx';
import './twelfth.css';

// Waste and stock takes (backend restaurantWaste.service, migration 0193).
// On the till, anyone says what was thrown away and why (WasteDialog); it
// comes off the stock (a dish's recipe too) and its cost is kept. Whoever
// wrote it takes it back within 15 minutes. In the back office (WasteTab):
// the waste by reason, by item and by day against the sales, and stock
// takes — count everything, see what is missing or more than expected.

const REASONS = [['dropped', '🫳', msg('Dropped')], ['expired', '📅', msg('Past its date')], ['spoiled', '🤢', msg('Gone off')], ['made_wrong', '🔁', msg('Made wrong')],
  ['sent_back', '↩️', msg('Sent back')], ['staff_meal', '🍽️', msg('Staff meal')], ['other', '✳️', msg('Other')]];
const REASON = Object.fromEntries(REASONS.map(([k, icon, label]) => [k, [icon, label]]));
function timeOf(d) { return new Date(d).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' }); }
function dayOf(d) { return new Date(d + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { weekday: 'short', day: 'numeric', month: 'short' }); }

export function WasteDialog({ token, onClose, onToast }) {
  const [kinds, setKinds] = useState(null);
  const [today, setToday] = useState(null);
  const [kind, setKind] = useState('menu');
  const [q, setQ] = useState('');
  const [pick, setPick] = useState(null); // { type, id, name, unit, sizes }
  const [size, setSize] = useState('');
  const [qty, setQty] = useState('1');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const call = useCallback((body) => posFetch('POST', '/pos/waste', token, body), [token]);
  useEffect(() => {
    call({ action: 'choices' }).then(setKinds).catch((e) => setError(e.message));
    call({ action: 'today' }).then(setToday).catch(() => {});
  }, [call]);
  const list = useMemo(() => {
    if (!kinds) return [];
    const all = kind === 'menu' ? kinds.dishes.map((d) => ({ type: 'menu', id: d.id, name: d.name, sub: d.category, unit: 'each', sizes: d.sizes }))
      : (kind === 'ingredient' ? kinds.ingredients : kinds.supplies).map((s) => ({ type: kind, id: s.id, name: s.name, sub: tr('{n} {unit} left', { n: s.left, unit: s.unit }), unit: s.unit, sizes: [] }));
    const w = q.trim().toLowerCase();
    return w ? all.filter((x) => x.name.toLowerCase().includes(w)) : all;
  }, [kinds, kind, q]);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await call({ action: 'log', type: pick.type, id: pick.id, variationId: size || undefined, qty: Number(qty), reason, note: note.trim() });
      setToday(r);
      onToast(tr('Thrown away: {name}{cost}.', { name: r.logged.name, cost: r.logged.cost ? ' · ' + money(r.logged.cost) : '' }));
      setPick(null); setSize(''); setQty('1'); setReason(''); setNote('');
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function undo(w) {
    setBusy(true); setError(null);
    try { setToday(await call({ action: 'undo', id: w.id })); onToast(tr('Taken back: {name}.', { name: w.name })); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <form className="dialog wst" role="dialog" aria-modal="true" aria-labelledby="wst-title" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="wst-head">
          <span className="wst-head-art" aria-hidden="true">🗑️</span>
          <div><h2 id="wst-title">{tr('Throw something away')}</h2><p>{tr('What, how many and why: it comes off the stock, and the manager sees what it cost.')}</p></div>
        </div>
        <div className="wst-kinds" role="tablist">
          {[['menu', '🍲 ' + tr('A dish')], ['ingredient', '🧅 ' + tr('An ingredient')], ['supply', '🥤 ' + tr('A supply')]].map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? 'is-on' : ''} onClick={() => { setKind(k); setPick(null); setSize(''); }}>{label}</button>
          ))}
        </div>
        <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Find it')} aria-label={tr('Find it')} />
        {!kinds ? <p className="dk-muted">{error || tr('Loading…')}</p> : (
          <div className="wst-pick" role="radiogroup" aria-label={tr('What')}>
            {list.map((x) => (
              <button key={x.id} type="button" role="radio" aria-checked={!!pick && pick.id === x.id} className={pick && pick.id === x.id ? 'is-on' : ''} onClick={() => { setPick(x); setSize(''); }}>
                <strong>{x.name}</strong><small>{x.sub}</small>
              </button>
            ))}
            {!list.length && <p className="dk-muted">{tr('Nothing matches.')}</p>}
          </div>
        )}
        {pick && (
          <>
            <div className="wst-qty">
              <div className="field"><label htmlFor="wst-qty">{pick.unit === 'each' ? tr('How many') : tr('How much ({unit})', { unit: pick.unit })}</label>
                <input id="wst-qty" className="input" type="number" min="0.01" step="any" required value={qty} onChange={(e) => setQty(e.target.value)} /></div>
              {pick.sizes.length > 0 ? (
                <div className="field"><label htmlFor="wst-size">{tr('Size')}</label>
                  <select id="wst-size" className="input" value={size} onChange={(e) => setSize(e.target.value)}>
                    <option value="">{tr('The dish itself')}</option>
                    {pick.sizes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select></div>
              ) : <div className="field"><label htmlFor="wst-note">{tr('A note (optional)')}</label><input id="wst-note" className="input" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr('e.g. tray slipped at table 4')} /></div>}
            </div>
            {pick.sizes.length > 0 && <div className="field"><label htmlFor="wst-note2">{tr('A note (optional)')}</label><input id="wst-note2" className="input" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr('e.g. tray slipped at table 4')} /></div>}
            <div className="wst-reasons" role="radiogroup" aria-label={tr('Why')}>
              {REASONS.map(([k, icon, label]) => <button key={k} type="button" role="radio" aria-checked={reason === k} className={reason === k ? 'is-on' : ''} onClick={() => setReason(k)}><span aria-hidden="true">{icon}</span>{tr(label)}</button>)}
            </div>
          </>
        )}
        {error && <div className="error-banner" role="alert">{error}</div>}
        {today && today.list.length > 0 && (
          <div className="wst-today">
            <h3><span>{tr('Today')}</span><span>{money(today.cost)}</span></h3>
            <ul>
              {today.list.slice(0, 8).map((w) => (
                <li key={w.id} className={w.undone ? 'is-undone' : ''}>
                  <span aria-hidden="true">{REASON[w.reason][0]}</span>
                  <span>{w.qty}{w.unit === 'each' ? '× ' : ' ' + w.unit + ' '}{w.name} <small>· {tr(REASON[w.reason][1])} · {w.by} · {timeOf(w.at)}</small></span>
                  <b>{money(w.cost)}</b>
                  {w.canUndo && <button type="button" className="pos-link" disabled={busy} onClick={() => undo(w)}>{tr('Take back')}</button>}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{tr('Close')}</button>
          <button type="submit" className="btn btn-primary wst-go" disabled={busy || !pick || !reason || !(Number(qty) > 0)}>🗑️ {tr('Throw away')}</button>
        </div>
      </form>
    </div>
  );
}

// ── the back office ──

const RANGES = [[7, msg('7 days')], [30, msg('30 days')], [90, msg('90 days')]];
function isoDaysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10); }

export function WasteTab({ token, pin, onFail }) {
  const [view, setView] = useState('waste');
  return (
    <section className="ts-sec">
      <div className="ts-chips" role="tablist">
        <button type="button" role="tab" aria-selected={view === 'waste'} className={view === 'waste' ? 'is-on' : ''} onClick={() => setView('waste')}>🗑️ {tr('Waste')}</button>
        <button type="button" role="tab" aria-selected={view === 'take'} className={view === 'take' ? 'is-on' : ''} onClick={() => setView('take')}>📋 {tr('Stock take')}</button>
      </div>
      {view === 'waste' ? <WasteReport token={token} pin={pin} onFail={onFail} /> : <StockTake token={token} pin={pin} onFail={onFail} />}
    </section>
  );
}

function WasteReport({ token, pin, onFail }) {
  const [days, setDays] = useState(30);
  const [d, setD] = useState(null);
  useEffect(() => {
    setD(null);
    posFetch('POST', '/pos/settings/waste', token, { managerPin: pin || undefined, from: isoDaysAgo(days - 1) }).then(setD).catch(onFail);
  }, [token, pin, days, onFail]);
  if (!d) return <p className="dk-muted">{tr('Loading…')}</p>;
  const maxR = Math.max(1, ...d.byReason.map((r) => r.cost));
  const maxI = Math.max(1, ...d.byItem.map((r) => r.cost));
  const maxD = Math.max(1, ...d.byDay.map((r) => r.cost));
  return (
    <div className="wst-report">
      <div className="ts-chips" role="radiogroup" aria-label={tr('Period')}>
        {RANGES.map(([n, label]) => <button key={n} type="button" role="radio" aria-checked={days === n} className={days === n ? 'is-on' : ''} onClick={() => setDays(n)}>{tr(label)}</button>)}
      </div>
      <div className="wst-hero">
        <div className={d.cost > 0 ? 'is-hot' : ''}><small>{tr('Thrown away')}</small><strong>{money(d.cost)}</strong></div>
        <div><small>{tr('Times')}</small><strong>{d.count}</strong></div>
        <div><small>{tr('Of the sales')}</small><strong>{d.ofSales == null ? '–' : d.ofSales + '%'}</strong></div>
        <div><small>{tr('Sales then')}</small><strong>{money(d.sales)}</strong></div>
      </div>
      {!d.count ? <div className="dk-empty"><p>{tr('Nothing thrown away in this time. On the till: More → Throw something away.')}</p></div> : (
        <>
          <div className="wst-cols">
            <div className="wst-box"><h3>{tr('Why')}</h3>
              <ul className="wst-bars">{d.byReason.map((r) => <li key={r.reason} style={{ '--w': r.cost / maxR }}><span>{REASON[r.reason][0]} {tr(REASON[r.reason][1])} <small className="dk-muted">×{r.count}</small></span><b>{money(r.cost)}</b><i /></li>)}</ul></div>
            <div className="wst-box"><h3>{tr('What')}</h3>
              <ul className="wst-bars">{d.byItem.map((r) => <li key={r.name} style={{ '--w': r.cost / maxI }}><span>{r.name} <small className="dk-muted">{r.qty}{r.unit === 'each' ? '×' : ' ' + r.unit}</small></span><b>{money(r.cost)}</b><i /></li>)}</ul></div>
          </div>
          <div className="wst-box"><h3>{tr('Each day')}</h3>
            <div className="wst-days">{d.byDay.map((r) => <span key={r.day} style={{ '--h': r.cost / maxD }} title={dayOf(r.day) + ' · ' + money(r.cost)} />)}</div></div>
          <div className="wst-box"><h3>{tr('The latest')}</h3>
            <ul className="wst-bars">{d.list.slice(0, 12).map((w) => <li key={w.id} style={{ '--w': 0 }}><span>{REASON[w.reason][0]} {w.qty}{w.unit === 'each' ? '× ' : ' ' + w.unit + ' '}{w.name} <small className="dk-muted">· {w.by} · {new Date(w.at).toLocaleString(activeIntlLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}{w.note ? ' · ' + w.note : ''}</small></span><b>{money(w.cost)}</b></li>)}</ul></div>
        </>
      )}
    </div>
  );
}

const GROUPS = [['menu', msg('Dishes')], ['ingredient', msg('Ingredients')], ['supply', msg('Supplies')]];
function StockTake({ token, pin, onFail }) {
  const [d, setD] = useState(null);
  const [counts, setCounts] = useState({}); // 'type:id' → typed figure
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const call = useCallback((body) => posFetch('POST', '/pos/stock-take', token, { managerPin: pin || undefined, ...body }), [token, pin]);
  const take = useCallback((r) => {
    setD(r);
    setCounts(r.open ? Object.fromEntries(r.open.lines.map((l) => [l.type + ':' + l.id, l.counted == null ? '' : String(l.counted)])) : {});
  }, []);
  useEffect(() => { call({ action: 'list' }).then(take).catch(onFail); }, [call, take, onFail]);
  async function act(action) {
    if (action === 'finish' && !window.confirm(tr('Finish the stock take? Each counted figure becomes the stock.'))) return;
    if (action === 'drop' && !window.confirm(tr('Drop this stock take? Nothing changes.'))) return;
    setBusy(true);
    try {
      const lines = d && d.open ? d.open.lines.map((l) => ({ type: l.type, id: l.id, counted: counts[l.type + ':' + l.id] })) : undefined;
      take(await call({ action, lines, note }));
    } catch (err) { onFail(err); } finally { setBusy(false); }
  }
  if (!d) return <p className="dk-muted">{tr('Loading…')}</p>;
  if (!d.open) {
    return (
      <div className="stk">
        <div className="stk-bar"><span aria-hidden="true">📋</span><div><strong>{tr('Count everything in one go')}</strong><br /><small>{tr('Every dish that counts its stock, every ingredient and supply, with what the till expects. Counted, each figure becomes the stock.')}</small></div>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act('start')}>{tr('Start a stock take')}</button></div>
        {d.past.length > 0 && (
          <ul className="stk-past">
            {d.past.map((t) => (
              <li key={t.id}><strong>{new Date(t.finishedAt || t.createdAt).toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', year: 'numeric' })}</strong>
                <span>{t.status === 'dropped' ? tr('Dropped') : tr('{n} counted', { n: t.counted })}</span>
                {t.status === 'done' && <span className="stk-diff is-less">{tr('{amount} missing', { amount: money(t.missing) })}</span>}
                {t.status === 'done' && t.found > 0 && <span className="stk-diff is-more">{tr('{amount} more', { amount: money(t.found) })}</span>}
                <small className="dk-muted">{t.finishedBy || t.startedBy}{t.note ? ' · ' + t.note : ''}</small></li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  const lines = d.open.lines;
  const typed = lines.filter((l) => counts[l.type + ':' + l.id] !== '' && counts[l.type + ':' + l.id] != null).length;
  return (
    <div className="stk">
      <div className="stk-bar">
        <div><strong>{tr('Stock take started by {name}', { name: d.open.startedBy })}</strong><br /><small>{tr('{n} of {total} counted', { n: typed, total: lines.length })}</small></div>
        <span className="stk-progress" style={{ '--p': typed / Math.max(1, lines.length) }}><i /></span>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => act('save')}>{tr('Save')}</button>
        <button type="button" className="btn btn-primary" disabled={busy || !typed} onClick={() => act('finish')}>✓ {tr('Finish')}</button>
        <button type="button" className="pos-link is-bad" disabled={busy} onClick={() => act('drop')}>{tr('Drop it')}</button>
      </div>
      {GROUPS.map(([type, label]) => {
        const rows = lines.filter((l) => l.type === type);
        if (!rows.length) return null;
        return (
          <div key={type} className="stk-group">
            <h3>{tr(label)}</h3>
            <ul className="stk-rows">
              {rows.map((l) => {
                const k = l.type + ':' + l.id, v = counts[k];
                const diff = v === '' || v == null ? null : Math.round((Number(v) - l.expected) * 100) / 100;
                return (
                  <li key={k} className={diff != null ? 'is-counted' : ''}>
                    <span><strong>{l.name}</strong><br /><small>{l.unit}{l.unitCost ? ' · ' + money(l.unitCost) : ''}</small></span>
                    <span className="stk-exp dk-muted">{tr('expected {n}', { n: l.expected })}</span>
                    <input className="input" type="number" min="0" step="any" inputMode="decimal" value={v} onChange={(e) => setCounts({ ...counts, [k]: e.target.value })} aria-label={tr('Counted: {name}', { name: l.name })} placeholder="–" />
                    <span className={'stk-diff' + (diff == null || diff === 0 ? '' : diff < 0 ? ' is-less' : ' is-more')}>{diff == null ? '' : diff === 0 ? '✓' : (diff > 0 ? '+' : '') + diff}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      <div className="field"><label htmlFor="stk-note">{tr('A note (optional)')}</label><input id="stk-note" className="input" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr('e.g. Sunday night count')} /></div>
    </div>
  );
}
