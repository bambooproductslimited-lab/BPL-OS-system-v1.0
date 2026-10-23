import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '../../components/DashKit';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { activeIntlLocale, msg, tr } from '../../lib/i18n.jsx';
import { CURRENCY_LABEL, FULFILLMENT, FulfillmentIcon, MethodGlyph, fmt, fulfillmentName, methodName } from './tillShared';
import { modsWords } from './tillBill';

// The till settings' sales report (TillSettings.jsx → Sales): every sale and
// refund of some days, newest first, and what a manager reads off them —
// net sales after refunds, how the money came in, dine in / pickup /
// delivery, each cashier, the busy hours, the dishes sold most, dollars and
// yuan taken. A tap on a transaction opens its dishes and how it was paid.
// Backend: restaurantTillSales.service.js (POST /pos/settings/sales).

const RANGES = [['today', msg('Today')], ['yesterday', msg('Yesterday')], ['week', msg('Last 7 days')], ['month', msg('This month')], ['lastMonth', msg('Last month')], ['year', msg('Last 12 months')], ['day', msg('A day…')], ['span', msg('From… to…')]];
// Where a sale was rung up: this till, or Square before it (brought in by the OS's Square import).
const SOURCES = [['', msg('Till and Square')], ['till', msg('This till')], ['square', msg('From Square')]];
const KINDS = [['all', msg('All transactions')], ['sales', msg('Sales')], ['refunds', msg('Refunds')], ['iou', msg('Sold on IOU')], ['voided', msg('Voided')]];
const METHODS = ['cash', 'mobile_money', 'alipay', 'wechat', 'vip', 'iou', 'card', 'bank_transfer', 'other'];
function dayISO(d) { return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
function pct(part, whole) { return whole > 0 ? Math.round((part / whole) * 100) : 0; }
function hourLabel(h) { return new Date(2000, 0, 1, h).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' }); }

export default function SalesReport({ token, pin, onFail }) {
  const today = dayISO(new Date());
  const [range, setRange] = useState('today');
  const [day, setDay] = useState(today);
  const [span, setSpan] = useState({ from: today.slice(0, 8) + '01', to: today });
  const [source, setSource] = useState('');
  const [method, setMethod] = useState('');
  const [fulfillment, setFulfillment] = useState('');
  const [cashier, setCashier] = useState('');
  const [kind, setKind] = useState('all');
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const dates = useMemo(() => {
    const d = new Date();
    if (range === 'today') return { from: today, to: today };
    if (range === 'yesterday') { const y = dayISO(new Date(d.getTime() - 86400000)); return { from: y, to: y }; }
    if (range === 'week') return { from: dayISO(new Date(d.getTime() - 6 * 86400000)), to: today };
    if (range === 'month') return { from: today.slice(0, 8) + '01', to: today };
    if (range === 'lastMonth') { const first = new Date(d.getFullYear(), d.getMonth() - 1, 1); const last = new Date(d.getFullYear(), d.getMonth(), 0); return { from: dayISO(first), to: dayISO(last) }; }
    if (range === 'year') return { from: dayISO(new Date(d.getTime() - 364 * 86400000)), to: today };
    if (range === 'span') return span;
    return { from: day, to: day };
  }, [range, day, today, span]);
  const body = useCallback((extra) => ({
    managerPin: pin || undefined, from: dates.from, to: dates.to, method: method || undefined, fulfillment: fulfillment || undefined,
    cashierId: cashier || undefined, kind, q: q || undefined, source: source || undefined, ...extra
  }), [pin, dates, method, fulfillment, cashier, kind, q, source]);
  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      try { const d = await posFetch('POST', '/pos/settings/sales', token, body()); if (live) { setData(d); setOpen(null); } } catch (err) { if (live) onFail(err); }
    }, q ? 300 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [token, body, q, onFail]);

  async function more() {
    setBusy(true);
    try {
      const d = await posFetch('POST', '/pos/settings/sales', token, body({ offset: data.rows.length }));
      setData({ ...data, rows: data.rows.concat(d.rows), more: d.more });
    } catch (err) { onFail(err); } finally { setBusy(false); }
  }
  async function download() {
    setBusy(true);
    try {
      const d = await posFetch('POST', '/pos/settings/sales', token, body({ limit: 2000 }));
      const head = [tr('When'), tr('Order'), tr('Transaction'), tr('Order type'), tr('Table'), tr('Customer'), tr('Cashier'), tr('Paid by'), tr('Dishes'), tr('Amount (GHS)'), tr('Refunded (GHS)')];
      const rows = d.rows.map((r) => [
        new Date(r.at).toLocaleString(activeIntlLocale()), r.orderNo, r.kind === 'refund' ? tr('Refund') : r.status === 'voided' ? tr('Voided') : tr('Sale'),
        fulfillmentName(r.fulfillment), r.table || '', r.customer || '', r.cashier || '',
        r.kind === 'refund' ? methodName(r.method) : r.payments.map((p) => methodName(p.method) + ' ' + (p.currency === 'GHS' ? p.amount.toFixed(2) : CURRENCY_LABEL[p.currency] + ' ' + Number(p.foreignAmount).toFixed(2))).join(' + '),
        r.items.map((i) => i.qty + '× ' + i.name + (i.note ? ' (' + i.note + ')' : '')).join('; '), r.total.toFixed(2), r.kind === 'sale' ? r.refunded.toFixed(2) : ''
      ]);
      const csv = [head].concat(rows).map((r) => r.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
      a.download = 'till-sales-' + dates.from + (dates.to !== dates.from ? '-to-' + dates.to : '') + '.csv';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (err) { onFail(err); } finally { setBusy(false); }
  }

  const t = data && data.totals;
  const peak = data && data.byHour.length ? data.byHour.reduce((a, b) => (b.amount > a.amount ? b : a)) : null;
  const top = data && data.byMethod.length ? data.byMethod[0] : null;
  const series = data ? (data.byDay.length ? data.byDay.map((d) => ({ key: d.day, ...d,
    label: data.byMonth ? new Date(d.day + '-15T12:00:00').toLocaleDateString(activeIntlLocale(), { month: 'short', year: 'numeric' }) : new Date(d.day + 'T12:00:00').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short' }) })) : fillHours(data.byHour)) : [];
  const maxBar = Math.max(1, ...series.map((s) => s.amount));
  const fulTotal = data ? data.byFulfillment.reduce((s, f) => s + f.amount, 0) : 0;

  return (
    <section className="ts-sec sr">
      <div className="ts-act-filters">
        <div className="ts-chips" role="radiogroup" aria-label={tr('When')}>
          {RANGES.map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={range === k} className={range === k ? 'is-on' : ''} onClick={() => setRange(k)}>{tr(label)}</button>)}
          {range === 'day' && <input className="input ts-act-day" type="date" max={today} value={day} onChange={(e) => e.target.value && setDay(e.target.value)} aria-label={tr('Day')} />}
          {range === 'span' && (<>
            <input className="input ts-act-day" type="date" max={today} value={span.from} onChange={(e) => e.target.value && setSpan({ ...span, from: e.target.value })} aria-label={tr('From')} />
            <input className="input ts-act-day" type="date" max={today} value={span.to} onChange={(e) => e.target.value && setSpan({ ...span, to: e.target.value })} aria-label={tr('To')} />
          </>)}
        </div>
        <div className="sr-filters">
          <select className="input" value={source} onChange={(e) => setSource(e.target.value)} aria-label={tr('Rung up on')}>
            {SOURCES.map(([k, label]) => <option key={k} value={k}>{tr(label)}</option>)}
          </select>
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value)} aria-label={tr('Transactions')}>
            {KINDS.map(([k, label]) => <option key={k} value={k}>{tr(label)}</option>)}
          </select>
          <select className="input" value={method} onChange={(e) => setMethod(e.target.value)} aria-label={tr('Paid by')}>
            <option value="">{tr('All payments')}</option>
            {METHODS.map((m) => <option key={m} value={m}>{methodName(m)}</option>)}
          </select>
          <select className="input" value={fulfillment} onChange={(e) => setFulfillment(e.target.value)} aria-label={tr('Order type')}>
            <option value="">{tr('All order types')}</option>
            {FULFILLMENT.map((f) => <option key={f.key} value={f.key}>{tr(f.label)}</option>)}
          </select>
          <select className="input" value={cashier} onChange={(e) => setCashier(e.target.value)} aria-label={tr('Cashier')}>
            <option value="">{tr('All cashiers')}</option>
            {(data ? data.staff : []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Search: order, table, customer…')} aria-label={tr('Search')} />
        </div>
      </div>

      {!data ? <p className="dk-muted">{tr('Loading…')}</p> : (
        <>
          <div className="sr-hero">
            <div className="sr-net">
              <small>{tr('Net sales')}</small>
              <strong>{money(t.net)}</strong>
              <span>{t.sales ? tr('{gross} sold − {refunded} refunded', { gross: money(t.gross), refunded: money(t.refunded) }) : tr('No sales on these days yet.')}</span>
            </div>
            <div className="sr-tiles">
              <span><b>{t.sales}</b>{t.sales === 1 ? tr('sale') : tr('sales')}</span>
              <span><b>{money(t.average)}</b>{tr('average sale')}</span>
              <span><b>{t.dishes}</b>{tr('dishes and drinks')}</span>
              <span className={t.refunds ? 'is-bad' : ''}><b>{t.refunds}</b>{t.refunds === 1 ? tr('refund') : tr('refunds')}</span>
              {t.iouOpen > 0 && <span className="is-warn"><b>{money(t.iouOwed)}</b>{tr('still owed on {n} IOUs', { n: t.iouOpen })}</span>}
              {t.voided > 0 && <span><b>{t.voided}</b>{tr('voided ({amount})', { amount: money(t.voidedAmount) })}</span>}
              {t.guests > 0 && <span className="is-guests"><b>{money(t.perGuest)}</b>{tr('per guest, {n} guests', { n: t.guests })}</span>}
              {t.fromSquare && t.fromSquare.sales > 0 && !source && <span className="is-square"><b>{money(t.fromSquare.amount)}</b>{tr('from Square: {n} sales', { n: t.fromSquare.sales })}</span>}
            </div>
          </div>
          {t.sales > 0 && (
            <p className="sr-say"><Icon name="spark" />
              {[peak && tr('Busiest hour: {when}.', { when: hourLabel(peak.hour) }),
                top && tr('Most money came by {method} ({share}%).', { method: methodName(top.method), share: pct(top.amount, t.gross) }),
                data.topItems[0] && tr('Best seller: {dish} × {n}.', { dish: data.topItems[0].name, n: data.topItems[0].qty })].filter(Boolean).join(' ')}
            </p>
          )}

          {t.sales > 0 && (
            <div className="sr-grid">
              <div className="sr-card">
                <h4>{tr('How the money came in')}</h4>
                <ul className="sr-methods">
                  {data.byMethod.map((m) => (
                    <li key={m.method} data-m={m.method}>
                      <span className="sr-m-ico"><MethodGlyph method={m.method} /></span>
                      <span className="sr-m-text">
                        <span><strong>{methodName(m.method)}</strong><b>{money(m.net)}</b></span>
                        <span className="sr-bar" aria-hidden="true"><i style={{ width: pct(Math.max(0, m.net), data.byMethod[0].net) + '%' }} /></span>
                        <small>{[tr('{n} sales · {share}%', { n: m.sales, share: pct(m.amount, t.gross) }), m.refunded ? tr('{amount} refunded', { amount: money(m.refunded) }) : null].filter(Boolean).join(' · ')}</small>
                      </span>
                    </li>
                  ))}
                </ul>
                {data.foreign.length > 0 && (
                  <div className="sr-fx">
                    {data.foreign.map((f) => <span key={f.currency}><b>{fmt(f.amount, f.currency)}</b>{tr('taken, worth {amount}', { amount: money(f.cedis) })}</span>)}
                  </div>
                )}
              </div>

              <div className="sr-card">
                <h4>{data.byMonth ? tr('Sales by month') : data.byDay.length ? tr('Sales by day') : tr('Sales by hour')}</h4>
                <div className="sr-cols" role="list">
                  {series.map((s) => (
                    <span key={s.key} role="listitem" tabIndex={0} className={'sr-col' + (s.amount === maxBar && s.amount > 0 ? ' is-peak' : '')}
                      aria-label={tr('{when}: {amount} from {n} sales', { when: s.label, amount: money(s.amount), n: s.sales })}>
                      <i style={{ height: Math.max(s.amount > 0 ? 4 : 0, (s.amount / maxBar) * 100) + '%' }} />
                      <em className="sr-tip">{s.label}<b>{money(s.amount)}</b>{tr('{n} sales', { n: s.sales })}</em>
                    </span>
                  ))}
                </div>
                <div className="sr-axis" aria-hidden="true">
                  <span>{series.length ? series[0].label : ''}</span><span>{series.length ? series[series.length - 1].label : ''}</span>
                </div>
                <div className="sr-ful">
                  {data.byFulfillment.map((f) => (
                    <span key={f.fulfillment} className={'is-' + f.fulfillment}>
                      {f.fulfillment !== 'other' ? <FulfillmentIcon kind={f.fulfillment} /> : <Icon name="info" />}
                      <strong>{f.fulfillment !== 'other' ? fulfillmentName(f.fulfillment) : tr('Before order types')}</strong>
                      <small>{tr('{amount} · {n} sales · {share}%', { amount: money(f.amount), n: f.sales, share: pct(f.amount, fulTotal) })}</small>
                    </span>
                  ))}
                </div>
              </div>

              <div className="sr-card">
                <h4>{tr('Best sellers')}</h4>
                <ol className="sr-top">
                  {data.topItems.map((i, n) => (
                    <li key={i.name}><span className="sr-rank">{n + 1}</span><span className="sr-top-name"><span>{i.name}</span>{i.custom && <small className="sr-custom">{tr('not on the menu')}</small>}</span><b>× {i.qty}</b><small>{money(i.amount)}</small></li>
                  ))}
                </ol>
              </div>

              <div className="sr-card">
                <h4>{tr('By cashier')}</h4>
                <ul className="sr-cashiers">
                  {data.byCashier.map((c) => (
                    <li key={c.id}>
                      <span className="sr-avatar" aria-hidden="true">{(c.name || '?').replace(/^zq\s+/i, '').slice(0, 1).toUpperCase()}</span>
                      <span className="sr-m-text">
                        <span><strong>{c.name || tr('Someone')}</strong><b>{money(c.amount)}</b></span>
                        <span className="sr-bar is-cashier" aria-hidden="true"><i style={{ width: pct(c.amount, data.byCashier[0].amount) + '%' }} /></span>
                        <small>{tr('{n} sales · average {amount}', { n: c.sales, amount: money(c.sales ? c.amount / c.sales : 0) })}</small>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              {(t.discounts > 0 || t.serviceCharge > 0 || (data.taxes || []).length > 0 || (data.addOns || []).length > 0 || (data.comps || []).length > 0) && (
                <div className="sr-card sr-extras">
                  <h4>{tr('Discounts, service and tax')}</h4>
                  <div className="sr-x-tiles">
                    <span className={t.discounts > 0 ? 'is-off' : ''}><b>{t.discounts > 0 ? '−' + money(t.discounts) : money(0)}</b>{t.discounted === 1 ? tr('off 1 sale') : tr('off {n} sales', { n: t.discounted || 0 })}</span>
                    <span className="is-service"><b>{money(t.serviceCharge)}</b>{t.serviceOff ? tr('service charge · taken off {n}', { n: t.serviceOff }) : tr('service charge')}</span>
                    {t.taxAdded > 0 && <span className="is-tax"><b>{money(t.taxAdded)}</b>{tr('taxes added')}</span>}
                  </div>
                  {(data.discountsBy || []).length > 0 && (
                    <ul className="sr-x-list is-plain">
                      {data.discountsBy.map((d) => <li key={d.name}><span className="sr-x-ico" aria-hidden="true">%</span><span>{d.name}<small>{d.sales === 1 ? tr('1 sale') : tr('{n} sales', { n: d.sales })}</small></span><b>−{money(d.amount)}</b></li>)}
                    </ul>
                  )}
                  {(data.comps || []).length > 0 && (
                    <ul className="sr-x-list is-plain">
                      {data.comps.map((c) => <li key={c.reason} className="is-comp"><span className="sr-x-ico" aria-hidden="true">🎁</span><span>{tr('On the house: {why}', { why: c.reason })}<small>{c.qty === 1 ? tr('1 dish') : tr('{n} dishes', { n: c.qty })}</small></span><b>{money(c.amount)}</b></li>)}
                    </ul>
                  )}
                  {(data.taxes || []).length > 0 && (
                    <div className="sr-fx">
                      {data.taxes.map((x) => <span key={x.name}><b>{money(x.amount)}</b>{x.name} · {x.included ? tr('in the prices') : tr('added')}</span>)}
                    </div>
                  )}
                  {(data.addOns || []).length > 0 && (
                    <>
                      <h5 className="sr-x-h">{tr('Add-ons asked for most')}</h5>
                      <div className="sr-x-addons">
                        {data.addOns.map((a) => (
                          <span key={a.name + a.how} className={'is-' + a.how}>
                            <b>× {a.qty}</b>{modsWords([a], tr)}
                            {a.amount > 0 && <small>+{money(a.amount)}</small>}
                          </span>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          <h4 className="sr-list-head">{tr('Transactions')} <small>{tr('Tap one to see its dishes and how it was paid.')}</small></h4>
          {!data.rows.length ? (
            <div className="dk-empty"><Icon name="receipt" /><p>{tr('No transactions for these filters.')}</p></div>
          ) : (
            <ul className="sr-rows">
              {data.rows.map((r) => {
                const isOpen = open === r.kind + r.id;
                return (
                  <li key={r.kind + r.id} className={'is-' + r.kind + (r.status === 'voided' ? ' is-voided' : '') + (isOpen ? ' is-open' : '')}>
                    <button type="button" className="sr-row" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : r.kind + r.id)}>
                      <time>{new Date(r.at).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' })}{data.from !== data.to && <small>{new Date(r.at).toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short' })}</small>}</time>
                      <span className="sr-row-ico" aria-hidden="true">{r.kind === 'refund' ? <Icon name="void" /> : r.fulfillment ? <FulfillmentIcon kind={r.fulfillment} /> : <Icon name="receipt" />}</span>
                      <span className="sr-row-text">
                        <strong>{r.kind === 'refund' ? tr('Refund on {order}', { order: r.orderNo }) : r.orderNo}
                          {r.status === 'voided' && <em className="sr-chip is-bad">{tr('Voided')}</em>}
                          {r.kind === 'sale' && r.refunded > 0 && <em className="sr-chip is-bad">{tr('{amount} refunded', { amount: money(r.refunded) })}</em>}
                          {r.iou && <em className={'sr-chip ' + (r.iou.paid ? 'is-good' : 'is-warn')}>{r.iou.paid ? tr('IOU paid') : tr('IOU owed')}</em>}
                          {r.source === 'square' && <em className="sr-chip is-square">Square{r.sourceName ? ' · ' + r.sourceName : ''}</em>}
                          {r.guests > 0 && <em className="sr-chip">👥 {r.guests}</em>}
                        </strong>
                        <small>{[r.fulfillment ? fulfillmentName(r.fulfillment) : null, r.table, r.customer, r.cashier].filter(Boolean).join(' · ')}</small>
                      </span>
                      <span className="sr-row-pay" aria-hidden="true">{(r.kind === 'refund' ? [{ method: r.method }] : r.payments).map((p, i) => <span key={i} className="sr-pay-dot" data-m={p.method}><MethodGlyph method={p.method} /></span>)}</span>
                      <b className="sr-row-amt">{money(r.total)}</b>
                    </button>
                    {isOpen && (
                      <div className="sr-detail">
                        <ul className="sr-items">
                          {r.items.map((i, n) => (
                            <li key={n}><span>{i.qty} × {i.name}{i.custom && <small className="sr-custom">{tr('not on the menu')}</small>}{i.note && <small className="sr-note">“{i.note}”</small>}</span><span>{money(i.lineTotal)}</span></li>
                          ))}
                        </ul>
                        {r.kind === 'sale' ? (
                          <ul className="sr-parts">
                            {r.payments.map((p, i) => (
                              <li key={i} data-m={p.method}>
                                <MethodGlyph method={p.method} /><strong>{methodName(p.method)}</strong>
                                <span>{p.currency !== 'GHS' ? tr('{foreign} at {rate} = {amount}', { foreign: fmt(p.foreignAmount, p.currency), rate: p.rate, amount: money(p.amount) }) : money(p.amount)}</span>
                                {p.tendered != null && <small>{tr('handed {given}, change {change}', { given: fmt(p.tendered, p.currency), change: money(p.changeGiven) })}</small>}
                              </li>
                            ))}
                            {r.waiter && <li className="sr-who">{tr('Waiter: {name}', { name: r.waiter })}</li>}
                            {r.deliveryAddress && <li className="sr-who">{tr('Delivered to {address}', { address: r.deliveryAddress })}</li>}
                            {r.iou && r.iou.paid && <li className="sr-who">{tr('IOU paid {date} by {method}', { date: new Date(r.iou.paidAt).toLocaleDateString(activeIntlLocale()), method: methodName(r.iou.method) })}</li>}
                          </ul>
                        ) : (
                          <ul className="sr-parts">
                            <li data-m={r.method}><MethodGlyph method={r.method} /><strong>{tr('Given back by {method}', { method: methodName(r.method) })}</strong><span>{money(-r.total)}</span></li>
                            <li className="sr-who">{tr('Why: {reason}', { reason: r.reason })}</li>
                            <li className="sr-who">{tr('Approved by {name}', { name: r.approvedBy || '—' })}</li>
                          </ul>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="ts-act-foot">
            {data.more && <button type="button" className="btn btn-secondary" disabled={busy} onClick={more}>{busy ? tr('Loading…') : tr('Show more')}</button>}
            {data.rows.length > 0 && <button type="button" className="btn btn-secondary" disabled={busy} onClick={download}>{tr('Download (CSV)')}</button>}
          </div>
        </>
      )}
    </section>
  );
}

// The hours from the first sale to the last, the quiet ones too.
function fillHours(byHour) {
  if (!byHour.length) return [];
  const by = new Map(byHour.map((h) => [h.hour, h]));
  const out = [];
  for (let h = byHour[0].hour; h <= byHour[byHour.length - 1].hour; h++) {
    const x = by.get(h) || { hour: h, sales: 0, amount: 0 };
    out.push({ key: 'h' + h, label: hourLabel(h), ...x });
  }
  return out;
}
