import { useEffect, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';
import { RANGES, rangeOf, useTip } from './ranges';
import './growth.css';
import './fifth.css';

// Back office → Reports → Tips (backend restaurantTips): the tips taken in
// the days picked, shared out as the settings say — to whoever served, by
// sale (among the team clocked in), or by hours worked — each person's
// share, their hours, what has been handed to them and what they are still
// owed; a payout noted with one tap. Another way of sharing can be looked
// at without changing the settings. One blue series for the days' tips.

const METHOD = { direct: () => tr('To whoever served'), sale: () => tr('By sale'), hours: () => tr('By hours') };
const ROLE = { manager: () => tr('Manager'), cashier: () => tr('Cashier'), waiter: () => tr('Waiter'), kitchen: () => tr('Kitchen') };
const PAY = [['cash', () => tr('Cash')], ['mobile_money', () => tr('Mobile Money')], ['payroll', () => tr('With the pay')], ['other', () => tr('Other')]];
function short(s) { return new Date(s + 'T12:00:00').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short' }); }
function initials(n) { return String(n || '?').split(' ').map((x) => x.charAt(0)).join('').slice(0, 2).toUpperCase(); }

function Payout({ person, through, onPay, onCancel }) {
  const [amount, setAmount] = useState(String(person.owed || ''));
  const [method, setMethod] = useState('cash');
  const [note, setNote] = useState('');
  return (
    <form className="tp-pay" onSubmit={(e) => { e.preventDefault(); onPay({ employeeId: person.id, amount: Number(amount), method, note, through }); }}>
      <label className="field"><span>{tr('Amount (GHS)')}</span><input className="input" type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus /></label>
      <div className="ts-chips" role="radiogroup" aria-label={tr('How it was paid')}>
        {PAY.map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={method === k} className={'ts-chip' + (method === k ? ' is-on' : '')} onClick={() => setMethod(k)}>{label()}</button>)}
      </div>
      <input className="input" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr('A note (optional)')} aria-label={tr('Note')} />
      <div className="tp-pay-go">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>{tr('Cancel')}</button>
        <button type="submit" className="btn btn-primary" disabled={!(Number(amount) > 0)}>✓ {tr('Paid out')}</button>
      </div>
    </form>
  );
}

