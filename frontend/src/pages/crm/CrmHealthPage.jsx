import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Empty, Glossary, Hero, Icon, Insights, Section, Status, fmtDate, jump } from '../../components/DashKit';
import { tr } from '../../lib/i18n.jsx';
import CustomerProfile from './CustomerProfile';
import { CategoryTag, ChannelDot, CustMark, RepSelect, ago, channelLabel, dupReasonText, useReps } from './crmHubShared';
import { Toast } from './crmShared';
import '../EmployeesPage.css';
import '../ToolRoomPage.css';
import './CrmPage.css';
import './CrmHub.css';

// Keeping the customer list clean and covered:
//  - profiles that look like one customer (GET /api/crm/duplicates), side
//    by side, with the OS's suggestion: merge them, delete the empty one,
//    or edit them apart; or say they aren't the same;
//  - customers with no sales rep (GET /api/crm/coverage), each with the rep
//    the OS suggests and why; give them all at once or one by one;
//  - the channels the CRM reads (GET /api/crm/channels), and how to connect
//    the ones that aren't.

const SUGGESTION = {
  merge: { label: () => tr('Merge them'), tone: 'good', help: () => tr('They look like one customer. Merging moves everything onto one profile.') },
  delete: { label: () => tr('Delete the empty one'), tone: 'warn', help: () => tr('One of the two has nothing on it at all.') },
  edit: { label: () => tr('Tell them apart'), tone: 'info', help: () => tr('A nearly identical name but different numbers: probably two people. Edit the names so they can be told apart, or fix a typo.') }
};
function usedTotal(u) { return u.invoices + u.quotations + u.orders + u.conversations + u.leads; }
function whyText(s) {
  if (!s) return '';
  switch (s.whyKey) {
    case 'lead': return tr('works their lead');
    case 'documents': return tr('made their last quotation or order');
    case 'replies': return tr('has been answering them');
    case 'least': return tr('has the fewest customers ({n})', { n: s.load });
    default: return s.why || '';
  }
}

