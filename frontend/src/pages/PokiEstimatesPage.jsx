import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { money } from '../lib/currency';
import DocPreview from '../components/DocPreview';
import { groupPackageItems } from '../lib/packages';
import { formatPaymentSchedule } from '../lib/paymentSchedule';
import ContactButtons from '../components/ContactButtons';
import { Glossary, Hero, Insights, Section, Status, jump } from '../components/DashKit';
import './EmployeesPage.css';
import './ToolRoomPage.css';
import './PokiPages.css';
import './PokiRentals.css';
import RowMenu from '../components/RowMenu';
import RecordDialog from '../components/RecordDialog';
import { itemsForDialog, totalsForDialog } from '../lib/docItems';

import { activeIntlLocale, docTr, msg, tr, trNodes } from '../lib/i18n.jsx';
import { formatDocDate } from '../lib/dates';
import { codeLabel } from '../lib/codeLabels.js';
// Letting offers — what a unit costs to take, quoted before any booking
// exists.
//
// The point of this screen over the general estimate builder is that the
// numbers come from the unit itself. Pick a unit, say how many periods of
// rent are wanted up front and how many months of deposit, and the offer
// is costed from the unit's own terms — including whatever its utility
// arrangement is, which is the question every prospect asks. The lines
// stay fully editable afterwards; the pre-fill is a starting point, not a
// rule.
//
// When the prospect accepts, the offer converts to a DRAFT booking on that
// unit. Draft, not active: activating is the deliberate step that checks
// the unit is still free and flips it to occupied.
//
// Same "explains itself" layout as the dashboards (components/DashKit.jsx):
// the key numbers (drafts not sent, offers out waiting for an answer, offers
// accepted this year and how many of the offers sent that is, empty units
// with no offer out), what stands out (an offer past its date, one sent a
// week ago with no answer, a unit on an offer that has since been let),
// and the offers as cards or a list, with a call or WhatsApp button to
// chase the prospect.

const KINDS = [
  { value: 'letting', label: msg('Letting offer') },
  { value: 'maintenance', label: msg('Repair / fit-out quote') },
  { value: 'other', label: msg('Other') }
];

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).length > 10 ? iso : iso + 'T00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(activeIntlLocale(), { day: '2-digit', month: 'short', year: 'numeric' });
}

