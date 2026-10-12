import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { Section } from '../../components/DashKit';
import { msg, tr } from '../../lib/i18n.jsx';
import { ChipPicker, Glyph, L, MkBanner, MkCompanies, MkDialog, MkEmpty, Pill, cedis, dayLabel, openFile, short, whole, useMkCompany } from './mkKit';

// Audiences (backend mkAudiences.service.js): who to talk to, written as
// rules the OS counts while you build them — "bought in the last 90
// days", "bought before but not for 6 months", "asked about chairs",
// "VIPs in Accra who came by WhatsApp". Saved, each is counted again every
// time the page opens and can be downloaded (name, phone, email) for a
// WhatsApp broadcast list, an SMS blast or a Facebook custom audience.
// Anyone who asked not to get marketing is always left out.

const STAGES = { lead: msg('Leads'), prospect: msg('Prospects'), active: msg('Customers'), vip: msg('VIPs'), inactive: msg('Gone quiet') };
const ORIGINS = { whatsapp: 'WhatsApp', facebook: 'Facebook', instagram: 'Instagram', email: msg('Email'), phone: msg('Phone'), walk_in: msg('Walk-in'), website: msg('Website'), other: msg('Other') };
const BASES = { customers: msg('Customers'), guests: msg('Restaurant guests') };
// Ready-made starting points: a name and the rules.
const IDEAS = [
  { name: msg('Bought in the last 90 days'), glyph: 'fire', rules: { boughtWithinDays: 90 } },
  { name: msg('Gone quiet: not bought for 6 months'), glyph: 'moon', rules: { notBoughtForDays: 180 } },
  { name: msg('Leads who never bought'), glyph: 'magnet', rules: { stages: ['lead', 'prospect'], neverBought: true } },
  { name: msg('Big spenders'), glyph: 'trophy', rules: { minSpend: 10000 } },
  { name: msg('Reachable on WhatsApp'), glyph: 'chat', rules: { hasPhone: true } }
];
const BLANK = { base: 'customers', stages: [], channels: [], boughtWithinDays: '', notBoughtForDays: '', neverBought: false, minSpend: '', minVisits: '', product: '', location: '', hasPhone: false, hasEmail: false };
const FACES = ['#7c3aed', '#db2777', '#2563c9', '#0f766e', '#b45309', '#4d7c0f'];
function faceColour(s) { let h = 0; for (const ch of String(s || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return FACES[h % FACES.length]; }
function initials(n) { return String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join(''); }

// The rules in a sentence, for the saved cards.
function rulesText(r) {
  const out = [];
  if (r.base === 'guests') out.push(tr('Restaurant guests'));
  else out.push(r.stages && r.stages.length ? r.stages.map((s) => L(STAGES, s)).join(', ') : tr('All customers'));
  if (r.channels && r.channels.length) out.push(tr('came by {list}', { list: r.channels.map((c) => L(ORIGINS, c)).join(', ') }));
  if (r.boughtWithinDays) out.push(tr('bought in the last {n} days', { n: r.boughtWithinDays }));
  if (r.notBoughtForDays) out.push(tr('not bought for {n} days', { n: r.notBoughtForDays }));
  if (r.neverBought) out.push(tr('never bought'));
  if (r.minSpend) out.push(tr('spent at least {amount}', { amount: cedis(r.minSpend) }));
  if (r.minVisits) out.push(tr('at least {n} visits', { n: r.minVisits }));
  if (r.product) out.push(tr('bought or asked about “{text}”', { text: r.product }));
  if (r.location) out.push(tr('in {place}', { place: r.location }));
  if (r.hasPhone) out.push(tr('with a phone number'));
  if (r.hasEmail) out.push(tr('with an email'));
  return out.join(' · ');
}

export default function MkAudiencesPage() {
  const mk = useMkCompany();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [builder, setBuilder] = useState(null);
  const [toast, setToast] = useState(null);
  const load = useCallback(() => { if (mk.company) api.get('/mk/audiences?company=' + mk.company).then(setD).catch((e) => setError(e.message)); }, [mk.company]);
  useEffect(() => { setD(null); load(); }, [load]);
  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(null), 3500); return () => clearTimeout(t); }, [toast]);

  async function remove(a) {
    if (!window.confirm(tr('Delete the audience “{name}”? The people stay in the CRM.', { name: a.name }))) return;
    try { setD(await api.del('/mk/audiences/' + a.id)); setToast(tr('Audience deleted.')); } catch (e) { setError(e.message); }
  }

  if (error && !d) return <div className="dk mk"><MkCompanies mk={mk} /><div className="error-banner">{error}</div></div>;
  if (!d) return <div className="dk mk"><MkCompanies mk={mk} /><p className="eyebrow">{tr('Loading…')}</p></div>;
  const reach = d.audiences.reduce((s, a) => Math.max(s, a.count), 0);
  const startNew = (rules, name) => setBuilder({ name: name || '', description: '', rules: { ...BLANK, base: d.restaurant && mk.company !== 'BPL' ? 'guests' : 'customers', ...(rules || {}) } });

  return (
    <div className="dk mk">
      <MkCompanies mk={mk} />
      <MkBanner art="users" eyebrow={tr('Marketing · Audiences')} title={tr('Audiences')}
        sub={tr('Who to talk to, as rules the OS counts for you: who bought lately, who went quiet, who asked about a product, who came by WhatsApp. Save one and download it for a broadcast list, an SMS blast or a Facebook audience.')}
        actions={d.canManage && <button type="button" className="mk-btn is-primary" onClick={() => startNew()}><Glyph name="plus" size={16} />{tr('Build an audience')}</button>}
        stats={[
          { glyph: 'users', value: String(d.audiences.length), label: tr('saved audiences') },
          { glyph: 'target', value: whole(reach), label: tr('in the biggest') },
          { glyph: 'chat', value: whole(d.audiences.reduce((s, a) => Math.max(s, a.withPhone), 0)), label: tr('reachable by phone') }
        ]} />
      {error && <div className="error-banner">{error}</div>}
      {d.canManage && (
        <Section title={tr('Start from an idea')} sub={tr('Each opens the builder with the rules filled in; change anything before saving.')}>
          <div className="mk-chippick">
            {IDEAS.map((i) => <button key={i.name} type="button" className="mk-chipopt" onClick={() => startNew(i.rules, tr(i.name))}><Glyph name={i.glyph} size={14} />{tr(i.name)}</button>)}
          </div>
        </Section>
      )}
      <Section title={tr('Saved audiences')} sub={tr('Counted again just now. People who asked not to get marketing are never in them.')}>
        {d.audiences.length ? (
          <div className="mk-grid">
            {d.audiences.map((a) => (
              <div key={a.id} className="mk-card">
                <div className="mk-card-head">
                  <span className="mk-icon"><Glyph name={a.rules.base === 'guests' ? 'heart' : 'users'} /></span>
                  <div className="mk-fill" style={{ flex: 1, minWidth: 0 }}>
                    <h3 className="mk-card-title">{a.name}</h3>
                    <span className="mk-card-sub">{a.description || rulesText(a.rules)}</span>
                  </div>
                </div>
                <div className="mk-count-big"><strong>{whole(a.count)}</strong><span className="mk-muted">{a.count === 1 ? tr('person') : tr('people')}</span></div>
                <div className="mk-row" style={{ flexWrap: 'wrap', gap: 6 }}>
                  <Pill tone="good" glyph="chat">{tr('{n} with a phone', { n: whole(a.withPhone) })}</Pill>
                  {a.rules.base === 'customers' && <Pill tone="info" glyph="inbox">{tr('{n} with an email', { n: whole(a.withEmail) })}</Pill>}
                  {a.optedOut > 0 && <Pill tone="muted">{tr('{n} left out (opted out)', { n: whole(a.optedOut) })}</Pill>}
                </div>
                {a.description && <span className="mk-muted">{rulesText(a.rules)}</span>}
                <span className="mk-muted">{tr('They have spent {amount} in all', { amount: cedis(a.spent) })} · {a.by}</span>
                <div className="mk-row" style={{ flexWrap: 'wrap', gap: 6 }}>
                  {d.canExport && <button type="button" className="mk-btn is-primary is-small" disabled={!a.count} onClick={() => openFile('/mk/audiences/' + a.id + '/export', true)}><Glyph name="download" size={14} />{tr('Download the list')}</button>}
                  {d.canManage && <button type="button" className="mk-btn is-ghost is-small" onClick={() => setBuilder({ id: a.id, name: a.name, description: a.description, rules: { ...BLANK, ...a.rules, boughtWithinDays: a.rules.boughtWithinDays ?? '', notBoughtForDays: a.rules.notBoughtForDays ?? '', minSpend: a.rules.minSpend ?? '', minVisits: a.rules.minVisits ?? '' } })}>{tr('Change it')}</button>}
                  {d.canManage && <button type="button" className="mk-btn is-danger is-small" onClick={() => remove(a)} aria-label={tr('Delete {name}', { name: a.name })} title={tr('Delete')}>✕</button>}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <MkEmpty glyph="users" title={tr('No audience saved yet')} action={d.canManage && <button type="button" className="mk-btn is-primary" onClick={() => startNew()}>{tr('Build an audience')}</button>}>
            {tr('Pick who is in it and watch the count change as you go. Saved, it is counted again whenever you open this page.')}
          </MkEmpty>
        )}
      </Section>
      {builder && <Builder b={builder} setB={setBuilder} company={mk.company} restaurant={d.restaurant}
        onSaved={(res) => { setD(res); setBuilder(null); setToast(tr('Audience saved.')); }} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function Builder({ b, setB, company, restaurant, onSaved }) {
  const [count, setCount] = useState(null);
  const [counting, setCounting] = useState(false);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const r = b.rules;
  const setR = (k, v) => setB({ ...b, rules: { ...r, [k]: v } });
  const val = (k) => (e) => setR(k, e.target.value);
  const seq = useRef(0);

  // Count again a moment after each change.
  const key = JSON.stringify(r);
  useEffect(() => {
    const n = ++seq.current;
    setCounting(true);
    const t = setTimeout(() => {
      api.post('/mk/audiences/preview', { company, rules: r })
        .then((res) => { if (n === seq.current) { setCount(res); setError(null); setCounting(false); } })
        .catch((e) => { if (n === seq.current) { setError(e.message); setCounting(false); } });
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, company]);

  async function save(e) {
    e.preventDefault();
    setSaving(true); setError(null);
    try { onSaved(b.id ? await api.put('/mk/audiences/' + b.id, { ...b, company }) : await api.post('/mk/audiences', { ...b, company })); }
    catch (x) { setError(x.message); setSaving(false); }
  }
  const guests = r.base === 'guests';

  return (
    <MkDialog wide title={b.id ? tr('Change the audience') : tr('Build an audience')} sub={tr('Every rule narrows it down. The count on the right follows as you go.')} onClose={() => !saving && setB(null)}
      footer={<><span className="mk-muted" style={{ marginRight: 'auto', fontWeight: 700, whiteSpace: 'nowrap', alignSelf: 'center' }}>{count ? (count.count === 1 ? tr('1 person') : tr('{n} people', { n: whole(count.count) })) : ''}</span><button type="button" className="mk-btn is-ghost" onClick={() => setB(null)} disabled={saving}>{tr('Cancel')}</button><button type="submit" form="mk-aud" className="mk-btn is-primary" disabled={saving}>{saving ? tr('Saving…') : tr('Save the audience')}</button></>}>
      <form id="mk-aud" className="mk-builder" onSubmit={save}>
        <div className="mk-rules">
          <label className="field"><span>{tr('Name')}</span><input className="input" required maxLength={120} value={b.name} onChange={(e) => setB({ ...b, name: e.target.value })} placeholder={tr('e.g. Hotel buyers gone quiet')} /></label>
          {restaurant && (
            <div className="mk-rule"><span>{tr('Who')}</span>
              <ChipPicker single label={tr('Who')} value={r.base} onChange={(v) => setB({ ...b, rules: { ...BLANK, base: v } })} options={Object.keys(BASES).map((k) => [k, L(BASES, k), k === 'guests' ? 'heart' : 'users'])} />
            </div>
          )}
          {!guests && (
            <>
              <div className="mk-rule"><span>{tr('Where they are in the CRM')}</span>
                <ChipPicker label={tr('Stage')} value={r.stages} onChange={(v) => setR('stages', v)} options={Object.keys(STAGES).map((k) => [k, L(STAGES, k)])} />
                <small className="mk-muted">{tr('None picked means all of them.')}</small>
              </div>
              <div className="mk-rule"><span>{tr('How they first came to us')}</span>
                <ChipPicker label={tr('First came by')} value={r.channels} onChange={(v) => setR('channels', v)} options={Object.keys(ORIGINS).map((k) => [k, L(ORIGINS, k)])} />
              </div>
            </>
          )}
          <div className="mk-rule"><span>{tr('When they last bought')}</span>
            <div className="mk-rule-row">{tr('Bought in the last')}<input className="input" type="number" min="1" max="3650" value={r.boughtWithinDays} onChange={val('boughtWithinDays')} disabled={r.neverBought} />{tr('days')}</div>
            <div className="mk-rule-row">{tr('Has not bought for')}<input className="input" type="number" min="1" max="3650" value={r.notBoughtForDays} onChange={val('notBoughtForDays')} disabled={r.neverBought} />{tr('days')}</div>
            <label className="mk-rule-row"><input type="checkbox" checked={r.neverBought} onChange={(e) => setB({ ...b, rules: { ...r, neverBought: e.target.checked, boughtWithinDays: '', notBoughtForDays: '' } })} style={{ width: 18, height: 18 }} />{tr('Never bought anything')}</label>
          </div>
          <div className="mk-rule"><span>{tr('How much')}</span>
            <div className="mk-rule-row">{tr('Spent at least')}<input className="input" type="number" min="0" step="any" value={r.minSpend} onChange={val('minSpend')} />GHS</div>
            {guests && <div className="mk-rule-row">{tr('Came at least')}<input className="input" type="number" min="1" value={r.minVisits} onChange={val('minVisits')} />{tr('times')}</div>}
          </div>
          <label className="mk-rule"><span>{guests ? tr('Ordered (a dish or drink)') : tr('Bought or asked about (a product)')}</span>
            <input className="input" maxLength={80} value={r.product} onChange={val('product')} placeholder={guests ? tr('e.g. jollof') : tr('e.g. chair, flooring, straws')} />
          </label>
          {!guests && <label className="mk-rule"><span>{tr('Where they are (town or area)')}</span><input className="input" maxLength={80} value={r.location} onChange={val('location')} placeholder={tr('e.g. Accra, East Legon')} /></label>}
          <div className="mk-rule"><span>{tr('Can be reached')}</span>
            <label className="mk-rule-row"><input type="checkbox" checked={r.hasPhone} onChange={(e) => setR('hasPhone', e.target.checked)} style={{ width: 18, height: 18 }} />{tr('Has a phone number (WhatsApp, SMS)')}</label>
            {!guests && <label className="mk-rule-row"><input type="checkbox" checked={r.hasEmail} onChange={(e) => setR('hasEmail', e.target.checked)} style={{ width: 18, height: 18 }} />{tr('Has an email address')}</label>}
          </div>
          <label className="field"><span>{tr('What it is for (optional)')}</span><textarea className="input" rows={2} maxLength={500} value={b.description} onChange={(e) => setB({ ...b, description: e.target.value })} placeholder={tr('e.g. The December bulk-order WhatsApp broadcast')} /></label>
        </div>
        <div className="mk-card mk-count" aria-live="polite">
          <span className="mk-muted" style={{ fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em' }}>{counting ? tr('Counting…') : tr('In this audience')}</span>
          <div className="mk-count-big"><strong style={{ opacity: counting ? 0.5 : 1 }}>{count ? whole(count.count) : '—'}</strong><span className="mk-muted">{count && count.count === 1 ? tr('person') : tr('people')}</span></div>
          {count && (
            <>
              <div className="mk-row" style={{ flexWrap: 'wrap', gap: 6 }}>
                <Pill tone="good" glyph="chat">{tr('{n} with a phone', { n: whole(count.withPhone) })}</Pill>
                {!guests && <Pill tone="info" glyph="inbox">{tr('{n} with an email', { n: whole(count.withEmail) })}</Pill>}
                {count.optedOut > 0 && <Pill tone="muted">{tr('{n} left out (opted out)', { n: whole(count.optedOut) })}</Pill>}
              </div>
              <span className="mk-muted">{tr('Between them they have spent {amount}.', { amount: cedis(count.spent) })}</span>
              {count.people ? (
                count.people.length ? (
                  <ul className="mk-people">
                    {count.people.map((p) => (
                      <li key={p.id}>
                        <span className="mk-face" style={{ background: faceColour(p.name) }}>{initials(p.name)}</span>
                        <span className="mk-fill" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                          <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</strong>
                          <span className="mk-muted">{[p.stage ? L(STAGES, p.stage) : null, p.visits ? tr('{n} visits', { n: p.visits }) : null, p.lastAt ? tr('last bought {date}', { date: dayLabel(p.lastAt, { day: 'numeric', month: 'short', year: 'numeric' }) }) : tr('never bought')].filter(Boolean).join(' · ')}</span>
                        </span>
                        <span className="mk-li-amount">{short(p.spent)}</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="mk-muted">{tr('Nobody matches every rule. Loosen one.')}</p>
              ) : <p className="mk-muted">{tr('Names show to people who can see customers.')}</p>}
              {count.people && count.count > count.people.length && <span className="mk-muted">{tr('The first {n}, biggest spenders first.', { n: count.people.length })}</span>}
            </>
          )}
        </div>
      </form>
      {error && <div className="error-banner">{error}</div>}
    </MkDialog>
  );
}
