import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { tr } from '../lib/i18n.jsx';
import './ViewScopeDialog.css';

// Who a manager can see in the Employee directory, Attendance and Leave
// (backend viewScope.service.js / rbac.visibleEmployee). HR ticks whole
// departments and single people; the people who report to the manager are
// always theirs. Roles that see everyone (HR, General Manager, MD,
// administrator) need nothing ticked, and the dialog says so.

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

export default function ViewScopeDialog({ employee, people, departments, onClose, onSaved }) {
  const [scope, setScope] = useState(null);
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
      setDepts(new Set(s.departments.map((d) => d.id)));
      setPicked(s.people.map((p) => p.id));
    }).catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [employee.id]);

  const active = useMemo(() => people.filter((p) => p.status !== 'terminated' && p.id !== employee.id), [people, employee.id]);
  const byId = useMemo(() => Object.fromEntries(people.map((p) => [p.id, p])), [people]);
  const team = useMemo(() => (scope && scope.managerial ? teamOf(employee.id, people) : new Set()), [scope, employee.id, people]);
  const deptName = (id) => (departments.find((d) => d.id === id) || {}).name || '';

  // What they would see with the ticks as they are now.
  const sees = useMemo(() => {
    const pickedSet = new Set(picked);
    return active.filter((p) => team.has(p.id) || pickedSet.has(p.id) || depts.has(p.departmentId));
  }, [active, team, picked, depts]);

  const groups = useMemo(() => {
    const m = new Map();
    departments.filter((d) => d.status !== 'archived').forEach((d) => {
      const k = d.companyName || '';
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(d);
    });
    return [...m.entries()].map(([company, list]) => [company, list.sort((a, b) => a.name.localeCompare(b.name))]);
  }, [departments]);
  const headcount = (deptId) => active.filter((p) => p.departmentId === deptId).length;

  const matches = q.trim().length < 1 ? [] : active.filter((p) => {
    if (picked.includes(p.id)) return false;
    const hay = (p.firstName + ' ' + p.lastName + ' ' + p.code + ' ' + (p.positionTitle || '')).toLowerCase();
    return hay.includes(q.trim().toLowerCase());
  }).slice(0, 6);

  function toggleDept(id) { setDepts((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }); }

  async function save() {
    setSaving(true); setError(null);
    try {
      const s = await api.put('/employees/' + employee.id + '/view-scope', { departmentIds: [...depts], employeeIds: picked });
      onSaved && onSaved(s);
    } catch (e) { setError(e.message); setSaving(false); }
  }

  const name = employee.firstName + ' ' + employee.lastName;
  const editable = scope && !scope.seesAll && scope.canEdit;
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

        {scope && scope.seesAll && (
          <div className="vs-note">{tr('Their role ({roles}) sees everyone in the company, so there is nothing to choose here. To limit what they see, give them a different role.', { roles: scope.roleNames.join(', ') })}</div>
        )}

        {editable && (
          <>
            <div className="vs-total" aria-live="polite">
              <strong>{sees.length}</strong>
              <span>{tr('of {n} people they can see, besides themselves', { n: active.length })}</span>
            </div>
            {!scope.hasLogin && <div className="vs-note is-warn">{tr('{name} cannot sign in yet. This takes effect once they have a login.', { name })}</div>}
            {scope.hasLogin && !scope.managerial && <div className="vs-note is-warn">{tr('Their role shows only their own attendance and leave, so the people ticked here appear in their Employee directory only.')}</div>}

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
                      <label key={d.id} className={'vs-dept' + (depts.has(d.id) ? ' is-on' : '')}>
                        <input type="checkbox" checked={depts.has(d.id)} onChange={() => toggleDept(d.id)} />
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
          </>
        )}

        <div className="dialog-actions">
          {editable ? (
            <>
              <button type="button" className="btn btn-secondary" disabled={saving} onClick={onClose}>{tr('Cancel')}</button>
              <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>{saving ? tr('Saving…') : tr('Save')}</button>
            </>
          ) : <button type="button" className="btn btn-primary" onClick={onClose}>{tr('Close')}</button>}
        </div>
      </div>
    </div>
  );
}
