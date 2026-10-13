import { useMemo, useState } from 'react';
import { api } from '../../api/client';
import { downloadProtected } from '../../lib/chatMedia';
import { Icon, Insights, Section, fmtDate } from '../../components/DashKit';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';
import {
  BalanceGauge, CheckDialog, GHS, ImportDialog, LineForm, MonthBars, PayBackDialog, PivotTable, RankBars, SheetSettingsDialog, TopupDialog, Who, daysSince, monthName, nLines
} from './EsParts';

// One officer's expense sheet: the balance and what it means, adding what
// was spent or received, the lines newest first with the balance after each
// and the checks between them, and where the money went this year.

function monthKey(iso) { return iso.slice(0, 7); }
function monthLabel(key) { return new Date(key + '-15T12:00').toLocaleDateString(activeIntlLocale(), { month: 'long', year: 'numeric' }); }

export default function EsSheet({ sheet, viewerId, people, onReload, onBack, setNotice }) {
  const [dialog, setDialog] = useState(null); // 'check' | 'topup' | 'import' | 'settings' | { edit: line }
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [month, setMonth] = useState(null);
  const [allMonths, setAllMonths] = useState(false);
  const s = { ...sheet, viewerId };
  const mine = sheet.employee.id === viewerId;
  const owed = sheet.balance < 0;
  const lastCheck = sheet.checks[0] || null;
  const sinceCheck = lastCheck ? sheet.lines.filter((l) => l.date > lastCheck.uptoDate) : sheet.lines;
  const pending = sheet.topups.filter((t) => t.status === 'pending');
  const thisYear = sheet.year === new Date().getFullYear();

  const insights = [];
  if (owed) insights.push({ tone: 'warn', icon: 'owed', text: !sheet.floatLimit
    ? (mine ? tr('The company owes you {amount} for what you paid yourself.', { amount: GHS(-sheet.balance) }) : tr('The company owes {name} {amount} for what they paid themselves.', { name: sheet.employee.name, amount: GHS(-sheet.balance) }))
    : mine ? tr('You have spent {amount} more than you were given: the company owes you this.', { amount: GHS(-sheet.balance) }) : tr('{name} has spent {amount} more than they were given: the company owes them this.', { name: sheet.employee.name, amount: GHS(-sheet.balance) }),
    action: sheet.can.manage ? { label: tr('Pay back'), run: () => setDialog('payback') } : mine && sheet.can.requestTopup && !pending.length ? { label: tr('Ask to be paid back'), run: () => setDialog('topup') } : null });
  else if (sheet.floatLimit && sheet.balance < sheet.floatLimit * 0.2) insights.push({ tone: 'warn', icon: 'cash', text: tr('Only {amount} left of a {limit} float.', { amount: GHS(sheet.balance), limit: GHS(sheet.floatLimit) }), action: mine && sheet.can.requestTopup && !pending.length ? { label: tr('Ask for a top-up'), run: () => setDialog('topup') } : null });
  if (!lastCheck && sheet.lines.length) insights.push({ tone: 'info', icon: 'check', text: tr('This sheet has never been checked.'), action: sheet.can.check ? { label: tr('Check it'), run: () => setDialog('check') } : null });
  else if (lastCheck && sinceCheck.length) {
    const age = daysSince(lastCheck.uptoDate);
    insights.push({ tone: age > 30 ? 'warn' : 'info', icon: 'check', text: (sinceCheck.length === 1 ? tr('1 line since the last check on {date} ({days} days ago).', { date: fmtDate(lastCheck.uptoDate), days: age }) : tr('{n} lines since the last check on {date} ({days} days ago).', { n: sinceCheck.length, date: fmtDate(lastCheck.uptoDate), days: age })), action: sheet.can.check ? { label: tr('Check now'), run: () => setDialog('check') } : null });
  }
  if (lastCheck && lastCheck.counted !== null && Math.abs(lastCheck.counted - lastCheck.balance) >= 0.01) {
    const d = Math.round((lastCheck.counted - lastCheck.balance) * 100) / 100;
    insights.push({ tone: 'bad', icon: 'warn', text: d < 0 ? tr('At the last check the cash was {amount} short of the sheet.', { amount: GHS(-d) }) : tr('At the last check there was {amount} more cash than the sheet showed.', { amount: GHS(d) }) });
  }
  pending.forEach((t) => insights.push({ tone: 'info', icon: 'cash', text: tr('A top-up of {amount} is waiting for finance (asked {date}).', { amount: GHS(t.amount), date: fmtDate(String(t.requestedAt).slice(0, 10)) }) }));
  const noReceipt = sheet.lines.filter((l) => l.kind === 'expense' && l.amount >= 200 && !l.receipt && !l.locked);
  if (noReceipt.length) insights.push({ tone: 'info', icon: 'receipt', text: noReceipt.length === 1 ? tr('1 expense of GHS 200 or more has no receipt photo yet.') : tr('{n} expenses of GHS 200 or more have no receipt photo yet.', { n: noReceipt.length }) });

  // Lines newest first, in months, with the checks where they fall.
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sheet.lines.filter((l) => (!cat || l.category === cat) && (month === null || Number(l.date.slice(5, 7)) - 1 === month) &&
      (!needle || [l.note, l.payee, l.category, l.costCentre, l.asset].join(' ').toLowerCase().includes(needle))).slice().reverse();
  }, [sheet.lines, q, cat, month]);
  const groups = useMemo(() => {
    const out = [];
    shown.forEach((l) => {
      const k = monthKey(l.date);
      if (!out.length || out[out.length - 1].key !== k) out.push({ key: k, lines: [], spent: 0, received: 0, passed: 0 });
      const g = out[out.length - 1];
      g.lines.push(l);
      if (l.kind === 'expense') g.spent += l.amount; else if (l.amount < 0) g.passed -= l.amount; else g.received += l.amount;
    });
    return out;
  }, [shown]);
  const filtering = !!(q || cat || month !== null);
  // A check sits just above the newest line it covers.
  const stampAt = {};
  if (!filtering) sheet.checks.forEach((c) => { const l = shown.find((x) => x.date <= c.uptoDate); if (l && !stampAt[l.id]) stampAt[l.id] = c; });

  async function remove(l) {
    if (!window.confirm(tr('Remove line {n} ({amount})?', { n: l.seq, amount: GHS(l.amount) }))) return;
    try { await api.del('/expense-sheets/lines/' + l.id); onReload(); } catch (ex) { setNotice(ex.message); }
  }
  async function undo(c) {
    if (!window.confirm(tr('Undo check {code}? The lines up to {date} can be changed again.', { code: c.code, date: fmtDate(c.uptoDate) }))) return;
    try { await api.del('/expense-sheets/checks/' + c.id); onReload(); } catch (ex) { setNotice(ex.message); }
  }

  return (
    <div className="es-sheet">
      <section className={'es-hero' + (owed ? ' is-owed' : '')}>
        <div className="es-hero-main">
          {onBack && <button type="button" className="es-back" onClick={onBack}><Icon name="arrow" /> {tr('All sheets')}</button>}
          <div className="es-hero-who">
            <span className="es-hero-photo"><Who person={sheet.employee} size={60} /></span>
            <div>
              <p className="es-eyebrow">{mine ? tr('My expense sheet') : tr('Expense sheet')} · {sheet.year}{sheet.status === 'closed' ? ' · ' + tr('closed') : ''}</p>
              <h1 className="es-hero-title">{sheet.employee.name}</h1>
              <p className="es-hero-sub">{[sheet.employee.title, sheet.employee.department].filter((v, i, a) => v && a.indexOf(v) === i).join(' · ')}{sheet.supervisor ? ' · ' + tr('checked by {name}', { name: sheet.supervisor.name }) : ''}</p>
            </div>
          </div>
          <div className="es-hero-stats">
            <span><small>{tr('Spent this month')}</small><b>{GHS(sheet.thisMonth.spent)}</b></span>
            <span><small>{tr('Received this month')}</small><b>{GHS(sheet.thisMonth.funded)}</b></span>
            <span><small>{tr('Last check')}</small><b>{lastCheck ? lastCheck.code + ' · ' + fmtDate(lastCheck.uptoDate) : tr('never')}</b></span>
          </div>
          <div className="es-hero-actions">
            {sheet.can.requestTopup && (sheet.floatLimit || owed) && <button type="button" className="es-pill is-main" onClick={() => setDialog('topup')}><Icon name="cash" /> {owed && !sheet.floatLimit ? tr('Ask to be paid back') : tr('Ask for a top-up')}</button>}
            {sheet.can.manage && owed && <button type="button" className="es-pill is-main" onClick={() => setDialog('payback')}><Icon name="cash" /> {tr('Pay back {amount}', { amount: GHS(-sheet.balance) })}</button>}
            {sheet.can.check && <button type="button" className="es-pill" onClick={() => setDialog('check')}><Icon name="check" /> {tr('Check up to a date')}</button>}
            {sheet.can.write && <button type="button" className="es-pill" onClick={() => setDialog('import')}><Icon name="layers" /> {tr('Bring in a workbook')}</button>}
            <button type="button" className="es-pill" onClick={() => downloadProtected('/expense-sheets/export.csv?sheet=' + sheet.id + '&year=' + sheet.year, 'expense-sheet-' + sheet.year + '.csv').catch((e) => setNotice(e.message))}><Icon name="doc" /> {tr('Export')}</button>
            {sheet.can.manage && <button type="button" className="es-pill" onClick={() => setDialog('settings')}><Icon name="key" /> {tr('Settings')}</button>}
          </div>
        </div>
        <BalanceGauge balance={sheet.balance} floatLimit={sheet.floatLimit} />
      </section>

      <Insights items={insights} />

      {sheet.can.write && thisYear && (
        <section className="es-card es-add" id="es-add">
          <h3>{tr('Add to the sheet')}</h3>
          <LineForm sheet={sheet} onSaved={() => { setNotice(tr('Added.')); onReload(); }} />
          <p className="es-muted">{sheet.lockedUntil ? tr('Checked up to {date}: new lines need a later date.', { date: fmtDate(sheet.lockedUntil) }) : tr('Lines can be changed until the sheet is checked.')}</p>
        </section>
      )}

      <Section title={tr('Lines')} sub={tr('Newest first, with the balance after each line. A lock means the line is in a checked period.')}
        action={sheet.years.length > 1 ? (
          <select className="input es-year" value={sheet.year} onChange={(e) => onReload(Number(e.target.value))} aria-label={tr('Year')}>
            {sheet.years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        ) : null}>
        <div className="es-filters">
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Search what, who, where…')} aria-label={tr('Search')} />
          <select className="input" value={cat} onChange={(e) => setCat(e.target.value)} aria-label={tr('Category')}>
            <option value="">{tr('All categories')}</option>
            {sheet.report.categories.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          </select>
          {month !== null && <button type="button" className="es-chip is-on" onClick={() => setMonth(null)}>{monthName(month, 'long')} ✕</button>}
          {filtering && <span className="es-muted">{nLines(shown.length)}</span>}
        </div>
        {groups.length ? (
          <div className="es-ledger">
            {(filtering || allMonths ? groups : groups.slice(0, 2)).map((g) => (
              <section key={g.key} className="es-month">
                <header><b>{monthLabel(g.key)}</b><span>{tr('spent {a}', { a: GHS(g.spent) })}{g.received ? ' · ' + tr('received {a}', { a: GHS(g.received) }) : ''}{g.passed ? ' · ' + tr('passed on {a}', { a: GHS(g.passed) }) : ''}</span></header>
                <ul>
                  {g.lines.map((l) => (
                    <li key={l.id}>
                      {stampAt[l.id] && (
                        <div className="es-stamp">
                          <span className="es-stamp-mark"><Icon name="check" /> {stampAt[l.id].code}</span>
                          <span>{stampAt[l.id].kind === 'accountant' ? tr('Accountant check') : tr('Supervisor check')} · {tr('up to {date}', { date: fmtDate(stampAt[l.id].uptoDate) })} · {tr('balance {amount}', { amount: GHS(stampAt[l.id].balance) })}{stampAt[l.id].counted !== null ? ' · ' + tr('counted {amount}', { amount: GHS(stampAt[l.id].counted) }) : ''}</span>
                          <em>{stampAt[l.id].by ? stampAt[l.id].by.name : stampAt[l.id].byInitials}</em>
                          {sheet.can.manage && sheet.checks[0] && sheet.checks[0].id === stampAt[l.id].id && <button type="button" className="es-link" onClick={() => undo(stampAt[l.id])}>{tr('Undo')}</button>}
                        </div>
                      )}
                      <div className={'es-line is-' + l.kind + (l.amount < 0 ? (l.kind === 'funding' ? ' is-passed' : ' is-back') : '')}>
                        <span className="es-line-no">{l.seq}</span>
                        <span className="es-line-date">{new Date(l.date + 'T12:00').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short' })}</span>
                        <span className="es-line-what">
                          <b>{l.note || (l.kind === 'funding' ? (l.amount < 0 ? tr('Money passed on') : tr('Money received')) : l.category)}</b>
                          <small>{[l.kind === 'funding' ? (l.payee ? (l.amount < 0 ? tr('to {name}', { name: l.payee }) : tr('from {name}', { name: l.payee })) : '') : l.payee, l.costCentre, l.asset].filter(Boolean).join(' · ')}</small>
                        </span>
                        {l.kind === 'expense' ? <span className="es-cat">{l.category}</span> : l.amount < 0 ? <span className="es-cat is-passed">{tr('Passed on')}</span> : <span className="es-cat is-recv">{l.source === 'topup' ? tr('Top-up') : l.source === 'payback' ? tr('Paid back') : tr('Received')}</span>}
                        <span className="es-line-qty">{l.kind === 'expense' && l.qty !== 1 ? l.qty + ' × ' + GHS(l.unitPrice) : ''}</span>
                        <span className="es-line-amt">{(l.kind === 'funding') === (l.amount > 0) ? '+' : '−'}{GHS(Math.abs(l.amount))}</span>
                        <span className={'es-line-bal' + (l.balance < 0 ? ' is-neg' : '')}>{GHS(l.balance)}</span>
                        <span className="es-line-tools">
                          {l.receipt && <button type="button" className="es-icon" title={tr('Receipt')} onClick={() => downloadProtected('/expense-sheets/lines/' + l.id + '/receipt', l.receipt.name).catch((e) => setNotice(e.message))}><Icon name="receipt" /></button>}
                          {l.locked ? <span className="es-icon is-lock" title={tr('Checked: locked')}><Icon name="key" /></span> : sheet.can.write && (
                            <>
                              <button type="button" className="es-icon" title={tr('Change')} onClick={() => setDialog({ edit: l })}><Icon name="doc" /></button>
                              <button type="button" className="es-icon is-danger" title={tr('Remove')} onClick={() => remove(l)}><Icon name="void" /></button>
                            </>
                          )}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {!filtering && !allMonths && groups.length > 2 && (
              <button type="button" className="btn btn-secondary es-more" onClick={() => setAllMonths(true)}>
                {tr('Show the earlier months ({n} lines)', { n: groups.slice(2).reduce((t, g) => t + g.lines.length, 0) })}
              </button>
            )}
            {!filtering && (allMonths || groups.length <= 2) && sheet.openingBalance !== 0 && <p className="es-opening">{tr('Carried in from before {year}: {amount}', { year: sheet.year, amount: GHS(sheet.openingBalance) })}</p>}
          </div>
        ) : <p className="es-empty"><Icon name="receipt" /> {filtering ? tr('No lines match.') : tr('Nothing on this sheet for {year} yet.', { year: sheet.year })}</p>}
      </Section>

      <Section title={tr('Where the money went in {year}', { year: sheet.year })} sub={tr('Month by month, by category, by cost centre and by who was paid. Press a month to see only its lines.')}>
        <div className="es-two">
          <div className="es-card"><h4>{tr('Month by month')}</h4><MonthBars spent={sheet.report.monthSpent} funded={sheet.report.monthFunded} year={sheet.year} onMonth={setMonth} active={month} /></div>
          <div className="es-card"><h4>{tr('By cost centre')}</h4><RankBars rows={sheet.report.costCentres.slice(0, 8)} empty={tr('Nothing spent yet.')} /></div>
        </div>
        <div className="es-card"><h4>{tr('By category and month')}</h4><PivotTable categories={sheet.report.categories} monthSpent={sheet.report.monthSpent} year={sheet.year} /></div>
        <div className="es-two">
          <div className="es-card"><h4>{tr('Who was paid most')}</h4><RankBars rows={sheet.report.payees.slice(0, 8)} empty={tr('Nothing spent yet.')} /></div>
          <div className="es-card">
            <h4>{tr('Checks')}</h4>
            {sheet.checks.length ? (
              <ol className="es-checks">
                {sheet.checks.slice(0, 8).map((c) => (
                  <li key={c.id}>
                    <span className={'es-check-code' + (c.kind === 'accountant' ? ' is-ac' : '')}>{c.code}</span>
                    <span><b>{tr('up to {date}', { date: fmtDate(c.uptoDate) })} · {GHS(c.balance)}</b><small>{(c.by ? c.by.name : c.byInitials) + ' · ' + (c.kind === 'accountant' ? tr('Accountant') : tr('Supervisor')) + (c.source === 'import' ? ' · ' + tr('from the workbook') : '')}</small></span>
                  </li>
                ))}
              </ol>
            ) : <p className="es-muted">{tr('No checks yet.')}</p>}
          </div>
        </div>
      </Section>

      {dialog === 'check' && <CheckDialog sheet={s} onClose={() => setDialog(null)} onDone={(c) => { setDialog(null); setNotice(tr('Checked up to {date} ({code}).', { date: fmtDate(c.uptoDate), code: c.code })); onReload(); }} />}
      {dialog === 'topup' && <TopupDialog sheet={sheet} onClose={() => setDialog(null)} onDone={() => { setDialog(null); setNotice(tr('Your request went to finance.')); onReload(); }} />}
      {dialog === 'import' && <ImportDialog sheet={sheet} onClose={() => setDialog(null)} onDone={(r) => { setDialog(null); setNotice(tr('Brought in {n} lines and {c} checks.', { n: r.added, c: r.checksAdded })); onReload(); }} />}
      {dialog === 'payback' && <PayBackDialog sheet={sheet} onClose={() => setDialog(null)} onDone={(l) => { setDialog(null); setNotice(tr('Paid back {amount}.', { amount: GHS(l.amount) })); onReload(); }} />}
      {dialog === 'settings' && <SheetSettingsDialog sheet={sheet} people={people} onClose={() => setDialog(null)} onDone={() => { setDialog(null); onReload(); }} />}
      {dialog && dialog.edit && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <div className="dialog es-dialog is-wide" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Change line {n}', { n: dialog.edit.seq })}</h2>
            <LineForm sheet={sheet} line={dialog.edit} onCancel={() => setDialog(null)} onSaved={() => { setDialog(null); onReload(); }} />
          </div>
        </div>
      )}
    </div>
  );
}
