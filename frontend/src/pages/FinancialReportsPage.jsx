import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { shareOrDownloadPdf } from '../lib/documentShare';
import { rowsToCsv, downloadCsv } from '../lib/csvExport';
import './FinancialReportsPage.css';

// Financial Reports: Profit & Loss, Cash Flow, Balance Sheet, AR Aging and
// Expense Detail, all computed live from invoices/payments/expenses/
// payslips/products/assets by reports.service.js — there's no general
// ledger in this system, so the Balance Sheet's Cash & bank, Accounts
// Payable, Loans and Owner's Equity lines are entered manually here
// (report.manage) rather than computed; everything else is automatic.

const TABS = [
  { key: 'pnl', label: 'Profit & Loss' },
  { key: 'cashflow', label: 'Cash Flow' },
  { key: 'balancesheet', label: 'Balance Sheet' },
  { key: 'araging', label: 'AR Aging' },
  { key: 'expensedetail', label: 'Expense Detail' }
];
const PERIOD_TABS = { pnl: true, cashflow: true, expensedetail: true };
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
      const [p, c, b, a, e] = await Promise.all([
        api.get('/reports/pnl' + qs),
        api.get('/reports/cashflow' + qs),
        api.get('/reports/balance-sheet'),
        api.get('/reports/ar-aging'),
        api.get('/reports/expense-detail' + qs)
      ]);
      setPnl(p); setCashFlow(c); setBalanceSheet(b); setArAging(a); setExpenseDetail(e);
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
      ['Invoice', 'Customer', 'Balance due (GHS)', 'Due date', 'Days overdue', 'Bucket'],
      ...arAging.invoices.map((r) => [r.invoiceNo, r.customerName, r.balanceDue, r.dueDate || '', r.daysOverdue, BUCKET_LABELS[r.bucket]])
    ];
    downloadCsv('ar-aging-' + arAging.asOf + '.csv', rowsToCsv(rows));
  }
  function exportExpenseDetailCsv() {
    if (!expenseDetail) return;
    const rows = [
      ['Expense Detail', from + ' to ' + to],
      [],
      ['Date', 'Category', 'Department', 'Requester', 'Description', 'Amount (GHS)'],
      ...expenseDetail.items.map((r) => [r.date, r.category, r.departmentName, r.requesterName, r.description, r.amount])
    ];
    downloadCsv('expense-detail-' + from + '-to-' + to + '.csv', rowsToCsv(rows));
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  const bucketMax = arAging ? Math.max(1, ...Object.values(arAging.buckets)) : 1;

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
        </div>
      </div>

      <div ref={printRef}>
        {tab === 'pnl' && pnl && (
          <div>
            <div className="finreport-kpis">
              <div className="finreport-kpi"><div className="finreport-kpi-label">Revenue</div><div className="finreport-kpi-value">{money(pnl.revenue)}</div></div>
              <div className="finreport-kpi"><div className="finreport-kpi-label">Expenses</div><div className="finreport-kpi-value">{money(pnl.totalExpenses)}</div></div>
              <div className="finreport-kpi"><div className="finreport-kpi-label">Payroll cost</div><div className="finreport-kpi-value">{money(pnl.payrollCost)}</div></div>
              <div className="finreport-kpi">
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
              <div className="finreport-kpi"><div className="finreport-kpi-label">Cash in</div><div className="finreport-kpi-value">{money(cashFlow.cashIn)}</div></div>
              <div className="finreport-kpi"><div className="finreport-kpi-label">Cash out</div><div className="finreport-kpi-value">{money(cashFlow.cashOut)}</div></div>
              <div className="finreport-kpi">
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
                  <div className="finreport-kpi-value">{money(arAging.buckets[k])}</div>
                  <div className="finreport-bar" style={{ width: Math.round((arAging.buckets[k] / bucketMax) * 100) + '%' }} />
                </div>
              ))}
            </div>
            <table className="table">
              <thead><tr><th>Invoice</th><th>Customer</th><th>Balance due</th><th>Due date</th><th>Days overdue</th></tr></thead>
              <tbody>
                {arAging.invoices.map((r) => (
                  <tr key={r.invoiceNo}>
                    <td style={{ fontWeight: 600 }}>{r.invoiceNo}</td><td>{r.customerName}</td><td>{money(r.balanceDue)}</td>
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
                <h2 className="finreport-section-title">By department</h2>
                <table className="table">
                  <thead><tr><th>Department</th><th>Amount</th></tr></thead>
                  <tbody>{expenseDetail.byDepartment.map((r) => <tr key={r.department}><td>{r.department}</td><td>{money(r.amount)}</td></tr>)}</tbody>
                </table>
              </section>
            </div>
            <h2 className="finreport-section-title">All expenses</h2>
            <table className="table">
              <thead><tr><th>Date</th><th>Category</th><th>Department</th><th>Requester</th><th>Description</th><th>Amount</th></tr></thead>
              <tbody>
                {expenseDetail.items.map((r, i) => (
                  <tr key={i}>
                    <td>{fmtDate(r.date)}</td><td>{r.category}</td><td>{r.departmentName}</td><td>{r.requesterName}</td>
                    <td className="finreport-desc-cell">{r.description || '—'}</td><td>{money(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!expenseDetail.items.length && <p className="table-empty">No expenses recognized in this period.</p>}
          </div>
        )}
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
