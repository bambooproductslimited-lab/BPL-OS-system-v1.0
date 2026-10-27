import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, API_URL } from '../api/client';
import { money } from '../lib/currency';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './seventeenth.css';
import './eighteenth.css';

// Statutory returns (Finance → Statutory returns; backend returns.service.js,
// migration 0199): each company's PAYE, SSNIT, VAT and withholding tax by
// month — what is due, worked out from payroll, invoices and the tills; when
// it falls due; filed and paid, with the reference and the receipt. The PAYE
// and SSNIT schedules download for the portals.

function dayText(d, opts) { return d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC', ...opts }) : '—'; }
function monthText(m, long) { return new Date(m + '-15T12:00:00Z').toLocaleDateString(activeIntlLocale(), { month: long ? 'long' : 'short', year: long ? 'numeric' : '2-digit', timeZone: 'UTC' }); }
function today() { return new Date().toISOString().slice(0, 10); }
function readFile(file) { return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file); }); }
const NAME = { paye: ['🧾', msg('PAYE')], ssnit: ['🛡️', msg('SSNIT')], vat: ['🏛️', msg('VAT and levies')], wht: ['✂️', msg('Withholding tax')] };
const STATE = {
  paid: ['✓', 'is-good', msg('Paid')], done: ['✓', 'is-good', msg('Filed, nothing to pay')], filed: ['📨', 'is-calm', msg('Filed, not paid')], due: ['⏳', 'is-warn', msg('Due soon')],
  overdue: ['⛔', 'is-bad', msg('Late')], upcoming: ['·', '', msg('To come')], nothing: ['—', '', msg('Nothing due')], before: ['', '', msg('Before the OS')]
};
const SOURCE = { invoices: ['🧾', msg('Invoices')], till: ['🍽️', msg('Till sales')] };

