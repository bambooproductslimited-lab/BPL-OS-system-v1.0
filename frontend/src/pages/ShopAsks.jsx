import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { money } from '../lib/currency';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';

// What customers ask of the online shop besides orders (backend
// shopReviews.service.js, shopQuotes.service.js): their reviews of what they
// bought — shown on the shop, hidden, or answered — and their requests for a
// quote, with photos of the space or of a piece they like, priced in a draft
// quotation for them.

function day(d) { return new Date(String(d).length === 10 ? d + 'T12:00:00' : d).toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', year: 'numeric' }); }
function Stars({ n }) {
  return <span className="sho-stars" role="img" aria-label={tr('{n} out of 5', { n })}>{[1, 2, 3, 4, 5].map((i) => <i key={i} className={i <= Math.round(n) ? 'is-on' : ''} aria-hidden="true">★</i>)}</span>;
}
function Tabs({ tabs, value, onChange, counts }) {
  return (
    <div className="sho-filters" role="tablist">
      {tabs.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={value === k} className={value === k ? 'is-on' : ''} onClick={() => onChange(k)}>{label()}{counts && counts[k] > 0 && <em className="sho-count">{counts[k]}</em>}</button>)}
    </div>
  );
}

const REVIEW_TABS = [['pending', () => tr('To look at')], ['shown', () => tr('On the shop')], ['hidden', () => tr('Hidden')]];

