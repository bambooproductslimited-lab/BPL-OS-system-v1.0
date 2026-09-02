import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import './LeaveTypesPage.css';

// HR/Admin-only screen (nav-gated on employee.write, same permission that
// already gates kiosk PIN management and employee editing) for the things
// the Leave screen itself deliberately doesn't expose. Four sections:
//  - Leave types: create/edit the catalogue leave.routes.js's /types
//    endpoint exposes to the request-leave picker. "Days per year" here is
//    the gross policy figure, before public holidays are subtracted.
//  - Public holidays: each company keeps its own list (a restaurant/bar
//    can stay open on a day the factory closes for) — company policy
//    bakes public holidays into the annual leave allowance rather than
//    granting them on top of it, so a 21-day type with 14 company
//    holidays that year nets to 7 actual bookable days. The same list
//    also means a holiday inside an approved request isn't charged
//    against the balance, exactly like Sundays already aren't.
//  - Employee balances: two related but distinct things per employee.
//    "Base entitlement" is their personal annual days for a leave type —
//    year-independent, persists until changed, defaults to the type's
//    company-wide days/year until HR sets a personal override (seniority,
//    a negotiated offer, a proration that should stick rather than
//    resetting every year). "Entitled/Used/Left" below it is the actual
//    stored balance for one specific year (base entitlement net of that
//    year's company holidays), still correctable for a one-off exception —
//    "used" there is always read-only, since it only ever moves via an
//    approved request.
//  - Year rollover: bulk-grant next year's balances ahead of time, so
//    everyone's summary is populated on day one rather than only
//    appearing after their first leave request of the year (the backend
//    also self-heals this lazily per-request either way — see
//    leave.service.js's requestLeave()).

const EMPTY_TYPE_FORM = { name: '', daysPerYear: '', paid: true, active: true };
const EMPTY_HOLIDAY_FORM = { date: '', name: '' };

