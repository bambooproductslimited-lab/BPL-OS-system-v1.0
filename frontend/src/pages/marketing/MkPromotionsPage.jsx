import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Section } from '../../components/DashKit';
import { tr } from '../../lib/i18n.jsx';
import { CHANNELS, ChannelChips, ChipPicker, Glyph, L, Meter, MkBanner, MkCompanies, MkDialog, MkEmpty, PROMO_KINDS, PROMO_STATE, Pill, cedis, dateRange, dayLabel, readParam, short, todayIso, useMkCompany, whole } from './mkKit';

// Promotions & offers (backend mkEvents.service.js): discount codes,
// money off, bundles, free items — each a coupon with its code, what it
// gives, when it runs and on which channels; every time it is used (or a
// day's uses at once) is logged with the sales it brought and the
// discount given, so it shows whether it paid.

const EMPTY = { name: '', code: '', kind: 'percent', value: '', details: '', startsOn: todayIso(), endsOn: '', channels: [], campaignId: '', active: true, targetUses: '' };
function valueText(p) {
  if (p.kind === 'percent' && p.value) return { big: p.value + '%', small: tr('off') };
  if (p.kind === 'amount' && p.value) return { big: short(p.value), small: tr('cedis off') };
  if (p.kind === 'free_item') return { big: tr('Free'), small: tr('item') };
  if (p.kind === 'bundle') return { big: tr('Bundle'), small: p.value ? cedis(p.value) : '' };
  return { big: tr('Offer'), small: '' };
}

