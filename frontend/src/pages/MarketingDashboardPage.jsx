import { useEffect, useState } from 'react';
import { api } from '../api/client';
import './MarketingDashboardPage.css';

// Ported from Bamboo OS.dc.html's marketing screen (screens.marketing
// block + the pipeline/funnel/topCustomers/leadsList/recentQuotesM
// computed values), backed by GET /api/reports/marketing
// (reportsService.marketingDashboard, requires customer.read — same
// permission navModel.js gates this nav entry on).
//
// Redesigned around the icon language established elsewhere: icon+tone
// funnel tiles (mirroring Reports/QIOverview), a building badge per lead
// (a company, not a person, mirroring Customers/Suppliers) plus an
// avatar for the named contact person.

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
function badgeColor(name) { return AVATAR_COLORS[hashStr(name || '') % AVATAR_COLORS.length]; }

function BuildingIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="5" y="3" width="9" height="18" stroke="currentColor" strokeWidth="1.6" />
      <rect x="14" y="9" width="6" height="12" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 7h1M8 11h1M8 15h1M11 7h1M11 11h1M11 15h1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
const ICON_PATHS = {
  document: <><rect x="5" y="3.5" width="14" height="17" rx="1.5" stroke="currentColor" strokeWidth="1.6" /><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  check: <><rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" strokeWidth="1.6" /><path d="M8 12.5l2.3 2.3L16 9.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></>,
  warning: <><path d="M12 4 21 19H3L12 4Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M12 10v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><circle cx="12" cy="16.5" r="0.9" fill="currentColor" /></>,
  cart: <><path d="M3 4h2.2l2 11.5h10.6l1.7-8.2H6.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /><circle cx="9.5" cy="19.5" r="1.3" stroke="currentColor" strokeWidth="1.6" /><circle cx="16.5" cy="19.5" r="1.3" stroke="currentColor" strokeWidth="1.6" /></>
};
function Icon({ name }) { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">{ICON_PATHS[name]}</svg>; }

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
    { label: 'Quotations sent', value: data.funnel.sent, icon: 'document', tone: 'ops' },
    { label: 'Accepted', value: data.funnel.accepted, icon: 'check', tone: 'people' },
    { label: 'Rejected / expired', value: data.funnel.rejected, icon: 'warning', tone: 'danger' },
    { label: 'Conversion rate', value: data.funnel.conversionRate + '%', icon: 'cart', tone: 'finance' }
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
              <div key={f.label} className={'mkt-funnel-tile mkt-funnel-tile-' + f.tone}>
                <span className="mkt-funnel-icon"><Icon name={f.icon} /></span>
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
                <td>
                  <div className="mkt-name-cell">
                    <span className="mkt-badge" style={{ background: badgeColor(l.name) }}><BuildingIcon /></span>
                    <span style={{ fontWeight: 600 }}>{l.name}</span>
                  </div>
                </td>
                <td>
                  {l.contactPerson ? (
                    <div className="mkt-contact-person-cell">
                      <span className="mkt-avatar" style={{ background: avatarColor(l.contactPerson) }}>{initials(l.contactPerson)}</span>
                      {l.contactPerson}
                    </div>
                  ) : '—'}
                </td>
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
