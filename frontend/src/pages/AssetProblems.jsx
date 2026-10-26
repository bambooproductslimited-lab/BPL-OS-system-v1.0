import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, API_URL } from '../api/client';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';

// Problems reported (Assets & maintenance, migration 0196): what anyone
// reported broken — on the factory floor, on a restaurant's till — the worst
// first, with their photos. Whoever manages assets plans a visit, marks it
// fixed (the page's own work dialog) or takes it off the list.

const URGENCY = { stopped: ['🛑', msg('Stopped working')], unsafe: ['⚠️', msg('Not safe to use')], working: ['🔧', msg('Still working')] };
const RANK = { stopped: 0, unsafe: 1, working: 2 };
const SOURCE = { till: msg('on the till'), floor: msg('in the OS'), office: msg('in the office') };
function ago(iso) {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 60) return tr('{n} min ago', { n: Math.max(1, m) });
  if (m < 1440) return tr('{n} h ago', { n: Math.round(m / 60) });
  return new Date(iso).toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short' });
}
function dayText(day) { return new Date(String(day).slice(0, 10) + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }); }
function today() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

function ProblemPhoto({ id, n }) {
  const [url, setUrl] = useState(null);
  const [big, setBig] = useState(false);
  useEffect(() => {
    let live = true, made = null;
    fetch(API_URL + '/maintenance/' + id + '/photos/' + n, { headers: api.authHeaders() }).then((r) => (r.ok ? r.blob() : null)).then((b) => { if (b && live) { made = URL.createObjectURL(b); setUrl(made); } }).catch(() => {});
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [id, n]);
  if (!url) return <span className="apb-photo is-empty" aria-hidden="true">📷</span>;
  return (
    <>
      <button type="button" className="apb-photo" onClick={() => setBig(true)} aria-label={tr('Photo {n}', { n: n + 1 })}><img src={url} alt="" /></button>
      {big && createPortal(<div className="apb-zoom" onClick={() => setBig(false)} role="dialog" aria-label={tr('Photo {n}', { n: n + 1 })}><img src={url} alt="" /></div>, document.body)}
    </>
  );
}

export default function AssetProblems({ records, canManage, focusId, onFixed, onChanged, onError }) {
  const [planning, setPlanning] = useState(null);
  const [plan, setPlan] = useState({ date: today(), technician: '' });
  const [busy, setBusy] = useState(false);
  const open = records.filter((r) => r.reportedAt && r.status !== 'completed')
    .sort((a, b) => (a.status === 'reported' ? 0 : 1) - (b.status === 'reported' ? 0 : 1) || (RANK[a.urgency] ?? 3) - (RANK[b.urgency] ?? 3) || String(b.reportedAt).localeCompare(String(a.reportedAt)));
  useEffect(() => {
    if (!focusId) return;
    const el = document.getElementById('apb-' + focusId);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focusId, open.length]);
  if (!open.length) return null;
  async function schedule(e, r) {
    e.preventDefault();
    setBusy(true);
    try { await api.post('/maintenance/' + r.id + '/schedule', plan); setPlanning(null); onChanged(tr('Repair planned for {date}.', { date: dayText(plan.date) })); }
    catch (err) { onError(err.message); } finally { setBusy(false); }
  }
  async function dismiss(r) {
    setBusy(true);
    try { await api.del('/maintenance/' + r.id); onChanged(tr('Taken off the list.')); } catch (err) { onError(err.message); } finally { setBusy(false); }
  }
  const stopped = open.filter((r) => r.urgency === 'stopped' || r.urgency === 'unsafe').length;
  return (
    <section className="apb" id="as-problems" aria-label={tr('Problems reported')}>
      <header className="apb-head">
        <span className="apb-bell" aria-hidden="true">🚨</span>
        <div>
          <h2>{tr('Problems reported')} <b>{open.length}</b></h2>
          <p>{stopped ? (stopped === 1 ? tr('1 is out of use or not safe.') : tr('{n} are out of use or not safe.', { n: stopped })) : tr('All still working; plan them when you can.')}</p>
        </div>
      </header>
      <div className="apb-list">
        {open.map((r, i) => {
          const u = URGENCY[r.urgency] || URGENCY.working;
          return (
            <article key={r.id} id={'apb-' + r.id} className={'apb-card is-' + (r.urgency || 'working') + (focusId === r.id ? ' is-focus' : '')} style={{ animationDelay: i * 0.04 + 's' }}>
              <div className="apb-top">
                <span className="apb-u"><em aria-hidden="true">{u[0]}</em>{tr(u[1])}</span>
                <span className="apb-when">{ago(r.reportedAt)}</span>
              </div>
              <h3>{r.assetName}</h3>
              <small className="apb-where">{r.assetNo}{r.assetLocation ? ' · ' + r.assetLocation : ''}{r.companyName ? ' · ' + r.companyName : ''}</small>
              <p className="apb-what">“{r.faultReport}”</p>
              <small className="apb-who">{r.reportedBy ? tr('Reported by {name}', { name: r.reportedBy }) : tr('Reported')} {tr(SOURCE[r.source] || SOURCE.office)}</small>
              {r.photos > 0 && <div className="apb-photos">{Array.from({ length: r.photos }, (_, n) => <ProblemPhoto key={n} id={r.id} n={n} />)}</div>}
              {r.status !== 'reported' && <div className="apb-planned">🗓️ {tr('Repair planned for {date}', { date: dayText(r.date) })}{r.technician ? ' · ' + r.technician : ''}</div>}
              {canManage && planning === r.id && (
                <form className="apb-plan" onSubmit={(e) => schedule(e, r)}>
                  <label><span>{tr('Day')}</span><input className="input" type="date" required min={today()} value={plan.date} onChange={(e) => setPlan({ ...plan, date: e.target.value })} /></label>
                  <label><span>{tr('Technician')}</span><input className="input" maxLength={60} value={plan.technician} onChange={(e) => setPlan({ ...plan, technician: e.target.value })} placeholder={tr('Who comes to fix it')} /></label>
                  <div className="apb-actions">
                    <button type="button" className="btn btn-secondary" onClick={() => setPlanning(null)}>{tr('Back')}</button>
                    <button type="submit" className="btn btn-primary" disabled={busy}>{tr('Plan it')}</button>
                  </div>
                </form>
              )}
              {canManage && planning !== r.id && (
                <div className="apb-actions">
                  <button type="button" className="btn btn-primary" onClick={() => onFixed(r)}>✅ {tr('Fixed')}</button>
                  {r.status === 'reported' && <button type="button" className="btn btn-secondary" onClick={() => { setPlan({ date: today(), technician: '' }); setPlanning(r.id); }}>🗓️ {tr('Plan a visit')}</button>}
                  <button type="button" className="apb-dismiss" disabled={busy} onClick={() => dismiss(r)}>{tr('Not a problem')}</button>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
