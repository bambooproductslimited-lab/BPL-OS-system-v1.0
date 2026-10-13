import { useState } from 'react';
import { api } from '../../api/client';
import Photo from '../../components/Photo';
import { Icon, fmtDate } from '../../components/DashKit';
import { money } from '../../lib/currency';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';

// The expense sheets' shared pieces (ExpenseSheetsPage.jsx, EsSheet.jsx,
// EsOverview.jsx): the balance gauge, the month bars, the category-by-month
// table that was the workbook's pivot, ranked bars, the line form and the
// dialogs. Styles in ExpenseSheets.css (.es-*).

export const GHS = (v) => money(v, 'GHS');
// Whole cedis, for small spaces.
export const GHS0 = (v) => 'GHS ' + Math.round(Number(v) || 0).toLocaleString(activeIntlLocale());
// A day and short month, with the year only when it is not this year.
export const nLines = (n) => (n === 1 ? tr('1 line') : tr('{n} lines', { n }));
export function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00');
  return d.toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}
export function monthName(m, style = 'short') { return new Date(2026, m, 1).toLocaleDateString(activeIntlLocale(), { month: style }); }
export function todayIso() { return new Date().toISOString().slice(0, 10); }
export function daysSince(iso) { return iso ? Math.round((Date.parse(todayIso()) - Date.parse(iso)) / 86400000) : null; }

// The balance against the usual float: a ring; below zero, the company owes.
export function BalanceGauge({ balance, floatLimit, size = 168 }) {
  const r = size / 2 - 10, c = 2 * Math.PI * r;
  const owed = balance < 0;
  const part = floatLimit ? Math.max(0, Math.min(1, Math.abs(balance) / floatLimit)) : owed ? 1 : balance > 0 ? 1 : 0;
  return (
    <span className={'es-gauge' + (owed ? ' is-owed' : '')} style={{ width: size, height: size }} role="img"
      aria-label={owed ? tr('Owed to the officer: {amount}', { amount: GHS(-balance) }) : tr('Cash in hand: {amount}', { amount: GHS(balance) })}>
      <svg viewBox={'0 0 ' + size + ' ' + size} width={size} height={size} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} className="es-gauge-track" />
        <circle cx={size / 2} cy={size / 2} r={r} className="es-gauge-fill" strokeDasharray={c} strokeDashoffset={c * (1 - part)} transform={'rotate(-90 ' + size / 2 + ' ' + size / 2 + ')'} />
      </svg>
      <span className="es-gauge-mid">
        <small>{owed ? tr('owed to the officer') : tr('cash in hand')}</small>
        <strong>{GHS(Math.abs(balance))}</strong>
        {floatLimit ? <em>{tr('of a {amount} float', { amount: GHS(floatLimit) })}</em> : null}
      </span>
    </span>
  );
}

// Twelve months: money spent and money received, side by side.
export function MonthBars({ spent, funded, year, onMonth, active }) {
  const max = Math.max(1, ...spent, ...funded);
  const nowM = new Date().getFullYear() === year ? new Date().getMonth() : 11;
  return (
    <div className="es-months">
      <div className="es-month-bars" role="img" aria-label={spent.map((s, i) => monthName(i) + ': ' + tr('{a} spent, {b} received', { a: GHS(s), b: GHS(funded[i]) })).join('; ')}>
        {spent.map((s, i) => (
          <button key={i} type="button" disabled={!onMonth} onClick={() => onMonth && onMonth(active === i ? null : i)}
            className={'es-mbar' + (i > nowM ? ' is-future' : '') + (active === i ? ' is-on' : '') + (i === nowM ? ' is-now' : '')}
            title={monthName(i, 'long') + ': ' + tr('{a} spent, {b} received', { a: GHS(s), b: GHS(funded[i]) })}>
            <span className="es-mbar-pair">
              <i className="is-spent" style={{ height: (s / max) * 100 + '%' }} />
              <i className="is-recv" style={{ height: (funded[i] / max) * 100 + '%' }} />
            </span>
            <small>{monthName(i).slice(0, 3)}</small>
          </button>
        ))}
      </div>
      <div className="es-legend"><span><i className="is-spent" />{tr('Spent')} · {GHS(spent.reduce((a, b) => a + b, 0))}</span><span><i className="is-recv" />{tr('Received')} · {GHS(funded.reduce((a, b) => a + b, 0))}</span></div>
    </div>
  );
}

