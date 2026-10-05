import { Component, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import ContactButtons from '../../components/ContactButtons';
import { Icon } from '../../components/DashKit';
import { tr } from '../../lib/i18n.jsx';
import { StageTag } from './crmShared';
import { CategoryTag, ChannelDot, CustMark, REASONS, ReasonTag, ago, ghsOr, nextStepText, reasonText } from './crmHubShared';
import './CrmHub.css';

// One customer who needs a follow-up (GET /api/crm/follow-ups/mine): why,
// what to do next, and everything needed to do it without searching —
// numbers, the last message, what they buy, what they owe.

export function FollowUpCard({ item, compact, onOpenProfile, onAfter }) {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  const c = item.customer;
  const l = item.lead;
  const top = item.reasons[0];
  const tone = (REASONS[item.top] || REASONS.quiet).tone;
  const name = c ? c.name : l.name;
  const phone = c ? c.phone : l.phone;
  const email = c ? c.email : l.email;

  // The one button that does the next step.
  let primary = null;
  if (top.type === 'waiting') primary = { label: tr('Reply now'), run: () => navigate('/crminbox?c=' + top.conversationId) };
  else if (top.type === 'overdue') primary = { label: tr('Open the invoice'), run: () => navigate('/invoices?open=' + top.invoiceId) };
  else if (top.type === 'quote') primary = { label: tr('Open the quotation'), run: () => navigate('/quotations?open=' + top.quotationId) };
  else if (top.type === 'lead') primary = { label: tr('Open the lead'), run: () => navigate('/crmleads?lead=' + top.leadId) };

  async function snooze(days) {
    if (!c) return;
    setBusy(true);
    try {
      const d = new Date(); d.setUTCDate(d.getUTCDate() + days);
      await api.put('/crm/profiles/' + c.id + '/follow-up', { on: d.toISOString().slice(0, 10), note: c.followUpNote || '' });
      if (onAfter) onAfter(tr('Next follow-up with {name} set.', { name }));
    } catch (err) { if (onAfter) onAfter(err.message); } finally { setBusy(false); }
  }
  async function done() {
    setBusy(true);
    try { await api.put('/crm/profiles/' + c.id + '/follow-up', { on: null }); if (onAfter) onAfter(tr('Follow-up with {name} done.', { name })); } catch (err) { if (onAfter) onAfter(err.message); } finally { setBusy(false); }
  }

  return (
    <article className={'hub-fu is-' + tone + (compact ? ' is-compact' : '')}>
      <header className="hub-fu-head">
        <CustMark name={name} size={compact ? 36 : 44} />
        <div className="hub-fu-who">
          <button type="button" className="crm-textbtn" onClick={() => (c ? onOpenProfile(c.id) : navigate('/crmleads?lead=' + l.id))}>{name}</button>
          <span className="dk-muted tl-small">{[c ? c.contactPerson : l.company, c ? c.location : l.location, phone].filter(Boolean).join(' · ')}</span>
        </div>
        <div className="hub-fu-tags">
          <ReasonTag type={item.top} />
          {c ? <CategoryTag value={c.category} /> : <StageTag value={l.stage} />}
        </div>
      </header>
      <ul className="hub-fu-reasons">
        {item.reasons.map((r, i) => <li key={i} className={'is-' + (REASONS[r.type] || REASONS.quiet).tone}><Icon name={(REASONS[r.type] || REASONS.quiet).icon} /> <span>{reasonText(r)}</span></li>)}
      </ul>
      <p className="hub-fu-next"><Icon name="arrow" /><span><strong>{tr('Next step:')}</strong> {nextStepText(item)}</span></p>
      {!compact && (
        <div className="hub-fu-facts">
          {c && c.lastMessage && (
            <div className="hub-fu-last">
              <ChannelDot channel={c.lastMessage.channel} />
              <span className="tl-small"><span className="dk-muted">{c.lastMessage.direction === 'in' ? tr('They wrote') : tr('We wrote')} {ago(c.lastMessage.at)}:</span> {c.lastMessage.preview}</span>
            </div>
          )}
          {c && (
            <div className="hub-fu-money tl-small">
              <span><span className="dk-muted">{tr('Bought')}</span> <strong>{ghsOr(c.lifetime)}</strong></span>
              <span className={c.outstanding > 0 ? 'is-bad' : ''}><span className="dk-muted">{tr('Owes')}</span> <strong>{ghsOr(c.outstanding)}</strong></span>
              {c.interests.length > 0 && <span><span className="dk-muted">{tr('Buys or asks about')}</span> {c.interests.join(', ')}</span>}
            </div>
          )}
          {l && <p className="tl-small">{l.item ? <><span className="dk-muted">{tr('Wants:')}</span> {l.item}</> : null}{l.comments ? <span className="dk-muted"> · {l.comments}</span> : null}</p>}
          {c && c.identities.length > 0 && <div className="crm-chips">{c.identities.slice(0, 5).map((i) => <span key={i.kind + i.value} className="hub-ident-chip">{i.label || i.value}</span>)}</div>}
        </div>
      )}
      <footer className="hub-fu-acts">
        {primary && <button type="button" className="btn btn-primary" onClick={primary.run}>{primary.label}</button>}
        <ContactButtons name={name} phone={phone} email={email} />
        {c && <button type="button" className="btn btn-secondary" onClick={() => onOpenProfile(c.id)}>{tr('Profile')}</button>}
        {!compact && c && can('crm.manage') && top.type === 'planned' && <button type="button" className="dk-link" disabled={busy} onClick={done}><Icon name="check" /> {tr('Done')}</button>}
        {!compact && c && can('crm.manage') && <button type="button" className="dk-link" disabled={busy} onClick={() => snooze(7)}>{tr('Again in a week')}</button>}
      </footer>
    </article>
  );
}

// The window must never get in the way: if it fails, it just isn't shown.
class Quietly extends Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error) { console.error('Follow-ups window:', error); }
  render() { return this.state.failed ? null : this.props.children; }
}
export function FollowUpsAtSignIn() { return <Quietly><FollowUpsWelcome /></Quietly>; }

