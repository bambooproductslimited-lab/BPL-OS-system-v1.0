import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import ContactButtons from '../components/ContactButtons';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { Glossary, Hero, Insights, Section, Status, jump } from '../components/DashKit';
import { money, moneyBreakdown } from '../lib/currency';
import DocPreview from '../components/DocPreview';
import { groupPackageItems } from '../lib/packages';
import { formatPaymentSchedule } from '../lib/paymentSchedule';
import './EmployeesPage.css';
import './ToolRoomPage.css';
import './RestaurantsPage.css';
import './PokiPages.css';
import './PokiRentals.css';
import RowMenu from '../components/RowMenu';

import { tr, activeIntlLocale, docTr } from '../lib/i18n.jsx';
import { formatDocDate } from '../lib/dates';
import { codeLabel } from '../lib/codeLabels.js';
// Rent & utilities — the billing desk. Rent is invoiced when a booking is
// made (it is paid for up front), so what happens here is: taking payments
// against invoices, raising one-off charges, and turning meter readings and
// shared building bills into utility invoices. Same "explains itself"
// layout as the dashboards (components/DashKit.jsx): the key numbers (owed
// and overdue, collected this month, readings not billed yet, shared bills
// not charged), what stands out (the most overdue invoice, readings waiting,
// metered units with no meter, meters not read for over a month), and two
// views — Invoices (with a call or WhatsApp button to chase the tenant and
// payment recorded in place) and Utilities (meters, readings, shared bills).

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).length > 10 ? iso : iso + 'T00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(activeIntlLocale(), { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function PokiBillingPage() {
  const { can } = useAuth();
  const canManage = can('poki.manage');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);

  const [previewInv, setPreviewInv] = useState(null);
  const [payFor, setPayFor] = useState(null);
  const [payForm, setPayForm] = useState({ amount: '', method: 'bank_transfer', reference: '', notes: '' });
  const [newInv, setNewInv] = useState(null);
  const [invError, setInvError] = useState(null);

  const [selected, setSelected] = useState({});
  const [view, setView] = useState('invoices');
  const [chip, setChip] = useState('unpaid');
  const [search, setSearch] = useState('');
  const [overview, setOverview] = useState(null);

  const [units, setUnits] = useState([]);
  const [meters, setMeters] = useState([]);
  const [readings, setReadings] = useState([]);
  const [masterBills, setMasterBills] = useState([]);
  const [properties, setProperties] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [charges, setCharges] = useState([]);
  const [chargeForm, setChargeForm] = useState(null); // new or edit, open when set
  const [chargeError, setChargeError] = useState(null);

  const [dialog, setDialog] = useState(null);
  const [form, setForm] = useState({});
  const [dialogError, setDialogError] = useState(null);
  const [split, setSplit] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [u, m, r, mb, inv, tn, ls] = await Promise.all([
        api.get('/poki/units'),
        api.get('/poki/meters'),
        api.get('/poki/readings'),
        api.get('/poki/master-bills'),
        api.get('/poki/invoices'),
        api.get('/poki/tenants'),
        api.get('/poki/bookings')
      ]);
      setUnits(u);
      setMeters(m);
      setReadings(r);
      setMasterBills(mb);
      setInvoices(inv);
      setTenants(tn);
      setBookings(ls);
      setProperties(await api.get('/poki/properties'));
      api.get('/poki/recurring-charges').then(setCharges).catch(() => {});
      api.get('/poki/overview').then(setOverview).catch(() => {});
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // The list row carries enough to display, but the printable invoice needs
  // its line items and the tenant's contact block, so fetch the full record.
  async function openPreview(inv) {
    setError(null);
    try {
      setPreviewInv(await api.get('/poki/invoices/' + inv.id));
    } catch (err) {
      setError(err.message);
    }
  }

  function openPay(inv) {
    setInvError(null);
    setPayForm({ amount: String(inv.balanceDue), method: 'bank_transfer', reference: '', notes: '' });
    setPayFor(inv);
  }

  async function submitPayment(e) {
    e.preventDefault();
    setBusy(true);
    setInvError(null);
    try {
      await api.post('/poki/invoices/' + payFor.id + '/payments', payForm);
      setToast(tr('Payment recorded on {invoiceNo}.', { invoiceNo: payFor.invoiceNo }));
      setPayFor(null);
      await load();
    } catch (err) {
      setInvError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function voidInvoice(inv) {
    if (!window.confirm(tr('Void {invoiceNo}? The number stays used, but the charge is cancelled.', { invoiceNo: inv.invoiceNo }))) return;
    setBusy(true);
    try {
      await api.post('/poki/invoices/' + inv.id + '/void', {});
      setToast(tr('{invoiceNo} voided.', { invoiceNo: inv.invoiceNo }));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function openNewInvoice() {
    setInvError(null);
    setNewInv({
      tenantId: '', bookingId: '', docKind: 'other', dueDate: '',
      notes: '', items: [{ description: '', qty: 1, unitPrice: '' }]
    });
  }

  async function submitNewInvoice(e) {
    e.preventDefault();
    setBusy(true);
    setInvError(null);
    try {
      const res = await api.post('/poki/invoices', {
        ...newInv,
        bookingId: newInv.bookingId || undefined,
        dueDate: newInv.dueDate || undefined,
        items: newInv.items.filter((i) => String(i.description).trim())
      });
      setToast(tr('Raised {invoiceNo}.', { invoiceNo: res.invoiceNo }));
      setNewInv(null);
      setView('invoices');
      await load();
    } catch (err) {
      setInvError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitDialog(e) {
    e.preventDefault();
    setBusy(true);
    setDialogError(null);
    try {
      if (dialog === 'meter') {
        await api.post('/poki/meters', form);
        setToast(tr('Meter added.'));
      } else if (dialog === 'reading') {
        await api.post('/poki/readings', form);
        setToast(tr('Reading recorded.'));
      } else if (dialog === 'master') {
        await api.post('/poki/master-bills', form);
        setToast(tr('Master bill recorded.'));
      }
      setDialog(null);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function billSelectedReadings() {
    const ids = readings.filter((r) => !r.invoiceId && selected['r_' + r.id]).map((r) => r.id);
    if (!ids.length) { setError(tr('Select at least one unbilled reading.')); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await api.post('/poki/readings/bill', { readingIds: ids });
      setToast(res.skippedUnits && res.skippedUnits.length
        ? tr('Raised {n} utility invoice(s). Skipped {units} — no active booking.', { n: res.created, units: res.skippedUnits.join(', ') })
        : tr('Raised {n} utility invoice(s).', { n: res.created }));
      setSelected({});
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function showSplit(bill) {
    try {
      setSplit(await api.get('/poki/master-bills/' + bill.id + '/split'));
      setDialog('split');
    } catch (err) {
      setError(err.message);
    }
  }

  async function billMaster() {
    setBusy(true);
    try {
      const res = await api.post('/poki/master-bills/' + split.billId + '/bill');
      setToast(tr('Apportioned to {created} tenant(s).', { created: res.created }));
      setDialog(null);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // ── recurring charges (CAM, flat utility fees) ─────────────────────
  const KIND_TEXT = { cam: tr('Service charge (CAM)'), utility: tr('Utilities (flat fee)'), other: tr('Recurring charge') };
  const FREQ_TEXT = { monthly: tr('every month'), quarterly: tr('every 3 months'), yearly: tr('every year') };
  function openCharge(c, bookingId) {
    setChargeError(null);
    setChargeForm(c
      ? { id: c.id, bookingId: c.bookingId, kind: c.kind, description: c.description, amount: String(c.amount), frequency: c.frequency, startDate: c.startDate, nextDate: c.nextDate, endDate: c.endDate || '', netDays: String(c.netDays) }
      : { bookingId: bookingId || '', kind: 'cam', description: '', amount: '', frequency: 'monthly', startDate: '', endDate: '', netDays: '14' });
  }
  async function saveCharge(e) {
    e.preventDefault();
    setBusy(true);
    setChargeError(null);
    try {
      const f = chargeForm;
      if (f.id) await api.put('/poki/recurring-charges/' + f.id, { description: f.description, amount: f.amount, frequency: f.frequency, nextDate: f.nextDate, endDate: f.endDate, netDays: f.netDays });
      else await api.post('/poki/recurring-charges', { bookingId: f.bookingId, kind: f.kind, description: f.description, amount: f.amount, frequency: f.frequency, startDate: f.startDate || undefined, endDate: f.endDate || undefined, netDays: f.netDays });
      setToast(f.id ? tr('Recurring charge updated.') : tr('Recurring charge set up. It is invoiced automatically on its date.'));
      setChargeForm(null);
      setCharges(await api.get('/poki/recurring-charges'));
    } catch (err) { setChargeError(err.message); } finally { setBusy(false); }
  }
  async function chargeAction(fn, done) {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      setToast(done(r));
      await load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  const billedText = (r) => (r.invoices.length ? (r.invoices.length === 1 ? tr('Invoice {no} raised.', { no: r.invoices[0].invoiceNo }) : tr('{n} invoices raised.', { n: r.invoices.length })) : tr('Nothing was due.'));

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  // ── what the page shows ────────────────────────────────────────────
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const daysSince = (d) => (d ? Math.round((today - new Date(String(d).slice(0, 10) + 'T00:00')) / 86400000) : null);
  const live = invoices.filter((i) => i.status !== 'void');
  const unpaid = live.filter((i) => i.status !== 'paid' && i.balanceDue > 0);
  const overdue = unpaid.filter((i) => i.overdue).sort((x, y) => String(x.dueDate).localeCompare(String(y.dueDate)));
  const sumBy = (list, f) => { const m = {}; list.forEach((i) => { m[i.currency] = (m[i.currency] || 0) + f(i); }); return Object.entries(m).filter(([, a]) => a).map(([currency, amount]) => ({ currency, amount })); };
  const unbilled = readings.filter((r) => !r.invoiceId);
  const unbilledTotal = unbilled.reduce((t, r) => t + r.amount, 0);
  const masterOpen = masterBills.filter((b) => !b.billedAt);
  const meteredUnits = units.filter((u) => u.utilityMode === 'metered' && u.active !== false);
  const noMeter = meteredUnits.filter((u) => !meters.some((m) => m.unitId === u.id));
  const unread = meters.filter((m) => m.active !== false && (!m.lastReadOn || daysSince(m.lastReadOn) > 40) && units.some((u) => u.id === m.unitId && u.status === 'occupied'));
  const thisMonth = new Date().toISOString().slice(0, 7);
  const lastMonth = (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7); })();
  const collected = (m) => (overview ? overview.collectedByMonth.filter((r) => r.month === m).map((r) => ({ currency: r.currency, amount: r.amount })) : []);
  const tenantByCustomer = new Map(tenants.map((t) => [t.customerId, t]));

  function showInvoices(key) { setView('invoices'); setChip(key); setTimeout(() => jump('pk-desk'), 0); }
  const stats = [
    { icon: 'owed', value: moneyBreakdown(sumBy(unpaid, (i) => i.balanceDue), money(0)), label: tr('owed by tenants'), note: overdue.length ? (overdue.length === 1 ? tr('1 invoice overdue') : tr('{n} invoices overdue', { n: overdue.length })) : tr('nothing past its due date'), tone: overdue.length ? 'bad' : '', onClick: () => showInvoices(overdue.length ? 'overdue' : 'unpaid') },
    { icon: 'cash', value: moneyBreakdown(collected(thisMonth), money(0)), label: tr('collected this month'), note: tr('{amount} last month', { amount: moneyBreakdown(collected(lastMonth), money(0)) }), onClick: () => showInvoices('paid') },
    { icon: 'clock', value: String(unbilled.length), label: tr('readings not billed'), note: unbilled.length ? tr('{amount} to charge', { amount: money(unbilledTotal) }) : tr('every reading is billed'), tone: unbilled.length ? 'alert' : '', onClick: () => { setView('utilities'); setTimeout(() => jump('pk-desk'), 0); } },
    { icon: 'doc', value: String(masterOpen.length), label: tr('shared bills not charged'), note: tr('building bills split across units'), tone: masterOpen.length ? 'alert' : '', onClick: () => { setView('utilities'); setTimeout(() => jump('pk-master'), 0); } }
  ];

  const insights = [];
  if (overdue.length) {
    const w = overdue[0];
    insights.push({ tone: 'bad', icon: 'owed', text: overdue.length === 1 ? tr('{name} has owed {amount} on {no} for {days} days.', { name: w.customerName, amount: money(w.balanceDue, w.currency), no: w.invoiceNo, days: daysSince(w.dueDate) }) : tr('{n} invoices are overdue; the oldest is {name}\'s {no}, {days} days.', { n: overdue.length, name: w.customerName, no: w.invoiceNo, days: daysSince(w.dueDate) }), action: canManage && overdue.length === 1 ? { label: tr('Record payment'), run: () => openPay(w) } : { label: tr('Show them'), run: () => showInvoices('overdue') } });
  }
  if (unbilled.length) insights.push({ tone: 'warn', icon: 'clock', text: unbilled.length === 1 ? tr('A reading of {amount} on {unit} has not been billed yet.', { amount: money(unbilled[0].amount), unit: unbilled[0].unitCode }) : tr('{n} meter readings worth {amount} have not been billed yet.', { n: unbilled.length, amount: money(unbilledTotal) }), action: { label: tr('Bill them'), run: () => { setView('utilities'); setTimeout(() => jump('pk-desk'), 0); } } });
  if (masterOpen.length) insights.push({ tone: 'warn', icon: 'doc', text: masterOpen.length === 1 ? tr('The {utility} bill for {property} has not been charged to the tenants.', { utility: codeLabel(masterOpen[0].utilityType).toLowerCase(), property: masterOpen[0].propertyName }) : tr('{n} shared bills have not been charged to the tenants.', { n: masterOpen.length }), action: { label: tr('Review & bill'), run: () => showSplit(masterOpen[0]) } });
  if (noMeter.length) insights.push({ tone: 'info', icon: 'warn', text: noMeter.length === 1 ? tr('{unit} is set to sub-metered utilities but has no meter, so its usage can\'t be billed.', { unit: noMeter[0].code }) : tr('{n} sub-metered units have no meter, so their usage can\'t be billed.', { n: noMeter.length }), action: canManage ? { label: tr('Add meter'), run: () => { setForm({ unitId: noMeter[0].id, utilityType: 'electricity', measureUnit: 'kWh', rate: '' }); setDialogError(null); setDialog('meter'); } } : null });
  if (unread.length) insights.push({ tone: 'info', icon: 'calendar', text: unread.length === 1 ? tr('The meter on {unit} has not been read for over a month.', { unit: unread[0].unitCode }) : tr('{n} meters on let units have not been read for over a month.', { n: unread.length }), action: canManage ? { label: tr('Record reading'), run: () => { setForm({ meterId: unread[0].id, periodStart: unread[0].lastReadOn ? String(unread[0].lastReadOn).slice(0, 10) : '', periodEnd: new Date().toISOString().slice(0, 10), currentReading: '' }); setDialogError(null); setDialog('reading'); } } : null });
  const todayIso = new Date().toISOString().slice(0, 10);
  const activeCharges = charges.filter((c) => c.status === 'active');
  const dueCharges = activeCharges.filter((c) => c.nextDate <= todayIso);
  const withCam = new Set(charges.filter((c) => c.kind === 'cam' && c.status !== 'ended').map((c) => c.bookingId));
  const noCam = bookings.filter((b) => b.status === 'active' && !withCam.has(b.id));
  if (dueCharges.length) insights.push({ tone: 'info', icon: 'calendar', text: dueCharges.length === 1 ? tr('{what} for {name} is due to be invoiced today. It goes out with the morning run, or bill it now.', { what: dueCharges[0].description, name: dueCharges[0].tenantName }) : tr('{n} recurring charges are due to be invoiced today. They go out with the morning run, or bill them now.', { n: dueCharges.length }), action: canManage ? { label: tr('Bill now'), run: () => chargeAction(() => api.post('/poki/recurring-charges/run'), billedText) } : null });
  if (canManage && noCam.length && charges.length) insights.push({ tone: 'info', icon: 'doc', text: noCam.length === 1 ? tr('{name}\'s booking {no} has no service charge (CAM) set up.', { name: noCam[0].tenantName, no: noCam[0].bookingNo }) : tr('{n} active bookings have no service charge (CAM) set up.', { n: noCam.length }), action: { label: tr('Set it up'), run: () => { setView('recurring'); openCharge(null, noCam[0].id); } } });
  if (!insights.length && invoices.length) insights.push({ tone: 'good', icon: 'check', text: tr('Everything billed is paid or in date, and every reading has been billed.') });

  const chipTest = {
    unpaid: (i) => unpaid.includes(i), overdue: (i) => overdue.includes(i), paid: (i) => i.status === 'paid',
    rent: (i) => i.docKind === 'rent', utility: (i) => i.docKind === 'utility', cam: (i) => i.docKind === 'cam', other: (i) => !['rent', 'utility', 'cam'].includes(i.docKind) && i.status !== 'void',
    void: (i) => i.status === 'void', all: () => true
  };
  const visible = invoices.filter(chipTest[chip] || chipTest.unpaid)
    .filter((i) => matchesQuery(search, i.invoiceNo, i.customerName, i.unitCode, i.propertyName, i.bookingNo));
  const chips = [
    ['unpaid', tr('Unpaid'), unpaid.length], ['overdue', tr('Overdue'), overdue.length], ['paid', tr('Paid'), live.filter(chipTest.paid).length],
    ['rent', tr('Rent'), live.filter(chipTest.rent).length], ['utility', tr('Utilities'), live.filter(chipTest.utility).length], ['cam', tr('Service charge (CAM)'), live.filter(chipTest.cam).length], ['other', tr('Other charges'), invoices.filter(chipTest.other).length],
    ['void', tr('Void'), invoices.filter(chipTest.void).length], ['all', tr('All'), invoices.length]
  ].filter(([k, , c]) => c > 0 || k === 'unpaid' || k === chip);
  function invState(i) {
    if (i.status === 'void') return { tone: 'muted', text: codeLabel('void') };
    if (i.status === 'paid') return { tone: 'good', text: codeLabel('paid') };
    if (i.overdue) { const d = daysSince(i.dueDate); return { tone: 'bad', text: d === 1 ? tr('1 day overdue') : tr('{daysOverdue} days overdue', { daysOverdue: d }) }; }
    if (i.amountPaid > 0) return { tone: 'warn', text: tr('part paid · due {date}', { date: fmtDate(i.dueDate) }) };
    return { tone: 'info', text: tr('due {date}', { date: fmtDate(i.dueDate) }) };
  }
  const readingsOf = (m) => readings.filter((r) => r.meterId === m.id);

  return (
    <div className="dk tl pk">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <Hero
        eyebrow={tr('Poki Rentals')}
        title={tr('Rent & utilities')}
        sub={tr('Take payments against what tenants owe, raise one-off charges, and turn meter readings and shared building bills into utility invoices. Rent itself is invoiced when a booking is made. Press a number to go to it.')}
        actions={canManage && (
          <>
            <button type="button" className="btn btn-primary" onClick={openNewInvoice}>{tr('New invoice')}</button>
            {meters.length > 0 && <button type="button" className="btn btn-secondary" onClick={() => { setForm({ meterId: meters[0].id, periodStart: '', periodEnd: '', currentReading: '' }); setDialogError(null); setDialog('reading'); }}>{tr('Record reading')}</button>}
          </>
        )}
        stats={stats} />

      <Insights items={insights.slice(0, 5)} />

      <div id="pk-desk" className="rs-views" role="tablist" aria-label={tr('Show')}>
        {[['invoices', tr('Invoices'), unpaid.length], ['utilities', tr('Utilities'), unbilled.length + masterOpen.length], ['recurring', tr('Recurring charges'), dueCharges.length]].map(([k, label, n]) => (
          <button key={k} type="button" role="tab" aria-selected={view === k} className={'rs-view' + (view === k ? ' is-on' : '')} onClick={() => setView(k)}>
            {label}{n ? <span className="ppl-chip-n">{n}</span> : null}
          </button>
        ))}
      </div>

      {view === 'invoices' && (
        <Section title={tr('Invoices')} sub={tr('Rent, utility and repair invoices for Poki tenants, oldest due first.')}>
          <div className="tl-tools"><div className="tl-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search invoice, tenant, unit…')} /></div></div>
          <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
            {chips.map(([key, label, c]) => (
              <button key={key} type="button" role="radio" aria-checked={chip === key} className={'ppl-chip' + (chip === key ? ' is-on' : '')} onClick={() => setChip(key)}>
                {label} <span className="ppl-chip-n">{c}</span>
              </button>
            ))}
          </div>
          {!visible.length ? (
            <div className="dk-empty tl-empty"><p>{invoices.length ? tr('Nothing matches. Try another search or filter.') : tr('Rent, utility and repair invoices raised for Poki tenants appear here.')}</p></div>
          ) : (
            <ul className="rs-list">
              {visible.slice().sort((x, y) => (chip === 'unpaid' || chip === 'overdue' ? String(x.dueDate).localeCompare(String(y.dueDate)) : 0)).map((i) => {
                const st = invState(i);
                const t = tenantByCustomer.get(i.customerId);
                return (
                  <li key={i.id} className={'rs-row' + (i.status === 'void' ? ' is-void' : '') + (st.tone === 'bad' ? ' is-short' : '')}>
                    <button type="button" className="rs-row-open" onClick={() => openPreview(i)}>
                      <span className="rs-row-main">
                        <strong>{i.customerName}</strong>
                        <span className="dk-muted tl-small">{[i.invoiceNo, codeLabel(i.docKind), i.unitCode ? i.unitCode + ' · ' + i.propertyName : null, i.periodStart ? fmtDate(i.periodStart) + ' – ' + fmtDate(i.periodEnd) : null].filter(Boolean).join(' · ')}</span>
                      </span>
                      <span className="rs-row-side">
                        <strong className={'rs-amount' + (i.balanceDue > 0 && i.status !== 'void' ? ' pk-owe' : '')}>{money(i.status === 'paid' || i.status === 'void' ? i.grandTotal : i.balanceDue, i.currency)}</strong>
                        <Status tone={st.tone}>{st.text}</Status>
                      </span>
                    </button>
                    <span className="pk-contact pk-inv-acts">
                      {canManage && i.status !== 'paid' && i.status !== 'void' && <button type="button" className="btn btn-secondary tl-btn" disabled={busy} onClick={() => openPay(i)}>{tr('Record payment')}</button>}
                      {i.balanceDue > 0 && i.status !== 'void' && t && <ContactButtons name={i.customerName} phone={t.phone} email={t.email} />}
                      <RowMenu actions={[
                        { label: tr('Print'), onClick: () => openPreview(i) },
                        { label: tr('Void'), onClick: () => voidInvoice(i), disabled: busy, danger: true, hidden: !(canManage && i.status !== 'void' && Number(i.amountPaid) === 0) }
                      ]} />
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      )}

      {view === 'recurring' && (
        <Section id="pk-recurring" title={tr('Recurring charges')} sub={tr('Service charge (CAM) and flat utility fees billed automatically every month, quarter or year for as long as the booking runs. Each is invoiced in advance on its date, and charges due the same day go on one invoice.')}
          action={canManage && (
            <div className="pk-actions">
              <button type="button" className="btn btn-secondary" disabled={busy || !dueCharges.length} onClick={() => chargeAction(() => api.post('/poki/recurring-charges/run'), billedText)}>{tr('Bill what is due')}</button>
              <button type="button" className="btn btn-primary" onClick={() => openCharge(null)}>{tr('New recurring charge')}</button>
            </div>
          )}>
          {!charges.length ? (
            <div className="dk-empty tl-empty"><p>{tr('No recurring charges yet. Set up the service charge (CAM) or a flat utility fee for a booking, and it is invoiced automatically.')}</p></div>
          ) : (
            <ul className="pk-rc-list">
              {charges.map((c) => {
                const due = c.status === 'active' && c.nextDate <= todayIso;
                return (
                  <li key={c.id} className={'pk-rc is-' + c.status}>
                    <div className="pk-rc-main">
                      <strong>{c.description} · {money(c.amount, c.currency)} {FREQ_TEXT[c.frequency]}</strong>
                      <span className="dk-muted tl-small">{c.tenantName} · {c.unitCode} · {c.propertyName} · {tr('booking {no}', { no: c.bookingNo })}</span>
                      <span className="dk-muted tl-small">
                        {c.periodsBilled ? tr('{n} periods billed, {amount} in all', { n: c.periodsBilled, amount: money(c.billedTotal, c.currency) }) : tr('Not billed yet')}
                        {c.lastInvoice ? ' · ' + tr('last: {no} ({status})', { no: c.lastInvoice.invoiceNo, status: codeLabel(c.lastInvoice.status) }) : ''}
                        {' · ' + tr('pay within {n} days', { n: c.netDays })}
                        {c.endDate ? ' · ' + tr('until {date}', { date: fmtDate(c.endDate) }) : ' · ' + tr('until the booking ends ({date})', { date: fmtDate(c.bookingEnd) })}
                      </span>
                    </div>
                    <div className="pk-rc-side">
                      <Status tone={c.status === 'ended' ? 'muted' : c.status === 'paused' ? 'warn' : due ? 'info' : 'good'}>
                        {c.status === 'ended' ? tr('Ended') : c.status === 'paused' ? tr('Paused') : due ? tr('Due today') : tr('Next {date}', { date: fmtDate(c.nextDate) })}
                      </Status>
                      {canManage && c.status !== 'ended' && (
                        <RowMenu actions={[
                          { label: tr('Edit'), onClick: () => openCharge(c) },
                          { label: tr('Bill the next period now'), onClick: () => chargeAction(() => api.post('/poki/recurring-charges/' + c.id + '/bill-now'), billedText), hidden: c.status !== 'active' },
                          { label: c.status === 'paused' ? tr('Resume') : tr('Pause'), onClick: () => chargeAction(() => api.post('/poki/recurring-charges/' + c.id + '/status', { status: c.status === 'paused' ? 'active' : 'paused' }), () => (c.status === 'paused' ? tr('Resumed.') : tr('Paused. Nothing is billed until you resume it.'))) },
                          { label: tr('End'), onClick: () => chargeAction(() => api.post('/poki/recurring-charges/' + c.id + '/status', { status: 'ended' }), () => tr('Ended. Invoices already raised stay as they are.')), danger: true },
                          { label: tr('Delete'), onClick: () => chargeAction(() => api.del('/poki/recurring-charges/' + c.id), () => tr('Deleted.')), danger: true, hidden: c.periodsBilled > 0 }
                        ]} />
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      )}

      {view === 'utilities' && (
        <>
          <Section title={tr('Meters')} sub={tr('A sub-meter on each unit set to metered utilities. Record a reading each period, then bill it.')}
            action={canManage && <button type="button" className="btn btn-secondary tl-btn" onClick={() => { setForm({ utilityType: 'electricity', measureUnit: 'kWh', rate: '' }); setDialogError(null); setDialog('meter'); }}>{tr('Add meter')}</button>}>
            {!meters.length ? (
              <div className="dk-empty tl-empty"><p>{tr('Add a sub-meter to any unit set to "metered" utilities, then record its readings each period to bill consumption.')}</p></div>
            ) : (
              <div className="tl-grid">
                {meters.map((m) => {
                  const rs = readingsOf(m);
                  const waiting = rs.filter((r) => !r.invoiceId);
                  const late = unread.includes(m);
                  return (
                    <article key={m.id} className={'tl-card' + (late ? ' st-low' : '')}>
                      <div className="tl-card-open pk-static">
                        <span className={'tl-badge pk-util is-' + m.utilityType} style={{ width: 44, height: 44 }} aria-hidden="true">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{m.utilityType === 'water' ? <path d="M12 3.5c3 4 6 7.2 6 10.5a6 6 0 0 1-12 0c0-3.3 3-6.5 6-10.5Z" /> : <path d="M13 3 5 13.5h6L10 21l8-10.5h-6z" />}</svg>
                        </span>
                        <span className="tl-card-head">
                          <span className="dk-muted tl-small">{m.propertyName} · {codeLabel(m.utilityType)}{m.meterNumber ? ' · ' + m.meterNumber : ''}</span>
                          <span className="tl-name">{m.unitCode}</span>
                        </span>
                      </div>
                      <div className="tl-tags">
                        {late ? <Status tone="warn">{m.lastReadOn ? tr('Last read {date}', { date: fmtDate(m.lastReadOn) }) : tr('Never read')}</Status> : m.lastReadOn ? <Status tone="muted">{tr('Last read {date}', { date: fmtDate(m.lastReadOn) })}</Status> : <Status tone="muted">{tr('Never read')}</Status>}
                        {waiting.length > 0 && <Status tone="warn">{tr('{amount} not billed', { amount: money(waiting.reduce((t, r) => t + r.amount, 0)) })}</Status>}
                      </div>
                      <div className="tl-foot">
                        <span className="dk-muted tl-small">{tr('reading {n} {unit}', { n: m.lastReading, unit: m.measureUnit })} · {tr('{rate} per {unit}', { rate: money(m.rate), unit: m.measureUnit })}</span>
                        {canManage && <button type="button" className="btn btn-secondary tl-btn" onClick={() => { setForm({ meterId: m.id, periodStart: m.lastReadOn ? String(m.lastReadOn).slice(0, 10) : '', periodEnd: new Date().toISOString().slice(0, 10), currentReading: '' }); setDialogError(null); setDialog('reading'); }}>{tr('Record reading')}</button>}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </Section>

          {readings.length > 0 && (
            <Section title={tr('Readings')} sub={tr('Tick the ones to bill; each tenant gets one invoice for theirs.')}
              action={canManage && unbilled.length > 0 && (
                <span className="rs-actions">
                  <button type="button" className="btn btn-secondary tl-btn" onClick={() => setSelected(Object.fromEntries(unbilled.map((r) => ['r_' + r.id, true])))}>{tr('Tick all not billed')}</button>
                  <button type="button" className="btn btn-primary tl-btn" disabled={busy || !unbilled.some((r) => selected['r_' + r.id])} onClick={billSelectedReadings}>{tr('Bill selected')}</button>
                </span>
              )}>
              <ul className="rs-list">
                {readings.map((r) => (
                  <li key={r.id} className="rs-row">
                    <label className="rs-row-open pk-reading">
                      {!r.invoiceId && canManage
                        ? <input type="checkbox" checked={!!selected['r_' + r.id]} onChange={(e) => setSelected({ ...selected, ['r_' + r.id]: e.target.checked })} aria-label={tr('Select reading for {unitCode}', { unitCode: r.unitCode })} />
                        : <span className="pk-reading-pad" />}
                      <span className="rs-row-main">
                        <strong>{r.unitCode} · {codeLabel(r.utilityType)}</strong>
                        <span className="dk-muted tl-small">{fmtDate(r.periodStart)} – {fmtDate(r.periodEnd)} · {r.previousReading} → {r.currentReading} · {tr('{n} {unit} used', { n: r.consumption, unit: r.measureUnit })}</span>
                      </span>
                      <span className="rs-row-side">
                        <strong className="rs-amount">{money(r.amount)}</strong>
                        {r.invoiceId ? <Status tone="good">{r.invoiceNo}</Status> : <Status tone="warn">{tr('unbilled')}</Status>}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section id="pk-master" title={tr('Shared (master) bills')} sub={tr('The whole-building ECG or Ghana Water bill, split across the units set to "apportioned". Review the split before charging it — apportioned utilities are the line tenants query most.')}
            action={canManage && properties.length > 0 && (
              <button type="button" className="btn btn-secondary tl-btn" onClick={() => { setForm({ propertyId: properties[0].id, utilityType: 'electricity', splitMethod: 'share', periodStart: '', periodEnd: '', totalAmount: '' }); setDialogError(null); setDialog('master'); }}>{tr('Record master bill')}</button>
            )}>
            {!masterBills.length ? <p className="dk-muted tl-small">{tr('Only needed if some units share a building meter rather than having their own.')}</p> : (
              <ul className="rs-list">
                {masterBills.map((b) => (
                  <li key={b.id} className="rs-row">
                    <button type="button" className="rs-row-open" onClick={() => showSplit(b)}>
                      <span className="rs-row-main">
                        <strong>{b.propertyName} · {codeLabel(b.utilityType)}</strong>
                        <span className="dk-muted tl-small">{fmtDate(b.periodStart)} – {fmtDate(b.periodEnd)} · {b.splitMethod === 'share' ? tr('unit share %') : b.splitMethod === 'sqm' ? tr('floor area') : tr('equally')}{b.reference ? ' · ' + b.reference : ''}</span>
                      </span>
                      <span className="rs-row-side">
                        <strong className="rs-amount">{money(b.totalAmount)}</strong>
                        {b.billedAt ? <Status tone="good">{tr('apportioned')}</Status> : <Status tone="warn">{tr('not billed')}</Status>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}

      <Glossary items={[
        [tr('Rent'), tr('Invoiced once, when a booking is made, for the whole booking. There is no monthly rent run.')],
        [tr('Sub-meter'), tr('A meter on one unit. Its readings are billed at the meter\'s rate to whoever is in the unit.')],
        [tr('Shared (master) bill'), tr('One bill for the whole building, split across the units by their share, their floor area or equally.')],
        [tr('Void'), tr('Cancels an invoice nothing has been paid on. The number stays used.')]
      ]} />

      {!invoices.length && !meters.length && <p className="dk-muted tl-small">{tr('Nothing billed yet.')} <Link to="/pokibookings">{tr('Bookings')}</Link></p>}

      {chargeForm && (
        <div className="dialog-backdrop" onClick={() => setChargeForm(null)}>
          <form className="dialog poki-dialog" onClick={(e) => e.stopPropagation()} onSubmit={saveCharge}>
            <h2 className="poki-dialog-title">{chargeForm.id ? tr('Edit recurring charge') : tr('New recurring charge')}</h2>
            {chargeError && <div className="error-banner poki-dialog-span">{chargeError}</div>}
            <div className="field poki-dialog-span">
              <label htmlFor="rc-booking">{tr('Booking')}</label>
              <select id="rc-booking" className="input" required disabled={!!chargeForm.id} value={chargeForm.bookingId} onChange={(e) => setChargeForm({ ...chargeForm, bookingId: e.target.value })}>
                <option value="">{tr('Choose a booking…')}</option>
                {bookings.filter((b) => b.status === 'active' || b.status === 'draft' || b.id === chargeForm.bookingId).map((b) => (
                  <option key={b.id} value={b.id}>{b.bookingNo} — {b.tenantName} — {b.unitCode} ({fmtDate(b.startDate)} → {fmtDate(b.endDate)})</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="rc-kind">{tr('What for')}</label>
              <select id="rc-kind" className="input" disabled={!!chargeForm.id} value={chargeForm.kind} onChange={(e) => setChargeForm({ ...chargeForm, kind: e.target.value })}>
                <option value="cam">{KIND_TEXT.cam}</option>
                <option value="utility">{KIND_TEXT.utility}</option>
                <option value="other">{tr('Something else')}</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="rc-desc">{tr('Line on the invoice')}</label>
              <input id="rc-desc" className="input" maxLength={120} value={chargeForm.description} placeholder={KIND_TEXT[chargeForm.kind]} onChange={(e) => setChargeForm({ ...chargeForm, description: e.target.value })} />
            </div>
            {chargeForm.kind === 'utility' && !chargeForm.id && <p className="dk-muted tl-small poki-dialog-span">{tr('If the unit\'s fixed utility fee was already included in the booking price, don\'t add it again here.')}</p>}
            <div className="field">
              <label htmlFor="rc-amount">{tr('Amount each time')}</label>
              <input id="rc-amount" className="input" type="number" min="0.01" step="0.01" required value={chargeForm.amount} onChange={(e) => setChargeForm({ ...chargeForm, amount: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="rc-freq">{tr('How often')}</label>
              <select id="rc-freq" className="input" value={chargeForm.frequency} onChange={(e) => setChargeForm({ ...chargeForm, frequency: e.target.value })}>
                <option value="monthly">{tr('Monthly')}</option>
                <option value="quarterly">{tr('Every 3 months')}</option>
                <option value="yearly">{tr('Yearly')}</option>
              </select>
            </div>
            {chargeForm.id ? (
              <div className="field">
                <label htmlFor="rc-next">{tr('Next invoice date')}</label>
                <input id="rc-next" className="input" type="date" required value={chargeForm.nextDate} onChange={(e) => setChargeForm({ ...chargeForm, nextDate: e.target.value })} />
              </div>
            ) : (
              <div className="field">
                <label htmlFor="rc-start">{tr('First invoice date')}</label>
                <input id="rc-start" className="input" type="date" value={chargeForm.startDate} onChange={(e) => setChargeForm({ ...chargeForm, startDate: e.target.value })} />
                <span className="dk-muted tl-small">{tr('Leave empty to start today (or when the booking starts). Each invoice covers the period that starts on its date.')}</span>
              </div>
            )}
            <div className="field">
              <label htmlFor="rc-end">{tr('Last date (optional)')}</label>
              <input id="rc-end" className="input" type="date" value={chargeForm.endDate} onChange={(e) => setChargeForm({ ...chargeForm, endDate: e.target.value })} />
              <span className="dk-muted tl-small">{tr('Empty: until the booking ends. A last part period is charged by the day.')}</span>
            </div>
            <div className="field">
              <label htmlFor="rc-net">{tr('Days to pay')}</label>
              <input id="rc-net" className="input" type="number" min="0" max="90" step="1" value={chargeForm.netDays} onChange={(e) => setChargeForm({ ...chargeForm, netDays: e.target.value })} />
            </div>
            <div className="dialog-actions poki-dialog-span">
              <button type="button" className="btn btn-secondary" onClick={() => setChargeForm(null)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? tr('Saving…') : chargeForm.id ? tr('Save') : tr('Set up charge')}</button>
            </div>
          </form>
        </div>
      )}

      {(dialog === 'meter' || dialog === 'reading' || dialog === 'master') && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <form className="dialog poki-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitDialog}>
            <h2 className="poki-dialog-title">
              {dialog === 'meter' && tr('Add meter')}
              {dialog === 'reading' && tr('Record meter reading')}
              {dialog === 'master' && tr('Record master utility bill')}
            </h2>
            {dialogError && <div className="error-banner poki-dialog-span">{dialogError}</div>}

            {dialog === 'meter' && (
              <>
                <div className="field">
                  <label htmlFor="pm-unit">{tr('Unit')}</label>
                  <select id="pm-unit" className="input" value={form.unitId || ''} onChange={set('unitId')} required>
                    <option value="">{tr('Choose a unit…')}</option>
                    {units.map((u) => <option key={u.id} value={u.id}>{u.propertyName} · {u.code}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="pm-type">{tr('Utility')}</label>
                  <select id="pm-type" className="input" value={form.utilityType} onChange={set('utilityType')}>
                    <option value="electricity">{tr('Electricity')}</option>
                    <option value="water">{tr('Water')}</option>
                    <option value="gas">{tr('Gas')}</option>
                    <option value="other">{tr('Other')}</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="pm-no">{tr('Meter number')}</label>
                  <input id="pm-no" className="input" value={form.meterNumber || ''} onChange={set('meterNumber')} />
                </div>
                <div className="field">
                  <label htmlFor="pm-unitlbl">{tr('Measured in')}</label>
                  <input id="pm-unitlbl" className="input" value={form.measureUnit} onChange={set('measureUnit')} placeholder="kWh, m³" />
                </div>
                <div className="field">
                  <label htmlFor="pm-rate">{tr('Rate per unit')}</label>
                  <input id="pm-rate" className="input" type="number" step="0.0001" value={form.rate} onChange={set('rate')} required />
                </div>
              </>
            )}

            {dialog === 'reading' && (
              <>
                <div className="field poki-dialog-span">
                  <label htmlFor="prd-meter">{tr('Meter')}</label>
                  <select id="prd-meter" className="input" value={form.meterId || ''} onChange={set('meterId')} required>
                    {meters.map((m) => (
                      <option key={m.id} value={m.id}>
                        {tr('{property} · {unit} — {utility} ({meter}) · last {reading}', { property: m.propertyName, unit: m.unitCode, utility: codeLabel(m.utilityType), meter: m.meterNumber || tr('no number'), reading: m.lastReading })}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="prd-start">{tr('Period start')}</label>
                  <input id="prd-start" className="input" type="date" value={form.periodStart} onChange={set('periodStart')} required />
                </div>
                <div className="field">
                  <label htmlFor="prd-end">{tr('Period end')}</label>
                  <input id="prd-end" className="input" type="date" value={form.periodEnd} onChange={set('periodEnd')} required />
                </div>
                <div className="field">
                  <label htmlFor="prd-prev">{tr('Previous reading')}</label>
                  <input id="prd-prev" className="input" type="number" step="0.001" value={form.previousReading || ''} onChange={set('previousReading')}
                    placeholder={String((meters.find((m) => m.id === form.meterId) || {}).lastReading || 0)} />
                </div>
                <div className="field">
                  <label htmlFor="prd-cur">{tr('Current reading')}</label>
                  <input id="prd-cur" className="input" type="number" step="0.001" value={form.currentReading} onChange={set('currentReading')} required />
                </div>
                <p className="poki-dialog-hint">
                  {tr('Leave the previous reading blank to carry forward this meter\'s last recorded figure.')}
                </p>
              </>
            )}

            {dialog === 'master' && (
              <>
                <div className="field">
                  <label htmlFor="pmb-prop">{tr('Property')}</label>
                  <select id="pmb-prop" className="input" value={form.propertyId} onChange={set('propertyId')} required>
                    {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="pmb-type">{tr('Utility')}</label>
                  <select id="pmb-type" className="input" value={form.utilityType} onChange={set('utilityType')}>
                    <option value="electricity">{tr('Electricity')}</option>
                    <option value="water">{tr('Water')}</option>
                    <option value="gas">{tr('Gas')}</option>
                    <option value="other">{tr('Other')}</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="pmb-start">{tr('Period start')}</label>
                  <input id="pmb-start" className="input" type="date" value={form.periodStart} onChange={set('periodStart')} required />
                </div>
                <div className="field">
                  <label htmlFor="pmb-end">{tr('Period end')}</label>
                  <input id="pmb-end" className="input" type="date" value={form.periodEnd} onChange={set('periodEnd')} required />
                </div>
                <div className="field">
                  <label htmlFor="pmb-total">{tr('Bill total')}</label>
                  <input id="pmb-total" className="input" type="number" step="0.01" value={form.totalAmount} onChange={set('totalAmount')} required />
                </div>
                <div className="field">
                  <label htmlFor="pmb-split">{tr('Split by')}</label>
                  <select id="pmb-split" className="input" value={form.splitMethod} onChange={set('splitMethod')}>
                    <option value="share">{tr('Each unit\'s share %')}</option>
                    <option value="equal">{tr('Equally between units')}</option>
                    <option value="sqm">{tr('Floor area')}</option>
                  </select>
                </div>
                <div className="field poki-dialog-span">
                  <label htmlFor="pmb-ref">{tr('Reference')}</label>
                  <input id="pmb-ref" className="input" value={form.reference || ''} onChange={set('reference')} placeholder={tr('e.g. ECG account / bill number')} />
                </div>
              </>
            )}

            <div className="poki-dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? tr('Saving…') : tr('Save')}</button>
            </div>
          </form>
        </div>
      )}

      {dialog === 'split' && split && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <div className="dialog poki-dialog" onClick={(e) => e.stopPropagation()}>
            <h2 className="poki-dialog-title">{tr('Split —')} {split.propertyName}</h2>
            <p className="poki-dialog-hint">
              {tr('{amount} for {from} → {to}, split by {method}.', {
                amount: money(split.totalAmount, 'GHS'), from: fmtDate(split.periodStart), to: fmtDate(split.periodEnd),
                method: split.splitMethod === 'share' ? tr("each unit's share %") : split.splitMethod === 'sqm' ? tr('floor area') : tr('equal shares')
              })}
            </p>
            {dialogError && <div className="error-banner poki-dialog-span">{dialogError}</div>}
            {split.weightBasisMissing && (
              <p className="poki-dialog-hint poki-overdue">
                {tr('No usable shares or floor areas are recorded on these units, so the bill is being split equally.')}
              </p>
            )}
            <div className="poki-dialog-span">
              {split.lines.length === 0 ? (
                <p className="poki-muted">{split.note || tr('No apportioned units in this property.')}</p>
              ) : (
                <table className="table">
                  <thead><tr><th>{tr('Unit')}</th><th>{tr('Tenant')}</th><th className="poki-num">{tr('Share')}</th><th className="poki-num">{tr('Amount')}</th></tr></thead>
                  <tbody>
                    {split.lines.map((l) => (
                      <tr key={l.unitId}>
                        <td className="poki-strong">{l.unitCode}</td>
                        <td>{l.tenantName || <span className="poki-muted">{tr('vacant — not billed')}</span>}</td>
                        <td className="poki-num">{l.sharePercent}%</td>
                        <td className="poki-num">{money(l.amount, l.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="poki-dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>{tr('Close')}</button>
              {canManage && !split.billedAt && split.lines.some((l) => l.billable) && (
                <button type="button" className="btn btn-primary" disabled={busy} onClick={billMaster}>
                  {busy ? tr('Billing…') : tr('Charge to tenants')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {payFor && (
        <div className="dialog-backdrop" onClick={() => setPayFor(null)}>
          <form className="dialog poki-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitPayment}>
            <h2 className="poki-dialog-title">{tr('Record payment —')} {payFor.invoiceNo}</h2>
            <p className="poki-dialog-hint poki-dialog-span">
              {tr('{customerName} · outstanding {amount}. A receipt is generated automatically, and part payments are fine.', { customerName: payFor.customerName, amount: money(payFor.balanceDue, payFor.currency) })}
            </p>
            {invError && <div className="error-banner poki-dialog-span">{invError}</div>}
            <div className="field">
              <label htmlFor="pp-amount">{tr('Amount')}</label>
              <input id="pp-amount" className="input" type="number" step="0.01" value={payForm.amount}
                onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="pp-method">{tr('Method')}</label>
              <select id="pp-method" className="input" value={payForm.method}
                onChange={(e) => setPayForm({ ...payForm, method: e.target.value })}>
                <option value="bank_transfer">{tr('Bank transfer')}</option>
                <option value="mobile_money">{tr('Mobile money')}</option>
                <option value="cash">{tr('Cash')}</option>
                <option value="cheque">{tr('Cheque')}</option>
                <option value="card">{tr('Card')}</option>
                <option value="other">{tr('Other')}</option>
              </select>
            </div>
            <div className="field poki-dialog-span">
              <label htmlFor="pp-ref">{tr('Reference')}</label>
              <input id="pp-ref" className="input" value={payForm.reference}
                onChange={(e) => setPayForm({ ...payForm, reference: e.target.value })}
                placeholder={tr('momo transaction id, cheque no…')} />
            </div>
            <div className="poki-dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setPayFor(null)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? tr('Saving…') : tr('Record payment')}</button>
            </div>
          </form>
        </div>
      )}

      {newInv && (
        <div className="dialog-backdrop" onClick={() => setNewInv(null)}>
          <form className="dialog poki-dialog poki-offer-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitNewInvoice}>
            <h2 className="poki-dialog-title">{tr('New invoice')}</h2>
            <p className="poki-dialog-hint poki-dialog-span">
              {tr('For one-off charges — service charge, late fee, cleaning, damages. Rent is invoiced with its booking and metered utilities from the Utilities view, so their bookkeeping stays in step.')}
            </p>
            {invError && <div className="error-banner poki-dialog-span">{invError}</div>}

            <div className="field">
              <label htmlFor="pn-tenant">{tr('Tenant')}</label>
              <select id="pn-tenant" className="input" value={newInv.tenantId}
                onChange={(e) => setNewInv({ ...newInv, tenantId: e.target.value, bookingId: '' })} required>
                <option value="">{tr('Choose a tenant…')}</option>
                {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="pn-kind">{tr('Charge kind')}</label>
              <select id="pn-kind" className="input" value={newInv.docKind}
                onChange={(e) => setNewInv({ ...newInv, docKind: e.target.value })}>
                <option value="other">{tr('Other')}</option>
                <option value="deposit">{tr('Deposit')}</option>
                <option value="maintenance">{tr('Maintenance')}</option>
              </select>
            </div>
            <div className="field poki-dialog-span">
              <label htmlFor="pn-booking">{tr('Against booking (optional)')}</label>
              <select id="pn-booking" className="input" value={newInv.bookingId}
                onChange={(e) => setNewInv({ ...newInv, bookingId: e.target.value })}>
                <option value="">{tr('Not tied to a booking')}</option>
                {bookings.filter((l) => !newInv.tenantId || l.tenantId === newInv.tenantId).map((l) => (
                  <option key={l.id} value={l.id}>{l.bookingNo} · {l.propertyName} · {l.unitCode}</option>
                ))}
              </select>
              <p className="poki-dialog-hint">{tr('Attaching the booking makes the charge show in that tenancy’s arrears.')}</p>
            </div>

            <div className="poki-dialog-span">
              <div className="poki-lines-head">
                <span>{tr('Lines')}</span>
                <span className="poki-muted">
                  {tr('Total')} {money(newInv.items.reduce((sum, it) => sum + (Number(it.qty) || 0) * (Number(it.unitPrice) || 0), 0), 'GHS')}
                </span>
              </div>
              {newInv.items.map((it, idx) => (
                <div className="poki-line-row" key={idx}>
                  <input className="input" placeholder={tr('Description')} value={it.description}
                    aria-label={tr('Line {n} description', { n: idx + 1 })}
                    onChange={(e) => setNewInv({ ...newInv, items: newInv.items.map((x, j) => (j === idx ? { ...x, description: e.target.value } : x)) })} />
                  <input className="input" type="number" step="0.01" placeholder={tr('Qty')} value={it.qty}
                    aria-label={tr('Line {n} quantity', { n: idx + 1 })}
                    onChange={(e) => setNewInv({ ...newInv, items: newInv.items.map((x, j) => (j === idx ? { ...x, qty: e.target.value } : x)) })} />
                  <input className="input" placeholder={tr('Unit')} value={it.unit || ''}
                    aria-label={tr('Line {n} unit', { n: idx + 1 })}
                    onChange={(e) => setNewInv({ ...newInv, items: newInv.items.map((x, j) => (j === idx ? { ...x, unit: e.target.value } : x)) })} />
                  <input className="input" type="number" step="0.01" placeholder={tr('Price')} value={it.unitPrice}
                    aria-label={tr('Line {n} price', { n: idx + 1 })}
                    onChange={(e) => setNewInv({ ...newInv, items: newInv.items.map((x, j) => (j === idx ? { ...x, unitPrice: e.target.value } : x)) })} />
                  <span className="poki-line-total">{money((Number(it.qty) || 0) * (Number(it.unitPrice) || 0), 'GHS')}</span>
                  <button type="button" className="btn btn-secondary poki-row-btn" aria-label={tr('Remove line {n}', { n: idx + 1 })}
                    onClick={() => setNewInv({ ...newInv, items: newInv.items.length > 1 ? newInv.items.filter((_, j) => j !== idx) : newInv.items })}>×</button>
                </div>
              ))}
              <button type="button" className="btn btn-secondary poki-row-btn"
                onClick={() => setNewInv({ ...newInv, items: [...newInv.items, { description: '', qty: 1, unitPrice: '' }] })}>{tr('Add line')}</button>
            </div>

            <div className="field">
              <label htmlFor="pn-due">{tr('Due date')}</label>
              <input id="pn-due" className="input" type="date" value={newInv.dueDate}
                onChange={(e) => setNewInv({ ...newInv, dueDate: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="pn-notes">{tr('Note on the invoice')}</label>
              <input id="pn-notes" className="input" value={newInv.notes}
                onChange={(e) => setNewInv({ ...newInv, notes: e.target.value })} />
            </div>

            <div className="poki-dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setNewInv(null)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? tr('Raising…') : tr('Raise invoice')}</button>
            </div>
          </form>
        </div>
      )}

      {previewInv && (
        <DocPreview
          documentType="invoice" documentId={previewInv.id}
          company={previewInv.company}
          // Poki managers hold poki.manage, not invoice.manage, so share
          // links go through Poki's own endpoints.
          shareApi={{
            create: (expiresInDays) => api.post('/poki/invoices/' + previewInv.id + '/share', { expiresInDays: expiresInDays || undefined }),
            whatsapp: (url) => api.post('/poki/invoices/' + previewInv.id + '/share/whatsapp', { url })
          }}
          docLabel={docTr('Invoice #{invoiceNo}', { invoiceNo: previewInv.invoiceNo })}
          dateLabel={docTr('Issue date')}
          dateValue={formatDocDate(previewInv.issuedAt)}
          heading={docTr('Invoice for {customerName}', { customerName: previewInv.customerName })}
          subHeading={docTr('Due {date}', { date: formatDocDate(previewInv.dueDate) })}
          blocks={[
            { title: docTr('Tenant'), lines: [previewInv.customerName, previewInv.customerEmail || previewInv.customerPhone || ''] },
            {
              title: docTr('Property'),
              lines: previewInv.unitCode
                ? [previewInv.propertyName + ' · ' + previewInv.unitCode, previewInv.bookingNo || '']
                : ['—', '']
            },
            {
              title: previewInv.periodStart ? docTr('Period') : docTr('Invoice'),
              lines: previewInv.periodStart
                ? [formatDocDate(previewInv.periodStart) + ' → ' + formatDocDate(previewInv.periodEnd), money(previewInv.grandTotal, previewInv.currency)]
                : [docTr('Issued {date}', { date: formatDocDate(previewInv.issuedAt) }), money(previewInv.grandTotal, previewInv.currency)]
            }
          ]}
          items={groupPackageItems(previewInv.items, previewInv.currency)}
          subtotal={money(previewInv.subtotal, previewInv.currency)}
          isPartial={previewInv.amountPaid > 0 && previewInv.balanceDue > 0}
          amountPaid={money(previewInv.amountPaid, previewInv.currency)}
          totalLabel={docTr('Total Due')}
          total={money(previewInv.balanceDue, previewInv.currency)}
          notesLabel={docTr('Payment instructions')}
          notesValue={previewInv.bankInstructions}
          paymentSchedule={formatPaymentSchedule(previewInv.paymentSchedule, previewInv.currency)}
          onClose={() => setPreviewInv(null)}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
