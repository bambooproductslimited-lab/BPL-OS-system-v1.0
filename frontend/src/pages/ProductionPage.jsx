import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import Photo from '../components/Photo';
import PeoplePicker from '../components/PeoplePicker';
import RowMenu from '../components/RowMenu';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { Glossary, Hero, Insights, PairBars, RankList, Section, Status, fmtDate, jump } from '../components/DashKit';
import { money } from '../lib/currency';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './EmployeesPage.css';
import './ProductionPage.css';

// Raw bamboo & production. Same "explains itself" layout as the dashboards
// (components/DashKit.jsx): the key numbers (bamboo in the yard, received
// and made this month, waste), what stands out (bamboo sitting too long,
// batches nearly used up, high waste, full warehouses), then the raw
// bamboo batches with how much of each has been used, written off or is
// left; the production records with their yield, waste and the people who
// worked on them; eight weeks of raw bamboo used and wasted; what was made
// this month per product; and the warehouses. A record entered by mistake
// is cancelled (the bamboo goes back to its batch, the output comes off
// stock) and spoiled bamboo is written off (rawBatches.service.js,
// production.service.js, migration 0084).

const UNITS = [
  { key: 'kg', label: msg('kg'), one: msg('kg') },
  { key: 'poles', label: msg('poles'), one: msg('pole') },
  { key: 'bundles', label: msg('bundles'), one: msg('bundle') },
  { key: 'tonnes', label: msg('tonnes'), one: msg('tonne') }
];
const GRADES = [
  { key: 'A', label: msg('Grade A'), note: msg('Mature, straight, no splits or insect damage.') },
  { key: 'B', label: msg('Grade B'), note: msg('Usable with some trimming.') },
  { key: 'C', label: msg('Grade C'), note: msg('Only for small pieces, skewers or fuel.') }
];
const WRITE_OFF_REASONS = [msg('Rotten'), msg('Split or cracked'), msg('Insect damage'), msg('Too wet'), msg('Stolen or missing')];
const OLD_DAYS = 30;
const HIGH_WASTE = 20;

const EMPTY_RAW = { species: '', supplierId: '', quantity: '', unit: 'kg', grade: 'B', cost: '', warehouseId: '', dateReceived: '', notes: '' };
const EMPTY_RECORD = { rawBatchId: '', outputProductId: '', date: '', productionLine: '', inputQty: '', outputQty: '', wasteQty: '', rejectedQty: '', supervisorId: '', employeeIds: [], notes: '' };
const EMPTY_WAREHOUSE = { name: '', location: '', capacity: '' };
const EMPTY_SUPPLIER = { name: '', contactPerson: '', phone: '', email: '', address: '', materialsSupplied: '' };
const EMPTY_PRODUCT = { sku: '', name: '', category: '', unit: '', costPrice: '', sellingPrice: '', currentStock: '', reorderLevel: '' };

