import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { shareOrDownloadPdf } from '../lib/documentShare';
import { rowsToCsv, downloadCsv } from '../lib/csvExport';
import { money as moneyFmt, moneyBreakdown } from '../lib/currency';
import { tr, msg, activeIntlLocale } from '../lib/i18n.jsx';
import './FinancialReportsPage.css';
import { codeLabel } from '../lib/codeLabels.js';

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
  { key: 'pnl', label: msg('Profit & Loss') },
  { key: 'cashflow', label: msg('Cash Flow') },
  { key: 'balancesheet', label: msg('Balance Sheet') },
  { key: 'araging', label: msg('AR Aging') },
  { key: 'expensedetail', label: msg('Expense Detail') },
  { key: 'taxsummary', label: msg('Tax Summary') }
];
const PERIOD_TABS = { pnl: true, cashflow: true, expensedetail: true, taxsummary: true };
const BUCKET_LABELS = { current: msg('Current'), d1_30: msg('1–30 days'), d31_60: msg('31–60 days'), d61_90: msg('61–90 days'), d90_plus: msg('90+ days') };

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length > 10 ? iso : iso + 'T00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(activeIntlLocale(), { day: '2-digit', month: 'short', year: 'numeric' });
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
      [tr('Profit & Loss'), tr('{from} to {to}', { from, to })],
      [],
      [tr('Metric'), tr('Amount (GHS)')],
      [tr('Revenue'), pnl.revenue],
      [tr('Total expenses'), pnl.totalExpenses],
      [tr('Payroll cost'), pnl.payrollCost],
      [tr('Net profit'), pnl.netProfit],
      [],
      [tr('Expense category'), tr('Amount (GHS)')],
      ...pnl.expenseByCategory.map((r) => [r.category, r.amount])
    ];
    downloadCsv('profit-and-loss-' + from + '-to-' + to + '.csv', rowsToCsv(rows));
  }
  function exportCashFlowCsv() {
    if (!cashFlow) return;
    const rows = [
      [tr('Cash Flow'), tr('{from} to {to}', { from, to })],
      [],
      [tr('Metric'), tr('Amount (GHS)')],
      [tr('Cash in'), cashFlow.cashIn],
      [tr('Expenses paid out'), cashFlow.expensesOut],
      [tr('Payroll paid out'), cashFlow.payrollOut],
      [tr('Net cash flow'), cashFlow.netCashFlow],
      [],
      [tr('Cash in by method'), tr('Amount (GHS)')],
      ...cashFlow.cashInByMethod.map((r) => [r.method, r.amount])
    ];
    downloadCsv('cash-flow-' + from + '-to-' + to + '.csv', rowsToCsv(rows));
  }
  function exportBalanceSheetCsv() {
    if (!balanceSheet) return;
    const rows = [
      [tr('Balance Sheet'), tr('as of {asOf}', { asOf: balanceSheet.asOf })],
      [],
      [tr('Assets'), tr('Amount (GHS)')],
      [tr('Cash & bank'), balanceSheet.assets.cashAndBank],
      [tr('Accounts receivable'), balanceSheet.assets.accountsReceivable],
      [tr('Inventory'), balanceSheet.assets.inventoryValue],
      [tr('Fixed assets (at cost)'), balanceSheet.assets.fixedAssets],
      [tr('Total assets'), balanceSheet.assets.total],
      [],
      [tr('Liabilities'), tr('Amount (GHS)')],
      [tr('Accounts payable'), balanceSheet.liabilities.accountsPayable],
      [tr('Loans payable'), balanceSheet.liabilities.loansPayable],
      [tr('Other liabilities'), balanceSheet.liabilities.otherLiabilities],
      [tr('Total liabilities'), balanceSheet.liabilities.total],
      [],
      [tr('Equity'), tr('Amount (GHS)')],
      [tr('Owner\'s equity'), balanceSheet.equity.ownersEquity],
      [tr('Retained earnings'), balanceSheet.equity.retainedEarnings],
      [tr('Total equity'), balanceSheet.equity.total]
    ];
    downloadCsv('balance-sheet-' + balanceSheet.asOf + '.csv', rowsToCsv(rows));
  }
  function exportArAgingCsv() {
    if (!arAging) return;
    const rows = [
      [tr('AR Aging'), tr('as of {asOf}', { asOf: arAging.asOf })],
      [],
      [tr('Invoice'), tr('Customer'), tr('Currency'), tr('Balance due'), tr('Due date'), tr('Days overdue'), tr('Bucket')],
      ...arAging.invoices.map((r) => [r.invoiceNo, r.customerName, r.currency, r.balanceDue, r.dueDate || '', r.daysOverdue, tr(BUCKET_LABELS[r.bucket])])
    ];
    downloadCsv('ar-aging-' + arAging.asOf + '.csv', rowsToCsv(rows));
  }
  function exportTaxSummaryCsv() {
    if (!taxSummary) return;
    const rows = [
      [tr('Tax Summary'), tr('{from} to {to}', { from, to })],
      [],
      [tr('Rate'), tr('Tax(es)'), tr('Taxable base (GHS)'), tr('Tax collected (GHS)'), tr('Invoices')],
      ...taxSummary.byRate.map((r) => [r.rate + '%', r.label, r.taxableBase, r.taxCollected, r.invoiceCount]),
      [],
      [tr('Total tax (from line items)'), taxSummary.totalTaxFromLineItems],
      [tr('Total tax (recorded on invoices)'), taxSummary.recordedTaxTotal],
      [tr('Reconciliation difference'), taxSummary.reconciliationDiff]
    ];
    downloadCsv('tax-summary-' + from + '-to-' + to + '.csv', rowsToCsv(rows));
  }
  function exportExpenseDetailCsv() {
    if (!expenseDetail) return;
    const rows = [
      [tr('Expense Detail'), tr('{from} to {to}', { from, to })],
      [],
      [tr('Date'), tr('Category'), tr('Group'), tr('Requester'), tr('Description'), tr('Amount (GHS)')],
      ...expenseDetail.items.map((r) => [r.date, r.category, r.departmentName, r.requesterName, r.description, r.amount])
    ];
    downloadCsv('expense-detail-' + from + '-to-' + to + '.csv', rowsToCsv(rows));
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

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
        {tr('Built from invoices, payments, expenses and payroll already in Bamboo OS — there\'s no general ledger here, so the Balance Sheet\'s Cash & bank, Accounts Payable, Loans and Owner\'s Equity figures are entered manually below; everything else updates automatically.')}
      </p>

      <div className="finreport-tabs">
        {TABS.map((t) => (
          <button key={t.key} type="button" className={'finreport-tab' + (tab === t.key ? ' finreport-tab-active' : '')} onClick={() => setTab(t.key)}>
            {tr(t.label)}
          </button>
        ))}
      </div>

      <div className="finreport-toolbar">
        {PERIOD_TABS[tab] && (
          <div className="finreport-period">
            <label>{tr('From')} <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label>{tr('To')} <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          </div>
        )}
        <div className="finreport-toolbar-actions">
          <button type="button" className="btn btn-secondary" disabled={exporting} onClick={() => downloadPdf(tab + '-' + todayISO() + '.pdf')}>
            {exporting ? tr('Preparing…') : tr('Download PDF')}
          </button>
          {tab === 'pnl' && <button type="button" className="btn btn-secondary" onClick={exportPnlCsv}>{tr('Download CSV')}</button>}
          {tab === 'cashflow' && <button type="button" className="btn btn-secondary" onClick={exportCashFlowCsv}>{tr('Download CSV')}</button>}
          {tab === 'balancesheet' && <button type="button" className="btn btn-secondary" onClick={exportBalanceSheetCsv}>{tr('Download CSV')}</button>}
          {tab === 'araging' && <button type="button" className="btn btn-secondary" onClick={exportArAgingCsv}>{tr('Download CSV')}</button>}
          {tab === 'expensedetail' && <button type="button" className="btn btn-secondary" onClick={exportExpenseDetailCsv}>{tr('Download CSV')}</button>}
          {tab === 'taxsummary' && <button type="button" className="btn btn-secondary" onClick={exportTaxSummaryCsv}>{tr('Download CSV')}</button>}
        </div>
      </div>

      {['pnl', 'cashflow', 'balancesheet', 'taxsummary'].includes(tab) && (
        <p className="finreport-asof">
          {tr("Totalled in the company's base currency ({currency}) — a document in another currency (Company settings → Enabled currencies) won't appear here, but still shows correctly on its own record and in the Invoices/Quotations lists.", {
            currency: (pnl && pnl.baseCurrency) || (cashFlow && cashFlow.baseCurrency) || (balanceSheet && balanceSheet.baseCurrency) || (taxSummary && taxSummary.baseCurrency) || 'GHS'
          })}
        </p>
      )}

      <div ref={printRef}>
        {tab === 'pnl' && pnl && (
          <div>
            <div className="finreport-kpis">
              <div className="finreport-kpi finreport-kpi-people"><span className="finreport-kpi-icon"><Icon name="cash" /></span><div className="finreport-kpi-label">{tr('Revenue')}</div><div className="finreport-kpi-value">{money(pnl.revenue)}</div></div>
              <div className="finreport-kpi finreport-kpi-warning"><span className="finreport-kpi-icon"><Icon name="receipt" /></span><div className="finreport-kpi-label">{tr('Expenses')}</div><div className="finreport-kpi-value">{money(pnl.totalExpenses)}</div></div>
              <div className="finreport-kpi finreport-kpi-finance"><span className="finreport-kpi-icon"><Icon name="users" /></span><div className="finreport-kpi-label">{tr('Payroll cost')}</div><div className="finreport-kpi-value">{money(pnl.payrollCost)}</div></div>
              <div className="finreport-kpi finreport-kpi-ops">
                <span className="finreport-kpi-icon"><Icon name="document" /></span>
                <div className="finreport-kpi-label">{tr('Net profit')}</div>
                <div className={'finreport-kpi-value' + (pnl.netProfit < 0 ? ' finreport-negative' : '')}>{money(pnl.netProfit)}</div>
              </div>
            </div>
            <h2 className="finreport-section-title">{tr('Expenses by category')}</h2>
            <table className="table">
              <thead><tr><th>{tr('Category')}</th><th>{tr('Amount')}</th></tr></thead>
              <tbody>
                {pnl.expenseByCategory.map((r) => <tr key={r.category}><td>{r.category}</td><td>{money(r.amount)}</td></tr>)}
              </tbody>
            </table>
            {!pnl.expenseByCategory.length && <p className="table-empty">{tr('No expenses recognized in this period.')}</p>}
          </div>
        )}

        {tab === 'cashflow' && cashFlow && (
          <div>
            <div className="finreport-kpis">
              <div className="finreport-kpi finreport-kpi-people"><span className="finreport-kpi-icon"><Icon name="cash" /></span><div className="finreport-kpi-label">{tr('Cash in')}</div><div className="finreport-kpi-value">{money(cashFlow.cashIn)}</div></div>
              <div className="finreport-kpi finreport-kpi-warning"><span className="finreport-kpi-icon"><Icon name="receipt" /></span><div className="finreport-kpi-label">{tr('Cash out')}</div><div className="finreport-kpi-value">{money(cashFlow.cashOut)}</div></div>
              <div className="finreport-kpi finreport-kpi-ops">
                <span className="finreport-kpi-icon"><Icon name="document" /></span>
                <div className="finreport-kpi-label">{tr('Net cash flow')}</div>
                <div className={'finreport-kpi-value' + (cashFlow.netCashFlow < 0 ? ' finreport-negative' : '')}>{money(cashFlow.netCashFlow)}</div>
              </div>
            </div>
            <h2 className="finreport-section-title">{tr('Cash in by method')}</h2>
            <table className="table">
              <thead><tr><th>{tr('Method')}</th><th>{tr('Amount')}</th></tr></thead>
              <tbody>
                {cashFlow.cashInByMethod.map((r) => <tr key={r.method}><td>{codeLabel(r.method)}</td><td>{money(r.amount)}</td></tr>)}
              </tbody>
            </table>
            {!cashFlow.cashInByMethod.length && <p className="table-empty">{tr('No payments received in this period.')}</p>}
          </div>
        )}

        {tab === 'balancesheet' && balanceSheet && (
          <div>
            <div className={'finreport-balance-banner' + (Math.abs(balanceSheet.balanceCheck) < 0.01 ? ' finreport-balanced' : ' finreport-unbalanced')}>
              {Math.abs(balanceSheet.balanceCheck) < 0.01
                ? tr('Balanced — assets equal liabilities plus equity.')
                : tr('Off by {amount} — check the manual inputs below (Cash & bank is usually the figure to correct).', { amount: money(Math.abs(balanceSheet.balanceCheck)) })}
            </div>
            <p className="finreport-asof">{tr('As of')} {fmtDate(balanceSheet.asOf)}</p>

            <div className="finreport-bs-columns">
              <section>
                <h2 className="finreport-section-title">{tr('Assets')}</h2>
                <table className="table">
                  <tbody>
                    <tr><td>{tr('Cash & bank')}</td><td>{money(balanceSheet.assets.cashAndBank)}</td></tr>
                    <tr><td>{tr('Accounts receivable')}</td><td>{money(balanceSheet.assets.accountsReceivable)}</td></tr>
                    <tr><td>{tr('Inventory')}</td><td>{money(balanceSheet.assets.inventoryValue)}</td></tr>
                    <tr><td>{tr('Fixed assets (at cost)')}</td><td>{money(balanceSheet.assets.fixedAssets)}</td></tr>
                    <tr className="finreport-total-row"><td>{tr('Total assets')}</td><td>{money(balanceSheet.assets.total)}</td></tr>
                  </tbody>
                </table>
              </section>
              <section>
                <h2 className="finreport-section-title">{tr('Liabilities')}</h2>
                <table className="table">
                  <tbody>
                    <tr><td>{tr('Accounts payable')}</td><td>{money(balanceSheet.liabilities.accountsPayable)}</td></tr>
                    <tr><td>{tr('Loans payable')}</td><td>{money(balanceSheet.liabilities.loansPayable)}</td></tr>
                    <tr><td>{tr('Other liabilities')}</td><td>{money(balanceSheet.liabilities.otherLiabilities)}</td></tr>
                    <tr className="finreport-total-row"><td>{tr('Total liabilities')}</td><td>{money(balanceSheet.liabilities.total)}</td></tr>
                  </tbody>
                </table>
                <h2 className="finreport-section-title">{tr('Equity')}</h2>
                <table className="table">
                  <tbody>
                    <tr><td>{tr('Owner\'s equity')}</td><td>{money(balanceSheet.equity.ownersEquity)}</td></tr>
                    <tr><td>{tr('Retained earnings')}</td><td>{money(balanceSheet.equity.retainedEarnings)}</td></tr>
                    <tr className="finreport-total-row"><td>{tr('Total equity')}</td><td>{money(balanceSheet.equity.total)}</td></tr>
                  </tbody>
                </table>
              </section>
            </div>

            {canManageBs && (
              <form className="finreport-bs-form no-print" onSubmit={saveBsInputs}>
                <h2 className="finreport-section-title">{tr('Edit manual inputs')}</h2>
                <div className="finreport-bs-fields">
                  <div className="field"><label>{tr('Cash & bank')}</label><input className="input" type="number" step="0.01" value={bsForm.cashAndBank} onChange={(e) => setBsForm({ ...bsForm, cashAndBank: e.target.value })} /></div>
                  <div className="field"><label>{tr('Accounts payable')}</label><input className="input" type="number" step="0.01" value={bsForm.accountsPayable} onChange={(e) => setBsForm({ ...bsForm, accountsPayable: e.target.value })} /></div>
                  <div className="field"><label>{tr('Loans payable')}</label><input className="input" type="number" step="0.01" value={bsForm.loansPayable} onChange={(e) => setBsForm({ ...bsForm, loansPayable: e.target.value })} /></div>
                  <div className="field"><label>{tr('Other liabilities')}</label><input className="input" type="number" step="0.01" value={bsForm.otherLiabilities} onChange={(e) => setBsForm({ ...bsForm, otherLiabilities: e.target.value })} /></div>
                  <div className="field"><label>{tr('Owner\'s equity')}</label><input className="input" type="number" step="0.01" value={bsForm.ownersEquity} onChange={(e) => setBsForm({ ...bsForm, ownersEquity: e.target.value })} /></div>
                </div>
                <div className="field">
                  <label>{tr('Notes')}</label>
                  <textarea className="input" value={bsForm.notes} onChange={(e) => setBsForm({ ...bsForm, notes: e.target.value })} placeholder={tr('E.g. loan source, last reconciled date…')} />
                </div>
                <button type="submit" className="btn btn-primary" disabled={savingBs}>{savingBs ? tr('Saving…') : tr('Save manual inputs')}</button>
              </form>
            )}
          </div>
        )}

        {tab === 'araging' && arAging && (
          <div>
            <p className="finreport-asof">{tr('As of')} {fmtDate(arAging.asOf)}</p>
            <div className="finreport-kpis">
              {Object.keys(BUCKET_LABELS).map((k) => (
                <div className="finreport-kpi" key={k}>
                  <div className="finreport-kpi-label">{tr(BUCKET_LABELS[k])}</div>
                  <div className="finreport-kpi-value">{moneyBreakdown(arAging.buckets[k])}</div>
                  <div className="finreport-bar" style={{ width: Math.round((bucketSum(arAging.buckets[k]) / bucketMax) * 100) + '%' }} />
                </div>
              ))}
            </div>
            <table className="table">
              <thead><tr><th>{tr('Invoice')}</th><th>{tr('Customer')}</th><th>{tr('Balance due')}</th><th>{tr('Due date')}</th><th>{tr('Days overdue')}</th></tr></thead>
              <tbody>
                {arAging.invoices.map((r) => (
                  <tr key={r.invoiceNo}>
                    <td style={{ fontWeight: 600 }}>{r.invoiceNo}</td><td>{r.customerName}</td><td>{moneyFmt(r.balanceDue, r.currency)}</td>
                    <td>{fmtDate(r.dueDate)}</td>
                    <td><span className={'tag ' + (r.bucket === 'current' ? 'tag-outline' : 'tag-accent')}>{tr(BUCKET_LABELS[r.bucket])}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!arAging.invoices.length && <p className="table-empty">{tr('No outstanding balances.')}</p>}
          </div>
        )}

        {tab === 'expensedetail' && expenseDetail && (
          <div>
            <div className="finreport-columns">
              <section>
                <h2 className="finreport-section-title">{tr('By category')}</h2>
                <table className="table">
                  <thead><tr><th>{tr('Category')}</th><th>{tr('Amount')}</th></tr></thead>
                  <tbody>{expenseDetail.byCategory.map((r) => <tr key={r.category}><td>{r.category}</td><td>{money(r.amount)}</td></tr>)}</tbody>
                </table>
              </section>
              <section>
                <h2 className="finreport-section-title">{tr('By group')}</h2>
                <table className="table">
                  <thead><tr><th>{tr('Group')}</th><th>{tr('Amount')}</th></tr></thead>
                  <tbody>{expenseDetail.byDepartment.map((r) => <tr key={r.department}><td>{r.department}</td><td>{money(r.amount)}</td></tr>)}</tbody>
                </table>
              </section>
            </div>
            <h2 className="finreport-section-title">{tr('All expenses')}</h2>
            <table className="table">
              <thead><tr><th>{tr('Date')}</th><th>{tr('Category')}</th><th>{tr('Group')}</th><th>{tr('Requester')}</th><th>{tr('Description')}</th><th>{tr('Amount')}</th></tr></thead>
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
            {!expenseDetail.items.length && <p className="table-empty">{tr('No expenses recognized in this period.')}</p>}
          </div>
        )}

        {tab === 'taxsummary' && taxSummary && (
          <div>
            <p className="finreport-tax-note">
              {tr('Grouped by the exact tax rate found on each invoice line — where two configured taxes share a rate (e.g. NHIL and GETFund both default to 2.5%), the label shows both rather than guessing which applies.')}
            </p>
            <table className="table">
              <thead><tr><th>{tr('Rate')}</th><th>{tr('Tax(es)')}</th><th>{tr('Taxable base')}</th><th>{tr('Tax collected')}</th><th>{tr('Invoices')}</th></tr></thead>
              <tbody>
                {taxSummary.byRate.map((r) => (
                  <tr key={r.rate}>
                    <td>{r.rate}%</td><td>{r.label}</td><td>{money(r.taxableBase)}</td><td>{money(r.taxCollected)}</td><td>{r.invoiceCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!taxSummary.byRate.length && <p className="table-empty">{tr('No invoices issued in this period.')}</p>}

            <div className={'finreport-balance-banner' + (Math.abs(taxSummary.reconciliationDiff) < 0.01 ? ' finreport-balanced' : ' finreport-unbalanced')} style={{ marginTop: 16 }}>
              {Math.abs(taxSummary.reconciliationDiff) < 0.01
                ? tr('Reconciled — line-item tax matches each invoice’s recorded total.')
                : tr('Off by {amount} vs. invoices’ recorded tax totals — likely a document-level tax rate applied outside the line items.', { amount: money(Math.abs(taxSummary.reconciliationDiff)) })}
            </div>
          </div>
        )}
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
