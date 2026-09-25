import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { blankDocItem } from '../components/DocItemsEditor';
import DocWizard from '../components/DocWizard';
import CustomerPicker from '../components/CustomerPicker';
import DocPreview from '../components/DocPreview';
import ContactButtons from '../components/ContactButtons';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import RowMenu from '../components/RowMenu';
import { Glossary, Hero, Insights, Section, Status, avatarColor, fmtDate, initials, jump } from '../components/DashKit';
import { adjustmentRows, lineAmount, totalsForDialog } from '../lib/docItems';
import { money, moneyBreakdown } from '../lib/currency';
import { groupPackageItems } from '../lib/packages';
import { formatPaymentSchedule } from '../lib/paymentSchedule';
import { tr, msg, docTr } from '../lib/i18n.jsx';
import { formatDocDate } from '../lib/dates';
import { codeLabel } from '../lib/codeLabels.js';
import './EmployeesPage.css';
import './ToolRoomPage.css';
import './RestaurantsPage.css';
import './PokiRentals.css';
import './CustomersPage.css';
import './EstimatesPage.css';

// Estimates — rough prices worked out for a client before a formal
// quotation. Same "explains itself" layout as the dashboards
// (components/DashKit.jsx): what is being worked on and what it is worth,
// how many became quotations and how many of those were won, what stands
// out (past their valid-until date, ready but not yet sent, drafts left
// sitting, quotations turned down), the path from draft to an answer, and
// the estimates as cards or a list with a window for each one
// (estimates.service.js list: contact details, who made it and the
// quotation made from it).
//
// Only a quotation.manage holder who can also read clients may start one:
// the client picker needs the client list.

const STEPS = [
  { key: 'draft', label: msg('Draft') }, { key: 'finalized', label: msg('Ready') },
  { key: 'converted', label: msg('Made into a quotation'), short: msg('Quoted') }, { key: 'won', label: msg('Accepted') }
];
const STALE_DAYS = 14;
const EMPTY_FORM = { customerId: '', validUntil: '', internalNotes: '', clientNotes: '', currency: '' };

function readPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* remembered for this visit only */ } }
function todayIso() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function daysSince(iso) {
  if (!iso) return null;
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const d = new Date(String(iso).slice(0, 10) + 'T00:00');
  return Math.round((t - d) / 86400000);
}
function isOpen(es) { return es.status === 'draft' || es.status === 'finalized'; }
function isPast(es) { return isOpen(es) && es.validUntil && String(es.validUntil).slice(0, 10) < todayIso(); }
function statusLabel(s) { return { draft: tr('Draft'), finalized: tr('Ready'), converted: tr('Made into a quotation'), archived: tr('Put away') }[s] || codeLabel(s); }
function quoteTone(s) { return s === 'accepted' ? 'good' : s === 'rejected' || s === 'expired' || s === 'cancelled' ? 'bad' : s === 'draft' ? 'muted' : 'info'; }
function sumBy(list) {
  const m = {};
  list.forEach((es) => { m[es.currency] = (m[es.currency] || 0) + Number(es.grandTotal || 0); });
  return Object.entries(m).map(([currency, amount]) => ({ currency, amount }));
}
function itemsLine(es) { return (es.items || []).map((i) => i.description).filter(Boolean).join(', '); }

function Mark({ es, size = 44 }) {
  return <span className="pk-avatar cu-mark" style={{ width: size, height: size, background: avatarColor(es.customerName), fontSize: Math.round(size * 0.34) }} aria-hidden="true">{initials(es.customerName)}</span>;
}

