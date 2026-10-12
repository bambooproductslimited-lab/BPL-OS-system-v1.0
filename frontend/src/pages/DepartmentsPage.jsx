import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import Photo from '../components/Photo';
import { Glossary, Insights, Section, Status, jump } from '../components/DashKit';
import { CoBanner, CompanyMark, Faces, GlanceTile, MiniRing, ShiftChip, ShiftClock, accentStyle, companyOrder, joined, years } from './CompaniesFun';
import './EmployeesPage.css';
import './DepartmentsPage.css';
import './CompaniesFun.css';
import RowMenu from '../components/RowMenu';

import { tr } from '../lib/i18n.jsx';
// Companies and their departments (and each department's shift times).
// An org-chart banner with how many are in today, what stands out, a tile
// per company with its team make-up, the 24-hour "who works when" of every
// shift time, then each company with its departments as cards: manager,
// faces, who is in today, shift times (backend companies.service.js
// overview()). Adding and editing companies, departments and shifts works
// as before, in the dialogs below.

const EMPTY_COMPANY_FORM = { name: '', code: '' };
const EMPTY_DEPT_FORM = { code: '', name: '', companyId: '', managerId: '' };
const EMPTY_SHIFT_FORM = { name: '', startTime: '', endTime: '' };

export default function DepartmentsPage() {
  const { can } = useAuth();
  const canManage = can('department.manage');
  const navigate = useNavigate();
  const [chip, setChip] = useState(''); // '' | 'nomanager' | 'noshifts' | 'empty'

  const [companies, setCompanies] = useState([]);
  const [view, setView] = useState(null); // the overview: today, totals, canSeeAttendance
  const [now, setNow] = useState(() => new Date());
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
      const o = await api.get('/companies/overview');
      setView(o);
      setCompanies(o.companies);
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
  // The time now moves along the shift clock.
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 60000); return () => clearInterval(t); }, []);

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
  if (!view) return <div className="dk cof">{error && <div className="error-banner" role="alert">{error}</div>}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const ordered = companyOrder(companies);
  const indexOf = (c) => ordered.findIndex((x) => x.id === c.id);
  const t = view.totals;
  const seeAtt = view.canSeeAttendance;
  const allDepts = companies.flatMap((c) => c.departments.map((d) => ({ ...d, company: c })));
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
  const filtered = ordered
    .map((c) => {
      const companyHit = matchesQuery(search, c.code, c.name);
      const depts = c.departments
        .filter((d) => !chip || deptTest[chip](d))
        .filter((d) => companyHit || matchesQuery(search, d.code, d.name, d.managerName, ...d.shifts.map((s) => s.name), ...(d.faces || []).map((f) => f.name)))
        .sort((a, b) => b.headcount - a.headcount || a.name.localeCompare(b.name));
      return { ...c, shown: depts, shifts: c.departments.reduce((n, d) => n + d.shiftCount, 0) };
    })
    .filter((c) => (chip ? c.shown.length : (matchesQuery(search, c.code, c.name) || c.shown.length)));

  function showOnly(key) { setChip(chip === key ? '' : key); jump('co-list'); }
  const expected = Math.max(0, t.people - t.onLeave);
  const withStaff = allDepts.filter((d) => d.headcount > 0);
  const ring = seeAtt
    ? { value: t.inToday, max: expected, big: (expected ? Math.round((t.inToday / expected) * 100) : 0) + '%', small: tr('in today'), caption: tr('{n} of the {total} expected have clocked in today; {leave} on leave are not counted.', { n: t.inToday, total: expected, leave: t.onLeave }) }
    : { value: withStaff.length - noManager.length, max: withStaff.length || 1, big: (withStaff.length - noManager.length) + '/' + withStaff.length, small: tr('managed'), caption: tr('Departments with staff that have a manager set.') };
  const tiles = [
    { icon: 'building', value: String(t.companies), label: t.companies === 1 ? tr('company') : tr('companies'), note: tr('{n} departments', { n: t.departments }), onClick: () => { setChip(''); jump('co-glance'); } },
    { icon: 'people', value: String(t.people), label: tr('people'), note: t.newThisYear ? tr('{n} joined this year', { n: t.newThisYear }) : tr('active staff in all companies'), onClick: () => navigate('/people') },
    seeAtt
      ? { icon: 'clock', value: String(t.inNow), label: tr('in right now'), note: tr('{n} on leave today', { n: t.onLeave }), onClick: () => navigate('/attendance') }
      : { icon: 'calendar', value: String(t.onLeave), label: tr('on leave today'), note: tr('approved leave'), onClick: () => navigate('/leave') },
    { icon: 'spark', value: years(t.averageYears), label: tr('years with us'), note: t.longestServing ? tr('on average · longest: {name}', { name: t.longestServing.name }) : tr('on average'), onClick: () => navigate('/people') }
  ];

  const insights = [];
  const names = (arr) => (arr.length <= 3 ? arr.map((d) => d.name).join(', ') : tr('{names} and {n} more', { names: arr.slice(0, 2).map((d) => d.name).join(', '), n: arr.length - 2 }));
  if (noManager.length) insights.push({ tone: 'warn', icon: 'people', text: noManager.length === 1 ? tr('{name} has staff but no manager set.', { name: noManager[0].name + ' (' + noManager[0].company.code + ')' }) : tr('{n} departments have staff but no manager set: {names}.', { n: noManager.length, names: names(noManager) }), action: canManage ? { label: tr('Show them'), run: () => showOnly('nomanager') } : null });
  if (noShifts.length) insights.push({ tone: 'info', icon: 'clock', text: tr('{names}: no shift times yet, so attendance uses each person\'s own start time or the company default to decide who is late.', { names: names(noShifts) }), action: { label: tr('Show them'), run: () => showOnly('noshifts') } });
  if (empty.length) insights.push({ tone: 'info', icon: 'info', text: empty.length === 1 ? tr('{name} has nobody in it.', { name: empty[0].name + ' (' + empty[0].company.code + ')' }) : tr('{n} departments have nobody in them. Delete the ones you no longer need.', { n: empty.length }), action: { label: tr('Show them'), run: () => showOnly('empty') } });
  if (seeAtt) {
    const full = withStaff.filter((d) => d.headcount - d.onLeave > 0 && d.inToday >= d.headcount - d.onLeave);
    if (full.length) insights.push({ tone: 'good', icon: 'check', text: full.length === 1 ? tr('Everyone expected in {name} ({company}) is in today.', { name: full[0].name, company: full[0].company.code }) : tr('Everyone expected is in today in {n} departments: {names}.', { n: full.length, names: names(full) }) });
  }
  if (t.newThisYear) {
    const most = companies.slice().sort((a, b) => b.newThisYear - a.newThisYear)[0];
    insights.push({ tone: 'good', icon: 'spark', text: t.newThisYear === 1 ? tr('1 person joined this year.') : tr('{n} people joined this year, most of them at {name} ({m}).', { n: t.newThisYear, name: most.name, m: most.newThisYear }) });
  }
  if (t.longestServing && t.longestServing.hireDate) insights.push({ tone: 'info', icon: 'spark', text: tr('{name} has been with us the longest: since {date}.', { name: t.longestServing.name, date: joined(t.longestServing.hireDate) }) });
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
  const peopleLink = (c, d) => '/people?company=' + encodeURIComponent(c.code) + (d ? '&department=' + encodeURIComponent(d.id) : '');

  return (
    <div className="dk cof">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <CoBanner
        eyebrow={tr('Bamboo OS · The group')}
        title={tr('Companies & departments')}
        sub={tr('Every company in the group, its departments, who manages each one, who is in today and the shift times people work. People, attendance and the dashboards are all organised by these.')}
        actions={canManage && <>
          <button type="button" className="cof-btn is-primary" onClick={() => openNewDept('')}>{tr('Add department')}</button>
          <button type="button" className="cof-btn is-ghost" onClick={openNewCompany}>{tr('Add company')}</button>
        </>}
        ring={ring} tiles={tiles} />

      <Insights items={insights.slice(0, 6)} />

      <Section id="co-glance" title={tr('The group at a glance')} sub={tr('Each company with its people, who is in today and how its departments make it up. Press one to go to it.')}>
        <div className="cof-glance">
          {ordered.map((c, i) => <GlanceTile key={c.id} company={c} index={i} seeAttendance={seeAtt} onOpen={() => jump('co-' + c.code)} />)}
        </div>
      </Section>

      {shiftTotal > 0 && (
        <Section title={tr('Who works when')} sub={tr('Every shift time across the day, by company, with the time now marked. A shift that runs past midnight wraps round to the morning.')}>
          <ShiftClock companies={ordered} now={now} />
        </Section>
      )}

      <Section id="co-list" title={tr('Companies and their departments')} sub={tr('Each department with its manager, its people, who is in today and its shift times. Press the number of people to see them.')}>
        <div className="co-tools">
          <div className="co-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search companies, departments, people…')} /></div>
          <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
            {chips.map(([key, label, n]) => (
              <button key={key || 'all'} type="button" role="radio" aria-checked={chip === key} className={'ppl-chip' + (chip === key ? ' is-on' : '')} onClick={() => setChip(key)}>
                {label} <span className="ppl-chip-n">{n}</span>
              </button>
            ))}
          </div>
        </div>

        {filtered.map((c) => {
          const exp = Math.max(0, c.people - c.onLeave);
          return (
            <article key={c.id} id={'co-' + c.code} className="cof-co" style={accentStyle(indexOf(c))}>
              <header className="cof-co-head">
                <CompanyMark company={c} size={56} />
                <div className="cof-co-title">
                  <h3>{c.name}</h3>
                  <span>{c.code}{c.status !== 'active' && <> · <Status tone="muted">{tr('Archived')}</Status></>}</span>
                </div>
                <div className="cof-co-actions">
                  {canManage && <button type="button" className="cof-btn is-small" onClick={() => openNewDept(c.id)}>{tr('+ Department')}</button>}
                  <RowMenu actions={[
                    { label: tr('See people'), onClick: () => navigate(peopleLink(c)) },
                    { label: tr('See attendance'), onClick: () => navigate('/attendance?company=' + encodeURIComponent(c.code)) },
                    { label: tr('Edit company'), onClick: () => openEditCompany(c), hidden: !canManage },
                    { label: tr('Delete company'), onClick: () => { setDialogError(null); setDeleteCompanyTarget(c); }, danger: true, hidden: !(canManage && c.departments.length === 0) }
                  ]} />
                </div>
                <div className="cof-co-chips">
                  <button type="button" className="cof-chip" onClick={() => navigate(peopleLink(c))}><b>{c.people}</b> {c.people === 1 ? tr('person') : tr('people')}</button>
                  <span className="cof-chip"><b>{c.departments.length}</b> {c.departments.length === 1 ? tr('department') : tr('departments')}</span>
                  {seeAtt && c.people > 0 && <span className="cof-chip is-here"><b>{c.inToday}</b> {tr('of {n} in today', { n: exp })}</span>}
                  {c.onLeave > 0 && <span className="cof-chip is-leave"><b>{c.onLeave}</b> {tr('on leave')}</span>}
                  {c.newThisYear > 0 && <span className="cof-chip is-new"><b>{c.newThisYear}</b> {tr('new this year')}</span>}
                  {c.averageYears !== null && <span className="cof-chip"><b>{years(c.averageYears)}</b> {tr('years on average')}</span>}
                  <span className="cof-chip"><b>{c.shifts}</b> {tr('shift times')}</span>
                </div>
              </header>

              {!c.departments.length ? (
                <div className="dk-empty"><p>{tr('No departments yet. Add one so people can be assigned to this company.')}</p></div>
              ) : (
                <div className="cof-depts">
                  {c.shown.map((d) => {
                    const dExp = Math.max(0, d.headcount - d.onLeave);
                    return (
                      <div key={d.id} className={'cof-dept' + (d.headcount === 0 ? ' is-empty' : '')}>
                        <div className="cof-dept-top">
                          <span className="cof-dept-code">{d.code}</span>
                          <h4>{d.name}</h4>
                          <RowMenu actions={[
                            { label: tr('See people'), onClick: () => navigate(peopleLink(c, d)), hidden: !d.headcount },
                            { label: canManage ? tr('Shift times') : tr('See shift times'), onClick: () => openShifts(d) },
                            { label: tr('Edit'), onClick: () => openEditDept(c.id, d), hidden: !canManage },
                            { label: tr('Delete'), onClick: () => { setDialogError(null); setDeleteDeptTarget(d); }, danger: true, hidden: !(canManage && d.headcount === 0) }
                          ]} />
                        </div>
                        <div className="cof-dept-mgr">
                          {hasManager(d) ? (
                            <><Photo id={d.managerId} name={d.managerName} photo={d.managerPhoto} size={32} /><span className="cof-mgr-text"><small>{tr('Manager')}</small><b>{d.managerName}</b></span></>
                          ) : (
                            <Status tone={d.headcount ? 'warn' : 'muted'}>{tr('No manager')}</Status>
                          )}
                        </div>
                        {d.headcount > 0 ? (
                          <button type="button" className="cof-dept-people" onClick={() => navigate(peopleLink(c, d))} title={tr('See people')}>
                            <Faces faces={d.faces || []} total={d.headcount} />
                            <span className="cof-dept-count"><strong>{d.headcount}</strong><small>{d.headcount === 1 ? tr('person') : tr('people')}</small></span>
                          </button>
                        ) : <p className="cof-muted cof-dept-nobody">{tr('Nobody here yet.')}</p>}
                        {seeAtt && d.headcount > 0 && (
                          <div className="cof-dept-in">
                            <MiniRing value={d.inToday} max={dExp} size={38} label={tr('{n} of {total} in today', { n: d.inToday, total: dExp })} />
                            <span className="cof-in-text"><b>{tr('{n} of {total} in today', { n: d.inToday, total: dExp })}</b><small>{d.inNow ? tr('{n} in right now', { n: d.inNow }) : tr('nobody in right now')}</small></span>
                          </div>
                        )}
                        {(d.onLeave > 0 || d.newThisYear > 0) && (
                          <div className="cof-dept-tags">
                            {d.onLeave > 0 && <span className="cof-chip is-leave"><b>{d.onLeave}</b> {tr('on leave')}</span>}
                            {d.newThisYear > 0 && <span className="cof-chip is-new"><b>{d.newThisYear}</b> {tr('new this year')}</span>}
                          </div>
                        )}
                        <div className="cof-dept-shifts">
                          {d.shifts.length ? d.shifts.slice(0, 3).map((s) => <ShiftChip key={s.id} shift={s} />) : <span className="cof-muted">{tr('No shift times')}</span>}
                          {d.shifts.length > 3 && <button type="button" className="cof-link" onClick={() => openShifts(d)}>{tr('+{n} more', { n: d.shifts.length - 3 })}</button>}
                        </div>
                      </div>
                    );
                  })}
                  {!c.shown.length && <p className="cof-muted">{tr('No departments here match.')}</p>}
                  {canManage && !chip && !search && (
                    <button type="button" className="cof-dept is-add" onClick={() => openNewDept(c.id)}>
                      <span className="cof-add-plus" aria-hidden="true">+</span>
                      <b>{tr('Add a department')}</b>
                      <small>{tr('to {name}', { name: c.name })}</small>
                    </button>
                  )}
                </div>
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
        [tr('In today'), tr('People who clocked in today, against everyone in the department who is not on approved leave.')],
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
