import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import './ReportsPage.css';

// Ported from Bamboo OS.dc.html's reports screen (screens.reports block +
// the reportKpis/expenseByCategory/salesByCustomer computed values around
// its render()).

export default function ReportsPage() {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSummary(await api.get('/reports/summary'));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="eyebrow">Loading…</div>;
  if (error) return <div className="error-banner">{error}</div>;

  const kpis = summary ? [
    { label: 'Total invoiced', value: 'GHS ' + (summary.totalInvoiced || 0).toLocaleString() },
    { label: 'Total collected', value: 'GHS ' + (summary.totalPaid || 0).toLocaleString() },
    { label: 'Outstanding', value: 'GHS ' + (summary.outstanding || 0).toLocaleString() },
    { label: 'Sales orders', value: summary.ordersCount || 0 },
    { label: 'Quotations accepted', value: summary.quotationsAccepted || 0 },
    { label: 'Expenses approved', value: 'GHS ' + (summary.totalExpensesApproved || 0).toLocaleString() }
  ] : [];

  const expenseByCategory = (summary && summary.expenseByCategory) || [];
  const salesByCustomer = (summary && summary.salesByCustomer) || [];

  return (
    <div>
      <div className="reports-kpis">
        {kpis.map((k) => (
          <div className="reports-kpi" key={k.label}>
            <div className="reports-kpi-label">{k.label}</div>
            <div className="reports-kpi-value">{k.value}</div>
          </div>
        ))}
      </div>

      <div className="reports-columns">
        <section>
          <h2 className="reports-section-title">Expenses by category</h2>
          <table className="table">
            <thead><tr><th>Category</th><th>Amount</th></tr></thead>
            <tbody>
              {expenseByCategory.map((r) => (
                <tr key={r.category}><td>{r.category}</td><td>GHS {r.amount.toLocaleString()}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
        <section>
          <h2 className="reports-section-title">Sales by customer</h2>
          <table className="table">
            <thead><tr><th>Customer</th><th>Amount</th></tr></thead>
            <tbody>
              {salesByCustomer.map((r) => (
                <tr key={r.customer}><td>{r.customer}</td><td>GHS {r.amount.toLocaleString()}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
      {!summary && <p className="table-empty">No data yet.</p>}
    </div>
  );
}
