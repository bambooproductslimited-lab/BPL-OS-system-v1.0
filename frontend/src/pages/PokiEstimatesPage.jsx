import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { money } from '../lib/currency';
import DocPreview from '../components/DocPreview';
import { groupPackageItems } from '../lib/packages';
import { formatPaymentSchedule } from '../lib/paymentSchedule';
import './PokiPages.css';
import RowMenu from '../components/RowMenu';
import RecordDialog from '../components/RecordDialog';
import { itemsForDialog, totalsForDialog } from '../lib/docItems';

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

const KINDS = [
  { value: 'letting', label: 'Letting offer' },
  { value: 'maintenance', label: 'Repair / fit-out quote' },
  { value: 'other', label: 'Other' }
];

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).length > 10 ? iso : iso + 'T00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
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
  validUntil: '', clientNotes: '', internalNotes: '', items: [blankLine()]
};

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
  const [statusFilter, setStatusFilter] = useState('');
  const [busyId, setBusyId] = useState(null);
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
      const [e, u, t] = await Promise.all([
        api.get('/poki/estimates'), api.get('/poki/units'), api.get('/poki/tenants')
      ]);
      setEstimates(e);
      setUnits(u);
      setTenants(t);
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
        items: est.items.length ? est.items.map((i) => ({ ...i })) : [blankLine()]
      });
    } else {
      setForm({ ...EMPTY, items: [blankLine()] });
    }
    setDialog('offer');
  }

  // Ask the server to cost the unit. Deliberately a round trip rather than
  // duplicating the deposit maths here — the monthly-equivalent rule for a
  // quarterly or annual unit lives in one place on the server, and a copy
  // in the browser would be a second place for it to drift.
  async function buildFromUnit() {
    if (!form.unitId) { setDialogError('Pick a unit first.'); return; }
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
      setToast('Costed from ' + d.propertyName + ' · ' + d.unitCode + '.');
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
        internalNotes: form.internalNotes,
        items: form.items.filter((i) => String(i.description).trim())
      };
      if (editId) await api.patch('/poki/estimates/' + editId, payload);
      else await api.post('/poki/estimates', payload);
      setToast(editId ? 'Offer updated.' : 'Offer created.');
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
      setToast('Marked ' + status + '.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(est) {
    if (!window.confirm('Delete ' + est.estimateNo + '?')) return;
    setBusyId(est.id);
    try {
      await api.delete('/poki/estimates/' + est.id);
      setToast('Deleted ' + est.estimateNo + '.');
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
      setToast('Created draft booking ' + res.booking.bookingNo + '. Activate it on the Bookings screen.');
      setDialog(null);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  const visible = estimates.filter((e) =>
    matchesQuery(search, e.estimateNo, e.customerName, e.unitCode, e.propertyName) &&
    (!statusFilter || e.status === statusFilter)
  );
  const set = (k) => (ev) => setForm({ ...form, [k]: ev.target.value });
  const setConv = (k) => (ev) => setConvert({ ...convert, [k]: ev.target.value });
  const vacantUnits = units.filter((u) => u.status === 'vacant' || u.id === form.unitId);
  const formTotal = form.items.reduce(
    (s, i) => s + (Number(i.qty) || 0) * (Number(i.unitPrice) || 0), 0
  );

  // One list, used by the row menu and by the record panel.
  function rowActionsFor(e) {
    return [
      { label: 'Print', onClick: () => openPreview(e) },
      { label: 'Edit', onClick: () => openOffer(e), hidden: !(canManage && e.status === 'draft') },
      { label: 'Mark sent', onClick: () => setStatus(e, 'finalized'), disabled: busyId === e.id, hidden: !(canManage && e.status === 'draft') },
      { label: 'Accept → booking', onClick: () => openConvert(e), hidden: !(canManage && e.docKind === 'letting' && e.status !== 'converted' && e.status !== 'archived') },
      { label: 'Delete', onClick: () => remove(e), disabled: busyId === e.id, danger: true, hidden: !(canManage && e.status !== 'converted') },
    ];
  }

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="poki-toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Search offers…" />
        <select className="input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status">
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="finalized">Sent</option>
          <option value="converted">Became a booking</option>
          <option value="archived">Archived</option>
        </select>
        <div className="poki-toolbar-spacer" />
        {canManage && (
          <button type="button" className="btn btn-primary" disabled={!tenants.length} onClick={() => openOffer(null)}>
            New offer
          </button>
        )}
      </div>

      {visible.length === 0 ? (
        <div className="poki-empty">
          <p className="poki-empty-title">{estimates.length ? 'No offers match' : 'No letting offers yet'}</p>
          <p className="poki-empty-sub">
            {estimates.length
              ? 'Try a different search or status filter.'
              : tenants.length
                ? 'Quote a prospect what a unit costs to take. The offer is costed from the unit’s own rent, deposit and utility terms, and becomes a booking once accepted.'
                : 'Add someone to the tenant register first — a prospect who hasn’t signed still belongs there.'}
          </p>
        </div>
      ) : (
        <div className="poki-table-wrap">
          <table className="table table-clickable">
            <thead>
              <tr>
                <th>Offer</th><th>Kind</th><th>Prospect</th><th>Unit</th><th>Valid until</th>
                <th className="poki-num">Total</th><th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((e) => (
                <tr
                  key={e.id}
                  tabIndex={0}
                  onClick={() => setDetail(e)}
                  onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setDetail(e); } }}
                >
                  <td className="poki-strong poki-nowrap">
                    {e.estimateNo}
                    {e.bookingNo && <div className="poki-muted">→ {e.bookingNo}</div>}
                  </td>
                  <td><span className="poki-chip poki-chip-open">{e.docKind}</span></td>
                  <td className="poki-nowrap">{e.customerName}</td>
                  <td className="poki-nowrap">
                    {e.unitCode || <span className="poki-muted">—</span>}
                    {e.propertyName && <div className="poki-muted">{e.propertyName}</div>}
                  </td>
                  <td className="poki-nowrap">{fmtDate(e.validUntil)}</td>
                  <td className="poki-num">{money(e.grandTotal, e.currency)}</td>
                  <td>
                    <span className={'poki-chip poki-chip-' + (e.status === 'converted' ? 'active' : e.status === 'finalized' ? 'expiring' : 'open')}>
                      {e.status === 'converted' ? 'booked' : e.status === 'finalized' ? 'sent' : e.status}
                    </span>
                  </td>
                  <td className="table-actions" onClick={(e) => e.stopPropagation()}>
                    <RowMenu actions={rowActionsFor(e)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dialog === 'offer' && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <form className="dialog poki-dialog poki-offer-dialog" onClick={(ev) => ev.stopPropagation()} onSubmit={submitOffer}>
            <h2 className="poki-dialog-title">{editId ? 'Edit offer' : 'New letting offer'}</h2>
            {dialogError && <div className="error-banner poki-dialog-span">{dialogError}</div>}

            <div className="field">
              <label htmlFor="pe-kind">Kind</label>
              <select id="pe-kind" className="input" value={form.docKind} onChange={set('docKind')} disabled={!!editId}>
                {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="pe-tenant">Prospect / tenant</label>
              <select id="pe-tenant" className="input" value={form.tenantId} onChange={set('tenantId')} required>
                <option value="">Choose from the register…</option>
                {tenants.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}{t.status === 'prospect' ? ' (prospect)' : ''}</option>
                ))}
              </select>
            </div>

            <div className="field poki-dialog-span">
              <label htmlFor="pe-unit">Unit being offered</label>
              <select id="pe-unit" className="input" value={form.unitId} onChange={set('unitId')} required={form.docKind === 'letting'}>
                <option value="">{form.docKind === 'letting' ? 'Choose a vacant unit…' : 'No particular unit'}</option>
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
                  <label htmlFor="pe-periods">Rent up front (periods)</label>
                  <input id="pe-periods" className="input" type="number" min="1" value={form.rentPeriods} onChange={set('rentPeriods')} />
                </div>
                <div className="field">
                  <label htmlFor="pe-deposit">Deposit (months of rent)</label>
                  <input id="pe-deposit" className="input" type="number" min="0" step="0.5" value={form.depositMonths} onChange={set('depositMonths')} />
                </div>
                <div className="poki-dialog-span">
                  <button type="button" className="btn btn-secondary" disabled={building || !form.unitId} onClick={buildFromUnit}>
                    {building ? 'Costing…' : 'Cost it from the unit'}
                  </button>
                  <p className="poki-dialog-hint" style={{ marginTop: 6 }}>
                    Fills the lines below from the unit’s rent, deposit and utility terms. Everything stays editable afterwards.
                  </p>
                </div>
              </>
            )}

            <div className="poki-dialog-span">
              <div className="poki-lines-head">
                <span>Lines</span>
                <span className="poki-muted">Total {money(formTotal, 'GHS')}</span>
              </div>
              {form.items.map((it, idx) => (
                <div className="poki-line-row" key={idx}>
                  <input
                    className="input" placeholder="Description" value={it.description}
                    onChange={(ev) => setItem(idx, 'description', ev.target.value)}
                    aria-label={'Line ' + (idx + 1) + ' description'}
                  />
                  <input
                    className="input" type="number" step="0.01" placeholder="Qty" value={it.qty}
                    onChange={(ev) => setItem(idx, 'qty', ev.target.value)}
                    aria-label={'Line ' + (idx + 1) + ' quantity'}
                  />
                  <input
                    className="input" placeholder="Unit" value={it.unit || ''}
                    onChange={(ev) => setItem(idx, 'unit', ev.target.value)}
                    aria-label={'Line ' + (idx + 1) + ' unit'}
                  />
                  <input
                    className="input" type="number" step="0.01" placeholder="Price" value={it.unitPrice}
                    onChange={(ev) => setItem(idx, 'unitPrice', ev.target.value)}
                    aria-label={'Line ' + (idx + 1) + ' price'}
                  />
                  <span className="poki-line-total">{money((Number(it.qty) || 0) * (Number(it.unitPrice) || 0), 'GHS')}</span>
                  <button type="button" className="btn btn-secondary poki-row-btn" onClick={() => dropLine(idx)} aria-label={'Remove line ' + (idx + 1)}>×</button>
                </div>
              ))}
              <button type="button" className="btn btn-secondary poki-row-btn" onClick={addLine}>Add line</button>
            </div>

            <div className="field">
              <label htmlFor="pe-valid">Valid until</label>
              <input id="pe-valid" className="input" type="date" value={form.validUntil} onChange={set('validUntil')} />
            </div>
            <div className="field poki-dialog-span">
              <label htmlFor="pe-notes">Notes to the prospect</label>
              <textarea id="pe-notes" className="input" rows={2} value={form.clientNotes} onChange={set('clientNotes')} />
            </div>

            <div className="poki-dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save offer'}</button>
            </div>
          </form>
        </div>
      )}

      {dialog === 'convert' && convert && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <form className="dialog poki-dialog" onClick={(ev) => ev.stopPropagation()} onSubmit={submitConvert}>
            <h2 className="poki-dialog-title">Accept {convert.est.estimateNo}</h2>
            <p className="poki-dialog-hint poki-dialog-span">
              {convert.est.customerName} · {convert.est.propertyName} · {convert.est.unitCode}. This creates a
              <strong> draft </strong> booking — activate it on the Bookings screen once it is signed, which is what
              marks the unit occupied.
            </p>
            {dialogError && <div className="error-banner poki-dialog-span">{dialogError}</div>}

            <div className="field">
              <label htmlFor="pc-start">Start date</label>
              <input id="pc-start" className="input" type="date" value={convert.startDate} onChange={setConv('startDate')} required />
            </div>
            <div className="field">
              <label htmlFor="pc-months">Months</label>
              <input id="pc-months" className="input" type="number" min="0" step="1" value={convert.durationMonths} onChange={setConv('durationMonths')} />
            </div>
            <div className="field">
              <label htmlFor="pc-days">…plus days</label>
              <input id="pc-days" className="input" type="number" min="0" step="1" value={convert.durationDays} onChange={setConv('durationDays')} />
            </div>
            <div className="field">
              <label htmlFor="pc-rate">Rent per month</label>
              <input id="pc-rate" className="input" type="number" step="0.01" value={convert.monthlyRate} onChange={setConv('monthlyRate')} required />
            </div>
            <div className="field">
              <label htmlFor="pc-dep">Deposit due</label>
              <input id="pc-dep" className="input" type="number" step="0.01" value={convert.depositAmount} onChange={setConv('depositAmount')} />
            </div>
            <div className="field">
              <label htmlFor="pc-day">Due on day</label>
              <input id="pc-day" className="input" type="number" min="1" max="28" value={convert.paymentDay} onChange={setConv('paymentDay')} />
            </div>
            <div className="field">
              <label htmlFor="pc-esc">Renewal increase (%)</label>
              <input id="pc-esc" className="input" type="number" step="0.01" value={convert.escalationPercent} onChange={setConv('escalationPercent')} placeholder="e.g. 10" />
            </div>

            <div className="poki-dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Creating…' : 'Create draft booking'}</button>
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
          docLabel={'Offer #' + previewEst.estimateNo}
          dateLabel="Valid until"
          dateValue={fmtDate(previewEst.validUntil)}
          heading={'Letting offer for ' + previewEst.customerName}
          subHeading={previewEst.unitCode ? previewEst.propertyName + ' \u00b7 ' + previewEst.unitCode : ''}
          blocks={[
            { title: 'Prospect', lines: [previewEst.customerName, previewEst.customerEmail || previewEst.customerPhone || ''] },
            { title: 'Unit', lines: [previewEst.unitCode || '—', previewEst.propertyName || ''] },
            { title: 'Offer', lines: ['Valid until ' + fmtDate(previewEst.validUntil), money(previewEst.grandTotal, previewEst.currency)] }
          ]}
          items={groupPackageItems(previewEst.items, previewEst.currency)}
          subtotal={money(previewEst.subtotal, previewEst.currency)}
          totalLabel="Total"
          total={money(previewEst.grandTotal, previewEst.currency)}
          notesLabel="Notes"
          notesValue={previewEst.clientNotes}
          termsLabel="Terms"
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
          tag={<span className={'poki-chip poki-chip-' + (detail.status === 'converted' ? 'active' : detail.status === 'finalized' ? 'expiring' : 'open')}>{detail.status}</span>}
          actions={rowActionsFor(detail)}
          onClose={() => setDetail(null)}
          items={itemsForDialog(detail.items, detail.currency)}
          totals={totalsForDialog(detail, detail.currency)}
          fields={[
            { label: 'Kind', value: detail.docKind },
            { label: 'Unit', value: detail.unitCode },
            { label: 'Property', value: detail.propertyName },
            { label: 'Valid until', value: fmtDate(detail.validUntil) },
            { label: 'Booking', value: detail.bookingNo },
            { label: 'Notes', value: detail.clientNotes, wide: true },
          ]}
        />
      )}

    </div>
  );
}
