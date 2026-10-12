import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { Section } from '../../components/DashKit';
import SearchInput, { matchesQuery } from '../../components/SearchInput';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';
import { Glyph, L, MkBanner, MkCompanies, MkDialog, MkEmpty, Pill, SPEND, cedis, dayLabel, openFile, readParam, short, todayIso, useMkCompany } from './mkKit';

// Budget & spend (backend mkBudget.service.js): the year's marketing
// budget, category by category, against every cedi spent — paid or only
// committed — with a line where spending should be by now if it went
// evenly through the year; the money month by month and by campaign; and
// every spend with its vendor, date, campaign or event and receipt.

const EMPTY = { category: 'digital_ads', description: '', vendor: '', amount: '', spentOn: todayIso(), status: 'paid', campaignId: '', eventId: '' };

export default function MkBudgetPage() {
  const mk = useMkCompany();
  const navigate = useNavigate();
  const [year, setYear] = useState(new Date().getFullYear());
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [edit, setEdit] = useState(null);
  const [setting, setSetting] = useState(null);
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState('');
  const [campaignFilter, setCampaignFilter] = useState(() => readParam('campaign') || '');
  const [campaigns, setCampaigns] = useState([]);
  const [events, setEvents] = useState([]);
  const [toast, setToast] = useState(null);

  const load = useCallback(() => {
    if (!mk.company) return;
    api.get('/mk/budget?company=' + mk.company + '&year=' + year).then(setD).catch((e) => setError(e.message));
  }, [mk.company, year]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!mk.company) return;
    api.get('/mk/campaigns/options?company=' + mk.company).then(setCampaigns).catch(() => setCampaigns([]));
    api.get('/mk/events?company=' + mk.company).then((x) => setEvents(x.events)).catch(() => setEvents([]));
  }, [mk.company]);
  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(null), 3500); return () => clearTimeout(t); }, [toast]);

  const lines = useMemo(() => (d ? d.spend : []).filter((l) => (!cat || l.category === cat) && (!campaignFilter || (l.campaign && l.campaign.id === campaignFilter)))
    .filter((l) => matchesQuery(query, l.description, l.vendor, l.campaign && l.campaign.name)), [d, cat, campaignFilter, query]);

  if (error) return <div className="dk mk"><MkCompanies mk={mk} /><div className="error-banner">{error}</div></div>;
  if (!d) return <div className="dk mk"><MkCompanies mk={mk} /><p className="eyebrow">{tr('Loading…')}</p></div>;
  const t = d.totals;
  const thisYear = new Date().getFullYear();
  const ahead = t.onPace !== null && t.spent > t.onPace * 1.1;
  const maxMonth = Math.max(1, ...d.months.map((m) => m.spent));
  const nowKey = todayIso().slice(0, 7);

  return (
    <div className="dk mk">
      <MkCompanies mk={mk} />
      <MkBanner art="wallet" eyebrow={tr('Marketing · Budget')} title={tr('Budget & spend, {year}', { year })}
        sub={tr('The year\'s marketing money: what each category may spend, what has gone, and whether spending is ahead of the year. Every spend keeps its receipt.')}
        actions={d.canManage && <>
          <button type="button" className="mk-btn is-primary" onClick={() => setEdit({ ...EMPTY })}><Glyph name="plus" size={16} />{tr('Record a spend')}</button>
          <button type="button" className="mk-btn is-ghost" onClick={() => setSetting(Object.fromEntries(Object.keys(SPEND).map((k) => [k, String((d.categories.find((c) => c.category === k) || {}).budget || '')])))}>{tr('Set the budget')}</button>
        </>}
        ring={t.budget ? { value: t.spent, max: t.budget, big: t.pct + '%', small: tr('of the budget used'), tone: ahead ? 'hot' : 'good',
          caption: year === thisYear ? tr('The year is {n}% gone; by now, about {pace} would be on pace.', { n: t.yearThrough, pace: cedis(t.onPace) }) : tr('{spent} of {budget}.', { spent: cedis(t.spent), budget: cedis(t.budget) }) } : null}
        stats={[
          { glyph: 'wallet', value: cedis(t.budget), label: tr('budget') },
          { glyph: 'cash', value: cedis(t.spent), label: tr('spent'), note: t.committed ? tr('{amount} of it not yet paid', { amount: cedis(t.committed) }) : tr('all paid'), tone: ahead ? 'alert' : '' },
          { glyph: 'target', value: cedis(t.left), label: tr('left to spend'), tone: t.left < 0 ? 'bad' : '' },
          { glyph: 'clock', value: cedis(t.lastYear), label: tr('spent the year before') }
        ]} />

      <div className="mk-tools">
        <button type="button" className="mk-btn is-ghost is-small" onClick={() => setYear(year - 1)} aria-label={tr('Previous year')}>‹ {year - 1}</button>
        <strong style={{ fontSize: 18 }}>{year}</strong>
        <button type="button" className="mk-btn is-ghost is-small" onClick={() => setYear(year + 1)} aria-label={tr('Next year')}>{year + 1} ›</button>
      </div>

      <div className="mk-two">
        <Section card title={tr('By category')} sub={tr('Each bar is what was spent against that category\'s budget; the stripes are agreed but not yet paid, the line is where spending would be if it went evenly through the year.')}>
          {d.categories.length ? (
            <div className="mk-cats">
              {d.categories.map((c) => {
                const max = Math.max(c.budget, c.spent, 1);
                return (
                  <div key={c.category} className="mk-cat">
                    <span className="mk-cat-name">{L(SPEND, c.category)}</span>
                    <span className="mk-cat-bar" title={tr('{spent} of {budget}', { spent: cedis(c.spent), budget: cedis(c.budget) })}>
                      <i className={c.budget && c.spent > c.budget ? 'is-over' : ''} style={{ width: Math.round((c.paid / max) * 100) + '%' }} />
                      {c.committed > 0 && <i className="is-committed" style={{ left: Math.round((c.paid / max) * 100) + '%', width: Math.round((c.committed / max) * 100) + '%' }} />}
                      {c.budget > 0 && year === thisYear && <b style={{ left: Math.round(((c.budget * t.yearThrough) / 100 / max) * 100) + '%' }} />}
                    </span>
                    <span className="mk-cat-nums"><strong>{cedis(c.spent)}</strong>{c.budget ? tr('of {budget} · {pct}%', { budget: short(c.budget), pct: c.pct }) : tr('no budget set')}</span>
                  </div>
                );
              })}
            </div>
          ) : <MkEmpty glyph="wallet" title={tr('No budget and no spend yet')} action={d.canManage && <button type="button" className="mk-btn is-primary" onClick={() => setSetting({})}>{tr('Set the budget')}</button>}>{tr('Give each kind of spending its share of the year: digital ads, content, print, events, sponsorship…')}</MkEmpty>}
        </Section>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Section card title={tr('Month by month')} sub={tr('What went out each month. Point at a month for its figure.')}>
            <div className="mk-months" role="img" aria-label={d.months.map((m) => m.month + ': ' + cedis(m.spent)).join('; ')}>
              {d.months.map((m) => (
                <span key={m.month} className={'mk-month' + (m.month === nowKey ? ' is-now' : '')} tabIndex={0}>
                  <span className="mk-tip">{new Date(m.month + '-01T00:00').toLocaleDateString(activeIntlLocale(), { month: 'long' })}: {cedis(m.spent)}</span>
                  <i style={{ height: Math.round((m.spent / maxMonth) * 100) + '%' }} />
                  <small>{new Date(m.month + '-01T00:00').toLocaleDateString(activeIntlLocale(), { month: 'narrow' })}</small>
                </span>
              ))}
            </div>
          </Section>
          <Section card title={tr('By campaign')} sub={tr('Where the year\'s money went, campaign by campaign.')}>
            {d.campaigns.length ? (
              <ul className="mk-list">
                {d.campaigns.slice(0, 8).map((c) => (
                  <li key={c.id || 'none'} className="mk-li" style={{ cursor: c.id ? 'pointer' : 'default' }} onClick={() => c.id && navigate('/mkcampaigns?open=' + c.id)}>
                    <span className="mk-fill"><strong>{c.name || tr('Not part of a campaign')}</strong><span className="mk-muted">{c.lines === 1 ? tr('1 spend') : tr('{n} spends', { n: c.lines })}</span></span>
                    <span className="mk-li-amount">{cedis(c.spent)}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="mk-muted">{tr('Nothing spent this year.')}</p>}
          </Section>
        </div>
      </div>

      <Section title={tr('Every spend')} sub={tr('Newest first. Press one to change it; the receipt opens from the paper clip.')}>
        <div className="mk-tools">
          <select className="input" value={cat} onChange={(e) => setCat(e.target.value)} aria-label={tr('Category')}>
            <option value="">{tr('All categories')}</option>{Object.keys(SPEND).map((k) => <option key={k} value={k}>{L(SPEND, k)}</option>)}
          </select>
          <select className="input" value={campaignFilter} onChange={(e) => setCampaignFilter(e.target.value)} aria-label={tr('Campaign')}>
            <option value="">{tr('Any campaign')}</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <span className="mk-fill" />
          <div style={{ minWidth: 220 }}><SearchInput value={query} onChange={setQuery} placeholder={tr('Search spend…')} /></div>
        </div>
        {lines.length ? (
          <ul className="mk-list">
            {lines.map((l) => (
              <li key={l.id} className="mk-li" style={{ cursor: d.canManage ? 'pointer' : 'default' }} onClick={() => d.canManage && setEdit({ id: l.id, category: l.category, description: l.description, vendor: l.vendor, amount: String(l.amount), spentOn: l.spentOn, status: l.status, campaignId: l.campaign ? l.campaign.id : '', eventId: l.event ? l.event.id : '', receipt: l.receipt })}>
                <span className="mk-icon"><Glyph name="wallet" size={16} /></span>
                <span className="mk-fill"><strong>{l.description}</strong>
                  <span className="mk-muted">{[L(SPEND, l.category), l.vendor, dayLabel(l.spentOn, { day: 'numeric', month: 'short', year: 'numeric' }), l.campaign && l.campaign.name, l.event && l.event.name].filter(Boolean).join(' · ')}</span></span>
                {l.status === 'committed' && <Pill tone="warn">{tr('not paid yet')}</Pill>}
                {l.receipt && <button type="button" className="mk-receipt-chip" onClick={(e) => { e.stopPropagation(); openFile('/mk/spend/' + l.id + '/receipt'); }} title={tr('Open the receipt')}><Glyph name="link" size={14} />{tr('Receipt')}</button>}
                <span className="mk-li-amount">{cedis(l.amount)}</span>
              </li>
            ))}
          </ul>
        ) : <p className="mk-muted">{d.spend.length ? tr('Nothing matches.') : tr('Nothing spent this year yet.')}</p>}
      </Section>

      {edit && <SpendDialog f={edit} setF={setEdit} company={mk.company} campaigns={campaigns} events={events} onSaved={() => { setEdit(null); load(); setToast(tr('Saved.')); }} />}
      {setting && <BudgetDialog values={setting} setValues={setSetting} categories={d.categories} company={mk.company} year={year} onSaved={(x) => { setSetting(null); setD(x); setToast(tr('Budget saved.')); }} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function SpendDialog({ f, setF, company, campaigns, events, onSaved }) {
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function save(e) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      const fd = new FormData();
      Object.entries({ ...f, company, receipt: undefined }).forEach(([k, v]) => { if (v !== undefined && v !== null) fd.append(k, v); });
      if (file) fd.append('receipt', file);
      await api.upload(f.id ? '/mk/spend/' + f.id : '/mk/spend', fd);
      onSaved();
    } catch (err) { setError(err.message); setSaving(false); }
  }
  async function remove() {
    if (!window.confirm(tr('Remove this spend?'))) return;
    try { await api.del('/mk/spend/' + f.id); onSaved(); } catch (err) { setError(err.message); }
  }
  return (
    <MkDialog title={f.id ? tr('Change a spend') : tr('Record a spend')} sub={tr('Committed is money agreed (an order, a booking) but not paid yet; it counts against the budget too.')} onClose={() => !saving && setF(null)}
      footer={<>
        {f.id && <button type="button" className="mk-btn is-danger" onClick={remove} disabled={saving}>{tr('Remove')}</button>}
        <span style={{ flex: 1 }} />
        <button type="button" className="mk-btn is-ghost" onClick={() => setF(null)} disabled={saving}>{tr('Cancel')}</button>
        <button type="submit" form="mk-spend" className="mk-btn is-primary" disabled={saving}>{saving ? tr('Saving…') : tr('Save')}</button>
      </>}>
      <form id="mk-spend" className="mk-form" onSubmit={save}>
        <label className="field is-span"><span>{tr('What for')}</span><input className="input" required maxLength={300} value={f.description} onChange={set('description')} placeholder={tr('e.g. Facebook ads, chairs campaign, week 2')} /></label>
        <label className="field"><span>{tr('Category')}</span><select className="input" value={f.category} onChange={set('category')}>{Object.keys(SPEND).map((k) => <option key={k} value={k}>{L(SPEND, k)}</option>)}</select></label>
        <label className="field"><span>{tr('Paid to')}</span><input className="input" maxLength={160} value={f.vendor} onChange={set('vendor')} placeholder={tr('Vendor, printer, agency…')} /></label>
        <label className="field"><span>{tr('Amount (GHS)')}</span><input className="input" required type="number" min="0.01" step="any" value={f.amount} onChange={set('amount')} /></label>
        <label className="field"><span>{tr('Date')}</span><input className="input" required type="date" value={f.spentOn} onChange={set('spentOn')} /></label>
        <label className="field"><span>{tr('Paid?')}</span><select className="input" value={f.status} onChange={set('status')}><option value="paid">{tr('Paid')}</option><option value="committed">{tr('Agreed, not paid yet')}</option></select></label>
        <label className="field"><span>{tr('Campaign')}</span><select className="input" value={f.campaignId} onChange={set('campaignId')}><option value="">{tr('No campaign')}</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="field"><span>{tr('Event')}</span><select className="input" value={f.eventId} onChange={set('eventId')}><option value="">{tr('No event')}</option>{events.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
        <label className="field"><span>{tr('Receipt or invoice')}</span><input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.doc,.docx,.xls,.xlsx" onChange={(e) => setFile(e.target.files[0] || null)} />
          {f.receipt && !file && <span className="hint">{tr('Kept: {name}. Choose a file to replace it.', { name: f.receipt.name })}</span>}</label>
      </form>
      {error && <div className="error-banner">{error}</div>}
    </MkDialog>
  );
}

function BudgetDialog({ values, setValues, categories, company, year, onSaved }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const total = Object.values(values).reduce((s, v) => s + (Number(v) || 0), 0);
  async function save() {
    setSaving(true); setError(null);
    try { onSaved(await api.put('/mk/budget', { company, year, lines: Object.keys(SPEND).map((k) => ({ category: k, amount: Number(values[k]) || 0 })) })); }
    catch (err) { setError(err.message); setSaving(false); }
  }
  return (
    <MkDialog title={tr('The {year} budget', { year })} sub={tr('How much each kind of marketing may spend this year. Leave a category at 0 if it gets nothing.')} onClose={() => !saving && setValues(null)}
      footer={<><span className="mk-muted" style={{ flex: 1 }}>{tr('Total: {amount}', { amount: cedis(total) })}</span><button type="button" className="mk-btn is-ghost" onClick={() => setValues(null)} disabled={saving}>{tr('Cancel')}</button><button type="button" className="mk-btn is-primary" onClick={save} disabled={saving}>{saving ? tr('Saving…') : tr('Save the budget')}</button></>}>
      <div className="mk-form">
        {Object.keys(SPEND).map((k) => {
          const c = categories.find((x) => x.category === k);
          return (
            <label key={k} className="field"><span>{L(SPEND, k)}</span>
              <input className="input" type="number" min="0" step="any" value={values[k] || ''} onChange={(e) => setValues({ ...values, [k]: e.target.value })} />
              {c && c.spent > 0 && <span className="hint">{tr('{amount} spent so far', { amount: cedis(c.spent) })}</span>}
            </label>
          );
        })}
      </div>
      {error && <div className="error-banner">{error}</div>}
    </MkDialog>
  );
}
