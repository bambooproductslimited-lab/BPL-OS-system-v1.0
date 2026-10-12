import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import { Section } from '../../components/DashKit';
import { tr } from '../../lib/i18n.jsx';
import { ChipPicker, Glyph, INTEL_KINDS, L, MkBanner, MkCompanies, MkDialog, MkEmpty, POSITIONS, Pill, cedis, dayLabel, todayIso, useMkCompany } from './mkKit';

// Competitors & market (backend mkBrand.service.js market()): who we
// compete with — where they are, how their prices sit against ours, what
// they do well and badly — and a running log of what anyone in marketing
// saw: a price (with ours beside it, so the gap is worked out), a
// promotion, a new product, news, reviews. The prices logged add up to
// each competitor's average gap, drawn from "cheaper than us" to "dearer".

const INTEL_GLYPH = { price: 'tag', promotion: 'ticket', product: 'gift', news: 'megaphone', review: 'chat', other: 'sparkle' };
const POS_TONE = { lower: 'bad', similar: 'warn', higher: 'good', unknown: 'muted' };
const EMPTY_COMP = { name: '', location: '', website: '', pricePosition: 'unknown', strengths: '', weaknesses: '', notes: '' };
function emptyIntel(competitorId) { return { kind: 'price', competitorId: competitorId || '', body: '', product: '', price: '', ourPrice: '', seenOn: todayIso(), source: '' }; }

