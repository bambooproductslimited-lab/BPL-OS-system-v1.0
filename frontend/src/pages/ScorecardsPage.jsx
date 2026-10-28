import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { money } from '../lib/currency';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './seventeenth.css';
import './twentieth.css';

// Supplier scorecards (Operations → Supplier scorecards; backend
// scorecards.service.js, migration 0201): each supplier's last months from
// what is already recorded — the restaurants' purchase orders, the raw
// bamboo taken in at Bamboo Products — and from a quick rating of a
// delivery: on time, complete, quality, price and service, weighed into a
// score and a grade, with the trend against the months before.

const PARTS = [['delivery', '⏱️', msg('On time')], ['completeness', '📦', msg('Complete')], ['quality', '💎', msg('Quality')], ['price', '💵', msg('Price')], ['service', '🤝', msg('Service')]];
const GRADE_TONE = { A: 'is-good', B: 'is-teal', C: 'is-warn', D: 'is-bad' };
function today() { return new Date().toISOString().slice(0, 10); }
function dayText(d) { return d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '—'; }
function monthText(m) { return new Date(m + '-15T12:00:00Z').toLocaleDateString(activeIntlLocale(), { month: 'short', timeZone: 'UTC' }); }

function Grade({ g, big }) {
  return <span className={'scd-grade ' + (g ? GRADE_TONE[g] : 'is-none') + (big ? ' is-big' : '')} aria-label={g ? tr('Grade {g}', { g }) : tr('Not graded yet')}>{g || '·'}</span>;
}

function Change({ v }) {
  if (v == null) return <span className="scd-change is-none">—</span>;
  return <span className={'scd-change ' + (v > 0 ? 'is-up' : v < 0 ? 'is-down' : '')} title={tr('against the months before')}>{v > 0 ? '▲ +' + v : v < 0 ? '▼ ' + v : '＝'}</span>;
}

