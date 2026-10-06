import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import ContactButtons from '../../components/ContactButtons';
import { Empty, Glossary, Hero, Icon, Insights, Section } from '../../components/DashKit';
import SearchInput from '../../components/SearchInput';
import { tr } from '../../lib/i18n.jsx';
import CustomerProfile from './CustomerProfile';
import { CATEGORIES, CHANNELS, CategoryTag, ChannelDot, CustMark, RepSelect, ago, ghsOr, useReps } from './crmHubShared';
import { Toast, followUpClass, followUpText } from './crmShared';
import '../EmployeesPage.css';
import '../ToolRoomPage.css';
import './CrmPage.css';
import './CrmHub.css';

// Every customer as one profile (GET /api/crm/profiles): everyone who has
// written on any channel, been quoted, ordered or bought. Filters live in
// the address (?show=waiting&rep=none&channel=whatsapp), and ?id= opens a
// profile (CustomerProfile.jsx). People who can assign reps can pick
// several customers and give them to a rep at once.

export default function CrmCustomersPage() {
  const navigate = useNavigate();
  const { can, session } = useAuth();
  const meId = session && session.employee ? session.employee.id : null;
  const canAssign = can('crm.assign');
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState(params.get('q') || '');
  const [picked, setPicked] = useState(() => new Set());
  const [assignTo, setAssignTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const { reps, reload: reloadReps } = useReps();

  const show = params.get('show') || '';
  const repF = params.get('rep') || '';
  // Customers are the ones who have paid (Lead → Prospect → Customer);
  // leads and prospects with a profile are one tap away.
  const catF = params.get('category') || 'paying';
  const chF = params.get('channel') || '';
  const sort = params.get('sort') || '';
  const openId = params.get('id');
  function setParam(k, v) { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); if (k !== 'id') p.delete('id'); setParams(p, { replace: k !== 'id' }); }

  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (show === 'waiting') qs.set('waiting', '1');
    if (show === 'followup') qs.set('followUp', 'due');
    if (show === 'inactive') qs.set('status', 'inactive');
    if (repF) qs.set('rep', repF);
    if (catF !== 'all') qs.set('category', catF);
    if (chF) qs.set('channel', chF);
    if (sort) qs.set('sort', sort);
    if (q.trim()) qs.set('search', q.trim());
    try { setData(await api.get('/crm/profiles?' + qs.toString())); setError(null); } catch (err) { setError(err.message); }
  }, [show, repF, catF, chF, sort, q]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);

  if (!data) return <div className="dk">{error ? <div className="error-banner">{error}</div> : <div className="eyebrow">{tr('Loading…')}</div>}</div>;
  const s = data.summary;
  const list = data.profiles;

  function toggle(id) { const n = new Set(picked); if (n.has(id)) n.delete(id); else n.add(id); setPicked(n); }
  async function assign() {
    if (!assignTo || !picked.size) return;
    setBusy(true);
    try {
      const out = await api.post('/crm/assign', { customerIds: [...picked], repId: assignTo });
      setToast(tr('{n} customers given to {name}.', { n: out.changed, name: (reps.find((r) => r.id === assignTo) || {}).name || '' }));
      setPicked(new Set()); load(); reloadReps();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  const insights = [];
  if (s.waiting) insights.push({ tone: 'bad', icon: 'send', text: s.waiting === 1 ? tr('1 customer wrote and is waiting for a reply.') : tr('{n} customers wrote and are waiting for a reply.', { n: s.waiting }), action: { label: tr('Open the inbox'), run: () => navigate('/crminbox?waiting=1') } });
  if (s.unassigned) insights.push({ tone: 'warn', icon: 'people', text: s.unassigned === 1 ? tr('1 customer has no sales rep.') : tr('{n} customers have no sales rep.', { n: s.unassigned }), action: { label: tr('See who should take them'), run: () => navigate('/crmhealth#reps') } });
  if (s.duplicates) insights.push({ tone: 'warn', icon: 'layers', text: s.duplicates === 1 ? tr('2 profiles look like the same customer.') : tr('{n} pairs of profiles look like the same customer.', { n: s.duplicates }), action: { label: tr('Check them'), run: () => navigate('/crmhealth') } });
  if (s.from_conversations) insights.push({ tone: 'info', icon: 'spark', text: tr('{n} profiles were made by the OS from people who wrote to us.', { n: s.from_conversations }) });

  return (
    <div className="dk crm hub">
      {error && <div className="error-banner" role="alert">{error}</div>}
      <Hero eyebrow={tr('Sales & CRM')} title={tr('Customers')}
        sub={tr('Everyone who has paid us, in one place: each with all their numbers and accounts, every conversation on every channel, and everything they were quoted, ordered and paid. People who write to us get a profile by themselves, as a lead; the first payment makes them a customer.')}
        actions={<>
          <button type="button" className="btn btn-primary" onClick={() => navigate('/crminbox?tab=followups')}>{tr('My follow-ups')}</button>
          <button type="button" className="btn btn-secondary" onClick={() => navigate('/crminbox')}>{tr('Inbox')}</button>
        </>}
        stats={[
          { icon: 'people', value: String(s.paying), label: tr('paying customers'), note: tr('{p} prospects and {l} leads have a profile too', { p: s.prospects, l: s.leads }), onClick: () => setParams({}, { replace: true }) },
          { icon: 'send', value: String(s.waiting), label: tr('waiting for a reply'), note: tr('wrote last, not answered'), tone: s.waiting ? 'alert' : 'good', onClick: () => setParam('show', 'waiting') },
          { icon: 'calendar', value: String(s.follow_up_due), label: tr('follow-ups due'), note: tr('on or before today'), tone: s.follow_up_due ? 'bad' : '', onClick: () => setParam('show', 'followup') },
          { icon: 'warn', value: String(s.unassigned), label: tr('with no sales rep'), note: tr('{n} possible duplicates', { n: s.duplicates }), tone: s.unassigned ? 'bad' : 'good', onClick: () => setParam('rep', 'none') }
        ]} />

      <Insights items={insights} />

      <Section id="hub-customers" title={tr('Customer profiles')} sub={tr('{n} shown. Press one to open the whole profile.', { n: list.length })}
        action={
          <select className="input hub-sort" value={sort} onChange={(e) => setParam('sort', e.target.value)} aria-label={tr('Order')}>
            <option value="">{tr('Latest contact first')}</option>
            <option value="value">{tr('Biggest buyers first')}</option>
            <option value="name">{tr('By name')}</option>
          </select>
        }>
        <div className="crm-filters">
          <SearchInput value={q} onChange={setQ} placeholder={tr('Search name, phone, email, place…')} />
          <select className="input" value={repF} onChange={(e) => setParam('rep', e.target.value)} aria-label={tr('Sales rep')}>
            <option value="">{tr('Every rep')}</option>
            {meId && <option value="me">{tr('My customers')}</option>}
            {reps.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            <option value="none">{tr('No rep yet')}</option>
          </select>
          <select className="input" value={chF} onChange={(e) => setParam('channel', e.target.value)} aria-label={tr('Channel')}>
            <option value="">{tr('Any channel')}</option>
            {CHANNELS.map((c) => <option key={c.key} value={c.key}>{tr(c.label)}</option>)}
          </select>
        </div>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {[['', tr('Everyone')], ['waiting', tr('Waiting for a reply')], ['followup', tr('Follow-up due')], ['inactive', tr('Inactive')]].map(([k, l]) => (
            <button key={k || 'all'} type="button" role="radio" aria-checked={show === k} className={'ppl-chip' + (show === k ? ' is-on' : '')} onClick={() => setParam('show', k)}>{l}</button>
          ))}
          <span className="hub-chip-gap" />
          {[['paying', tr('Paying customers')], ['vip', tr('VIP')], ['prospect', tr('Prospects')], ['lead', tr('Leads')], ['all', tr('All profiles')]].map(([k, l]) => (
            <button key={k} type="button" role="radio" aria-checked={catF === k} className={'ppl-chip' + (catF === k ? ' is-on' : '')} onClick={() => setParam('category', k === 'paying' ? '' : k)}>{l}</button>
          ))}
        </div>

        {canAssign && picked.size > 0 && (
          <div className="hub-bulk" role="region" aria-label={tr('Give to a rep')}>
            <strong>{tr('{n} chosen', { n: picked.size })}</strong>
            <RepSelect reps={reps} value={assignTo} onChange={setAssignTo} emptyLabel={tr('Give them to…')} />
            <button type="button" className="btn btn-primary" disabled={!assignTo || busy} onClick={assign}>{tr('Give to this rep')}</button>
            <button type="button" className="dk-link" onClick={() => setPicked(new Set())}>{tr('Clear')}</button>
          </div>
        )}

        {list.length ? (
          <div className="hub-cards">
            {list.map((c) => (
              <article key={c.id} className={'hub-card' + (c.waitingSince ? ' is-waiting' : '') + (picked.has(c.id) ? ' is-picked' : '')}>
                {canAssign && <label className="hub-pick"><input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} /><span className="sr-only">{tr('Choose {name}', { name: c.name })}</span></label>}
                <button type="button" className="hub-card-open" onClick={() => setParam('id', c.id)}>
                  <span className="hub-card-top">
                    <CustMark name={c.name} />
                    <span className="hub-card-who">
                      <strong className="crm-card-name">{c.name}</strong>
                      <span className="dk-muted tl-small">{[c.location, c.phone || c.email].filter(Boolean).join(' · ') || tr('no details yet')}</span>
                    </span>
                    <CategoryTag value={c.category} />
                  </span>
                  <span className="hub-card-chs">
                    {c.channels.map((ch) => <ChannelDot key={ch} channel={ch} />)}
                    <span className="dk-muted tl-small">{c.lastContactAt ? tr('last contact {time}', { time: ago(c.lastContactAt) }) : tr('no contact yet')}</span>
                  </span>
                  {c.waitingSince && <span className="hub-flag is-bad"><Icon name="send" /> {tr('Waiting for a reply since {time}', { time: ago(c.waitingSince) })}</span>}
                  {c.followUpOn && <span className={'hub-flag ' + followUpClass(c.followUpOn)}><Icon name="calendar" /> {tr('Follow-up {when}', { when: followUpText(c.followUpOn) })}</span>}
                  <span className="hub-card-money">
                    <span><small>{tr('Bought')}</small> {ghsOr(c.lifetime)}</span>
                    {c.outstanding > 0 && <span className={c.overdue > 0 ? 'is-bad' : ''}><small>{tr('Owes')}</small> {ghsOr(c.outstanding)}</span>}
                    {c.openQuotes > 0 && <span><small>{tr('Open quotes')}</small> {c.openQuotes}</span>}
                  </span>
                  <span className="hub-card-rep">{c.rep ? <><Icon name="people" /> {c.rep.name}</> : <span className="hub-norep"><Icon name="warn" /> {tr('No sales rep')}</span>}{c.duplicates > 0 && <span className="hub-dup"><Icon name="layers" /> {tr('possible duplicate')}</span>}</span>
                </button>
                <div className="hub-card-acts"><ContactButtons name={c.name} phone={c.phone} email={c.email} /></div>
              </article>
            ))}
          </div>
        ) : <Empty icon="people">{tr('No customer matches. Try another filter.')}</Empty>}
      </Section>

      <Glossary items={[
        ...CATEGORIES.map((c) => [tr(c.label), tr(c.help)]),
        [tr('Waiting for a reply'), tr('The customer wrote last and nobody has answered yet, on any channel.')],
        [tr('Sales rep'), tr('The one person who looks after the customer: answers them, follows up, and is on their sales orders.')],
        [tr('Possible duplicate'), tr('Another profile has the same phone, email or name. Data health shows both side by side to merge or tell apart.')]
      ]} />

      {openId && <CustomerProfile id={openId} reps={reps} onClose={() => setParam('id', '')} onChanged={load} />}
      <Toast text={toast} onDone={() => setToast(null)} />
    </div>
  );
}