// "12% dearer", "8% cheaper", "the same".
function gapWords(g) {
  if (g === null || g === undefined) return '';
  if (g === 0) return tr('the same as ours');
  return g > 0 ? tr('{n}% dearer than ours', { n: g }) : tr('{n}% cheaper than ours', { n: -g });
}
function webLink(w) { return /^https?:\/\//i.test(w) ? w : 'https://' + w; }

export default function MkMarketPage() {
  const mk = useMkCompany();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [comp, setComp] = useState(null);
  const [intel, setIntel] = useState(null);
  const [kind, setKind] = useState('all');
  const [who, setWho] = useState('');
  const [toast, setToast] = useState(null);
  const load = useCallback(() => { if (mk.company) api.get('/mk/market?company=' + mk.company).then(setD).catch((e) => setError(e.message)); }, [mk.company]);
  useEffect(() => { setD(null); load(); }, [load]);
  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(null), 3500); return () => clearTimeout(t); }, [toast]);

  const feed = useMemo(() => (d ? d.intel.filter((i) => (kind === 'all' || i.kind === kind) && (!who || (who === 'none' ? !i.competitor : i.competitor && i.competitor.id === who))) : []), [d, kind, who]);

  if (error && !d) return <div className="dk mk"><MkCompanies mk={mk} /><div className="error-banner">{error}</div></div>;
  if (!d) return <div className="dk mk"><MkCompanies mk={mk} /><p className="eyebrow">{tr('Loading…')}</p></div>;
  const t = d.totals;
  const priced = d.competitors.filter((c) => c.averageGap !== null).sort((a, b) => a.averageGap - b.averageGap);
  const scale = Math.max(20, ...priced.map((c) => Math.abs(c.averageGap)));

  async function removeComp(c) {
    if (!window.confirm(tr('Remove {name}? What was logged about them stays, without the name.', { name: c.name }))) return;
    try { setD(await api.del('/mk/competitors/' + c.id)); setToast(tr('Competitor removed.')); } catch (e) { setError(e.message); }
  }
  async function removeIntel(i) {
    if (!window.confirm(tr('Remove this entry?'))) return;
    try { setD(await api.del('/mk/intel/' + i.id)); } catch (e) { setError(e.message); }
  }

  return (
    <div className="dk mk">
      <MkCompanies mk={mk} />
      <MkBanner art="binoculars" eyebrow={tr('Marketing · Market')} title={tr('Competitors & the market')}
        sub={tr('Who we are up against, how their prices sit against ours, and everything anyone saw out there: a price, a promotion, a new product, a review.')}
        actions={<>
          <button type="button" className="mk-btn is-primary" onClick={() => setIntel(emptyIntel())}><Glyph name="plus" size={16} />{tr('Log what you saw')}</button>
          {d.canManage && <button type="button" className="mk-btn is-ghost" onClick={() => setComp({ ...EMPTY_COMP })}>{tr('Add a competitor')}</button>}
        </>}
        stats={[
          { glyph: 'binoculars', value: String(t.competitors), label: tr('competitors watched') },
          { glyph: 'clock', value: String(t.sightings30), label: tr('things seen in 30 days') },
          { glyph: 'tag', value: t.averageGap === null ? '—' : (t.averageGap > 0 ? '+' : t.averageGap < 0 ? '−' : '') + Math.abs(t.averageGap) + '%', label: tr('their prices against ours'), note: t.averageGap === null ? tr('log a price to see it') : gapWords(t.averageGap) }
        ]} />
      {error && <div className="error-banner">{error}</div>}

      {priced.length > 0 && (
        <Section title={tr('Their prices against ours')} sub={tr('The average gap of every price logged for each competitor. The middle line is our price; left of it they are cheaper, right of it dearer.')}>
          <div className="mk-card">
            <div className="mk-gapchart" role="table" aria-label={tr('Their prices against ours')}>
              <div className="mk-gapchart-axis" aria-hidden="true"><span>{tr('Cheaper than us')}</span><span>{tr('Our price')}</span><span>{tr('Dearer than us')}</span></div>
              {priced.map((c) => {
                const w = (Math.abs(c.averageGap) / scale) * 50;
                return (
                  <div key={c.id} className="mk-gapchart-row" role="row" title={c.name + ': ' + gapWords(c.averageGap)}>
                    <span className="mk-gapchart-name" role="cell">{c.name}</span>
                    <span className="mk-gapchart-track" role="cell">
                      <i className={c.averageGap < 0 ? 'is-below' : 'is-above'} style={c.averageGap < 0 ? { right: '50%', width: Math.max(1, w) + '%' } : { left: '50%', width: Math.max(1, w) + '%' }} />
                    </span>
                    <b className={'mk-gapchart-val ' + (c.averageGap < 0 ? 'is-below' : c.averageGap > 0 ? 'is-above' : '')} role="cell">{(c.averageGap > 0 ? '+' : c.averageGap < 0 ? '−' : '') + Math.abs(c.averageGap) + '%'}</b>
                  </div>
                );
              })}
            </div>
          </div>
        </Section>
      )}

      <Section title={tr('Competitors')} sub={tr('What they do well and badly, and how often we have seen them lately.')}>
        {d.competitors.length ? (
          <div className="mk-grid">
            {d.competitors.map((c) => (
              <div key={c.id} className={'mk-card mk-pos is-' + c.pricePosition}>
                <div className="mk-card-head">
                  <span className="mk-icon"><Glyph name="binoculars" /></span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h3 className="mk-card-title">{c.name}</h3>
                    <span className="mk-card-sub">{c.location || tr('Where: not noted')}</span>
                  </div>
                  <Pill tone={POS_TONE[c.pricePosition]}>{L(POSITIONS, c.pricePosition)}</Pill>
                </div>
                {c.website && <a className="mk-link" href={webLink(c.website)} target="_blank" rel="noopener noreferrer"><Glyph name="globe" size={14} />{c.website.replace(/^https?:\/\//i, '')}</a>}
                <span className="mk-gap">
                  {c.averageGap !== null ? <><Glyph name="tag" size={14} /><b className={c.averageGap < 0 ? 'is-below' : c.averageGap > 0 ? 'is-above' : ''}>{gapWords(c.averageGap)}</b></> : <span className="mk-muted">{tr('No price logged yet')}</span>}
                </span>
                {(c.strengths || c.weaknesses) && (
                  <div className="mk-sw">
                    <div><b>{tr('Good at')}</b>{c.strengths || '—'}</div>
                    <div><b>{tr('Weak at')}</b>{c.weaknesses || '—'}</div>
                  </div>
                )}
                {c.notes && <span className="mk-muted" style={{ whiteSpace: 'pre-wrap' }}>{c.notes}</span>}
                <span className="mk-muted">{c.sightings ? (c.sightings === 1 ? tr('Seen once, on {date}', { date: dayLabel(c.lastSeen, { day: 'numeric', month: 'short', year: 'numeric' }) }) : tr('Seen {n} times, last {date}', { n: c.sightings, date: dayLabel(c.lastSeen, { day: 'numeric', month: 'short', year: 'numeric' }) })) : tr('Nothing logged yet')}</span>
                <div className="mk-row" style={{ flexWrap: 'wrap', gap: 6 }}>
                  <button type="button" className="mk-btn is-ghost is-small" onClick={() => setIntel(emptyIntel(c.id))}><Glyph name="plus" size={14} />{tr('Log a sighting')}</button>
                  {c.sightings > 0 && <button type="button" className="mk-btn is-ghost is-small" onClick={() => { setWho(c.id); setKind('all'); const el = document.getElementById('mk-feed'); if (el) el.scrollIntoView({ behavior: 'smooth' }); }}>{tr('See what was seen')}</button>}
                  {d.canManage && <button type="button" className="mk-btn is-ghost is-small" onClick={() => setComp({ id: c.id, name: c.name, location: c.location || '', website: c.website || '', pricePosition: c.pricePosition, strengths: c.strengths || '', weaknesses: c.weaknesses || '', notes: c.notes || '' })}>{tr('Edit')}</button>}
                  {d.canManage && <button type="button" className="mk-btn is-danger is-small" onClick={() => removeComp(c)} aria-label={tr('Remove {name}', { name: c.name })}>✕</button>}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <MkEmpty glyph="binoculars" title={tr('No competitors yet')} action={d.canManage && <button type="button" className="mk-btn is-primary" onClick={() => setComp({ ...EMPTY_COMP })}>{tr('Add a competitor')}</button>}>
            {tr('Add the businesses customers compare us with. Then everyone can log their prices and promotions as they see them.')}
          </MkEmpty>
        )}
      </Section>

      <Section title={tr('What was seen')} sub={tr('Newest first. Anyone in marketing can add to it.')}>
        <div id="mk-feed" />
        {d.intel.length > 0 && (
          <div className="mk-tools" style={{ marginBottom: 12 }}>
            <div className="mk-chippick" role="radiogroup" aria-label={tr('Kind')}>
              <button type="button" role="radio" aria-checked={kind === 'all'} className={'mk-chipopt' + (kind === 'all' ? ' is-on' : '')} onClick={() => setKind('all')}>{tr('All')}</button>
              {Object.keys(INTEL_KINDS).filter((k) => d.intel.some((i) => i.kind === k)).map((k) => (
                <button key={k} type="button" role="radio" aria-checked={kind === k} className={'mk-chipopt' + (kind === k ? ' is-on' : '')} onClick={() => setKind(k)}><Glyph name={INTEL_GLYPH[k]} size={14} />{L(INTEL_KINDS, k)}</button>
              ))}
            </div>
            <span className="mk-fill" />
            <select className="input" value={who} onChange={(e) => setWho(e.target.value)} aria-label={tr('Competitor')}>
              <option value="">{tr('Every competitor')}</option>
              {d.competitors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              <option value="none">{tr('The market in general')}</option>
            </select>
          </div>
        )}
        {feed.length ? (
          <ul className="mk-feed">
            {feed.map((i) => (
              <li key={i.id}>
                <span className="mk-icon"><Glyph name={INTEL_GLYPH[i.kind] || 'sparkle'} /></span>
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span className="mk-row" style={{ flexWrap: 'wrap', gap: 6 }}>
                    <strong>{i.competitor ? i.competitor.name : tr('The market')}</strong>
                    <Pill tone="violet">{L(INTEL_KINDS, i.kind)}</Pill>
                    {i.product && <span className="mk-muted">{i.product}</span>}
                  </span>
                  <span style={{ lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{i.body}</span>
                  {(i.price !== null || i.ourPrice !== null) && (
                    <span className="mk-gap">
                      {i.price !== null && <span>{tr('Theirs')} <b>{cedis(i.price)}</b></span>}
                      {i.ourPrice !== null && <span>· {tr('ours')} <b>{cedis(i.ourPrice)}</b></span>}
                      {i.gap !== null && <b className={i.gap < 0 ? 'is-below' : i.gap > 0 ? 'is-above' : ''}>· {gapWords(i.gap)}</b>}
                    </span>
                  )}
                  <span className="mk-muted">{[dayLabel(i.seenOn, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }), i.source, i.by].filter(Boolean).join(' · ')}</span>
                </span>
                {(i.mine || d.canManage) && <button type="button" className="mk-btn is-ghost is-small" style={{ alignSelf: 'flex-start' }} onClick={() => removeIntel(i)} aria-label={tr('Remove this entry')}>✕</button>}
              </li>
            ))}
          </ul>
        ) : d.intel.length ? <p className="mk-muted">{tr('Nothing matches.')}</p> : (
          <MkEmpty glyph="tag" title={tr('Nothing logged yet')} action={<button type="button" className="mk-btn is-primary" onClick={() => setIntel(emptyIntel())}>{tr('Log what you saw')}</button>}>
            {tr('Saw a competitor\'s price at a fair, a promotion on Instagram, a new product in a shop? Log it with ours beside it and the gap is worked out.')}
          </MkEmpty>
        )}
      </Section>

      {comp && <CompetitorDialog f={comp} setF={setComp} company={mk.company} onSaved={(res) => { setD(res); setComp(null); setToast(tr('Competitor saved.')); }} />}
      {intel && <IntelDialog f={intel} setF={setIntel} company={mk.company} competitors={d.competitors} onSaved={(res) => { setD(res); setIntel(null); setToast(tr('Logged. Thank you!')); }} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function CompetitorDialog({ f, setF, company, onSaved }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e && e.target ? e.target.value : e });
  async function save(e) {
    e.preventDefault();
    setSaving(true); setError(null);
    try { onSaved(f.id ? await api.put('/mk/competitors/' + f.id, { ...f, company }) : await api.post('/mk/competitors', { ...f, company })); }
    catch (x) { setError(x.message); setSaving(false); }
  }
  return (
    <MkDialog wide title={f.id ? tr('Change the competitor') : tr('Add a competitor')} onClose={() => !saving && setF(null)}
      footer={<><button type="button" className="mk-btn is-ghost" onClick={() => setF(null)} disabled={saving}>{tr('Cancel')}</button><button type="submit" form="mk-comp" className="mk-btn is-primary" disabled={saving}>{saving ? tr('Saving…') : tr('Save')}</button></>}>
      <form id="mk-comp" className="mk-form" onSubmit={save}>
        <label className="field"><span>{tr('Name')}</span><input className="input" required maxLength={160} value={f.name} onChange={set('name')} /></label>
        <label className="field"><span>{tr('Where they are')}</span><input className="input" maxLength={200} value={f.location} onChange={set('location')} placeholder={tr('e.g. Kumasi, online')} /></label>
        <label className="field is-span"><span>{tr('Website or page (optional)')}</span><input className="input" maxLength={200} value={f.website} onChange={set('website')} placeholder="example.com" /></label>
        <div className="field is-span"><span>{tr('Their prices, on the whole')}</span>
          <ChipPicker single label={tr('Their prices')} value={f.pricePosition} onChange={set('pricePosition')} options={Object.keys(POSITIONS).map((k) => [k, L(POSITIONS, k)])} />
        </div>
        <label className="field"><span>{tr('What they are good at')}</span><textarea className="input" rows={3} maxLength={2000} value={f.strengths} onChange={set('strengths')} /></label>
        <label className="field"><span>{tr('Where they are weak')}</span><textarea className="input" rows={3} maxLength={2000} value={f.weaknesses} onChange={set('weaknesses')} /></label>
        <label className="field is-span"><span>{tr('Notes (optional)')}</span><textarea className="input" rows={2} maxLength={2000} value={f.notes} onChange={set('notes')} /></label>
      </form>
      {error && <div className="error-banner">{error}</div>}
    </MkDialog>
  );
}

function IntelDialog({ f, setF, company, competitors, onSaved }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e && e.target ? e.target.value : e });
  const gap = f.price !== '' && f.ourPrice !== '' && Number(f.ourPrice) > 0 ? Math.round(((Number(f.price) - Number(f.ourPrice)) / Number(f.ourPrice)) * 100) : null;
  async function save(e) {
    e.preventDefault();
    setSaving(true); setError(null);
    try { onSaved(await api.post('/mk/intel', { ...f, company })); } catch (x) { setError(x.message); setSaving(false); }
  }
  return (
    <MkDialog wide title={tr('Log what you saw')} sub={tr('A price, a promotion, a new product, news or reviews about a competitor or the market.')} onClose={() => !saving && setF(null)}
      footer={<><button type="button" className="mk-btn is-ghost" onClick={() => setF(null)} disabled={saving}>{tr('Cancel')}</button><button type="submit" form="mk-intel" className="mk-btn is-primary" disabled={saving}>{saving ? tr('Saving…') : tr('Log it')}</button></>}>
      <form id="mk-intel" className="mk-form" onSubmit={save}>
        <div className="field is-span"><span>{tr('What was it?')}</span>
          <ChipPicker single label={tr('Kind')} value={f.kind} onChange={set('kind')} options={Object.keys(INTEL_KINDS).map((k) => [k, L(INTEL_KINDS, k), INTEL_GLYPH[k]])} />
        </div>
        <label className="field"><span>{tr('Whose')}</span><select className="input" value={f.competitorId} onChange={set('competitorId')}><option value="">{tr('The market in general')}</option>{competitors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="field"><span>{tr('Product (optional)')}</span><input className="input" maxLength={160} value={f.product} onChange={set('product')} placeholder={tr('e.g. 2-seater bamboo sofa')} /></label>
        <label className="field is-span"><span>{tr('What you saw')}</span><textarea className="input" required rows={3} maxLength={2000} value={f.body} onChange={set('body')} placeholder={tr('e.g. 15% off all furniture for Easter, on their Instagram and a banner at the shop')} /></label>
        <label className="field"><span>{tr('Their price (GHS)')}</span><input className="input" type="number" min="0" step="any" value={f.price} onChange={set('price')} /></label>
        <label className="field"><span>{tr('Our price for the same (GHS)')}</span><input className="input" type="number" min="0" step="any" value={f.ourPrice} onChange={set('ourPrice')} /></label>
        {gap !== null && <p className="mk-note is-span" style={{ margin: 0 }}><Glyph name="tag" size={14} /> {tr('Theirs is {words}.', { words: gapWords(gap) })}</p>}
        <label className="field"><span>{tr('When')}</span><input className="input" type="date" required max={todayIso()} value={f.seenOn} onChange={set('seenOn')} /></label>
        <label className="field"><span>{tr('Where (optional)')}</span><input className="input" maxLength={200} value={f.source} onChange={set('source')} placeholder={tr('e.g. Their Instagram, a trade fair, a customer told us')} /></label>
      </form>
      {error && <div className="error-banner">{error}</div>}
    </MkDialog>
  );
}