// Shown once per sign-in to anyone with customers to follow up today.
const SEEN_KEY = 'bamboo.crm.followups.seen';
export function FollowUpsWelcome() {
  const navigate = useNavigate();
  const { session, can } = useAuth();
  const [data, setData] = useState(null);
  const empId = session && session.employee ? session.employee.id : null;
  const allowed = can('crm.read') && !!empId;

  useEffect(() => {
    if (!allowed) return;
    let seen = null;
    try { seen = sessionStorage.getItem(SEEN_KEY); } catch { /* storage blocked: show it */ }
    if (seen === empId) return;
    api.get('/crm/follow-ups/mine').then((x) => {
      try { sessionStorage.setItem(SEEN_KEY, empId); } catch { /* not kept */ }
      if (x && x.total > 0) setData(x);
    }).catch(() => {});
  }, [allowed, empId]);

  if (!data) return null;
  const close = () => setData(null);
  const first = session.employee.firstName || session.employee.first_name || '';
  const hour = new Date().getHours();
  const hello = hour < 12 ? tr('Good morning, {name}.', { name: first }) : hour < 17 ? tr('Good afternoon, {name}.', { name: first }) : tr('Good evening, {name}.', { name: first });
  const waiting = data.counts.waiting || 0;
  return (
    <div className="dialog-backdrop hub-welcome-back" onClick={close}>
      <div className="dialog hub-welcome" role="dialog" aria-modal="true" aria-labelledby="hub-w-t" onClick={(e) => e.stopPropagation()}>
        <header className="hub-welcome-head">
          <span className="hub-welcome-icon"><Icon name="people" /></span>
          <div>
            <p className="eyebrow">{hello}</p>
            <h2 id="hub-w-t">{data.total === 1 ? tr('1 customer needs you today') : tr('{n} customers need you today', { n: data.total })}</h2>
            <p className="dk-muted">{waiting ? tr('{n} of them wrote and are waiting for a reply — start there.', { n: waiting }) : tr('Most urgent first. Each card says why and what to do next.')}</p>
          </div>
          <button type="button" className="crm-x" onClick={close} aria-label={tr('Close')}>✕</button>
        </header>
        <div className="hub-welcome-counts">
          {['waiting', 'planned', 'overdue', 'quote', 'lead', 'quiet'].filter((k) => data.counts[k]).map((k) => <span key={k} className={'hub-reason is-' + REASONS[k].tone}><Icon name={REASONS[k].icon} /> {tr(REASONS[k].label)} <strong>{data.counts[k]}</strong></span>)}
        </div>
        <div className="hub-welcome-list">
          {data.items.slice(0, 4).map((it, i) => <FollowUpCard key={i} item={it} compact onOpenProfile={(id) => { close(); navigate('/crmcustomers?id=' + id); }} />)}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={close}>{tr('Later')}</button>
          <button type="button" className="btn btn-primary" onClick={() => { close(); navigate('/crmfollowups'); }}>{data.total > 4 ? tr('See all {n}', { n: data.total }) : tr('Open my follow-ups')}</button>
        </div>
      </div>
    </div>
  );
}
