import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { money } from '../lib/currency';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import { restaurantLogoUrl } from '../lib/restaurantLogos';
import './OwnerPage.css';

// The owner's view (Restaurants → Owner's view; backend ownerView.service
// on top of restaurantTillInsights owner): every restaurant today so far
// against the same weekday last week up to the same time, then what needs
// the owner first, the restaurants side by side, and per restaurant the
// money (drawers, safe, petty cash), who is on shift and who is late,
// today's events, what is happening now, the best sellers, the last 7 days
// and today's hours. Bamboo Products' day under it, for those who may see
// it. Asked again every minute.

// What needs looking at, in the reader's language (the backend sends the
// same in English).
const ALERTS = {
  readings: (n) => n === 1 ? tr('1 checklist reading out of range') : tr('{n} checklist readings out of range', { n }),
  stopped: (n) => n === 1 ? tr('1 piece of equipment out of use') : tr('{n} pieces of equipment out of use', { n }),
  bills: (n) => n === 1 ? tr('1 bill overdue') : tr('{n} bills overdue', { n }),
  waiting: (n) => n === 1 ? tr('1 website order waiting to be accepted') : tr('{n} website orders waiting to be accepted', { n }),
  disputes: (n) => n === 1 ? tr('1 dispute open') : tr('{n} disputes open', { n }),
  problems: (n) => n === 1 ? tr('1 equipment problem reported') : tr('{n} equipment problems reported', { n }),
  checklists: (n) => n === 1 ? tr('1 checklist not finished') : tr('{n} checklists not finished', { n }),
  low: (n) => n === 1 ? tr('1 ingredient or supply running low') : tr('{n} ingredients and supplies running low', { n }),
  service: (n) => n === 1 ? tr('1 service due this week') : tr('{n} services due this week', { n }),
  billsWeek: (n) => n === 1 ? tr('1 bill due this week') : tr('{n} bills due this week', { n }),
  owed: (n) => n === 1 ? tr('1 customer invoice overdue') : tr('{n} customer invoices overdue', { n }),
  approve: (n) => n === 1 ? tr('1 bill to approve') : tr('{n} bills to approve', { n }),
  repairs: (n) => n === 1 ? tr('1 repair request to answer') : tr('{n} repair requests to answer', { n }),
  failed: (n) => n === 1 ? tr('1 visit could not be done today') : tr('{n} visits could not be done today', { n }),
  quotes: (n) => n === 1 ? tr('1 quote asked for on the website') : tr('{n} quotes asked for on the website', { n })
};
const LINKS = { bills: '/bills', billsWeek: '/bills', approve: '/bills', stopped: '/assets', problems: '/assets', service: '/assets', owed: '/invoices', repairs: '/bplvisits', failed: '/bplvisits', quotes: '/shoporders', low: '/restaurant' };
function alertText(a) {
  if (a.key === 'busy') return a.text === 'Website orders paused' ? tr('Website orders paused') : tr('Busy mode on the website');
  return ALERTS[a.key] ? ALERTS[a.key](a.n) : a.text;
}
function hm(iso) { return new Date(iso).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' }); }

function Delta({ now, before }) {
  if (!(before > 0)) return <span className="ow-delta is-flat">{now > 0 ? tr('new') : '—'}</span>;
  const p = Math.round((now - before) / before * 1000) / 10;
  return <span className={'ow-delta ' + (p > 0 ? 'is-up' : p < 0 ? 'is-down' : 'is-flat')}><b aria-hidden="true">{p > 0 ? '▲' : p < 0 ? '▼' : '→'}</b> {p > 0 ? '+' : ''}{p}%</span>;
}
function dayShort(s) { return new Date(s + 'T12:00:00').toLocaleDateString(activeIntlLocale(), { weekday: 'narrow' }); }

function Week({ week }) {
  const max = Math.max(1, ...week.map((w) => w.net));
  return (
    <div className="ow-week" role="img" aria-label={tr('The last 7 days') + ': ' + week.map((w) => w.day + ' ' + money(w.net)).join(', ')}>
      {week.map((w, i) => (
        <span key={w.day} className={'ow-week-day' + (i === week.length - 1 ? ' is-today' : '')} title={w.day + ' · ' + money(w.net)}>
          <i style={{ height: Math.max(3, w.net / max * 100) + '%' }} /><small>{dayShort(w.day)}</small>
        </span>
      ))}
    </div>
  );
}
function Hours({ hours }) {
  if (!hours.length) return null;
  const lo = Math.min(...hours.map((h) => h.hour)), hi = Math.max(new Date().getUTCHours(), ...hours.map((h) => h.hour));
  const max = Math.max(1, ...hours.map((h) => h.net));
  const all = Array.from({ length: hi - lo + 1 }, (_, i) => { const h = lo + i; const x = hours.find((y) => y.hour === h); return { hour: h, net: x ? x.net : 0 }; });
  return (
    <div className="ow-hours" role="img" aria-label={tr('Today by the hour') + ': ' + all.map((h) => h.hour + ':00 ' + money(h.net)).join(', ')}>
      {all.map((h) => <span key={h.hour} title={h.hour + ':00 · ' + money(h.net)}><i style={{ height: Math.max(2, h.net / max * 100) + '%' }} /><small>{h.hour % 3 === 0 ? h.hour : ''}</small></span>)}
    </div>
  );
}

// One line of what needs looking at; a link when there is a page for it.
function Alert({ a, company, onOpen }) {
  const to = LINKS[a.key];
  const body = (
    <>
      <em aria-hidden="true">{a.icon}</em>
      <span>{company && <small>{company}</small>}{alertText(a)}{a.amount ? <b> · {money(a.amount)}</b> : null}</span>
      <i className="ow-level">{a.level === 'bad' ? tr('Now') : a.level === 'warn' ? tr('Today') : tr('Coming up')}</i>
    </>
  );
  return to
    ? <button type="button" className={'ow-alert is-' + a.level} onClick={() => onOpen(to)}>{body}<b className="ow-go" aria-hidden="true">›</b></button>
    : <div className={'ow-alert is-' + a.level}>{body}</div>;
}

// The restaurants side by side: one row a measure, the best of each row
// marked (never by colour alone).
function Compare({ restaurants }) {
  const rows = [
    { label: tr('Sales today'), get: (r) => r.today.net, show: money, best: 'max' },
    { label: tr('vs last week by now'), get: (r) => r.change == null ? null : r.change, show: (v) => v == null ? '—' : (v > 0 ? '+' : '') + v + '%', best: 'max' },
    { label: tr('Orders'), get: (r) => r.today.orders, show: String, best: 'max' },
    { label: tr('Average'), get: (r) => r.today.average, show: money, best: 'max' },
    { label: tr('Guests'), get: (r) => r.today.guests, show: String, best: 'max' },
    { label: tr('In the drawers'), get: (r) => r.money.inDrawers, show: money },
    { label: tr('In the safe'), get: (r) => r.money.safe, show: money },
    { label: tr('Petty cash today'), get: (r) => r.money.petty.amount, show: money },
    { label: tr('On shift now'), get: (r) => r.staff.on.length, show: String },
    { label: tr('Late'), get: (r) => r.staff.late.length, show: String, best: 'min' },
    { label: tr('Events today'), get: (r) => r.events.today.length, show: String },
    { label: tr('To look at'), get: (r) => r.alerts.filter((a) => a.level !== 'info').length, show: String, best: 'min' }
  ];
  return (
    <section className="ow-compare" aria-label={tr('Side by side')}>
      <h2>{tr('Side by side')}</h2>
      <div className="ow-compare-scroll">
        <table>
          <thead><tr><th scope="col"><span className="sr-only">{tr('Measure')}</span></th>{restaurants.map((r) => {
            const logo = restaurantLogoUrl(r.code);
            return <th key={r.id} scope="col">{logo ? <img src={logo} alt="" /> : <span aria-hidden="true">🍽️</span>}<span>{r.name}</span></th>;
          })}</tr></thead>
          <tbody>
            {rows.map((row) => {
              const vals = restaurants.map(row.get);
              const nums = vals.filter((v) => v != null);
              const best = row.best && nums.length > 1 && new Set(nums).size > 1 ? (row.best === 'max' ? Math.max(...nums) : Math.min(...nums)) : null;
              return (
                <tr key={row.label}>
                  <th scope="row">{row.label}</th>
                  {vals.map((v, i) => <td key={restaurants[i].id} className={best != null && v === best ? 'is-best' : ''}>{row.show(v)}{best != null && v === best && <em title={tr('Best')} aria-label={tr('Best')}>★</em>}</td>)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Money({ m }) {
  return (
    <div className="ow-money">
      <span><small>💵 {tr('In the drawers')}</small><b>{money(m.inDrawers)}</b><i>{m.drawers === 1 ? tr('1 drawer open') : m.drawers ? tr('{n} drawers open', { n: m.drawers }) : tr('No drawer open')}</i></span>
      <span className={m.safeOver ? 'is-warn' : ''}><small>🔐 {tr('In the safe')}</small><b>{money(m.safe)}</b><i>{m.safeOver ? '⚠️ ' + tr('Over the limit: bank it') : m.safeCounted ? tr('Counted {when}', { when: new Date(m.safeCounted).toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short' }) }) : tr('Not counted yet')}</i></span>
      <span className={m.petty.noReceipt ? 'is-warn' : ''}><small>🧾 {tr('Petty cash today')}</small><b>{money(m.petty.amount)}</b><i>{m.petty.n ? (m.petty.noReceipt ? '⚠️ ' + tr('{n} without a receipt', { n: m.petty.noReceipt }) : tr('{n} paid out', { n: m.petty.n })) : tr('None')}</i></span>
    </div>
  );
}

function Staff({ s }) {
  return (
    <div className="ow-staff">
      <small>{tr('On shift now')} · {s.on.length}{s.planned ? ' / ' + tr('{n} on the rota', { n: s.planned }) : ''}</small>
      <div className="ow-chips">
        {s.on.map((p, i) => <span key={p.name + i} className={'ow-chip' + (p.onBreak ? ' is-break' : '')} title={tr('Since {time}', { time: hm(p.since) })}><b aria-hidden="true">{p.name.charAt(0)}</b>{p.name}{p.onBreak && <em>☕ {tr('on a break')}</em>}</span>)}
        {s.late.map((p, i) => <span key={'late' + p.name + i} className="ow-chip is-late"><b aria-hidden="true">!</b>{p.name}<em>{tr('late — due at {time}', { time: p.starts })}</em></span>)}
        {!s.on.length && !s.late.length && <span className="ow-none">{tr('Nobody clocked in')}</span>}
      </div>
    </div>
  );
}

function Events({ e }) {
  if (!e.today.length && !e.asked && !e.catering && !e.week) return null;
  return (
    <div className="ow-events">
      {e.today.map((x) => <span key={x.ref} className="ow-event"><b>🎉 {hm(x.at)}</b>{x.name}{x.occasion ? ' · ' + x.occasion : ''}<em>{tr('{n} guests', { n: x.guests })}</em></span>)}
      <small>
        {e.week > e.today.length ? tr('{n} events in the next 7 days', { n: e.week }) : null}
        {e.asked ? ' · ' + (e.asked === 1 ? tr('1 event enquiry to answer') : tr('{n} event enquiries to answer', { n: e.asked })) : ''}
        {e.catering ? ' · ' + tr('{n} catering orders today', { n: e.catering }) : ''}
      </small>
    </div>
  );
}

function BplCard({ b, onOpen }) {
  return (
    <article className="ow-card ow-bpl">
      <header><span className="ow-dot" aria-hidden="true">🎋</span><strong>{b.name}</strong></header>
      <div className="ow-stats ow-stats-4">
        <span><b>{b.shop.today}</b>{tr('shop orders today')}<i>{money(b.shop.total)}</i></span>
        <span><b>{b.shop.making}</b>{tr('being made')}<i>{tr('{n} ready', { n: b.shop.ready })}</i></span>
        <span><b>{b.visits.done}/{b.visits.n}</b>{tr('visits done today')}<i>{b.visits.out ? tr('{n} on the way', { n: b.visits.out }) : '—'}</i></span>
        <span><b>{money(b.owed.amount)}</b>{tr('owed to us, overdue')}<i>{tr('{n} invoices', { n: b.owed.n })}</i></span>
      </div>
      {b.bills && (
        <div className="ow-billrow">
          <span>🧾 {tr('Bills due this week')}: <b>{money(b.bills.week.amount)}</b></span>
          {b.bills.overdue.n > 0 && <span className="is-bad">⏰ {tr('Overdue')}: <b>{money(b.bills.overdue.amount)}</b></span>}
        </div>
      )}
      {b.alerts.length > 0 && <div className="ow-alerts">{b.alerts.map((a) => <Alert key={a.key} a={a} onOpen={onOpen} />)}</div>}
    </article>
  );
}

export default function OwnerPage() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => api.get('/restaurant/owner').then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);
  if (!data) return <div className="ow"><p className="ow-wait">{error || tr('Loading…')}</p></div>;
  const t = data.total;
  const needs = data.needs || [];
  return (
    <div className="ow">
      <header className="ow-hero">
        <small>{new Date(data.at).toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long' })} · {tr('as of {time}', { time: hm(data.at) })}</small>
        <h1>{money(t.net)}</h1>
        <p>{tr('{n} orders today, all restaurants', { n: t.orders })} · <Delta now={t.net} before={t.lastWeek} /> <span className="ow-vs">{tr('vs last week by now ({amount})', { amount: money(t.lastWeek) })}</span></p>
        {t.inDrawers != null && (
          <div className="ow-hero-chips">
            <span>💵 <b>{money(t.inDrawers)}</b> {tr('in the drawers')}</span>
            <span>🔐 <b>{money(t.safe)}</b> {tr('in the safes')}</span>
            <span>🧑‍🍳 <b>{t.onShift}</b> {tr('on shift')}</span>
          </div>
        )}
        <button type="button" className="ow-refresh" onClick={load} aria-label={tr('Refresh')}>↻</button>
      </header>

      <section className={'ow-needs' + (needs.length ? '' : ' is-calm')} aria-label={tr('Needs you')}>
        <h2>{needs.length ? tr('Needs you') : tr('All calm')}</h2>
        {needs.length
          ? <div className="ow-alerts">{needs.map((a) => <Alert key={a.company.id + a.key} a={a} company={a.company.name} onOpen={navigate} />)}</div>
          : <p>{tr('Nothing needs you right now. Every restaurant is running smoothly.')}</p>}
      </section>

      {!data.restaurants.length && <p className="ow-wait">{tr('No restaurant has sold anything this week yet.')}</p>}
      {data.restaurants.length > 1 && <Compare restaurants={data.restaurants} />}

      <div className="ow-list">
        {data.restaurants.map((r, i) => {
          const logo = restaurantLogoUrl(r.code);
          const own = (r.alerts || []).filter((a) => a.level === 'info');
          return (
            <article key={r.id} className="ow-card" style={{ animationDelay: i * 0.05 + 's' }}>
              <header>
                {logo ? <img src={logo} alt="" /> : <span className="ow-dot" aria-hidden="true">🍽️</span>}
                <strong>{r.name}</strong>
                <Delta now={r.today.net} before={r.lastWeek.net} />
              </header>
              <div className="ow-big">
                <b>{money(r.today.net)}</b>
                <small>{tr('last week by now: {amount}', { amount: money(r.lastWeek.net) })}</small>
              </div>
              <div className="ow-stats">
                <span><b>{r.today.orders}</b>{tr('orders')}</span>
                <span><b>{money(r.today.average)}</b>{tr('average')}</span>
                <span><b>{r.today.guests}</b>{tr('guests')}</span>
              </div>
              <div className="ow-now">
                <span className={r.now.openOrders ? 'is-on' : ''}>🧾 {tr('{n} open', { n: r.now.openOrders })}</span>
                <span className={r.now.cooking ? 'is-on' : ''}>👩‍🍳 {tr('{n} cooking', { n: r.now.cooking })}</span>
              </div>
              {r.money && <Money m={r.money} />}
              {r.staff && <Staff s={r.staff} />}
              {r.events && <Events e={r.events} />}
              {own.length > 0 && <div className="ow-alerts is-small">{own.map((a) => <Alert key={a.key} a={a} onOpen={navigate} />)}</div>}
              {r.top.length > 0 && (
                <ol className="ow-top">{r.top.map((x, j) => <li key={x.name}><em>{['🥇', '🥈', '🥉'][j]}</em><span>{x.name}</span><b>×{x.qty}</b></li>)}</ol>
              )}
              <div className="ow-charts">
                <div><small>{tr('The last 7 days')}</small><Week week={r.week} /></div>
                {r.hours.length > 0 && <div><small>{tr('Today by the hour')}</small><Hours hours={r.hours} /></div>}
              </div>
            </article>
          );
        })}
        {data.bpl && <BplCard b={data.bpl} onOpen={navigate} />}
      </div>
    </div>
  );
}