function Stars({ value, onChange, label }) {
  return (
    <span className="scd-stars" role="radiogroup" aria-label={label}>
      {[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" role="radio" aria-checked={value === n} className={value >= n ? 'is-on' : ''} onClick={() => onChange(value === n ? null : n)} aria-label={String(n)}>★</button>)}
    </span>
  );
}

function YesNo({ value, onChange, label }) {
  return (
    <span className="scd-yn" role="radiogroup" aria-label={label}>
      <button type="button" role="radio" aria-checked={value === true} className={value === true ? 'is-yes' : ''} onClick={() => onChange(value === true ? null : true)}>👍 {tr('Yes')}</button>
      <button type="button" role="radio" aria-checked={value === false} className={value === false ? 'is-no' : ''} onClick={() => onChange(value === false ? null : false)}>👎 {tr('No')}</button>
    </span>
  );
}

function RateForm({ s, days, onDone, onCancel }) {
  const [f, setF] = useState({ ref: '', deliveredOn: today(), onTime: null, complete: null, quality: null, price: null, service: null, note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onDone(await api.post('/scorecards/rate', { ...f, kind: s.kind, supplierId: s.id, days })); } catch (err) { setError(err.message); setBusy(false); }
  }
  const poor = (f.quality != null && f.quality <= 2) || (f.onTime === false && f.complete === false);
  return (
    <form className="x7-form" onSubmit={save}>
      <h3>⭐ {tr('How was the delivery?')}</h3>
      <div className="x7-grid2">
        <label><span>{tr('Delivery or invoice')}</span><input className="input" value={f.ref} onChange={(e) => set('ref', e.target.value)} placeholder={tr('e.g. PO-0123')} /></label>
        <label><span>{tr('Came on')}</span><input className="input" type="date" max={today()} value={f.deliveredOn} onChange={(e) => set('deliveredOn', e.target.value)} /></label>
      </div>
      <div className="scd-rate">
        <div><span>⏱️ {tr('On the day agreed?')}</span><YesNo value={f.onTime} onChange={(v) => set('onTime', v)} label={tr('On the day agreed?')} /></div>
        <div><span>📦 {tr('Everything there?')}</span><YesNo value={f.complete} onChange={(v) => set('complete', v)} label={tr('Everything there?')} /></div>
        <div><span>💎 {tr('Quality')}</span><Stars value={f.quality} onChange={(v) => set('quality', v)} label={tr('Quality')} /></div>
        <div><span>💵 {tr('Price')}</span><Stars value={f.price} onChange={(v) => set('price', v)} label={tr('Price')} /></div>
        <div><span>🤝 {tr('Service')}</span><Stars value={f.service} onChange={(v) => set('service', v)} label={tr('Service')} /></div>
      </div>
      <input className="input" value={f.note} onChange={(e) => set('note', e.target.value)} placeholder={tr('What happened? e.g. 3 crates short, soft tomatoes')} aria-label={tr('Note')} />
      {poor && <p className="x7-note">📣 {tr('A poor delivery: the others who buy from them are told.')}</p>}
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onCancel}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Save the rating')}</button></div>
    </form>
  );
}

function SupplierSheet({ k, days, onClose, onChanged }) {
  const [kind, id] = k.split(':');
  const [s, setS] = useState(null);
  const [error, setError] = useState(null);
  const [rating, setRating] = useState(false);
  const load = useCallback(() => api.get('/scorecards/' + kind + '/' + id + '?days=' + days).then(setS).catch((e) => setError(e.message)), [kind, id, days]);
  useEffect(() => { load(); }, [load]);
  if (!s) return <div className="dialog-backdrop" onClick={onClose}><div className="dialog x7-sheet"><p className="x7-wait">{error || tr('Loading…')}</p></div></div>;
  const g = { A: ['#15803d', '#0f766e'], B: ['#0f766e', '#2563eb'], C: ['#d97706', '#b45309'], D: ['#b91c1c', '#7f1d1d'] }[s.grade] || ['#475569', '#334155'];
  const maxScore = 100;
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-sheet is-wide" role="dialog" aria-modal="true" aria-labelledby="scd-s-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-hero" style={{ '--g1': g[0], '--g2': g[1] }}>
          <Grade g={s.grade} big />
          <div><small>{s.company.name}{s.supplies ? ' · ' + s.supplies : ''}</small><h2 id="scd-s-t">{s.name}</h2>
            <p>{s.score != null ? <><b>{s.score}</b><span className="x7-pill">{tr('out of 100')}</span></> : <span className="x7-pill">{tr('Not enough yet to grade ({n} of {m})', { n: s.points, m: s.minPoints })}</span>}
              <span className="x7-pill">📦 {s.deliveries === 1 ? tr('1 delivery') : tr('{n} deliveries', { n: s.deliveries })}</span><span className="x7-pill">💵 {money(s.spend, 'GHS')}</span></p></div>
          <button type="button" className="x7-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="scd-parts">{PARTS.map(([p, ic, lab]) => {
          const x = s.parts[p];
          return (
            <div key={p} className={'scd-part' + (x.score == null ? ' is-none' : '')}>
              <span className="scd-part-head"><em aria-hidden="true">{ic}</em>{tr(lab)}<small>{tr('{n}% of the score', { n: s.weights[p] })}</small></span>
              <span className="scd-meter"><i style={{ width: (x.score || 0) + '%' }} className={x.score == null ? '' : x.score >= 85 ? 'is-good' : x.score >= 55 ? 'is-warn' : 'is-bad'} /></span>
              <span className="scd-part-foot"><b>{x.score != null ? x.score : '—'}</b><small>{x.n ? (x.n === 1 ? tr('from 1') : tr('from {n}', { n: x.n })) : tr('nothing yet')}</small></span>
            </div>
          );
        })}</div>
        <div className="x7-sec"><h3>📈 {tr('Month by month')}</h3>
          <div className="scd-months">{s.months.map((m) => (
            <div key={m.month} className="scd-month" title={m.score != null ? tr('{m}: {n}', { m: monthText(m.month), n: m.score }) : tr('{m}: not enough to grade', { m: monthText(m.month) })}>
              <span className="scd-month-bar">{m.score != null ? <i className={m.score >= 85 ? 'is-good' : m.score >= 70 ? 'is-teal' : m.score >= 55 ? 'is-warn' : 'is-bad'} style={{ height: m.score / maxScore * 100 + '%' }}><b>{m.score}</b></i> : <em>{m.points ? '·' : ''}</em>}</span>
              <small>{monthText(m.month)}</small>
            </div>
          ))}</div>
        </div>
        {rating ? <RateForm s={s} days={days} onCancel={() => setRating(false)} onDone={(x) => { setRating(false); setS(x); onChanged(); }} /> : s.canRate && <div className="x7-actions"><button type="button" className="btn btn-primary is-end" onClick={() => setRating(true)}>⭐ {tr('Rate a delivery')}</button></div>}
        <div className="x7-sec"><h3>🧾 {tr('What it is made of')}</h3>
          {!s.events.length ? <p className="x7-muted">{tr('Nothing recorded in these months.')}</p> : <ul className="scd-events">{s.events.map((e, n) => (
            <li key={n} className={'is-' + e.kind}>
              <span className="scd-ev-ico" aria-hidden="true">{e.kind === 'order' ? '🧾' : e.kind === 'intake' ? '🎋' : '⭐'}</span>
              <span className="scd-ev-main">
                <b>{e.ref || (e.kind === 'rating' ? tr('A rating') : '—')}<small>{dayText(e.day)}{e.by ? ' · ' + e.by : ''}</small></b>
                <span className="scd-ev-tags">
                  {e.onTime === true && <span className="x7-pill is-good">⏱️ {tr('on time')}</span>}
                  {e.onTime === false && <span className="x7-pill is-bad">⏱️ {e.expected ? tr('late (due {d})', { d: dayText(e.expected) }) : tr('late')}</span>}
                  {e.fill != null && <span className={'x7-pill ' + (e.fill >= 100 ? 'is-good' : 'is-warn')}>📦 {tr('{n}% came', { n: e.fill })}</span>}
                  {e.complete === true && <span className="x7-pill is-good">📦 {tr('complete')}</span>}
                  {e.complete === false && <span className="x7-pill is-bad">📦 {tr('short')}</span>}
                  {e.grade && <span className={'x7-pill ' + (e.grade === 'A' ? 'is-good' : e.grade === 'B' ? 'is-calm' : 'is-warn')}>💎 {tr('grade {g}', { g: e.grade })}</span>}
                  {e.priceChange != null && <span className={'x7-pill ' + (e.priceChange > 0 ? 'is-bad' : 'is-good')}>💵 {(e.priceChange > 0 ? '+' : '') + e.priceChange}%</span>}
                  {e.kind === 'rating' && ['quality', 'price', 'service'].filter((x) => e[x] != null).map((x) => <span key={x} className="x7-pill is-calm">{x === 'quality' ? '💎' : x === 'price' ? '💵' : '🤝'} {'★'.repeat(e[x])}</span>)}
                </span>
                {e.note && <small className="scd-ev-note">{e.note}</small>}
              </span>
              {e.total != null && <span className="scd-ev-money">{money(e.total, 'GHS')}{e.qty ? <small>{e.qty} {e.unit}</small> : null}</span>}
            </li>
          ))}</ul>}
        </div>
      </div>
    </div>
  );
}

