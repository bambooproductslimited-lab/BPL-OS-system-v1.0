import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Empty, Glossary, Icon, Section } from '../../components/DashKit';
import Photo from '../../components/Photo';
import { msg, tr } from '../../lib/i18n.jsx';
import CustomerProfile from './CustomerProfile';
import { FollowUpCard } from './FollowUps';
import { REASONS, REASON_ORDER, ghsOr, useReps } from './crmHubShared';
import { Confetti, Ring, greeting } from './crmFun';
import { Toast } from './crmShared';
import '../EmployeesPage.css';
import '../ToolRoomPage.css';
import './CrmPage.css';
import './CrmHub.css';
import './CrmInbox.css';

// Who needs a follow-up today (GET /api/crm/follow-ups/mine), most urgent
// first: customers waiting for a reply, follow-ups that have come,
// overdue payments, unanswered quotations, leads due, buyers gone quiet.
// Sales managers (crm.assign) can look at any rep's list (?rep=) and see
// the customers who need someone but have no rep.
//
// Made a game of the day: a banner with the day's points against the goal
// and the streak (the sales board's, GET /api/crm/board/day); the list in
// three lanes by how soon (right now, today, keep in touch); and "Start my
// round", one customer at a time until the list is done — with confetti.

const LANES = [
  { key: 'now', types: ['waiting', 'overdue'], title: msg('Right now'), sub: msg('Waiting for a reply, or money overdue') },
  { key: 'today', types: ['planned', 'quote', 'lead'], title: msg('Today'), sub: msg('Follow-ups due, quotations, leads') },
  { key: 'keep', types: ['quiet'], title: msg('Keep in touch'), sub: msg('Good customers gone quiet') }
];

