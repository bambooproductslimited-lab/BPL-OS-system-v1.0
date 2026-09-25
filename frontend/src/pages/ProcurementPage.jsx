import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import Photo from '../components/Photo';
import RowMenu from '../components/RowMenu';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { Glossary, Hero, Insights, Section, Status, fmtDate, jump } from '../components/DashKit';
import { money } from '../lib/currency';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './EmployeesPage.css';
import './ProcurementPage.css';

// Purchase requests. Same "explains itself" layout as the dashboards
// (components/DashKit.jsx): the key numbers (waiting for a decision,
// approved but not ordered, on order, spent this month), what stands out
// (requests waiting too long, needed-by dates passed, orders that cost more
// than estimated), then the requests with where each one is: asked →
// approved → ordered → received (procurement.service.js, migration 0086).
// Approvers decide with a note; whoever buys records the order and the
// delivery; the requester can cancel while it waits.

const STEPS = [
  { key: 'pending', label: msg('Asked') },
  { key: 'approved', label: msg('Approved') },
  { key: 'ordered', label: msg('Ordered') },
  { key: 'received', label: msg('Received') }
];
const STATUS_TEXT = {
  pending: msg('Waiting for a decision'), approved: msg('Approved, not ordered yet'), ordered: msg('On order'),
  received: msg('Received'), rejected: msg('Rejected'), cancelled: msg('Cancelled')
};
const PRIORITY = { high: msg('High'), medium: msg('Medium'), low: msg('Low') };
const EMPTY_FORM = { item: '', quantity: '1', estimatedPrice: '', requiredDate: '', priority: 'medium', reason: '' };

function daysSince(iso) {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}
function daysUntil(iso) {
  if (!iso) return null;
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((new Date(String(iso).slice(0, 10) + 'T00:00') - t) / 86400000);
}
function statusTone(s) { return s === 'received' ? 'good' : s === 'rejected' ? 'bad' : s === 'cancelled' ? 'muted' : s === 'pending' ? 'warn' : 'info'; }
function cost(r) { return r.actualCost !== null && r.actualCost !== undefined ? r.actualCost : r.estimatedPrice; }

function Steps({ r }) {
  if (r.status === 'rejected' || r.status === 'cancelled') return <Status tone={statusTone(r.status)}>{tr(STATUS_TEXT[r.status])}</Status>;
  // Received is the end: every step is done, none is still to come.
  const at = r.status === 'received' ? STEPS.length : STEPS.findIndex((s) => s.key === r.status);
  return (
    <ol className="pc-steps" aria-label={tr(STATUS_TEXT[r.status])}>
      {STEPS.map((s, i) => <li key={s.key} className={i < at ? 'is-done' : i === at ? 'is-now' : ''}><span aria-hidden="true" />{tr(s.label)}</li>)}
    </ol>
  );
}