export default function ScorecardsPage() {
  const [params, setParams] = useSearchParams();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const days = Number(params.get('days')) || 180;
  const company = params.get('company') || '';
  const load = useCallback(() => api.get('/scorecards?days=' + days + (company ? '&company=' + encodeURIComponent(company) : '')).then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message)), [days, company]);
  useEffect(() => { load(); }, [load]);
  const open = params.get('supplier');
  if (!d) return <div className="x7"><p className="x7-wait">{error || tr('Loading…')}</p></div>;
  const s = d.summary;
  // The window and the company stay as they are unless changed; undefined drops one.
  const keep = (extra) => {
    const p = { ...(days !== 180 ? { days: String(days) } : {}), ...(company ? { company } : {}), ...extra };
    Object.keys(p).forEach((key) => { if (p[key] === undefined) delete p[key]; });
    return p;
  };
  const shown = d.suppliers.filter((x) => !q || (x.name + ' ' + (x.supplies || '')).toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="x7">
      <header className="x7-head">
        <div>
          <h1>🏅 {tr('Supplier scorecards')}</h1>
          <p>{tr('How each supplier has done: on the day agreed, everything there, the quality, the price against last time and the service. From the purchase orders, the bamboo taken in and a quick rating of each delivery.')}</p>
        </div>
        <div className="x7-seg" role="tablist" aria-label={tr('Over')}>{d.windows.map((w) => <button key={w} type="button" role="tab" aria-selected={days === w} className={days === w ? 'is-on' : ''} onClick={() => setParams(keep({ days: w === 180 ? undefined : String(w) }))}>{w === 365 ? tr('A year') : tr('{n} days', { n: w })}</button>)}</div>
      </header>
      <div className="x7-tiles">
        <div className="x7-tile is-teal"><small>🏅 {tr('Graded')}</small><b>{s.graded}</b><span>{tr('{n} with too little to grade', { n: d.suppliers.length - s.graded })}</span></div>
        <div className="x7-tile is-good"><small>🥇 {tr('Grade A')}</small><b>{s.a}</b><span>{tr('85 and over')}</span></div>
        <div className={'x7-tile ' + (s.watch ? 'is-bad' : 'is-good')}><small>👀 {tr('To watch')}</small><b>{s.watch}</b><span>{tr('grade D, or down 10 or more')}</span></div>
        <div className="x7-tile is-calm"><small>📊 {tr('Average score')}</small><b>{s.average != null ? s.average : '—'}</b><span>{tr('of those graded')}</span></div>
        <div className="x7-tile is-violet"><small>💵 {tr('Bought')}</small><b>{money(s.spend, 'GHS')}</b><span>{s.deliveries === 1 ? tr('1 delivery') : tr('{n} deliveries', { n: s.deliveries })}</span></div>
      </div>
      <div className="lic-bar">
        <div className="x7-chips">
          <button type="button" className={!company ? 'is-on' : ''} onClick={() => setParams(keep({ company: undefined }))}>{tr('Everyone')}</button>
          {d.companies.map((c) => <button key={c.code} type="button" className={company === c.code ? 'is-on' : ''} onClick={() => setParams(keep({ company: c.code }))}>{c.name}</button>)}
        </div>
        <input className="input lic-search" data-type-to-search value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Find a supplier')} aria-label={tr('Find a supplier')} />
      </div>
      <p className="x7-muted scd-weights">{tr('The score:')} {PARTS.map(([p, ic, lab]) => <span key={p}>{ic} {tr(lab)} {d.weights[p]}%</span>)}</p>
      {!shown.length ? <div className="x7-empty"><span aria-hidden="true">🏅</span><p>{tr('No supplier with deliveries in these months.')}</p></div> : (
        <div className="scd-list">{shown.map((x, n) => (
          <button key={x.key} type="button" className={'scd-row' + (x.grade === 'D' || (x.change != null && x.change <= -10) ? ' is-watch' : '')} onClick={() => setParams(keep({ supplier: x.key }))}>
            <span className="scd-rank">{x.grade ? n + 1 : ''}</span>
            <Grade g={x.grade} />
            <span className="scd-who"><b>{x.name}</b><small>{[x.company.name, x.supplies].filter(Boolean).join(' · ')}</small></span>
            <span className="scd-score">{x.score != null ? <><b>{x.score}</b><span className="scd-meter"><i className={x.score >= 85 ? 'is-good' : x.score >= 70 ? 'is-teal' : x.score >= 55 ? 'is-warn' : 'is-bad'} style={{ width: x.score + '%' }} /></span></> : <small>{tr('{n} of {m} to grade', { n: x.points, m: d.minPoints })}</small>}</span>
            <span className="scd-mini" aria-label={tr('The parts')}>{PARTS.map(([p, ic, lab]) => {
              const v = x.parts[p].score;
              return <span key={p} title={tr(lab) + ': ' + (v == null ? '—' : v)} className={v == null ? 'is-none' : v >= 85 ? 'is-good' : v >= 55 ? 'is-warn' : 'is-bad'}><em aria-hidden="true">{ic}</em>{v == null ? '·' : v}</span>;
            })}</span>
            <Change v={x.change} />
            <span className="scd-money"><b>{money(x.spend, 'GHS')}</b><small>{x.deliveries === 1 ? tr('1 delivery') : tr('{n} deliveries', { n: x.deliveries })}{x.ratings ? ' · ⭐ ' + x.ratings : ''}</small></span>
          </button>
        ))}</div>
      )}
      {open && <SupplierSheet key={open + days} k={open} days={days} onClose={() => setParams(keep({}))} onChanged={load} />}
    </div>
  );
}
