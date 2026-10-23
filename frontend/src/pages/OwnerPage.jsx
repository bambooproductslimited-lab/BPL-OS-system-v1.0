import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { money } from '../lib/currency';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import { restaurantLogoUrl } from '../lib/restaurantLogos';
import './OwnerPage.css';

// The owner's phone (Restaurants → Owner's view; backend
// restaurantTillInsights owner): every restaurant today so far against the
// same weekday last week up to the same time, what is happening now (open
// orders, food cooking, drawers open), the best sellers today, the last 7
// days and today's hours. Asked again every minute.

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

export default function OwnerPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => api.get('/restaurant/owner').then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);
  if (!data) return <div className="ow"><p className="ow-wait">{error || tr('Loading…')}</p></div>;
  const t = data.total;
  return (
    <div className="ow">
      <header className="ow-hero">
        <small>{new Date(data.at).toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long' })} · {tr('as of {time}', { time: new Date(data.at).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' }) })}</small>
        <h1>{money(t.net)}</h1>
        <p>{tr('{n} orders today, all restaurants', { n: t.orders })} · <Delta now={t.net} before={t.lastWeek} /> <span className="ow-vs">{tr('vs last week by now ({amount})', { amount: money(t.lastWeek) })}</span></p>
        <button type="button" className="ow-refresh" onClick={load} aria-label={tr('Refresh')}>↻</button>
      </header>
      {!data.restaurants.length && <p className="ow-wait">{tr('No restaurant has sold anything this week yet.')}</p>}
      <div className="ow-list">
        {data.restaurants.map((r, i) => {
          const logo = restaurantLogoUrl(r.code);
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
                <span className={r.now.drawers ? 'is-on' : ''}>💵 {r.now.drawers === 1 ? tr('1 drawer open') : r.now.drawers ? tr('{n} drawers open', { n: r.now.drawers }) : tr('No drawer open')}</span>
              </div>
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
      </div>
    </div>
  );
}
