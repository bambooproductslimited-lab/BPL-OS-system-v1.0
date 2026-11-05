import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import Photo from '../components/Photo';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { Insights, Section, fmtDate } from '../components/DashKit';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import { KINDS, PRIORITIES, STATUSES, kindIcon, kindName, priorityName, statusName } from '../lib/maintenance.js';
import { WoBanner } from './WorkOrdersFun.jsx';
import MaintenancePresent from './MaintenancePresent';
import './MaintenanceOrders.css';

// Maintenance and IT work orders — the jobs the maintenance team does
// around our places, as the team kept them in its Google Sheet, the IT work
// order tracker (backend maintenanceWorkOrders.service.js). The sheet's tabs
// are here as tabs: the Dashboard, the open jobs (Incomplete), the last 7
// days, every job (WO Data), the routines (RT Data and RT Report) and
// Billing with its audit tick. Anyone can ask for a job; the work order
// managers plan it, give it to someone and import the sheet; whoever a job
// is given to moves it along.

const FLOW = ['new', 'scheduled', 'in_progress', 'on_hold', 'completed'];
const TABS = [
  ['dash', () => tr('Dashboard')], ['open', () => tr('Jobs to do')], ['week', () => tr('Last 7 days')],
  ['all', () => tr('Every job')], ['routines', () => tr('Routine jobs')], ['billing', () => tr('Billing')]
];
const PAGE = 60;
const CURRENCIES = ['GHS', 'USD', 'EUR', 'GBP', 'CNY'];

function readPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* remembered for this visit only */ } }
function money(n, currency) {
  if (n === null || n === undefined) return '';
  try { return new Intl.NumberFormat(activeIntlLocale(), { style: 'currency', currency: currency || 'GHS', maximumFractionDigits: 2 }).format(n); } catch { return (currency || '') + ' ' + n; }
}
// Short, for a tile with little room (GHS 9.8K); the exact amount goes under it.
function moneyShort(n, currency) {
  try { return new Intl.NumberFormat(activeIntlLocale(), { style: 'currency', currency: currency || 'GHS', notation: 'compact', maximumFractionDigits: 1 }).format(n); } catch { return (currency || '') + ' ' + Math.round(n); }
}
function moneyMap(m) { const ks = Object.keys(m || {}); return ks.length ? ks.map((c) => money(m[c], c)).join(' + ') : '—'; }
function addDays(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function monthOf(iso) { return iso ? new Date(iso.slice(0, 7) + '-01T00:00:00Z').toLocaleDateString(activeIntlLocale(), { month: 'long', year: 'numeric', timeZone: 'UTC' }) : ''; }
function whoName(p) { return p ? p.name : ''; }
function dueWords(r) {
  if (!r.nextOn) return tr('No next date');
  if (r.dueIn === 0) return tr('Today');
  if (r.dueIn < 0) return tr('Late by {n} days', { n: -r.dueIn });
  if (r.dueIn === 1) return tr('Tomorrow');
  return tr('In {n} days', { n: r.dueIn });
}

function StatusPill({ status }) { return <span className={'mw-pill is-' + status}><i aria-hidden="true" />{statusName(status)}</span>; }
function PriorityPill({ priority }) { return <span className={'mw-prio is-' + priority}>{priorityName(priority)}</span>; }
function Kind({ k }) { return <span className="mw-kind"><span aria-hidden="true">{kindIcon(k)}</span>{kindName(k)}</span>; }
function Person({ p, size }) {
  if (!p) return <span className="dk-muted">{tr('Nobody yet')}</span>;
  return <span className="mw-person">{p.id ? <Photo id={p.id} name={p.name} photo={p.photo} size={size || 22} /> : <span className="mw-initial" aria-hidden="true">{(p.name || '?').charAt(0)}</span>}{p.name}</span>;
}

function downloadCsv(rows, name) {
  const head = [tr('Work order'), tr('Request date'), tr('Requested by'), tr('Place'), tr('Kind of job'), tr('Description'), tr('Priority'), tr('Status'),
    tr('Given to'), tr('Scheduled'), tr('Completed'), tr('Days taken'), tr('Currency'), tr('Estimated cost'), tr('Actual cost'), tr('Days open'), tr('Notes'), tr('Checked for billing')];
  const cell = (v) => '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"';
  const lines = rows.map((o) => [o.ref, o.requestedOn, whoName(o.requestedBy), o.location, kindName(o.category), o.description, priorityName(o.priority), statusName(o.status),
    whoName(o.assignedTo), o.scheduledOn, o.completedOn, o.daysTaken, o.currency, o.estimatedCost, o.actualCost, o.daysOpen, o.notes, o.audited ? '✓' : ''].map(cell).join(','));
  const blob = new Blob(['﻿' + [head.map(cell).join(',')].concat(lines).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name + '.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── a bar list: how many, with the open ones picked out ──
function Bars({ rows, label, total, open, onPick, icon }) {
  const max = Math.max(1, ...rows.map(total));
  return (
    <ul className="mw-bars">
      {rows.map((r) => (
        <li key={label(r)}>
          <button type="button" className="mw-bar-row" onClick={onPick ? () => onPick(r) : undefined} disabled={!onPick}>
            <span className="mw-bar-name">{icon && <span aria-hidden="true">{icon(r)}</span>}{label(r)}</span>
            <span className="mw-bar-track" aria-hidden="true">
              <span className="mw-bar-all" style={{ width: (total(r) / max * 100) + '%' }} />
              <span className="mw-bar-open" style={{ width: (open(r) / max * 100) + '%' }} />
            </span>
            <span className="mw-bar-n"><strong>{total(r)}</strong>{open(r) > 0 && <small>{tr('{n} open', { n: open(r) })}</small>}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// ── the job: everything on it, and what this person can do with it ──
function JobPanel({ job, can, myId, busy, onAct, onEdit, onDelete, onClose }) {
  const [doing, setDoing] = useState(null); // 'done' | 'schedule' | 'note'
  const [day, setDay] = useState(new Date().toISOString().slice(0, 10));
  const [cost, setCost] = useState(job.actualCost === null ? '' : String(job.actualCost));
  const [note, setNote] = useState('');
  const given = job.assignedTo && job.assignedTo.id === myId;
  const moves = can.manage || given;
  const asked = job.requestedBy && job.requestedBy.id === myId;
  const go = (status, extra) => onAct(job, { status, ...extra }).then(() => { setDoing(null); setNote(''); });
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog mw-job" role="dialog" aria-modal="true" aria-labelledby="mw-job-title" onClick={(e) => e.stopPropagation()}>
        <div className="mw-job-top">
          <span className="mw-job-ref">{job.ref}</span>
          <StatusPill status={job.status} />
          <PriorityPill priority={job.priority} />
          <Kind k={job.category} />
          {job.overdue && <span className="mw-late-tag">{tr('Overdue')}</span>}
          {job.audited && <span className="mw-audit-tag">✓ {tr('Checked for billing')}</span>}
        </div>
        <h2 id="mw-job-title" className="mw-job-title">{job.description}</h2>
        <dl className="mw-job-grid">
          <div><dt>{tr('Place')}</dt><dd>📍 {job.location || '—'}{job.companyName && job.companyName !== job.location ? <small> · {job.companyName}</small> : null}</dd></div>
          <div><dt>{tr('Asked for by')}</dt><dd><Person p={job.requestedBy && job.requestedBy.name ? job.requestedBy : null} /> <small>{fmtDate(job.requestedOn)}</small></dd></div>
          <div><dt>{tr('Given to')}</dt><dd><Person p={job.assignedTo} /></dd></div>
          <div><dt>{tr('Scheduled')}</dt><dd className={job.overdue ? 'is-late' : ''}>{job.scheduledOn ? fmtDate(job.scheduledOn) : '—'}</dd></div>
          <div><dt>{tr('Completed')}</dt><dd>{job.completedOn ? fmtDate(job.completedOn) : '—'}</dd></div>
          <div><dt>{tr('Days open')}</dt><dd>{job.daysOpen === null ? '—' : job.daysOpen}{job.daysTaken !== null && <small> · {job.daysTaken === 0 ? tr('done on its planned day') : tr('{n} days from its planned day', { n: job.daysTaken })}</small>}</dd></div>
          {(job.estimatedCost !== null || job.actualCost !== null) && <div><dt>{tr('Cost')}</dt><dd>{job.estimatedCost !== null && <span>{tr('Estimated')} {money(job.estimatedCost, job.currency)}</span>}{job.actualCost !== null && <strong> {tr('Actual')} {money(job.actualCost, job.currency)}</strong>}</dd></div>}
          {job.routineName && <div><dt>{tr('Routine')}</dt><dd>🔁 {job.routineName}</dd></div>}
        </dl>
        {job.notes && <p className="mw-job-notes">{job.notes}</p>}

        {doing === 'done' && (
          <div className="mw-inline">
            <label><span>{tr('Done on')}</span><input type="date" className="input" value={day} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setDay(e.target.value)} /></label>
            <label><span>{tr('Actual cost')} ({job.currency})</span><input className="input" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="0.00" /></label>
            <label className="is-wide"><span>{tr('Note (optional)')}</span><input className="input" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} /></label>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => go('completed', { completedOn: day, actualCost: cost, note })}>✓ {tr('Mark done')}</button>
          </div>
        )}
        {doing === 'schedule' && (
          <div className="mw-inline">
            <label><span>{tr('Planned for')}</span><input type="date" className="input" value={day} onChange={(e) => setDay(e.target.value)} /></label>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => go('scheduled', { scheduledOn: day })}>📅 {tr('Schedule')}</button>
          </div>
        )}
        {doing === 'note' && (
          <div className="mw-inline">
            <label className="is-wide"><span>{tr('Note')}</span><input className="input" value={note} maxLength={300} autoFocus onChange={(e) => setNote(e.target.value)} /></label>
            <button type="button" className="btn btn-primary" disabled={busy || !note.trim()} onClick={() => go(job.status, { note })}>{tr('Add note')}</button>
          </div>
        )}

        <div className="mw-job-acts">
          {moves && job.open && <>
            {job.status !== 'in_progress' && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => go('in_progress')}>▶ {tr('Start the job')}</button>}
            {job.status !== 'on_hold' && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => go('on_hold')}>⏸ {tr('On hold')}</button>}
            <button type="button" className={'btn btn-secondary' + (doing === 'schedule' ? ' is-on' : '')} onClick={() => setDoing(doing === 'schedule' ? null : 'schedule')}>📅 {tr('Schedule…')}</button>
            <button type="button" className={'btn btn-primary' + (doing === 'done' ? ' is-on' : '')} onClick={() => setDoing(doing === 'done' ? null : 'done')}>✓ {tr('Done…')}</button>
          </>}
          {moves && <button type="button" className="btn btn-secondary" onClick={() => setDoing(doing === 'note' ? null : 'note')}>✎ {tr('Add a note')}</button>}
          {can.manage && !job.open && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => go('in_progress')}>↺ {tr('Open again')}</button>}
          {(can.manage || (asked && job.status === 'new')) && job.open && <button type="button" className="pos-link is-bad" disabled={busy} onClick={() => { if (window.confirm(tr('Call off {ref}?', { ref: job.ref }))) go('cancelled'); }}>{tr('Call it off')}</button>}
        </div>
        <div className="dialog-actions">
          {can.manage && <button type="button" className="pos-link is-bad" onClick={() => { if (window.confirm(tr('Delete {ref} for good?', { ref: job.ref }))) onDelete(job); }}>{tr('Delete')}</button>}
          {can.manage && <button type="button" className="btn btn-secondary" onClick={() => onEdit(job)}>{tr('Edit')}</button>}
          <button type="button" className="btn btn-primary" onClick={onClose}>{tr('Close')}</button>
        </div>
      </div>
    </div>
  );
}

// ── asking for a job, or recording one in full ──
const EMPTY = { description: '', location: '', category: 'other', priority: 'medium', status: '', requestedById: '', requestedByName: '', requestedOn: '',
  assignedToId: '', assignedToName: '', scheduledOn: '', completedOn: '', currency: 'GHS', estimatedCost: '', actualCost: '', notes: '' };
function JobForm({ job, can, employees, places, busy, onSave, onClose }) {
  const [f, setF] = useState(() => job ? {
    ...EMPTY, description: job.description, location: job.location, category: job.category, priority: job.priority, status: job.status,
    requestedById: job.requestedBy && job.requestedBy.id ? job.requestedBy.id : '', requestedByName: job.requestedBy && !job.requestedBy.id ? job.requestedBy.name : '',
    requestedOn: job.requestedOn || '', assignedToId: job.assignedTo && job.assignedTo.id ? job.assignedTo.id : '', assignedToName: job.assignedTo && !job.assignedTo.id ? job.assignedTo.name : '',
    scheduledOn: job.scheduledOn || '', completedOn: job.completedOn || '', currency: job.currency, estimatedCost: job.estimatedCost === null ? '' : String(job.estimatedCost),
    actualCost: job.actualCost === null ? '' : String(job.actualCost), notes: job.notes
  } : EMPTY);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const full = can.manage;
  const staff = employees.slice().sort((a, b) => (a.firstName + a.lastName).localeCompare(b.firstName + b.lastName));
  function save() {
    const body = { description: f.description, location: f.location, category: f.category, priority: f.priority, notes: f.notes };
    if (full) Object.assign(body, {
      status: f.status || undefined, requestedOn: f.requestedOn || undefined, scheduledOn: f.scheduledOn, completedOn: f.status === 'completed' ? f.completedOn : undefined,
      requestedById: f.requestedById || null, requestedByName: f.requestedById ? '' : f.requestedByName,
      assignedToId: f.assignedToId || null, assignedToName: f.assignedToId ? '' : f.assignedToName,
      currency: f.currency, estimatedCost: f.estimatedCost, actualCost: f.actualCost
    });
    if (full && !job && !f.requestedById && !f.requestedByName) { delete body.requestedById; delete body.requestedByName; }
    onSave(body);
  }
  const personField = (idKey, nameKey, label) => (
    <label className="mw-field">
      <span>{label}</span>
      <select className="input" value={f[idKey] || (f[nameKey] ? '__name' : '')} onChange={(e) => { set(idKey, e.target.value === '__name' ? '' : e.target.value); if (e.target.value !== '__name') set(nameKey, ''); else set(nameKey, f[nameKey] || ' '); }}>
        <option value="">{tr('Nobody')}</option>
        {staff.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}
        <option value="__name">{tr('Someone not in the directory…')}</option>
      </select>
      {!f[idKey] && f[nameKey] !== '' && <input className="input" value={f[nameKey].trim() ? f[nameKey] : ''} maxLength={80} placeholder={tr('Their name')} onChange={(e) => set(nameKey, e.target.value)} />}
    </label>
  );
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog mw-form" role="dialog" aria-modal="true" aria-labelledby="mw-form-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="mw-form-title">{job ? tr('Edit {ref}', { ref: job.ref }) : full ? tr('New job') : tr('Ask for a job')}</h2>
        {!full && <p className="dk-muted wo-small">{tr('Say what is wrong and where. The maintenance team plans it, gives it to someone and you hear when it is done.')}</p>}
        <label className="mw-field">
          <span>{tr('What needs doing?')}</span>
          <textarea className="input" rows={3} value={f.description} maxLength={2000} autoFocus placeholder={tr('Such as: the kitchen tap is leaking')} onChange={(e) => set('description', e.target.value)} />
        </label>
        <label className="mw-field">
          <span>{tr('Where?')}</span>
          <input className="input" list="mw-places" value={f.location} maxLength={80} placeholder={tr('Such as BPL, Star Bar, Poki…')} onChange={(e) => set('location', e.target.value)} />
          <datalist id="mw-places">{places.map((p) => <option key={p} value={p} />)}</datalist>
        </label>
        <div className="mw-field"><span>{tr('Kind of job')}</span>
          <div className="mw-chips">{KINDS.map((k) => <button key={k} type="button" className={'mw-chip' + (f.category === k ? ' is-on' : '')} onClick={() => set('category', k)}><span aria-hidden="true">{kindIcon(k)}</span> {kindName(k)}</button>)}</div>
        </div>
        <div className="mw-field"><span>{tr('How urgent?')}</span>
          <div className="mw-chips">{PRIORITIES.map((p) => <button key={p} type="button" className={'mw-chip is-prio-' + p + (f.priority === p ? ' is-on' : '')} onClick={() => set('priority', p)}>{priorityName(p)}</button>)}</div>
        </div>
        {full && <>
          <div className="mw-two">
            {personField('assignedToId', 'assignedToName', tr('Given to'))}
            <label className="mw-field"><span>{tr('Scheduled for')}</span><input type="date" className="input" value={f.scheduledOn} onChange={(e) => set('scheduledOn', e.target.value)} /></label>
          </div>
          <div className="mw-two">
            {personField('requestedById', 'requestedByName', tr('Asked for by'))}
            <label className="mw-field"><span>{tr('Asked for on')}</span><input type="date" className="input" value={f.requestedOn} onChange={(e) => set('requestedOn', e.target.value)} placeholder={tr('Today')} /></label>
          </div>
          <div className="mw-two">
            <label className="mw-field"><span>{tr('Status')}</span>
              <select className="input" value={f.status} onChange={(e) => set('status', e.target.value)}>
                <option value="">{tr('As planned (new, or scheduled with a day)')}</option>
                {STATUSES.map((s) => <option key={s} value={s}>{statusName(s)}</option>)}
              </select>
            </label>
            {f.status === 'completed' && <label className="mw-field"><span>{tr('Completed on')}</span><input type="date" className="input" value={f.completedOn} onChange={(e) => set('completedOn', e.target.value)} /></label>}
          </div>
          <div className="mw-three">
            <label className="mw-field"><span>{tr('Currency')}</span>
              <select className="input" value={f.currency} onChange={(e) => set('currency', e.target.value)}>{CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}</select>
            </label>
            <label className="mw-field"><span>{tr('Estimated cost')}</span><input className="input" inputMode="decimal" value={f.estimatedCost} onChange={(e) => set('estimatedCost', e.target.value)} placeholder="0.00" /></label>
            <label className="mw-field"><span>{tr('Actual cost')}</span><input className="input" inputMode="decimal" value={f.actualCost} onChange={(e) => set('actualCost', e.target.value)} placeholder="0.00" /></label>
          </div>
        </>}
        <label className="mw-field">
          <span>{tr('Notes')}</span>
          <textarea className="input" rows={2} value={f.notes} maxLength={2000} onChange={(e) => set('notes', e.target.value)} />
        </label>
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
          <button type="button" className="btn btn-primary" disabled={busy || !f.description.trim()} onClick={save}>{busy ? tr('Saving…') : job ? tr('Save') : full ? tr('Add the job') : tr('Send the request')}</button>
        </div>
      </div>
    </div>
  );
}

