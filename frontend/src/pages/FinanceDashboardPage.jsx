import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { money, moneyBreakdown } from '../lib/currency';
import { rowsToCsv, downloadCsv } from '../lib/csvExport';
import './FinanceDashboardPage.css';

// Ported from Bamboo OS.dc.html's finance dashboard screen
// (screens.financedash block + the financeKpis/financeTrend/etc computed
// values around its render()), including the client-side CSV export
// (downloadFinanceCsv) built the same way: an in-browser Blob download,
// no server endpoint involved.
//
// Redesigned around the tone-mix KPI tile language introduced on the
// Dashboard (icon + tone-colored badge per stat, non-interactive since
// these tiles have no drill-down), plus a requester avatar in the
// pending-expenses table.

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
  document: <><rect x="5" y="3.5" width="14" height="17" rx="1.5" stroke="currentColor" strokeWidth="1.6" /><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" /><path d="M12 7.5V12l3.2 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></>,
  warning: <><path d="M12 4 21 19H3L12 4Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M12 10v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><circle cx="12" cy="16.5" r="0.9" fill="currentColor" /></>,
  receipt: <><path d="M6 3.5h12v17l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4v-17Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M8.5 8h7M8.5 11.5h7M8.5 15h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>
};
function Icon({ name }) { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">{ICON_PATHS[name]}</svg>; }

const PERIOD_OPTIONS = [3, 6, 9, 12];

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length > 10 ? iso : iso + 'T00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function FinanceDashboardPage() {
  const [fin, setFin] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [periodType, setPeriodType] = useState('months');
  const [periodCount, setPeriodCount] = useState(6);

  const load = useCallback(async () => {
    setError(null);
    try {
      setFin(await api.get('/reports/finance?periodType=' + periodType + '&periodCount=' + periodCount));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [periodType, periodCount]);

  useEffect(() => { load(); }, [load]);

  function handleDownloadCsv() {
    const data = fin || {};
    const rows = [['Period', 'Revenue collected (GHS)', 'Expenses approved (GHS)']];
    (data.monthlyTrend || []).forEach((m) => rows.push([m.month, m.revenue, m.expense]));
    rows.push([]);
    rows.push(['Metric', 'Value']);
    (data.cashCollectedThisMonthByCurrency || []).forEach((r) => rows.push(['Cash collected this month (' + r.currency + ')', r.amount]));
    rows.push(['Net position this month (' + (data.baseCurrency || 'GHS') + ')', data.netPositionThisMonth || 0]);
    (data.outstandingByCurrency || []).forEach((r) => rows.push(['Outstanding (' + r.currency + ')', r.amount]));
    (data.overdueTotalByCurrency || []).forEach((r) => rows.push(['Overdue total (' + r.currency + ')', r.amount]));
    rows.push(['Pending expense claims', data.pendingExpensesTotal || 0]);
    rows.push(['Expenses approved this month', data.approvedExpensesThisMonth || 0]);
    downloadCsv('finance-summary-' + new Date().toISOString().slice(0, 10) + '.csv', rowsToCsv(rows));
  }

  if (loading) return <div className="eyebrow">Loading…</div>;
  if (error) return <div className="error-banner">{error}</div>;
  if (!fin) return <p className="table-empty">No data yet.</p>;

  const kpis = [
    { label: 'Cash collected this month', value: moneyBreakdown(fin.cashCollectedThisMonthByCurrency), note: '', icon: 'cash', tone: 'people' },
    { label: 'Net position this month', value: money(fin.netPositionThisMonth || 0, fin.baseCurrency), note: 'Collected minus approved expenses, in ' + fin.baseCurrency, icon: 'document', tone: 'ops' },
    { label: 'Outstanding (all invoices)', value: moneyBreakdown(fin.outstandingByCurrency), note: fin.unpaidCount + ' unpaid', icon: 'clock', tone: 'warning' },
    { label: 'Overdue total', value: moneyBreakdown(fin.overdueTotalByCurrency), note: fin.overdueInvoices.length + ' invoice(s)', icon: 'warning', tone: 'danger' },
    { label: 'Pending expense claims', value: 'GHS ' + fin.pendingExpensesTotal.toLocaleString(), note: fin.pendingExpenses.length + ' claim(s)', icon: 'receipt', tone: 'warning' },
    { label: 'Expenses approved this month', value: 'GHS ' + fin.approvedExpensesThisMonth.toLocaleString(), note: '', icon: 'receipt', tone: 'finance' }
  ];

  const trendMax = Math.max(1, ...(fin.monthlyTrend || []).flatMap((m) => [m.revenue, m.expense]));

  return (
    <div>
      <div className="finance-toolbar">
        <button type="button" className="btn btn-secondary" onClick={handleDownloadCsv}>Download CSV</button>
      </div>

      <div className="finance-kpis">
        {kpis.map((k) => (
          <div className={'finance-kpi finance-kpi-' + k.tone} key={k.label}>
            <span className="finance-kpi-icon"><Icon name={k.icon} /></span>
            <div className="finance-kpi-label">{k.label}</div>
            <div className="finance-kpi-value">{k.value}</div>
            <div className="finance-kpi-note">{k.note}</div>
          </div>
        ))}
      </div>

      <div className="finance-columns">
        <section>
          <div className="finance-trend-header">
            <h2 className="finance-section-title">Revenue vs. expenses ({fin.baseCurrency})</h2>
            <div className="finance-period-controls">
              <div className="finance-period-toggle">
                <button type="button" className={periodType === 'months' ? 'is-active' : ''} onClick={() => setPeriodType('months')}>Months</button>
                <button type="button" className={periodType === 'years' ? 'is-active' : ''} onClick={() => setPeriodType('years')}>Years</button>
              </div>
              <select className="input finance-period-count" value={periodCount} onChange={(e) => setPeriodCount(Number(e.target.value))}>
                {PERIOD_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          </div>
          <div className="finance-trend-chart">
            {fin.monthlyTrend.map((m) => (
              <div className="finance-trend-col" key={m.month}>
                <div className="finance-trend-bars">
                  <div className="finance-trend-bar finance-trend-bar-revenue" title={money(m.revenue, fin.baseCurrency)} style={{ height: Math.round((m.revenue / trendMax) * 100) + '%' }} />
                  <div className="finance-trend-bar finance-trend-bar-expense" title={money(m.expense, fin.baseCurrency)} style={{ height: Math.round((m.expense / trendMax) * 100) + '%' }} />
                </div>
                <div className="finance-trend-label">{m.month}</div>
              </div>
            ))}
          </div>
          <div className="finance-trend-legend">
            <div className="finance-legend-item"><span className="finance-legend-swatch finance-legend-revenue" />Revenue collected</div>
            <div className="finance-legend-item"><span className="finance-legend-swatch finance-legend-expense" />Expenses approved</div>
          </div>
        </section>

        <section>
          <h2 className="finance-section-title">Recent payments</h2>
          <table className="table">
            <thead><tr><th>Invoice</th><th>Customer</th><th>Amount</th><th>Date</th><th>Method</th></tr></thead>
            <tbody>
              {fin.recentPayments.map((p, i) => (
                <tr key={i}>
                  <td style={{ fontWeight: 600 }}>{p.invoiceNo}</td><td>{p.customerName}</td>
                  <td>{money(p.amount, p.currency)}</td><td>{fmtDate(p.date)}</td>
                  <td style={{ textTransform: 'capitalize' }}>{p.method.replace('_', ' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!fin.recentPayments.length && <p className="table-empty">No payments recorded yet.</p>}
        </section>
      </div>

      <div className="finance-columns">
        <section>
          <h2 className="finance-section-title">Overdue invoices</h2>
          <table className="table">
            <thead><tr><th>Invoice</th><th>Customer</th><th>Amount</th><th>Overdue by</th></tr></thead>
            <tbody>
              {fin.overdueInvoices.map((inv, i) => (
                <tr key={i}>
                  <td style={{ fontWeight: 600 }}>{inv.invoiceNo}</td><td>{inv.customerName}</td>
                  <td>{money(inv.amount, inv.currency)}</td>
                  <td><span className="tag tag-accent">{inv.daysOverdue} day(s)</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!fin.overdueInvoices.length && <p className="table-empty">No overdue invoices.</p>}
        </section>

        <section>
          <h2 className="finance-section-title">Expense claims awaiting a decision</h2>
          <table className="table">
            <thead><tr><th>Category</th><th>Amount</th><th>Requester</th><th>Group</th></tr></thead>
            <tbody>
              {fin.pendingExpenses.map((e, i) => (
                <tr key={i}>
                  <td>{e.category}</td><td>GHS {e.amount.toLocaleString()}</td>
                  <td>
                    <div className="finance-requester-cell">
                      <span className="finance-avatar" style={{ background: avatarColor(e.requesterName) }}>{initials(e.requesterName)}</span>
                      {e.requesterName}
                    </div>
                  </td>
                  <td>{e.departmentName}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!fin.pendingExpenses.length && <p className="table-empty">Nothing pending.</p>}
        </section>
      </div>
    </div>
  );
}
