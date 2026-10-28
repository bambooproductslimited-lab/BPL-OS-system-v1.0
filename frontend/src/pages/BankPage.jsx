import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { money } from '../lib/currency';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './seventeenth.css';

// Bank reconciliation (Finance → Bank reconciliation; backend
// bank.service.js, migration 0198): each company's bank and Mobile Money
// accounts; the bank's statement imported from its CSV; each line matched to
// the money recorded in the OS — by itself when there is one obvious match —
// or explained (bank charges, a transfer between our accounts); reconciled
// up to a day once nothing before it is left open.

function dayText(d, opts) { return d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC', ...opts }) : '—'; }
function monthText(m) { return new Date(m + '-15T12:00:00Z').toLocaleDateString(activeIntlLocale(), { month: 'short', year: 'numeric', timeZone: 'UTC' }); }
function today() { return new Date().toISOString().slice(0, 10); }
const KIND = { bank: ['🏦', msg('Bank')], mobile_money: ['📱', msg('Mobile Money')], cash: ['💵', msg('Cash')] };
const MATCH = { payment: ['🧾', msg('Customer payment')], bill_payment: ['📑', msg('Bill paid')], advance: ['💵', msg('Salary advance')], pay_run: ['👥', msg('Pay run')], deposit: ['🏧', msg('Takings banked')] };
const CATEGORY = {
  bank_charges: ['🏦', msg('Bank charges')], interest: ['📈', msg('Interest')], transfer: ['🔁', msg('Between our accounts')], owner: ['👤', msg('Owner\'s money')], loan: ['🤝', msg('Loan')],
  tax: ['🏛️', msg('Tax')], sales: ['🛒', msg('Sales not invoiced')], refund: ['↩️', msg('Refund')], other: ['📝', msg('Something else')]
};
const FIELDS = [['date', msg('Date')], ['description', msg('Description')], ['reference', msg('Reference')], ['amount', msg('Amount (+ in, − out)')], ['debit', msg('Money out')], ['credit', msg('Money in')], ['balance', msg('Balance')]];

function AccountForm({ meta, account, onClose, onSaved }) {
  const [f, setF] = useState(account ? { id: account.id, companyId: account.companyId, name: account.name, kind: account.kind, bankName: account.bankName, last4: account.last4 } : { companyId: (meta.companies[0] || {}).id, name: '', kind: 'bank', bankName: '', last4: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onSaved(await api.post('/bank/accounts', f)); } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog x7-dlg" role="dialog" aria-modal="true" aria-labelledby="bk-acc-t" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">🏦</span><div><h2 id="bk-acc-t">{account ? tr('Change the account') : tr('Add an account')}</h2><p>{tr('A bank account, a Mobile Money wallet or a cash box.')}</p></div></div>
        <div className="x7-chips" role="group" aria-label={tr('Company')}>{meta.companies.map((c) => <button key={c.id} type="button" className={f.companyId === c.id ? 'is-on' : ''} onClick={() => setF({ ...f, companyId: c.id })}>{c.name}</button>)}</div>
        <div className="x7-chips" role="group" aria-label={tr('Kind')}>{Object.entries(KIND).map(([k, [ic, l]]) => <button key={k} type="button" className={f.kind === k ? 'is-on' : ''} onClick={() => setF({ ...f, kind: k })}><em aria-hidden="true">{ic}</em>{tr(l)}</button>)}</div>
        <div className="x7-grid3">
          <label><span>{tr('Name')}</span><input className="input" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={tr('e.g. Ecobank current')} /></label>
          <label><span>{tr('Bank or network')}</span><input className="input" value={f.bankName} onChange={(e) => setF({ ...f, bankName: e.target.value })} /></label>
          <label><span>{tr('Last 4 digits')}</span><input className="input" inputMode="numeric" maxLength={4} value={f.last4} onChange={(e) => setF({ ...f, last4: e.target.value })} /></label>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Save')}</button></div>
      </form>
    </div>
  );
}

// Reading a statement: the columns found by their names, changed by hand if
// need be, the first lines as they will be read.
function ImportDialog({ account, onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [csv, setCsv] = useState('');
  const [pv, setPv] = useState(null);
  const [map, setMap] = useState({});
  const [flip, setFlip] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function pick(e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    setError(null); setPv(null);
    try {
      const text = await f.text();
      setFile(f.name); setCsv(text);
      const p = await api.post('/bank/accounts/' + account.id + '/preview', { csv: text });
      setPv(p); setMap(p.mapping || {});
      if (!p.found) setError(tr('The columns were not found by their names: choose them below.'));
    } catch (err) { setError(err.message); }
  }
  async function go() {
    setBusy(true); setError(null);
    try { onDone(await api.post('/bank/accounts/' + account.id + '/import', { csv, filename: file, mapping: map, flip })); }
    catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-dlg" style={{ width: 'min(760px, calc(100vw - 24px))' }} role="dialog" aria-modal="true" aria-labelledby="bk-imp-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">📥</span><div><h2 id="bk-imp-t">{tr('Import a statement')}</h2><p>{tr('Download the statement from the bank or Mobile Money as a CSV file. A line already imported is not added twice.')}</p></div></div>
        <label className={'x7-drop' + (pv ? ' is-set' : '')}>
          <input type="file" accept=".csv,text/csv,text/plain" onChange={pick} />
          <em aria-hidden="true">{pv ? '✅' : '📄'}</em><span>{file ? file : tr('Choose the CSV file')}</span>
        </label>
        {pv && (
          <>
            <div className="bk-map">
              {FIELDS.map(([k, l]) => (
                <label key={k}><span>{tr(l)}</span>
                  <select className="input" value={map[k] == null ? '' : String(map[k])} onChange={(e) => setMap({ ...map, [k]: e.target.value === '' ? null : Number(e.target.value) })}>
                    <option value="">—</option>
                    {pv.header.map((h, i) => <option key={i} value={i}>{h || tr('Column {n}', { n: i + 1 })}</option>)}
                  </select>
                </label>
              ))}
            </div>
            <label className="x7-check"><input type="checkbox" checked={flip} onChange={(e) => setFlip(e.target.checked)} /><span>{tr('Money in shows as minus')}<small>{tr('Turn the signs around: some statements count from the bank\'s side.')}</small></span></label>
            {pv.lines.length > 0 && (
              <div className="bk-sample">
                <table>
                  <thead><tr><th>{tr('Date')}</th><th>{tr('Description')}</th><th>{tr('Reference')}</th><th className="num">{tr('Amount')}</th><th className="num">{tr('Balance')}</th></tr></thead>
                  <tbody>{pv.lines.map((l, i) => <tr key={i}><td>{dayText(l.day, { year: 'numeric' })}</td><td>{l.description}</td><td>{l.reference}</td><td className="num">{money((flip ? -1 : 1) * l.amount, 'GHS')}</td><td className="num">{l.balance == null ? '' : money(l.balance, 'GHS')}</td></tr>)}</tbody>
                </table>
              </div>
            )}
            <p className="x7-muted">{tr('{n} lines read', { n: pv.count })}{pv.skipped ? ' · ' + tr('{n} rows without a date or amount left out', { n: pv.skipped }) : ''}</p>
          </>
        )}
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="button" className="btn btn-primary" disabled={busy || !pv} onClick={go}>{tr('Import')}</button></div>
      </div>
    </div>
  );
}

function LineSheet({ line, onClose, onChanged }) {
  const [l, setL] = useState(line);
  const [cands, setCands] = useState(null);
  const [mode, setMode] = useState('');
  const [cat, setCat] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { if (l.status === 'open') api.get('/bank/lines/' + l.id + '/candidates').then((d) => setCands(d.candidates)).catch((e) => setError(e.message)); }, [l.id, l.status]);
  async function act(path, body) {
    setBusy(true); setError(null);
    try { const x = await api.post('/bank/lines/' + l.id + '/' + path, body); setL(x); setMode(''); onChanged(x); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  const inn = l.amount > 0;
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-sheet" role="dialog" aria-modal="true" aria-labelledby="bk-line-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-hero" style={l.status === 'open' ? { '--g1': '#b45309', '--g2': '#c2410c' } : l.status === 'matched' ? { '--g1': '#15803d', '--g2': '#0f766e' } : { '--g1': '#475569', '--g2': '#6d28d9' }}>
          <span className="x7-icon" aria-hidden="true">{inn ? '⬆️' : '⬇️'}</span>
          <div>
            <small>{dayText(l.day, { weekday: 'short', year: 'numeric' })}{l.reference ? ' · ' + l.reference : ''}</small>
            <h2 id="bk-line-t">{l.description || tr('No description')}</h2>
            <p><b>{inn ? '+' : '−'}{money(Math.abs(l.amount), 'GHS')}</b><span className="x7-pill">{l.status === 'open' ? '⏳ ' + tr('To match') : l.status === 'matched' ? '✅ ' + tr('Matched') : '📝 ' + tr('Explained')}</span></p>
          </div>
          <button type="button" className="x7-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        {l.match && (
          <div className="bk-matchline">
            <em aria-hidden="true">{MATCH[l.match.type][0]}</em>
            <span className="x7-who"><b>{tr(MATCH[l.match.type][1])} · {l.match.ref}</b><small>{l.match.who}{l.match.reference ? ' · ' + l.match.reference : ''} · {dayText(l.match.day)}{l.auto ? ' · ⚡ ' + tr('matched by itself') : l.by ? ' · ' + l.by : ''}</small></span>
            <span className="x7-money"><b>{money(l.match.amount, 'GHS')}</b></span>
          </div>
        )}
        {l.status === 'explained' && <p className="x7-note">{CATEGORY[l.category][0]} <b>{tr(CATEGORY[l.category][1])}</b>{l.note ? ' — ' + l.note : ''}{l.by ? ' · ' + l.by : ''}</p>}
        {l.status === 'open' && mode !== 'explain' && (
          <div className="x7-sec">
            <h3>{tr('Recorded in the OS for this amount')}</h3>
            {!cands ? <p className="x7-muted">{tr('Loading…')}</p> : !cands.length ? <p className="x7-note">🔍 {tr('Nothing recorded for {amount} within three weeks. Record it where it belongs (a payment, a bill paid) and look again, or explain it.', { amount: money(Math.abs(l.amount), 'GHS') })}</p> : (
              <div className="bk-cand">
                {cands.map((c, i) => (
                  <div key={c.type + c.id} className={'bk-matchline' + (i === 0 ? ' is-best' : '')}>
                    <em aria-hidden="true">{MATCH[c.type][0]}</em>
                    <span className="x7-who"><b>{tr(MATCH[c.type][1])} · {c.ref}</b><small>{c.who}{c.reference ? ' · ' + c.reference : ''} · {dayText(c.day)} · {c.days === 0 ? tr('same day') : Math.abs(c.days) === 1 ? tr('1 day apart') : tr('{n} days apart', { n: Math.abs(c.days) })}</small></span>
                    <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act('match', { type: c.type, id: c.id })}>{tr('Match')}</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {mode === 'explain' && (
          <form className="x7-form" onSubmit={(e) => { e.preventDefault(); act('explain', { category: cat, note }); }}>
            <h3>📝 {tr('What is it?')}</h3>
            <div className="x7-chips" role="group">{Object.entries(CATEGORY).map(([k, [ic, lb]]) => <button key={k} type="button" className={cat === k ? 'is-on' : ''} onClick={() => setCat(k)}><em aria-hidden="true">{ic}</em>{tr(lb)}</button>)}</div>
            <label><span>{tr('Note')}</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={cat === 'other' ? tr('Say what it is') : tr('Optional')} /></label>
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setMode('')}>{tr('Back')}</button><button type="submit" className="btn btn-primary" disabled={busy || !cat}>{tr('Save')}</button></div>
          </form>
        )}
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="x7-actions">
          {l.status === 'open' && mode !== 'explain' && <button type="button" className="btn btn-secondary" onClick={() => setMode('explain')}>📝 {tr('Explain it')}</button>}
          {l.status !== 'open' && !l.locked && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => act('undo', {})}>↩️ {tr('Undo')}</button>}
          {l.locked && <span className="x7-muted">🔒 {tr('In a reconciled period')}</span>}
          {l.balance != null && <span className="x7-muted is-end">{tr('Balance after: {amount}', { amount: money(l.balance, 'GHS') })}</span>}
        </div>
      </div>
    </div>
  );
}

function ReconcileDialog({ d, onClose, onDone }) {
  const [until, setUntil] = useState(d.account.lastDay || today());
  const [balance, setBalance] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function go(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onDone(await api.post('/bank/accounts/' + d.account.id + '/reconcile', { until, balance })); } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog x7-dlg" role="dialog" aria-modal="true" aria-labelledby="bk-rec-t" onClick={(e) => e.stopPropagation()} onSubmit={go}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">🔒</span><div><h2 id="bk-rec-t">{tr('Reconcile')}</h2><p>{tr('Every line up to that day is matched or explained; nothing before it can change after.')}</p></div></div>
        <div className="x7-grid2">
          <label><span>{tr('Up to')}</span><input className="input" type="date" max={today()} required value={until} onChange={(e) => setUntil(e.target.value)} /></label>
          <label><span>{tr('Balance on the statement')}</span><input className="input" type="number" step="0.01" value={balance} onChange={(e) => setBalance(e.target.value)} placeholder={tr('Optional')} /><small>{tr('Checked against the statement\'s own balance.')}</small></label>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Reconcile')}</button></div>
      </form>
    </div>
  );
}

function Account({ id, meta, onBack, onChanged }) {
  const [status, setStatus] = useState('open');
  const [month, setMonth] = useState('');
  const [q, setQ] = useState('');
  const [d, setD] = useState(null);
  const [dlg, setDlg] = useState('');
  const [line, setLine] = useState(null);
  const [flash, setFlash] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => {
    const s = new URLSearchParams({ status });
    if (month) s.set('month', month);
    if (q.trim()) s.set('q', q.trim());
    return api.get('/bank/accounts/' + id + '?' + s.toString()).then(setD).catch((e) => setError(e.message));
  }, [id, status, month, q]);
  useEffect(() => { load(); }, [load]);
  async function rematch() {
    try { const x = await api.post('/bank/accounts/' + id + '/automatch', {}); setFlash('⚡ ' + (x.done.matched === 1 ? tr('1 more line matched by itself.') : tr('{n} more lines matched by themselves.', { n: x.done.matched }))); load(); onChanged(); }
    catch (e) { setError(e.message); }
  }
  if (!d) return <p className="x7-wait">{error || tr('Loading…')}</p>;
  const a = d.account;
  return (
    <>
      <button type="button" className="x7-back" onClick={onBack}>← {tr('All accounts')}</button>
      <header className="x7-head">
        <div>
          <h1>{KIND[a.kind][0]} {a.name}</h1>
          <p>{a.company}{a.bankName ? ' · ' + a.bankName : ''}{a.last4 ? ' · ••' + a.last4 : ''}{a.reconciledUntil ? ' · 🔒 ' + tr('reconciled up to {date}', { date: dayText(a.reconciledUntil, { year: 'numeric' }) }) : ''}</p>
        </div>
        <div className="x7-head-actions">
          <button type="button" className="btn btn-secondary" onClick={() => setDlg('edit')}>✏️ {tr('Edit')}</button>
          <button type="button" className="btn btn-secondary" onClick={rematch}>⚡ {tr('Look for matches again')}</button>
          <button type="button" className="btn btn-secondary" onClick={() => setDlg('reconcile')}>🔒 {tr('Reconcile')}</button>
          <button type="button" className="btn btn-primary" onClick={() => setDlg('import')}>📥 {tr('Import a statement')}</button>
        </div>
      </header>
      <div className="x7-tiles">
        <div className="x7-tile is-warn"><small>⏳ {tr('To match')}</small><b>{a.open}</b><span>{tr('{in} in, {out} out', { in: money(a.openIn, 'GHS'), out: money(a.openOut, 'GHS') })}</span></div>
        <div className="x7-tile is-good"><small>✅ {tr('Matched')}</small><b>{d.summary.matched}</b><span>{tr('{n} by themselves', { n: d.summary.auto })}</span></div>
        <div className="x7-tile is-violet"><small>📝 {tr('Explained')}</small><b>{d.summary.explained}</b><span>{tr('charges, transfers, interest')}</span></div>
        <div className="x7-tile is-calm"><small>💰 {tr('Balance')}</small><b>{a.balance == null ? '—' : money(a.balance, 'GHS')}</b><span>{a.lastDay ? tr('on the statement, {date}', { date: dayText(a.lastDay, { year: 'numeric' }) }) : tr('no statement yet')}</span></div>
      </div>
      {flash && <div className="x7-flash" role="status">{flash}</div>}
      <div className="x7-bar">
        <div className="x7-seg" role="tablist">
          {[['open', tr('To match')], ['matched', tr('Matched')], ['explained', tr('Explained')], ['all', tr('All')]].map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={status === k} className={status === k ? 'is-on' : ''} onClick={() => setStatus(k)}>{l}{k === 'open' && a.open ? <i>{a.open}</i> : null}</button>)}
        </div>
        <input className="input x7-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Search the descriptions')} aria-label={tr('Search')} />
      </div>
      {d.months.length > 1 && (
        <div className="bk-months x7-chips">
          <button type="button" className={!month ? 'is-on' : ''} onClick={() => setMonth('')}>{tr('Every month')}</button>
          {d.months.map((m) => <button key={m.month} type="button" className={month === m.month ? 'is-on' : ''} onClick={() => setMonth(m.month)}>{monthText(m.month)}{m.open ? ' · ⏳' + m.open : ' ✓'}</button>)}
        </div>
      )}
      {!d.lines.length ? <div className="x7-empty"><span aria-hidden="true">{status === 'open' ? '🎉' : '📄'}</span><p>{status === 'open' ? tr('Nothing left to match here.') : tr('No lines yet: import a statement.')}</p></div> : (
        <div className="x7-list">
          {d.lines.map((l) => (
            <button key={l.id} type="button" className={'x7-row bk-line' + (l.status === 'open' ? ' is-flag is-warn' : '')} onClick={() => setLine(l)}>
              <span className="bk-day"><b>{dayText(l.day)}</b>{l.reference ? <small>{l.reference}</small> : null}</span>
              <span className="x7-who"><b>{l.description || '—'}</b><small>{l.match ? MATCH[l.match.type][0] + ' ' + l.match.ref + ' · ' + l.match.who + (l.auto ? ' · ⚡' : '') : l.status === 'explained' ? CATEGORY[l.category][0] + ' ' + tr(CATEGORY[l.category][1]) + (l.note ? ' · ' + l.note : '') : tr('to match')}</small></span>
              <span className={'x7-pill ' + (l.status === 'open' ? 'is-warn' : l.status === 'matched' ? 'is-good' : 'is-violet')}>{l.status === 'open' ? '⏳ ' + tr('To match') : l.status === 'matched' ? '✅ ' + tr('Matched') : '📝 ' + tr('Explained')}</span>
              <span className={'x7-money ' + (l.amount > 0 ? 'is-in' : 'is-out')}><b>{l.amount > 0 ? '+' : '−'}{money(Math.abs(l.amount), 'GHS')}</b>{l.balance != null && <small>{money(l.balance, 'GHS')}</small>}</span>
            </button>
          ))}
        </div>
      )}
      {d.imports.length > 0 && <p className="x7-muted">📥 {tr('Last import: {file}, {n} new lines, {m} matched by themselves', { file: d.imports[0].filename || '—', n: d.imports[0].added, m: d.imports[0].matched })} · {dayText(d.imports[0].at, { year: 'numeric' })}</p>}
      {line && <LineSheet key={line.id} line={line} onClose={() => setLine(null)} onChanged={() => { load(); onChanged(); }} />}
      {dlg === 'import' && <ImportDialog account={a} onClose={() => setDlg('')} onDone={(x) => { setDlg(''); setD(x); setStatus('open'); setFlash('📥 ' + tr('{n} new lines, {d} already there, {m} matched by themselves.', { n: x.done.added, d: x.done.duplicates, m: x.done.matched })); onChanged(); }} />}
      {dlg === 'reconcile' && <ReconcileDialog d={d} onClose={() => setDlg('')} onDone={(x) => { setDlg(''); setD(x); setFlash('🔒 ' + tr('Reconciled up to {date}.', { date: dayText(x.account.reconciledUntil, { year: 'numeric' }) })); onChanged(); }} />}
      {dlg === 'edit' && <AccountForm meta={meta} account={a} onClose={() => setDlg('')} onSaved={(x) => { setDlg(''); setD(x); onChanged(); }} />}
    </>
  );
}

export default function BankPage() {
  const [params, setParams] = useSearchParams();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => api.get('/bank').then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const openId = params.get('account');
  const open = (id) => setParams(id ? { account: id } : {});
  if (!d) return <div className="x7"><p className="x7-wait">{error || tr('Loading…')}</p></div>;
  if (openId) return <div className="x7"><Account key={openId} id={openId} meta={d} onBack={() => open(null)} onChanged={load} /></div>;
  const s = d.summary;
  return (
    <div className="x7">
      <header className="x7-head">
        <div>
          <h1>🏦 {tr('Bank reconciliation')}</h1>
          <p>{tr('Import each account\'s statement; every line is matched to the money recorded in the OS, or explained. What is left is what to look into.')}</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>➕ {tr('Add an account')}</button>
      </header>
      <div className="x7-tiles">
        <div className="x7-tile is-calm"><small>🏦 {tr('Accounts')}</small><b>{s.accounts}</b><span>{tr('bank, Mobile Money and cash')}</span></div>
        <div className="x7-tile is-warn"><small>⏳ {tr('Lines to match')}</small><b>{s.open}</b><span>{tr('across all accounts')}</span></div>
        <div className="x7-tile is-teal"><small>⬆️ {tr('Money in not matched')}</small><b>{money(s.openIn, 'GHS')}</b><span>{tr('payments not recorded yet?')}</span></div>
        <div className="x7-tile is-bad"><small>⬇️ {tr('Money out not matched')}</small><b>{money(s.openOut, 'GHS')}</b><span>{tr('bills or charges not recorded?')}</span></div>
      </div>
      {!d.accounts.length ? <div className="x7-empty"><span aria-hidden="true">🏦</span><p>{tr('No account yet. Add one, then import its statement.')}</p></div> : (
        <div className="bk-accounts">
          {d.accounts.map((a, i) => (
            <button key={a.id} type="button" className="x7-acc" style={{ animationDelay: Math.min(i, 8) * 0.04 + 's' }} onClick={() => open(a.id)}>
              <span className="bk-acc-top">
                <span className="x7-icon" aria-hidden="true">{KIND[a.kind][0]}</span>
                <span className="x7-who"><b>{a.name}</b><small>{a.company}{a.last4 ? ' · ••' + a.last4 : ''}</small></span>
                <span className="bk-ring" style={{ '--p': a.matchedPct ?? 0 }} role="img" aria-label={tr('{n}% matched', { n: a.matchedPct ?? 0 })}><b>{a.matchedPct == null ? '—' : a.matchedPct + '%'}</b></span>
              </span>
              <span className="bk-acc-facts">
                <span><small>{tr('Balance')}</small><b>{a.balance == null ? '—' : money(a.balance, 'GHS')}</b></span>
                <span><small>{tr('To match')}</small><b>{a.open ? '⏳ ' + a.open : '✓ 0'}</b></span>
                <span><small>{tr('Last line')}</small><b>{a.lastDay ? dayText(a.lastDay) : '—'}</b></span>
                <span><small>{tr('Reconciled up to')}</small><b>{a.reconciledUntil ? '🔒 ' + dayText(a.reconciledUntil) : '—'}</b></span>
              </span>
            </button>
          ))}
        </div>
      )}
      {adding && <AccountForm meta={d} onClose={() => setAdding(false)} onSaved={(x) => { setAdding(false); load(); open(x.account.id); }} />}
    </div>
  );
}