export default function CrmFollowUpsPage() {
  const navigate = useNavigate();
  const { can, session } = useAuth();
  const canAssign = can('crm.assign');
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [day, setDay] = useState(null);
  const [team, setTeam] = useState(null);
  const [error, setError] = useState(null);
  const [profile, setProfile] = useState(null);
  const [toast, setToast] = useState(null);
  const [round, setRound] = useState(null); // { at, handled, of }
  const [burst, setBurst] = useState(0);
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
    api.get('/crm/board/day' + (repF && canAssign ? '?rep=' + encodeURIComponent(repF) : '')).then(setDay).catch(() => setDay(null));
  }, [repF, canAssign]);
  useEffect(() => { load(); }, [load]);

  function after(text, kind) {
    setToast(text);
    if (kind === 'done') setBurst(Date.now());
    if (round && (kind === 'done' || kind === 'snooze')) setRound((r) => r && { ...r, handled: r.handled + 1 });
    load();
  }

  if (!data) return <div className="dk">{error ? <div className="error-banner">{error}</div> : <div className="eyebrow">{tr('Loading…')}</div>}</div>;
  const items = data.items.filter((i) => !typeF || i.top === typeF);
  const owed = data.items.reduce((a, i) => a + i.reasons.filter((r) => r.type === 'overdue').reduce((b, r) => b + (r.amount || 0), 0), 0);
  const quotes = data.items.reduce((a, i) => a + i.reasons.filter((r) => r.type === 'quote').reduce((b, r) => b + (r.amount || 0), 0), 0);
  const withReason = (k) => data.items.filter((i) => i.reasons.some((r) => r.type === k)).length;
  const meId = session && session.employee ? session.employee.id : null;
  const mineTeam = team ? team.reps.find((r) => r.rep && r.rep.id === meId) : null;
  const repName = repF ? ((reps.find((r) => r.id === repF) || {}).name || '') : null;
  const meName = session && session.employee ? session.employee.firstName || session.employee.first_name : '';
  const waiting = data.counts.waiting || 0;
  const teamMax = team ? Math.max(1, ...team.reps.map((r) => r.total)) : 1;
  const met = day && day.today >= day.goal;

  let line;
  if (!data.total) line = repName ? tr('Nobody needs {name} right now.', { name: repName }) : tr('Nobody needs a follow-up right now. Well done.');
  else if (waiting) line = data.total === 1 ? tr('1 customer needs you today, and is waiting for a reply — start there.') : tr('{n} customers need you today. {w} wrote and are waiting for a reply — start there.', { n: data.total, w: waiting });
  else line = data.total === 1 ? tr('1 customer needs you today. The card says why and what to do next.') : tr('{n} customers need you today, most urgent first. Each card says why and what to do next.', { n: data.total });

  return (
    <div className="dk crm hub fx">
      <Confetti burst={burst} />
      {error && <div className="error-banner" role="alert">{error}</div>}

      <section className="fx-hero">
        <span className="fx-hero-glow" aria-hidden="true" />
        <div className="fx-hero-main">
          <p className="fx-eyebrow">{tr('Sales & CRM')} · {repName ? tr('{name}\'s follow-ups', { name: repName }) : tr('My follow-ups')}</p>
          <h1 className="fx-hero-title">{repName ? tr('{name}\'s follow-ups', { name: repName }) : greeting(meName)}</h1>
          <p className="fx-hero-sub">{line}</p>
          <div className="fx-hero-actions">
            {items.length > 0 && <button type="button" className="fx-btn is-primary" onClick={() => setRound({ at: 0, handled: 0, of: items.length })}><Icon name="arrow" /> {repName ? tr('Go through the list') : tr('Start my round')}</button>}
            <button type="button" className="fx-btn is-ghost" onClick={() => navigate('/crminbox?waiting=1' + (repF ? '' : '&mine=1'))}><Icon name="send" /> {tr('Inbox')}</button>
            <button type="button" className="fx-btn is-ghost" onClick={() => navigate('/crmcustomers' + (repF ? '?rep=' + repF : '?rep=me'))}>{repName ? tr('Their customers') : tr('My customers')}</button>
          </div>
        </div>
        <div className="fx-hero-side">
          {day && (
            <div className="fx-goal">
              <Ring value={day.today} max={day.goal} size={128} stroke={12} tone={met ? 'good' : ''}>
                <strong>{day.today}</strong>
                <small>{tr('of {n} points', { n: day.goal })}</small>
              </Ring>
              <span className="fx-goal-cap">{met ? tr('Today\'s goal reached!') : tr('{n} points to today\'s goal', { n: day.goal - day.today })}</span>
              <span className={'fx-streak' + (day.streak ? ' is-on' : '')}>{day.streak ? '🔥 ' + (day.streak === 1 ? tr('1 day in a row') : tr('{n} days in a row', { n: day.streak })) : tr('Reach the goal to start a streak')}</span>
              {day.rank && <span className="fx-rank">{tr('#{rank} of {of} this week', { rank: day.rank, of: day.of })}</span>}
            </div>
          )}
          <div className="fx-tiles">
            <button type="button" className={'fx-tile' + (!typeF ? ' is-on' : '')} onClick={() => setParam('type', '')}>
              <span className="fx-tile-label">{tr('customers to follow up')}</span>
              <span className="fx-tile-value">{data.total}</span>
              <span className="fx-tile-note">{meName && !repName ? tr('for {name}', { name: meName }) : tr('most urgent first')}</span>
            </button>
            <button type="button" className={'fx-tile' + (waiting ? ' is-alert' : '') + (typeF === 'waiting' ? ' is-on' : '')} onClick={() => setParam('type', typeF === 'waiting' ? '' : 'waiting')}>
              <span className="fx-tile-label">{tr('waiting for a reply')}</span>
              <span className="fx-tile-value">{waiting}</span>
              <span className="fx-tile-note">{tr('answer these first')}</span>
            </button>
            <button type="button" className={'fx-tile' + (typeF === 'overdue' ? ' is-on' : '')} onClick={() => setParam('type', typeF === 'overdue' ? '' : 'overdue')}>
              <span className="fx-tile-label">{tr('overdue payments')}</span>
              <span className="fx-tile-value is-money">{ghsOr(owed)}</span>
              <span className="fx-tile-note">{tr('{n} customers', { n: withReason('overdue') })}</span>
            </button>
            <button type="button" className={'fx-tile' + (typeF === 'quote' ? ' is-on' : '')} onClick={() => setParam('type', typeF === 'quote' ? '' : 'quote')}>
              <span className="fx-tile-label">{tr('in quotations not answered')}</span>
              <span className="fx-tile-value is-money">{ghsOr(quotes)}</span>
              <span className="fx-tile-note">{tr('{n} customers', { n: withReason('quote') })}</span>
            </button>
          </div>
        </div>
      </section>

      {canAssign && team && (
        <Section id="hub-team" title={tr('The team')} sub={tr('How many customers each rep should get back to. Press a rep to see their list.')}>
          <div className="fx-team">
            <button type="button" className={'fx-rep' + (!repF ? ' is-on' : '')} onClick={() => setParam('rep', '')}>
              <span className="fx-rep-av"><Icon name="people" /></span>
              <span className="fx-rep-main">
                <strong>{tr('Mine')}</strong>
                <small className={mineTeam && mineTeam.waiting ? 'is-bad' : 'dk-muted'}>{tr('{n} to follow up', { n: mineTeam ? mineTeam.total : !repF ? data.total : 0 })}{mineTeam && mineTeam.waiting ? ' · ' + tr('{n} waiting', { n: mineTeam.waiting }) : ''}</small>
                <span className="fx-rep-bar"><span style={{ width: ((mineTeam ? mineTeam.total : 0) / teamMax * 100) + '%' }} /></span>
              </span>
            </button>
            {team.reps.filter((r) => r.rep && r.rep.id !== meId).sort((a, b) => b.total - a.total).map((r) => {
              const rp = reps.find((x) => x.id === r.rep.id);
              return (
                <button key={r.rep.id} type="button" className={'fx-rep' + (repF === r.rep.id ? ' is-on' : '')} onClick={() => setParam('rep', r.rep.id)}>
                  <span className="fx-rep-photo"><Photo id={r.rep.id} name={r.rep.name} photo={rp ? rp.photo : null} size={40} />{r.waiting > 0 && <span className="fx-rep-badge">{r.waiting}</span>}</span>
                  <span className="fx-rep-main">
                    <strong>{r.rep.name}</strong>
                    <small className={r.waiting ? 'is-bad' : 'dk-muted'}>{tr('{n} to follow up', { n: r.total })}{r.waiting ? ' · ' + tr('{n} waiting', { n: r.waiting }) : ''}</small>
                    <span className="fx-rep-bar"><span style={{ width: (r.total / teamMax * 100) + '%' }} /></span>
                  </span>
                </button>
              );
            })}
            {team.unassigned.length > 0 && (
              <button type="button" className="fx-rep is-warn" onClick={() => navigate('/crmhealth#reps')}>
                <span className="fx-rep-av"><Icon name="warn" /></span>
                <span className="fx-rep-main"><strong>{tr('No rep')}</strong><small className="is-bad">{tr('{n} need someone', { n: team.unassigned.length })}</small></span>
              </button>
            )}
          </div>
        </Section>
      )}

      <Section id="hub-fus" title={tr('Who to get back to')} sub={tr('{n} shown.', { n: items.length })}>
        <div className="fx-chips" role="radiogroup" aria-label={tr('Why')}>
          <button type="button" role="radio" aria-checked={!typeF} className={'fx-chip' + (!typeF ? ' is-on' : '')} onClick={() => setParam('type', '')}>{tr('All')} <span className="fx-chip-n">{data.total}</span></button>
          {REASON_ORDER.filter((k) => data.counts[k]).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={typeF === k} className={'fx-chip is-' + REASONS[k].tone + (typeF === k ? ' is-on' : '')} onClick={() => setParam('type', typeF === k ? '' : k)}><Icon name={REASONS[k].icon} /> {tr(REASONS[k].label)} <span className="fx-chip-n">{data.counts[k]}</span></button>
          ))}
        </div>
        {items.length ? (
          <div className="fx-lanes">
            {LANES.map((lane) => {
              const list = items.filter((it) => lane.types.includes(it.top));
              if (typeF && !list.length) return null;
              return (
                <section key={lane.key} className={'fx-lane is-' + lane.key} aria-label={tr(lane.title)}>
                  <header className="fx-lane-head">
                    <span className="fx-lane-dot" aria-hidden="true" />
                    <div><h3>{tr(lane.title)}</h3><small className="dk-muted">{tr(lane.sub)}</small></div>
                    <span className="fx-lane-n">{list.length}</span>
                  </header>
                  {list.length ? list.map((it, i) => <FollowUpCard key={(it.customer ? it.customer.id : it.lead.id) + i} item={it} onOpenProfile={setProfile} onAfter={after} />)
                    : <p className="fx-lane-empty">✓ {tr('Nothing here.')}</p>}
                </section>
              );
            })}
          </div>
        ) : (
          <div className="fx-clear">
            <span className="fx-clear-art" aria-hidden="true">🎉</span>
            <h3>{data.total ? tr('Nobody for this reason.') : tr('All clear!')}</h3>
            <p className="dk-muted">{data.total ? tr('Choose another reason above.') : tr('Nobody needs a follow-up right now. A good moment to call a quiet customer or find new leads.')}</p>
          </div>
        )}
      </Section>

      <Glossary items={REASON_ORDER.map((k) => [tr(REASONS[k].label), {
        waiting: tr('The customer wrote on a channel more than 2 hours ago and nobody has answered.'),
        planned: tr('A follow-up date set on the profile has come.'),
        overdue: tr('An invoice is past its due date with money still owed.'),
        quote: tr('A quotation was sent 3 or more days ago with no answer, or it is about to expire.'),
        lead: tr('A lead of theirs has its follow-up date today or earlier.'),
        quiet: tr('A buying customer nobody has been in touch with for 45 days.')
      }[k]]).concat([
        [tr('Points'), tr('Calls, replies, notes, stage moves, quotations and wins logged in the OS, as on the sales board. The daily goal is the same too.')],
        [tr('Your round'), tr('One customer at a time, most urgent first. Done or "again tomorrow" moves on to the next by itself.')]
      ])} />

      {round && <RoundDialog round={round} items={items} onMove={(at) => setRound((r) => ({ ...r, at }))} onClose={() => setRound(null)} onOpenProfile={(id) => { setRound(null); setProfile(id); }} onAfter={after} onFinish={() => setBurst(Date.now())} />}
      {profile && <CustomerProfile id={profile} reps={reps} onClose={() => setProfile(null)} onChanged={load} />}
      <Toast text={toast} onDone={() => setToast(null)} />
    </div>
  );
}

