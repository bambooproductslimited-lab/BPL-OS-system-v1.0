import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import PurchaseOrderPreview from '../components/PurchaseOrderPreview';
import RowMenu from '../components/RowMenu';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { Hero, Insights, Section, Status, fmtDate } from '../components/DashKit';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import './EmployeesPage.css';
import './PurchaseOrdersPage.css';

// Purchase orders to suppliers and bamboo farmers (backend
// purchaseOrders.service.js): made in a form laid out like the paper one
// (components/PurchaseOrderPreview.jsx is the document itself), printed or
// shared as a PDF, marked sent, then delivered with what came — or
// cancelled. procurement.approve makes them; procurement.read.all sees them.

const STATUS_TEXT = { draft: () => tr('Draft'), issued: () => tr('Sent to the supplier'), delivered: () => tr('Delivered'), cancelled: () => tr('Cancelled') };
const STATUS_TONE = { draft: 'muted', issued: 'info', delivered: 'good', cancelled: 'bad' };

function money(n, cur) {
  return (cur || 'GHS') + ' ' + Number(n || 0).toLocaleString(activeIntlLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function qty(n) { return Number(n || 0).toLocaleString(activeIntlLocale(), { maximumFractionDigits: 3 }); }
function toNum(v) { const n = Number(String(v == null ? '' : v).replace(/,/g, '').trim()); return Number.isFinite(n) ? n : 0; }
function today() { return new Date().toISOString().slice(0, 10); }
const BLANK_LINE = { description: '', specification: '', quantity: '', unit: 'pcs', unitPrice: '' };

// ── the form, in the order of the paper one ──
function PoForm({ order, options, busy, onSave, onClose }) {
  const first = options.companies[0] || { id: '', next: '' };
  const [f, setF] = useState(() => (order ? {
    companyId: order.company.id, number: order.number, title: order.title, poDate: order.poDate,
    supplierId: order.supplier.id || '', supplierName: order.supplier.name, supplierLocation: order.supplier.location, supplierContact: order.supplier.contact,
    currency: order.currency, lines: order.lines.map((l) => ({ description: l.description, specification: l.specification, quantity: String(l.quantity), unit: l.unit, unitPrice: String(l.unitPrice) })),
    quality: order.quality.length ? order.quality.slice() : [''], deliveryLocation: order.deliveryLocation, deliveryDate: order.deliveryDate || '', notes: order.notes,
    preparedName: order.preparedBy.name, preparedPosition: order.preparedBy.position, preparedSignature: order.preparedBy.signature, preparedOn: order.preparedBy.on || order.poDate
  } : {
    companyId: first.id, number: first.next, title: '', poDate: today(),
    supplierId: '', supplierName: '', supplierLocation: '', supplierContact: '',
    currency: 'GHS', lines: [{ ...BLANK_LINE }], quality: [''], deliveryLocation: options.places[0] || '', deliveryDate: '', notes: '',
    preparedName: options.me.name, preparedPosition: options.me.position, preparedSignature: options.me.signature, preparedOn: today()
  }));
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const setLine = (i, k, v) => setF((x) => ({ ...x, lines: x.lines.map((l, n) => (n === i ? { ...l, [k]: v } : l)) }));
  const setQuality = (i, v) => setF((x) => ({ ...x, quality: x.quality.map((q, n) => (n === i ? v : q)) }));
  const total = f.lines.reduce((s, l) => s + Math.round(toNum(l.quantity) * toNum(l.unitPrice) * 100) / 100, 0);

  function pickCompany(id) {
    const co = options.companies.find((c) => c.id === id);
    setF((x) => ({ ...x, companyId: id, number: order ? x.number : (co ? co.next : x.number) }));
  }
  // A name from the list brings its place and number; another name is a new one.
  function pickSupplier(name) {
    const s = options.suppliers.find((x) => x.name.trim().toLowerCase() === name.trim().toLowerCase());
    setF((x) => {
      const was = options.suppliers.find((y) => y.id === x.supplierId);
      const fromWas = (k) => !x[k] || (was && x[k] === was[k === 'supplierLocation' ? 'location' : 'contact']);
      return {
        ...x, supplierName: name, supplierId: s ? s.id : '',
        supplierLocation: s && fromWas('supplierLocation') ? s.location : x.supplierLocation,
        supplierContact: s && fromWas('supplierContact') ? s.contact : x.supplierContact
      };
    });
  }
  function save(e) {
    e.preventDefault();
    onSave({
      ...f,
      lines: f.lines.filter((l) => l.description.trim() || String(l.quantity).trim() || String(l.unitPrice).trim()),
      quality: f.quality.filter((q) => q.trim())
    });
  }
  const early = f.deliveryDate && f.poDate && f.deliveryDate < f.poDate;
  const ready = f.title.trim() && f.supplierName.trim() && f.lines.some((l) => l.description.trim() && toNum(l.quantity) > 0);

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog po-form" role="dialog" aria-modal="true" aria-labelledby="po-form-title" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2 id="po-form-title">{order ? tr('Change purchase order {no}', { no: order.number }) : tr('New purchase order')}</h2>

        <div className="po-grid">
          <label className="po-wide"><span>{tr('What it is for (the title)')}</span>
            <input className="input" value={f.title} maxLength={120} onChange={(e) => set('title', e.target.value)} placeholder={tr('Such as Bamboo poles')} autoFocus />
            <small className="dk-muted">{tr('It prints as PURCHASE ORDER – {title}', { title: (f.title || tr('Bamboo poles')).toUpperCase() })}</small>
          </label>
          {options.companies.length > 1 && (
            <label><span>{tr('Company buying')}</span>
              <select className="input" value={f.companyId} onChange={(e) => pickCompany(e.target.value)}>
                {options.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          )}
          <label><span>{tr('PO No.')}</span><input className="input" value={f.number} maxLength={30} onChange={(e) => set('number', e.target.value)} /></label>
          <label><span>{tr('Date')}</span><input type="date" className="input" value={f.poDate} onChange={(e) => set('poDate', e.target.value)} /></label>
        </div>

        <h3 className="po-h">{tr('Supplier')}</h3>
        <div className="po-grid">
          <label className="po-wide"><span>{tr('Supplier/Farmer')}</span>
            <input className="input" list="po-suppliers" value={f.supplierName} maxLength={160} onChange={(e) => pickSupplier(e.target.value)} placeholder={tr('Start typing a name from the supplier list, or a new one')} />
            <datalist id="po-suppliers">{options.suppliers.map((s) => <option key={s.id} value={s.name}>{s.outgrower ? tr('Bamboo farmer') : s.location}</option>)}</datalist>
            {f.supplierName && <small className="dk-muted">{f.supplierId ? '✓ ' + tr('On the supplier list') : tr('Not on the supplier list: printed as typed')}</small>}
          </label>
          <label><span>{tr('Location')}</span><input className="input" value={f.supplierLocation} maxLength={160} onChange={(e) => set('supplierLocation', e.target.value)} /></label>
          <label><span>{tr('Contact')}</span><input className="input" value={f.supplierContact} maxLength={80} inputMode="tel" onChange={(e) => set('supplierContact', e.target.value)} /></label>
        </div>

        <h3 className="po-h">{tr('Purchase details')}</h3>
        <div className="po-lines">
          <div className="po-line po-line-head" aria-hidden="true">
            <span>{tr('Description')}</span><span>{tr('Specification')}</span><span>{tr('Quantity')}</span><span>{tr('Unit')}</span><span>{tr('Unit price')}</span><span>{tr('Total')}</span><span />
          </div>
          {f.lines.map((l, i) => (
            <div key={i} className="po-line">
              <input className="input" value={l.description} maxLength={160} onChange={(e) => setLine(i, 'description', e.target.value)} placeholder={tr('Bamboo poles')} aria-label={tr('Line {n}: description', { n: i + 1 })} />
              <input className="input" value={l.specification} maxLength={300} onChange={(e) => setLine(i, 'specification', e.target.value)} placeholder={tr('Minimum length: 14ft')} aria-label={tr('Line {n}: specification', { n: i + 1 })} />
              <input className="input" value={l.quantity} inputMode="decimal" onChange={(e) => setLine(i, 'quantity', e.target.value)} placeholder="0" aria-label={tr('Line {n}: quantity', { n: i + 1 })} />
              <input className="input" value={l.unit} maxLength={20} onChange={(e) => setLine(i, 'unit', e.target.value)} aria-label={tr('Line {n}: unit', { n: i + 1 })} />
              <input className="input" value={l.unitPrice} inputMode="decimal" onChange={(e) => setLine(i, 'unitPrice', e.target.value)} placeholder="0.00" aria-label={tr('Line {n}: unit price', { n: i + 1 })} />
              <span className="po-line-total">{Number(Math.round(toNum(l.quantity) * toNum(l.unitPrice) * 100) / 100).toLocaleString(activeIntlLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              <button type="button" className="po-x" disabled={f.lines.length === 1} onClick={() => setF((x) => ({ ...x, lines: x.lines.filter((_, n) => n !== i) }))} aria-label={tr('Take line {n} out', { n: i + 1 })}>×</button>
            </div>
          ))}
          <div className="po-lines-foot">
            <button type="button" className="pos-link" onClick={() => setF((x) => ({ ...x, lines: x.lines.concat([{ ...BLANK_LINE }]) }))}>＋ {tr('Add a line')}</button>
            <span className="po-total">
              {tr('Total purchase value')}: <b>{money(total, f.currency)}</b>
              <select className="input po-cur" value={f.currency} onChange={(e) => set('currency', e.target.value)} aria-label={tr('Currency')}>
                {options.currencies.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </span>
          </div>
        </div>

        <h3 className="po-h">{tr('Quality requirements')}</h3>
        <ol className="po-quality">
          {f.quality.map((q, i) => (
            <li key={i}>
              <input className="input" value={q} maxLength={300} onChange={(e) => setQuality(i, e.target.value)} placeholder={i === 0 ? tr('Minimum length of 14 feet.') : ''} aria-label={tr('Quality requirement {n}', { n: i + 1 })} />
              <button type="button" className="po-x" onClick={() => setF((x) => ({ ...x, quality: x.quality.length > 1 ? x.quality.filter((_, n) => n !== i) : [''] }))} aria-label={tr('Take requirement {n} out', { n: i + 1 })}>×</button>
            </li>
          ))}
        </ol>
        <button type="button" className="pos-link" onClick={() => setF((x) => ({ ...x, quality: x.quality.concat(['']) }))}>＋ {tr('Add a requirement')}</button>

        <h3 className="po-h">{tr('Delivery')}</h3>
        <div className="po-grid">
          <label className="po-wide"><span>{tr('Delivery location')}</span>
            <input className="input" list="po-places" value={f.deliveryLocation} maxLength={200} onChange={(e) => set('deliveryLocation', e.target.value)} placeholder={tr('Such as our factory, Tema Community 9')} />
            <datalist id="po-places">{options.places.map((p) => <option key={p} value={p} />)}</datalist>
          </label>
          <label><span>{tr('Expected delivery date')}</span><input type="date" className="input" value={f.deliveryDate} onChange={(e) => set('deliveryDate', e.target.value)} /></label>
        </div>
        {early && <p className="po-warn" role="status">⚠️ {tr('The delivery date is before the order date. Check it.')}</p>}

        <h3 className="po-h">{tr('Approval')}</h3>
        <div className="po-grid">
          <label><span>{tr('Prepared by')}</span><input className="input" value={f.preparedName} maxLength={120} onChange={(e) => set('preparedName', e.target.value)} /></label>
          <label><span>{tr('Position')}</span><input className="input" value={f.preparedPosition} maxLength={120} onChange={(e) => set('preparedPosition', e.target.value)} /></label>
          <label><span>{tr('Signature (initials)')}</span><input className="input" value={f.preparedSignature} maxLength={40} onChange={(e) => set('preparedSignature', e.target.value)} /></label>
          <label><span>{tr('Date')}</span><input type="date" className="input" value={f.preparedOn} onChange={(e) => set('preparedOn', e.target.value)} /></label>
        </div>

        <label className="po-notes"><span>{tr('Notes (optional, printed at the end)')}</span>
          <textarea className="input" rows={2} maxLength={2000} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        </label>

        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !ready}>{busy ? tr('Saving…') : order ? tr('Save changes') : tr('Save and see it')}</button>
        </div>
      </form>
    </div>
  );
}

// What came: line by line, and the day.
function DeliveryDialog({ order, busy, onDone, onClose }) {
  const [got, setGot] = useState(() => order.lines.map((l) => String(l.quantity)));
  const [on, setOn] = useState(today());
  const [note, setNote] = useState('');
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog po-small" role="dialog" aria-modal="true" aria-labelledby="po-dl-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="po-dl-title">{tr('Delivery of {no}', { no: order.number })}</h2>
        <p className="dk-muted">{tr('What actually came, line by line. Leave the ordered quantity when it all came.')}</p>
        {order.lines.map((l, i) => (
          <label key={l.id} className="po-dl-line"><span>{l.description} <small className="dk-muted">{tr('ordered {n}', { n: qty(l.quantity) + ' ' + l.unit })}</small></span>
            <input className="input" inputMode="decimal" value={got[i]} onChange={(e) => setGot((g) => g.map((x, n) => (n === i ? e.target.value : x)))} />
          </label>
        ))}
        <label className="po-dl-line"><span>{tr('Delivered on')}</span><input type="date" className="input" value={on} max={today()} onChange={(e) => setOn(e.target.value)} /></label>
        <label className="po-dl-line"><span>{tr('Note (optional)')}</span><input className="input" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder={tr('Such as 150 poles too short, sent back')} /></label>
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onDone({ status: 'delivered', received: got.map((g) => String(g).replace(/,/g, '')), deliveredOn: on, note })}>✓ {tr('Record the delivery')}</button>
        </div>
      </div>
    </div>
  );
}

function CancelDialog({ order, busy, onDone, onClose }) {
  const [reason, setReason] = useState('');
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog po-small" role="dialog" aria-modal="true" aria-labelledby="po-cx-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="po-cx-title">{tr('Cancel purchase order {no}?', { no: order.number })}</h2>
        <label className="po-dl-line"><span>{tr('Why')}</span><input className="input" value={reason} maxLength={300} autoFocus onChange={(e) => setReason(e.target.value)} placeholder={tr('Such as the farmer could not cut in time')} /></label>
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Keep it')}</button>
          <button type="button" className="btn btn-danger" disabled={busy || !reason.trim()} onClick={() => onDone({ status: 'cancelled', reason })}>{tr('Cancel the order')}</button>
        </div>
      </div>
    </div>
  );
}

export default function PurchaseOrdersPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [chip, setChip] = useState('open');
  const [form, setForm] = useState(null); // { order? }
  const [viewId, setViewId] = useState(null);
  const [delivering, setDelivering] = useState(null);
  const [cancelling, setCancelling] = useState(null);

  const load = useCallback(() => api.get('/purchase-orders').then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  function say(t) { setNotice(t); setTimeout(() => setNotice(null), 4000); }
  async function act(fn, done) {
    setBusy(true);
    try { const out = await fn(); await load(); if (done) say(done(out)); return out; } catch (e) { setError(e.message); throw e; } finally { setBusy(false); }
  }
  const save = (body) => act(() => (form.order ? api.patch('/purchase-orders/' + form.order.id, body) : api.post('/purchase-orders', body)),
    (o) => (form.order ? tr('{no} saved.', { no: o.number }) : tr('{no} made. Print it or share it with the supplier.', { no: o.number })))
    .then((o) => { setForm(null); setViewId(o.id); setError(null); }).catch(() => {});
  const move = (o, body, text) => act(() => api.post('/purchase-orders/' + o.id + '/status', body), () => text).then(() => { setDelivering(null); setCancelling(null); }).catch(() => {});
  const remove = (o) => act(() => api.del('/purchase-orders/' + o.id), () => tr('{no} deleted.', { no: o.number })).then(() => setViewId(null)).catch(() => {});

  const orders = useMemo(() => (data ? data.orders : []), [data]);
  if (!data) return <div className="dk po">{error ? <div className="error-banner" role="alert">{error}</div> : <p className="dk-muted">{tr('Loading…')}</p>}</div>;
  const can = data.can;
  const open = orders.filter((o) => o.status === 'draft' || o.status === 'issued');
  const late = open.filter((o) => o.late);
  const drafts = orders.filter((o) => o.status === 'draft');
  const month = data.today.slice(0, 7);
  const deliveredMonth = orders.filter((o) => o.status === 'delivered' && (o.deliveredOn || '').slice(0, 7) === month);
  const sum = (list) => list.reduce((s, o) => s + (o.currency === 'GHS' ? o.total : 0), 0);
  const chips = [
    ['open', tr('Open'), open.length], ['draft', tr('Drafts'), drafts.length], ['issued', tr('Sent'), orders.filter((o) => o.status === 'issued').length],
    ['late', tr('Late'), late.length], ['delivered', tr('Delivered'), orders.filter((o) => o.status === 'delivered').length],
    ['cancelled', tr('Cancelled'), orders.filter((o) => o.status === 'cancelled').length], ['all', tr('All'), orders.length]
  ];
  const visible = orders.filter((o) => (chip === 'all' || (chip === 'open' ? (o.status === 'draft' || o.status === 'issued') : chip === 'late' ? o.late : o.status === chip))
    && matchesQuery(search, [o.number, o.title, o.supplier.name, o.supplier.location, o.deliveryLocation, o.preparedBy.name].concat(o.lines.map((l) => l.description))));
  const stats = [
    { icon: 'doc', value: String(open.length), label: tr('open orders'), note: open.length ? tr('{amount} to receive', { amount: money(sum(open)) }) : tr('none waiting'), onClick: () => setChip('open') },
    { icon: 'warn', value: String(late.length), label: tr('late deliveries'), note: tr('past their expected delivery date'), tone: late.length ? 'late' : '', onClick: () => setChip('late') },
    { icon: 'send', value: String(drafts.length), label: tr('drafts'), note: tr('not sent to the supplier yet'), onClick: () => setChip('draft') },
    { icon: 'check', value: money(sum(deliveredMonth)), label: tr('delivered this month'), note: tr('{n} order(s)', { n: deliveredMonth.length }), onClick: () => setChip('delivered') }
  ];
  const insights = [];
  if (late.length) insights.push({ tone: 'bad', icon: 'warn', text: late.length === 1 ? tr('{no} is past its expected delivery date.', { no: late[0].number }) : tr('{n} orders are past their expected delivery date.', { n: late.length }), action: { label: tr('Show them'), run: () => setChip('late') } });
  if (drafts.length) insights.push({ tone: 'info', icon: 'send', text: drafts.length === 1 ? tr('{no} is still a draft: send it to the supplier.', { no: drafts[0].number }) : tr('{n} drafts are not sent to the supplier yet.', { n: drafts.length }), action: { label: tr('Show them'), run: () => setChip('draft') } });

  const view = viewId ? orders.find((o) => o.id === viewId) : null;
  const rowActions = (o) => [
    { label: tr('See and print'), onClick: () => setViewId(o.id) },
    { label: tr('Edit'), onClick: () => setForm({ order: o }), hidden: !can.edit || !(o.status === 'draft' || o.status === 'issued') },
    { label: tr('Mark as sent to the supplier'), onClick: () => move(o, { status: 'issued' }, tr('{no} is marked as sent.', { no: o.number })), hidden: !can.edit || o.status !== 'draft' },
    { label: tr('Record the delivery'), onClick: () => setDelivering(o), hidden: !can.edit || !(o.status === 'draft' || o.status === 'issued') },
    { label: tr('Back to a draft'), onClick: () => move(o, { status: 'draft' }, tr('{no} is a draft again.', { no: o.number })), hidden: !can.edit || !(o.status === 'issued' || o.status === 'delivered') },
    { label: tr('Cancel the order'), onClick: () => setCancelling(o), danger: true, hidden: !can.edit || !(o.status === 'draft' || o.status === 'issued') },
    { label: tr('Delete'), onClick: () => { if (window.confirm(tr('Delete {no} for good?', { no: o.number }))) remove(o); }, danger: true, hidden: !can.edit || !(o.status === 'draft' || o.status === 'cancelled') }
  ];

  return (
    <div className="dk po">
      {error && <div className="error-banner" role="alert">{error}</div>}
      {notice && <div className="po-toast" role="status">✅ {notice}</div>}
      <Hero
        eyebrow={new Date().toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        title={tr('Purchase orders')}
        sub={tr('What we order from suppliers and bamboo farmers: what, how many, at what price, the quality asked for, and when it is to be delivered — printed or shared as a PDF, then marked delivered with what came.')}
        actions={can.edit && <button type="button" className="btn btn-primary" onClick={() => setForm({})}>{tr('+ New purchase order')}</button>}
        stats={stats} />
      <Insights items={insights} />

      <Section id="po-list" title={tr('Purchase orders')} sub={tr('Newest first. Press one to see it as the supplier will.')}>
        <div className="po-tools"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search number, supplier, item, place…')} /></div>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {chips.map(([k, label, n]) => (
            <button key={k} type="button" role="radio" aria-checked={chip === k} className={'ppl-chip' + (chip === k ? ' is-on' : '')} onClick={() => setChip(k)}>{label} <span className="ppl-chip-n">{n}</span></button>
          ))}
        </div>
        {visible.length ? (
          <ul className="po-list">
            {visible.map((o) => (
              <li key={o.id} className={'po-row is-' + o.status + (o.late ? ' is-late' : '')}>
                <button type="button" className="po-open" onClick={() => setViewId(o.id)}>
                  <span className="po-row-main">
                    <span className="po-row-title"><b>{o.number}</b> {o.title}</span>
                    <span className="dk-muted">{o.supplier.name}{o.supplier.location ? ' · ' + o.supplier.location : ''} · {o.lines.map((l) => qty(l.quantity) + ' ' + l.unit + ' ' + l.description).join(', ')}</span>
                  </span>
                </button>
                <span className="po-row-money"><b>{money(o.total, o.currency)}</b><span className="dk-muted">{fmtDate(o.poDate)}</span></span>
                <span className="po-row-when">
                  <Status tone={o.late ? 'bad' : STATUS_TONE[o.status]}>{o.late ? tr('Late') : STATUS_TEXT[o.status]()}</Status>
                  <span className="dk-muted">
                    {o.status === 'delivered' ? (o.received !== null && o.received !== o.ordered ? tr('{got} of {ordered} came', { got: qty(o.received), ordered: qty(o.ordered) }) : fmtDate(o.deliveredOn))
                      : o.deliveryDate ? tr('Due {date}', { date: fmtDate(o.deliveryDate) }) : ''}
                  </span>
                </span>
                <span className="po-row-acts"><RowMenu actions={rowActions(o)} /></span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="dk-empty">
            <p>{orders.length ? tr('Nothing here. Try another filter.') : tr('No purchase orders yet.')}</p>
            {can.edit && !orders.length && <button type="button" className="btn btn-primary" onClick={() => setForm({})}>{tr('+ New purchase order')}</button>}
          </div>
        )}
      </Section>

      {view && !form && !delivering && !cancelling && (
        <PurchaseOrderPreview order={view} onClose={() => setViewId(null)} actions={can.edit && <>
          {(view.status === 'draft' || view.status === 'issued') && <button type="button" className="btn btn-secondary" onClick={() => setForm({ order: view })}>{tr('Edit')}</button>}
          {view.status === 'draft' && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => move(view, { status: 'issued' }, tr('{no} is marked as sent.', { no: view.number }))}>{tr('Mark as sent')}</button>}
          {(view.status === 'draft' || view.status === 'issued') && <button type="button" className="btn btn-secondary" onClick={() => setDelivering(view)}>{tr('Record the delivery')}</button>}
        </>} />
      )}
      {form && <PoForm order={form.order} options={data.options} busy={busy} onSave={save} onClose={() => setForm(null)} />}
      {delivering && <DeliveryDialog order={delivering} busy={busy} onDone={(body) => move(delivering, body, tr('{no} is delivered.', { no: delivering.number }))} onClose={() => setDelivering(null)} />}
      {cancelling && <CancelDialog order={cancelling} busy={busy} onDone={(body) => move(cancelling, body, tr('{no} is cancelled.', { no: cancelling.number }))} onClose={() => setCancelling(null)} />}
    </div>
  );
}
