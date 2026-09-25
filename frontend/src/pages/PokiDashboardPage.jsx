import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import ContactButtons from '../components/ContactButtons';
import { Glossary, Hero, Insights, PairBars, RankList, Section, Status, fmtDate, jump } from '../components/DashKit';
import { money, moneyBreakdown } from '../lib/currency';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels.js';
import './EmployeesPage.css';
import './ToolRoomPage.css';
import './RestaurantsPage.css';
import './PokiRentals.css';

// Poki Rentals — the overview a landlord opens first. Same "explains
// itself" layout as the dashboards (components/DashKit.jsx): the key
// numbers (how much of the portfolio is let, the monthly rent roll, what is
// owed, open repairs), what stands out (rent overdue, tenancies ending with
// no renewal, units standing empty and the rent they are losing, move-ins
// coming, urgent repairs), what was billed against what came in over twelve
// months, occupancy by property, and the lists to act on: arrears (with a
// call or WhatsApp button), tenancies ending, units empty, move-ins.
// Amounts are kept per currency, never added across currencies.

function daysUntil(iso) {
  if (!iso) return null;
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((new Date(String(iso).slice(0, 10) + 'T00:00') - t) / 86400000);
}
function monthLabel(ym) { return new Date(ym + '-01T00:00').toLocaleDateString(activeIntlLocale(), { month: 'short' }); }