export function ReviewsDialog({ onClose, onChanged }) {
  const { can } = useAuth();
  const [tab, setTab] = useState('pending');
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [answer, setAnswer] = useState(null); // { id, text }
  const load = useCallback(() => api.get('/shop-orders/reviews?status=' + tab).then(setD).catch((e) => setError(e.message)), [tab]);
  useEffect(() => { load(); }, [load]);
  async function decide(r, patch) {
    setBusy(r.id); setError(null);
    try { await api.patch('/shop-orders/reviews/' + r.id, patch); setAnswer(null); await load(); onChanged(); } catch (e) { setError(e.message); } finally { setBusy(null); }
  }
  const c = d && d.counts;
  return createPortal(
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <div className="dialog sho-dlg is-wide" role="dialog" aria-modal="true" aria-labelledby="sho-rv-title" onClick={(e) => e.stopPropagation()}>
        <div className="sho-dlg-head">
          <h2 id="sho-rv-title">⭐ {tr('Reviews')}</h2>
          <button type="button" className="sho-code-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        {c && (
          <div className="sho-rv-sum">
            <strong>{c.average != null ? c.average.toFixed(1) : '–'}</strong>
            <span>{c.average != null ? <Stars n={c.average} /> : <small>{tr('No stars on the shop yet')}</small>}<small>{c.shown === 1 ? tr('1 review on the shop') : tr('{n} reviews on the shop', { n: c.shown })}</small></span>
            {c.pending > 0 && <em>{c.pending === 1 ? tr('1 to look at') : tr('{n} to look at', { n: c.pending })}</em>}
          </div>
        )}
        <Tabs tabs={REVIEW_TABS} value={tab} onChange={(k) => { setTab(k); setD(null); }} counts={c ? { pending: c.pending } : null} />
        {error && <div className="error-banner" role="alert">{error}</div>}
        {!d ? <p className="muted">{tr('Loading…')}</p> : !d.reviews.length ? (
          <div className="sho-empty is-small"><span aria-hidden="true">{tab === 'pending' ? '🎉' : '⭐'}</span><strong>{tab === 'pending' ? tr('Nothing to look at') : tr('No reviews here')}</strong>
            <p>{tr('Customers are asked to rate what they bought once their order is done.')}</p></div>
        ) : (
          <ul className="sho-rv-list">
            {d.reviews.map((r, i) => (
              <li key={r.id} className={'sho-rv is-' + r.status} style={{ '--i': Math.min(i, 10) }}>
                <div className="sho-rv-top">
                  <Stars n={r.rating} />
                  <strong>{r.itemName}</strong>
                  <small>{r.name} · {r.orderNo} · {day(r.at)}</small>
                </div>
                {r.words ? <p className="sho-rv-words">“{r.words}”</p> : <p className="sho-rv-words is-none">{tr('Stars only, no words.')}</p>}
                {answer && answer.id === r.id ? (
                  <label className="sho-field">{tr('Our answer, shown under the review')}
                    <textarea className="input" rows={2} maxLength={400} autoFocus value={answer.text} onChange={(e) => setAnswer({ ...answer, text: e.target.value })} placeholder={tr('e.g. Thank you! Enjoy it.')} /></label>
                ) : r.reply ? <p className="sho-rv-reply"><b>💬 {tr('Our answer')}</b> {r.reply}</p> : null}
                {can('invoice.manage') && (
                  <div className="sho-rv-acts">
                    {answer && answer.id === r.id ? (
                      <>
                        <button type="button" className="btn btn-secondary" onClick={() => setAnswer(null)} disabled={busy === r.id}>{tr('Cancel')}</button>
                        <button type="button" className="btn btn-primary" onClick={() => decide(r, { reply: answer.text })} disabled={busy === r.id}>{tr('Save the answer')}</button>
                      </>
                    ) : (
                      <>
                        <button type="button" className="btn btn-secondary" onClick={() => setAnswer({ id: r.id, text: r.reply || '' })} disabled={busy === r.id}>💬 {r.reply ? tr('Change the answer') : tr('Answer')}</button>
                        {r.status !== 'hidden' && <button type="button" className="btn btn-secondary" onClick={() => decide(r, { status: 'hidden' })} disabled={busy === r.id}>🙈 {tr('Hide')}</button>}
                        {r.status !== 'shown' && <button type="button" className="btn btn-primary" onClick={() => decide(r, { status: 'shown' })} disabled={busy === r.id}>👀 {tr('Show on the shop')}</button>}
                      </>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>, document.body
  );
}

const QUOTE_TABS = [['new', () => tr('New')], ['quoted', () => tr('Priced')], ['closed', () => tr('Closed')], ['', () => tr('All')]];
const QUOTE_STATUS = { new: ['🆕', () => tr('New')], quoted: ['📝', () => tr('Priced')], closed: ['✕', () => tr('Closed')] };
function quotationWords(s) {
  if (s === 'draft') return tr('Draft, not sent yet');
  if (s === 'accepted' || s === 'converted') return tr('Approved');
  if (s === 'rejected') return tr('Declined');
  return tr('Sent');
}

// One of a request's photos: fetched with the staff sign-in (they are not
// public), shown small, tapped to see it big.
function QuotePhoto({ id, n, onOpen }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let gone = false, made = null;
    fetch(api.url('/shop-orders/quotes/' + id + '/photos/' + n), { headers: api.authHeaders() })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => { if (b && !gone) { made = URL.createObjectURL(b); setUrl(made); } })
      .catch(() => {});
    return () => { gone = true; if (made) URL.revokeObjectURL(made); };
  }, [id, n]);
  return (
    <button type="button" className="sho-qr-ph" style={{ '--i': n }} onClick={() => url && onOpen(url)} aria-label={tr('Photo {n}', { n: n + 1 })}>
      {url ? <img src={url} alt="" /> : <i aria-hidden="true">📷</i>}
    </button>
  );
}

export function QuoteRequestsDialog({ openId, onClose, onChanged }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState(openId ? '' : 'new');
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [big, setBig] = useState(null);
  const load = useCallback(() => api.get('/shop-orders/quotes' + (tab ? '?status=' + tab : '')).then(setD).catch((e) => setError(e.message)), [tab]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!d || !openId) return;
    const el = document.getElementById('sho-qr-' + openId);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [d, openId]);

  async function make(q) {
    setBusy(q.id); setError(null);
    try { const r = await api.post('/shop-orders/quotes/' + q.id + '/quotation'); onChanged(); navigate('/quotations?open=' + r.quotationId); } catch (e) { setError(e.message); setBusy(null); }
  }
  async function setStatus(q, status) {
    setBusy(q.id); setError(null);
    try { await api.patch('/shop-orders/quotes/' + q.id, { status }); await load(); onChanged(); } catch (e) { setError(e.message); } finally { setBusy(null); }
  }
  const c = d && d.counts;
  return createPortal(
    <div className="dialog-backdrop" onClick={() => !busy && (big ? setBig(null) : onClose())}>
      <div className="dialog sho-dlg is-wide" role="dialog" aria-modal="true" aria-labelledby="sho-qr-title" onClick={(e) => e.stopPropagation()}>
        <div className="sho-dlg-head">
          <h2 id="sho-qr-title">📐 {tr('Quote requests')}</h2>
          <button type="button" className="sho-code-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        <p className="muted">{tr('From "Ask for a quote" on the shop: made to size, or in numbers. Make the quotation, price it, then send it; the customer approves it online and sees it in My account.')}</p>
        <Tabs tabs={QUOTE_TABS} value={tab} onChange={(k) => { setTab(k); setD(null); }} counts={c ? { new: c.new } : null} />
        {error && <div className="error-banner" role="alert">{error}</div>}
        {!d ? <p className="muted">{tr('Loading…')}</p> : !d.requests.length ? (
          <div className="sho-empty is-small"><span aria-hidden="true">📐</span><strong>{tab === 'new' ? tr('No new requests') : tr('No requests here')}</strong>
            <p>{tr('Customers ask from the shop, or from an item: "Need another size?"')}</p></div>
        ) : (
          <ul className="sho-qr-list">
            {d.requests.map((q, i) => (
              <li key={q.id} id={'sho-qr-' + q.id} className={'sho-qr is-' + q.status + (openId === q.id ? ' is-picked' : '')} style={{ '--i': Math.min(i, 10) }}>
                <div className="sho-o-top">
                  <span className={'sho-tag is-qr-' + q.status}>{QUOTE_STATUS[q.status][0]} {QUOTE_STATUS[q.status][1]()}</span>
                  <strong>{q.number}</strong>
                  <small>{day(q.createdAt)}</small>
                  {q.budget != null && <b className="sho-qr-budget">{tr('Budget {amount}', { amount: money(q.budget) })}</b>}
                </div>
                <h3 className="sho-qr-what">{q.what}{q.qty > 1 && <em>× {q.qty}</em>}</h3>
                {(q.size || q.area || q.neededBy || q.item) && (
                  <div className="sho-qr-facts">
                    {q.size && <span>📏 {q.size}</span>}
                    {q.area && <span>📍 {q.area}</span>}
                    {q.neededBy && <span>📅 {tr('Needed by {day}', { day: day(q.neededBy) })}</span>}
                    {q.item && <span>🎋 {tr('Asked from: {name}', { name: q.item.name })}</span>}
                  </div>
                )}
                {q.note && <p className="sho-o-note">“{q.note}”</p>}
                {q.photos.length > 0 && <div className="sho-qr-photos">{q.photos.map((p) => <QuotePhoto key={p.n} id={q.id} n={p.n} onOpen={setBig} />)}</div>}
                <div className="sho-o-who">
                  <span className="sho-av" aria-hidden="true">{q.name.replace(/^zq\s+/i, '').slice(0, 1).toUpperCase()}</span>
                  <span><strong>{q.name}</strong><small><a href={'tel:' + q.phone}>{q.phone}</a>{q.email ? ' · ' + q.email : ''}</small></span>
                </div>
                <div className="sho-o-foot">
                  {q.quotation ? <Link className={'sho-inv' + (q.quotation.status === 'accepted' || q.quotation.status === 'converted' ? ' is-paid' : '')} to={'/quotations?open=' + q.quotation.id}>📝 {q.quotation.quoteNo} · {quotationWords(q.quotation.status)}</Link> : <span />}
                  {can('quotation.manage') && (
                    <span className="sho-acts">
                      {q.status === 'closed'
                        ? <button type="button" className="btn btn-secondary" disabled={busy === q.id} onClick={() => setStatus(q, 'new')}>↩ {tr('Open again')}</button>
                        : <button type="button" className="btn btn-secondary" disabled={busy === q.id} onClick={() => setStatus(q, 'closed')}>{tr('Close')}</button>}
                      {!q.quotation && q.status !== 'closed' && <button type="button" className="btn btn-primary" disabled={busy === q.id} onClick={() => make(q)}>📝 {tr('Make the quotation')}</button>}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {big && <button type="button" className="sho-qr-big" onClick={(e) => { e.stopPropagation(); setBig(null); }} aria-label={tr('Close')}><img src={big} alt={tr('Photo')} /></button>}
    </div>, document.body
  );
}
