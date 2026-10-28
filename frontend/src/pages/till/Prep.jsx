import { useCallback, useEffect, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';
import './thirteenth.css';

// The kitchen's prep list (backend restaurantPrep.service, migration 0194),
// on the till's More menu and the kitchen screen: what to have ready a day —
// the usual for that weekday with a little extra, and what is ordered ahead
// on the website and for catering — the ingredients that takes against the
// stock, and a tick on each dish as it is made.

function dayOf(n) { return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10); }
function dayWords(d, n) {
  if (n === 0) return tr('Today');
  if (n === 1) return tr('Tomorrow');
  return new Date(d + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { weekday: 'short', day: 'numeric', timeZone: 'UTC' });
}
function timeOf(iso) { return new Date(iso).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }); }
function qtyText(n, unit) { return (Math.round(n * 100) / 100) + (unit && unit !== 'each' ? ' ' + unit : ''); }

export default function PrepDialog({ token, onClose }) {
  const [n, setN] = useState(0);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [weeks, setWeeks] = useState(4);
  const [buffer, setBuffer] = useState(10);
  const [setOpen, setSetOpen] = useState(false);
  const call = useCallback((body) => posFetch('POST', '/pos/prep', token, { day: dayOf(n), ...body }), [token, n]);
  useEffect(() => {
    setData(null); setError(null);
    call({ action: 'view' }).then((d) => { setData(d); setWeeks(d.weeks); setBuffer(d.buffer); }).catch((e) => setError(e.message));
  }, [call]);
  async function act(body, key) {
    setBusy(key || 'x'); setError(null);
    try { setData(await call(body)); } catch (e) { setError(e.message); } finally { setBusy(null); }
  }
  const days = [0, 1, 2, 3, 4, 5, 6];
  const left = data ? data.dishes.length - data.done : 0;
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog prp print-solo" role="dialog" aria-modal="true" aria-labelledby="prp-title" onClick={(e) => e.stopPropagation()}>
        <div className="prp-head">
          <span className="prp-head-art" aria-hidden="true">🔪</span>
          <div>
            <h2 id="prp-title">{tr('Prep list')}</h2>
            <p>{data ? (data.dishes.length ? (left ? tr('{n} of {total} dishes still to make', { n: left, total: data.dishes.length }) : '🎉 ' + tr('Everything is made')) : tr('Nothing expected that day yet')) : tr('Loading…')}</p>
          </div>
          {data && data.canSet && <button type="button" className="pos-link prp-set-btn" onClick={() => setSetOpen(!setOpen)}>⚙️ {tr('How it counts')}</button>}
        </div>
        <div className="prp-days" role="radiogroup" aria-label={tr('Day')}>
          {days.map((k) => <button key={k} type="button" role="radio" aria-checked={n === k} className={n === k ? 'is-on' : ''} onClick={() => setN(k)}>{dayWords(dayOf(k), k)}</button>)}
        </div>
        {setOpen && data && (
          <form className="prp-settings" onSubmit={(e) => { e.preventDefault(); act({ action: 'settings', weeks, buffer }, 'set'); setSetOpen(false); }}>
            <label><span>{tr('The usual: the same weekday over the last')}</span>
              <select className="input" value={weeks} onChange={(e) => setWeeks(Number(e.target.value))}>{[1, 2, 3, 4, 6, 8, 12].map((w) => <option key={w} value={w}>{tr('{n} weeks', { n: w })}</option>)}</select></label>
            <label><span>{tr('Make a little extra, to be safe')}</span>
              <select className="input" value={buffer} onChange={(e) => setBuffer(Number(e.target.value))}>{[0, 5, 10, 15, 20, 25, 30, 50].map((b) => <option key={b} value={b}>+{b}%</option>)}</select></label>
            <button type="submit" className="btn btn-primary" disabled={busy === 'set'}>{tr('Save')}</button>
          </form>
        )}
        {error && <div className="error-banner" role="alert">{error}</div>}
        {!data ? <p className="dk-muted">{tr('Loading…')}</p> : (
          <>
            <div className="prp-pills">
              <span>🍽️ {tr('{n} dishes', { n: data.dishes.length })}</span>
              {data.ahead.length > 0 && <span>🗓️ {tr('{n} ordered ahead', { n: data.ahead.length })}</span>}
              {data.ahead.some((o) => o.catering) && <span className="is-cater">🎉 {tr('{n} catering', { n: data.ahead.filter((o) => o.catering).length })}</span>}
              {(data.events || []).length > 0 && <span className="is-event">🥂 {data.events.length === 1 ? tr('1 event') : tr('{n} events', { n: data.events.length })}</span>}
              {data.bookings.count > 0 && <span>📅 {tr('{n} bookings, {guests} guests', { n: data.bookings.count, guests: data.bookings.guests })}</span>}
              {data.short > 0 && <span className="is-short">⚠️ {tr('{n} ingredients short', { n: data.short })}</span>}
              <small>{tr('The usual: the last {weeks} weeks, +{buffer}%', { weeks: data.weeks, buffer: data.buffer })}</small>
            </div>
            {!data.dishes.length ? (
              <div className="dk-empty"><span aria-hidden="true">🍳</span><p>{tr('No sales on that weekday in the last weeks, and nothing ordered ahead.')}</p></div>
            ) : (
              <ul className="prp-list">
                {data.dishes.map((d, i) => (
                  <li key={d.id} className={(d.done ? 'is-done' : '') + (d.catering ? ' is-cater' : '') + (d.event ? ' is-event' : '')} style={{ '--i': i }}>
                    <button type="button" className="prp-tick" aria-pressed={!!d.done} disabled={busy === d.key}
                      onClick={() => act(d.done ? { action: 'tick', key: d.key, done: false } : { action: 'tick', key: d.key, qty: d.total }, d.key)}
                      aria-label={d.done ? tr('Not made yet: {name}', { name: d.name }) : tr('Made: {name}', { name: d.name })}>{d.done ? '✓' : ''}</button>
                    <span className="prp-name">
                      <strong>{d.name}</strong>
                      <span className="prp-why">
                        {d.fromUsual > 0 && <em>{tr('usual {n}', { n: d.fromUsual })}</em>}
                        {d.ahead > 0 && <em className="is-ahead">🗓️ {tr('ordered {n}', { n: d.ahead })}</em>}
                        {d.catering > 0 && <em className="is-cater">🎉 {tr('catering {n}', { n: d.catering })}{d.serves ? ' · ' + tr('serves {n}', { n: d.serves * d.catering }) : ''}</em>}
                        {d.event > 0 && <em className="is-event">🥂 {tr('event {n}', { n: d.event })}</em>}
                        {!d.hasRecipe && <em className="is-norecipe">{tr('no recipe')}</em>}
                      </span>
                      {d.done && <small>✓ {tr('{name} at {time}', { name: d.done.by, time: timeOf(d.done.at) })}</small>}
                    </span>
                    <b className="prp-total">{d.total}</b>
                  </li>
                ))}
              </ul>
            )}
            {data.ingredients.length > 0 && (
              <section className="prp-sec">
                <h3>🧺 {tr('Ingredients it takes')}</h3>
                <ul className="prp-ing">
                  {data.ingredients.map((g) => (
                    <li key={g.id} className={g.short > 0 ? 'is-short' : ''}>
                      <span className="prp-ing-name"><strong>{g.name}</strong><small>{tr('{need} needed · {stock} in stock', { need: qtyText(g.need, g.unit), stock: qtyText(g.stock, g.unit) })}{g.cost > 0 ? ' · ' + money(g.cost) : ''}</small></span>
                      <span className="prp-bar" style={{ '--fill': Math.min(1, g.stock / Math.max(g.need, 0.0001)) }}><i /></span>
                      <b>{g.short > 0 ? tr('{n} short', { n: qtyText(g.short, g.unit) }) : '✓'}</b>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {(data.events || []).length > 0 && (
              <section className="prp-sec">
                <h3>🥂 {tr('Events that day')}</h3>
                <ul className="prp-ahead">
                  {data.events.map((e) => (
                    <li key={e.id} className="is-event"><b>{timeOf(e.at)}</b><span><strong>{e.ref} · {e.occasion || tr('Event')} · {e.name}</strong><small>{tr('{n} guests', { n: e.guests })}</small></span></li>
                  ))}
                </ul>
              </section>
            )}
            {data.ahead.length > 0 && (
              <section className="prp-sec">
                <h3>🗓️ {tr('Ordered ahead for that day')}</h3>
                <ul className="prp-ahead">
                  {data.ahead.map((o) => (
                    <li key={o.id} className={o.catering ? 'is-cater' : ''}>
                      <b>{timeOf(o.at)}</b>
                      <span><strong>{o.ref} · {o.name}</strong><small>{o.catering ? '🎉 ' + tr('Catering for {n} guests', { n: o.catering.guests }) + ' · ' : ''}{tr('{n} dishes', { n: o.dishes })} · {o.fulfillment === 'pickup' ? tr('Pickup') : tr('Delivery')}{o.status === 'pending' ? ' · ' + tr('not confirmed yet') : ''}</small></span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={() => window.print()} disabled={!data}>🖨️ {tr('Print')}</button>
          <button type="button" className="btn btn-primary" onClick={onClose}>{tr('Close')}</button>
        </div>
      </div>
    </div>
  );
}
