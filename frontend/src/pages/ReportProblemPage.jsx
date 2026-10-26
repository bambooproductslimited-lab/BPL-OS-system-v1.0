import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import { shrinkPhoto } from './till/photoShrink';
import './ReportProblemPage.css';

// Report a problem (Work → Report a problem; backend maintenance.service
// reportChoices / report): anyone signed in — on the factory floor, in an
// office, in a restaurant — picks the machine or piece of equipment, says
// whether it still works, what is wrong, with photos. Whoever looks after
// assets is told at once; the reporter is told when it is fixed, and
// follows their reports here.

const URGENCY = {
  stopped: ['🛑', msg('It stopped working'), msg('Out of use until it is fixed.')],
  unsafe: ['⚠️', msg('It is not safe to use'), msg('Nobody should use it until it is checked.')],
  working: ['🔧', msg('It still works, but…'), msg('Something is wrong; it can wait a little.')]
};
const STATUS = {
  reported: ['📨', msg('Sent — waiting for a plan')], scheduled: ['🗓️', msg('Repair planned')], in_progress: ['🛠️', msg('Being fixed')], completed: ['✅', msg('Fixed')]
};
function dayText(day) { return day ? new Date(String(day).slice(0, 10) + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : ''; }
function ago(iso) {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 60) return tr('{n} min ago', { n: Math.max(1, m) });
  if (m < 1440) return tr('{n} h ago', { n: Math.round(m / 60) });
  return new Date(iso).toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short' });
}

