import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { API_URL } from '../api/client';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import DeviceLanguage from '../components/DeviceLanguage';
import './ShopPage.css';
import './ShopOrderPage.css';

// A repair request's own page on online.bplghana.com (/s/<its link>;
// backend bplVisits serviceView, migration 0195): what was asked, the
// warranty, Bamboo Products' answer, and the repair visit when planned.

function dayWords(day) { return new Date(day + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }); }
function when(iso) { return new Date(iso).toLocaleString(activeIntlLocale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
const STEPS = [['new', '📨', () => tr('Asked')], ['visit', '🗓️', () => tr('Visit planned')], ['fixed', '✅', () => tr('Fixed')]];

export default function ShopServicePage() {
  const { token } = useParams();
  const [s, setS] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let live = true;
    const load = () => fetch(API_URL + '/shop/service/' + encodeURIComponent(token)).then((r) => r.json().then((j) => {
      if (!live) return;
      if (!r.ok) setError((j.error && j.error.message) || tr('Something went wrong. Please try again.')); else { setS(j); document.title = tr('Your repair request') + ' ' + j.ref; }
    })).catch(() => live && setError(tr('Something went wrong. Please try again.')));
    load();
    const t = setInterval(load, 30000);
    return () => { live = false; clearInterval(t); };
  }, [token]);
  if (error && !s) return <div className="shp shp-mid"><img src="/logo.png" alt="Bamboo Products Limited" className="shp-logo" /><h1>{tr('We cannot find that request')}</h1><p>{error}</p></div>;
  if (!s) return <div className="shp shp-mid"><span className="shp-spin" aria-hidden="true">🔧</span><p>{tr('Loading…')}</p></div>;
  const at = s.status === 'closed' ? 2 : STEPS.findIndex((x) => x[0] === s.status);
  return (
    <div className="shp sop">
      <header className="sop-head">
        <a href="/" className="sop-back" aria-label={tr('Back to the shop')}><img src="/logo.png" alt="" className="shp-logo" /></a>
        <span className="sop-head-t"><small>{tr('Your repair request')}</small><strong>{s.ref}</strong></span>
        <a className="sop-acct" href="/account" aria-label={tr('My account')}>👤<span> {tr('My account')}</span></a>
        <DeviceLanguage className="shp-lang sop-lang" />
      </header>
      <section className={'sop-hero svc-hero is-' + s.status}>
        <span className="sop-hero-ico" aria-hidden="true">{s.status === 'fixed' ? '✅' : s.status === 'visit' ? '🗓️' : s.status === 'closed' ? '📁' : '🔧'}</span>
        <h1>{s.status === 'fixed' ? tr('Hello {name}, it is fixed', { name: s.name }) : s.status === 'visit' ? tr('Hello {name}, we are coming to fix it', { name: s.name }) : s.status === 'closed' ? tr('Hello {name}, this request is closed', { name: s.name }) : tr('Hello {name}, we have your request', { name: s.name })}</h1>
        {s.visit && s.visit.status !== 'done' && s.visit.status !== 'cancelled' && s.visit.status !== 'failed' && <p>🗓️ {dayWords(s.visit.day)} · {tr('Between {from} and {to}', { from: s.visit.from, to: s.visit.to })}</p>}
        {s.visit && s.visit.status === 'done' && <p>✅ {tr('Done {when}, received by {name}', { when: when(s.visit.doneAt), name: s.visit.signedName })}</p>}
      </section>
      {s.status !== 'closed' && (
        <ol className="sop-steps" aria-label={tr('Where your request is')}>
          {STEPS.map(([k, ico, label], i) => (
            <li key={k} className={(i <= at ? 'is-done' : '') + (i === at ? ' is-now' : '')} style={{ '--i': i }}>
              <span className="sop-dot" aria-hidden="true">{i <= at ? ico : ''}</span>
              <span className="sop-step-t"><strong>{label()}</strong>{k === 'new' && <small>{when(s.createdAt)}</small>}</span>
            </li>
          ))}
        </ol>
      )}
      {s.answer && <section className="sop-card svc-answer"><span aria-hidden="true">💬</span><div><small>{tr('Bamboo Products says')}</small><p>{s.answer}</p></div></section>}
      <section className="sop-card">
        <h2>{tr('What you told us')}</h2>
        {s.item && <p className="svc-item">🪑 {s.item}</p>}
        <p className="svc-problem">“{s.problem}”</p>
        {s.photos > 0 && <p className="sop-pay-note">📷 {s.photos === 1 ? tr('1 photo sent') : tr('{n} photos sent', { n: s.photos })}</p>}
        {(s.warranty !== null || s.underWarranty !== null) && (
          <p className={'sop-warranty' + ((s.warranty === null ? s.underWarranty : s.warranty) ? ' is-in' : '')}>
            <span aria-hidden="true">🛡️</span>
            {s.warranty === true ? tr('Under warranty: the repair is free.') : s.warranty === false ? tr('Not under warranty: we tell you the price first.') : s.underWarranty ? tr('Under warranty until {day}', { day: dayWords(s.warrantyUntil) }) : tr('The warranty ended {day}', { day: dayWords(s.warrantyUntil) })}
          </p>
        )}
        {s.orderToken && <p className="sop-pay-note"><a href={'/o/' + s.orderToken}>📦 {tr('Your order {no}', { no: s.orderNo })}</a></p>}
      </section>
      <p className="shp-hint is-center">{tr('This page updates by itself.')}</p>
      <footer className="shp-foot">Bamboo Products Limited · {tr('Made in Ghana from bamboo')} 🎋</footer>
    </div>
  );
}
