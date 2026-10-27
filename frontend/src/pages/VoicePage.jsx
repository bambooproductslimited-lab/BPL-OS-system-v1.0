import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './seventeenth.css';
import './eighteenth.css';
import './nineteenth.css';

// Staff voice (People → Staff voice; backend voice.service.js, migration
// 0200): the ideas box everyone reads and votes on, answered by whoever runs
// it; pulse surveys — a 1 to 5 scale, would you recommend working here (0 to
// 10, eNPS), a choice, a free answer — anonymous, a group only shown once
// enough people in it have answered. Answering and sharing ideas from My
// space too.

function dayText(d, opts) { return d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC', ...opts }) : '—'; }
function inDays(n) { return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10); }

const CATEGORY = { workplace: ['🏭', msg('Workplace')], safety: ['⛑️', msg('Safety')], products: ['🪑', msg('Products')], customers: ['🤝', msg('Customers')], saving: ['💰', msg('Saving money')], wellbeing: ['🌿', msg('Wellbeing')], training: ['🎓', msg('Training')], other: ['💡', msg('Other')] };
const STATUS = { new: ['🆕', 'is-calm', msg('New')], reviewing: ['🔍', 'is-violet', msg('Being looked at')], planned: ['🗓️', 'is-teal', msg('Planned')], done: ['✅', 'is-good', msg('Done')], not_now: ['💤', 'is-warn', msg('Not now')] };
const KIND = { scale: msg('1 to 5'), enps: msg('0 to 10: would you recommend'), choice: msg('A choice'), text: msg('Free answer') };
const FACES = ['😞', '🙁', '😐', '🙂', '😄'];
const STARTERS = [
  { kind: 'enps', text: msg('How likely are you to recommend working here to a friend?') },
  { kind: 'scale', text: msg('I have what I need to do my job well') },
  { kind: 'scale', text: msg('My manager listens to me') },
  { kind: 'scale', text: msg('I feel safe at work') },
  { kind: 'text', text: msg('One thing we should change') }
];

function IdeaDialog({ onClose, onDone, categories }) {
  const [f, setF] = useState({ title: '', body: '', category: 'workplace', anonymous: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onDone(await api.post('/voice/ideas', f)); } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog x7-dlg" style={{ width: 'min(620px, calc(100vw - 24px))' }} role="dialog" aria-modal="true" aria-labelledby="vc-i-t" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">💡</span><div><h2 id="vc-i-t">{tr('Share an idea')}</h2><p>{tr('Big or small: everyone can vote for it, and you will hear what happens to it.')}</p></div></div>
        <div className="x7-chips">{categories.map((k) => <button key={k} type="button" className={f.category === k ? 'is-on' : ''} onClick={() => setF({ ...f, category: k })}><em aria-hidden="true">{CATEGORY[k][0]}</em>{tr(CATEGORY[k][1])}</button>)}</div>
        <label><span>{tr('The idea, in a line')}</span><input className="input" required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder={tr('e.g. A water cooler by the kilns')} /></label>
        <label><span>{tr('Why it would help')}</span><textarea className="input" rows={3} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></label>
        <label className="x7-check"><input type="checkbox" checked={f.anonymous} onChange={(e) => setF({ ...f, anonymous: e.target.checked })} /><span>{tr('Share it without my name')}<small>{tr('Nobody sees who shared it, not even whoever runs the box.')}</small></span></label>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>💡 {tr('Share it')}</button></div>
      </form>
    </div>
  );
}

