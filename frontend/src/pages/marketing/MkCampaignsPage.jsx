import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import Photo from '../../components/Photo';
import SearchInput, { matchesQuery } from '../../components/SearchInput';
import { Section } from '../../components/DashKit';
import { msg, tr } from '../../lib/i18n.jsx';
import { CampaignMini } from './MkHomePage';
import { CAMPAIGN_STATUS, CHANNELS, ChannelChips, ChipPicker, EVENT_KINDS, Glyph, L, Meter, MkBanner, MkCompanies, MkDialog, MkEmpty, OBJECTIVES, OBJECTIVE_GLYPH, PHASES, PHASE_TONE, Pill, REQUEST_STATUS, REQUEST_TONE, SPEND, campaignReturn, cedis, dateRange, dayLabel, readParam, short, useMkCompany, whole } from './mkKit';

// Campaigns (backend mkCampaigns.service.js): every campaign of the
// company as a scoreboard card — its goal, dates, spend against budget,
// leads against target, its return — and the plan for a new one, step by
// step: what and why, who and where, when and how much, targets and the
// tracking code. A campaign opens to its whole story: the plan, what it
// brought (leads, sales, reach), where the money went, its posts, events,
// promotions and requests, and what was learned. Leads are credited to it
// automatically by its tracking code, or by hand from the leads that came
// in while it ran.

const FILTERS = [['all', msg('All')], ['running', msg('Running')], ['upcoming', msg('Starts soon')], ['draft', msg('Drafts')], ['ended', msg('Finished')]];
const LEAD_STAGES = { new: msg('New'), contacted: msg('Contacted'), follow_up: msg('Follow up'), qualified: msg('Qualified'), quote_sent: msg('Quote sent'), negotiation: msg('Negotiating'), won: msg('Won'), lost: msg('Lost') };
const EMPTY = { name: '', objective: 'leads', keyMessage: '', description: '', audience: '', channels: [], startDate: '', endDate: '', budget: '', ownerId: '', status: 'planned',
  targetLeads: '', targetRevenue: '', targetReach: '', code: '' };