// ── a routine: what it is, who does it, every how many days ──
function RoutineForm({ routine, employees, places, busy, onSave, onClose }) {
  const r = routine || {};
  const [f, setF] = useState({
    name: r.name || '', description: r.description || '', location: r.location || '', category: r.category || 'other', scheduleNote: r.scheduleNote || '',
    assignedToId: r.assignedTo && r.assignedTo.id ? r.assignedTo.id : '', assignedToName: r.assignedTo && !r.assignedTo.id ? r.assignedTo.name : '',
    everyDays: r.everyDays ? String(r.everyDays) : '', lastDoneOn: r.lastDoneOn || '', nextOn: '', notes: r.notes || '', link: r.link || ''
  });
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const staff = employees.slice().sort((a, b) => (a.firstName + a.lastName).localeCompare(b.firstName + b.lastName));
  const next = f.nextOn || (f.everyDays && f.lastDoneOn ? addDays(f.lastDoneOn, Number(f.everyDays) || 0) : '');
  function save() {
    const body = { ...f, everyDays: f.everyDays === '' ? null : Number(f.everyDays), assignedToId: f.assignedToId || null, assignedToName: f.assignedToId ? '' : f.assignedToName };
    if (!f.nextOn) delete body.nextOn;
    onSave(body);
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog mw-form" role="dialog" aria-modal="true" aria-labelledby="mw-rt-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="mw-rt-title">{routine ? tr('Edit routine {ref}', { ref: routine.ref }) : tr('New routine job')}</h2>
        <p className="dk-muted wo-small">{tr('A job that comes round again every so many days, such as cleaning the A/C units. Mark it done and its next day moves on by itself.')}</p>
        <div className="mw-two">
          <label className="mw-field"><span>{tr('Name')}</span><input className="input" value={f.name} maxLength={120} autoFocus placeholder={tr('Such as A/C cleaning')} onChange={(e) => set('name', e.target.value)} /></label>
          <label className="mw-field"><span>{tr('Where?')}</span><input className="input" list="mw-rt-places" value={f.location} maxLength={80} onChange={(e) => set('location', e.target.value)} /><datalist id="mw-rt-places">{places.map((p) => <option key={p} value={p} />)}</datalist></label>
        </div>
        <label className="mw-field"><span>{tr('What is done')}</span><textarea className="input" rows={2} value={f.description} maxLength={1000} onChange={(e) => set('description', e.target.value)} /></label>
        <div className="mw-field"><span>{tr('Kind of job')}</span>
          <div className="mw-chips">{KINDS.map((k) => <button key={k} type="button" className={'mw-chip' + (f.category === k ? ' is-on' : '')} onClick={() => set('category', k)}><span aria-hidden="true">{kindIcon(k)}</span> {kindName(k)}</button>)}</div>
        </div>
        <div className="mw-two">
          <label className="mw-field"><span>{tr('Who does it')}</span>
            <select className="input" value={f.assignedToId} onChange={(e) => set('assignedToId', e.target.value)}>
              <option value="">{f.assignedToName ? f.assignedToName : tr('Nobody')}</option>
              {staff.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}
            </select>
          </label>
          <label className="mw-field"><span>{tr('When in the day or week')}</span><input className="input" value={f.scheduleNote} maxLength={80} placeholder={tr('Such as Wednesday morning')} onChange={(e) => set('scheduleNote', e.target.value)} /></label>
        </div>
        <div className="mw-three">
          <label className="mw-field"><span>{tr('Every how many days')}</span><input className="input" inputMode="numeric" value={f.everyDays} onChange={(e) => set('everyDays', e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="30" /></label>
          <label className="mw-field"><span>{tr('Last done')}</span><input type="date" className="input" value={f.lastDoneOn} onChange={(e) => set('lastDoneOn', e.target.value)} /></label>
          <label className="mw-field"><span>{tr('Next time')}</span><input type="date" className="input" value={f.nextOn || next} onChange={(e) => set('nextOn', e.target.value)} /></label>
        </div>
        <div className="mw-two">
          <label className="mw-field"><span>{tr('Notes')}</span><input className="input" value={f.notes} maxLength={1000} onChange={(e) => set('notes', e.target.value)} /></label>
          <label className="mw-field"><span>{tr('Web link')}</span><input className="input" value={f.link} maxLength={500} placeholder="https://" onChange={(e) => set('link', e.target.value)} /></label>
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
          <button type="button" className="btn btn-primary" disabled={busy || !f.name.trim()} onClick={save}>{busy ? tr('Saving…') : tr('Save routine')}</button>
        </div>
      </div>
    </div>
  );
}

// ── the team's Google Sheet into the OS ──
function ImportSheet({ employees, onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [aliases, setAliases] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const staff = employees.slice().sort((a, b) => (a.firstName + a.lastName).localeCompare(b.firstName + b.lastName));
  const form = useCallback((f) => {
    const fd = new FormData();
    fd.append('file', f);
    const given = {};
    Object.keys(aliases).forEach((k) => { if (aliases[k]) given[k] = aliases[k]; });
    fd.append('aliases', JSON.stringify(given));
    return fd;
  }, [aliases]);
  async function pick(f) {
    setFile(f); setPreview(null); setError(null);
    if (!f) return;
    setBusy(true);
    try { setPreview(await api.upload('/maint-work-orders/import/preview', form(f))); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  useEffect(() => {
    if (!file || !preview) return undefined;
    const t = setTimeout(() => { api.upload('/maint-work-orders/import/preview', form(file)).then(setPreview).catch((err) => setError(err.message)); }, 300);
    return () => clearTimeout(t);
  }, [aliases]); // eslint-disable-line react-hooks/exhaustive-deps
  async function run() {
    setBusy(true); setError(null);
    try { onDone(await api.upload('/maint-work-orders/import', form(file))); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  const KINDS_READ = { orders: () => tr('work orders'), routines: () => tr('routines'), archived: () => tr('routines put away') };
  const unknown = preview ? preview.names.filter((n) => !n.matched || aliases[n.name]) : [];
  const known = preview ? preview.names.filter((n) => n.matched && !aliases[n.name]) : [];
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog wo-import mw-import" onClick={(e) => e.stopPropagation()}>
        <h2>{tr('Import the IT work order sheet')}</h2>
        <p className="dk-muted wo-small">{tr('In Google Sheets use File → Download → Microsoft Excel (.xlsx), then choose that file here. The WO Data tab brings the jobs, RT Data the routines, and a tab named Arc… the routines put away. Importing again later adds only what is new and brings the rest up to date.')}</p>
        <label className="wo-drop">
          <input type="file" accept=".xlsx" onChange={(e) => pick(e.target.files && e.target.files[0])} />
          <span className="wo-drop-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M4.5 15v3.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V15" /></svg></span>
          <span>{file ? file.name : tr('Choose the .xlsx file')}</span>
        </label>
        {busy && !preview && <p className="dk-muted wo-small">{tr('Reading the workbook…')}</p>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        {preview && (
          <div className="wo-import-body">
            <div className="wo-import-heads is-four">
              <div><strong>{preview.orders.add}</strong><span>{tr('new jobs to add')}</span></div>
              <div className={preview.orders.update ? 'is-update' : ''}><strong>{preview.orders.update}</strong><span>{tr('changed on the sheet since: brought up to date')}</span></div>
              <div><strong>{preview.orders.same}</strong><span>{tr('in the OS, nothing new')}</span></div>
              <div><strong>{preview.routines.add + preview.routines.update}</strong><span>{tr('routines to add or bring up to date')}</span></div>
            </div>
            <p className="wo-small">{tr('Tabs read:')} {preview.sheets.map((x) => tr('“{name}” — {kind}, {n} rows', { name: x.name, kind: (KINDS_READ[x.kind] || (() => x.kind))(), n: x.rows })).join(' · ')}</p>
            {Object.keys(preview.byStatus).length > 0 && <div className="wo-import-statuses"><span className="dk-muted wo-small">{tr('New ones:')}</span> {Object.keys(preview.byStatus).map((s) => <span key={s} className="wo-import-status"><StatusPill status={s} /> {preview.byStatus[s]}</span>)}</div>}
            {preview.orders.kept > 0 && <p className="wo-note">{tr('{n} jobs were changed in the OS since the last import: the OS keeps what it has for them.', { n: preview.orders.kept })}</p>}
            {unknown.length > 0 && (
              <section className="wo-import-section is-open">
                <h3 className="wo-small"><strong>{tr('Names not found in the staff directory')}</strong></h3>
                <p className="dk-muted wo-small">{tr('Say who each one is, and the OS remembers it for next time. Left as written, the name still shows on the job.')}</p>
                <ul className="mw-names">
                  {unknown.map((n) => (
                    <li key={n.name}>
                      <strong>{n.name}</strong>
                      <select className="input" value={aliases[n.name] || ''} onChange={(e) => setAliases({ ...aliases, [n.name]: e.target.value })} aria-label={tr('Who is {name}?', { name: n.name })}>
                        <option value="">{tr('Keep as written')}</option>
                        {(n.couldBe || []).length > 0 && <optgroup label={tr('Could be')}>{n.couldBe.map((c) => <option key={'c' + c.id} value={c.id}>{c.name}</option>)}</optgroup>}
                        <optgroup label={tr('Everyone')}>{staff.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}</optgroup>
                      </select>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {known.length > 0 && <p className="wo-small"><span className="dk-muted">{tr('Matched to staff:')}</span> {known.map((n) => n.name).join(', ')}</p>}
            {preview.places.length > 0 && <p className="wo-small"><span className="dk-muted">{tr('Places:')}</span> {preview.places.map((p) => p.location + (p.ours ? ' ✓' : '')).join(' · ')} <span className="dk-muted">{tr('(✓ one of our companies)')}</span></p>}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
          <button type="button" className="btn btn-primary" disabled={!preview || busy || (!preview.orders.add && !preview.orders.update && !preview.routines.add && !preview.routines.update)} onClick={run}>{busy ? tr('Importing…') : tr('Import')}</button>
        </div>
      </div>
    </div>
  );
}

export default function MaintenanceOrders({ myId }) {
  const [data, setData] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState(() => readPref('bos.mwTab', 'dash'));
  const [openId, setOpenId] = useState(() => new URLSearchParams(window.location.search).get('job') || null);
  const [form, setForm] = useState(null); // { job? }
  const [routineForm, setRoutineForm] = useState(null); // { routine? }
  const [importing, setImporting] = useState(false);
  const [presenting, setPresenting] = useState(false);
  // All jobs: the filters.
  const [q, setQ] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [fKind, setFKind] = useState('');
  const [fPlace, setFPlace] = useState('');
  const [fWho, setFWho] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [openChip, setOpenChip] = useState('all');
  const [billOnly, setBillOnly] = useState(false);

  const load = useCallback(() => api.get('/maint-work-orders').then(setData).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); api.get('/employees').then((list) => setEmployees(list.filter((e) => e.status !== 'terminated'))).catch(() => {}); }, [load]);
  function pickTab(t) { setTab(t); writePref('bos.mwTab', t); }
  function say(text) { setNotice(text); setTimeout(() => setNotice(null), 4000); }

  async function act(fn, text) {
    setBusy(true); setError(null);
    try { const out = await fn(); await load(); if (text) say(text); return out; } catch (e) { setError(e.message); throw e; } finally { setBusy(false); }
  }
  const moveJob = (job, body) => act(() => api.post('/maint-work-orders/' + job.id + '/status', body), tr('{ref} is now {status}.', { ref: job.ref, status: statusName(body.status).toLowerCase() })).catch(() => {});
  const saveJob = (body) => act(() => (form.job ? api.patch('/maint-work-orders/' + form.job.id, body) : api.post('/maint-work-orders', body)),
    form.job ? tr('{ref} saved.', { ref: form.job.ref }) : data.can.manage ? tr('Job added.') : tr('Your request is in: the maintenance team has been told.'))
    .then((o) => { setForm(null); if (o && o.id) setOpenId(o.id); }).catch(() => {});
  const deleteJob = (job) => act(() => api.del('/maint-work-orders/' + job.id), tr('{ref} deleted.', { ref: job.ref })).then(() => setOpenId(null)).catch(() => {});
  const audit = (job, on) => act(() => api.post('/maint-work-orders/' + job.id + '/audit', { audited: on })).catch(() => {});
  const saveRoutine = (body) => act(() => (routineForm.routine ? api.patch('/maint-work-orders/routines/' + routineForm.routine.id, body) : api.post('/maint-work-orders/routines', body)), tr('Routine job saved.'))
    .then(() => setRoutineForm(null)).catch(() => {});
  const routineDone = (r) => act(() => api.post('/maint-work-orders/routines/' + r.id + '/done', {}), tr('{name} done today: next time moved on.', { name: r.name })).catch(() => {});
  const routineOrder = (r) => act(() => api.post('/maint-work-orders/routines/' + r.id + '/order', {}), tr('A work order is made for {name}.', { name: r.name })).then((o) => o && setOpenId(o.id)).catch(() => {});
  const routineArchive = (r, on) => act(() => api.post('/maint-work-orders/routines/' + r.id + '/archive', { archived: on }), on ? tr('{name} put away.', { name: r.name }) : tr('{name} brought back.', { name: r.name })).catch(() => {});

  const orders = useMemo(() => (data ? data.orders : []), [data]);
  const today = data ? data.today : new Date().toISOString().slice(0, 10);
  const weekAgo = addDays(today, -7);
  const open = orders.filter((o) => o.open);
  const lastWeek = orders.filter((o) => o.status === 'completed' && o.completedOn >= weekAgo);
  const done = orders.filter((o) => o.status === 'completed');
  const places = data ? data.options.places : [];
  const people = useMemo(() => Array.from(new Set(orders.map((o) => whoName(o.assignedTo)).filter(Boolean))).sort(), [orders]);

  if (!data) return <div className="dk wo mw">{error ? <div className="error-banner" role="alert">{error}</div> : <p className="dk-muted">{tr('Loading…')}</p>}</div>;
  const s = data.summary;
  const can = data.can;
  const job = openId ? orders.find((o) => o.id === openId) : null;
  const routines = data.routines.filter((r) => !r.archived);
  const putAway = data.routines.filter((r) => r.archived);
  const firstCurrency = Object.keys(s.actual)[0];

  function showAll(filter) {
    setFStatus(filter.status || ''); setFKind(filter.kind || ''); setFPlace(filter.place || ''); setFWho(filter.who || ''); setQ(''); setShown(PAGE);
    pickTab('all');
  }
  const tiles = [
    { icon: 'wrench', value: String(s.open), label: tr('open jobs'), note: s.unassigned ? tr('{n} not given to anyone', { n: s.unassigned }) : tr('all given to someone'), onClick: () => pickTab('open'), active: tab === 'open' },
    { icon: 'warn', value: String(s.overdue), label: tr('overdue'), note: tr('still open after their planned day'), tone: s.overdue ? 'late' : '', onClick: () => { setOpenChip('late'); pickTab('open'); } },
    { icon: 'check', value: String(s.doneLast7), label: tr('done this week'), note: tr('{n} asked for in the same 7 days', { n: s.askedLast7 }), onClick: () => pickTab('week'), active: tab === 'week' },
    { icon: 'clock', value: s.avgDaysToClose === null ? '—' : String(s.avgDaysToClose), label: tr('days to close'), note: tr('on average, jobs done in the last 90 days') },
    { icon: 'calendar', value: String(s.routinesLate + s.routinesDueWeek), label: tr('routines due'), note: s.routinesLate ? (s.routinesLate === 1 ? tr('1 past its next day') : tr('{n} past their next day', { n: s.routinesLate })) : tr('in the next 7 days'), tone: s.routinesLate ? 'late' : '', onClick: () => pickTab('routines'), active: tab === 'routines' },
    { icon: 'cash', value: firstCurrency ? moneyShort(s.actual[firstCurrency], firstCurrency) : '—', label: tr('spent on jobs'), note: firstCurrency ? moneyMap(s.actual) : tr('actual costs recorded'), onClick: () => pickTab('billing'), active: tab === 'billing' }
  ];

  const insights = [];
  if (s.overdue) insights.push({ tone: 'bad', icon: 'warn', text: s.overdue === 1 ? tr('1 job is still open after its planned day.') : tr('{n} jobs are still open after their planned day.', { n: s.overdue }), action: { label: tr('Show them'), run: () => { setOpenChip('late'); pickTab('open'); } } });
  if (s.openByPriority.urgent) insights.push({ tone: 'bad', icon: 'warn', text: s.openByPriority.urgent === 1 ? tr('1 urgent job open.') : tr('{n} urgent jobs open.', { n: s.openByPriority.urgent }), action: { label: tr('Show them'), run: () => { setOpenChip('urgent'); pickTab('open'); } } });
  if (s.unassigned) insights.push({ tone: 'warn', icon: 'people', text: s.unassigned === 1 ? tr('1 open job is not given to anyone yet.') : tr('{n} open jobs are not given to anyone yet.', { n: s.unassigned }), action: { label: tr('Show them'), run: () => { setOpenChip('nobody'); pickTab('open'); } } });
  if (s.routinesLate) insights.push({ tone: 'warn', icon: 'calendar', text: s.routinesLate === 1 ? tr('1 routine is past its next day.') : tr('{n} routines are past their next day.', { n: s.routinesLate }), action: { label: tr('Routine jobs'), run: () => pickTab('routines') } });
  if (can.manage && s.toAudit) insights.push({ tone: 'info', icon: 'receipt', text: s.toAudit === 1 ? tr('1 done job not yet checked for billing.') : tr('{n} done jobs not yet checked for billing.', { n: s.toAudit }), action: { label: tr('Billing'), run: () => { setBillOnly(true); pickTab('billing'); } } });
  const oldest = open.slice().sort((a, b) => b.daysOpen - a.daysOpen)[0];
  if (oldest && oldest.daysOpen >= 14) insights.push({ tone: 'info', icon: 'clock', text: tr('The oldest open job, {ref} at {place}, has waited {n} days.', { ref: oldest.ref, place: oldest.location || '—', n: oldest.daysOpen }), action: { label: tr('Open it'), run: () => setOpenId(oldest.id) } });

  // Open jobs, as the sheet's Incomplete tab: by the day asked, then by place.
  const openShown = open.filter((o) => openChip === 'all' || (openChip === 'late' && o.overdue) || (openChip === 'nobody' && !o.assignedTo) || (openChip === 'urgent' && (o.priority === 'urgent' || o.priority === 'high')) || o.status === openChip)
    .sort((a, b) => a.requestedOn.localeCompare(b.requestedOn) || a.location.localeCompare(b.location));
  const byDay = [];
  openShown.forEach((o) => { const last = byDay[byDay.length - 1]; if (last && last.day === o.requestedOn) last.rows.push(o); else byDay.push({ day: o.requestedOn, rows: [o] }); });

  // The last 7 days, as the sheet's Last 7 tab: by place.
  const weekPlaces = {};
  lastWeek.forEach((o) => { (weekPlaces[o.location || '—'] = weekPlaces[o.location || '—'] || []).push(o); });
  const weekKeys = Object.keys(weekPlaces).sort((a, b) => a.localeCompare(b));
  function copyWeek() {
    const text = tr('Done in the last 7 days') + ' (' + fmtDate(weekAgo) + ' – ' + fmtDate(today) + ')\n' + weekKeys.map((p) => '\n' + p + '\n' + weekPlaces[p].map((o) => '• ' + o.description + (o.assignedTo ? ' — ' + o.assignedTo.name : '')).join('\n')).join('\n');
    navigator.clipboard.writeText(text).then(() => say(tr('Copied: paste it in WhatsApp or an email.'))).catch(() => setError(tr('Could not copy here: select the list and copy it by hand.')));
  }

  // Every job, as the sheet's WO Data tab.
  const all = orders.filter((o) => (!fStatus || (fStatus === 'open' ? o.open : o.status === fStatus)) && (!fKind || o.category === fKind) && (!fPlace || o.location === fPlace)
    && (!fWho || whoName(o.assignedTo) === fWho) && (!q || matchesQuery(q, o.ref, o.description, o.location, whoName(o.assignedTo), whoName(o.requestedBy), o.notes)));

  // Billing: done jobs by the month they were done, newest first.
  const billRows = done.filter((o) => !billOnly || !o.audited).sort((a, b) => b.completedOn.localeCompare(a.completedOn) || b.ref.localeCompare(a.ref));
  const months = [];
  billRows.forEach((o) => { const m = o.completedOn.slice(0, 7); const last = months[months.length - 1]; if (last && last.m === m) last.rows.push(o); else months.push({ m, rows: [o] }); });

  const row = (o, cols) => (
    <tr key={o.id} className={'mw-row' + (o.overdue ? ' is-late' : '')} onClick={() => setOpenId(o.id)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setOpenId(o.id); }}>
      {cols(o)}
    </tr>
  );

  return (
    <div className="dk wo mw">
      {error && <div className="error-banner" role="alert">{error}</div>}
      {notice && <div className="mw-toast" role="status">✅ {notice}</div>}

      <WoBanner
        eyebrow={new Date().toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        title={tr('Maintenance & IT')}
        sub={can.seeAll
          ? tr('Every job around our places — IT, electrical, plumbing, A/C and the rest: who asked, who is on it, what is late, and the routines that come round. Press a number to see those jobs.')
          : tr('The jobs you asked for and the ones given to you. Ask for a job when something needs fixing: the maintenance team plans it and you hear when it is done.')}
        actions={<>
          <button type="button" className="btn btn-primary" onClick={() => setForm({})}>{can.manage ? tr('+ New job') : tr('+ Ask for a job')}</button>
          {can.manage && <button type="button" className="btn btn-secondary" onClick={() => setRoutineForm({})}>{tr('+ New routine')}</button>}
          {can.manage && <button type="button" className="btn btn-secondary" onClick={() => setImporting(true)}>{tr('Import from the sheet')}</button>}
          <button type="button" className="btn btn-secondary wo-present-btn" onClick={() => setPresenting(true)} title={tr('This week’s jobs done, still open and coming up, as slides for the Saturday meeting')}>
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" /></svg>
            {tr('Saturday review')}
          </button>
        </>}
        tiles={tiles} />

      <nav className="mw-tabs" aria-label={tr('Maintenance views')}>
        {TABS.map(([k, label]) => {
          const n = k === 'open' ? s.open : k === 'week' ? lastWeek.length : k === 'all' ? orders.length : k === 'routines' ? s.routinesLate + s.routinesDueWeek : k === 'billing' && can.manage ? s.toAudit : 0;
          return (
            <button key={k} type="button" className={'mw-tab' + (tab === k ? ' is-on' : '')} aria-current={tab === k ? 'page' : undefined} onClick={() => pickTab(k)}>
              {label()}{n > 0 && <span className={'mw-tab-n' + ((k === 'routines' && s.routinesLate) || (k === 'open' && s.overdue) ? ' is-late' : '')}>{n}</span>}
            </button>
          );
        })}
      </nav>

      {tab === 'dash' && (
        <>
          <nav className="mw-flow" aria-label={tr('Jobs by status')}>
            {FLOW.map((st, i) => (
              <Fragment key={st}>
                <button type="button" className={'mw-flow-node is-' + st + (s.byStatus[st] ? '' : ' is-zero')} onClick={() => showAll({ status: st })}>
                  <span className="mw-flow-n">{s.byStatus[st] || 0}</span>
                  <span className="mw-flow-label">{statusName(st)}</span>
                </button>
                {i < FLOW.length - 1 && <span className="mw-flow-arrow" aria-hidden="true">→</span>}
              </Fragment>
            ))}
          </nav>
          <Insights items={insights} />
          <div className="mw-grid">
            <Section card title={tr('Open jobs by priority')} sub={tr('How urgent the open jobs are.')}>
              <ul className="mw-prio-list">
                {PRIORITIES.slice().reverse().map((p) => {
                  const n = s.openByPriority[p] || 0;
                  return (
                    <li key={p} className={'is-' + p}>
                      <PriorityPill priority={p} />
                      <span className="mw-bar-track" aria-hidden="true"><span className="mw-bar-open" style={{ width: (n / Math.max(1, s.open) * 100) + '%' }} /></span>
                      <strong>{n}</strong>
                    </li>
                  );
                })}
              </ul>
            </Section>
            <Section card title={tr('Kinds of job')} sub={tr('Every job by its kind; the darker part is still open. Press one to see its jobs.')}>
              <Bars rows={s.byCategory} label={(r) => kindName(r.key)} icon={(r) => kindIcon(r.key)} total={(r) => r.total} open={(r) => r.open} onPick={(r) => showAll({ kind: r.key })} />
            </Section>
            <Section card title={tr('Places')} sub={tr('Where the jobs are. Press a place to see its jobs.')}>
              <Bars rows={s.byLocation.slice(0, 10)} label={(r) => r.location} total={(r) => r.total} open={(r) => r.open} onPick={(r) => showAll({ place: r.location })} />
            </Section>
            <Section card title={tr('Who does them')} sub={tr('Open jobs, late ones, and jobs done in the last 30 days.')}>
              {s.byPerson.length ? (
                <ul className="mw-people">
                  {s.byPerson.slice(0, 8).map((p) => (
                    <li key={p.id || p.name}>
                      <button type="button" onClick={() => showAll({ who: p.name, status: 'open' })}>
                        <Person p={p} size={30} />
                        <span className="mw-people-n"><strong>{p.open}</strong><small>{tr('to do')}</small></span>
                        <span className={'mw-people-n' + (p.late ? ' is-late' : '')}><strong>{p.late}</strong><small>{tr('overdue')}</small></span>
                        <span className="mw-people-n"><strong>{p.doneLast30}</strong><small>{tr('done, 30 days')}</small></span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : <p className="dk-muted">{tr('No jobs given to anyone yet.')}</p>}
            </Section>
          </div>
        </>
      )}

      {tab === 'open' && (
        <Section title={tr('Jobs to do')} sub={tr('Everything not done yet, oldest request first, as the sheet’s Incomplete tab. Press a job to move it along.')}
          action={<div className="wo-seg" role="radiogroup" aria-label={tr('Show')}>
            {[['all', tr('All')], ['late', tr('Overdue')], ['urgent', tr('Urgent and high')], ['nobody', tr('Not given to anyone')], ['new', statusName('new')], ['scheduled', statusName('scheduled')], ['in_progress', statusName('in_progress')], ['on_hold', statusName('on_hold')]].map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={openChip === k} className={openChip === k ? 'is-on' : ''} onClick={() => setOpenChip(k)}>{label}</button>
            ))}
          </div>}>
          {!openShown.length ? <p className="mw-empty">🎉 {tr('Nothing here: every job like this is done.')}</p> : (
            <div className="mw-table-wrap">
              <table className="mw-table">
                <thead><tr><th>{tr('Asked on')}</th><th>{tr('Place')}</th><th>{tr('Description')}</th><th>{tr('Given to')}</th><th className="is-num">{tr('Days open')}</th><th>{tr('Status')}</th><th>{tr('Scheduled')}</th><th>{tr('Notes')}</th></tr></thead>
                <tbody>
                  {byDay.map((g) => g.rows.map((o, i) => row(o, (x) => <>
                    <td className="mw-day">{i === 0 ? fmtDate(g.day) : ''}</td>
                    <td>{x.location || '—'}</td>
                    <td className="mw-desc"><span className="mw-ref">{x.ref}</span> {x.description} {x.priority === 'urgent' || x.priority === 'high' ? <PriorityPill priority={x.priority} /> : null}</td>
                    <td><Person p={x.assignedTo} /></td>
                    <td className={'is-num' + (x.daysOpen >= 14 ? ' is-old' : '')}>{x.daysOpen}</td>
                    <td><StatusPill status={x.status} /></td>
                    <td className={x.overdue ? 'is-late' : ''}>{x.scheduledOn ? fmtDate(x.scheduledOn) : '—'}</td>
                    <td className="mw-notes">{x.notes}</td>
                  </>)))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}

      {tab === 'week' && (
        <Section title={tr('Done in the last 7 days')} sub={tr('{from} to {to}, by place, as the sheet’s Last 7 tab: ready for the weekly review.', { from: fmtDate(weekAgo), to: fmtDate(today) })}
          action={lastWeek.length > 0 && <button type="button" className="btn btn-secondary" onClick={copyWeek}>📋 {tr('Copy as text')}</button>}>
          {!lastWeek.length ? <p className="mw-empty">{tr('No jobs done in the last 7 days.')}</p> : (
            <div className="mw-week">
              {weekKeys.map((p) => (
                <article key={p} className="mw-week-place">
                  <h4>📍 {p} <small>{weekPlaces[p].length}</small></h4>
                  <ul>
                    {weekPlaces[p].map((o) => (
                      <li key={o.id}><button type="button" onClick={() => setOpenId(o.id)}>
                        <span className="mw-week-tick" aria-hidden="true">✓</span>
                        <span><strong>{o.description}</strong><small>{kindIcon(o.category)} {kindName(o.category)} · {o.assignedTo ? o.assignedTo.name : tr('Nobody yet')} · {fmtDate(o.completedOn)}</small></span>
                      </button></li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          )}
        </Section>
      )}

      {tab === 'all' && (
        <Section title={tr('Every job')} sub={tr('Every job, newest request first, with the sheet’s columns. Press a job to open it.')}
          action={<button type="button" className="btn btn-secondary" onClick={() => downloadCsv(all, 'maintenance-work-orders')}>⬇ {tr('Download CSV')}</button>}>
          <div className="mw-filters">
            <SearchInput value={q} onChange={(v) => { setQ(v); setShown(PAGE); }} placeholder={tr('Search jobs, places, people…')} />
            <select className="input" value={fStatus} onChange={(e) => { setFStatus(e.target.value); setShown(PAGE); }} aria-label={tr('Status')}>
              <option value="">{tr('Every status')}</option><option value="open">{tr('Open (not done)')}</option>
              {STATUSES.map((st) => <option key={st} value={st}>{statusName(st)}</option>)}
            </select>
            <select className="input" value={fKind} onChange={(e) => { setFKind(e.target.value); setShown(PAGE); }} aria-label={tr('Kind of job')}>
              <option value="">{tr('Every kind')}</option>{KINDS.map((k) => <option key={k} value={k}>{kindIcon(k)} {kindName(k)}</option>)}
            </select>
            <select className="input" value={fPlace} onChange={(e) => { setFPlace(e.target.value); setShown(PAGE); }} aria-label={tr('Place')}>
              <option value="">{tr('Every place')}</option>{places.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <select className="input" value={fWho} onChange={(e) => { setFWho(e.target.value); setShown(PAGE); }} aria-label={tr('Given to')}>
              <option value="">{tr('Everyone')}</option>{people.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <p className="dk-muted wo-small">{tr('{n} of {total} jobs', { n: all.length, total: orders.length })}</p>
          {!all.length ? <p className="mw-empty">{tr('No jobs match.')}</p> : (
            <div className="mw-table-wrap">
              <table className="mw-table is-wide">
                <thead><tr><th>{tr('WO')}</th><th>{tr('Asked on')}</th><th>{tr('Asked by')}</th><th>{tr('Place')}</th><th>{tr('Kind')}</th><th>{tr('Description')}</th><th>{tr('Priority')}</th><th>{tr('Status')}</th><th>{tr('Given to')}</th><th>{tr('Scheduled')}</th><th>{tr('Completed')}</th><th className="is-num">{tr('Days')}</th><th className="is-num">{tr('Cost')}</th><th className="is-num">{tr('Days open')}</th></tr></thead>
                <tbody>
                  {all.slice(0, shown).map((o) => row(o, (x) => <>
                    <td className="mw-ref">{x.ref}</td>
                    <td>{fmtDate(x.requestedOn)}</td>
                    <td>{whoName(x.requestedBy)}</td>
                    <td>{x.location}</td>
                    <td title={kindName(x.category)}>{kindIcon(x.category)}</td>
                    <td className="mw-desc">{x.description}</td>
                    <td><PriorityPill priority={x.priority} /></td>
                    <td><StatusPill status={x.status} /></td>
                    <td>{whoName(x.assignedTo)}</td>
                    <td className={x.overdue ? 'is-late' : ''}>{x.scheduledOn ? fmtDate(x.scheduledOn) : ''}</td>
                    <td>{x.completedOn ? fmtDate(x.completedOn) : ''}</td>
                    <td className="is-num">{x.daysTaken === null ? '' : x.daysTaken}</td>
                    <td className="is-num">{x.actualCost !== null ? money(x.actualCost, x.currency) : x.estimatedCost !== null ? <span className="dk-muted">~{money(x.estimatedCost, x.currency)}</span> : ''}</td>
                    <td className="is-num">{x.daysOpen === null ? '' : x.daysOpen}</td>
                  </>))}
                </tbody>
              </table>
            </div>
          )}
          {all.length > shown && <button type="button" className="btn btn-secondary mw-more" onClick={() => setShown(shown + PAGE)}>{tr('Show {n} more', { n: Math.min(PAGE, all.length - shown) })}</button>}
        </Section>
      )}

      {tab === 'routines' && (
        <Section title={tr('Routine jobs')} sub={tr('Jobs that come round every so many days, the next one first. Mark one done and its next day moves on; or make it a work order to plan and give out.')}
          action={can.manage && <button type="button" className="btn btn-primary" onClick={() => setRoutineForm({})}>{tr('+ New routine')}</button>}>
          {!routines.length ? <p className="mw-empty">{tr('No routines yet.')}</p> : (
            <div className="mw-routines">
              {routines.map((r) => {
                const mine = r.assignedTo && r.assignedTo.id === myId;
                return (
                  <article key={r.id} className={'mw-rt' + (r.late ? ' is-late' : r.dueIn !== null && r.dueIn <= 7 ? ' is-soon' : '')}>
                    <div className="mw-rt-when">
                      <strong>{r.nextOn ? fmtDate(r.nextOn) : '—'}</strong>
                      <small>{dueWords(r)}</small>
                    </div>
                    <div className="mw-rt-main">
                      <h4><span className="mw-ref">{r.ref}</span> {kindIcon(r.category)} {r.name}</h4>
                      {r.description && <p>{r.description}</p>}
                      <p className="mw-rt-meta">
                        {r.location && <span>📍 {r.location}</span>}
                        {r.assignedTo && <span>👤 {r.assignedTo.name}</span>}
                        <span>🔁 {r.everyDays ? tr('every {n} days', { n: r.everyDays }) : tr('not repeating yet')}</span>
                        {r.scheduleNote && <span>🕘 {r.scheduleNote}</span>}
                        <span>{r.lastDoneOn ? tr('last done {date}', { date: fmtDate(r.lastDoneOn) }) : tr('never done yet')}</span>
                      </p>
                      {r.notes && <p className="dk-muted wo-small">{r.notes}</p>}
                      {r.link && <a className="wo-small" href={r.link} target="_blank" rel="noreferrer">🔗 {tr('Web link')}</a>}
                    </div>
                    <div className="mw-rt-acts">
                      {(can.manage || mine) && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => routineDone(r)}>✓ {tr('Done today')}</button>}
                      {can.manage && (r.openOrderId
                        ? <button type="button" className="btn btn-secondary" onClick={() => setOpenId(r.openOrderId)}>{tr('Its work order')}</button>
                        : <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => routineOrder(r)}>{tr('Make a work order')}</button>)}
                      {can.manage && <button type="button" className="pos-link" onClick={() => setRoutineForm({ routine: r })}>{tr('Edit')}</button>}
                      {can.manage && <button type="button" className="pos-link" onClick={() => routineArchive(r, true)}>{tr('Put it away')}</button>}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
          {putAway.length > 0 && (
            <details className="mw-away">
              <summary>{tr('{n} routines put away', { n: putAway.length })}</summary>
              <ul>{putAway.map((r) => <li key={r.id}><span>{r.ref} {r.name}{r.description ? ' — ' + r.description : ''}</span>{can.manage && <button type="button" className="pos-link" onClick={() => routineArchive(r, false)}>{tr('Bring back')}</button>}</li>)}</ul>
            </details>
          )}
        </Section>
      )}

      {tab === 'billing' && (
        <Section title={tr('Billing')} sub={tr('Done jobs by the month they were done, with what each cost. Tick a job once it has been checked, as the sheet’s Audit column.')}
          action={<div className="mw-bill-acts">
            <label className="mw-check"><input type="checkbox" checked={billOnly} onChange={(e) => setBillOnly(e.target.checked)} /> {tr('Only not checked yet')}</label>
            <button type="button" className="btn btn-secondary" onClick={() => downloadCsv(billRows, 'maintenance-billing')}>⬇ {tr('Download CSV')}</button>
          </div>}>
          {!months.length ? <p className="mw-empty">{billOnly ? tr('Every done job is checked.') : tr('No done jobs yet.')}</p> : months.map((m) => {
            const cost = {};
            m.rows.forEach((o) => { if (o.actualCost !== null) cost[o.currency] = (cost[o.currency] || 0) + o.actualCost; });
            const left = m.rows.filter((o) => !o.audited).length;
            return (
              <div key={m.m} className="mw-month">
                <h4>{monthOf(m.m)} <small>{tr('{n} jobs', { n: m.rows.length })} · {moneyMap(cost)}{left ? ' · ' + tr('{n} to check', { n: left }) : ' · ✓'}</small></h4>
                <div className="mw-table-wrap">
                  <table className="mw-table">
                    <thead><tr><th>{tr('Completed')}</th><th>{tr('Place')}</th><th>{tr('Description')}</th><th>{tr('Kind')}</th><th>{tr('Done by')}</th><th className="is-num">{tr('Days taken')}</th><th className="is-num">{tr('Actual cost')}</th><th>{tr('Checked')}</th></tr></thead>
                    <tbody>
                      {m.rows.map((o) => (
                        <tr key={o.id} className="mw-row">
                          <td onClick={() => setOpenId(o.id)}>{fmtDate(o.completedOn)}</td>
                          <td onClick={() => setOpenId(o.id)}>{o.location}</td>
                          <td className="mw-desc" onClick={() => setOpenId(o.id)}>{o.description}</td>
                          <td onClick={() => setOpenId(o.id)}>{kindIcon(o.category)} {kindName(o.category)}</td>
                          <td onClick={() => setOpenId(o.id)}>{whoName(o.assignedTo)}</td>
                          <td className="is-num" onClick={() => setOpenId(o.id)}>{o.daysTaken === null ? '' : o.daysTaken}</td>
                          <td className="is-num" onClick={() => setOpenId(o.id)}>{o.actualCost !== null ? money(o.actualCost, o.currency) : ''}</td>
                          <td>{can.manage
                            ? <input type="checkbox" className="mw-audit" checked={o.audited} disabled={busy} onChange={(e) => audit(o, e.target.checked)} aria-label={tr('Checked for billing: {ref}', { ref: o.ref })} />
                            : o.audited ? '✓' : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </Section>
      )}

      {presenting && <MaintenancePresent orders={orders} routines={data.routines} today={today} scopeName={can.seeAll ? tr('All places') : tr('My jobs')}
        onClose={() => setPresenting(false)} onOpen={(o) => setOpenId(o.id)} paused={!!job || !!form || !!routineForm || importing} />}
      {job && <JobPanel key={job.id + job.status} job={job} can={can} myId={myId} busy={busy} onAct={moveJob} onDelete={deleteJob} onEdit={(j) => { setOpenId(null); setForm({ job: j }); }} onClose={() => setOpenId(null)} />}
      {form && <JobForm job={form.job} can={can} employees={employees} places={places} busy={busy} onSave={saveJob} onClose={() => setForm(null)} />}
      {routineForm && <RoutineForm routine={routineForm.routine} employees={employees} places={places} busy={busy} onSave={saveRoutine} onClose={() => setRoutineForm(null)} />}
      {importing && <ImportSheet employees={employees} onClose={() => setImporting(false)} onDone={(r) => { setImporting(false); load(); say(tr('Imported: {a} jobs added, {u} brought up to date, {r} routines added.', { a: r.orders.added, u: r.orders.updated, r: r.routines.added })); }} />}
    </div>
  );
}