function addYear(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00');
  if (Number.isNaN(d.getTime())) return '';
  d.setFullYear(d.getFullYear() + 1);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

const blankLine = () => ({ description: '', qty: 1, unit: 'each', unitPrice: '', notes: '' });

const EMPTY = {
  docKind: 'letting', tenantId: '', unitId: '', rentPeriods: 1, depositMonths: 1,
  validUntil: '', clientNotes: '', internalNotes: '', terms: '', items: [blankLine()]
};

function kindLabel(k) { return tr((KINDS.find((x) => x.value === k) || KINDS[2]).label); }

// A finalized letting offer has gone to the customer and a converted one
// has become a booking, so the list says Sent and Booked.
function offerStatusLabel(status) {
  if (status === 'converted') return tr('Booked');
  if (status === 'finalized') return codeLabel('sent');
  return codeLabel(status);
}

export default function PokiEstimatesPage() {
  const { can } = useAuth();
  const canManage = can('poki.manage');

  const [estimates, setEstimates] = useState([]);
  const [units, setUnits] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [search, setSearch] = useState('');
  const [chip, setChip] = useState('open');
  const [view, setView] = useState(() => { try { return localStorage.getItem('bos.pokiOffersView') || 'cards'; } catch { return 'cards'; } });
  const [busyId, setBusyId] = useState(null);
  const [standardTerms, setStandardTerms] = useState('');
  const [detail, setDetail] = useState(null);

  const [dialog, setDialog] = useState(null); // 'offer' | 'convert'
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [convert, setConvert] = useState(null);
  const [previewEst, setPreviewEst] = useState(null);
  const [dialogError, setDialogError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [building, setBuilding] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [e, u, t, terms] = await Promise.all([
        api.get('/poki/estimates'), api.get('/poki/units'), api.get('/poki/tenants'),
        // The standard block, so a new offer starts with it and an edited one
        // can be put back to it.
        api.get('/poki/offer-terms').catch(() => ({ terms: '' }))
      ]);
      setEstimates(e);
      setUnits(u);
      setTenants(t);
      setStandardTerms(terms.terms || '');
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

  // The row carries enough to list, but printing needs the line items and
  // Poki's letterhead, so fetch the full record.
  async function openPreview(est) {
    setError(null);
    try {
      setPreviewEst(await api.get('/poki/estimates/' + est.id));
    } catch (err) {
      setError(err.message);
    }
  }

  function openOffer(est) {
    setDialogError(null);
    setEditId(est ? est.id : null);
    if (est) {
      const tenant = tenants.find((t) => t.customerId === est.customerId);
      setForm({
        ...EMPTY, docKind: est.docKind, tenantId: tenant ? tenant.id : '', unitId: est.unitId || '',
        validUntil: est.validUntil ? String(est.validUntil).slice(0, 10) : '',
        clientNotes: est.clientNotes || '', internalNotes: est.internalNotes || '',
        terms: est.terms || '',
        items: est.items.length ? est.items.map((i) => ({ ...i })) : [blankLine()]
      });
    } else {
      setForm({ ...EMPTY, items: [blankLine()], terms: standardTerms });
    }
    setDialog('offer');
  }

  // Ask the server to cost the unit. Deliberately a round trip rather than
  // duplicating the deposit maths here — the monthly-equivalent rule for a
  // quarterly or annual unit lives in one place on the server, and a copy
  // in the browser would be a second place for it to drift.
  async function buildFromUnit() {
    if (!form.unitId) { setDialogError(tr('Pick a unit first.')); return; }
    setBuilding(true);
    setDialogError(null);
    try {
      const d = await api.post('/poki/estimates/letting-draft', {
        unitId: form.unitId, rentPeriods: form.rentPeriods, depositMonths: form.depositMonths
      });
      setForm((f) => ({
        ...f, items: d.items, clientNotes: d.clientNotes,
        // Show the validity date the offer will actually carry rather
        // than leaving the field blank and stamping one on save.
        validUntil: f.validUntil || d.validUntil
      }));
      setToast(tr('Costed from {propertyName} · {unitCode}.', { propertyName: d.propertyName, unitCode: d.unitCode }));
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setBuilding(false);
    }
  }

  function setItem(idx, key, value) {
    setForm((f) => {
      const items = f.items.map((it, i) => (i === idx ? { ...it, [key]: value } : it));
      return { ...f, items };
    });
  }
  const addLine = () => setForm((f) => ({ ...f, items: [...f.items, blankLine()] }));
  const dropLine = (idx) => setForm((f) => ({
    ...f, items: f.items.length > 1 ? f.items.filter((_, i) => i !== idx) : f.items
  }));

  async function submitOffer(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      const payload = {
        docKind: form.docKind, tenantId: form.tenantId, unitId: form.unitId || undefined,
        validUntil: form.validUntil || undefined, clientNotes: form.clientNotes,
        // Always sent, so clearing the box genuinely removes the terms rather
        // than falling back to the standard block.
        terms: form.terms,
        internalNotes: form.internalNotes,
        items: form.items.filter((i) => String(i.description).trim())
      };
      if (editId) await api.patch('/poki/estimates/' + editId, payload);
      else await api.post('/poki/estimates', payload);
      setToast(editId ? tr('Offer updated.') : tr('Offer created.'));
      setDialog(null);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(est, status) {
    setBusyId(est.id);
    try {
      await api.post('/poki/estimates/' + est.id + '/status', { status });
      setToast(tr('Marked {status}.', { status: offerStatusLabel(status) }));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(est) {
    if (!window.confirm(tr('Delete {estimateNo}?', { estimateNo: est.estimateNo }))) return;
    setBusyId(est.id);
    try {
      await api.delete('/poki/estimates/' + est.id);
      setToast(tr('Deleted {estimateNo}.', { estimateNo: est.estimateNo }));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  // Pre-fill the booking terms from the offer and the unit it quoted, then
  // let the operator confirm. What is confirmed here is what gets written —
  // the figures are never re-derived from the line descriptions, which the
  // operator may well have edited.
  function openConvert(est) {
    const unit = units.find((u) => u.id === est.unitId);
    // "Rent (days) — ..." must not be mistaken for the months line: it
    // starts with "Rent" too, and matching it first would read the day
    // count as a number of months.
    const dayLine = est.items.find((i) => /^rent \(days\)/i.test(i.description || ''));
    const rentLine = est.items.find((i) => /^rent/i.test(i.description || '') && i !== dayLine);
    const depLine = est.items.find((i) => /deposit/i.test(i.description || ''));
    const start = new Date().toISOString().slice(0, 10);
    setDialogError(null);
    setConvert({
      est,
      startDate: start,
      // The offer already priced a duration; carry its months and days
      // across rather than defaulting to a year, so the booking matches
      // what the tenant accepted.
      durationMonths: rentLine ? rentLine.qty : 12,
      durationDays: dayLine ? dayLine.qty : 0,
      monthlyRate: rentLine ? rentLine.unitPrice : (unit ? unit.baseRent : ''),
      dailyRate: dayLine ? dayLine.unitPrice : (unit ? unit.dailyRate : ''),
      depositAmount: depLine ? depLine.unitPrice : '',
      escalationPercent: ''
    });
    setDialog('convert');
  }

  async function submitConvert(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      const res = await api.post('/poki/estimates/' + convert.est.id + '/convert-to-booking', {
        startDate: convert.startDate,
        durationMonths: convert.durationMonths, durationDays: convert.durationDays,
        monthlyRate: convert.monthlyRate, dailyRate: convert.dailyRate,
        depositAmount: convert.depositAmount,
        escalationPercent: convert.escalationPercent
      });
      setToast(tr('Created draft booking {bookingNo}. Activate it on the Bookings screen.', { bookingNo: res.booking.bookingNo }));
      setDialog(null);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  const set = (k) => (ev) => setForm({ ...form, [k]: ev.target.value });
  const setConv = (k) => (ev) => setConvert({ ...convert, [k]: ev.target.value });
  const vacantUnits = units.filter((u) => u.status === 'vacant' || u.id === form.unitId);
  // The offer is priced in the unit's currency — the backend takes it from
  // there too (pokiEstimates.service.js). The editor used to label every line
  // and the total "GHS" whatever the unit was, so a unit let at USD 381.60
  // showed as GHS 381.60 and totalled GHS 763.20: the right number under the
  // wrong currency, which on a letting offer is a figure a prospect could
  // hold you to.
  const formCurrency = (units.find((u) => u.id === form.unitId) || {}).currency || 'GHS';
  const formTotal = form.items.reduce(
    (s, i) => s + (Number(i.qty) || 0) * (Number(i.unitPrice) || 0), 0
  );

  // One list, used by the row menu and by the record panel.
  function rowActionsFor(e) {
    return [
      { label: tr('Print'), onClick: () => openPreview(e) },
      { label: tr('Edit'), onClick: () => openOffer(e), hidden: !(canManage && e.status === 'draft') },
      { label: tr('Mark sent'), onClick: () => setStatus(e, 'finalized'), disabled: busyId === e.id, hidden: !(canManage && e.status === 'draft') },
      { label: tr('Accept → booking'), onClick: () => openConvert(e), hidden: !(canManage && e.docKind === 'letting' && e.status !== 'converted' && e.status !== 'archived') },
      { label: tr('Delete'), onClick: () => remove(e), disabled: busyId === e.id, danger: true, hidden: !(canManage && e.status !== 'converted') },
    ];
  }

  // ── what the page shows ────────────────────────────────────────────
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const daysSince = (d) => (d ? Math.round((today - new Date(String(d).slice(0, 10) + 'T00:00')) / 86400000) : null);
  const drafts = estimates.filter((e) => e.status === 'draft');
  const sent = estimates.filter((e) => e.status === 'finalized');
  const lapsed = sent.filter((e) => e.validUntil && daysSince(e.validUntil) > 0);
  const waiting = sent.filter((e) => !lapsed.includes(e));
  const stale = waiting.filter((e) => daysSince(e.createdAt) >= 7);
  const takenElsewhere = [...drafts, ...sent].filter((e) => e.docKind === 'letting' && e.unitId && e.unitStatus === 'occupied');
  const year = String(new Date().getFullYear());
  const accepted = estimates.filter((e) => e.status === 'converted' && String(e.createdAt).slice(0, 4) === year);
  const decided = estimates.filter((e) => (e.status === 'converted' || e.status === 'finalized' || e.status === 'archived') && String(e.createdAt).slice(0, 4) === year);
  const offeredUnits = new Set([...drafts, ...sent].map((e) => e.unitId).filter(Boolean));
  const emptyNoOffer = units.filter((u) => u.status === 'vacant' && u.active !== false && !offeredUnits.has(u.id) && !u.nextBookingStart);

  function showOnly(key) { setChip(chip === key ? 'open' : key); jump('pk-offers'); }
  const stats = [
    { icon: 'doc', value: String(drafts.length), label: tr('drafts not sent'), note: drafts.length ? tr('finish and send them') : tr('nothing waiting to go out'), onClick: () => showOnly('draft') },
    { icon: 'send', value: String(waiting.length), label: tr('out, waiting for an answer'), note: lapsed.length ? tr('{n} past their date', { n: lapsed.length }) : stale.length ? tr('{n} sent over a week ago', { n: stale.length }) : tr('none past their date'), tone: lapsed.length ? 'alert' : '', onClick: () => showOnly('sent') },
    { icon: 'check', value: String(accepted.length), label: tr('accepted this year'), note: decided.length ? tr('{pct}% of the offers made', { pct: Math.round((accepted.length / decided.length) * 100) }) : tr('none made yet this year'), tone: accepted.length ? 'good' : '', onClick: () => showOnly('converted') },
    { icon: 'drawer', value: String(emptyNoOffer.length), label: tr('empty units with no offer'), note: emptyNoOffer.length ? emptyNoOffer.slice(0, 3).map((u) => u.code).join(', ') + (emptyNoOffer.length > 3 ? '…' : '') : tr('every empty unit is on offer'), tone: emptyNoOffer.length ? 'alert' : 'good', onClick: () => canManage && emptyNoOffer.length && tenants.length && openOffer(null) }
  ];

  const insights = [];
  if (takenElsewhere.length) insights.push({ tone: 'bad', icon: 'warn', text: takenElsewhere.length === 1 ? tr('{no} offers {unit}, which has since been let. Withdraw it or offer another unit.', { no: takenElsewhere[0].estimateNo, unit: takenElsewhere[0].unitCode }) : tr('{n} open offers are for units that have since been let.', { n: takenElsewhere.length }), action: { label: tr('Show them'), run: () => showOnly('taken') } });
  if (lapsed.length) insights.push({ tone: 'warn', icon: 'calendar', text: lapsed.length === 1 ? tr('The offer to {name} for {unit} ran out on {date}.', { name: lapsed[0].customerName, unit: lapsed[0].unitCode || '—', date: fmtDate(lapsed[0].validUntil) }) : tr('{n} offers are past the date they were valid until.', { n: lapsed.length }), action: { label: tr('Show them'), run: () => showOnly('lapsed') } });
  if (stale.length) insights.push({ tone: 'info', icon: 'phone', text: stale.length === 1 ? tr('{name} has had the offer for {unit} for {n} days with no answer. Give them a call.', { name: stale[0].customerName, unit: stale[0].unitCode || '—', n: daysSince(stale[0].createdAt) }) : tr('{n} offers were sent over a week ago with no answer.', { n: stale.length }), action: { label: tr('Show them'), run: () => showOnly('sent') } });
  if (drafts.length) insights.push({ tone: 'info', icon: 'doc', text: drafts.length === 1 ? tr('{no} for {name} is still a draft — mark it sent once it has gone out.', { no: drafts[0].estimateNo, name: drafts[0].customerName }) : tr('{n} offers are still drafts.', { n: drafts.length }), action: { label: tr('Show them'), run: () => showOnly('draft') } });
  if (emptyNoOffer.length) insights.push({ tone: 'warn', icon: 'drawer', text: emptyNoOffer.length === 1 ? tr('{unit} at {property} is empty and nobody has been offered it.', { unit: emptyNoOffer[0].code, property: emptyNoOffer[0].propertyName }) : tr('{n} empty units have no offer out.', { n: emptyNoOffer.length }), action: canManage && tenants.length ? { label: tr('Make an offer'), run: () => openOffer(null) } : null });
  if (!insights.length && estimates.length) insights.push({ tone: 'good', icon: 'check', text: tr('Every offer is out and in date, and every empty unit is on offer.') });

  const chipTest = {
    open: (e) => e.status === 'draft' || e.status === 'finalized', draft: (e) => e.status === 'draft', sent: (e) => waiting.includes(e),
    lapsed: (e) => lapsed.includes(e), taken: (e) => takenElsewhere.includes(e), converted: (e) => e.status === 'converted',
    archived: (e) => e.status === 'archived', all: () => true
  };
  const visible = estimates.filter(chipTest[chip] || chipTest.open)
    .filter((e) => matchesQuery(search, e.estimateNo, e.customerName, e.unitCode, e.propertyName));
  const chips = [
    ['open', tr('Open'), drafts.length + sent.length], ['draft', tr('Draft'), drafts.length], ['sent', tr('Waiting for an answer'), waiting.length],
    ['lapsed', tr('Past their date'), lapsed.length], ['taken', tr('Unit since let'), takenElsewhere.length],
    ['converted', tr('Became a booking'), estimates.filter(chipTest.converted).length], ['archived', tr('Archived'), estimates.filter(chipTest.archived).length], ['all', tr('All'), estimates.length]
  ].filter(([k, , c]) => c > 0 || k === 'open' || k === chip);
  function stateOf(e) {
    if (e.status === 'converted') return { tone: 'good', text: e.bookingNo ? tr('Booked · {no}', { no: e.bookingNo }) : tr('Booked') };
    if (e.status === 'archived') return { tone: 'muted', text: codeLabel('archived') };
    if (takenElsewhere.includes(e)) return { tone: 'bad', text: tr('Unit since let') };
    if (lapsed.includes(e)) return { tone: 'warn', text: tr('Ran out {date}', { date: fmtDate(e.validUntil) }) };
    if (e.status === 'draft') return { tone: 'muted', text: tr('Draft — not sent') };
    return { tone: 'info', text: e.validUntil ? tr('Sent · good until {date}', { date: fmtDate(e.validUntil) }) : tr('Sent') };
  }
  const tenantFor = (e) => tenants.find((t) => t.customerId === e.customerId);

  return (
    <div className="dk tl pk">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <Hero
        eyebrow={tr('Poki Rentals')}
        title={tr('Letting offers')}
        sub={tr('What a unit costs to take, quoted to a prospect before any booking exists — costed from the unit\'s own rent, deposit and utilities. Accepted, it becomes a draft booking. Press a number to show only those.')}
        actions={canManage && <button type="button" className="btn btn-primary" disabled={!tenants.length} onClick={() => openOffer(null)}>{tr('New offer')}</button>}
        stats={stats} />

      <Insights items={insights.slice(0, 5)} />

      <Section id="pk-offers" title={tr('Offers')} sub={tr('Press an offer for its lines and totals.')}
        action={(
          <div className="ppl-view" role="radiogroup" aria-label={tr('View')}>
            {[['cards', tr('Cards')], ['list', tr('List')]].map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={view === k} className={view === k ? 'is-on' : ''} onClick={() => { setView(k); try { localStorage.setItem('bos.pokiOffersView', k); } catch { /* this visit only */ } }}>{label}</button>
            ))}
          </div>
        )}>
        <div className="tl-tools"><div className="tl-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search offers…')} /></div></div>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {chips.map(([key, label, c]) => (
            <button key={key} type="button" role="radio" aria-checked={chip === key} className={'ppl-chip' + (chip === key ? ' is-on' : '')} onClick={() => setChip(key)}>
              {label} <span className="ppl-chip-n">{c}</span>
            </button>
          ))}
        </div>
        {!visible.length ? (
          <div className="dk-empty tl-empty">
            <p>{estimates.length ? tr('Try a different search or status filter.') : tenants.length
              ? tr('Quote a prospect what a unit costs to take. The offer is costed from the unit’s own rent, deposit and utility terms, and becomes a booking once accepted.')
              : tr('Add someone to the tenant register first — a prospect who hasn’t signed still belongs there.')}</p>
            {!tenants.length && <Link className="btn btn-secondary" to="/pokitenants">{tr('Tenants')}</Link>}
          </div>
        ) : view === 'cards' ? (
          <div className="tl-grid">
            {visible.map((e) => {
              const st = stateOf(e);
              const t = tenantFor(e);
              return (
                <article key={e.id} className={'tl-card' + (st.tone === 'bad' ? ' st-late' : st.tone === 'warn' ? ' st-low' : '') + (e.status === 'archived' ? ' st-retired' : '')}>
                  <button type="button" className="tl-card-open" onClick={() => setDetail(e)}>
                    <span className={'pk-unit-code' + (e.status === 'converted' ? ' is-let' : '')}>{e.unitCode || '—'}</span>
                    <span className="tl-card-head">
                      <span className="dk-muted tl-small">{e.estimateNo} · {kindLabel(e.docKind)}{e.propertyName ? ' · ' + e.propertyName : ''}</span>
                      <span className="tl-name">{e.customerName}</span>
                    </span>
                  </button>
                  <span className="tl-menu"><RowMenu actions={rowActionsFor(e)} /></span>
                  <div className="tl-tags"><Status tone={st.tone}>{st.text}</Status></div>
                  <div className="tl-foot">
                    <span className="tl-small"><strong>{money(e.grandTotal, e.currency)}</strong> <span className="dk-muted">{tr('to take it')}</span></span>
                    <ContactButtons name={e.customerName} phone={e.customerPhone || (t && t.phone)} email={e.customerEmail} />
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="tl-table-wrap">
            <table className="tl-table">
              <thead><tr><th>{tr('Offer')}</th><th>{tr('Unit')}</th><th className="is-num">{tr('Total')}</th><th>{tr('Status')}</th><th /></tr></thead>
              <tbody>
                {visible.map((e) => {
                  const st = stateOf(e);
                  return (
                    <tr key={e.id} className={e.status === 'archived' ? 'st-retired' : ''}>
                      <td><button type="button" className="tl-row-open" onClick={() => setDetail(e)}><span><span className="tl-name">{e.customerName}</span><span className="dk-muted tl-small">{e.estimateNo} · {kindLabel(e.docKind)}</span></span></button></td>
                      <td>{e.unitCode || '—'}{e.propertyName && <div className="dk-muted tl-small">{e.propertyName}</div>}</td>
                      <td className="is-num">{money(e.grandTotal, e.currency)}</td>
                      <td><Status tone={st.tone}>{st.text}</Status></td>
                      <td className="tl-menu-cell"><RowMenu actions={rowActionsFor(e)} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Glossary items={[
        [tr('Letting offer'), tr('What a prospect would pay to take a unit: rent up front, the deposit and the utility terms, with a date it is good until.')],
        [tr('Sent'), tr('Marked as gone out to the prospect. It can no longer be edited, only accepted or withdrawn.')],
        [tr('Accept'), tr('Turns the offer into a draft booking on the unit. Activating the booking is what puts the tenant in.')],
        [tr('Unit since let'), tr('Someone else took the unit after the offer was made. The offer can no longer be honoured as it stands.')]
      ]} />

      {dialog === 'offer' && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <form className="dialog poki-dialog poki-offer-dialog" onClick={(ev) => ev.stopPropagation()} onSubmit={submitOffer}>
            <h2 className="poki-dialog-title">{editId ? tr('Edit offer') : tr('New letting offer')}</h2>
            {dialogError && <div className="error-banner poki-dialog-span">{dialogError}</div>}

            <div className="field">
              <label htmlFor="pe-kind">{tr('Kind')}</label>
              <select id="pe-kind" className="input" value={form.docKind} onChange={set('docKind')} disabled={!!editId}>
                {KINDS.map((k) => <option key={k.value} value={k.value}>{tr(k.label)}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="pe-tenant">{tr('Prospect / tenant')}</label>
              <select id="pe-tenant" className="input" value={form.tenantId} onChange={set('tenantId')} required>
                <option value="">{tr('Choose from the register…')}</option>
                {tenants.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}{t.status === 'prospect' ? tr(' (prospect)') : ''}</option>
                ))}
              </select>
            </div>

            <div className="field poki-dialog-span">
              <label htmlFor="pe-unit">{tr('Unit being offered')}</label>
              <select id="pe-unit" className="input" value={form.unitId} onChange={set('unitId')} required={form.docKind === 'letting'}>
                <option value="">{form.docKind === 'letting' ? tr('Choose a vacant unit…') : tr('No particular unit')}</option>
                {vacantUnits.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.propertyName} · {u.code}{u.name ? ' — ' + u.name : ''} · {money(u.baseRent, u.currency)}
                  </option>
                ))}
              </select>
            </div>

            {form.docKind === 'letting' && (
              <>
                <div className="field">
                  <label htmlFor="pe-periods">{tr('Rent up front (periods)')}</label>
                  <input id="pe-periods" className="input" type="number" min="1" value={form.rentPeriods} onChange={set('rentPeriods')} />
                </div>
                <div className="field">
                  <label htmlFor="pe-deposit">{tr('Deposit (months of rent)')}</label>
                  <input id="pe-deposit" className="input" type="number" min="0" step="0.5" value={form.depositMonths} onChange={set('depositMonths')} />
                </div>
                <div className="poki-dialog-span">
                  <button type="button" className="btn btn-secondary" disabled={building || !form.unitId} onClick={buildFromUnit}>
                    {building ? tr('Costing…') : tr('Cost it from the unit')}
                  </button>
                  <p className="poki-dialog-hint" style={{ marginTop: 6 }}>
                    {tr('Fills the lines below from the unit’s rent, deposit and utility terms. Everything stays editable afterwards.')}
                  </p>
                </div>
              </>
            )}

            <div className="poki-dialog-span">
              <div className="poki-lines-head">
                <span>{tr('Lines')}</span>
                <span className="poki-muted">{tr('Total')} {money(formTotal, formCurrency)}</span>
              </div>
              {form.items.map((it, idx) => (
                <div className="poki-line-row" key={idx}>
                  <input
                    className="input" placeholder={tr('Description')} value={it.description}
                    onChange={(ev) => setItem(idx, 'description', ev.target.value)}
                    aria-label={tr('Line {n} description', { n: idx + 1 })}
                  />
                  <input
                    className="input" type="number" step="0.01" placeholder={tr('Qty')} value={it.qty}
                    onChange={(ev) => setItem(idx, 'qty', ev.target.value)}
                    aria-label={tr('Line {n} quantity', { n: idx + 1 })}
                  />
                  <input
                    className="input" placeholder={tr('Unit')} value={it.unit || ''}
                    onChange={(ev) => setItem(idx, 'unit', ev.target.value)}
                    aria-label={tr('Line {n} unit', { n: idx + 1 })}
                  />
                  <input
                    className="input" type="number" step="0.01" placeholder={tr('Price')} value={it.unitPrice}
                    onChange={(ev) => setItem(idx, 'unitPrice', ev.target.value)}
                    aria-label={tr('Line {n} price', { n: idx + 1 })}
                  />
                  <span className="poki-line-total">{money((Number(it.qty) || 0) * (Number(it.unitPrice) || 0), formCurrency)}</span>
                  <button type="button" className="btn btn-secondary poki-row-btn" onClick={() => dropLine(idx)} aria-label={tr('Remove line {n}', { n: idx + 1 })}>×</button>
                </div>
              ))}
              <button type="button" className="btn btn-secondary poki-row-btn" onClick={addLine}>{tr('Add line')}</button>
            </div>

            <div className="field">
              <label htmlFor="pe-valid">{tr('Valid until')}</label>
              <input id="pe-valid" className="input" type="date" value={form.validUntil} onChange={set('validUntil')} />
            </div>
            <div className="field poki-dialog-span">
              <label htmlFor="pe-notes">{tr('Notes to the prospect')}</label>
              <textarea id="pe-notes" className="input" rows={2} value={form.clientNotes} onChange={set('clientNotes')} />
            </div>
            <div className="field poki-dialog-span">
              <div className="poki-terms-head">
                <label htmlFor="pe-terms">{tr('Terms on this offer')}</label>
                <span className="poki-terms-actions">
                  {form.terms !== standardTerms && standardTerms && (
                    <button type="button" className="btn btn-secondary poki-terms-btn"
                      onClick={() => setForm((f) => ({ ...f, terms: standardTerms }))}>
                      {tr('Use the standard terms')}
                    </button>
                  )}
                  {form.terms && (
                    <button type="button" className="btn btn-secondary poki-terms-btn"
                      onClick={() => setForm((f) => ({ ...f, terms: '' }))}>
                      {tr('Remove terms')}
                    </button>
                  )}
                </span>
              </div>
              <textarea
                id="pe-terms" className="input poki-terms-box" rows={8}
                value={form.terms} onChange={set('terms')}
                placeholder={tr('No terms will be printed on this offer.')}
              />
              <div className="poki-muted poki-terms-hint">
                {form.terms
                  ? tr('Printed at the foot of the offer. Edit freely — this copy belongs to this offer alone.')
                  : tr('This offer will print with no terms block.')}
              </div>
            </div>

            <div className="poki-dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : tr('Save offer')}</button>
            </div>
          </form>
        </div>
      )}

      {dialog === 'convert' && convert && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <form className="dialog poki-dialog" onClick={(ev) => ev.stopPropagation()} onSubmit={submitConvert}>
            <h2 className="poki-dialog-title">{tr('Accept {estimateNo}', { estimateNo: convert.est.estimateNo })}</h2>
            <p className="poki-dialog-hint poki-dialog-span">
              {trNodes('{offer}. This creates a {draft} booking — activate it on the Bookings screen once it is signed, which is what marks the unit occupied.', {
                offer: [convert.est.customerName, convert.est.propertyName, convert.est.unitCode].join(' · '),
                draft: <strong>{tr('draft')}</strong>
              })}
            </p>
            {dialogError && <div className="error-banner poki-dialog-span">{dialogError}</div>}

            <div className="field">
              <label htmlFor="pc-start">{tr('Start date')}</label>
              <input id="pc-start" className="input" type="date" value={convert.startDate} onChange={setConv('startDate')} required />
            </div>
            <div className="field">
              <label htmlFor="pc-months">{tr('Months')}</label>
              <input id="pc-months" className="input" type="number" min="0" step="1" value={convert.durationMonths} onChange={setConv('durationMonths')} />
            </div>
            <div className="field">
              <label htmlFor="pc-days">{tr('…plus days')}</label>
              <input id="pc-days" className="input" type="number" min="0" step="1" value={convert.durationDays} onChange={setConv('durationDays')} />
            </div>
            <div className="field">
              <label htmlFor="pc-rate">{tr('Rent per month')}</label>
              <input id="pc-rate" className="input" type="number" step="0.01" value={convert.monthlyRate} onChange={setConv('monthlyRate')} required />
            </div>
            <div className="field">
              <label htmlFor="pc-dep">{tr('Deposit due')}</label>
              <input id="pc-dep" className="input" type="number" step="0.01" value={convert.depositAmount} onChange={setConv('depositAmount')} />
            </div>
            <div className="field">
              <label htmlFor="pc-daily">{tr('Rent per day')}</label>
              <input id="pc-daily" className="input" type="number" step="0.01" value={convert.dailyRate || ''} onChange={setConv('dailyRate')} placeholder={tr('from the unit')} />
            </div>
            <div className="field">
              <label htmlFor="pc-esc">{tr('Renewal increase (%)')}</label>
              <input id="pc-esc" className="input" type="number" step="0.01" value={convert.escalationPercent} onChange={setConv('escalationPercent')} placeholder={tr('e.g. 10')} />
            </div>

            <div className="poki-dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Creating…') : tr('Create draft booking')}</button>
            </div>
          </form>
        </div>
      )}

      {previewEst && (
        <DocPreview
          documentType="estimate" documentId={previewEst.id}
          company={previewEst.company}
          shareApi={{
            create: (expiresInDays) => api.post('/poki/estimates/' + previewEst.id + '/share', { expiresInDays: expiresInDays || undefined }),
            whatsapp: (url) => api.post('/poki/estimates/' + previewEst.id + '/share/whatsapp', { url })
          }}
          docLabel={docTr('Offer #{estimateNo}', { estimateNo: previewEst.estimateNo })}
          dateLabel={docTr('Valid until')}
          dateValue={formatDocDate(previewEst.validUntil)}
          heading={docTr('Letting offer for {customerName}', { customerName: previewEst.customerName })}
          subHeading={previewEst.unitCode ? previewEst.propertyName + ' \u00b7 ' + previewEst.unitCode : ''}
          blocks={[
            { title: docTr('Prospect'), lines: [previewEst.customerName, previewEst.customerEmail || previewEst.customerPhone || ''] },
            { title: docTr('Unit'), lines: [previewEst.unitCode || '—', previewEst.propertyName || ''] },
            { title: docTr('Offer'), lines: [docTr('Valid until {date}', { date: formatDocDate(previewEst.validUntil) }), money(previewEst.grandTotal, previewEst.currency)] }
          ]}
          items={groupPackageItems(previewEst.items, previewEst.currency)}
          subtotal={money(previewEst.subtotal, previewEst.currency)}
          totalLabel={docTr('Total')}
          total={money(previewEst.grandTotal, previewEst.currency)}
          notesLabel={docTr('Notes')}
          notesValue={previewEst.clientNotes}
          termsLabel={docTr('Terms')}
          termsValue={previewEst.terms}
          paymentSchedule={formatPaymentSchedule(previewEst.paymentSchedule, previewEst.currency)}
          onClose={() => setPreviewEst(null)}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
      {detail && (
        <RecordDialog
          title={detail.estimateNo}
          subtitle={detail.customerName}
          tag={<span className={'poki-chip poki-chip-' + (detail.status === 'converted' ? 'active' : detail.status === 'finalized' ? 'expiring' : 'open')}>{offerStatusLabel(detail.status)}</span>}
          actions={rowActionsFor(detail)}
          onClose={() => setDetail(null)}
          items={itemsForDialog(detail.items, detail.currency)}
          totals={totalsForDialog(detail, detail.currency)}
          fields={[
            { label: tr('Kind'), value: kindLabel(detail.docKind) },
            { label: tr('Unit'), value: detail.unitCode },
            { label: tr('Property'), value: detail.propertyName },
            { label: tr('Valid until'), value: fmtDate(detail.validUntil) },
            { label: tr('Booking'), value: detail.bookingNo },
            { label: tr('Notes'), value: detail.clientNotes, wide: true },
          ]}
        />
      )}

    </div>
  );
}
