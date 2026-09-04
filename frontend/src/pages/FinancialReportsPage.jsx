import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { shareOrDownloadPdf } from '../lib/documentShare';
import { rowsToCsv, downloadCsv } from '../lib/csvExport';
import { money as moneyFmt, moneyBreakdown } from '../lib/currency';
import './FinancialReportsPage.css';

// Financial Reports: Profit & Loss, Cash Flow, Balance Sheet, AR Aging and
// Expense Detail, all computed live from invoices/payments/expenses/
// payslips/products/assets by reports.service.js — there's no general
// ledger in this system, so the Balance Sheet's Cash & bank, Accounts
// Payable, Loans and Owner's Equity lines are entered manually here
// (report.manage) rather than computed; everything else is automatic.

// Redesign scoped narrowly given the size and density of this page (six
// report tabs, a PDF export ref, a manual balance-sheet-inputs form): only
// the P&L/Cash Flow summary tiles get the icon+tone treatment (mirroring
// Reports/FinanceDashboard), plus a requester avatar in the Expense Detail
// table. The AR Aging bucket tiles keep their existing bar-only treatment
// (a second icon there would clutter, not clarify) and every tab's table,
// the balance-sheet form, and all exports are untouched.

const AVATAR_COLORS = ['#3f7d3b', '#2f5f2c', '#7d5c3f', '#3f5a7d', '#7d3f5c', '#5c3f7d', '#7d6b3f', '#3f7d6b'];
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return ((parts[0] ? parts[0][0] : '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function avatarColor(name) { return AVATAR_COLORS[hashStr(name || '') % AVATAR_COLORS.length]; }

const ICON_PATHS = {
  cash: <><rect x="2.5" y="6" width="19" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.6" /><circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" /></>,
  receipt: <><path d="M6 3.5h12v17l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4v-17Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M8.5 8h7M8.5 11.5h7M8.5 15h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  users: <><circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.6" /><path d="M2.5 19c0-3.6 2.5-6 5.5-6s5.5 2.4 5.5 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><circle cx="16.5" cy="9" r="2.3" stroke="currentColor" strokeWidth="1.6" /><path d="M14.8 13.3c2.6.4 4.7 2.5 4.7 5.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  document: <><rect x="5" y="3.5" width="14" height="17" rx="1.5" stroke="currentColor" strokeWidth="1.6" /><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>
};
function Icon({ name }) { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">{ICON_PATHS[name]}</svg>; }

const TABS = [
  { key: 'pnl', label: 'Profit & Loss' },
  { key: 'cashflow', label: 'Cash Flow' },
  { key: 'balancesheet', label: 'Balance Sheet' },
  { key: 'araging', label: 'AR Aging' },
  { key: 'expensedetail', label: 'Expense Detail' },
  { key: 'taxsummary', label: 'Tax Summary' }
];
const PERIOD_TABS = { pnl: true, cashflow: true, expensedetail: true, taxsummary: true };
const BUCKET_LABELS = { current: 'Current', d1_30: '1–30 days', d31_60: '31–60 days', d61_90: '61–90 days', d90_plus: '90+ days' };

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length > 10 ? iso : iso + 'T00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function money(n) { return 'GHS ' + Number(n || 0).toLocaleString(); }
function defaultFrom() { return new Date().toISOString().slice(0, 8) + '01'; }
function todayISO() { return new Date().toISOString().slice(0, 10); }

function blankBsForm() { return { cashAndBank: 0, accountsPayable: 0, loansPayable: 0, otherLiabilities: 0, ownersEquity: 0, notes: '' }; }

export default function FinancialReportsPage() {
  const { can } = useAuth();
  const canManageBs = can('report.manage');

  const [tab, setTab] = useState('pnl');
  const [from, setFrom] = useState(defaultFrom());
  const [to, setTo] = useState(todayISO());

  const [pnl, setPnl] = useState(null);
  const [cashFlow, setCashFlow] = useState(null);
  const [balanceSheet, setBalanceSheet] = useState(null);
  const [arAging, setArAging] = useState(null);
  const [expenseDetail, setExpenseDetail] = useState(null);
  const [taxSummary, setTaxSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [exporting, setExporting] = useState(false);

  const [bsForm, setBsForm] = useState(blankBsForm());
  const [savingBs, setSavingBs] = useState(false);

  const printRef = useRef(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const qs = '?from=' + from + '&to=' + to;
      const [p, c, b, a, e, t] = await Promise.all([
        api.get('/reports/pnl' + qs),
        api.get('/reports/cashflow' + qs),
        api.get('/reports/balance-sheet'),
        api.get('/reports/ar-aging'),
        api.get('/reports/expense-detail' + qs),
        api.get('/reports/tax-summary' + qs)
      ]);
      setPnl(p); setCashFlow(c); setBalanceSheet(b); setArAging(a); setExpenseDetail(e); setTaxSummary(t);
      setBsForm({
        cashAndBank: b.manualInputs.cashAndBank, accountsPayable: b.manualInputs.accountsPayable,
        loansPayable: b.manualInputs.loansPayable, otherLiabilities: b.manualInputs.otherLiabilities,
        ownersEquity: b.manualInputs.ownersEquity, notes: b.manualInputs.notes
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  async function saveBsInputs(e) {
    e.preventDefault();
    setSavingBs(true);
    setError(null);
    try {
      await api.patch('/reports/balance-sheet/inputs', bsForm);
      setToast('Balance sheet inputs saved.');
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
    try {
      await shareOrDownloadPdf(printRef.current, filename, filename, filename);
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting(false);
    }
  }

  function exportPnlCsv() {
    if (!pnl) return;
    const rows = [
      ['Profit & Loss', from + ' to ' + to],
      [],
      ['Metric', 'Amount (GHS)'],
      ['Revenue', pnl.revenue],
      ['Total expenses', pnl.totalExpenses],
      ['Payroll cost', pnl.payrollCost],
      ['Net profit', pnl.netProfit],
      [],
      ['Expense category', 'Amount (GHS)'],
      ...pnl.expenseByCategory.map((r) => [r.category, r.amount])
    ];
    downloadCsv('profit-and-loss-' + from + '-to-' + to + '.csv', rowsToCsv(rows));
  }
  function exportCashFlowCsv() {
    if (!cashFlow) return;
    const rows = [
      ['Cash Flow', from + ' to ' + to],
      [],
      ['Metric', 'Amount (GHS)'],
      ['Cash in', cashFlow.cashIn],
      ['Expenses paid out', cashFlow.expensesOut],
      ['Payroll paid out', cashFlow.payrollOut],
      ['Net cash flow', cashFlow.netCashFlow],
      [],
      ['Cash in by method', 'Amount (GHS)'],
      ...cashFlow.cashInByMethod.map((r) => [r.method, r.amount])
    ];
    downloadCsv('cash-flow-' + from + '-to-' + to + '.csv', rowsToCsv(rows));
  }
  function exportBalanceSheetCsv() {
    if (!balanceSheet) return;
    const rows = [
      ['Balance Sheet', 'as of ' + balanceSheet.asOf],
      [],
      ['Assets', 'Amount (GHS)'],
      ['Cash & bank', balanceSheet.assets.cashAndBank],
      ['Accounts receivable', balanceSheet.assets.accountsReceivable],
      ['Inventory', balanceSheet.assets.inventoryValue],
      ['Fixed assets (at cost)', balanceSheet.assets.fixedAssets],
      ['Total assets', balanceSheet.assets.total],
      [],
      ['Liabilities', 'Amount (GHS)'],
      ['Accounts payable', balanceSheet.liabilities.accountsPayable],
      ['Loans payable', balanceSheet.liabilities.loansPayable],
      ['Other liabilities', balanceSheet.liabilities.otherLiabilities],
      ['Total liabilities', balanceSheet.liabilities.total],
      [],
      ['Equity', 'Amount (GHS)'],
      ["Owner's equity", balanceSheet.equity.ownersEquity],
      ['Retained earnings', balanceSheet.equity.retainedEarnings],
      ['Total equity', balanceSheet.equity.total]
    ];
    downloadCsv('balance-sheet-' + balanceSheet.asOf + '.csv', rowsToCsv(rows));
  }
  function exportArAgingCsv() {
    if (!arAging) return;
    const rows = [
      ['AR Aging', 'as of ' + arAging.asOf],
      [],
      ['Invoice', 'Customer', 'Currency', 'Balance due', 'Due date', 'Days overdue', 'Bucket'],
      ...arAging.invoices.map((r) => [r.invoiceNo, r.customerName, r.currency, r.balanceDue, r.dueDate || '', r.daysOverdue, BUCKET_LABELS[r.bucket]])
    ];
    downloadCsv('ar-aging-' + arAging.asOf + '.csv', rowsToCsv(rows));
  }
  function exportTaxSummaryCsv() {
    if (!taxSummary) return;
    const rows = [
      ['Tax Summary', from + ' to ' + to],
      [],
      ['Rate', 'Tax(es)', 'Taxable base (GHS)', 'Tax collected (GHS)', 'Invoices'],
      ...taxSummary.byRate.map((r) => [r.rate + '%', r.label, r.taxableBase, r.taxCollected, r.invoiceCount]),
      [],
      ['Total tax (from line items)', taxSummary.totalTaxFromLineItems],
      ['Total tax (recorded on invoices)', taxSummary.recordedTaxTotal],
      ['Reconciliation difference', taxSummary.reconciliationDiff]
    ];
    downloadCsv('tax-summary-' + from + '-to-' + to + '.csv', rowsToCsv(rows));
  }
  function exportExpenseDetailCsv() {
    if (!expenseDetail) return;
    const rows = [
      ['Expense Detail', from + ' to ' + to],
      [],
      ['Date', 'Category', 'Group', 'Requester', 'Description', 'Amount (GHS)'],
      ...expenseDetail.items.map((r) => [r.date, r.category, r.departmentName, r.requesterName, r.description, r.amount])
    ];
    downloadCsv('expense-detail-' + from + '-to-' + to + '.csv', rowsToCsv(rows));
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  // Each bucket is now [{ currency, amount }] rather than one blended number
  // (a customer's outstanding balance can be in any enabled currency — see
  // reports.service.js's arAging()). bucketMax sums across currencies purely
  // to size the bar's width proportionally; the displayed value itself is
  // always the full per-currency breakdown, never that summed number.
  const bucketSum = (arr) => (arr || []).reduce((s, r) => s + r.amount, 0);
  const bucketMax = arAging ? Math.max(1, ...Object.values(arAging.buckets).map(bucketSum)) : 1;

  return (
    <div className="finreport">
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <p className="finreport-intro">
        Built from invoices, payments, expenses and payroll already in Bamboo OS — there's no general ledger here, so
        the Balance Sheet's Cash &amp; bank, Accounts Payable, Loans and Owner's Equity figures are entered manually
        below; everything else updates automatically.
      </p>

      <div className="finreport-tabs">
        {TABS.map((t) => (
          <button key={t.key} type="button" className={'finreport-tab' + (tab === t.key ? ' finreport-tab-active' : '')} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="finreport-toolbar">
        {PERIOD_TABS[tab] && (
          <div className="finreport-period">
            <label>From <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label>To <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          </div>
        )}
        <div className="finreport-toolbar-actions">
          <button type="button" className="btn btn-secondary" disabled={exporting} onClick={() => downloadPdf(tab + '-' + todayISO() + '.pdf')}>
            {exporting ? 'Preparing…' : 'Download PDF'}
          </button>
          {tab === 'pnl' && <button type="button" className="btn btn-secondary" onClick={exportPnlCsv}>Download CSV</button>}
          {tab === 'cashflow' && <button type="button" className="btn btn-secondary" onClick={exportCashFlowCsv}>Download CSV</button>}
          {tab === 'balancesheet' && <button type="button" className="btn btn-secondary" onClick={exportBalanceSheetCsv}>Download CSV</button>}
          {tab === 'araging' && <button type="button" className="btn btn-secondary" onClick={exportArAgingCsv}>Download CSV</button>}
          {tab === 'expensedetail' && <button type="button" className="btn btn-secondary" onClick={exportExpenseDetailCsv}>Download CSV</button>}
          {tab === 'taxsummary' && <button type="button" className="btn btn-secondary" onClick={exportTaxSummaryCsv}>Download CSV</button>}
        </div>
      </div>

      {['pnl', 'cashflow', 'balancesheet', 'taxsummary'].includes(tab) && (
        <p className="finreport-asof">
          Totalled in the company's base currency
          ({(pnl && pnl.baseCurrency) || (cashFlow && cashFlow.baseCurrency) || (balanceSheet && balanceSheet.baseCurrency) || (taxSummary && taxSummary.baseCurrency) || 'GHS'}) —
          a document in another currency (Company settings → Enabled currencies) won't appear here, but still shows correctly on its own record and in the Invoices/Quotations lists.
        </p>
      )}

      <div ref={printRef}>
        {tab === 'pnl' && pnl && (
          <div>
            <div className="finreport-kpis">
              <div className="finreport-kpi finreport-kpi-people"><span className="finreport-kpi-icon"><Icon name="cash" /></span><div className="finreport-kpi-label">Revenue</div><div className="finreport-kpi-value">{money(pnl.revenue)}</div></div>
              <div className="finreport-kpi finreport-kpi-warning"><span className="finreport-kpi-icon"><Icon name="receipt" /></span><div className="finreport-kpi-label">Expenses</div><div className="finreport-kpi-value">{money(pnl.totalExpenses)}</div></div>
              <div className="finreport-kpi finreport-kpi-finance"><span className="finreport-kpi-icon"><Icon name="users" /></span><div className="finreport-kpi-label">Payroll cost</div><div className="finreport-kpi-value">{money(pnl.payrollCost)}</div></div>
              <div className="finreport-kpi finreport-kpi-ops">
                <span className="finreport-kpi-icon"><Icon name="document" /></span>
                <div className="finreport-kpi-label">Net profit</div>
                <div className={'finreport-kpi-value' + (pnl.netProfit < 0 ? ' finreport-negative' : '')}>{money(pnl.netProfit)}</div>
              </div>
            </div>
            <h2 className="finreport-section-title">Expenses by category</h2>
            <table className="table">
              <thead><tr><th>Category</th><th>Amount</th></tr></thead>
              <tbody>
                {pnl.expenseByCategory.map((r) => <tr key={r.category}><td>{r.category}</td><td>{money(r.amount)}</td></tr>)}
              </tbody>
            </table>
            {!pnl.expenseByCategory.length && <p className="table-empty">No expenses recognized in this period.</p>}
          </div>
        )}

        {tab === 'cashflow' && cashFlow && (
          <div>
            <div className="finreport-kpis">
              <div className="finreport-kpi finreport-kpi-people"><span className="finreport-kpi-icon"><Icon name="cash" /></span><div className="finreport-kpi-label">Cash in</div><div className="finreport-kpi-value">{money(cashFlow.cashIn)}</div></div>
              <div className="finreport-kpi finreport-kpi-warning"><span className="finreport-kpi-icon"><Icon name="receipt" /></span><div className="finreport-kpi-label">Cash out</div><div className="finreport-kpi-value">{money(cashFlow.cashOut)}</div></div>
              <div className="finreport-kpi finreport-kpi-ops">
                <span className="finreport-kpi-icon"><Icon name="document" /></span>
                <div className="finreport-kpi-label">Net cash flow</div>
                <div className={'finreport-kpi-value' + (cashFlow.netCashFlow < 0 ? ' finreport-negative' : '')}>{money(cashFlow.netCashFlow)}</div>
              </div>
            </div>
            <h2 className="finreport-section-title">Cash in by method</h2>
            <table className="table">
              <thead><tr><th>Method</th><th>Amount</th></tr></thead>
              <tbody>
                {cashFlow.cashInByMethod.map((r) => <tr key={r.method}><td style={{ textTransform: 'capitalize' }}>{r.method.replace('_', ' ')}</td><td>{money(r.amount)}</td></tr>)}
              </tbody>
            </table>
            {!cashFlow.cashInByMethod.length && <p className="table-empty">No payments received in this period.</p>}
          </div>
        )}

        {tab === 'balancesheet' && balanceSheet && (
          <div>
            <div className={'finreport-balance-banner' + (Math.abs(balanceSheet.balanceCheck) < 0.01 ? ' finreport-balanced' : ' finreport-unbalanced')}>
              {Math.abs(balanceSheet.balanceCheck) < 0.01
                ? 'Balanced — assets equal liabilities plus equity.'
                : 'Off by ' + money(Math.abs(balanceSheet.balanceCheck)) + ' — check the manual inputs below (Cash & bank is usually the figure to correct).'}
            </div>
            <p className="finreport-asof">As of {fmtDate(balanceSheet.asOf)}</p>

            <div className="finreport-bs-columns">
              <section>
                <h2 className="finreport-section-title">Assets</h2>
                <table className="table">
                  <tbody>
                    <tr><td>Cash &amp; bank</td><td>{money(balanceSheet.assets.cashAndBank)}</td></tr>
                    <tr><td>Accounts receivable</td><td>{money(balanceSheet.assets.accountsReceivable)}</td></tr>
                    <tr><td>Inventory</td><td>{money(balanceSheet.assets.inventoryValue)}</td></tr>
                    <tr><td>Fixed assets (at cost)</td><td>{money(balanceSheet.assets.fixedAssets)}</td></tr>
                    <tr className="finreport-total-row"><td>Total assets</td><td>{money(balanceSheet.assets.total)}</td></tr>
                  </tbody>
                </table>
              </section>
              <section>
                <h2 className="finreport-section-title">Liabilities</h2>
                <table className="table">
                  <tbody>
                    <tr><td>Accounts payable</td><td>{money(balanceSheet.liabilities.accountsPayable)}</td></tr>
                    <tr><td>Loans payable</td><td>{money(balanceSheet.liabilities.loansPayable)}</td></tr>
                    <tr><td>Other liabilities</td><td>{money(balanceSheet.liabilities.otherLiabilities)}</td></tr>
                    <tr className="finreport-total-row"><td>Total liabilities</td><td>{money(balanceSheet.liabilities.total)}</td></tr>
                  </tbody>
                </table>
                <h2 className="finreport-section-title">Equity</h2>
                <table className="table">
                  <tbody>
                    <tr><td>Owner's equity</td><td>{money(balanceSheet.equity.ownersEquity)}</td></tr>
                    <tr><td>Retained earnings</td><td>{money(balanceSheet.equity.retainedEarnings)}</td></tr>
                    <tr className="finreport-total-row"><td>Total equity</td><td>{money(balanceSheet.equity.total)}</td></tr>
                  </tbody>
                </table>
              </section>
            </div>

            {canManageBs && (
              <form className="finreport-bs-form no-print" onSubmit={saveBsInputs}>
                <h2 className="finreport-section-title">Edit manual inputs</h2>
                <div className="finreport-bs-fields">
                  <div className="field"><label>Cash &amp; bank</label><input className="input" type="number" step="0.01" value={bsForm.cashAndBank} onChange={(e) => setBsForm({ ...bsForm, cashAndBank: e.target.value })} /></div>
                  <div className="field"><label>Accounts payable</label><input className="input" type="number" step="0.01" value={bsForm.accountsPayable} onChange={(e) => setBsForm({ ...bsForm, accountsPayable: e.target.value })} /></div>
                  <div className="field"><label>Loans payable</label><input className="input" type="number" step="0.01" value={bsForm.loansPayable} onChange={(e) => setBsForm({ ...bsForm, loansPayable: e.target.value })} /></div>
                  <div className="field"><label>Other liabilities</label><input className="input" type="number" step="0.01" value={bsForm.otherLiabilities} onChange={(e) => setBsForm({ ...bsForm, otherLiabilities: e.target.value })} /></div>
                  <div className="field"><label>Owner's equity</label><input className="input" type="number" step="0.01" value={bsForm.ownersEquity} onChange={(e) => setBsForm({ ...bsForm, ownersEquity: e.target.value })} /></div>
                </div>
                <div className="field">
                  <label>Notes</label>
                  <textarea className="input" value={bsForm.notes} onChange={(e) => setBsForm({ ...bsForm, notes: e.target.value })} placeholder="E.g. loan source, last reconciled date…" />
                </div>
                <button type="submit" className="btn btn-primary" disabled={savingBs}>{savingBs ? 'Saving…' : 'Save manual inputs'}</button>
              </form>
            )}
          </div>
        )}

        {tab === 'araging' && arAging && (
          <div>
            <p className="finreport-asof">As of {fmtDate(arAging.asOf)}</p>
            <div className="finreport-kpis">
              {Object.keys(BUCKET_LABELS).map((k) => (
                <div className="finreport-kpi" key={k}>
                  <div className="finreport-kpi-label">{BUCKET_LABELS[k]}</div>
                  <div className="finreport-kpi-value">{moneyBreakdown(arAging.buckets[k])}</div>
                  <div className="finreport-bar" style={{ width: Math.round((bucketSum(arAging.buckets[k]) / bucketMax) * 100) + '%' }} />
                </div>
              ))}
            </div>
            <table className="table">
              <thead><tr><th>Invoice</th><th>Customer</th><th>Balance due</th><th>Due date</th><th>Days overdue</th></tr></thead>
              <tbody>
                {arAging.invoices.map((r) => (
                  <tr key={r.invoiceNo}>
                    <td style={{ fontWeight: 600 }}>{r.invoiceNo}</td><td>{r.customerName}</td><td>{moneyFmt(r.balanceDue, r.currency)}</td>
                    <td>{fmtDate(r.dueDate)}</td>
                    <td><span className={'tag ' + (r.bucket === 'current' ? 'tag-outline' : 'tag-accent')}>{BUCKET_LABELS[r.bucket]}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!arAging.invoices.length && <p className="table-empty">No outstanding balances.</p>}
          </div>
        )}

        {tab === 'expensedetail' && expenseDetail && (
          <div>
            <div className="finreport-columns">
              <section>
                <h2 className="finreport-section-title">By category</h2>
                <table className="table">
                  <thead><tr><th>Category</th><th>Amount</th></tr></thead>
                  <tbody>{expenseDetail.byCategory.map((r) => <tr key={r.category}><td>{r.category}</td><td>{money(r.amount)}</td></tr>)}</tbody>
                </table>
              </section>
              <section>
                <h2 className="finreport-section-title">By group</h2>
                <table className="table">
                  <thead><tr><th>Group</th><th>Amount</th></tr></thead>
                  <tbody>{expenseDetail.byDepartment.map((r) => <tr key={r.department}><td>{r.department}</td><td>{money(r.amount)}</td></tr>)}</tbody>
                </table>
              </section>
            </div>
            <h2 className="finreport-section-title">All expenses</h2>
            <table className="table">
              <thead><tr><th>Date</th><th>Category</th><th>Group</th><th>Requester</th><th>Description</th><th>Amount</th></tr></thead>
              <tbody>
                {expenseDetail.items.map((r, i) => (
                  <tr key={i}>
                    <td>{fmtDate(r.date)}</td><td>{r.category}</td><td>{r.departmentName}</td>
                    <td>
                      <div className="finreport-requester-cell">
                        <span className="finreport-avatar" style={{ background: avatarColor(r.requesterName) }}>{initials(r.requesterName)}</span>
                        {r.requesterName}
                      </div>
                    </td>
                    <td className="finreport-desc-cell">{r.description || '—'}</td><td>{money(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!expenseDetail.items.length && <p className="table-empty">No expenses recognized in this period.</p>}
          </div>
        )}

        {tab === 'taxsummary' && taxSummary && (
          <div>
            <p className="finreport-tax-note">
              Grouped by the exact tax rate found on each invoice line — where two configured taxes share a rate
              (e.g. NHIL and GETFund both default to 2.5%), the label shows both rather than guessing which applies.
            </p>
            <table className="table">
              <thead><tr><th>Rate</th><th>Tax(es)</th><th>Taxable base</th><th>Tax collected</th><th>Invoices</th></tr></thead>
              <tbody>
                {taxSummary.byRate.map((r) => (
                  <tr key={r.rate}>
                    <td>{r.rate}%</td><td>{r.label}</td><td>{money(r.taxableBase)}</td><td>{money(r.taxCollected)}</td><td>{r.invoiceCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!taxSummary.byRate.length && <p className="table-empty">No invoices issued in this period.</p>}

            <div className={'finreport-balance-banner' + (Math.abs(taxSummary.reconciliationDiff) < 0.01 ? ' finreport-balanced' : ' finreport-unbalanced')} style={{ marginTop: 16 }}>
              {Math.abs(taxSummary.reconciliationDiff) < 0.01
                ? 'Reconciled — line-item tax matches each invoice’s recorded total.'
                : 'Off by ' + money(Math.abs(taxSummary.reconciliationDiff)) + ' vs. invoices’ recorded tax totals — likely a document-level tax rate applied outside the line items.'}
            </div>
          </div>
        )}
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
