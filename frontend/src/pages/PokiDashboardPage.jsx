import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { money, moneyBreakdown } from '../lib/currency';
import { tr } from '../lib/i18n.jsx';
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

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;
  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return null;

  const u = data.units;

  return (
    <div>
      <div className="poki-stats">
        <div className="poki-stat">
          <div className="poki-stat-label">{tr('Occupancy')}</div>
          <div className="poki-stat-value">{u.occupancyRate}%</div>
          <div className="poki-stat-sub">{u.occupied} {tr('of')} {u.total} {tr('units let')}</div>
          <div className="poki-occupancy-bar">
            <div className="poki-occupancy-fill" style={{ width: Math.min(100, u.occupancyRate) + '%' }} />
          </div>
        </div>
        <div className="poki-stat poki-stat-good">
          <div className="poki-stat-label">{tr('Monthly rent roll')}</div>
          {/* Per currency, not blended: the backend now returns
              [{ currency, amount }] because adding a USD rent to a GHS one
              produces a number that means nothing. A GHS-only portfolio shows
              a single figure and reads exactly as it did. */}
          <div className="poki-stat-value">{moneyBreakdown(data.monthlyRecurringRevenue, money(0))}</div>
          <div className="poki-stat-sub">{tr('active bookings, normalised to a month')}</div>
        </div>
        <div className={'poki-stat' + ((data.outstanding || []).length ? ' poki-stat-danger' : '')}>
          <div className="poki-stat-label">{tr('Outstanding')}</div>
          <div className="poki-stat-value">{moneyBreakdown(data.outstanding, money(0))}</div>
          <div className="poki-stat-sub">
            {data.overdueCount > 0
              ? moneyBreakdown(data.overdueAmount, money(0)) + tr(' of it overdue (') + data.overdueCount + tr(' invoice') + (data.overdueCount === 1 ? '' : 's') + ')'
              : tr('nothing past its due date')}
          </div>
        </div>
        <div className="poki-stat">
          <div className="poki-stat-label">{tr('Vacant units')}</div>
          <div className="poki-stat-value">{u.vacant}</div>
          <div className="poki-stat-sub">{u.other > 0 ? u.other + tr(' held back (maintenance/reserved)') : tr('nothing held back')}</div>
        </div>
        <div className="poki-stat">
          <div className="poki-stat-label">{tr('Open maintenance')}</div>
          <div className="poki-stat-value">{data.openMaintenance}</div>
          <div className="poki-stat-sub">{tr('reported, not yet resolved')}</div>
        </div>
      </div>

      <div className="poki-section">
        <h2 className="poki-section-title">{tr('Bookings ending in the next 90 days')}</h2>
        <p className="poki-section-sub">
          {tr('Chase a renewal or start re-letting. A booking left to lapse frees its unit automatically on the end date.')}
        </p>
        {data.expiringBookings.length === 0 ? (
          <div className="poki-empty">
            <p className="poki-empty-title">{tr('Nothing expiring soon')}</p>
            <p className="poki-empty-sub">{tr('No active booking ends within the next 90 days.')}</p>
          </div>
        ) : (
          <div className="poki-table-wrap">
<table className="table">
            <thead>
              <tr><th>{tr('Booking')}</th><th>{tr('Unit')}</th><th>{tr('Tenant')}</th><th>{tr('Ends')}</th><th className="poki-num">{tr('Rent')}</th><th className="poki-num">{tr('Owing')}</th></tr>
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
                        {days <= 0 ? tr('due now') : days + tr(' days')}
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
        <h2 className="poki-section-title">{tr('Arrears')}</h2>
        <p className="poki-section-sub">
          {tr('Unpaid rent, utility and repair invoices, worst first. Record payments against them on the Rent & utilities screen.')}
        </p>
        {!arrears || arrears.rows.length === 0 ? (
          <div className="poki-empty">
            <p className="poki-empty-title">{tr('Everything is paid up')}</p>
            <p className="poki-empty-sub">{tr('No tenant currently owes anything.')}</p>
          </div>
        ) : (
          <div className="poki-table-wrap">
<table className="table">
            <thead>
              <tr><th>{tr('Invoice')}</th><th>{tr('Tenant')}</th><th>{tr('Unit')}</th><th>{tr('Kind')}</th><th>{tr('Due')}</th><th className="poki-num">{tr('Balance')}</th></tr>
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
                    {r.daysOverdue > 0 && <div className="poki-overdue poki-muted">{r.daysOverdue} {tr('days overdue')}</div>}
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