export default function MkCampaignsPage() {
  const { can } = useAuth();
  const canManage = can('marketing.manage');
  const mk = useMkCompany();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [form, setForm] = useState(null); // { id?, ...fields }
  const [openId, setOpenId] = useState(() => readParam('open'));
  const [team, setTeam] = useState([]);
  const [toast, setToast] = useState(null);

  const load = useCallback(() => {
    if (!mk.company) return;
    api.get('/mk/campaigns?company=' + mk.company).then(setData).catch((e) => setError(e.message));
  }, [mk.company]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/mk/requests/team').then(setTeam).catch(() => setTeam([])); }, []);
  useEffect(() => { if (readParam('new') === '1' && canManage) setForm({ ...EMPTY }); }, [canManage]);
  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(null), 3500); return () => clearTimeout(t); }, [toast]);

  function open(id) { setOpenId(id); window.history.replaceState({}, '', '/mkcampaigns?open=' + id); }
  function close() { setOpenId(null); window.history.replaceState({}, '', '/mkcampaigns'); }

  const list = useMemo(() => {
    if (!data) return [];
    return data.campaigns.filter((c) => (filter === 'all' ? c.phase !== 'cancelled' : filter === 'ended' ? c.phase === 'ended' || c.phase === 'overdue' : c.phase === filter))
      .filter((c) => matchesQuery(query, c.name, c.audience, c.code));
  }, [data, filter, query]);

  if (error) return <div className="dk mk"><MkCompanies mk={mk} /><div className="error-banner">{error}</div></div>;
  if (!data) return <div className="dk mk"><MkCompanies mk={mk} /><p className="eyebrow">{tr('Loading…')}</p></div>;
  const t = data.totals;
  const counts = {};
  data.campaigns.forEach((c) => { const k = c.phase === 'overdue' ? 'ended' : c.phase; counts[k] = (counts[k] || 0) + 1; });

  return (
    <div className="dk mk">
      <MkCompanies mk={mk} />
      <MkBanner art="target"
        eyebrow={tr('Marketing · Campaigns')}
        title={tr('Campaigns')}
        sub={tr('Each push with one goal: plan it, run it, and see what it brought in. Leads, sales and reach are counted from the OS, not typed in.')}
        actions={canManage && <button type="button" className="mk-btn is-primary" onClick={() => setForm({ ...EMPTY })}><Glyph name="plus" size={16} />{tr('Plan a campaign')}</button>}
        ring={{ value: t.spend, max: t.budget || 1, big: t.roi === null ? '—' : (t.roi > 0 ? '+' : '') + t.roi + '%', small: tr('return on spend'), tone: t.roi === null ? '' : t.roi >= 0 ? 'good' : 'hot',
          caption: tr('{revenue} in sales from {spend} spent.', { revenue: cedis(t.revenue), spend: cedis(t.spend) }) }}
        stats={[
          { glyph: 'play', value: String(t.live), label: tr('running now') },
          { glyph: 'magnet', value: whole(t.leads), label: tr('leads brought in'), note: tr('{n} won', { n: t.won }) },
          { glyph: 'wallet', value: t.costPerLead ? cedis(t.costPerLead) : '—', label: tr('cost per lead') },
          { glyph: 'cash', value: short(t.budget), label: tr('budgeted'), note: tr('{spent} spent', { spent: short(t.spend) }) }
        ]} />

      <Section title={tr('Your campaigns')} sub={tr('Press a campaign for its whole story. The bar under the name is how far through its dates it is.')}>
        <div className="mk-tools">
          <div className="mk-chippick" role="radiogroup" aria-label={tr('Show')}>
            {FILTERS.map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={filter === k} className={'mk-chipopt' + (filter === k ? ' is-on' : '')} onClick={() => setFilter(k)}>
                {tr(label)} <span className="mk-muted">{k === 'all' ? data.campaigns.filter((c) => c.phase !== 'cancelled').length : counts[k] || 0}</span>
              </button>
            ))}
          </div>
          <span className="mk-fill" />
          <div style={{ minWidth: 220 }}><SearchInput value={query} onChange={setQuery} placeholder={tr('Search campaigns…')} /></div>
        </div>
        {list.length ? (
          <div className="mk-grid">{list.map((c) => <CampaignMini key={c.id} c={c} onOpen={() => open(c.id)} />)}</div>
        ) : (
          <MkEmpty glyph="target" title={data.campaigns.length ? tr('Nothing matches') : tr('No campaigns yet')}
            action={canManage && !data.campaigns.length && <button type="button" className="mk-btn is-primary" onClick={() => setForm({ ...EMPTY })}>{tr('Plan the first one')}</button>}>
            {data.campaigns.length ? tr('Try another filter or search.') : tr('Start with one: a goal (say, 30 leads for bamboo chairs), who it is for, where it runs, a budget and a tracking code to put on every lead it brings.')}
          </MkEmpty>
        )}
      </Section>

      {form && <CampaignForm form={form} setForm={setForm} company={mk.company} team={team} onSaved={(c) => { setForm(null); load(); open(c.id); setToast(tr('Campaign saved.')); }} />}
      {openId && <CampaignDetail id={openId} canManage={canManage} canCrm={can('crm.read')} onClose={close} onEdit={(c) => setForm(toForm(c))} onChanged={load} navigate={navigate} toast={setToast} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function toForm(c) {
  return {
    id: c.id, name: c.name, objective: c.objective, keyMessage: c.keyMessage, description: c.description, audience: c.audience, channels: c.channels,
    startDate: c.startDate || '', endDate: c.endDate || '', budget: c.budget || '', ownerId: c.owner ? c.owner.id : '', status: c.status,
    targetLeads: c.targetLeads ?? '', targetRevenue: c.targetRevenue ?? '', targetReach: c.targetReach ?? '', code: c.code, review: c.review
  };
}

function CampaignForm({ form, setForm, company, team, onSaved }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e && e.target ? e.target.value : e });
  async function save(e) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      const body = { ...form, company };
      const c = form.id ? await api.put('/mk/campaigns/' + form.id, body) : await api.post('/mk/campaigns', body);
      onSaved(c);
    } catch (err) { setError(err.message); setSaving(false); }
  }
  const suggest = () => setForm({ ...form, code: (form.name || 'campaign').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 18) + '-' + String(new Date().getFullYear()).slice(2) });
  return (
    <MkDialog wide title={form.id ? tr('Edit the plan') : tr('Plan a campaign')} sub={tr('Four short steps. Only the name is needed now; the rest can be filled in as the plan firms up.')} onClose={() => !saving && setForm(null)}
      footer={<>
        <button type="button" className="mk-btn is-ghost" onClick={() => setForm(null)} disabled={saving}>{tr('Cancel')}</button>
        <button type="submit" form="mk-camp-form" className="mk-btn is-primary" disabled={saving}>{saving ? tr('Saving…') : form.id ? tr('Save the plan') : tr('Save the campaign')}</button>
      </>}>
      <form id="mk-camp-form" className="mk-form" onSubmit={save}>
        <div className="mk-step"><b>1</b>{tr('What and why')}</div>
        <label className="field is-span"><span>{tr('Name')}</span><input className="input" required maxLength={120} value={form.name} onChange={set('name')} placeholder={tr('e.g. Bamboo chairs for hotels, Q4')} /></label>
        <div className="field is-span"><span>{tr('The one goal')}</span>
          <ChipPicker single label={tr('Objective')} value={form.objective} onChange={set('objective')} options={Object.keys(OBJECTIVES).map((k) => [k, L(OBJECTIVES, k), OBJECTIVE_GLYPH[k]])} />
        </div>
        <label className="field is-span"><span>{tr('The one thing it says')}</span><input className="input" maxLength={500} value={form.keyMessage} onChange={set('keyMessage')} placeholder={tr('e.g. Cooler, stronger and greener than plastic')} />
          <span className="hint">{tr('If people remember one sentence, which is it? Every post, flyer and talk should say it.')}</span></label>
        <label className="field is-span"><span>{tr('More about it (optional)')}</span><textarea className="input" rows={2} maxLength={2000} value={form.description} onChange={set('description')} /></label>

        <div className="mk-step"><b>2</b>{tr('Who and where')}</div>
        <label className="field is-span"><span>{tr('Who it is for')}</span><input className="input" maxLength={500} value={form.audience} onChange={set('audience')} placeholder={tr('e.g. Hotel and restaurant owners in Accra and Kumasi')} /></label>
        <div className="field is-span"><span>{tr('Where it runs')}</span>
          <ChipPicker label={tr('Channels')} value={form.channels} onChange={set('channels')} options={Object.keys(CHANNELS).map((k) => [k, L(CHANNELS, k)])} />
        </div>

        <div className="mk-step"><b>3</b>{tr('When and how much')}</div>
        <label className="field"><span>{tr('Starts')}</span><input className="input" type="date" value={form.startDate} onChange={set('startDate')} /></label>
        <label className="field"><span>{tr('Ends')}</span><input className="input" type="date" value={form.endDate} onChange={set('endDate')} /></label>
        <label className="field"><span>{tr('Budget (GHS)')}</span><input className="input" type="number" min="0" step="any" value={form.budget} onChange={set('budget')} /></label>
        <label className="field"><span>{tr('Owner')}</span>
          <select className="input" value={form.ownerId} onChange={set('ownerId')}>
            <option value="">{tr('Nobody yet')}</option>
            {team.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="field"><span>{tr('Status')}</span>
          <select className="input" value={form.status} onChange={set('status')}>
            {Object.keys(CAMPAIGN_STATUS).map((k) => <option key={k} value={k}>{L(CAMPAIGN_STATUS, k)}</option>)}
          </select>
        </label>

        <div className="mk-step"><b>4</b>{tr('Targets and tracking')}</div>
        <label className="field"><span>{tr('Leads to bring in')}</span><input className="input" type="number" min="0" step="1" value={form.targetLeads} onChange={set('targetLeads')} /></label>
        <label className="field"><span>{tr('Sales to make (GHS)')}</span><input className="input" type="number" min="0" step="any" value={form.targetRevenue} onChange={set('targetRevenue')} /></label>
        <label className="field"><span>{tr('People to reach')}</span><input className="input" type="number" min="0" step="1" value={form.targetReach} onChange={set('targetReach')} /></label>
        <label className="field"><span>{tr('Tracking code')}</span>
          <span className="mk-row"><input className="input mk-fill" maxLength={40} value={form.code} onChange={set('code')} placeholder="CHAIRS-26" />
            <button type="button" className="mk-btn is-ghost is-small" onClick={suggest}>{tr('Suggest')}</button></span>
          <span className="hint">{tr('Put it on the ads and flyers ("quote CHAIRS-26"). A lead whose source is this code, received while the campaign runs, is counted for it.')}</span>
        </label>
        {form.id && <label className="field is-span"><span>{tr('What was learned')}</span><textarea className="input" rows={3} maxLength={4000} value={form.review || ''} onChange={set('review')} /></label>}
      </form>
      {error && <div className="error-banner">{error}</div>}
    </MkDialog>
  );
}

