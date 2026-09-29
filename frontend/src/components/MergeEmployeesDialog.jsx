import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import Photo from './Photo';
import SearchInput, { matchesQuery } from './SearchInput';
import { Status } from './DashKit';
import { msg, tr } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels.js';
import './MergeEmployeesDialog.css';

// Merging two records of the same person (employeeMerge.service.js): pick
// the duplicate, see what would move and what the kept record takes from
// it, then merge. Terminated records can be picked too: that is where a
// duplicate removed earlier still keeps its TimeStation attendance.

// The tables people recognise; anything else is "other linked records".
const MOVES = {
  attendance: msg('days of attendance'),
  leave_requests: msg('leave requests'),
  leave_balances: msg('leave balances'),
  payslips: msg('payslips'),
  task_assignees: msg('tasks assigned'),
  tasks: msg('tasks created'),
  task_comments: msg('task comments'),
  messages: msg('chat messages'),
  conversation_members: msg('chats'),
  expenses: msg('expense claims'),
  approvals: msg('approvals'),
  notifications: msg('notifications'),
  employee_documents: msg('ID documents'),
  project_members: msg('projects'),
  crm_leads: msg('CRM leads'),
  production_batch_employees: msg('production batches'),
  restaurant_orders: msg('till orders'),
  restaurant_drawer_sessions: msg('cash drawer shifts')
};

// What the kept record can take over (employeeMerge.service.js FIELD_LABEL).
const TAKES = new Set([
  msg('phone number'), msg('job title'), msg('manager'), msg('location'), msg('shift'), msg('shift times'), msg('TimeStation link'),
  msg('kiosk PIN'), msg('kiosk face'), msg('photo'), msg('hourly rate'), msg('basic salary and allowance'), msg('SSNIT number'), msg('TIN'),
  msg('kiosk language'), msg('work week'), msg('leave days'), msg('daily rate and pay cycle')
]);

function fullName(e) { return e.firstName + ' ' + e.lastName; }
function sameName(a, b) { return fullName(a).trim().toLowerCase() === fullName(b).trim().toLowerCase(); }

