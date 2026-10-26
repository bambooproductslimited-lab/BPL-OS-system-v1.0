import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { api, API_URL } from '../api/client';
import { money } from '../lib/currency';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import { shrinkPhoto } from './till/photoShrink';
import './BillsPage.css';

// Bills to pay (Finance → Bills to pay; backend bills.service, migration
// 0196): what Bamboo Products and the restaurants owe their suppliers —
// entered here or on a restaurant's till, or made by themselves when a
// purchase order is received and not paid at the door. Over the limit they
// wait for someone who approves; then paid, all at once or in parts, with
// the transfer slip. Overdue first, then this week, then later.

const CATEGORY = {
  stock: ['📦', msg('Stock and food')], utilities: ['💡', msg('Power, water, gas')], rent: ['🏠', msg('Rent')], services: ['🧰', msg('Services')],
  equipment: ['🛠️', msg('Equipment and repairs')], transport: ['🚚', msg('Transport')], staff: ['👥', msg('Staff costs')], other: ['🧾', msg('Other')]
};
const METHOD = { bank: ['🏦', msg('Bank transfer')], mobile_money: ['📱', msg('Mobile Money')], cash: ['💵', msg('Cash')], cheque: ['✍️', msg('Cheque')] };
const STATE = {
  overdue: ['⏰', msg('Overdue')], today: ['🔔', msg('Due today')], soon: ['📅', msg('This week')], later: ['🗓️', msg('Later')], paid: ['✅', msg('Paid')], cancelled: ['✕', msg('Cancelled')]
};
const SOURCE = { office: msg('Entered in the office'), till: msg('Entered on the till'), purchase_order: msg('From a purchase order received') };
function addDays(day, n) { return new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
function dayText(day) { return day ? new Date(day + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—'; }
function hue(name) { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function dueWords(b) {
  if (b.status === 'paid') return tr('Paid');
  if (b.status === 'cancelled') return tr('Cancelled');
  if (b.daysLeft < 0) return b.daysLeft === -1 ? tr('1 day late') : tr('{n} days late', { n: -b.daysLeft });
  if (b.daysLeft === 0) return tr('Due today');
  return b.daysLeft === 1 ? tr('Due tomorrow') : tr('Due in {n} days', { n: b.daysLeft });
}

// A file the API keeps behind the sign-in: a photo opens big, a PDF in a
// new tab.
function BillFile({ path, file }) {
  const [url, setUrl] = useState(null);
  const [big, setBig] = useState(false);
  useEffect(() => {
    let live = true, made = null;
    fetch(API_URL + path, { headers: api.authHeaders() }).then((r) => (r.ok ? r.blob() : null)).then((b) => { if (b && live) { made = URL.createObjectURL(b); setUrl(made); } }).catch(() => {});
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [path]);
  const isPdf = file.type === 'application/pdf';
  if (!url) return <span className="bl-file is-empty" aria-hidden="true">{isPdf ? '📄' : '📷'}</span>;
  if (isPdf) return <a className="bl-file is-pdf" href={url} target="_blank" rel="noreferrer" title={file.name}><b>PDF</b><small>{file.name}</small></a>;
  return (
    <>
      <button type="button" className="bl-file" onClick={() => setBig(true)} aria-label={file.name}><img src={url} alt="" /></button>
      {big && createPortal(<div className="bl-zoom" onClick={() => setBig(false)} role="dialog" aria-label={file.name}><img src={url} alt="" /></div>, document.body)}
    </>
  );
}

// A new bill, or one changed.
function BillDialog({ start, data, onClose, onSaved }) {
  const [v, setV] = useState(start);
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (patch) => setV((x) => ({ ...x, ...patch }));
  const suppliers = useMemo(() => {
    const seen = new Set();
    return data.suppliers.filter((s) => (!s.companyId || s.companyId === v.companyId) && !seen.has(s.name) && seen.add(s.name)).map((s) => s.name);
  }, [data.suppliers, v.companyId]);
  const over = Number(v.amount) > data.settings.approveOver && !data.canApprove;
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      let bill = await api.post('/bills', { ...v, amount: Number(v.amount) });
      if (files.length) {
        const fd = new FormData();
        files.forEach((f) => fd.append('files', f));
        bill = await api.upload('/bills/' + bill.id + '/files', fd);
      }
      onSaved(bill);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog bl-dlg" role="dialog" aria-modal="true" aria-labelledby="bl-new-title" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="bl-dlg-head">
          <span className="bl-dlg-art" aria-hidden="true">{CATEGORY[v.category][0]}</span>
          <div><h2 id="bl-new-title">{v.id ? tr('Change the bill') : tr('A bill to pay')}</h2><p>{tr('From a supplier: what it is, how much, and when it is due.')}</p></div>
        </div>
        <div className="bl-grid">
          <label><span>{tr('Who owes it')}</span>
            <select className="input" value={v.companyId} onChange={(e) => set({ companyId: e.target.value })} required>
              {data.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label><span>{tr('Supplier')}</span>
            <input className="input" list="bl-suppliers" required minLength={2} maxLength={120} value={v.supplierName} onChange={(e) => set({ supplierName: e.target.value })} placeholder={tr('Who sent the bill')} />
            <datalist id="bl-suppliers">{suppliers.map((s) => <option key={s} value={s} />)}</datalist>
          </label>
        </div>
        <div className="bl-cats" role="radiogroup" aria-label={tr('What for')}>
          {data.categories.map((c) => <button key={c} type="button" role="radio" aria-checked={v.category === c} className={v.category === c ? 'is-on' : ''} onClick={() => set({ category: c })}><em aria-hidden="true">{CATEGORY[c][0]}</em>{tr(CATEGORY[c][1])}</button>)}
        </div>
        <div className="bl-grid bl-grid-4">
          <label className="bl-amount"><span>{tr('Amount')}</span><input className="input" type="number" inputMode="decimal" min="0.01" step="0.01" required value={v.amount} onChange={(e) => set({ amount: e.target.value })} /></label>
          <label><span>{tr('Their invoice number')}</span><input className="input" maxLength={60} value={v.reference} onChange={(e) => set({ reference: e.target.value })} placeholder={tr('e.g. INV-2041')} /></label>
          <label><span>{tr('Bill date')}</span><input className="input" type="date" required value={v.billDate} max={data.today} onChange={(e) => set({ billDate: e.target.value })} /></label>
          <label><span>{tr('Due')}</span><input className="input" type="date" required value={v.dueDate} min={v.billDate} onChange={(e) => set({ dueDate: e.target.value })} /></label>
        </div>
        <div className="bl-due-chips">
          {[0, 7, 14, 30].map((n) => <button key={n} type="button" className={v.dueDate === addDays(v.billDate, n) ? 'is-on' : ''} onClick={() => set({ dueDate: addDays(v.billDate, n) })}>{n ? tr('{n} days', { n }) : tr('On receipt')}</button>)}
        </div>
        <label className="bl-note"><span>{tr('Note')}</span><textarea className="input" rows={2} maxLength={500} value={v.note} onChange={(e) => set({ note: e.target.value })} placeholder={tr('e.g. the October gas, two cylinders')} /></label>
        {!v.id && (
          <label className="bl-drop">
            <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple onChange={(e) => { setFiles(Array.from(e.target.files || []).slice(0, 4)); }} />
            <em aria-hidden="true">📎</em>
            <span>{files.length ? files.map((f) => f.name).join(', ') : tr('Add a photo or PDF of the bill')}</span>
          </label>
        )}
        {over && <p className="bl-hint">✍️ {tr('Over {amount}: it waits for someone who approves bills before it can be paid.', { amount: money(data.settings.approveOver) })}</p>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{v.id ? tr('Save') : tr('Add the bill')}</button>
        </div>
      </form>
    </div>
  );
}

// Paying it, all or part, with the slip.
function PayForm({ bill, data, onPaid, onCancel }) {
  const [v, setV] = useState({ amount: String(bill.balance), paidOn: data.today, method: 'bank', account: data.settings.accounts[0] || '', reference: '' });
  const [photo, setPhoto] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (patch) => setV((x) => ({ ...x, ...patch }));
  async function addPhoto(e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try { setPhoto(await shrinkPhoto(f)); } catch { setError(tr('That file is not a photo.')); }
  }
  async function pay(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onPaid(await api.post('/bills/' + bill.id + '/pay', { ...v, amount: Number(v.amount), photo: photo || undefined })); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <form className="bl-pay" onSubmit={pay}>
      <h3>💸 {tr('Pay it')}</h3>
      <div className="bl-methods" role="radiogroup" aria-label={tr('How')}>
        {data.methods.map((m) => <button key={m} type="button" role="radio" aria-checked={v.method === m} className={v.method === m ? 'is-on' : ''} onClick={() => set({ method: m })}><em aria-hidden="true">{METHOD[m][0]}</em>{tr(METHOD[m][1])}</button>)}
      </div>
      <div className="bl-grid bl-grid-4">
        <label className="bl-amount"><span>{tr('Amount')}</span><input className="input" type="number" inputMode="decimal" min="0.01" max={bill.balance} step="0.01" required value={v.amount} onChange={(e) => set({ amount: e.target.value })} /></label>
        <label><span>{tr('Paid on')}</span><input className="input" type="date" required value={v.paidOn} max={data.today} onChange={(e) => set({ paidOn: e.target.value })} /></label>
        <label><span>{tr('From which account')}</span>
          <input className="input" list="bl-accounts" maxLength={60} value={v.account} onChange={(e) => set({ account: e.target.value })} />
          <datalist id="bl-accounts">{data.settings.accounts.map((a) => <option key={a} value={a} />)}</datalist>
        </label>
        <label><span>{tr('Transfer reference')}</span><input className="input" maxLength={60} value={v.reference} onChange={(e) => set({ reference: e.target.value })} /></label>
      </div>
      <label className="bl-drop is-small">
        <input type="file" accept="image/*" capture="environment" onChange={addPhoto} />
        <em aria-hidden="true">{photo ? '✅' : '📷'}</em><span>{photo ? tr('Slip added') : tr('Photo of the slip or receipt')}</span>
      </label>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>{tr('Back')}</button>
        <button type="submit" className="btn btn-primary" disabled={busy}>{Number(v.amount) >= bill.balance ? tr('Paid in full') : tr('Record part payment')}</button>
      </div>
    </form>
  );
}

// One bill: what, files, payments; approve, pay, change, cancel.
function BillSheet({ id, data, onClose, onChanged, onEdit }) {
  const [b, setB] = useState(null);
  const [mode, setMode] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { api.get('/bills/' + id).then(setB).catch((e) => setError(e.message)); }, [id]);
  function done(next) { setB(next); setMode(''); onChanged(next); }
  async function act(path, body) {
    setBusy(true); setError(null);
    try { done(await api.post('/bills/' + b.id + path, body || {})); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function addFiles(e) {
    const list = Array.from(e.target.files || []);
    e.target.value = '';
    if (!list.length) return;
    const fd = new FormData();
    list.slice(0, 4).forEach((f) => fd.append('files', f));
    setBusy(true); setError(null);
    try { done(await api.upload('/bills/' + b.id + '/files', fd)); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  const pct = b && b.amount ? Math.min(100, Math.round(b.paid / b.amount * 100)) : 0;
  const open = b && (b.status === 'to_approve' || b.status === 'approved');
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog bl-sheet" role="dialog" aria-modal="true" aria-labelledby="bl-sheet-title" onClick={(e) => e.stopPropagation()}>
        {!b ? <p className="bl-wait">{error || tr('Loading…')}</p> : (
          <>
            <div className={'bl-sheet-hero is-' + b.state}>
              <span className="bl-avatar" style={{ '--h': hue(b.supplierName) }} aria-hidden="true">{b.supplierName.charAt(0).toUpperCase()}</span>
              <div>
                <small>{b.ref}{b.reference ? ' · ' + b.reference : ''} · {b.company.name}</small>
                <h2 id="bl-sheet-title">{b.supplierName}</h2>
                <p><b>{money(b.amount)}</b> <span className={'bl-pill is-' + b.state}>{STATE[b.state][0]} {dueWords(b)}</span>{b.status === 'to_approve' && <span className="bl-pill is-approve">✍️ {tr('To approve')}</span>}</p>
              </div>
              <button type="button" className="bl-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
            </div>
            {b.status !== 'cancelled' && (
              <div className="bl-progress" aria-label={tr('{paid} paid of {amount}', { paid: money(b.paid), amount: money(b.amount) })}>
                <i style={{ width: pct + '%' }} />
                <span>{tr('{paid} paid', { paid: money(b.paid) })}</span><span>{b.balance > 0 ? tr('{left} left to pay', { left: money(b.balance) }) : '🎉 ' + tr('Nothing left to pay')}</span>
              </div>
            )}
            <dl className="bl-facts">
              <div><dt>{tr('What for')}</dt><dd>{CATEGORY[b.category][0]} {tr(CATEGORY[b.category][1])}</dd></div>
              <div><dt>{tr('Bill date')}</dt><dd>{dayText(b.billDate)}</dd></div>
              <div><dt>{tr('Due')}</dt><dd>{dayText(b.dueDate)}</dd></div>
              <div><dt>{tr('Where from')}</dt><dd>{tr(SOURCE[b.source] || SOURCE.office)}{b.purchaseOrder ? ' · ' + b.purchaseOrder.ref : ''}</dd></div>
              {b.createdBy && <div><dt>{tr('Entered by')}</dt><dd>{b.createdBy}</dd></div>}
              {b.approvedBy && <div><dt>{tr('Approved by')}</dt><dd>{b.approvedBy}</dd></div>}
            </dl>
            {b.note && <p className="bl-note-view">📝 {b.note}</p>}
            {b.cancelledReason && <p className="bl-note-view is-bad">✕ {b.cancelledReason}</p>}
            <div className="bl-files">
              {b.files.map((f) => <BillFile key={f.n} path={'/bills/' + b.id + '/files/' + f.n} file={f} />)}
              {data.canManage && b.files.length < 4 && b.status !== 'cancelled' && (
                <label className="bl-file is-add"><input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple onChange={addFiles} disabled={busy} /><b aria-hidden="true">＋</b><small>{tr('Photo or PDF')}</small></label>
              )}
              {!b.files.length && !data.canManage && <span className="bl-none">{tr('No copy of the bill yet.')}</span>}
            </div>
            {b.payments.length > 0 && (
              <div className="bl-payments">
                <h3>{tr('Payments')}</h3>
                {b.payments.map((p) => (
                  <div key={p.id} className="bl-payment">
                    <em aria-hidden="true">{(METHOD[p.method] || METHOD.bank)[0]}</em>
                    <span><b>{money(p.amount)}</b> · {tr((METHOD[p.method] || METHOD.bank)[1])}{p.account ? ' · ' + p.account : ''}<small>{dayText(p.paidOn)}{p.reference ? ' · ' + p.reference : ''}{p.by ? ' · ' + p.by : ''}</small></span>
                    {p.hasPhoto && <BillFile path={'/bills/payments/' + p.id + '/photo'} file={{ name: tr('Slip'), type: 'image/jpeg' }} />}
                  </div>
                ))}
              </div>
            )}
            {mode === 'pay' && <PayForm bill={b} data={data} onPaid={done} onCancel={() => setMode('')} />}
            {mode === 'cancel' && (
              <div className="bl-pay">
                <h3>✕ {tr('Cancel this bill')}</h3>
                <label><span>{tr('Why')}</span><input className="input" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={tr('e.g. entered twice; the supplier sent a credit note')} /></label>
                <div className="dialog-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setMode('')}>{tr('Back')}</button>
                  <button type="button" className="btn btn-danger" disabled={busy || reason.trim().length < 3} onClick={() => act('/cancel', { reason })}>{tr('Cancel the bill')}</button>
                </div>
              </div>
            )}
            {error && <div className="error-banner" role="alert">{error}</div>}
            {!mode && open && (
              <div className="bl-actions">
                {b.status === 'to_approve' && data.canApprove && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act('/approve')}>✍️ {tr('Approve')}</button>}
                {b.status === 'approved' && data.canManage && <button type="button" className="btn btn-primary" onClick={() => setMode('pay')}>💸 {tr('Pay this bill')}</button>}
                {b.status === 'to_approve' && !data.canApprove && <span className="bl-wait-approve">⏳ {tr('Waiting for someone who approves bills')}</span>}
                {data.canManage && <button type="button" className="btn btn-secondary" onClick={() => onEdit(b)}>{tr('Edit')}</button>}
                {data.canManage && !b.payments.length && <button type="button" className="btn btn-secondary bl-cancel" onClick={() => setMode('cancel')}>{tr('Cancel the bill')}</button>}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SettingsDialog({ data, onClose, onSaved }) {
  const [v, setV] = useState({ approveOver: String(data.settings.approveOver), dueDays: String(data.settings.dueDays), accounts: data.settings.accounts.join('\n') });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onSaved(await api.put('/bills/settings', { approveOver: Number(v.approveOver), dueDays: Number(v.dueDays), accounts: v.accounts.split('\n').map((a) => a.trim()).filter(Boolean) })); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog bl-dlg" role="dialog" aria-modal="true" aria-labelledby="bl-set-title" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="bl-dlg-head"><span className="bl-dlg-art" aria-hidden="true">⚙️</span><div><h2 id="bl-set-title">{tr('Bills: how they work')}</h2><p>{tr('Who must approve, when a received order is due, and the accounts you pay from.')}</p></div></div>
        <div className="bl-grid">
          <label><span>{tr('Approve bills over')}</span><input className="input" type="number" min="0" step="1" value={v.approveOver} onChange={(e) => setV({ ...v, approveOver: e.target.value })} /><small>{tr('Bills over this wait for someone who approves. 0: every bill.')}</small></label>
          <label><span>{tr('A received order is due after (days)')}</span><input className="input" type="number" min="0" max="120" value={v.dueDays} onChange={(e) => setV({ ...v, dueDays: e.target.value })} /><small>{tr('Unless it was paid at the door.')}</small></label>
        </div>
        <label><span>{tr('Accounts you pay from (one a line)')}</span><textarea className="input" rows={3} value={v.accounts} onChange={(e) => setV({ ...v, accounts: e.target.value })} placeholder={tr('e.g. Main bank account\nMoMo wallet')} /></label>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{tr('Save')}</button>
        </div>
      </form>
    </div>
  );
}

export default function BillsPage() {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState('open');
  const [company, setCompany] = useState('');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(null);
  const [settings, setSettings] = useState(false);
  const openId = params.get('open');
  const load = useCallback(() => {
    const s = new URLSearchParams({ status });
    if (company) s.set('company', company);
    if (q.trim()) s.set('q', q.trim());
    return api.get('/bills?' + s.toString()).then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message));
  }, [status, company, q]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);
  const groups = useMemo(() => {
    if (!data) return [];
    if (status !== 'open') return [{ key: status, bills: data.bills }];
    return ['overdue', 'today', 'soon', 'later'].map((k) => ({ key: k, bills: data.bills.filter((b) => b.state === k) })).filter((g) => g.bills.length);
  }, [data, status]);
  if (!data) return <div className="bl"><p className="bl-wait">{error || tr('Loading…')}</p></div>;
  const s = data.summary;
  const blank = () => ({ companyId: company || (data.companies.find((c) => c.code === 'BPL') || data.companies[0] || {}).id, supplierName: '', reference: '', category: 'stock', billDate: data.today, dueDate: addDays(data.today, data.settings.dueDays), amount: '', note: '' });
  const open = (id) => setParams((p) => { const n = new URLSearchParams(p); if (id) n.set('open', id); else n.delete('open'); return n; });
  const cards = [
    { key: 'overdue', icon: '⏰', label: tr('Overdue'), n: s.overdue.n, amount: s.overdue.amount, tone: 'bad' },
    { key: 'week', icon: '📅', label: tr('Due this week'), n: s.week.n, amount: s.week.amount, tone: 'warn' },
    { key: 'later', icon: '🗓️', label: tr('Later'), n: s.later.n, amount: s.later.amount, tone: 'calm' },
    { key: 'approve', icon: '✍️', label: tr('To approve'), n: s.toApprove.n, amount: s.toApprove.amount, tone: 'violet' },
    { key: 'paid', icon: '✅', label: tr('Paid this month'), amount: s.paidThisMonth, tone: 'good' }
  ];
  return (
    <div className="bl">
      <header className="bl-head">
        <div>
          <h1>🧾 {tr('Bills to pay')}</h1>
          <p>{tr('What we owe suppliers, across Bamboo Products and the restaurants: approved, paid, with the slip.')}</p>
        </div>
        <div className="bl-head-actions">
          {data.canApprove && <button type="button" className="btn btn-secondary" onClick={() => setSettings(true)}>⚙️ {tr('Settings')}</button>}
          {data.canManage && <button type="button" className="btn btn-primary" onClick={() => setEditing(blank())}>＋ {tr('New bill')}</button>}
        </div>
      </header>

      <div className="bl-cards">
        {cards.map((c, i) => (
          <div key={c.key} className={'bl-card is-' + c.tone} style={{ animationDelay: i * 0.04 + 's' }}>
            <em aria-hidden="true">{c.icon}</em>
            <small>{c.label}</small>
            <b>{money(c.amount)}</b>
            {c.n != null && <span>{c.n === 1 ? tr('1 bill') : tr('{n} bills', { n: c.n })}</span>}
          </div>
        ))}
      </div>

      {data.byCompany.length > 0 && (
        <div className="bl-companies" role="group" aria-label={tr('Who owes it')}>
          <button type="button" className={!company ? 'is-on' : ''} onClick={() => setCompany('')}>{tr('Everyone')}</button>
          {data.byCompany.map((c) => (
            <button key={c.id} type="button" className={company === c.id ? 'is-on' : ''} onClick={() => setCompany(company === c.id ? '' : c.id)}>
              {c.name}<b>{money(c.balance)}</b>{c.overdue > 0 && <i title={tr('Overdue')}>⏰ {c.overdue}</i>}
            </button>
          ))}
        </div>
      )}

      <div className="bl-bar">
        <div className="bl-tabs" role="tablist">
          {[['open', tr('To pay')], ['paid', tr('Paid')], ['cancelled', tr('Cancelled')], ['all', tr('All')]].map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={status === k} className={status === k ? 'is-on' : ''} onClick={() => setStatus(k)}>{l}</button>)}
        </div>
        <input className="input bl-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Search a supplier or number')} aria-label={tr('Search')} />
      </div>

      {!data.bills.length && (
        <div className="bl-empty">
          <span aria-hidden="true">{status === 'open' ? '🌴' : '📭'}</span>
          <p>{status === 'open' ? tr('Nothing to pay. Every bill is settled.') : tr('No bills here.')}</p>
        </div>
      )}
      {groups.map((g) => (
        <section key={g.key} className={'bl-group is-' + g.key}>
          {status === 'open' && <h2>{STATE[g.key][0]} {tr(STATE[g.key][1])} <small>{money(g.bills.reduce((t, b) => t + b.balance, 0))}</small></h2>}
          <div className="bl-list">
            {g.bills.map((b) => (
              <button key={b.id} type="button" className={'bl-row is-' + b.state} onClick={() => open(b.id)}>
                <span className="bl-avatar" style={{ '--h': hue(b.supplierName) }} aria-hidden="true">{b.supplierName.charAt(0).toUpperCase()}</span>
                <span className="bl-who">
                  <b>{b.supplierName}</b>
                  <small>{CATEGORY[b.category][0]} {tr(CATEGORY[b.category][1])} · {b.ref}{b.reference ? ' · ' + b.reference : ''}{b.files.length ? ' · 📎' : ''}</small>
                </span>
                <span className="bl-co">{b.company.code}</span>
                <span className="bl-when"><span className={'bl-pill is-' + b.state}>{dueWords(b)}</span>{b.status === 'to_approve' && <span className="bl-pill is-approve">✍️ {tr('To approve')}</span>}</span>
                <span className="bl-money"><b>{money(b.status === 'paid' || b.status === 'cancelled' ? b.amount : b.balance)}</b>{b.paid > 0 && b.balance > 0 && <small>{tr('of {amount}', { amount: money(b.amount) })}</small>}</span>
              </button>
            ))}
          </div>
        </section>
      ))}

      {editing && <BillDialog start={editing} data={data} onClose={() => setEditing(null)} onSaved={(b) => { setEditing(null); load(); open(b.id); }} />}
      {openId && !editing && <BillSheet key={openId} id={openId} data={data} onClose={() => open(null)} onChanged={() => load()}
        onEdit={(b) => setEditing({ id: b.id, companyId: b.company.id, supplierName: b.supplierName, reference: b.reference || '', category: b.category, billDate: b.billDate, dueDate: b.dueDate, amount: String(b.amount), note: b.note || '' })} />}
      {settings && <SettingsDialog data={data} onClose={() => setSettings(false)} onSaved={() => { setSettings(false); load(); }} />}
    </div>
  );
}