// "Start my round": one customer at a time. Done and "again …" take the
// customer off the list, so the same place shows the next one.
function RoundDialog({ round, items, onMove, onClose, onOpenProfile, onAfter, onFinish }) {
  const at = Math.min(round.at, items.length);
  const finished = at >= items.length;
  const shown = Math.min(round.handled + at + 1, round.of);
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight' && !finished) onMove(at + 1);
      else if (e.key === 'ArrowLeft' && at > 0) onMove(at - 1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [at, finished, onMove, onClose]);
  useEffect(() => { if (finished) onFinish(); }, [finished]); // eslint-disable-line react-hooks/exhaustive-deps
  const it = items[at];
  return (
    <div className="dialog-backdrop fx-round-back" onClick={onClose}>
      <div className="dialog fx-round" role="dialog" aria-modal="true" aria-labelledby="fx-round-t" onClick={(e) => e.stopPropagation()}>
        <header className="fx-round-head">
          <div>
            <p className="eyebrow">{tr('Your round')}</p>
            <h2 id="fx-round-t">{finished ? tr('Round done!') : tr('Customer {n} of {of}', { n: shown, of: round.of })}</h2>
          </div>
          <button type="button" className="crm-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </header>
        <div className="fx-round-bar" aria-hidden="true"><span style={{ width: (finished ? 100 : (shown - 1) / Math.max(1, round.of) * 100) + '%' }} /></div>
        {finished ? (
          <div className="fx-clear">
            <span className="fx-clear-art" aria-hidden="true">🏁</span>
            <h3>{round.handled ? tr('You handled {n} of {of} customers. Great work!', { n: round.handled, of: round.of }) : tr('You went through all {n}.', { n: round.of })}</h3>
            <p className="dk-muted">{tr('Calls and replies you logged count toward today\'s points.')}</p>
            <button type="button" className="fx-btn is-primary" onClick={onClose}>{tr('Close')}</button>
          </div>
        ) : (
          <>
            <FollowUpCard key={(it.customer ? it.customer.id : it.lead.id) + at} item={it} onOpenProfile={onOpenProfile} onAfter={onAfter} />
            <footer className="fx-round-foot">
              <button type="button" className="fx-btn is-soft" disabled={at === 0} onClick={() => onMove(at - 1)}>← {tr('Back')}</button>
              <span className="dk-muted tl-small">{tr('← → to move, Esc to stop')}</span>
              <button type="button" className="fx-btn is-soft" onClick={() => onMove(at + 1)}>{at + 1 < items.length ? tr('Next') : tr('Finish')} →</button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
