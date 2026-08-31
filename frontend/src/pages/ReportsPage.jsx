import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import './ReportsPage.css';

// Ported from Bamboo OS.dc.html's reports screen (screens.reports block +
// the reportKpis/expenseByCategory/salesByCustomer computed values around
// its render()).
//
// Redesigned around the tone-mix KPI tile language introduced on the
// Dashboard: an icon + tone-colored badge per stat. These tiles have no
// drill-down destination, so — unlike Dashboard's — they're plain,
// non-interactive divs (no hover-lift, no cursor pointer, no arrow).

const ICON_PATHS = {
  document: <><rect x="5" y="3.5" width="14" height="17" rx="1.5" stroke="currentColor" strokeWidth="1.6" /><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  cash: <><rect x="2.5" y="6" width="19" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.6" /><circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" /><path d="M12 7.5V12l3.2 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></>,
  cart: <><path d="M3 4h2.2l2 11.5h10.6l1.7-8.2H6.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /><circle cx="9.5" cy="19.5" r="1.3" stroke="currentColor" strokeWidth="1.6" /><circle cx="16.5" cy="19.5" r="1.3" stroke="currentColor" strokeWidth="1.6" /></>,
  check: <><rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" strokeWidth="1.6" /><path d="M8 12.5l2.3 2.3L16 9.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></>,
  receipt: <><path d="M6 3.5h12v17l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4v-17Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M8.5 8h7M8.5 11.5h7M8.5 15h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>
};
function Icon({ name }) { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">{ICON_PATHS[name]}</svg>; }

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
    { label: 'Total invoiced', value: 'GHS ' + (summary.totalInvoiced || 0).toLocaleString(), icon: 'document', tone: 'finance' },
    { label: 'Total collected', value: 'GHS ' + (summary.totalPaid || 0).toLocaleString(), icon: 'cash', tone: 'people' },
    { label: 'Outstanding', value: 'GHS ' + (summary.outstanding || 0).toLocaleString(), icon: 'clock', tone: 'warning' },
    { label: 'Sales orders', value: summary.ordersCount || 0, icon: 'cart', tone: 'ops' },
    { label: 'Quotations accepted', value: summary.quotationsAccepted || 0, icon: 'check', tone: 'people' },
    { label: 'Expenses approved', value: 'GHS ' + (summary.totalExpensesApproved || 0).toLocaleString(), icon: 'receipt', tone: 'finance' }
  ] : [];

  const expenseByCategory = (summary && summary.expenseByCategory) || [];
  const salesByCustomer = (summary && summary.salesByCustomer) || [];

  return (
    <div>
      <div className="reports-kpis">
        {kpis.map((k) => (
          <div className={'reports-kpi reports-kpi-' + k.tone} key={k.label}>
            <span className="reports-kpi-icon"><Icon name={k.icon} /></span>
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
