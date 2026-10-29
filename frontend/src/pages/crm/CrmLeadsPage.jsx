import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Empty, Glossary, Hero, Icon, Section, fmtDate, jump } from '../../components/DashKit';
import SearchInput, { matchesQuery } from '../../components/SearchInput';
import { tr } from '../../lib/i18n.jsx';
import { LEAD_STAGES, OPEN_STAGES, PHASES, PROSPECT_STAGES, ImportDialog, LeadDialog, NewLeadDialog, PhaseTag, StageTag, Toast, VisitDialog, WhoIsThisDialog, useUnmatchedNames, addDays, daysUntil, followUpClass, followUpText, ghs, stage, todayISO, useCrmBasics, usePerms } from './crmShared';
import { StopPill } from './crmStop';
import { NOT_LEAD_REASONS, reasonText } from './crmStopReasons';
import { SalesReviewButton } from './SalesPresent';
import { PRIORITY_GLOSSARY, PriorityKey, PriorityRing, ReasonChips, TIERS, TierTag, estimate } from './leadPriority';
import '../EmployeesPage.css';
import '../ToolRoomPage.css';
import './CrmPage.css';

// Lead → Prospect → Customer, one page per step that is still being worked:
//   phase "lead" (Sales & CRM → Leads): everyone who comes in — enquiries,
//     and contacts from fairs, events and lists — at New, Contacted or
//     Follow-up;
//   phase "prospect" (Customers & prospects → Prospects): the ones being
//     worked on for real — Qualified, Quote sent, Negotiation — and the won
//     ones waiting for their first payment, which makes them customers.
// As a list to search and filter, or as a board by stage. The filters live
// in the address (?stage=new&followUp=overdue&rep=me), so the overview's
// links land on exactly the leads they talk about. Pressing one opens it
// (crmShared.jsx LeadDialog).
//
// Most important first: each open lead has a priority (0–100, solid,
// promising, maybe or long shot; leadPriority.jsx), the page opens with the
// ones to work first and the priority ladder, the list is in that order
// unless another is picked (?sort=new, ?sort=follow) and can keep one tier
// (?tier=solid). The star marks a lead Important by hand.

const LIST_STEP = 60;
const TIER_COLOR = { solid: 'var(--lp-solid)', promising: 'var(--lp-promising)', maybe: 'var(--lp-maybe)', long_shot: 'var(--lp-long)' };
const score = (l) => (l.priority ? l.priority.score : -1);
const byPriority = (a, b) => score(b) - score(a) || (a.nextFollowUp || '9999').localeCompare(b.nextFollowUp || '9999') || String(b.receivedOn).localeCompare(String(a.receivedOn));
const byNewest = (a, b) => String(b.receivedOn).localeCompare(String(a.receivedOn)) || String(b.createdAt).localeCompare(String(a.createdAt));
const byFollowUp = (a, b) => (a.nextFollowUp || '9999').localeCompare(b.nextFollowUp || '9999') || byPriority(a, b);
const SORTS = { '': byPriority, new: byNewest, follow: byFollowUp };

