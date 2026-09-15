import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { money } from '../lib/currency';
import './PokiPages.css';

// Poki rentals — the overview a landlord opens first: how much of the
// portfolio is earning, what's owed, and what needs attention this quarter.

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).length > 10 ? iso : iso + 'T00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function daysUntil(iso) {
  if (!iso) return null;
  const end = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  return Math.round((end - today) / 86400000);
}

export default function PokiDashboardPage() {
  const [data, setData] = useState(null);
  const [arrears, setArrears] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [o, a] = await Promise.all([api.get('/poki/overview'), api.get('/poki/arrears')]);
      setData(o);
      setArrears(a);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="eyebrow">Loading…</div>;
  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return null;

  const u = data.units;

  return (
    <div>
      <div className="poki-stats">
        <div className="poki-stat">
          <div className="poki-stat-label">Occupancy</div>
          <div className="poki-stat-value">{u.occupancyRate}%</div>
          <div className="poki-stat-sub">{u.occupied} of {u.total} units let</div>
          <div className="poki-occupancy-bar">
            <div className="poki-occupancy-fill" style={{ width: Math.min(100, u.occupancyRate) + '%' }} />
          </div>
        </div>
        <div className="poki-stat poki-stat-good">
          <div className="poki-stat-label">Monthly rent roll</div>
          <div className="poki-stat-value">{money(data.monthlyRecurringRevenue, 'GHS')}</div>
          <div className="poki-stat-sub">active bookings, normalised to a month</div>
        </div>
        <div className={'poki-stat' + (data.outstanding > 0 ? ' poki-stat-danger' : '')}>
          <div className="poki-stat-label">Outstanding</div>
          <div className="poki-stat-value">{money(data.outstanding, 'GHS')}</div>
          <div className="poki-stat-sub">
            {data.overdueCount > 0
              ? money(data.overdueAmount, 'GHS') + ' of it overdue (' + data.overdueCount + ' invoice' + (data.overdueCount === 1 ? '' : 's') + ')'
              : 'nothing past its due date'}
          </div>
        </div>
        <div className="poki-stat">
          <div className="poki-stat-label">Vacant units</div>
          <div className="poki-stat-value">{u.vacant}</div>
          <div className="poki-stat-sub">{u.other > 0 ? u.other + ' held back (maintenance/reserved)' : 'nothing held back'}</div>
        </div>
        <div className="poki-stat">
          <div className="poki-stat-label">Open maintenance</div>
          <div className="poki-stat-value">{data.openMaintenance}</div>
          <div className="poki-stat-sub">reported, not yet resolved</div>
        </div>
      </div>

      <div className="poki-section">
        <h2 className="poki-section-title">Bookings ending in the next 90 days</h2>
        <p className="poki-section-sub">
          Chase a renewal or start re-letting. A booking left to lapse frees its unit automatically on the end date.
        </p>
        {data.expiringBookings.length === 0 ? (
          <div className="poki-empty">
            <p className="poki-empty-title">Nothing expiring soon</p>
            <p className="poki-empty-sub">No active booking ends within the next 90 days.</p>
          </div>
        ) : (
          <div className="poki-table-wrap">
<table className="table">
            <thead>
              <tr><th>Booking</th><th>Unit</th><th>Tenant</th><th>Ends</th><th className="poki-num">Rent</th><th className="poki-num">Owing</th></tr>
            </thead>
            <tbody>
              {data.expiringBookings.map((l) => {
                const days = daysUntil(l.endDate);
                return (
                  <tr key={l.id}>
                    <td className="poki-strong poki-nowrap">{l.bookingNo}</td>
                    <td className="poki-nowrap">{l.unitCode}<div className="poki-muted">{l.propertyName}</div></td>
                    <td className="poki-nowrap">{l.tenantName}</td>
                    <td className="poki-nowrap">
                      {fmtDate(l.endDate)}{' '}
                      <span className={'poki-chip ' + (days <= 30 ? 'poki-chip-expired' : 'poki-chip-expiring')}>
                        {days <= 0 ? 'due now' : days + ' days'}
                      </span>
                    </td>
                    <td className="poki-num">{money(l.rentTotal, l.currency)}</td>
                    <td className={'poki-num' + (l.balanceTotal > 0 ? ' poki-overdue' : '')}>
                      {money(l.balanceTotal || 0, l.currency)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
</div>
        )}
      </div>

      <div className="poki-section">
        <h2 className="poki-section-title">Arrears</h2>
        <p className="poki-section-sub">
          Unpaid rent, utility and repair invoices, worst first. Record payments against them on the Rent &amp; utilities screen.
        </p>
        {!arrears || arrears.rows.length === 0 ? (
          <div className="poki-empty">
            <p className="poki-empty-title">Everything is paid up</p>
            <p className="poki-empty-sub">No tenant currently owes anything.</p>
          </div>
        ) : (
          <div className="poki-table-wrap">
<table className="table">
            <thead>
              <tr><th>Invoice</th><th>Tenant</th><th>Unit</th><th>Kind</th><th>Due</th><th className="poki-num">Balance</th></tr>
            </thead>
            <tbody>
              {arrears.rows.slice(0, 15).map((r) => (
                <tr key={r.invoiceId}>
                  <td className="poki-strong poki-nowrap">{r.invoiceNo}</td>
                  <td className="poki-nowrap">{r.tenantName}</td>
                  <td className="poki-nowrap">{r.unitCode || '—'}{r.unitCode && <div className="poki-muted">{r.propertyName}</div>}</td>
                  <td><span className="poki-chip poki-chip-open">{r.docKind}</span></td>
                  <td className="poki-nowrap">
                    {fmtDate(r.dueDate)}
                    {r.daysOverdue > 0 && <div className="poki-overdue poki-muted">{r.daysOverdue} days overdue</div>}
                  </td>
                  <td className="poki-num poki-strong">{money(r.balanceDue, r.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
</div>
        )}
      </div>
    </div>
  );
}