export default function PokiDashboardPage() {
  const { can } = useAuth();
  const canManage = can('poki.manage');
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [arrears, setArrears] = useState(null);
  const [properties, setProperties] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [o, a, p] = await Promise.all([api.get('/poki/overview'), api.get('/poki/arrears'), api.get('/poki/properties')]);
      setData(o); setArrears(a); setProperties(p);
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
  const rows = (arrears && arrears.rows) || [];
  const overdue = rows.filter((r) => r.daysOverdue > 0);
  const ending30 = data.expiringBookings.filter((b) => daysUntil(b.endDate) <= 30);
  const bookedFrom = new Map(data.upcomingBookings.map((b) => [b.unitId, b.startDate]));
  const longVacant = data.vacantUnits.filter((v) => v.daysVacant >= 30 && !bookedFrom.has(v.id));
  const byTenant = new Map();
  overdue.forEach((r) => {
    const t = byTenant.get(r.tenantName) || { name: r.tenantName, phone: r.tenantPhone, currency: r.currency, amount: 0, days: 0, n: 0 };
    t.amount += r.balanceDue; t.days = Math.max(t.days, r.daysOverdue); t.n++;
    byTenant.set(r.tenantName, t);
  });
  const worst = Array.from(byTenant.values()).sort((x, y) => y.days - x.days || y.amount - x.amount)[0];

  // the currency most of the money is in charts; any other is noted
  const currencies = Array.from(new Set([...data.billedByMonth, ...data.collectedByMonth].map((r) => r.currency)));
  const mainCurrency = currencies.includes('GHS') ? 'GHS' : currencies[0] || 'GHS';
  const sumFor = (list, month) => list.filter((r) => r.month === month && r.currency === mainCurrency).reduce((s, r) => s + r.amount, 0);
  const chart = data.months.map((m) => ({ label: monthLabel(m), a: sumFor(data.billedByMonth, m), b: sumFor(data.collectedByMonth, m) }));
  const yearBilled = chart.reduce((s, r) => s + r.a, 0);
  const yearCollected = chart.reduce((s, r) => s + r.b, 0);
  const hasMoney = yearBilled > 0 || yearCollected > 0;

  const stats = [
    { icon: 'check', value: u.occupancyRate + '%', label: tr('of units let'), note: tr('{occupied} of {total} units let', { occupied: u.occupied, total: u.total }), onClick: () => navigate('/pokiproperties') },
    { icon: 'cash', value: moneyBreakdown(data.monthlyRecurringRevenue, money(0)), label: tr('rent roll a month'), note: tr('from bookings let by the month'), onClick: () => navigate('/pokibookings') },
    { icon: 'owed', value: moneyBreakdown(data.outstanding, money(0)), label: tr('owed by tenants'), note: data.overdueCount ? (data.overdueCount === 1 ? tr('{amount} of it overdue (1 invoice)', { amount: moneyBreakdown(data.overdueAmount, money(0)) }) : tr('{amount} of it overdue ({n} invoices)', { amount: moneyBreakdown(data.overdueAmount, money(0)), n: data.overdueCount })) : tr('nothing past its due date'), tone: data.overdueCount ? 'bad' : '', onClick: () => jump('pk-arrears') },
    { icon: 'warn', value: String(data.openMaintenance), label: tr('repairs open'), note: data.urgentMaintenance ? tr('{n} high or urgent', { n: data.urgentMaintenance }) : tr('none urgent'), tone: data.urgentMaintenance ? 'alert' : '', onClick: () => navigate('/pokimaintenance') }
  ];

  const insights = [];
  if (worst) insights.push({ tone: 'bad', icon: 'owed', text: byTenant.size === 1 ? tr('{name} owes {amount}, {days} days overdue.', { name: worst.name, amount: money(worst.amount, worst.currency), days: worst.days }) : tr('{n} tenants are behind; {name} owes {amount}, {days} days overdue.', { n: byTenant.size, name: worst.name, amount: money(worst.amount, worst.currency), days: worst.days }), action: { label: tr('Show arrears'), run: () => jump('pk-arrears') } });
  if (ending30.length) insights.push({ tone: 'warn', icon: 'calendar', text: ending30.length === 1 ? tr('{tenant}\'s booking on {unit} ends {date}. Renew it or start re-letting.', { tenant: ending30[0].tenantName, unit: ending30[0].unitCode, date: fmtDate(ending30[0].endDate) }) : tr('{n} bookings end in the next 30 days. Renew them or start re-letting.', { n: ending30.length }), action: { label: tr('Show them'), run: () => jump('pk-ending') } });
  if (longVacant.length) {
    const lost = longVacant.reduce((m, v) => { m[v.currency] = (m[v.currency] || 0) + v.baseRent; return m; }, {});
    insights.push({ tone: 'warn', icon: 'drawer', text: longVacant.length === 1 ? tr('{unit} at {property} has stood empty for {days} days — {rent} a month not coming in.', { unit: longVacant[0].code, property: longVacant[0].propertyName, days: longVacant[0].daysVacant, rent: money(longVacant[0].baseRent, longVacant[0].currency) }) : tr('{n} units have stood empty for over a month — {rent} a month not coming in.', { n: longVacant.length, rent: Object.entries(lost).map(([c, a]) => money(a, c)).join(' · ') }), action: canManage ? { label: tr('Make a letting offer'), run: () => navigate('/pokiestimates') } : { label: tr('Show them'), run: () => jump('pk-vacant') } });
  }
  if (data.upcomingBookings.length) insights.push({ tone: 'info', icon: 'people', text: data.upcomingBookings.length === 1 ? tr('{tenant} moves into {unit} on {date}.', { tenant: data.upcomingBookings[0].tenantName, unit: data.upcomingBookings[0].unitCode, date: fmtDate(data.upcomingBookings[0].startDate) }) : tr('{n} tenants move in over the next 30 days.', { n: data.upcomingBookings.length }), action: { label: tr('Show them'), run: () => jump('pk-moving') } });
  if (data.urgentMaintenance) insights.push({ tone: 'warn', icon: 'warn', text: data.urgentMaintenance === 1 ? tr('1 high or urgent repair is open.') : tr('{n} high or urgent repairs are open.', { n: data.urgentMaintenance }), action: { label: tr('Open maintenance'), run: () => navigate('/pokimaintenance') } });
  if (hasMoney && yearBilled > 0 && yearCollected < yearBilled * 0.8) insights.push({ tone: 'info', icon: 'cash', text: tr('Over twelve months {collected} came in against {billed} billed.', { collected: money(yearCollected, mainCurrency), billed: money(yearBilled, mainCurrency) }), action: { label: tr('Show arrears'), run: () => jump('pk-arrears') } });
  if (data.depositsHeld.length) insights.push({ tone: 'info', icon: 'drawer', text: tr('{amount} of tenants\' deposits is being held, to be returned at the end of their tenancies.', { amount: moneyBreakdown(data.depositsHeld) }) });
  if (!insights.length) insights.push({ tone: 'good', icon: 'check', text: tr('Rent is paid up, nothing ends soon and no unit stands empty for long.') });

  const propRows = properties.filter((p) => p.status !== 'archived' && p.unitCount > 0)
    .map((p) => ({ key: p.id, name: p.name, value: Math.round((p.occupiedCount / p.unitCount) * 100), amount: tr('{occupied} of {total} let', { occupied: p.occupiedCount, total: p.unitCount }), meta: p.vacantCount ? (p.vacantCount === 1 ? tr('1 empty') : tr('{n} empty', { n: p.vacantCount })) : tr('full') }))
    .sort((x, y) => x.value - y.value);

  return (
    <div className="dk tl pk">
      <Hero
        eyebrow={new Date().toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        title={tr('Poki Rentals')}
        sub={tr('The properties and units, who is in them, what they pay and what they owe. See what is ending, what stands empty and what needs repairing. Press a number to go to it.')}
        actions={(
          <>
            {canManage && <Link className="btn btn-primary" to="/pokibookings">{tr('New booking')}</Link>}
            <Link className="btn btn-secondary" to="/pokibilling">{tr('Rent & utilities')}</Link>
          </>
        )}
        stats={stats} />

      <Insights items={insights.slice(0, 5)} />

      {hasMoney && (
        <Section id="pk-money" title={tr('Billed and collected')} sub={tr('The last twelve months, in {currency}: what was invoiced and what tenants paid.', { currency: mainCurrency }) + (currencies.length > 1 ? ' ' + tr('Other currencies are on the Rent & utilities screen.') : '')} card>
          <PairBars rows={chart} aLabel={tr('Billed')} bLabel={tr('Collected')} format={(v) => money(v, mainCurrency)} />
        </Section>
      )}

      <div className="dk-two">
        <Section id="pk-props" title={tr('Occupancy by property')} sub={tr('Emptiest first.')} card>
          {propRows.length ? <RankList rows={propRows} /> : <p className="dk-muted tl-small">{tr('No properties with units yet.')} <Link to="/pokiproperties">{tr('Add one')}</Link></p>}
        </Section>
        <Section id="pk-vacant" title={tr('Empty units')} sub={tr('Longest empty first, with the rent each would bring in.')} card>
          {data.vacantUnits.length ? (
            <ul className="pk-list">
              {data.vacantUnits.slice(0, 8).map((v) => (
                <li key={v.id}>
                  <span className="pk-list-main"><strong>{v.code}{v.name ? ' · ' + v.name : ''}</strong><span className="dk-muted tl-small">{v.propertyName} · {codeLabel(v.unitType)}</span></span>
                  <span className="pk-list-side"><strong>{money(v.baseRent, v.currency)}</strong>{bookedFrom.has(v.id)
                      ? <Status tone="info">{tr('booked from {date}', { date: fmtDate(bookedFrom.get(v.id)) })}</Status>
                      : <Status tone={v.daysVacant >= 60 ? 'bad' : v.daysVacant >= 30 ? 'warn' : 'muted'}>{v.timesLet ? (v.daysVacant === 1 ? tr('empty 1 day') : tr('empty {n} days', { n: v.daysVacant })) : tr('never let')}</Status>}</span>
                </li>
              ))}
            </ul>
          ) : <p className="dk-muted tl-small">{tr('Every unit is let or held back.')}</p>}
        </Section>
      </div>

      <Section id="pk-arrears" title={tr('Arrears')} sub={tr('Unpaid rent, utility and repair invoices, most overdue first. Record payments on the Rent & utilities screen.')}>
        {rows.length ? (
          <ul className="rs-list">
            {rows.slice(0, 15).map((r) => (
              <li key={r.invoiceId} className={'rs-row' + (r.daysOverdue > 30 ? ' is-short' : '')}>
                <div className="rs-row-open pk-static">
                  <span className="rs-row-main">
                    <strong>{r.tenantName}</strong>
                    <span className="dk-muted tl-small">{[r.invoiceNo, codeLabel(r.docKind), r.unitCode ? r.unitCode + ' · ' + r.propertyName : null].filter(Boolean).join(' · ')}</span>
                  </span>
                  <span className="rs-row-side">
                    <strong className="rs-amount">{money(r.balanceDue, r.currency)}</strong>
                    {r.daysOverdue > 0 ? <Status tone={r.daysOverdue > 30 ? 'bad' : 'warn'}>{r.daysOverdue === 1 ? tr('1 day overdue') : tr('{daysOverdue} days overdue', { daysOverdue: r.daysOverdue })}</Status> : <span className="dk-muted tl-small">{tr('due {date}', { date: fmtDate(r.dueDate) })}</span>}
                  </span>
                </div>
                <span className="pk-contact"><ContactButtons name={r.tenantName} phone={r.tenantPhone} email={r.tenantEmail} /></span>
              </li>
            ))}
          </ul>
        ) : <p className="dk-muted tl-small">{tr('Everything is paid up')} — {tr('No tenant currently owes anything.')}</p>}
      </Section>

      <div className="dk-two">
        <Section id="pk-ending" title={tr('Ending in the next 90 days')} sub={tr('Chase a renewal or start re-letting. A booking left to lapse frees its unit on the end date.')} card>
          {data.expiringBookings.length ? (
            <ul className="pk-list">
              {data.expiringBookings.map((b) => {
                const d = daysUntil(b.endDate);
                return (
                  <li key={b.id}>
                    <span className="pk-list-main"><strong>{b.tenantName}</strong><span className="dk-muted tl-small">{b.unitCode} · {b.propertyName} · {b.bookingNo}</span></span>
                    <span className="pk-list-side">
                      <Status tone={d <= 14 ? 'bad' : d <= 30 ? 'warn' : 'info'}>{d <= 0 ? tr('ends today') : d === 1 ? tr('ends tomorrow') : tr('ends in {n} days', { n: d })}</Status>
                      <ContactButtons name={b.tenantName} phone={b.tenantPhone} email={b.tenantEmail} />
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : <p className="dk-muted tl-small">{tr('No active booking ends within the next 90 days.')}</p>}
        </Section>
        <Section id="pk-moving" title={tr('Moving in soon')} sub={tr('Bookings starting in the next 30 days. Check the rent and deposit are paid before handing over keys.')} card>
          {data.upcomingBookings.length ? (
            <ul className="pk-list">
              {data.upcomingBookings.map((b) => (
                <li key={b.id}>
                  <span className="pk-list-main"><strong>{b.tenantName}</strong><span className="dk-muted tl-small">{b.unitCode} · {b.propertyName} · {b.durationLabel}</span></span>
                  <span className="pk-list-side">
                    <span className="tl-small">{fmtDate(b.startDate)}</span>
                    {b.balanceTotal > 0 ? <Status tone="warn">{tr('{amount} still to pay', { amount: money(b.balanceTotal, b.currency) })}</Status> : <Status tone="good">{tr('Paid')}</Status>}
                  </span>
                </li>
              ))}
            </ul>
          ) : <p className="dk-muted tl-small">{tr('Nobody moves in over the next 30 days.')}</p>}
        </Section>
      </div>

      <Glossary items={[
        [tr('Rent roll'), tr('The monthly rent of every booking let by the month. Bookings of a few days are left out; they are not monthly income.')],
        [tr('Billed and collected'), tr('Billed is what was invoiced in the month; collected is what tenants paid in it. A gap that keeps growing is rent not coming in.')],
        [tr('Arrears'), tr('Invoices not yet paid. Overdue means past the due date.')],
        [tr('Empty for'), tr('Days since the last booking on the unit ended, or since the unit was added if it was never let.')],
        [tr('Deposit held'), tr('Deposits tenants paid that have not been returned yet.')]
      ]} />
    </div>
  );
}
