import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import WaybillPreview from '../components/WaybillPreview';
import CatalogPicker from '../components/CatalogPicker';
import ContactButtons from '../components/ContactButtons';
import Photo from '../components/Photo';
import RowMenu from '../components/RowMenu';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { Glossary, Hero, Insights, RankList, Section, Status, fmtDate, jump } from '../components/DashKit';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './EmployeesPage.css';
import './WaybillsPage.css';

// Waybills document goods leaving the factory or showroom — a delivery
// note, not a sales document (no pricing on the line items). The printed
// document (WaybillPreview.jsx) carries the full company letterhead, a
// "shipped to" contact block, and three sign-off lines.
//
// Same "explains itself" layout as the dashboards (components/DashKit.jsx):
// the key numbers (on the road, delivered and dispatched this month, items
// sent), what stands out (deliveries not confirmed after a few days, no
// driver or vehicle recorded), where goods went this month, then the
// waybills with their route, and a window for each. Marking one delivered
// records who signed for it and anything short or damaged
// (waybills.service.js setStatus).

const ORIGINS = { factory: msg('Factory'), showroom: msg('Showroom') };
const STATUS_TEXT = { dispatched: msg('On the road'), delivered: msg('Delivered'), cancelled: msg('Cancelled') };
const LATE_DAYS = 3;

function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function daysSince(iso) { return iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : null; }
function n(v) { return Number(v || 0).toLocaleString(activeIntlLocale(), { maximumFractionDigits: 2 }); }
function itemCount(wb) { return (wb.items || []).reduce((s, it) => s + (Number(it.qty) || 0), 0); }
function itemsLine(wb) {
  const items = wb.items || [];
  if (!items.length) return tr('no items listed');
  const first = items[0].qty + ' ' + (items[0].unit || '') + ' ' + items[0].description;
  return items.length === 1 ? first : tr('{first} and {n} more', { first, n: items.length - 1 });
}
function statusTone(s, late) { return s === 'delivered' ? 'good' : s === 'cancelled' ? 'muted' : late ? 'bad' : 'info'; }

function blankItem() { return { itemNo: '', description: '', qty: 1, unit: 'each' }; }
const EMPTY_FORM = {
  origin: 'factory', destination: '', customerId: '', driverName: '', vehicleNo: '', receivedBy: '',
  shippedToName: '', shippedToAddress: '', shippedToPhone: '', shippedToEmail: '', shippingDate: todayISO(),
  salesRepId: '', packagedBy: '', approvedBy: '', notes: '', items: [blankItem()]
};