export default function CrmLeadsPage({ phase = 'lead' }) {
  const isP = phase === 'prospect';
  const navigate = useNavigate();
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
  const unmatched = useUnmatchedNames();

  const stagesHere = isP ? PROSPECT_STAGES : LEAD_STAGES;
  const view = params.get('view') === 'board' ? 'board' : 'list';
  const stageF = params.get('stage') || 'open';
  const followF = params.get('followUp') || '';
  const repF = params.get('rep') || '';
  const sourceF = params.get('source') || '';
  const tierF = TIERS.some((t) => t.key === params.get('tier')) ? params.get('tier') : '';
  const sortF = SORTS[params.get('sort')] ? params.get('sort') || '' : '';
  function setParam(k, v) { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); p.delete('lead'); p.delete('new'); setParams(p, { replace: true }); setShown(LIST_STEP); }

  const load = useCallback(async () => {
    try { setLeads(await api.get('/crm/leads?stage=all&limit=1000')); setError(null); } catch (err) { setError(err.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // What this page holds while it is being worked on.
  const isOpenHere = useCallback((l) => (isP ? l.phase === 'prospect' || l.phase === 'won' : l.phase === 'lead'), [isP]);
  const today = todayISO();
  const repMatch = useCallback((l) => !(repF === 'me' ? l.repId !== meId : repF === 'none' ? (l.repId || l.repName) : repF && l.repId !== repF && l.repName !== repF), [repF, meId]);
  // Every filter but the priority tier: the tier chips count these.
  const unTiered = useMemo(() => {
    if (!leads) return [];
    return leads.filter((l) => {
      if (stageF === 'open') { if (!isOpenHere(l)) return false; }
      else if (stageF === 'won' || stageF === 'customer') { if (l.phase !== stageF) return false; }
      else if (l.stage !== stageF) return false;
      if (followF) {
        const d = daysUntil(l.nextFollowUp);
        if (followF === 'overdue' && !(d !== null && d < 0 && OPEN_STAGES.includes(l.stage))) return false;
        if (followF === 'today' && d !== 0) return false;
        if (followF === 'week' && !(d !== null && d >= 0 && d <= 7)) return false;
        if (followF === 'none' && (l.nextFollowUp || l.noFollowUp || !OPEN_STAGES.includes(l.stage))) return false;
        if (followF === 'stopped' && !l.noFollowUp) return false;
      }
      if (!repMatch(l)) return false;
      if (sourceF && (l.source || '-') !== sourceF) return false;
      return matchesQuery(q, ...[l.name, l.company, l.phone, l.item, l.location, l.ref, l.sheetRef, l.repName, l.comments]);
    });
  }, [leads, stageF, followF, sourceF, q, isOpenHere, repMatch]);
  const filtered = useMemo(() => unTiered.filter((l) => !tierF || (l.priority && l.priority.tier === tierF)).sort(SORTS[sortF]), [unTiered, tierF, sortF]);

  if (!leads) return <div className="dk">{error ? <div className="error-banner">{error}</div> : <div className="eyebrow">{tr('Loading…')}</div>}</div>;

  const open = leads.filter(isOpenHere);
  const working = leads.filter((l) => (isP ? l.phase === 'prospect' : l.phase === 'lead'));
  const overdue = working.filter((l) => l.nextFollowUp && l.nextFollowUp < today);
  const fresh = leads.filter((l) => l.stage === 'new');
  const waitingPay = leads.filter((l) => l.phase === 'won');
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString();
  const newCustomers = leads.filter((l) => l.phase === 'customer' && l.stageChangedAt >= monthAgo);
  // Of the leads that came in over the last 90 days, how many got further.
  const recent = leads.filter((l) => l.receivedOn >= addDays(today, -90));
  const movedOn = recent.filter((l) => ['prospect', 'won', 'customer'].includes(l.phase));
  const movedPct = recent.length ? Math.round(movedOn.length / recent.length * 100) : null;
  const reps = [...new Map(leads.filter((l) => l.repName).map((l) => [l.repId || l.repName, l.repName])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const sources = [...new Set(leads.filter((l) => isOpenHere(l) || l.phase === 'lost').map((l) => l.source || '-'))].sort();
  const count = (st) => leads.filter((l) => l.stage === st).length;
  const countPhase = (ph) => leads.filter((l) => l.phase === ph).length;

  // Ranked: this page's open leads for the rep and source picked, most important first.
  const ranked = leads.filter((l) => isOpenHere(l) && l.priority && repMatch(l) && (!sourceF || (l.source || '-') === sourceF)).sort(byPriority);
  const tierCount = (k) => ranked.filter((l) => l.priority.tier === k).length;
  const solidN = tierCount('solid');
  function pickTier(k) { setParam('tier', k); setTimeout(() => jump('crm-leads'), 50); }

  async function star(l) {
    setMoving(l.id);
    try {
      const on = l.manualPriority !== 'high';
      await api.put('/crm/leads/' + l.id + '/priority', { priority: on ? 'high' : null });
      await load();
      setToast(on ? tr('{name} is marked important.', { name: l.name }) : tr('{name} is back to its worked-out priority.', { name: l.name }));
    } catch (err) { setError(err.message); } finally { setMoving(null); }
  }

  async function nextStage(l) {
    const i = OPEN_STAGES.indexOf(l.stage);
    const to = i >= 0 && i < OPEN_STAGES.length - 1 ? OPEN_STAGES[i + 1] : null;
    if (!to) { setDialog({ kind: 'lead', id: l.id }); return; }
    setMoving(l.id);
    try {
      await api.post('/crm/leads/' + l.id + '/stage', { stage: to });
      await load();
      setToast(to === 'qualified' ? tr('{name} is now a prospect.', { name: l.name }) : tr('{name} moved to {stage}.', { name: l.name, stage: tr(stage(to).label) }));
    } catch (err) { setError(err.message); } finally { setMoving(null); }
  }

  const leadCard = (l, compact) => {
    const nextKey = OPEN_STAGES[OPEN_STAGES.indexOf(l.stage) + 1];
    const p = l.priority;
    const tag = l.phase === 'won' || l.phase === 'customer' ? <PhaseTag phase={l.phase} /> : <StageTag value={l.stage} />;
    return (
      <article key={l.id} className={'crm-card ' + (p ? 'lp-card lp-' + p.tier : 'is-' + (l.phase === 'won' ? 'warn' : stage(l.stage).tone))}>
        <button type="button" className="crm-card-open" onClick={() => setDialog({ kind: 'lead', id: l.id })}>
          {p ? (
            <span className="crm-card-top">
              <PriorityRing priority={p} size={compact ? 'sm' : 'md'} />
              <span className="lp-card-title">
                <strong className="crm-card-name">{l.name}</strong>
                <span className="lp-card-tags"><TierTag tierKey={p.tier} />{!compact && tag}</span>
              </span>
            </span>
          ) : (
            <span className="crm-card-top">
              <strong className="crm-card-name">{l.name}</strong>
              {!compact && tag}
            </span>
          )}
          <span className="dk-muted tl-small crm-card-want">{l.item || tr('What they want isn\'t written down yet.')}{p && p.value ? <span className="lp-card-value"> · {tr('about {amount}', { amount: estimate(p.value.amount) })}</span> : null}</span>
          <span className="dk-muted tl-small">{[l.source, l.repName, l.location].filter(Boolean).join(' · ') || '—'}</span>
          {p && <ReasonChips priority={p} max={compact ? 1 : 2} />}
          {l.stage === 'not_lead' ? <span className="dk-muted tl-small crm-card-why">{reasonText(l.lostReason, NOT_LEAD_REASONS)}</span>
            : l.noFollowUp ? <StopPill noFollowUp={l.noFollowUp} />
            : OPEN_STAGES.includes(l.stage) && <span className={'tl-small crm-card-follow ' + followUpClass(l.nextFollowUp)}><Icon name="calendar" /> {followUpText(l.nextFollowUp)}</span>}
          {l.stage === 'won' && l.dealValue > 0 && <span className="tl-small crm-card-won"><Icon name="cash" /> {ghs(l.dealValue)}</span>}
          {!compact && l.lastNote && <span className="dk-muted tl-small crm-card-note">“{l.lastNote.body}”</span>}
        </button>
        {p && canManage && (
          <button type="button" className={'lp-star' + (l.manualPriority === 'high' ? ' is-on' : '')} disabled={moving === l.id} onClick={() => star(l)}
            aria-pressed={l.manualPriority === 'high'} aria-label={tr('Important')} title={l.manualPriority === 'high' ? tr('Marked important. Press to put it back to its worked-out priority.') : tr('Mark as important: it stays at the top.')}>
            <Icon name="star" />
          </button>
        )}
        {compact && canManage && OPEN_STAGES.includes(l.stage) && l.stage !== 'negotiation' && (
          <button type="button" className="crm-card-next" disabled={moving === l.id} onClick={() => nextStage(l)}
            title={nextKey === 'qualified' ? tr('Move to Qualified: they become a prospect') : tr('Move to {stage}', { stage: tr(stage(nextKey).label) })}>
            {nextKey === 'qualified' ? tr('Make a prospect') : tr('Next')} <Icon name="arrow" />
          </button>
        )}
      </article>
    );
  };

  const chips = isP
    ? [['open', tr('Open'), open.length], ...PROSPECT_STAGES.map((k) => [k, tr(stage(k).label), count(k)]), ['won', tr('Won, waiting for payment'), waitingPay.length], ['customer', tr('Became customers'), countPhase('customer')]]
    : [['open', tr('Open'), open.length], ...LEAD_STAGES.map((k) => [k, tr(stage(k).label), count(k)]), ['lost', tr('Lost'), count('lost')], ['not_lead', tr('Not leads'), count('not_lead')]];
  const columns = isP ? [...PROSPECT_STAGES, 'won'] : LEAD_STAGES;
  const phaseInfo = PHASES.find((p) => p.key === phase);

  return (
    <div className="dk crm">
      {error && <div className="error-banner" role="alert">{error}</div>}
      <Hero eyebrow={tr('Lead → Prospect → Customer')} title={isP ? tr('Prospects') : tr('Leads')}
        sub={isP
          ? tr('Leads being worked on for real: qualified, quoted, or agreeing terms. Won ones wait here until they pay; with the first payment they become customers by themselves.')
          : tr('Everyone who comes in: enquiries from every channel, and contacts from fairs, events and lists. Answer them, find out what they need, and once it is a real job, make them a prospect.')}
        actions={isP
          ? <button type="button" className="btn btn-secondary" onClick={() => navigate('/crmleads')}>{tr('Leads')}</button>
          : <>
            {canManage && <button type="button" className="btn btn-primary" onClick={() => setDialog({ kind: 'new' })}>{tr('Add a lead')}</button>}
            <SalesReviewButton />
            {canManage && <button type="button" className="btn btn-secondary" onClick={() => setDialog({ kind: 'import' })}>{tr('Import from a spreadsheet')}</button>}
          </>}
        stats={isP ? [
          { icon: 'people', value: String(working.length), label: tr('prospects being worked on'), note: tr('{n} have our quotation', { n: count('quote_sent') }), onClick: () => setParam('stage', '') },
          { icon: 'clock', value: String(overdue.length), label: tr('follow-ups overdue'), note: tr('{n} due today', { n: working.filter((l) => l.nextFollowUp === today).length }), tone: overdue.length ? 'alert' : '', onClick: () => setParam('followUp', 'overdue') },
          { icon: 'cash', value: String(waitingPay.length), label: tr('won, waiting for payment'), note: tr('{amount} linked so far', { amount: ghs(waitingPay.reduce((a, l) => a + l.dealValue, 0)) }), tone: waitingPay.length ? 'alert' : '', onClick: () => setParam('stage', 'won') },
          { icon: 'check', value: String(newCustomers.length), label: tr('became customers in the last 30 days'), note: tr('{amount} in sales', { amount: ghs(newCustomers.reduce((a, l) => a + l.dealValue, 0)) }), tone: newCustomers.length ? 'good' : '', onClick: () => setParam('stage', 'customer') }
        ] : [
          { icon: 'people', value: String(working.length), label: tr('open leads'), note: tr('{n} came in in the last 30 days', { n: working.filter((l) => l.receivedOn >= addDays(today, -30)).length }), onClick: () => setParam('stage', '') },
          { icon: 'send', value: String(fresh.length), label: tr('not contacted yet'), note: fresh.length ? tr('the oldest came in {date}', { date: fmtDate(fresh[fresh.length - 1].receivedOn) }) : tr('everyone has been answered'), tone: fresh.length ? 'bad' : 'good', onClick: () => setParam('stage', 'new') },
          { icon: 'clock', value: String(overdue.length), label: tr('follow-ups overdue'), note: tr('{n} due today', { n: working.filter((l) => l.nextFollowUp === today).length }), tone: overdue.length ? 'alert' : '', onClick: () => setParam('followUp', 'overdue') },
          { icon: 'arrow', value: movedPct !== null ? movedPct + '%' : '—', label: tr('became prospects or customers'), note: tr('{n} of the {m} leads from the last 90 days', { n: movedOn.length, m: recent.length }), tone: movedPct !== null && movedPct >= 30 ? 'good' : '', onClick: () => navigate('/crmcustomers?tab=prospects') }
        ]} />

      <Section id="crm-priority" title={tr('Work these first')}
        sub={isP
          ? tr('Every open prospect has a priority from 0 to 100: how likely they are to buy, and how big the job is. The solid ones are at the top. Open one to see why.')
          : tr('Every open lead has a priority from 0 to 100: how likely they are to buy, and how big the job is. The solid ones are at the top. Open one to see why.')}>
        <div className="lp-spot">
          <div className="lp-ladder">
            <div className="lp-ladder-head">
              <strong>{tr('The priority ladder')}</strong>
              <span className="dk-muted tl-small">{solidN === 1 ? tr('1 solid of {n} open', { n: ranked.length }) : tr('{s} solid of {n} open', { s: solidN, n: ranked.length })}</span>
            </div>
            <div className="lp-bar" role="group" aria-label={tr('The priority ladder')}>
              {TIERS.map((t) => tierCount(t.key) > 0 && (
                <button key={t.key} type="button" className={'lp-seg is-' + t.key} style={{ flexGrow: tierCount(t.key) }} onClick={() => pickTier(t.key)}
                  aria-label={tr('{tier}: {n}', { tier: tr(t.label), n: tierCount(t.key) })} title={tr('{tier}: {n}', { tier: tr(t.label), n: tierCount(t.key) })} />
              ))}
            </div>
            <div className="lp-tiers">
              {TIERS.map((t) => (
                <button key={t.key} type="button" className={'lp-tier is-' + t.key + (tierF === t.key ? ' is-on' : '')} aria-pressed={tierF === t.key} onClick={() => pickTier(tierF === t.key ? '' : t.key)}>
                  <span className="lp-tier-top"><strong>{tierCount(t.key)}</strong><span>{tr(t.label)}</span></span>
                  <small>{tr(t.help)}</small>
                </button>
              ))}
            </div>
            <PriorityKey />
          </div>
          <ol className="lp-top" aria-label={tr('Work these first')}>
            {ranked.length ? ranked.slice(0, 5).map((l, i) => (
              <li key={l.id}>
                <button type="button" className="lp-top-row" onClick={() => setDialog({ kind: 'lead', id: l.id })}>
                  <span className="lp-rank">{i + 1}</span>
                  <PriorityRing priority={l.priority} size="sm" />
                  <span className="lp-top-main">
                    <span className="lp-top-name"><span>{l.name}</span>{l.manualPriority === 'high' && <Icon name="star" />}<TierTag tierKey={l.priority.tier} /></span>
                    <span className="dk-muted tl-small lp-top-want">{[l.item, l.priority.value ? tr('about {amount}', { amount: estimate(l.priority.value.amount) }) : null, l.repName].filter(Boolean).join(' · ') || '—'}</span>
                    <ReasonChips priority={l.priority} max={2} />
                  </span>
                </button>
              </li>
            )) : <li className="dk-muted lp-top-empty">{isP ? tr('No open prospect yet.') : tr('No open lead yet.')}</li>}
          </ol>
        </div>
      </Section>

      <Section id="crm-leads" title={view === 'board' ? tr('The board') : isP ? tr('All prospects') : tr('All leads')}
        sub={view === 'board'
          ? (isP ? tr('Prospects by stage. Next moves one on; open one to win or lose it. Won ones wait for their first payment.') : tr('Leads by stage. Next moves one on; Make a prospect when it is a real job.'))
          : sortF ? tr('{n} shown. Press one to open it.', { n: filtered.length }) : tr('{n} shown, the most important first. Press one to open it.', { n: filtered.length })}
        action={
          <div className="dk-segment" role="radiogroup" aria-label={tr('View')}>
            {[['list', tr('List')], ['board', tr('Board')]].map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={view === k} className={view === k ? 'is-on' : ''} onClick={() => setParam('view', k === 'board' ? 'board' : '')}>{label}</button>)}
          </div>
        }>
        <div className="crm-note is-info crm-phase-note">
          <Icon name="info" />
          <span>{tr(phaseInfo.help)} {isP ? tr('They became prospects from Leads; they become customers when they pay.') : tr('Next they become prospects, then customers when they pay.')}</span>
        </div>
        {unmatched.names.length > 0 && canManage && (
          <div className="crm-note is-warn crm-who-note">
            <Icon name="people" />
            <span>{unmatched.names.length === 1
              ? tr('1 name from the spreadsheet ({names}) isn\'t linked to anyone on the staff list yet.', { names: unmatched.names[0].name })
              : tr('{n} names from the spreadsheet ({names}) aren\'t linked to anyone on the staff list yet.', { n: unmatched.names.length, names: unmatched.names.slice(0, 5).map((x) => x.name).join(', ') + (unmatched.names.length > 5 ? '…' : '') })}</span>
            <button type="button" className="dk-link" onClick={() => setDialog({ kind: 'who' })}>{tr('Who is this?')} <Icon name="arrow" /></button>
          </div>
        )}
        <div className="crm-filters">
          <SearchInput value={q} onChange={setQ} placeholder={tr('Search name, phone, item, place…')} />
          <select className="input" value={repF} onChange={(e) => setParam('rep', e.target.value)} aria-label={tr('Sales rep')}>
            <option value="">{tr('Every rep')}</option>
            {meId && <option value="me">{isP ? tr('My prospects') : tr('My leads')}</option>}
            {reps.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            <option value="none">{tr('No rep yet')}</option>
          </select>
          <select className="input" value={sourceF} onChange={(e) => setParam('source', e.target.value)} aria-label={tr('How they found us')}>
            <option value="">{tr('Any source')}</option>
            {sources.map((s) => <option key={s} value={s}>{s === '-' ? tr('Not known') : s}</option>)}
          </select>
          <select className="input" value={sortF} onChange={(e) => setParam('sort', e.target.value)} aria-label={tr('Order')}>
            <option value="">{tr('Most important first')}</option>
            <option value="new">{tr('Newest first')}</option>
            <option value="follow">{tr('By follow-up date')}</option>
          </select>
        </div>
        {view === 'list' && (
          <div className="ppl-chips" role="radiogroup" aria-label={tr('Stage')}>
            {chips.map(([k, label, n]) => (
              <button key={k} type="button" role="radio" aria-checked={stageF === k} className={'ppl-chip' + (stageF === k ? ' is-on' : '')} onClick={() => setParam('stage', k === 'open' ? '' : k)}>{label} <span className="ppl-chip-n">{n}</span></button>
            ))}
          </div>
        )}
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Priority')}>
          {[['', tr('Any priority')], ...TIERS.map((t) => [t.key, tr(t.label)])].map(([k, label]) => (
            <button key={k || 'any'} type="button" role="radio" aria-checked={tierF === k} className={'ppl-chip' + (k ? ' lp-tier-chip' : '') + (tierF === k ? ' is-on' : '')} style={k ? { '--c': TIER_COLOR[k] } : undefined}
              onClick={() => setParam('tier', k)}>{label} <span className="ppl-chip-n">{k ? unTiered.filter((l) => l.priority && l.priority.tier === k).length : unTiered.length}</span></button>
          ))}
        </div>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Follow-up')}>
          {[['', tr('Any follow-up')], ['overdue', tr('Overdue')], ['today', tr('Due today')], ['week', tr('This week')], ['none', tr('No date set')], ['stopped', tr('Not to be followed up')]].map(([k, label]) => (
            <button key={k || 'any'} type="button" role="radio" aria-checked={followF === k} className={'ppl-chip' + (followF === k ? ' is-on' : '')} onClick={() => setParam('followUp', k)}>{label}</button>
          ))}
        </div>

        {view === 'list' ? (
          filtered.length ? (
            <>
              <div className="crm-cards">{filtered.slice(0, shown).map((l) => leadCard(l, false))}</div>
              {filtered.length > shown && <button type="button" className="btn btn-secondary crm-more" onClick={() => setShown(shown + LIST_STEP)}>{tr('Show {n} more', { n: Math.min(LIST_STEP, filtered.length - shown) })}</button>}
            </>
          ) : <Empty icon="people">{leads.length ? (isP ? tr('No prospect matches. Leads become prospects once they are qualified or quoted.') : tr('No lead matches. Try another filter.')) : tr('No leads yet. Add the next enquiry that comes in, or import your spreadsheet.')}</Empty>
        ) : (
          <div className={'crm-board' + (isP ? ' is-four' : ' is-three')} role="list">
            {columns.map((key) => {
              const col = filtered.filter((l) => (key === 'won' ? l.phase === 'won' : l.stage === key) && (stageF === 'open' || stageF === key));   // in the order picked
              const label = key === 'won' ? tr('Won, waiting for payment') : tr(stage(key).label);
              const help = key === 'won' ? tr('They agreed to buy. The first payment makes them a customer.') : tr(stage(key).help);
              return (
                <section key={key} className={'crm-col is-' + (key === 'won' ? 'good' : stage(key).tone)} role="listitem" aria-label={label}>
                  <h4 className="crm-col-head"><span>{label}</span><span className="ppl-chip-n">{col.length}</span></h4>
                  <p className="dk-muted tl-small crm-col-help">{help}</p>
                  <div className="crm-col-cards">{col.length ? col.map((l) => leadCard(l, true)) : <p className="dk-muted tl-small crm-col-empty">{tr('None')}</p>}</div>
                </section>
              );
            })}
          </div>
        )}
      </Section>

      <Glossary items={PHASES.map((p) => [tr(p.label), tr(p.help)])
        .concat(stagesHere.map((k) => [tr(stage(k).label), tr(stage(k).help)]))
        .concat(isP ? [[tr('Won, waiting for payment'), tr('They agreed to buy but haven\'t paid yet. Link the sale\'s invoice to the prospect; the first payment on it makes them a customer.')]] : [[tr('Lost'), tr(stage('lost').help)]])
        .concat([[tr('Next follow-up'), tr('The date someone should get back to them. Adding a call or note to a new lead marks it contacted.')]])
        .concat(PRIORITY_GLOSSARY.map(([k, v]) => [tr(k), tr(v)]))} />

      {dialog && dialog.kind === 'new' && settings && <NewLeadDialog settings={settings} people={people} meId={meId} onClose={() => setDialog(null)} onSaved={(l) => { setDialog({ kind: 'lead', id: l.id }); setToast(tr('Lead {ref} added.', { ref: l.ref })); load(); }} />}
      {dialog && dialog.kind === 'import' && <ImportDialog onClose={() => setDialog(null)} onDone={() => { load(); unmatched.reload(); }} />}
      {dialog && dialog.kind === 'who' && <WhoIsThisDialog people={people} onClose={() => setDialog(null)} onDone={() => { load(); unmatched.reload(); }} />}
      {dialog && dialog.kind === 'lead' && settings && <LeadDialog leadId={dialog.id} settings={settings} people={people} onClose={() => setDialog(null)} onChanged={load} onVisit={(v) => setDialog({ kind: 'visit', visit: v, back: dialog.id })} />}
      {dialog && dialog.kind === 'visit' && <VisitDialog visit={dialog.visit} people={people} onClose={() => setDialog({ kind: 'lead', id: dialog.back })} onSaved={() => { setToast(tr('Site visit saved.')); setDialog({ kind: 'lead', id: dialog.back }); }} />}
      <Toast text={toast} onDone={() => setToast(null)} />
    </div>
  );
}