function AnswerIdeaDialog({ idea, onClose, onDone }) {
  const [f, setF] = useState({ status: idea.status === 'new' ? 'reviewing' : idea.status, response: idea.response || '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onDone(await api.put('/voice/ideas/' + idea.id, f)); } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog x7-dlg" style={{ width: 'min(600px, calc(100vw - 24px))' }} role="dialog" aria-modal="true" aria-labelledby="vc-a-t" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">{CATEGORY[idea.category][0]}</span><div><h2 id="vc-a-t">{idea.title}</h2><p>{idea.ref} · ▲ {idea.votes} · {idea.author || tr('Shared without a name')}</p></div></div>
        {idea.body && <p className="x7-note">{idea.body}</p>}
        <div className="x7-chips">{Object.entries(STATUS).map(([k, [ic, , l]]) => <button key={k} type="button" className={f.status === k ? 'is-on' : ''} onClick={() => setF({ ...f, status: k })}><em aria-hidden="true">{ic}</em>{tr(l)}</button>)}</div>
        <label><span>{tr('Your answer — everyone sees it')}</span><textarea className="input" rows={3} value={f.response} onChange={(e) => setF({ ...f, response: e.target.value })} placeholder={tr('What happens next, or why not now')} /></label>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Answer')}</button></div>
      </form>
    </div>
  );
}

function IdeaCard({ idea, canManage, onVote, onAnswer }) {
  const st = STATUS[idea.status];
  const settled = idea.status === 'done' || idea.status === 'not_now';
  return (
    <article className={'vc-idea' + (settled ? ' is-settled' : '')}>
      <button type="button" className={'vc-vote' + (idea.voted ? ' is-on' : '')} disabled={settled && !idea.voted} onClick={() => onVote(idea)} aria-pressed={idea.voted} aria-label={tr('Vote')}><span aria-hidden="true">▲</span><b>{idea.votes}</b></button>
      <div className="vc-idea-main">
        <h3><em aria-hidden="true">{CATEGORY[idea.category][0]}</em> {idea.title}</h3>
        {idea.body && <p>{idea.body}</p>}
        <div className="vc-idea-foot">
          <span className={'x7-pill ' + st[1]}>{st[0]} {tr(st[2])}</span>
          <small>{idea.ref} · {idea.mine ? tr('Yours') : idea.author || '🕶️ ' + tr('without a name')} · {dayText(idea.createdAt)}</small>
          {canManage && <button type="button" className="x7-link" onClick={() => onAnswer(idea)}>💬 {idea.response ? tr('Change the answer') : tr('Answer')}</button>}
        </div>
        {idea.response && <p className="vc-response"><b>{idea.respondedBy || tr('Management')}:</b> {idea.response}</p>}
      </div>
    </article>
  );
}

function SurveyDialog({ d, survey, onClose, onDone }) {
  const [f, setF] = useState(survey ? { title: survey.title, intro: survey.intro, audience: survey.departmentId ? 'd:' + survey.departmentId : survey.companyId ? 'c:' + survey.companyId : '', closesOn: survey.closesOn || inDays(7), anonymous: survey.anonymous, questions: survey.questions }
    : { title: '', intro: '', audience: '', closesOn: inDays(7), anonymous: true, questions: [{ kind: 'enps', text: tr(STARTERS[0].text), options: [] }] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const setQ = (n, x) => setF({ ...f, questions: f.questions.map((q, j) => (j === n ? { ...q, ...x } : q)) });
  async function save(send) {
    setBusy(true); setError(null);
    const body = { title: f.title, intro: f.intro, closesOn: f.closesOn, anonymous: f.anonymous, questions: f.questions, companyId: f.audience.startsWith('c:') ? f.audience.slice(2) : null, departmentId: f.audience.startsWith('d:') ? f.audience.slice(2) : null };
    try {
      let x = survey ? await api.put('/voice/surveys/' + survey.id, body) : await api.post('/voice/surveys', body);
      if (send) x = await api.post('/voice/surveys/' + x.id + '/open', {});
      onDone(x);
    } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-dlg" style={{ width: 'min(760px, calc(100vw - 24px))' }} role="dialog" aria-modal="true" aria-labelledby="vc-s-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">📣</span><div><h2 id="vc-s-t">{survey ? tr('The survey') : tr('A pulse survey')}</h2><p>{tr('A few questions, two minutes. Anonymous: answers keep no name, and a group only shows once {n} have answered.', { n: d.minGroup })}</p></div></div>
        <label><span>{tr('Title')}</span><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder={tr('e.g. October pulse')} /></label>
        <label><span>{tr('A word to start')}</span><input className="input" value={f.intro} onChange={(e) => setF({ ...f, intro: e.target.value })} /></label>
        <div className="x7-grid3">
          <label><span>{tr('Who')}</span><select className="input" value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value })}><option value="">{tr('Everyone')}</option>{d.companies.map((c) => <option key={c.id} value={'c:' + c.id}>{c.name}</option>)}{d.departments.map((x) => <option key={x.id} value={'d:' + x.id}>{x.company ? x.company + ' · ' : ''}{x.name}</option>)}</select></label>
          <label><span>{tr('Open until')}</span><input className="input" type="date" value={f.closesOn} onChange={(e) => setF({ ...f, closesOn: e.target.value })} /></label>
          <label className="x7-check" style={{ alignSelf: 'end' }}><input type="checkbox" checked={f.anonymous} onChange={(e) => setF({ ...f, anonymous: e.target.checked })} /><span>{tr('Anonymous')}</span></label>
        </div>
        <div className="ob-edit">{f.questions.map((q, n) => (
          <div key={n} className="vc-q-row">
            <select className="input" value={q.kind} onChange={(e) => setQ(n, { kind: e.target.value })} aria-label={tr('Kind')}>{Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{tr(l)}</option>)}</select>
            <input className="input" value={q.text} onChange={(e) => setQ(n, { text: e.target.value })} aria-label={tr('Question')} />
            <button type="button" className="btn btn-secondary" onClick={() => setF({ ...f, questions: f.questions.filter((_, j) => j !== n) })} aria-label={tr('Remove')}>✕</button>
            {q.kind === 'choice' && <input className="input vc-q-options" value={(q.options || []).join(', ')} onChange={(e) => setQ(n, { options: e.target.value.split(',').map((o) => o.trim()) })} placeholder={tr('The choices, with commas: Monday, Friday')} aria-label={tr('Choices')} />}
          </div>
        ))}</div>
        <div className="x7-chips">{STARTERS.map((s) => <button key={s.text} type="button" onClick={() => setF({ ...f, questions: [...f.questions, { kind: s.kind, text: tr(s.text), options: [] }] })}>➕ {tr(s.text)}</button>)}<button type="button" onClick={() => setF({ ...f, questions: [...f.questions, { kind: 'scale', text: '', options: [] }] })}>➕ {tr('Your own question')}</button></div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="button" className="btn btn-secondary" disabled={busy} onClick={() => save(false)}>{tr('Save as a draft')}</button><button type="button" className="btn btn-primary" disabled={busy} onClick={() => save(true)}>📣 {tr('Send it')}</button></div>
      </div>
    </div>
  );
}

