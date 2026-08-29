import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import './FinanceDashboardPage.css';

// Ported from Bamboo OS.dc.html's finance dashboard screen
// (screens.financedash block + the financeKpis/financeTrend/etc computed
// values around its render()), including the client-side CSV export
// (downloadFinanceCsv) built the same way: an in-browser Blob download,
// no server endpoint involved.

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

  function downloadCsv() {
    const data = fin || {};
    const rows = [['Period', 'Revenue collected (GHS)', 'Expenses approved (GHS)']];
    (data.monthlyTrend || []).forEach((m) => rows.push([m.month, m.revenue, m.expense]));
    rows.push([]);
    rows.push(['Metric', 'Value']);
    rows.push(['Cash collected this month', data.cashCollectedThisMonth || 0]);
    rows.push(['Net position this month', data.netPositionThisMonth || 0]);
    rows.push(['Outstanding (all invoices)', data.outstandingTotal || 0]);
    rows.push(['Overdue total', data.overdueTotal || 0]);
    rows.push(['Pending expense claims', data.pendingExpensesTotal || 0]);
    rows.push(['Expenses approved this month', data.approvedExpensesThisMonth || 0]);
    const csv = rows.map((r) => r.map((v) => (typeof v === 'string' && v.indexOf(',') >= 0 ? '"' + v + '"' : v)).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'finance-summary-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) return <div className="eyebrow">Loading…</div>;
  if (error) return <div className="error-banner">{error}</div>;
  if (!fin) return <p className="table-empty">No data yet.</p>;

  const kpis = [
    { label: 'Cash collected this month', value: 'GHS ' + fin.cashCollectedThisMonth.toLocaleString(), note: '' },
    { label: 'Net position this month', value: 'GHS ' + (fin.netPositionThisMonth || 0).toLocaleString(), note: 'Collected minus approved expenses' },
    { label: 'Outstanding (all invoices)', value: 'GHS ' + fin.outstandingTotal.toLocaleString(), note: fin.unpaidCount + ' unpaid' },
    { label: 'Overdue total', value: 'GHS ' + fin.overdueTotal.toLocaleString(), note: fin.overdueInvoices.length + ' invoice(s)' },
    { label: 'Pending expense claims', value: 'GHS ' + fin.pendingExpensesTotal.toLocaleString(), note: fin.pendingExpenses.length + ' claim(s)' },
    { label: 'Expenses approved this month', value: 'GHS ' + fin.approvedExpensesThisMonth.toLocaleString(), note: '' }
  ];

  const trendMax = Math.max(1, ...(fin.monthlyTrend || []).flatMap((m) => [m.revenue, m.expense]));

  return (
    <div>
      <div className="finance-toolbar">
        <button type="button" className="btn btn-secondary" onClick={downloadCsv}>Download CSV</button>
      </div>

      <div className="finance-kpis">
        {kpis.map((k) => (
          <div className="finance-kpi" key={k.label}>
            <div className="finance-kpi-label">{k.label}</div>
            <div className="finance-kpi-value">{k.value}</div>
            <div className="finance-kpi-note">{k.note}</div>
          </div>
        ))}
      </div>

      <div className="finance-columns">
        <section>
          <div className="finance-trend-header">
            <h2 className="finance-section-title">Revenue vs. expenses</h2>
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
                  <div className="finance-trend-bar finance-trend-bar-revenue" title={'GHS ' + m.revenue.toLocaleString()} style={{ height: Math.round((m.revenue / trendMax) * 100) + '%' }} />
                  <div className="finance-trend-bar finance-trend-bar-expense" title={'GHS ' + m.expense.toLocaleString()} style={{ height: Math.round((m.expense / trendMax) * 100) + '%' }} />
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
                  <td>GHS {p.amount.toLocaleString()}</td><td>{fmtDate(p.date)}</td>
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
                  <td>GHS {inv.amount.toLocaleString()}</td>
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
                  <td>{e.category}</td><td>GHS {e.amount.toLocaleString()}</td><td>{e.requesterName}</td><td>{e.departmentName}</td>
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
