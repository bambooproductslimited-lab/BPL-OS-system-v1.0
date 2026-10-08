import { useMemo, useState } from 'react';
import { api } from '../api/client';
import { Status, fmtDate } from './DashKit';
import { tr } from '../lib/i18n.jsx';
import './SetEmployeeIdsDialog.css';

// Hire dates for many people at once (employeeHireDates.service.js): paste
// a name or employee ID and the day they started, one person per line, see
// who each line is and what changes, then set them. Laid out like
// SetEmployeeIdsDialog, whose styles it shares.

const TONE = { match: 'good', maybe: 'warn', several: 'warn', none: 'muted' };

export default function SetHireDatesDialog({ onClose, onDone }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState(null); // { rows, skipped, order, ambiguous }
  const [pick, setPick] = useState({}); // row index -> employee id ('' = nobody)
  const [show, setShow] = useState('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function check(order) {
    setBusy(true); setError(null);
    try {
      const r = await api.post('/employees/hire-dates/preview', { text, order: order || null });
      const first = {};
      r.rows.forEach((row, i) => { first[i] = row.status === 'match' && !row.repeated ? row.candidates[0].id : ''; });
      setResult(r); setPick(first); setShow('all');
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  const rows = result ? result.rows : null;
  const plan = useMemo(() => {
    if (!rows) return null;
    const chosen = {}; // employee id -> how many lines picked them
    Object.values(pick).forEach((id) => { if (id) chosen[id] = (chosen[id] || 0) + 1; });
    return rows.map((row, i) => {
      const id = pick[i];
      const person = id ? row.candidates.find((c) => c.id === id) : null;
      let state = 'skip', why = null;
      if (row.repeated) { state = 'blocked'; why = tr('This person is on the list more than once; leave one line out.'); }
      else if (person && chosen[person.id] > 1) { state = 'blocked'; why = tr('{name} is picked on another line too.', { name: person.name }); }
      else if (person && String(person.hireDate).slice(0, 10) === row.date) state = 'same';
      else if (person) state = 'set';
      return { row, person, state, why, taken: (c) => chosen[c.id] && pick[i] !== c.id };
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
      const changes = plan.filter((p) => p.state === 'set').map((p) => ({ employeeId: p.person.id, hireDate: p.row.date }));
      const r = await api.post('/employees/hire-dates/apply', { changes });
      onDone(r.updated === 1 ? tr('1 hire date set.') : tr('{n} hire dates set.', { n: r.updated }));
    } catch (e) { setError(e.message); setBusy(false); }
  }

  const label = (s) => ({ match: tr('Matches'), maybe: tr('Check'), several: tr('Same name twice'), none: tr('Not in the OS') })[s];
  const whySkipped = (w) => ({ 'no-date': tr('no date'), 'bad-date': tr('not a real date'), 'no-person': tr('no name or ID') })[w] || '';

  return (
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <div className="dialog sid shd" role="dialog" aria-modal="true" aria-labelledby="shd-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="shd-title">{tr('Set hire dates from a list')}</h2>
        {error && <div className="error-banner" role="alert">{error}</div>}

        {!result ? (
          <>
            <p className="dialog-body">{tr('Copy the name (or employee ID) and start date columns from your HR or payroll sheet and paste them below, one person per line. Dates like 11/03/2019, 2019-03-11 or 11 Mar 2019 all work. You will see who each line matches and what changes before anything is saved.')}</p>
            <textarea className="input sid-paste" value={text} onChange={(e) => setText(e.target.value)} rows={10} spellCheck={false}
              placeholder={'Abena Mensah\t11/03/2019\nBPL-014\t2 Feb 2021\n…'} aria-label={tr('Names and hire dates')} />
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
              <button type="button" className="btn btn-primary" disabled={busy || !text.trim()} onClick={() => check()}>{busy ? tr('Checking…') : tr('Check the list')}</button>
            </div>
          </>
        ) : (
          <>
            <div className="sid-summary">
              <div className="sid-sum is-good"><strong>{counts.set}</strong><span>{tr('will get the new date')}</span></div>
              <div className="sid-sum is-warn"><strong>{counts.check}</strong><span>{tr('to check: say who they are')}</span></div>
              <div className="sid-sum"><strong>{counts.none}</strong><span>{tr('not in the OS, left out')}</span></div>
              {counts.same > 0 && <div className="sid-sum"><strong>{counts.same}</strong><span>{tr('already have that date')}</span></div>}
              {counts.blocked > 0 && <div className="sid-sum is-bad"><strong>{counts.blocked}</strong><span>{tr('can\'t be set')}</span></div>}
            </div>

            {result.ambiguous && (
              <div className="shd-order" role="group" aria-label={tr('How to read 03/04/2019')}>
                <span>{tr('Some dates could be read either way round. 03/04/2019 is read as:')}</span>
                <button type="button" className={'sid-tab' + (result.order === 'dmy' ? ' is-on' : '')} disabled={busy} onClick={() => result.order !== 'dmy' && check('dmy')}>{tr('3 April (day first)')}</button>
                <button type="button" className={'sid-tab' + (result.order === 'mdy' ? ' is-on' : '')} disabled={busy} onClick={() => result.order !== 'mdy' && check('mdy')}>{tr('March 4 (month first)')}</button>
              </div>
            )}

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
                <li key={p.i} className={'sid-row shd-row is-' + p.state + (p.row.status === 'none' ? ' is-none' : '')}>
                  <span className="shd-date">{fmtDate(p.row.date)}</span>
                  <span className="sid-who">
                    <span className="sid-name">{p.row.by === 'id' && p.row.code ? <span className="shd-code">{p.row.code}</span> : null}{p.row.name}</span>
                    {p.person && (
                      <span className="dk-muted">
                        {p.state === 'same' ? tr('{name}: already {date}', { name: p.person.name, date: fmtDate(p.person.hireDate) })
                          : tr('{name}: now {was} → {date}', { name: p.person.name, was: fmtDate(p.person.hireDate), date: fmtDate(p.row.date) })}
                      </span>
                    )}
                    {(p.row.status === 'maybe' || p.row.status === 'several') && (
                      <select className="input sid-pick" value={pick[p.i] || ''} onChange={(e) => setPick({ ...pick, [p.i]: e.target.value })}
                        aria-label={tr('Who is {name}?', { name: p.row.name })}>
                        <option value="">{tr('Who is this? (leave out)')}</option>
                        {p.row.candidates.map((c) => (
                          <option key={c.id} value={c.id} disabled={!!p.taken(c)}>
                            {c.name + ' · ' + c.code + (c.positionTitle ? ' · ' + c.positionTitle : '')}
                          </option>
                        ))}
                      </select>
                    )}
                    {p.row.status === 'match' && p.state !== 'same' && !p.row.repeated && (
                      <label className="sid-tick">
                        <input type="checkbox" checked={!!pick[p.i]} onChange={(e) => setPick({ ...pick, [p.i]: e.target.checked ? p.row.candidates[0].id : '' })} />
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
            {result.skipped.length > 0 && (
              <p className="sid-skipped">{(() => {
                const lines = result.skipped.slice(0, 3).map((s) => s.line + ' (' + whySkipped(s.why) + ')').join(' · ') + (result.skipped.length > 3 ? ' …' : '');
                return result.skipped.length === 1 ? tr('Skipped 1 line: {lines}', { lines }) : tr('Skipped {n} lines: {lines}', { n: result.skipped.length, lines });
              })()}</p>
            )}

            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setResult(null)}>{tr('Back')}</button>
              <button type="button" className="btn btn-primary" disabled={busy || !counts.set} onClick={apply}>
                {busy ? tr('Saving…') : counts.set === 1 ? tr('Set 1 hire date') : tr('Set {n} hire dates', { n: counts.set })}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