export default function MkPromotionsPage() {
  const { can } = useAuth();
  const mk = useMkCompany();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [openId, setOpenId] = useState(() => readParam('open'));
  const [campaigns, setCampaigns] = useState([]);
  const [toast, setToast] = useState(null);
  const load = useCallback(() => { if (mk.company) api.get('/mk/promotions?company=' + mk.company).then(setD).catch((e) => setError(e.message)); }, [mk.company]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (mk.company) api.get('/mk/campaigns/options?company=' + mk.company).then(setCampaigns).catch(() => setCampaigns([])); }, [mk.company]);
  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(null), 3500); return () => clearTimeout(t); }, [toast]);
  function open(id) { setOpenId(id); window.history.replaceState({}, '', '/mkpromotions?open=' + id); }
  function close() { setOpenId(null); window.history.replaceState({}, '', '/mkpromotions'); }

  if (error) return <div className="dk mk"><MkCompanies mk={mk} /><div className="error-banner">{error}</div></div>;
  if (!d) return <div className="dk mk"><MkCompanies mk={mk} /><p className="eyebrow">{tr('Loading…')}</p></div>;
  const canManage = can('marketing.manage');
  const live = d.promotions.filter((p) => p.state === 'running' || p.state === 'upcoming');
  const rest = d.promotions.filter((p) => p.state === 'ended' || p.state === 'paused');
  const t = d.totals;

  return (
    <div className="dk mk">
      <MkCompanies mk={mk} />
      <MkBanner art="ticket" eyebrow={tr('Marketing · Promotions')} title={tr('Promotions & offers')}
        sub={tr('Codes and offers, when they run and where, and how often they were used with the sales they brought, so each shows whether it paid.')}
        actions={canManage && <button type="button" className="mk-btn is-primary" onClick={() => setForm({ ...EMPTY })}><Glyph name="plus" size={16} />{tr('New promotion')}</button>}
        stats={[
          { glyph: 'ticket', value: String(t.running), label: tr('running now') },
          { glyph: 'check', value: whole(t.uses), label: tr('times used') },
          { glyph: 'cash', value: short(t.revenue), label: tr('sales they brought') },
          { glyph: 'gift', value: short(t.discount), label: tr('given in discounts') }
        ]} />
      <Section title={tr('Running and coming up')} sub={tr('Press a coupon to log its uses or change it.')}>
        {live.length ? <div className="mk-grid">{live.map((p) => <Coupon key={p.id} p={p} onOpen={() => open(p.id)} />)}</div>
          : <MkEmpty glyph="ticket" title={tr('No promotion running')} action={canManage && <button type="button" className="mk-btn is-primary" onClick={() => setForm({ ...EMPTY })}>{tr('New promotion')}</button>}>{tr('A code for an Instagram audience, 10% off on Valentine\'s, a free drink with every main: set it up here and count its uses.')}</MkEmpty>}
      </Section>
      {rest.length > 0 && (
        <Section title={tr('Ended and paused')}>
          <div className="mk-grid">{rest.map((p) => <Coupon key={p.id} p={p} onOpen={() => open(p.id)} />)}</div>
        </Section>
      )}
      {form && <PromoForm f={form} setF={setForm} company={mk.company} campaigns={campaigns} onSaved={(p) => { setForm(null); load(); open(p.id); setToast(tr('Promotion saved.')); }} />}
      {openId && <PromoDetail id={openId} onClose={close} onEdit={(p) => setForm({ id: p.id, name: p.name, code: p.code, kind: p.kind, value: p.value ?? '', details: p.details, startsOn: p.startsOn, endsOn: p.endsOn || '', channels: p.channels, campaignId: p.campaign ? p.campaign.id : '', active: p.active, targetUses: p.targetUses ?? '' })} onChanged={load} toast={setToast} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function Coupon({ p, onOpen }) {
  const v = valueText(p);
  return (
    <button type="button" className={'mk-coupon is-' + p.state} onClick={onOpen}>
      <span className="mk-coupon-stub"><b>{v.big}</b><small>{v.small}</small></span>
      <span className="mk-coupon-body">
        <span className="mk-row"><strong className="mk-fill" style={{ fontSize: 14.5 }}>{p.name}</strong><Pill tone={p.state === 'running' ? 'good' : p.state === 'upcoming' ? 'violet' : 'muted'}>{L(PROMO_STATE, p.state)}</Pill></span>
        {p.code && <span className="mk-code">{p.code}</span>}
        <span className="mk-muted">{dateRange(p.startsOn, p.endsOn)}{p.daysLeft !== null ? ' · ' + (p.daysLeft === 0 ? tr('last day') : tr('{n} days left', { n: p.daysLeft })) : ''}</span>
        {p.targetUses ? <Meter value={p.uses} max={p.targetUses} tone="good" label={tr('Used {n} of {target} times', { n: p.uses, target: p.targetUses })} /> : <span className="mk-muted">{tr('Used {n} times · {amount} in sales', { n: p.uses, amount: cedis(p.revenue) })}</span>}
        <ChannelChips list={p.channels.slice(0, 4)} />
      </span>
    </button>
  );
}

function PromoForm({ f, setF, company, campaigns, onSaved }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e && e.target ? e.target.value : e });
  async function save(e) {
    e.preventDefault();
    setSaving(true); setError(null);
    try { onSaved(f.id ? await api.put('/mk/promotions/' + f.id, { ...f, company }) : await api.post('/mk/promotions', { ...f, company })); }
    catch (err) { setError(err.message); setSaving(false); }
  }
  return (
    <MkDialog wide title={f.id ? tr('Change the promotion') : tr('New promotion')} onClose={() => !saving && setF(null)}
      footer={<><button type="button" className="mk-btn is-ghost" onClick={() => setF(null)} disabled={saving}>{tr('Cancel')}</button><button type="submit" form="mk-promo" className="mk-btn is-primary" disabled={saving}>{saving ? tr('Saving…') : tr('Save')}</button></>}>
      <form id="mk-promo" className="mk-form" onSubmit={save}>
        <label className="field"><span>{tr('Name')}</span><input className="input" required maxLength={160} value={f.name} onChange={set('name')} placeholder={tr('e.g. Valentine\'s dinner for two')} /></label>
        <label className="field"><span>{tr('Code (optional)')}</span><input className="input" maxLength={40} value={f.code} onChange={set('code')} placeholder="LOVE10" style={{ fontFamily: 'ui-monospace, monospace', textTransform: 'uppercase' }} /></label>
        <label className="field"><span>{tr('What it gives')}</span><select className="input" value={f.kind} onChange={set('kind')}>{Object.keys(PROMO_KINDS).map((k) => <option key={k} value={k}>{L(PROMO_KINDS, k)}</option>)}</select></label>
        <label className="field"><span>{f.kind === 'percent' ? tr('Percentage off') : f.kind === 'amount' ? tr('Cedis off') : tr('Price (optional)')}</span><input className="input" type="number" min="0" step="any" value={f.value} onChange={set('value')} /></label>
        <label className="field"><span>{tr('Starts')}</span><input className="input" required type="date" value={f.startsOn} onChange={set('startsOn')} /></label>
        <label className="field"><span>{tr('Ends')}</span><input className="input" type="date" value={f.endsOn} onChange={set('endsOn')} /></label>
        <label className="field"><span>{tr('Uses to aim for')}</span><input className="input" type="number" min="0" step="1" value={f.targetUses} onChange={set('targetUses')} /></label>
        <label className="field"><span>{tr('Campaign')}</span><select className="input" value={f.campaignId} onChange={set('campaignId')}><option value="">{tr('No campaign')}</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <div className="field is-span"><span>{tr('Where it is offered')}</span><ChipPicker label={tr('Channels')} value={f.channels} onChange={set('channels')} options={Object.keys(CHANNELS).map((k) => [k, L(CHANNELS, k)])} /></div>
        <label className="field is-span"><span>{tr('The terms')}</span><textarea className="input" rows={2} maxLength={2000} value={f.details} onChange={set('details')} placeholder={tr('e.g. Dine-in only, one per table, not with other offers')} /></label>
        {f.id && <label className="field"><span className="mk-row" style={{ gap: 8 }}><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} style={{ width: 18, height: 18 }} />{tr('On (untick to pause it)')}</span></label>}
      </form>
      {error && <div className="error-banner">{error}</div>}
    </MkDialog>
  );
}