async function download(path, name) {
  const r = await fetch(API_URL + path, { headers: api.authHeaders() });
  if (!r.ok) throw new Error(tr('That did not download.'));
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function ReturnSheet({ company, kind, period, onClose, onChanged }) {
  const [r, setR] = useState(null);
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const [error, setError] = useState(null);
  const q = '?company=' + company + '&kind=' + kind + '&period=' + period;
  const take = (x) => { setR(x); setF({ amount: x.kind === 'wht' && x.amount != null ? String(x.amount) : '', inputVat: x.inputVat != null ? String(x.inputVat) : '', filedOn: x.filedOn || '', filedRef: x.filedRef || '', paidOn: x.paidOn || '', paidAmount: x.paidAmount != null ? String(x.paidAmount) : x.amount != null ? String(x.amount) : '', paidRef: x.paidRef || '', receipt: null, receiptName: '' }); };
  useEffect(() => { api.get('/returns/one' + q).then(take).catch((e) => setError(e.message)); }, [q]);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null); setFlash(null);
    try {
      const body = { companyId: company, kind, period, filedOn: f.filedOn || null, filedRef: f.filedRef, paidOn: f.paidOn || null, paidAmount: f.paidOn ? f.paidAmount : null, paidRef: f.paidRef };
      if (kind === 'wht') body.amount = f.amount;
      if (kind === 'vat') body.inputVat = f.inputVat;
      if (f.receipt) body.receipt = f.receipt;
      take(await api.put('/returns', body)); setFlash('✅ ' + tr('Saved.')); onChanged();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function pick(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 6 * 1024 * 1024) { setError(tr('That receipt is too big (6 MB at most).')); return; }
    setF({ ...f, receipt: await readFile(file), receiptName: file.name });
  }
  async function seeReceipt() {
    const res = await fetch(API_URL + '/returns/receipt' + q, { headers: api.authHeaders() });
    if (res.ok) window.open(URL.createObjectURL(await res.blob()), '_blank', 'noopener');
  }
  if (!r || !f) return <div className="dialog-backdrop" onClick={onClose}><div className="dialog x7-sheet"><p className="x7-wait">{error || tr('Loading…')}</p></div></div>;
  const st = STATE[r.state] || STATE.upcoming;
  const late = r.state === 'overdue';
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-sheet is-wide" role="dialog" aria-modal="true" aria-labelledby="tx-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-hero" style={late ? { '--g1': '#b91c1c', '--g2': '#9d174d' } : r.state === 'paid' || r.state === 'done' ? { '--g1': '#047857', '--g2': '#0f766e' } : { '--g1': '#1e3a8a', '--g2': '#6d28d9' }}>
          <span className="x7-icon" aria-hidden="true">{NAME[kind][0]}</span>
          <div><small>{r.company.name} · {monthText(period, true)}</small><h2 id="tx-t">{tr(NAME[kind][1])}</h2>
            <p><b>{r.amount == null ? tr('Enter the amount') : r.amount < 0 ? tr('credit {amount}', { amount: money(-r.amount, 'GHS') }) : money(r.amount, 'GHS')}</b><span className="x7-pill">{st[0]} {tr(st[2])}</span><span className="x7-pill">📅 {tr('due {date}', { date: dayText(r.due, { weekday: 'short' }) })}</span></p></div>
          <button type="button" className="x7-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        {(kind === 'paye' || kind === 'ssnit') && (
          <div className="x7-sec">
            <div className="x7-bar"><h3>👥 {tr('{n} staff on the pay runs', { n: r.people.length })}</h3>
              <button type="button" className="btn btn-secondary" disabled={!r.people.length} onClick={() => download('/returns/schedule' + q, kind + '-' + period + '.csv').catch((e) => setError(e.message))}>⬇️ {tr('Download the schedule')}</button></div>
            {r.missing > 0 && <p className="x7-note">⚠️ {kind === 'ssnit' ? tr('{n} without an SSNIT number: add it in their record first.', { n: r.missing }) : tr('{n} without a TIN or Ghana Card: add it in their record first.', { n: r.missing })}</p>}
            <div className="tx-table-wrap"><table className="tx-table">
              <thead><tr><th>{tr('Name')}</th><th>{kind === 'ssnit' ? tr('SSNIT number') : tr('TIN')}</th><th className="num">{kind === 'ssnit' ? tr('Basic salary') : tr('Gross pay')}</th>{kind === 'ssnit' ? <><th className="num">5.5%</th><th className="num">13%</th></> : <th className="num">{tr('PAYE')}</th>}</tr></thead>
              <tbody>{r.people.map((p) => <tr key={p.code}><td>{p.name}</td><td>{(kind === 'ssnit' ? p.ssnitNumber : p.tin || p.ghanaCard) || <span className="x7-pill is-bad">{tr('missing')}</span>}</td><td className="num">{money(kind === 'ssnit' ? p.basic : p.gross, 'GHS')}</td>{kind === 'ssnit' ? <><td className="num">{money(p.employee, 'GHS')}</td><td className="num">{money(p.employer, 'GHS')}</td></> : <td className="num">{money(p.paye, 'GHS')}</td>}</tr>)}</tbody>
              <tfoot><tr><td colSpan={3}>{tr('Total')}</td>{kind === 'ssnit' ? <><td className="num">{money(r.totals.employee, 'GHS')}</td><td className="num">{money(r.totals.employer, 'GHS')}</td></> : <td className="num">{money(r.totals.paye, 'GHS')}</td>}</tr></tfoot>
            </table></div>
            {r.tiers && <dl className="x7-facts"><div><dt>{tr('Tier 1 — to SSNIT (13.5%)')}</dt><dd>{money(r.tiers.tier1, 'GHS')}</dd></div><div><dt>{tr('Tier 2 — to the trustee (5%)')}</dt><dd>{money(r.tiers.tier2, 'GHS')}</dd></div></dl>}
          </div>
        )}
        {kind === 'vat' && (
          <div className="x7-sec">
            <h3>🏛️ {tr('VAT, NHIL and GETFund charged')}</h3>
            <div className="x7-list">{r.sources.map((s) => (
              <div key={s.key} className="x7-row" style={{ cursor: 'default' }}><span className="x7-icon" aria-hidden="true">{SOURCE[s.key][0]}</span><span className="x7-who"><b>{tr(SOURCE[s.key][1])}</b><small>{tr('{n} sales', { n: s.count })} · {tr('before tax {amount}', { amount: money(s.net, 'GHS') })}</small></span><span /><span className="x7-money"><b>{money(s.tax, 'GHS')}</b></span></div>
            ))}</div>
            {!r.sources.length && <p className="x7-note">{tr('No sales this month: file a nil return.')}</p>}
            <dl className="x7-facts"><div><dt>{tr('Charged on sales')}</dt><dd>{money(r.output, 'GHS')}</dd></div><div><dt>{tr('Paid on purchases (input VAT)')}</dt><dd>{money(r.inputVat || 0, 'GHS')}</dd></div><div><dt>{r.amount < 0 ? tr('To carry forward') : tr('To pay')}</dt><dd>{money(Math.abs(r.amount), 'GHS')}</dd></div></dl>
          </div>
        )}
        {kind === 'wht' && <p className="x7-note">✂️ {tr('Withholding tax kept back from suppliers\' payments: enter what was withheld this month.')}</p>}
        <form className="x7-form" onSubmit={save}>
          <h3>📨 {tr('Filed and paid')}</h3>
          {kind === 'wht' && <label><span>{tr('Withholding tax for the month')}</span><input className="input" type="number" min="0" step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label>}
          {kind === 'vat' && <label><span>{tr('Input VAT on purchases (from the suppliers\' VAT invoices)')}</span><input className="input" type="number" min="0" step="0.01" value={f.inputVat} onChange={(e) => setF({ ...f, inputVat: e.target.value })} /></label>}
          <div className="x7-grid2">
            <label><span>{tr('Filed on')}</span><input className="input" type="date" max={today()} value={f.filedOn} onChange={(e) => setF({ ...f, filedOn: e.target.value })} /></label>
            <label><span>{kind === 'ssnit' ? tr('SSNIT reference') : tr('GRA reference')}</span><input className="input" value={f.filedRef} onChange={(e) => setF({ ...f, filedRef: e.target.value })} /></label>
            <label><span>{tr('Paid on')}</span><input className="input" type="date" max={today()} value={f.paidOn} onChange={(e) => setF({ ...f, paidOn: e.target.value })} /></label>
            <label><span>{tr('Amount paid')}</span><input className="input" type="number" min="0" step="0.01" value={f.paidAmount} onChange={(e) => setF({ ...f, paidAmount: e.target.value })} /></label>
            <label><span>{tr('Payment reference')}</span><input className="input" value={f.paidRef} onChange={(e) => setF({ ...f, paidRef: e.target.value })} /></label>
            <label className={'x7-drop' + (f.receipt || r.receipt ? ' is-set' : '')} style={{ alignSelf: 'end' }}><input type="file" accept="image/*,application/pdf" onChange={pick} /><em aria-hidden="true">{f.receipt || r.receipt ? '✅' : '🧾'}</em><span>{f.receiptName || (r.receipt ? tr('Receipt kept — tap to change') : tr('The receipt (photo or PDF)'))}</span></label>
          </div>
          {r.receipt && <button type="button" className="x7-link" style={{ alignSelf: 'flex-start' }} onClick={seeReceipt}>🧾 {tr('See the receipt')}</button>}
          {flash && <div className="x7-flash" role="status">{flash}</div>}
          {error && <div className="error-banner" role="alert">{error}</div>}
          <div className="dialog-actions"><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Save')}</button></div>
        </form>
      </div>
    </div>
  );
}