export default function MergeEmployeesDialog({ keep: keepIn, onClose, onDone }) {
  const [keep, setKeep] = useState(keepIn);
  const [all, setAll] = useState(null);
  const [dup, setDup] = useState(null);
  const [q, setQ] = useState('');
  const [preview, setPreview] = useState(null);
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => { api.get('/employees?includeTerminated=true').then(setAll).catch((e) => setError(e.message)); }, []);
  useEffect(() => {
    if (!dup) { setPreview(null); return; }
    setPreview(null); setSure(false); setError(null);
    api.get('/employees/' + keep.id + '/merge-preview?from=' + dup.id).then(setPreview).catch((e) => setError(e.message));
  }, [keep, dup]);

  const candidates = useMemo(() => {
    if (!all) return [];
    return all.filter((e) => e.id !== keep.id && matchesQuery(q, fullName(e), e.code, e.email, e.positionTitle))
      .sort((a, b) => (sameName(b, keep) - sameName(a, keep)) || fullName(a).localeCompare(fullName(b)));
  }, [all, keep, q]);

  async function doMerge() {
    setBusy(true); setError(null);
    try {
      const r = await api.post('/employees/' + keep.id + '/merge', { fromId: dup.id });
      onDone(tr('{name} is one record now: {n} linked items moved over.', { name: r.kept.name, n: r.moved }));
    } catch (e) { setError(e.message); setBusy(false); }
  }

  const grouped = preview ? (() => {
    const known = {}, other = { n: 0 };
    preview.moves.forEach((m) => {
      if (MOVES[m.table]) known[m.table] = (known[m.table] || 0) + m.rows;
      else other.n += m.rows;
    });
    return { known, other: other.n };
  })() : null;

  return (
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <div className="dialog mrg" role="dialog" aria-modal="true" aria-labelledby="mrg-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="mrg-title">{tr('Merge a duplicate into {name}', { name: fullName(keep) })}</h2>
        <p className="dialog-body">{tr('Use this when the same person has two records, for example an account made by hand and the same person again from TimeStation. Everything on the duplicate moves to the record you keep, and the duplicate is removed.')}</p>
        {error && <div className="error-banner" role="alert">{error}</div>}

        {!dup ? (
          <>
            <SearchInput value={q} onChange={setQ} placeholder={tr('Search name, code or email…')} />
            <div className="mrg-list" role="listbox" aria-label={tr('The duplicate')}>
              {all === null ? <p className="dk-muted">{tr('Loading…')}</p> : candidates.slice(0, 60).map((e) => (
                <button key={e.id} type="button" role="option" aria-selected="false" className="mrg-person" onClick={() => setDup(e)}>
                  <Photo id={e.id} name={fullName(e)} photo={e.photo} size={36} />
                  <span className="mrg-person-text">
                    <strong>{fullName(e)}</strong>
                    <span className="dk-muted">{[e.code, e.positionTitle, e.email].filter(Boolean).join(' · ')}</span>
                  </span>
                  {sameName(e, keep) && <Status tone="warn">{tr('Same name')}</Status>}
                  {e.status !== 'active' && <Status tone="muted">{codeLabel(e.status)}</Status>}
                </button>
              ))}
              {all && !candidates.length && <p className="dk-muted">{tr('No one matches.')}</p>}
            </div>
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button></div>
          </>
        ) : (
          <>
            <div className="mrg-pair">
              <div className="mrg-card is-keep">
                <span className="mrg-tag">{tr('Keep')}</span>
                <strong>{fullName(keep)}</strong>
                <span className="dk-muted">{[keep.code, keep.email].filter(Boolean).join(' · ')}</span>
                {preview && <span className="dk-muted">{preview.logins.keep ? tr('Signs in as {email}', { email: preview.logins.keep.email }) : tr('No sign-in')}</span>}
              </div>
              <button type="button" className="mrg-swap" onClick={() => { const k = keep; setKeep(dup); setDup(k); }} title={tr('Keep the other one instead')} aria-label={tr('Keep the other one instead')}>⇄</button>
              <div className="mrg-card is-dup">
                <span className="mrg-tag">{tr('Merge in and remove')}</span>
                <strong>{fullName(dup)}</strong>
                <span className="dk-muted">{[dup.code, dup.email].filter(Boolean).join(' · ')}</span>
                {preview && <span className="dk-muted">{preview.logins.duplicate ? tr('Signs in as {email}', { email: preview.logins.duplicate.email }) : tr('No sign-in')}{preview.duplicate.timestation ? ' · ' + tr('from TimeStation') : ''}</span>}
              </div>
            </div>

            {!preview ? <p className="dk-muted">{tr('Checking what would move…')}</p> : (
              <>
                <h3 className="mrg-h3">{tr('What moves to {name}', { name: fullName(keep) })}</h3>
                {!preview.moves.length ? <p className="dk-muted">{tr('Nothing is linked to the duplicate.')}</p> : (
                  <ul className="mrg-moves">
                    {Object.entries(grouped.known).map(([t, n]) => <li key={t}><strong>{n.toLocaleString()}</strong> {tr(MOVES[t])}</li>)}
                    {grouped.other > 0 && <li><strong>{grouped.other.toLocaleString()}</strong> {tr('other linked records')}</li>}
                  </ul>
                )}
                {preview.takes.length > 0 && (
                  <p className="mrg-note">{tr('{name} also takes from the duplicate what it doesn\'t have yet: {list}.', { name: fullName(keep), list: preview.takes.map((t) => (TAKES.has(t) ? tr(t) : t)).join(', ') })}</p>
                )}
                <ul className="mrg-warn">
                  {preview.loginRemoved && <li>{tr('Both can sign in. The duplicate\'s login ({email}) will be removed; {name} keeps signing in as {keep}.', { email: preview.logins.duplicate.email, name: fullName(keep), keep: preview.logins.keep.email })}</li>}
                  {preview.loginMoves && <li>{tr('Only the duplicate can sign in. Its login ({email}) moves to {name}.', { email: preview.logins.duplicate.email, name: fullName(keep) })}</li>}
                  {preview.sameAttendanceDays > 0 && <li>{tr('{n} days have attendance on both. The one with clock times is kept.', { n: preview.sameAttendanceDays })}</li>}
                  {preview.chatBetweenThemRemoved && <li>{tr('The one-to-one chat between the two records is removed.')}</li>}
                  <li>{tr('Leave balances of the same type and year are added together, and the earlier start date of the two is kept.')}</li>
                </ul>
                {preview.isYou && <div className="error-banner">{tr('You are signed in as the record that would be removed. Press ⇄ to keep the one you sign in with.')}</div>}
                {preview.blockers.map((b) => <div key={b} className="error-banner">{b}</div>)}
                <label className="mrg-sure">
                  <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} disabled={!!preview.blockers.length || preview.isYou} />
                  {tr('I understand this can\'t be undone.')}
                </label>
              </>
            )}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setDup(null)}>{tr('Back')}</button>
              <button type="button" className="btn btn-primary" disabled={!preview || !sure || busy || !!preview.blockers.length || preview.isYou} onClick={doMerge}>
                {busy ? tr('Merging…') : tr('Merge into {name}', { name: fullName(keep) })}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
