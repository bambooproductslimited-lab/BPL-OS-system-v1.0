import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import ContactButtons from '../components/ContactButtons';
import RowMenu from '../components/RowMenu';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { Glossary, Hero, Insights, Section, Status, fmtDate, jump } from '../components/DashKit';
import { money, moneyBreakdown } from '../lib/currency';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels.js';
import './EmployeesPage.css';
import './ToolRoomPage.css';
import './RestaurantsPage.css';
import './PokiPages.css';
import './PokiRentals.css';

// Bookings — who occupies which unit, for how long, on what terms. A booking
// is a block of time bought up front (so many months plus so many days) and
// invoiced once, when it is made. Same "explains itself" layout as the
// dashboards (components/DashKit.jsx): the key numbers (running now,
// starting soon, ending soon, not fully paid), what stands out (bookings
// ending with no renewal, drafts whose start date has passed, tenants in
// without having paid, deposits waiting to be returned, bookings with no
// agreement), a timeline of every unit against the months so gaps and
// overlaps show at a glance, and the bookings as cards or a list. A booking
// opens with its money (invoiced, paid, owed), its deposit and the actions:
// activate, edit, record the deposit, renew, end, refund the deposit, and
// the tenancy agreement (generated from the template, edited, printed).
// ?unit= or ?tenant= in the address opens a new booking for that unit or
// tenant (the Properties and Tenants screens link here).

const EMPTY = {
  unitId: '', tenantId: '', startDate: '', durationMonths: 12, durationDays: 0,
  monthlyRate: '', dailyRate: '', currency: 'GHS',
  depositAmount: '', depositMonths: 1, escalationPercent: '', status: 'draft', notes: ''
};
const PAST = ['expired', 'terminated', 'renewed'];

function readPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* remembered for this visit only */ } }
function iso(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function day0(s) { return new Date(String(s).slice(0, 10) + 'T00:00'); }
function daysUntil(s) {
  if (!s) return null;
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((day0(s) - t) / 86400000);
}
function isRunning(b) { return b.status === 'active'; }
function isUpcoming(b) { return b.status === 'draft' && daysUntil(b.startDate) >= 0; }
function isLateDraft(b) { return b.status === 'draft' && daysUntil(b.startDate) < 0; }
function depositToReturn(b) { return PAST.includes(b.status) && b.status !== 'renewed' && b.depositHeld > b.depositRefunded; }
function stateOf(b) {
  if (b.status === 'active') {
    const d = daysUntil(b.endDate);
    return { tone: d <= 14 ? 'bad' : d <= 60 ? 'warn' : 'good', text: d <= 0 ? tr('ends today') : d === 1 ? tr('ends tomorrow') : d <= 90 ? tr('ends in {n} days', { n: d }) : tr('Running until {date}', { date: fmtDate(b.endDate) }) };
  }
  if (b.status === 'draft') {
    const d = daysUntil(b.startDate);
    if (d < 0) return { tone: 'bad', text: tr('Start date passed — not activated') };
    return { tone: 'info', text: d === 0 ? tr('Starts today') : d === 1 ? tr('Starts tomorrow') : tr('Starts in {n} days', { n: d }) };
  }
  return { tone: 'muted', text: codeLabel(b.status) };
}

// every unit against the months: past two, this one and the next six
function Timeline({ units, bookings, onOpen }) {
  const start = new Date(); start.setDate(1); start.setMonth(start.getMonth() - 2); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setMonth(end.getMonth() + 9);
  const span = end - start;
  const months = Array.from({ length: 9 }, (_, i) => { const m = new Date(start); m.setMonth(m.getMonth() + i); return m; });
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const pos = (d) => Math.max(0, Math.min(100, ((d - start) / span) * 100));
  const rows = units.map((u) => ({ u, bs: bookings.filter((b) => b.unitId === u.id && day0(b.endDate) >= start && day0(b.startDate) < end) }));
  return (
    <div className="pk-tl-scroll">
      <div className="pk-tl">
        <div className="pk-tl-row pk-tl-head">
          <span className="pk-tl-unit" />
          <span className="pk-tl-track">
            {months.map((m) => <span key={m.toISOString()} className="pk-tl-month" style={{ left: pos(m) + '%' }}>{m.toLocaleDateString(activeIntlLocale(), { month: 'short' })}</span>)}
          </span>
        </div>
        {rows.map(({ u, bs }) => (
          <div key={u.id} className="pk-tl-row">
            <span className="pk-tl-unit"><strong>{u.code}</strong><span className="dk-muted">{u.propertyName}</span></span>
            <span className="pk-tl-track">
              {months.map((m) => <span key={m.toISOString()} className="pk-tl-grid" style={{ left: pos(m) + '%' }} />)}
              <span className="pk-tl-today" style={{ left: pos(today) + '%' }} />
              {bs.map((b) => {
                const a = pos(day0(b.startDate));
                const z = pos(new Date(day0(b.endDate).getTime() + 86400000));
                return (
                  <button key={b.id} type="button" className={'pk-tl-bar is-' + (PAST.includes(b.status) ? 'past' : b.status) + (b.balanceTotal > 0 ? ' is-owing' : '')}
                    style={{ left: a + '%', width: Math.max(1.2, z - a) + '%' }} onClick={() => onOpen(b.id)}
                    title={b.tenantName + ' · ' + fmtDate(b.startDate) + ' – ' + fmtDate(b.endDate)}>
                    <span>{b.tenantName}</span>
                  </button>
                );
              })}
            </span>
          </div>
        ))}
      </div>
      <div className="dk-legend pk-tl-legend">
        <span><i className="dk-swatch pk-sw-active" />{tr('Running')}</span>
        <span><i className="dk-swatch pk-sw-draft" />{tr('Booked, not started')}</span>
        <span><i className="dk-swatch pk-sw-past" />{tr('Past')}</span>
        <span><i className="dk-swatch pk-sw-owing" />{tr('Not fully paid')}</span>
      </div>
    </div>
  );
}

export default function PokiBookingsPage() {
  const { can } = useAuth();
  const canManage = can('poki.manage');
  const [params, setParams] = useSearchParams();

  const [bookings, setBookings] = useState([]);
  const [units, setUnits] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [search, setSearch] = useState('');
  const [chip, setChip] = useState('current');
  const [view, setView] = useState(() => readPref('bos.pokiBookingsView', 'cards'));
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState(null); // booking id

  const [dialog, setDialog] = useState(null); // 'booking' | 'deposit' | 'refund' | 'renew' | 'end' | 'agreement'
  const [editId, setEditId] = useState(null);
  const [target, setTarget] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [quote, setQuote] = useState(null);
  const [dialogError, setDialogError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [agreementBody, setAgreementBody] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [l, u, t] = await Promise.all([api.get('/poki/bookings'), api.get('/poki/units'), api.get('/poki/tenants')]);
      setBookings(l);
      setUnits(u);
      setTenants(t);
      return { units: u, tenants: t };
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load().then((d) => {
      // ?unit= / ?tenant= from the Properties or Tenants screen
      const unitId = params.get('unit');
      const tenantId = params.get('tenant');
      if (d && canManage && (unitId || tenantId)) {
        openBooking(null, { unitId: unitId || '', tenantId: tenantId || '' }, d.units);
        setParams({}, { replace: true });
      }
    });
  }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // The price and the availability both come from the server, not from
  // arithmetic repeated here, so the booking screen and the invoice it will
  // raise cannot disagree. Debounced: it fires on every keystroke.
  useEffect(() => {
    if (dialog !== 'booking' || !form.unitId || !form.startDate) { setQuote(null); return undefined; }
    const months = Number(form.durationMonths) || 0;
    const days = Number(form.durationDays) || 0;
    if (months <= 0 && days <= 0) { setQuote(null); return undefined; }
    let cancelled = false;
    const t = setTimeout(() => {
      api.post('/poki/bookings/quote', {
        unitId: form.unitId, startDate: form.startDate, durationMonths: months, durationDays: days,
        monthlyRate: form.monthlyRate === '' ? undefined : form.monthlyRate,
        dailyRate: form.dailyRate === '' ? undefined : form.dailyRate,
        depositAmount: form.depositAmount === '' ? 0 : form.depositAmount,
        currency: form.currency, exceptId: editId || undefined
      })
        .then((q) => { if (!cancelled) setQuote(q); })
        .catch(() => { if (!cancelled) setQuote(null); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [dialog, editId, form.unitId, form.startDate, form.durationMonths, form.durationDays,
    form.monthlyRate, form.dailyRate, form.depositAmount, form.currency]);

  // Deposits are agreed in months of rent; the amount follows, but stays
  // editable for a negotiated figure.
  function monthsFromDeposit(depositAmount, monthlyRate) {
    const per = Number(monthlyRate) || 0;
    const amount = Number(depositAmount) || 0;
    if (!per || !amount) return '';
    return Math.round((amount / per) * 100) / 100;
  }
  function depositFor(monthlyRate, months) {
    const m = Number(months);
    if (!Number.isFinite(m) || m <= 0) return '';
    return Math.round((Number(monthlyRate) || 0) * m * 100) / 100;
  }
  function withUnit(f, unitId, unitList, editing) {
    const u = (unitList || units).find((x) => x.id === unitId);
    const monthlyRate = u && !editing ? u.baseRent : f.monthlyRate;
    return {
      ...f, unitId, monthlyRate,
      dailyRate: u && !editing ? (u.dailyRate || '') : f.dailyRate,
      currency: u ? u.currency : f.currency,
      depositAmount: u && !editing ? depositFor(monthlyRate, f.depositMonths) : f.depositAmount
    };
  }
  function openBooking(l, preset, unitList) {
    setDialogError(null);
    setEditId(l ? l.id : null);
    setQuote(null);
    if (l) {
      setForm({ ...EMPTY, ...l, startDate: String(l.startDate).slice(0, 10), depositMonths: monthsFromDeposit(l.depositAmount, l.monthlyRate) });
    } else {
      let f = { ...EMPTY, startDate: iso(new Date()) };
      if (preset && preset.tenantId) f.tenantId = preset.tenantId;
      if (preset && preset.unitId) {
        f = withUnit(f, preset.unitId, unitList, false);
        const u = (unitList || units).find((x) => x.id === preset.unitId);
        // a unit let now can be booked from the day after its booking ends
        if (u && u.bookingEnd) { const d = day0(u.bookingEnd); d.setDate(d.getDate() + 1); f.startDate = iso(d); }
      }
      setForm(f);
    }
    setDetail(null);
    setDialog('booking');
  }
  async function submitBooking(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      if (editId) await api.patch('/poki/bookings/' + editId, form);
      else await api.post('/poki/bookings', form);
      setToast(editId ? tr('Booking updated.') : tr('Booking created.'));
      setDialog(null);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }
  async function act(booking, path, body, message) {
    setBusy(true);
    setError(null);
    try {
      await api.post('/poki/bookings/' + booking.id + path, body || {});
      setToast(message);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  function openSimple(kind, booking) {
    setDialogError(null);
    setTarget(booking);
    setForm(kind === 'renew'
      ? { escalationPercent: booking.escalationPercent || 0, startDate: '', durationMonths: '', durationDays: '', monthlyRate: '', notes: '' }
      : kind === 'refund'
        ? { amount: Math.round((booking.depositHeld - booking.depositRefunded) * 100) / 100, deductions: '', notes: '' }
        : kind === 'deposit'
          ? { amount: Math.max(0, Math.round((booking.depositAmount - booking.depositHeld) * 100) / 100) || '', notes: '' }
          : { reason: '', status: daysUntil(booking.endDate) <= 0 ? 'expired' : 'terminated' });
    setDetail(null);
    setDialog(kind);
  }
  async function submitSimple(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      if (dialog === 'deposit') {
        await api.post('/poki/bookings/' + target.id + '/deposit', { amount: form.amount, notes: form.notes });
        setToast(tr('Deposit recorded.'));
      } else if (dialog === 'refund') {
        await api.post('/poki/bookings/' + target.id + '/deposit-refund', { amount: form.amount, deductions: form.deductions, notes: form.notes });
        setToast(tr('Deposit refund recorded.'));
      } else if (dialog === 'renew') {
        const body = { escalationPercent: form.escalationPercent };
        if (form.startDate) body.startDate = form.startDate;
        if (form.durationMonths !== '') body.durationMonths = form.durationMonths;
        if (form.durationDays !== '') body.durationDays = form.durationDays;
        if (form.monthlyRate) body.monthlyRate = form.monthlyRate;
        if (form.notes) body.notes = form.notes;
        await api.post('/poki/bookings/' + target.id + '/renew', body);
        setToast(tr('Booking renewed.'));
      } else if (dialog === 'end') {
        await api.post('/poki/bookings/' + target.id + '/end', { reason: form.reason, status: form.status });
        setToast(tr('Booking ended — the unit is now vacant.'));
      }
      setDialog(null);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }
  async function openAgreement(booking) {
    setDialogError(null);
    setTarget(booking);
    setAgreementBody(booking.agreementBody || '');
    setDetail(null);
    setDialog('agreement');
    if (!booking.agreementBody && canManage) await generateAgreement(booking);
  }
  async function generateAgreement(booking) {
    setSaving(true);
    setDialogError(null);
    try {
      const res = await api.post('/poki/bookings/' + (booking || target).id + '/agreement', {});
      setAgreementBody(res.body);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }
  async function saveAgreement() {
    setSaving(true);
    setDialogError(null);
    try {
      await api.put('/poki/bookings/' + target.id + '/agreement', { body: agreementBody });
      setToast(tr('Agreement saved.'));
      setDialog(null);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }
  function printAgreement() {
    const w = window.open('', '_blank');
    if (!w) return;
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    w.document.write(
      '<html><head><title>' + esc(target.bookingNo) + ' — Tenancy Agreement</title>' +
      '<style>body{font-family:Georgia,serif;line-height:1.7;max-width:720px;margin:40px auto;padding:0 24px;white-space:pre-wrap;font-size:13px}</style>' +
      '</head><body>' + esc(agreementBody) + '</body></html>'
    );
    w.document.close();
    w.focus();
    w.print();
  }

  const liveUnits = useMemo(() => units.filter((u) => u.active !== false), [units]);

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const running = bookings.filter(isRunning);
  const upcoming = bookings.filter(isUpcoming).sort((x, y) => String(x.startDate).localeCompare(String(y.startDate)));
  const lateDrafts = bookings.filter(isLateDraft);
  const renewedFrom = new Set(bookings.filter((b) => b.renewedFromId).map((b) => b.renewedFromId));
  const ending = running.filter((b) => daysUntil(b.endDate) <= 60).sort((x, y) => String(x.endDate).localeCompare(String(y.endDate)));
  const endingNoRenewal = ending.filter((b) => !renewedFrom.has(b.id) && !bookings.some((o) => o.unitId === b.unitId && o.id !== b.id && (o.status === 'draft' || o.status === 'active') && day0(o.startDate) > day0(b.endDate)));
  const owing = bookings.filter((b) => b.balanceTotal > 0 && b.status !== 'renewed');
  const inUnpaid = running.filter((b) => b.balanceTotal > 0);
  const toReturn = bookings.filter(depositToReturn);
  const noAgreement = running.filter((b) => !b.agreementGeneratedAt);
  const sumBy = (list, f) => { const m = {}; list.forEach((b) => { m[b.currency] = (m[b.currency] || 0) + f(b); }); return Object.entries(m).filter(([, a]) => a).map(([currency, amount]) => ({ currency, amount })); };

  function showOnly(key) { setChip(chip === key ? 'current' : key); jump('pk-list'); }
  const stats = [
    { icon: 'check', value: String(running.length), label: tr('running now'), note: tr('{amount} a month', { amount: moneyBreakdown(sumBy(running.filter((b) => b.durationMonths > 0), (b) => b.monthlyRate), money(0)) }), onClick: () => showOnly('running') },
    { icon: 'calendar', value: String(upcoming.length), label: tr('starting soon'), note: upcoming.length ? tr('next: {tenant}, {date}', { tenant: upcoming[0].tenantName, date: fmtDate(upcoming[0].startDate) }) : tr('nothing booked ahead'), onClick: () => showOnly('upcoming') },
    { icon: 'clock', value: String(ending.length), label: tr('ending in 60 days'), note: endingNoRenewal.length ? tr('{n} with no renewal yet', { n: endingNoRenewal.length }) : tr('all renewed or re-let'), tone: endingNoRenewal.length ? 'alert' : '', onClick: () => showOnly('ending') },
    { icon: 'owed', value: String(owing.length), label: tr('not fully paid'), note: moneyBreakdown(sumBy(owing, (b) => b.balanceTotal), tr('everything paid')), tone: inUnpaid.length ? 'bad' : owing.length ? 'alert' : 'good', onClick: () => showOnly('owing') }
  ];

  const insights = [];
  if (lateDrafts.length) insights.push({ tone: 'bad', icon: 'calendar', text: lateDrafts.length === 1 ? tr('{bookingNo} for {tenant} was due to start {date} but was never activated.', { bookingNo: lateDrafts[0].bookingNo, tenant: lateDrafts[0].tenantName, date: fmtDate(lateDrafts[0].startDate) }) : tr('{n} bookings were due to start but were never activated.', { n: lateDrafts.length }), action: canManage && lateDrafts.length === 1 ? { label: tr('Activate'), run: () => act(lateDrafts[0], '/activate', {}, tr('Booking activated — the unit is now occupied.')) } : { label: tr('Show them'), run: () => showOnly('late') } });
  if (inUnpaid.length) insights.push({ tone: 'bad', icon: 'owed', text: inUnpaid.length === 1 ? tr('{tenant} is in {unit} with {amount} of the booking still unpaid.', { tenant: inUnpaid[0].tenantName, unit: inUnpaid[0].unitCode, amount: money(inUnpaid[0].balanceTotal, inUnpaid[0].currency) }) : tr('{n} tenants are in with their booking not fully paid.', { n: inUnpaid.length }), action: { label: tr('Show them'), run: () => showOnly('owing') } });
  if (endingNoRenewal.length) insights.push({ tone: 'warn', icon: 'clock', text: endingNoRenewal.length === 1 ? tr('{tenant}\'s booking on {unit} ends {date} with no renewal yet.', { tenant: endingNoRenewal[0].tenantName, unit: endingNoRenewal[0].unitCode, date: fmtDate(endingNoRenewal[0].endDate) }) : tr('{n} bookings end in the next 60 days with no renewal yet.', { n: endingNoRenewal.length }), action: canManage && endingNoRenewal.length === 1 ? { label: tr('Renew'), run: () => openSimple('renew', endingNoRenewal[0]) } : { label: tr('Show them'), run: () => showOnly('ending') } });
  if (toReturn.length) insights.push({ tone: 'info', icon: 'drawer', text: toReturn.length === 1 ? tr('{tenant}\'s deposit of {amount} has not been returned since the booking ended.', { tenant: toReturn[0].tenantName, amount: money(toReturn[0].depositHeld - toReturn[0].depositRefunded, toReturn[0].currency) }) : tr('{n} ended bookings still hold a deposit to return.', { n: toReturn.length }), action: canManage && toReturn.length === 1 ? { label: tr('Refund deposit'), run: () => openSimple('refund', toReturn[0]) } : { label: tr('Show them'), run: () => showOnly('deposit') } });
  if (noAgreement.length) insights.push({ tone: 'info', icon: 'doc', text: noAgreement.length === 1 ? tr('{bookingNo} is running with no tenancy agreement drawn up.', { bookingNo: noAgreement[0].bookingNo }) : tr('{n} running bookings have no tenancy agreement drawn up.', { n: noAgreement.length }), action: noAgreement.length === 1 ? { label: tr('Draw it up'), run: () => openAgreement(noAgreement[0]) } : { label: tr('Show them'), run: () => showOnly('noagreement') } });
  if (!insights.length && bookings.length) insights.push({ tone: 'good', icon: 'check', text: tr('Every running booking is paid, has its agreement, and nothing ends without a plan.') });

  const chipTest = {
    current: (b) => b.status === 'active' || b.status === 'draft', running: isRunning, upcoming: isUpcoming, late: isLateDraft,
    ending: (b) => ending.includes(b), owing: (b) => owing.includes(b), deposit: depositToReturn, noagreement: (b) => noAgreement.includes(b),
    past: (b) => PAST.includes(b.status), all: () => true
  };
  const visible = bookings.filter(chipTest[chip] || chipTest.current)
    .filter((b) => matchesQuery(search, b.bookingNo, b.tenantName, b.unitCode, b.propertyName));
  const chips = [
    ['current', tr('Current'), bookings.filter(chipTest.current).length], ['running', tr('Running'), running.length], ['upcoming', tr('Starting soon'), upcoming.length],
    ['late', tr('Not activated'), lateDrafts.length], ['ending', tr('Ending soon'), ending.length], ['owing', tr('Not fully paid'), owing.length],
    ['deposit', tr('Deposit to return'), toReturn.length], ['noagreement', tr('No agreement'), noAgreement.length],
    ['past', tr('Past'), bookings.filter(chipTest.past).length], ['all', tr('All'), bookings.length]
  ].filter(([k, , c]) => c > 0 || k === 'current' || k === chip);

  function bookingActions(l) {
    return [
      { label: tr('Open'), onClick: () => setDetail(l.id) },
      { label: tr('Agreement'), onClick: () => openAgreement(l) },
      canManage && l.status === 'draft' && { label: tr('Activate'), onClick: () => act(l, '/activate', {}, tr('Booking activated — the unit is now occupied.')), disabled: busy },
      canManage && (l.status === 'draft' || l.status === 'active') && { label: tr('Edit'), onClick: () => openBooking(l) },
      canManage && l.status === 'active' && l.depositHeld < l.depositAmount && { label: tr('Record deposit'), onClick: () => openSimple('deposit', l) },
      canManage && l.status === 'active' && { label: tr('Renew'), onClick: () => openSimple('renew', l) },
      canManage && l.status === 'active' && { label: tr('End'), onClick: () => openSimple('end', l), danger: true },
      canManage && depositToReturn(l) && { label: tr('Refund deposit'), onClick: () => openSimple('refund', l) }
    ].filter(Boolean);
  }

  const cur = detail ? bookings.find((b) => b.id === detail) : null;
  const curTenant = cur ? tenants.find((t) => t.id === cur.tenantId) : null;
  const bookableUnits = units.filter((u) => u.active !== false || (editId && form.unitId === u.id));
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="dk tl pk">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <Hero
        eyebrow={tr('Poki Rentals')}
        title={tr('Bookings')}
        sub={tr('Who is in which unit, from when to when, and on what terms. A booking is paid for up front and invoiced once, when it is made. Press a number to show only those.')}
        actions={canManage && <button type="button" className="btn btn-primary" disabled={!tenants.length || !units.length} onClick={() => openBooking(null)}>{tr('New booking')}</button>}
        stats={stats} />

      <Insights items={insights.slice(0, 5)} />

      {liveUnits.length > 0 && (
        <Section id="pk-timeline" title={tr('Who is where')} sub={tr('Every unit, two months back and six ahead; the line is today. Gaps are empty months. Press a booking to open it.')} card>
          <Timeline units={liveUnits} bookings={bookings} onOpen={setDetail} />
        </Section>
      )}

      <Section id="pk-list" title={tr('Bookings')} sub={tr('Press a booking for its money, its deposit and its agreement.')}
        action={(
          <div className="ppl-view" role="radiogroup" aria-label={tr('View')}>
            {[['cards', tr('Cards')], ['list', tr('List')]].map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={view === k} className={view === k ? 'is-on' : ''} onClick={() => { setView(k); writePref('bos.pokiBookingsView', k); }}>{label}</button>
            ))}
          </div>
        )}>
        <div className="tl-tools"><div className="tl-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search bookings…')} /></div></div>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {chips.map(([key, label, c]) => (
            <button key={key} type="button" role="radio" aria-checked={chip === key} className={'ppl-chip' + (chip === key ? ' is-on' : '')} onClick={() => setChip(key)}>
              {label} <span className="ppl-chip-n">{c}</span>
            </button>
          ))}
        </div>
        {!visible.length ? (
          <div className="dk-empty tl-empty">
            <p>{bookings.length ? tr('Try a different search or status filter.') : tr('A booking puts a tenant in a unit and drives rent billing. Add a property, a unit and a tenant first.')}</p>
            {!bookings.length && <Link className="btn btn-secondary" to="/pokiproperties">{tr('Properties & units')}</Link>}
          </div>
        ) : view === 'cards' ? (
          <div className="tl-grid">
            {visible.map((b) => {
              const st = stateOf(b);
              const paidPct = b.invoicedTotal > 0 ? Math.min(100, Math.round((b.paidTotal / b.invoicedTotal) * 100)) : 0;
              return (
                <article key={b.id} className={'tl-card' + (st.tone === 'bad' || (isRunning(b) && b.balanceTotal > 0) ? ' st-late' : st.tone === 'warn' ? ' st-low' : '') + (PAST.includes(b.status) ? ' st-retired' : '')}>
                  <button type="button" className="tl-card-open" onClick={() => setDetail(b.id)}>
                    <span className={'pk-unit-code' + (isRunning(b) ? ' is-let' : '')}>{b.unitCode}</span>
                    <span className="tl-card-head">
                      <span className="dk-muted tl-small">{b.bookingNo} · {b.propertyName}</span>
                      <span className="tl-name">{b.tenantName}</span>
                    </span>
                  </button>
                  <span className="tl-menu"><RowMenu actions={bookingActions(b)} /></span>
                  <div className="tl-tags">
                    <Status tone={st.tone}>{st.text}</Status>
                    {isRunning(b) && !b.agreementGeneratedAt && <Status tone="muted">{tr('No agreement')}</Status>}
                  </div>
                  <span className="dk-muted tl-small">{fmtDate(b.startDate)} – {fmtDate(b.endDate)} · {b.durationLabel}</span>
                  <span className={'tl-stock' + (b.balanceTotal > 0 ? ' is-low' : '')}>
                    <span className="tl-stock-row"><strong>{b.balanceTotal > 0 ? tr('{amount} to pay', { amount: money(b.balanceTotal, b.currency) }) : tr('Paid in full')}</strong><span className="dk-muted">{tr('of {amount}', { amount: money(b.invoicedTotal || b.rentTotal, b.currency) })}</span></span>
                    <span className="tl-stock-bar" aria-hidden="true"><span style={{ width: paidPct + '%' }} /></span>
                  </span>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="tl-table-wrap">
            <table className="tl-table">
              <thead><tr><th>{tr('Booking')}</th><th>{tr('Term')}</th><th className="is-num">{tr('Rent')}</th><th className="is-num">{tr('Owing')}</th><th>{tr('Status')}</th><th /></tr></thead>
              <tbody>
                {visible.map((b) => {
                  const st = stateOf(b);
                  return (
                    <tr key={b.id} className={PAST.includes(b.status) ? 'st-retired' : ''}>
                      <td><button type="button" className="tl-row-open" onClick={() => setDetail(b.id)}><span className={'pk-unit-code is-small' + (isRunning(b) ? ' is-let' : '')}>{b.unitCode}</span><span><span className="tl-name">{b.tenantName}</span><span className="dk-muted tl-small">{b.bookingNo} · {b.propertyName}</span></span></button></td>
                      <td className="tl-small">{fmtDate(b.startDate)} – {fmtDate(b.endDate)}<div className="dk-muted">{b.durationLabel}</div></td>
                      <td className="is-num">{money(b.rentTotal, b.currency)}<div className="dk-muted tl-small">{money(b.monthlyRate, b.currency)}{tr('/month')}</div></td>
                      <td className={'is-num' + (b.balanceTotal > 0 ? ' pk-owe' : '')}>{money(b.balanceTotal || 0, b.currency)}</td>
                      <td><Status tone={st.tone}>{st.text}</Status></td>
                      <td className="tl-menu-cell"><RowMenu actions={bookingActions(b)} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Glossary items={[
        [tr('Booking'), tr('A block of time bought up front — so many months plus so many days. The whole of it is invoiced once, when it is made.')],
        [tr('Draft'), tr('Drawn up but not started. Activating it puts the tenant in the unit.')],
        [tr('Renew'), tr('Books the same unit again from the day after this booking ends, at the same or an increased rate.')],
        [tr('Deposit'), tr('Paid with the booking and held until the end, then returned less any deductions.')],
        [tr('Agreement'), tr('The tenancy agreement, drawn up from the template with the booking\'s details, then edited and printed.')]
      ]} />

      {/* ── one booking ── */}
      {cur && (
        <div className="dialog-backdrop" onClick={() => setDetail(null)}>
          <div className="dialog tl-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="tl-detail-head">
              <span className={'pk-unit-code is-big' + (isRunning(cur) ? ' is-let' : '')}>{cur.unitCode}</span>
              <div>
                <span className="dk-muted tl-small">{cur.bookingNo} · {cur.propertyName}</span>
                <h2>{cur.tenantName}</h2>
                <div className="tl-tags"><Status tone={stateOf(cur).tone}>{stateOf(cur).text}</Status></div>
              </div>
              <button type="button" className="tl-close" onClick={() => setDetail(null)} aria-label={tr('Close')}>×</button>
            </div>
            <div className="tl-holder is-inline">
              <div className="tl-holder-head">
                <span className="tl-holder-name"><strong>{fmtDate(cur.startDate)} – {fmtDate(cur.endDate)}</strong><span className="dk-muted tl-small">{cur.durationLabel} · {money(cur.monthlyRate, cur.currency)}{tr('/month')}{Number(cur.dailyRate) ? ' · ' + money(cur.dailyRate, cur.currency) + ' ' + tr('a day') : ''}</span></span>
                <ContactButtons name={cur.tenantName} phone={cur.tenantPhone} email={cur.tenantEmail} />
              </div>
            </div>
            <ul className="rs-lines">
              <li><span /><span>{tr('Rent for the term')}</span><strong>{money(cur.rentTotal, cur.currency)}</strong></li>
              <li><span /><span>{tr('Invoiced — rent, deposit and any charges')}</span><strong>{money(cur.invoicedTotal || 0, cur.currency)}</strong></li>
              <li><span>−</span><span>{tr('Paid')}</span><strong>{money(cur.paidTotal || 0, cur.currency)}</strong></li>
              <li className="rs-total"><span>=</span><span>{tr('Still to pay')}</span><strong className={cur.balanceTotal > 0 ? 'pk-owe' : ''}>{money(cur.balanceTotal || 0, cur.currency)}</strong></li>
            </ul>
            <dl className="tl-facts">
              <div><dt>{tr('Deposit due')}</dt><dd>{money(cur.depositAmount, cur.currency)}</dd></div>
              <div><dt>{tr('Deposit held')}</dt><dd>{money(cur.depositHeld, cur.currency)}</dd></div>
              {cur.depositRefunded > 0 && <div><dt>{tr('Deposit refunded')}</dt><dd>{money(cur.depositRefunded, cur.currency)}{cur.depositRefundedOn ? ' · ' + fmtDate(cur.depositRefundedOn) : ''}</dd></div>}
              {cur.escalationPercent > 0 && <div><dt>{tr('Renewal increase')}</dt><dd>{cur.escalationPercent}%</dd></div>}
              <div><dt>{tr('Agreement')}</dt><dd>{cur.agreementGeneratedAt ? tr('drawn up {date}', { date: fmtDate(cur.agreementGeneratedAt) }) : tr('not yet')}</dd></div>
              {cur.terminatedOn && <div><dt>{tr('Ended')}</dt><dd>{fmtDate(cur.terminatedOn)}{cur.terminationReason ? ' · ' + cur.terminationReason : ''}</dd></div>}
              {curTenant && curTenant.idNumber && <div><dt>{tr('ID')}</dt><dd>{curTenant.idType} · {curTenant.idNumber}</dd></div>}
            </dl>
            {cur.notes && <p className="tl-notes">{cur.notes}</p>}
            <div className="dialog-actions tl-actions">
              <button type="button" className="btn btn-secondary" onClick={() => openAgreement(cur)}>{tr('Agreement')}</button>
              {cur.balanceTotal > 0 && <Link className="btn btn-secondary" to="/pokibilling">{tr('Record a payment')}</Link>}
              {canManage && (cur.status === 'draft' || cur.status === 'active') && <button type="button" className="btn btn-secondary" onClick={() => openBooking(cur)}>{tr('Edit')}</button>}
              {canManage && cur.status === 'active' && <button type="button" className="btn btn-secondary" onClick={() => openSimple('end', cur)}>{tr('End')}</button>}
              {canManage && depositToReturn(cur) && <button type="button" className="btn btn-primary" onClick={() => openSimple('refund', cur)}>{tr('Refund deposit')}</button>}
              {canManage && cur.status === 'active' && <button type="button" className="btn btn-primary" onClick={() => openSimple('renew', cur)}>{tr('Renew')}</button>}
              {canManage && cur.status === 'draft' && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => { setDetail(null); act(cur, '/activate', {}, tr('Booking activated — the unit is now occupied.')); }}>{tr('Activate')}</button>}
            </div>
          </div>
        </div>
      )}

      {/* ── new / edit ── */}
      {dialog === 'booking' && (
        <div className="dialog-backdrop" onClick={() => !saving && setDialog(null)}>
          <form className="dialog tl-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitBooking}>
            <h2>{editId ? tr('Edit booking') : tr('New booking')}</h2>
            <div className="tl-form">
              <div className="field">
                <label htmlFor="pl-unit">{tr('Unit')}</label>
                <select id="pl-unit" className="input" value={form.unitId} onChange={(e) => setForm(withUnit(form, e.target.value, null, !!editId))} required disabled={!!editId}>
                  <option value="">{tr('Choose a unit…')}</option>
                  {bookableUnits.map((u) => <option key={u.id} value={u.id}>{u.propertyName} · {u.code}{u.name ? ' — ' + u.name : ''}{u.status === 'occupied' ? ' (' + tr('let until {date}', { date: fmtDate(u.bookingEnd) }) + ')' : ''}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="pl-tenant">{tr('Tenant')}</label>
                <select id="pl-tenant" className="input" value={form.tenantId} onChange={set('tenantId')} required disabled={!!editId}>
                  <option value="">{tr('Choose a tenant…')}</option>
                  {tenants.filter((t) => t.status !== 'blacklisted' && t.status !== 'former' || t.id === form.tenantId).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="pl-start">{tr('Start date')}</label>
                <input id="pl-start" className="input" type="date" value={form.startDate} onChange={set('startDate')} required />
              </div>
              <div className="field">
                <span className="tl-label">{tr('How long')}</span>
                <div className="pk-duration">
                  <input id="pl-months" className="input" type="number" min="0" step="1" aria-label={tr('For how many months')} value={form.durationMonths} onChange={set('durationMonths')} />
                  <span>{tr('months +')}</span>
                  <input id="pl-days" className="input" type="number" min="0" step="1" aria-label={tr('…plus how many days')} value={form.durationDays} onChange={set('durationDays')} />
                  <span>{tr('days')}</span>
                </div>
                <div className="tl-due">
                  {[[6, 0], [12, 0], [24, 0], [0, 7]].map(([m, d]) => (
                    <button key={m + '-' + d} type="button" className={'tl-seg-btn' + (Number(form.durationMonths) === m && Number(form.durationDays) === d ? ' is-on' : '')} onClick={() => setForm({ ...form, durationMonths: m, durationDays: d })}>
                      {m ? tr('{n} months', { n: m }) : tr('{n} days', { n: d })}
                    </button>
                  ))}
                </div>
              </div>
              <div className="field">
                <label htmlFor="pl-rate">{tr('Rent per month')}</label>
                <input id="pl-rate" className="input" type="number" min="0" step="0.01" value={form.monthlyRate} required
                  onChange={(e) => { const v = e.target.value; setForm((f) => ({ ...f, monthlyRate: v, depositAmount: f.depositMonths ? depositFor(v, f.depositMonths) : f.depositAmount })); }} />
              </div>
              <div className="field">
                <label htmlFor="pl-daily">{tr('Rent per day')}</label>
                <input id="pl-daily" className="input" type="number" min="0" step="0.01" value={form.dailyRate} onChange={set('dailyRate')} placeholder={tr('from the unit')} />
                <span className="dk-muted tl-small">{tr('Blank uses a thirtieth of the monthly rate.')}</span>
              </div>
              <div className="field">
                <label htmlFor="pl-dep-months">{tr('Deposit (months of rent)')}</label>
                <input id="pl-dep-months" className="input" type="number" min="0" step="0.5" value={form.depositMonths}
                  onChange={(e) => { const v = e.target.value; setForm((f) => ({ ...f, depositMonths: v, depositAmount: depositFor(f.monthlyRate, v) })); }} />
              </div>
              <div className="field">
                <label htmlFor="pl-dep">{tr('Deposit due')}</label>
                <input id="pl-dep" className="input" type="number" min="0" step="0.01" value={form.depositAmount} onChange={set('depositAmount')} />
              </div>
              <div className="field">
                <label htmlFor="pl-esc">{tr('Renewal increase (%)')}</label>
                <input id="pl-esc" className="input" type="number" min="0" step="0.01" value={form.escalationPercent} onChange={set('escalationPercent')} placeholder={tr('e.g. 10')} />
              </div>
              {!editId && (
                <div className="field tl-span">
                  <span className="tl-label">{tr('Start as')}</span>
                  <div className="tl-seg" role="radiogroup" aria-label={tr('Start as')}>
                    {[['draft', tr('Draft — not yet occupying')], ['active', tr('Active — tenant moves in now')]].map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={form.status === k} className={'tl-seg-btn' + (form.status === k ? ' is-on' : '')} onClick={() => setForm({ ...form, status: k })}>{label}</button>)}
                  </div>
                </div>
              )}
              <div className="field tl-span">
                <label htmlFor="pl-notes">{tr('Notes (optional)')}</label>
                <textarea id="pl-notes" className="input tl-textarea" value={form.notes} onChange={set('notes')} />
              </div>
            </div>
            {quote && (
              <div className="poki-term-total">
                <div className="poki-term-row">
                  <span>{tr('Rent —')} {quote.durationLabel}<span className="poki-muted">{' '}{tr('({date} to {date2})', { date: fmtDate(quote.startDate), date2: fmtDate(quote.endDate) })}</span></span>
                  <strong>{money(quote.rentTotal, quote.currency)}</strong>
                </div>
                {quote.daysAmount > 0 && (
                  <div className="poki-term-row poki-muted">
                    <span>{quote.durationDays === 1 ? tr('of which 1 day at {rate}', { rate: money(quote.dailyRate, quote.currency) }) : tr('of which {n} days at {rate}', { n: quote.durationDays, rate: money(quote.dailyRate, quote.currency) })}</span>
                    <span>{money(quote.daysAmount, quote.currency)}</span>
                  </div>
                )}
                <div className="poki-term-row"><span>{tr('Deposit')}</span><strong>{money(quote.depositAmount, quote.currency)}</strong></div>
                <div className="poki-term-row poki-term-grand"><span>{tr('Payable before occupation')}</span><strong>{money(quote.total, quote.currency)}</strong></div>
                {!quote.available && (
                  <div className="poki-term-clash">{tr('Unavailable — {bookingNo} has this unit from {date} to {date2}.', { bookingNo: quote.clashesWith.bookingNo, date: fmtDate(quote.clashesWith.startDate), date2: fmtDate(quote.clashesWith.endDate) })}</div>
                )}
              </div>
            )}
            <p className="dk-muted tl-small">{tr('The whole booking is invoiced once, when it is made — there is no monthly rent run. Utilities, where the unit has them, are billed separately as they are used.')}</p>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)} disabled={saving}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving || (quote && !quote.available)}>{saving ? tr('Saving…') : editId ? tr('Save changes') : tr('Make the booking')}</button>
            </div>
          </form>
        </div>
      )}

      {/* ── deposit, refund, renew, end ── */}
      {(dialog === 'deposit' || dialog === 'refund' || dialog === 'renew' || dialog === 'end') && target && (
        <div className="dialog-backdrop" onClick={() => !saving && setDialog(null)}>
          <form className="dialog tl-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitSimple}>
            <h2>
              {dialog === 'deposit' && tr('Record deposit — {bookingNo}', { bookingNo: target.bookingNo })}
              {dialog === 'refund' && tr('Refund deposit — {bookingNo}', { bookingNo: target.bookingNo })}
              {dialog === 'renew' && tr('Renew booking — {bookingNo}', { bookingNo: target.bookingNo })}
              {dialog === 'end' && tr('End booking — {bookingNo}', { bookingNo: target.bookingNo })}
            </h2>
            <p className="dk-muted tl-small">{target.tenantName} · {target.unitCode} · {target.propertyName}</p>
            <div className="tl-form">
              {dialog === 'deposit' && (
                <>
                  <p className="dk-muted tl-small tl-span">{tr('{tenantName} owes a deposit of {amount}; {amount2} has been received so far.', { tenantName: target.tenantName, amount: money(target.depositAmount, target.currency), amount2: money(target.depositHeld, target.currency) })}</p>
                  <div className="field">
                    <label htmlFor="pd-amt">{tr('Amount received')}</label>
                    <input id="pd-amt" className="input" type="number" min="0" step="0.01" value={form.amount} onChange={set('amount')} required autoFocus />
                  </div>
                  <div className="field">
                    <label htmlFor="pd-notes">{tr('Reference / notes')}</label>
                    <input id="pd-notes" className="input" value={form.notes} onChange={set('notes')} />
                  </div>
                </>
              )}
              {dialog === 'refund' && (
                <>
                  <p className="dk-muted tl-small tl-span">{tr('{amount} is held on this booking. Anything you withhold for damage or unpaid rent goes in deductions and is not refunded.', { amount: money(target.depositHeld - target.depositRefunded, target.currency) })}</p>
                  <div className="field">
                    <label htmlFor="pr-amt">{tr('Refund to tenant')}</label>
                    <input id="pr-amt" className="input" type="number" min="0" step="0.01" value={form.amount} onChange={set('amount')} required autoFocus />
                  </div>
                  <div className="field">
                    <label htmlFor="pr-ded">{tr('Deductions withheld')}</label>
                    <input id="pr-ded" className="input" type="number" min="0" step="0.01" value={form.deductions} onChange={set('deductions')} />
                  </div>
                  <div className="field tl-span">
                    <label htmlFor="pr-notes">{tr('What the deductions cover')}</label>
                    <textarea id="pr-notes" className="input tl-textarea" value={form.notes} onChange={set('notes')} />
                  </div>
                </>
              )}
              {dialog === 'renew' && (
                <>
                  <p className="dk-muted tl-small tl-span">{tr('Books the same unit again, starting the day after {date} — this booking keeps its own price and signed agreement. Leave the fields blank to repeat the same length at the increased rate.', { date: fmtDate(target.endDate) })}</p>
                  <div className="field">
                    <label htmlFor="prn-esc">{tr('Rent increase (%)')}</label>
                    <input id="prn-esc" className="input" type="number" min="0" step="0.01" value={form.escalationPercent} onChange={set('escalationPercent')} />
                    {Number(form.escalationPercent) > 0 && !form.monthlyRate && <span className="dk-muted tl-small">{tr('New rent: {amount} a month', { amount: money(target.monthlyRate * (1 + Number(form.escalationPercent) / 100), target.currency) })}</span>}
                  </div>
                  <div className="field">
                    <label htmlFor="prn-rate">{tr('Or set the monthly rate directly')}</label>
                    <input id="prn-rate" className="input" type="number" min="0" step="0.01" value={form.monthlyRate} onChange={set('monthlyRate')} placeholder={String(target.monthlyRate)} />
                  </div>
                  <div className="field">
                    <label htmlFor="prn-start">{tr('New start date')}</label>
                    <input id="prn-start" className="input" type="date" value={form.startDate} onChange={set('startDate')} />
                    <span className="dk-muted tl-small">{tr('Blank: the day after this one ends.')}</span>
                  </div>
                  <div className="field">
                    <span className="tl-label">{tr('How long')}</span>
                    <div className="pk-duration">
                      <input id="prn-months" className="input" type="number" min="0" step="1" aria-label={tr('Months')} value={form.durationMonths} onChange={set('durationMonths')} placeholder={String(target.durationMonths)} />
                      <span>{tr('months +')}</span>
                      <input id="prn-days" className="input" type="number" min="0" step="1" aria-label={tr('…plus days')} value={form.durationDays} onChange={set('durationDays')} placeholder={String(target.durationDays)} />
                      <span>{tr('days')}</span>
                    </div>
                  </div>
                </>
              )}
              {dialog === 'end' && (
                <>
                  <p className="dk-muted tl-small tl-span">{tr("{unitCode} becomes vacant immediately. Any unpaid invoices stay outstanding — ending a tenancy doesn't cancel what's owed.", { unitCode: target.unitCode })}</p>
                  <div className="field tl-span">
                    <span className="tl-label">{tr('Reason type')}</span>
                    <div className="tl-seg" role="radiogroup" aria-label={tr('Reason type')}>
                      {[['terminated', tr('Terminated early')], ['expired', tr('Ran to its end date')]].map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={form.status === k} className={'tl-seg-btn' + (form.status === k ? ' is-on' : '')} onClick={() => setForm({ ...form, status: k })}>{label}</button>)}
                    </div>
                  </div>
                  <div className="field tl-span">
                    <label htmlFor="pe-reason">{tr('Reason')}</label>
                    <textarea id="pe-reason" className="input tl-textarea" value={form.reason} onChange={set('reason')} />
                  </div>
                </>
              )}
            </div>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)} disabled={saving}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : tr('Confirm')}</button>
            </div>
          </form>
        </div>
      )}

      {/* ── agreement ── */}
      {dialog === 'agreement' && target && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <div className="dialog poki-agreement-dialog" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ margin: 0 }}>{tr('Tenancy agreement —')} {target.bookingNo}</h2>
            <p className="poki-muted" style={{ margin: 0 }}>{target.tenantName} · {target.propertyName} · {target.unitCode} · {fmtDate(target.startDate)} → {fmtDate(target.endDate)}</p>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <textarea className="input poki-agreement-body" value={agreementBody} onChange={(e) => setAgreementBody(e.target.value)} readOnly={!canManage}
              placeholder={saving ? tr('Generating…') : tr('No agreement yet — generate one from the template.')} />
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>{tr('Close')}</button>
              <button type="button" className="btn btn-secondary" disabled={!agreementBody} onClick={printAgreement}>{tr('Print / PDF')}</button>
              {canManage && <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => generateAgreement(target)}>{saving ? tr('Generating…') : tr('Regenerate from template')}</button>}
              {canManage && <button type="button" className="btn btn-primary" disabled={saving || !agreementBody} onClick={saveAgreement}>{tr('Save')}</button>}
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
