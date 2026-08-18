import { useEffect, useState } from 'react';
import { api } from '../api/client';
import './QIOverviewPage.css';

// Ported from Bamboo OS.dc.html's qioverview screen (screens.qioverview
// block + the qiKpis/qiMonthly/qiRecent*/qiUpcomingDue/qiOverdueInvoices
// computed values), backed by GET /api/reports/commercial
// (reportsService.commercialDashboard).

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length > 10 ? iso : iso + 'T00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function docTagClass(bucket) {
  if (bucket === 'approved') return 'tag-neutral';
  if (bucket === 'rejected') return 'tag-accent';
  return 'tag-outline';
}

export default function QIOverviewPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        setData(await api.get('/reports/commercial'));
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

  const kpis = [
    { label: 'Total quotations', value: data.totalQuotations },
    { label: 'Awaiting response', value: data.awaitingResponse },
    { label: 'Accepted', value: data.acceptedQuotations },
    { label: 'Rejected', value: data.rejectedQuotations },
    { label: 'Expired', value: data.expiredQuotations },
    { label: 'Quotation value', value: 'GHS ' + data.totalQuotationValue.toLocaleString() },
    { label: 'Conversion rate', value: data.conversionRate + '%' },
    { label: 'Total invoices', value: data.totalInvoices },
    { label: 'Invoiced amount', value: 'GHS ' + data.totalInvoicedAmount.toLocaleString() },
    { label: 'Total paid', value: 'GHS ' + data.totalPaid.toLocaleString() },
    { label: 'Outstanding balance', value: 'GHS ' + data.outstandingBalance.toLocaleString() },
    { label: 'Overdue invoices', value: data.overdueCount, note: 'GHS ' + data.overdueAmount.toLocaleString() },
    { label: 'Revenue this month', value: 'GHS ' + data.revenueThisMonth.toLocaleString() },
    { label: 'Revenue this year', value: 'GHS ' + data.revenueThisYear.toLocaleString() }
  ];

  const maxInvoiced = data.monthly.length ? Math.max(...data.monthly.map((m) => m.invoiced)) : 0;

  return (
    <div className="qio">
      <div className="qio-kpis">
        {kpis.map((k) => (
          <div key={k.label} className="qio-kpi">
            <div className="qio-kpi-label">{k.label}</div>
            <div className="qio-kpi-value">{k.value}</div>
            {k.note && <div className="qio-kpi-note">{k.note}</div>}
          </div>
        ))}
      </div>

      <section>
        <h2 className="qio-section-title">Invoiced vs collected — last 6 months</h2>
        <table className="table">
          <thead><tr><th>Month</th><th>Invoiced</th><th>Collected</th><th className="qio-bar-col">Invoiced share</th></tr></thead>
          <tbody>
            {data.monthly.map((m) => (
              <tr key={m.month}>
                <td>{m.month}</td>
                <td>GHS {m.invoiced.toLocaleString()}</td>
                <td>GHS {m.paid.toLocaleString()}</td>
                <td>
                  <div className="qio-bar-track">
                    <div className="qio-bar-fill" style={{ width: (maxInvoiced ? Math.round((m.invoiced / maxInvoiced) * 100) : 0) + '%' }} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="qio-columns">
        <section>
          <h2 className="qio-section-title">Recent quotations</h2>
          <table className="table">
            <thead><tr><th>Quote</th><th>Customer</th><th>Total</th><th>Status</th></tr></thead>
            <tbody>
              {data.recentQuotes.map((q, i) => (
                <tr key={i}>
                  <td>{q.quoteNo}</td><td>{q.customerName}</td><td>GHS {q.grandTotal.toLocaleString()}</td>
                  <td><span className={'tag ' + docTagClass(q.status === 'accepted' ? 'approved' : 'pending')}>{q.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          <h2 className="qio-section-title qio-section-title-spaced">Recent invoices</h2>
          <table className="table">
            <thead><tr><th>Invoice</th><th>Customer</th><th>Amount</th><th>Status</th></tr></thead>
            <tbody>
              {data.recentInvoices.map((iv, i) => (
                <tr key={i}>
                  <td>{iv.invoiceNo}</td><td>{iv.customerName}</td><td>GHS {iv.grandTotal.toLocaleString()}</td>
                  <td><span className={'tag ' + docTagClass(iv.status === 'paid' ? 'approved' : 'pending')}>{iv.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section>
          <h2 className="qio-section-title">Upcoming invoice due dates</h2>
          <table className="table">
            <thead><tr><th>Invoice</th><th>Customer</th><th>Amount</th><th>Due</th></tr></thead>
            <tbody>
              {data.upcomingDue.map((iv, i) => (
                <tr key={i}><td>{iv.invoiceNo}</td><td>{iv.customerName}</td><td>GHS {iv.balanceDue.toLocaleString()}</td><td>{fmtDate(iv.dueDate)}</td></tr>
              ))}
            </tbody>
          </table>
          <h2 className="qio-section-title qio-section-title-spaced">Overdue invoices</h2>
          <table className="table">
            <thead><tr><th>Invoice</th><th>Customer</th><th>Amount</th><th>Due</th></tr></thead>
            <tbody>
              {data.overdueInvoices.map((iv, i) => (
                <tr key={i}><td>{iv.invoiceNo}</td><td className="qio-overdue-customer">{iv.customerName}</td><td>GHS {iv.balanceDue.toLocaleString()}</td><td>{fmtDate(iv.dueDate)}</td></tr>
              ))}
            </tbody>
          </table>
          <h2 className="qio-section-title qio-section-title-spaced">Recent payments</h2>
          <table className="table">
            <thead><tr><th>Invoice</th><th>Customer</th><th>Amount</th><th>Date</th></tr></thead>
            <tbody>
              {data.recentPayments.map((p, i) => (
                <tr key={i}><td>{p.invoiceNo}</td><td>{p.customerName}</td><td>GHS {p.amount.toLocaleString()}</td><td>{fmtDate(p.date)}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