export default function ProcurementPage() {
  const { session, can } = useAuth();
  const employeeId = session && session.employee && session.employee.id;
  const canRequest = can('procurement.request');
  const canApprove = can('procurement.approve');

  const [requests, setRequests] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [chip, setChip] = useState(canApprove ? 'open' : 'mine');
  const [search, setSearch] = useState('');

  const [newOpen, setNewOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [act, setAct] = useState(null); // { r, kind: 'approved'|'rejected'|'order'|'receive'|'cancel', note, supplierId, supplierName, actualCost }
  const [detail, setDetail] = useState(null);
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try { setRequests(await api.get('/procurement')); } catch (err) { setError(err.message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (canApprove) api.get('/suppliers').then(setSuppliers).catch(() => {}); }, [canApprove]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  function openNew() { setFormError(null); setForm(EMPTY_FORM); setNewOpen(true); }
  async function submitNew(e) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      await api.post('/procurement', form);
      setToast(tr('Purchase request submitted.'));
      setNewOpen(false);
      setChip('mine');
      await load();
    } catch (err) { setFormError(err.message); } finally { setSaving(false); }
  }
  function openAct(r, kind) {
    setFormError(null);
    setDetail(null);
    setAct({ r, kind, note: '', supplierId: r.supplierId || '', supplierName: '', actualCost: r.actualCost !== null && r.actualCost !== undefined ? String(r.actualCost) : String(r.estimatedPrice || '') });
  }
  async function submitAct(e) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    const { r, kind } = act;
    try {
      if (kind === 'approved' || kind === 'rejected') {
        await api.post('/procurement/' + r.id + '/decision', { decision: kind, note: act.note });
        setToast(kind === 'approved' ? tr('Request approved.') : tr('Request rejected.'));
      } else if (kind === 'order') {
        await api.post('/procurement/' + r.id + '/order', { supplierId: act.supplierId || null, supplierName: act.supplierId ? '' : act.supplierName, actualCost: act.actualCost });
        setToast(tr('{item} marked as ordered.', { item: r.item }));
      } else if (kind === 'receive') {
        await api.post('/procurement/' + r.id + '/receive', { actualCost: act.actualCost });
        setToast(tr('{item} marked as received.', { item: r.item }));
      } else if (kind === 'cancel') {
        await api.post('/procurement/' + r.id + '/cancel');
        setToast(tr('Request cancelled.'));
      }
      setAct(null);
      await load();
    } catch (err) { setFormError(err.message); } finally { setSaving(false); }
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const monthKey = new Date().toISOString().slice(0, 7);
  const pending = requests.filter((r) => r.status === 'pending');
  const toDecide = pending.filter((r) => r.requesterId !== employeeId);
  const approved = requests.filter((r) => r.status === 'approved');
  const ordered = requests.filter((r) => r.status === 'ordered');
  const receivedMonth = requests.filter((r) => r.status === 'received' && String(r.receivedAt).slice(0, 7) === monthKey);
  const spent = receivedMonth.reduce((s, r) => s + cost(r), 0);
  const estimated = receivedMonth.reduce((s, r) => s + r.estimatedPrice, 0);
  const late = requests.filter((r) => ['pending', 'approved', 'ordered'].includes(r.status) && r.requiredDate && daysUntil(r.requiredDate) < 0);
  const slow = toDecide.filter((r) => daysSince(r.createdAt) >= 3).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const stale = approved.filter((r) => daysSince(r.decidedAt) >= 7);
  const over = requests.filter((r) => r.actualCost !== null && r.estimatedPrice > 0 && r.actualCost > r.estimatedPrice * 1.2);
  const mine = requests.filter((r) => r.mine);

  function showOnly(key) { setChip(chip === key ? 'all' : key); jump('pc-list'); }
  const stats = canApprove ? [
    { icon: 'clock', value: String(toDecide.length), label: tr('waiting for your decision'), note: toDecide.length ? tr('worth {amount}', { amount: money(toDecide.reduce((s, r) => s + r.estimatedPrice, 0)) }) : tr('nothing waiting'), tone: toDecide.length ? 'alert' : 'good', onClick: () => showOnly('pending') },
    { icon: 'check', value: String(approved.length), label: tr('approved, not ordered'), note: approved.length ? tr('worth {amount}', { amount: money(approved.reduce((s, r) => s + r.estimatedPrice, 0)) }) : tr('all ordered'), onClick: () => showOnly('approved') },
    { icon: 'bag', value: String(ordered.length), label: tr('on order'), note: late.length ? tr('{n} past the date needed', { n: late.length }) : tr('waiting to arrive'), tone: late.length ? 'alert' : '', onClick: () => showOnly('ordered') },
    { icon: 'cash', value: money(spent), label: tr('received this month'), note: estimated ? (spent > estimated ? tr('{amount} over the estimates', { amount: money(spent - estimated) }) : tr('{amount} under the estimates', { amount: money(estimated - spent) })) : tr('{n} items', { n: receivedMonth.length }), onClick: () => showOnly('received') }
  ] : [
    { icon: 'doc', value: String(mine.length), label: tr('my requests'), note: tr('{n} this month', { n: mine.filter((r) => String(r.createdAt).slice(0, 7) === monthKey).length }), onClick: () => showOnly('mine') },
    { icon: 'clock', value: String(mine.filter((r) => r.status === 'pending').length), label: tr('waiting for a decision'), note: tr('your manager is notified'), onClick: () => showOnly('pending') },
    { icon: 'check', value: String(mine.filter((r) => ['approved', 'ordered'].includes(r.status)).length), label: tr('approved or on order'), note: tr('you are told when it arrives'), onClick: () => showOnly('approved') },
    { icon: 'bag', value: String(mine.filter((r) => r.status === 'received').length), label: tr('received'), note: tr('all time'), onClick: () => showOnly('received') }
  ];

  const insights = [];
  if (canApprove && slow.length) insights.push({ tone: 'warn', icon: 'clock', text: slow.length === 1 ? tr('{name} has waited {d} days for a decision on {item}.', { name: slow[0].requesterName, d: daysSince(slow[0].createdAt), item: slow[0].item }) : tr('{n} requests have waited 3 days or more for a decision.', { n: slow.length }), action: { label: tr('Show them'), run: () => showOnly('pending') } });
  const urgent = toDecide.filter((r) => r.priority === 'high');
  if (canApprove && urgent.length) insights.push({ tone: 'bad', icon: 'warn', text: urgent.length === 1 ? tr('{item} is high priority and waiting for a decision.', { item: urgent[0].item }) : tr('{n} high-priority requests are waiting for a decision.', { n: urgent.length }), action: { label: tr('Show them'), run: () => showOnly('pending') } });
  if (late.length) insights.push({ tone: 'warn', icon: 'calendar', text: late.length === 1 ? tr('{item} was needed by {date} and has not arrived.', { item: late[0].item, date: fmtDate(late[0].requiredDate) }) : tr('{n} requests are past the date they were needed and have not arrived.', { n: late.length }), action: { label: tr('Show them'), run: () => showOnly('late') } });
  if (canApprove && stale.length) insights.push({ tone: 'info', icon: 'bag', text: tr('{n} approved requests have not been ordered for a week or more.', { n: stale.length }), action: { label: tr('Show them'), run: () => showOnly('approved') } });
  if (over.length) insights.push({ tone: 'info', icon: 'cash', text: over.length === 1 ? tr('{item} cost {actual}, more than the {est} estimated.', { item: over[0].item, actual: money(over[0].actualCost), est: money(over[0].estimatedPrice) }) : tr('{n} purchases cost more than 20% over their estimate.', { n: over.length }) });
  if (!insights.length && requests.length) insights.push({ tone: 'good', icon: 'check', text: tr('Nothing is waiting too long and nothing is late.') });

  const chipTest = {
    open: (r) => ['pending', 'approved', 'ordered'].includes(r.status),
    pending: (r) => r.status === 'pending',
    approved: (r) => r.status === 'approved',
    ordered: (r) => r.status === 'ordered',
    received: (r) => r.status === 'received',
    late: (r) => late.includes(r),
    closed: (r) => r.status === 'rejected' || r.status === 'cancelled',
    mine: (r) => r.mine,
    all: () => true
  };
  const visible = requests.filter(chipTest[chip] || chipTest.all)
    .filter((r) => matchesQuery(search, r.item, r.requesterName, r.departmentName, r.reason, r.supplierName));
  const chips = [
    canApprove && ['open', tr('Open'), requests.filter(chipTest.open).length],
    ['pending', tr('Waiting for a decision'), pending.length],
    ['approved', tr('Approved'), approved.length],
    ['ordered', tr('On order'), ordered.length],
    ['late', tr('Past the date needed'), late.length],
    ['received', tr('Received'), requests.filter(chipTest.received).length],
    ['closed', tr('Rejected or cancelled'), requests.filter(chipTest.closed).length],
    canApprove && ['mine', tr('Mine'), mine.length],
    ['all', tr('All'), requests.length]
  ].filter(Boolean).filter(([k, , c]) => c > 0 || k === 'all' || k === chip);

  function actionsFor(r) {
    const decider = canApprove && r.status === 'pending' && r.requesterId !== employeeId;
    return [
      { label: tr('Open'), onClick: () => setDetail(r) },
      decider && { label: tr('Approve'), onClick: () => openAct(r, 'approved') },
      decider && { label: tr('Reject'), onClick: () => openAct(r, 'rejected'), danger: true },
      canApprove && r.status === 'approved' && { label: tr('Mark ordered'), onClick: () => openAct(r, 'order') },
      canApprove && (r.status === 'ordered' || r.status === 'approved') && { label: tr('Mark received'), onClick: () => openAct(r, 'receive') },
      r.status === 'pending' && (r.mine || canApprove) && { label: tr('Cancel request'), onClick: () => openAct(r, 'cancel'), danger: true }
    ].filter(Boolean);
  }
  function mainAction(r) {
    const decider = canApprove && r.status === 'pending' && r.requesterId !== employeeId;
    if (decider) return <><button type="button" className="btn btn-secondary pc-btn" onClick={() => openAct(r, 'rejected')}>{tr('Reject')}</button><button type="button" className="btn btn-primary pc-btn" onClick={() => openAct(r, 'approved')}>{tr('Approve')}</button></>;
    if (canApprove && r.status === 'approved') return <button type="button" className="btn btn-primary pc-btn" onClick={() => openAct(r, 'order')}>{tr('Mark ordered')}</button>;
    if (canApprove && r.status === 'ordered') return <button type="button" className="btn btn-primary pc-btn" onClick={() => openAct(r, 'receive')}>{tr('Mark received')}</button>;
    return null;
  }

  const actTitle = act && ({ approved: tr('Approve {item}', { item: act.r.item }), rejected: tr('Reject {item}', { item: act.r.item }), order: tr('Order {item}', { item: act.r.item }), receive: tr('{item} has arrived', { item: act.r.item }), cancel: tr('Cancel the request for {item}?', { item: act.r.item }) })[act.kind];

  return (
    <div className="dk pc">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <Hero
        eyebrow={new Date().toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        title={tr('Procurement')}
        sub={canApprove
          ? tr('Purchase requests from across the company and where each one is: asked, approved, ordered, received. Decide with a note, then record the order and the delivery. Press a number to show only those.')
          : tr('Ask for something to be bought and follow it: approved, ordered, received. You get a notification at each step.')}
        actions={canRequest && <button type="button" className="btn btn-primary" onClick={openNew}>{tr('Request a purchase')}</button>}
        stats={stats} />

      <Insights items={insights.slice(0, 5)} />

      <Section id="pc-list" title={tr('Requests')} sub={tr('Newest first. Press a request for the whole story.')}>
        <div className="pc-tools">
          <div className="pc-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search item, requester, group…')} /></div>
        </div>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {chips.map(([key, label, c]) => (
            <button key={key} type="button" role="radio" aria-checked={chip === key} className={'ppl-chip' + (chip === key ? ' is-on' : '')} onClick={() => setChip(key)}>
              {label} <span className="ppl-chip-n">{c}</span>
            </button>
          ))}
        </div>
        {visible.length ? (
          <ul className="pc-list">
            {visible.map((r) => {
              const due = daysUntil(r.requiredDate);
              const open = ['pending', 'approved', 'ordered'].includes(r.status);
              return (
                <li key={r.id} className={'pc-row is-' + r.status + (open && due !== null && due < 0 ? ' is-late' : '')}>
                  <button type="button" className="pc-open" onClick={() => setDetail(r)}>
                    <Photo id={r.requesterId} name={r.requesterName} photo={r.requesterPhoto} size={36} />
                    <span className="pc-main">
                      <span className="pc-title">{r.item} <span className="dk-muted">× {r.quantity}</span></span>
                      <span className="dk-muted pc-sub">{r.requesterName} · {r.departmentName}{r.companyCode ? ' · ' + r.companyCode : ''} · {fmtDate(String(r.createdAt).slice(0, 10))}</span>
                    </span>
                  </button>
                  <span className="pc-money">
                    <strong>{money(cost(r))}</strong>
                    <span className="dk-muted pc-sub">{r.actualCost !== null && r.actualCost !== undefined ? tr('estimated {amount}', { amount: money(r.estimatedPrice) }) : tr('estimate')}</span>
                  </span>
                  <span className="pc-when">
                    {r.priority === 'high' && open && <Status tone="bad">{tr('High priority')}</Status>}
                    {r.requiredDate && open && <span className={'pc-due' + (due < 0 ? ' is-late' : due <= 3 ? ' is-soon' : '')}>{due < 0 ? tr('needed {n} days ago', { n: -due }) : due === 0 ? tr('needed today') : tr('needed by {date}', { date: fmtDate(r.requiredDate) })}</span>}
                  </span>
                  <span className="pc-state"><Steps r={r} /></span>
                  <span className="pc-acts">
                    {mainAction(r)}
                    <RowMenu actions={actionsFor(r)} />
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="dk-empty pc-empty">
            <p>{requests.length ? tr('Nothing here. Try another filter.') : tr('No purchase requests yet.')}</p>
            {canRequest && !requests.length && <button type="button" className="btn btn-primary" onClick={openNew}>{tr('Request a purchase')}</button>}
          </div>
        )}
      </Section>

      <Glossary items={[
        [tr('Asked'), tr('Someone asked for it to be bought. Their manager and anyone who approves purchases can decide.')],
        [tr('Approved'), tr('Agreed, with an optional note. The next step is ordering it.')],
        [tr('Ordered'), tr('Bought or ordered from a supplier, with what it really cost.')],
        [tr('Received'), tr('It has arrived. The requester is told at each step.')],
        [tr('Estimate'), tr('What the requester expected it to cost, for all of the quantity.')]
      ]} />

      {/* ── a new request ── */}
      {newOpen && (
        <div className="dialog-backdrop" onClick={() => !saving && setNewOpen(false)}>
          <form className="dialog pc-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitNew}>
            <h2>{tr('Request a purchase')}</h2>
            <div className="pc-form">
              <div className="field pc-span">
                <label htmlFor="pc-item">{tr('What is needed')}</label>
                <input id="pc-item" className="input" maxLength={100} value={form.item} onChange={(e) => setForm({ ...form, item: e.target.value })} placeholder={tr('e.g. 10-inch saw blades')} required autoFocus />
              </div>
              <div className="field">
                <label htmlFor="pc-qty">{tr('Quantity')}</label>
                <input id="pc-qty" className="input" type="number" min="1" step="any" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} required />
              </div>
              <div className="field">
                <label htmlFor="pc-price">{tr('Estimated cost, in all (GHS)')}</label>
                <input id="pc-price" className="input" type="number" min="0" step="any" value={form.estimatedPrice} onChange={(e) => setForm({ ...form, estimatedPrice: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="pc-date">{tr('Needed by')}</label>
                <input id="pc-date" className="input" type="date" value={form.requiredDate} onChange={(e) => setForm({ ...form, requiredDate: e.target.value })} />
              </div>
              <div className="field">
                <span className="pc-label">{tr('Priority')}</span>
                <div className="pc-priority" role="radiogroup" aria-label={tr('Priority')}>
                  {['low', 'medium', 'high'].map((p) => (
                    <button key={p} type="button" role="radio" aria-checked={form.priority === p} className={'pc-prio is-' + p + (form.priority === p ? ' is-on' : '')} onClick={() => setForm({ ...form, priority: p })}>{tr(PRIORITY[p])}</button>
                  ))}
                </div>
              </div>
              <div className="field pc-span">
                <label htmlFor="pc-reason">{tr('Why is it needed?')}</label>
                <textarea id="pc-reason" className="input pc-textarea" maxLength={300} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} required />
              </div>
            </div>
            <p className="dk-muted pc-small">{tr('Your manager is notified, and you are told when it is decided, ordered and received.')}</p>
            {formError && <div className="error-banner">{formError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setNewOpen(false)} disabled={saving}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : tr('Submit')}</button>
            </div>
          </form>
        </div>
      )}

      {/* ── decide / order / receive / cancel ── */}
      {act && (
        <div className="dialog-backdrop" onClick={() => !saving && setAct(null)}>
          <form className="dialog pc-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitAct}>
            <h2>{actTitle}</h2>
            <p className="dk-muted pc-small">{tr('{name} asked for {qty} on {date}: {reason}', { name: act.r.requesterName, qty: act.r.quantity, date: fmtDate(String(act.r.createdAt).slice(0, 10)), reason: act.r.reason })}</p>
            {(act.kind === 'approved' || act.kind === 'rejected') && (
              <div className="field">
                <label htmlFor="pc-note">{act.kind === 'rejected' ? tr('Why not? (the requester sees this)') : tr('Note for the requester (optional)')}</label>
                <textarea id="pc-note" className="input pc-textarea" maxLength={300} value={act.note} onChange={(e) => setAct({ ...act, note: e.target.value })} required={act.kind === 'rejected'} autoFocus />
              </div>
            )}
            {act.kind === 'order' && (
              <div className="pc-form">
                <div className="field pc-span">
                  <label htmlFor="pc-sup">{tr('Supplier')}</label>
                  <select id="pc-sup" className="input" value={act.supplierId} onChange={(e) => setAct({ ...act, supplierId: e.target.value })}>
                    <option value="">{tr('Someone else (type below)')}</option>
                    {suppliers.filter((s) => s.status === 'active').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
                {!act.supplierId && (
                  <div className="field pc-span">
                    <label htmlFor="pc-supname">{tr('Bought from')}</label>
                    <input id="pc-supname" className="input" maxLength={120} value={act.supplierName} onChange={(e) => setAct({ ...act, supplierName: e.target.value })} placeholder={tr('e.g. Kaneshie market')} />
                  </div>
                )}
                <div className="field">
                  <label htmlFor="pc-cost">{tr('What it cost, in all (GHS)')}</label>
                  <input id="pc-cost" className="input" type="number" min="0" step="any" value={act.actualCost} onChange={(e) => setAct({ ...act, actualCost: e.target.value })} />
                  <span className="dk-muted pc-small">{tr('Estimated {amount}', { amount: money(act.r.estimatedPrice) })}</span>
                </div>
              </div>
            )}
            {act.kind === 'receive' && (
              <div className="field">
                <label htmlFor="pc-cost2">{tr('What it cost, in all (GHS)')}</label>
                <input id="pc-cost2" className="input" type="number" min="0" step="any" value={act.actualCost} onChange={(e) => setAct({ ...act, actualCost: e.target.value })} />
                <span className="dk-muted pc-small">{tr('Change it if the invoice differed.')}</span>
              </div>
            )}
            {act.kind === 'cancel' && <p className="dialog-body">{tr('It is taken off the approval list. You can ask again later.')}</p>}
            {formError && <div className="error-banner">{formError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setAct(null)} disabled={saving}>{act.kind === 'cancel' ? tr('Keep it') : tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? tr('Saving…') : ({ approved: tr('Approve'), rejected: tr('Reject'), order: tr('Mark ordered'), receive: tr('Mark received'), cancel: tr('Cancel request') })[act.kind]}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── one request ── */}
      {detail && (
        <div className="dialog-backdrop" onClick={() => setDetail(null)}>
          <div className="dialog pc-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="pc-detail-head">
              <div>
                <h2>{detail.item} <span className="dk-muted">× {detail.quantity}</span></h2>
                <Steps r={detail} />
              </div>
              <button type="button" className="pc-close" onClick={() => setDetail(null)} aria-label={tr('Close')}>×</button>
            </div>
            <ol className="pc-timeline">
              <li>
                <Photo id={detail.requesterId} name={detail.requesterName} photo={detail.requesterPhoto} size={30} />
                <div><strong>{tr('{name} asked', { name: detail.requesterName })}</strong><span className="dk-muted">{fmtDate(String(detail.createdAt).slice(0, 10))} · {detail.departmentName} · {tr(PRIORITY[detail.priority])}</span><p>{detail.reason}</p></div>
              </li>
              {detail.decidedAt && (
                <li className={detail.status === 'rejected' ? 'is-bad' : detail.status === 'cancelled' ? 'is-muted' : 'is-good'}>
                  <span className="pc-dot" aria-hidden="true" />
                  <div><strong>{detail.status === 'rejected' ? tr('Rejected by {name}', { name: detail.deciderName || '—' }) : detail.status === 'cancelled' ? tr('Cancelled') : tr('Approved by {name}', { name: detail.deciderName || '—' })}</strong><span className="dk-muted">{fmtDate(String(detail.decidedAt).slice(0, 10))}</span>{detail.decisionNote && <p>{detail.decisionNote}</p>}</div>
                </li>
              )}
              {detail.orderedAt && (
                <li className="is-good">
                  <span className="pc-dot" aria-hidden="true" />
                  <div><strong>{tr('Ordered by {name}', { name: detail.orderedByName || '—' })}</strong><span className="dk-muted">{fmtDate(String(detail.orderedAt).slice(0, 10))}{detail.supplierName ? ' · ' + detail.supplierName : ''}{detail.actualCost !== null ? ' · ' + money(detail.actualCost) : ''}</span></div>
                </li>
              )}
              {detail.receivedAt && (
                <li className="is-good">
                  <span className="pc-dot" aria-hidden="true" />
                  <div><strong>{tr('Received, checked by {name}', { name: detail.receivedByName || '—' })}</strong><span className="dk-muted">{fmtDate(String(detail.receivedAt).slice(0, 10))}</span></div>
                </li>
              )}
            </ol>
            <dl className="pc-facts">
              <div><dt>{tr('Estimated')}</dt><dd>{money(detail.estimatedPrice)}</dd></div>
              {detail.actualCost !== null && <div><dt>{tr('Actual cost')}</dt><dd>{money(detail.actualCost)}</dd></div>}
              <div><dt>{tr('Needed by')}</dt><dd>{detail.requiredDate ? fmtDate(detail.requiredDate) : '—'}</dd></div>
            </dl>
            <div className="dialog-actions">
              {mainAction(detail)}
              {!mainAction(detail) && <button type="button" className="btn btn-primary" onClick={() => setDetail(null)}>{tr('Close')}</button>}
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
