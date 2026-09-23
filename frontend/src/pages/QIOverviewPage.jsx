import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { money, moneyBreakdown } from '../lib/currency';
import { tr, activeIntlLocale } from '../lib/i18n.jsx';
import './QIOverviewPage.css';
import { codeLabel } from '../lib/codeLabels.js';

// Ported from Bamboo OS.dc.html's qioverview screen (screens.qioverview
// block + the qiKpis/qiMonthly/qiRecent*/qiUpcomingDue/qiOverdueInvoices
// computed values), backed by GET /api/reports/commercial
// (reportsService.commercialDashboard).
//
// Redesigned around the tone-mix KPI tile language introduced on the
// Dashboard: an icon + tone-colored badge per stat. Non-interactive,
// same as Reports/FinanceDashboard, since these tiles have no
// drill-down destination.

const ICON_PATHS = {
  document: <><rect x="5" y="3.5" width="14" height="17" rx="1.5" stroke="currentColor" strokeWidth="1.6" /><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  cash: <><rect x="2.5" y="6" width="19" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.6" /><circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" /><path d="M12 7.5V12l3.2 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></>,
  check: <><rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" strokeWidth="1.6" /><path d="M8 12.5l2.3 2.3L16 9.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></>,
  warning: <><path d="M12 4 21 19H3L12 4Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M12 10v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><circle cx="12" cy="16.5" r="0.9" fill="currentColor" /></>
};
function Icon({ name }) { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">{ICON_PATHS[name]}</svg>; }

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length > 10 ? iso : iso + 'T00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(activeIntlLocale(), { day: '2-digit', month: 'short', year: 'numeric' });
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

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;
  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return null;

  const kpis = [
    { label: tr('Total quotations'), value: data.totalQuotations, icon: 'document', tone: 'ops' },
    { label: tr('Awaiting response'), value: data.awaitingResponse, icon: 'clock', tone: 'warning' },
    { label: tr('Accepted'), value: data.acceptedQuotations, icon: 'check', tone: 'people' },
    { label: tr('Rejected'), value: data.rejectedQuotations, icon: 'warning', tone: 'danger' },
    { label: tr('Expired'), value: data.expiredQuotations, icon: 'clock', tone: 'danger' },
    { label: tr('Quotation value'), value: moneyBreakdown(data.totalQuotationValueByCurrency), icon: 'cash', tone: 'finance' },
    { label: tr('Conversion rate'), value: data.conversionRate + '%', icon: 'check', tone: 'people' },
    { label: tr('Total invoices'), value: data.totalInvoices, icon: 'document', tone: 'ops' },
    { label: tr('Invoiced amount'), value: moneyBreakdown(data.totalInvoicedByCurrency), icon: 'cash', tone: 'finance' },
    { label: tr('Total paid'), value: moneyBreakdown(data.totalPaidByCurrency), icon: 'cash', tone: 'people' },
    { label: tr('Outstanding balance'), value: moneyBreakdown(data.outstandingByCurrency), icon: 'clock', tone: 'warning' },
    { label: tr('Overdue invoices'), value: data.overdueCount, note: moneyBreakdown(data.overdueAmountByCurrency), icon: 'warning', tone: 'danger' },
    { label: tr('Revenue this month'), value: moneyBreakdown(data.revenueThisMonthByCurrency), icon: 'cash', tone: 'people' },
    { label: tr('Revenue this year'), value: moneyBreakdown(data.revenueThisYearByCurrency), icon: 'cash', tone: 'people' }
  ];

  const maxInvoiced = data.monthly.length ? Math.max(...data.monthly.map((m) => m.invoiced)) : 0;

  return (
    <div className="qio">
      <div className="qio-kpis">
        {kpis.map((k) => (
          <div key={k.label} className={'qio-kpi qio-kpi-' + k.tone}>
            <span className="qio-kpi-icon"><Icon name={k.icon} /></span>
            <div className="qio-kpi-label">{k.label}</div>
            <div className="qio-kpi-value">{k.value}</div>
            {k.note && <div className="qio-kpi-note">{k.note}</div>}
          </div>
        ))}
      </div>

      <section>
        <h2 className="qio-section-title">{tr('Invoiced vs collected — last 6 months (')}{data.baseCurrency})</h2>
        <table className="table">
          <thead><tr><th>{tr('Month')}</th><th>{tr('Invoiced')}</th><th>{tr('Collected')}</th><th className="qio-bar-col">{tr('Invoiced share')}</th></tr></thead>
          <tbody>
            {data.monthly.map((m) => (
              <tr key={m.month}>
                <td>{m.month}</td>
                <td>{money(m.invoiced, data.baseCurrency)}</td>
                <td>{money(m.paid, data.baseCurrency)}</td>
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
          <h2 className="qio-section-title">{tr('Recent quotations')}</h2>
          <table className="table">
            <thead><tr><th>{tr('Quote')}</th><th>{tr('Customer')}</th><th>{tr('Total')}</th><th>{tr('Status')}</th></tr></thead>
            <tbody>
              {data.recentQuotes.map((q, i) => (
                <tr key={i}>
                  <td>{q.quoteNo}</td><td>{q.customerName}</td><td>{money(q.grandTotal, q.currency)}</td>
                  <td><span className={'tag ' + docTagClass(q.status === 'accepted' ? 'approved' : 'pending')}>{codeLabel(q.status)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          <h2 className="qio-section-title qio-section-title-spaced">{tr('Recent invoices')}</h2>
          <table className="table">
            <thead><tr><th>{tr('Invoice')}</th><th>{tr('Customer')}</th><th>{tr('Amount')}</th><th>{tr('Status')}</th></tr></thead>
            <tbody>
              {data.recentInvoices.map((iv, i) => (
                <tr key={i}>
                  <td>{iv.invoiceNo}</td><td>{iv.customerName}</td><td>{money(iv.grandTotal, iv.currency)}</td>
                  <td><span className={'tag ' + docTagClass(iv.status === 'paid' ? 'approved' : 'pending')}>{codeLabel(iv.status)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section>
          <h2 className="qio-section-title">{tr('Upcoming invoice due dates')}</h2>
          <table className="table">
            <thead><tr><th>{tr('Invoice')}</th><th>{tr('Customer')}</th><th>{tr('Amount')}</th><th>{tr('Due')}</th></tr></thead>
            <tbody>
              {data.upcomingDue.map((iv, i) => (
                <tr key={i}><td>{iv.invoiceNo}</td><td>{iv.customerName}</td><td>{money(iv.balanceDue, iv.currency)}</td><td>{fmtDate(iv.dueDate)}</td></tr>
              ))}
            </tbody>
          </table>
          <h2 className="qio-section-title qio-section-title-spaced">{tr('Overdue invoices')}</h2>
          <table className="table">
            <thead><tr><th>{tr('Invoice')}</th><th>{tr('Customer')}</th><th>{tr('Amount')}</th><th>{tr('Due')}</th></tr></thead>
            <tbody>
              {data.overdueInvoices.map((iv, i) => (
                <tr key={i}><td>{iv.invoiceNo}</td><td className="qio-overdue-customer">{iv.customerName}</td><td>{money(iv.balanceDue, iv.currency)}</td><td>{fmtDate(iv.dueDate)}</td></tr>
              ))}
            </tbody>
          </table>
          <h2 className="qio-section-title qio-section-title-spaced">{tr('Recent payments')}</h2>
          <table className="table">
            <thead><tr><th>{tr('Invoice')}</th><th>{tr('Customer')}</th><th>{tr('Amount')}</th><th>{tr('Date')}</th></tr></thead>
            <tbody>
              {data.recentPayments.map((p, i) => (
                <tr key={i}><td>{p.invoiceNo}</td><td>{p.customerName}</td><td>{money(p.amount, p.currency)}</td><td>{fmtDate(p.date)}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