function CampaignDetail({ id, canManage, canCrm, onClose, onEdit, onChanged, navigate, toast }) {
  const [c, setC] = useState(null);
  const [error, setError] = useState(null);
  const [finish, setFinish] = useState(null);
  const [credit, setCredit] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.get('/mk/campaigns/' + id).then(setC).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);

  async function status(s, review) {
    setBusy(true);
    try { setC(await api.post('/mk/campaigns/' + id + '/status', review === undefined ? { status: s } : { status: s, review })); onChanged(); setFinish(null); toast(tr('Campaign updated.')); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function remove() {
    if (!window.confirm(tr('Delete this campaign? Its posts, spend, leads and events stay, no longer tied to it.'))) return;
    try { await api.del('/mk/campaigns/' + id); onChanged(); onClose(); toast(tr('Campaign deleted.')); } catch (e) { setError(e.message); }
  }

  if (!c) return <MkDialog wide title={tr('Campaign')} onClose={onClose}>{error ? <div className="error-banner">{error}</div> : <p className="mk-muted">{tr('Loading…')}</p>}</MkDialog>;
  const r = c.results;
  const ret = campaignReturn(c);
  const actions = [];
  if (canManage) {
    if (c.status === 'draft' || c.status === 'planned' || c.status === 'paused') actions.push(<button key="go" type="button" className="mk-btn is-primary is-small" disabled={busy} onClick={() => status('active')}><Glyph name="play" size={14} />{c.status === 'paused' ? tr('Resume') : tr('Launch')}</button>);
    if (c.status === 'active') actions.push(<button key="pause" type="button" className="mk-btn is-ghost is-small" disabled={busy} onClick={() => status('paused')}><Glyph name="pause" size={14} />{tr('Pause')}</button>);
    if (c.status === 'active' || c.status === 'paused') actions.push(<button key="end" type="button" className="mk-btn is-ghost is-small" disabled={busy} onClick={() => setFinish(c.review || '')}><Glyph name="trophy" size={14} />{tr('Finish')}</button>);
    actions.push(<button key="edit" type="button" className="mk-btn is-ghost is-small" onClick={() => onEdit(c)}>{tr('Edit the plan')}</button>);
    if (c.status !== 'cancelled' && c.status !== 'completed') actions.push(<button key="cancel" type="button" className="mk-btn is-ghost is-small" disabled={busy} onClick={() => status('cancelled')}>{tr('Cancel it')}</button>);
    actions.push(<button key="del" type="button" className="mk-btn is-danger is-small" onClick={remove}>{tr('Delete')}</button>);
  }
  const funnelMax = Math.max(1, r.leads);
  return (
    <MkDialog wide title={c.name} sub={L(OBJECTIVES, c.objective) + ' · ' + dateRange(c.startDate, c.endDate)} onClose={onClose}>
      <div className="mk-row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <Pill tone={PHASE_TONE[c.phase]}>{L(PHASES, c.phase)}</Pill>
        {c.code && <Pill tone="violet" glyph="tag">{c.code}</Pill>}
        {c.owner && <span className="mk-row"><Photo id={c.owner.id} name={c.owner.name} photo={c.owner.photo} size={24} /><span className="mk-muted">{c.owner.name}</span></span>}
        <span className="mk-fill" />
        <span className="mk-chips">{actions}</span>
      </div>
      {error && <div className="error-banner">{error}</div>}

      <div className="mk-facts">
        <span className={'mk-fact' + (c.budget && r.spend > c.budget ? ' is-bad' : '')}><small>{tr('Spent')}</small><strong>{cedis(r.spend)}</strong><em>{c.budget ? tr('of {budget} budget', { budget: cedis(c.budget) }) : tr('no budget set')}{r.committed ? ' · ' + tr('{amount} not yet paid', { amount: cedis(r.committed) }) : ''}</em></span>
        <span className="mk-fact"><small>{tr('Leads')}</small><strong>{r.leads}{c.targetLeads ? ' / ' + c.targetLeads : ''}</strong><em>{r.costPerLead ? tr('{amount} each', { amount: cedis(r.costPerLead) }) : tr('cost per lead once there are both')}</em></span>
        <span className="mk-fact"><small>{tr('Sales')}</small><strong>{cedis(r.revenue)}</strong><em>{c.targetRevenue ? tr('target {amount}', { amount: cedis(c.targetRevenue) }) : tr('{n} customers bought', { n: r.buyers })}</em></span>
        {c.objective !== 'awareness' && <span className={'mk-fact' + (ret.tone ? ' is-' + ret.tone : '')}><small>{tr('Return')}</small><strong>{ret.value}</strong><em>{ret.note || tr('(sales − spend) ÷ spend')}</em></span>}
        <span className="mk-fact"><small>{tr('Reach')}</small><strong>{short(r.reach)}</strong><em>{c.targetReach ? tr('target {n}', { n: short(c.targetReach) }) : tr('{n} posts, {clicks} clicks', { n: r.posts, clicks: short(r.clicks) })}</em></span>
      </div>

      <div className="mk-two">
        <div className="mk-card">
          <h4 className="mk-h4"><Glyph name="target" size={16} />{tr('The plan')}</h4>
          {c.keyMessage && <p className="mk-note" style={{ margin: 0 }}>“{c.keyMessage}”</p>}
          <dl className="mk-kv">
            <dt>{tr('For')}</dt><dd>{c.audience || '—'}</dd>
            <dt>{tr('Status')}</dt><dd>{L(CAMPAIGN_STATUS, c.status)}</dd>
            <dt>{tr('Budget')}</dt><dd>{c.budget ? cedis(c.budget) : '—'}</dd>
          </dl>
          <ChannelChips list={c.channels} />
          {c.description && <p className="mk-muted" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{c.description}</p>}
          {c.budget > 0 && <Meter value={r.spend} max={c.budget} tone={r.spend > c.budget ? 'bad' : ''} label={tr('{pct}% of the budget used', { pct: r.budgetUsed || 0 })} />}
          {c.targetLeads > 0 && <Meter value={r.leads} max={c.targetLeads} tone="info" label={tr('{n} of {target} leads', { n: r.leads, target: c.targetLeads })} />}
          {c.targetRevenue > 0 && <Meter value={r.revenue} max={c.targetRevenue} tone="good" label={tr('{amount} of {target} in sales', { amount: cedis(r.revenue), target: cedis(c.targetRevenue) })} />}
        </div>
        <div className="mk-card">
          <h4 className="mk-h4"><Glyph name="magnet" size={16} />{tr('Where its leads got to')}</h4>
          <div className="mk-funnel">
            {[[tr('Leads'), r.leads], [tr('Prospects (quoted)'), r.prospects + r.won], [tr('Won'), r.won], [tr('Customers who bought'), r.buyers]].map(([label, n]) => (
              <div key={label} className="mk-funnel-row"><span>{label}</span><span className="mk-funnel-bar"><i style={{ width: Math.round((n / funnelMax) * 100) + '%' }} /></span><span>{n}</span></div>
            ))}
          </div>
          <p className="mk-muted" style={{ margin: 0 }}>{tr('Sales are what these leads\' customers were invoiced from the day the lead came in until 90 days after the campaign ends, plus promotion and event sales.')}</p>
          {(r.promoUses > 0 || r.events > 0) && (
            <dl className="mk-kv">
              {r.promoUses > 0 && <><dt>{tr('Promotion uses')}</dt><dd>{r.promoUses} · {cedis(r.promoRevenue)}</dd></>}
              {r.events > 0 && <><dt>{tr('At its events')}</dt><dd>{tr('{v} visitors, {l} leads', { v: r.visitors, l: r.eventLeads })}</dd></>}
            </dl>
          )}
        </div>
      </div>

      {(c.status === 'completed' || c.review) && (
        <div className="mk-card">
          <h4 className="mk-h4"><Glyph name="trophy" size={16} />{tr('What was learned')}</h4>
          {c.review ? <p className="mk-note" style={{ margin: 0 }}>{c.review}</p> : <p className="mk-muted" style={{ margin: 0 }}>{tr('Nothing written yet. What worked, what did not, what to do next time?')}</p>}
        </div>
      )}

      <div className="mk-card">
        <div className="mk-card-head"><h4 className="mk-h4"><Glyph name="users" size={16} />{tr('Its leads')}</h4>
          {canManage && canCrm && <button type="button" className="mk-btn is-ghost is-small" onClick={() => setCredit(true)}><Glyph name="plus" size={14} />{tr('Credit leads to it')}</button>}</div>
        {c.leads === null ? <p className="mk-muted">{tr('You can see how many, not who: the leads are in the CRM.')}</p> : c.leads.length ? (
          <ul className="mk-list">
            {c.leads.slice(0, 30).map((l) => (
              <li key={l.id} className="mk-li">
                <span className="mk-fill"><strong>{l.name}</strong><span className="mk-muted">{[l.company, l.item, dayLabel(l.receivedOn)].filter(Boolean).join(' · ')}</span></span>
                <Pill tone={l.stage === 'won' ? 'good' : l.stage === 'lost' ? 'muted' : 'info'}>{L(LEAD_STAGES, l.stage)}</Pill>
                {!l.credited && <span className="mk-muted" title={tr('Counted by its tracking code')}><Glyph name="tag" size={14} /></span>}
              </li>
            ))}
          </ul>
        ) : <p className="mk-muted">{tr('No leads yet. Ask for the tracking code, or credit leads that came in while it ran.')}</p>}
      </div>

      <div className="mk-two">
        <div className="mk-card">
          <div className="mk-card-head"><h4 className="mk-h4"><Glyph name="wallet" size={16} />{tr('Where the money went')}</h4><button type="button" className="mk-link" onClick={() => navigate('/mkbudget?campaign=' + c.id)}>{tr('Budget & spend')}</button></div>
          {c.spend.length ? <ul className="mk-list">{c.spend.map((s) => (
            <li key={s.id} className="mk-li"><span className="mk-fill"><strong>{s.description}</strong><span className="mk-muted">{[L(SPEND, s.category), s.vendor, dayLabel(s.spentOn)].filter(Boolean).join(' · ')}</span></span>
              <span className="mk-li-amount">{cedis(s.amount)}</span>{s.status === 'committed' && <Pill tone="warn">{tr('not paid yet')}</Pill>}</li>
          ))}</ul> : <p className="mk-muted">{tr('Nothing spent on it yet.')}</p>}
        </div>
        <div className="mk-card">
          <div className="mk-card-head"><h4 className="mk-h4"><Glyph name="chat" size={16} />{tr('Its posts')}</h4><button type="button" className="mk-link" onClick={() => navigate('/socialtracker?tab=calendar')}>{tr('Social & content')}</button></div>
          {c.posts.length ? <ul className="mk-list">{c.posts.slice(0, 12).map((p) => (
            <li key={p.id} className="mk-li"><span className="mk-fill"><strong>{p.title || p.channel}</strong><span className="mk-muted">{p.channel} · {p.at ? dayLabel(p.at) : '—'}</span></span>
              <span className="mk-muted">{tr('{n} reached', { n: short(p.reach) })}</span></li>
          ))}</ul> : <p className="mk-muted">{tr('No posts tied to it. Pick this campaign on a post in Social & content.')}</p>}
        </div>
      </div>

      {(c.events.length > 0 || c.promotions.length > 0 || c.requests.length > 0) && (
        <div className="mk-card">
          <h4 className="mk-h4"><Glyph name="flag" size={16} />{tr('Events, promotions and requests')}</h4>
          <ul className="mk-list">
            {c.events.map((e) => <li key={e.id} className="mk-li is-link" style={{ cursor: 'pointer' }} onClick={() => navigate('/mkevents?open=' + e.id)}><Glyph name="flag" size={16} /><span className="mk-fill"><strong>{e.name}</strong><span className="mk-muted">{L(EVENT_KINDS, e.kind)} · {dateRange(e.startsOn, e.endsOn)}</span></span><span className="mk-muted">{tr('{n} leads', { n: e.leads })}</span></li>)}
            {c.promotions.map((p) => <li key={p.id} className="mk-li" style={{ cursor: 'pointer' }} onClick={() => navigate('/mkpromotions?open=' + p.id)}><Glyph name="ticket" size={16} /><span className="mk-fill"><strong>{p.name}</strong><span className="mk-muted">{p.code || '—'} · {dateRange(p.startsOn, p.endsOn)}</span></span><span className="mk-muted">{tr('used {n} times', { n: p.uses })}</span></li>)}
            {c.requests.map((q) => <li key={q.id} className="mk-li" style={{ cursor: 'pointer' }} onClick={() => navigate('/mkrequests?open=' + q.id)}><Glyph name="inbox" size={16} /><span className="mk-fill"><strong>{q.title}</strong><span className="mk-muted">{q.dueOn ? tr('needed by {date}', { date: dayLabel(q.dueOn) }) : ''}</span></span><Pill tone={REQUEST_TONE[q.status]}>{L(REQUEST_STATUS, q.status)}</Pill></li>)}
          </ul>
        </div>
      )}

      {finish !== null && (
        <MkDialog title={tr('Finish {name}', { name: c.name })} sub={tr('Write down what was learned while it is fresh: it is what makes the next campaign better.')} onClose={() => setFinish(null)}
          footer={<><button type="button" className="mk-btn is-ghost" onClick={() => setFinish(null)}>{tr('Cancel')}</button><button type="button" className="mk-btn is-primary" disabled={busy} onClick={() => status('completed', finish)}>{tr('Finish the campaign')}</button></>}>
          <div className="mk-facts">
            <span className="mk-fact"><small>{tr('Leads')}</small><strong>{r.leads}</strong></span>
            <span className="mk-fact"><small>{tr('Sales')}</small><strong>{short(r.revenue)}</strong></span>
            <span className="mk-fact"><small>{tr('Return')}</small><strong>{r.roi === null ? '—' : r.roi + '%'}</strong></span>
          </div>
          <label className="field"><span>{tr('What worked, what did not, what to do next time')}</span><textarea className="input" rows={5} value={finish} onChange={(e) => setFinish(e.target.value)} /></label>
        </MkDialog>
      )}
      {credit && <CreditLeads id={c.id} onClose={() => setCredit(false)} onDone={(x) => { setC(x); onChanged(); setCredit(false); toast(tr('Leads credited.')); }} />}
    </MkDialog>
  );
}

function CreditLeads({ id, onClose, onDone }) {
  const [rows, setRows] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [error, setError] = useState(null);
  useEffect(() => { api.get('/mk/campaigns/' + id + '/lead-candidates').then((r) => { setRows(r); setPicked(new Set(r.filter((l) => l.credited).map((l) => l.id))); }).catch((e) => setError(e.message)); }, [id]);
  async function save() {
    try {
      const was = new Set(rows.filter((l) => l.credited).map((l) => l.id));
      const add = [...picked].filter((x) => !was.has(x)), drop = [...was].filter((x) => !picked.has(x));
      let out = null;
      if (add.length) out = await api.post('/mk/campaigns/' + id + '/leads', { leadIds: add, credit: true });
      if (drop.length) out = await api.post('/mk/campaigns/' + id + '/leads', { leadIds: drop, credit: false });
      onDone(out || await api.get('/mk/campaigns/' + id));
    } catch (e) { setError(e.message); }
  }
  return (
    <MkDialog title={tr('Credit leads to this campaign')} sub={tr('Leads that came in while it ran (from a week before) and are not already another campaign\'s. Tick the ones it brought.')} onClose={onClose}
      footer={<><button type="button" className="mk-btn is-ghost" onClick={onClose}>{tr('Cancel')}</button><button type="button" className="mk-btn is-primary" disabled={!rows} onClick={save}>{tr('Save')}</button></>}>
      {error && <div className="error-banner">{error}</div>}
      {!rows ? <p className="mk-muted">{tr('Loading…')}</p> : rows.length ? (
        <div className="mk-check">
          {rows.map((l) => (
            <label key={l.id} className={picked.has(l.id) ? 'is-on' : ''}>
              <input type="checkbox" checked={picked.has(l.id)} onChange={() => { const n = new Set(picked); if (n.has(l.id)) n.delete(l.id); else n.add(l.id); setPicked(n); }} />
              <span className="mk-fill"><strong>{l.name}</strong> <span className="mk-muted">{[l.source, l.item, dayLabel(l.receivedOn)].filter(Boolean).join(' · ')}</span></span>
              <span className="mk-muted">{L(LEAD_STAGES, l.stage)}</span>
            </label>
          ))}
        </div>
      ) : <p className="mk-muted">{tr('No leads came in while it ran.')}</p>}
    </MkDialog>
  );
}