export default function WaybillsPage() {
  const { can } = useAuth();
  const canManage = can('waybill.manage');

  const [waybills, setWaybills] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [detail, setDetail] = useState(null);
  const [previewWb, setPreviewWb] = useState(null);
  const [chip, setChip] = useState('road');
  const [origin, setOrigin] = useState('');
  const [search, setSearch] = useState('');

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [dialogError, setDialogError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [marking, setMarking] = useState(null); // { wb, status, receivedBy, deliveredOn, note }

  const load = useCallback(async () => {
    setError(null);
    try {
      const [wbs, custs, emps, cat] = await Promise.all([
        api.get('/waybills'),
        can('customer.read') ? api.get('/customers').catch(() => []) : Promise.resolve([]),
        can('employee.read') ? api.get('/employees').catch(() => []) : Promise.resolve([]),
        can('catalog.read') ? api.get('/catalog').catch(() => []) : Promise.resolve([])
      ]);
      setWaybills(wbs);
      setCustomers(custs);
      setEmployees(emps);
      setCatalog(cat.filter((c) => c.active));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [can]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  function openNew() {
    setDialogError(null);
    setForm({ ...EMPTY_FORM, shippingDate: todayISO(), items: [blankItem()] });
    setDialogOpen(true);
  }
  function pickCustomer(customerId) {
    const c = customers.find((x) => x.id === customerId);
    const autoFill = c && !form.shippedToName && !form.shippedToAddress && !form.shippedToPhone && !form.shippedToEmail;
    setForm({
      ...form, customerId,
      ...(autoFill ? { shippedToName: c.name, shippedToAddress: c.address || '', shippedToPhone: c.phone || '', shippedToEmail: c.email || '' } : {})
    });
  }
  function setItem(idx, key, value) {
    setForm({ ...form, items: form.items.map((it, i) => (i === idx ? { ...it, [key]: value } : it)) });
  }
  function pickCatalogItem(idx, c) {
    if (!c) return;
    setForm({ ...form, items: form.items.map((it, i) => (i === idx ? { ...it, itemNo: c.code || it.itemNo, description: c.name, unit: c.unit } : it)) });
  }
  function addItem() { setForm({ ...form, items: form.items.concat([blankItem()]) }); }
  function removeItem(idx) {
    if (form.items.length <= 1) return;
    setForm({ ...form, items: form.items.filter((_, i) => i !== idx) });
  }
  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      const body = { ...form, customerId: form.customerId || null, salesRepId: form.salesRepId || null };
      const created = await api.post('/waybills', body);
      setToast(tr('{waybillNo} dispatched.', { waybillNo: created.waybillNo }));
      setDialogOpen(false);
      setChip('road');
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }
  function openMark(wb, status) {
    setDialogError(null);
    setDetail(null);
    setMarking({ wb, status, receivedBy: wb.receivedBy || '', deliveredOn: todayISO(), note: '' });
  }
  async function saveMark(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      const { wb, status } = marking;
      await api.post('/waybills/' + wb.id + '/status', { status, receivedBy: marking.receivedBy, deliveredOn: marking.deliveredOn, note: marking.note });
      setToast(status === 'delivered' ? tr('{waybillNo} delivered.', { waybillNo: wb.waybillNo }) : status === 'cancelled' ? tr('{waybillNo} cancelled.', { waybillNo: wb.waybillNo }) : tr('{waybillNo} is back on the road.', { waybillNo: wb.waybillNo }));
      setMarking(null);
      await load();
    } catch (err) { setDialogError(err.message); } finally { setSaving(false); }
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const monthKey = todayISO().slice(0, 7);
  const road = waybills.filter((w) => w.status === 'dispatched');
  // Days on the road count from the shipping date.
  const late = road.filter((w) => daysSince(w.shippingDate || w.createdAt) >= LATE_DAYS);
  const month = waybills.filter((w) => String(w.shippingDate || w.createdAt).slice(0, 7) === monthKey && w.status !== 'cancelled');
  const deliveredMonth = waybills.filter((w) => w.status === 'delivered' && String(w.deliveredAt).slice(0, 7) === monthKey);
  const today = waybills.filter((w) => String(w.shippingDate || w.createdAt).slice(0, 10) === todayISO() && w.status !== 'cancelled');
  const noDriver = road.filter((w) => !w.driverName && !w.vehicleNo);
  const shortNotes = waybills.filter((w) => /Delivery:/.test(w.notes || '') && String(w.deliveredAt).slice(0, 7) === monthKey);
  const byPlace = Array.from(month.reduce((m, w) => {
    const key = w.customerName || w.shippedToName || w.destination;
    const cur = m.get(key) || { key, name: key, value: 0, trips: 0, dest: w.destination };
    cur.value += itemCount(w); cur.trips += 1;
    return m.set(key, cur);
  }, new Map()).values()).sort((a, b) => b.trips - a.trips || b.value - a.value).slice(0, 6)
    .map((r) => ({ ...r, amount: r.trips === 1 ? tr('1 waybill') : tr('{n} waybills', { n: r.trips }), meta: tr('{n} items · {place}', { n: n(r.value), place: r.dest }) }));

  function showOnly(key) { setChip(chip === key ? 'all' : key); jump('wb-list'); }
  const stats = [
    { icon: 'send', value: String(road.length), label: tr('on the road'), note: late.length ? tr('{n} not confirmed after {d} days', { n: late.length, d: LATE_DAYS }) : tr('waiting to be delivered'), tone: late.length ? 'alert' : '', onClick: () => showOnly('road') },
    { icon: 'check', value: String(deliveredMonth.length), label: tr('delivered this month'), note: shortNotes.length ? tr('{n} with a note on the delivery', { n: shortNotes.length }) : tr('signed for'), tone: deliveredMonth.length ? 'good' : '', onClick: () => showOnly('delivered') },
    { icon: 'doc', value: String(month.length), label: tr('dispatched this month'), note: today.length ? tr('{n} today', { n: today.length }) : tr('none today'), onClick: () => showOnly('month') },
    { icon: 'bag', value: n(month.reduce((s, w) => s + itemCount(w), 0)), label: tr('items sent this month'), note: tr('from the factory and showroom'), onClick: () => jump('wb-where') }
  ];

  const insights = [];
  if (late.length) insights.push({ tone: 'warn', icon: 'clock', text: late.length === 1 ? tr('{no} to {place} left {d} days ago and is not confirmed delivered.', { no: late[0].waybillNo, place: late[0].destination, d: daysSince(late[0].shippingDate || late[0].createdAt) }) : tr('{n} waybills left more than {d} days ago and are not confirmed delivered.', { n: late.length, d: LATE_DAYS }), action: canManage && late.length === 1 ? { label: tr('Mark delivered'), run: () => openMark(late[0], 'delivered') } : { label: tr('Show them'), run: () => showOnly('late') } });
  if (noDriver.length) insights.push({ tone: 'info', icon: 'people', text: noDriver.length === 1 ? tr('{no} has no driver or vehicle recorded.', { no: noDriver[0].waybillNo }) : tr('{n} waybills on the road have no driver or vehicle recorded.', { n: noDriver.length }), action: { label: tr('Show them'), run: () => showOnly('road') } });
  if (shortNotes.length) insights.push({ tone: 'warn', icon: 'warn', text: shortNotes.length === 1 ? tr('The delivery of {no} has a note: {note}', { no: shortNotes[0].waybillNo, note: (shortNotes[0].notes.split('Delivery: ').pop() || '').split('\n')[0] }) : tr('{n} deliveries this month have a note about something short or damaged.', { n: shortNotes.length }), action: { label: tr('Open it'), run: () => setDetail(shortNotes[0]) } });
  if (byPlace.length) insights.push({ tone: 'info', icon: 'up', text: tr('Most sent this month: {name}, {trips}.', { name: byPlace[0].name, trips: byPlace[0].amount }) });
  if (!late.length && road.length === 0 && waybills.length) insights.push({ tone: 'good', icon: 'check', text: tr('Everything sent has been delivered.') });

  const chipTest = {
    road: (w) => w.status === 'dispatched',
    late: (w) => late.includes(w),
    delivered: (w) => w.status === 'delivered',
    month: (w) => month.includes(w),
    cancelled: (w) => w.status === 'cancelled',
    all: () => true
  };
  const visible = waybills.filter(chipTest[chip] || chipTest.all)
    .filter((w) => !origin || w.origin === origin)
    .filter((w) => matchesQuery(search, w.waybillNo, w.destination, w.customerName, w.shippedToName, w.driverName, w.vehicleNo, w.receivedBy, ...(w.items || []).map((it) => it.description)));
  const chips = [
    ['road', tr('On the road'), road.length],
    ['late', tr('Not confirmed after {d} days', { d: LATE_DAYS }), late.length],
    ['delivered', tr('Delivered'), waybills.filter(chipTest.delivered).length],
    ['month', tr('This month'), month.length],
    ['cancelled', tr('Cancelled'), waybills.filter(chipTest.cancelled).length],
    ['all', tr('All'), waybills.length]
  ].filter(([k, , c]) => c > 0 || k === 'all' || k === chip);

  function waybillActions(wb) {
    return [
      { label: tr('Open'), onClick: () => setDetail(wb) },
      { label: tr('Preview and print'), onClick: () => setPreviewWb(wb) },
      canManage && wb.status === 'dispatched' && { label: tr('Mark delivered'), onClick: () => openMark(wb, 'delivered') },
      canManage && wb.status === 'dispatched' && { label: tr('Cancel'), onClick: () => openMark(wb, 'cancelled'), danger: true },
      canManage && wb.status !== 'dispatched' && { label: tr('Put back on the road'), onClick: () => openMark(wb, 'dispatched') }
    ].filter(Boolean);
  }

  return (
    <div className="dk wb">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <Hero
        eyebrow={new Date().toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        title={tr('Waybills')}
        sub={tr('Delivery notes for goods leaving the factory or showroom: what went, where, with which driver, and who signed for it. Press a number to show only those.')}
        actions={canManage && <button type="button" className="btn btn-primary" onClick={openNew}>{tr('New waybill')}</button>}
        stats={stats} />

      <Insights items={insights.slice(0, 5)} />

      <Section id="wb-list" title={tr('Waybills')} sub={tr('Newest first. Press one for its items and delivery.')}>
        <div className="wb-tools">
          <div className="wb-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search waybill, place, customer, driver, item…')} /></div>
          <select className="input wb-select" value={origin} onChange={(e) => setOrigin(e.target.value)} aria-label={tr('Origin')}>
            <option value="">{tr('Factory and showroom')}</option>
            <option value="factory">{tr('From the factory')}</option>
            <option value="showroom">{tr('From the showroom')}</option>
          </select>
        </div>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {chips.map(([key, label, c]) => (
            <button key={key} type="button" role="radio" aria-checked={chip === key} className={'ppl-chip' + (chip === key ? ' is-on' : '')} onClick={() => setChip(key)}>
              {label} <span className="ppl-chip-n">{c}</span>
            </button>
          ))}
        </div>
        {visible.length ? (
          <ul className="wb-list">
            {visible.map((wb) => {
              const isLate = late.includes(wb);
              const since = daysSince(wb.shippingDate || wb.createdAt);
              return (
                <li key={wb.id} className={'wb-row is-' + wb.status + (isLate ? ' is-late' : '')}>
                  <button type="button" className="wb-open" onClick={() => setDetail(wb)}>
                    <span className={'wb-origin is-' + wb.origin} aria-hidden="true">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"><path d="M3 6.5h10v9H3zM13 10h3.5L20 13v2.5h-7z" /><circle cx="7" cy="17" r="1.6" /><circle cx="17" cy="17" r="1.6" /></svg>
                    </span>
                    <span className="wb-main">
                      <span className="wb-title">{wb.waybillNo} <span className="wb-route">{tr(ORIGINS[wb.origin])} → {wb.destination}</span></span>
                      <span className="dk-muted wb-sub">{wb.customerName || wb.shippedToName} · {itemsLine(wb)}</span>
                    </span>
                  </button>
                  <span className="wb-driver">
                    {wb.driverName || wb.vehicleNo ? <><strong>{wb.driverName || '—'}</strong><span className="dk-muted">{wb.vehicleNo}</span></> : <span className="dk-muted">{tr('No driver recorded')}</span>}
                  </span>
                  <span className="wb-when">
                    <span>{fmtDate(String(wb.shippingDate || wb.createdAt).slice(0, 10))}</span>
                    <Status tone={statusTone(wb.status, isLate)}>{wb.status === 'dispatched' && since > 0 ? (since === 1 ? tr('On the road, 1 day') : tr('On the road, {n} days', { n: since })) : tr(STATUS_TEXT[wb.status])}</Status>
                  </span>
                  <span className="wb-acts">
                    {canManage && wb.status === 'dispatched' && <button type="button" className="btn btn-secondary wb-btn" onClick={() => openMark(wb, 'delivered')}>{tr('Delivered')}</button>}
                    <RowMenu actions={waybillActions(wb)} />
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="dk-empty wb-empty">
            <p>{waybills.length ? tr('Nothing here. Try another filter.') : tr('No waybills yet')}</p>
            {canManage && !waybills.length && <button type="button" className="btn btn-primary" onClick={openNew}>{tr('New waybill')}</button>}
          </div>
        )}
      </Section>

      {byPlace.length > 0 && (
        <Section id="wb-where" title={tr('Where goods went this month')} sub={tr('Customers and places by number of waybills.')} card>
          <RankList rows={byPlace} />
        </Section>
      )}

      <Glossary items={[
        [tr('On the road'), tr('Dispatched and not yet confirmed delivered.')],
        [tr('Delivered'), tr('Signed for at the other end. Record who signed and anything short or damaged.')],
        [tr('Waybill'), tr('The delivery note that travels with the goods. Press "Preview and print" for the printed copy with the signature lines.')]
      ]} />

      {dialogOpen && (
        <div className="dialog-backdrop" onClick={() => setDialogOpen(false)}>
          <form className="dialog waybills-dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h2 className="waybills-dialog-title">{tr('New waybill')}</h2>
            {dialogError && <div className="error-banner waybills-dialog-span">{dialogError}</div>}

            <div className="field">
              <label htmlFor="wb-origin">{tr('Origin')}</label>
              <select id="wb-origin" className="input" value={form.origin} onChange={(e) => setForm({ ...form, origin: e.target.value })}>
                <option value="factory">{tr('Factory')}</option>
                <option value="showroom">{tr('Showroom')}</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="wb-destination">{tr('Destination')}</label>
              <input id="wb-destination" className="input" value={form.destination} onChange={(e) => setForm({ ...form, destination: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="wb-customer">{tr('Customer (optional)')}</label>
              <select id="wb-customer" className="input" value={form.customerId} onChange={(e) => pickCustomer(e.target.value)}>
                <option value="">{tr('None')}</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="wb-shipping-date">{tr('Shipping date')}</label>
              <input id="wb-shipping-date" className="input" type="date" value={form.shippingDate} onChange={(e) => setForm({ ...form, shippingDate: e.target.value })} />
            </div>

            <div className="waybills-dialog-span waybills-section-title">{tr('Shipped to')}</div>
            <div className="field">
              <label htmlFor="wb-ship-name">{tr('Name')}</label>
              <input id="wb-ship-name" className="input" value={form.shippedToName} onChange={(e) => setForm({ ...form, shippedToName: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="wb-ship-phone">{tr('Phone')}</label>
              <input id="wb-ship-phone" className="input" value={form.shippedToPhone} onChange={(e) => setForm({ ...form, shippedToPhone: e.target.value })} />
            </div>
            <div className="field waybills-dialog-span">
              <label htmlFor="wb-ship-address">{tr('Address')}</label>
              <input id="wb-ship-address" className="input" value={form.shippedToAddress} onChange={(e) => setForm({ ...form, shippedToAddress: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="wb-ship-email">{tr('Email')}</label>
              <input id="wb-ship-email" className="input" type="email" value={form.shippedToEmail} onChange={(e) => setForm({ ...form, shippedToEmail: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="wb-salesrep">{tr('Sales rep')}</label>
              <select id="wb-salesrep" className="input" value={form.salesRepId} onChange={(e) => setForm({ ...form, salesRepId: e.target.value })}>
                <option value="">{tr('None')}</option>
                {employees.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}
              </select>
            </div>

            <div className="waybills-dialog-span waybills-section-title">{tr('Shipment')}</div>
            <div className="field">
              <label htmlFor="wb-driver">{tr('Driver name')}</label>
              <input id="wb-driver" className="input" value={form.driverName} onChange={(e) => setForm({ ...form, driverName: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="wb-vehicle">{tr('Vehicle number')}</label>
              <input id="wb-vehicle" className="input" value={form.vehicleNo} onChange={(e) => setForm({ ...form, vehicleNo: e.target.value })} />
            </div>

            <div className="waybills-dialog-span">
              <label className="waybills-items-label">{tr('Items')}</label>
              <table className="table waybills-items-table">
                <thead><tr><th>{tr('S/N')}</th><th>{tr('Description')}</th><th>{tr('Qty')}</th><th>{tr('Unit')}</th><th /></tr></thead>
                <tbody>
                  {form.items.map((it, idx) => (
                    <tr key={idx}>
                      <td><input className="input waybills-items-sn" value={it.itemNo} placeholder={String(idx + 1)} onChange={(e) => setItem(idx, 'itemNo', e.target.value)} /></td>
                      <td className="waybills-items-desc-cell">
                        <CatalogPicker
                          value={it.description}
                          onChange={(text) => setItem(idx, 'description', text)}
                          onPickOption={(c) => pickCatalogItem(idx, c)}
                          options={catalog}
                          placeholder={tr('Search products & services or type a custom item…')}
                          required
                        />
                      </td>
                      <td><input className="input" type="number" min="0.01" step="0.01" value={it.qty} onChange={(e) => setItem(idx, 'qty', e.target.value)} required /></td>
                      <td><input className="input" value={it.unit} onChange={(e) => setItem(idx, 'unit', e.target.value)} /></td>
                      <td>
                        <button type="button" className="btn btn-secondary waybills-row-btn" disabled={form.items.length <= 1} onClick={() => removeItem(idx)}>{tr('Remove')}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button type="button" className="btn btn-secondary" onClick={addItem}>{tr('Add item')}</button>
            </div>

            <div className="waybills-dialog-span waybills-section-title">{tr('Sign-off (optional — printed with a signature line)')}</div>
            <div className="field">
              <label htmlFor="wb-packaged">{tr('Packaged by')}</label>
              <input id="wb-packaged" className="input" value={form.packagedBy} onChange={(e) => setForm({ ...form, packagedBy: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="wb-received">{tr('Received by')}</label>
              <input id="wb-received" className="input" value={form.receivedBy} onChange={(e) => setForm({ ...form, receivedBy: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="wb-approved">{tr('Approved by')}</label>
              <input id="wb-approved" className="input" value={form.approvedBy} onChange={(e) => setForm({ ...form, approvedBy: e.target.value })} />
            </div>

            <div className="field waybills-dialog-span">
              <label htmlFor="wb-notes">{tr('Notes')}</label>
              <textarea id="wb-notes" className="input" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>

            <div className="dialog-actions waybills-dialog-span">
              <button type="button" className="btn btn-secondary" onClick={() => setDialogOpen(false)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Dispatching…') : tr('Dispatch waybill')}</button>
            </div>
          </form>
        </div>
      )}

      {marking && (
        <div className="dialog-backdrop" onClick={() => !saving && setMarking(null)}>
          <form className="dialog wb-dialog" onClick={(e) => e.stopPropagation()} onSubmit={saveMark}>
            <h2>{marking.status === 'delivered' ? tr('{waybillNo} delivered', { waybillNo: marking.wb.waybillNo }) : marking.status === 'cancelled' ? tr('Cancel {waybillNo}?', { waybillNo: marking.wb.waybillNo }) : tr('Put {waybillNo} back on the road?', { waybillNo: marking.wb.waybillNo })}</h2>
            <p className="dk-muted wb-small">{tr(ORIGINS[marking.wb.origin])} → {marking.wb.destination} · {itemsLine(marking.wb)}</p>
            {marking.status === 'delivered' && (
              <div className="wb-form">
                <div className="field">
                  <label htmlFor="wb-rcv">{tr('Signed for by')}</label>
                  <input id="wb-rcv" className="input" maxLength={120} value={marking.receivedBy} onChange={(e) => setMarking({ ...marking, receivedBy: e.target.value })} placeholder={tr('Name, and their role')} autoFocus />
                </div>
                <div className="field">
                  <label htmlFor="wb-on">{tr('Delivered on')}</label>
                  <input id="wb-on" className="input" type="date" max={todayISO()} value={marking.deliveredOn} onChange={(e) => setMarking({ ...marking, deliveredOn: e.target.value })} />
                </div>
              </div>
            )}
            {marking.status !== 'dispatched' && (
              <div className="field">
                <label htmlFor="wb-note">{marking.status === 'delivered' ? tr('Anything short or damaged? (optional)') : tr('Why? (optional)')}</label>
                <input id="wb-note" className="input" maxLength={500} value={marking.note} onChange={(e) => setMarking({ ...marking, note: e.target.value })} />
              </div>
            )}
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setMarking(null)} disabled={saving}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : marking.status === 'delivered' ? tr('Mark delivered') : marking.status === 'cancelled' ? tr('Cancel the waybill') : tr('Put back on the road')}</button>
            </div>
          </form>
        </div>
      )}

      {detail && (
        <div className="dialog-backdrop" onClick={() => setDetail(null)}>
          <div className="dialog wb-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="wb-detail-head">
              <div>
                <span className="dk-muted wb-small">{tr(ORIGINS[detail.origin])} → {detail.destination}</span>
                <h2>{detail.waybillNo}</h2>
                <Status tone={statusTone(detail.status, late.includes(detail))}>{tr(STATUS_TEXT[detail.status])}</Status>
              </div>
              <button type="button" className="wb-close" onClick={() => setDetail(null)} aria-label={tr('Close')}>×</button>
            </div>
            <div className="wb-to">
              <div>
                <strong>{detail.shippedToName}</strong>
                <span className="dk-muted">{[detail.customerName && detail.customerName !== detail.shippedToName ? detail.customerName : null, detail.shippedToAddress, detail.shippedToPhone].filter(Boolean).join(' · ')}</span>
              </div>
              <ContactButtons name={detail.shippedToName} phone={detail.shippedToPhone || detail.customerPhone} email={detail.shippedToEmail} />
            </div>
            <table className="wb-items">
              <thead><tr><th>{tr('S/N')}</th><th>{tr('Description')}</th><th className="is-num">{tr('Qty')}</th></tr></thead>
              <tbody>
                {(detail.items || []).map((it, i) => (
                  <tr key={i}><td>{it.itemNo || i + 1}</td><td>{it.description}</td><td className="is-num">{n(it.qty)} {it.unit}</td></tr>
                ))}
              </tbody>
            </table>
            <ol className="wb-timeline">
              <li>
                <Photo id={detail.dispatchedBy} name={detail.dispatchedByName} photo={detail.dispatchedByPhoto} size={28} />
                <div><strong>{tr('Dispatched by {name}', { name: detail.dispatchedByName })}</strong><span className="dk-muted">{fmtDate(String(detail.shippingDate || detail.createdAt).slice(0, 10))}{detail.driverName ? ' · ' + tr('driver {name}', { name: detail.driverName }) : ''}{detail.vehicleNo ? ' · ' + detail.vehicleNo : ''}{detail.salesRepName ? ' · ' + tr('sales rep {name}', { name: detail.salesRepName }) : ''}</span></div>
              </li>
              {detail.status === 'delivered' && (
                <li className="is-good"><span className="wb-dot" aria-hidden="true" /><div><strong>{tr('Delivered')}{detail.receivedBy ? ' · ' + tr('signed for by {name}', { name: detail.receivedBy }) : ''}</strong><span className="dk-muted">{fmtDate(String(detail.deliveredAt).slice(0, 10))}</span></div></li>
              )}
              {detail.status === 'cancelled' && <li className="is-muted"><span className="wb-dot" aria-hidden="true" /><div><strong>{tr('Cancelled')}</strong></div></li>}
            </ol>
            {detail.notes && <p className="wb-notes">{detail.notes}</p>}
            <div className="dialog-actions wb-actions">
              <button type="button" className="btn btn-secondary" onClick={() => { setPreviewWb(detail); }}>{tr('Preview and print')}</button>
              {canManage && detail.status === 'dispatched' && <button type="button" className="btn btn-primary" onClick={() => openMark(detail, 'delivered')}>{tr('Mark delivered')}</button>}
              {!(canManage && detail.status === 'dispatched') && <button type="button" className="btn btn-primary" onClick={() => setDetail(null)}>{tr('Close')}</button>}
            </div>
          </div>
        </div>
      )}

      {previewWb && <WaybillPreview waybill={previewWb} onClose={() => setPreviewWb(null)} />}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
