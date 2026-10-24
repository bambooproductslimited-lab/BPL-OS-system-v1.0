import { useCallback, useEffect, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { activeIntlLocale, msg, tr } from '../../lib/i18n.jsx';
import './sixth.css';

// Closing the day, in the till settings (Reports → Close the day; backend
// restaurantCloseDay.service.js): the day as a manager reads it at closing
// time — net sales against the same day last week, how it was paid, the
// hours, what sold most, the drawers (right, short, over or still open),
// orders still open, IOUs not paid, what is running low — then closed,
// kept as it was, told to the managers, emailed, and offered on WhatsApp.
// It can close by itself at a set time (the settings below, saved with the
// till settings).

const METHOD = { cash: msg('Cash'), mobile_money: msg('Mobile Money'), card: msg('Card'), vip: msg('VIP account'), iou: msg('IOU'), gift_card: msg('Gift card'), alipay: msg('Alipay'), wechat: msg('WeChat Pay'), app: msg('Delivery app'), paystack: msg('Paystack') };
function dayWords(d) { return new Date(d + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long' }); }
function timeWords(t) { return t ? new Date(t).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' }) : ''; }
function daysBack(n) { return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10); }

function Hours({ hours }) {
  if (!hours.length) return null;
  const max = Math.max(...hours.map((h) => h.amount), 1);
  const from = Math.min(...hours.map((h) => h.hour)), to = Math.max(...hours.map((h) => h.hour));
  const all = [];
  for (let h = from; h <= to; h++) all.push(hours.find((x) => x.hour === h) || { hour: h, sales: 0, amount: 0 });
  const top = all.reduce((a, b) => (b.amount > a.amount ? b : a), all[0]);
  return (
    <div className="cz-card cz-hours">
      <h4>{tr('Through the day')}</h4>
      <div className="cz-hbars" role="list">
        {all.map((h) => (
          <span key={h.hour} role="listitem" className={'cz-hbar' + (h === top ? ' is-top' : '')} title={tr('{hour}:00 · {n} sales · {amount}', { hour: String(h.hour).padStart(2, '0'), n: h.sales, amount: money(h.amount) })}
            aria-label={tr('{hour}:00 · {n} sales · {amount}', { hour: String(h.hour).padStart(2, '0'), n: h.sales, amount: money(h.amount) })}>
            {h === top && <em>{money(h.amount)}</em>}
            <i style={{ height: Math.max(2, (h.amount / max) * 100) + '%' }} />
            <small>{h.hour}</small>
          </span>
        ))}
      </div>
    </div>
  );
}

function Summary({ s }) {
  const ch = s.lastWeek.change;
  const warn = [];
  const openDrawers = s.drawers.filter((d) => d.status === 'open').length;
  if (openDrawers) warn.push(['🗄️', openDrawers === 1 ? tr('A drawer is still open: count it before closing.') : tr('{n} drawers still open: count them before closing.', { n: openDrawers })]);
  if (s.openOrders.count) warn.push(['🧾', s.openOrders.count === 1 ? tr('An order is still open ({amount}): charge it or move it to tomorrow.', { amount: money(s.openOrders.amount) }) : tr('{n} orders still open ({amount}): charge them or move them to tomorrow.', { n: s.openOrders.count, amount: money(s.openOrders.amount) })]);
  if (s.sales.iouOpen) warn.push(['🤝', s.sales.iouOpen === 1 ? tr('An IOU is not paid yet ({amount}).', { amount: money(s.sales.iouOwed) }) : tr('{n} IOUs not paid yet ({amount}).', { n: s.sales.iouOpen, amount: money(s.sales.iouOwed) })]);
  if (s.drawerTotals.short < 0) warn.push(['⚠️', tr('The drawers came out {amount} short.', { amount: money(-s.drawerTotals.short) })]);
  const maxM = Math.max(...s.byMethod.map((m) => m.net), 1);
  return (
    <>
      <div className="cz-big">
        <span className="cz-big-label">{tr('Net sales')}</span>
        <b className="cz-big-num">{money(s.sales.net)}</b>
        <span className="cz-big-sub">
          {tr('{n} sales', { n: s.sales.count })}{s.sales.count ? ' · ' + tr('average {amount}', { amount: money(s.sales.average) }) : ''}
          {ch !== null && <em className={'cz-vs' + (ch >= 0 ? ' is-up' : ' is-down')}>{ch >= 0 ? '▲' : '▼'} {Math.abs(ch)}% {tr('vs last {day}', { day: new Date(s.lastWeek.day + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { weekday: 'long' }) })}</em>}
        </span>
      </div>
      <div className="cz-kpis">
        {[['🍽️', tr('Dishes'), s.sales.dishes], ['👥', tr('Guests'), s.sales.guests ? s.sales.guests + ' · ' + money(s.sales.perGuest) : '—'], ['💝', tr('Tips'), money(s.sales.tips)],
          ['🎟️', tr('Discounts and deals'), money(s.sales.discounts)], ['↩️', tr('Refunds'), s.sales.refunds ? s.sales.refunds + ' · ' + money(s.sales.refunded) : '—'], ['🚫', tr('Voided'), s.sales.voided ? s.sales.voided + ' · ' + money(s.sales.voidedAmount) : '—']]
          .map(([icon, label, v], i) => <div key={label} className="cz-kpi" style={{ '--i': i }}><span aria-hidden="true">{icon}</span><small>{label}</small><b>{v}</b></div>)}
      </div>
      {warn.length > 0 && <ul className="cz-warn">{warn.map(([icon, w]) => <li key={w}><span aria-hidden="true">{icon}</span>{w}</li>)}</ul>}
      <div className="cz-grid">
        <div className="cz-card">
          <h4>{tr('Paid by')}</h4>
          {!s.byMethod.length ? <p className="dk-muted">{tr('No sales yet.')}</p> : (
            <ul className="cz-methods">
              {s.byMethod.map((m) => (
                <li key={m.method}>
                  <span>{METHOD[m.method] ? tr(METHOD[m.method]) : m.name}</span>
                  <span className="cz-mbar" aria-hidden="true"><i style={{ width: Math.max(2, (m.net / maxM) * 100) + '%' }} /></span>
                  <b>{money(m.net)}</b>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="cz-card">
          <h4>{tr('Sold most')}</h4>
          {!s.topItems.length ? <p className="dk-muted">{tr('No sales yet.')}</p> : (
            <ol className="cz-top">{s.topItems.map((t, i) => <li key={t.name} style={{ '--i': i }}><span className="cz-medal" aria-hidden="true">{['🥇', '🥈', '🥉', '4', '5'][i]}</span><span>{t.name}</span><b>{t.qty}×</b></li>)}</ol>
          )}
        </div>
        <Hours hours={s.byHour} />
        <div className="cz-card">
          <h4>{tr('Drawers')}</h4>
          {!s.drawers.length ? <p className="dk-muted">{tr('No drawer was opened.')}</p> : (
            <ul className="cz-drawers">
              {s.drawers.map((d, i) => (
                <li key={i} className={d.status === 'open' ? 'is-open' : d.difference === 0 ? 'is-right' : d.difference < 0 ? 'is-short' : 'is-over'}>
                  <span>{d.cashier}</span>
                  <b>{d.status === 'open' ? tr('still open') : d.difference === 0 ? '✓ ' + tr('right') : d.difference < 0 ? tr('{amount} short', { amount: money(-d.difference) }) : tr('{amount} over', { amount: money(d.difference) })}</b>
                </li>
              ))}
            </ul>
          )}
          {s.lowStock.count > 0 && (
            <>
              <h4 className="cz-h4-gap">{tr('Running low')}</h4>
              <div className="cz-low">{s.lowStock.items.map((x) => <span key={x.name} className={x.out ? 'is-out' : ''}>{x.out ? '⛔' : '⚠'} {x.name}</span>)}</div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

export default function CloseDayTab({ token, pin, draft, set, onFail }) {
  const [day, setDay] = useState(daysBack(0));
  const [data, setData] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [stamp, setStamp] = useState(false);
  const call = useCallback(async (body) => {
    setBusy(true);
    try { const d = await posFetch('POST', '/pos/settings/closeday', token, { managerPin: pin || undefined, day, ...body }); setData(d); return d; }
    catch (err) { onFail(err); return null; } finally { setBusy(false); }
  }, [token, pin, day, onFail]);
  useEffect(() => { setData(null); call({ action: 'preview' }); }, [call]);
  const cfg = draft.closeDay || { auto: false, at: '23:30', emails: [], whatsapp: '' };
  // The addresses as typed (commas and all); the settings keep the list.
  const [emailsText, setEmailsText] = useState(() => (cfg.emails || []).join(', '));
  async function close(again) {
    const d = await call({ action: 'close', note, again: again || undefined });
    if (d) { setStamp(true); setNote(''); setTimeout(() => setStamp(false), 2400); }
  }
  return (
    <section className="ts-sec cz">
      <div className="cz-hero">
        <div className="cz-hero-top">
          <span className="cz-moon" aria-hidden="true">🌙</span>
          <div>
            <strong>{tr('Close the day')}</strong>
            <small>{day ? dayWords(day) : ''}</small>
          </div>
          <div className="cz-days" role="radiogroup" aria-label={tr('Which day')}>
            {[0, 1, 2, 3, 4, 5, 6].map((n) => {
              const d = daysBack(n);
              return <button key={d} type="button" role="radio" aria-checked={day === d} className={day === d ? 'is-on' : ''} onClick={() => setDay(d)}>{n === 0 ? tr('Today') : n === 1 ? tr('Yesterday') : new Date(d + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { weekday: 'short', day: 'numeric' })}</button>;
            })}
          </div>
        </div>
        {data && data.closed && (
          <div className={'cz-stamp' + (stamp ? ' is-new' : '')}>
            <b>{tr('CLOSED')}</b>
            <small>{data.closed.auto ? tr('by itself at {time}', { time: timeWords(data.closed.closedAt) }) : tr('{time} by {name}', { time: timeWords(data.closed.closedAt), name: data.closed.closedBy || '—' })}</small>
          </div>
        )}
      </div>
      {!data ? <p className="dk-muted">{tr('Loading…')}</p> : (
        <>
          <Summary s={data.live} />
          {data.closed && data.closed.note && <p className="cz-note">📝 {data.closed.note}</p>}
          <div className="cz-actions">
            {!data.closed && <input className="input cz-note-in" maxLength={400} value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr('A note for the day (optional): a power cut, a big party…')} aria-label={tr('A note for the day')} />}
            {!data.closed
              ? <button type="button" className="btn btn-primary cz-go" disabled={busy} onClick={() => close(false)}>🌙 {busy ? tr('Closing…') : tr('Close the day')}</button>
              : <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => close(true)} title={tr('With the sales as they are now')}>↻ {tr('Close it again')}</button>}
            {data.whatsappUrl && <a className="btn cz-wa" href={data.whatsappUrl} target="_blank" rel="noopener noreferrer">💬 {data.settings.whatsapp ? tr('Send to the owner on WhatsApp') : tr('Share on WhatsApp')}</a>}
            {data.done && data.done.sent && data.done.sent.email && data.done.sent.email.to.length > 0 && <span className="cz-sent">✉️ {tr('Emailed to {to}', { to: data.done.sent.email.to.join(', ') })}</span>}
          </div>
          {data.history.length > 0 && (
            <div className="cz-card cz-hist">
              <h4>{tr('Days closed')}</h4>
              <ul>
                {data.history.map((h) => (
                  <li key={h.id}>
                    <button type="button" className={h.day === day ? 'is-on' : ''} onClick={() => setDay(h.day)}>
                      <span>{new Date(h.day + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { weekday: 'short', day: 'numeric', month: 'short' })}</span>
                      <small>{h.auto ? '⏰ ' + tr('by itself') : h.closedBy}</small>
                      <b>{money(h.net)}</b>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      <div className="cz-card cz-auto">
        <h4>⏰ {tr('Close by itself')}</h4>
        <button type="button" role="switch" aria-checked={cfg.auto} className="ts-toggle-row" onClick={() => set(['closeDay'], { ...cfg, auto: !cfg.auto })}>
          <span><strong>{tr('Close the day at a set time')}</strong><small>{tr('If nobody has closed it by then. A time before noon closes the night before, for late nights. A day with no sale and no drawer is not closed.')}</small></span>
          <span className={'ts-switch' + (cfg.auto ? ' is-on' : '')} aria-hidden="true"><i /></span>
        </button>
        <div className="pu-row">
          {cfg.auto && <label className="dz-num"><span>{tr('At')}</span><input className="input" type="time" value={cfg.at} onChange={(e) => set(['closeDay'], { ...cfg, at: e.target.value })} /></label>}
          <div className="field pu-grow"><label htmlFor="cz-em">{tr('Email the day to')}</label>
            <input id="cz-em" className="input" value={emailsText} onChange={(e) => { setEmailsText(e.target.value); set(['closeDay'], { ...cfg, emails: e.target.value.split(/[,;\s]+/).filter(Boolean) }); }} placeholder={tr('owner@example.com, manager@example.com')} />
          </div>
          <div className="field"><label htmlFor="cz-wa">{tr('Owner\'s WhatsApp')}</label>
            <input id="cz-wa" className="input" inputMode="tel" maxLength={30} value={cfg.whatsapp || ''} onChange={(e) => set(['closeDay'], { ...cfg, whatsapp: e.target.value })} placeholder="024 000 0000" />
          </div>
        </div>
        <small className="dk-muted">{tr('Saved with the till settings. The managers are told on their phones each time a day is closed.')}</small>
      </div>
    </section>
  );
}
