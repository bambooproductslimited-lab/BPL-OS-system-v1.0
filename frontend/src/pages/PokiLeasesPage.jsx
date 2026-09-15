import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { money } from '../lib/currency';
import { perCycle } from '../lib/rentCycle';
import './PokiPages.css';

// Leases — who occupies which unit, on what terms. Also where the tenancy
// agreement gets generated (from a template, with the lease's own details
// filled in) and where deposits and renewals are handled.

const RENT_CYCLES = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'semiannual', label: 'Every 6 months' },
  { value: 'annual', label: 'Annually' },
  { value: 'one_off', label: 'One-off (whole term)' }
];

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).length > 10 ? iso : iso + 'T00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

const EMPTY = {
  unitId: '', tenantId: '', startDate: '', endDate: '', rentAmount: '', currency: 'GHS',
  rentCycle: 'monthly', paymentDay: 1, depositAmount: '', escalationPercent: '', status: 'draft', notes: ''
};

export default function PokiLeasesPage() {
  const { can } = useAuth();
  const canManage = can('poki.manage');

  const [leases, setLeases] = useState([]);
  const [units, setUnits] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [busyId, setBusyId] = useState(null);

  const [dialog, setDialog] = useState(null); // 'lease' | 'deposit' | 'refund' | 'renew' | 'end' | 'agreement'
  const [editId, setEditId] = useState(null);
  const [target, setTarget] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [dialogError, setDialogError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [agreementBody, setAgreementBody] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [l, u, t] = await Promise.all([api.get('/poki/leases'), api.get('/poki/units'), api.get('/poki/tenants')]);
      setLeases(l);
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

  function openLease(l) {
    setDialogError(null);
    setEditId(l ? l.id : null);
    setForm(l
      ? { ...EMPTY, ...l, startDate: String(l.startDate).slice(0, 10), endDate: String(l.endDate).slice(0, 10) }
      : EMPTY);
    setDialog('lease');
  }

  // Picking a vacant unit prefills the asking rent and terms so the common
  // case (letting at the advertised price) is one click, while still
  // allowing a negotiated figure.
  function onUnitChange(unitId) {
    const u = units.find((x) => x.id === unitId);
    setForm((f) => ({
      ...f,
      unitId,
      rentAmount: u && !editId ? u.baseRent : f.rentAmount,
      currency: u ? u.currency : f.currency,
      rentCycle: u && !editId ? u.rentCycle : f.rentCycle
    }));
  }

  async function submitLease(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      if (editId) await api.patch('/poki/leases/' + editId, form);
      else await api.post('/poki/leases', form);
      setToast(editId ? 'Lease updated.' : 'Lease created.');
      setDialog(null);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function act(lease, path, body, message) {
    setBusyId(lease.id);
    setError(null);
    try {
      await api.post('/poki/leases/' + lease.id + path, body || {});
      setToast(message);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  function openSimple(kind, lease) {
    setDialogError(null);
    setTarget(lease);
    setForm(kind === 'renew'
      ? { escalationPercent: lease.escalationPercent || 0, startDate: '', endDate: '', rentAmount: '', notes: '' }
      : { amount: '', deductions: '', notes: '', reason: '', status: 'terminated' });
    setDialog(kind);
  }

  async function submitSimple(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      if (dialog === 'deposit') {
        await api.post('/poki/leases/' + target.id + '/deposit', { amount: form.amount, notes: form.notes });
        setToast('Deposit recorded.');
      } else if (dialog === 'refund') {
        await api.post('/poki/leases/' + target.id + '/deposit-refund', {
          amount: form.amount, deductions: form.deductions, notes: form.notes
        });
        setToast('Deposit refund recorded.');
      } else if (dialog === 'renew') {
        const body = { escalationPercent: form.escalationPercent };
        if (form.startDate) body.startDate = form.startDate;
        if (form.endDate) body.endDate = form.endDate;
        if (form.rentAmount) body.rentAmount = form.rentAmount;
        if (form.notes) body.notes = form.notes;
        await api.post('/poki/leases/' + target.id + '/renew', body);
        setToast('Lease renewed.');
      } else if (dialog === 'end') {
        await api.post('/poki/leases/' + target.id + '/end', { reason: form.reason, status: form.status });
        setToast('Lease ended — the unit is now vacant.');
      }
      setDialog(null);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function openAgreement(lease) {
    setDialogError(null);
    setTarget(lease);
    setAgreementBody(lease.agreementBody || '');
    setDialog('agreement');
    if (!lease.agreementBody) await generateAgreement(lease);
  }

  async function generateAgreement(lease) {
    setSaving(true);
    setDialogError(null);
    try {
      const res = await api.post('/poki/leases/' + (lease || target).id + '/agreement', {});
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
      await api.put('/poki/leases/' + target.id + '/agreement', { body: agreementBody });
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
      '<html><head><title>' + esc(target.leaseNo) + ' — Tenancy Agreement</title>' +
      '<style>body{font-family:Georgia,serif;line-height:1.7;max-width:720px;margin:40px auto;padding:0 24px;white-space:pre-wrap;font-size:13px}</style>' +
      '</head><body>' + esc(agreementBody) + '</body></html>'
    );
    w.document.close();
    w.focus();
    w.print();
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  const visible = leases.filter((l) =>
    matchesQuery(search, l.leaseNo, l.tenantName, l.unitCode, l.propertyName) && (!statusFilter || l.status === statusFilter)
  );
  const vacantUnits = units.filter((u) => u.status === 'vacant' || (editId && form.unitId === u.id));
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="poki-toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Search leases…" />
        <select className="input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status">
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="active">Active</option>
          <option value="expired">Expired</option>
          <option value="terminated">Terminated</option>
          <option value="renewed">Renewed</option>
        </select>
        <div className="poki-toolbar-spacer" />
        {canManage && (
          <button type="button" className="btn btn-primary" disabled={!tenants.length || !units.length} onClick={() => openLease(null)}>
            New lease
          </button>
        )}
      </div>

      {visible.length === 0 ? (
        <div className="poki-empty">
          <p className="poki-empty-title">{leases.length ? 'No leases match' : 'No leases yet'}</p>
          <p className="poki-empty-sub">
            {leases.length
              ? 'Try a different search or status filter.'
              : 'A lease puts a tenant in a unit and drives rent billing. Add a property, a unit and a tenant first.'}
          </p>
        </div>
      ) : (
        <div className="poki-table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Lease</th><th>Unit</th><th>Tenant</th><th>Term</th>
              <th className="poki-num">Rent</th><th className="poki-num">Deposit</th><th className="poki-num">Owing</th>
              <th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((l) => (
              <tr key={l.id}>
                <td className="poki-nowrap">
                  <div className="poki-strong">{l.leaseNo}</div>
                  {l.agreementGeneratedAt && <div className="poki-muted">agreement ready</div>}
                </td>
                <td className="poki-nowrap">
                  <div className="poki-strong">{l.unitCode}</div>
                  <div className="poki-muted">{l.propertyName}</div>
                </td>
                <td className="poki-nowrap">{l.tenantName}</td>
                <td className="poki-nowrap">
                  <div>{fmtDate(l.startDate)}</div>
                  <div className="poki-muted">→ {fmtDate(l.endDate)}</div>
                  {l.status === 'active' && l.nextInvoiceOn && (
                    <div className="poki-muted">next bill {fmtDate(l.nextInvoiceOn)}</div>
                  )}
                </td>
                <td className="poki-num">
                  {money(l.rentAmount, l.currency)}
                  <div className="poki-muted">{perCycle(l.rentCycle)}</div>
                </td>
                <td className="poki-num">
                  {money(l.depositHeld, l.currency)}
                  {l.depositAmount > l.depositHeld && (
                    <div className="poki-muted">of {money(l.depositAmount, l.currency)}</div>
                  )}
                </td>
                <td className={'poki-num' + (l.balanceTotal > 0 ? ' poki-overdue' : '')}>{money(l.balanceTotal || 0, l.currency)}</td>
                <td><span className={'poki-chip poki-chip-' + l.status}>{l.status}</span></td>
                <td className="table-actions">
                  <button type="button" className="btn btn-secondary poki-row-btn" onClick={() => openAgreement(l)}>Agreement</button>
                  {canManage && l.status === 'draft' && (
                    <button type="button" className="btn btn-secondary poki-row-btn" disabled={busyId === l.id}
                      onClick={() => act(l, '/activate', {}, 'Lease activated — the unit is now occupied.')}>Activate</button>
                  )}
                  {canManage && (l.status === 'draft' || l.status === 'active') && (
                    <button type="button" className="btn btn-secondary poki-row-btn" onClick={() => openLease(l)}>Edit</button>
                  )}
                  {canManage && l.status === 'active' && (
                    <>
                      <button type="button" className="btn btn-secondary poki-row-btn" onClick={() => openSimple('deposit', l)}>Deposit</button>
                      <button type="button" className="btn btn-secondary poki-row-btn" onClick={() => openSimple('renew', l)}>Renew</button>
                      <button type="button" className="btn btn-secondary poki-row-btn" onClick={() => openSimple('end', l)}>End</button>
                    </>
                  )}
                  {canManage && l.depositHeld > l.depositRefunded && l.status !== 'active' && l.status !== 'draft' && (
                    <button type="button" className="btn btn-secondary poki-row-btn" onClick={() => openSimple('refund', l)}>Refund deposit</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      {dialog === 'lease' && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <form className="dialog poki-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitLease}>
            <h2 className="poki-dialog-title">{editId ? 'Edit lease' : 'New lease'}</h2>
            {dialogError && <div className="error-banner poki-dialog-span">{dialogError}</div>}
            <div className="field">
              <label htmlFor="pl-unit">Unit</label>
              <select id="pl-unit" className="input" value={form.unitId} onChange={(e) => onUnitChange(e.target.value)} required disabled={!!editId}>
                <option value="">Choose a vacant unit…</option>
                {vacantUnits.map((u) => (
                  <option key={u.id} value={u.id}>{u.propertyName} · {u.code}{u.name ? ' — ' + u.name : ''}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="pl-tenant">Tenant</label>
              <select id="pl-tenant" className="input" value={form.tenantId} onChange={set('tenantId')} required disabled={!!editId}>
                <option value="">Choose a tenant…</option>
                {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="pl-start">Start date</label>
              <input id="pl-start" className="input" type="date" value={form.startDate} onChange={set('startDate')} required />
            </div>
            <div className="field">
              <label htmlFor="pl-end">End date</label>
              <input id="pl-end" className="input" type="date" value={form.endDate} onChange={set('endDate')} required />
            </div>
            <div className="field">
              <label htmlFor="pl-rent">Rent</label>
              <input id="pl-rent" className="input" type="number" step="0.01" value={form.rentAmount} onChange={set('rentAmount')} required />
            </div>
            <div className="field">
              <label htmlFor="pl-cycle">Billed</label>
              <select id="pl-cycle" className="input" value={form.rentCycle} onChange={set('rentCycle')}>
                {RENT_CYCLES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="pl-day">Due on day</label>
              <input id="pl-day" className="input" type="number" min="1" max="28" value={form.paymentDay} onChange={set('paymentDay')} />
            </div>
            <div className="field">
              <label htmlFor="pl-dep">Deposit due</label>
              <input id="pl-dep" className="input" type="number" step="0.01" value={form.depositAmount} onChange={set('depositAmount')} />
            </div>
            <div className="field">
              <label htmlFor="pl-esc">Renewal increase (%)</label>
              <input id="pl-esc" className="input" type="number" step="0.01" value={form.escalationPercent} onChange={set('escalationPercent')} placeholder="e.g. 10" />
            </div>
            {!editId && (
              <div className="field">
                <label htmlFor="pl-status">Start as</label>
                <select id="pl-status" className="input" value={form.status} onChange={set('status')}>
                  <option value="draft">Draft — not yet occupying</option>
                  <option value="active">Active — tenant moves in now</option>
                </select>
              </div>
            )}
            <div className="field poki-dialog-span">
              <label htmlFor="pl-notes">Notes</label>
              <textarea id="pl-notes" className="input" rows={2} value={form.notes} onChange={set('notes')} />
            </div>
            <p className="poki-dialog-hint">
              Rent invoices are raised from the Rent &amp; utilities screen once the lease is active — the first period starts on the start date.
            </p>
            <div className="poki-dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </div>
      )}

      {(dialog === 'deposit' || dialog === 'refund' || dialog === 'renew' || dialog === 'end') && target && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <form className="dialog poki-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitSimple}>
            <h2 className="poki-dialog-title">
              {dialog === 'deposit' && 'Record deposit — ' + target.leaseNo}
              {dialog === 'refund' && 'Refund deposit — ' + target.leaseNo}
              {dialog === 'renew' && 'Renew lease — ' + target.leaseNo}
              {dialog === 'end' && 'End lease — ' + target.leaseNo}
            </h2>
            {dialogError && <div className="error-banner poki-dialog-span">{dialogError}</div>}

            {dialog === 'deposit' && (
              <>
                <p className="poki-dialog-hint">
                  {target.tenantName} owes a deposit of {money(target.depositAmount, target.currency)};{' '}
                  {money(target.depositHeld, target.currency)} has been received so far.
                </p>
                <div className="field">
                  <label htmlFor="pd-amt">Amount received</label>
                  <input id="pd-amt" className="input" type="number" step="0.01" value={form.amount} onChange={set('amount')} required />
                </div>
                <div className="field">
                  <label htmlFor="pd-notes">Reference / notes</label>
                  <input id="pd-notes" className="input" value={form.notes} onChange={set('notes')} />
                </div>
              </>
            )}

            {dialog === 'refund' && (
              <>
                <p className="poki-dialog-hint">
                  {money(target.depositHeld - target.depositRefunded, target.currency)} is held on this lease. Anything you withhold
                  for damage or unpaid rent goes in deductions and is not refunded.
                </p>
                <div className="field">
                  <label htmlFor="pr-amt">Refund to tenant</label>
                  <input id="pr-amt" className="input" type="number" step="0.01" value={form.amount} onChange={set('amount')} required />
                </div>
                <div className="field">
                  <label htmlFor="pr-ded">Deductions withheld</label>
                  <input id="pr-ded" className="input" type="number" step="0.01" value={form.deductions} onChange={set('deductions')} />
                </div>
                <div className="field poki-dialog-span">
                  <label htmlFor="pr-notes">What the deductions cover</label>
                  <textarea id="pr-notes" className="input" rows={2} value={form.notes} onChange={set('notes')} />
                </div>
              </>
            )}

            {dialog === 'renew' && (
              <>
                <p className="poki-dialog-hint">
                  Creates a new lease continuing from {fmtDate(target.endDate)}, so this term keeps its own rent and signed
                  agreement. Leave the dates blank for a 12-month renewal.
                </p>
                <div className="field">
                  <label htmlFor="prn-esc">Rent increase (%)</label>
                  <input id="prn-esc" className="input" type="number" step="0.01" value={form.escalationPercent} onChange={set('escalationPercent')} />
                </div>
                <div className="field">
                  <label htmlFor="prn-rent">Or set rent directly</label>
                  <input id="prn-rent" className="input" type="number" step="0.01" value={form.rentAmount} onChange={set('rentAmount')}
                    placeholder={String(target.rentAmount)} />
                </div>
                <div className="field">
                  <label htmlFor="prn-start">New start date</label>
                  <input id="prn-start" className="input" type="date" value={form.startDate} onChange={set('startDate')} />
                </div>
                <div className="field">
                  <label htmlFor="prn-end">New end date</label>
                  <input id="prn-end" className="input" type="date" value={form.endDate} onChange={set('endDate')} />
                </div>
              </>
            )}

            {dialog === 'end' && (
              <>
                <p className="poki-dialog-hint">
                  {target.unitCode} becomes vacant immediately. Any unpaid invoices stay outstanding — ending a tenancy doesn't
                  cancel what's owed.
                </p>
                <div className="field">
                  <label htmlFor="pe-status">Reason type</label>
                  <select id="pe-status" className="input" value={form.status} onChange={set('status')}>
                    <option value="terminated">Terminated early</option>
                    <option value="expired">Ran to its end date</option>
                  </select>
                </div>
                <div className="field poki-dialog-span">
                  <label htmlFor="pe-reason">Reason</label>
                  <textarea id="pe-reason" className="input" rows={2} value={form.reason} onChange={set('reason')} />
                </div>
              </>
            )}

            <div className="poki-dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Confirm'}</button>
            </div>
          </form>
        </div>
      )}

      {dialog === 'agreement' && target && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <div className="dialog poki-agreement-dialog" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ margin: 0 }}>Tenancy agreement — {target.leaseNo}</h2>
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
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>Close</button>
              <button type="button" className="btn btn-secondary" disabled={!agreementBody} onClick={printAgreement}>Print / PDF</button>
              {canManage && (
                <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => generateAgreement(target)}>
                  {saving ? 'Generating…' : 'Regenerate from template'}
                </button>
              )}
              {canManage && (
                <button type="button" className="btn btn-primary" disabled={saving || !agreementBody} onClick={saveAgreement}>Save</button>
              )}
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