// Answering: from My space or the Surveys tab.
export function AnswerSurveyDialog({ survey, onClose, onDone }) {
  const [a, setA] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onDone(await api.post('/voice/surveys/' + survey.id + '/answer', { answers: a })); } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog x7-dlg vc-answer" style={{ width: 'min(640px, calc(100vw - 24px))' }} role="dialog" aria-modal="true" aria-labelledby="vc-q-t" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">📣</span><div><h2 id="vc-q-t">{survey.title}</h2><p>{survey.intro || (survey.anonymous ? tr('Anonymous: your answers keep no name.') : '')}</p></div></div>
        {survey.anonymous && <p className="x7-note">🕶️ {tr('Anonymous: your answers keep no name, and your team is only shown once enough of you have answered.')}</p>}
        {survey.questions.map((q, n) => (
          <fieldset key={q.id} className="vc-ask">
            <legend><span>{n + 1}</span> {q.text}{q.optional ? <small> · {tr('optional')}</small> : ''}</legend>
            {q.kind === 'scale' && <div className="vc-scale">{[1, 2, 3, 4, 5].map((v) => <button key={v} type="button" className={a[q.id] === v ? 'is-on' : ''} onClick={() => setA({ ...a, [q.id]: v })} aria-label={String(v)}><span aria-hidden="true">{FACES[v - 1]}</span><small>{v}</small></button>)}</div>}
            {q.kind === 'enps' && <><div className="vc-enps">{Array.from({ length: 11 }, (_, v) => <button key={v} type="button" className={(a[q.id] === v ? 'is-on ' : '') + (v <= 6 ? 'is-low' : v <= 8 ? 'is-mid' : 'is-high')} onClick={() => setA({ ...a, [q.id]: v })}>{v}</button>)}</div><div className="vc-enps-ends"><small>{tr('Not at all likely')}</small><small>{tr('Very likely')}</small></div></>}
            {q.kind === 'choice' && <div className="x7-chips">{q.options.map((o) => <button key={o} type="button" className={a[q.id] === o ? 'is-on' : ''} onClick={() => setA({ ...a, [q.id]: o })}>{o}</button>)}</div>}
            {q.kind === 'text' && <textarea className="input" rows={2} value={a[q.id] || ''} onChange={(e) => setA({ ...a, [q.id]: e.target.value })} />}
          </fieldset>
        ))}
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Later')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Send my answers')}</button></div>
      </form>
    </div>
  );
}