// Category by month: what the workbook's report pivot showed.
export function PivotTable({ categories, monthSpent, year }) {
  const last = new Date().getFullYear() === year ? new Date().getMonth() : 11;
  const months = Array.from({ length: last + 1 }, (_, i) => i);
  const max = Math.max(1, ...categories.flatMap((c) => months.map((m) => c.months[m])));
  if (!categories.length) return <p className="es-muted">{tr('Nothing spent this year yet.')}</p>;
  return (
    <div className="es-pivot-wrap">
      <table className="es-pivot">
        <thead><tr><th>{tr('Category')}</th>{months.map((m) => <th key={m}>{monthName(m)}</th>)}<th>{tr('Total')}</th></tr></thead>
        <tbody>
          {categories.map((c) => (
            <tr key={c.name}>
              <th>{c.name}</th>
              {months.map((m) => <td key={m} style={{ '--h': c.months[m] / max }} className={c.months[m] ? 'is-some' : ''}>{c.months[m] ? Math.round(c.months[m]).toLocaleString(activeIntlLocale()) : ''}</td>)}
              <td className="es-pivot-total">{GHS(c.total)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr><th>{tr('Total')}</th>{months.map((m) => <td key={m}>{Math.round(monthSpent[m]).toLocaleString(activeIntlLocale())}</td>)}<td className="es-pivot-total">{GHS(monthSpent.reduce((a, b) => a + b, 0))}</td></tr></tfoot>
      </table>
    </div>
  );
}

export function RankBars({ rows, empty }) {
  if (!rows.length) return <p className="es-muted">{empty}</p>;
  const max = Math.max(1, ...rows.map((r) => r.total));
  return (
    <ol className="es-rank">
      {rows.map((r) => (
        <li key={r.name}>
          <span className="es-rank-name">{r.name}</span>
          <span className="es-rank-bar"><i style={{ width: Math.round((r.total / max) * 100) + '%' }} /></span>
          <b>{GHS(r.total)}</b>
        </li>
      ))}
    </ol>
  );
}

export function Who({ person, size = 40 }) {
  return <Photo id={person.id} name={person.name} photo={person.photo} size={size} />;
}

// ── a line: add or change ─────────────────────────────────────────────
// `start`: no sheet yet — the expense opens one (POST /expense-sheets/start),
// and `sheet` only carries the lists.
export function LineForm({ sheet, line, kind: kindIn, onSaved, onCancel, compact, start }) {
  const [kind, setKind] = useState(line ? line.kind : kindIn || 'expense');
  const [f, setF] = useState(() => ({
    date: line ? line.date : todayIso(), amount: line ? String(line.amount) : '', qty: line ? String(line.qty) : '1',
    note: line ? line.note : '', payee: line ? line.payee : '', category: line ? line.category : '', costCentre: line ? line.costCentre : '', asset: line ? line.asset : ''
  }));
  const [receipt, setReceipt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const amount = Number(f.amount), qty = Number(f.qty) || 1;
  const unit = amount && qty ? Math.round((amount / qty) * 100) / 100 : null;
  const cats = sheet.lists.categories.filter((c) => c.active || c.name === f.category);
  const centres = sheet.lists.costCentres.filter((c) => c.active || c.name === f.costCentre);
  const used = {};
  sheet.lines.forEach((l) => { if (l.kind === 'expense' && l.category) used[l.category] = (used[l.category] || 0) + 1; });
  const quick = Object.keys(used).sort((a, b) => used[b] - used[a]).slice(0, 5);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const body = { ...f, kind, amount: Number(f.amount), qty: Number(f.qty) || 1 };
      const saved = line ? await api.patch('/expense-sheets/lines/' + line.id, body) : start ? await api.post('/expense-sheets/start', body) : await api.post('/expense-sheets/' + sheet.id + '/lines', body);
      if (receipt) { const fd = new FormData(); fd.append('file', receipt); await api.upload('/expense-sheets/lines/' + (start ? saved.newLineId : saved.id) + '/receipt', fd); }
      if (!line) setF((x) => ({ ...x, amount: '', qty: '1', note: '', payee: kind === 'funding' ? x.payee : '' }));
      setReceipt(null);
      onSaved(saved);
    } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  }
  return (
    <form className={'es-form' + (compact ? ' is-compact' : '')} onSubmit={save}>
      {!line && !start && (
        <div className="es-kind" role="tablist" aria-label={tr('What is it?')}>
          <button type="button" role="tab" aria-selected={kind === 'expense'} className={kind === 'expense' ? 'is-on' : ''} onClick={() => setKind('expense')}><Icon name="receipt" /> {tr('Money spent')}</button>
          <button type="button" role="tab" aria-selected={kind === 'funding'} className={kind === 'funding' ? 'is-on is-recv' : ''} onClick={() => setKind('funding')}><Icon name="cash" /> {tr('Money received')}</button>
        </div>
      )}
      {err && <div className="error-banner" role="alert">{err}</div>}
      <div className="es-form-grid">
        <label className="es-field"><span>{tr('Date')}</span><input className="input" type="date" required max={todayIso()} value={f.date} onChange={set('date')} /></label>
        <label className="es-field"><span>{tr('Amount (GHS)')}</span><input className="input" type="number" step="0.01" required value={f.amount} onChange={set('amount')} placeholder="0.00" /></label>
        {kind === 'expense' && <label className="es-field is-narrow"><span>{tr('Qty')}</span><input className="input" type="number" step="any" min="0.001" value={f.qty} onChange={set('qty')} /></label>}
        {kind === 'expense' && <div className="es-field is-narrow es-unit"><span>{tr('Each')}</span><b>{unit !== null ? GHS(unit) : '—'}</b></div>}
        {kind === 'expense' && (
          <label className="es-field"><span>{tr('Category')}</span>
            <select className="input" required value={f.category} onChange={set('category')}>
              <option value="">{tr('Choose…')}</option>
              {cats.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
          </label>
        )}
        <label className="es-field"><span>{kind === 'funding' ? (Number(f.amount) < 0 ? tr('To (who got it)') : tr('From (who gave it)')) : tr('Paid to')}</span><input className="input" list={'es-payees-' + sheet.id} value={f.payee} onChange={set('payee')} maxLength={120} /></label>
        {kind === 'expense' && (
          <label className="es-field"><span>{tr('Cost centre')}</span>
            <select className="input" value={f.costCentre} onChange={set('costCentre')}>
              <option value="">{tr('—')}</option>
              {centres.map((c) => <option key={c.name} value={c.name}>{c.name}{c.companyName && c.companyName !== c.name ? ' · ' + c.companyName : ''}</option>)}
            </select>
          </label>
        )}
        {kind === 'expense' && <label className="es-field"><span>{tr('Vehicle or machine')}</span><input className="input" list={'es-assets-' + sheet.id} value={f.asset} onChange={set('asset')} maxLength={80} placeholder={tr('optional')} /></label>}
        <label className="es-field is-wide"><span>{tr('What for')}</span><input className="input" value={f.note} onChange={set('note')} maxLength={300} placeholder={kind === 'funding' ? tr('e.g. Float top-up') : tr('e.g. Taxi to the client, 2 trips')} /></label>
        <label className="es-field es-file"><span>{tr('Receipt')}</span><input type="file" accept="image/*,application/pdf" onChange={(e) => setReceipt(e.target.files[0] || null)} /></label>
      </div>
      {kind === 'expense' && quick.length > 0 && !line && (
        <div className="es-quick">{quick.map((c) => <button key={c} type="button" className={'es-chip' + (f.category === c ? ' is-on' : '')} onClick={() => setF((x) => ({ ...x, category: c }))}>{c}</button>)}</div>
      )}
      <datalist id={'es-payees-' + sheet.id}>{sheet.suggestions.payees.map((p) => <option key={p} value={p} />)}</datalist>
      <datalist id={'es-assets-' + sheet.id}>{sheet.suggestions.assets.map((a) => <option key={a.name} value={a.name} />)}</datalist>
      <div className="es-form-actions">
        {onCancel && <button type="button" className="btn btn-secondary" onClick={onCancel}>{tr('Cancel')}</button>}
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? tr('Saving…') : line ? tr('Save changes') : start ? tr('Record it and ask to be paid back') : kind === 'funding' ? tr('Add money received') : tr('Add expense')}</button>
      </div>
    </form>
  );
}

// ── dialogs ───────────────────────────────────────────────────────────
export function Dialog({ title, children, onClose, wide }) {
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className={'dialog es-dialog' + (wide ? ' is-wide' : '')} role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function CheckDialog({ sheet, onDone, onClose }) {
  const [upto, setUpto] = useState(todayIso());
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [kind, setKind] = useState(sheet.can.accountantCheck && !(sheet.supervisor && sheet.supervisor.id === sheet.viewerId) ? 'accountant' : 'supervisor');
  const [err, setErr] = useState(null);
  const bal = sheet.lines.filter((l) => l.date <= upto).reduce((b, l) => (l.balance !== undefined ? l.balance : b), sheet.openingBalance);
  async function go() {
    setErr(null);
    try { onDone(await api.post('/expense-sheets/' + sheet.id + '/checks', { uptoDate: upto, counted, note, kind })); } catch (ex) { setErr(ex.message); }
  }
  const diff = counted !== '' ? Math.round((Number(counted) - bal) * 100) / 100 : null;
  return (
    <Dialog title={tr('Check this sheet')} onClose={onClose}>
      <p className="dialog-body">{tr('Confirm the balance up to a date. Every line up to then is locked: nothing can be added, changed or removed on or before it.')}</p>
      {err && <div className="error-banner">{err}</div>}
      <div className="es-form-grid">
        <label className="es-field"><span>{tr('Checked up to')}</span><input className="input" type="date" max={todayIso()} min={sheet.lockedUntil || undefined} value={upto} onChange={(e) => setUpto(e.target.value)} /></label>
        <div className="es-field"><span>{tr('Balance on the sheet')}</span><b className="es-big">{GHS(bal)}</b></div>
        <label className="es-field"><span>{tr('Cash counted (optional)')}</span><input className="input" type="number" step="0.01" value={counted} onChange={(e) => setCounted(e.target.value)} /></label>
        {sheet.can.accountantCheck && (
          <label className="es-field"><span>{tr('Checked as')}</span>
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}><option value="supervisor">{tr('Supervisor')}</option><option value="accountant">{tr('Accountant')}</option></select>
          </label>
        )}
        <label className="es-field is-wide"><span>{tr('Note')}</span><input className="input" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} /></label>
      </div>
      {diff !== null && diff !== 0 && <p className={'es-diff' + (diff < 0 ? ' is-short' : '')}>{diff < 0 ? tr('The cash is {amount} short of the sheet.', { amount: GHS(-diff) }) : tr('There is {amount} more cash than the sheet shows.', { amount: GHS(diff) })}</p>}
      <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="button" className="btn btn-primary" onClick={go}>{tr('Check and lock')}</button></div>
    </Dialog>
  );
}

// With a float: up to the usual float. With none (someone paid back for
// what they bought themselves): what the company owes them.
export function TopupDialog({ sheet, onDone, onClose }) {
  const payBack = !sheet.floatLimit && sheet.balance < 0;
  const gap = sheet.floatLimit ? sheet.floatLimit - sheet.balance : -sheet.balance;
  const [amount, setAmount] = useState(gap > 0 ? String(Math.round(gap * 100) / 100) : '');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState(null);
  async function go() { setErr(null); try { onDone(await api.post('/expense-sheets/' + sheet.id + '/topups', { amount: Number(amount), reason })); } catch (ex) { setErr(ex.message); } }
  return (
    <Dialog title={payBack ? tr('Ask to be paid back') : tr('Ask for a top-up')} onClose={onClose}>
      <p className="dialog-body">{payBack ? tr('The company owes you {amount}. Finance gets your request and records it on your sheet when they pay you.', { amount: GHS(-sheet.balance) }) : sheet.floatLimit ? tr('Your usual float is {amount}. Finance gets your request and adds the money to your sheet when they give it.', { amount: GHS(sheet.floatLimit) }) : tr('Finance gets your request and adds the money to your sheet when they give it.')}</p>
      {err && <div className="error-banner">{err}</div>}
      <div className="es-form-grid">
        <label className="es-field"><span>{tr('Amount (GHS)')}</span><input className="input" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label className="es-field is-wide"><span>{tr('What it is for')}</span><input className="input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder={tr('e.g. Fuel and transport for the week')} /></label>
      </div>
      <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="button" className="btn btn-primary" onClick={go} disabled={!(Number(amount) > 0)}>{tr('Send request')}</button></div>
    </Dialog>
  );
}

// Finance pays an officer back what the company owes them (the sheet is
// below zero): money received on the sheet, marked as a pay-back.
export function PayBackDialog({ sheet, onDone, onClose }) {
  const [amount, setAmount] = useState(String(Math.round(-sheet.balance * 100) / 100));
  const [date, setDate] = useState(todayIso());
  const [note, setNote] = useState('');
  const [err, setErr] = useState(null);
  async function go() { setErr(null); try { onDone(await api.post('/expense-sheets/' + sheet.id + '/payback', { amount: Number(amount), date, note })); } catch (ex) { setErr(ex.message); } }
  return (
    <Dialog title={tr('Pay {name} back', { name: sheet.employee.name })} onClose={onClose}>
      <p className="dialog-body">{tr('The company owes {name} {amount}: what they spent beyond what they were given. Record what you pay them; it goes on their sheet as money received.', { name: sheet.employee.name, amount: GHS(-sheet.balance) })}</p>
      {err && <div className="error-banner">{err}</div>}
      <div className="es-form-grid">
        <label className="es-field"><span>{tr('Amount paid (GHS)')}</span><input className="input" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label className="es-field"><span>{tr('Date paid')}</span><input className="input" type="date" max={todayIso()} min={sheet.lockedUntil || undefined} value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="es-field is-wide"><span>{tr('How (optional)')}</span><input className="input" value={note} maxLength={250} onChange={(e) => setNote(e.target.value)} placeholder={tr('e.g. Mobile money, cash')} /></label>
      </div>
      <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="button" className="btn btn-primary" onClick={go} disabled={!(Number(amount) > 0)}>{tr('Record the pay-back')}</button></div>
    </Dialog>
  );
}

export function DecideDialog({ topup, officer, onDone, onClose }) {
  const [amount, setAmount] = useState(String(topup.amount));
  const [date, setDate] = useState(todayIso());
  const [note, setNote] = useState('');
  const [err, setErr] = useState(null);
  async function go(approve) {
    setErr(null);
    try { onDone(await api.post('/expense-sheets/topups/' + topup.id + '/decide', { approve, amount: Number(amount), date, note })); } catch (ex) { setErr(ex.message); }
  }
  return (
    <Dialog title={tr('Top-up for {name}', { name: officer })} onClose={onClose}>
      <p className="dialog-body">{tr('Asked for {amount} on {date}.', { amount: GHS(topup.amount), date: fmtDate(String(topup.requestedAt).slice(0, 10)) })}{topup.reason ? ' “' + topup.reason + '”' : ''}</p>
      {err && <div className="error-banner">{err}</div>}
      <div className="es-form-grid">
        <label className="es-field"><span>{tr('Amount given (GHS)')}</span><input className="input" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label className="es-field"><span>{tr('Date given')}</span><input className="input" type="date" max={todayIso()} value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="es-field is-wide"><span>{tr('Note to the officer')}</span><input className="input" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} /></label>
      </div>
      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
        <button type="button" className="btn btn-secondary" onClick={() => go(false)}>{tr('Decline')}</button>
        <button type="button" className="btn btn-primary" onClick={() => go(true)}>{tr('Approve and add to the sheet')}</button>
      </div>
    </Dialog>
  );
}

export function ImportDialog({ sheet, onDone, onClose }) {
  const [file, setFile] = useState(null);
  const [pv, setPv] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  async function call(path) {
    const fd = new FormData(); fd.append('file', file);
    setBusy(true); setErr(null);
    try { return await api.upload('/expense-sheets/' + sheet.id + path, fd); } catch (ex) { setErr(ex.message); return null; } finally { setBusy(false); }
  }
  async function preview(f) { setFile(f); setPv(null); if (!f) return; const fd = new FormData(); fd.append('file', f); setBusy(true); setErr(null); try { setPv(await api.upload('/expense-sheets/' + sheet.id + '/import/preview', fd)); } catch (ex) { setErr(ex.message); } finally { setBusy(false); } }
  async function run() { const r = await call('/import'); if (r) onDone(r); }
  const diffs = pv ? pv.checks.filter((c) => c.agrees === false && !c.close) : [];
  const lineCount = pv ? pv.funding.lines + pv.expenses.lines + (pv.passedOn ? pv.passedOn.lines : 0) : 0;
  return (
    <Dialog title={tr('Bring in an expense workbook')} onClose={onClose} wide>
      <p className="dialog-body">{tr('The officer\'s old Excel sheet (.xlsx): the funding tab and the expense tab are read, the supervisor\'s stamps become checks. Bringing in a newer copy later adds only what is new.')}</p>
      <input type="file" accept=".xlsx" onChange={(e) => preview(e.target.files[0] || null)} />
      {busy && <p className="es-muted">{tr('Reading…')}</p>}
      {err && <div className="error-banner">{err}</div>}
      {pv && (
        <div className="es-import">
          {pv.officerOnWorkbook && pv.officerOnWorkbook.toLowerCase() !== pv.sheetOwner.toLowerCase().split(' ')[0] && pv.sheetOwner.toLowerCase().indexOf(pv.officerOnWorkbook.toLowerCase()) < 0 && (
            <p className="es-warn"><Icon name="warn" /> {tr('This workbook says it belongs to “{name}”, but this is {owner}\'s sheet.', { name: pv.officerOnWorkbook, owner: pv.sheetOwner })}</p>
          )}
          <div className="es-import-tiles">
            <div><small>{tr('Money received')}</small><b>{GHS(pv.funding.total)}</b><em>{nLines(pv.funding.lines)}</em></div>
            {pv.passedOn && pv.passedOn.lines > 0 && <div><small>{tr('Money passed on')}</small><b>{GHS(pv.passedOn.total)}</b><em>{nLines(pv.passedOn.lines)}</em></div>}
            <div><small>{tr('Money spent')}</small><b>{GHS(pv.expenses.total)}</b><em>{nLines(pv.expenses.lines)}</em></div>
            <div><small>{tr('Balance on the workbook')}</small><b>{pv.balance.onWorkbook === null ? '—' : GHS(pv.balance.onWorkbook)}</b><em>{pv.balance.workbookDate ? fmtDate(pv.balance.workbookDate) : ''}</em></div>
            {(() => {
              const known = pv.balance.onWorkbook !== null && pv.balance.afterImport !== null;
              const same = known && Math.abs(pv.balance.onWorkbook - pv.balance.afterImport) < 0.01;
              return <div className={!known ? '' : same ? 'is-good' : 'is-warn'}><small>{tr('Balance in the OS after')}</small><b>{pv.balance.afterImport === null ? '—' : GHS(pv.balance.afterImport)}</b><em>{!known ? tr('nothing to compare with') : same ? tr('the same ✓') : tr('different by {amount}', { amount: GHS(Math.abs(pv.balance.onWorkbook - pv.balance.afterImport)) })}</em></div>;
            })()}
          </div>
          <ul className="es-import-notes">
            {pv.passedOn && pv.passedOn.lines > 0 && <li>{pv.passedOn.lines === 1 ? tr('1 line on the funding tab is below zero: money passed on or handed back (payroll cash, money returned). It lowers the balance but is not counted as spending.') : tr('{n} lines on the funding tab are below zero: money passed on or handed back (payroll cash, money returned). They lower the balance but are not counted as spending.', { n: pv.passedOn.lines })}</li>}
            {pv.skippedBlank > 0 && <li>{tr('{n} rows with a date but no amount (days filled in ahead) are left out.', { n: pv.skippedBlank })}</li>}
            {pv.already > 0 && <li>{pv.already === 1 ? tr('1 line is already in the OS and is skipped.') : tr('{n} lines are already in the OS and are skipped.', { n: pv.already })}</li>}
            {pv.intoImportedChecks > 0 && <li>{pv.intoImportedChecks === 1 ? tr('1 line was left out by an earlier import and falls in a period checked by it. It is added, and the checks from that import are worked out again.') : tr('{n} lines were left out by an earlier import and fall in a period checked by it. They are added, and the checks from that import are worked out again.', { n: pv.intoImportedChecks })}</li>}
            {pv.inCheckedPeriod > 0 && <li>{pv.inCheckedPeriod === 1 ? tr('1 line falls in a period already checked here and is skipped.') : tr('{n} lines fall in a period already checked here and are skipped.', { n: pv.inCheckedPeriod })}</li>}
            {pv.payeesMerged.length > 0 && <li>{tr('Payees written in different cases become one: {list}.', { list: pv.payeesMerged.map((m) => m.to).join(', ') })}</li>}
            {pv.unitPriceDiffs.length > 0 && <li>{pv.unitPriceDiffs.length === 1 ? tr('1 line had a typed unit price that does not match amount ÷ quantity; the amount is kept.') : tr('{n} lines had a typed unit price that does not match amount ÷ quantity; the amount is kept.', { n: pv.unitPriceDiffs.length })}</li>}
            {pv.future.length > 0 && <li>{pv.future.length === 1 ? tr('1 line dated in the future is left out.') : tr('{n} lines dated in the future are left out.', { n: pv.future.length })}</li>}
            {pv.newCategories.length > 0 && <li>{(pv.canGrowLists ? tr('New categories added to the list: {list}.') : tr('Categories not on the list, kept as written: {list}.')).replace('{list}', pv.newCategories.join(', '))}</li>}
            {pv.newCostCentres.length > 0 && <li>{(pv.canGrowLists ? tr('New cost centres added to the list: {list}.') : tr('Cost centres not on the list, kept as written: {list}.')).replace('{list}', pv.newCostCentres.join(', '))}</li>}
          </ul>
          {pv.checks.length > 0 && (
            <div className="es-import-checks">
              <b>{tr('{n} checks found in the audit column', { n: pv.checks.length })}</b>
              <ol>
                {pv.checks.map((c, i) => (
                  <li key={i} className={c.agrees === false && !c.close ? 'is-warn' : ''}>
                    <span>{fmtDate(c.date)} · {c.kind === 'accountant' ? tr('Accountant') : c.initials}</span>
                    <span>{c.stamped === null ? tr('date only') : c.agrees ? tr('{amount} — agrees ✓', { amount: GHS(c.stamped) }) : c.close ? tr('{amount} — within a few pesewas', { amount: GHS(c.stamped) }) : tr('stamped {a}, the lines give {b}', { a: GHS(c.stamped), b: GHS(c.computed) })}</span>
                  </li>
                ))}
              </ol>
              {diffs.length > 0 && <p className="es-warn"><Icon name="warn" /> {diffs.length === 1 ? tr('1 stamp differs from the lines: probably a line added later with an earlier date. Worth a look before the next check.') : tr('{n} stamps differ from the lines: probably lines added later with an earlier date. Worth a look before the next check.', { n: diffs.length })}</p>}
            </div>
          )}
        </div>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
        <button type="button" className="btn btn-primary" disabled={!pv || busy || (!lineCount && !pv.checks.length)} onClick={run}>
          {pv ? (lineCount === 1 ? tr('Bring in 1 line') : tr('Bring in {n} lines', { n: lineCount })) : tr('Bring in')}
        </button>
      </div>
    </Dialog>
  );
}

export function SheetSettingsDialog({ sheet, people, onDone, onClose }) {
  const [sup, setSup] = useState(sheet.supervisor ? sheet.supervisor.id : '');
  const [limit, setLimit] = useState(sheet.floatLimit === null ? '' : String(sheet.floatLimit));
  const [note, setNote] = useState(sheet.note || '');
  const [status, setStatus] = useState(sheet.status);
  const [err, setErr] = useState(null);
  async function go() { setErr(null); try { onDone(await api.patch('/expense-sheets/' + sheet.id, { supervisorId: sup || null, floatLimit: limit === '' ? null : Number(limit), note, status })); } catch (ex) { setErr(ex.message); } }
  return (
    <Dialog title={tr('Sheet settings')} onClose={onClose}>
      {err && <div className="error-banner">{err}</div>}
      <div className="es-form-grid">
        <label className="es-field is-wide"><span>{tr('Checked by (supervisor)')}</span>
          <select className="input" value={sup} onChange={(e) => setSup(e.target.value)}>
            <option value="">{tr('Nobody — finance only')}</option>
            {people.filter((p) => p.id !== sheet.employee.id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="es-field"><span>{tr('Usual float (GHS)')}</span><input className="input" type="number" step="0.01" min="0" value={limit} onChange={(e) => setLimit(e.target.value)} /></label>
        <label className="es-field"><span>{tr('Sheet')}</span><select className="input" value={status} onChange={(e) => setStatus(e.target.value)}><option value="open">{tr('Open')}</option><option value="closed">{tr('Closed')}</option></select></label>
        <label className="es-field is-wide"><span>{tr('Note')}</span><input className="input" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} /></label>
      </div>
      <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="button" className="btn btn-primary" onClick={go}>{tr('Save')}</button></div>
    </Dialog>
  );
}
