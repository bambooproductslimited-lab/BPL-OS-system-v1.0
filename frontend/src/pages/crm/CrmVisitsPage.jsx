import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import { Empty, Glossary, Hero, Icon, Section, Status, fmtDate } from '../../components/DashKit';
import { tr } from '../../lib/i18n.jsx';
import { Toast, VisitDialog, daysUntil, todayISO, useCrmBasics, usePerms, visitLabel } from './crmShared';
import '../EmployeesPage.css';
import '../ToolRoomPage.css';
import './CrmPage.css';

// Visits to a client's site to measure or assess a job — the sheet's Site
// Visits tab — with who went and what they found. A visit tied to a lead
// shows in the lead's history too.

export default function CrmVisitsPage() {
  const { canManage } = usePerms();
  const { people } = useCrmBasics();
  const [visits, setVisits] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);
  const [toast, setToast] = useState(null);
  const [show, setShow] = useState('upcoming');

  const load = useCallback(async () => {
    try { setVisits(await api.get('/crm/visits')); setError(null); } catch (err) { setError(err.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const today = todayISO();
  const groups = useMemo(() => {
    if (!visits) return null;
    const upcoming = visits.filter((v) => v.status === 'scheduled' && v.scheduledOn >= today).sort((a, b) => (a.scheduledOn < b.scheduledOn ? -1 : 1));
    const missed = visits.filter((v) => v.status === 'scheduled' && v.scheduledOn < today);
    const done = visits.filter((v) => v.status !== 'scheduled');
    return { upcoming, missed, done };
  }, [visits, today]);

  if (!visits) return <div className="dk">{error ? <div className="error-banner">{error}</div> : <div className="eyebrow">{tr('Loading…')}</div>}</div>;

  const monthStart = today.slice(0, 8) + '01';
  const thisMonth = visits.filter((v) => v.scheduledOn >= monthStart && v.scheduledOn <= today.slice(0, 8) + '31');
  const visited = visits.filter((v) => v.status === 'visited');
  const list = show === 'upcoming' ? groups.upcoming : show === 'missed' ? groups.missed : groups.done;

  const who = (v) => v.assessors.map((a) => a.name).concat(v.assessorsText ? [v.assessorsText] : []).join(', ');

  return (
    <div className="dk crm">
      {error && <div className="error-banner" role="alert">{error}</div>}
      <Hero eyebrow={tr('Sales & CRM')} title={tr('Site visits')}
        sub={tr('Going to a client\'s site to measure or assess a job before quoting: when, who goes, and what they found.')}
        actions={canManage && <button type="button" className="btn btn-primary" onClick={() => setEditing({})}>{tr('Book a site visit')}</button>}
        stats={[
          { icon: 'calendar', value: String(groups.upcoming.length), label: tr('booked ahead'), note: groups.upcoming[0] ? tr('next: {client}, {date}', { client: groups.upcoming[0].client, date: fmtDate(groups.upcoming[0].scheduledOn) }) : tr('nothing booked'), onClick: () => setShow('upcoming') },
          { icon: 'warn', value: String(groups.missed.length), label: tr('past, not marked'), note: tr('say whether they happened'), tone: groups.missed.length ? 'alert' : '', onClick: () => setShow('missed') },
          { icon: 'check', value: tr('{done} of {n}', { done: thisMonth.filter((v) => v.status === 'visited').length, n: thisMonth.length }), label: tr('done this month'), note: tr('{n} cancelled', { n: thisMonth.filter((v) => v.status === 'cancelled').length }) },
          { icon: 'people', value: String(visited.length), label: tr('visits made in all'), note: tr('{n} booked in all', { n: visits.length }), onClick: () => setShow('done') }
        ]} />

      <Section title={show === 'upcoming' ? tr('Booked ahead') : show === 'missed' ? tr('Past, not marked') : tr('Done or cancelled')}
        sub={show === 'missed' ? tr('These dates have passed. Open each one and mark it visited (with what was found) or cancelled.') : show === 'upcoming' ? tr('Soonest first.') : tr('Latest first.')}
        action={
          <div className="dk-segment" role="radiogroup" aria-label={tr('Show')}>
            {[['upcoming', tr('Booked'), groups.upcoming.length], ['missed', tr('Not marked'), groups.missed.length], ['done', tr('Done'), groups.done.length]].map(([k, label, n]) => (
              <button key={k} type="button" role="radio" aria-checked={show === k} className={show === k ? 'is-on' : ''} onClick={() => setShow(k)}>{label} ({n})</button>
            ))}
          </div>
        }>
        {list.length ? (
          <ul className="dk-rows">
            {list.map((v) => {
              const d = daysUntil(v.scheduledOn);
              return (
                <li key={v.id} className="dk-row crm-row-btn">
                  <button type="button" onClick={() => setEditing(v)}>
                    <span className={'dk-lead-icon ' + (v.status === 'visited' ? 'is-good' : v.status === 'cancelled' ? '' : d < 0 ? 'is-bad' : 'is-info')}><Icon name={v.status === 'visited' ? 'check' : 'calendar'} /></span>
                    <div className="dk-row-main">
                      <div className="dk-row-title">{v.client}{v.leadRef ? <span className="dk-muted"> · {v.leadRef}</span> : null}</div>
                      <div className="dk-muted dk-row-meta">{[v.location, who(v) ? tr('with {names}', { names: who(v) }) : tr('nobody assigned yet')].filter(Boolean).join(' · ')}</div>
                      {v.findings && <div className="dk-muted dk-row-meta">{v.findings}</div>}
                    </div>
                    <div className="dk-row-side">
                      <div className="dk-row-amount">{fmtDate(v.scheduledOn)}</div>
                      <div className="dk-row-note"><Status tone={v.status === 'visited' ? 'good' : v.status === 'cancelled' ? 'muted' : d < 0 ? 'bad' : 'info'}>{v.status === 'scheduled' && d === 0 ? tr('Today') : visitLabel(v.status)}</Status></div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : <Empty icon="calendar">{show === 'upcoming' ? tr('No visit booked. Book one from here or from the lead.') : show === 'missed' ? tr('Every past visit is marked.') : tr('No visit made yet.')}</Empty>}
      </Section>

      <Glossary items={[
        [tr('Booked'), tr('A visit agreed with the client for a date.')],
        [tr('Visited'), tr('It happened. Write what was found so whoever quotes has the measurements.')],
        [tr('Past, not marked'), tr('The date has passed but nobody said whether the visit happened.')]
      ]} />

      {editing && <VisitDialog visit={editing} people={people} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setToast(tr('Site visit saved.')); load(); }} onDeleted={() => { setEditing(null); setToast(tr('Site visit deleted.')); load(); }} />}
      <Toast text={toast} onDone={() => setToast(null)} />
    </div>
  );
}