export default function ReportProblemPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [assetId, setAssetId] = useState('');
  const [urgency, setUrgency] = useState('');
  const [what, setWhat] = useState('');
  const [photos, setPhotos] = useState([]);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(null);
  const load = useCallback(() => api.get('/maintenance/report').then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const asset = data && data.assets.find((a) => a.id === assetId);
  const groups = useMemo(() => {
    if (!data) return [];
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hit = data.assets.filter((a) => words.every((w) => (a.name + ' ' + a.assetNo + ' ' + a.location + ' ' + a.category + ' ' + a.companyName).toLowerCase().indexOf(w) >= 0));
    const by = new Map();
    hit.forEach((a) => { const k = a.companyName || tr('Other'); if (!by.has(k)) by.set(k, []); by.get(k).push(a); });
    return Array.from(by.entries());
  }, [data, q]);
  async function addPhoto(e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try { const p = await shrinkPhoto(f); setPhotos((l) => l.concat([p]).slice(0, 3)); } catch { setError(tr('That file is not a photo.')); }
  }
  async function send(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api.post('/maintenance/report', { assetId, urgency, what, photos });
      setSent(r); setAssetId(''); setUrgency(''); setWhat(''); setPhotos([]); setQ('');
      load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  if (!data) return <div className="rp"><p className="rp-wait">{error || tr('Loading…')}</p></div>;
  return (
    <div className="rp">
      <header className="rp-hero">
        <span className="rp-hero-art" aria-hidden="true">🛠️</span>
        <div>
          <h1>{tr('Something broken?')}</h1>
          <p>{tr('Tell whoever looks after the machines. It takes a minute, and you will hear when it is fixed.')}</p>
        </div>
      </header>

      {sent && (
        <div className="rp-sent" role="status">
          <span aria-hidden="true">🎉</span>
          <div><b>{tr('Sent. Thank you!')}</b><p>{tr('{name}: they were told and will plan the repair.', { name: sent.assetName })}</p></div>
          <button type="button" className="rp-x" onClick={() => setSent(null)} aria-label={tr('Close')}>✕</button>
        </div>
      )}

      <form className="rp-form" onSubmit={send}>
        <section className="rp-step">
          <h2><i>1</i>{tr('Which one?')}</h2>
          {asset ? (
            <div className="rp-picked">
              <span aria-hidden="true">⚙️</span>
              <div><b>{asset.name}</b><small>{asset.assetNo}{asset.location ? ' · ' + asset.location : ''}{asset.companyName ? ' · ' + asset.companyName : ''}</small></div>
              {asset.open > 0 && <em>{asset.open === 1 ? tr('1 problem already reported') : tr('{n} problems already reported', { n: asset.open })}</em>}
              <button type="button" className="btn btn-secondary" onClick={() => setAssetId('')}>{tr('Pick another one')}</button>
            </div>
          ) : (
            <>
              <input className="input rp-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Search: the machine, its number or where it is')} aria-label={tr('Search')} autoFocus />
              <div className="rp-assets">
                {groups.map(([co, list]) => (
                  <div key={co} className="rp-co">
                    <small>{co}</small>
                    <div className="rp-grid">
                      {list.slice(0, 60).map((a) => (
                        <button key={a.id} type="button" className={'rp-asset' + (a.status === 'in_repair' ? ' is-repair' : '')} onClick={() => setAssetId(a.id)}>
                          <b>{a.name}</b>
                          <small>{a.assetNo}{a.location ? ' · ' + a.location : ''}</small>
                          {a.status === 'in_repair' && <em>🛑 {tr('Out of use')}</em>}
                          {a.status !== 'in_repair' && a.open > 0 && <em>🔧 {tr('Reported')}</em>}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                {!groups.length && <p className="rp-none">{tr('Nothing found. Try another word.')}</p>}
              </div>
            </>
          )}
        </section>

        <section className={'rp-step' + (asset ? '' : ' is-off')}>
          <h2><i>2</i>{tr('Does it still work?')}</h2>
          <div className="rp-urgency" role="radiogroup" aria-label={tr('Does it still work?')}>
            {data.urgencies.map((u) => (
              <button key={u} type="button" role="radio" aria-checked={urgency === u} disabled={!asset} className={'rp-u is-' + u + (urgency === u ? ' is-on' : '')} onClick={() => setUrgency(u)}>
                <em aria-hidden="true">{URGENCY[u][0]}</em><b>{tr(URGENCY[u][1])}</b><small>{tr(URGENCY[u][2])}</small>
              </button>
            ))}
          </div>
        </section>

        <section className={'rp-step' + (asset && urgency ? '' : ' is-off')}>
          <h2><i>3</i>{tr('What is wrong?')}</h2>
          <textarea className="input" rows={3} maxLength={300} value={what} disabled={!asset || !urgency} onChange={(e) => setWhat(e.target.value)}
            placeholder={tr('e.g. the blade wobbles and makes a grinding noise')} aria-label={tr('What is wrong?')} />
          <div className="rp-photos">
            {photos.map((p, i) => <span key={i} className="rp-photo"><img src={p} alt="" /><button type="button" onClick={() => setPhotos(photos.filter((x, k) => k !== i))} aria-label={tr('Take it off')}>✕</button></span>)}
            {photos.length < 3 && (
              <label className={'rp-photo is-add' + (!asset || !urgency ? ' is-off' : '')}>
                <input type="file" accept="image/*" capture="environment" onChange={addPhoto} disabled={!asset || !urgency} />
                <b aria-hidden="true">📷</b><small>{tr('Add a photo')}</small>
              </label>
            )}
          </div>
        </section>

        {error && <div className="error-banner" role="alert">{error}</div>}
        <button type="submit" className="btn btn-primary rp-send" disabled={busy || !asset || !urgency || what.trim().length < 3}>📨 {tr('Send the report')}</button>
      </form>

      {data.mine.length > 0 && (
        <section className="rp-mine">
          <h2>{tr('My reports')}</h2>
          {data.mine.map((m) => {
            const st = STATUS[m.status] || STATUS.reported;
            return (
              <div key={m.id} className={'rp-report is-' + m.status}>
                <em aria-hidden="true">{(URGENCY[m.urgency] || URGENCY.working)[0]}</em>
                <div>
                  <b>{m.assetName}</b>
                  <p>{m.faultReport}</p>
                  <small>{m.reportedAt ? ago(m.reportedAt) : ''}{m.assetLocation ? ' · ' + m.assetLocation : ''}</small>
                </div>
                <span className="rp-st">{st[0]} {tr(st[1])}{m.status === 'scheduled' ? ' · ' + dayText(m.date) : ''}{m.status === 'completed' && m.technician ? ' · ' + m.technician : ''}</span>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}
