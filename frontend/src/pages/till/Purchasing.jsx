import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '../../components/DashKit';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { activeIntlLocale, msg, tr } from '../../lib/i18n.jsx';
import './sixth.css';
import './fifteenth.css';

// Low stock and purchase orders, in the till settings (Menu and stock →
// Low stock and orders; backend restaurantPurchasing.service.js): what is
// at or under its level, each with a bar of how much is left; drafts made
// from it, one per supplier, or by hand; sent on WhatsApp (opened on this
// device) or by email; received into the stock at the price paid. And the
// suppliers, with who each thing is bought from. Managers are told when
// something goes under its level.

const TYPE_ICON = { menu: '🥤', ingredient: '🧅', supply: '📦' };
const TYPE_LABEL = { menu: msg('Dish or drink'), ingredient: msg('Ingredient'), supply: msg('Supply') };
const STATUS = { draft: [msg('Draft'), '📝'], sent: [msg('Sent'), '📨'], received: [msg('Received'), '✅'], cancelled: [msg('Cancelled'), '✖'] };
function qtyWords(n, unit) { return (Math.round(Number(n) * 1000) / 1000) + (unit && unit !== 'each' ? ' ' + unit : ''); }
function dateWords(d) { return d ? new Date(d).toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short' }) : ''; }

function LowList({ low, onDraft, busy }) {
  if (!low.length) {
    return (
      <div className="pu-happy">
        <span aria-hidden="true">🎉</span>
        <strong>{tr('Nothing is running low')}</strong>
        <small>{tr('Set a level on each thing in Stock (or "Warn when this few are left" on a dish) and it shows here when it gets there.')}</small>
      </div>
    );
  }
  const toOrder = low.filter((x) => x.suggest > 0).length;
  return (
    <div className="pu-low">
      <div className="pu-low-head">
        <strong>{tr('{n} running low', { n: low.length })}</strong>
        <button type="button" className="btn btn-primary pu-go" disabled={busy || !toOrder} onClick={onDraft} title={toOrder ? '' : tr('Everything low is on order already.')}>
          ✨ {tr('Draft orders for them')}
        </button>
      </div>
      <ul>
        {low.map((x, i) => {
          const pct = Math.max(0, Math.min(100, x.level ? (x.stock / (x.level * 2)) * 100 : 0));
          return (
            <li key={x.type + x.id} className={'pu-lowrow' + (x.out ? ' is-out' : '')} style={{ '--i': i }}>
              <span className="pu-ico" aria-hidden="true">{TYPE_ICON[x.type]}</span>
              <span className="pu-lowmain">
                <b>{x.name}</b>
                <span className="pu-bar" role="img" aria-label={tr('{left} left of {level}', { left: qtyWords(x.stock, x.unit), level: qtyWords(x.level, x.unit) })}>
                  <i style={{ width: pct + '%' }} /><em style={{ left: '50%' }} />
                </span>
                <small>
                  {x.out ? tr('None left') : tr('{left} left · level {level}', { left: qtyWords(x.stock, x.unit), level: qtyWords(x.level, x.unit) })}
                  {x.supplier ? ' · ' + x.supplier : ' · ' + tr('no supplier yet')}
                </small>
              </span>
              <span className="pu-lowside">
                {x.onOrder > 0 ? <span className="pu-onorder">📨 {tr('{n} on order', { n: qtyWords(x.onOrder, x.unit) })}</span> : <span className="pu-suggest">{tr('Order {n}', { n: qtyWords(x.suggest, x.unit) })}</span>}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function OrderCard({ o, open, onOpen, k }) {
  const [label, icon] = STATUS[o.status];
  return (
    <button type="button" className={'pu-po is-' + o.status + (open ? ' is-open' : '')} style={{ '--i': k }} onClick={onOpen} aria-expanded={open}>
      <span className="pu-po-ico" aria-hidden="true">{icon}</span>
      <span className="pu-po-main">
        <b>{o.ref} · {o.supplier.name || tr('No supplier yet')}</b>
        <small>{o.lines.length === 1 ? tr('1 line') : tr('{n} lines', { n: o.lines.length })} · {o.status === 'received' ? tr('received {date}', { date: dateWords(o.receivedAt) }) : o.status === 'sent' ? tr('sent {date}', { date: dateWords(o.sentAt) }) : tr('made {date}', { date: dateWords(o.createdAt) })}{o.expectedOn ? ' · ' + tr('needed by {date}', { date: dateWords(o.expectedOn) }) : ''}</small>
        {o.bill && <small className={'pu-bill is-' + o.bill.status}>🧾 {o.bill.ref} · {o.bill.status === 'paid' ? tr('paid') : o.bill.status === 'cancelled' ? tr('cancelled') : tr('{amount} to pay by {date}', { amount: money(o.bill.balance), date: dateWords(o.bill.dueDate) })}</small>}
      </span>
      <span className={'pu-status is-' + o.status}>{tr(label)}</span>
      <b className="pu-po-total">{money(o.total)}</b>
    </button>
  );
}

function OrderEditor({ o, data, call, onDone, emailOn }) {
  const editable = o.status === 'draft';
  const [lines, setLines] = useState(o.lines.map((l) => ({ ...l, qty: String(l.qty), unitCost: String(l.unitCost), receivedQty: String(l.receivedQty == null ? l.qty : l.receivedQty) })));
  const [supplierId, setSupplierId] = useState(o.supplierId || '');
  const [expectedOn, setExpectedOn] = useState(o.expectedOn || '');
  const [note, setNote] = useState(o.note === 'From the low stock' ? '' : o.note || '');
  const [adding, setAdding] = useState('');
  const [receiving, setReceiving] = useState(false);
  const [pay, setPay] = useState({ atDoor: false, dueDate: '', supplierRef: '' });
  const [sent, setSent] = useState(null);
  const total = lines.reduce((a, l) => a + (Number(receiving ? l.receivedQty : l.qty) || 0) * (Number(l.unitCost) || 0), 0);
  const body = () => ({ id: o.id, supplierId: supplierId || null, expectedOn: expectedOn || null, note, lines: lines.map((l) => ({ type: l.type, id: l.itemId, qty: Number(l.qty), unitCost: Number(l.unitCost) })) });
  function setLine(i, p) { setLines(lines.map((l, k) => (k === i ? { ...l, ...p } : l))); }
  function add(key) {
    const it = data.items.find((x) => x.type + ':' + x.id === key);
    if (!it || lines.some((l) => l.type === it.type && l.itemId === it.id)) return;
    setLines(lines.concat([{ type: it.type, itemId: it.id, name: it.name, unit: it.unit, qty: '1', unitCost: String(it.unitCost || 0), receivedQty: '1' }]));
    setAdding('');
  }
  async function save() { await call({ action: 'draft', order: body() }, tr('{ref} saved.', { ref: o.ref })); }
  async function send(via) {
    if (editable) await call({ action: 'draft', order: body() });
    const d = await call({ action: 'send', id: o.id, via }, via === 'email' ? tr('{ref} emailed to {to}.', { ref: o.ref, to: o.supplier.email }) : null);
    if (d && d.done && via === 'whatsapp') { setSent(d.done); window.open(d.done.whatsappUrl, '_blank', 'noopener'); }
  }
  async function receive() {
    await call({ action: 'receive', id: o.id, lines: lines.map((l) => ({ id: l.id, receivedQty: Number(l.receivedQty), unitCost: Number(l.unitCost) })), paidAtDoor: pay.atDoor, dueDate: pay.atDoor ? undefined : pay.dueDate || undefined, supplierRef: pay.supplierRef || undefined },
      pay.atDoor ? tr('{ref} received: the stock is up to date.', { ref: o.ref }) : tr('{ref} received: the stock is up to date, and the bill is with the office to pay.', { ref: o.ref }));
    onDone();
  }
  const sup = data.suppliers.find((s) => s.id === (supplierId || o.supplierId));
  return (
    <div className="pu-edit">
      {editable && (
        <div className="pu-row">
          <div className="field pu-grow"><label htmlFor={'pu-s-' + o.id}>{tr('Supplier')}</label>
            <select id={'pu-s-' + o.id} className="input" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">{tr('No supplier yet')}</option>
              {data.suppliers.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div className="field"><label htmlFor={'pu-d-' + o.id}>{tr('Needed by')}</label><input id={'pu-d-' + o.id} className="input" type="date" value={expectedOn} onChange={(e) => setExpectedOn(e.target.value)} /></div>
        </div>
      )}
      <div className="pu-lines-wrap">
      <table className="pu-lines">
        <thead><tr><th>{tr('What')}</th><th>{receiving ? tr('Came') : tr('How many')}</th><th>{tr('Each')}</th><th>{tr('Total')}</th>{editable && <th aria-label={tr('Remove')} />}</tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={l.type + l.itemId}>
              <td><span aria-hidden="true">{TYPE_ICON[l.type]} </span>{l.name}{l.unit && l.unit !== 'each' && <small> · {l.unit}</small>}</td>
              <td>{editable ? <input className="input" type="number" min="0" step="any" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} aria-label={tr('How many {name}', { name: l.name })} />
                : receiving ? <input className="input" type="number" min="0" step="any" value={l.receivedQty} onChange={(e) => setLine(i, { receivedQty: e.target.value })} aria-label={tr('How many {name} came', { name: l.name })} />
                  : qtyWords(l.receivedQty !== 'null' && o.status === 'received' ? l.receivedQty : l.qty, '')}</td>
              <td>{editable || receiving ? <input className="input" type="number" min="0" step="0.01" value={l.unitCost} onChange={(e) => setLine(i, { unitCost: e.target.value })} aria-label={tr('What one {name} costs', { name: l.name })} /> : money(l.unitCost)}</td>
              <td className="pu-num">{money((Number(receiving ? l.receivedQty : o.status === 'received' ? l.receivedQty : l.qty) || 0) * (Number(l.unitCost) || 0))}</td>
              {editable && <td><button type="button" className="cb-x" onClick={() => setLines(lines.filter((x, k) => k !== i))} aria-label={tr('Take {name} off', { name: l.name })}>×</button></td>}
            </tr>
          ))}
        </tbody>
        <tfoot><tr><td colSpan={3}>{tr('Total')}</td><td className="pu-num"><b>{money(total)}</b></td>{editable && <td />}</tr></tfoot>
      </table>
      </div>
      {editable && (
        <div className="pu-row">
          <select className="input pu-grow" value={adding} onChange={(e) => add(e.target.value)} aria-label={tr('Add to the order')}>
            <option value="">＋ {tr('Add to the order…')}</option>
            {data.items.filter((x) => !lines.some((l) => l.type === x.type && l.itemId === x.id)).map((x) => <option key={x.type + x.id} value={x.type + ':' + x.id}>{TYPE_ICON[x.type]} {x.name} ({tr(TYPE_LABEL[x.type])})</option>)}
          </select>
          <input className="input pu-grow" maxLength={400} value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr('A note for the supplier (optional)')} aria-label={tr('A note for the supplier (optional)')} />
        </div>
      )}
      {receiving && (
        <div className="pu-pay">
          <span>{tr('How is it paid?')}</span>
          <div className="pu-pay-seg" role="radiogroup" aria-label={tr('How is it paid?')}>
            <button type="button" role="radio" aria-checked={!pay.atDoor} className={!pay.atDoor ? 'is-on' : ''} onClick={() => setPay({ ...pay, atDoor: false })}>🧾 {tr('A bill: the office pays it')}</button>
            <button type="button" role="radio" aria-checked={pay.atDoor} className={pay.atDoor ? 'is-on' : ''} onClick={() => setPay({ ...pay, atDoor: true })}>💵 {tr('Paid at the door')}</button>
          </div>
          {!pay.atDoor && (
            <div className="pu-row">
              <div className="field pu-grow"><label htmlFor={'pu-ref-' + o.id}>{tr('Their invoice number')}</label><input id={'pu-ref-' + o.id} className="input" maxLength={60} value={pay.supplierRef} onChange={(e) => setPay({ ...pay, supplierRef: e.target.value })} /></div>
              <div className="field"><label htmlFor={'pu-due-' + o.id}>{tr('Due')}</label><input id={'pu-due-' + o.id} className="input" type="date" value={pay.dueDate} onChange={(e) => setPay({ ...pay, dueDate: e.target.value })} /></div>
            </div>
          )}
        </div>
      )}
      {sent && (
        <div className="pu-sent">
          <p className="pu-message">{sent.message}</p>
          {!sent.hasNumber && <small className="dk-muted">{tr('This supplier has no WhatsApp number: pick the chat on your phone.')}</small>}
          <a className="btn btn-secondary" href={sent.whatsappUrl} target="_blank" rel="noopener noreferrer">{tr('Open WhatsApp again')}</a>
        </div>
      )}
      <div className="pu-acts">
        {editable && <button type="button" className="btn btn-secondary" onClick={save}>{tr('Save draft')}</button>}
        {(editable || o.status === 'sent') && <button type="button" className="btn pu-wa" onClick={() => send('whatsapp')}>💬 {o.status === 'sent' ? tr('Send again on WhatsApp') : tr('Send on WhatsApp')}</button>}
        {(editable || o.status === 'sent') && emailOn && (sup || o.supplier).email && <button type="button" className="btn btn-secondary" onClick={() => send('email')}>✉️ {tr('Email it')}</button>}
        {editable && <button type="button" className="btn btn-secondary" onClick={() => send('other')} title={tr('Sent another way: by phone or by hand')}>{tr('Mark as sent')}</button>}
        {(o.status === 'sent' || editable) && !receiving && <button type="button" className="btn btn-primary" onClick={() => setReceiving(true)}>📥 {tr('It came')}</button>}
        {receiving && <button type="button" className="btn btn-primary" onClick={receive}>✅ {tr('Into the stock · {amount}', { amount: money(total) })}</button>}
        {(editable || o.status === 'sent') && <button type="button" className="pos-link is-bad" onClick={async () => { if (window.confirm(tr('Cancel {ref}?', { ref: o.ref }))) { await call({ action: 'cancel', id: o.id }, tr('{ref} cancelled.', { ref: o.ref })); onDone(); } }}>{tr('Cancel the order')}</button>}
      </div>
    </div>
  );
}

function Suppliers({ data, call }) {
  const [edit, setEdit] = useState(null);
  async function save(e) {
    e.preventDefault();
    const d = await call({ action: 'saveSupplier', supplier: edit }, tr('{name} saved.', { name: edit.name }));
    if (d) setEdit(null);
  }
  const by = useMemo(() => {
    const m = new Map();
    data.items.forEach((x) => { if (x.supplierId) m.set(x.supplierId, (m.get(x.supplierId) || []).concat([x])); });
    return m;
  }, [data.items]);
  const nobody = data.items.filter((x) => !x.supplierId);
  return (
    <div className="pu-sups">
      <div className="pu-sup-grid">
        {data.suppliers.map((s) => (
          <div key={s.id} className={'pu-sup' + (s.active ? '' : ' is-off')}>
            <span className="pu-sup-av" aria-hidden="true">{s.name.replace(/^zq\w*\s+/i, '').slice(0, 1).toUpperCase()}</span>
            <div className="pu-sup-main">
              <b>{s.name}</b>
              <small>{[s.phone, s.email].filter(Boolean).join(' · ') || tr('No phone or email yet')}</small>
              <small>{(by.get(s.id) || []).map((x) => x.name).join(', ') || tr('Nothing bought from them yet')}</small>
            </div>
            <button type="button" className="pos-link" onClick={() => setEdit({ ...s })}>{tr('Change')}</button>
          </div>
        ))}
        <button type="button" className="pu-sup is-new" onClick={() => setEdit({ name: '', phone: '', email: '', note: '' })}>＋ {tr('Add a supplier')}</button>
      </div>
      {edit && (
        <form className="pu-sup-form" onSubmit={save}>
          <div className="pu-row">
            <div className="field pu-grow"><label htmlFor="pu-sn">{tr('Name')}</label><input id="pu-sn" className="input" required maxLength={80} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
            <div className="field"><label htmlFor="pu-sp">{tr('WhatsApp or phone')}</label><input id="pu-sp" className="input" maxLength={30} inputMode="tel" value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></div>
            <div className="field pu-grow"><label htmlFor="pu-se">{tr('Email')}</label><input id="pu-se" className="input" type="email" maxLength={120} value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></div>
          </div>
          <div className="pu-acts">
            {edit.id && <button type="button" className="pos-link is-bad" onClick={async () => { if (window.confirm(tr('Remove {name}? Past orders keep their name.', { name: edit.name }))) { await call({ action: 'removeSupplier', id: edit.id }, tr('{name} removed.', { name: edit.name })); setEdit(null); } }}>{tr('Remove')}</button>}
            <button type="button" className="btn btn-secondary" onClick={() => setEdit(null)}>{tr('Cancel')}</button>
            <button type="submit" className="btn btn-primary">{tr('Save supplier')}</button>
          </div>
        </form>
      )}
      {nobody.length > 0 && data.suppliers.length > 0 && (
        <div className="pu-who">
          <strong>{tr('Who is each bought from?')}</strong>
          <ul>
            {nobody.slice(0, 30).map((x) => (
              <li key={x.type + x.id}>
                <span>{TYPE_ICON[x.type]} {x.name}</span>
                <select className="input" value="" onChange={(e) => call({ action: 'setSupplier', type: x.type, id: x.id, supplierId: e.target.value })} aria-label={tr('Supplier of {name}', { name: x.name })}>
                  <option value="">{tr('Pick…')}</option>
                  {data.suppliers.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function PurchasingTab({ token, pin, onFail }) {
  const [data, setData] = useState(null);
  const [view, setView] = useState('low');
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const call = useCallback(async (body, said) => {
    setBusy(true);
    try {
      const d = await posFetch('POST', '/pos/settings/purchasing', token, { managerPin: pin || undefined, ...body });
      setData(d);
      if (said) setFlash(said);
      return d;
    } catch (err) { onFail(err); return null; } finally { setBusy(false); }
  }, [token, pin, onFail]);
  useEffect(() => { call({ action: 'list' }); }, [call]);
  if (!data) return <section className="ts-sec"><p className="dk-muted">{tr('Loading…')}</p></section>;
  const live = data.orders.filter((o) => o.status === 'draft' || o.status === 'sent');
  async function draftLow() {
    const d = await call({ action: 'draftLow' });
    if (d && d.done) { setFlash(tr('{n} draft orders made: check them and send them.', { n: d.done.orders.length })); setView('orders'); setOpen(d.done.orders[0] ? d.done.orders[0].id : null); }
  }
  async function newOrder() {
    const first = data.low[0] || data.items[0];
    if (!first) return;
    const d = await call({ action: 'draft', order: { lines: [{ type: first.type, id: first.id, qty: first.suggest || 1 }] } });
    if (d && d.done) { setView('orders'); setOpen(d.done.order.id); }
  }
  return (
    <section className="ts-sec pu">
      <div className="pu-hero">
        <div className="pu-hero-stat"><b>{data.low.length}</b><span>{tr('running low')}</span></div>
        <div className="pu-hero-stat"><b>{data.low.filter((x) => x.out).length}</b><span>{tr('run out')}</span></div>
        <div className="pu-hero-stat"><b>{data.orders.filter((o) => o.status === 'sent').length}</b><span>{tr('on order')}</span></div>
        <div className="pu-hero-stat"><b>{money(data.orders.filter((o) => o.status === 'sent').reduce((a, o) => a + o.total, 0))}</b><span>{tr('to pay when it comes')}</span></div>
      </div>
      <div className="dk-segment" role="tablist">
        <button type="button" role="tab" aria-selected={view === 'low'} className={view === 'low' ? 'is-on' : ''} onClick={() => setView('low')}>⚠ {tr('Low stock')} {data.low.length}</button>
        <button type="button" role="tab" aria-selected={view === 'orders'} className={view === 'orders' ? 'is-on' : ''} onClick={() => setView('orders')}>📨 {tr('Purchase orders')} {live.length}</button>
        <button type="button" role="tab" aria-selected={view === 'suppliers'} className={view === 'suppliers' ? 'is-on' : ''} onClick={() => setView('suppliers')}>🤝 {tr('Suppliers')} {data.suppliers.length}</button>
      </div>
      {flash && <div className="ts-flash" role="status"><Icon name="check" />{flash}</div>}
      {view === 'low' && <LowList low={data.low} busy={busy} onDraft={draftLow} />}
      {view === 'orders' && (
        <div className="pu-pos">
          <div className="pu-row"><button type="button" className="btn btn-secondary" disabled={busy} onClick={newOrder}>＋ {tr('A new order')}</button></div>
          {!data.orders.length && <div className="dk-empty"><Icon name="info" /><p>{tr('No purchase orders yet. Draft them from the low stock, or make one.')}</p></div>}
          {data.orders.map((o, k) => (
            <div key={o.id} className="pu-po-item">
              <OrderCard o={o} k={k} open={open === o.id} onOpen={() => setOpen(open === o.id ? null : o.id)} />
              {open === o.id && <OrderEditor key={o.id + o.status + o.total} o={o} data={data} call={call} emailOn={data.emailOn} onDone={() => setOpen(null)} />}
            </div>
          ))}
        </div>
      )}
      {view === 'suppliers' && <Suppliers data={data} call={call} />}
    </section>
  );
}
