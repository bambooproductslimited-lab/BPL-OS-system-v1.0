import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { tr } from '../lib/i18n.jsx';
import './ViewScopeDialog.css';

// Who someone can see in the Employee directory, Attendance and Leave
// (backend viewScope.service.js / rbac.visibleEmployee). HR or an
// administrator ticks whole companies, whole departments and single people;
// the people who report to a manager are always theirs. A role that sees
// everyone (HR, General Manager, MD, administrator) sees every company, or
// only the companies ticked here. Nobody changes their own, and nobody can
// hand out more than they see themselves (`mine`).

function Glyph({ d, size = 18 }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>;
}
const EYE = <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="3" /></>;
const X = <path d="M6 6l12 12M18 6 6 18" />;

// Everyone below `id` in the reporting line.
function teamOf(id, people) {
  const below = new Map();
  people.forEach((p) => { if (p.managerId) { if (!below.has(p.managerId)) below.set(p.managerId, []); below.get(p.managerId).push(p.id); } });
  const out = new Set(), stack = [...(below.get(id) || [])];
  while (stack.length) { const x = stack.pop(); if (x === id || out.has(x)) continue; out.add(x); (below.get(x) || []).forEach((y) => stack.push(y)); }
  return out;
}

export default function ViewScopeDialog({ employee, people, departments, mine, onClose, onSaved }) {
  const [scope, setScope] = useState(null);
  const [comps, setComps] = useState(new Set());
  const [onlySome, setOnlySome] = useState(false);
  const [depts, setDepts] = useState(new Set());
  const [picked, setPicked] = useState([]);
  const [q, setQ] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    api.get('/employees/' + employee.id + '/view-scope').then((s) => {
      if (!alive) return;
      setScope(s);
      setComps(new Set(s.companies.map((c) => c.id)));
      setOnlySome(s.companiesLimited);
      setDepts(new Set(s.departments.map((d) => d.id)));
      setPicked(s.people.map((p) => p.id));
    }).catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [employee.id]);

  const active = useMemo(() => people.filter((p) => p.status !== 'terminated' && p.id !== employee.id), [people, employee.id]);
  const byId = useMemo(() => Object.fromEntries(people.map((p) => [p.id, p])), [people]);
  const team = useMemo(() => (scope && scope.managerial ? teamOf(employee.id, people) : new Set()), [scope, employee.id, people]);
  const deptName = (id) => (departments.find((d) => d.id === id) || {}).name || '';
  const companyOf = useMemo(() => Object.fromEntries(departments.map((d) => [d.id, d.companyId])), [departments]);
  // Only what the person changing it can see themselves.
  const inReach = (companyId) => !mine || !mine.companiesLimited || mine.companies.some((c) => c.id === companyId);
  const companies = useMemo(() => {
    const seen = new Map();
    departments.forEach((d) => { if (!seen.has(d.companyId) && inReach(d.companyId)) seen.set(d.companyId, { id: d.companyId, name: d.companyName, code: d.companyCode }); });
    return [...seen.values()].sort((a, b) => (a.code === 'BPL' ? -1 : b.code === 'BPL' ? 1 : a.name.localeCompare(b.name)));
  }, [departments, mine]); // eslint-disable-line react-hooks/exhaustive-deps
  const allCompanies = scope && scope.seesAll && !onlySome;

  // What they would see with the ticks as they are now.
  const sees = useMemo(() => {
    if (allCompanies) return active;
    const pickedSet = new Set(picked);
    return active.filter((p) => team.has(p.id) || pickedSet.has(p.id) || depts.has(p.departmentId) || comps.has(companyOf[p.departmentId]));
  }, [active, team, picked, depts, comps, companyOf, allCompanies]);

  const groups = useMemo(() => {
    const m = new Map();
    departments.filter((d) => d.status !== 'archived' && inReach(d.companyId)).forEach((d) => {
      const k = d.companyName || '';
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(d);
    });
    return [...m.entries()].map(([company, list]) => [company, list.sort((a, b) => a.name.localeCompare(b.name))]);
  }, [departments, mine]); // eslint-disable-line react-hooks/exhaustive-deps
  const headcount = (deptId) => active.filter((p) => p.departmentId === deptId).length;
  const companyHeadcount = (id) => active.filter((p) => companyOf[p.departmentId] === id).length;

  const matches = q.trim().length < 1 ? [] : active.filter((p) => {
    if (picked.includes(p.id)) return false;
    const hay = (p.firstName + ' ' + p.lastName + ' ' + p.code + ' ' + (p.positionTitle || '')).toLowerCase();
    return hay.includes(q.trim().toLowerCase());
  }).slice(0, 6);

  const toggle = (set) => (id) => set((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleDept = toggle(setDepts), toggleCompany = toggle(setComps);

  async function save() {
    setSaving(true); setError(null);
    try {
      const s = await api.put('/employees/' + employee.id + '/view-scope', { companyIds: allCompanies ? [] : [...comps], departmentIds: [...depts], employeeIds: picked });
      onSaved && onSaved(s);
    } catch (e) { setError(e.message); setSaving(false); }
  }

  const name = employee.firstName + ' ' + employee.lastName;
  const editable = scope && scope.canEdit;
  const companyBoxes = (
    <div className="vs-depts">
      {companies.map((c) => (
        <label key={c.id} className={'vs-dept' + (comps.has(c.id) ? ' is-on' : '')}>
          <input type="checkbox" checked={comps.has(c.id)} onChange={() => toggleCompany(c.id)} />
          <span className="vs-dept-name">{c.name}</span>
          <span className="vs-dept-n">{companyHeadcount(c.id)}</span>
        </label>
      ))}
    </div>
  );
  return (
    <div className="dialog-backdrop" onClick={() => !saving && onClose()}>
      <div className="dialog vs" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="vs-title">
        <div className="vs-head">
          <span className="vs-head-icon"><Glyph d={EYE} size={20} /></span>
          <div>
            <h2 id="vs-title">{tr('Who {name} can see', { name })}</h2>
            <p className="vs-sub">{tr('In the Employee directory, Attendance and Leave.')}</p>
          </div>
        </div>

        {!scope && !error && <p className="vs-sub">{tr('Loading…')}</p>}
        {error && <div className="error-banner" role="alert">{error}</div>}

        {scope && scope.isSelf && <div className="vs-note">{tr('This is who you can see. You cannot change it yourself: HR or another administrator can.')}</div>}

        {scope && (
          <fieldset className="vs-fieldset" disabled={!editable}>
            <div className="vs-total" aria-live="polite">
              <strong>{sees.length}</strong>
              <span>{tr('of {n} people they can see, besides themselves', { n: active.length })}</span>
            </div>
            {!scope.hasLogin && !scope.isSelf && <div className="vs-note is-warn">{tr('{name} cannot sign in yet. This takes effect once they have a login.', { name })}</div>}
            {scope.hasLogin && !scope.managerial && !scope.seesAll && <div className="vs-note is-warn">{tr('Their role shows only their own attendance and leave, so the people ticked here appear in their Employee directory only.')}</div>}

            {scope.seesAll ? (
              <section className="vs-block">
                <h3>{tr('Companies')}</h3>
                <p className="vs-why">{tr('Their role ({roles}) sees everyone. Choose whether that is every company or only some.', { roles: scope.roleNames.join(', ') })}</p>
                <div className="vs-seg" role="radiogroup" aria-label={tr('Companies')}>
                  {[[false, tr('All companies')], [true, tr('Only these companies')]].map(([k, label]) => (
                    <button key={String(k)} type="button" role="radio" aria-checked={onlySome === k} className={'vs-seg-btn' + (onlySome === k ? ' is-on' : '')} onClick={() => setOnlySome(k)}>{label}</button>
                  ))}
                </div>
                {onlySome && companyBoxes}
                {onlySome && !comps.size && <p className="vs-empty">{tr('Tick at least one company, or choose All companies.')}</p>}
              </section>
            ) : (
              <section className="vs-block">
                <h3>{tr('Whole companies')}</h3>
                <p className="vs-why">{tr('Everyone in a ticked company, in every department, including people who join later.')}</p>
                {companyBoxes}
              </section>
            )}

            {!scope.seesAll && <>
            <section className="vs-block">
              <h3>{tr('Their team')}</h3>
              <p className="vs-why">{tr('The people who report to them, directly or through someone else. Always included — change who reports to whom on each person\'s record.')}</p>
              {team.size ? (
                <div className="vs-chips">{[...team].map((id) => byId[id]).filter(Boolean).filter((p) => p.status !== 'terminated').map((p) => <span key={p.id} className="vs-chip is-fixed">{p.firstName} {p.lastName}</span>)}</div>
              ) : <p className="vs-empty">{scope.managerial ? tr('Nobody reports to them yet.') : tr('Not a manager role, so no team.')}</p>}
            </section>

            <section className="vs-block">
              <h3>{tr('Whole departments')}</h3>
              <p className="vs-why">{tr('Everyone in a ticked department, including people who join it later.')}</p>
              {groups.map(([company, list]) => (
                <div key={company} className="vs-company">
                  {groups.length > 1 && <div className="vs-company-name">{company}</div>}
                  <div className="vs-depts">
                    {list.map((d) => (
                      <label key={d.id} className={'vs-dept' + (depts.has(d.id) || comps.has(d.companyId) ? ' is-on' : '')}>
                        <input type="checkbox" checked={depts.has(d.id) || comps.has(d.companyId)} disabled={comps.has(d.companyId)} onChange={() => toggleDept(d.id)} />
                        <span className="vs-dept-name">{d.name}</span>
                        <span className="vs-dept-n">{headcount(d.id)}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </section>

            <section className="vs-block">
              <h3>{tr('Other people')}</h3>
              <p className="vs-why">{tr('Single people outside their team and departments.')}</p>
              {picked.length > 0 && (
                <div className="vs-chips">
                  {picked.map((id) => byId[id]).filter(Boolean).map((p) => (
                    <span key={p.id} className="vs-chip">
                      {p.firstName} {p.lastName}<small>{deptName(p.departmentId)}</small>
                      <button type="button" aria-label={tr('Remove {name}', { name: p.firstName + ' ' + p.lastName })} onClick={() => setPicked((l) => l.filter((x) => x !== p.id))}><Glyph d={X} size={13} /></button>
                    </span>
                  ))}
                </div>
              )}
              <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Add a person: type a name or ID')} autoComplete="off" />
              {matches.length > 0 && (
                <ul className="vs-matches">
                  {matches.map((p) => (
                    <li key={p.id}>
                      <button type="button" onClick={() => { setPicked((l) => [...l, p.id]); setQ(''); }}>
                        <strong>{p.firstName} {p.lastName}</strong>
                        <span>{p.code} · {p.positionTitle || '—'} · {deptName(p.departmentId)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            </>}
          </fieldset>
        )}

        <div className="dialog-actions">
          {editable ? (
            <>
              <button type="button" className="btn btn-secondary" disabled={saving} onClick={onClose}>{tr('Cancel')}</button>
              <button type="button" className="btn btn-primary" disabled={saving || (scope.seesAll && onlySome && !comps.size)} onClick={save}>{saving ? tr('Saving…') : tr('Save')}</button>
            </>
          ) : <button type="button" className="btn btn-primary" onClick={onClose}>{tr('Close')}</button>}
        </div>
      </div>
    </div>
  );
}
