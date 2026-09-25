import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import Photo from '../components/Photo';
import { Glossary, Hero, Insights, Section, Status, fmtDate, jump } from '../components/DashKit';
import { tr } from '../lib/i18n.jsx';
import './EmployeesPage.css';
import './ToolRoomPage.css';
import './RolesPage.css';

// Roles & permissions — what each role may do and who holds it, in the
// same "explains itself" layout as the dashboards (components/DashKit.jsx):
// how many roles and people, who holds the sensitive powers (access, pay,
// settings, the audit log), what stands out (roles nobody holds, roles with
// no permissions, switched-off accounts still holding roles), the roles as
// cards with a window each (members, permissions by group with all / none,
// name and description, copy, delete), the full comparison grid, and the
// latest changes (roles.service.js: list with members, changes, update,
// create with copyFrom, setPermission with several at once).
//
// Permissions are enforced on every operation on the server, not just
// hidden here. The System Administrator role is locked to full access;
// built-in roles keep their names. Everything that changes needs
// role.manage (the nav gates the screen on it too).

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="rl-lock">
      <rect x="5" y="10.5" width="14" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
function ChevronIcon() {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

// Groups the catalogue by its own p.group, in the order each group first
// appears (the API's ordering).
function groupCatalogue(list) {
  const order = [];
  const byGroup = new Map();
  list.forEach((p) => {
    if (!byGroup.has(p.group)) { byGroup.set(p.group, []); order.push(p.group); }
    byGroup.get(p.group).push(p);
  });
  return order.map((g) => ({ group: g, permissions: byGroup.get(g) }));
}
const isAdmin = (r) => r.key === 'administrator';
const EMPTY_NEW = { name: '', description: '', copyFrom: '' };

export default function RolesPage() {
  const { can } = useAuth();
  const canManage = can('role.manage');
  const navigate = useNavigate();

  const [roles, setRoles] = useState([]);
  const [catalogue, setCatalogue] = useState([]);
  const [changes, setChanges] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [busyKey, setBusyKey] = useState(null);
  const [search, setSearch] = useState('');
  const [roleSearch, setRoleSearch] = useState('');
  const [chip, setChip] = useState('all');
  const [detail, setDetail] = useState(null);
  const [edit, setEdit] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [newForm, setNewForm] = useState(EMPTY_NEW);
  const [dialogError, setDialogError] = useState('');
  const [saving, setSaving] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set());
  function toggleGroup(group) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group); else next.add(group);
      return next;
    });
  }

  const load = useCallback(async () => {
    setError(null);
    try {
      const [r, c, ch] = await Promise.all([api.get('/roles'), api.get('/roles/permissions'), canManage ? api.get('/roles/changes') : Promise.resolve([])]);
      setRoles(r);
      setCatalogue(c);
      setChanges(ch);
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

  async function setPerms(role, permissions, on) {
    const key = role.id + ':' + permissions.join(',');
    setBusyKey(key);
    setError(null);
    try {
      await api.post('/roles/' + role.id + '/permissions', { permissions, on });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyKey(null);
    }
  }

  function openNew(copyFrom) {
    setNewForm({ ...EMPTY_NEW, copyFrom: copyFrom || '' });
    setDialogError('');
    setNewOpen(true);
  }
  async function saveNew(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError('');
    try {
      const r = await api.post('/roles', { name: newForm.name, description: newForm.description, copyFrom: newForm.copyFrom || undefined });
      setNewOpen(false);
      setToast(tr('Role "{name}" created.', { name: r.name }));
      await load();
      setDetail(r.id);
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }
  async function saveEdit(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError('');
    try {
      await api.patch('/roles/' + detail, edit);
      setEdit(null);
      setToast(tr('Role updated.'));
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }
  async function remove(role) {
    setSaving(true);
    setError(null);
    try {
      await api.del('/roles/' + role.id);
      setDetail(null);
      setConfirmDelete(false);
      setToast(tr('Role "{name}" deleted.', { name: role.name }));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }
  function openDetail(id) { setEdit(null); setConfirmDelete(false); setDialogError(''); setDetail(id); }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const total = catalogue.length;
  const sensitiveKeys = catalogue.filter((p) => p.sensitive).map((p) => p.key);
  const sensitiveOf = (r) => r.permissions.filter((k) => sensitiveKeys.includes(k));
  const custom = roles.filter((r) => !r.isSystem);
  const unused = roles.filter((r) => r.userCount === 0);
  const unusedCustom = custom.filter((r) => r.userCount === 0);
  const empty = roles.filter((r) => !r.permissions.length && !isAdmin(r));
  const people = new Map();
  roles.forEach((r) => (r.members || []).forEach((m) => { if (!people.has(m.userId)) people.set(m.userId, { ...m, roles: [] }); people.get(m.userId).roles.push(r); }));
  const powerful = [...people.values()].filter((m) => m.status === 'active' && m.roles.some((r) => isAdmin(r) || sensitiveOf(r).length));
  const switchedOff = [...people.values()].filter((m) => m.status !== 'active');
  const recentChanges = changes.filter((c) => Date.now() - new Date(c.at).getTime() < 7 * 86400000);

  function showOnly(key) { setChip(chip === key ? 'all' : key); jump('rl-roles'); }
  const stats = [
    { icon: 'people', value: String(roles.length), label: tr('roles'), note: tr('{s} built in · {c} made here', { s: roles.length - custom.length, c: custom.length }), onClick: () => showOnly('all') },
    { icon: 'check', value: String(people.size), label: tr('people with an account role'), note: switchedOff.length ? tr('{n} of them switched off', { n: switchedOff.length }) : tr('all of them active'), onClick: () => jump('rl-roles') },
    { icon: 'warn', value: String(powerful.length), label: tr('can change access, pay or settings'), note: tr('through {n} roles', { n: roles.filter((r) => r.userCount && (isAdmin(r) || sensitiveOf(r).length)).length }), tone: powerful.length > 5 ? 'warn' : '', onClick: () => showOnly('sensitive') },
    { icon: 'void', value: String(unused.length), label: tr('roles nobody holds'), note: unusedCustom.length ? tr('{n} of them made here', { n: unusedCustom.length }) : tr('only built-in ones'), onClick: () => showOnly('unused') }
  ];

  const insights = [];
  if (powerful.length) insights.push({ tone: 'info', icon: 'warn', text: tr('{n} people can change who has access, pay or company settings: {names}.', { n: powerful.length, names: powerful.slice(0, 6).map((m) => m.name).join(', ') + (powerful.length > 6 ? ' …' : '') }), action: { label: tr('Show the roles'), run: () => showOnly('sensitive') } });
  if (switchedOff.length) insights.push({ tone: 'warn', icon: 'void', text: switchedOff.length === 1 ? tr('{name}\'s account is switched off but still holds {role}.', { name: switchedOff[0].name, role: switchedOff[0].roles.map((r) => r.name).join(', ') }) : tr('{n} switched-off accounts still hold roles.', { n: switchedOff.length }), action: { label: tr('Open User accounts'), run: () => navigate('/users') } });
  if (unusedCustom.length) insights.push({ tone: 'info', icon: 'info', text: unusedCustom.length === 1 ? tr('Nobody holds the role "{name}". Give it to someone or delete it.', { name: unusedCustom[0].name }) : tr('{n} roles made here are held by nobody. Give them to someone or delete them.', { n: unusedCustom.length }), action: { label: unusedCustom.length === 1 ? tr('Open') : tr('Show them'), run: () => (unusedCustom.length === 1 ? openDetail(unusedCustom[0].id) : showOnly('unused')) } });
  if (empty.length) insights.push({ tone: 'warn', icon: 'info', text: empty.length === 1 ? tr('The role "{name}" has no permissions, so its holders can only sign in.', { name: empty[0].name }) : tr('{n} roles have no permissions at all.', { n: empty.length }), action: { label: tr('Open'), run: () => openDetail(empty[0].id) } });
  if (recentChanges.length) insights.push({ tone: 'info', icon: 'clock', text: recentChanges.length === 1 ? tr('One change to roles in the last week: {what}', { what: recentChanges[0].summary }) : tr('{n} changes to roles in the last week, the latest by {name}.', { n: recentChanges.length, name: recentChanges[0].actorName }), action: { label: tr('Show them'), run: () => jump('rl-changes') } });
  if (!insights.length) insights.push({ tone: 'good', icon: 'check', text: tr('Every role is in use and has permissions.') });

  const chipTest = { all: () => true, sensitive: (r) => isAdmin(r) || sensitiveOf(r).length > 0, unused: (r) => r.userCount === 0, custom: (r) => !r.isSystem };
  const visibleRoles = roles.filter(chipTest[chip] || chipTest.all)
    .filter((r) => matchesQuery(roleSearch, r.name, r.description, ...(r.members || []).map((m) => m.name)));
  const chips = [['all', tr('All'), roles.length], ['sensitive', tr('Sensitive powers'), roles.filter(chipTest.sensitive).length], ['custom', tr('Made here'), custom.length], ['unused', tr('Nobody holds'), unused.length]]
    .filter(([k, , c]) => c > 0 || k === 'all' || k === chip);

  const visibleCatalogue = catalogue.filter((p) => matchesQuery(search, p.group, p.label, tr(p.group), tr(p.label), p.key));
  const groups = groupCatalogue(visibleCatalogue);
  const allGroups = groupCatalogue(catalogue);
  const cur = detail ? roles.find((r) => r.id === detail) : null;
  const curLocked = cur ? isAdmin(cur) || !canManage : true;

  return (
    <div className="dk tl rl">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <Hero
        eyebrow={tr('Governance')}
        title={tr('Roles & permissions')}
        sub={tr('What each role may do and who holds it. Permissions are checked on every action on the server, not just hidden on screen. Press a number to show only those.')}
        actions={canManage && <button type="button" className="btn btn-primary" onClick={() => openNew('')}>{tr('New role')}</button>}
        stats={stats} />

      <Insights items={insights.slice(0, 5)} />

      <Section id="rl-roles" title={tr('Roles')} sub={tr('Press a role to see who holds it and change what it may do.')}>
        <div className="tl-tools"><div className="tl-search"><SearchInput value={roleSearch} onChange={setRoleSearch} placeholder={tr('Search roles or people…')} /></div></div>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {chips.map(([key, label, c]) => (
            <button key={key} type="button" role="radio" aria-checked={chip === key} className={'ppl-chip' + (chip === key ? ' is-on' : '')} onClick={() => setChip(key)}>
              {label} <span className="ppl-chip-n">{c}</span>
            </button>
          ))}
        </div>
        {!visibleRoles.length ? <div className="dk-empty tl-empty"><p>{tr('Nothing matches. Try another search or filter.')}</p></div> : (
          <div className="tl-grid">
            {visibleRoles.map((r) => {
              const n = isAdmin(r) ? total : r.permissions.length;
              const sens = isAdmin(r) ? sensitiveKeys.length : sensitiveOf(r).length;
              return (
                <article key={r.id} className={'tl-card rl-card' + (isAdmin(r) ? ' is-admin' : '') + (r.userCount === 0 ? ' st-retired' : '')}>
                  <button type="button" className="tl-card-open rl-open" onClick={() => openDetail(r.id)}>
                    <span className="tl-card-head">
                      <span className="dk-muted tl-small">{r.isSystem ? tr('Built in') : tr('Made here')}{r.updatedAt && new Date(r.updatedAt) - new Date(r.createdAt) > 60000 ? ' · ' + tr('changed {date}', { date: fmtDate(r.updatedAt) }) : ''}</span>
                      <span className="tl-name">{isAdmin(r) && <LockIcon />}{r.name}</span>
                    </span>
                  </button>
                  {r.description && <p className="dk-muted tl-small rl-desc">{r.description}</p>}
                  <div className="rl-count">
                    <span className="rl-bar"><span style={{ width: Math.round((n / Math.max(1, total)) * 100) + '%' }} /></span>
                    <span className="tl-small">{tr('{n} of {total} permissions', { n, total })}</span>
                  </div>
                  <div className="tl-tags">
                    {sens > 0 && <Status tone="warn">{sens === 1 ? tr('1 sensitive power') : tr('{n} sensitive powers', { n: sens })}</Status>}
                    {!n && <Status tone="bad">{tr('No permissions')}</Status>}
                  </div>
                  <div className="tl-foot rl-foot">
                    <span className="rl-faces">
                      {(r.members || []).slice(0, 5).map((m) => <Photo key={m.userId} id={m.employeeId} name={m.name} photo={m.photo} size={28} />)}
                      {r.userCount > 5 && <span className="rl-more">+{r.userCount - 5}</span>}
                    </span>
                    <span className="dk-muted tl-small">{r.userCount === 0 ? tr('nobody') : r.userCount === 1 ? tr('1 person') : tr('{n} people', { n: r.userCount })}</span>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </Section>

      <Section id="rl-matrix" title={tr('Compare roles')} sub={tr('Every permission against every role. Tick a box to grant it; the change applies at the holders\' next action.')}>
        <SearchInput value={search} onChange={setSearch} placeholder={tr('Search permissions…')} />
        <div className="roles-scroll" style={{ marginTop: 12 }}>
          <table className="table roles-table">
            <thead>
              <tr>
                <th className="roles-perm-col roles-corner-cell">{tr('Permission')}</th>
                {roles.map((r) => (
                  <th key={r.id} className={'roles-role-col' + (isAdmin(r) ? ' roles-role-col-locked' : '')}>
                    <button type="button" className="roles-role-name" onClick={() => openDetail(r.id)}>{isAdmin(r) && <LockIcon />}{r.name}</button>
                    <div className="roles-usercount">{r.userCount === 1 ? tr('1 person') : tr('{n} people', { n: r.userCount })}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map(({ group, permissions }) => {
                const isCollapsed = !search && collapsedGroups.has(group);
                return (
                  <Fragment key={group}>
                    <tr className="roles-group-row">
                      <th colSpan={1 + roles.length} className="roles-group-cell">
                        <button type="button" className="roles-group-toggle" onClick={() => toggleGroup(group)} aria-expanded={!isCollapsed}>
                          <span className={'roles-group-chevron' + (isCollapsed ? '' : ' roles-group-chevron-open')}><ChevronIcon /></span>
                          {tr(group)}
                          <span className="roles-group-count">{permissions.length}</span>
                        </button>
                      </th>
                    </tr>
                    {!isCollapsed && permissions.map((p) => (
                      <tr key={p.key} className="roles-perm-row">
                        <td className="roles-perm-cell">
                          <div className="roles-perm-label">{tr(p.label)}{p.sensitive && <span className="rl-sens" title={tr('Sensitive power')}>!</span>}</div>
                          <div className="roles-perm-key">{p.key}</div>
                        </td>
                        {roles.map((r) => {
                          const on = isAdmin(r) || r.permissions.indexOf(p.key) >= 0;
                          const locked = isAdmin(r) || !canManage;
                          return (
                            <td key={r.id} className={'roles-checkbox-cell' + (locked ? ' roles-checkbox-cell-locked' : '')}>
                              <label className="roles-checkbox-label">
                                <input type="checkbox" checked={on} disabled={locked || busyKey === r.id + ':' + p.key} onChange={(e) => setPerms(r, [p.key], e.target.checked)} className="roles-checkbox" aria-label={r.name + ': ' + tr(p.label)} />
                              </label>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        {!!catalogue.length && !visibleCatalogue.length && <div className="dk-empty"><p>{tr('No permissions match "{search}"', { search })}</p></div>}
      </Section>

      {canManage && (
        <Section id="rl-changes" title={tr('Latest changes')} sub={tr('From the audit log: who changed which role, and when.')}>
          {!changes.length ? <div className="dk-empty"><p>{tr('No changes to roles recorded yet.')}</p></div> : (
            <ul className="rl-changes">
              {changes.slice(0, 15).map((c, i) => (
                <li key={i}>
                  <span className="rl-ch-what">{c.summary}</span>
                  <span className="dk-muted tl-small">{c.actorName} · {fmtDate(c.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      <Glossary items={[
        [tr('Role'), tr('A named set of permissions. People get roles through their user account; a person with several roles can do what any of them allows.')],
        [tr('Permission'), tr('One thing someone may see or do, like approving leave or viewing invoices. The server checks it on every action.')],
        [tr('Sensitive power'), tr('A permission over other people\'s access, pay, company settings or the audit log. Worth keeping to few people.')],
        [tr('Built in'), tr('Roles that came with the system. Their permissions can change but their names stay; they can\'t be deleted.')],
        [tr('System Administrator'), tr('Always has every permission, so someone can always put things right. It can\'t be changed.')],
        [tr('Made here'), tr('Roles your company added. They can be renamed, and deleted once nobody holds them.')]
      ]} />

      {cur && (
        <div className="dialog-backdrop" onClick={() => setDetail(null)}>
          <div className="dialog tl-dialog rl-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="tl-detail-head">
              <div>
                <span className="dk-muted tl-small">{cur.isSystem ? tr('Built in') : tr('Made here')} · {cur.userCount === 1 ? tr('1 person') : tr('{n} people', { n: cur.userCount })}</span>
                <h2>{isAdmin(cur) && <LockIcon />}{cur.name}</h2>
                {cur.description && <p className="dk-muted rl-dialog-desc">{cur.description}</p>}
              </div>
              <button type="button" className="tl-close" onClick={() => setDetail(null)} aria-label={tr('Close')}>×</button>
            </div>
            {isAdmin(cur) && <p className="rl-note">{tr('This role always has every permission, so someone can always put things right. It can\'t be changed.')}</p>}

            {edit ? (
              <form className="rl-edit" onSubmit={saveEdit}>
                <div className="field">
                  <label htmlFor="rl-name">{tr('Name')}</label>
                  <input id="rl-name" className="input" value={edit.name} disabled={cur.isSystem} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required />
                  {cur.isSystem && <span className="dk-muted tl-small">{tr('Built-in roles keep their names.')}</span>}
                </div>
                <div className="field">
                  <label htmlFor="rl-desc">{tr('Description')}</label>
                  <input id="rl-desc" className="input" value={edit.description} maxLength={300} onChange={(e) => setEdit({ ...edit, description: e.target.value })} placeholder={tr('Who this role is for')} />
                </div>
                {dialogError && <div className="error-banner">{dialogError}</div>}
                <div className="dialog-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setEdit(null)}>{tr('Cancel')}</button>
                  <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : tr('Save')}</button>
                </div>
              </form>
            ) : null}

            <h3 className="tl-h3">{tr('Who holds it')}</h3>
            {!cur.members || !cur.members.length ? <p className="dk-muted">{tr('Nobody yet. Roles are given on the User accounts page.')}</p> : (
              <ul className="rl-members">
                {cur.members.map((m) => (
                  <li key={m.userId}>
                    <Photo id={m.employeeId} name={m.name} photo={m.photo} size={32} />
                    <span className="rl-m-main"><strong>{m.name}</strong><span className="dk-muted tl-small">{m.title || '—'}</span></span>
                    {m.status !== 'active' ? <Status tone="bad">{tr('Switched off')}</Status> : <span className="dk-muted tl-small">{m.lastLoginAt ? tr('last in {date}', { date: fmtDate(m.lastLoginAt) }) : tr('never signed in')}</span>}
                  </li>
                ))}
              </ul>
            )}

            <h3 className="tl-h3">{tr('What it may do')} <span className="dk-muted tl-small">{tr('{n} of {total} permissions', { n: isAdmin(cur) ? total : cur.permissions.length, total })}</span></h3>
            <div className="rl-groups">
              {allGroups.map(({ group, permissions }) => {
                const on = permissions.filter((p) => isAdmin(cur) || cur.permissions.includes(p.key));
                const keys = permissions.map((p) => p.key);
                return (
                  <div key={group} className="rl-group">
                    <div className="rl-group-head">
                      <strong>{tr(group)}</strong>
                      <span className="dk-muted tl-small">{on.length}/{permissions.length}</span>
                      {!curLocked && (
                        <span className="rl-group-btns">
                          <button type="button" className="rl-mini" disabled={on.length === permissions.length || !!busyKey} onClick={() => setPerms(cur, keys, true)}>{tr('All')}</button>
                          <button type="button" className="rl-mini" disabled={!on.length || !!busyKey} onClick={() => setPerms(cur, keys, false)}>{tr('None')}</button>
                        </span>
                      )}
                    </div>
                    {permissions.map((p) => (
                      <label key={p.key} className={'rl-perm' + (on.includes(p) ? ' is-on' : '')}>
                        <input type="checkbox" className="roles-checkbox" checked={on.includes(p)} disabled={curLocked || busyKey === cur.id + ':' + p.key} onChange={(e) => setPerms(cur, [p.key], e.target.checked)} />
                        <span>{tr(p.label)}{p.sensitive && <span className="rl-sens" title={tr('Sensitive power')}>!</span>}</span>
                      </label>
                    ))}
                  </div>
                );
              })}
            </div>

            {canManage && !edit && (
              <div className="dialog-actions tl-actions">
                {confirmDelete ? (
                  <>
                    <span className="dk-muted tl-small rl-confirm">{tr('Delete the role "{name}"? This can\'t be undone.', { name: cur.name })}</span>
                    <button type="button" className="btn btn-secondary" onClick={() => setConfirmDelete(false)}>{tr('Cancel')}</button>
                    <button type="button" className="btn btn-primary" disabled={saving} onClick={() => remove(cur)}>{tr('Delete')}</button>
                  </>
                ) : (
                  <>
                    {!cur.isSystem && <button type="button" className="btn btn-secondary" disabled={cur.userCount > 0} title={cur.userCount > 0 ? tr('Take it away from everyone first') : undefined} onClick={() => setConfirmDelete(true)}>{tr('Delete')}</button>}
                    <button type="button" className="btn btn-secondary" onClick={() => { setDetail(null); openNew(cur.id); }}>{tr('Copy into a new role')}</button>
                    {!isAdmin(cur) && <button type="button" className="btn btn-secondary" onClick={() => { setDialogError(''); setEdit({ name: cur.name, description: cur.description || '' }); }}>{tr('Edit name & description')}</button>}
                    <Link className="btn btn-primary" to="/users">{tr('Give it to someone')}</Link>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {newOpen && (
        <div className="dialog-backdrop" onClick={() => setNewOpen(false)}>
          <form className="dialog rl-new" onClick={(e) => e.stopPropagation()} onSubmit={saveNew}>
            <h2>{tr('New role')}</h2>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="field">
              <label htmlFor="role-name">{tr('Name')}</label>
              <input id="role-name" className="input" value={newForm.name} onChange={(e) => setNewForm({ ...newForm, name: e.target.value })} required maxLength={80} />
            </div>
            <div className="field">
              <label htmlFor="role-description">{tr('Description (optional)')}</label>
              <input id="role-description" className="input" value={newForm.description} maxLength={300} onChange={(e) => setNewForm({ ...newForm, description: e.target.value })} placeholder={tr('Who this role is for')} />
            </div>
            <div className="field">
              <label htmlFor="role-copy">{tr('Start from')}</label>
              <select id="role-copy" className="input" value={newForm.copyFrom} onChange={(e) => setNewForm({ ...newForm, copyFrom: e.target.value })}>
                <option value="">{tr('No permissions — tick them afterwards')}</option>
                {roles.filter((r) => !isAdmin(r)).map((r) => <option key={r.id} value={r.id}>{tr('A copy of {name} ({n} permissions)', { name: r.name, n: r.permissions.length })}</option>)}
              </select>
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setNewOpen(false)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Creating…') : tr('Create role')}</button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