function SettleDialog({ d, onClose, onDone }) {
  const [before, setBefore] = useState(d.months[d.months.length - 2]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function go() {
    setBusy(true); setError(null);
    try { onDone(await api.post('/returns/settle', { companyId: d.company, before })); } catch (e) { setError(e.message); setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-dlg" role="dialog" aria-modal="true" aria-labelledby="tx-s-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">🗂️</span><div><h2 id="tx-s-t">{tr('Filed before the OS')}</h2><p>{tr('Returns for months before this one were filed and paid outside the OS: they stop showing as late.')}</p></div></div>
        <label><span>{tr('Every month before')}</span><select className="input" value={before} onChange={(e) => setBefore(e.target.value)}>{d.months.map((m) => <option key={m} value={m}>{monthText(m, true)}</option>)}</select></label>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="button" className="btn btn-primary" disabled={busy} onClick={go}>{tr('Mark them')}</button></div>
      </div>
    </div>
  );
}

export default function ReturnsPage() {
  const [params, setParams] = useSearchParams();
  const [company, setCompany] = useState('');
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [settling, setSettling] = useState(false);
  const [flash, setFlash] = useState(null);
  const load = useCallback(() => api.get('/returns' + (company ? '?company=' + company : '')).then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message)), [company]);
  useEffect(() => { load(); }, [load]);
  const kind = params.get('kind'), period = params.get('period');
  const open = (k, p) => setParams(k ? { kind: k, period: p } : {});
  if (!d) return <div className="x7"><p className="x7-wait">{error || tr('Loading…')}</p></div>;
  const t = d.tiles;
  return (
    <div className="x7">
      <header className="x7-head">
        <div>
          <h1>🏛️ {tr('Statutory returns')}</h1>
          <p>{tr('PAYE, SSNIT, VAT and withholding tax for each company and month: what is due, worked out from payroll, invoices and the tills; when; filed and paid, with the reference and the receipt.')}</p>
        </div>
        <div className="x7-head-actions"><button type="button" className="btn btn-secondary" onClick={() => setSettling(true)}>🗂️ {tr('Filed before the OS')}</button></div>
      </header>
      <div className="x7-chips">{d.companies.map((c) => <button key={c.id} type="button" className={d.company === c.id ? 'is-on' : ''} onClick={() => setCompany(c.id)}>{c.name}</button>)}</div>
      {flash && <div className="x7-flash" role="status">{flash}</div>}
      <div className="x7-tiles">
        <div className={'x7-tile ' + (t.overdue ? 'is-bad' : 'is-good')}><small>⛔ {tr('Late')}</small><b>{t.overdue}</b><span>{!t.overdue ? tr('nothing late') : t.overdueAmount > 0 ? money(t.overdueAmount, 'GHS') : tr('amounts to enter')}</span></div>
        <div className="x7-tile is-warn"><small>⏳ {tr('Due in the next 30 days')}</small><b>{t.dueSoon}</b><span>{money(t.dueSoonAmount, 'GHS')}</span></div>
        <div className="x7-tile is-calm"><small>📅 {tr('Next')}</small><b>{t.next ? tr(NAME[t.next.kind][1]) : '—'}</b><span>{t.next ? tr('{month}, due {date}', { month: monthText(t.next.period, true), date: dayText(t.next.due) }) : ''}</span></div>
        <div className="x7-tile is-good"><small>✓ {tr('Paid this year')}</small><b>{money(t.paidYear, 'GHS')}</b><span>{tr('{n} returns', { n: t.paidYearCount })}</span></div>
      </div>
      <section className="x7-card">
        <h2>🗓️ {tr('The year')} <small>{tr('tap a month to file it')}</small></h2>
        <div className="tx-grid-wrap" ref={(el) => { if (el && !el.dataset.end) { el.dataset.end = '1'; el.scrollLeft = el.scrollWidth; } }}>
          <table className="tx-grid">
            <thead><tr><th />{d.months.map((m) => <th key={m} className={m === d.today.slice(0, 7) ? 'is-now' : ''}>{monthText(m)}</th>)}</tr></thead>
            <tbody>{d.kinds.map((k) => (
              <tr key={k}>
                <th scope="row"><em aria-hidden="true">{NAME[k][0]}</em> {tr(NAME[k][1])}</th>
                {d.cells[k].map((c) => {
                  const st = STATE[c.state] || STATE.upcoming;
                  return (
                    <td key={c.period}>
                      {c.state === 'before' ? <span className="tx-cell is-before" aria-label={tr(st[2])} /> : (
                        <button type="button" className={'tx-cell is-' + c.state} onClick={() => open(k, c.period)} title={tr(NAME[k][1]) + ', ' + monthText(c.period, true) + ': ' + tr(st[2]) + (c.amount != null ? ' · ' + money(c.amount, 'GHS') : '') + ' · ' + tr('due {date}', { date: dayText(c.due) })}>
                          <i aria-hidden="true">{st[0]}</i><small>{c.amount == null ? '?' : c.state === 'upcoming' && !c.amount ? '' : c.amount < 0 ? '↩' : c.amount >= 1000 ? Math.round(c.amount / 100) / 10 + 'k' : Math.round(c.amount)}</small>
                        </button>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}</tbody>
          </table>
        </div>
        <div className="bg-legend">{['paid', 'filed', 'due', 'overdue', 'upcoming', 'nothing'].map((k) => <span key={k}><i className={'tx-key is-' + k} aria-hidden="true">{STATE[k][0]}</i>{tr(STATE[k][2])}</span>)}</div>
      </section>
      <section className="x7-card">
        <h2>📌 {tr('Coming up')}</h2>
        {!d.upcoming.length ? <p className="x7-muted">{tr('Nothing to file just now.')}</p> : (
          <div className="x7-list">{d.upcoming.map((c) => {
            const st = STATE[c.state] || STATE.upcoming;
            return (
              <button key={c.kind + c.period} type="button" className={'x7-row' + (c.state === 'overdue' ? ' is-flag is-bad' : c.state === 'due' ? ' is-flag is-warn' : '')} onClick={() => open(c.kind, c.period)}>
                <span className="x7-icon" aria-hidden="true">{NAME[c.kind][0]}</span>
                <span className="x7-who"><b>{tr(NAME[c.kind][1])} · {monthText(c.period, true)}</b><small>{tr('due {date}', { date: dayText(c.due, { weekday: 'short' }) })}</small></span>
                <span className={'x7-pill ' + st[1]}>{st[0]} {tr(st[2])}</span>
                <span className="x7-money"><b>{c.amount == null ? '—' : c.amount < 0 ? tr('credit {amount}', { amount: money(-c.amount, 'GHS') }) : money(c.amount, 'GHS')}</b></span>
              </button>
            );
          })}</div>
        )}
      </section>
      {settling && <SettleDialog d={d} onClose={() => setSettling(false)} onDone={(x) => { setSettling(false); setD(x); setFlash('✅ ' + tr('{n} returns marked as filed outside the OS.', { n: x.settled })); }} />}
      {kind && period && <ReturnSheet key={kind + period + d.company} company={d.company} kind={kind} period={period} onClose={() => open(null)} onChanged={load} />}
    </div>
  );
}
