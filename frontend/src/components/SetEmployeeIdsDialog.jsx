import { useMemo, useState } from 'react';
import { api } from '../api/client';
import { Status } from './DashKit';
import { tr } from '../lib/i18n.jsx';
import './SetEmployeeIdsDialog.css';

// Employee IDs for many people at once (employeeCodes.service.js): paste the
// ID and name columns from a sheet, see who each line is, then set them.
// A name that is exactly one person is ticked; a close name ("Albert Amadu
// Awini" for Albert Awini) waits for someone to say who it is; a name not in
// the OS is left out. An ID someone else keeps can't be given.

const TONE = { match: 'good', maybe: 'warn', several: 'warn', none: 'muted' };

export default function SetEmployeeIdsDialog({ onClose, onDone }) {
  const [text, setText] = useState('');
  const [rows, setRows] = useState(null); // preview rows
  const [skipped, setSkipped] = useState([]);
  const [pick, setPick] = useState({}); // row index -> employee id ('' = nobody)
  const [show, setShow] = useState('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function check() {
    setBusy(true); setError(null);
    try {
      const r = await api.post('/employees/codes/preview', { text });
      const first = {};
      r.rows.forEach((row, i) => { first[i] = row.status === 'match' && !row.repeated ? row.candidates[0].id : ''; });
      setRows(r.rows); setSkipped(r.skipped); setPick(first); setShow('all');
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  // What each line will do, given who is picked on every line.
  const plan = useMemo(() => {
    if (!rows) return null;
    const chosen = {}; // employee id -> row index
    Object.entries(pick).forEach(([i, id]) => { if (id) chosen[id] = Number(i); });
    return rows.map((row, i) => {
      const id = pick[i];
      const person = id ? row.candidates.find((c) => c.id === id) : null;
      let state = 'skip', why = null;
      if (row.repeated) { state = 'blocked'; why = tr('This ID is on the list more than once.'); }
      else if (person && person.code.toUpperCase() === row.code) state = 'same';
      else if (person && row.holder && row.holder.id !== person.id && chosen[row.holder.id] === undefined) {
        state = 'blocked'; why = tr('{name} already has this ID and keeps it.', { name: row.holder.name });
      } else if (person) state = 'set';
      return { row, person, state, why, taken: (c) => chosen[c.id] !== undefined && chosen[c.id] !== i };
    });
  }, [rows, pick]);

  const counts = useMemo(() => {
    const c = { all: 0, set: 0, check: 0, none: 0, same: 0, blocked: 0 };
    (plan || []).forEach((p) => {
      c.all++;
      if (p.state === 'set') c.set++;
      if (p.state === 'same') c.same++;
      if (p.state === 'blocked') c.blocked++;
      if ((p.row.status === 'maybe' || p.row.status === 'several') && !p.person) c.check++;
      if (p.row.status === 'none') c.none++;
    });
    return c;
  }, [plan]);

  const visible = (plan || []).map((p, i) => ({ ...p, i })).filter((p) => {
    if (show === 'set') return p.state === 'set';
    if (show === 'check') return (p.row.status === 'maybe' || p.row.status === 'several') && !p.person;
    if (show === 'none') return p.row.status === 'none';
    if (show === 'blocked') return p.state === 'blocked';
    return true;
  });

  async function apply() {
    setBusy(true); setError(null);
    try {
      const changes = plan.filter((p) => p.state === 'set').map((p) => ({ employeeId: p.person.id, code: p.row.code }));
      const r = await api.post('/employees/codes/apply', { changes });
      onDone(tr('{n} employee IDs set.', { n: r.updated }));
    } catch (e) { setError(e.message); setBusy(false); }
  }

  const label = (s) => ({ match: tr('Matches'), maybe: tr('Check'), several: tr('Same name twice'), none: tr('Not in the OS') })[s];

  return (
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <div className="dialog sid" role="dialog" aria-modal="true" aria-labelledby="sid-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="sid-title">{tr('Set employee IDs from a list')}</h2>
        {error && <div className="error-banner" role="alert">{error}</div>}

        {!rows ? (
          <>
            <p className="dialog-body">{tr('Copy the ID and name columns from your sheet (TimeStation, payroll, ID cards) and paste them below, one person per line. Surname first is fine. You will see who each line matches before anything changes.')}</p>
            <textarea className="input sid-paste" value={text} onChange={(e) => setText(e.target.value)} rows={10} spellCheck={false}
              placeholder={'5013\tAbena Mensah\n3016\tKwame Boateng\n…'} aria-label={tr('IDs and names')} />
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
              <button type="button" className="btn btn-primary" disabled={busy || !text.trim()} onClick={check}>{busy ? tr('Checking…') : tr('Check the list')}</button>
            </div>
          </>
        ) : (
          <>
            <div className="sid-summary">
              <div className="sid-sum is-good"><strong>{counts.set}</strong><span>{tr('will get their ID')}</span></div>
              <div className="sid-sum is-warn"><strong>{counts.check}</strong><span>{tr('to check: say who they are')}</span></div>
              <div className="sid-sum"><strong>{counts.none}</strong><span>{tr('not in the OS, left out')}</span></div>
              {counts.same > 0 && <div className="sid-sum"><strong>{counts.same}</strong><span>{tr('already have it')}</span></div>}
              {counts.blocked > 0 && <div className="sid-sum is-bad"><strong>{counts.blocked}</strong><span>{tr('can\'t be set')}</span></div>}
            </div>

            <div className="sid-tabs" role="tablist">
              {[['all', tr('All')], ['set', tr('Will be set')], ['check', tr('To check')], ['none', tr('Not in the OS')], ['blocked', tr('Can\'t be set')]]
                .filter(([k]) => k === 'all' || counts[k] > 0)
                .map(([k, l]) => (
                  <button key={k} type="button" role="tab" aria-selected={show === k} className={'sid-tab' + (show === k ? ' is-on' : '')} onClick={() => setShow(k)}>
                    {l} <span>{counts[k]}</span>
                  </button>
                ))}
            </div>

            <ul className="sid-list">
              {visible.map((p) => (
                <li key={p.i} className={'sid-row is-' + p.state + (p.row.status === 'none' ? ' is-none' : '')}>
                  <span className="sid-code">{p.row.code}</span>
                  <span className="sid-who">
                    <span className="sid-name">{p.row.name}</span>
                    {p.row.status === 'match' && p.person && (
                      <span className="dk-muted">{[p.person.positionTitle, tr('now {code}', { code: p.person.code })].filter(Boolean).join(' · ')}</span>
                    )}
                    {(p.row.status === 'maybe' || p.row.status === 'several') && (
                      <select className="input sid-pick" value={pick[p.i] || ''} onChange={(e) => setPick({ ...pick, [p.i]: e.target.value })}
                        aria-label={tr('Who is {name}?', { name: p.row.name })}>
                        <option value="">{tr('Who is this? (leave out)')}</option>
                        {p.row.candidates.map((c) => (
                          <option key={c.id} value={c.id} disabled={p.taken(c)}>
                            {c.name + ' · ' + c.code + (c.positionTitle ? ' · ' + c.positionTitle : '')}
                          </option>
                        ))}
                      </select>
                    )}
                    {p.row.status === 'match' && p.state !== 'same' && (
                      <label className="sid-tick">
                        <input type="checkbox" checked={!!pick[p.i]} disabled={p.row.repeated}
                          onChange={(e) => setPick({ ...pick, [p.i]: e.target.checked ? p.row.candidates[0].id : '' })} />
                        {tr('Set it')}
                      </label>
                    )}
                    {p.why && <span className="sid-why">{p.why}</span>}
                  </span>
                  <span className="sid-state">
                    {p.state === 'same' ? <Status tone="muted">{tr('Already set')}</Status>
                      : p.state === 'blocked' ? <Status tone="bad">{tr('Can\'t be set')}</Status>
                      : <Status tone={TONE[p.row.status]}>{label(p.row.status)}</Status>}
                  </span>
                </li>
              ))}
            </ul>
            {skipped.length > 0 && (
              <p className="sid-skipped">{tr('Skipped, no ID and name on the line: {lines}', { lines: skipped.slice(0, 3).join(' · ') + (skipped.length > 3 ? ' …' : '') })}</p>
            )}

            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setRows(null)}>{tr('Back')}</button>
              <button type="button" className="btn btn-primary" disabled={busy || !counts.set} onClick={apply}>
                {busy ? tr('Saving…') : tr('Set {n} IDs', { n: counts.set })}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
