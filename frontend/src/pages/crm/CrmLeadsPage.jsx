import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Empty, Glossary, Hero, Icon, Section, fmtDate } from '../../components/DashKit';
import SearchInput, { matchesQuery } from '../../components/SearchInput';
import { tr } from '../../lib/i18n.jsx';
import { OPEN_STAGES, STAGES, ImportDialog, LeadDialog, NewLeadDialog, StageTag, Toast, VisitDialog, daysUntil, followUpClass, followUpText, ghs, stage, todayISO, useCrmBasics, usePerms } from './crmShared';
import '../EmployeesPage.css';
import '../ToolRoomPage.css';
import './CrmPage.css';

// Every lead, as a list to search and filter or as a board by stage. The
// filters live in the address (?stage=new&followUp=overdue&rep=me), so the
// overview's links land on exactly the leads they talk about. Pressing a
// lead opens it (crmShared.jsx LeadDialog).

const LIST_STEP = 60;
const BOARD_CLOSED = 12;

export default function CrmLeadsPage() {
  const { session } = useAuth();
  const meId = session && session.employee ? session.employee.id : null;
  const { canManage } = usePerms();
  const { settings, people } = useCrmBasics();
  const [params, setParams] = useSearchParams();
  const [leads, setLeads] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(LIST_STEP);
  const [dialog, setDialog] = useState(() => (params.get('lead') ? { kind: 'lead', id: params.get('lead') } : params.get('new') ? { kind: 'new' } : null));
  const [toast, setToast] = useState(null);
  const [moving, setMoving] = useState(null);

  const view = params.get('view') === 'board' ? 'board' : 'list';
  const stageF = params.get('stage') || 'open';
  const followF = params.get('followUp') || '';
  const repF = params.get('rep') || '';
  const sourceF = params.get('source') || '';
  function setParam(k, v) { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); p.delete('lead'); p.delete('new'); setParams(p, { replace: true }); setShown(LIST_STEP); }

  const load = useCallback(async () => {
    try { setLeads(await api.get('/crm/leads?stage=all&limit=1000')); setError(null); } catch (err) { setError(err.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const today = todayISO();
  const filtered = useMemo(() => {
    if (!leads) return [];
    return leads.filter((l) => {
      if (stageF === 'open' ? !OPEN_STAGES.includes(l.stage) : stageF !== 'all' && l.stage !== stageF) return false;
      if (followF) {
        const d = daysUntil(l.nextFollowUp);
        if (followF === 'overdue' && !(d !== null && d < 0 && OPEN_STAGES.includes(l.stage))) return false;
        if (followF === 'today' && d !== 0) return false;
        if (followF === 'week' && !(d !== null && d >= 0 && d <= 7)) return false;
        if (followF === 'none' && (l.nextFollowUp || !OPEN_STAGES.includes(l.stage))) return false;
      }
      if (repF === 'me' ? l.repId !== meId : repF === 'none' ? (l.repId || l.repName) : repF && l.repId !== repF && l.repName !== repF) return false;
      if (sourceF && (l.source || '-') !== sourceF) return false;
      return matchesQuery(q, ...[l.name, l.company, l.phone, l.item, l.location, l.ref, l.sheetRef, l.repName, l.comments]);
    });
  }, [leads, stageF, followF, repF, sourceF, q, meId]);

  if (!leads) return <div className="dk">{error ? <div className="error-banner">{error}</div> : <div className="eyebrow">{tr('Loading…')}</div>}</div>;

  const open = leads.filter((l) => OPEN_STAGES.includes(l.stage));
  const overdue = open.filter((l) => l.nextFollowUp && l.nextFollowUp < today);
  const fresh = leads.filter((l) => l.stage === 'new');
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString();
  const wonRecent = leads.filter((l) => l.stage === 'won' && l.stageChangedAt >= monthAgo);
  const reps = [...new Map(leads.filter((l) => l.repName).map((l) => [l.repId || l.repName, l.repName])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const sources = [...new Set(leads.map((l) => l.source || '-'))].sort();
  const count = (st) => leads.filter((l) => l.stage === st).length;

  async function nextStage(l) {
    const i = OPEN_STAGES.indexOf(l.stage);
    const to = i >= 0 && i < OPEN_STAGES.length - 1 ? OPEN_STAGES[i + 1] : null;
    if (!to) { setDialog({ kind: 'lead', id: l.id }); return; }
    setMoving(l.id);
    try { await api.post('/crm/leads/' + l.id + '/stage', { stage: to }); await load(); setToast(tr('{name} moved to {stage}.', { name: l.name, stage: tr(stage(to).label) })); } catch (err) { setError(err.message); } finally { setMoving(null); }
  }

  const leadCard = (l, compact) => (
    <article key={l.id} className={'crm-card is-' + stage(l.stage).tone}>
      <button type="button" className="crm-card-open" onClick={() => setDialog({ kind: 'lead', id: l.id })}>
        <span className="crm-card-top">
          <strong className="crm-card-name">{l.name}</strong>
          {!compact && <StageTag value={l.stage} />}
        </span>
        <span className="dk-muted tl-small crm-card-want">{l.item || tr('What they want isn\'t written down yet.')}</span>
        <span className="dk-muted tl-small">{[l.source, l.repName, l.location].filter(Boolean).join(' · ') || '—'}</span>
        {OPEN_STAGES.includes(l.stage) && <span className={'tl-small crm-card-follow ' + followUpClass(l.nextFollowUp)}><Icon name="calendar" /> {followUpText(l.nextFollowUp)}</span>}
        {l.stage === 'won' && l.dealValue > 0 && <span className="tl-small crm-card-won"><Icon name="cash" /> {ghs(l.dealValue)}</span>}
        {l.lastNote && <span className="dk-muted tl-small crm-card-note">“{l.lastNote.body}”</span>}
      </button>
      {compact && canManage && OPEN_STAGES.includes(l.stage) && l.stage !== 'negotiation' && (
        <button type="button" className="crm-card-next" disabled={moving === l.id} onClick={() => nextStage(l)} title={tr('Move to {stage}', { stage: tr(stage(OPEN_STAGES[OPEN_STAGES.indexOf(l.stage) + 1]).label) })}>
          {tr('Next')} <Icon name="arrow" />
        </button>
      )}
    </article>
  );

  return (
    <div className="dk crm">
      {error && <div className="error-banner" role="alert">{error}</div>}
      <Hero eyebrow={tr('Sales & CRM')} title={tr('Leads')}
        sub={tr('Everyone who has asked about a product, from the first message until they buy or go elsewhere. Keep the next follow-up date on every open lead and nobody gets forgotten.')}
        actions={canManage && <>
          <button type="button" className="btn btn-primary" onClick={() => setDialog({ kind: 'new' })}>{tr('Add a lead')}</button>
          <button type="button" className="btn btn-secondary" onClick={() => setDialog({ kind: 'import' })}>{tr('Import from a spreadsheet')}</button>
        </>}
        stats={[
          { icon: 'people', value: String(open.length), label: tr('open leads'), note: tr('{n} in all', { n: leads.length }), onClick: () => { setParam('stage', ''); } },
          { icon: 'send', value: String(fresh.length), label: tr('not contacted yet'), note: fresh.length ? tr('the oldest came in {date}', { date: fmtDate(fresh[fresh.length - 1].receivedOn) }) : tr('everyone has been answered'), tone: fresh.length ? 'bad' : 'good', onClick: () => setParam('stage', 'new') },
          { icon: 'clock', value: String(overdue.length), label: tr('follow-ups overdue'), note: tr('{n} due today', { n: open.filter((l) => l.nextFollowUp === today).length }), tone: overdue.length ? 'alert' : '', onClick: () => setParam('followUp', 'overdue') },
          { icon: 'check', value: String(wonRecent.length), label: tr('won in the last 30 days'), note: tr('{amount} in sales', { amount: ghs(wonRecent.reduce((a, l) => a + l.dealValue, 0)) }), tone: wonRecent.length ? 'good' : '', onClick: () => setParam('stage', 'won') }
        ]} />

      <Section id="crm-leads" title={view === 'board' ? tr('The board') : tr('All leads')}
        sub={view === 'board' ? tr('Open leads by stage. Next moves a lead one stage on; open it to win or lose it.') : tr('{n} shown. Press one to open it.', { n: filtered.length })}
        action={
          <div className="dk-segment" role="radiogroup" aria-label={tr('View')}>
            {[['list', tr('List')], ['board', tr('Board')]].map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={view === k} className={view === k ? 'is-on' : ''} onClick={() => setParam('view', k === 'board' ? 'board' : '')}>{label}</button>)}
          </div>
        }>
        <div className="crm-filters">
          <SearchInput value={q} onChange={setQ} placeholder={tr('Search name, phone, item, place…')} />
          <select className="input" value={repF} onChange={(e) => setParam('rep', e.target.value)} aria-label={tr('Sales rep')}>
            <option value="">{tr('Every rep')}</option>
            {meId && <option value="me">{tr('My leads')}</option>}
            {reps.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            <option value="none">{tr('No rep yet')}</option>
          </select>
          <select className="input" value={sourceF} onChange={(e) => setParam('source', e.target.value)} aria-label={tr('How they found us')}>
            <option value="">{tr('Any source')}</option>
            {sources.map((s) => <option key={s} value={s}>{s === '-' ? tr('Not known') : s}</option>)}
          </select>
        </div>
        {view === 'list' && (
          <div className="ppl-chips" role="radiogroup" aria-label={tr('Stage')}>
            {[['open', tr('Open'), open.length], ...STAGES.map((s) => [s.key, tr(s.label), count(s.key)]), ['all', tr('All'), leads.length]].map(([k, label, n]) => (
              <button key={k} type="button" role="radio" aria-checked={stageF === k} className={'ppl-chip' + (stageF === k ? ' is-on' : '')} onClick={() => setParam('stage', k === 'open' ? '' : k)}>{label} <span className="ppl-chip-n">{n}</span></button>
            ))}
          </div>
        )}
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Follow-up')}>
          {[['', tr('Any follow-up')], ['overdue', tr('Overdue')], ['today', tr('Due today')], ['week', tr('This week')], ['none', tr('No date set')]].map(([k, label]) => (
            <button key={k || 'any'} type="button" role="radio" aria-checked={followF === k} className={'ppl-chip' + (followF === k ? ' is-on' : '')} onClick={() => setParam('followUp', k)}>{label}</button>
          ))}
        </div>

        {view === 'list' ? (
          filtered.length ? (
            <>
              <div className="crm-cards">{filtered.slice(0, shown).map((l) => leadCard(l, false))}</div>
              {filtered.length > shown && <button type="button" className="btn btn-secondary crm-more" onClick={() => setShown(shown + LIST_STEP)}>{tr('Show {n} more', { n: Math.min(LIST_STEP, filtered.length - shown) })}</button>}
            </>
          ) : <Empty icon="people">{leads.length ? tr('No lead matches. Try another filter.') : tr('No leads yet. Add the next enquiry that comes in, or import your spreadsheet.')}</Empty>
        ) : (
          <div className="crm-board" role="list">
            {STAGES.map((s) => {
              let col = filtered.filter((l) => l.stage === s.key);
              if (stageF !== 'open' && stageF !== 'all' && stageF !== s.key) col = [];
              if (!OPEN_STAGES.includes(s.key)) col = (stageF === s.key ? leads.filter((l) => l.stage === s.key && filtered.includes(l)) : leads.filter((l) => l.stage === s.key && matchesQuery(q, ...[l.name, l.item]))).slice(0, BOARD_CLOSED);
              return (
                <section key={s.key} className={'crm-col is-' + s.tone} role="listitem" aria-label={tr(s.label)}>
                  <h4 className="crm-col-head"><span>{tr(s.label)}</span><span className="ppl-chip-n">{OPEN_STAGES.includes(s.key) ? col.length : count(s.key)}</span></h4>
                  <p className="dk-muted tl-small crm-col-help">{tr(s.help)}</p>
                  <div className="crm-col-cards">{col.length ? col.map((l) => leadCard(l, true)) : <p className="dk-muted tl-small crm-col-empty">{tr('None')}</p>}</div>
                  {!OPEN_STAGES.includes(s.key) && count(s.key) > BOARD_CLOSED && <p className="dk-muted tl-small">{tr('The latest {n}.', { n: BOARD_CLOSED })}</p>}
                </section>
              );
            })}
          </div>
        )}
      </Section>

      <Glossary items={STAGES.map((s) => [tr(s.label), tr(s.help)]).concat([[tr('Next follow-up'), tr('The date someone should get back to the lead. Adding a call or note to a new lead marks it contacted.')]])} />

      {dialog && dialog.kind === 'new' && settings && <NewLeadDialog settings={settings} people={people} meId={meId} onClose={() => setDialog(null)} onSaved={(l) => { setDialog({ kind: 'lead', id: l.id }); setToast(tr('Lead {ref} added.', { ref: l.ref })); load(); }} />}
      {dialog && dialog.kind === 'import' && <ImportDialog onClose={() => setDialog(null)} onDone={load} />}
      {dialog && dialog.kind === 'lead' && settings && <LeadDialog leadId={dialog.id} settings={settings} people={people} onClose={() => setDialog(null)} onChanged={load} onVisit={(v) => setDialog({ kind: 'visit', visit: v, back: dialog.id })} />}
      {dialog && dialog.kind === 'visit' && <VisitDialog visit={dialog.visit} people={people} onClose={() => setDialog({ kind: 'lead', id: dialog.back })} onSaved={() => { setToast(tr('Site visit saved.')); setDialog({ kind: 'lead', id: dialog.back }); }} />}
      <Toast text={toast} onDone={() => setToast(null)} />
    </div>
  );
}
