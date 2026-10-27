import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { money } from '../lib/currency';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './AdvancesPage.css';

// Salary advances (Finance → Salary advances; backend advances.service.js,
// migration 0197): staff ask from My space for part of their pay early —
// up to a share of a month's pay, repaid over a few months — finance
// approves or declines, pays it out, and each payslip takes off an
// instalment until it is repaid (or it is repaid in cash).

function dayText(d) { return d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—'; }
function hue(name) { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function today() { return new Date().toISOString().slice(0, 10); }
const ADV_STATUS = {
  requested: ['🙋', msg('Asked')], approved: ['👍', msg('Approved · to be paid out')], declined: ['✋', msg('Declined')],
  paid: ['🔁', msg('Being repaid')], repaid: ['✅', msg('Repaid')], cancelled: ['🚫', msg('Cancelled')]
};
const METHOD = { bank: ['🏦', msg('Bank transfer')], mobile_money: ['📱', msg('Mobile Money')], cash: ['💵', msg('Cash')] };

function Progress({ a }) {
  const pct = a.amount ? Math.min(100, Math.round(a.repaid / a.amount * 100)) : 0;
  return (
    <span className="adv-progress" role="img" aria-label={tr('{repaid} of {amount} repaid', { repaid: money(a.repaid, 'GHS'), amount: money(a.amount, 'GHS') })}>
      <i style={{ width: pct + '%' }} /><span>{tr('{repaid} of {amount} repaid', { repaid: money(a.repaid, 'GHS'), amount: money(a.amount, 'GHS') })}</span>
    </span>
  );
}

function Sheet({ id, onClose, onChanged }) {
  const [a, setA] = useState(null);
  const [mode, setMode] = useState('');
  const [f, setF] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { api.get('/advances/' + id).then((x) => { setA(x); setF({ amount: String(x.amount), months: String(x.months), method: 'mobile_money', paidOn: today(), reference: '', reason: '', repay: '', note: '' }); }).catch((e) => setError(e.message)); }, [id]);
  async function act(path, body) {
    setBusy(true); setError(null);
    try { setA(await api.post('/advances/' + id + '/' + path, body)); setMode(''); onChanged(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  if (!a) return <div className="dialog-backdrop" onClick={onClose}><div className="dialog adv-sheet"><p className="adv-wait">{error || tr('Loading…')}</p></div></div>;
  const share = a.employee.monthlyPay ? Math.round(a.amount / a.employee.monthlyPay * 100) : null;
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog adv-sheet" role="dialog" aria-modal="true" aria-labelledby="adv-title" onClick={(e) => e.stopPropagation()}>
        <div className={'adv-hero is-' + a.status}>
          <span className="adv-avatar" style={{ '--h': hue(a.employee.name) }} aria-hidden="true">{a.employee.name.charAt(0)}</span>
          <div>
            <small>{a.ref} · {a.employee.position || a.employee.code}{a.employee.company ? ' · ' + a.employee.company : ''}</small>
            <h2 id="adv-title">{a.employee.name}</h2>
            <p><b>{money(a.amount, 'GHS')}</b><span className="adv-pill">{ADV_STATUS[a.status][0]} {tr(ADV_STATUS[a.status][1])}</span></p>
          </div>
          <button type="button" className="adv-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        <dl className="adv-facts">
          <div><dt>{tr('Repaid')}</dt><dd>{tr('{amount} a month', { amount: money(a.instalment, 'GHS') })}<br /><small>{a.months === 1 ? tr('over 1 month') : tr('over {n} months', { n: a.months })}</small></dd></div>
          <div><dt>{tr('A month\'s pay')}</dt><dd>{money(a.employee.monthlyPay, 'GHS')}<br /><small>{share != null ? tr('this is {n}% of it', { n: share }) : ''}</small></dd></div>
          <div><dt>{tr('Asked on')}</dt><dd>{dayText(a.createdAt)}</dd></div>
        </dl>
        <p className="adv-reason">💬 “{a.reason}”</p>
        {a.status === 'paid' && <Progress a={a} />}
        {a.decidedBy && <p className="adv-note">{a.status === 'declined' ? '✋ ' + tr('Declined by {name} on {date}: {reason}', { name: a.decidedBy, date: dayText(a.decidedAt), reason: a.declineReason }) : '👍 ' + tr('Approved by {name} on {date}', { name: a.decidedBy, date: dayText(a.decidedAt) })}</p>}
        {a.paidAt && <p className="adv-note">{METHOD[a.paidMethod][0]} {tr('Paid out on {date} by {method}', { date: dayText(a.paidAt), method: tr(METHOD[a.paidMethod][1]) })}{a.paidReference ? ' · ' + a.paidReference : ''}{a.paidBy ? ' · ' + a.paidBy : ''}</p>}
        {a.repayments.length > 0 && (
          <div className="adv-reps">
            <h3>{tr('Repayments')}</h3>
            {a.repayments.map((r, i) => (
              <span key={i}><em aria-hidden="true">{r.kind === 'payroll' ? '🧾' : '💵'}</em><span>{r.kind === 'payroll' ? tr('Payslip, pay run {run}', { run: r.runNo }) : tr('In cash') + (r.note ? ' · ' + r.note : '')}<small>{dayText(r.at)}</small></span><b>{money(r.amount, 'GHS')}</b></span>
            ))}
          </div>
        )}
        {error && <div className="error-banner" role="alert">{error}</div>}
        {mode === 'approve' && (
          <form className="adv-form" onSubmit={(e) => { e.preventDefault(); act('decide', { approve: true, amount: Number(f.amount), months: Number(f.months) }); }}>
            <h3>👍 {tr('Approve')}</h3>
            <div className="adv-grid">
              <label><span>{tr('Amount')}</span><input className="input" type="number" min="1" max={a.amount} step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /><small>{tr('Up to what was asked.')}</small></label>
              <label><span>{tr('Repaid over')}</span><select className="input" value={f.months} onChange={(e) => setF({ ...f, months: e.target.value })}>{Array.from({ length: 12 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n === 1 ? tr('1 month') : tr('{n} months', { n })}</option>)}</select>
                <small>{tr('{amount} a month', { amount: money(Math.ceil(Number(f.amount || 0) / Number(f.months || 1) * 100) / 100, 'GHS') })}</small></label>
            </div>
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setMode('')}>{tr('Back')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Approve')}</button></div>
          </form>
        )}
        {mode === 'decline' && (
          <form className="adv-form" onSubmit={(e) => { e.preventDefault(); act('decide', { approve: false, reason: f.reason }); }}>
            <h3>✋ {tr('Decline')}</h3>
            <label><span>{tr('Why? {name} reads this.', { name: a.employee.name })}</span><textarea className="input" rows={2} required value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></label>
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setMode('')}>{tr('Back')}</button><button type="submit" className="btn btn-danger" disabled={busy}>{tr('Decline')}</button></div>
          </form>
        )}
        {mode === 'pay' && (
          <form className="adv-form" onSubmit={(e) => { e.preventDefault(); act('pay', { method: f.method, reference: f.reference, paidOn: f.paidOn }); }}>
            <h3>💸 {tr('Pay it out')}</h3>
            <div className="adv-methods" role="group" aria-label={tr('How')}>
              {Object.entries(METHOD).map(([k, [ic, l]]) => <button key={k} type="button" className={f.method === k ? 'is-on' : ''} onClick={() => setF({ ...f, method: k })}><em aria-hidden="true">{ic}</em>{tr(l)}</button>)}
            </div>
            <div className="adv-grid">
              <label><span>{tr('Paid on')}</span><input className="input" type="date" max={today()} value={f.paidOn} onChange={(e) => setF({ ...f, paidOn: e.target.value })} /></label>
              <label><span>{tr('Reference')}</span><input className="input" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} placeholder={tr('Optional')} /></label>
            </div>
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setMode('')}>{tr('Back')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Paid {amount}', { amount: money(a.amount, 'GHS') })}</button></div>
          </form>
        )}
        {mode === 'repay' && (
          <form className="adv-form" onSubmit={(e) => { e.preventDefault(); act('repay', { amount: Number(f.repay), note: f.note }); }}>
            <h3>💵 {tr('Repaid in cash')}</h3>
            <div className="adv-grid">
              <label><span>{tr('Amount')}</span><input className="input" type="number" min="0.01" max={a.left} step="0.01" required value={f.repay} onChange={(e) => setF({ ...f, repay: e.target.value })} /><small>{tr('{amount} left', { amount: money(a.left, 'GHS') })}</small></label>
              <label><span>{tr('Note')}</span><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder={tr('Optional')} /></label>
            </div>
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setMode('')}>{tr('Back')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Record it')}</button></div>
          </form>
        )}
        {!mode && (
          <div className="adv-actions">
            {a.status === 'requested' && <button type="button" className="btn btn-primary" onClick={() => setMode('approve')}>👍 {tr('Approve')}</button>}
            {a.status === 'requested' && <button type="button" className="btn btn-secondary" onClick={() => setMode('decline')}>✋ {tr('Decline')}</button>}
            {a.status === 'approved' && <button type="button" className="btn btn-primary" onClick={() => setMode('pay')}>💸 {tr('Pay it out')}</button>}
            {a.status === 'paid' && <button type="button" className="btn btn-secondary" onClick={() => setMode('repay')}>💵 {tr('Repaid in cash')}</button>}
            {(a.status === 'requested' || a.status === 'approved') && <button type="button" className="btn btn-secondary adv-cancel" disabled={busy} onClick={() => act('cancel', {})}>{tr('Cancel the advance')}</button>}
          </div>
        )}
      </div>
    </div>
  );
}

function Rules({ settings, onClose, onSaved }) {
  const [f, setF] = useState({ open: settings.open, maxPercent: String(settings.maxPercent), maxMonths: String(settings.maxMonths) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await api.put('/advances/settings', { open: f.open, maxPercent: Number(f.maxPercent), maxMonths: Number(f.maxMonths) }); onSaved(); }
    catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog adv-dlg" role="dialog" aria-modal="true" aria-labelledby="adv-rules" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="adv-dlg-head"><span className="adv-dlg-art" aria-hidden="true">⚖️</span><div><h2 id="adv-rules">{tr('Rules for advances')}</h2><p>{tr('What staff can ask for from My space.')}</p></div></div>
        <label className="adv-switch"><input type="checkbox" checked={f.open} onChange={(e) => setF({ ...f, open: e.target.checked })} /><span><b>{tr('Staff can ask for an advance')}</b><small>{tr('Off: the form in My space is closed.')}</small></span></label>
        <div className="adv-grid">
          <label><span>{tr('At most, share of a month\'s pay')}</span><input className="input" type="number" min="1" max="100" value={f.maxPercent} onChange={(e) => setF({ ...f, maxPercent: e.target.value })} /><small>%</small></label>
          <label><span>{tr('Repaid over at most')}</span><select className="input" value={f.maxMonths} onChange={(e) => setF({ ...f, maxMonths: e.target.value })}>{Array.from({ length: 12 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n === 1 ? tr('1 month') : tr('{n} months', { n })}</option>)}</select></label>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Save')}</button></div>
      </form>
    </div>
  );
}

export default function AdvancesPage() {
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState('waiting');
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [rules, setRules] = useState(false);
  const load = useCallback(() => api.get('/advances?status=' + status).then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message)), [status]);
  useEffect(() => { load(); }, [load]);
  const openId = params.get('open');
  const open = (id) => setParams((p) => { const n = new URLSearchParams(p); if (id) n.set('open', id); else n.delete('open'); return n; });
  if (!d) return <div className="adv"><p className="adv-wait">{error || tr('Loading…')}</p></div>;
  const s = d.summary;
  return (
    <div className="adv">
      <header className="adv-head">
        <div>
          <h1>💵 {tr('Salary advances')}</h1>
          <p>{tr('Staff ask from My space; you approve, pay it out, and each payslip takes back an instalment until it is repaid.')}</p>
        </div>
        <button type="button" className="btn btn-secondary" onClick={() => setRules(true)}>⚖️ {tr('Rules')} · {d.settings.open ? tr('{n}% of pay, {m} months', { n: d.settings.maxPercent, m: d.settings.maxMonths }) : tr('closed')}</button>
      </header>
      <div className="adv-tiles">
        <div className="adv-tile is-violet"><em aria-hidden="true">🙋</em><small>{tr('Asked, to decide')}</small><b>{money(s.asked.amount, 'GHS')}</b><span>{s.asked.n === 1 ? tr('1 advance') : tr('{n} advances', { n: s.asked.n })}</span></div>
        <div className="adv-tile is-calm"><em aria-hidden="true">💸</em><small>{tr('Approved, to pay out')}</small><b>{money(s.toPay.amount, 'GHS')}</b><span>{s.toPay.n === 1 ? tr('1 advance') : tr('{n} advances', { n: s.toPay.n })}</span></div>
        <div className="adv-tile is-warn"><em aria-hidden="true">🔁</em><small>{tr('Still to be repaid')}</small><b>{money(s.outstanding.amount, 'GHS')}</b><span>{s.outstanding.n === 1 ? tr('1 advance') : tr('{n} advances', { n: s.outstanding.n })}</span></div>
        <div className="adv-tile is-good"><em aria-hidden="true">✅</em><small>{tr('Repaid this month')}</small><b>{money(s.repaidThisMonth, 'GHS')}</b><span>{tr('from payslips and cash')}</span></div>
      </div>
      <div className="adv-tabs" role="tablist">
        {[['waiting', tr('Waiting')], ['repaying', tr('Being repaid')], ['done', tr('Done')], ['all', tr('All')]].map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={status === k} className={status === k ? 'is-on' : ''} onClick={() => setStatus(k)}>{l}</button>)}
      </div>
      {!d.advances.length ? <div className="adv-empty"><span aria-hidden="true">🌤️</span><p>{status === 'waiting' ? tr('Nobody is waiting for an advance.') : tr('Nothing here.')}</p></div> : (
        <div className="adv-list">
          {d.advances.map((a) => (
            <button key={a.id} type="button" className={'adv-row is-' + a.status} onClick={() => open(a.id)}>
              <span className="adv-avatar" style={{ '--h': hue(a.employee.name) }} aria-hidden="true">{a.employee.name.charAt(0)}</span>
              <span className="adv-who"><b>{a.employee.name}</b><small>{a.ref} · {dayText(a.createdAt)} · “{a.reason}”</small>{a.status === 'paid' && <Progress a={a} />}</span>
              <span className={'adv-pill is-' + a.status}>{ADV_STATUS[a.status][0]} {tr(ADV_STATUS[a.status][1])}</span>
              <span className="adv-money"><b>{money(a.amount, 'GHS')}</b><small>{tr('{amount} a month', { amount: money(a.instalment, 'GHS') })} × {a.months}</small></span>
            </button>
          ))}
        </div>
      )}
      {openId && <Sheet key={openId} id={openId} onClose={() => open(null)} onChanged={load} />}
      {rules && <Rules settings={d.settings} onClose={() => setRules(false)} onSaved={() => { setRules(false); load(); }} />}
    </div>
  );
}

