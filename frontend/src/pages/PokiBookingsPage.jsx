import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { money } from '../lib/currency';
import './PokiPages.css';
import RowMenu from '../components/RowMenu';
import RecordDialog from '../components/RecordDialog';

import { tr } from '../lib/i18n.jsx';
// Bookings — who occupies which unit, on what terms. Also where the tenancy
// agreement gets generated (from a template, with the booking's own details
// filled in) and where deposits and renewals are handled.

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).length > 10 ? iso : iso + 'T00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

const EMPTY = {
  unitId: '', tenantId: '', startDate: '', durationMonths: 12, durationDays: 0,
  monthlyRate: '', dailyRate: '', currency: 'GHS',
  depositAmount: '', depositMonths: 1, escalationPercent: '', status: 'draft', notes: ''
};

export default function PokiBookingsPage() {
  const { can } = useAuth();
  const canManage = can('poki.manage');

  const [bookings, setBookings] = useState([]);
  const [units, setUnits] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [detail, setDetail] = useState(null);

  const [dialog, setDialog] = useState(null); // 'booking' | 'deposit' | 'refund' | 'renew' | 'end' | 'agreement'
  const [editId, setEditId] = useState(null);
  const [target, setTarget] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [quote, setQuote] = useState(null);
  const [dialogError, setDialogError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [agreementBody, setAgreementBody] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [l, u, t] = await Promise.all([api.get('/poki/bookings'), api.get('/poki/units'), api.get('/poki/tenants')]);
      setBookings(l);
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

  // The price and the availability both come from the server, not from
  // arithmetic repeated here. The booking screen and the invoice it will
  // raise then cannot disagree — a quoted total the tenant is not actually
  // charged is worse than showing no total at all. Debounced, because it
  // fires on every keystroke in the rate and duration fields.
  useEffect(() => {
    if (dialog !== 'booking' || !form.unitId || !form.startDate) { setQuote(null); return undefined; }
    const months = Number(form.durationMonths) || 0;
    const days = Number(form.durationDays) || 0;
    if (months <= 0 && days <= 0) { setQuote(null); return undefined; }

    let cancelled = false;
    const t = setTimeout(() => {
      api.post('/poki/bookings/quote', {
        unitId: form.unitId,
        startDate: form.startDate,
        durationMonths: months,
        durationDays: days,
        monthlyRate: form.monthlyRate === '' ? undefined : form.monthlyRate,
        dailyRate: form.dailyRate === '' ? undefined : form.dailyRate,
        depositAmount: form.depositAmount === '' ? 0 : form.depositAmount,
        currency: form.currency,
        exceptId: editId || undefined
      })
        .then((q) => { if (!cancelled) setQuote(q); })
        .catch(() => { if (!cancelled) setQuote(null); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [dialog, editId, form.unitId, form.startDate, form.durationMonths, form.durationDays,
      form.monthlyRate, form.dailyRate, form.depositAmount, form.currency]);

  function openBooking(l) {
    setDialogError(null);
    setEditId(l ? l.id : null);
    setQuote(null);
    setForm(l
      ? {
        ...EMPTY, ...l,
        startDate: String(l.startDate).slice(0, 10),
        // Derived from what was actually agreed rather than defaulted to
        // one month, so editing the rate on a two-month deposit does not
        // quietly halve it.
        depositMonths: monthsFromDeposit(l.depositAmount, l.monthlyRate)
      }
      : EMPTY);
    setDialog('booking');
  }

  // Picking a unit prefills its asking rates, so letting at the advertised
  // price is one click while a negotiated figure is still allowed.
  function onUnitChange(unitId) {
    const u = units.find((x) => x.id === unitId);
    setForm((f) => {
      const monthlyRate = u && !editId ? u.baseRent : f.monthlyRate;
      const dailyRate = u && !editId ? (u.dailyRate || '') : f.dailyRate;
      return {
        ...f,
        unitId,
        monthlyRate,
        dailyRate,
        currency: u ? u.currency : f.currency,
        depositAmount: u && !editId ? depositFor(monthlyRate, f.depositMonths) : f.depositAmount
      };
    });
  }

  // Deposits are agreed in months of rent, so that is what gets entered and
  // the amount follows. It stays an ordinary editable field: a negotiated
  // figure typed straight in is kept unless the months or the rate change.
  function monthsFromDeposit(depositAmount, monthlyRate) {
    const per = Number(monthlyRate) || 0;
    const amount = Number(depositAmount) || 0;
    if (!per || !amount) return '';
    return Math.round((amount / per) * 100) / 100;
  }

  function depositFor(monthlyRate, months) {
    const m = Number(months);
    if (!Number.isFinite(m) || m <= 0) return '';
    return Math.round((Number(monthlyRate) || 0) * m * 100) / 100;
  }

  function onDepositMonthsChange(months) {
    setForm((f) => ({ ...f, depositMonths: months, depositAmount: depositFor(f.monthlyRate, months) }));
  }

  function onRateChange(monthlyRate) {
    setForm((f) => ({
      ...f,
      monthlyRate,
      depositAmount: f.depositMonths ? depositFor(monthlyRate, f.depositMonths) : f.depositAmount
    }));
  }

  async function submitBooking(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      if (editId) await api.patch('/poki/bookings/' + editId, form);
      else await api.post('/poki/bookings', form);
      setToast(editId ? 'Booking updated.' : 'Booking created.');
      setDialog(null);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function act(booking, path, body, message) {
    setBusyId(booking.id);
    setError(null);
    try {
      await api.post('/poki/bookings/' + booking.id + path, body || {});
      setToast(message);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  function openSimple(kind, booking) {
    setDialogError(null);
    setTarget(booking);
    setForm(kind === 'renew'
      ? { escalationPercent: booking.escalationPercent || 0, startDate: '', endDate: '', rentTotal: '', notes: '' }
      : { amount: '', deductions: '', notes: '', reason: '', status: 'terminated' });
    setDialog(kind);
  }

  async function submitSimple(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      if (dialog === 'deposit') {
        await api.post('/poki/bookings/' + target.id + '/deposit', { amount: form.amount, notes: form.notes });
        setToast('Deposit recorded.');
      } else if (dialog === 'refund') {
        await api.post('/poki/bookings/' + target.id + '/deposit-refund', {
          amount: form.amount, deductions: form.deductions, notes: form.notes
        });
        setToast('Deposit refund recorded.');
      } else if (dialog === 'renew') {
        const body = { escalationPercent: form.escalationPercent };
        if (form.startDate) body.startDate = form.startDate;
        if (form.durationMonths !== '') body.durationMonths = form.durationMonths;
        if (form.durationDays !== '') body.durationDays = form.durationDays;
        if (form.monthlyRate) body.monthlyRate = form.monthlyRate;
        if (form.notes) body.notes = form.notes;
        await api.post('/poki/bookings/' + target.id + '/renew', body);
        setToast('Booking renewed.');
      } else if (dialog === 'end') {
        await api.post('/poki/bookings/' + target.id + '/end', { reason: form.reason, status: form.status });
        setToast('Booking ended — the unit is now vacant.');
      }
      setDialog(null);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function openAgreement(booking) {
    setDialogError(null);
    setTarget(booking);
    setAgreementBody(booking.agreementBody || '');
    setDialog('agreement');
    if (!booking.agreementBody) await generateAgreement(booking);
  }

  async function generateAgreement(booking) {
    setSaving(true);
    setDialogError(null);
    try {
      const res = await api.post('/poki/bookings/' + (booking || target).id + '/agreement', {});
      setAgreementBody(res.body);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveAgreement() {
    setSaving(true);
    setDialogError(null);
    try {
      await api.put('/poki/bookings/' + target.id + '/agreement', { body: agreementBody });
      setToast('Agreement saved.');
      setDialog(null);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  function printAgreement() {
    const w = window.open('', '_blank');
    if (!w) return;
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    w.document.write(
      '<html><head><title>' + esc(target.bookingNo) + ' — Tenancy Agreement</title>' +
      '<style>body{font-family:Georgia,serif;line-height:1.7;max-width:720px;margin:40px auto;padding:0 24px;white-space:pre-wrap;font-size:13px}</style>' +
      '</head><body>' + esc(agreementBody) + '</body></html>'
    );
    w.document.close();
    w.focus();
    w.print();
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  const visible = bookings.filter((l) =>
    matchesQuery(search, l.bookingNo, l.tenantName, l.unitCode, l.propertyName) && (!statusFilter || l.status === statusFilter)
  );
  // Every active unit, not just the ones marked vacant. Occupancy is a
  // question about dates now: a unit let until August is perfectly bookable
  // for September, and filtering on the status flag made that impossible to
  // enter. The quote says whether the chosen dates are free, and the
  // database refuses an overlap regardless.
  const bookableUnits = units.filter((u) => u.active !== false || (editId && form.unitId === u.id));
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  // One list, shared by the row menu and the record panel.
  function bookingActions(l) {
    return [
      { label: 'Agreement', onClick: () => openAgreement(l) },
      { label: 'Activate', onClick: () => act(l, '/activate', {}, 'Booking activated — the unit is now occupied.'), disabled: busyId === l.id, hidden: !(canManage && l.status === 'draft') },
      { label: 'Edit', onClick: () => openBooking(l), hidden: !(canManage && (l.status === 'draft' || l.status === 'active')) },
      { label: 'Deposit', onClick: () => openSimple('deposit', l), hidden: !(canManage && l.status === 'active') },
      { label: 'Renew', onClick: () => openSimple('renew', l), hidden: !(canManage && l.status === 'active') },
      { label: 'End', onClick: () => openSimple('end', l), hidden: !(canManage && l.status === 'active') },
      { label: 'Refund deposit', onClick: () => openSimple('refund', l), hidden: !(canManage && l.depositHeld > l.depositRefunded && l.status !== 'active' && l.status !== 'draft') },
    ];
  }

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="poki-toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder={tr('Search bookings…')} />
        <select className="input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label={tr('Filter by status')}>
          <option value="">{tr('All statuses')}</option>
          <option value="draft">{tr('Draft')}</option>
          <option value="active">{tr('Active')}</option>
          <option value="expired">{tr('Expired')}</option>
          <option value="terminated">{tr('Terminated')}</option>
          <option value="renewed">{tr('Renewed')}</option>
        </select>
        <div className="poki-toolbar-spacer" />
        {canManage && (
          <button type="button" className="btn btn-primary" disabled={!tenants.length || !units.length} onClick={() => openBooking(null)}>
            {tr('New booking')}
          </button>
        )}
      </div>

      {visible.length === 0 ? (
        <div className="poki-empty">
          <p className="poki-empty-title">{bookings.length ? 'No bookings match' : 'No bookings yet'}</p>
          <p className="poki-empty-sub">
            {bookings.length
              ? 'Try a different search or status filter.'
              : 'A booking puts a tenant in a unit and drives rent billing. Add a property, a unit and a tenant first.'}
          </p>
        </div>
      ) : (
        <div className="poki-table-wrap">
        <table className="table table-clickable">
          <thead>
            <tr>
              <th>{tr('Booking')}</th><th>{tr('Unit')}</th><th>{tr('Tenant')}</th><th>{tr('Term')}</th>
              <th className="poki-num">{tr('Rent')}</th><th className="poki-num">{tr('Deposit')}</th><th className="poki-num">{tr('Owing')}</th>
              <th>{tr('Status')}</th><th></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((l) => (
              <tr
                key={l.id}
                tabIndex={0}
                onClick={() => setDetail(l)}
                onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setDetail(l); } }}
              >
                <td className="poki-nowrap">
                  <div className="poki-strong">{l.bookingNo}</div>
                  {l.agreementGeneratedAt && <div className="poki-muted">{tr('agreement ready')}</div>}
                </td>
                <td className="poki-nowrap">
                  <div className="poki-strong">{l.unitCode}</div>
                  <div className="poki-muted">{l.propertyName}</div>
                </td>
                <td className="poki-nowrap">{l.tenantName}</td>
                <td className="poki-nowrap">
                  <div>{fmtDate(l.startDate)}</div>
                  <div className="poki-muted">→ {fmtDate(l.endDate)}</div>
                  <div className="poki-muted">{l.durationLabel}</div>
                </td>
                <td className="poki-num">
                  {money(l.rentTotal, l.currency)}
                  <div className="poki-muted">{money(l.monthlyRate, l.currency)}{tr('/month')}</div>
                </td>
                <td className="poki-num">
                  {money(l.depositHeld, l.currency)}
                  {l.depositAmount > l.depositHeld && (
                    <div className="poki-muted">{tr('of')} {money(l.depositAmount, l.currency)}</div>
                  )}
                </td>
                <td className={'poki-num' + (l.balanceTotal > 0 ? ' poki-overdue' : '')}>{money(l.balanceTotal || 0, l.currency)}</td>
                <td><span className={'poki-chip poki-chip-' + l.status}>{l.status}</span></td>
                <td className="table-actions" onClick={(e) => e.stopPropagation()}>
<RowMenu actions={bookingActions(l)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      {dialog === 'booking' && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <form className="dialog poki-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitBooking}>
            <h2 className="poki-dialog-title">{editId ? 'Edit booking' : 'New booking'}</h2>
            {dialogError && <div className="error-banner poki-dialog-span">{dialogError}</div>}
            <div className="field">
              <label htmlFor="pl-unit">{tr('Unit')}</label>
              <select id="pl-unit" className="input" value={form.unitId} onChange={(e) => onUnitChange(e.target.value)} required disabled={!!editId}>
                <option value="">{tr('Choose a unit…')}</option>
                {bookableUnits.map((u) => (
                  <option key={u.id} value={u.id}>{u.propertyName} · {u.code}{u.name ? ' — ' + u.name : ''}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="pl-tenant">{tr('Tenant')}</label>
              <select id="pl-tenant" className="input" value={form.tenantId} onChange={set('tenantId')} required disabled={!!editId}>
                <option value="">{tr('Choose a tenant…')}</option>
                {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="pl-start">{tr('Start date')}</label>
              <input id="pl-start" className="input" type="date" value={form.startDate} onChange={set('startDate')} required />
            </div>
            <div className="field">
              <label htmlFor="pl-months">{tr('For how many months')}</label>
              <input id="pl-months" className="input" type="number" min="0" step="1"
                value={form.durationMonths} onChange={set('durationMonths')} />
            </div>
            <div className="field">
              <label htmlFor="pl-days">{tr('…plus how many days')}</label>
              <input id="pl-days" className="input" type="number" min="0" step="1"
                value={form.durationDays} onChange={set('durationDays')} />
              <p className="poki-dialog-hint">{tr('Leave months at 0 for a booking of days only.')}</p>
            </div>
            <div className="field">
              <label htmlFor="pl-rate">{tr('Rent per month')}</label>
              <input id="pl-rate" className="input" type="number" step="0.01"
                value={form.monthlyRate} onChange={(e) => onRateChange(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="pl-daily">{tr('Rent per day')}</label>
              <input id="pl-daily" className="input" type="number" step="0.01"
                value={form.dailyRate} onChange={set('dailyRate')} placeholder={tr('from the unit')} />
              <p className="poki-dialog-hint">{tr('Blank uses a thirtieth of the monthly rate.')}</p>
            </div>
            <div className="field">
              <label htmlFor="pl-dep-months">{tr('Deposit (months of rent)')}</label>
              <input id="pl-dep-months" className="input" type="number" min="0" step="0.5"
                value={form.depositMonths} onChange={(e) => onDepositMonthsChange(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="pl-dep">{tr('Deposit due')}</label>
              <input id="pl-dep" className="input" type="number" step="0.01" value={form.depositAmount} onChange={set('depositAmount')} />
            </div>
            <div className="field">
              <label htmlFor="pl-esc">{tr('Renewal increase (%)')}</label>
              <input id="pl-esc" className="input" type="number" step="0.01" value={form.escalationPercent} onChange={set('escalationPercent')} placeholder={tr('e.g. 10')} />
            </div>
            {!editId && (
              <div className="field">
                <label htmlFor="pl-status">{tr('Start as')}</label>
                <select id="pl-status" className="input" value={form.status} onChange={set('status')}>
                  <option value="draft">{tr('Draft — not yet occupying')}</option>
                  <option value="active">{tr('Active — tenant moves in now')}</option>
                </select>
              </div>
            )}
            <div className="field poki-dialog-span">
              <label htmlFor="pl-notes">{tr('Notes')}</label>
              <textarea id="pl-notes" className="input" rows={2} value={form.notes} onChange={set('notes')} />
            </div>
            {quote && (
              <div className="poki-term-total poki-dialog-span">
                <div className="poki-term-row">
                  <span>
                    {tr('Rent —')} {quote.durationLabel}
                    <span className="poki-muted">
                      {' '}({fmtDate(quote.startDate)} {tr('to')} {fmtDate(quote.endDate)})
                    </span>
                  </span>
                  <strong>{money(quote.rentTotal, quote.currency)}</strong>
                </div>
                {quote.daysAmount > 0 && (
                  <div className="poki-term-row poki-muted">
                    <span>
                      {tr('of which')} {quote.durationDays} {quote.durationDays === 1 ? 'day' : 'days'} {tr('at')} {money(quote.dailyRate, quote.currency)}
                    </span>
                    <span>{money(quote.daysAmount, quote.currency)}</span>
                  </div>
                )}
                <div className="poki-term-row">
                  <span>{tr('Deposit')}</span>
                  <strong>{money(quote.depositAmount, quote.currency)}</strong>
                </div>
                <div className="poki-term-row poki-term-grand">
                  <span>{tr('Payable before occupation')}</span>
                  <strong>{money(quote.total, quote.currency)}</strong>
                </div>
                {!quote.available && (
                  <div className="poki-term-clash">
                    {tr('Unavailable —')} {quote.clashesWith.bookingNo} {tr('has this unit from')}{' '}
                    {fmtDate(quote.clashesWith.startDate)} {tr('to')} {fmtDate(quote.clashesWith.endDate)}.
                  </div>
                )}
              </div>
            )}
            <p className="poki-dialog-hint">
              {tr('The whole booking is invoiced once, when it is made — there is no monthly rent run. Utilities, where the unit has them, are billed separately as they are used.')}
            </p>
            <div className="poki-dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving || (quote && !quote.available)}>{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </div>
      )}

      {(dialog === 'deposit' || dialog === 'refund' || dialog === 'renew' || dialog === 'end') && target && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <form className="dialog poki-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitSimple}>
            <h2 className="poki-dialog-title">
              {dialog === 'deposit' && 'Record deposit — ' + target.bookingNo}
              {dialog === 'refund' && 'Refund deposit — ' + target.bookingNo}
              {dialog === 'renew' && 'Renew booking — ' + target.bookingNo}
              {dialog === 'end' && 'End booking — ' + target.bookingNo}
            </h2>
            {dialogError && <div className="error-banner poki-dialog-span">{dialogError}</div>}

            {dialog === 'deposit' && (
              <>
                <p className="poki-dialog-hint">
                  {target.tenantName} {tr('owes a deposit of')} {money(target.depositAmount, target.currency)};{' '}
                  {money(target.depositHeld, target.currency)} {tr('has been received so far.')}
                </p>
                <div className="field">
                  <label htmlFor="pd-amt">{tr('Amount received')}</label>
                  <input id="pd-amt" className="input" type="number" step="0.01" value={form.amount} onChange={set('amount')} required />
                </div>
                <div className="field">
                  <label htmlFor="pd-notes">{tr('Reference / notes')}</label>
                  <input id="pd-notes" className="input" value={form.notes} onChange={set('notes')} />
                </div>
              </>
            )}

            {dialog === 'refund' && (
              <>
                <p className="poki-dialog-hint">
                  {money(target.depositHeld - target.depositRefunded, target.currency)} {tr('is held on this booking. Anything you withhold for damage or unpaid rent goes in deductions and is not refunded.')}
                </p>
                <div className="field">
                  <label htmlFor="pr-amt">{tr('Refund to tenant')}</label>
                  <input id="pr-amt" className="input" type="number" step="0.01" value={form.amount} onChange={set('amount')} required />
                </div>
                <div className="field">
                  <label htmlFor="pr-ded">{tr('Deductions withheld')}</label>
                  <input id="pr-ded" className="input" type="number" step="0.01" value={form.deductions} onChange={set('deductions')} />
                </div>
                <div className="field poki-dialog-span">
                  <label htmlFor="pr-notes">{tr('What the deductions cover')}</label>
                  <textarea id="pr-notes" className="input" rows={2} value={form.notes} onChange={set('notes')} />
                </div>
              </>
            )}

            {dialog === 'renew' && (
              <>
                <p className="poki-dialog-hint">
                  {tr('Books the same unit again, starting the day after')} {fmtDate(target.endDate)} {tr('— this booking keeps its own price and signed agreement. Leave the fields blank to repeat the same length at the increased rate.')}
                </p>
                <div className="field">
                  <label htmlFor="prn-esc">{tr('Rent increase (%)')}</label>
                  <input id="prn-esc" className="input" type="number" step="0.01" value={form.escalationPercent} onChange={set('escalationPercent')} />
                </div>
                <div className="field">
                  <label htmlFor="prn-rate">{tr('Or set the monthly rate directly')}</label>
                  <input id="prn-rate" className="input" type="number" step="0.01" value={form.monthlyRate} onChange={set('monthlyRate')}
                    placeholder={String(target.monthlyRate)} />
                </div>
                <div className="field">
                  <label htmlFor="prn-start">{tr('New start date')}</label>
                  <input id="prn-start" className="input" type="date" value={form.startDate} onChange={set('startDate')}
                    placeholder={tr('day after this one ends')} />
                </div>
                <div className="field">
                  <label htmlFor="prn-months">{tr('Months')}</label>
                  <input id="prn-months" className="input" type="number" min="0" step="1" value={form.durationMonths} onChange={set('durationMonths')}
                    placeholder={String(target.durationMonths)} />
                </div>
                <div className="field">
                  <label htmlFor="prn-days">{tr('…plus days')}</label>
                  <input id="prn-days" className="input" type="number" min="0" step="1" value={form.durationDays} onChange={set('durationDays')}
                    placeholder={String(target.durationDays)} />
                </div>
              </>
            )}

            {dialog === 'end' && (
              <>
                <p className="poki-dialog-hint">
                  {target.unitCode} {tr('becomes vacant immediately. Any unpaid invoices stay outstanding — ending a tenancy doesn\'t cancel what\'s owed.')}
                </p>
                <div className="field">
                  <label htmlFor="pe-status">{tr('Reason type')}</label>
                  <select id="pe-status" className="input" value={form.status} onChange={set('status')}>
                    <option value="terminated">{tr('Terminated early')}</option>
                    <option value="expired">{tr('Ran to its end date')}</option>
                  </select>
                </div>
                <div className="field poki-dialog-span">
                  <label htmlFor="pe-reason">{tr('Reason')}</label>
                  <textarea id="pe-reason" className="input" rows={2} value={form.reason} onChange={set('reason')} />
                </div>
              </>
            )}

            <div className="poki-dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Confirm'}</button>
            </div>
          </form>
        </div>
      )}

      {dialog === 'agreement' && target && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <div className="dialog poki-agreement-dialog" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ margin: 0 }}>{tr('Tenancy agreement —')} {target.bookingNo}</h2>
            <p className="poki-muted" style={{ margin: 0 }}>
              {target.tenantName} · {target.propertyName} · {target.unitCode} ·{' '}
              {fmtDate(target.startDate)} → {fmtDate(target.endDate)}
            </p>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <textarea
              className="input poki-agreement-body"
              value={agreementBody}
              onChange={(e) => setAgreementBody(e.target.value)}
              readOnly={!canManage}
              placeholder={saving ? 'Generating…' : 'No agreement yet — generate one from the template.'}
            />
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>{tr('Close')}</button>
              <button type="button" className="btn btn-secondary" disabled={!agreementBody} onClick={printAgreement}>{tr('Print / PDF')}</button>
              {canManage && (
                <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => generateAgreement(target)}>
                  {saving ? 'Generating…' : 'Regenerate from template'}
                </button>
              )}
              {canManage && (
                <button type="button" className="btn btn-primary" disabled={saving || !agreementBody} onClick={saveAgreement}>{tr('Save')}</button>
              )}
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
      {detail && (
        <RecordDialog
          title={detail.bookingNo}
          subtitle={detail.tenantName}
          actions={bookingActions(detail)}
          onClose={() => setDetail(null)}
          fields={[
            { label: 'Unit', value: detail.unitCode },
            { label: 'Property', value: detail.propertyName },
            { label: 'Starts', value: fmtDate(detail.startDate) },
            { label: 'Ends', value: fmtDate(detail.endDate) },
            { label: 'Duration', value: [detail.durationMonths ? detail.durationMonths + ' month' + (detail.durationMonths === 1 ? '' : 's') : null,
                                         detail.durationDays ? detail.durationDays + ' day' + (detail.durationDays === 1 ? '' : 's') : null]
                                         .filter(Boolean).join(' + ') },
            { label: 'Status', value: detail.status },
            { label: 'Monthly rate', value: money(detail.monthlyRate, detail.currency) },
            { label: 'Daily rate', value: Number(detail.dailyRate) ? money(detail.dailyRate, detail.currency) : null },
            { label: 'Rent for the term', value: money(detail.rentTotal, detail.currency) },
            { label: 'Deposit due', value: money(detail.depositAmount, detail.currency) },
            { label: 'Deposit held', value: money(detail.depositHeld, detail.currency) },
            { label: 'Deposit refunded', value: Number(detail.depositRefunded) ? money(detail.depositRefunded, detail.currency) : null },
            { label: 'Notes', value: detail.notes, wide: true },
          ]}
        />
      )}

    </div>
  );
}