export default function TipsReport({ token, pin, onFail }) {
  const [range, setRange] = useState('7');
  const [method, setMethod] = useState(null); // null: as the settings say
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [paying, setPaying] = useState(null);
  const [tipOn, tipNode] = useTip();
  const r = rangeOf(range);
  function ask(extra) {
    setBusy(true);
    return posFetch('POST', '/pos/settings/tips', token, { managerPin: pin || undefined, from: r.from, to: r.to, method: method || undefined, ...extra })
      .then(setData).catch(onFail).finally(() => setBusy(false));
  }
  useEffect(() => { ask(); }, [range, method, token, pin]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <section className="ts-sec"><p className="dk-muted">{busy ? tr('Loading…') : ''}</p></section>;
  const max = Math.max(1, ...data.days.map((d) => d.tips));
  const top = Math.max(1, ...data.people.map((p) => p.tips));
  return (
    <section className={'ts-sec in tips' + (busy ? ' is-busy' : '')}>
      <div className="in-filters">
        <div className="ts-chips" role="radiogroup" aria-label={tr('When')}>
          {RANGES.map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={range === k} className={range === k ? 'is-on' : ''} onClick={() => setRange(k)}>{tr(label)}</button>)}
        </div>
        <label className="in-compare"><span>{tr('Shared')}</span>
          <select className="input" value={method || ''} onChange={(e) => setMethod(e.target.value || null)}>
            <option value="">{tr('As set: {way}', { way: METHOD[data.setMethod]() })}</option>
            {Object.keys(METHOD).filter((k) => k !== data.setMethod).map((k) => <option key={k} value={k}>{tr('What if: {way}', { way: METHOD[k]() })}</option>)}
          </select>
        </label>
      </div>
      {!data.on && <p className="ts-note">💡 {tr('Tips are off on the till: turn them on in Setup → Bookings, tips and rewards.')}</p>}

      <div className="in-kpis">
        {[['💛', tr('Tips'), money(data.total)], ['🧾', tr('Tipped orders'), data.orders], ['🎯', tr('Average tip'), money(data.average)], ['⏳', tr('Still to hand out'), money(data.owed)]].map(([art, label, value]) => (
          <div key={label} className="in-kpi"><span className="in-kpi-ico" aria-hidden="true">{art}</span><span className="in-kpi-label">{label}</span><strong>{value}</strong></div>
        ))}
      </div>

      <div className="in-card">
        <h3>{tr('Tips by day')}</h3>
        <div className="tips-days" role="list">
          {data.days.map((d) => (
            <div key={d.day} className="tips-day" role="listitem">
              <span className="tips-col" {...tipOn(short(d.day) + ': ' + money(d.tips) + ' · ' + (d.orders === 1 ? tr('1 tipped order') : tr('{n} tipped orders', { n: d.orders })))}>
                <i style={{ height: Math.max(d.tips > 0 ? 4 : 0, d.tips / max * 100) + '%' }} />
              </span>
              <small>{data.days.length <= 14 || data.days.indexOf(d) % 5 === 0 ? short(d.day) : ''}</small>
            </div>
          ))}
        </div>
      </div>

      <div className="in-card">
        <h3>{tr('Who gets what')} <small className="dk-muted">{METHOD[data.method]()}{data.method !== 'direct' ? ' · ' + data.roles.map((x) => (ROLE[x] ? ROLE[x]() : x)).join(', ') : ''}</small></h3>
        {data.fallback > 0 && <p className="dk-muted tips-fall">{tr('{amount} was paid when nobody who shares was clocked in: it went to whoever served.', { amount: money(data.fallback) })}</p>}
        {!data.people.length && <p className="dk-muted">{tr('No tips in these days.')}</p>}
        <ul className="tips-people is-plain">
          {data.people.map((p) => (
            <li key={p.id} className={p.owed > 0 ? 'is-owed' : p.paid > 0 ? 'is-paid' : ''}>
              <span className="tips-ava" aria-hidden="true">{initials(p.name)}</span>
              <div className="tips-who">
                <strong>{p.name}</strong>
                <small>{[p.role && ROLE[p.role] ? ROLE[p.role]() : null, p.hours > 0 ? tr('{n} h worked', { n: p.hours }) : null, p.served > 0 ? tr('served {n} tipped', { n: p.served }) : null].filter(Boolean).join(' · ')}</small>
                <span className="tips-bar" {...tipOn(p.name + ': ' + money(p.tips) + (data.total > 0 ? ' · ' + Math.round(p.tips / data.total * 100) + '%' : ''))}><i style={{ width: Math.max(2, p.tips / top * 100) + '%' }} /></span>
              </div>
              <div className="tips-sum">
                <strong>{money(p.tips)}</strong>
                <small>{p.paid > 0 ? tr('{amount} paid', { amount: money(p.paid) }) : ''}{p.paid > 0 && p.owed > 0 ? ' · ' : ''}{p.owed > 0 ? tr('{amount} owed', { amount: money(p.owed) }) : p.tips > 0 && p.paid >= p.tips ? '✓ ' + tr('all paid') : ''}</small>
                {p.owed > 0 && paying !== p.id && <button type="button" className="btn btn-secondary tl-btn" onClick={() => setPaying(p.id)}>💸 {tr('Pay out')}</button>}
              </div>
              {paying === p.id && <Payout person={p} through={data.period.to} onCancel={() => setPaying(null)} onPay={(x) => { setPaying(null); ask({ action: 'payout', ...x }); }} />}
            </li>
          ))}
        </ul>
      </div>

      {data.payouts.length > 0 && (
        <div className="in-card">
          <h3>{tr('Paid out')}</h3>
          <table className="ts-table">
            <thead><tr><th>{tr('To')}</th><th>{tr('Up to')}</th><th>{tr('How')}</th><th>{tr('By')}</th><th className="is-num">{tr('Amount')}</th><th /></tr></thead>
            <tbody>
              {data.payouts.map((x) => (
                <tr key={x.id}><td>{x.name}{x.note ? <small className="dk-muted"> · {x.note}</small> : null}</td><td>{short(x.through)}</td><td>{(PAY.find(([k]) => k === x.method) || PAY[3])[1]()}</td><td>{x.by || '—'}</td>
                  <td className="is-num">{money(x.amount)}</td>
                  <td><button type="button" className="pos-line-x" aria-label={tr('Remove')} onClick={() => { if (window.confirm(tr('Take this payout off? Use it for one put in by mistake.'))) ask({ action: 'remove', id: x.id }); }}>×</button></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {tipNode}
    </section>
  );
}
