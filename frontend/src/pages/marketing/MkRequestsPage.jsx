import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import Photo from '../../components/Photo';
import PeoplePicker from '../../components/PeoplePicker';
import { Section } from '../../components/DashKit';
import { msg, tr } from '../../lib/i18n.jsx';
import {
  Glyph, L, MkBanner, MkDialog, MkEmpty, Pill, REQUEST_GLYPH, REQUEST_KINDS, REQUEST_STATUS, dayLabel, openFile, readParam, todayIso
} from './mkKit';

// Requests to marketing (backend mkRequests.service.js), for everyone:
// ask for a flyer, a post, a banner, a video, photos… with a brief and the
// date it is needed by, attach what helps, and follow it on a board —
// new, in progress, ready to check, done. Marketing takes it on, assigns
// someone to lead it and a team to work with them, talks in the comments
// and attaches the finished work; the one who asked approves it or asks
// for changes. Everyone is told at each step.

const LANES = ['new', 'in_progress', 'review', 'done'];
const STEPS = ['new', 'in_progress', 'review', 'done'];
const PLACEHOLDER = msg('What is it for? What must it say? Sizes, where it will be used, anything it must include…');

export default function MkRequestsPage() {
  const { session } = useAuth();
  const me = session && session.employee ? session.employee.id : null;
  const [scope, setScope] = useState('mine');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [companies, setCompanies] = useState([]);
  const [asking, setAsking] = useState(false);
  const [openId, setOpenId] = useState(() => readParam('open'));
  const [toast, setToast] = useState(null);

  // Marketing starts on everyone's requests; everyone else on their own.
  const loadedOnce = useRef(false);
  const load = useCallback(() => api.get('/mk/requests?scope=' + scope).then((d) => { setData(d); if (d.canSeeAll && scope === 'mine' && !loadedOnce.current) { loadedOnce.current = true; setScope('all'); } }).catch((e) => setError(e.message)), [scope]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/mk/companies').then(setCompanies).catch(() => setCompanies([])); }, []);
  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(null), 3500); return () => clearTimeout(t); }, [toast]);
  function open(id) { setOpenId(id); window.history.replaceState({}, '', '/mkrequests?open=' + id); }
  function close() { setOpenId(null); window.history.replaceState({}, '', '/mkrequests'); }

  if (error) return <div className="dk mk"><div className="error-banner">{error}</div></div>;
  if (!data) return <div className="dk mk"><p className="eyebrow">{tr('Loading…')}</p></div>;
  const c = data.counts;
  const open_ = c.new + c.in_progress + c.review;
  const doneMonth = data.requests.filter((r) => r.status === 'done' && r.doneAt && String(r.doneAt).slice(0, 7) === todayIso().slice(0, 7)).length;
  const declined = data.requests.filter((r) => r.status === 'declined');

  return (
    <div className="dk mk">
      <MkBanner art="inbox" eyebrow={tr('Marketing · Requests')} title={tr('Ask marketing')}
        sub={data.canManage
          ? tr('What the company has asked marketing for. Take each on, assign it, keep the one who asked posted and attach the finished work here.')
          : tr('Need a flyer, a post, a banner, photos or a video? Ask here with what it is for and when you need it, and follow it until it is done.')}
        actions={<button type="button" className="mk-btn is-primary" onClick={() => setAsking(true)}><Glyph name="plus" size={16} />{tr('Ask for something')}</button>}
        stats={[
          { glyph: 'inbox', value: String(open_), label: data.scope === 'all' ? tr('open requests') : tr('of yours open') },
          { glyph: 'sparkle', value: String(c.new), label: tr('not taken on yet'), tone: c.new ? 'alert' : '' },
          { glyph: 'clock', value: String(data.overdue), label: tr('past the date needed'), tone: data.overdue ? 'bad' : '' },
          { glyph: 'check', value: String(doneMonth), label: tr('done this month'), tone: doneMonth ? 'good' : '' }
        ]} />

      <Section title={data.scope === 'all' ? tr('Every request') : tr('Your requests')} sub={tr('Left to right: new, being worked on, ready for the one who asked to check, done. Press a card to open it.')}
        action={data.canSeeAll && (
          <div className="mk-chippick" role="radiogroup" aria-label={tr('Show')}>
            {[['all', tr('Everyone\'s')], ['mine', tr('Mine')]].map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={scope === k} className={'mk-chipopt' + (scope === k ? ' is-on' : '')} onClick={() => { loadedOnce.current = true; setScope(k); }}>{label}</button>
            ))}
          </div>
        )}>
        {data.requests.length ? (
          <div className="mk-board">
            {LANES.map((lane) => {
              const items = data.requests.filter((r) => r.status === lane).slice(0, lane === 'done' ? 12 : 100);
              return (
                <div key={lane} className={'mk-lane is-' + lane}>
                  <div className="mk-lane-head"><i />{L(REQUEST_STATUS, lane)}<span>{c[lane]}</span></div>
                  {items.map((r) => <RequestCard key={r.id} r={r} me={me} onOpen={() => open(r.id)} />)}
                  {!items.length && <p className="mk-muted" style={{ margin: '4px 6px' }}>{lane === 'new' ? tr('Nothing waiting.') : tr('Nothing here.')}</p>}
                </div>
              );
            })}
          </div>
        ) : (
          <MkEmpty glyph="inbox" title={tr('No requests yet')} action={<button type="button" className="mk-btn is-primary" onClick={() => setAsking(true)}>{tr('Ask for something')}</button>}>
            {tr('Ask marketing for anything that needs designing, writing, photographing or filming. Say what it is for and when you need it.')}
          </MkEmpty>
        )}
        {declined.length > 0 && (
          <details className="mk-card" style={{ padding: '10px 14px' }}>
            <summary style={{ cursor: 'pointer', fontWeight: 800 }}>{tr('Declined ({n})', { n: declined.length })}</summary>
            <ul className="mk-list" style={{ marginTop: 10 }}>
              {declined.map((r) => <li key={r.id} className="mk-li" style={{ cursor: 'pointer' }} onClick={() => open(r.id)}><span className="mk-fill"><strong>{r.ref} {r.title}</strong><span className="mk-muted">{r.note}</span></span></li>)}
            </ul>
          </details>
        )}
      </Section>

      {asking && <AskDialog companies={companies} onClose={() => setAsking(false)} onDone={(r) => { setAsking(false); load(); open(r.id); setToast(tr('Sent to marketing. You will be told as it moves.')); }} />}
      {openId && <RequestDetail id={openId} me={me} onClose={close} onChanged={load} toast={setToast} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function RequestCard({ r, me, onOpen }) {
  return (
    <button type="button" className={'mk-card mk-req' + (r.priority === 'urgent' ? ' is-urgent' : '')} style={{ '--p': 'var(--mk-' + ({ new: 'info', in_progress: 'violet', review: 'warn', done: 'good' }[r.status] || 'muted') + ')' }} onClick={onOpen}>
      <span className="mk-req-top"><span className="mk-icon"><Glyph name={REQUEST_GLYPH[r.kind]} size={15} /></span>{r.ref} · {L(REQUEST_KINDS, r.kind)}{r.priority === 'urgent' && <Pill tone="bad" glyph="fire">{tr('Urgent')}</Pill>}</span>
      <strong className="mk-card-title" style={{ fontSize: 14 }}>{r.title}</strong>
      <span className="mk-req-foot">
        <span className="mk-faces">
          <Photo id={r.requester.id} name={r.requester.name} photo={r.requester.photo} size={24} />
          {r.assignee && <Photo id={r.assignee.id} name={r.assignee.name} photo={r.assignee.photo} size={24} />}
          {r.team.slice(0, 2).map((m) => <Photo key={m.id} id={m.id} name={m.name} photo={m.photo} size={24} />)}
          {r.team.length > 2 && <span className="mk-faces-more">+{r.team.length - 2}</span>}
        </span>
        <span>{r.requester.id === me ? tr('You asked') : r.requester.name}</span>
        <span style={{ flex: 1 }} />
        {r.comments > 0 && <span title={tr('Comments')}><Glyph name="chat" size={13} /> {r.comments}</span>}
        {r.delivered > 0 && <span title={tr('Finished work attached')} style={{ color: 'var(--mk-good)' }}><Glyph name="download" size={13} /> {r.delivered}</span>}
        {r.dueOn && <span className={'mk-due' + (r.overdue ? ' is-late' : '')}><Glyph name="clock" size={13} />{dayLabel(r.dueOn)}</span>}
      </span>
    </button>
  );
}

function AskDialog({ companies, onClose, onDone }) {
  const [f, setF] = useState({ company: (companies[0] && companies[0].code) || 'BPL', kind: 'flyer', title: '', brief: '', audience: '', dueOn: '', priority: 'normal' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function send(e) {
    e.preventDefault();
    setSaving(true); setError(null);
    try { onDone(await api.post('/mk/requests', f)); } catch (err) { setError(err.message); setSaving(false); }
  }
  return (
    <MkDialog wide title={tr('Ask marketing for something')} sub={tr('The clearer the brief, the sooner it comes back right. Marketing is told straight away.')} onClose={() => !saving && onClose()}
      footer={<><button type="button" className="mk-btn is-ghost" onClick={onClose} disabled={saving}>{tr('Cancel')}</button><button type="submit" form="mk-ask" className="mk-btn is-primary" disabled={saving}>{saving ? tr('Sending…') : tr('Send to marketing')}</button></>}>
      <form id="mk-ask" className="mk-form" onSubmit={send}>
        <div className="field is-span"><span>{tr('What do you need?')}</span>
          <div className="mk-kinds" role="radiogroup" aria-label={tr('Kind')}>
            {Object.keys(REQUEST_KINDS).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={f.kind === k} className={'mk-kind' + (f.kind === k ? ' is-on' : '')} onClick={() => setF({ ...f, kind: k })}>
                <Glyph name={REQUEST_GLYPH[k]} size={22} />{L(REQUEST_KINDS, k)}
              </button>
            ))}
          </div>
        </div>
        <label className="field is-span"><span>{tr('In a few words')}</span><input className="input" required maxLength={160} value={f.title} onChange={set('title')} placeholder={tr('e.g. A5 flyer for the Christmas showroom sale')} /></label>
        <label className="field is-span"><span>{tr('The brief')}</span><textarea className="input" rows={4} maxLength={4000} value={f.brief} onChange={set('brief')} placeholder={tr(PLACEHOLDER)} /></label>
        <label className="field"><span>{tr('Who will see it')}</span><input className="input" maxLength={300} value={f.audience} onChange={set('audience')} placeholder={tr('e.g. Walk-in customers, hotel buyers')} /></label>
        <label className="field"><span>{tr('Needed by')}</span><input className="input" type="date" min={todayIso()} value={f.dueOn} onChange={set('dueOn')} /></label>
        {companies.length > 1 && (
          <label className="field"><span>{tr('For')}</span>
            <select className="input" value={f.company} onChange={set('company')}>{companies.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select>
          </label>
        )}
        <label className="field" style={{ alignSelf: 'end' }}><span className="mk-row" style={{ gap: 8 }}>
          <input type="checkbox" checked={f.priority === 'urgent'} onChange={(e) => setF({ ...f, priority: e.target.checked ? 'urgent' : 'normal' })} style={{ width: 18, height: 18 }} />
          {tr('It is urgent')}</span><span className="hint">{tr('Only when something real depends on it; marketing sees it first.')}</span></label>
      </form>
      {error && <div className="error-banner">{error}</div>}
    </MkDialog>
  );
}

function RequestDetail({ id, me, onClose, onChanged, toast }) {
  const [r, setR] = useState(null);
  const [error, setError] = useState(null);
  const [comment, setComment] = useState('');
  const [team, setTeam] = useState([]);
  const [people, setPeople] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [busy, setBusy] = useState(false);
  const [decline, setDecline] = useState(null);
  const [changes, setChanges] = useState(null);
  const fileRef = useRef(null);
  const [deliver, setDeliver] = useState(false);
  const load = useCallback(() => api.get('/mk/requests/' + id).then(setR).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!r || !r.canManage) return;
    api.get('/mk/requests/team').then(setTeam).catch(() => {});
    api.get('/mk/requests/people').then(setPeople).catch(() => {});
    api.get('/mk/campaigns/options?company=' + r.company.code).then(setCampaigns).catch(() => {});
  }, [r && r.canManage, r && r.company.code]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(fn, msgText) {
    setBusy(true); setError(null);
    try { setR(await fn()); onChanged(); if (msgText) toast(msgText); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const status = (s, note) => act(() => api.post('/mk/requests/' + id + '/status', note === undefined ? { status: s } : { status: s, note }), tr('Request updated.'));
  const setCrew = (ids) => act(() => api.put('/mk/requests/' + id + '/team', { employeeIds: ids }),
    ids.length > r.team.length ? tr('Added to the team; they are told.') : tr('Team updated.'));
  const assign = (field, value) => act(() => api.put('/mk/requests/' + id, { title: r.title, kind: r.kind, brief: r.brief, audience: r.audience, dueOn: r.dueOn, priority: r.priority, [field]: value }));
  async function upload(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const fd = new FormData(); fd.append('file', file); if (deliver) fd.append('delivered', 'true');
    await act(() => api.upload('/mk/requests/' + id + '/files', fd), deliver ? tr('Finished work attached; they are told.') : tr('File attached.'));
  }
  async function send(e) {
    e.preventDefault();
    if (!comment.trim()) return;
    await act(() => api.post('/mk/requests/' + id + '/comments', { body: comment }));
    setComment('');
  }

  if (!r) return <MkDialog wide title={tr('Request')} onClose={onClose}>{error ? <div className="error-banner">{error}</div> : <p className="mk-muted">{tr('Loading…')}</p>}</MkDialog>;
  const stepAt = STEPS.indexOf(r.status);
  const delivered = r.attachments.filter((a) => a.delivered), refs = r.attachments.filter((a) => !a.delivered);
  return (
    <MkDialog wide title={r.ref + ' · ' + r.title} sub={L(REQUEST_KINDS, r.kind) + ' · ' + r.company.name + (r.dueOn ? ' · ' + tr('needed by {date}', { date: dayLabel(r.dueOn, { weekday: 'short', day: 'numeric', month: 'short' }) }) : '')} onClose={onClose}>
      <div className="mk-row" style={{ flexWrap: 'wrap', gap: 8 }}>
        {r.status === 'declined' ? <Pill tone="muted">{L(REQUEST_STATUS, 'declined')}</Pill> : (
          <span className="mk-stepper">{STEPS.map((s, i) => <span key={s} className={i < stepAt ? 'is-done' : i === stepAt ? 'is-now' : ''}>{i < stepAt && <Glyph name="check" size={12} />}{L(REQUEST_STATUS, s)}</span>)}</span>
        )}
        {r.priority === 'urgent' && <Pill tone="bad" glyph="fire">{tr('Urgent')}</Pill>}
        {r.overdue && <Pill tone="bad" glyph="clock">{tr('Past the date needed')}</Pill>}
      </div>
      {error && <div className="error-banner">{error}</div>}

      <div className="mk-two">
        <div className="mk-card">
          <h4 className="mk-h4"><Glyph name="file" size={16} />{tr('The brief')}</h4>
          {r.brief ? <p style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.55 }}>{r.brief}</p> : <p className="mk-muted" style={{ margin: 0 }}>{tr('No brief written.')}</p>}
          {r.audience && <p className="mk-muted" style={{ margin: 0 }}>{tr('For: {who}', { who: r.audience })}</p>}
          {r.note && <p className="mk-note" style={{ margin: 0 }}><strong>{tr('From marketing:')}</strong> {r.note}</p>}
        </div>
        <div className="mk-card">
          <h4 className="mk-h4"><Glyph name="users" size={16} />{tr('Who')}</h4>
          <span className="mk-row"><Photo id={r.requester.id} name={r.requester.name} photo={r.requester.photo} size={30} /><span className="mk-fill"><strong>{r.requester.name}</strong><span className="mk-muted"> · {tr('asked on {date}', { date: dayLabel(r.createdAt) })}</span></span></span>
          {r.canManage ? (
            <>
              <label className="field"><span>{tr('Who leads it')}</span>
                <select className="input" value={r.assignee ? r.assignee.id : ''} disabled={busy} onChange={(e) => assign('assignedTo', e.target.value || null)}>
                  <option value="">{tr('Nobody yet')}</option>{team.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select></label>
              <label className="field"><span>{tr('Part of a campaign')}</span>
                <select className="input" value={r.campaign ? r.campaign.id : ''} disabled={busy} onChange={(e) => assign('campaignId', e.target.value || null)}>
                  <option value="">{tr('No campaign')}</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select></label>
            </>
          ) : (
            <span className="mk-row">{r.assignee ? <><Photo id={r.assignee.id} name={r.assignee.name} photo={r.assignee.photo} size={30} /><span><strong>{r.assignee.name}</strong> <span className="mk-muted">{tr('leads it')}</span></span></> : <span className="mk-muted">{tr('Not assigned yet.')}</span>}</span>
          )}
        </div>
      </div>

      <TeamCard r={r} people={people} busy={busy} onChange={setCrew} />

      {delivered.length > 0 && (
        <div className="mk-card" style={{ borderColor: 'color-mix(in srgb, var(--mk-good) 45%, var(--mk-line))' }}>
          <h4 className="mk-h4" style={{ color: 'var(--mk-good)' }}><Glyph name="download" size={16} />{tr('The finished work')}</h4>
          <div className="mk-files">{delivered.map((a) => <FileChip key={a.id} a={a} id={id} canRemove={r.canManage} onRemoved={setR} />)}</div>
        </div>
      )}

      <div className="mk-chips">
        {r.canManage && r.status === 'new' && <button type="button" className="mk-btn is-primary is-small" disabled={busy} onClick={() => status('in_progress')}><Glyph name="play" size={14} />{tr('Start on it')}</button>}
        {r.canManage && r.status === 'in_progress' && <button type="button" className="mk-btn is-primary is-small" disabled={busy} onClick={() => status('review')}><Glyph name="arrowR" size={14} />{tr('Ready for them to check')}</button>}
        {r.canManage && (r.status === 'review' || r.status === 'in_progress') && <button type="button" className="mk-btn is-ghost is-small" disabled={busy} onClick={() => status('done')}><Glyph name="check" size={14} />{tr('Mark it done')}</button>}
        {r.canManage && (r.status === 'done' || r.status === 'declined') && <button type="button" className="mk-btn is-ghost is-small" disabled={busy} onClick={() => status('in_progress')}>{tr('Reopen')}</button>}
        {r.canManage && r.status !== 'declined' && r.status !== 'done' && <button type="button" className="mk-btn is-danger is-small" disabled={busy} onClick={() => setDecline('')}>{tr('Decline')}</button>}
        {r.mine && r.status === 'review' && !r.canManage && <>
          <button type="button" className="mk-btn is-primary is-small" disabled={busy} onClick={() => status('done')}><Glyph name="check" size={14} />{tr('Looks good: done')}</button>
          <button type="button" className="mk-btn is-ghost is-small" disabled={busy} onClick={() => setChanges('')}>{tr('Ask for changes')}</button>
        </>}
        <span style={{ flex: 1 }} />
        {r.canManage && <label className="mk-row mk-muted" style={{ gap: 6 }}><input type="checkbox" checked={deliver} onChange={(e) => setDeliver(e.target.checked)} />{tr('It is the finished work')}</label>}
        <button type="button" className="mk-btn is-ghost is-small" onClick={() => fileRef.current && fileRef.current.click()}><Glyph name="upload" size={14} />{tr('Attach a file')}</button>
        <input ref={fileRef} type="file" hidden onChange={upload} />
      </div>
      {refs.length > 0 && <div className="mk-files">{refs.map((a) => <FileChip key={a.id} a={a} id={id} canRemove={r.canManage} onRemoved={setR} />)}</div>}

      <div className="mk-card">
        <h4 className="mk-h4"><Glyph name="chat" size={16} />{tr('Talk about it')}</h4>
        <div className="mk-thread">
          {r.thread.map((m) => (
            <div key={m.id} className={'mk-msg' + (m.author.id === me ? ' is-mine' : '')}>
              <Photo id={m.author.id} name={m.author.name} photo={m.author.photo} size={28} />
              <div className="mk-msg-body"><div className="mk-msg-head"><span>{m.author.id === me ? tr('You') : m.author.name}</span><span>{dayLabel(m.at, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span></div>{m.body}</div>
            </div>
          ))}
          {!r.thread.length && <p className="mk-muted" style={{ margin: 0 }}>{tr('No messages yet. Ask a question or add a detail; the other side is told.')}</p>}
        </div>
        <form className="mk-row" onSubmit={send}>
          <input className="input mk-fill" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} placeholder={tr('Write a message…')} aria-label={tr('Message')} />
          <button type="submit" className="mk-btn is-primary is-small" disabled={!comment.trim() || busy}>{tr('Send')}</button>
        </form>
      </div>

      {decline !== null && (
        <MkDialog title={tr('Decline this request')} sub={tr('Say why, so they know what to do instead. They are told.')} onClose={() => setDecline(null)}
          footer={<><button type="button" className="mk-btn is-ghost" onClick={() => setDecline(null)}>{tr('Cancel')}</button><button type="button" className="mk-btn is-danger" disabled={!decline.trim() || busy} onClick={async () => { await status('declined', decline); setDecline(null); }}>{tr('Decline')}</button></>}>
          <textarea className="input" rows={3} value={decline} onChange={(e) => setDecline(e.target.value)} placeholder={tr('e.g. Use the existing price list flyer in the brand kit.')} />
        </MkDialog>
      )}
      {changes !== null && (
        <MkDialog title={tr('Ask for changes')} sub={tr('Say what to change; it goes back to marketing with your note.')} onClose={() => setChanges(null)}
          footer={<><button type="button" className="mk-btn is-ghost" onClick={() => setChanges(null)}>{tr('Cancel')}</button><button type="button" className="mk-btn is-primary" disabled={!changes.trim() || busy} onClick={async () => { await status('in_progress', changes); setChanges(null); }}>{tr('Send it back')}</button></>}>
          <textarea className="input" rows={3} value={changes} onChange={(e) => setChanges(e.target.value)} />
        </MkDialog>
      )}
    </MkDialog>
  );
}

// The team working on it with the one leading it. Marketing picks anyone
// on staff (its own people offered first); everyone else sees who is on it.
function TeamCard({ r, people, busy, onChange }) {
  const ids = r.team.map((m) => m.id);
  const lead = r.assignee ? r.assignee.id : null;
  const choices = people.filter((p) => p.id !== lead);
  const suggested = choices.filter((p) => p.marketing && !ids.includes(p.id)).slice(0, 6);
  const crew = (r.assignee ? 1 : 0) + r.team.length;
  return (
    <div className="mk-card mk-team">
      <div className="mk-team-head">
        <h4 className="mk-h4"><Glyph name="users" size={16} />{tr('Team working on it')}</h4>
        {crew > 0 && <span className="mk-team-count">{crew === 1 ? tr('1 person on it') : tr('{n} people on it', { n: crew })}</span>}
      </div>
      {r.canManage ? (
        <>
          <PeoplePicker employees={choices} value={ids} onChange={(next) => !busy && onChange(next)}
            emptyText={tr('Just the one leading it so far. Add the people who will help: designers, photographers, drivers…')}
            placeholder={tr('Add someone: type a name…')} />
          {suggested.length > 0 && (
            <div className="mk-team-suggest">
              <span className="mk-muted">{tr('From marketing:')}</span>
              {suggested.map((p) => (
                <button key={p.id} type="button" className="mk-team-add" disabled={busy} onClick={() => onChange([...ids, p.id])}>
                  <Photo id={p.id} name={p.firstName + ' ' + p.lastName} photo={p.photo} size={20} /> {(p.firstName + ' ' + p.lastName).trim()} <span aria-hidden="true">+</span>
                </button>
              ))}
            </div>
          )}
        </>
      ) : r.team.length ? (
        <div className="mk-team-list">
          {r.team.map((m) => (
            <span key={m.id} className="mk-team-person">
              <Photo id={m.id} name={m.name} photo={m.photo} size={30} />
              <span><strong>{m.name}</strong>{m.position && <span className="mk-muted">{m.position}</span>}</span>
            </span>
          ))}
        </div>
      ) : <p className="mk-muted" style={{ margin: 0 }}>{tr('Nobody else on it yet.')}</p>}
    </div>
  );
}

function FileChip({ a, id, canRemove, onRemoved }) {
  async function remove() {
    if (!window.confirm(tr('Remove {name}?', { name: a.name }))) return;
    try { onRemoved(await api.del('/mk/requests/' + id + '/files/' + a.id)); } catch { /* left as it was */ }
  }
  return (
    <span className={'mk-file' + (a.delivered ? ' is-delivered' : '')}>
      <Glyph name={a.delivered ? 'trophy' : 'file'} size={15} /><span title={a.name}>{a.name}</span>
      <button type="button" onClick={() => openFile('/mk/requests/' + id + '/files/' + a.id)} title={tr('Open')} aria-label={tr('Open')}><Glyph name="arrowR" size={14} /></button>
      <button type="button" onClick={() => openFile('/mk/requests/' + id + '/files/' + a.id, true)} title={tr('Download')} aria-label={tr('Download')}><Glyph name="download" size={14} /></button>
      {canRemove && <button type="button" onClick={remove} title={tr('Remove')} aria-label={tr('Remove')}>×</button>}
    </span>
  );
}
