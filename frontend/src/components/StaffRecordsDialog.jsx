import { useMemo, useState } from 'react';
import { api } from '../api/client';
import { Status } from './DashKit';
import { money } from '../lib/currency';
import { tr } from '../lib/i18n.jsx';
import './SetEmployeeIdsDialog.css';

// Staff records from an HR sheet (employeeRecords.service.js): choose the
// .xlsx, see who each row is and what changes — the salary for SSNIT (the
// SSNIT amount over the staff rate), SSNIT number, Ghana Card, TIN — then
// set them. Empty or N/A cells leave a field as it is; numbers that don't
// look right are listed and left out. Laid out like SetHireDatesDialog,
// whose styles it shares.

const TONE = { match: 'good', maybe: 'warn', several: 'warn', none: 'muted' };
const FIELDS = ['ssnitSalary', 'ssnitNumber', 'ghanaCard', 'tin'];

function differs(field, now, value) {
  if (value === undefined) return false;
  if (field === 'ssnitSalary') return now == null || Number(now) !== Number(value);
  return String(now || '').toUpperCase() !== String(value).toUpperCase();
}

export default function StaffRecordsDialog({ onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null); // { tab, columns, staffRate, rows }
  const [pick, setPick] = useState({}); // row index -> employee id ('' = leave out)
  const [show, setShow] = useState('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function check() {
    setBusy(true); setError(null);
    try {
      const fd = new FormData(); fd.append('file', file);
      const r = await api.upload('/employees/records/preview', fd);
      const first = {};
      r.rows.forEach((row, i) => { first[i] = row.status === 'match' && !row.repeated ? row.candidates[0].id : ''; });
      setResult(r); setPick(first); setShow('all');
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  const rows = result ? result.rows : null;
  const plan = useMemo(() => {
    if (!rows) return null;
    const chosen = {};
    Object.values(pick).forEach((id) => { if (id) chosen[id] = (chosen[id] || 0) + 1; });
    return rows.map((row, i) => {
      const id = pick[i];
      const person = id ? row.candidates.find((c) => c.id === id) : null;
      const changes = person ? FIELDS.filter((f) => differs(f, person.now[f], row.values[f])) : [];
      const hasValues = FIELDS.some((f) => row.values[f] !== undefined);
      let state = 'skip', why = null;
      if (row.repeated) { state = 'blocked'; why = tr('This person is on the sheet more than once; leave one row out.'); }
      else if (person && chosen[person.id] > 1) { state = 'blocked'; why = tr('{name} is picked on another row too.', { name: person.name }); }
      else if (person && !hasValues) state = 'empty';
      else if (person && !changes.length) state = 'same';
      else if (person) state = 'set';
      return { row, person, changes, state, why, taken: (c) => chosen[c.id] && pick[i] !== c.id };
    });
  }, [rows, pick]);

  const counts = useMemo(() => {
    const c = { all: 0, set: 0, check: 0, none: 0, same: 0, blocked: 0, problems: 0 };
    (plan || []).forEach((p) => {
      c.all++;
      if (p.state === 'set') c.set++;
      if (p.state === 'same' || p.state === 'empty') c.same++;
      if (p.state === 'blocked') c.blocked++;
      if ((p.row.status === 'maybe' || p.row.status === 'several') && !p.person) c.check++;
      if (p.row.status === 'none') c.none++;
      if (p.row.problems.some((x) => !x.kept)) c.problems++;
    });
    return c;
  }, [plan]);

  const visible = (plan || []).map((p, i) => ({ ...p, i })).filter((p) => {
    if (show === 'set') return p.state === 'set';
    if (show === 'check') return (p.row.status === 'maybe' || p.row.status === 'several') && !p.person;
    if (show === 'none') return p.row.status === 'none';
    if (show === 'blocked') return p.state === 'blocked';
    if (show === 'problems') return p.row.problems.some((x) => !x.kept);
    return true;
  });

  async function apply() {
    setBusy(true); setError(null);
    try {
      const changes = plan.filter((p) => p.state === 'set').map((p) => {
        const c = { employeeId: p.person.id };
        p.changes.forEach((f) => { c[f] = p.row.values[f]; });
        return c;
      });
      const r = await api.post('/employees/records/apply', { changes });
      onDone(r.updated === 1 ? tr('1 staff record updated.') : tr('{n} staff records updated.', { n: r.updated }));
    } catch (e) { setError(e.message); setBusy(false); }
  }

  const label = (s) => ({ match: tr('Matches'), maybe: tr('Check'), several: tr('Same name twice'), none: tr('Not in the OS') })[s];
  const fieldLabel = (f) => ({ ssnitSalary: tr('Salary for SSNIT'), ssnitAmount: tr('SSNIT'), ssnitNumber: tr('SSNIT number'), ghanaCard: tr('Ghana Card'), tin: tr('TIN') })[f];
  const shown = (f, v) => (f === 'ssnitSalary' ? money(v) : v);
  const problemText = (x) => (x.why === 'twice'
    ? tr('{field} {value} is on more than one row; left out.', { field: fieldLabel(x.field), value: x.value })
    : x.why === 'unusual'
      ? tr('SSNIT number {value} is not the usual letter and 12 digits; check it.', { value: x.value })
      : tr('{field} "{value}" doesn\'t look right; left out.', { field: fieldLabel(x.field), value: x.value }));

  return (
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <div className="dialog sid srd" role="dialog" aria-modal="true" aria-labelledby="srd-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="srd-title">{tr('Bring in staff records')}</h2>
        {error && <div className="error-banner" role="alert">{error}</div>}

        {!result ? (
          <>
            <p className="dialog-body">{tr('Choose your HR sheet (.xlsx): a row per person with their name, and any of SSNIT ID, GH Card, TIN and SSNIT (the amount they pay each month). Empty or N/A cells are skipped. You will see who each row matches and what changes before anything is saved.')}</p>
            <input type="file" accept=".xlsx" onChange={(e) => setFile(e.target.files[0] || null)} aria-label={tr('Staff sheet')} />
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
              <button type="button" className="btn btn-primary" disabled={busy || !file} onClick={check}>{busy ? tr('Checking…') : tr('Check the sheet')}</button>
            </div>
          </>
        ) : (
          <>
            <div className="sid-summary">
              <div className="sid-sum is-good"><strong>{counts.set}</strong><span>{tr('will be updated')}</span></div>
              <div className="sid-sum is-warn"><strong>{counts.check}</strong><span>{tr('to check: say who they are')}</span></div>
              <div className="sid-sum"><strong>{counts.none}</strong><span>{tr('not in the OS, left out')}</span></div>
              {counts.same > 0 && <div className="sid-sum"><strong>{counts.same}</strong><span>{tr('nothing new for them')}</span></div>}
              {counts.blocked > 0 && <div className="sid-sum is-bad"><strong>{counts.blocked}</strong><span>{tr('can\'t be set')}</span></div>}
            </div>
            {result.columns.includes('ssnitAmount') && !result.columns.includes('ssnitSalary') && (
              <p className="srd-note">{tr('The SSNIT column is read as what each person pays each month ({rate}% of their salary for SSNIT): 32.45 is a salary for SSNIT of 590.00.', { rate: result.staffRate })}</p>
            )}

            <div className="sid-tabs" role="tablist">
              {[['all', tr('All')], ['set', tr('Will be updated')], ['check', tr('To check')], ['none', tr('Not in the OS')], ['problems', tr('Left out values')], ['blocked', tr('Can\'t be set')]]
                .filter(([k]) => k === 'all' || counts[k] > 0)
                .map(([k, l]) => (
                  <button key={k} type="button" role="tab" aria-selected={show === k} className={'sid-tab' + (show === k ? ' is-on' : '')} onClick={() => setShow(k)}>
                    {l} <span>{counts[k]}</span>
                  </button>
                ))}
            </div>

            <ul className="sid-list">
              {visible.map((p) => (
                <li key={p.i} className={'sid-row srd-row is-' + p.state + (p.row.status === 'none' ? ' is-none' : '')}>
                  <span className="srd-line">{tr('Row {n}', { n: p.row.row })}</span>
                  <span className="sid-who">
                    <span className="sid-name">{p.row.name || p.row.code}</span>
                    {p.person && <span className="dk-muted">{p.person.name + ' · ' + p.person.code + (p.person.positionTitle ? ' · ' + p.person.positionTitle : '')}</span>}
                    <span className="srd-values">
                      {FIELDS.filter((f) => p.row.values[f] !== undefined).map((f) => {
                        const now = p.person ? p.person.now[f] : null;
                        const changing = p.person && differs(f, now, p.row.values[f]);
                        return (
                          <span key={f} className={'srd-val' + (changing ? ' is-new' : '')}>
                            <b>{fieldLabel(f)}</b> {changing && now != null && now !== '' ? shown(f, now) + ' → ' : ''}{shown(f, p.row.values[f])}
                            {f === 'ssnitSalary' && p.row.values.ssnitAmount !== undefined ? ' ' + tr('(pays {amount})', { amount: money(p.row.values.ssnitAmount) }) : ''}
                          </span>
                        );
                      })}
                    </span>
                    {p.row.problems.map((x, k) => <span key={k} className={x.kept ? 'srd-warn' : 'sid-why'}>{problemText(x)}</span>)}
                    {(p.row.status === 'maybe' || p.row.status === 'several') && (
                      <select className="input sid-pick" value={pick[p.i] || ''} onChange={(e) => setPick({ ...pick, [p.i]: e.target.value })}
                        aria-label={tr('Who is {name}?', { name: p.row.name })}>
                        <option value="">{tr('Who is this? (leave out)')}</option>
                        {p.row.candidates.map((c) => (
                          <option key={c.id} value={c.id} disabled={!!p.taken(c)}>{c.name + ' · ' + c.code + (c.positionTitle ? ' · ' + c.positionTitle : '')}</option>
                        ))}
                      </select>
                    )}
                    {p.row.status === 'match' && (p.state === 'set' || (p.state === 'skip' && !p.row.repeated)) && (
                      <label className="sid-tick">
                        <input type="checkbox" checked={!!pick[p.i]} onChange={(e) => setPick({ ...pick, [p.i]: e.target.checked ? p.row.candidates[0].id : '' })} />
                        {tr('Update')}
                      </label>
                    )}
                    {p.why && <span className="sid-why">{p.why}</span>}
                  </span>
                  <span className="sid-state">
                    {p.state === 'same' ? <Status tone="muted">{tr('Already set')}</Status>
                      : p.state === 'empty' ? <Status tone="muted">{tr('Nothing to bring in')}</Status>
                      : p.state === 'blocked' ? <Status tone="bad">{tr('Can\'t be set')}</Status>
                      : <Status tone={TONE[p.row.status]}>{label(p.row.status)}</Status>}
                  </span>
                </li>
              ))}
            </ul>

            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setResult(null)}>{tr('Back')}</button>
              <button type="button" className="btn btn-primary" disabled={busy || !counts.set} onClick={apply}>
                {busy ? tr('Saving…') : counts.set === 1 ? tr('Update 1 person') : tr('Update {n} people', { n: counts.set })}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
