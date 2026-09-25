import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import RowMenu from '../components/RowMenu';
import Photo from '../components/Photo';
import { Glossary, Hero, Insights, Section, Status, fmtDate, jump } from '../components/DashKit';
import { tr, activeIntlLocale } from '../lib/i18n.jsx';
import './EmployeesPage.css';
import './ToolRoomPage.css';
import './UsersPage.css';
// User accounts — who can sign in, with which roles, and how safely, in the
// same "explains itself" layout as the dashboards (components/DashKit.jsx):
// how many accounts are active, how many use two-step sign-in, who hasn't
// signed in for a while, and what needs attention (people who have left
// but can still sign in, locked accounts, sensitive powers without
// two-step, employees with no account). The accounts show as cards or a
// list, each with a window: roles (several allowed), how it signs in, and
// its recent activity from the audit log (users.service.js).
//
// The backend refuses changing your own roles or switching yourself off,
// and keeps the last active System Administrator; the page disables those
// buttons rather than letting the click fail. Creating accounts, passwords,
// login emails and turning off two-step need user.create.

const IDLE_DAYS = 30;
function readPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* remembered for this visit only */ } }
function daysSince(ts) { return ts ? Math.floor((Date.now() - new Date(ts).getTime()) / 86400000) : null; }
function fmtLastLogin(iso) {
  if (!iso) return tr('Never');
  return new Date(iso).toLocaleString(activeIntlLocale(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function hasLeft(u) { return u.employeeStatus === 'terminated'; }
function isIdle(u) { return u.status === 'active' && (u.lastLoginAt ? daysSince(u.lastLoginAt) > IDLE_DAYS : daysSince(u.createdAt) > 7); }

const EMPTY_NEW_USER = { employeeId: '', roleId: '', password: '', confirmPassword: '', mustChangePassword: true };

export default function UsersPage() {
  const { can, session } = useAuth();
  const canSeeRoles = can('employee.read');
  const canCreate = can('user.create');
  const me = session && session.userId;

  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const [availableEmployees, setAvailableEmployees] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newUser, setNewUser] = useState(EMPTY_NEW_USER);
  const [createError, setCreateError] = useState(null);
  const [creating, setCreating] = useState(false);

  const [resetTarget, setResetTarget] = useState(null);
  const [resetPassword, setResetPassword] = useState('');
  const [resetConfirm, setResetConfirm] = useState('');
  const [resetError, setResetError] = useState(null);
  const [resetting, setResetting] = useState(false);
  const [search, setSearch] = useState('');

  const [emailTarget, setEmailTarget] = useState(null);
  const [emailDraft, setEmailDraft] = useState('');
  const [emailError, setEmailError] = useState(null);
  const [emailSaving, setEmailSaving] = useState(false);
  const [catalogue, setCatalogue] = useState([]);
  const [chip, setChip] = useState('all');
  const [view, setView] = useState(() => readPref('bos.usersView', 'cards'));
  const [detail, setDetail] = useState(null);
  const [activity, setActivity] = useState(null);
  const [roleDraft, setRoleDraft] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [u, r, avail, cat] = await Promise.all([
        api.get('/users'),
        canSeeRoles ? api.get('/roles') : Promise.resolve([]),
        canCreate ? api.get('/users/available-employees') : Promise.resolve([]),
        api.get('/roles/permissions')
      ]);
      setUsers(u);
      setRoles(r);
      setAvailableEmployees(avail);
      setCatalogue(cat);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [canSeeRoles, canCreate]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  async function saveRoles(user, roleIds) {
    setBusyId(user.id);
    setError(null);
    try {
      await api.post('/users/' + user.id + '/roles', { roleIds });
      setRoleDraft(null);
      setToast(tr("{name}'s role updated.", { name: user.name }));
      loadActivity(user.id);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  // For someone who lost their phone and their backup codes: they can then
  // sign in with their password alone and set two-step up again.
  async function resetTwoStep(user) {
    if (!window.confirm(tr('Turn off two-step sign-in for {name}? They will sign in with just their password until they turn it on again.', { name: user.name }))) return;
    setBusyId(user.id);
    setError(null);
    try {
      await api.post('/users/' + user.id + '/two-step/reset', {});
      setToast(tr("Two-step sign-in turned off for {name}.", { name: user.name }));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function unlock(user) {
    setBusyId(user.id);
    setError(null);
    try {
      await api.post('/users/' + user.id + '/unlock', {});
      setToast(tr('{name} can try signing in again.', { name: user.name }));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }
  async function loadActivity(id) {
    try { setActivity(await api.get('/users/' + id + '/activity')); } catch { setActivity([]); }
  }
  function openDetail(u) { setRoleDraft(null); setActivity(null); setDetail(u.id); loadActivity(u.id); }

  async function toggleStatus(user) {
    setBusyId(user.id);
    setError(null);
    try {
      const nextStatus = user.status === 'active' ? 'disabled' : 'active';
      await api.post('/users/' + user.id + '/status', { status: nextStatus });
      setToast(nextStatus === 'active' ? tr("{name}'s account enabled.", { name: user.name }) : tr("{name}'s account disabled.", { name: user.name }));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  function openCreate() {
    setCreateError(null);
    setNewUser(EMPTY_NEW_USER);
    setShowCreate(true);
  }

  async function handleCreate(e) {
    e.preventDefault();
    setCreateError(null);
    if (newUser.password.length < 8) { setCreateError(tr('Password must be at least 8 characters.')); return; }
    if (newUser.password !== newUser.confirmPassword) { setCreateError(tr('Passwords do not match.')); return; }

    setCreating(true);
    try {
      const created = await api.post('/users', {
        employeeId: newUser.employeeId,
        roleId: newUser.roleId,
        password: newUser.password,
        mustChangePassword: newUser.mustChangePassword
      });
      setToast(tr("{name}'s account was created.", { name: created.name }));
      setShowCreate(false);
      await load();
    } catch (err) {
      setCreateError(err.message);
    } finally {
      setCreating(false);
    }
  }

  function openReset(user) {
    setResetError(null);
    setResetPassword('');
    setResetConfirm('');
    setResetTarget(user);
  }

  async function handleReset(e) {
    e.preventDefault();
    setResetError(null);
    if (resetPassword.length < 8) { setResetError(tr('Password must be at least 8 characters.')); return; }
    if (resetPassword !== resetConfirm) { setResetError(tr('Passwords do not match.')); return; }

    setResetting(true);
    try {
      await api.post('/users/' + resetTarget.id + '/password', { password: resetPassword });
      setToast(tr('Password reset for {name}.', { name: resetTarget.name }));
      setResetTarget(null);
      await load();
    } catch (err) {
      setResetError(err.message);
    } finally {
      setResetting(false);
    }
  }

  function openEmail(user) {
    setEmailError(null);
    setEmailDraft(user.email);
    setEmailTarget(user);
  }

  async function handleEmailSave(e) {
    e.preventDefault();
    setEmailError(null);
    setEmailSaving(true);
    try {
      await api.post('/users/' + emailTarget.id + '/email', { email: emailDraft });
      setToast(tr('Login email updated for {name}.', { name: emailTarget.name }));
      setEmailTarget(null);
      await load();
    } catch (err) {
      setEmailError(err.message);
    } finally {
      setEmailSaving(false);
    }
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const sensitiveKeys = catalogue.filter((p) => p.sensitive).map((p) => p.key);
  const powerful = (u) => u.isAdmin || u.roleIds.some((id) => { const r = roles.find((x) => x.id === id); return r && r.permissions.some((k) => sensitiveKeys.includes(k)); });
  const active = users.filter((u) => u.status === 'active');
  const off = users.filter((u) => u.status !== 'active');
  const twoStep = active.filter((u) => u.twoStepOn);
  const share = active.length ? Math.round((twoStep.length / active.length) * 100) : 0;
  const idle = users.filter(isIdle);
  const left = active.filter(hasLeft);
  const locked = users.filter((u) => u.lockedUntil);
  const exposed = active.filter((u) => powerful(u) && !u.twoStepOn);
  const withClaude = active.filter((u) => u.claudeConnected);
  const attention = (u) => (u.status === 'active' && hasLeft(u)) || !!u.lockedUntil || (u.status === 'active' && powerful(u) && !u.twoStepOn);

  function showOnly(key) { setChip(chip === key ? 'all' : key); jump('us-list'); }
  const stats = [
    { icon: 'people', value: String(active.length), label: tr('accounts that can sign in'), note: off.length ? tr('{n} switched off', { n: off.length }) : tr('none switched off'), onClick: () => showOnly('active') },
    { icon: 'check', value: share + '%', label: tr('use two-step sign-in'), note: tr('{n} of {total} active accounts', { n: twoStep.length, total: active.length }), tone: share >= 80 ? 'good' : share < 50 ? 'warn' : '', onClick: () => showOnly('no2step') },
    { icon: 'clock', value: String(idle.length), label: tr('not signed in for {n} days', { n: IDLE_DAYS }), note: tr('including accounts never used'), onClick: () => showOnly('idle') },
    { icon: 'warn', value: String(users.filter(attention).length), label: tr('need attention'), note: tr('left the company, locked, or sensitive powers without two-step'), tone: users.filter(attention).length ? 'bad' : 'good', onClick: () => showOnly('attention') }
  ];

  const insights = [];
  if (left.length) insights.push({ tone: 'bad', icon: 'void', text: left.length === 1 ? tr('{name} no longer works here but can still sign in.', { name: left[0].name }) : tr('{n} people who no longer work here can still sign in.', { n: left.length }), action: left.length === 1 && left[0].id !== me ? { label: tr('Switch off'), run: () => toggleStatus(left[0]) } : { label: tr('Show them'), run: () => showOnly('attention') } });
  if (exposed.length) insights.push({ tone: 'warn', icon: 'warn', text: exposed.length === 1 ? tr('{name} can change access, pay or settings but signs in with a password alone.', { name: exposed[0].name }) : tr('{n} people who can change access, pay or settings sign in with a password alone. Ask them to turn on two-step sign-in under My space.', { n: exposed.length }), action: { label: tr('Show them'), run: () => showOnly('attention') } });
  if (locked.length) insights.push({ tone: 'warn', icon: 'clock', text: locked.length === 1 ? tr('{name} is locked out after too many wrong passwords.', { name: locked[0].name }) : tr('{n} accounts are locked out after too many wrong passwords.', { n: locked.length }), action: locked.length === 1 ? { label: tr('Unlock'), run: () => unlock(locked[0]) } : { label: tr('Show them'), run: () => showOnly('attention') } });
  if (idle.length) insights.push({ tone: 'info', icon: 'clock', text: idle.length === 1 ? tr('{name}\'s account hasn\'t been used for over {d} days. Switch it off if nobody needs it.', { name: idle[0].name, d: IDLE_DAYS }) : tr('{n} active accounts haven\'t been used for over {d} days. Switch off the ones nobody needs.', { n: idle.length, d: IDLE_DAYS }), action: { label: tr('Show them'), run: () => showOnly('idle') } });
  if (canCreate && availableEmployees.length) insights.push({ tone: 'info', icon: 'people', text: availableEmployees.length === 1 ? tr('{name} has no account yet.', { name: availableEmployees[0].name }) : tr('{n} employees have no account yet.', { n: availableEmployees.length }), action: { label: tr('New user'), run: openCreate } });
  if (withClaude.length) insights.push({ tone: 'info', icon: 'spark', text: withClaude.length === 1 ? tr('{name} has a Claude app connected to their account.', { name: withClaude[0].name }) : tr('{n} people have a Claude app connected to their account.', { n: withClaude.length }), action: { label: tr('Show them'), run: () => showOnly('claude') } });
  if (!insights.length) insights.push({ tone: 'good', icon: 'check', text: tr('Every account is in order.') });

  const chipTest = {
    all: () => true, active: (u) => u.status === 'active', off: (u) => u.status !== 'active', no2step: (u) => u.status === 'active' && !u.twoStepOn,
    idle: isIdle, attention, claude: (u) => u.claudeConnected
  };
  const visibleUsers = users.filter(chipTest[chip] || chipTest.all)
    .filter((u) => matchesQuery(search, u.name, u.email, u.title, u.department, ...u.roleNames));
  const chips = [
    ['all', tr('All'), users.length], ['attention', tr('Need attention'), users.filter(attention).length], ['active', tr('Active'), active.length], ['off', tr('Switched off'), off.length],
    ['no2step', tr('No two-step'), active.length - twoStep.length], ['idle', tr('Not used lately'), idle.length], ['claude', tr('Claude connected'), withClaude.length]
  ].filter(([k, , c]) => c > 0 || k === 'all' || k === chip);

  function flagsOf(u) {
    const out = [];
    if (u.status !== 'active') out.push({ tone: 'muted', text: tr('Switched off') });
    if (u.status === 'active' && hasLeft(u)) out.push({ tone: 'bad', text: tr('Left the company') });
    if (u.lockedUntil) out.push({ tone: 'bad', text: tr('Locked out') });
    if (u.status === 'active') out.push(u.twoStepOn ? { tone: 'good', text: tr('Two-step on') } : { tone: powerful(u) ? 'warn' : 'muted', text: tr('Password only') });
    if (u.mustChangePassword) out.push({ tone: 'info', text: tr('Must set a new password') });
    return out;
  }
  function actionsFor(u) {
    const self = u.id === me;
    return [
      { label: tr('Open'), onClick: () => openDetail(u) },
      !self && { label: u.status === 'active' ? tr('Switch off') : tr('Switch on'), onClick: () => toggleStatus(u) },
      u.lockedUntil && { label: tr('Unlock'), onClick: () => unlock(u) },
      canCreate && { label: tr('Change email'), onClick: () => openEmail(u) },
      canCreate && { label: tr('Reset password'), onClick: () => openReset(u) },
      canCreate && u.twoStepOn && { label: tr('Turn off two-step sign-in'), onClick: () => resetTwoStep(u) }
    ].filter(Boolean);
  }
  const cur = detail ? users.find((u) => u.id === detail) : null;
  const curSelf = cur && cur.id === me;
  const methods = cur ? [cur.twoStep.app && tr('authenticator app'), cur.twoStep.sms && tr('text message'), cur.twoStep.email && tr('email code')].filter(Boolean) : [];

  return (
    <div className="dk tl us">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <Hero
        eyebrow={tr('Governance')}
        title={tr('User accounts')}
        sub={tr('Who can sign in to Bamboo OS, with which roles, and how safely. Press a number to show only those.')}
        actions={(
          <>
            {canCreate && <button type="button" className="btn btn-primary" onClick={openCreate}>{tr('New user')}</button>}
            <Link className="btn btn-secondary" to="/roles">{tr('Roles & permissions')}</Link>
          </>
        )}
        stats={stats} />

      <Insights items={insights.slice(0, 5)} />

      <Section id="us-list" title={tr('Accounts')} sub={tr('Press an account to see its roles, how it signs in and what happened to it lately.')}
        action={(
          <div className="ppl-view" role="radiogroup" aria-label={tr('View')}>
            {[['cards', tr('Cards')], ['list', tr('List')]].map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={view === k} className={view === k ? 'is-on' : ''} onClick={() => { setView(k); writePref('bos.usersView', k); }}>{label}</button>
            ))}
          </div>
        )}>
        <div className="tl-tools"><div className="tl-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search users…')} /></div></div>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {chips.map(([key, label, c]) => (
            <button key={key} type="button" role="radio" aria-checked={chip === key} className={'ppl-chip' + (chip === key ? ' is-on' : '')} onClick={() => setChip(key)}>
              {label} <span className="ppl-chip-n">{c}</span>
            </button>
          ))}
        </div>
        {!visibleUsers.length ? (
          <div className="dk-empty tl-empty"><p>{users.length ? tr('Nothing matches. Try another search or filter.') : tr('No user accounts yet')}</p></div>
        ) : view === 'cards' ? (
          <div className="tl-grid">
            {visibleUsers.map((u) => (
              <article key={u.id} className={'tl-card' + (u.status !== 'active' ? ' st-retired' : '') + (attention(u) ? ' st-late' : '')}>
                <button type="button" className="tl-card-open" onClick={() => openDetail(u)}>
                  <Photo id={u.employeeId} name={u.name} photo={u.photo} size={44} />
                  <span className="tl-card-head">
                    <span className="dk-muted tl-small">{[u.title, u.department].filter(Boolean).join(' · ') || '—'}</span>
                    <span className="tl-name">{u.name}{u.id === me ? ' · ' + tr('you') : ''}</span>
                  </span>
                </button>
                <span className="tl-menu"><RowMenu disabled={busyId === u.id} actions={actionsFor(u)} /></span>
                <p className="dk-muted tl-small us-email">{u.email}</p>
                <div className="us-roles">{u.roleNames.map((n) => <span key={n} className="us-role">{n}</span>)}</div>
                <div className="tl-tags">{flagsOf(u).map((f, i) => <Status key={i} tone={f.tone}>{f.text}</Status>)}</div>
                <div className="tl-foot"><span className="dk-muted tl-small">{tr('Last sign-in')}: {fmtLastLogin(u.lastLoginAt)}</span></div>
              </article>
            ))}
          </div>
        ) : (
          <div className="tl-table-wrap">
            <table className="tl-table">
              <thead><tr><th>{tr('Employee')}</th><th>{tr('Roles')}</th><th>{tr('Last sign-in')}</th><th>{tr('How it signs in')}</th><th /></tr></thead>
              <tbody>
                {visibleUsers.map((u) => (
                  <tr key={u.id} className={u.status !== 'active' ? 'st-retired' : ''}>
                    <td><button type="button" className="tl-row-open" onClick={() => openDetail(u)}><Photo id={u.employeeId} name={u.name} photo={u.photo} size={32} /><span><span className="tl-name">{u.name}</span><span className="dk-muted tl-small">{u.email}</span></span></button></td>
                    <td className="es-items-cell">{u.roleNames.join(', ')}</td>
                    <td className={isIdle(u) ? 'pk-owe' : ''}>{fmtLastLogin(u.lastLoginAt)}</td>
                    <td><div className="tl-tags">{flagsOf(u).map((f, i) => <Status key={i} tone={f.tone}>{f.text}</Status>)}</div></td>
                    <td className="tl-menu-cell"><RowMenu disabled={busyId === u.id} actions={actionsFor(u)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Glossary items={[
        [tr('User account'), tr('What lets an employee sign in: a login email, a password and one or more roles. Employees without one can still be clocked in at the kiosk and paid.')],
        [tr('Switched off'), tr('The account can\'t sign in or use any page, starting with its very next action. Any Claude app connected to it is disconnected too. It can be switched back on.')],
        [tr('Two-step sign-in'), tr('A code from a phone app, a text message or an email as well as the password. Each person turns it on under My space.')],
        [tr('Locked out'), tr('Too many wrong passwords in a row. It clears by itself after a while, or press Unlock.')],
        [tr('Left the company'), tr('The employee record says they no longer work here, but the account is still switched on.')],
        [tr('Sensitive powers'), tr('Permissions over other people\'s access, pay, company settings or the audit log — see Roles & permissions.')]
      ]} />

      {cur && (
        <div className="dialog-backdrop" onClick={() => setDetail(null)}>
          <div className="dialog tl-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="tl-detail-head">
              <Photo id={cur.employeeId} name={cur.name} photo={cur.photo} size={56} />
              <div>
                <span className="dk-muted tl-small">{[cur.title, cur.department, cur.company].filter(Boolean).join(' · ') || '—'}</span>
                <h2>{cur.name}</h2>
                <div className="tl-tags">{flagsOf(cur).map((f, i) => <Status key={i} tone={f.tone}>{f.text}</Status>)}</div>
              </div>
              <button type="button" className="tl-close" onClick={() => setDetail(null)} aria-label={tr('Close')}>×</button>
            </div>
            <dl className="tl-facts">
              <div><dt>{tr('Login email')}</dt><dd className="us-email">{cur.email}</dd></div>
              <div><dt>{tr('Last sign-in')}</dt><dd>{fmtLastLogin(cur.lastLoginAt)}</dd></div>
              <div><dt>{tr('Account made')}</dt><dd>{fmtDate(cur.createdAt)}</dd></div>
              <div><dt>{tr('Two-step sign-in')}</dt><dd>{methods.length ? methods.join(', ') : tr('Off — password only')}</dd></div>
              <div><dt>{tr('Wrong passwords in a row')}</dt><dd className={cur.lockedUntil ? 'pk-owe' : ''}>{cur.failedAttempts}{cur.lockedUntil ? ' · ' + tr('locked until {time}', { time: fmtLastLogin(cur.lockedUntil) }) : ''}</dd></div>
              <div><dt>{tr('Claude app')}</dt><dd>{cur.claudeConnected ? tr('Connected') : tr('Not connected')}</dd></div>
            </dl>

            <h3 className="tl-h3">{tr('Roles')}</h3>
            {roleDraft ? (
              <div className="us-role-pick">
                {roles.map((r) => (
                  <label key={r.id} className="us-role-opt">
                    <input type="checkbox" checked={roleDraft.includes(r.id)} onChange={(e) => setRoleDraft(e.target.checked ? roleDraft.concat(r.id) : roleDraft.filter((x) => x !== r.id))} />
                    <span>{r.name}</span>
                    <span className="dk-muted tl-small">{r.description}</span>
                  </label>
                ))}
                <div className="dialog-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setRoleDraft(null)}>{tr('Cancel')}</button>
                  <button type="button" className="btn btn-primary" disabled={!roleDraft.length || busyId === cur.id} onClick={() => saveRoles(cur, roleDraft)}>{tr('Save roles')}</button>
                </div>
              </div>
            ) : (
              <div className="us-roles us-roles-big">
                {cur.roleNames.map((n) => <span key={n} className="us-role">{n}</span>)}
                {!curSelf && canSeeRoles && <button type="button" className="us-link" onClick={() => setRoleDraft(cur.roleIds.slice())}>{tr('Change roles')}</button>}
                {curSelf && <span className="dk-muted tl-small">{tr('You can\'t change your own roles.')}</span>}
              </div>
            )}

            <h3 className="tl-h3">{tr('Recent activity')}</h3>
            {!activity ? <p className="dk-muted">{tr('Loading…')}</p> : !activity.length ? <p className="dk-muted">{tr('Nothing recorded yet.')}</p> : (
              <ul className="us-activity">
                {activity.slice(0, 10).map((a, i) => <li key={i}><span>{a.summary}</span><span className="dk-muted tl-small">{a.actorName} · {fmtLastLogin(a.at)}</span></li>)}
              </ul>
            )}

            <div className="dialog-actions tl-actions">
              {canCreate && cur.twoStepOn && <button type="button" className="btn btn-secondary" disabled={busyId === cur.id} onClick={() => resetTwoStep(cur)}>{tr('Turn off two-step sign-in')}</button>}
              {canCreate && <button type="button" className="btn btn-secondary" onClick={() => openEmail(cur)}>{tr('Change email')}</button>}
              {canCreate && <button type="button" className="btn btn-secondary" onClick={() => openReset(cur)}>{tr('Reset password')}</button>}
              {cur.lockedUntil && <button type="button" className="btn btn-secondary" disabled={busyId === cur.id} onClick={() => unlock(cur)}>{tr('Unlock')}</button>}
              {!curSelf && <button type="button" className={'btn ' + (cur.status === 'active' ? 'btn-secondary' : 'btn-primary')} disabled={busyId === cur.id} onClick={() => toggleStatus(cur)}>{cur.status === 'active' ? tr('Switch off') : tr('Switch on')}</button>}
            </div>
          </div>
        </div>
      )}

      {showCreate && (
        <div className="dialog-backdrop" onClick={() => setShowCreate(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('New user')}</h2>
            <form className="users-dialog-form" onSubmit={handleCreate}>
              <div className="field">
                <label htmlFor="nu-employee">{tr('Employee')}</label>
                <select
                  id="nu-employee"
                  className="input"
                  value={newUser.employeeId}
                  onChange={(e) => setNewUser({ ...newUser, employeeId: e.target.value })}
                  required
                >
                  <option value="" disabled>{tr('Select an employee…')}</option>
                  {availableEmployees.map((emp) => (
                    <option key={emp.id} value={emp.id}>{emp.name} ({emp.email})</option>
                  ))}
                </select>
                {!availableEmployees.length && (
                  <p className="field-hint">{tr('Every employee already has a login account.')}</p>
                )}
              </div>

              <div className="field">
                <label htmlFor="nu-role">{tr('Role')}</label>
                <select
                  id="nu-role"
                  className="input"
                  value={newUser.roleId}
                  onChange={(e) => setNewUser({ ...newUser, roleId: e.target.value })}
                  required
                >
                  <option value="" disabled>{tr('Select a role…')}</option>
                  {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </div>

              <div className="field">
                <label htmlFor="nu-password">{tr('Password')}</label>
                <input
                  id="nu-password"
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={newUser.password}
                  onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                  required
                />
              </div>

              <div className="field">
                <label htmlFor="nu-confirm">{tr('Confirm password')}</label>
                <input
                  id="nu-confirm"
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={newUser.confirmPassword}
                  onChange={(e) => setNewUser({ ...newUser, confirmPassword: e.target.value })}
                  required
                />
              </div>

              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={newUser.mustChangePassword}
                  onChange={(e) => setNewUser({ ...newUser, mustChangePassword: e.target.checked })}
                />
                {tr('Require a password change at first sign-in')}
              </label>

              {createError && <div className="error-banner">{createError}</div>}

              <div className="dialog-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setShowCreate(false)}>{tr('Cancel')}</button>
                <button type="submit" className="btn btn-primary" disabled={creating || !availableEmployees.length}>
                  {creating ? tr('Creating…') : tr('Create account')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {resetTarget && (
        <div className="dialog-backdrop" onClick={() => setResetTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Reset password')}</h2>
            <p className="dialog-body">{tr('Set a new password for')} <strong>{resetTarget.name}</strong>{tr('. They\'ll be required to change it at their next sign-in.')}</p>
            <form className="users-dialog-form" onSubmit={handleReset}>
              <div className="field">
                <label htmlFor="rp-password">{tr('New password')}</label>
                <input
                  id="rp-password"
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={resetPassword}
                  onChange={(e) => setResetPassword(e.target.value)}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="rp-confirm">{tr('Confirm new password')}</label>
                <input
                  id="rp-confirm"
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={resetConfirm}
                  onChange={(e) => setResetConfirm(e.target.value)}
                  required
                />
              </div>

              {resetError && <div className="error-banner">{resetError}</div>}

              <div className="dialog-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setResetTarget(null)}>{tr('Cancel')}</button>
                <button type="submit" className="btn btn-primary" disabled={resetting}>
                  {resetting ? tr('Saving…') : tr('Reset password')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {emailTarget && (
        <div className="dialog-backdrop" onClick={() => setEmailTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Change login email')}</h2>
            <p className="dialog-body">
              {tr('Set the email')} <strong>{emailTarget.name}</strong> {tr('signs in with. This only changes their login account — it doesn\'t touch their employee record\'s own email address.')}
            </p>
            <form className="users-dialog-form" onSubmit={handleEmailSave}>
              <div className="field">
                <label htmlFor="ce-email">{tr('Login email')}</label>
                <input
                  id="ce-email"
                  className="input"
                  type="email"
                  autoComplete="off"
                  value={emailDraft}
                  onChange={(e) => setEmailDraft(e.target.value)}
                  required
                />
              </div>

              {emailError && <div className="error-banner">{emailError}</div>}

              <div className="dialog-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setEmailTarget(null)}>{tr('Cancel')}</button>
                <button type="submit" className="btn btn-primary" disabled={emailSaving}>
                  {emailSaving ? tr('Saving…') : tr('Save email')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
