import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import RowMenu from '../components/RowMenu';
import Photo, { fetchBlobUrl, forgetBlob, useBlobUrl } from '../components/Photo';
import { Glossary, Hero, Insights, RankList, Section, Status, fmtDate, jump } from '../components/DashKit';
import { money } from '../lib/currency';
import { tr, msg } from '../lib/i18n.jsx';
import './EmployeesPage.css';
import './ToolRoomPage.css';
import './RestaurantsPage.css';
import './PokiRentals.css';
import './CustomersPage.css';
import './EstimatesPage.css';
import './ExpensesPage.css';

// Expenses — money staff spent for the business and claim back. Same
// "explains itself" layout as the dashboards (components/DashKit.jsx): what
// is waiting for a decision, what is approved but not paid out, what was
// claimed this month, claims with no receipt; what stands out (claims left
// waiting, approved claims not paid, missing receipts, a decision with a
// reason); where the money goes by category; and the claims as cards or a
// list, each opening a window with its receipt and path.
//
// expenses.service.js: everyone sees their own claims; approvers see the
// claims of people in their scope. Nobody decides their own claim. A
// receipt (photo or PDF) is added by the requester while the claim waits,
// or by an approver until it is paid; a reason can go with a decision.

const STEPS = [{ key: 'pending', label: msg('Claimed') }, { key: 'approved', label: msg('Approved') }, { key: 'paid', label: msg('Paid out') }];
const COMMON = ['Fuel', 'Transport', 'Meals', 'Accommodation', 'Airtime & data', 'Repairs', 'Office supplies', 'Materials'];
const WAIT_DAYS = 7;

function readPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* remembered for this visit only */ } }
function iso(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function todayIso() { return iso(new Date()); }
function daysSince(ts) { if (!ts) return 0; const t = new Date(); t.setHours(0, 0, 0, 0); const d = new Date(ts); d.setHours(0, 0, 0, 0); return Math.round((t - d) / 86400000); }
function sum(list) { return list.reduce((s, x) => s + x.amount, 0); }
function statusTone(s) { return s === 'paid' ? 'good' : s === 'approved' ? 'info' : s === 'rejected' ? 'bad' : 'warn'; }
function statusLabel(s) { return { pending: tr('Waiting for a decision'), approved: tr('Approved · to pay out'), paid: tr('Paid out'), rejected: tr('Rejected') }[s] || s; }
function isImage(r) { return r && /^image\//.test(r.type || '') || (r && /\.(jpe?g|png|webp|heic|heif)$/i.test(r.name || '')); }

function ReceiptThumb({ claim, version }) {
  const url = useBlobUrl(claim.receipt && isImage(claim.receipt) ? '/expenses/' + claim.id + '/receipt?inline=1' : null, version);
  if (!claim.receipt) return null;
  if (!isImage(claim.receipt)) return <span className="ex-file" aria-hidden="true">PDF</span>;
  return url ? <img className="ex-thumb" src={url} alt={tr('Receipt')} /> : <span className="ex-file" aria-hidden="true">…</span>;
}

const EMPTY_FORM = { category: '', amount: '', date: todayIso(), description: '' };

export default function ExpensesPage() {
  const { session, can } = useAuth();
  const me = session && session.employee && session.employee.id;
  const canRequest = can('expense.request');
  const canApprove = can('expense.approve');

  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [file, setFile] = useState(null);
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [note, setNote] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [receiptVersion, setReceiptVersion] = useState(1);
  const [search, setSearch] = useState('');
  const [chip, setChip] = useState(canApprove ? 'todecide' : 'mine');
  const [category, setCategory] = useState('');
  const [view, setView] = useState(() => readPref('bos.expensesView', 'cards'));
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setExpenses(await api.get('/expenses'));
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
  useEffect(() => { setNote(''); setConfirmDelete(false); }, [detail]);

  function openNew() { setFormError(null); setEditId(null); setForm(EMPTY_FORM); setFile(null); setFormOpen(true); }
  function openEdit(x) {
    setFormError(null); setEditId(x.id); setFile(null);
    setForm({ category: x.category, amount: String(x.amount), date: String(x.date).slice(0, 10), description: x.description });
    setDetail(null); setFormOpen(true);
  }
  async function uploadReceipt(id, f) {
    const fd = new FormData();
    fd.append('file', f);
    await api.upload('/expenses/' + id + '/receipt', fd);
    forgetBlob('/expenses/' + id + '/receipt?inline=1');
    setReceiptVersion((v) => v + 1);
  }
  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const saved = editId ? await api.patch('/expenses/' + editId, form) : await api.post('/expenses', form);
      if (file) await uploadReceipt(saved.id, file);
      setToast(editId ? tr('Claim updated.') : tr('Expense claim submitted.'));
      setFormOpen(false);
      await load();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  }
  async function act(x, fn, done) {
    setBusyId(x.id);
    setError(null);
    try {
      await fn();
      setToast(done);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }
  const decide = (x, decision) => act(x, () => api.post('/expenses/' + x.id + '/decision', { decision, note }), decision === 'approved' ? tr('Claim approved.') : tr('Claim rejected.'));
  const markPaid = (x) => act(x, () => api.post('/expenses/' + x.id + '/mark-paid'), tr('Marked paid.'));
  const remove = (x) => act(x, async () => { await api.del('/expenses/' + x.id); setDetail(null); }, tr('Claim deleted.'));
  async function pickReceipt(x, f) {
    if (!f) return;
    await act(x, () => uploadReceipt(x.id, f), tr('Receipt added.'));
  }
  // The file sits behind sign-in, so it is fetched with the session and
  // opened from memory; the tab is opened on the click itself, as a tab
  // opened after waiting would be blocked as a pop-up.
  function openReceipt(x) {
    const win = window.open('', '_blank');
    fetchBlobUrl('/expenses/' + x.id + '/receipt?inline=1', receiptVersion).then((u) => {
      if (u && win) win.location.href = u;
      else { if (win) win.close(); setError(tr('The receipt could not be opened.')); }
    });
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const others = expenses.filter((x) => x.requesterId !== me);
  const toDecide = (canApprove ? others : expenses).filter((x) => x.status === 'pending');
  const toPay = expenses.filter((x) => x.status === 'approved');
  const monthKey = todayIso().slice(0, 7);
  const lastKey = (() => { const t = new Date(); return iso(new Date(t.getFullYear(), t.getMonth() - 1, 1)).slice(0, 7); })();
  const counted = (x) => x.status !== 'rejected';
  const thisMonth = expenses.filter((x) => counted(x) && String(x.date).slice(0, 7) === monthKey);
  const lastMonth = expenses.filter((x) => counted(x) && String(x.date).slice(0, 7) === lastKey);
  const noReceipt = expenses.filter((x) => (x.status === 'pending' || x.status === 'approved') && !x.receipt);
  const staleDecide = toDecide.filter((x) => daysSince(x.createdAt) > WAIT_DAYS);
  const stalePay = toPay.filter((x) => daysSince(x.decidedAt) > WAIT_DAYS);
  const myRejected = expenses.filter((x) => x.requesterId === me && x.status === 'rejected' && daysSince(x.decidedAt) <= 30);
  const recent = expenses.filter((x) => (x.status === 'approved' || x.status === 'paid') && daysSince(x.date) <= 90);
  const byCat = {};
  recent.forEach((x) => { byCat[x.category] = (byCat[x.category] || 0) + x.amount; });
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const change = sum(lastMonth) > 0 ? Math.round(((sum(thisMonth) - sum(lastMonth)) / sum(lastMonth)) * 100) : null;

  function showOnly(key) { setCategory(''); setChip(chip === key ? 'all' : key); jump('ex-list'); }
  const stats = [
    { icon: 'clock', value: String(toDecide.length), label: canApprove ? tr('waiting for your decision') : tr('waiting for a decision'), note: toDecide.length ? tr('for {amount}', { amount: money(sum(toDecide)) }) : tr('nothing waiting'), tone: staleDecide.length ? 'warn' : '', onClick: () => showOnly('todecide') },
    { icon: 'cash', value: money(sum(toPay)), label: tr('approved, not paid out'), note: toPay.length === 1 ? tr('1 claim') : tr('{n} claims', { n: toPay.length }), tone: stalePay.length ? 'bad' : toPay.length ? 'warn' : 'good', onClick: () => showOnly('topay') },
    { icon: 'receipt', value: money(sum(thisMonth)), label: tr('claimed this month'), note: change === null ? tr('{n} claims', { n: thisMonth.length }) : change >= 0 ? tr('{pct}% more than last month', { pct: change }) : tr('{pct}% less than last month', { pct: -change }), onClick: () => showOnly('month') },
    { icon: 'warn', value: String(noReceipt.length), label: tr('with no receipt'), note: tr('waiting or approved'), tone: noReceipt.length ? 'warn' : 'good', onClick: () => showOnly('noreceipt') }
  ];
  const insights = [];
  if (stalePay.length) insights.push({ tone: 'bad', icon: 'cash', text: stalePay.length === 1 ? tr('{name}\'s {category} claim of {amount} was approved {days} days ago and hasn\'t been paid out.', { name: stalePay[0].requesterName, category: stalePay[0].category, amount: money(stalePay[0].amount), days: daysSince(stalePay[0].decidedAt) }) : tr('{n} approved claims have waited more than a week to be paid out.', { n: stalePay.length }), action: { label: tr('Show them'), run: () => showOnly('topay') } });
  if (staleDecide.length) insights.push({ tone: 'warn', icon: 'clock', text: staleDecide.length === 1 ? tr('{name}\'s {category} claim has waited {days} days for a decision.', { name: staleDecide[0].requesterName, category: staleDecide[0].category, days: daysSince(staleDecide[0].createdAt) }) : tr('{n} claims have waited more than a week for a decision.', { n: staleDecide.length }), action: { label: tr('Show them'), run: () => showOnly('todecide') } });
  if (noReceipt.length) insights.push({ tone: 'warn', icon: 'receipt', text: noReceipt.length === 1 ? tr('The {category} claim of {amount} has no receipt yet.', { category: noReceipt[0].category, amount: money(noReceipt[0].amount) }) : tr('{n} claims have no receipt yet. Add a photo of it.', { n: noReceipt.length }), action: { label: tr('Show them'), run: () => showOnly('noreceipt') } });
  myRejected.slice(0, 1).forEach((x) => insights.push({ tone: 'info', icon: 'info', text: x.decisionNote ? tr('Your {category} claim was rejected: “{note}”', { category: x.category, note: x.decisionNote }) : tr('Your {category} claim of {amount} was rejected.', { category: x.category, amount: money(x.amount) }), action: { label: tr('Open'), run: () => setDetail(x.id) } }));
  if (cats.length && canApprove) insights.push({ tone: 'info', icon: 'up', text: tr('{category} is where most claimed money went over the last 90 days: {amount}.', { category: cats[0][0], amount: money(cats[0][1]) }), action: { label: tr('Show them'), run: () => { setChip('all'); setCategory(cats[0][0]); jump('ex-list'); } } });
  if (!insights.length && expenses.length) insights.push({ tone: 'good', icon: 'check', text: tr('Nothing is waiting, everything approved is paid out, and every claim has its receipt.') });

  const chipTest = {
    todecide: (x) => toDecide.includes(x), topay: (x) => x.status === 'approved', noreceipt: (x) => noReceipt.includes(x), month: (x) => thisMonth.includes(x),
    paid: (x) => x.status === 'paid', rejected: (x) => x.status === 'rejected', mine: (x) => x.requesterId === me, all: () => true
  };
  const visible = expenses.filter(chipTest[chip] || chipTest.all).filter((x) => !category || x.category === category)
    .filter((x) => matchesQuery(search, x.requesterName, x.departmentName, x.category, x.description, x.companyName));
  const chips = [
    ['todecide', tr('To decide'), toDecide.length], ['topay', tr('To pay out'), toPay.length], ['noreceipt', tr('No receipt'), noReceipt.length], ['month', tr('This month'), thisMonth.length],
    ['paid', tr('Paid out'), expenses.filter(chipTest.paid).length], ['rejected', tr('Rejected'), expenses.filter(chipTest.rejected).length],
    ...(canApprove ? [['mine', tr('Mine'), expenses.filter(chipTest.mine).length]] : []), ['all', tr('All'), expenses.length]
  ].filter(([k, , c]) => c > 0 || k === 'all' || k === chip);
  const allCats = [...new Set(expenses.map((x) => x.category).concat(COMMON))].sort();

  const cur = detail ? expenses.find((x) => x.id === detail) : null;
  const mine = cur && cur.requesterId === me;
  const canEditCur = cur && cur.status === 'pending' && (mine || canApprove);
  const canReceiptCur = cur && ((mine && cur.status === 'pending') || (canApprove && cur.status !== 'paid'));
  const stepAt = cur ? STEPS.findIndex((s) => s.key === cur.status) : 0;
  function actionsFor(x) {
    const own = x.requesterId === me;
    return [
      { label: tr('Open'), onClick: () => setDetail(x.id) },
      canApprove && !own && x.status === 'pending' && { label: tr('Approve'), onClick: () => decide(x, 'approved') },
      canApprove && x.status === 'approved' && { label: tr('Mark paid'), onClick: () => markPaid(x) },
      x.status === 'pending' && (own || canApprove) && { label: tr('Edit'), onClick: () => openEdit(x) },
      x.receipt && { label: tr('Open receipt'), onClick: () => openReceipt(x) }
    ].filter(Boolean);
  }

  return (
    <div className="dk tl pk cu ex">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <Hero
        eyebrow={tr('Finance')}
        title={tr('Expenses')}
        sub={canApprove ? tr('Money staff spent for the business and are claiming back: what waits for a decision, what is approved but not paid out, and where the money goes. Press a number to show only those.') : tr('Money you spent for the business and are claiming back: send a claim with a photo of the receipt and follow it until it is paid.')}
        actions={canRequest && <button type="button" className="btn btn-primary" onClick={openNew}>{tr('New claim')}</button>}
        stats={stats} />

      <Insights items={insights.slice(0, 5)} />

      {cats.length > 0 && (
        <Section id="ex-cats" title={tr('Where the money goes')} sub={tr('Approved and paid claims over the last 90 days, by category. Press one to show those claims.')} card>
          <RankList rows={cats.slice(0, 8).map(([name, amount]) => ({ key: name, name, amount: money(amount), value: amount }))} />
          <div className="ex-cat-links">
            {cats.slice(0, 8).map(([name]) => <button key={name} type="button" className={'ppl-chip' + (category === name ? ' is-on' : '')} onClick={() => { setChip('all'); setCategory(category === name ? '' : name); jump('ex-list'); }}>{name}</button>)}
          </div>
        </Section>
      )}

      <Section id="ex-list" title={tr('Claims')} sub={tr('Press a claim to see its receipt, decide it or pay it out.')}
        action={(
          <div className="ppl-view" role="radiogroup" aria-label={tr('View')}>
            {[['cards', tr('Cards')], ['list', tr('List')]].map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={view === k} className={view === k ? 'is-on' : ''} onClick={() => { setView(k); writePref('bos.expensesView', k); }}>{label}</button>
            ))}
          </div>
        )}>
        <div className="tl-tools"><div className="tl-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search expense claims…')} /></div></div>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {chips.map(([key, label, c]) => (
            <button key={key} type="button" role="radio" aria-checked={chip === key} className={'ppl-chip' + (chip === key ? ' is-on' : '')} onClick={() => setChip(key)}>
              {label} <span className="ppl-chip-n">{c}</span>
            </button>
          ))}
          {category && <button type="button" className="ppl-chip is-on" onClick={() => setCategory('')}>{category} ×</button>}
        </div>
        {!visible.length ? (
          <div className="dk-empty tl-empty">
            <p>{expenses.length ? tr('Nothing matches. Try another search or filter.') : tr('No expense claims yet')}</p>
            {canRequest && !expenses.length && <button type="button" className="btn btn-primary" onClick={openNew}>{tr('New claim')}</button>}
          </div>
        ) : view === 'cards' ? (
          <div className="tl-grid">
            {visible.map((x) => (
              <article key={x.id} className={'tl-card' + (stalePay.includes(x) ? ' st-late' : '') + (x.status === 'rejected' ? ' st-retired' : '')}>
                <button type="button" className="tl-card-open" onClick={() => setDetail(x.id)}>
                  <Photo id={x.requesterId} name={x.requesterName} photo={x.requesterPhoto} size={44} />
                  <span className="tl-card-head">
                    <span className="dk-muted tl-small">{x.category} · {fmtDate(x.date)}</span>
                    <span className="tl-name">{x.requesterName}</span>
                  </span>
                </button>
                <span className="tl-menu"><RowMenu disabled={busyId === x.id} actions={actionsFor(x)} /></span>
                <p className="dk-muted tl-small es-items">{x.description}</p>
                <div className="tl-tags"><Status tone={statusTone(x.status)}>{statusLabel(x.status)}</Status>{!x.receipt && x.status !== 'rejected' && <Status tone="warn">{tr('No receipt')}</Status>}</div>
                <div className="tl-foot">
                  <span className="es-total">{money(x.amount)}</span>
                  <ReceiptThumb claim={x} version={receiptVersion} />
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="tl-table-wrap">
            <table className="tl-table">
              <thead><tr><th>{tr('Requester')}</th><th>{tr('Category')}</th><th>{tr('Date')}</th><th>{tr('Description')}</th><th className="is-num">{tr('Amount')}</th><th>{tr('Receipt')}</th><th>{tr('Status')}</th><th /></tr></thead>
              <tbody>
                {visible.map((x) => (
                  <tr key={x.id} className={x.status === 'rejected' ? 'st-retired' : ''}>
                    <td><button type="button" className="tl-row-open" onClick={() => setDetail(x.id)}><Photo id={x.requesterId} name={x.requesterName} photo={x.requesterPhoto} size={30} /><span><span className="tl-name">{x.requesterName}</span><span className="dk-muted tl-small">{x.departmentName}</span></span></button></td>
                    <td>{x.category}</td>
                    <td>{fmtDate(x.date)}</td>
                    <td className="es-items-cell">{x.description}</td>
                    <td className="is-num">{money(x.amount)}</td>
                    <td className={!x.receipt && x.status !== 'rejected' ? 'pk-owe' : ''}>{x.receipt ? tr('Yes') : tr('None')}</td>
                    <td><Status tone={statusTone(x.status)}>{statusLabel(x.status)}</Status></td>
                    <td className="tl-menu-cell"><RowMenu disabled={busyId === x.id} actions={actionsFor(x)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Glossary items={[
        [tr('Claim'), tr('Money someone spent for the business and asks to have paid back, with a photo of the receipt.')],
        [tr('Approved · to pay out'), tr('Someone who approves claims said yes. Finance pays the money back and marks it paid.')],
        [tr('Rejected'), tr('Not paid back. The reason, if one was given, is shown with the claim.')],
        [tr('Your own claim'), tr('Nobody decides their own claim: another approver must.')]
      ]} />

      {/* ── one claim ── */}
      {cur && (
        <div className="dialog-backdrop" onClick={() => setDetail(null)}>
          <div className="dialog tl-dialog ex-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="tl-detail-head">
              <Photo id={cur.requesterId} name={cur.requesterName} photo={cur.requesterPhoto} size={56} />
              <div>
                <span className="dk-muted tl-small">{cur.requesterName} · {cur.departmentName}</span>
                <h2>{money(cur.amount)}</h2>
                <div className="tl-tags"><Status tone={statusTone(cur.status)}>{statusLabel(cur.status)}</Status></div>
              </div>
              <button type="button" className="tl-close" onClick={() => setDetail(null)} aria-label={tr('Close')}>×</button>
            </div>
            {cur.status !== 'rejected' && (
              <ol className="es-path" aria-label={tr('Where it stands')}>
                {STEPS.map((s, i) => <li key={s.key} className={i <= stepAt ? 'is-done' : ''}>{tr(s.label)}</li>)}
              </ol>
            )}
            <dl className="tl-facts">
              <div><dt>{tr('Category')}</dt><dd>{cur.category}</dd></div>
              <div><dt>{tr('Spent on')}</dt><dd>{fmtDate(cur.date)}</dd></div>
              <div><dt>{tr('Claimed')}</dt><dd>{fmtDate(cur.createdAt)}</dd></div>
              {cur.decidedByName && <div><dt>{cur.status === 'rejected' ? tr('Rejected by') : tr('Approved by')}</dt><dd>{cur.decidedByName} · {fmtDate(cur.decidedAt)}</dd></div>}
              {cur.paidAt && <div><dt>{tr('Paid out by')}</dt><dd>{cur.paidByName || '—'} · {fmtDate(cur.paidAt)}</dd></div>}
            </dl>
            <p className="tl-notes">{cur.description}</p>
            {cur.decisionNote && <p className="tl-notes ex-note"><strong>{tr('Reason')}:</strong> {cur.decisionNote}</p>}
            <h3 className="tl-h3">{tr('Receipt')}</h3>
            {cur.receipt ? (
              <button type="button" className="ex-receipt" onClick={() => openReceipt(cur)}>
                <ReceiptThumb claim={cur} version={receiptVersion} />
                <span><strong>{cur.receipt.name}</strong><span className="dk-muted tl-small">{tr('Press to open')}</span></span>
              </button>
            ) : <p className="dk-muted tl-small">{tr('No receipt yet.')}</p>}
            {canReceiptCur && (
              <>
                <input ref={fileRef} type="file" accept="image/*,.pdf" hidden onChange={(e) => { pickReceipt(cur, e.target.files[0]); e.target.value = ''; }} />
                <button type="button" className="btn btn-secondary ex-add-receipt" disabled={busyId === cur.id} onClick={() => fileRef.current && fileRef.current.click()}>{cur.receipt ? tr('Replace receipt') : tr('Add a photo of the receipt')}</button>
              </>
            )}
            {canApprove && !mine && cur.status === 'pending' && (
              <div className="field ex-note-field">
                <label htmlFor="ex-note">{tr('Reason (optional, sent to {name})', { name: cur.requesterName })}</label>
                <input id="ex-note" className="input" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
              </div>
            )}
            {canApprove && mine && cur.status === 'pending' && <p className="dk-muted tl-small">{tr('This is your own claim, so someone else who approves claims must decide it.')}</p>}
            {confirmDelete ? (
              <div className="dialog-actions tl-actions">
                <span className="dk-muted tl-small prl-confirm">{tr('Delete this claim?')}</span>
                <button type="button" className="btn btn-secondary" onClick={() => setConfirmDelete(false)}>{tr('Cancel')}</button>
                <button type="button" className="btn btn-primary" disabled={busyId === cur.id} onClick={() => remove(cur)}>{tr('Delete')}</button>
              </div>
            ) : (
              <div className="dialog-actions tl-actions">
                {canEditCur && <button type="button" className="btn btn-secondary" onClick={() => setConfirmDelete(true)}>{tr('Delete')}</button>}
                {canEditCur && <button type="button" className="btn btn-secondary" onClick={() => openEdit(cur)}>{tr('Edit')}</button>}
                {canApprove && !mine && cur.status === 'pending' && <button type="button" className="btn btn-secondary" disabled={busyId === cur.id} onClick={() => decide(cur, 'rejected')}>{tr('Reject')}</button>}
                {canApprove && !mine && cur.status === 'pending' && <button type="button" className="btn btn-primary" disabled={busyId === cur.id} onClick={() => decide(cur, 'approved')}>{tr('Approve')}</button>}
                {canApprove && cur.status === 'approved' && <button type="button" className="btn btn-primary" disabled={busyId === cur.id} onClick={() => markPaid(cur)}>{tr('Mark paid')}</button>}
              </div>
            )}
          </div>
        </div>
      )}

      {formOpen && (
        <div className="dialog-backdrop" onClick={() => !saving && setFormOpen(false)}>
          <form className="dialog tl-dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h2>{editId ? tr('Edit expense claim') : tr('New expense claim')}</h2>
            {formError && <div className="error-banner">{formError}</div>}
            <div className="tl-form">
              <div className="field">
                <label htmlFor="ex-category">{tr('Category')}</label>
                <input id="ex-category" className="input" list="ex-cats-list" maxLength={40} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder={tr('Travel, Fuel…')} required />
                <datalist id="ex-cats-list">{allCats.map((c) => <option key={c} value={c} />)}</datalist>
              </div>
              <div className="field">
                <label htmlFor="ex-amount">{tr('Amount (GHS)')}</label>
                <input id="ex-amount" className="input" type="number" min="0.01" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required />
              </div>
              <div className="field">
                <label htmlFor="ex-date">{tr('Spent on')}</label>
                <input id="ex-date" className="input" type="date" max={todayIso()} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="ex-file">{tr('Receipt (photo or PDF)')}</label>
                <input id="ex-file" className="input" type="file" accept="image/*,.pdf" onChange={(e) => setFile(e.target.files[0] || null)} />
              </div>
              <div className="field tl-span">
                <label htmlFor="ex-description">{tr('What it was for')}</label>
                <textarea id="ex-description" className="input tl-textarea" maxLength={300} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} required />
              </div>
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setFormOpen(false)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : editId ? tr('Save changes') : tr('Submit claim')}</button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