function EnpsGauge({ e }) {
  if (!e) return null;
  const pct = (n) => (e.n ? n / e.n * 100 : 0);
  return (
    <div className="vc-gauge">
      <div className={'vc-gauge-score ' + (e.score >= 30 ? 'is-good' : e.score >= 0 ? 'is-warn' : 'is-bad')}><b>{e.score > 0 ? '+' + e.score : e.score}</b><small>eNPS</small></div>
      <div className="vc-gauge-bar" role="img" aria-label={tr('{p} would recommend, {d} would not', { p: e.promoters, d: e.detractors })}>
        <i className="is-det" style={{ width: pct(e.detractors) + '%' }} /><i className="is-pas" style={{ width: pct(e.passives) + '%' }} /><i className="is-pro" style={{ width: pct(e.promoters) + '%' }} />
      </div>
      <div className="vc-gauge-keys"><span>😞 {tr('{n} would not (0–6)', { n: e.detractors })}</span><span>😐 {tr('{n} in between', { n: e.passives })}</span><span>😄 {tr('{n} would (9–10)', { n: e.promoters })}</span></div>
    </div>
  );
}

function SurveySheet({ id, d, onClose, onChanged, onAnswer }) {
  const [s, setS] = useState(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { api.get('/voice/surveys/' + id).then(setS).catch((e) => setError(e.message)); }, [id]);
  async function act(path) {
    setBusy(true); setError(null);
    try { setS(await api.post('/voice/surveys/' + s.id + path, {})); onChanged(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  if (!s) return <div className="dialog-backdrop" onClick={onClose}><div className="dialog x7-sheet"><p className="x7-wait">{error || tr('Loading…')}</p></div></div>;
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-sheet is-wide" role="dialog" aria-modal="true" aria-labelledby="vc-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-hero" style={{ '--g1': '#7c3aed', '--g2': '#db2777' }}>
          <span className="x7-icon" aria-hidden="true">📣</span>
          <div><small>{s.audience || tr('Everyone')} · {s.anonymous ? '🕶️ ' + tr('Anonymous') : tr('Named')} · {s.status === 'draft' ? tr('Draft') : tr('until {date}', { date: dayText(s.closesOn) })}</small><h2 id="vc-t">{s.title}</h2>
            <p><span className="x7-pill">{s.status === 'open' ? '🟢 ' + tr('Open') : s.status === 'closed' ? '⏹️ ' + tr('Closed') : '📝 ' + tr('Draft')}</span>{s.status !== 'draft' && <span className="x7-pill">{tr('{n} of {m} answered', { n: s.responses, m: s.invited })}{s.rate != null ? ' · ' + s.rate + '%' : ''}</span>}</p></div>
          <button type="button" className="x7-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        {s.status !== 'draft' && <div className="vc-rate"><i style={{ width: (s.rate || 0) + '%' }} /></div>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        {s.hidden && s.status !== 'draft' && <div className="x7-empty"><span aria-hidden="true">🕶️</span><p>{tr('The results show once {n} people have answered, so nobody can be picked out.', { n: s.minGroup })}</p></div>}
        {s.results && !s.hidden && s.results.map((q, n) => (
          <section key={q.id} className="vc-result">
            <h3><span>{n + 1}</span> {q.text} <small>{tr('{n} answers', { n: q.answered })}</small></h3>
            {q.kind === 'enps' && <EnpsGauge e={q.enps} />}
            {q.kind === 'scale' && (
              <div className="vc-scale-res">
                <div className="vc-avg"><b>{q.average ?? '—'}</b><small>/ 5 · {tr('{n}% agree', { n: q.favourable ?? 0 })}</small></div>
                <div className="vc-dist">{q.counts.map((c, v) => <span key={v} title={String(v + 1)}><i style={{ height: Math.max(4, c / Math.max(1, ...q.counts) * 100) + '%' }} className={'is-' + (v + 1)} /><small>{FACES[v]} {c}</small></span>)}</div>
              </div>
            )}
            {q.kind === 'choice' && <div className="qc-pareto">{q.options.map((o) => <div key={o.option} className="qc-pareto-row"><span className="qc-pareto-name">{o.option}</span><span className="qc-pareto-bar"><i style={{ width: o.count / Math.max(1, q.answered) * 100 + '%' }} /></span><b>{o.count}</b><small>{q.answered ? Math.round(o.count / q.answered * 100) : 0}%</small></div>)}</div>}
            {q.kind === 'text' && (q.answers.length ? <ul className="vc-quotes">{q.answers.map((t, j) => <li key={j}>“{t}”</li>)}</ul> : <p className="x7-muted">{tr('No answers.')}</p>)}
            {q.byDepartment && q.byDepartment.length > 1 && (
              <div className="vc-depts">{q.byDepartment.map((x) => <span key={x.department} className={x.hidden ? 'is-hidden' : ''}><b>{x.hidden ? '🕶️' : q.kind === 'enps' ? (x.value > 0 ? '+' : '') + x.value : x.value}</b><small>{x.department} · {x.n}</small></span>)}</div>
            )}
          </section>
        ))}
        {s.canManage && (
          <div className="x7-actions">
            {s.status === 'draft' && <><button type="button" className="btn btn-secondary" onClick={() => setEditing(true)}>✏️ {tr('Change it')}</button><button type="button" className="btn btn-primary is-end" disabled={busy} onClick={() => act('/open')}>📣 {tr('Send it')}</button></>}
            {s.status === 'open' && !s.answered && <button type="button" className="btn btn-secondary" onClick={() => onAnswer(s)}>✍️ {tr('Answer it myself')}</button>}
            {s.status === 'open' && <button type="button" className="btn btn-secondary is-end" disabled={busy} onClick={() => act('/close')}>⏹️ {tr('Close it now')}</button>}
          </div>
        )}
        {editing && <SurveyDialog d={d} survey={s} onClose={() => setEditing(false)} onDone={(x) => { setEditing(false); setS(x); onChanged(); }} />}
      </div>
    </div>
  );
}

function TrendChart({ trend }) {
  // Drawn at the card's own width, so the labels keep their size.
  const box = useRef(null);
  const [W, setW] = useState(520);
  useEffect(() => {
    const fit = () => { if (box.current) setW(Math.max(280, Math.round(box.current.clientWidth))); };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  if (trend.length < 2) return null;
  const H = 120, pad = 30, min = Math.min(-20, ...trend.map((t) => t.score)), max = Math.max(40, ...trend.map((t) => t.score));
  const x = (n) => pad + n * (W - pad * 2) / (trend.length - 1), y = (v) => 10 + (max - v) / (max - min) * H;
  return (
    <div ref={box}><svg className="vc-trend" viewBox={'0 0 ' + W + ' ' + (H + 34)} role="img" aria-label={tr('eNPS survey by survey')}>
      <line x1={pad} x2={W - pad} y1={y(0)} y2={y(0)} className="bg-grid" />
      <polyline points={trend.map((t, n) => x(n) + ',' + y(t.score)).join(' ')} />
      {trend.map((t, n) => <g key={t.surveyId}><circle cx={x(n)} cy={y(t.score)} r="6" /><text x={x(n)} y={y(t.score) - 11} textAnchor="middle" className="vc-trend-v">{t.score > 0 ? '+' + t.score : t.score}</text><text x={x(n)} y={H + 30} textAnchor="middle" className="bg-axis">{dayText(t.on)}</text></g>)}
    </svg></div>
  );
}

export default function VoicePage() {
  const [params, setParams] = useSearchParams();
  const [sort, setSort] = useState('top');
  const [status, setStatus] = useState('');
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [dlg, setDlg] = useState(null);
  const [flash, setFlash] = useState(null);
  const load = useCallback(() => api.get('/voice?sort=' + sort + (status ? '&status=' + status : '')).then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message)), [sort, status]);
  useEffect(() => { load(); }, [load]);
  const tab = params.get('tab') || (params.get('survey') ? 'surveys' : 'ideas');
  const surveyId = params.get('survey');
  const go = (p) => setParams(p);
  async function vote(idea) {
    try { const x = await api.post('/voice/ideas/' + idea.id + '/vote', { on: !idea.voted }); setD((dd) => ({ ...dd, ideas: dd.ideas.map((i) => (i.id === x.id ? x : i)) })); } catch (e) { setFlash('⚠️ ' + e.message); }
  }
  if (!d) return <div className="x7"><p className="x7-wait">{error || tr('Loading…')}</p></div>;
  const s = d.summary;
  return (
    <div className="x7">
      <header className="x7-head">
        <div>
          <h1>💬 {tr('Staff voice')}</h1>
          <p>{tr('Ideas from anyone, voted on by everyone and answered; short anonymous surveys to hear how people really feel.')}</p>
        </div>
        <div className="x7-head-actions">
          {d.canManage && <button type="button" className="btn btn-secondary" onClick={() => setDlg({ k: 'survey' })}>📣 {tr('New survey')}</button>}
          <button type="button" className="btn btn-primary" onClick={() => setDlg({ k: 'idea' })}>💡 {tr('Share an idea')}</button>
        </div>
      </header>
      <div className="x7-tiles">
        <div className="x7-tile is-violet"><small>💡 {tr('Ideas')}</small><b>{s.ideas}</b><span>{tr('{n} new', { n: s.fresh })}</span></div>
        <div className="x7-tile is-teal"><small>🗓️ {tr('Planned')}</small><b>{s.planned}</b><span>{tr('on their way')}</span></div>
        <div className="x7-tile is-good"><small>✅ {tr('Done')}</small><b>{s.done}</b><span>{tr('ideas made real')}</span></div>
        <div className="x7-tile is-calm"><small>📣 {tr('Surveys open')}</small><b>{s.openSurveys}</b><span>{tr('anonymous')}</span></div>
        {d.canManage && <div className={'x7-tile ' + (s.enps == null ? 'is-calm' : s.enps >= 30 ? 'is-good' : s.enps >= 0 ? 'is-warn' : 'is-bad')}><small>😄 {tr('Would recommend us (eNPS)')}</small><b>{s.enps == null ? '—' : (s.enps > 0 ? '+' : '') + s.enps}</b><span>{s.enpsBefore != null ? (s.enps >= s.enpsBefore ? '▲ ' : '▼ ') + tr('from {n} last time', { n: s.enpsBefore }) : tr('the last survey')}</span></div>}
      </div>
      <div className="x7-bar">
        <div className="x7-seg" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'ideas'} className={tab === 'ideas' ? 'is-on' : ''} onClick={() => go({})}>💡 {tr('Ideas box')}</button>
          <button type="button" role="tab" aria-selected={tab === 'surveys'} className={tab === 'surveys' ? 'is-on' : ''} onClick={() => go({ tab: 'surveys' })}>📣 {tr('Surveys')}{d.surveys.filter((x) => x.status === 'open' && x.forMe && !x.answered).length ? <i>{d.surveys.filter((x) => x.status === 'open' && x.forMe && !x.answered).length}</i> : null}</button>
        </div>
        {tab === 'ideas' && <div className="x7-seg">{[['top', tr('Most votes')], ['new', tr('Newest')]].map(([k, l]) => <button key={k} type="button" className={sort === k ? 'is-on' : ''} onClick={() => setSort(k)}>{l}</button>)}</div>}
      </div>
      {flash && <div className="x7-flash" role="status">{flash}</div>}
      {tab === 'ideas' && (
        <>
          <div className="x7-chips"><button type="button" className={!status ? 'is-on' : ''} onClick={() => setStatus('')}>{tr('All')}</button>{Object.entries(STATUS).map(([k, [ic, , l]]) => <button key={k} type="button" className={status === k ? 'is-on' : ''} onClick={() => setStatus(k)}><em aria-hidden="true">{ic}</em>{tr(l)}</button>)}</div>
          {!d.ideas.length ? <div className="x7-empty"><span aria-hidden="true">💡</span><p>{tr('No ideas yet. Be the first!')}</p></div>
            : <div className="vc-ideas">{d.ideas.map((i) => <IdeaCard key={i.id} idea={i} canManage={d.canManage} onVote={vote} onAnswer={(x) => setDlg({ k: 'answer', idea: x })} />)}</div>}
        </>
      )}
      {tab === 'surveys' && (
        <>
          {d.canManage && d.trend.length > 1 && <section className="x7-card"><h2>📈 {tr('Would recommend us, survey by survey')}</h2><TrendChart trend={d.trend} /></section>}
          {!d.surveys.length ? <div className="x7-empty"><span aria-hidden="true">📣</span><p>{tr('No survey for you just now.')}</p></div> : (
            <div className="x7-list">{d.surveys.map((x) => (
              <button key={x.id} type="button" className={'x7-row' + (x.status === 'open' && x.forMe && !x.answered ? ' is-flag is-calm' : '')} onClick={() => (d.canManage ? go({ survey: x.id }) : x.answered ? null : setDlg({ k: 'answerSurvey', survey: x }))}>
                <span className="x7-icon" aria-hidden="true">{x.status === 'open' ? '🟢' : x.status === 'closed' ? '⏹️' : '📝'}</span>
                <span className="x7-who"><b>{x.title}</b><small>{x.audience || tr('Everyone')} · {tr('{n} questions', { n: x.questions.length })}{x.closesOn ? ' · ' + tr('until {date}', { date: dayText(x.closesOn) }) : ''}</small></span>
                {x.status !== 'draft' && d.canManage ? <span className="vc-row-rate"><i style={{ width: (x.rate || 0) + '%' }} /><small>{x.responses}/{x.invited}</small></span> : <span />}
                <span className={'x7-pill ' + (x.answered ? 'is-good' : x.status === 'open' ? 'is-calm' : 'is-violet')}>{x.answered ? '✓ ' + tr('Answered') : x.status === 'open' ? tr('Answer') : x.status === 'draft' ? tr('Draft') : tr('Closed')}</span>
              </button>
            ))}</div>
          )}
        </>
      )}
      {dlg && dlg.k === 'idea' && <IdeaDialog categories={d.categories} onClose={() => setDlg(null)} onDone={() => { setDlg(null); setFlash('💡 ' + tr('Shared — thank you! Everyone can vote for it now.')); go({}); load(); }} />}
      {dlg && dlg.k === 'answer' && <AnswerIdeaDialog idea={dlg.idea} onClose={() => setDlg(null)} onDone={() => { setDlg(null); load(); }} />}
      {dlg && dlg.k === 'survey' && <SurveyDialog d={d} onClose={() => setDlg(null)} onDone={(x) => { setDlg(null); load(); go({ survey: x.id }); }} />}
      {dlg && dlg.k === 'answerSurvey' && <AnswerSurveyDialog survey={dlg.survey} onClose={() => setDlg(null)} onDone={() => { setDlg(null); setFlash('🙏 ' + tr('Thank you — your answers are in.')); load(); }} />}
      {surveyId && <SurveySheet key={surveyId} id={surveyId} d={d} onClose={() => go({ tab: 'surveys' })} onChanged={load} onAnswer={(x) => setDlg({ k: 'answerSurvey', survey: x })} />}
    </div>
  );
}

// My space: surveys to answer; an idea to share; my ideas and how they stand.
export function MyVoiceCard() {
  const [d, setD] = useState(null);
  const [answering, setAnswering] = useState(null);
  const [sharing, setSharing] = useState(false);
  const [flash, setFlash] = useState(null);
  const load = useCallback(() => api.get('/voice/mine').then(setD).catch(() => setD(null)), []);
  useEffect(() => { load(); }, [load]);
  if (!d) return null;
  const toAnswer = d.surveys.filter((s) => !s.answered);
  return (
    <div className="msx-card x7-mine">
      <h4 className="msp-h4">💬 {tr('Your voice')}</h4>
      {toAnswer.map((s) => (
        <div key={s.id} className="x7-mine-top" style={{ '--tone': 'var(--x7-violet)' }}>
          <span><small>📣 {s.anonymous ? tr('Anonymous') + ' · ' : ''}{tr('until {date}', { date: dayText(s.closesOn) })}</small><b>{s.title}</b></span>
          <button type="button" className="btn btn-primary" onClick={() => setAnswering(s)}>✍️ {tr('Answer')}</button>
        </div>
      ))}
      <div className="x7-mine-top" style={{ '--tone': 'var(--x7-teal)' }}>
        <span><small>{tr('An idea to make work better?')}</small><b>{tr('Share it; everyone can vote')}</b></span>
        <button type="button" className="btn btn-secondary" onClick={() => setSharing(true)}>💡 {tr('Share an idea')}</button>
      </div>
      {flash && <div className="x7-flash" role="status">{flash}</div>}
      {d.ideas.length > 0 && <ul className="x7-mine-list">{d.ideas.map((i) => (
        <li key={i.id}><span aria-hidden="true">{CATEGORY[i.category][0]}</span><span><b>{i.title}</b><small>▲ {i.votes}{i.response ? ' · ' + i.response : ''}</small></span><span className={'x7-pill ' + STATUS[i.status][1]} style={{ flex: 'none' }}>{STATUS[i.status][0]} {tr(STATUS[i.status][2])}</span></li>
      ))}</ul>}
      {!d.ideas.length && d.top.length > 0 && <ul className="x7-mine-list">{d.top.map((i) => (
        <li key={i.id}><span aria-hidden="true">{CATEGORY[i.category][0]}</span><span><b>{i.title}</b><small>▲ {i.votes} · {tr(STATUS[i.status][2])}</small></span></li>
      ))}</ul>}
      {answering && <AnswerSurveyDialog survey={answering} onClose={() => setAnswering(null)} onDone={() => { setAnswering(null); setFlash('🙏 ' + tr('Thank you — your answers are in.')); load(); }} />}
      {sharing && <IdeaDialog categories={d.categories} onClose={() => setSharing(false)} onDone={() => { setSharing(false); setFlash('💡 ' + tr('Shared — thank you! Everyone can vote for it now.')); load(); }} />}
    </div>
  );
}