function isoDay(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function daysSince(iso) {
  const today = new Date();
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return Math.round((Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - Date.UTC(y, m - 1, d)) / 86400000);
}
function n(v, digits = 1) { return Number(v || 0).toLocaleString(activeIntlLocale(), { maximumFractionDigits: digits }); }
function unitLabel(u) { const f = UNITS.find((x) => x.key === u); return f ? tr(f.label) : u; }
// "per pole", not "per poles"
function unitOne(u) { const f = UNITS.find((x) => x.key === u); return f ? tr(f.one) : u; }
function qty(v, unit) { return n(v) + ' ' + unitLabel(unit); }
// "3,000 kg + 450 poles"
function qtyByUnit(rows) { return rows.length ? rows.map((r) => qty(r.qty, r.unit)).join(' + ') : '0 ' + unitLabel('kg'); }
function sumByUnit(items, pick, unitOf) {
  const m = new Map();
  items.forEach((x) => { const v = pick(x); if (v) m.set(unitOf(x), (m.get(unitOf(x)) || 0) + v); });
  return Array.from(m.entries()).map(([unit, q]) => ({ unit, qty: q })).sort((a, b) => b.qty - a.qty);
}
function startOfWeek(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
function wasteTone(p) { return p >= HIGH_WASTE ? 'bad' : p >= 10 ? 'warn' : 'good'; }

// Used / written off / left, as one bar.
function UseBar({ r }) {
  const total = r.receivedQty || 1;
  const pct = (v) => Math.max(0, Math.min(100, (v / total) * 100)) + '%';
  return (
    <div className="pr-usebar" role="img" aria-label={tr('{used} used, {off} written off, {left} left', { used: qty(r.usedQty, r.unit), off: qty(r.disposedQty, r.unit), left: qty(r.quantity, r.unit) })}>
      <span className="is-used" style={{ width: pct(r.usedQty) }} />
      <span className="is-off" style={{ width: pct(r.disposedQty) }} />
    </div>
  );
}

function Faces({ people, max = 4 }) {
  if (!people.length) return null;
  return (
    <span className="pr-faces" title={people.map((p) => p.name).join(', ')}>
      {people.slice(0, max).map((p) => <Photo key={p.id} id={p.id} name={p.name} photo={p.photo} size={24} />)}
      {people.length > max && <span className="pr-faces-more">+{people.length - max}</span>}
    </span>
  );
}

export default function ProductionPage() {
  const { can } = useAuth();
  const canProduction = can('production.manage');
  const canWarehouse = can('warehouse.manage');
  const canSupplier = can('supplier.manage');
  const canInventory = can('inventory.manage');

  const [rawBatches, setRawBatches] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [batches, setBatches] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [products, setProducts] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [rawChip, setRawChip] = useState('stock');
  const [rawSearch, setRawSearch] = useState('');
  const [pbChip, setPbChip] = useState('month');
  const [pbSearch, setPbSearch] = useState('');

  const [rawDialog, setRawDialog] = useState(null); // { id? }
  const [rawForm, setRawForm] = useState(EMPTY_RAW);
  const [recordOpen, setRecordOpen] = useState(false);
  const [recForm, setRecForm] = useState(EMPTY_RECORD);
  const [detail, setDetail] = useState(null); // { b, cancelling, reason }
  const [writeOff, setWriteOff] = useState(null); // { r, qty, reason }
  const [whDialog, setWhDialog] = useState(null); // { id? }
  const [whForm, setWhForm] = useState(EMPTY_WAREHOUSE);
  const [whDelete, setWhDelete] = useState(null);
  const [supOpen, setSupOpen] = useState(false);
  const [supForm, setSupForm] = useState(EMPTY_SUPPLIER);
  const [prodDialog, setProdDialog] = useState(null); // { id? }
  const [prodForm, setProdForm] = useState(EMPTY_PRODUCT);
  const [formError, setFormError] = useState(null);
  const [subError, setSubError] = useState(null); // errors in a dialog opened over another
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [rb, pb, wh] = await Promise.all([
        api.get('/raw-batches'), api.get('/production'), api.get('/warehouses').catch(() => [])
      ]);
      setRawBatches(rb);
      setBatches(pb);
      setWarehouses(wh);
      // Suppliers, products and staff only feed the forms, which need
      // production.manage — a read-only viewer may not be allowed them.
      if (canProduction) {
        const [sup, prod, emps] = await Promise.all([
          api.get('/suppliers').catch(() => []), api.get('/products').catch(() => []), api.get('/employees').catch(() => [])
        ]);
        setSuppliers(sup);
        setProducts(prod);
        setEmployees(emps);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [canProduction]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const today = isoDay(new Date());
  const lines = useMemo(() => Array.from(new Set(batches.map((b) => b.productionLine).filter(Boolean))).sort(), [batches]);
  const speciesList = useMemo(() => Array.from(new Set(rawBatches.map((r) => r.species))).sort(), [rawBatches]);

  // ── actions ──────────────────────────────────────────────────────────
  function openReceive() {
    setFormError(null);
    setRawForm({ ...EMPTY_RAW, dateReceived: today, warehouseId: warehouses.length === 1 ? warehouses[0].id : '' });
    setRawDialog({});
  }
  function openEditRaw(r) {
    setFormError(null);
    setRawForm({ species: r.species, supplierId: r.supplierId || '', quantity: String(r.receivedQty), unit: r.unit, grade: r.qualityGrade || 'B', cost: String(r.cost || ''), warehouseId: r.warehouseId || '', dateReceived: r.dateReceived, notes: r.notes || '' });
    setRawDialog({ id: r.id, r });
  }
  async function saveRaw(e) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const body = { species: rawForm.species, supplierId: rawForm.supplierId, quantity: rawForm.quantity, unit: rawForm.unit, qualityGrade: rawForm.grade, cost: rawForm.cost, warehouseId: rawForm.warehouseId, dateReceived: rawForm.dateReceived, notes: rawForm.notes };
      const r = rawDialog.id ? await api.put('/raw-batches/' + rawDialog.id, body) : await api.post('/raw-batches', body);
      setToast(rawDialog.id ? tr('Updated batch {batchNo}.', { batchNo: r.batchNo }) : tr('Received {batchNo}.', { batchNo: r.batchNo }));
      setRawDialog(null);
      await load();
    } catch (err) { setFormError(err.message); } finally { setSaving(false); }
  }

  function openRecord(r) {
    setFormError(null);
    const last = batches.find((b) => b.status !== 'cancelled');
    setRecForm({
      ...EMPTY_RECORD, date: today, rawBatchId: r ? r.id : '',
      productionLine: last ? last.productionLine : '', outputProductId: last ? last.outputProductId || '' : ''
    });
    setRecordOpen(true);
  }
  async function saveRecord(e) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const b = await api.post('/production', { ...recForm, supervisorId: recForm.supervisorId || undefined });
      setToast(tr('Batch {batchNo} recorded.', { batchNo: b.batchNo }));
      setRecordOpen(false);
      setPbChip('month');
      await load();
    } catch (err) { setFormError(err.message); } finally { setSaving(false); }
  }
  async function cancelBatch() {
    setSaving(true);
    setFormError(null);
    try {
      const b = await api.post('/production/' + detail.b.id + '/cancel', { reason: detail.reason });
      setToast(tr('Batch {batchNo} cancelled. The bamboo is back in {raw}.', { batchNo: b.batchNo, raw: b.rawBatchNo }));
      setDetail({ b });
      await load();
    } catch (err) { setFormError(err.message); } finally { setSaving(false); }
  }
  async function saveWriteOff(e) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      await api.post('/raw-batches/' + writeOff.r.id + '/write-off', { qty: writeOff.qty, reason: writeOff.reason });
      setToast(tr('Wrote off {qty} from {batchNo}.', { qty: qty(writeOff.qty, writeOff.r.unit), batchNo: writeOff.r.batchNo }));
      setWriteOff(null);
      await load();
    } catch (err) { setFormError(err.message); } finally { setSaving(false); }
  }

  function openWarehouse(w) {
    setSubError(null);
    setWhForm(w ? { name: w.name, location: w.location || '', capacity: w.capacity ? String(w.capacity) : '' } : EMPTY_WAREHOUSE);
    setWhDialog(w ? { id: w.id } : {});
  }
  async function saveWarehouse(e) {
    e.preventDefault();
    setSaving(true);
    setSubError(null);
    try {
      const w = whDialog.id ? await api.put('/warehouses/' + whDialog.id, whForm) : await api.post('/warehouses', whForm);
      setToast(whDialog.id ? tr('Warehouse updated.') : tr('Warehouse added.'));
      if (!whDialog.id && rawDialog) setRawForm((f) => ({ ...f, warehouseId: w.id }));
      setWhDialog(null);
      await load();
    } catch (err) { setSubError(err.message); } finally { setSaving(false); }
  }
  async function deleteWarehouse() {
    try {
      await api.del('/warehouses/' + whDelete.id);
      setToast(tr('{name} deleted.', { name: whDelete.name }));
      setWhDelete(null);
      await load();
    } catch (err) { setError(err.message); setWhDelete(null); }
  }
  async function saveSupplier(e) {
    e.preventDefault();
    setSaving(true);
    setSubError(null);
    try {
      const s = await api.post('/suppliers', supForm);
      setToast(tr('Supplier added.'));
      setSupOpen(false);
      setRawForm((f) => ({ ...f, supplierId: s.id }));
      await load();
    } catch (err) { setSubError(err.message); } finally { setSaving(false); }
  }
  function openProduct(edit) {
    setSubError(null);
    const p = edit ? products.find((x) => x.id === recForm.outputProductId) : null;
    if (edit && !p) { setToast(tr('Pick a product first.')); return; }
    setProdForm(p ? { sku: p.sku, name: p.name, category: p.category, unit: p.unit, costPrice: p.costPrice, sellingPrice: p.sellingPrice, currentStock: p.currentStock, reorderLevel: p.reorderLevel } : EMPTY_PRODUCT);
    setProdDialog(p ? { id: p.id } : {});
  }
  async function saveProduct(e) {
    e.preventDefault();
    setSaving(true);
    setSubError(null);
    try {
      const r = prodDialog.id ? await api.put('/products/' + prodDialog.id, prodForm) : await api.post('/products', prodForm);
      setToast(prodDialog.id ? tr('Product {sku} updated.', { sku: r.sku }) : tr('Product {sku} added.', { sku: r.sku }));
      if (!prodDialog.id) setRecForm((f) => ({ ...f, outputProductId: r.id }));
      setProdDialog(null);
      await load();
    } catch (err) { setSubError(err.message); } finally { setSaving(false); }
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const monthKey = today.slice(0, 7);
  const lastMonthKey = (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return isoDay(d).slice(0, 7); })();
  const weekStart = isoDay(startOfWeek(new Date()));
  const live = batches.filter((b) => b.status !== 'cancelled');
  const inStock = rawBatches.filter((r) => r.quantity > 0);
  const stockByUnit = sumByUnit(inStock, (r) => r.quantity, (r) => r.unit);
  const oldest = inStock.slice().sort((a, b) => String(a.dateReceived).localeCompare(String(b.dateReceived)))[0];
  const receivedMonth = rawBatches.filter((r) => String(r.dateReceived).slice(0, 7) === monthKey);
  const madeMonth = live.filter((b) => String(b.date).slice(0, 7) === monthKey);
  const madeLastMonth = live.filter((b) => String(b.date).slice(0, 7) === lastMonthKey);
  const wasteOf = (list) => { const i = list.reduce((s, b) => s + b.inputQty, 0); return i ? Math.round((list.reduce((s, b) => s + b.wasteQty, 0) / i) * 1000) / 10 : null; };
  const wasteMonth = wasteOf(madeMonth);
  const wasteLast = wasteOf(madeLastMonth);

  const stats = [
    { icon: 'bag', value: stockByUnit.length ? qty(stockByUnit[0].qty, stockByUnit[0].unit) : '0', label: tr('raw bamboo in stock'), note: inStock.length === 1 ? tr('in 1 batch') : tr('in {n} batches', { n: inStock.length }) + (stockByUnit.length > 1 ? ' · + ' + qtyByUnit(stockByUnit.slice(1)) : ''), onClick: () => { setRawChip('stock'); jump('pr-raw'); } },
    { icon: 'down', value: receivedMonth.length ? qtyByUnit(sumByUnit(receivedMonth, (r) => r.receivedQty, (r) => r.unit).slice(0, 1)) : '0', label: tr('received this month'), note: receivedMonth.length ? tr('{n} deliveries · {cost}', { n: receivedMonth.length, cost: money(receivedMonth.reduce((s, r) => s + r.cost, 0)) }) : tr('nothing received yet'), onClick: () => { setRawChip('month'); jump('pr-raw'); } },
    { icon: 'up', value: n(madeMonth.reduce((s, b) => s + b.outputQty, 0), 0), label: tr('made this month'), note: madeMonth.length === 1 ? tr('in 1 production batch') : tr('in {n} production batches', { n: madeMonth.length }), tone: madeMonth.length ? 'good' : '', onClick: () => { setPbChip('month'); jump('pr-batches'); } },
    { icon: 'percent', value: wasteMonth === null ? '—' : n(wasteMonth) + '%', label: tr('waste this month'), note: wasteLast === null ? tr('of the raw bamboo used') : tr('last month {pct}%', { pct: n(wasteLast) }), tone: wasteMonth !== null && wasteMonth >= HIGH_WASTE ? 'alert' : '', onClick: () => { setPbChip('month'); jump('pr-batches'); } }
  ];

  const insights = [];
  if (oldest && daysSince(oldest.dateReceived) > OLD_DAYS) {
    insights.push({ tone: 'warn', icon: 'clock', text: tr('{batchNo} ({species}) has been in stock for {days} days; {left} left. Older bamboo dries out and splits.', { batchNo: oldest.batchNo, species: oldest.species, days: daysSince(oldest.dateReceived), left: qty(oldest.quantity, oldest.unit) }), action: canProduction ? { label: tr('Use it'), run: () => openRecord(oldest) } : undefined });
  }
  const high = live.filter((b) => daysSince(b.date) <= 30 && b.wastePct >= HIGH_WASTE).sort((a, b) => b.wastePct - a.wastePct)[0];
  if (high) insights.push({ tone: 'bad', icon: 'warn', text: tr('{batchNo} lost {pct}% of its bamboo as waste ({product}, {date}).', { batchNo: high.batchNo, pct: n(high.wastePct), product: high.productName, date: fmtDate(high.date) }), action: { label: tr('Open it'), run: () => setDetail({ b: high }) } });
  const low = inStock.filter((r) => r.receivedQty > 0 && r.quantity / r.receivedQty < 0.1);
  if (low.length) insights.push({ tone: 'info', icon: 'bag', text: low.length === 1 ? tr('{batchNo} is almost used up: {left} left.', { batchNo: low[0].batchNo, left: qty(low[0].quantity, low[0].unit) }) : tr('{n} raw batches are almost used up.', { n: low.length }), action: canProduction ? { label: tr('Receive more'), run: openReceive } : undefined });
  const full = warehouses.filter((w) => w.capacity > 0 && w.rawQty > w.capacity);
  if (full.length) insights.push({ tone: 'warn', icon: 'drawer', text: tr('{name} holds more than its capacity ({held} for {cap}).', { name: full[0].name, held: n(full[0].rawQty), cap: n(full[0].capacity) }), action: { label: tr('Show it'), run: () => jump('pr-warehouses') } });
  const lastRecord = live[0];
  if (inStock.length && (!lastRecord || daysSince(lastRecord.date) > 7)) insights.push({ tone: 'info', icon: 'calendar', text: lastRecord ? tr('No production recorded since {date}, with {stock} of bamboo waiting.', { date: fmtDate(lastRecord.date), stock: qtyByUnit(stockByUnit) }) : tr('No production recorded yet, with {stock} of bamboo waiting.', { stock: qtyByUnit(stockByUnit) }), action: canProduction ? { label: tr('Record production'), run: () => openRecord() } : undefined });
  if (wasteMonth !== null && wasteLast !== null && wasteMonth < wasteLast) insights.push({ tone: 'good', icon: 'check', text: tr('Waste is down to {now}% this month from {before}% last month.', { now: n(wasteMonth), before: n(wasteLast) }) });

  // raw batches
  const rawChipTest = {
    stock: (r) => r.quantity > 0,
    month: (r) => String(r.dateReceived).slice(0, 7) === monthKey,
    old: (r) => r.quantity > 0 && daysSince(r.dateReceived) > OLD_DAYS,
    done: (r) => r.quantity <= 0,
    all: () => true
  };
  const visibleRaw = rawBatches.filter(rawChipTest[rawChip] || rawChipTest.stock)
    .filter((r) => matchesQuery(rawSearch, r.batchNo, r.species, r.supplierName, r.supplierTown, r.warehouseName, r.notes));
  const rawChips = [
    ['stock', tr('In stock'), inStock.length],
    ['month', tr('Received this month'), receivedMonth.length],
    ['old', tr('Over {n} days old', { n: OLD_DAYS }), inStock.filter(rawChipTest.old).length],
    ['done', tr('Used up or written off'), rawBatches.length - inStock.length],
    ['all', tr('All'), rawBatches.length]
  ].filter(([k, , c]) => c > 0 || k === 'stock' || k === rawChip);

  // production records
  const pbChipTest = {
    week: (b) => b.status !== 'cancelled' && String(b.date) >= weekStart,
    month: (b) => b.status !== 'cancelled' && String(b.date).slice(0, 7) === monthKey,
    all: (b) => b.status !== 'cancelled',
    waste: (b) => b.status !== 'cancelled' && b.wastePct >= HIGH_WASTE,
    cancelled: (b) => b.status === 'cancelled'
  };
  const visiblePb = batches.filter(pbChipTest[pbChip] || pbChipTest.month)
    .filter((b) => matchesQuery(pbSearch, b.batchNo, b.productName, b.productSku, b.rawBatchNo, b.rawSpecies, b.supervisorName, b.productionLine, b.notes, ...b.workers.map((w) => w.name)));
  const pbChips = [
    ['week', tr('This week'), batches.filter(pbChipTest.week).length],
    ['month', tr('This month'), madeMonth.length],
    ['all', tr('All'), live.length],
    ['waste', tr('High waste'), batches.filter(pbChipTest.waste).length],
    ['cancelled', tr('Cancelled'), batches.length - live.length]
  ].filter(([k, , c]) => c > 0 || k === 'month' || k === pbChip);

  // eight weeks of raw bamboo used and wasted
  const weeks = [];
  const w0 = startOfWeek(new Date());
  for (let i = 7; i >= 0; i--) {
    const s = new Date(w0); s.setDate(s.getDate() - i * 7);
    const e = new Date(s); e.setDate(e.getDate() + 7);
    const from = isoDay(s), to = isoDay(e);
    const inWeek = live.filter((b) => String(b.date) >= from && String(b.date) < to);
    weeks.push({ label: s.toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short' }), a: inWeek.reduce((t, b) => t + b.inputQty, 0), b: inWeek.reduce((t, b) => t + b.wasteQty, 0) });
  }
  const anyWeeks = weeks.some((w) => w.a > 0);
  const rawUnitMain = live[0] ? live[0].rawUnit : 'kg';

  const byProduct = Array.from(madeMonth.reduce((m, b) => {
    const cur = m.get(b.outputProductId) || { key: b.outputProductId, name: b.productName, unit: b.productUnit, out: 0, input: 0, waste: 0, rawUnit: b.rawUnit, count: 0 };
    cur.out += b.outputQty; cur.input += b.inputQty; cur.waste += b.wasteQty; cur.count += 1;
    return m.set(b.outputProductId, cur);
  }, new Map()).values()).sort((a, b) => b.out - a.out).map((p) => ({
    key: p.key, name: p.name, value: p.out, amount: n(p.out, 0) + ' ' + p.unit,
    meta: tr('{yield} per {unit} · {waste}% waste', { yield: n(p.input ? p.out / p.input : 0, 2), unit: unitOne(p.rawUnit), waste: n(p.input ? (p.waste / p.input) * 100 : 0) }) +
      ' · ' + (p.count === 1 ? tr('1 batch') : tr('{n} batches', { n: p.count }))
  }));

  // the record form, worked out as it is filled in
  const recRaw = rawBatches.find((r) => r.id === recForm.rawBatchId);
  const recProduct = products.find((p) => p.id === recForm.outputProductId);
  const recIn = Number(recForm.inputQty) || 0, recOut = Number(recForm.outputQty) || 0, recWaste = Number(recForm.wasteQty) || 0;
  const rawCostPer = rawDialog && Number(rawForm.quantity) > 0 && Number(rawForm.cost) > 0 ? Number(rawForm.cost) / Number(rawForm.quantity) : null;

  return (
    <div className="dk pr">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <Hero
        eyebrow={new Date().toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        title={tr('Raw bamboo & production')}
        sub={tr('Bamboo received from suppliers and farmers, what is still in the yard, and what the factory made from it. Each production record takes bamboo from a raw batch and adds the product to stock. Press a number to show only those.')}
        actions={canProduction && (
          <>
            <button type="button" className="btn btn-primary" onClick={openReceive}>{tr('Receive raw bamboo')}</button>
            <button type="button" className="btn btn-secondary" onClick={() => openRecord()}>{tr('Record production')}</button>
          </>
        )}
        stats={stats} />

      <Insights items={insights.slice(0, 5)} />

      <Section id="pr-raw" title={tr('Raw bamboo')} sub={tr('Each delivery is a batch. The bar shows how much has gone into production, been written off, or is left.')}>
        <div className="pr-tools">
          <div className="pr-search"><SearchInput value={rawSearch} onChange={setRawSearch} placeholder={tr('Search batch, species, supplier, warehouse…')} /></div>
        </div>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {rawChips.map(([key, label, c]) => (
            <button key={key} type="button" role="radio" aria-checked={rawChip === key} className={'ppl-chip' + (rawChip === key ? ' is-on' : '')} onClick={() => setRawChip(key)}>
              {label} <span className="ppl-chip-n">{c}</span>
            </button>
          ))}
        </div>
        {visibleRaw.length ? (
          <div className="pr-grid">
            {visibleRaw.map((r) => {
              const age = daysSince(r.dateReceived);
              const done = r.quantity <= 0;
              return (
                <article key={r.id} className={'pr-card' + (done ? ' is-done' : age > OLD_DAYS ? ' is-old' : '')}>
                  <div className="pr-card-top">
                    <span className="dk-muted pr-code">{r.batchNo}</span>
                    {r.qualityGrade && <span className={'pr-grade is-' + r.qualityGrade}>{tr('Grade {g}', { g: r.qualityGrade })}</span>}
                    {canProduction && (
                      <span className="pr-menu">
                        <RowMenu actions={[
                          !done && { label: tr('Use in production'), onClick: () => openRecord(r) },
                          { label: tr('Edit'), onClick: () => openEditRaw(r) },
                          !done && { label: tr('Write off'), onClick: () => { setFormError(null); setWriteOff({ r, qty: String(r.quantity), reason: '' }); }, danger: true }
                        ].filter(Boolean)} />
                      </span>
                    )}
                  </div>
                  <h3 className="pr-card-title">{r.species}</h3>
                  <p className="dk-muted pr-card-sub">
                    {r.supplierName}{r.supplierTown ? ' · ' + r.supplierTown : ''}
                    {r.supplierPhone && <> · <a href={'tel:' + r.supplierPhone.replace(/\s+/g, '')}>{r.supplierPhone}</a></>}
                  </p>
                  <UseBar r={r} />
                  <div className="pr-left">
                    <strong>{done ? (r.status === 'disposed' ? tr('Written off') : tr('Used up')) : tr('{left} left', { left: qty(r.quantity, r.unit) })}</strong>
                    <span className="dk-muted">{tr('of {received}', { received: qty(r.receivedQty, r.unit) })}</span>
                  </div>
                  <dl className="pr-facts">
                    <div><dt>{tr('Received')}</dt><dd>{fmtDate(r.dateReceived)}{!done && <span className={'pr-age' + (age > OLD_DAYS ? ' is-old' : '')}> · {age === 0 ? tr('today') : age === 1 ? tr('1 day ago') : tr('{n} days ago', { n: age })}</span>}</dd></div>
                    <div><dt>{tr('Warehouse')}</dt><dd>{r.warehouseName}</dd></div>
                    <div><dt>{tr('Cost')}</dt><dd>{r.cost ? money(r.cost) : '—'}{r.costPerUnit ? <span className="dk-muted pr-per">{tr('{price} per {unit}', { price: money(r.costPerUnit), unit: unitOne(r.unit) })}</span> : null}</dd></div>
                    {(r.usedQty > 0 || r.disposedQty > 0) && <div><dt>{tr('Used')}</dt><dd>{qty(r.usedQty, r.unit)}{r.productionCount ? ' · ' + (r.productionCount === 1 ? tr('1 batch') : tr('{n} batches', { n: r.productionCount })) : ''}{r.disposedQty > 0 ? ' · ' + tr('{qty} written off', { qty: qty(r.disposedQty, r.unit) }) : ''}</dd></div>}
                  </dl>
                  {canProduction && !done && (
                    <div className="pr-card-foot">
                      <button type="button" className="btn btn-secondary pr-btn" onClick={() => openRecord(r)}>{tr('Use in production')}</button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        ) : (
          <div className="dk-empty pr-empty">
            <p>{rawBatches.length ? tr('Nothing matches. Try another search or filter.') : tr('No raw material received yet')}</p>
            {canProduction && !rawBatches.length && <button type="button" className="btn btn-primary" onClick={openReceive}>{tr('Receive raw bamboo')}</button>}
          </div>
        )}
      </Section>

      <Section id="pr-batches" title={tr('Production')} sub={tr('What was made, from which bamboo, and how much was lost. Press a record for the details.')}
        action={canProduction && <button type="button" className="btn btn-secondary" onClick={() => openRecord()}>{tr('Record production')}</button>}>
        <div className="pr-tools">
          <div className="pr-search"><SearchInput value={pbSearch} onChange={setPbSearch} placeholder={tr('Search batch, product, supervisor, line…')} /></div>
        </div>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {pbChips.map(([key, label, c]) => (
            <button key={key} type="button" role="radio" aria-checked={pbChip === key} className={'ppl-chip' + (pbChip === key ? ' is-on' : '')} onClick={() => setPbChip(key)}>
              {label} <span className="ppl-chip-n">{c}</span>
            </button>
          ))}
        </div>
        {visiblePb.length ? (
          <ul className="pr-list">
            {visiblePb.map((b) => {
              const d = new Date(String(b.date) + 'T00:00');
              return (
                <li key={b.id} className={'pr-row' + (b.status === 'cancelled' ? ' is-cancelled' : b.wastePct >= HIGH_WASTE ? ' is-bad' : '')}>
                  <button type="button" className="pr-open" onClick={() => { setFormError(null); setDetail({ b }); }}>
                    <span className="pr-date" aria-hidden="true">
                      <strong>{d.getDate()}</strong>
                      <span>{d.toLocaleDateString(activeIntlLocale(), { month: 'short' })}</span>
                    </span>
                    <span className="pr-main">
                      <span className="pr-title">{n(b.outputQty, 0)} {b.productUnit} · {b.productName}</span>
                      <span className="dk-muted pr-sub">{b.batchNo} · {tr('{qty} from {batch}', { qty: qty(b.inputQty, b.rawUnit), batch: b.rawBatchNo })}{b.rawSpecies ? ' (' + b.rawSpecies + ')' : ''} · {b.productionLine}</span>
                    </span>
                  </button>
                  <span className="pr-row-tags">
                    {b.status === 'cancelled'
                      ? <Status tone="muted">{tr('Cancelled')}</Status>
                      : <Status tone={wasteTone(b.wastePct)}>{tr('{pct}% waste', { pct: n(b.wastePct) })}</Status>}
                  </span>
                  <span className="pr-row-people">
                    <Photo id={b.supervisorId} name={b.supervisorName} photo={b.supervisorPhoto} size={26} />
                    <Faces people={b.workers.filter((w) => w.id !== b.supervisorId)} max={3} />
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="dk-empty pr-empty">
            <p>{batches.length ? tr('Nothing here. Try another filter.') : tr('No production batches recorded yet')}</p>
            {pbChip !== 'all' && live.length > 0 && <button type="button" className="btn btn-secondary" onClick={() => { setPbChip('all'); setPbSearch(''); }}>{tr('Show all')}</button>}
          </div>
        )}
      </Section>

      {(anyWeeks || byProduct.length > 0) && (
        <div className="dk-two pr-charts">
          <Section title={tr('Last 8 weeks')} sub={tr('Raw bamboo used and how much of it was waste ({unit}).', { unit: unitLabel(rawUnitMain) })} card>
            {anyWeeks ? <PairBars rows={weeks} aLabel={tr('Used')} bLabel={tr('Waste')} format={(v) => n(v, 0)} /> : <p className="dk-muted">{tr('Nothing made in the last 8 weeks.')}</p>}
          </Section>
          <Section title={tr('Made this month')} sub={tr('Per product, with how much it gets from each unit of bamboo.')} card>
            {byProduct.length ? <RankList rows={byProduct} /> : <p className="dk-muted">{tr('Nothing made yet this month.')}</p>}
          </Section>
        </div>
      )}

      <Section id="pr-warehouses" title={tr('Warehouses')} sub={tr('Where the raw bamboo is kept.')}
        action={canWarehouse && <button type="button" className="btn btn-secondary" onClick={() => openWarehouse(null)}>{tr('Add warehouse')}</button>}>
        {warehouses.length ? (
          <div className="pr-wh-grid">
            {warehouses.map((w) => {
              const pct = w.capacity > 0 ? Math.round((w.rawQty / w.capacity) * 100) : null;
              return (
                <article key={w.id} className="pr-wh">
                  <div className="pr-card-top">
                    <strong className="pr-wh-name">{w.name}</strong>
                    {canWarehouse && (
                      <span className="pr-menu">
                        <RowMenu actions={[
                          { label: tr('Edit'), onClick: () => openWarehouse(w) },
                          { label: tr('Delete'), onClick: () => setWhDelete(w), danger: true, hidden: w.rawQty !== 0 }
                        ]} />
                      </span>
                    )}
                  </div>
                  <span className="dk-muted pr-small">{w.location || tr('No location recorded')}</span>
                  <span className="pr-wh-held">{w.batchCount ? qtyByUnit(w.rawByUnit || []) : tr('Empty')}</span>
                  {(w.batchCount > 0 || w.capacity > 0) && <span className="dk-muted pr-small">{[w.batchCount === 1 ? tr('1 batch') : w.batchCount ? tr('{n} batches', { n: w.batchCount }) : '', w.capacity > 0 ? tr('capacity {n}', { n: n(w.capacity, 0) }) : ''].filter(Boolean).join(' · ')}</span>}
                  {pct !== null && (
                    <span className={'pr-cap' + (pct > 100 ? ' is-over' : pct > 85 ? ' is-high' : '')} role="img" aria-label={tr('{pct}% full', { pct })}>
                      <span style={{ width: Math.min(100, pct) + '%' }} />
                    </span>
                  )}
                  {pct !== null && <span className={'pr-small ' + (pct > 100 ? 'pr-bad' : 'dk-muted')}>{tr('{pct}% full', { pct })}</span>}
                </article>
              );
            })}
          </div>
        ) : <p className="dk-muted">{tr('No warehouses yet.')}</p>}
      </Section>

      <Glossary items={[
        [tr('Raw batch'), tr('One delivery of bamboo from a supplier or farmer, with its own number (RB-…).')],
        [tr('Left, used, written off'), tr('Production takes bamboo from a batch; what was rotten, split or lost is written off with a reason; the rest is left.')],
        [tr('Yield'), tr('How much product one unit of bamboo gives, for example 2 planks per kg.')],
        [tr('Waste'), tr('Bamboo lost while making the batch (offcuts, splits), as a share of the bamboo used. Above {n}% is flagged.', { n: HIGH_WASTE })],
        [tr('Rejected'), tr('Finished pieces that failed the quality check. They are not added to stock.')],
        [tr('Cancel a record'), tr('For a record entered by mistake: the bamboo goes back to its batch and the output comes off stock.')],
        [tr('Grade'), tr('A: mature, straight, no damage. B: usable with trimming. C: only for small pieces, skewers or fuel.')]
      ]} />

      {/* ── receive / edit raw bamboo ── */}
      {rawDialog && (
        <div className="dialog-backdrop" onClick={() => !saving && setRawDialog(null)}>
          <form className="dialog pr-dialog" onClick={(e) => e.stopPropagation()} onSubmit={saveRaw}>
            <h2>{rawDialog.id ? tr('Edit {batchNo}', { batchNo: rawDialog.r.batchNo }) : tr('Receive raw bamboo')}</h2>
            <div className="pr-form">
              <div className="field">
                <label htmlFor="rb-species">{tr('Species')}</label>
                <input id="rb-species" className="input" list="rb-species-list" value={rawForm.species} onChange={(e) => setRawForm({ ...rawForm, species: e.target.value })} placeholder="Bambusa vulgaris" required />
                <datalist id="rb-species-list">{speciesList.map((s) => <option key={s} value={s} />)}</datalist>
              </div>
              <div className="field">
                <label htmlFor="rb-date">{tr('Date received')}</label>
                <input id="rb-date" className="input" type="date" max={today} value={rawForm.dateReceived} onChange={(e) => setRawForm({ ...rawForm, dateReceived: e.target.value })} required />
              </div>
              <div className="field pr-span">
                <label htmlFor="rb-supplier">{tr('Supplier or farmer')}</label>
                <div className="pr-inline">
                  <select id="rb-supplier" className="input" value={rawForm.supplierId} onChange={(e) => setRawForm({ ...rawForm, supplierId: e.target.value })} required>
                    <option value="" disabled>{tr('Choose a supplier')}</option>
                    {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}{s.town ? ' — ' + s.town : ''}</option>)}
                  </select>
                  {canSupplier && <button type="button" className="btn btn-secondary" onClick={() => { setSubError(null); setSupForm({ ...EMPTY_SUPPLIER, materialsSupplied: tr('Bamboo') }); setSupOpen(true); }}>{tr('+ New')}</button>}
                </div>
              </div>
              <div className="field">
                <label htmlFor="rb-qty">{rawDialog.id ? tr('Quantity received') : tr('Quantity')}</label>
                <div className="pr-inline">
                  <input id="rb-qty" className="input" type="number" min="0" step="any" value={rawForm.quantity} onChange={(e) => setRawForm({ ...rawForm, quantity: e.target.value })} required />
                  <select className="input pr-unit" value={rawForm.unit} onChange={(e) => setRawForm({ ...rawForm, unit: e.target.value })} aria-label={tr('Unit')}>
                    {UNITS.map((u) => <option key={u.key} value={u.key}>{tr(u.label)}</option>)}
                  </select>
                </div>
                {rawDialog.id && rawDialog.r.receivedQty - rawDialog.r.quantity > 0 && <span className="dk-muted pr-small">{tr('{qty} already used or written off.', { qty: qty(rawDialog.r.receivedQty - rawDialog.r.quantity, rawDialog.r.unit) })}</span>}
              </div>
              <div className="field">
                <label htmlFor="rb-cost">{tr('Total cost (GHS)')}</label>
                <input id="rb-cost" className="input" type="number" min="0" step="any" value={rawForm.cost} onChange={(e) => setRawForm({ ...rawForm, cost: e.target.value })} />
                {rawCostPer !== null && <span className="dk-muted pr-small">{tr('{price} per {unit}', { price: money(rawCostPer), unit: unitOne(rawForm.unit) })}</span>}
              </div>
              <div className="field pr-span">
                <span className="pr-label">{tr('Grade')}</span>
                <div className="pr-grades" role="radiogroup" aria-label={tr('Grade')}>
                  {GRADES.map((g) => (
                    <button key={g.key} type="button" role="radio" aria-checked={rawForm.grade === g.key} className={'pr-grade-pick is-' + g.key + (rawForm.grade === g.key ? ' is-on' : '')} onClick={() => setRawForm({ ...rawForm, grade: g.key })}>
                      <strong>{tr(g.label)}</strong><span>{tr(g.note)}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="field pr-span">
                <label htmlFor="rb-warehouse">{tr('Warehouse')}</label>
                <div className="pr-inline">
                  <select id="rb-warehouse" className="input" value={rawForm.warehouseId} onChange={(e) => setRawForm({ ...rawForm, warehouseId: e.target.value })} required>
                    <option value="" disabled>{tr('Choose a warehouse')}</option>
                    {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                  {canWarehouse && <button type="button" className="btn btn-secondary" onClick={() => openWarehouse(null)}>{tr('+ New')}</button>}
                </div>
              </div>
              <div className="field pr-span">
                <label htmlFor="rb-notes">{tr('Notes (optional)')}</label>
                <textarea id="rb-notes" className="input pr-textarea" maxLength={500} value={rawForm.notes} onChange={(e) => setRawForm({ ...rawForm, notes: e.target.value })} placeholder={tr('Truck number, who delivered it, condition on arrival…')} />
              </div>
            </div>
            {formError && <div className="error-banner">{formError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setRawDialog(null)} disabled={saving}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : rawDialog.id ? tr('Save changes') : tr('Receive')}</button>
            </div>
          </form>
        </div>
      )}

      {/* ── record production ── */}
      {recordOpen && (
        <div className="dialog-backdrop" onClick={() => !saving && setRecordOpen(false)}>
          <form className="dialog pr-dialog" onClick={(e) => e.stopPropagation()} onSubmit={saveRecord}>
            <h2>{tr('Record production')}</h2>
            <div className="pr-form">
              <div className="field pr-span">
                <label htmlFor="pb-raw">{tr('Raw bamboo used')}</label>
                <div className="pr-inline">
                  <select id="pb-raw" className="input" value={recForm.rawBatchId} onChange={(e) => setRecForm({ ...recForm, rawBatchId: e.target.value })} required>
                    <option value="" disabled>{tr('Choose a batch')}</option>
                    {inStock.map((r) => <option key={r.id} value={r.id}>{r.batchNo} — {r.species} — {tr('{left} left', { left: qty(r.quantity, r.unit) })}</option>)}
                  </select>
                  <button type="button" className="btn btn-secondary" onClick={() => { setRecordOpen(false); openReceive(); }}>{tr('+ New')}</button>
                </div>
              </div>
              <div className="field pr-span">
                <label htmlFor="pb-product">{tr('Product made')}</label>
                <div className="pr-inline is-wrap">
                  <select id="pb-product" className="input" value={recForm.outputProductId} onChange={(e) => setRecForm({ ...recForm, outputProductId: e.target.value })} required>
                    <option value="" disabled>{tr('Choose a product')}</option>
                    {products.map((p) => <option key={p.id} value={p.id}>{p.name}{p.sku ? ' (' + p.sku + ')' : ''}</option>)}
                  </select>
                  {canInventory && <button type="button" className="btn btn-secondary" onClick={() => openProduct(false)}>{tr('+ New')}</button>}
                  {canInventory && recForm.outputProductId && <button type="button" className="btn btn-secondary" onClick={() => openProduct(true)}>{tr('Edit')}</button>}
                </div>
              </div>
              <div className="field">
                <label htmlFor="pb-date">{tr('Date')}</label>
                <input id="pb-date" className="input" type="date" max={today} value={recForm.date} onChange={(e) => setRecForm({ ...recForm, date: e.target.value })} required />
              </div>
              <div className="field">
                <label htmlFor="pb-line">{tr('Production line')}</label>
                <input id="pb-line" className="input" list="pb-lines" value={recForm.productionLine} maxLength={60} onChange={(e) => setRecForm({ ...recForm, productionLine: e.target.value })} placeholder={tr('e.g. Weaving Line')} required />
                <datalist id="pb-lines">{lines.map((l) => <option key={l} value={l} />)}</datalist>
              </div>
              <div className="field">
                <label htmlFor="pb-input">{tr('Bamboo used')}{recRaw ? ' (' + unitLabel(recRaw.unit) + ')' : ''}</label>
                <div className="pr-inline">
                  <input id="pb-input" className="input" type="number" min="0" step="any" max={recRaw ? recRaw.quantity : undefined} value={recForm.inputQty} onChange={(e) => setRecForm({ ...recForm, inputQty: e.target.value })} required />
                  {recRaw && <button type="button" className="btn btn-secondary pr-all" onClick={() => setRecForm({ ...recForm, inputQty: String(recRaw.quantity) })}>{tr('All')}</button>}
                </div>
              </div>
              <div className="field">
                <label htmlFor="pb-output">{tr('Made')}{recProduct ? ' (' + recProduct.unit + ')' : ''}</label>
                <input id="pb-output" className="input" type="number" min="0" step="any" value={recForm.outputQty} onChange={(e) => setRecForm({ ...recForm, outputQty: e.target.value })} required />
              </div>
              <div className="field">
                <label htmlFor="pb-waste">{tr('Waste')}{recRaw ? ' (' + unitLabel(recRaw.unit) + ')' : ''}</label>
                <input id="pb-waste" className="input" type="number" min="0" step="any" value={recForm.wasteQty} onChange={(e) => setRecForm({ ...recForm, wasteQty: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="pb-rejected">{tr('Rejected')}{recProduct ? ' (' + recProduct.unit + ')' : ''}</label>
                <input id="pb-rejected" className="input" type="number" min="0" step="any" value={recForm.rejectedQty} onChange={(e) => setRecForm({ ...recForm, rejectedQty: e.target.value })} />
              </div>
              {recRaw && recIn > 0 && (
                <div className={'pr-preview pr-span' + (recIn > recRaw.quantity ? ' is-bad' : '')}>
                  {recIn > recRaw.quantity
                    ? tr('Only {left} is left in {batchNo}.', { left: qty(recRaw.quantity, recRaw.unit), batchNo: recRaw.batchNo })
                    : <>
                      {tr('Leaves {left} in {batchNo}.', { left: qty(recRaw.quantity - recIn, recRaw.unit), batchNo: recRaw.batchNo })}
                      {recOut > 0 && ' ' + tr('{yield} {product} per {unit}.', { yield: n(recOut / recIn, 2), product: recProduct ? recProduct.unit : '', unit: unitOne(recRaw.unit) })}
                      {recWaste > 0 && ' ' + tr('{pct}% waste.', { pct: n((recWaste / recIn) * 100) })}
                    </>}
                </div>
              )}
              {employees.length > 0 && (
                <>
                  <div className="field pr-span">
                    <label htmlFor="pb-sup">{tr('Supervisor')}</label>
                    <select id="pb-sup" className="input" value={recForm.supervisorId} onChange={(e) => setRecForm({ ...recForm, supervisorId: e.target.value })}>
                      <option value="">{tr('Me')}</option>
                      {employees.map((em) => <option key={em.id} value={em.id}>{em.firstName} {em.lastName}</option>)}
                    </select>
                  </div>
                  <div className="field pr-span">
                    <span className="pr-label">{tr('Who worked on it (optional)')}</span>
                    <PeoplePicker employees={employees} value={recForm.employeeIds} onChange={(ids) => setRecForm({ ...recForm, employeeIds: ids })} emptyText={tr('Nobody yet.')} />
                  </div>
                </>
              )}
              <div className="field pr-span">
                <label htmlFor="pb-notes">{tr('Notes (optional)')}</label>
                <textarea id="pb-notes" className="input pr-textarea" maxLength={1000} value={recForm.notes} onChange={(e) => setRecForm({ ...recForm, notes: e.target.value })} placeholder={tr('Machine problems, why waste was high…')} />
              </div>
            </div>
            {formError && <div className="error-banner">{formError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setRecordOpen(false)} disabled={saving}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : tr('Record batch')}</button>
            </div>
          </form>
        </div>
      )}

      {/* ── one production record ── */}
      {detail && (
        <div className="dialog-backdrop" onClick={() => !saving && setDetail(null)}>
          <div className="dialog pr-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="pr-detail-head">
              <div>
                <h2>{n(detail.b.outputQty, 0)} {detail.b.productUnit} · {detail.b.productName}</h2>
                <span className="dk-muted">{detail.b.batchNo} · {fmtDate(detail.b.date)} · {detail.b.productionLine}</span>
              </div>
              <button type="button" className="pr-close" onClick={() => setDetail(null)} aria-label={tr('Close')}>×</button>
            </div>
            {detail.b.status === 'cancelled' && (
              <div className="pr-cancelled">
                <Status tone="muted">{tr('Cancelled')}</Status>
                <span>{tr('by {name} on {date}: {reason}', { name: detail.b.cancelledByName || '—', date: fmtDate(String(detail.b.cancelledAt).slice(0, 10)), reason: detail.b.cancelReason })}</span>
              </div>
            )}
            <div className="pr-flow">
              <div><span className="dk-muted">{tr('Bamboo used')}</span><strong>{qty(detail.b.inputQty, detail.b.rawUnit)}</strong><span className="dk-muted">{detail.b.rawBatchNo}{detail.b.rawSpecies ? ' · ' + detail.b.rawSpecies : ''}</span></div>
              <span className="pr-arrow" aria-hidden="true">→</span>
              <div><span className="dk-muted">{tr('Made')}</span><strong>{n(detail.b.outputQty, 0)} {detail.b.productUnit}</strong><span className="dk-muted">{detail.b.productSku || detail.b.productName}</span></div>
            </div>
            <dl className="pr-facts pr-facts-wide">
              <div><dt>{tr('Yield')}</dt><dd>{tr('{yield} per {unit}', { yield: n(detail.b.yieldPerUnit, 2), unit: unitOne(detail.b.rawUnit) })}</dd></div>
              <div><dt>{tr('Waste')}</dt><dd>{qty(detail.b.wasteQty, detail.b.rawUnit)} · <Status tone={wasteTone(detail.b.wastePct)}>{n(detail.b.wastePct)}%</Status></dd></div>
              <div><dt>{tr('Rejected')}</dt><dd>{n(detail.b.rejectedQty, 0)} {detail.b.productUnit}{detail.b.rejectedQty ? ' · ' + n(detail.b.rejectPct) + '%' : ''}</dd></div>
              {detail.b.rawCost !== null && <div><dt>{tr('Bamboo cost')}</dt><dd>{money(detail.b.rawCost)}</dd></div>}
              {detail.b.outputValue > 0 && <div><dt>{tr('Output at cost price')}</dt><dd>{money(detail.b.outputValue)}</dd></div>}
            </dl>
            <div className="pr-people">
              <span className="pr-person"><Photo id={detail.b.supervisorId} name={detail.b.supervisorName} photo={detail.b.supervisorPhoto} size={30} /><span><strong>{detail.b.supervisorName}</strong><span className="dk-muted">{tr('Supervisor')}</span></span></span>
              {detail.b.workers.filter((w) => w.id !== detail.b.supervisorId).map((w) => (
                <span key={w.id} className="pr-person"><Photo id={w.id} name={w.name} photo={w.photo} size={30} /><span><strong>{w.name}</strong></span></span>
              ))}
            </div>
            {detail.b.notes && <p className="pr-notes">{detail.b.notes}</p>}
            {detail.cancelling && (
              <div className="field">
                <label htmlFor="pb-cancel-reason">{tr('Why cancel it?')}</label>
                <input id="pb-cancel-reason" className="input" value={detail.reason || ''} maxLength={200} onChange={(e) => setDetail({ ...detail, reason: e.target.value })} placeholder={tr('e.g. Entered twice')} autoFocus />
                <span className="dk-muted pr-small">{tr('{qty} goes back to {batch} and {out} comes off stock.', { qty: qty(detail.b.inputQty, detail.b.rawUnit), batch: detail.b.rawBatchNo, out: n(detail.b.outputQty, 0) + ' ' + detail.b.productUnit })}</span>
              </div>
            )}
            {formError && <div className="error-banner">{formError}</div>}
            <div className="dialog-actions">
              {canProduction && detail.b.status !== 'cancelled' && !detail.cancelling && <button type="button" className="btn btn-secondary" onClick={() => { setFormError(null); setDetail({ ...detail, cancelling: true, reason: '' }); }}>{tr('Cancel this record')}</button>}
              {detail.cancelling && <button type="button" className="btn btn-secondary" onClick={() => setDetail({ b: detail.b })} disabled={saving}>{tr('Keep it')}</button>}
              {detail.cancelling
                ? <button type="button" className="btn btn-primary" onClick={cancelBatch} disabled={saving || !String(detail.reason || '').trim()}>{saving ? tr('Saving…') : tr('Cancel the record')}</button>
                : <button type="button" className="btn btn-primary" onClick={() => setDetail(null)}>{tr('Close')}</button>}
            </div>
          </div>
        </div>
      )}

      {/* ── write off ── */}
      {writeOff && (
        <div className="dialog-backdrop" onClick={() => !saving && setWriteOff(null)}>
          <form className="dialog pr-dialog" onClick={(e) => e.stopPropagation()} onSubmit={saveWriteOff}>
            <h2>{tr('Write off bamboo')}</h2>
            <p className="dk-muted pr-small">{tr('{batchNo} ({species}) has {left} left. Bamboo written off comes out of stock and is kept on record with the reason.', { batchNo: writeOff.r.batchNo, species: writeOff.r.species, left: qty(writeOff.r.quantity, writeOff.r.unit) })}</p>
            <div className="pr-form">
              <div className="field">
                <label htmlFor="wo-qty">{tr('How much')} ({unitLabel(writeOff.r.unit)})</label>
                <input id="wo-qty" className="input" type="number" min="0" step="any" max={writeOff.r.quantity} value={writeOff.qty} onChange={(e) => setWriteOff({ ...writeOff, qty: e.target.value })} required />
              </div>
              <div className="field">
                <label htmlFor="wo-reason">{tr('Reason')}</label>
                <input id="wo-reason" className="input" list="wo-reasons" maxLength={200} value={writeOff.reason} onChange={(e) => setWriteOff({ ...writeOff, reason: e.target.value })} required />
                <datalist id="wo-reasons">{WRITE_OFF_REASONS.map((r) => <option key={r} value={tr(r)} />)}</datalist>
              </div>
            </div>
            {formError && <div className="error-banner">{formError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setWriteOff(null)} disabled={saving}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : tr('Write off')}</button>
            </div>
          </form>
        </div>
      )}

      {/* ── warehouse ── */}
      {whDialog && (
        <div className="dialog-backdrop pr-over" onClick={() => !saving && setWhDialog(null)}>
          <form className="dialog pr-dialog pr-small-dialog" onClick={(e) => e.stopPropagation()} onSubmit={saveWarehouse}>
            <h2>{whDialog.id ? tr('Edit warehouse') : tr('Add warehouse')}</h2>
            <div className="field">
              <label htmlFor="wh-name">{tr('Warehouse name')}</label>
              <input id="wh-name" className="input" value={whForm.name} onChange={(e) => setWhForm({ ...whForm, name: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="wh-location">{tr('Location')}</label>
              <input id="wh-location" className="input" value={whForm.location} onChange={(e) => setWhForm({ ...whForm, location: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="wh-capacity">{tr('Capacity (optional)')}</label>
              <input id="wh-capacity" className="input" type="number" min="0" value={whForm.capacity} onChange={(e) => setWhForm({ ...whForm, capacity: e.target.value })} />
              <span className="dk-muted pr-small">{tr('In the unit the bamboo is counted in, usually kg. Used to warn when it is full.')}</span>
            </div>
            {subError && <div className="error-banner">{subError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setWhDialog(null)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{whDialog.id ? tr('Save changes') : tr('Add warehouse')}</button>
            </div>
          </form>
        </div>
      )}

      {whDelete && (
        <div className="dialog-backdrop" onClick={() => setWhDelete(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Delete warehouse')}</h2>
            <p className="dialog-body">{tr('Delete')} <strong>{whDelete.name}</strong>{tr('? This cannot be undone.')}</p>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setWhDelete(null)}>{tr('Cancel')}</button>
              <button type="button" className="btn btn-primary" onClick={deleteWarehouse}>{tr('Delete')}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── supplier (from the receive form) ── */}
      {supOpen && (
        <div className="dialog-backdrop pr-over" onClick={() => !saving && setSupOpen(false)}>
          <form className="dialog pr-dialog" onClick={(e) => e.stopPropagation()} onSubmit={saveSupplier}>
            <h2>{tr('Add supplier')}</h2>
            <div className="pr-form">
              <div className="field pr-span">
                <label htmlFor="prsup-name">{tr('Supplier name')}</label>
                <input id="prsup-name" className="input" value={supForm.name} onChange={(e) => setSupForm({ ...supForm, name: e.target.value })} required />
              </div>
              <div className="field">
                <label htmlFor="prsup-contact">{tr('Contact person')}</label>
                <input id="prsup-contact" className="input" value={supForm.contactPerson} onChange={(e) => setSupForm({ ...supForm, contactPerson: e.target.value })} required />
              </div>
              <div className="field">
                <label htmlFor="prsup-phone">{tr('Phone')}</label>
                <input id="prsup-phone" className="input" type="tel" value={supForm.phone} onChange={(e) => setSupForm({ ...supForm, phone: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="prsup-email">{tr('Email')}</label>
                <input id="prsup-email" className="input" type="email" value={supForm.email} onChange={(e) => setSupForm({ ...supForm, email: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="prsup-address">{tr('Address')}</label>
                <input id="prsup-address" className="input" value={supForm.address} onChange={(e) => setSupForm({ ...supForm, address: e.target.value })} />
              </div>
              <div className="field pr-span">
                <label htmlFor="prsup-materials">{tr('Materials supplied')}</label>
                <input id="prsup-materials" className="input" value={supForm.materialsSupplied} onChange={(e) => setSupForm({ ...supForm, materialsSupplied: e.target.value })} required />
              </div>
            </div>
            {subError && <div className="error-banner">{subError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setSupOpen(false)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{tr('Add supplier')}</button>
            </div>
          </form>
        </div>
      )}

      {/* ── product (from the record form) ── */}
      {prodDialog && (
        <div className="dialog-backdrop pr-over" onClick={() => !saving && setProdDialog(null)}>
          <form className="dialog pr-dialog" onClick={(e) => e.stopPropagation()} onSubmit={saveProduct}>
            <h2>{prodDialog.id ? tr('Edit product') : tr('Add product')}</h2>
            <div className="pr-form">
              <div className="field">
                <label htmlFor="prprod-sku">SKU</label>
                <input id="prprod-sku" className="input" value={prodForm.sku} onChange={(e) => setProdForm({ ...prodForm, sku: e.target.value })} required />
              </div>
              <div className="field">
                <label htmlFor="prprod-name">{tr('Name')}</label>
                <input id="prprod-name" className="input" value={prodForm.name} onChange={(e) => setProdForm({ ...prodForm, name: e.target.value })} required />
              </div>
              <div className="field">
                <label htmlFor="prprod-category">{tr('Category')}</label>
                <input id="prprod-category" className="input" value={prodForm.category} onChange={(e) => setProdForm({ ...prodForm, category: e.target.value })} required />
              </div>
              <div className="field">
                <label htmlFor="prprod-unit">{tr('Unit')}</label>
                <input id="prprod-unit" className="input" value={prodForm.unit} onChange={(e) => setProdForm({ ...prodForm, unit: e.target.value })} placeholder={tr('piece, plank, pack')} />
              </div>
              <div className="field">
                <label htmlFor="prprod-cost">{tr('Cost price')}</label>
                <input id="prprod-cost" className="input" type="number" value={prodForm.costPrice} onChange={(e) => setProdForm({ ...prodForm, costPrice: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="prprod-price">{tr('Selling price')}</label>
                <input id="prprod-price" className="input" type="number" value={prodForm.sellingPrice} onChange={(e) => setProdForm({ ...prodForm, sellingPrice: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="prprod-stock">{tr('Opening stock')}</label>
                <input id="prprod-stock" className="input" type="number" value={prodForm.currentStock} onChange={(e) => setProdForm({ ...prodForm, currentStock: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="prprod-reorder">{tr('Reorder level')}</label>
                <input id="prprod-reorder" className="input" type="number" value={prodForm.reorderLevel} onChange={(e) => setProdForm({ ...prodForm, reorderLevel: e.target.value })} />
              </div>
            </div>
            {subError && <div className="error-banner">{subError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setProdDialog(null)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{prodDialog.id ? tr('Save changes') : tr('Add product')}</button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
