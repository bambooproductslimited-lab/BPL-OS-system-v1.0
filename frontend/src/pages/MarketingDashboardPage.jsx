import { useEffect, useState } from 'react';
import { api } from '../api/client';
import './MarketingDashboardPage.css';

// Ported from Bamboo OS.dc.html's marketing screen (screens.marketing
// block + the pipeline/funnel/topCustomers/leadsList/recentQuotesM
// computed values), backed by GET /api/reports/marketing
// (reportsService.marketingDashboard, requires customer.read — same
// permission navModel.js gates this nav entry on).

function docTagClass(bucket) {
  if (bucket === 'approved') return 'tag-neutral';
  if (bucket === 'rejected') return 'tag-accent';
  return 'tag-outline';
}

export default function MarketingDashboardPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        setData(await api.get('/reports/marketing'));
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div className="eyebrow">Loading…</div>;
  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return null;

  const pipeline = data.pipeline.map((p) => ({
    label: p.category, count: p.count,
    share: data.totalCustomers ? Math.round((p.count / data.totalCustomers) * 100) : 0
  }));
  const funnel = [
    { label: 'Quotations sent', value: data.funnel.sent },
    { label: 'Accepted', value: data.funnel.accepted },
    { label: 'Rejected / expired', value: data.funnel.rejected },
    { label: 'Conversion rate', value: data.funnel.conversionRate + '%' }
  ];

  return (
    <div className="mkt">
      <div className="mkt-top">
        <section>
          <h2 className="mkt-section-title">Customer pipeline</h2>
          <table className="table">
            <thead><tr><th>Category</th><th>Customers</th><th className="mkt-share-col">Share</th></tr></thead>
            <tbody>
              {pipeline.map((p) => (
                <tr key={p.label}>
                  <td className="mkt-capitalize">{p.label}</td><td>{p.count}</td>
                  <td>
                    <div className="mkt-bar-track"><div className="mkt-bar-fill" style={{ width: p.share + '%' }} /></div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2 className="mkt-section-title mkt-section-title-spaced">Quotation funnel</h2>
          <div className="mkt-funnel">
            {funnel.map((f) => (
              <div key={f.label} className="mkt-funnel-tile">
                <div className="mkt-funnel-label">{f.label}</div>
                <div className="mkt-funnel-value">{f.value}</div>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2 className="mkt-section-title">Top customers by sales value</h2>
          <table className="table">
            <thead><tr><th>Customer</th><th>Total</th></tr></thead>
            <tbody>
              {data.topCustomers.map((c, i) => <tr key={i}><td>{c.name}</td><td>GHS {c.total.toLocaleString()}</td></tr>)}
            </tbody>
          </table>

          <h2 className="mkt-section-title mkt-section-title-spaced">Recent quotations</h2>
          <table className="table">
            <thead><tr><th>Quote</th><th>Customer</th><th>Total</th><th>Status</th></tr></thead>
            <tbody>
              {data.recentQuotes.map((q, i) => (
                <tr key={i}>
                  <td>{q.quoteNo}</td><td>{q.customerName}</td><td>GHS {q.total.toLocaleString()}</td>
                  <td><span className={'tag ' + docTagClass(q.status === 'accepted' ? 'approved' : (q.status === 'rejected' || q.status === 'expired') ? 'rejected' : 'pending')}>{q.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <section>
        <h2 className="mkt-section-title">Leads &amp; prospects to follow up</h2>
        <table className="table">
          <thead><tr><th>Customer</th><th>Contact</th><th>Email / phone</th><th>Category</th><th>Account manager</th></tr></thead>
          <tbody>
            {data.leads.map((l, i) => (
              <tr key={i}>
                <td style={{ fontWeight: 600 }}>{l.name}</td><td>{l.contactPerson}</td>
                <td className="mkt-contact-cell">{l.email}<br />{l.phone}</td>
                <td><span className={'tag ' + docTagClass(l.category === 'lead' ? 'pending' : 'approved')}>{l.category}</span></td>
                <td>{l.managerName}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data.leads.length && <p className="table-empty">No leads or prospects to follow up right now.</p>}
      </section>
    </div>
  );
}
