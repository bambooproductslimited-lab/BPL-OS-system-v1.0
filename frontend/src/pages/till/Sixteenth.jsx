import { useCallback, useEffect, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';
import './sixteenth.css';

// The sixteenth batch on the till (migration 0197):
//  - Back office → Menu and stock → Prices: what each ingredient and supply
//    cost every time it came in, the last against the one before, the 90-day
//    low and high, which supplier sold it for less and the dishes it goes
//    into; when a purchase order comes in dearer by more than the share set
//    here, the managers are told (restaurantPrices.service).

function dayText(day) { return day ? new Date(day + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '—'; }
function cost(n) { return n == null ? '—' : money(n); }

// The price over its last fill-ins: one line, the latest marked.
function Spark({ points, tone }) {
  if (points.length < 2) return <span className="prc-spark is-none">{points.length ? tr('1 price so far') : tr('No price yet')}</span>;
  const w = 120, h = 34, pad = 4;
  const vals = points.map((p) => p.cost);
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const xy = points.map((p, i) => [pad + i * (w - pad * 2) / (points.length - 1), h - pad - (p.cost - lo) / span * (h - pad * 2)]);
  const last = xy[xy.length - 1];
  return (
    <svg className={'prc-spark is-' + tone} width={w} height={h} role="img" aria-label={tr('Price over time: from {from} to {to}', { from: money(vals[0]), to: money(vals[vals.length - 1]) })}>
      <polyline points={xy.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ')} />
      <circle cx={last[0]} cy={last[1]} r="4" />
      {points.map((p, i) => <title key={i}>{dayText(p.day)}: {money(p.cost)}</title>)}
    </svg>
  );
}

function Change({ x }) {
  if (x.change == null) return <span className="prc-chg is-flat">— {tr('no change yet')}</span>;
  if (x.change > 0) return <span className={'prc-chg ' + (x.rose ? 'is-up' : 'is-upish')}>▲ {tr('{n}% dearer', { n: x.change })}</span>;
  if (x.change < 0) return <span className="prc-chg is-down">▼ {tr('{n}% cheaper', { n: -x.change })}</span>;
  return <span className="prc-chg is-flat">= {tr('same price')}</span>;
}

export function PricesTab({ token, pin, onFail }) {
  const [data, setData] = useState(null);
  const [only, setOnly] = useState('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const [pct, setPct] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const call = useCallback((body) => posFetch('POST', '/pos/settings/prices', token, { managerPin: pin || undefined, ...body }), [token, pin]);
  useEffect(() => { call({ action: 'list' }).then((d) => { setData(d); setPct(String(d.settings.alertPercent)); }).catch(onFail); }, [call, onFail]);
  if (!data) return <section className="ts-sec"><p className="dk-muted">{tr('Loading…')}</p></section>;
  const s = data.summary;
  async function saveAlert(e) {
    e.preventDefault();
    setBusy(true);
    try { const d = await call({ action: 'settings', alertPercent: Number(pct) }); setData(d); setFlash('🔔 ' + tr('Managers are told when a price goes up by {n}% or more.', { n: d.settings.alertPercent })); }
    catch (err) { onFail(err); } finally { setBusy(false); }
  }
  const words = q.trim().toLowerCase();
  const list = data.items.filter((x) => (only === 'up' ? x.change > 0 : only === 'down' ? x.change < 0 : only === 'cheaper' ? x.suppliers.length > 1 && x.last && x.suppliers[0].avg < x.last.cost : x.points.length > 0 || only === 'every') && (!words || x.name.toLowerCase().includes(words)))
    .sort((a, b) => (only === 'all' || only === 'up' ? (b.change || 0) - (a.change || 0) : a.name.localeCompare(b.name)));
  return (
    <section className="ts-sec prc">
      {flash && <div className="ts-flash" role="status">{flash}</div>}
      <div className="prc-cards">
        <div className="prc-card is-bad"><small>📈 {tr('Gone up')}</small><b>{s.rises}</b><span>{s.biggest ? tr('most: {name} +{n}%', { name: s.biggest.name, n: s.biggest.change }) : tr('nothing over {n}%', { n: data.settings.alertPercent })}</span></div>
        <div className="prc-card is-good"><small>📉 {tr('Gone down')}</small><b>{s.falls}</b><span>{s.average != null ? tr('on average {n}% since the price before', { n: (s.average > 0 ? '+' : '') + s.average }) : '—'}</span></div>
        <div className="prc-card is-violet"><small>🏷️ {tr('Cheaper elsewhere')}</small><b>{s.cheaperElsewhere}</b><span>{tr('another supplier sold it for less')}</span></div>
        <div className="prc-card is-calm"><small>🧺 {tr('Bought in 30 days')}</small><b>{money(s.spent30)}</b><span>{s.tracked === 1 ? tr('1 item with prices') : tr('{n} items with prices', { n: s.tracked })}</span></div>
      </div>
      <form className="prc-alert" onSubmit={saveAlert}>
        <span aria-hidden="true">🔔</span>
        <label htmlFor="prc-pct">{tr('Tell the managers when an order comes in dearer by')}</label>
        <input id="prc-pct" className="input" type="number" min="0" max="100" step="0.5" value={pct} onChange={(e) => setPct(e.target.value)} />
        <b>%</b>
        <button type="submit" className="btn btn-secondary" disabled={busy || Number(pct) === data.settings.alertPercent}>{tr('Save')}</button>
      </form>
      <div className="prc-tools">
        <div className="prc-seg" role="tablist">
          {[['all', tr('With prices')], ['up', tr('Gone up')], ['down', tr('Gone down')], ['cheaper', tr('Cheaper elsewhere')], ['every', tr('Everything')]].map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={only === k} className={only === k ? 'is-on' : ''} onClick={() => setOnly(k)}>{l}</button>)}
        </div>
        <input className="input prc-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Search')} aria-label={tr('Search')} />
      </div>
      {!list.length ? <p className="prc-none">{only === 'all' ? tr('No prices yet: they come from purchase orders received, and stock entered as come in with its price.') : tr('Nothing here.')}</p> : (
        <div className="prc-list">
          {list.map((x) => {
            const key = x.type + ':' + x.id, isOpen = open === key;
            const cheapest = x.suppliers.find((p) => p.cheapest);
            return (
              <div key={key} className={'prc-item' + (x.rose ? ' is-up' : '') + (isOpen ? ' is-open' : '')}>
                <button type="button" className="prc-row" onClick={() => setOpen(isOpen ? null : key)} aria-expanded={isOpen}>
                  <span className="prc-name"><b>{x.name}</b><small>{x.type === 'ingredient' ? '🥕 ' + tr('Ingredient') : '📦 ' + tr('Supply')} · {tr('per {unit}', { unit: x.unit })}{x.supplier ? ' · ' + x.supplier : ''}</small></span>
                  <Spark points={x.points} tone={x.rose ? 'up' : x.fell ? 'down' : 'flat'} />
                  <span className="prc-now"><b>{cost(x.last ? x.last.cost : x.cost)}</b><Change x={x} /></span>
                </button>
                {isOpen && (
                  <div className="prc-more">
                    <div className="prc-facts">
                      <span><small>{tr('Last')}</small><b>{cost(x.last && x.last.cost)}</b><i>{x.last ? dayText(x.last.day) : ''}</i></span>
                      <span><small>{tr('Before')}</small><b>{cost(x.prev && x.prev.cost)}</b><i>{x.prev ? dayText(x.prev.day) : ''}</i></span>
                      <span><small>{tr('90 days, low – high')}</small><b>{x.min90 != null ? money(x.min90) + ' – ' + money(x.max90) : '—'}</b><i>{x.avg90 != null ? tr('average {amount}', { amount: money(x.avg90) }) : ''}</i></span>
                    </div>
                    {x.suppliers.length > 0 && (
                      <div className="prc-sups">
                        <h4>{tr('Suppliers, the last 12 months')}</h4>
                        {x.suppliers.map((p) => (
                          <span key={p.name} className={p.cheapest ? 'is-cheap' : ''}>
                            <b>{p.cheapest ? '🏷️ ' : ''}{p.name}</b>
                            <small>{p.n === 1 ? tr('1 order') : tr('{n} orders', { n: p.n })} · {tr('last {amount}', { amount: money(p.last) })}</small>
                            <i>{tr('average {amount}', { amount: money(p.avg) })}</i>
                          </span>
                        ))}
                        {cheapest && x.last && cheapest.avg < x.last.cost && <p className="prc-tip">💡 {tr('{name} sold it for {amount} on average: {n}% less than the last price.', { name: cheapest.name, amount: money(cheapest.avg), n: Math.round((x.last.cost - cheapest.avg) / x.last.cost * 100) })}</p>}
                      </div>
                    )}
                    {x.dishes.length > 0 && <p className="prc-dishes">🍽️ {tr('Goes into: {dishes}', { dishes: x.dishes.join(', ') })}</p>}
                    {x.points.length > 0 && (
                      <div className="prc-hist">
                        {x.points.slice().reverse().map((p, i) => <span key={i}><small>{dayText(p.day)}</small><b>{money(p.cost)}</b></span>)}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
