import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { shareOrDownloadPdf } from '../lib/documentShare';
import { rowsToCsv, downloadCsv } from '../lib/csvExport';
import { CompanySwitcher, Glossary, Hero, Insights, RankList, Section, Status, fmtDate, jump } from '../components/DashKit';
import { money as moneyFmt, moneyBreakdown } from '../lib/currency';
import { tr, msg } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels.js';
import './ToolRoomPage.css';
import './EmployeesPage.css';
import './CustomersPage.css';
import './ReportsPage.css';
import './FinancialReportsPage.css';

// Financial reports: Profit & Loss, Cash Flow, Balance Sheet, who owes us
// (receivables ageing), Expense detail and Tax, all worked out live from
// invoices, restaurant sales, payments, purchases, expense claims, payroll,
// stock and assets by reports.service.js. There is no general ledger, so
// the Balance Sheet's Cash & bank, Accounts payable, Loans and Owner's
// equity are typed in (report.manage); everything else is automatic.
//
// Same "explains itself" layout as the dashboards (components/DashKit.jsx):
// one company or every company together, a period, the headline numbers,
// what stands out, then each report laid out as a statement with PDF and
// CSV downloads. Totals are in the base currency; the receivables list
// keeps each invoice's own currency.

const TABS = [
  { key: 'pnl', label: msg('Profit & Loss') }, { key: 'cashflow', label: msg('Cash Flow') }, { key: 'balancesheet', label: msg('Balance Sheet') },
  { key: 'araging', label: msg('Who owes us') }, { key: 'expensedetail', label: msg('Expense Detail') }, { key: 'taxsummary', label: msg('Tax Summary') }
];
const PERIOD_TABS = { pnl: true, cashflow: true, expensedetail: true, taxsummary: true };
const BUCKETS = [
  { key: 'current', label: msg('Not yet due') }, { key: 'd1_30', label: msg('1–30 days') }, { key: 'd31_60', label: msg('31–60 days') },
  { key: 'd61_90', label: msg('61–90 days') }, { key: 'd90_plus', label: msg('90+ days') }
];
const PRESETS = [
  { key: 'month', label: msg('This month') }, { key: 'last', label: msg('Last month') }, { key: 'quarter', label: msg('This quarter') },
  { key: 'year', label: msg('This year') }, { key: 'lastyear', label: msg('Last year') }, { key: 'custom', label: msg('Choose dates') }
];

function iso(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function rangeFor(key) {
  const t = new Date(); const y = t.getFullYear(); const m = t.getMonth();
  if (key === 'last') return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) };
  if (key === 'quarter') return { from: iso(new Date(y, m - (m % 3), 1)), to: iso(t) };
  if (key === 'year') return { from: iso(new Date(y, 0, 1)), to: iso(t) };
  if (key === 'lastyear') return { from: iso(new Date(y - 1, 0, 1)), to: iso(new Date(y - 1, 11, 31)) };
  return { from: iso(new Date(y, m, 1)), to: iso(t) };
}
function readPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* remembered for this visit only */ } }
// A share of revenue, left out when revenue is so small next to the other
// figure that the percentage would mean nothing ("-3500% of revenue").
function pct(part, whole) { if (!whole) return null; const p = Math.round((part / whole) * 100); return Math.abs(p) > 500 ? null : p; }
function blankBsForm() { return { cashAndBank: 0, accountsPayable: 0, loansPayable: 0, otherLiabilities: 0, ownersEquity: 0, notes: '' }; }

