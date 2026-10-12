import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Section } from '../../components/DashKit';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';
import { Ring } from '../crm/crmFun';
import {
  EVENT_KINDS, EVENT_STATUS, Glyph, L, Meter, MkBanner, MkCompanies, MkDialog, MkEmpty, Pill, SPEND, cedis, dateRange, dayLabel, readParam, short, todayIso, useMkCompany, whole
} from './mkKit';

// Events (backend mkEvents.service.js): trade fairs, exhibitions, launches,
// showroom days, tastings, sponsorships. Coming up, each shows how many days
// are left and how much of its checklist is done (a standard checklist for
// its kind, dated from the event, is there from the start); once it is
// over, what it brought: visitors, leads, sales on the day and what each
// lead cost.

const EMPTY = { name: '', kind: 'trade_fair', startsOn: '', endsOn: '', venue: '', budget: '', campaignId: '', status: 'planned', targetLeads: '', checklist: true };

export default function MkEventsPage() {
  const { can } = useAuth();
  const mk = useMkCompany();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [openId, setOpenId] = useState(() => readParam('open'));
  const [campaigns, setCampaigns] = useState([]);
  const [toast, setToast] = useState(null);
  const load = useCallback(() => { if (mk.company) api.get('/mk/events?company=' + mk.company).then(setD).catch((e) => setError(e.message)); }, [mk.company]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (mk.company) api.get('/mk/campaigns/options?company=' + mk.company).then(setCampaigns).catch(() => setCampaigns([])); }, [mk.company]);
  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(null), 3500); return () => clearTimeout(t); }, [toast]);
  function open(id) { setOpenId(id); window.history.replaceState({}, '', '/mkevents?open=' + id); }
  function close() { setOpenId(null); window.history.replaceState({}, '', '/mkevents'); }

  if (error) return <div className="dk mk"><MkCompanies mk={mk} /><div className="error-banner">{error}</div></div>;
  if (!d) return <div className="dk mk"><MkCompanies mk={mk} /><p className="eyebrow">{tr('Loading…')}</p></div>;
  const coming = d.events.filter((e) => e.when === 'upcoming' || e.when === 'now').sort((a, b) => (a.startsOn < b.startsOn ? -1 : 1));
  const past = d.events.filter((e) => e.when === 'past');
  const t = d.totals;
  const canManage = can('marketing.manage');

  return (
    <div className="dk mk">
      <MkCompanies mk={mk} />
      <MkBanner art="flag" eyebrow={tr('Marketing · Events')} title={tr('Events')}
        sub={tr('Fairs, exhibitions, launches, showroom days and tastings: each with its checklist from the start, its budget and spend, and what it brought in once it is over.')}
        actions={canManage && <button type="button" className="mk-btn is-primary" onClick={() => setForm({ ...EMPTY })}><Glyph name="plus" size={16} />{tr('Plan an event')}</button>}
        stats={[
          { glyph: 'calendar', value: String(t.upcoming), label: tr('coming up') },
          { glyph: 'users', value: whole(t.visitors), label: tr('visitors this year') },
          { glyph: 'magnet', value: whole(t.leads), label: tr('leads captured this year'), note: t.leads && t.spent ? tr('{amount} a lead', { amount: cedis(t.spent / t.leads) }) : null },
          { glyph: 'cash', value: short(t.sales), label: tr('sold at events this year'), note: tr('{amount} spent', { amount: short(t.spent) }) }
        ]} />

      <Section title={tr('Coming up')} sub={tr('Soonest first. The ring is how much of the checklist is done; red means something on it is late.')}>
        {coming.length ? <div className="mk-grid">{coming.map((e) => <EventCard key={e.id} e={e} onOpen={() => open(e.id)} />)}</div>
          : <MkEmpty glyph="flag" title={tr('Nothing planned')} action={canManage && <button type="button" className="mk-btn is-primary" onClick={() => setForm({ ...EMPTY })}>{tr('Plan an event')}</button>}>{tr('Plan the next fair, launch or showroom day here: it starts with a checklist dated back from the day.')}</MkEmpty>}
      </Section>
      {past.length > 0 && (
        <Section title={tr('How past events went')} sub={tr('Visitors, leads and sales on the day against what each cost.')}>
          <div className="mk-grid">{past.map((e) => <EventCard key={e.id} e={e} onOpen={() => open(e.id)} />)}</div>
        </Section>
      )}
      {form && <EventForm f={form} setF={setForm} company={mk.company} campaigns={campaigns} onSaved={(e) => { setForm(null); load(); open(e.id); setToast(tr('Event saved.')); }} />}
      {openId && <EventDetail id={openId} onClose={close} onEdit={(e) => setForm({ id: e.id, name: e.name, kind: e.kind, startsOn: e.startsOn, endsOn: e.endsOn || '', venue: e.venue, budget: e.budget || '', campaignId: e.campaign ? e.campaign.id : '', status: e.status, targetLeads: e.targetLeads ?? '', leadsCaptured: e.leadsCaptured, visitors: e.visitors, sales: e.sales, notes: e.notes, outcome: e.outcome })} onChanged={load} toast={setToast} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function EventCard({ e, onOpen }) {
  const d = new Date(e.startsOn + 'T00:00');
  const past = e.when === 'past';
  return (
    <button type="button" className="mk-card mk-event" onClick={onOpen}>
      <div className="mk-row">
        <span className="mk-datebox"><b>{d.getDate()}</b><small>{d.toLocaleDateString(activeIntlLocale(), { month: 'short' })}</small></span>
        <span className="mk-fill"><h3 className="mk-card-title">{e.name}</h3><span className="mk-card-sub">{L(EVENT_KINDS, e.kind)}{e.venue ? ' · ' + e.venue : ''}</span>
          <span className="mk-countdown">{e.when === 'now' ? tr('On now') : past ? dateRange(e.startsOn, e.endsOn) : e.daysTo === 1 ? tr('Tomorrow') : tr('In {n} days', { n: e.daysTo })}</span></span>
        {!past && e.tasks > 0 && (
          <Ring value={e.tasksDone} max={e.tasks} size={58} stroke={7} tone={e.tasksLate ? 'hot' : e.tasksDone === e.tasks ? 'good' : ''}>
            <strong style={{ fontSize: 13 }}>{e.tasksDone}/{e.tasks}</strong>
          </Ring>
        )}
      </div>
      {past ? (
        <div className="mk-camp-nums">
          <span className="mk-camp-num"><small>{tr('Visitors')}</small><strong>{whole(e.visitors)}</strong></span>
          <span className="mk-camp-num"><small>{tr('Leads')}</small><strong>{e.leadsCaptured}{e.targetLeads ? ' / ' + e.targetLeads : ''}</strong></span>
          <span className="mk-camp-num"><small>{tr('Each lead cost')}</small><strong>{e.costPerLead ? short(e.costPerLead) : '—'}</strong></span>
        </div>
      ) : (
        <>
          {e.budget > 0 && <Meter value={e.spent} max={e.budget} tone={e.spent > e.budget ? 'bad' : ''} label={tr('{spent} of {budget} budget', { spent: cedis(e.spent), budget: cedis(e.budget) })} />}
          <span className="mk-row">{e.tasksLate > 0 && <Pill tone="bad" glyph="clock">{e.tasksLate === 1 ? tr('1 task late') : tr('{n} tasks late', { n: e.tasksLate })}</Pill>}<Pill tone={e.status === 'confirmed' ? 'good' : 'info'}>{L(EVENT_STATUS, e.status)}</Pill></span>
        </>
      )}
    </button>
  );
}

function EventForm({ f, setF, company, campaigns, onSaved }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function save(e) {
    e.preventDefault();
    setSaving(true); setError(null);
    try { onSaved(f.id ? await api.put('/mk/events/' + f.id, { ...f, company }) : await api.post('/mk/events', { ...f, company })); }
    catch (err) { setError(err.message); setSaving(false); }
  }
  return (
    <MkDialog wide title={f.id ? tr('Edit the event') : tr('Plan an event')} sub={f.id ? null : tr('A checklist for its kind is added, dated back from the day; change it as you go.')} onClose={() => !saving && setF(null)}
      footer={<><button type="button" className="mk-btn is-ghost" onClick={() => setF(null)} disabled={saving}>{tr('Cancel')}</button><button type="submit" form="mk-event" className="mk-btn is-primary" disabled={saving}>{saving ? tr('Saving…') : tr('Save')}</button></>}>
      <form id="mk-event" className="mk-form" onSubmit={save}>
        <label className="field is-span"><span>{tr('Name')}</span><input className="input" required maxLength={160} value={f.name} onChange={set('name')} placeholder={tr('e.g. Accra Home & Garden Expo')} /></label>
        <label className="field"><span>{tr('Kind')}</span><select className="input" value={f.kind} onChange={set('kind')}>{Object.keys(EVENT_KINDS).map((k) => <option key={k} value={k}>{L(EVENT_KINDS, k)}</option>)}</select></label>
        <label className="field"><span>{tr('Where')}</span><input className="input" maxLength={200} value={f.venue} onChange={set('venue')} /></label>
        <label className="field"><span>{tr('Starts')}</span><input className="input" required type="date" value={f.startsOn} onChange={set('startsOn')} /></label>
        <label className="field"><span>{tr('Ends')}</span><input className="input" type="date" value={f.endsOn} onChange={set('endsOn')} /></label>
        <label className="field"><span>{tr('Budget (GHS)')}</span><input className="input" type="number" min="0" step="any" value={f.budget} onChange={set('budget')} /></label>
        <label className="field"><span>{tr('Leads to collect')}</span><input className="input" type="number" min="0" step="1" value={f.targetLeads} onChange={set('targetLeads')} /></label>
        <label className="field"><span>{tr('Campaign')}</span><select className="input" value={f.campaignId} onChange={set('campaignId')}><option value="">{tr('No campaign')}</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="field"><span>{tr('Status')}</span><select className="input" value={f.status} onChange={set('status')}>{Object.keys(EVENT_STATUS).map((k) => <option key={k} value={k}>{L(EVENT_STATUS, k)}</option>)}</select></label>
        {f.id && <>
          <div className="mk-step"><b>✓</b>{tr('How it went')}</div>
          <label className="field"><span>{tr('Visitors')}</span><input className="input" type="number" min="0" step="1" value={f.visitors} onChange={set('visitors')} /></label>
          <label className="field"><span>{tr('Leads captured')}</span><input className="input" type="number" min="0" step="1" value={f.leadsCaptured} onChange={set('leadsCaptured')} /></label>
          <label className="field"><span>{tr('Sold on the day (GHS)')}</span><input className="input" type="number" min="0" step="any" value={f.sales} onChange={set('sales')} /></label>
          <label className="field is-span"><span>{tr('What happened, what to do next time')}</span><textarea className="input" rows={3} value={f.outcome} onChange={set('outcome')} /></label>
        </>}
      </form>
      {error && <div className="error-banner">{error}</div>}
    </MkDialog>
  );
}

function EventDetail({ id, onClose, onEdit, onChanged, toast }) {
  const navigate = useNavigate();
  const [e, setE] = useState(null);
  const [error, setError] = useState(null);
  const [task, setTask] = useState({ title: '', dueOn: '' });
  const load = useCallback(() => api.get('/mk/events/' + id).then(setE).catch((x) => setError(x.message)), [id]);
  useEffect(() => { load(); }, [load]);
  async function act(fn) { try { setE(await fn()); onChanged(); } catch (x) { setError(x.message); } }
  async function remove() {
    if (!window.confirm(tr('Delete this event and its checklist?'))) return;
    try { await api.del('/mk/events/' + id); onChanged(); onClose(); toast(tr('Event deleted.')); } catch (x) { setError(x.message); }
  }
  if (!e) return <MkDialog wide title={tr('Event')} onClose={onClose}>{error ? <div className="error-banner">{error}</div> : <p className="mk-muted">{tr('Loading…')}</p>}</MkDialog>;
  const today = todayIso();
  return (
    <MkDialog wide title={e.name} sub={L(EVENT_KINDS, e.kind) + ' · ' + dateRange(e.startsOn, e.endsOn) + (e.venue ? ' · ' + e.venue : '')} onClose={onClose}>
      <div className="mk-row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <Pill tone={e.status === 'done' ? 'violet' : e.status === 'confirmed' ? 'good' : e.status === 'cancelled' ? 'muted' : 'info'}>{L(EVENT_STATUS, e.status)}</Pill>
        {e.when === 'upcoming' && <span className="mk-countdown" style={{ color: 'var(--mk-info)' }}>{e.daysTo === 1 ? tr('Tomorrow') : tr('In {n} days', { n: e.daysTo })}</span>}
        {e.campaign && <button type="button" className="mk-link" onClick={() => navigate('/mkcampaigns?open=' + e.campaign.id)}><Glyph name="target" size={14} />{e.campaign.name}</button>}
        <span style={{ flex: 1 }} />
        {e.canManage && <>
          <button type="button" className="mk-btn is-ghost is-small" onClick={() => onEdit(e)}>{e.when === 'past' ? tr('Record how it went') : tr('Edit')}</button>
          <button type="button" className="mk-btn is-danger is-small" onClick={remove}>{tr('Delete')}</button>
        </>}
      </div>
      {error && <div className="error-banner">{error}</div>}
      <div className="mk-facts">
        <span className={'mk-fact' + (e.budget && e.spent > e.budget ? ' is-bad' : '')}><small>{tr('Spent')}</small><strong>{cedis(e.spent)}</strong><em>{e.budget ? tr('of {budget} budget', { budget: cedis(e.budget) }) : tr('no budget set')}</em></span>
        <span className="mk-fact"><small>{tr('Visitors')}</small><strong>{whole(e.visitors)}</strong></span>
        <span className="mk-fact"><small>{tr('Leads')}</small><strong>{e.leadsCaptured}{e.targetLeads ? ' / ' + e.targetLeads : ''}</strong><em>{e.costPerLead ? tr('{amount} each', { amount: cedis(e.costPerLead) }) : ''}</em></span>
        <span className="mk-fact"><small>{tr('Sold on the day')}</small><strong>{cedis(e.sales)}</strong></span>
      </div>
      <div className="mk-two">
        <div className="mk-card">
          <h4 className="mk-h4"><Glyph name="check" size={16} />{tr('Checklist')} <span className="mk-muted">{e.tasksDone}/{e.tasks}</span></h4>
          <div className="mk-check">
            {e.checklist.map((t) => (
              <label key={t.id} className={(t.done ? 'is-done' : '') + (!t.done && t.dueOn && t.dueOn < today ? ' is-late' : '')}>
                <input type="checkbox" checked={t.done} disabled={!e.canManage} onChange={() => act(() => api.post('/mk/events/' + id + '/tasks/' + t.id, { done: !t.done }))} />
                <span className="mk-fill">{tr(t.title)}</span>
                <span className="mk-muted">{t.done ? t.doneBy || '' : t.dueOn ? dayLabel(t.dueOn) : ''}</span>
              </label>
            ))}
          </div>
          {e.canManage && (
            <form className="mk-row" onSubmit={(x) => { x.preventDefault(); if (!task.title.trim()) return; act(() => api.post('/mk/events/' + id + '/tasks', task)).then(() => setTask({ title: '', dueOn: '' })); }}>
              <input className="input mk-fill" value={task.title} onChange={(x) => setTask({ ...task, title: x.target.value })} placeholder={tr('Add something to do…')} aria-label={tr('Task')} />
              <input className="input" type="date" value={task.dueOn} onChange={(x) => setTask({ ...task, dueOn: x.target.value })} aria-label={tr('Due')} style={{ width: 'auto' }} />
              <button type="submit" className="mk-btn is-ghost is-small">{tr('Add')}</button>
            </form>
          )}
        </div>
        <div className="mk-card">
          <div className="mk-card-head"><h4 className="mk-h4"><Glyph name="wallet" size={16} />{tr('What it cost')}</h4><button type="button" className="mk-link" onClick={() => navigate('/mkbudget')}>{tr('Record a spend')}</button></div>
          {e.spend.length ? <ul className="mk-list">{e.spend.map((s) => (
            <li key={s.id} className="mk-li"><span className="mk-fill"><strong>{s.description}</strong><span className="mk-muted">{[L(SPEND, s.category), s.vendor, dayLabel(s.spentOn)].filter(Boolean).join(' · ')}</span></span><span className="mk-li-amount">{cedis(s.amount)}</span></li>
          ))}</ul> : <p className="mk-muted">{tr('Nothing spent yet. Record spend on Budget & spend and pick this event.')}</p>}
          {e.outcome && <><h4 className="mk-h4"><Glyph name="trophy" size={16} />{tr('How it went')}</h4><p className="mk-note" style={{ margin: 0 }}>{e.outcome}</p></>}
        </div>
      </div>
    </MkDialog>
  );
}