export default function EstimatesPage() {
  const { can } = useAuth();
  const canManage = can('quotation.manage');
  const canSeeCustomers = can('customer.read');
  const canSeeCatalog = can('catalog.read');
  const canOpenNew = canManage && canSeeCustomers;

  const [estimates, setEstimates] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [currencies, setCurrencies] = useState(['GHS']);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [items, setItems] = useState([blankDocItem()]);
  const [docDiscount, setDocDiscount] = useState({ value: 0, type: 'fixed' });
  const [docTaxRate, setDocTaxRate] = useState(0);
  const [paymentSchedule, setPaymentSchedule] = useState([]);
  const [dialogError, setDialogError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [detail, setDetail] = useState(null);

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [previewEs, setPreviewEs] = useState(null);
  const [search, setSearch] = useState('');
  const [chip, setChip] = useState('open');
  const [step, setStep] = useState('');
  const [view, setView] = useState(() => readPref('bos.estimatesView', 'cards'));

  const load = useCallback(async () => {
    setError(null);
    try {
      const [es, cust, cat] = await Promise.all([
        api.get('/estimates'),
        canSeeCustomers ? api.get('/customers') : Promise.resolve([]),
        canSeeCatalog ? api.get('/catalog') : Promise.resolve([])
      ]);
      setEstimates(es);
      setCustomers(cust);
      setCatalog(cat);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
    try {
      const settings = await api.get('/settings');
      if (settings.commercial && settings.commercial.currencies) setCurrencies(settings.commercial.currencies);
    } catch { /* falls back to GHS only, see QuotationsPage's identical comment */ }
  }, [canSeeCustomers, canSeeCatalog]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  function openNew() {
    setDialogError(null);
    setEditId(null);
    setForm(EMPTY_FORM);
    setItems([blankDocItem()]);
    setDocDiscount({ value: 0, type: 'fixed' });
    setDocTaxRate(0);
    setPaymentSchedule([]);
    setDialogOpen(true);
  }
  function openEdit(es) {
    setDialogError(null);
    setEditId(es.id);
    setForm({ customerId: es.customerId, validUntil: es.validUntil, internalNotes: es.internalNotes || '', clientNotes: es.clientNotes || '', currency: es.currency || '' });
    setItems(es.items.map((it) => ({ ...it })));
    setDocDiscount(es.discount || { value: 0, type: 'fixed' });
    setDocTaxRate(es.taxRate || 0);
    setPaymentSchedule((es.paymentSchedule || []).map((r) => ({ label: r.label, type: r.type, value: r.value, dueDate: r.dueDate || '' })));
    setDetail(null);
    setDialogOpen(true);
  }

  async function handleSubmit() {
    setSaving(true);
    setDialogError(null);
    try {
      const payload = {
        customerId: form.customerId, items, validUntil: form.validUntil, internalNotes: form.internalNotes, clientNotes: form.clientNotes,
        currency: form.currency || undefined, discount: docDiscount, taxRate: docTaxRate, paymentSchedule
      };
      if (editId) await api.put('/estimates/' + editId, payload);
      else await api.post('/estimates', payload);
      setToast(editId ? tr('Estimate updated.') : tr('Estimate created.'));
      setDialogOpen(false);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function run(es, fn, done) {
    setBusyId(es.id);
    setError(null);
    try {
      const r = await fn();
      setToast(done(r));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }
  const setStatus = (es, status, text) => run(es, () => api.post('/estimates/' + es.id + '/status', { status }), () => text);
  const finalize = (es) => setStatus(es, 'finalized', tr('{estimateNo} finalized.', { estimateNo: es.estimateNo }));
  const archive = (es) => setStatus(es, 'archived', tr('{estimateNo} put away.', { estimateNo: es.estimateNo }));
  const reopen = (es) => setStatus(es, 'draft', tr('{estimateNo} is a draft again.', { estimateNo: es.estimateNo }));
  const convert = (es) => run(es, () => api.post('/estimates/' + es.id + '/convert', {}), (q) => tr('{quoteNo} created from estimate.', { quoteNo: q.quoteNo }));

  async function confirmDelete() {
    setDeleting(true);
    try {
      await api.del('/estimates/' + deleteTarget.id);
      setToast(tr('{estimateNo} deleted.', { estimateNo: deleteTarget.estimateNo }));
      setDeleteTarget(null);
      setDetail(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  }

  function openPreview(es) {
    const cust = customers.find((c) => c.id === es.customerId) || {};
    setPreviewEs({ ...es, customerName: cust.name || es.customerName, customerEmail: cust.email || es.customerEmail || '' });
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const open = estimates.filter(isOpen);
  const drafts = estimates.filter((es) => es.status === 'draft');
  const ready = estimates.filter((es) => es.status === 'finalized');
  const converted = estimates.filter((es) => es.status === 'converted');
  const won = converted.filter((es) => es.quotation && es.quotation.status === 'accepted');
  const lost = converted.filter((es) => es.quotation && ['rejected', 'expired', 'cancelled'].includes(es.quotation.status));
  const waiting = converted.filter((es) => es.quotation && ['sent', 'viewed'].includes(es.quotation.status));
  const past = open.filter(isPast);
  const stale = drafts.filter((es) => daysSince(es.createdAt) > STALE_DAYS);
  const decided = converted.length + estimates.filter((es) => es.status === 'archived').length;

  function showOnly(key) { setStep(''); setChip(chip === key ? 'open' : key); jump('es-list'); }
  const stats = [
    { icon: 'doc', value: String(open.length), label: tr('estimates being worked on'), note: tr('{n} ready to become a quotation', { n: ready.length }), onClick: () => showOnly('open') },
    { icon: 'cash', value: moneyBreakdown(sumBy(open), money(0)), label: tr('worth, not yet quoted'), note: past.length ? tr('{n} past their valid-until date', { n: past.length }) : tr('all still within their dates'), tone: past.length ? 'warn' : '', onClick: () => showOnly(past.length ? 'past' : 'open') },
    { icon: 'send', value: String(converted.length), label: tr('made into quotations'), note: decided ? tr('{pct}% of estimates that went somewhere', { pct: Math.round((converted.length / decided) * 100) }) : tr('none yet'), onClick: () => showOnly('converted') },
    { icon: 'check', value: String(won.length), label: tr('accepted by the client'), note: waiting.length ? tr('{n} still waiting for an answer', { n: waiting.length }) : lost.length ? tr('{n} turned down', { n: lost.length }) : tr('from quotations made from estimates'), tone: won.length ? 'good' : '', onClick: () => showOnly('won') }
  ];

  const insights = [];
  if (past.length) insights.push({ tone: 'warn', icon: 'calendar', text: past.length === 1 ? tr('{no} for {name} passed its valid-until date on {date}. Check the prices before sending it.', { no: past[0].estimateNo, name: past[0].customerName, date: fmtDate(past[0].validUntil) }) : tr('{n} estimates have passed their valid-until date. Check the prices or put them away.', { n: past.length }), action: { label: past.length === 1 ? tr('Open') : tr('Show them'), run: () => (past.length === 1 ? setDetail(past[0].id) : showOnly('past')) } });
  if (ready.length) insights.push({ tone: 'info', icon: 'send', text: ready.length === 1 ? tr('{no} for {name} is ready. Make it into a quotation to send it.', { no: ready[0].estimateNo, name: ready[0].customerName }) : tr('{n} estimates are ready to be made into quotations.', { n: ready.length }), action: { label: ready.length === 1 ? tr('Open') : tr('Show them'), run: () => (ready.length === 1 ? setDetail(ready[0].id) : showOnly('ready')) } });
  if (stale.length) insights.push({ tone: 'warn', icon: 'clock', text: stale.length === 1 ? tr('{no} for {name} has been a draft for {days} days.', { no: stale[0].estimateNo, name: stale[0].customerName, days: daysSince(stale[0].createdAt) }) : tr('{n} drafts have sat for more than two weeks.', { n: stale.length }), action: { label: tr('Show them'), run: () => showOnly('stale') } });
  if (lost.length) insights.push({ tone: 'bad', icon: 'down', text: lost.length === 1 ? tr('The quotation made from {no} for {name} was turned down.', { no: lost[0].estimateNo, name: lost[0].customerName }) : tr('{n} quotations made from estimates were turned down.', { n: lost.length }), action: { label: tr('Show them'), run: () => showOnly('lost') } });
  if (won.length) insights.push({ tone: 'good', icon: 'up', text: won.length === 1 ? tr('{no} for {name} ended in an accepted quotation, worth {amount}.', { no: won[0].estimateNo, name: won[0].customerName, amount: money(won[0].grandTotal, won[0].currency) }) : tr('{n} estimates ended in an accepted quotation, worth {amount}.', { n: won.length, amount: moneyBreakdown(sumBy(won)) }), action: { label: tr('Show them'), run: () => showOnly('won') } });
  if (!insights.length && estimates.length) insights.push({ tone: 'good', icon: 'check', text: tr('Nothing waiting: every estimate is within its dates and moving.') });

  const chipTest = {
    open: isOpen, draft: (es) => es.status === 'draft', ready: (es) => es.status === 'finalized', past: isPast, stale: (es) => stale.includes(es),
    converted: (es) => es.status === 'converted', won: (es) => won.includes(es), lost: (es) => lost.includes(es),
    archived: (es) => es.status === 'archived', all: () => true
  };
  const stepTest = { draft: chipTest.draft, finalized: chipTest.ready, converted: chipTest.converted, won: chipTest.won };
  const visible = estimates.filter(chipTest[chip] || chipTest.open)
    .filter((es) => !step || stepTest[step](es))
    .filter((es) => matchesQuery(search, es.estimateNo, es.customerName, itemsLine(es), es.quotation && es.quotation.quoteNo, es.createdByName));
  const chips = [
    ['open', tr('Being worked on'), open.length], ['draft', tr('Drafts'), drafts.length], ['ready', tr('Ready'), ready.length],
    ['past', tr('Past valid-until'), past.length], ['stale', tr('Old drafts'), stale.length], ['converted', tr('Made into quotations'), converted.length],
    ['won', tr('Accepted'), won.length], ['lost', tr('Turned down'), lost.length], ['archived', tr('Put away'), estimates.filter(chipTest.archived).length], ['all', tr('All'), estimates.length]
  ].filter(([k, , c]) => c > 0 || k === 'open' || k === chip);
  const counts = { draft: drafts.length, finalized: ready.length, converted: converted.length, won: won.length };

  function stateOf(es, short) {
    if (es.status === 'converted' && es.quotation) return { tone: quoteTone(es.quotation.status), text: es.quotation.quoteNo + ' · ' + codeLabel(es.quotation.status) };
    if (es.status === 'archived') return { tone: 'muted', text: tr('Put away') };
    if (isPast(es)) return { tone: 'warn', text: short ? tr('Past valid-until') : tr('Past valid-until {date}', { date: fmtDate(es.validUntil) }) };
    if (es.status === 'finalized') return { tone: 'info', text: tr('Ready') };
    return { tone: 'muted', text: short ? tr('Draft') : tr('Draft · valid until {date}', { date: fmtDate(es.validUntil) }) };
  }
  // Shared by the row menu and the window so the two cannot drift.
  function actionsFor(es) {
    return [
      { label: tr('Open'), onClick: () => setDetail(es.id) },
      { label: tr('Preview'), onClick: () => openPreview(es) },
      canManage && es.status === 'draft' && { label: tr('Edit'), onClick: () => openEdit(es) },
      canManage && es.status === 'draft' && { label: tr('Mark ready'), onClick: () => finalize(es) },
      canManage && isOpen(es) && { label: tr('Make into a quotation'), onClick: () => convert(es) },
      canManage && es.status === 'finalized' && { label: tr('Back to draft'), onClick: () => reopen(es) },
      canManage && isOpen(es) && { label: tr('Put away'), onClick: () => archive(es) },
      canManage && es.status === 'archived' && { label: tr('Bring back'), onClick: () => reopen(es) },
      canManage && es.status !== 'converted' && { label: tr('Delete'), onClick: () => setDeleteTarget(es), danger: true }
    ].filter(Boolean);
  }

  const cur = detail ? estimates.find((es) => es.id === detail) : null;
  // Subtotal, discount and tax only when there is something between them and the total.
  const curTotals = cur ? totalsForDialog(cur, cur.currency).filter((r, i, all) => all.length > 2 || r.strong) : [];

  return (
    <div className="dk tl pk cu es">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <Hero
        eyebrow={tr('Quotations & Invoicing')}
        title={tr('Estimates')}
        sub={tr('Rough prices worked out for a client before a formal quotation: what is being worked on, what became a quotation and what the client said. Press a number to show only those.')}
        actions={(
          <>
            {canOpenNew && <button type="button" className="btn btn-primary" onClick={openNew}>{tr('New estimate')}</button>}
            <Link className="btn btn-secondary" to="/quotations">{tr('Quotations')}</Link>
          </>
        )}
        stats={stats} />

      <Insights items={insights.slice(0, 5)} />

      <Section id="es-steps" title={tr('From draft to an answer')} sub={tr('Where the estimates are. Press a step to show only those.')}>
        <div className="cu-stages es-steps" role="radiogroup" aria-label={tr('Step')}>
          {STEPS.map((s, i) => (
            <button key={s.key} type="button" role="radio" aria-checked={step === s.key} className={'cu-stage es-step is-' + s.key + (step === s.key ? ' is-on' : '')}
              onClick={() => { setChip('all'); setStep(step === s.key ? '' : s.key); jump('es-list'); }}>
              <strong>{counts[s.key] || 0}</strong>
              <span>{tr(s.label)}</span>
              {i < STEPS.length - 1 && <i className="cu-stage-arrow" aria-hidden="true">→</i>}
            </button>
          ))}
        </div>
      </Section>

      <Section id="es-list" title={tr('Estimates')} sub={tr('Press an estimate to see its lines and what happened to it.')}
        action={(
          <div className="ppl-view" role="radiogroup" aria-label={tr('View')}>
            {[['cards', tr('Cards')], ['list', tr('List')]].map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={view === k} className={view === k ? 'is-on' : ''} onClick={() => { setView(k); writePref('bos.estimatesView', k); }}>{label}</button>
            ))}
          </div>
        )}>
        <div className="tl-tools"><div className="tl-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search estimates…')} /></div></div>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {chips.map(([key, label, c]) => (
            <button key={key} type="button" role="radio" aria-checked={chip === key} className={'ppl-chip' + (chip === key ? ' is-on' : '')} onClick={() => { setChip(key); setStep(''); }}>
              {label} <span className="ppl-chip-n">{c}</span>
            </button>
          ))}
          {step && <button type="button" className="ppl-chip is-on" onClick={() => setStep('')}>{tr(STEPS.find((s) => s.key === step).label)} ×</button>}
        </div>
        {!visible.length ? (
          <div className="dk-empty tl-empty">
            <p>{estimates.length ? tr('Nothing matches. Try another search or filter.') : tr('No estimates yet')}</p>
            {canOpenNew && !estimates.length && <button type="button" className="btn btn-primary" onClick={openNew}>{tr('New estimate')}</button>}
          </div>
        ) : view === 'cards' ? (
          <div className="tl-grid">
            {visible.map((es) => {
              const st = stateOf(es);
              return (
                <article key={es.id} className={'tl-card' + (isPast(es) ? ' st-low' : '') + (es.status === 'archived' ? ' st-retired' : '')}>
                  <button type="button" className="tl-card-open" onClick={() => setDetail(es.id)} disabled={busyId === es.id}>
                    <Mark es={es} />
                    <span className="tl-card-head">
                      <span className="dk-muted tl-small">{es.estimateNo} · {fmtDate(es.createdAt)}</span>
                      <span className="tl-name">{es.customerName}</span>
                    </span>
                  </button>
                  <span className="tl-menu"><RowMenu disabled={busyId === es.id} actions={actionsFor(es)} /></span>
                  <p className="dk-muted tl-small es-items">{itemsLine(es) || '—'}</p>
                  <div className="tl-tags"><Status tone={st.tone}>{st.text}</Status></div>
                  <div className="tl-foot">
                    <span className="es-total">{money(es.grandTotal, es.currency)}</span>
                    <ContactButtons name={es.customerName} phone={es.customerPhone} email={es.customerEmail} />
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="tl-table-wrap">
            <table className="tl-table">
              <thead><tr><th>{tr('Estimate')}</th><th>{tr('What for')}</th><th className="is-num">{tr('Total')}</th><th>{tr('Where it stands')}</th><th>{tr('Valid until')}</th><th /></tr></thead>
              <tbody>
                {visible.map((es) => {
                  const st = stateOf(es, true);
                  return (
                    <tr key={es.id} className={es.status === 'archived' ? 'st-retired' : ''}>
                      <td><button type="button" className="tl-row-open" onClick={() => setDetail(es.id)}><Mark es={es} size={32} /><span><span className="tl-name">{es.customerName}</span><span className="dk-muted tl-small">{es.estimateNo}</span></span></button></td>
                      <td className="es-items-cell">{itemsLine(es) || '—'}</td>
                      <td className="is-num">{money(es.grandTotal, es.currency)}</td>
                      <td><Status tone={st.tone}>{st.text}</Status></td>
                      <td className={isPast(es) ? 'pk-owe' : ''}>{fmtDate(es.validUntil)}</td>
                      <td className="tl-menu-cell"><RowMenu disabled={busyId === es.id} actions={actionsFor(es)} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Glossary items={[
        [tr('Estimate'), tr('A rough price worked out for a client. It is not sent as a formal offer; that is what a quotation is for.')],
        [tr('Draft'), tr('Still being worked on. Only a draft can be changed.')],
        [tr('Ready'), tr('The prices are checked and it can be made into a quotation.')],
        [tr('Made into a quotation'), tr('A quotation was made from it with the same lines and totals. What the client said shows next to it.')],
        [tr('Put away'), tr('No longer being worked on. It can be brought back as a draft.')],
        [tr('Valid until'), tr('The date the prices hold until. After it, check them again before quoting.')]
      ]} />

      {/* ── one estimate ── */}
      {cur && (
        <div className="dialog-backdrop" onClick={() => setDetail(null)}>
          <div className="dialog tl-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="tl-detail-head">
              <Mark es={cur} size={56} />
              <div>
                <span className="dk-muted tl-small">{cur.estimateNo} · {statusLabel(cur.status)}</span>
                <h2>{cur.customerName}</h2>
                <div className="tl-tags"><Status tone={stateOf(cur).tone}>{stateOf(cur).text}</Status></div>
              </div>
              <button type="button" className="tl-close" onClick={() => setDetail(null)} aria-label={tr('Close')}>×</button>
            </div>
            <ol className="es-path" aria-label={tr('Where it stands')}>
              {STEPS.map((s, i) => {
                const reached = cur.status === 'converted' ? (s.key !== 'won' || (cur.quotation && cur.quotation.status === 'accepted')) : cur.status === 'finalized' ? i <= 1 : cur.status === 'draft' ? i === 0 : false;
                const failed = s.key === 'won' && cur.quotation && ['rejected', 'expired', 'cancelled'].includes(cur.quotation.status);
                return <li key={s.key} className={(reached ? 'is-done' : '') + (failed ? ' is-failed' : '')}>{failed ? codeLabel(cur.quotation.status) : tr(s.short || s.label)}</li>;
              })}
            </ol>
            <ul className="rs-lines">
              {cur.items.map((it, i) => <li key={i}><span className="rs-qty">{it.qty}×</span><span>{it.description}<span className="dk-muted tl-small"> · {money(it.unitPrice, cur.currency)}</span></span><strong>{money(lineAmount(it), cur.currency)}</strong></li>)}
              {curTotals.map((r) => <li key={r.label} className={r.strong ? 'rs-total' : ''}><span /><span>{r.label}</span><strong>{r.value}</strong></li>)}
            </ul>
            <dl className="tl-facts">
              <div><dt>{tr('Valid until')}</dt><dd className={isPast(cur) ? 'pk-owe' : ''}>{fmtDate(cur.validUntil)}</dd></div>
              <div><dt>{tr('Made')}</dt><dd>{fmtDate(cur.createdAt)}{cur.createdByName ? ' · ' + cur.createdByName : ''}</dd></div>
              <div><dt>{tr('Currency')}</dt><dd>{cur.currency}</dd></div>
              {cur.quotation && <div><dt>{tr('Quotation')}</dt><dd><Link to={'/quotations?open=' + cur.quotation.id}>{cur.quotation.quoteNo}</Link> · {codeLabel(cur.quotation.status)}</dd></div>}
            </dl>
            <div className="tl-holder is-inline">
              <div className="tl-holder-head">
                <span className="tl-holder-name"><strong>{cur.customerName}</strong><span className="dk-muted tl-small">{[cur.customerPhone, cur.customerEmail].filter(Boolean).join(' · ') || tr('no phone or email')}</span></span>
                <ContactButtons name={cur.customerName} phone={cur.customerPhone} email={cur.customerEmail} />
              </div>
            </div>
            {cur.clientNotes && <><h3 className="tl-h3">{tr('Message to customer')}</h3><p className="tl-notes">{cur.clientNotes}</p></>}
            {cur.internalNotes && <><h3 className="tl-h3">{tr('Internal notes')}</h3><p className="tl-notes">{cur.internalNotes}</p></>}
            <div className="dialog-actions tl-actions">
              {canManage && cur.status !== 'converted' && <button type="button" className="btn btn-secondary" onClick={() => setDeleteTarget(cur)}>{tr('Delete')}</button>}
              {canManage && isOpen(cur) && <button type="button" className="btn btn-secondary" disabled={busyId === cur.id} onClick={() => archive(cur)}>{tr('Put away')}</button>}
              {canManage && cur.status === 'archived' && <button type="button" className="btn btn-secondary" disabled={busyId === cur.id} onClick={() => reopen(cur)}>{tr('Bring back')}</button>}
              {canManage && cur.status === 'draft' && <button type="button" className="btn btn-secondary" onClick={() => openEdit(cur)}>{tr('Edit')}</button>}
              <button type="button" className="btn btn-secondary" onClick={() => openPreview(cur)}>{tr('Preview')}</button>
              {canManage && cur.status === 'draft' && <button type="button" className="btn btn-secondary" disabled={busyId === cur.id} onClick={() => finalize(cur)}>{tr('Mark ready')}</button>}
              {canManage && isOpen(cur) && <button type="button" className="btn btn-primary" disabled={busyId === cur.id} onClick={() => convert(cur)}>{tr('Make into a quotation')}</button>}
              {cur.quotation && <Link className="btn btn-primary" to={'/quotations?open=' + cur.quotation.id}>{tr('Open {no}', { no: cur.quotation.quoteNo })}</Link>}
            </div>
          </div>
        </div>
      )}

      {dialogOpen && (
        <DocWizard
          title={editId ? tr('Edit estimate') : tr('New estimate')} docKind="estimate"
          detailsSlot={
            <div className="estimates-dialog-fields">
              <div className="field">
                <label htmlFor="es-customer">{tr('Customer')}</label>
                <CustomerPicker id="es-customer" customers={customers} value={form.customerId} onChange={(id) => setForm({ ...form, customerId: id })} required />
              </div>
              <div className="field">
                <label htmlFor="es-currency">{tr('Currency')}</label>
                <select id="es-currency" className="input" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
                  <option value="">{tr('Customer\'s default')}</option>
                  {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="es-valid">{tr('Valid until')}</label>
                <input id="es-valid" className="input" type="date" value={form.validUntil} onChange={(e) => setForm({ ...form, validUntil: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="es-internal">{tr('Internal notes')}</label>
                <textarea id="es-internal" className="input" value={form.internalNotes} onChange={(e) => setForm({ ...form, internalNotes: e.target.value })} placeholder={tr('Not shown to the customer')} />
              </div>
            </div>
          }
          message={form.clientNotes} onMessageChange={(v) => setForm({ ...form, clientNotes: v })} messageLabel={tr('Message to customer')}
          items={items} onItemsChange={setItems} catalogOptions={catalog}
          currency={form.currency || (customers.find((c) => c.id === form.customerId) || {}).preferredCurrency || 'GHS'}
          docDiscount={docDiscount} onDocDiscountChange={setDocDiscount}
          docTaxRate={docTaxRate} onDocTaxRateChange={setDocTaxRate}
          paymentSchedule={paymentSchedule} onPaymentScheduleChange={setPaymentSchedule}
          recapBlocks={[
            { label: tr('Customer'), value: (customers.find((c) => c.id === form.customerId) || {}).name || '—' },
            { label: tr('Valid until'), value: form.validUntil ? fmtDate(form.validUntil) : '—' }
          ]}
          submitLabel={editId ? tr('Save changes') : tr('Create estimate')} saving={saving} error={dialogError}
          onSubmit={handleSubmit} onClose={() => setDialogOpen(false)}
        />
      )}

      {deleteTarget && (
        <div className="dialog-backdrop" onClick={() => setDeleteTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Delete {estimateNo}', { estimateNo: deleteTarget.estimateNo })}</h2>
            <p className="dialog-body">{tr('This cannot be undone.')}</p>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDeleteTarget(null)}>{tr('Cancel')}</button>
              <button type="button" className="btn btn-primary" disabled={deleting} onClick={confirmDelete}>{deleting ? tr('Deleting…') : tr('Delete')}</button>
            </div>
          </div>
        </div>
      )}

      {previewEs && (
        <DocPreview
          documentType="estimate" documentId={previewEs.id}
          docLabel={docTr('Estimate #{estimateNo}', { estimateNo: previewEs.estimateNo })}
          dateLabel={docTr('Issue date')}
          dateValue={formatDocDate(previewEs.createdAt)}
          heading={docTr('Estimate for {customerName}', { customerName: previewEs.customerName })}
          subHeading={docTr('Valid until {date}', { date: formatDocDate(previewEs.validUntil) })}
          blocks={[
            { title: docTr('Customer'), lines: [previewEs.customerName, previewEs.customerEmail] },
            { title: docTr('Estimate Details'), lines: [docTr('Created {date}', { date: formatDocDate(previewEs.createdAt) }), money(previewEs.grandTotal, previewEs.currency)] },
            { title: docTr('Validity'), lines: [docTr('Valid until {date}', { date: formatDocDate(previewEs.validUntil) }), money(previewEs.grandTotal, previewEs.currency)] }
          ]}
          items={groupPackageItems(previewEs.items, previewEs.currency)}
          subtotal={money(previewEs.subtotal, previewEs.currency)}
          discountRows={adjustmentRows(previewEs, previewEs.currency).discountRows}
          taxRows={adjustmentRows(previewEs, previewEs.currency).taxRows}
          totalLabel={docTr('Grand Total')}
          total={money(previewEs.grandTotal, previewEs.currency)}
          notesLabel={docTr('Notes')}
          notesValue={previewEs.clientNotes}
          termsLabel={docTr('Terms & conditions')}
          termsValue={previewEs.terms}
          paymentSchedule={formatPaymentSchedule(previewEs.paymentSchedule, previewEs.currency)}
          onClose={() => setPreviewEs(null)}
        />
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