// A statement: [{ label, amount, kind: 'head'|'line'|'sub'|'total', note }]
function Statement({ rows, base }) {
  return (
    <table className="fr-stmt">
      <tbody>
        {rows.filter(Boolean).map((r, i) => (
          <tr key={i} className={'is-' + (r.kind || 'line') + (r.amount < 0 && r.kind === 'total' ? ' is-neg' : '')}>
            <th scope="row">{r.label}{r.note && <span className="dk-muted tl-small"> · {r.note}</span>}</th>
            <td>{r.amount === undefined || r.amount === null ? '' : moneyFmt(r.amount, base)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function FinancialReportsPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const canManageBs = can('report.manage');

  const [companies, setCompanies] = useState([]);
  const [company, setCompany] = useState(() => readPref('bos.statementsCompany', 'ALL'));
  const [tab, setTab] = useState(() => readPref('bos.statementsTab', 'pnl'));
  const [preset, setPreset] = useState('month');
  const [range, setRange] = useState(() => rangeFor('month'));
  const [pnl, setPnl] = useState(null);
  const [cashFlow, setCashFlow] = useState(null);
  const [balanceSheet, setBalanceSheet] = useState(null);
  const [arAging, setArAging] = useState(null);
  const [expenseDetail, setExpenseDetail] = useState(null);
  const [taxSummary, setTaxSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [bsForm, setBsForm] = useState(blankBsForm());
  const [savingBs, setSavingBs] = useState(false);
  const printRef = useRef(null);

  useEffect(() => { api.get('/reports/statements/companies').then(setCompanies).catch(() => setCompanies([])); }, []);
  const load = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const qs = '?company=' + encodeURIComponent(company) + '&from=' + range.from + '&to=' + range.to;
      const [p, c, b, a, e, t] = await Promise.all([
        api.get('/reports/pnl' + qs), api.get('/reports/cashflow' + qs), api.get('/reports/balance-sheet'),
        api.get('/reports/ar-aging?company=' + encodeURIComponent(company)), api.get('/reports/expense-detail' + qs), api.get('/reports/tax-summary' + qs)
      ]);
      setPnl(p); setCashFlow(c); setBalanceSheet(b); setArAging(a); setExpenseDetail(e); setTaxSummary(t);
      setBsForm({
        cashAndBank: b.manualInputs.cashAndBank, accountsPayable: b.manualInputs.accountsPayable, loansPayable: b.manualInputs.loansPayable,
        otherLiabilities: b.manualInputs.otherLiabilities, ownersEquity: b.manualInputs.ownersEquity, notes: b.manualInputs.notes
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setBusy(false);
    }
  }, [company, range]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  function pickPreset(key) { setPreset(key); if (key !== 'custom') setRange(rangeFor(key)); }
  function pickCompany(code) { setCompany(code); writePref('bos.statementsCompany', code); }
  function pickTab(key) { setTab(key); writePref('bos.statementsTab', key); }
  async function saveBsInputs(e) {
    e.preventDefault();
    setSavingBs(true);
    setError(null);
    try {
      await api.patch('/reports/balance-sheet/inputs', bsForm);
      setToast(tr('Balance sheet inputs saved.'));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingBs(false);
    }
  }
  async function downloadPdf(filename) {
    setExporting(true);
    setError(null);
    try { await shareOrDownloadPdf(printRef.current, filename, filename, filename); } catch (err) { setError(err.message); } finally { setExporting(false); }
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;
  if (!pnl) return <div className="error-banner">{error}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const base = pnl.baseCurrency;
  const from = pnl.from, to = pnl.to;
  const periodText = fmtDate(from) + ' – ' + fmtDate(to);
  const coName = company === 'ALL' ? tr('All companies') : pnl.company.name;
  const arBase = (arAging.totalByCurrency.find((r) => r.currency === base) || { amount: 0 }).amount;
  const ar90 = arAging.buckets.d90_plus || [];
  const margin = pct(pnl.netProfit, pnl.revenue);
  const grossMargin = pct(pnl.grossProfit, pnl.revenue);
  const stillToPay = cashFlow.stillToPay.expenses + cashFlow.stillToPay.payroll;

  const stats = [
    { icon: 'up', value: moneyFmt(pnl.revenue, base), label: tr('revenue'), note: tr('invoiced {a} · restaurants {b}', { a: moneyFmt(pnl.revenueLines.invoiced, base), b: moneyFmt(pnl.revenueLines.restaurant, base) }), onClick: () => pickTab('pnl') },
    { icon: pnl.netProfit < 0 ? 'down' : 'cash', value: moneyFmt(pnl.netProfit, base), label: pnl.netProfit < 0 ? tr('net loss') : tr('net profit'), note: !pnl.revenue ? tr('no revenue in the period') : margin === null ? tr('costs far above revenue') : tr('{pct}% of revenue', { pct: margin }), tone: pnl.netProfit < 0 ? 'bad' : pnl.netProfit > 0 ? 'good' : '', onClick: () => pickTab('pnl') },
    { icon: 'scale', value: moneyFmt(cashFlow.netCashFlow, base), label: tr('net cash flow'), note: tr('in {a} · out {b}', { a: moneyFmt(cashFlow.cashIn, base), b: moneyFmt(cashFlow.cashOut, base) }), tone: cashFlow.netCashFlow < 0 ? 'warn' : '', onClick: () => pickTab('cashflow') },
    { icon: 'owed', value: moneyBreakdown(arAging.totalByCurrency, moneyFmt(0, base)), label: tr('owed to us now'), note: ar90.length ? tr('{amount} over 90 days', { amount: moneyBreakdown(ar90) }) : tr('nothing over 90 days'), tone: ar90.length ? 'bad' : '', onClick: () => pickTab('araging') }
  ];

  const insights = [];
  if (pnl.revenue > 0 && pnl.netProfit < 0) insights.push({ tone: 'bad', icon: 'down', text: tr('Costs were {amount} more than revenue over the period.', { amount: moneyFmt(-pnl.netProfit, base) }), action: { label: tr('See the P&L'), run: () => { pickTab('pnl'); jump('fr-report'); } } });
  if (cashFlow.netCashFlow < 0) insights.push({ tone: 'warn', icon: 'scale', text: tr('More cash went out ({out}) than came in ({in}).', { out: moneyFmt(cashFlow.cashOut, base), in: moneyFmt(cashFlow.cashIn, base) }), action: { label: tr('See the cash flow'), run: () => { pickTab('cashflow'); jump('fr-report'); } } });
  if (stillToPay > 0) insights.push({ tone: 'info', icon: 'clock', text: tr('{amount} is approved but not paid out yet: {a} in expense claims and {b} in payroll.', { amount: moneyFmt(stillToPay, base), a: moneyFmt(cashFlow.stillToPay.expenses, base), b: moneyFmt(cashFlow.stillToPay.payroll, base) }), action: { label: tr('Expenses'), run: () => navigate('/expenses') } });
  if (ar90.length) insights.push({ tone: 'bad', icon: 'owed', text: tr('{amount} has been owed for more than 90 days.', { amount: moneyBreakdown(ar90) }), action: { label: tr('See who owes'), run: () => { pickTab('araging'); jump('fr-report'); } } });
  if (Math.abs(balanceSheet.balanceCheck) >= 0.01) insights.push({ tone: 'warn', icon: 'warn', text: tr('The balance sheet is off by {amount}. Cash & bank is usually the figure to correct.', { amount: moneyFmt(Math.abs(balanceSheet.balanceCheck), base) }), action: { label: tr('See the balance sheet'), run: () => { pickTab('balancesheet'); jump('fr-report'); } } });
  if (Math.abs(taxSummary.reconciliationDiff) >= 0.01) insights.push({ tone: 'warn', icon: 'percent', text: tr('Tax worked out from the invoices differs from what they recorded by {amount}.', { amount: moneyFmt(Math.abs(taxSummary.reconciliationDiff), base) }), action: { label: tr('See the tax'), run: () => { pickTab('taxsummary'); jump('fr-report'); } } });
  if (grossMargin !== null && pnl.purchases.total > 0 && pnl.purchases.total < pnl.revenue) insights.push({ tone: 'info', icon: 'bag', text: tr('Purchases took {pct}% of revenue, leaving a gross margin of {gm}%.', { pct: pct(pnl.purchases.total, pnl.revenue), gm: grossMargin }), action: null });

  // ── exports ─────────────────────────────────────────────────────────
  const head = (title) => [[title, coName, tr('{from} to {to}', { from, to })], []];
  function csv(name, rows) { downloadCsv(name + '-' + (company || 'all').toLowerCase() + '-' + from + '-to-' + to + '.csv', rowsToCsv(rows)); }
  const pnlRows = [
    { label: tr('Revenue'), kind: 'head' },
    { label: tr('Invoiced sales'), amount: pnl.revenueLines.invoiced },
    pnl.revenueLines.restaurant ? { label: tr('Restaurant takings'), amount: pnl.revenueLines.restaurant } : null,
    { label: tr('Total revenue'), amount: pnl.revenue, kind: 'sub' },
    { label: tr('Purchases received'), kind: 'head' },
    { label: tr('Purchase requests'), amount: pnl.purchases.procurement, note: pnl.purchases.procurementCount ? tr('{n} received', { n: pnl.purchases.procurementCount }) : null },
    pnl.purchases.rawBamboo || pnl.purchases.rawBambooCount ? { label: tr('Raw bamboo'), amount: pnl.purchases.rawBamboo, note: tr('{n} batches', { n: pnl.purchases.rawBambooCount }) } : null,
    pnl.purchases.restaurantSupplies ? { label: tr('Restaurant supplies'), amount: pnl.purchases.restaurantSupplies } : null,
    { label: tr('Gross profit'), amount: pnl.grossProfit, kind: 'total', note: grossMargin === null ? null : tr('{pct}% of revenue', { pct: grossMargin }) },
    { label: tr('Running costs'), kind: 'head' },
    ...pnl.expenseByCategory.map((r) => ({ label: r.category, amount: r.amount })),
    { label: tr('Payroll'), amount: pnl.payrollCost, note: tr('gross pay and employer SSNIT') },
    { label: tr('Total running costs'), amount: pnl.totalExpenses + pnl.payrollCost, kind: 'sub' },
    { label: pnl.netProfit < 0 ? tr('Net loss') : tr('Net profit'), amount: pnl.netProfit, kind: 'total', note: margin === null ? null : tr('{pct}% of revenue', { pct: margin }) }
  ];
  const cfRows = [
    { label: tr('Money in'), kind: 'head' },
    ...cashFlow.cashInByMethod.map((r) => ({ label: codeLabel(r.method), amount: r.amount })),
    { label: tr('Total in'), amount: cashFlow.cashIn, kind: 'sub', note: cashFlow.cashInFromRestaurants ? tr('invoices {a} · restaurants {b}', { a: moneyFmt(cashFlow.cashInFromInvoices, base), b: moneyFmt(cashFlow.cashInFromRestaurants, base) }) : null },
    { label: tr('Money out'), kind: 'head' },
    { label: tr('Expense claims paid out'), amount: cashFlow.expensesOut },
    { label: tr('Payroll paid'), amount: cashFlow.payrollOut, note: tr('runs marked paid') },
    { label: tr('Purchases received'), amount: cashFlow.purchasesOut, note: tr('counted as paid when received') },
    { label: tr('Total out'), amount: cashFlow.cashOut, kind: 'sub' },
    { label: tr('Net cash flow'), amount: cashFlow.netCashFlow, kind: 'total' },
    { label: tr('Still to go out'), kind: 'head' },
    { label: tr('Approved expense claims'), amount: cashFlow.stillToPay.expenses, note: tr('{n} claims', { n: cashFlow.stillToPay.expenseCount }) },
    { label: tr('Approved pay runs'), amount: cashFlow.stillToPay.payroll, note: tr('{n} runs', { n: cashFlow.stillToPay.payrollRuns }) }
  ];
  const bs = balanceSheet;
  const bsRows = [
    { label: tr('Assets'), kind: 'head' },
    { label: tr('Cash & bank'), amount: bs.assets.cashAndBank, note: tr('typed in') },
    { label: tr('Accounts receivable'), amount: bs.assets.accountsReceivable },
    { label: tr('Inventory'), amount: bs.assets.inventoryValue, note: tr('finished products at cost') },
    { label: tr('Fixed assets (at cost)'), amount: bs.assets.fixedAssets },
    { label: tr('Total assets'), amount: bs.assets.total, kind: 'total' },
    { label: tr('Liabilities'), kind: 'head' },
    { label: tr('Accounts payable'), amount: bs.liabilities.accountsPayable, note: tr('typed in') },
    { label: tr('Loans payable'), amount: bs.liabilities.loansPayable, note: tr('typed in') },
    { label: tr('Other liabilities'), amount: bs.liabilities.otherLiabilities, note: tr('typed in') },
    { label: tr('Total liabilities'), amount: bs.liabilities.total, kind: 'sub' },
    { label: tr('Equity'), kind: 'head' },
    { label: tr('Owner\'s equity'), amount: bs.equity.ownersEquity, note: tr('typed in') },
    { label: tr('Retained earnings'), amount: bs.equity.retainedEarnings, note: tr('all profit to date') },
    { label: tr('Total equity'), amount: bs.equity.total, kind: 'sub' },
    { label: tr('Liabilities and equity'), amount: bs.liabilities.total + bs.equity.total, kind: 'total' }
  ];
  function exportCurrent() {
    const toCsv = (rows) => rows.filter(Boolean).map((r) => [r.label + (r.note ? ' (' + r.note + ')' : ''), r.amount === undefined ? '' : r.amount]);
    if (tab === 'pnl') csv('profit-and-loss', head(tr('Profit & Loss')).concat([[tr('Line'), tr('Amount') + ' (' + base + ')']], toCsv(pnlRows)));
    else if (tab === 'cashflow') csv('cash-flow', head(tr('Cash Flow')).concat([[tr('Line'), tr('Amount') + ' (' + base + ')']], toCsv(cfRows)));
    else if (tab === 'balancesheet') downloadCsv('balance-sheet-' + bs.asOf + '.csv', rowsToCsv([[tr('Balance Sheet'), tr('as of {asOf}', { asOf: bs.asOf })], [], [tr('Line'), tr('Amount') + ' (' + base + ')']].concat(toCsv(bsRows))));
    else if (tab === 'araging') downloadCsv('who-owes-us-' + arAging.asOf + '.csv', rowsToCsv([[tr('Who owes us'), coName, arAging.asOf], [], [tr('Invoice'), tr('Customer'), tr('Currency'), tr('Balance due'), tr('Due date'), tr('Days overdue'), tr('Bucket')]].concat(arAging.invoices.map((r) => [r.invoiceNo, r.customerName, r.currency, r.balanceDue, r.dueDate || '', r.daysOverdue, tr((BUCKETS.find((b) => b.key === r.bucket) || BUCKETS[0]).label)]))));
    else if (tab === 'expensedetail') csv('expense-detail', head(tr('Expense Detail')).concat([[tr('Date'), tr('Category'), tr('Group'), tr('Requester'), tr('Description'), tr('Amount') + ' (' + base + ')']], expenseDetail.items.map((r) => [r.date, r.category, r.departmentName, r.requesterName, r.description, r.amount])));
    else csv('tax-summary', head(tr('Tax Summary')).concat([[tr('Rate'), tr('Tax(es)'), tr('Taxable base') + ' (' + base + ')', tr('Tax collected') + ' (' + base + ')', tr('Invoices')]], taxSummary.byRate.map((r) => [r.rate + '%' + (r.onWholeDocument ? ' (' + tr('whole document') + ')' : ''), r.label, r.taxableBase, r.taxCollected, r.invoiceCount]), [[], [tr('Total tax (from line items)'), taxSummary.totalTaxFromLineItems], [tr('Tax set on whole documents'), taxSummary.totalTaxOnWholeDocuments], [tr('Total tax (recorded on invoices)'), taxSummary.recordedTaxTotal], [tr('Reconciliation difference'), taxSummary.reconciliationDiff]]));
  }

  const bucketRows = BUCKETS.map((b) => ({ ...b, sum: arAging.buckets[b.key] || [], n: arAging.invoices.filter((r) => r.bucket === b.key).length }));

  return (
    <div className={'dk tl fr' + (busy ? ' is-loading' : '')}>
      {error && <div className="error-banner" role="alert">{error}</div>}

      <CompanySwitcher companies={companies.map((c) => (c.code === 'ALL' ? { ...c, name: tr('All companies') } : c))} company={company} onPick={pickCompany} />

      <Hero
        eyebrow={tr('Finance')}
        title={tr('Financial reports')}
        sub={tr('{company}, {period}: the profit and loss, cash flow, balance sheet, who owes us, expenses and tax — worked out from invoices, till sales, payments, purchases, expense claims and payroll already in Bamboo OS.', { company: coName, period: periodText })}
        stats={stats} />

      <div className="rp-period" role="radiogroup" aria-label={tr('Period')}>
        {PRESETS.map((p) => <button key={p.key} type="button" role="radio" aria-checked={preset === p.key} className={'ppl-chip' + (preset === p.key ? ' is-on' : '')} onClick={() => pickPreset(p.key)}>{tr(p.label)}</button>)}
        {preset === 'custom' && (
          <span className="rp-dates">
            <input className="input" type="date" value={range.from} max={range.to} onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })} aria-label={tr('From')} />
            <span aria-hidden="true">–</span>
            <input className="input" type="date" value={range.to} min={range.from} onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })} aria-label={tr('To')} />
          </span>
        )}
      </div>

      <Insights items={insights.slice(0, 5)} />

      <Section id="fr-report" title={tr((TABS.find((t) => t.key === tab) || TABS[0]).label)}
        sub={tab === 'balancesheet' ? tr('As of {date}, every company together.', { date: fmtDate(bs.asOf) }) : tab === 'araging' ? tr('As of {date}.', { date: fmtDate(arAging.asOf) }) : periodText + ' · ' + coName}
        action={(
          <div className="fr-actions">
            <button type="button" className="btn btn-secondary" disabled={exporting} onClick={() => downloadPdf(tab + '-' + to + '.pdf')}>{exporting ? tr('Preparing…') : tr('Download PDF')}</button>
            <button type="button" className="btn btn-secondary" onClick={exportCurrent}>{tr('Download CSV')}</button>
          </div>
        )}>
        <div className="fr-tabs" role="tablist" aria-label={tr('Report')}>
          {TABS.map((t) => <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={'ppl-chip' + (tab === t.key ? ' is-on' : '')} onClick={() => pickTab(t.key)}>{tr(t.label)}</button>)}
        </div>
        {PERIOD_TABS[tab] && tab !== 'expensedetail' && <p className="dk-muted tl-small">{tr('In {base}. An invoice in another currency shows on its own record and in the Invoices list, but isn\'t added into these totals.', { base })}</p>}

        <div ref={printRef} className="fr-print">
          <h3 className="fr-print-title">{tr((TABS.find((t) => t.key === tab) || TABS[0]).label)} · {coName}</h3>
          {tab === 'pnl' && <Statement rows={pnlRows} base={base} />}

          {tab === 'cashflow' && <Statement rows={cfRows} base={base} />}

          {tab === 'balancesheet' && (
            <>
              <div className={'fr-banner ' + (Math.abs(bs.balanceCheck) < 0.01 ? 'is-ok' : 'is-off')}>
                {Math.abs(bs.balanceCheck) < 0.01 ? tr('Balanced — assets equal liabilities plus equity.') : tr('Off by {amount} — check the typed-in figures below (Cash & bank is usually the one to correct).', { amount: moneyFmt(Math.abs(bs.balanceCheck), base) })}
              </div>
              <Statement rows={bsRows} base={base} />
            </>
          )}

          {tab === 'araging' && (
            <>
              <div className="cu-stages iv-ages fr-ages">
                {bucketRows.map((b) => (
                  <div key={b.key} className={'cu-stage iv-age is-' + ({ current: 'notdue', d1_30: 'a30', d31_60: 'a60', d61_90: 'a90', d90_plus: 'a90p' }[b.key])}>
                    <strong>{b.sum.length ? moneyBreakdown(b.sum) : '—'}</strong>
                    <span>{tr(b.label)} · {b.n}</span>
                  </div>
                ))}
              </div>
              {arAging.invoices.length ? (
                <div className="tl-table-wrap">
                  <table className="tl-table">
                    <thead><tr><th>{tr('Customer')}</th><th>{tr('Invoice')}</th><th className="is-num">{tr('Balance due')}</th><th>{tr('Due date')}</th><th>{tr('How late')}</th></tr></thead>
                    <tbody>
                      {arAging.invoices.map((r) => (
                        <tr key={r.invoiceNo}>
                          <td><span className="tl-name">{r.customerName}</span>{r.phone && <div className="dk-muted tl-small">{r.phone}</div>}</td>
                          <td>{r.invoiceId ? <Link to={'/invoices?open=' + r.invoiceId}>{r.invoiceNo}</Link> : r.invoiceNo}</td>
                          <td className="is-num">{moneyFmt(r.balanceDue, r.currency)}</td>
                          <td>{r.dueDate ? fmtDate(r.dueDate) : '—'}</td>
                          <td><Status tone={r.bucket === 'current' ? 'muted' : r.bucket === 'd1_30' ? 'warn' : 'bad'}>{r.bucket === 'current' ? tr('Not yet due') : tr('{n} days overdue', { n: r.daysOverdue })}</Status></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <p className="dk-muted tl-small">{tr('No outstanding balances.')}</p>}
            </>
          )}

          {tab === 'expensedetail' && (
            <>
              {expenseDetail.items.length ? (
                <>
                  <div className="rp-pair">
                    <div><h3 className="tl-h3">{tr('By category')}</h3><RankList rows={expenseDetail.byCategory.map((r) => ({ key: r.category, name: r.category, amount: moneyFmt(r.amount, base), value: r.amount }))} /></div>
                    <div><h3 className="tl-h3">{tr('By group')}</h3><RankList rows={expenseDetail.byDepartment.map((r) => ({ key: r.department, name: r.department, amount: moneyFmt(r.amount, base), value: r.amount }))} /></div>
                  </div>
                  <h3 className="tl-h3">{tr('Every claim ({n}), {amount} in all', { n: expenseDetail.items.length, amount: moneyFmt(expenseDetail.total, base) })}</h3>
                  <div className="tl-table-wrap">
                    <table className="tl-table">
                      <thead><tr><th>{tr('Date')}</th><th>{tr('Category')}</th><th>{tr('Requester')}</th><th>{tr('Description')}</th><th className="is-num">{tr('Amount')}</th></tr></thead>
                      <tbody>
                        {expenseDetail.items.map((r, i) => (
                          <tr key={r.id || i}>
                            <td>{fmtDate(r.date)}</td><td>{r.category}</td>
                            <td>{r.requesterName}<div className="dk-muted tl-small">{r.departmentName}</div></td>
                            <td className="es-items-cell">{r.description || '—'}</td><td className="is-num">{moneyFmt(r.amount, base)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : <p className="dk-muted tl-small">{tr('No expenses recognized in this period.')}</p>}
            </>
          )}

          {tab === 'taxsummary' && (
            <>
              <p className="dk-muted tl-small">{tr('Grouped by the exact tax rate on each invoice line, or set on the whole invoice. Where two configured taxes share a rate (NHIL and GETFund both default to 2.5%), the label shows both rather than guessing which applies.')}</p>
              {taxSummary.byRate.length ? (
                <div className="tl-table-wrap">
                  <table className="tl-table">
                    <thead><tr><th>{tr('Rate')}</th><th>{tr('Tax(es)')}</th><th className="is-num">{tr('Taxable base')}</th><th className="is-num">{tr('Tax collected')}</th><th className="is-num">{tr('Invoices')}</th></tr></thead>
                    <tbody>
                      {taxSummary.byRate.map((r) => (
                        <tr key={r.rate + (r.onWholeDocument ? 'd' : '')}>
                          <td>{r.rate}%{r.onWholeDocument && <div className="dk-muted tl-small">{tr('on the whole invoice')}</div>}</td>
                          <td>{r.label}</td><td className="is-num">{moneyFmt(r.taxableBase, base)}</td><td className="is-num">{moneyFmt(r.taxCollected, base)}</td><td className="is-num">{r.invoiceCount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <p className="dk-muted tl-small">{tr('No invoices issued in this period.')}</p>}
              <div className={'fr-banner ' + (Math.abs(taxSummary.reconciliationDiff) < 0.01 ? 'is-ok' : 'is-off')}>
                {Math.abs(taxSummary.reconciliationDiff) < 0.01
                  ? tr('Reconciled — the tax worked out matches what the invoices recorded ({amount}).', { amount: moneyFmt(taxSummary.recordedTaxTotal, base) })
                  : tr('Off by {amount} against what the invoices recorded.', { amount: moneyFmt(Math.abs(taxSummary.reconciliationDiff), base) })}
              </div>
            </>
          )}
        </div>

        {tab === 'balancesheet' && canManageBs && (
          <details className="fr-bs-edit">
            <summary>{tr('Edit the typed-in figures')}</summary>
            <form onSubmit={saveBsInputs}>
              <div className="tl-form">
                {[['cashAndBank', tr('Cash & bank')], ['accountsPayable', tr('Accounts payable')], ['loansPayable', tr('Loans payable')], ['otherLiabilities', tr('Other liabilities')], ['ownersEquity', tr('Owner\'s equity')]].map(([k, label]) => (
                  <div className="field" key={k}><label htmlFor={'fr-' + k}>{label}</label><input id={'fr-' + k} className="input" type="number" step="0.01" value={bsForm[k]} onChange={(e) => setBsForm({ ...bsForm, [k]: e.target.value })} /></div>
                ))}
                <div className="field tl-span"><label htmlFor="fr-notes">{tr('Notes')}</label><textarea id="fr-notes" className="input tl-textarea" value={bsForm.notes} onChange={(e) => setBsForm({ ...bsForm, notes: e.target.value })} placeholder={tr('E.g. loan source, last reconciled date…')} /></div>
              </div>
              <button type="submit" className="btn btn-primary" disabled={savingBs}>{savingBs ? tr('Saving…') : tr('Save manual inputs')}</button>
            </form>
          </details>
        )}
      </Section>

      <Glossary items={[
        [tr('Revenue'), tr('Invoices issued in the period (voided ones left out) plus restaurant till sales.')],
        [tr('Purchases received'), tr('Purchase requests that arrived, at their real cost, raw bamboo batches and restaurant supplies delivered. Supplier payments aren\'t recorded, so a purchase counts as paid when it is received.')],
        [tr('Gross profit'), tr('Revenue less purchases.')],
        [tr('Running costs'), tr('Approved expense claims by the day they were spent, and payroll: gross pay plus the employer\'s SSNIT for runs approved or paid, by pay date.')],
        [tr('Cash flow'), tr('Money that actually moved in the period: payments and till sales in; expense claims paid out, pay runs marked paid and purchases received out. What is approved but not paid is shown separately.')],
        [tr('Retained earnings'), tr('All profit since the start, worked out the same way as the P&L.')]
      ]} />

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