// My space: ask for an advance and follow your own.
export function AdvanceCard() {
  const [d, setD] = useState(null);
  const [asking, setAsking] = useState(false);
  const [f, setF] = useState({ amount: '', months: '1', reason: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const load = useCallback(() => api.get('/advances/mine').then(setD).catch(() => setD(null)), []);
  useEffect(() => { load(); }, [load]);
  if (!d) return null;
  const al = d.allowance;
  const waiting = d.advances.find((a) => a.status === 'requested' || a.status === 'approved');
  async function ask(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await api.post('/advances', { amount: Number(f.amount), months: Number(f.months), reason: f.reason }); setAsking(false); setF({ amount: '', months: '1', reason: '' }); load(); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function cancel(id) {
    try { await api.post('/advances/' + id + '/cancel', {}); load(); } catch (err) { setError(err.message); }
  }
  return (
    <div className="msx-card adv-mine">
      <h4 className="msp-h4">💵 {tr('Salary advance')}</h4>
      {!asking && (
        <div className="adv-mine-top">
          <span><small>{al.settings.open ? tr('You can ask for up to') : tr('Advances are closed for now')}</small><b>{al.settings.open ? money(al.max, 'GHS') : '—'}</b>{al.owing > 0 && <i>{tr('{amount} still to repay', { amount: money(al.owing, 'GHS') })}</i>}</span>
          {al.settings.open && !waiting && al.max > 0 && <button type="button" className="btn btn-primary" onClick={() => setAsking(true)}>{tr('Ask for an advance')}</button>}
        </div>
      )}
      {asking && (
        <form className="adv-form" onSubmit={ask}>
          <div className="adv-grid">
            <label><span>{tr('How much?')}</span><input className="input" type="number" min="1" max={al.max} step="1" required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} autoFocus /><small>{tr('Up to {amount}', { amount: money(al.max, 'GHS') })}</small></label>
            <label><span>{tr('Repaid over')}</span><select className="input" value={f.months} onChange={(e) => setF({ ...f, months: e.target.value })}>{Array.from({ length: al.settings.maxMonths }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n === 1 ? tr('1 month') : tr('{n} months', { n })}</option>)}</select>
              {f.amount > 0 && <small>{tr('{amount} off each payslip', { amount: money(Math.ceil(Number(f.amount) / Number(f.months) * 100) / 100, 'GHS') })}</small>}</label>
          </div>
          <label><span>{tr('What is it for?')}</span><input className="input" required value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder={tr('e.g. School fees')} /></label>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setAsking(false)}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Ask')}</button></div>
        </form>
      )}
      {d.advances.length > 0 && (
        <ul className="adv-mine-list">
          {d.advances.slice(0, 4).map((a) => (
            <li key={a.id}>
              <span className={'adv-pill is-' + a.status}>{ADV_STATUS[a.status][0]} {tr(ADV_STATUS[a.status][1])}</span>
              <span className="adv-mine-main"><b>{money(a.amount, 'GHS')}</b><small>{a.ref} · {dayText(a.createdAt)}{a.status === 'paid' ? ' · ' + tr('{amount} left', { amount: money(a.left, 'GHS') }) : ''}{a.status === 'declined' && a.declineReason ? ' · ' + a.declineReason : ''}</small></span>
              {a.status === 'requested' && <button type="button" className="adv-link" onClick={() => cancel(a.id)}>{tr('Cancel')}</button>}
            </li>
          ))}
        </ul>
      )}
      {!asking && error && <div className="error-banner" role="alert">{error}</div>}
    </div>
  );
}
