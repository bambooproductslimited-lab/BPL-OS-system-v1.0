import { useState } from 'react';
import { API_URL } from '../api/client';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';

// On a shop order's page (ShopOrderPage, backend bplVisits forOrder,
// migration 0195): its delivery or fitting — the day and the time window,
// on the way, done and who received it — the warranty, and something
// wrong: a repair asked for with photos, followed on its own page (/s/…).

function dayWords(day) { return new Date(day + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }); }
function when(iso) { return new Date(iso).toLocaleString(activeIntlLocale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
const SERVICE = { new: () => tr('We are looking at it'), visit: () => tr('Repair visit planned'), fixed: () => tr('Fixed'), closed: () => tr('Closed') };

function RepairForm({ token, lines, onSent, onClose }) {
  const [item, setItem] = useState(lines.length === 1 ? lines[0].description : '');
  const [problem, setProblem] = useState('');
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  function pick(e) {
    const add = Array.from(e.target.files || []).filter((f) => /^image\//.test(f.type));
    e.target.value = '';
    setFiles((l) => l.concat(add.map((f) => ({ f, url: URL.createObjectURL(f) }))).slice(0, 4));
  }
  async function send(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const fd = new FormData();
      fd.append('item', item); fd.append('problem', problem);
      files.forEach((x) => fd.append('photos', x.f));
      const r = await fetch(API_URL + '/shop/orders/' + encodeURIComponent(token) + '/service', { method: 'POST', body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j.error && j.error.message) || tr('Something went wrong. Please try again.'));
      onSent(j);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <form className="sop-card sop-repair" onSubmit={send}>
      <h2>🔧 {tr('Ask for a repair')}</h2>
      <p className="sop-pay-note">{tr('Tell us what is wrong, with photos if you can: we answer, and come to fix it.')}</p>
      {lines.length > 1 && (
        <div className="sop-repair-items" role="radiogroup" aria-label={tr('Which one')}>
          {lines.map((l, i) => <button key={i} type="button" role="radio" aria-checked={item === l.description} className={item === l.description ? 'is-on' : ''} onClick={() => setItem(l.description)}>{l.description}</button>)}
        </div>
      )}
      <textarea className="input" rows={4} required minLength={10} maxLength={1000} value={problem} onChange={(e) => setProblem(e.target.value)} placeholder={tr('What is wrong? e.g. a leg is loose and it wobbles')} aria-label={tr('What is wrong')} />
      <div className="sop-repair-photos">
        {files.map((x, i) => <span key={i}><img src={x.url} alt="" /><button type="button" onClick={() => setFiles(files.filter((y, k) => k !== i))} aria-label={tr('Take it off')}>✕</button></span>)}
        {files.length < 4 && <label className="sop-repair-add">📷 {tr('Add photos')}<input type="file" accept="image/*" multiple onChange={pick} hidden /></label>}
      </div>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="sop-repair-go">
        <button type="button" className="shp-link" onClick={onClose}>{tr('Cancel')}</button>
        <button type="submit" className="shp-go" disabled={busy || problem.trim().length < 10}>{busy ? tr('Sending…') : '🔧 ' + tr('Send my request')}</button>
      </div>
    </form>
  );
}

export function AfterSales({ token, o }) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(null);
  const a = o.after;
  if (!a) return null;
  const v = a.visit;
  const kind = v && v.kind === 'install' ? tr('fitting') : v && v.kind === 'repair' ? tr('repair visit') : tr('delivery');
  const under = a.warrantyUntil && a.warrantyUntil >= new Date().toISOString().slice(0, 10);
  return (
    <>
      {v && (
        <section className={'sop-card sop-visit is-' + v.status}>
          <span className="sop-visit-art" aria-hidden="true">{v.status === 'done' ? '✅' : v.status === 'on_way' ? '🚚' : v.kind === 'install' ? '🛠️' : '📦'}</span>
          <div>
            <small>{v.kind === 'install' ? tr('Your fitting') : tr('Your delivery')}</small>
            {v.status === 'done'
              ? <strong>{tr('Done {when}, received by {name}', { when: when(v.doneAt), name: v.signedName })}</strong>
              : v.status === 'failed' ? <strong>{tr('We could not come: we will call you to find another day.')}</strong>
                : <strong>{v.status === 'on_way' ? tr('On the way to you now') : dayWords(v.day)}</strong>}
            {v.status !== 'done' && v.status !== 'failed' && <span>🕒 {tr('Between {from} and {to}', { from: v.from, to: v.to })}{v.crew.length ? ' · ' + tr('with {names}', { names: v.crew.join(', ') }) : ''}</span>}
            {v.status === 'planned' && <span className="sop-visit-hint">{tr('We text you when we are on the way. Not there that day? Call us to move it.')}</span>}
            {v.status === 'done' && v.photos > 0 && <span>📷 {v.photos === 1 ? tr('1 photo taken') : tr('{n} photos taken', { n: v.photos })}</span>}
          </div>
          {v.status === 'planned' && <span className="sop-visit-kind">{kind}</span>}
        </section>
      )}
      {(a.warrantyUntil || a.services.length > 0 || a.canAskRepair) && (
        <section className="sop-card sop-after">
          {a.warrantyUntil && (
            <p className={'sop-warranty' + (under ? ' is-in' : '')}>
              <span aria-hidden="true">🛡️</span>{under ? tr('Under warranty until {day}', { day: dayWords(a.warrantyUntil) }) : tr('The warranty ended {day}', { day: dayWords(a.warrantyUntil) })}
            </p>
          )}
          {a.services.length > 0 && (
            <ul className="sop-services">
              {a.services.map((s) => <li key={s.token}><a href={'/s/' + s.token}><b>{s.ref}</b><span>{s.item || tr('Repair')}</span><em className={'is-' + s.status}>{SERVICE[s.status]()}</em></a></li>)}
            </ul>
          )}
          {sent && <p className="sop-flash is-paid" role="status">✅ {tr('Request {ref} sent: we look at it and call you.', { ref: sent.ref })} <a href={'/s/' + sent.token}>{tr('Follow it')}</a></p>}
          {a.canAskRepair && !open && !sent && <button type="button" className="shp-quote-link sop-ask-repair" onClick={() => setOpen(true)}>🔧 {tr('Something wrong? Ask for a repair')}</button>}
        </section>
      )}
      {open && <RepairForm token={token} lines={o.lines} onClose={() => setOpen(false)} onSent={(r) => { setOpen(false); setSent(r); }} />}
    </>
  );
}
