import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import Photo from '../components/Photo';
import { Glossary, Hero, Icon, Insights, Section, Status, avatarColor, initials, jump } from '../components/DashKit';
import { restaurantLogoUrl } from '../lib/restaurantLogos';
import './EmployeesPage.css';
import './DepartmentsPage.css';
import RowMenu from '../components/RowMenu';

import { tr } from '../lib/i18n.jsx';
// Companies and their departments (and each department's shift times).
// Same "explains itself" layout as the dashboards (components/DashKit.jsx):
// a header with the key numbers (press one to show only those
// departments), what stands out, then a card per company listing its
// departments with their manager, headcount and shift times. Adding and
// editing companies, departments and shifts works as before, in the
// dialogs below.

const EMPTY_COMPANY_FORM = { name: '', code: '' };
const EMPTY_DEPT_FORM = { code: '', name: '', companyId: '', managerId: '' };
const EMPTY_SHIFT_FORM = { name: '', startTime: '', endTime: '' };

export default function DepartmentsPage() {
  const { can } = useAuth();
  const canManage = can('department.manage');
  const navigate = useNavigate();
  const [chip, setChip] = useState(''); // '' | 'nomanager' | 'noshifts' | 'empty'

  const [companies, setCompanies] = useState([]);
  const [managers, setManagers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [search, setSearch] = useState('');

  const [companyDialogOpen, setCompanyDialogOpen] = useState(false);
  const [editCompanyId, setEditCompanyId] = useState(null);
  const [companyForm, setCompanyForm] = useState(EMPTY_COMPANY_FORM);
  const [companyDialogError, setCompanyDialogError] = useState(null);
  const [savingCompany, setSavingCompany] = useState(false);

  const [deptDialogOpen, setDeptDialogOpen] = useState(false);
  const [editDeptId, setEditDeptId] = useState(null);
  const [deptForm, setDeptForm] = useState(EMPTY_DEPT_FORM);
  const [deptDialogError, setDeptDialogError] = useState(null);
  const [savingDept, setSavingDept] = useState(false);

  const [shiftsDialog, setShiftsDialog] = useState(null); // { departmentId, departmentName, shifts, loading, error }
  const [shiftForm, setShiftForm] = useState(EMPTY_SHIFT_FORM);
  const [editShiftId, setEditShiftId] = useState(null);
  const [shiftFormError, setShiftFormError] = useState(null);
  const [savingShift, setSavingShift] = useState(false);

  const [deleteCompanyTarget, setDeleteCompanyTarget] = useState(null);
  const [deleteDeptTarget, setDeleteDeptTarget] = useState(null);
  const [deleteShiftTarget, setDeleteShiftTarget] = useState(null);
  const [dialogError, setDialogError] = useState(null);
  const [deleting, setDeleting] = useState(false);


  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await api.get('/companies');
      setCompanies(list);
      if (canManage) {
        const employees = await api.get('/employees');
        setManagers(employees.map((e) => ({ id: e.id, name: e.firstName + ' ' + e.lastName })));
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [canManage]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);


  // Company dialog
  function openNewCompany() {
    setCompanyDialogError(null);
    setEditCompanyId(null);
    setCompanyForm(EMPTY_COMPANY_FORM);
    setCompanyDialogOpen(true);
  }
  function openEditCompany(c) {
    setCompanyDialogError(null);
    setEditCompanyId(c.id);
    setCompanyForm({ name: c.name, code: c.code });
    setCompanyDialogOpen(true);
  }
  async function handleCompanySubmit(e) {
    e.preventDefault();
    setSavingCompany(true);
    setCompanyDialogError(null);
    try {
      const body = { name: companyForm.name, code: companyForm.code };
      const saved = editCompanyId ? await api.put('/companies/' + editCompanyId, body) : await api.post('/companies', body);
      setToast(tr('Company {code} saved.', { code: saved.code }));
      setCompanyDialogOpen(false);
      await load();
    } catch (err) {
      setCompanyDialogError(err.message);
    } finally {
      setSavingCompany(false);
    }
  }
  async function confirmDeleteCompany() {
    setDeleting(true);
    setDialogError(null);
    try {
      await api.del('/companies/' + deleteCompanyTarget.id);
      setToast(tr('{name} deleted.', { name: deleteCompanyTarget.name }));
      setDeleteCompanyTarget(null);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setDeleting(false);
    }
  }

  // Department dialog
  function openNewDept(companyId) {
    setDeptDialogError(null);
    setEditDeptId(null);
    setDeptForm({ ...EMPTY_DEPT_FORM, companyId: companyId || '' });
    setDeptDialogOpen(true);
  }
  function openEditDept(companyId, d) {
    setDeptDialogError(null);
    setEditDeptId(d.id);
    setDeptForm({ code: d.code, name: d.name, companyId, managerId: d.managerId || '' });
    setDeptDialogOpen(true);
  }
  async function handleDeptSubmit(e) {
    e.preventDefault();
    setSavingDept(true);
    setDeptDialogError(null);
    try {
      const body = { code: deptForm.code, name: deptForm.name, companyId: deptForm.companyId || undefined, managerId: deptForm.managerId || null };
      const saved = editDeptId ? await api.put('/departments/' + editDeptId, body) : await api.post('/departments', body);
      setToast(tr('Department {code} saved.', { code: saved.code }));
      setDeptDialogOpen(false);
      await load();
    } catch (err) {
      setDeptDialogError(err.message);
    } finally {
      setSavingDept(false);
    }
  }
  async function confirmDeleteDept() {
    setDeleting(true);
    setDialogError(null);
    try {
      await api.del('/departments/' + deleteDeptTarget.id);
      setToast(tr('{name} deleted.', { name: deleteDeptTarget.name }));
      setDeleteDeptTarget(null);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setDeleting(false);
    }
  }

  // Shifts dialog (per department)
  async function openShifts(department) {
    setShiftForm(EMPTY_SHIFT_FORM);
    setEditShiftId(null);
    setShiftFormError(null);
    setShiftsDialog({ departmentId: department.id, departmentName: department.name, shifts: [], loading: true, error: null });
    try {
      const shifts = await api.get('/shifts?departmentId=' + department.id);
      setShiftsDialog({ departmentId: department.id, departmentName: department.name, shifts, loading: false, error: null });
    } catch (err) {
      setShiftsDialog({ departmentId: department.id, departmentName: department.name, shifts: [], loading: false, error: err.message });
    }
  }
  async function reloadShifts() {
    if (!shiftsDialog) return;
    try {
      const shifts = await api.get('/shifts?departmentId=' + shiftsDialog.departmentId);
      setShiftsDialog({ ...shiftsDialog, shifts, loading: false, error: null });
    } catch (err) {
      setShiftsDialog({ ...shiftsDialog, loading: false, error: err.message });
    }
  }
  function startEditShift(s) {
    setEditShiftId(s.id);
    setShiftForm({ name: s.name, startTime: s.startTime, endTime: s.endTime });
    setShiftFormError(null);
  }
  function cancelEditShift() {
    setEditShiftId(null);
    setShiftForm(EMPTY_SHIFT_FORM);
    setShiftFormError(null);
  }
  async function handleShiftSubmit(e) {
    e.preventDefault();
    setSavingShift(true);
    setShiftFormError(null);
    try {
      const body = { name: shiftForm.name, startTime: shiftForm.startTime, endTime: shiftForm.endTime, departmentId: shiftsDialog.departmentId };
      if (editShiftId) await api.put('/shifts/' + editShiftId, body);
      else await api.post('/shifts', body);
      setToast(editShiftId ? tr('Shift updated.') : tr('Shift added.'));
      setEditShiftId(null);
      setShiftForm(EMPTY_SHIFT_FORM);
      await reloadShifts();
      await load();
    } catch (err) {
      setShiftFormError(err.message);
    } finally {
      setSavingShift(false);
    }
  }
  async function confirmDeleteShift() {
    setDeleting(true);
    setDialogError(null);
    try {
      await api.del('/shifts/' + deleteShiftTarget.id);
      setToast(tr('{name} deleted.', { name: deleteShiftTarget.name }));
      setDeleteShiftTarget(null);
      await reloadShifts();
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setDeleting(false);
    }
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const allDepts = companies.flatMap((c) => c.departments.map((d) => ({ ...d, company: c })));
  const people = allDepts.reduce((n, d) => n + d.headcount, 0);
  const shiftTotal = allDepts.reduce((n, d) => n + d.shiftCount, 0);
  const hasManager = (d) => !!d.managerId;
  const noManager = allDepts.filter((d) => !hasManager(d) && d.headcount > 0);
  const noShifts = allDepts.filter((d) => !d.shiftCount && d.headcount > 0);
  const empty = allDepts.filter((d) => d.headcount === 0);
  const deptTest = {
    nomanager: (d) => !hasManager(d) && d.headcount > 0,
    noshifts: (d) => !d.shiftCount && d.headcount > 0,
    empty: (d) => d.headcount === 0
  };
  const filtered = companies
    .map((c) => {
      const companyHit = matchesQuery(search, c.code, c.name);
      const depts = c.departments
        .filter((d) => !chip || deptTest[chip](d))
        .filter((d) => companyHit || matchesQuery(search, d.code, d.name, d.managerName, ...d.shifts.map((s) => s.name)))
        .sort((a, b) => b.headcount - a.headcount || a.name.localeCompare(b.name));
      return { ...c, shown: depts, people: c.departments.reduce((n, d) => n + d.headcount, 0), shifts: c.departments.reduce((n, d) => n + d.shiftCount, 0) };
    })
    .filter((c) => (chip ? c.shown.length : (matchesQuery(search, c.code, c.name) || c.shown.length)))
    .sort((a, b) => (a.code === 'BPL' ? -1 : b.code === 'BPL' ? 1 : a.name.localeCompare(b.name)));

  function showOnly(key) { setChip(chip === key ? '' : key); jump('co-list'); }
  const stats = [
    { icon: 'drawer', value: String(companies.length), label: companies.length === 1 ? tr('company') : tr('companies'), note: tr('{n} departments', { n: allDepts.length }), onClick: () => { setChip(''); jump('co-list'); } },
    { icon: 'people', value: String(people), label: tr('people'), note: tr('active staff in all companies'), onClick: () => navigate('/people') },
    { icon: 'warn', value: String(noManager.length), label: tr('without a manager'), note: tr('departments with staff'), tone: noManager.length ? 'alert' : '', onClick: () => showOnly('nomanager') },
    { icon: 'clock', value: String(shiftTotal), label: tr('shift times'), note: noShifts.length ? tr('{n} departments have none', { n: noShifts.length }) : tr('every department has one'), onClick: () => showOnly('noshifts') }
  ];

  const insights = [];
  const names = (arr) => (arr.length <= 3 ? arr.map((d) => d.name).join(', ') : tr('{names} and {n} more', { names: arr.slice(0, 2).map((d) => d.name).join(', '), n: arr.length - 2 }));
  if (noManager.length) insights.push({ tone: 'warn', icon: 'people', text: noManager.length === 1 ? tr('{name} has staff but no manager set.', { name: noManager[0].name + ' (' + noManager[0].company.code + ')' }) : tr('{n} departments have staff but no manager set: {names}.', { n: noManager.length, names: names(noManager) }), action: canManage ? { label: tr('Show them'), run: () => showOnly('nomanager') } : null });
  if (noShifts.length) insights.push({ tone: 'info', icon: 'clock', text: tr('{names}: no shift times yet, so attendance uses each person\'s own start time or the company default to decide who is late.', { names: names(noShifts) }), action: { label: tr('Show them'), run: () => showOnly('noshifts') } });
  if (empty.length) insights.push({ tone: 'info', icon: 'info', text: empty.length === 1 ? tr('{name} has nobody in it.', { name: empty[0].name + ' (' + empty[0].company.code + ')' }) : tr('{n} departments have nobody in them. Delete the ones you no longer need.', { n: empty.length }), action: { label: tr('Show them'), run: () => showOnly('empty') } });
  const bigCo = companies.map((c) => ({ c, n: c.departments.reduce((s, d) => s + d.headcount, 0) })).sort((a, b) => b.n - a.n)[0];
  if (bigCo && people && companies.length > 1) insights.push({ tone: 'info', icon: 'people', text: tr('{name} has the most people: {n} of {total}.', { name: bigCo.c.name, n: bigCo.n, total: people }) });
  const bigDept = allDepts.slice().sort((a, b) => b.headcount - a.headcount)[0];
  if (bigDept && bigDept.headcount && allDepts.length > 1) insights.push({ tone: 'info', icon: 'people', text: tr('The biggest department is {name} ({company}), with {n} people.', { name: bigDept.name, company: bigDept.company.code, n: bigDept.headcount }) });
  const bare = companies.filter((c) => !c.departments.length);
  if (bare.length) insights.push({ tone: 'warn', icon: 'drawer', text: tr('{names} has no departments yet, so nobody can be added to it.', { names: bare.map((c) => c.name).join(', ') }) });

  const chips = [
    ['', tr('All'), allDepts.length],
    ['nomanager', tr('No manager'), noManager.length],
    ['noshifts', tr('No shift times'), noShifts.length],
    ['empty', tr('Empty'), empty.length]
  ];

  return (
    <div className="dk co">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <Hero
        eyebrow={tr('Bamboo OS')}
        title={tr('Companies & departments')}
        sub={tr('The companies in the OS, their departments, who manages each one and the shift times people work. People, attendance and the dashboards are all organised by these. Press a number to show only those departments.')}
        actions={canManage && <>
          <button type="button" className="btn btn-primary" onClick={() => openNewDept('')}>{tr('Add department')}</button>
          <button type="button" className="btn btn-secondary" onClick={openNewCompany}>{tr('Add company')}</button>
        </>}
        stats={stats} />

      <Insights items={insights.slice(0, 6)} />

      <Section id="co-list" title={tr('Companies')} sub={tr('Each company with its departments, biggest first.')}>
        <div className="co-tools">
          <div className="co-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search companies, departments, managers…')} /></div>
          <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
            {chips.map(([key, label, n]) => (
              <button key={key || 'all'} type="button" role="radio" aria-checked={chip === key} className={'ppl-chip' + (chip === key ? ' is-on' : '')} onClick={() => setChip(key)}>
                {label} <span className="ppl-chip-n">{n}</span>
              </button>
            ))}
          </div>
        </div>

        {filtered.map((c) => {
          const logo = restaurantLogoUrl(c.code);
          const max = Math.max(1, ...c.departments.map((d) => d.headcount));
          return (
            <article key={c.id} className="co-card">
              <header className="co-head">
                {logo
                  ? <img className="co-logo" src={logo} alt="" />
                  : <span className="co-mark" style={{ background: avatarColor(c.name) }} aria-hidden="true">{initials(c.name)}</span>}
                <div className="co-title">
                  <h3>{c.name}</h3>
                  <span className="dk-muted">{c.code}{c.status !== 'active' && <> · <Status tone="muted">{tr('Archived')}</Status></>}</span>
                </div>
                <dl className="co-nums">
                  <div><dt>{tr('people')}</dt><dd>{c.people}</dd></div>
                  <div><dt>{tr('departments')}</dt><dd>{c.departments.length}</dd></div>
                  <div><dt>{tr('shift times')}</dt><dd>{c.shifts}</dd></div>
                </dl>
                <div className="co-head-actions">
                  {canManage && <button type="button" className="btn btn-secondary co-small-btn" onClick={() => openNewDept(c.id)}>{tr('+ Department')}</button>}
                  <RowMenu actions={[
                    { label: tr('See people'), onClick: () => navigate('/people?company=' + encodeURIComponent(c.code)) },
                    { label: tr('See attendance'), onClick: () => navigate('/attendance?company=' + encodeURIComponent(c.code)) },
                    { label: tr('Edit company'), onClick: () => openEditCompany(c), hidden: !canManage },
                    { label: tr('Delete company'), onClick: () => { setDialogError(null); setDeleteCompanyTarget(c); }, danger: true, hidden: !(canManage && c.departments.length === 0) }
                  ]} />
                </div>
              </header>

              {!c.departments.length ? (
                <div className="dk-empty"><p>{tr('No departments yet. Add one so people can be assigned to this company.')}</p></div>
              ) : (
                <ul className="co-depts">
                  {c.shown.map((d) => (
                    <li key={d.id} className="co-dept">
                      <div className="co-dept-name">
                        <strong>{d.name}</strong>
                        <span className="dk-muted">{d.code}</span>
                      </div>
                      <div className="co-dept-mgr">
                        {hasManager(d) ? (
                          <><Photo id={d.managerId} name={d.managerName} photo={d.managerPhoto} size={28} /><span className="co-mgr-text"><span className="dk-muted co-label">{tr('Manager')}</span>{d.managerName}</span></>
                        ) : (
                          <Status tone={d.headcount ? 'warn' : 'muted'}>{tr('No manager')}</Status>
                        )}
                      </div>
                      <button type="button" className="co-dept-count" onClick={() => navigate('/people?company=' + encodeURIComponent(c.code))} title={tr('See people')}>
                        <span className="co-dept-count-row"><strong>{d.headcount}</strong> <span className="dk-muted">{d.headcount === 1 ? tr('person') : tr('people')}</span></span>
                        <span className="dk-track" aria-hidden="true"><span style={{ width: Math.round((d.headcount / max) * 100) + '%' }} /></span>
                      </button>
                      <div className="co-dept-shifts">
                        {d.shifts.length ? d.shifts.slice(0, 2).map((s) => (
                          <span key={s.id} className="co-shift" title={tr('{n} people on this shift', { n: s.assignedCount })}>
                            <Icon name="clock" /> {s.name} <span className="dk-muted">{s.startTime}–{s.endTime}</span>
                          </span>
                        )) : <span className="dk-muted">{tr('No shift times')}</span>}
                        {d.shifts.length > 2 && <span className="dk-muted">{tr('+{n} more', { n: d.shifts.length - 2 })}</span>}
                      </div>
                      <div className="co-dept-actions">
                        <RowMenu actions={[
                          { label: canManage ? tr('Shift times') : tr('See shift times'), onClick: () => openShifts(d) },
                          { label: tr('Edit'), onClick: () => openEditDept(c.id, d), hidden: !canManage },
                          { label: tr('Delete'), onClick: () => { setDialogError(null); setDeleteDeptTarget(d); }, danger: true, hidden: !(canManage && d.headcount === 0) }
                        ]} />
                      </div>
                    </li>
                  ))}
                  {!c.shown.length && <li className="co-dept is-none dk-muted">{tr('No departments here match.')}</li>}
                </ul>
              )}
            </article>
          );
        })}

        {!companies.length && <div className="dk-empty"><p>{tr('No companies yet')}</p></div>}
        {!!companies.length && !filtered.length && (
          <div className="dk-empty">
            <p>{search ? tr('No companies match "{search}"', { search }) : tr('Nothing matches this filter.')}</p>
            <button type="button" className="btn btn-secondary" onClick={() => { setSearch(''); setChip(''); }}>{tr('Clear filters')}</button>
          </div>
        )}
      </Section>

      <Glossary items={[
        [tr('Company'), tr('One of the businesses in the OS, such as Bamboo Products or a restaurant. Each has its own departments, people and figures.')],
        [tr('Department'), tr('A team inside a company (other pages call it a group). Every person belongs to one.')],
        [tr('Code'), tr('A short name used in reports and employee codes, such as BPL or PROD.')],
        [tr('Manager'), tr('The person in charge of a department. Managers can see the people in their department.')],
        [tr('Shift times'), tr('The start and end times people in a department work. Attendance uses the start time to decide who is late.')],
        [tr('Empty'), tr('A department with nobody in it. Only empty departments and companies without departments can be deleted.')]
      ]} />

      {companyDialogOpen && (
        <div className="dialog-backdrop" onClick={() => setCompanyDialogOpen(false)}>
          <form className="dialog departments-dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleCompanySubmit}>
            <h2 className="departments-dialog-title">{editCompanyId ? tr('Edit company') : tr('Add company')}</h2>
            {companyDialogError && <div className="error-banner departments-dialog-span">{companyDialogError}</div>}
            <div className="field departments-dialog-span">
              <label htmlFor="company-name">{tr('Company name')}</label>
              <input id="company-name" className="input" value={companyForm.name} onChange={(e) => setCompanyForm({ ...companyForm, name: e.target.value })} placeholder="Bamboo Products Limited" required />
            </div>
            <div className="field">
              <label htmlFor="company-code">{tr('Code')}</label>
              <input id="company-code" className="input" maxLength={8} value={companyForm.code} onChange={(e) => setCompanyForm({ ...companyForm, code: e.target.value })} placeholder="BPL" required />
            </div>
            <div className="dialog-actions departments-dialog-span">
              <button type="button" className="btn btn-secondary" onClick={() => setCompanyDialogOpen(false)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={savingCompany}>{savingCompany ? tr('Saving…') : (editCompanyId ? tr('Save changes') : tr('Create'))}</button>
            </div>
          </form>
        </div>
      )}

      {deptDialogOpen && (
        <div className="dialog-backdrop" onClick={() => setDeptDialogOpen(false)}>
          <form className="dialog departments-dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleDeptSubmit}>
            <h2 className="departments-dialog-title">{editDeptId ? tr('Edit department') : tr('Add department')}</h2>
            {deptDialogError && <div className="error-banner departments-dialog-span">{deptDialogError}</div>}
            <div className="field departments-dialog-span">
              <label htmlFor="dept-company">{tr('Company')}</label>
              <select id="dept-company" className="input" value={deptForm.companyId} onChange={(e) => setDeptForm({ ...deptForm, companyId: e.target.value })} required>
                <option value="" disabled>{tr('Select a company…')}</option>
                {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="dept-code">{tr('Code')}</label>
              <input id="dept-code" className="input" maxLength={5} value={deptForm.code} onChange={(e) => setDeptForm({ ...deptForm, code: e.target.value })} placeholder="PROD" required />
            </div>
            <div className="field">
              <label htmlFor="dept-name">{tr('Department name')}</label>
              <input id="dept-name" className="input" value={deptForm.name} onChange={(e) => setDeptForm({ ...deptForm, name: e.target.value })} placeholder={tr('Productions')} required />
            </div>
            <div className="field departments-dialog-span">
              <label htmlFor="dept-manager">{tr('Manager')}</label>
              <select id="dept-manager" className="input" value={deptForm.managerId} onChange={(e) => setDeptForm({ ...deptForm, managerId: e.target.value })}>
                <option value="">{tr('Unassigned')}</option>
                {managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
            <div className="dialog-actions departments-dialog-span">
              <button type="button" className="btn btn-secondary" onClick={() => setDeptDialogOpen(false)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={savingDept}>{savingDept ? tr('Saving…') : (editDeptId ? tr('Save changes') : tr('Create'))}</button>
            </div>
          </form>
        </div>
      )}

      {shiftsDialog && (
        <div className="dialog-backdrop" onClick={() => setShiftsDialog(null)}>
          <div className="dialog departments-shifts-dialog" onClick={(e) => e.stopPropagation()}>
            <h2 className="departments-dialog-title">{tr('Shifts —')} {shiftsDialog.departmentName}</h2>
            {shiftsDialog.error && <div className="error-banner">{shiftsDialog.error}</div>}
            {shiftsDialog.loading ? (
              <div className="eyebrow">{tr('Loading…')}</div>
            ) : (
              <>
                {!shiftsDialog.shifts.length && <p className="departments-nested-empty">{tr('No shifts yet for this department.')}</p>}
                {!!shiftsDialog.shifts.length && (
                  <table className="table departments-shifts-table">
                    <thead>
                      <tr><th>{tr('Shift')}</th><th>{tr('Start')}</th><th>{tr('End')}</th><th>{tr('Assigned')}</th><th /></tr>
                    </thead>
                    <tbody>
                      {shiftsDialog.shifts.map((s) => (
                        <tr key={s.id}>
                          <td style={{ fontWeight: 600 }}>{s.name}</td>
                          <td>{s.startTime}</td>
                          <td>{s.endTime}</td>
                          <td>{s.assignedCount}</td>
                          <td className="table-actions" onClick={(e) => e.stopPropagation()}>
                            <RowMenu actions={[
                              { label: tr('Edit'), onClick: () => startEditShift(s), hidden: !(canManage) },
                              { label: tr('Delete'), onClick: () => { setDialogError(null); setDeleteShiftTarget(s); }, danger: true, hidden: !(canManage && s.assignedCount === 0) },
                            ]} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {canManage && (
                  <form className="departments-shift-form" onSubmit={handleShiftSubmit}>
                    {shiftFormError && <div className="error-banner departments-dialog-span">{shiftFormError}</div>}
                    <div className="field">
                      <label htmlFor="shift-name">{tr('Shift name')}</label>
                      <input id="shift-name" className="input" maxLength={40} value={shiftForm.name} onChange={(e) => setShiftForm({ ...shiftForm, name: e.target.value })} placeholder={tr('Day Shift')} required />
                    </div>
                    <div className="field">
                      <label htmlFor="shift-start">{tr('Start time')}</label>
                      <input id="shift-start" className="input" type="time" value={shiftForm.startTime} onChange={(e) => setShiftForm({ ...shiftForm, startTime: e.target.value })} required />
                    </div>
                    <div className="field">
                      <label htmlFor="shift-end">{tr('End time')}</label>
                      <input id="shift-end" className="input" type="time" value={shiftForm.endTime} onChange={(e) => setShiftForm({ ...shiftForm, endTime: e.target.value })} required />
                    </div>
                    {editShiftId && <button type="button" className="btn btn-secondary" onClick={cancelEditShift}>{tr('Cancel')}</button>}
                    <button className="btn btn-primary" type="submit" disabled={savingShift}>
                      {savingShift ? tr('Saving…') : (editShiftId ? tr('Save changes') : tr('+ Add shift'))}
                    </button>
                  </form>
                )}
              </>
            )}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShiftsDialog(null)}>{tr('Close')}</button>
            </div>
          </div>
        </div>
      )}

      {deleteCompanyTarget && (
        <div className="dialog-backdrop" onClick={() => setDeleteCompanyTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Delete company')}</h2>
            <p className="dialog-body">{tr('Delete')} <strong>{deleteCompanyTarget.name}</strong>{tr('? This cannot be undone.')}</p>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDeleteCompanyTarget(null)}>{tr('Cancel')}</button>
              <button type="button" className="btn btn-primary" disabled={deleting} onClick={confirmDeleteCompany}>
                {deleting ? tr('Deleting…') : tr('Delete company')}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteDeptTarget && (
        <div className="dialog-backdrop" onClick={() => setDeleteDeptTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Delete department')}</h2>
            <p className="dialog-body">{tr('Delete')} <strong>{deleteDeptTarget.name}</strong>{tr('? This cannot be undone.')}</p>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDeleteDeptTarget(null)}>{tr('Cancel')}</button>
              <button type="button" className="btn btn-primary" disabled={deleting} onClick={confirmDeleteDept}>
                {deleting ? tr('Deleting…') : tr('Delete department')}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteShiftTarget && (
        <div className="dialog-backdrop" onClick={() => setDeleteShiftTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Delete shift')}</h2>
            <p className="dialog-body">{tr('Delete')} <strong>{deleteShiftTarget.name}</strong>{tr('? This cannot be undone.')}</p>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDeleteShiftTarget(null)}>{tr('Cancel')}</button>
              <button type="button" className="btn btn-primary" disabled={deleting} onClick={confirmDeleteShift}>
                {deleting ? tr('Deleting…') : tr('Delete shift')}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
