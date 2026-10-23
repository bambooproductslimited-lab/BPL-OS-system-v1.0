import { useEffect, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';
import { RANGES, rangeOf, useTip } from './ranges';
import './growth.css';
import './fifth.css';

// Back office → Guests → Feedback (backend restaurantFeedback): how guests
// rated their visits on their receipt, what they said was good or not, the
// dishes they liked, who served the happiest tables; and each one, the
// unhappy ones first to follow up privately — a note of what was done, and
// a WhatsApp message to the guest if they said yes. Happy and unhappy are
// the two series (blue and orange, validated for colour-blind readers).

const FACES = ['😞', '🙁', '😐', '🙂', '😍'];
const TAG = { food: () => tr('Food'), service: () => tr('Service'), speed: () => tr('Speed'), value: () => tr('Value'), ambience: () => tr('Ambience'), cleanliness: () => tr('Cleanliness') };
const SHOW = [['all', () => tr('All')], ['open', () => tr('To follow up')], ['unhappy', () => tr('Unhappy')], ['happy', () => tr('Happy')]];
function when(s) { return new Date(s).toLocaleString(activeIntlLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }

function FollowUp({ item, onDone, onCancel }) {
  const [reply, setReply] = useState('');
  const [message, setMessage] = useState(() => tr('Hello, thank you for telling us about your visit. We are sorry it was not right. We would love to make it up to you.'));
  return (
    <form className="fb-follow" onSubmit={(e) => { e.preventDefault(); onDone({ reply, message: item.phone ? message : undefined }); }}>
      <label className="field"><span>{tr('What was done (for the team)')}</span>
        <input className="input" maxLength={600} value={reply} onChange={(e) => setReply(e.target.value)} placeholder={tr('e.g. called them, a free dessert next time')} autoFocus /></label>
      {item.phone ? (
        <label className="field"><span>{tr('Message to {name} on WhatsApp', { name: item.guest || tr('the guest') })}</span>
          <textarea className="input" rows={3} maxLength={600} value={message} onChange={(e) => setMessage(e.target.value)} /></label>
      ) : <p className="dk-muted">{tr('They did not say we may get in touch, so there is no message to send.')}</p>}
      <div className="tp-pay-go">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>{tr('Cancel')}</button>
        <button type="submit" className="btn btn-primary">{item.phone ? '💬 ' + tr('Followed up · open WhatsApp') : '✓ ' + tr('Followed up')}</button>
      </div>
    </form>
  );
}

export default function FeedbackReport({ token, pin, onFail }) {
  const [range, setRange] = useState('30');
  const [show, setShow] = useState('all');
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null);
  const [tipOn, tipNode] = useTip();
  const r = rangeOf(range);
  function ask(extra) {
    setBusy(true);
    return posFetch('POST', '/pos/settings/feedback', token, { managerPin: pin || undefined, from: r.from, to: r.to, ...extra })
      .then((d) => { setData(d); if (d.whatsapp) window.open(d.whatsapp, '_blank', 'noopener'); }).catch(onFail).finally(() => setBusy(false));
  }
  useEffect(() => { ask(); }, [range, token, pin]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <section className="ts-sec"><p className="dk-muted">{busy ? tr('Loading…') : ''}</p></section>;
  const s = data.summary;
  const distMax = Math.max(1, ...data.distribution.map((d) => d.count));
  const tagMax = Math.max(1, ...data.tags.map((t) => Math.max(t.happy, t.unhappy)));
  const items = data.items.filter((x) => (show === 'open' ? x.rating <= 2 && x.status !== 'resolved' : show === 'unhappy' ? x.rating <= 2 : show === 'happy' ? x.rating >= 4 : true));
  return (
    <section className={'ts-sec in fb' + (busy ? ' is-busy' : '')}>
      <div className="in-filters">
        <div className="ts-chips" role="radiogroup" aria-label={tr('When')}>
          {RANGES.map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={range === k} className={range === k ? 'is-on' : ''} onClick={() => setRange(k)}>{tr(label)}</button>)}
        </div>
      </div>
      {!data.on && <p className="ts-note">💡 {tr('Feedback is off: turn it on in Setup → Bookings, tips and rewards.')}</p>}

      <div className="fb-hero">
        <div className="fb-score">
          <span className="fb-face" aria-hidden="true">{s.average ? FACES[Math.max(0, Math.min(4, Math.round(s.average) - 1))] : '🤔'}</span>
          <div><strong>{s.average != null ? s.average.toFixed(1) : '—'}<small>/5</small></strong><span>{s.count === 1 ? tr('1 guest said') : tr('{n} guests said', { n: s.count })}</span></div>
        </div>
        <div className="in-kpis">
          {[['💬', tr('Answered'), s.responseRate != null ? s.responseRate + '%' : '—', tr('of {n} sales', { n: s.sales })],
            ['😍', tr('Happy (4–5)'), s.happy, null], ['😞', tr('Unhappy (1–2)'), s.unhappy, null],
            ['📞', tr('To follow up'), s.open, null]].map(([art, label, value, sub]) => (
            <div key={label} className={'in-kpi' + (label === tr('To follow up') && s.open > 0 ? ' is-alert' : '')}><span className="in-kpi-ico" aria-hidden="true">{art}</span><span className="in-kpi-label">{label}</span><strong>{value}</strong>{sub && <small className="dk-muted">{sub}</small>}</div>
          ))}
        </div>
      </div>

      <div className="in-grid">
        <article className="in-card">
          <h3>{tr('The faces')}</h3>
          <ul className="fb-dist is-plain">
            {data.distribution.slice().reverse().map((d) => (
              <li key={d.rating}><span aria-hidden="true">{FACES[d.rating - 1]}</span><b>{d.rating}</b>
                <span className="in-bar-track" {...tipOn(tr('{n} of 5', { n: d.rating }) + ': ' + d.count + (s.count ? ' · ' + Math.round(d.count / s.count * 100) + '%' : ''))}><span className="in-bar" style={{ width: Math.max(d.count ? 2 : 0, d.count / distMax * 100) + '%' }} /></span>
                <i>{d.count}</i></li>
            ))}
          </ul>
        </article>
        <article className="in-card">
          <h3>{tr('What they mentioned')}</h3>
          <p className="in-legend"><span><i className="in-key is-now" aria-hidden="true" />{tr('Happy')}</span><span><i className="in-key is-cost" aria-hidden="true" />{tr('Unhappy')}</span></p>
          <ul className="fb-tags is-plain">
            {data.tags.map((t) => (
              <li key={t.tag}><span>{TAG[t.tag] ? TAG[t.tag]() : t.tag}</span>
                <span className="fb-pair">
                  <span className="fb-pair-bar is-happy" {...tipOn((TAG[t.tag] ? TAG[t.tag]() : t.tag) + ' · ' + tr('Happy') + ': ' + t.happy)}><i style={{ width: t.happy / tagMax * 100 + '%' }} /></span>
                  <span className="fb-pair-bar is-unhappy" {...tipOn((TAG[t.tag] ? TAG[t.tag]() : t.tag) + ' · ' + tr('Unhappy') + ': ' + t.unhappy)}><i style={{ width: t.unhappy / tagMax * 100 + '%' }} /></span>
                </span>
                <small>{t.happy} · {t.unhappy}</small></li>
            ))}
          </ul>
        </article>
        {(data.dishes.length > 0 || data.people.length > 0) && (
          <article className="in-card">
            <h3>{tr('Dishes and the team')}</h3>
            {data.dishes.length > 0 && <ul className="fb-chips is-plain">{data.dishes.map((d) => <li key={d.name}><span>{d.name}</span>{d.liked > 0 && <b className="is-up">👍 {d.liked}</b>}{d.disliked > 0 && <b className="is-down">👎 {d.disliked}</b>}</li>)}</ul>}
            {data.people.length > 0 && <ul className="fb-chips is-plain">{data.people.map((p) => <li key={p.name}><span>🙋 {p.name}</span><b>{FACES[Math.max(0, Math.min(4, Math.round(p.average) - 1))]} {p.average.toFixed(1)}</b><small>{tr('{n} rated', { n: p.count })}</small></li>)}</ul>}
          </article>
        )}
      </div>

      <div className="in-card">
        <div className="fb-list-head">
          <h3>{tr('What guests said')}</h3>
          <div className="ts-chips" role="radiogroup" aria-label={tr('Show')}>
            {SHOW.map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={show === k} className={show === k ? 'is-on' : ''} onClick={() => setShow(k)}>{label()}</button>)}
          </div>
        </div>
        {!items.length && <p className="dk-muted">{tr('Nothing here.')}</p>}
        <ul className="fb-items is-plain">
          {items.map((x) => (
            <li key={x.id} className={'is-r' + x.rating + ' is-' + x.status}>
              <span className="fb-item-face" aria-hidden="true">{FACES[x.rating - 1]}</span>
              <div className="fb-item-body">
                <div className="fb-item-top">
                  <strong>{x.guest || tr('A guest')}</strong>
                  <span className="fb-stars" aria-label={tr('{n} of 5', { n: x.rating })}>{'★'.repeat(x.rating)}<i>{'★'.repeat(5 - x.rating)}</i></span>
                  {x.rating <= 2 && <span className={'fb-pill is-' + (x.status === 'resolved' ? 'done' : 'open')}>{x.status === 'resolved' ? '✓ ' + tr('Followed up') : '⚠️ ' + tr('To follow up')}</span>}
                </div>
                {x.comment && <p className="fb-comment">“{x.comment}”</p>}
                <div className="fb-item-tags">
                  {x.tags.map((t) => <span key={t} className={'fb-tag ' + (x.rating >= 4 ? 'is-up' : x.rating <= 2 ? 'is-down' : '')}>{TAG[t] ? TAG[t]() : t}</span>)}
                  {x.dishes.map((d) => <span key={d.name} className={'fb-tag ' + (d.liked ? 'is-up' : 'is-down')}>{d.liked ? '👍' : '👎'} {d.name}</span>)}
                </div>
                <small className="dk-muted">{[x.orderNo, money(x.total), x.table, x.servedBy ? tr('served by {name}', { name: x.servedBy }) : null, when(x.at)].filter(Boolean).join(' · ')}</small>
                {x.status === 'resolved' && x.reply && <small className="fb-reply">↳ {x.reply}{x.resolvedBy ? ' — ' + x.resolvedBy : ''}</small>}
                {x.rating <= 2 && x.status !== 'resolved' && open !== x.id && <button type="button" className="btn btn-primary tl-btn fb-go" onClick={() => setOpen(x.id)}>📞 {tr('Follow up')}</button>}
                {open === x.id && <FollowUp item={x} onCancel={() => setOpen(null)} onDone={(p) => { setOpen(null); ask({ action: 'resolve', id: x.id, ...p }); }} />}
              </div>
            </li>
          ))}
        </ul>
      </div>
      {tipNode}
    </section>
  );
}