export default function LeaveTypesPage() {
  const [types, setTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [typeDialog, setTypeDialog] = useState(null); // { mode: 'new'|'edit', id }
  const [typeForm, setTypeForm] = useState(EMPTY_TYPE_FORM);
  const [typeSaving, setTypeSaving] = useState(false);
  const [typeError, setTypeError] = useState('');

  const [companies, setCompanies] = useState([]);
  const [holidayCompanyId, setHolidayCompanyId] = useState('');
  const [holidayYear, setHolidayYear] = useState(String(new Date().getFullYear()));
  const [holidays, setHolidays] = useState([]);
  const [holidaysLoading, setHolidaysLoading] = useState(false);
  const [holidayError, setHolidayError] = useState('');
  const [holidayForm, setHolidayForm] = useState(EMPTY_HOLIDAY_FORM);
  const [holidaySaving, setHolidaySaving] = useState(false);

  const [recalculating, setRecalculating] = useState(false);
  const [recalculateResult, setRecalculateResult] = useState(null);

  const [entitlements, setEntitlements] = useState(null);
  const [entitlementsLoading, setEntitlementsLoading] = useState(false);
  const [entitlementError, setEntitlementError] = useState('');
  const [entitlementSavingId, setEntitlementSavingId] = useState('');
  const [entitlementDrafts, setEntitlementDrafts] = useState({}); // leaveTypeId -> string being edited

  const [employees, setEmployees] = useState([]);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('');
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [balances, setBalances] = useState(null);
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [balanceError, setBalanceError] = useState('');
  const [savingRowId, setSavingRowId] = useState('');
  const [entitledDrafts, setEntitledDrafts] = useState({}); // leaveTypeId -> string being edited

  const [rolloverYear, setRolloverYear] = useState(String(new Date().getFullYear() + 1));
  const [rolloverRunning, setRolloverRunning] = useState(false);
  const [rolloverResult, setRolloverResult] = useState(null);
  const [rolloverError, setRolloverError] = useState('');

  async function loadTypes() {
    setLoading(true);
    setError('');
    try {
      setTypes(await api.get('/leave/types/all'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load leave types.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadTypes();
    api.get('/employees').then((rows) => setEmployees(rows.filter((e) => e.status === 'active'))).catch(() => {});
    api.get('/companies').then((rows) => {
      setCompanies(rows);
      if (rows.length) setHolidayCompanyId(rows[0].id);
    }).catch(() => {});
  }, []);

  async function loadHolidays(companyId, y) {
    if (!companyId) { setHolidays([]); return; }
    setHolidaysLoading(true);
    setHolidayError('');
    try {
      setHolidays(await api.get('/leave/holidays?companyId=' + companyId + '&year=' + encodeURIComponent(y)));
    } catch (err) {
      setHolidayError(err instanceof ApiError ? err.message : 'Could not load holidays.');
    } finally {
      setHolidaysLoading(false);
    }
  }

  useEffect(() => {
    if (holidayCompanyId) loadHolidays(holidayCompanyId, holidayYear);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holidayCompanyId, holidayYear]);

  async function addHoliday(e) {
    e.preventDefault();
    setHolidaySaving(true);
    setHolidayError('');
    try {
      await api.post('/leave/holidays', { companyId: holidayCompanyId, date: holidayForm.date, name: holidayForm.name });
      setHolidayForm(EMPTY_HOLIDAY_FORM);
      await loadHolidays(holidayCompanyId, holidayYear);
    } catch (err) {
      setHolidayError(err instanceof ApiError ? err.message : 'Could not add that holiday.');
    } finally {
      setHolidaySaving(false);
    }
  }

  async function removeHoliday(id) {
    setHolidayError('');
    try {
      await api.del('/leave/holidays/' + id);
      await loadHolidays(holidayCompanyId, holidayYear);
    } catch (err) {
      setHolidayError(err instanceof ApiError ? err.message : 'Could not remove that holiday.');
    }
  }

  function openNewType() {
    setTypeForm(EMPTY_TYPE_FORM);
    setTypeError('');
    setTypeDialog({ mode: 'new' });
  }
  function openEditType(t) {
    setTypeForm({ name: t.name, daysPerYear: String(t.daysPerYear), paid: t.paid, active: t.active });
    setTypeError('');
    setTypeDialog({ mode: 'edit', id: t.id });
  }

  async function saveType(e) {
    e.preventDefault();
    setTypeSaving(true);
    setTypeError('');
    try {
      const body = { name: typeForm.name, daysPerYear: Number(typeForm.daysPerYear), paid: typeForm.paid, active: typeForm.active };
      if (typeDialog.mode === 'new') await api.post('/leave/types', body);
      else await api.patch('/leave/types/' + typeDialog.id, body);
      setTypeDialog(null);
      await loadTypes();
    } catch (err) {
      setTypeError(err instanceof ApiError ? err.message : 'Could not save that leave type.');
    } finally {
      setTypeSaving(false);
    }
  }

  async function loadBalances(empId, y) {
    if (!empId) { setBalances(null); return; }
    setBalancesLoading(true);
    setBalanceError('');
    try {
      const rows = await api.get('/leave/balances/' + empId + '?year=' + encodeURIComponent(y));
      setBalances(rows);
      setEntitledDrafts(Object.fromEntries(rows.map((r) => [r.leaveTypeId, String(r.entitled)])));
    } catch (err) {
      setBalanceError(err instanceof ApiError ? err.message : 'Could not load balances.');
      setBalances(null);
    } finally {
      setBalancesLoading(false);
    }
  }

  async function loadEntitlements(empId) {
    if (!empId) { setEntitlements(null); return; }
    setEntitlementsLoading(true);
    setEntitlementError('');
    try {
      const rows = await api.get('/leave/entitlements/' + empId);
      setEntitlements(rows);
      setEntitlementDrafts(Object.fromEntries(rows.map((r) => [r.leaveTypeId, String(r.daysPerYear)])));
    } catch (err) {
      setEntitlementError(err instanceof ApiError ? err.message : 'Could not load entitlements.');
      setEntitlements(null);
    } finally {
      setEntitlementsLoading(false);
    }
  }

  function onEmployeeChange(id) {
    setSelectedEmployeeId(id);
    setRecalculateResult(null);
    loadBalances(id, year);
    loadEntitlements(id);
  }
  function onYearChange(y) {
    setYear(y);
    setRecalculateResult(null);
    if (selectedEmployeeId) loadBalances(selectedEmployeeId, y);
  }

  // A leave_balances row is only ever set once (at grant time) and never
  // automatically tracks a later change to a leave type's default or a
  // company's holiday list — Save/Reset on Base Entitlement above only
  // re-syncs the one row it actually touches, so a type nobody's
  // customized (still sitting at the default) can go stale silently.
  // This walks every leave type for the employee/year and snaps each
  // existing row back onto the current formula in one action.
  async function recalculateBalances() {
    setRecalculating(true);
    setBalanceError('');
    setRecalculateResult(null);
    try {
      const res = await api.post('/leave/balances/recalculate', { employeeId: selectedEmployeeId, year: Number(year) });
      setRecalculateResult(res);
      await loadBalances(selectedEmployeeId, year);
    } catch (err) {
      setBalanceError(err instanceof ApiError ? err.message : 'Could not recalculate balances.');
    } finally {
      setRecalculating(false);
    }
  }

  async function saveEntitlement(leaveTypeId) {
    const draft = entitlementDrafts[leaveTypeId];
    const daysPerYear = Number(draft);
    if (!Number.isInteger(daysPerYear) || daysPerYear < 0) { setEntitlementError('Days must be a whole number, 0 or more.'); return; }
    setEntitlementSavingId(leaveTypeId);
    setEntitlementError('');
    try {
      // year: so the backend can immediately update this year's balance
      // too, if one's already been granted — otherwise the change is
      // invisible below until the balance is next (re)granted.
      await api.post('/leave/entitlements', { employeeId: selectedEmployeeId, leaveTypeId, daysPerYear, year: Number(year) });
      await Promise.all([loadEntitlements(selectedEmployeeId), loadBalances(selectedEmployeeId, year)]);
    } catch (err) {
      setEntitlementError(err instanceof ApiError ? err.message : 'Could not save that entitlement.');
    } finally {
      setEntitlementSavingId('');
    }
  }

  async function resetEntitlement(leaveTypeId) {
    setEntitlementSavingId(leaveTypeId);
    setEntitlementError('');
    try {
      await api.del('/leave/entitlements/' + selectedEmployeeId + '/' + leaveTypeId + '?year=' + encodeURIComponent(year));
      await Promise.all([loadEntitlements(selectedEmployeeId), loadBalances(selectedEmployeeId, year)]);
    } catch (err) {
      setEntitlementError(err instanceof ApiError ? err.message : 'Could not reset that entitlement.');
    } finally {
      setEntitlementSavingId('');
    }
  }

  async function saveEntitled(leaveTypeId) {
    const draft = entitledDrafts[leaveTypeId];
    const entitled = Number(draft);
    if (!Number.isInteger(entitled) || entitled < 0) { setBalanceError('Days must be a whole number, 0 or more.'); return; }
    setSavingRowId(leaveTypeId);
    setBalanceError('');
    try {
      await api.post('/leave/balances', { employeeId: selectedEmployeeId, leaveTypeId, year: Number(year), entitled });
      await loadBalances(selectedEmployeeId, year);
    } catch (err) {
      setBalanceError(err instanceof ApiError ? err.message : 'Could not save that balance.');
    } finally {
      setSavingRowId('');
    }
  }

  async function runRollover() {
    const y = Number(rolloverYear);
    if (!Number.isInteger(y)) { setRolloverError('Enter a valid year.'); return; }
    setRolloverRunning(true);
    setRolloverError('');
    setRolloverResult(null);
    try {
      const res = await api.post('/leave/rollover', { year: y });
      setRolloverResult(res);
      if (selectedEmployeeId && String(y) === year) loadBalances(selectedEmployeeId, year);
    } catch (err) {
      setRolloverError(err instanceof ApiError ? err.message : 'Could not run the rollover.');
    } finally {
      setRolloverRunning(false);
    }
  }

  return (
    <div>
      <p className="leavetypes-intro">Set what each leave type is worth per year, correct an individual employee's entitlement, and grant a new year's balances ahead of time.</p>

      <section className="leavetypes-section">
        <div className="leavetypes-section-header">
          <h2>Leave types</h2>
          <button type="button" className="btn btn-primary" onClick={openNewType}>+ New leave type</button>
        </div>
        {error && <div className="error-banner">{error}</div>}
        {loading ? (
          <p className="table-empty">Loading…</p>
        ) : (
          <table className="table" style={{ marginTop: 12 }}>
            <thead><tr><th>Name</th><th>Days / year</th><th>Paid</th><th>Active</th><th /></tr></thead>
            <tbody>
              {types.map((t) => (
                <tr key={t.id} className={t.active ? '' : 'leavetypes-row-inactive'}>
                  <td style={{ fontWeight: 600 }}>{t.name}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{t.daysPerYear}</td>
                  <td>{t.paid ? 'Paid' : 'Unpaid'}</td>
                  <td><span className={'tag ' + (t.active ? 'tag-neutral' : 'tag-accent')}>{t.active ? 'Active' : 'Inactive'}</span></td>
                  <td className="table-actions">
                    <button type="button" className="btn btn-secondary attendance-row-btn" onClick={() => openEditType(t)}>Edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!loading && !types.length && <p className="table-empty">No leave types yet.</p>}
      </section>

      <section className="leavetypes-section">
        <h2>Public holidays</h2>
        <p className="leavetypes-intro">
          Each company keeps its own list. Company policy bakes these into the annual leave allowance — a 21-day type
          with 14 holidays this year nets to 7 bookable days — rather than granting holidays on top of it.
        </p>
        <div className="leavetypes-balance-toolbar">
          <div className="field">
            <label htmlFor="lt-holiday-company">Company</label>
            <select id="lt-holiday-company" className="input" value={holidayCompanyId} onChange={(e) => setHolidayCompanyId(e.target.value)}>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="lt-holiday-year">Year</label>
            <input id="lt-holiday-year" className="input" style={{ width: 110 }} value={holidayYear} onChange={(e) => setHolidayYear(e.target.value)} inputMode="numeric" />
          </div>
        </div>

        {holidayError && <div className="error-banner">{holidayError}</div>}
        {holidaysLoading ? (
          <p className="table-empty">Loading…</p>
        ) : (
          <>
            {holidays.length > 0 && (
              <table className="table" style={{ marginTop: 12 }}>
                <thead><tr><th>Date</th><th>Name</th><th /></tr></thead>
                <tbody>
                  {holidays.map((h) => (
                    <tr key={h.id}>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{h.date}</td>
                      <td>{h.name}</td>
                      <td className="table-actions">
                        <button type="button" className="btn btn-secondary attendance-row-btn" onClick={() => removeHoliday(h.id)}>Remove</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {!holidays.length && <p className="table-empty">No holidays recorded for this company/year yet.</p>}
          </>
        )}

        <form className="leavetypes-holiday-form" onSubmit={addHoliday}>
          <div className="field">
            <label htmlFor="lt-holiday-date">Date</label>
            <input id="lt-holiday-date" type="date" className="input" value={holidayForm.date} onChange={(e) => setHolidayForm({ ...holidayForm, date: e.target.value })} required />
          </div>
          <div className="field">
            <label htmlFor="lt-holiday-name">Name</label>
            <input id="lt-holiday-name" className="input" value={holidayForm.name} onChange={(e) => setHolidayForm({ ...holidayForm, name: e.target.value })} placeholder="e.g. Independence Day" required />
          </div>
          <button type="submit" className="btn btn-secondary" disabled={holidaySaving}>{holidaySaving ? 'Adding…' : '+ Add holiday'}</button>
        </form>
      </section>

      <section className="leavetypes-section">
        <h2>Employee balances</h2>
        <div className="leavetypes-balance-toolbar">
          <div className="field">
            <label htmlFor="lt-employee">Employee</label>
            <select id="lt-employee" className="input" value={selectedEmployeeId} onChange={(e) => onEmployeeChange(e.target.value)}>
              <option value="">Choose an employee…</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName} ({e.code})</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="lt-year">Year</label>
            <input id="lt-year" className="input" style={{ width: 110 }} value={year} onChange={(e) => onYearChange(e.target.value)} inputMode="numeric" />
          </div>
        </div>

        {!selectedEmployeeId && <p className="table-empty">Choose an employee to view and correct their leave balances.</p>}

        {selectedEmployeeId && (
          <>
            <h3 className="leavetypes-subheading">Base entitlement</h3>
            <p className="leavetypes-intro">
              This employee's own annual days per leave type — persists year to year until changed. Defaults to the
              company figure above until you set a personal one (seniority, a negotiated offer, a proration that
              should stick). Saving updates the {year} balance below immediately if one's already been granted.
            </p>
            {entitlementError && <div className="error-banner">{entitlementError}</div>}
            {entitlementsLoading && <p className="table-empty">Loading…</p>}
            {!entitlementsLoading && entitlements && (
              <table className="table" style={{ marginTop: 12, marginBottom: 24 }}>
                <thead><tr><th>Leave type</th><th>Company default</th><th>This employee</th><th /></tr></thead>
                <tbody>
                  {entitlements.map((en) => (
                    <tr key={en.leaveTypeId}>
                      <td style={{ fontWeight: 600 }}>{en.name}{en.isCustom && <span className="tag tag-outline" style={{ marginLeft: 8 }}>Custom</span>}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{en.companyDefault}</td>
                      <td>
                        <input
                          className="input" style={{ width: 80 }} inputMode="numeric"
                          value={entitlementDrafts[en.leaveTypeId] ?? String(en.daysPerYear)}
                          onChange={(e) => setEntitlementDrafts({ ...entitlementDrafts, [en.leaveTypeId]: e.target.value })}
                        />
                      </td>
                      <td className="table-actions">
                        <button
                          type="button" className="btn btn-secondary attendance-row-btn"
                          disabled={entitlementSavingId === en.leaveTypeId || String(en.daysPerYear) === (entitlementDrafts[en.leaveTypeId] ?? String(en.daysPerYear))}
                          onClick={() => saveEntitlement(en.leaveTypeId)}
                        >
                          {entitlementSavingId === en.leaveTypeId ? 'Saving…' : 'Save'}
                        </button>
                        {en.isCustom && (
                          <button type="button" className="btn btn-secondary attendance-row-btn" disabled={entitlementSavingId === en.leaveTypeId} onClick={() => resetEntitlement(en.leaveTypeId)}>
                            Reset to default
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div className="leavetypes-balance-subheader">
              <h3 className="leavetypes-subheading">{year} balance</h3>
              <button type="button" className="btn btn-secondary attendance-row-btn" disabled={recalculating} onClick={recalculateBalances}>
                {recalculating ? 'Recalculating…' : 'Recalculate against current policy'}
              </button>
            </div>
            {recalculateResult && (
              <p className="leavetypes-rollover-result">
                Checked {recalculateResult.checked} leave type(s), updated {recalculateResult.updated} to match the current company default/holidays/personal entitlement.
              </p>
            )}
          </>
        )}

        {balanceError && <div className="error-banner">{balanceError}</div>}
        {selectedEmployeeId && balancesLoading && <p className="table-empty">Loading…</p>}
        {selectedEmployeeId && !balancesLoading && balances && (
          <table className="table" style={{ marginTop: 12 }}>
            <thead><tr><th>Leave type</th><th>Entitled</th><th>Used</th><th>Left</th><th /></tr></thead>
            <tbody>
              {balances.map((b) => (
                <tr key={b.leaveTypeId}>
                  <td style={{ fontWeight: 600 }}>
                    {b.name}
                    {b.holidays > 0 && b.daysPerYear > 0 && <div className="leavetypes-holiday-note">{b.daysPerYear} days/year − {b.holidays} holiday(s){!b.hasRow ? ' (preview)' : ''}</div>}
                  </td>
                  <td>
                    <input
                      className="input" style={{ width: 80 }} inputMode="numeric"
                      value={entitledDrafts[b.leaveTypeId] ?? String(b.entitled)}
                      onChange={(e) => setEntitledDrafts({ ...entitledDrafts, [b.leaveTypeId]: e.target.value })}
                    />
                  </td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{b.used}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{b.entitled - b.used}</td>
                  <td className="table-actions">
                    <button
                      type="button" className="btn btn-secondary attendance-row-btn"
                      disabled={savingRowId === b.leaveTypeId || String(b.entitled) === (entitledDrafts[b.leaveTypeId] ?? String(b.entitled))}
                      onClick={() => saveEntitled(b.leaveTypeId)}
                    >
                      {savingRowId === b.leaveTypeId ? 'Saving…' : 'Save'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="leavetypes-section">
        <h2>Year rollover</h2>
        <p className="leavetypes-intro">
          Grants every active employee this year's balance for each leave type, using its current days/year default.
          Safe to run more than once — it never overwrites a balance that already exists (including one you've corrected above).
        </p>
        <div className="leavetypes-balance-toolbar">
          <div className="field">
            <label htmlFor="lt-rollover-year">Year</label>
            <input id="lt-rollover-year" className="input" style={{ width: 110 }} value={rolloverYear} onChange={(e) => setRolloverYear(e.target.value)} inputMode="numeric" />
          </div>
          <button type="button" className="btn btn-primary" disabled={rolloverRunning} onClick={runRollover}>
            {rolloverRunning ? 'Granting…' : 'Grant balances for this year'}
          </button>
        </div>
        {rolloverError && <div className="error-banner">{rolloverError}</div>}
        {rolloverResult && (
          <p className="leavetypes-rollover-result">
            Granted {rolloverResult.granted} new balance record(s) for {rolloverResult.year}, across {rolloverResult.employees} active employee(s) and {rolloverResult.types} leave type(s).
          </p>
        )}
      </section>

      {typeDialog && (
        <div className="dialog-backdrop" onClick={() => setTypeDialog(null)}>
          <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={saveType}>
            <h2>{typeDialog.mode === 'new' ? 'New leave type' : 'Edit leave type'}</h2>
            {typeError && <div className="error-banner">{typeError}</div>}
            <div className="field">
              <label htmlFor="lt-name">Name</label>
              <input id="lt-name" className="input" value={typeForm.name} onChange={(e) => setTypeForm({ ...typeForm, name: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="lt-days">Days per year</label>
              <input id="lt-days" className="input" value={typeForm.daysPerYear} onChange={(e) => setTypeForm({ ...typeForm, daysPerYear: e.target.value })} inputMode="numeric" required />
              <span className="leavetypes-field-hint">Gross figure, before each company's public holidays are subtracted — see the balance an employee actually gets below.</span>
            </div>
            <label className="leavetypes-checkbox-field">
              <input type="checkbox" checked={typeForm.paid} onChange={(e) => setTypeForm({ ...typeForm, paid: e.target.checked })} />
              Paid leave
            </label>
            {typeDialog.mode === 'edit' && (
              <label className="leavetypes-checkbox-field">
                <input type="checkbox" checked={typeForm.active} onChange={(e) => setTypeForm({ ...typeForm, active: e.target.checked })} />
                Active (shown when requesting leave)
              </label>
            )}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setTypeDialog(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={typeSaving}>{typeSaving ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