export default function CrmHealthPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { can } = useAuth();
  const canManage = can('crm.manage');
  const canAssign = can('crm.assign');
  const [params] = useSearchParams();
  const [dups, setDups] = useState(null);
  const [cover, setCover] = useState(null);
  const [channels, setChannels] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [keep, setKeep] = useState({});
  const [picks, setPicks] = useState({});
  const [profile, setProfile] = useState(null);
  const [toast, setToast] = useState(null);
  const { reps, reload: reloadReps } = useReps();
  const pairF = params.get('pair');

  const load = useCallback(async () => {
    try {
      const [d, c, ch] = await Promise.all([api.get('/crm/duplicates'), api.get('/crm/coverage'), api.get('/crm/channels')]);
      setDups(d); setCover(c); setChannels(ch); setError(null);
    } catch (err) { setError(err.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (dups && location.hash) setTimeout(() => jump(location.hash.slice(1)), 60); }, [dups, location.hash]);

  async function act(key, fn, done) {
    setBusy(key); setError(null);
    try { await fn(); if (done) setToast(done); await load(); reloadReps(); } catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  if (!dups || !cover) return <div className="dk">{error ? <div className="error-banner">{error}</div> : <div className="eyebrow">{tr('Loading…')}</div>}</div>;
  const shownDups = pairF ? dups.filter((d) => d.id === pairF).concat(dups.filter((d) => d.id !== pairF)) : dups;
  const merges = dups.filter((d) => d.suggestion === 'merge').length;
  const waitingNoRep = cover.filter((c) => c.waiting > 0).length;
  const conn = channels ? [
    { key: 'whatsapp', ok: channels.whatsapp.configured },
    { key: 'email', ok: channels.email.configured },
    { key: 'facebook', ok: channels.meta.facebook.connected && channels.meta.facebook.messages },
    { key: 'instagram', ok: channels.meta.instagram.connected && channels.meta.instagram.messages }
  ] : [];

  const insights = [];
  if (waitingNoRep) insights.push({ tone: 'bad', icon: 'send', text: tr('{n} customers with no rep are waiting for a reply. Nobody will answer them until they have one.', { n: waitingNoRep }), action: { label: tr('Give them reps'), run: () => jump('reps') } });
  if (cover.length) insights.push({ tone: 'warn', icon: 'people', text: tr('{n} customers have no sales rep. The OS has suggested one for each.', { n: cover.length }), action: canAssign ? { label: tr('Give each to the suggested rep'), run: () => act('all', () => api.post('/crm/coverage/assign-suggested', {}), tr('Customers given to their suggested reps.')) } : null });
  if (merges) insights.push({ tone: 'info', icon: 'layers', text: tr('{n} pairs of profiles look like one customer.', { n: merges }), action: { label: tr('Check them'), run: () => jump('dups') } });
  if (channels && conn.some((c) => !c.ok)) insights.push({ tone: 'info', icon: 'phone', text: tr('{n} of 4 channels are connected. Messages on the others don\'t reach the CRM yet.', { n: conn.filter((c) => c.ok).length }), action: { label: tr('See how'), run: () => jump('channels') } });

  return (
    <div className="dk crm hub">
      {error && <div className="error-banner" role="alert">{error}</div>}
      <Hero eyebrow={tr('Sales & CRM')} title={tr('Data health')}
        sub={tr('Keeps the customer list clean and covered: one profile per customer, a sales rep for everyone who needs one, and every channel flowing in. The OS checks every hour and tells the sales managers each morning when customers have no rep.')}
        actions={canManage && <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => act('scan', () => api.post('/crm/duplicates/scan'), tr('Checked again.'))}><Icon name="eye" /> {busy === 'scan' ? tr('Checking…') : tr('Check for duplicates now')}</button>}
        stats={[
          { icon: 'layers', value: String(dups.length), label: tr('possible duplicates'), note: tr('{n} look like one customer', { n: merges }), tone: dups.length ? 'bad' : 'good', onClick: () => jump('dups') },
          { icon: 'people', value: String(cover.length), label: tr('customers with no rep'), note: tr('{n} are waiting for a reply', { n: waitingNoRep }), tone: waitingNoRep ? 'alert' : cover.length ? 'bad' : 'good', onClick: () => jump('reps') },
          { icon: 'phone', value: channels ? conn.filter((c) => c.ok).length + ' / 4' : '…', label: tr('channels connected'), note: tr('WhatsApp, email, Facebook, Instagram'), onClick: () => jump('channels') }
        ]} />

      <Insights items={insights} />

      <Section id="dups" title={tr('Profiles that look like one customer')} sub={tr('Side by side, with what they have in common. Nothing changes until you choose.')}>
        {shownDups.length ? (
          <div className="hub-dups">
            {shownDups.map((d) => {
              const sg = SUGGESTION[d.suggestion] || SUGGESTION.merge;
              const keepId = keep[d.id] || d.keepId;
              const sides = [d.a, d.b];
              const kept = sides.find((x) => x.id === keepId);
              const dropped = sides.find((x) => x.id !== keepId);
              const empty = sides.find((x) => usedTotal(x.used) === 0);
              return (
                <article key={d.id} className={'hub-dup-card' + (pairF === d.id ? ' is-focus' : '')}>
                  <header className="hub-dup-head">
                    <span className="hub-score" title={tr('How sure the OS is')}><strong>{d.score}</strong>%</span>
                    <div>
                      <p className="hub-dup-reasons">{d.reasons.map(dupReasonText).join(' · ')}</p>
                      <p className="dk-muted tl-small"><Status tone={sg.tone}>{tr('Suggested:')} {sg.label()}</Status> {sg.help()}</p>
                    </div>
                  </header>
                  <div className="hub-dup-sides">
                    {sides.map((x) => (
                      <label key={x.id} className={'hub-side' + (x.id === keepId ? ' is-keep' : ' is-drop')}>
                        <input type="radio" name={'keep-' + d.id} checked={x.id === keepId} onChange={() => setKeep({ ...keep, [d.id]: x.id })} disabled={!canManage} />
                        <span className="hub-side-badge">{x.id === keepId ? tr('Keep') : tr('Fold in')}</span>
                        <span className="hub-side-top"><CustMark name={x.name} size={34} /><span><strong>{x.name}</strong><CategoryTag value={x.category} /></span></span>
                        <dl className="hub-side-facts">
                          <div><dt>{tr('Phone')}</dt><dd>{x.phone || '—'}</dd></div>
                          <div><dt>{tr('Email')}</dt><dd>{x.email || '—'}</dd></div>
                          <div><dt>{tr('Location')}</dt><dd>{x.location || '—'}</dd></div>
                          <div><dt>{tr('Rep')}</dt><dd>{x.rep ? x.rep.name : '—'}</dd></div>
                          <div><dt>{tr('Came from')}</dt><dd>{x.origin ? channelLabel(x.origin) : x.source || '—'} · {fmtDate(x.createdAt)}</dd></div>
                          <div><dt>{tr('On it')}</dt><dd>{usedTotal(x.used) ? tr('{i} invoices, {q} quotations, {o} orders, {c} conversations, {l} leads', { i: x.used.invoices, q: x.used.quotations, o: x.used.orders, c: x.used.conversations, l: x.used.leads }) : tr('Nothing — an empty profile')}</dd></div>
                        </dl>
                        <button type="button" className="dk-link" onClick={(e) => { e.preventDefault(); setProfile(x.id); }}>{tr('Open the profile')}</button>
                      </label>
                    ))}
                  </div>
                  {canManage && (
                    <footer className="hub-dup-acts">
                      <button type="button" className={'btn ' + (d.suggestion === 'merge' ? 'btn-primary' : 'btn-secondary')} disabled={!!busy}
                        onClick={() => { if (window.confirm(tr('Merge “{drop}” into “{keep}”? Everything on “{drop}” moves to “{keep}”, then “{drop}” is removed.', { drop: dropped.name, keep: kept.name }))) act(d.id, () => api.post('/crm/duplicates/merge', { keepId, dropId: dropped.id, suggestionId: d.id }), tr('Merged into {name}.', { name: kept.name })); }}>
                        <Icon name="layers" /> {tr('Merge into {name}', { name: kept.name })}
                      </button>
                      {empty && <button type="button" className={'btn ' + (d.suggestion === 'delete' ? 'btn-primary' : 'btn-secondary')} disabled={!!busy}
                        onClick={() => { if (window.confirm(tr('Delete the empty profile “{name}”?', { name: empty.name }))) act(d.id, () => api.del('/crm/profiles/' + empty.id + '?suggestion=' + d.id), tr('Deleted.')); }}>{tr('Delete the empty one')}</button>}
                      {d.suggestion === 'edit' && <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => act(d.id, () => api.post('/crm/duplicates/' + d.id + '/decide', { status: 'edited' }), tr('Marked as told apart.'))}>{tr('I\'ve edited them')}</button>}
                      <button type="button" className="dk-link" disabled={!!busy} onClick={() => act(d.id, () => api.post('/crm/duplicates/' + d.id + '/decide', { status: 'dismissed' }), tr('Kept apart. The OS won\'t suggest this pair again.'))}>{tr('Not the same customer')}</button>
                    </footer>
                  )}
                </article>
              );
            })}
          </div>
        ) : <Empty icon="check">{tr('No duplicates found. Every customer has one profile.')}</Empty>}
      </Section>

      <Section id="reps" title={tr('Customers with no sales rep')} sub={tr('Customers who write, have an open lead, or bought or were quoted this year need someone. The OS suggests who.')}
        action={canAssign && cover.some((c) => c.suggested) && <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => act('all', () => api.post('/crm/coverage/assign-suggested', {}), tr('Customers given to their suggested reps.'))}>{tr('Give each to the suggested rep')}</button>}>
        {cover.length ? (
          <ul className="hub-cover">
            {cover.map((c) => (
              <li key={c.id} className={c.waiting ? 'is-waiting' : ''}>
                <button type="button" className="hub-cover-who" onClick={() => setProfile(c.id)}>
                  <CustMark name={c.name} size={36} />
                  <span><strong>{c.name}</strong><span className="dk-muted tl-small">{[c.phone || c.email, c.origin ? tr('first wrote on {channel}', { channel: channelLabel(c.origin) }) : null, c.lastInboundAt ? tr('last wrote {time}', { time: ago(c.lastInboundAt) }) : tr('added {time}', { time: ago(c.createdAt) })].filter(Boolean).join(' · ')}</span></span>
                </button>
                {c.waiting > 0 && <span className="hub-flag is-bad"><Icon name="send" /> {tr('waiting for a reply')}</span>}
                <span className="hub-cover-sug">{c.suggested ? <><Icon name="spark" /> {tr('Suggested: {name}', { name: c.suggested.name })} <span className="dk-muted tl-small">({whyText(c.suggested)})</span></> : <span className="dk-muted tl-small">{tr('No rep to suggest yet. Give someone the sales rep role.')}</span>}</span>
                {canAssign && (
                  <span className="hub-cover-acts">
                    <RepSelect reps={reps} value={picks[c.id] || (c.suggested ? c.suggested.id : '')} onChange={(v) => setPicks({ ...picks, [c.id]: v })} emptyLabel={tr('Choose a rep')} />
                    <button type="button" className="btn btn-secondary" disabled={!!busy || !(picks[c.id] || c.suggested)} onClick={() => { const repId = picks[c.id] || c.suggested.id; act(c.id, () => api.post('/crm/assign', { customerIds: [c.id], repId }), tr('{name} now has a rep.', { name: c.name })); }}>{tr('Give')}</button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : <Empty icon="check">{tr('Every customer who needs a rep has one.')}</Empty>}
      </Section>

      <Section id="channels" title={tr('Channels')} sub={tr('Where customer messages come from. New messages are read every 3 minutes.')}>
        {channels && (
          <div className="hub-channels">
            <ChannelCard channel="whatsapp" ok={channels.whatsapp.configured}
              detail={channels.whatsapp.configured ? tr('Messages to the business WhatsApp number come in as they arrive, and replies go out from the inbox.') : tr('Not connected. The WhatsApp Business settings go on the server (Render), the same ones the OS uses for WhatsApp notifications.')}
              extra={tr('Older chats: use "Import a WhatsApp chat" in the inbox.')} />
            <ChannelCard channel="email" ok={channels.email.configured} last={channels.email.lastOkAt} err={channels.email.lastError} items={channels.email.items}
              detail={channels.email.configured ? tr('Reading {box}. Newsletters, notices and mail between staff are left out.', { box: channels.email.mailbox || '' }) : tr('Not connected. On Render, set CRM_IMAP_USER and CRM_IMAP_PASS (for Gmail: an app password) for the sales mailbox, then deploy.')} />
            <ChannelCard channel="facebook" ok={channels.meta.facebook.connected && channels.meta.facebook.messages} last={channels.meta.facebook.lastOkAt} err={channels.meta.facebook.lastError} items={channels.meta.facebook.items}
              detail={!channels.meta.facebook.connected ? tr('Not connected. Connect Facebook on Integrations.') : !channels.meta.facebook.messages ? tr('Connected, but without permission to read messages. Connect Facebook again on Integrations and allow messages.') : tr('Page messages come in and replies go out from the inbox.')}
              action={!(channels.meta.facebook.connected && channels.meta.facebook.messages) && { label: tr('Go to Integrations'), run: () => navigate('/integrations') }} />
            <ChannelCard channel="instagram" ok={channels.meta.instagram.connected && channels.meta.instagram.messages} last={channels.meta.instagram.lastOkAt} err={channels.meta.instagram.lastError} items={channels.meta.instagram.items}
              detail={!channels.meta.instagram.connected ? tr('Not connected. Connect Instagram on Integrations (it goes through the Facebook page).') : !channels.meta.instagram.messages ? tr('Connected, but without permission to read messages. Connect again on Integrations and allow messages.') : tr('Direct messages come in and replies go out from the inbox.')}
              action={!(channels.meta.instagram.connected && channels.meta.instagram.messages) && { label: tr('Go to Integrations'), run: () => navigate('/integrations') }} />
            <ChannelCard channel="call" ok detail={tr('Calls, visits and texts from a personal phone: write them down on the customer\'s profile ("Log a call or visit").')} />
          </div>
        )}
      </Section>

      <Glossary items={[
        [tr('Merge'), tr('Everything on the folded-in profile — invoices, quotations, orders, payments, leads, conversations, numbers — moves to the kept one, its blanks are filled in, and the folded-in profile is removed. The merge is recorded on the kept profile.')],
        [tr('Delete the empty one'), tr('Only possible for a profile with nothing on it at all.')],
        [tr('Not the same customer'), tr('Keeps both. The OS won\'t suggest this pair again.')],
        [tr('Suggested rep'), tr('The rep on their lead, else whoever made their quotations or orders or has been answering them, else the rep with the fewest customers.')]
      ]} />

      {profile && <CustomerProfile id={profile} reps={reps} onClose={() => setProfile(null)} onChanged={load} />}
      <Toast text={toast} onDone={() => setToast(null)} />
    </div>
  );
}

function ChannelCard({ channel, ok, detail, extra, last, err, items, action }) {
  return (
    <article className={'hub-chan' + (ok ? ' is-ok' : ' is-off')}>
      <header><ChannelDot channel={channel} withLabel /><Status tone={ok ? 'good' : 'muted'}>{ok ? tr('Connected') : tr('Not connected')}</Status></header>
      <p className="tl-small">{detail}</p>
      {extra && <p className="dk-muted tl-small">{extra}</p>}
      {(last || items > 0) && <p className="dk-muted tl-small">{last ? tr('Last read {time}', { time: ago(last) }) : ''}{items > 0 ? ' · ' + tr('{n} messages brought in', { n: items }) : ''}</p>}
      {err && <p className="hub-err tl-small"><Icon name="warn" /> {err}</p>}
      {action && <button type="button" className="dk-link" onClick={action.run}>{action.label} <Icon name="arrow" /></button>}
    </article>
  );
}
