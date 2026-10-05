import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Empty, Glossary, Hero, Icon, Section } from '../../components/DashKit';
import Photo from '../../components/Photo';
import { tr } from '../../lib/i18n.jsx';
import CustomerProfile from './CustomerProfile';
import { FollowUpCard } from './FollowUps';
import { REASONS, REASON_ORDER, ghsOr, useReps } from './crmHubShared';
import { Toast } from './crmShared';
import '../EmployeesPage.css';
import '../ToolRoomPage.css';
import './CrmPage.css';
import './CrmHub.css';

// Who needs a follow-up today (GET /api/crm/follow-ups/mine), most urgent
// first: customers waiting for a reply, follow-ups that have come,
// overdue payments, unanswered quotations, leads due, buyers gone quiet.
// Sales managers (crm.assign) can look at any rep's list (?rep=) and see
// the customers who need someone but have no rep.

export default function CrmFollowUpsPage() {
  const navigate = useNavigate();
  const { can, session } = useAuth();
  const canAssign = can('crm.assign');
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [team, setTeam] = useState(null);
  const [error, setError] = useState(null);
  const [profile, setProfile] = useState(null);
  const [toast, setToast] = useState(null);
  const { reps } = useReps();
  const repF = params.get('rep') || '';
  const typeF = params.get('type') || '';
  function setParam(k, v) { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p, { replace: true }); }

  const load = useCallback(async () => {
    try {
      setData(await api.get(repF && canAssign ? '/crm/follow-ups/team?rep=' + encodeURIComponent(repF) : '/crm/follow-ups/mine'));
      if (canAssign) setTeam(await api.get('/crm/follow-ups/team'));
      setError(null);
    } catch (err) { setError(err.message); }
  }, [repF, canAssign]);
  useEffect(() => { load(); }, [load]);

  if (!data) return <div className="dk">{error ? <div className="error-banner">{error}</div> : <div className="eyebrow">{tr('Loading…')}</div>}</div>;
  const items = data.items.filter((i) => !typeF || i.top === typeF);
  const owed = data.items.reduce((a, i) => a + i.reasons.filter((r) => r.type === 'overdue').reduce((b, r) => b + (r.amount || 0), 0), 0);
  const quotes = data.items.reduce((a, i) => a + i.reasons.filter((r) => r.type === 'quote').reduce((b, r) => b + (r.amount || 0), 0), 0);
  const withReason = (k) => data.items.filter((i) => i.reasons.some((r) => r.type === k)).length;
  const meId = session && session.employee ? session.employee.id : null;
  const mineTeam = team ? team.reps.find((r) => r.rep && r.rep.id === meId) : null;
  const repName = repF ? ((reps.find((r) => r.id === repF) || {}).name || '') : null;
  const meName = session && session.employee ? session.employee.firstName : '';

  return (
    <div className="dk crm hub">
      {error && <div className="error-banner" role="alert">{error}</div>}
      <Hero eyebrow={tr('Sales & CRM')} title={repName ? tr('{name}\'s follow-ups', { name: repName }) : tr('My follow-ups')}
        sub={repName ? tr('The customers {name} should get back to, most urgent first.', { name: repName }) : tr('The customers you should get back to today, most urgent first. Each says why, what to do next, and how to reach them.')}
        actions={<>
          <button type="button" className="btn btn-secondary" onClick={() => navigate('/crminbox?waiting=1' + (repF ? '' : '&mine=1'))}>{tr('Inbox')}</button>
          <button type="button" className="btn btn-secondary" onClick={() => navigate('/crmcustomers' + (repF ? '?rep=' + repF : '?rep=me'))}>{repName ? tr('Their customers') : tr('My customers')}</button>
        </>}
        stats={[
          { icon: 'people', value: String(data.total), label: tr('customers to follow up'), note: meName && !repName ? tr('for {name}', { name: meName }) : null, onClick: () => setParam('type', '') },
          { icon: 'send', value: String(data.counts.waiting || 0), label: tr('waiting for a reply'), note: tr('answer these first'), tone: data.counts.waiting ? 'alert' : 'good', onClick: () => setParam('type', 'waiting') },
          { icon: 'owed', value: ghsOr(owed), label: tr('overdue payments'), note: tr('{n} customers', { n: withReason('overdue') }), tone: owed ? 'bad' : '', onClick: () => setParam('type', 'overdue') },
          { icon: 'doc', value: ghsOr(quotes), label: tr('in quotations not answered'), note: tr('{n} customers', { n: withReason('quote') }), onClick: () => setParam('type', 'quote') }
        ]} />

      {canAssign && team && (
        <Section id="hub-team" title={tr('The team')} sub={tr('How many customers each rep should get back to. Press a rep to see their list.')}>
          <div className="hub-team">
            <button type="button" className={'hub-team-rep' + (!repF ? ' is-on' : '')} onClick={() => setParam('rep', '')}>
              <span className="hub-team-av"><Icon name="people" /></span>
              <span><strong>{tr('Mine')}</strong><small className={mineTeam && mineTeam.waiting ? 'is-bad' : 'dk-muted'}>{tr('{n} to follow up', { n: mineTeam ? mineTeam.total : !repF ? data.total : 0 })}{mineTeam && mineTeam.waiting ? ' · ' + tr('{n} waiting', { n: mineTeam.waiting }) : ''}</small></span>
            </button>
            {team.reps.filter((r) => r.rep && r.rep.id !== meId).sort((a, b) => b.total - a.total).map((r) => {
              const rp = reps.find((x) => x.id === r.rep.id);
              return (
                <button key={r.rep.id} type="button" className={'hub-team-rep' + (repF === r.rep.id ? ' is-on' : '')} onClick={() => setParam('rep', r.rep.id)}>
                  <Photo id={r.rep.id} name={r.rep.name} photo={rp ? rp.photo : null} size={36} />
                  <span><strong>{r.rep.name}</strong><small className={r.waiting ? 'is-bad' : 'dk-muted'}>{tr('{n} to follow up', { n: r.total })}{r.waiting ? ' · ' + tr('{n} waiting', { n: r.waiting }) : ''}</small></span>
                </button>
              );
            })}
            {team.unassigned.length > 0 && (
              <button type="button" className="hub-team-rep is-warn" onClick={() => navigate('/crmhealth#reps')}>
                <span className="hub-team-av"><Icon name="warn" /></span>
                <span><strong>{tr('No rep')}</strong><small className="is-bad">{tr('{n} need someone', { n: team.unassigned.length })}</small></span>
              </button>
            )}
          </div>
        </Section>
      )}

      <Section id="hub-fus" title={tr('Who to get back to')} sub={tr('{n} shown.', { n: items.length })}>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Why')}>
          <button type="button" role="radio" aria-checked={!typeF} className={'ppl-chip' + (!typeF ? ' is-on' : '')} onClick={() => setParam('type', '')}>{tr('All')} <span className="ppl-chip-n">{data.total}</span></button>
          {REASON_ORDER.filter((k) => data.counts[k]).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={typeF === k} className={'ppl-chip' + (typeF === k ? ' is-on' : '')} onClick={() => setParam('type', k)}><Icon name={REASONS[k].icon} /> {tr(REASONS[k].label)} <span className="ppl-chip-n">{data.counts[k]}</span></button>
          ))}
        </div>
        {items.length ? (
          <div className="hub-fus">{items.map((it, i) => <FollowUpCard key={(it.customer ? it.customer.id : it.lead.id) + i} item={it} onOpenProfile={setProfile} onAfter={(t) => { setToast(t); load(); }} />)}</div>
        ) : <Empty icon="check">{data.total ? tr('Nobody for this reason.') : tr('Nobody needs a follow-up right now. Well done.')}</Empty>}
      </Section>

      <Glossary items={REASON_ORDER.map((k) => [tr(REASONS[k].label), {
        waiting: tr('The customer wrote on a channel more than 2 hours ago and nobody has answered.'),
        planned: tr('A follow-up date set on the profile has come.'),
        overdue: tr('An invoice is past its due date with money still owed.'),
        quote: tr('A quotation was sent 3 or more days ago with no answer, or it is about to expire.'),
        lead: tr('A lead of theirs has its follow-up date today or earlier.'),
        quiet: tr('A buying customer nobody has been in touch with for 45 days.')
      }[k]])} />

      {profile && <CustomerProfile id={profile} reps={reps} onClose={() => setProfile(null)} onChanged={load} />}
      <Toast text={toast} onDone={() => setToast(null)} />
    </div>
  );
}
