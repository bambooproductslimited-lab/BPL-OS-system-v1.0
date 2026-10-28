import { useCallback, useEffect, useState } from 'react';
import { API_URL, api } from '../api/client';
import { money } from '../lib/currency';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './seventeenth.css';
import './twentyfirst.css';

// The monthly management report (Reports → Monthly report; backend
// managementReport.service.js, migration 0203): the month for the owners on
// one page — sales by company against the month before, margins, what was
// spent, cash in and out and what is owed, stock and production, power,
// people and safety, licences ending soon — downloaded as a PDF or emailed,
// by hand or on its own on the 1st.

const CATEGORY = {
  payroll: msg('Payroll'), stock: msg('Stock'), utilities: msg('Utilities'), rent: msg('Rent'), services: msg('Services'), equipment: msg('Equipment'),
  transport: msg('Transport'), fuel: msg('Fuel'), expenses: msg('Expenses'), staff: msg('Staff'), other: msg('Other')
};
const CAT_COLOURS = ['#0f766e', '#2563eb', '#7c3aed', '#d97706', '#db2777', '#0891b2', '#65a30d', '#64748b'];

function dayText(d) { return d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—'; }
function monthLabel(m) { return new Date(m + '-15T12:00:00Z').toLocaleDateString(activeIntlLocale(), { month: 'long', year: 'numeric', timeZone: 'UTC' }); }
function monthShort(m) { return new Date(m + '-15T12:00:00Z').toLocaleDateString(activeIntlLocale(), { month: 'short', timeZone: 'UTC' }); }
function prevMonth(m) { const d = new Date(m + '-15T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); }
function timeText(d) { return d ? new Date(d).toLocaleString(activeIntlLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'; }
function num(v, p = 1) { return v == null ? '—' : (Math.round(v * 10 ** p) / 10 ** p).toLocaleString(activeIntlLocale()); }
function pct(n) { return n == null ? '—' : (n > 0 ? '+' : '') + n + '%'; }

function Fact({ label, value, tone }) { return <div className={'mrp-fact' + (tone ? ' is-' + tone : '')}><span>{label}</span><b>{value}</b></div>; }

function SettingsCard({ d, onSaved }) {
  const [list, setList] = useState(d.settings.recipients);
  const [add, setAdd] = useState('');
  const [auto, setAuto] = useState(d.settings.autoSend);
  const [busy, setBusy] = useState(false);
  const [msgText, setMsg] = useState(null);
  const [error, setError] = useState(null);
  function push() {
    const e = add.trim().toLowerCase();
    if (!e) return;
    if (!list.includes(e)) setList(list.concat(e));
    setAdd('');
  }
  async function save() {
    setBusy(true); setError(null); setMsg(null);
    try { onSaved(await api.put('/management-report/settings', { recipients: list, autoSend: auto, month: d.month })); setMsg(tr('Saved.')); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return (
    <section className="x7-card mrp-settings"><h2>👥 {tr('Who it goes to')}</h2>
      <div className="mrp-chips">{list.map((e) => <span key={e} className="mrp-chip">{e}<button type="button" onClick={() => setList(list.filter((x) => x !== e))} aria-label={tr('Take off {who}', { who: e })}>✕</button></span>)}{!list.length && <span className="x7-muted">{tr('Nobody yet.')}</span>}</div>
      <div className="mrp-add"><input className="input" type="email" value={add} onChange={(e) => setAdd(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); push(); } }} placeholder={tr('An owner\'s email address')} aria-label={tr('Email address')} /><button type="button" className="btn btn-secondary" onClick={push}>➕ {tr('Add')}</button></div>
      <label className="x7-check"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /><span>{tr('Send it on its own on the 1st, for the month just ended')}</span></label>
      {error && <div className="error-banner" role="alert">{error}</div>}
      {msgText && <p className="x7-flash is-good" role="status">✅ {msgText}</p>}
      <div className="dialog-actions"><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{tr('Save')}</button></div>
    </section>
  );
}

export default function ManagementReportPage() {
  const [month, setMonth] = useState(prevMonth(new Date().toISOString().slice(0, 7)));
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const load = useCallback(() => { setD(null); return api.get('/management-report?month=' + month).then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message)); }, [month]);
  useEffect(() => { load(); }, [load]);
  async function pdf() {
    setBusy(true); setError(null);
    try {
      const r = await fetch(API_URL + '/management-report/pdf?month=' + month, { headers: api.authHeaders() });
      if (!r.ok) throw new Error(tr('The PDF did not come through: try again.'));
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement('a');
      a.href = url; a.download = 'Management report ' + month + '.pdf';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function send() {
    if (!window.confirm(tr('Email the {m} report to {list}?', { m: monthLabel(month), list: d.settings.recipients.join(', ') }))) return;
    setBusy(true); setError(null); setFlash(null);
    try { setD(await api.post('/management-report/send', { month })); setFlash(tr('Emailed to {n} people.', { n: d.settings.recipients.length })); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const months = d ? d.months : [];
  return (
    <div className="x7">
      <header className="x7-head">
        <div>
          <h1>📊 {tr('Monthly management report')}</h1>
          <p>{tr('The month for the owners on one page: sales against the month before, margins, spending, cash, stock and production, power, people and safety, and the licences ending soon. A PDF to download or email.')}</p>
        </div>
        <div className="x7-head-actions">
          <select className="input mrp-month" value={month} onChange={(e) => setMonth(e.target.value)} aria-label={tr('Month')}>{(months.length ? months : [{ month, label: month }]).map((m) => <option key={m.month} value={m.month}>{monthLabel(m.month)}</option>)}</select>
          <button type="button" className="btn btn-secondary" disabled={busy || !d} onClick={pdf}>⬇️ {tr('Download the PDF')}</button>
          <button type="button" className="btn btn-primary" disabled={busy || !d || !d.settings.recipients.length || !d.emailOn} onClick={send} title={d && !d.emailOn ? tr('Email is not set up on the server yet.') : ''}>✉️ {tr('Email it to the owners')}</button>
        </div>
      </header>
      {error && <div className="error-banner" role="alert">{error}</div>}
      {flash && <p className="x7-flash is-good" role="status">✅ {flash}</p>}
      {!d ? <p className="x7-wait">{tr('Loading…')}</p> : (() => {
        const s = d.sales, prev = prevMonth(d.month);
        const top = Math.max(1, ...s.companies.map((c) => Math.max(c.sales, c.before)));
        return (
          <>
            <div className="mrp-paper">
              <div className="mrp-band"><span aria-hidden="true">🎋</span><div><small>{tr('Bamboo Products Limited · the group')}</small><h2>{monthLabel(d.month)}</h2><p>{tr('against {m}', { m: monthLabel(prev) })}</p></div></div>
              <div className="x7-tiles mrp-tiles">
                <div className={'x7-tile ' + (s.change == null ? 'is-calm' : s.change >= 0 ? 'is-good' : 'is-bad')}><small>💰 {tr('Sales')}</small><b>{money(s.total)}</b><span>{s.change == null ? tr('nothing to set against') : tr('{p} on {m}', { p: pct(s.change), m: monthShort(prev) })}</span></div>
                <div className="x7-tile is-violet"><small>🧾 {tr('Spent')}</small><b>{money(d.spending.total)}</b><span>{tr('bills, payroll, expenses, fuel')}</span></div>
                <div className={'x7-tile ' + (d.cash.owedToUs.late > 0 ? 'is-warn' : 'is-good')}><small>🏦 {tr('Cash collected')}</small><b>{money(d.cash.collected)}</b><span>{tr('{v} overdue', { v: money(d.cash.owedToUs.late) })}</span></div>
                <div className="x7-tile is-teal"><small>👥 {tr('People')}</small><b>{d.people.headcount}</b><span>{tr('+{a} joined · {b} left', { a: d.people.joined, b: d.people.left })}</span></div>
              </div>

              <section className="mrp-sec"><h3>💰 {tr('Sales by company')}</h3>
                <div className="mrp-sales">{s.companies.map((c) => (
                  <div key={c.code} className="mrp-sale">
                    <span className="mrp-sale-name"><b>{c.name}</b><small>{c.count} {c.countWord === 'orders' ? tr('orders') : tr('invoices')}{c.average != null ? ' · ' + tr('{v} on average', { v: money(c.average) }) : ''}{c.foodCost != null ? ' · ' + tr('food cost {n}%', { n: c.foodCost }) : ''}</small></span>
                    <span className="mrp-sale-bars"><i style={{ width: c.sales / top * 100 + '%' }} /><i className="is-before" style={{ width: c.before / top * 100 + '%' }} /></span>
                    <span className="mrp-sale-fig"><b>{money(c.sales)}</b><small className={c.change == null ? '' : c.change >= 0 ? 'is-good' : 'is-bad'}>{pct(c.change)}</small></span>
                  </div>
                ))}</div>
                <p className="mrp-legend"><i /> {monthShort(d.month)} <i className="is-before" /> {monthShort(prev)}</p>
              </section>

              <div className="mrp-two">
                <section className="mrp-sec"><h3>📐 {tr('Margins')}</h3>
                  {d.margins.bom ? <>
                    <Fact label={tr('Average margin on the bills of materials')} value={d.margins.bom.average + '%'} tone={d.margins.bom.average < 20 ? 'bad' : 'good'} />
                    <Fact label={tr('Products under 20%')} value={d.margins.bom.low} tone={d.margins.bom.low ? 'warn' : ''} />
                    {d.margins.bom.lowest.map((x) => <Fact key={x.name} label={tr('Lowest: {name}', { name: x.name })} value={x.marginPct + '%'} tone={x.marginPct < 20 ? 'bad' : ''} />)}
                  </> : <p className="x7-muted">{tr('No product costed yet.')}</p>}
                  {d.margins.food.map((f) => <Fact key={f.code} label={tr('Food cost, {name}', { name: f.name })} value={f.foodCost + '%'} tone={f.foodCost > 35 ? 'warn' : 'good'} />)}
                </section>
                <section className="mrp-sec"><h3>🏦 {tr('Cash')}</h3>
                  <Fact label={tr('Collected from customers')} value={money(d.cash.collected)} tone="good" />
                  <Fact label={tr('Supplier bills paid')} value={money(d.cash.billsPaid)} />
                  <Fact label={tr('Payroll and SSNIT')} value={money(d.cash.payroll)} />
                  <Fact label={tr('Owed to us')} value={money(d.cash.owedToUs.amount) + (d.cash.owedToUs.late ? ' · ' + tr('{v} late', { v: money(d.cash.owedToUs.late) }) : '')} tone={d.cash.owedToUs.late ? 'warn' : ''} />
                  <Fact label={tr('We owe suppliers')} value={money(d.cash.weOwe.amount) + (d.cash.weOwe.late ? ' · ' + tr('{v} late', { v: money(d.cash.weOwe.late) }) : '')} tone={d.cash.weOwe.late ? 'bad' : ''} />
                  {d.cash.banks.map((b) => <Fact key={b.code + b.name} label={b.code + ' · ' + b.name} value={(b.currency || 'GHS') + ' ' + num(b.balance, 0)} />)}
                </section>
              </div>

              <section className="mrp-sec"><h3>🧾 {tr('What was spent')}</h3>
                {!d.spending.companies.length ? <p className="x7-muted">{tr('Nothing recorded this month.')}</p> : <div className="mrp-spend">{d.spending.companies.map((c) => (
                  <div key={c.code} className="mrp-spend-row">
                    <span className="mrp-sale-name"><b>{c.name}</b><small>{money(c.total)} · {pct(c.change)}</small></span>
                    <span className="mrp-stack" role="img" aria-label={c.categories.map((x) => tr(CATEGORY[x.category] || CATEGORY.other) + ' ' + money(x.amount)).join(', ')}>
                      {c.categories.map((x, i) => <i key={x.category} style={{ flexGrow: x.amount, background: CAT_COLOURS[i % CAT_COLOURS.length] }} title={tr(CATEGORY[x.category] || CATEGORY.other) + ' · ' + money(x.amount)} />)}
                    </span>
                    <span className="mrp-cats">{c.categories.slice(0, 4).map((x, i) => <small key={x.category}><i style={{ background: CAT_COLOURS[i % CAT_COLOURS.length] }} />{tr(CATEGORY[x.category] || CATEGORY.other)} {money(x.amount)}</small>)}</span>
                  </div>
                ))}</div>}
              </section>

              <div className="mrp-two">
                <section className="mrp-sec"><h3>🏭 {tr('Stock and production')}</h3>
                  <Fact label={tr('Stock at cost')} value={money(d.stock.value)} />
                  <Fact label={tr('Products at or under reorder')} value={d.stock.low} tone={d.stock.low ? 'warn' : ''} />
                  {d.stock.raw.slice(0, 2).map((x) => <Fact key={x.unit} label={tr('Raw bamboo in store')} value={num(x.qty, 0) + ' ' + x.unit} />)}
                  <Fact label={tr('Jobs finished')} value={d.stock.jobs.jobs + ' · ' + num(d.stock.jobs.good, 0) + ' ' + tr('made')} />
                  <Fact label={tr('Spoilt')} value={d.stock.jobs.scrapPct == null ? '—' : d.stock.jobs.scrapPct + '%'} tone={d.stock.jobs.scrapPct > 5 ? 'warn' : ''} />
                  <Fact label={tr('Outgrowers paid')} value={money(d.stock.outgrowers.paid) + ' · ' + d.stock.outgrowers.payments} />
                  <Fact label={tr('Quotes awarded')} value={d.stock.rfqs} />
                </section>
                <section className="mrp-sec"><h3>⚡ {tr('Power')}</h3>
                  <Fact label={tr('Power cuts')} value={d.power.outages} />
                  <Fact label={tr('Hours without power')} value={num(d.power.offHours)} tone={d.power.offHours > 24 ? 'warn' : ''} />
                  <Fact label={tr('Generator hours')} value={num(d.power.genHours)} />
                  <Fact label={tr('Fuel bought')} value={num(d.power.litres) + ' L · ' + money(d.power.fuelCost)} />
                  <Fact label={tr('A generator hour costs')} value={d.power.costPerHour != null ? money(d.power.costPerHour) : '—'} />
                  <Fact label={tr('Prepaid electricity')} value={money(d.power.prepaid)} />
                </section>
              </div>

              <div className="mrp-two">
                <section className="mrp-sec"><h3>👥 {tr('People')}</h3>
                  <Fact label={tr('Working here')} value={d.people.headcount} />
                  <Fact label={tr('Joined · left')} value={d.people.joined + ' · ' + d.people.left} />
                  <Fact label={tr('Leave taken')} value={tr('{n} days', { n: num(d.people.leaveDays) })} />
                  <Fact label={tr('Late arrivals')} value={d.people.late + (d.people.latePct != null ? ' · ' + d.people.latePct + '%' : '')} tone={d.people.latePct > 10 ? 'warn' : ''} />
                  <Fact label={tr('Absent days')} value={d.people.absent} />
                </section>
                <section className="mrp-sec"><h3>🦺 {tr('Safety')}</h3>
                  <Fact label={tr('Incidents')} value={d.safety.incidents} />
                  <Fact label={tr('Serious')} value={d.safety.serious} tone={d.safety.serious ? 'bad' : ''} />
                  <Fact label={tr('Near misses')} value={d.safety.nearMisses} />
                  <Fact label={tr('Days lost to injury')} value={d.safety.lostDays} tone={d.safety.lostDays ? 'warn' : ''} />
                  <Fact label={tr('Days since a lost-time injury')} value={d.safety.daysSinceLost == null ? tr('none recorded') : d.safety.daysSinceLost} tone="good" />
                </section>
              </div>

              <section className="mrp-sec"><h3>📜 {tr('Licences and permits ending soon')}</h3>
                {!d.licences.length ? <p className="mrp-ok">✅ {tr('None ending in the next 60 days.')}</p> : <div className="mrp-lic">{d.licences.map((l, i) => (
                  <div key={i} className={l.expires < new Date().toISOString().slice(0, 10) ? 'is-bad' : ''}><b>{l.title}</b><small>{l.company}</small><span>{dayText(l.expires)}</span><em>{l.renewing ? tr('renewal applied for') : l.expires < new Date().toISOString().slice(0, 10) ? tr('expired') : tr('to renew')}</em></div>
                ))}</div>}
              </section>
            </div>

            <div className="x7-grid2">
              {d.canSettings ? <SettingsCard d={d} onSaved={setD} /> : <section className="x7-card"><h2>👥 {tr('Who it goes to')}</h2><p>{d.settings.recipients.join(', ') || tr('Nobody yet.')}</p></section>}
              <section className="x7-card"><h2>📨 {tr('Sent')}</h2>
                {!d.sent.length ? <p className="x7-muted">{tr('Not sent yet.')}</p> : <div className="x7-list">{d.sent.map((x) => (
                  <div key={x.month} className="x7-row">
                    <span className="x7-icon" aria-hidden="true">{x.auto ? '🤖' : '✉️'}</span>
                    <span className="x7-who"><b>{monthLabel(x.month)}</b><small>{timeText(x.at)} · {x.auto ? tr('on its own') : x.by || ''}{x.to ? ' · ' + x.to : ''}</small></span>
                    <span /><span />
                  </div>
                ))}</div>}
                {!d.emailOn && <p className="x7-note">✉️ {tr('Email is not set up on the server yet: download the PDF instead.')}</p>}
              </section>
            </div>
          </>
        );
      })()}
    </div>
  );
}