function PromoDetail({ id, onClose, onEdit, onChanged, toast }) {
  const navigate = useNavigate();
  const [p, setP] = useState(null);
  const [error, setError] = useState(null);
  const [use, setUse] = useState({ usedOn: todayIso(), uses: '', revenue: '', discount: '', note: '' });
  const load = useCallback(() => api.get('/mk/promotions/' + id).then(setP).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  async function log(e) {
    e.preventDefault();
    try { setP(await api.post('/mk/promotions/' + id + '/uses', use)); setUse({ usedOn: todayIso(), uses: '', revenue: '', discount: '', note: '' }); onChanged(); toast(tr('Uses logged.')); }
    catch (x) { setError(x.message); }
  }
  async function remove() {
    if (!window.confirm(tr('Delete this promotion and its log?'))) return;
    try { await api.del('/mk/promotions/' + id); onChanged(); onClose(); } catch (x) { setError(x.message); }
  }
  if (!p) return <MkDialog wide title={tr('Promotion')} onClose={onClose}>{error ? <div className="error-banner">{error}</div> : <p className="mk-muted">{tr('Loading…')}</p>}</MkDialog>;
  return (
    <MkDialog wide title={p.name} sub={L(PROMO_KINDS, p.kind) + ' · ' + dateRange(p.startsOn, p.endsOn)} onClose={onClose}>
      <div className="mk-row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <Pill tone={p.state === 'running' ? 'good' : p.state === 'upcoming' ? 'violet' : 'muted'}>{L(PROMO_STATE, p.state)}</Pill>
        {p.code && <span className="mk-code">{p.code}</span>}
        {p.campaign && <button type="button" className="mk-link" onClick={() => navigate('/mkcampaigns?open=' + p.campaign.id)}><Glyph name="target" size={14} />{p.campaign.name}</button>}
        <span style={{ flex: 1 }} />
        {p.canManage && <><button type="button" className="mk-btn is-ghost is-small" onClick={() => onEdit(p)}>{tr('Change it')}</button><button type="button" className="mk-btn is-danger is-small" onClick={remove}>{tr('Delete')}</button></>}
      </div>
      {error && <div className="error-banner">{error}</div>}
      <div className="mk-facts">
        <span className="mk-fact"><small>{tr('Times used')}</small><strong>{whole(p.uses)}</strong><em>{p.targetUses ? tr('of {n} aimed for', { n: p.targetUses }) : ''}</em></span>
        <span className="mk-fact"><small>{tr('Sales it brought')}</small><strong>{cedis(p.revenue)}</strong><em>{p.averageSale ? tr('{amount} a use', { amount: cedis(p.averageSale) }) : ''}</em></span>
        <span className="mk-fact"><small>{tr('Discount given')}</small><strong>{cedis(p.discount)}</strong><em>{p.revenue ? tr('{n}% of those sales', { n: Math.round((p.discount / p.revenue) * 100) }) : ''}</em></span>
      </div>
      {p.details && <p className="mk-note" style={{ margin: 0 }}>{p.details}</p>}
      {p.canManage && (
        <form className="mk-card" onSubmit={log}>
          <h4 className="mk-h4"><Glyph name="plus" size={16} />{tr('Log uses')}</h4>
          <div className="mk-form">
            <label className="field"><span>{tr('Day')}</span><input className="input" type="date" max={todayIso()} value={use.usedOn} onChange={(e) => setUse({ ...use, usedOn: e.target.value })} /></label>
            <label className="field"><span>{tr('Times used')}</span><input className="input" required type="number" min="1" step="1" value={use.uses} onChange={(e) => setUse({ ...use, uses: e.target.value })} /></label>
            <label className="field"><span>{tr('Sales those brought (GHS)')}</span><input className="input" type="number" min="0" step="any" value={use.revenue} onChange={(e) => setUse({ ...use, revenue: e.target.value })} /></label>
            <label className="field"><span>{tr('Discount given (GHS)')}</span><input className="input" type="number" min="0" step="any" value={use.discount} onChange={(e) => setUse({ ...use, discount: e.target.value })} /></label>
            <label className="field is-span"><span>{tr('Note (optional)')}</span><input className="input" maxLength={300} value={use.note} onChange={(e) => setUse({ ...use, note: e.target.value })} /></label>
          </div>
          <button type="submit" className="mk-btn is-primary is-small" style={{ alignSelf: 'flex-start' }}>{tr('Log them')}</button>
        </form>
      )}
      <div className="mk-card">
        <h4 className="mk-h4"><Glyph name="clock" size={16} />{tr('Every use logged')}</h4>
        {p.log.length ? <ul className="mk-list">{p.log.map((u) => (
          <li key={u.id} className="mk-li"><span className="mk-fill"><strong>{u.uses === 1 ? tr('Used once') : tr('Used {n} times', { n: u.uses })}</strong><span className="mk-muted">{[dayLabel(u.usedOn, { weekday: 'short', day: 'numeric', month: 'short' }), u.note, u.by].filter(Boolean).join(' · ')}</span></span>
            <span className="mk-li-amount">{cedis(u.revenue)}</span></li>
        ))}</ul> : <p className="mk-muted">{tr('Not used yet.')}</p>}
      </div>
    </MkDialog>
  );
}
