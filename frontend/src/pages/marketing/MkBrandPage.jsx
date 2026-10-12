import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import { Section } from '../../components/DashKit';
import { tr } from '../../lib/i18n.jsx';
import { ASSET_KINDS, Glyph, L, MkBanner, MkCompanies, MkDialog, MkEmpty, Pill, dayLabel, daysBetween, openFile, todayIso, useMkCompany, useProtectedImage, whole } from './mkKit';

// The brand kit (backend mkBrand.service.js), open to everyone signed in:
// anyone making a quotation cover, a sign, a post or a presentation finds
// the logo, the colours (press one to copy its code), the fonts, how we
// sound and the do's and don'ts here, with every file marketing keeps —
// logos, guidelines, templates, photos, videos, fonts, print-ready
// artwork — and when a bought photo's or font's licence runs out.
// Marketing (marketing.manage) keeps it up to date.

const KIND_GLYPH = { logo: 'sparkle', guideline: 'book', template: 'file', photo: 'camera', video: 'video', font: 'tag', print: 'flag', other: 'file' };
const EMPTY_ASSET = { kind: 'logo', name: '', description: '', tags: '', licenceUntil: '', file: null };

// White or near-black text, whichever reads better on the colour.
function inkOn(hex) {
  const n = parseInt(String(hex || '#000000').slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  const lum = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  return (1.05) / (lum + 0.05) >= (lum + 0.05) / 0.05 ? '#ffffff' : '#111827';
}
function sizeText(b) {
  if (!b) return '';
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  return Math.max(1, Math.round(b / 1024)) + ' KB';
}
// One line, one point.
function lines(text) {
  const list = String(text || '').split('\n').map((l) => l.replace(/^[-•*]\s*/, '').trim()).filter(Boolean);
  return list.length ? <ul>{list.map((l, i) => <li key={i}>{l}</li>)}</ul> : '—';
}
function ext(name) { const m = String(name || '').match(/\.([a-z0-9]{1,5})$/i); return m ? m[1] : ''; }

export default function MkBrandPage() {
  const mk = useMkCompany();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [kind, setKind] = useState('all');
  const [q, setQ] = useState('');
  const [editBrand, setEditBrand] = useState(null);
  const [asset, setAsset] = useState(null);
  const [toast, setToast] = useState(null);
  useEffect(() => { if (mk.company) { setD(null); api.get('/mk/brand?company=' + mk.company).then(setD).catch((e) => setError(e.message)); } }, [mk.company]);
  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(null), 3000); return () => clearTimeout(t); }, [toast]);

  const shown = useMemo(() => {
    if (!d) return [];
    const words = q.trim().toLowerCase();
    return d.assets.filter((a) => (kind === 'all' || a.kind === kind) && (!words || [a.name, a.description, a.fileName, ...(a.tags || [])].join(' ').toLowerCase().includes(words)));
  }, [d, kind, q]);

  if (error && !d) return <div className="dk mk"><MkCompanies mk={mk} /><div className="error-banner">{error}</div></div>;
  if (!d) return <div className="dk mk"><MkCompanies mk={mk} /><p className="eyebrow">{tr('Loading…')}</p></div>;
  const b = d.brand;
  const today = todayIso();
  const expiring = d.assets.filter((a) => a.licenceUntil && (a.licenceExpired || daysBetween(today, a.licenceUntil) <= 30));
  const kinds = Object.keys(ASSET_KINDS).filter((k) => d.assets.some((a) => a.kind === k));
  const empty = !b.tagline && !b.voice && !b.colours.length && !b.fonts && !b.dos && !b.donts;

  function copy(c) {
    const done = () => setToast(tr('{hex} copied.', { hex: c.hex }));
    if (navigator.clipboard) navigator.clipboard.writeText(c.hex).then(done, () => setToast(c.hex));
    else setToast(c.hex);
  }
  async function remove(a) {
    if (!window.confirm(tr('Remove “{name}” from the brand kit?', { name: a.name }))) return;
    try { setD(await api.del('/mk/assets/' + a.id)); setToast(tr('File removed.')); } catch (e) { setError(e.message); }
  }
  const openBrandForm = () => setEditBrand({ tagline: b.tagline, voice: b.voice, colours: b.colours.map((c) => ({ ...c })), fonts: b.fonts, dos: b.dos, donts: b.donts });

  return (
    <div className="dk mk">
      <MkCompanies mk={mk} />
      <MkBanner art="palette" eyebrow={tr('Marketing · Brand kit')} title={tr('The {name} brand', { name: d.company.name })}
        sub={b.tagline ? '“' + b.tagline + '”' : tr('The logo, colours, fonts and voice, and every file you need to make something look like us. Open to everyone.')}
        actions={d.canManage && <>
          <button type="button" className="mk-btn is-primary" onClick={() => setAsset({ ...EMPTY_ASSET })}><Glyph name="upload" size={16} />{tr('Add a file')}</button>
          <button type="button" className="mk-btn is-ghost" onClick={openBrandForm}>{tr('Edit the brand')}</button>
        </>}
        stats={[
          { glyph: 'palette', value: String(b.colours.length), label: tr('brand colours') },
          { glyph: 'file', value: String(d.assets.length), label: tr('files to use') },
          { glyph: 'download', value: whole(d.assets.reduce((s, a) => s + (a.downloads || 0), 0)), label: tr('downloads') },
          ...(expiring.length ? [{ glyph: 'clock', value: String(expiring.length), label: tr('licences ending'), tone: 'warn' }] : [])
        ]} />
      {error && <div className="error-banner">{error}</div>}

      {empty ? (
        <Section title={tr('The brand')}>
          <MkEmpty glyph="palette" title={tr('The brand is not written down yet')} action={d.canManage && <button type="button" className="mk-btn is-primary" onClick={openBrandForm}>{tr('Write it down')}</button>}>
            {tr('The tagline, the colours with their codes, the fonts, how we sound, and what to do and never do with the logo: once here, everyone makes things that look and sound like us.')}
          </MkEmpty>
        </Section>
      ) : (
        <>
          {b.colours.length > 0 && (
            <Section title={tr('Colours')} sub={tr('Press a colour to copy its code. “Aa” shows the text colour that reads on it.')}>
              <div className="mk-swatches">
                {b.colours.map((c, i) => (
                  <button key={i} type="button" className="mk-swatch" onClick={() => copy(c)} title={tr('Copy {hex}', { hex: c.hex })}>
                    <i style={{ background: c.hex, color: inkOn(c.hex), display: 'grid', placeItems: 'center', fontStyle: 'normal', fontWeight: 800, fontSize: 22 }}>Aa</i>
                    <span><strong>{c.name}</strong><code>{c.hex.toUpperCase()}</code></span>
                  </button>
                ))}
              </div>
            </Section>
          )}
          <div className="mk-two">
            {(b.voice || b.fonts) && (
              <Section card title={tr('How we look and sound')}>
                {b.fonts && <div className="mk-note" style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}><Glyph name="tag" size={16} /><span><strong>{tr('Fonts')}</strong><br />{b.fonts}</span></div>}
                {b.voice && <p style={{ margin: 0, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{b.voice}</p>}
              </Section>
            )}
            {(b.dos || b.donts) && (
              <Section card title={tr('Do\'s and don\'ts')}>
                <div className="mk-dosdonts">
                  <div className="mk-do"><h4><Glyph name="check" size={15} />{tr('Do')}</h4>{lines(b.dos)}</div>
                  <div className="mk-do is-dont"><h4>✕ {tr('Never')}</h4>{lines(b.donts)}</div>
                </div>
              </Section>
            )}
          </div>
        </>
      )}

      <Section title={tr('Files')} sub={tr('Logos, templates, photos and more. Press a picture to see it full size.')}>
        {d.assets.length > 0 && (
          <div className="mk-tools" style={{ marginBottom: 12 }}>
            <div className="mk-chippick" role="radiogroup" aria-label={tr('Kind')}>
              <button type="button" role="radio" aria-checked={kind === 'all'} className={'mk-chipopt' + (kind === 'all' ? ' is-on' : '')} onClick={() => setKind('all')}>{tr('All')} · {d.assets.length}</button>
              {kinds.map((k) => (
                <button key={k} type="button" role="radio" aria-checked={kind === k} className={'mk-chipopt' + (kind === k ? ' is-on' : '')} onClick={() => setKind(k)}>
                  <Glyph name={KIND_GLYPH[k]} size={14} />{L(ASSET_KINDS, k)} · {d.assets.filter((a) => a.kind === k).length}
                </button>
              ))}
            </div>
            <span className="mk-fill" />
            <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Search files')} aria-label={tr('Search files')} />
          </div>
        )}
        {shown.length ? (
          <div className="mk-assets">{shown.map((a) => <AssetCard key={a.id} a={a} canManage={d.canManage} onEdit={() => setAsset({ id: a.id, kind: a.kind, name: a.name, description: a.description || '', tags: (a.tags || []).join(', '), licenceUntil: a.licenceUntil || '' })} onRemove={() => remove(a)} />)}</div>
        ) : d.assets.length ? <p className="mk-muted">{tr('No file matches.')}</p> : (
          <MkEmpty glyph="file" title={tr('No files yet')} action={d.canManage && <button type="button" className="mk-btn is-primary" onClick={() => setAsset({ ...EMPTY_ASSET })}>{tr('Add a file')}</button>}>
            {tr('Put the logo (light and dark), the letterhead, post templates and the best product photos here, so nobody uses an old or blurry one.')}
          </MkEmpty>
        )}
      </Section>

      {editBrand && <BrandDialog f={editBrand} setF={setEditBrand} company={mk.company} onSaved={(res) => { setD(res); setEditBrand(null); setToast(tr('Brand saved.')); }} />}
      {asset && <AssetDialog f={asset} setF={setAsset} company={mk.company} onSaved={(res) => { setD(res); setAsset(null); setToast(tr('File saved.')); }} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function AssetCard({ a, canManage, onEdit, onRemove }) {
  const img = useProtectedImage(a.isImage ? '/mk/assets/' + a.id + '/file' : null);
  const left = a.licenceUntil ? daysBetween(todayIso(), a.licenceUntil) : null;
  return (
    <div className="mk-asset">
      <button type="button" className="mk-asset-art" style={{ border: 0, padding: 0, cursor: 'pointer', width: '100%' }} onClick={() => openFile('/mk/assets/' + a.id + '/file')} aria-label={tr('Open {name}', { name: a.name })}>
        {img ? <img src={img} alt="" loading="lazy" /> : <Glyph name={KIND_GLYPH[a.kind] || 'file'} size={44} />}
        {ext(a.fileName) && <span className="mk-asset-ext">{ext(a.fileName)}</span>}
      </button>
      <div className="mk-asset-body">
        <strong title={a.name}>{a.name}</strong>
        <span className="mk-muted">{[L(ASSET_KINDS, a.kind), sizeText(a.size), a.downloads ? tr('{n} downloads', { n: a.downloads }) : null].filter(Boolean).join(' · ')}</span>
        {a.description && <span className="mk-muted" style={{ overflowWrap: 'anywhere' }}>{a.description}</span>}
        {a.tags && a.tags.length > 0 && <span className="mk-row" style={{ flexWrap: 'wrap', gap: 4 }}>{a.tags.map((t) => <Pill key={t} tone="violet">#{t}</Pill>)}</span>}
        {a.licenceUntil && (a.licenceExpired ? <Pill tone="bad" glyph="clock">{tr('Licence ended {date}', { date: dayLabel(a.licenceUntil, { day: 'numeric', month: 'short', year: 'numeric' }) })}</Pill>
          : left <= 30 ? <Pill tone="warn" glyph="clock">{tr('Licence ends in {n} days', { n: left })}</Pill>
            : <span className="mk-muted">{tr('Licensed until {date}', { date: dayLabel(a.licenceUntil, { day: 'numeric', month: 'short', year: 'numeric' }) })}</span>)}
        <div className="mk-asset-acts">
          <button type="button" className="mk-btn is-primary is-small" onClick={() => openFile('/mk/assets/' + a.id + '/file', true)}><Glyph name="download" size={14} />{tr('Download')}</button>
          {canManage && <button type="button" className="mk-btn is-ghost is-small" onClick={onEdit} aria-label={tr('Change {name}', { name: a.name })}>{tr('Edit')}</button>}
          {canManage && <button type="button" className="mk-btn is-danger is-small" onClick={onRemove} aria-label={tr('Remove {name}', { name: a.name })}>✕</button>}
        </div>
      </div>
    </div>
  );
}

function BrandDialog({ f, setF, company, onSaved }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const setColour = (i, k, v) => setF({ ...f, colours: f.colours.map((c, j) => (j === i ? { ...c, [k]: v } : c)) });
  async function save(e) {
    e.preventDefault();
    setSaving(true); setError(null);
    try { onSaved(await api.put('/mk/brand', { ...f, company })); } catch (x) { setError(x.message); setSaving(false); }
  }
  return (
    <MkDialog wide title={tr('Edit the brand')} sub={tr('Everyone in the company sees this.')} onClose={() => !saving && setF(null)}
      footer={<><button type="button" className="mk-btn is-ghost" onClick={() => setF(null)} disabled={saving}>{tr('Cancel')}</button><button type="submit" form="mk-brand" className="mk-btn is-primary" disabled={saving}>{saving ? tr('Saving…') : tr('Save')}</button></>}>
      <form id="mk-brand" className="mk-form" onSubmit={save}>
        <label className="field is-span"><span>{tr('Tagline')}</span><input className="input" maxLength={200} value={f.tagline} onChange={set('tagline')} placeholder={tr('e.g. Made in Ghana, made to last')} /></label>
        <div className="field is-span"><span>{tr('Colours')}</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {f.colours.map((c, i) => (
              <div key={i} className="mk-row" style={{ gap: 8 }}>
                <input type="color" value={/^#[0-9a-f]{6}$/i.test(c.hex) ? c.hex : '#000000'} onChange={(e) => setColour(i, 'hex', e.target.value)} aria-label={tr('Pick the colour')} style={{ width: 44, height: 38, padding: 2, border: '1px solid var(--mk-line)', borderRadius: 10, background: 'none' }} />
                <input className="input" style={{ width: '7.5rem', fontFamily: 'ui-monospace, monospace' }} value={c.hex} onChange={(e) => setColour(i, 'hex', e.target.value.trim())} pattern="#[0-9a-fA-F]{6}" required aria-label={tr('Colour code')} />
                <input className="input mk-fill" maxLength={40} value={c.name} onChange={(e) => setColour(i, 'name', e.target.value)} placeholder={tr('e.g. Bamboo green')} aria-label={tr('Colour name')} />
                <button type="button" className="mk-btn is-ghost is-small" onClick={() => setF({ ...f, colours: f.colours.filter((_, j) => j !== i) })} aria-label={tr('Remove the colour')}>✕</button>
              </div>
            ))}
            {f.colours.length < 16 && <button type="button" className="mk-btn is-ghost is-small" style={{ alignSelf: 'flex-start' }} onClick={() => setF({ ...f, colours: [...f.colours, { name: '', hex: '#3f7d3b' }] })}><Glyph name="plus" size={14} />{tr('Add a colour')}</button>}
          </div>
        </div>
        <label className="field is-span"><span>{tr('Fonts')}</span><input className="input" maxLength={500} value={f.fonts} onChange={set('fonts')} placeholder={tr('e.g. Headings in Poppins Bold, text in Inter')} /></label>
        <label className="field is-span"><span>{tr('How we sound')}</span><textarea className="input" rows={3} maxLength={2000} value={f.voice} onChange={set('voice')} placeholder={tr('e.g. Warm, proud of Ghanaian craft, plain words, never pushy')} /></label>
        <label className="field"><span>{tr('Do')}</span><textarea className="input" rows={4} maxLength={2000} value={f.dos} onChange={set('dos')} placeholder={tr('One per line')} /></label>
        <label className="field"><span>{tr('Never')}</span><textarea className="input" rows={4} maxLength={2000} value={f.donts} onChange={set('donts')} placeholder={tr('One per line')} /></label>
      </form>
      {error && <div className="error-banner">{error}</div>}
    </MkDialog>
  );
}

function AssetDialog({ f, setF, company, onSaved }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function save(e) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      if (f.id) onSaved(await api.patch('/mk/assets/' + f.id, { name: f.name, kind: f.kind, description: f.description, tags: f.tags, licenceUntil: f.licenceUntil }));
      else {
        const fd = new FormData();
        fd.append('file', f.file);
        ['kind', 'name', 'description', 'tags', 'licenceUntil'].forEach((k) => fd.append(k, f[k] || ''));
        fd.append('company', company);
        onSaved(await api.upload('/mk/assets', fd));
      }
    } catch (x) { setError(x.message); setSaving(false); }
  }
  return (
    <MkDialog title={f.id ? tr('Change the file') : tr('Add a file')} onClose={() => !saving && setF(null)}
      footer={<><button type="button" className="mk-btn is-ghost" onClick={() => setF(null)} disabled={saving}>{tr('Cancel')}</button><button type="submit" form="mk-asset" className="mk-btn is-primary" disabled={saving || (!f.id && !f.file)}>{saving ? tr('Saving…') : tr('Save')}</button></>}>
      <form id="mk-asset" className="mk-form" onSubmit={save}>
        {!f.id && <label className="field is-span"><span>{tr('File')}</span><input className="input" type="file" required onChange={(e) => { const file = e.target.files[0] || null; setF({ ...f, file, name: f.name || (file ? file.name.replace(/\.[^.]+$/, '') : '') }); }} /><small className="hint">{tr('Pictures, PDFs, videos, fonts, design files and zips, up to 100 MB.')}</small></label>}
        <label className="field"><span>{tr('Kind')}</span><select className="input" value={f.kind} onChange={set('kind')}>{Object.keys(ASSET_KINDS).map((k) => <option key={k} value={k}>{L(ASSET_KINDS, k)}</option>)}</select></label>
        <label className="field"><span>{tr('Name')}</span><input className="input" maxLength={160} value={f.name} onChange={set('name')} placeholder={tr('e.g. Logo on dark backgrounds')} /></label>
        <label className="field is-span"><span>{tr('What it is for (optional)')}</span><input className="input" maxLength={500} value={f.description} onChange={set('description')} /></label>
        <label className="field"><span>{tr('Tags (optional)')}</span><input className="input" maxLength={200} value={f.tags} onChange={set('tags')} placeholder={tr('e.g. chairs, outdoor, 2026')} /></label>
        <label className="field"><span>{tr('Licence ends (bought photos, fonts)')}</span><input className="input" type="date" value={f.licenceUntil} onChange={set('licenceUntil')} /></label>
      </form>
      {error && <div className="error-banner">{error}</div>}
    </MkDialog>
  );
}
