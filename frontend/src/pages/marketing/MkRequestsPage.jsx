import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import Photo from '../../components/Photo';
import PeoplePicker from '../../components/PeoplePicker';
import { Section } from '../../components/DashKit';
import { fileBadge, fileKind, viewFiles } from '../../components/FileViewer';
import { activeIntlLocale, msg, tr } from '../../lib/i18n.jsx';
import {
  Glyph, L, Linkified, MkBanner, MkDialog, MkEmpty, Pill, REQUEST_GLYPH, REQUEST_KINDS, REQUEST_STATUS, addDays, dayLabel, openFile, readParam, siteOf, todayIso,
  useProtectedImage, webLink
} from './mkKit';
import RequestsSummary from './MkRequestsSummary';

// Requests to marketing (backend mkRequests.service.js), for everyone:
// ask for a flyer, a post, a banner, a video, photos… with a brief and the
// date it is needed by, attach what helps, and follow it on a board —
// new, in progress, ready to check, done. Marketing takes it on, assigns
// someone to lead it and a team to work with them, talks in the comments
// and attaches the finished work — files, or links to where it lives (the
// published post, a shared folder); the one who asked approves it or asks
// for changes. Anyone on it can add links that help (a Drive folder, a
// design, a post to copy). Files open inside the app
// (components/FileViewer.jsx), one after another; links in a new tab. Everyone is told at each step. What is needed regularly is
// a routine (backend mkRoutines.service.js): it makes the request itself
// on each day it comes round — every N weeks on chosen days, or every N
// months on a day — with the same brief, lead and team.

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
  const [routines, setRoutines] = useState([]);
  const [routineEdit, setRoutineEdit] = useState(null); // null, {} for a new one, or a routine
  const [openId, setOpenId] = useState(() => readParam('open'));
  const [focusRoutine, setFocusRoutine] = useState(() => readParam('routine')); // from a reminder or the calendar
  const [toast, setToast] = useState(null);
  const [presenting, setPresenting] = useState(false);
  const [version, setVersion] = useState(0); // the summary reloads when the board does

  // Marketing starts on everyone's requests; everyone else on their own.
  const loadedOnce = useRef(false);
  const load = useCallback(() => api.get('/mk/requests?scope=' + scope).then((d) => { setData(d); setVersion((v) => v + 1); if (d.canSeeAll && scope === 'mine' && !loadedOnce.current) { loadedOnce.current = true; setScope('all'); } }).catch((e) => setError(e.message)), [scope]);
  useEffect(() => { load(); }, [load]);
  const loadRoutines = useCallback(() => api.get('/mk/routines?scope=' + scope).then(setRoutines).catch(() => setRoutines([])), [scope]);
  useEffect(() => { loadRoutines(); }, [loadRoutines]);
  useEffect(() => { api.get('/mk/companies').then(setCompanies).catch(() => setCompanies([])); }, []);
  // Opened from a routine's reminder or the calendar: scroll to it and light it up.
  useEffect(() => {
    if (!focusRoutine || !routines.some((rt) => rt.id === focusRoutine)) return undefined;
    const t = setTimeout(() => {
      const el = document.getElementById('rt-' + focusRoutine);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 150);
    const done = setTimeout(() => { setFocusRoutine(null); window.history.replaceState({}, '', '/mkrequests'); }, 4000);
    return () => { clearTimeout(t); clearTimeout(done); };
  }, [focusRoutine, routines]);
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
        actions={<>
          <button type="button" className="mk-btn is-primary" onClick={() => setAsking(true)}><Glyph name="plus" size={16} />{tr('Ask for something')}</button>
          <button type="button" className="mk-btn is-ghost" onClick={() => setRoutineEdit({})}><Glyph name="repeat" size={16} />{tr('Set up a routine')}</button>
          <button type="button" className="mk-btn is-ghost" onClick={() => setPresenting(true)} title={tr('The summary as slides, for a meeting')}><Glyph name="play" size={16} />{tr('Present as slides')}</button>
        </>}
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

      <RequestsSummary scope={data.scope} companies={companies} version={version} onOpen={open}
        presenting={presenting} onPresenting={setPresenting} paused={!!openId} />

      <Section id="mk-routines" title={tr('Routines')} sub={tr('Requests that come round on their own: on each day, the request is made with the same brief, lead and team, and they are told.')}
        action={<button type="button" className="mk-btn is-ghost is-small" onClick={() => setRoutineEdit({})}><Glyph name="plus" size={14} />{tr('New routine')}</button>}>
        {routines.length ? (
          <div className="mk-grid">
            {routines.map((rt) => <RoutineCard key={rt.id} rt={rt} me={me} focus={rt.id === focusRoutine} onEdit={() => setRoutineEdit(rt)}
              onChanged={(text) => { loadRoutines(); load(); if (text) setToast(text); }} />)}
          </div>
        ) : (
          <MkEmpty glyph="repeat" title={tr('No routines yet')} action={<button type="button" className="mk-btn is-primary" onClick={() => setRoutineEdit({})}>{tr('Set up a routine')}</button>}>
            {tr('For what is needed again and again: the week\'s social posts, a monthly price list, photos at every month end. Set it once; the request is made on each day it comes round.')}
          </MkEmpty>
        )}
      </Section>

      {asking && <AskDialog companies={companies} onClose={() => setAsking(false)} onDone={(r) => { setAsking(false); load(); open(r.id); setToast(tr('Sent to marketing. You will be told as it moves.')); }}
        onRoutine={(f) => { setAsking(false); setRoutineEdit({ draft: f }); }} />}
      {routineEdit && <RoutineDialog companies={companies} canManage={data.canManage} start={routineEdit} onClose={() => setRoutineEdit(null)}
        onDone={(rt, isNew) => {
          setRoutineEdit(null); loadRoutines(); load();
          setToast(rt.madeNow ? tr('Routine saved. Today\'s request is made; the next comes round on {date}.', { date: dayLabel(rt.nextOn, { weekday: 'short', day: 'numeric', month: 'short' }) })
            : rt.nextOn ? (isNew ? tr('Routine set up. The first request comes round on {date}.', { date: dayLabel(rt.nextOn, { weekday: 'short', day: 'numeric', month: 'short' }) }) : tr('Routine saved.'))
              : tr('Routine saved. It has come to its end date.'));
        }} />}
      {openId && <RequestDetail id={openId} me={me} onClose={close} onChanged={load} toast={setToast} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function RequestCard({ r, me, onOpen }) {
  return (
    <button type="button" className={'mk-card mk-req' + (r.priority === 'urgent' ? ' is-urgent' : '')} style={{ '--p': 'var(--mk-' + ({ new: 'info', in_progress: 'violet', review: 'warn', done: 'good' }[r.status] || 'muted') + ')' }} onClick={onOpen}>
      <span className="mk-req-top"><span className="mk-icon"><Glyph name={REQUEST_GLYPH[r.kind]} size={15} /></span>{r.ref} · {L(REQUEST_KINDS, r.kind)}{r.routine && <span className="mk-req-repeat" title={tr('From a routine')}><Glyph name="repeat" size={13} /></span>}{r.priority === 'urgent' && <Pill tone="bad" glyph="fire">{tr('Urgent')}</Pill>}</span>
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

function AskDialog({ companies, onClose, onDone, onRoutine }) {
  const [f, setF] = useState({ company: (companies[0] && companies[0].code) || 'BPL', kind: 'flyer', title: '', brief: '', audience: '', dueOn: '', priority: 'normal', links: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function send(e) {
    e.preventDefault();
    const lines = f.links.split(/\s*\n\s*/).map((x) => x.trim()).filter(Boolean);
    const links = [];
    for (let i = 0; i < lines.length; i++) {
      const k = webLink(lines[i]);
      if (k.error) { setError(lines.length > 1 ? tr('Link {n}: {problem}', { n: i + 1, problem: k.error }) : k.error); return; }
      links.push(k.url);
    }
    if (links.length > 10) { setError(tr('Up to 10 links with a new request; add more after.')); return; }
    setSaving(true); setError(null);
    try { onDone(await api.post('/mk/requests', { ...f, links })); } catch (err) { setError(err.message); setSaving(false); }
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
        <label className="field is-span"><span className="mk-row" style={{ gap: 6 }}><Glyph name="link" size={14} />{tr('Links that help')} <span className="mk-muted">{tr('(optional)')}</span></span>
          <textarea className="input" rows={2} value={f.links} onChange={set('links')} placeholder={tr('One per line: a Google Drive folder, a Canva design, a post to copy, a website…')} />
          <span className="hint">{tr('Files can be attached once it is sent.')}</span></label>
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
        <button type="button" className="mk-routine-offer is-span" onClick={() => onRoutine(f)}>
          <Glyph name="repeat" size={18} /><span><strong>{tr('Needed again and again?')}</strong> {tr('Make it a routine: it is asked for on its own every week or month.')}</span><Glyph name="arrowR" size={16} />
        </button>
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
  const [linkForm, setLinkForm] = useState(null); // { url, label } while adding a link
  const [linkError, setLinkError] = useState(null);
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
  async function setCrew(ids) {
    setBusy(true); setError(null);
    try {
      const next = await api.put('/mk/requests/' + id + '/team', { employeeIds: ids });
      setR(next); onChanged();
      const t = next.texts;
      if (ids.length <= r.team.length) toast(tr('Team updated.'));
      else if (!t) toast(tr('Added to the team; they are told.'));
      else if (t.sent && !t.noPhone && !t.failed) toast(tr('Added to the team; they are told here and by text.'));
      else if (t.noPhone && !t.sent) toast(tr('Added to the team and told here. No text: there is no phone number on their employee record.'));
      else toast(tr('Added to the team and told here. Texts sent: {sent} of {n}.', { sent: t.sent, n: t.sent + t.noPhone + t.failed }));
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const assign = (field, value) => act(() => api.put('/mk/requests/' + id, { title: r.title, kind: r.kind, brief: r.brief, audience: r.audience, dueOn: r.dueOn, priority: r.priority, [field]: value }));
  async function upload(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const fd = new FormData(); fd.append('file', file); if (deliver) fd.append('delivered', 'true');
    await act(() => api.upload('/mk/requests/' + id + '/files', fd), deliver ? tr('Finished work attached; they are told.') : tr('File attached.'));
  }
  async function addLink(e) {
    e.preventDefault();
    const k = webLink(linkForm.url);
    if (k.error) { setLinkError(k.error); return; }
    setBusy(true); setLinkError(null);
    try {
      setR(await api.post('/mk/requests/' + id + '/links', { url: k.url, label: linkForm.label, delivered: deliver }));
      onChanged(); setLinkForm(null);
      toast(deliver ? tr('Link to the finished work added; they are told.') : tr('Link added.'));
    } catch (err) { setLinkError(err.message); } finally { setBusy(false); }
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
  const links = r.links || [], doneLinks = links.filter((k) => k.delivered), refLinks = links.filter((k) => !k.delivered);
  // Every file of the request, the finished work first, to go through in the viewer.
  const shelf = delivered.concat(refs);
  const viewAll = (a) => viewFiles(shelf.map((x) => ({
    path: '/mk/requests/' + id + '/files/' + x.id, name: x.name, mime: x.mime, size: x.size,
    note: [x.delivered ? tr('The finished work') : null, tr('added by {name} on {date}', { name: x.by, date: dayLabel(x.at) })].filter(Boolean).join(' · ')
  })), shelf.indexOf(a));
  const mayRemove = (x) => r.canManage || x.byId === me;
  const removeLink = async (k) => {
    if (!window.confirm(tr('Remove the link to {name}?', { name: k.label || k.host }))) return;
    await act(() => api.del('/mk/requests/' + id + '/links/' + k.id), tr('Link removed.'));
  };
  return (
    <MkDialog wide title={r.ref + ' · ' + r.title} sub={L(REQUEST_KINDS, r.kind) + ' · ' + r.company.name + (r.dueOn ? ' · ' + tr('needed by {date}', { date: dayLabel(r.dueOn, { weekday: 'short', day: 'numeric', month: 'short' }) }) : '')} onClose={onClose}>
      <div className="mk-row" style={{ flexWrap: 'wrap', gap: 8 }}>
        {r.status === 'declined' ? <Pill tone="muted">{L(REQUEST_STATUS, 'declined')}</Pill> : (
          <span className="mk-stepper">{STEPS.map((s, i) => <span key={s} className={i < stepAt ? 'is-done' : i === stepAt ? 'is-now' : ''}>{i < stepAt && <Glyph name="check" size={12} />}{L(REQUEST_STATUS, s)}</span>)}</span>
        )}
        {r.priority === 'urgent' && <Pill tone="bad" glyph="fire">{tr('Urgent')}</Pill>}
        {r.overdue && <Pill tone="bad" glyph="clock">{tr('Past the date needed')}</Pill>}
        {r.routine && <Pill tone="violet" glyph="repeat">{tr('From a routine, for {date}', { date: dayLabel(r.routine.on, { weekday: 'short', day: 'numeric', month: 'short' }) })}</Pill>}
      </div>
      {error && <div className="error-banner">{error}</div>}

      <div className="mk-two">
        <div className="mk-card">
          <h4 className="mk-h4"><Glyph name="file" size={16} />{tr('The brief')}</h4>
          {r.brief ? <p style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.55, overflowWrap: 'anywhere' }}><Linkified text={r.brief} /></p> : <p className="mk-muted" style={{ margin: 0 }}>{tr('No brief written.')}</p>}
          {r.audience && <p className="mk-muted" style={{ margin: 0 }}>{tr('For: {who}', { who: r.audience })}</p>}
          {r.note && <p className="mk-note" style={{ margin: 0 }}><strong>{tr('From marketing:')}</strong> <Linkified text={r.note} /></p>}
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

      {delivered.length + doneLinks.length > 0 && (
        <div className="mk-card mk-shelf is-done">
          <h4 className="mk-h4"><Glyph name="trophy" size={16} />{tr('The finished work')}</h4>
          {delivered.length > 0 && <div className="mk-ftiles">{delivered.map((a) => <FileTile key={a.id} a={a} id={id} onOpen={() => viewAll(a)} canRemove={mayRemove(a)} onRemoved={setR} />)}</div>}
          {doneLinks.length > 0 && <div className="mk-links">{doneLinks.map((k) => <LinkRow key={k.id} k={k} canRemove={mayRemove(k)} onRemove={() => removeLink(k)} />)}</div>}
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
        <button type="button" className={'mk-btn is-ghost is-small' + (linkForm ? ' is-on' : '')} onClick={() => { setLinkError(null); setLinkForm(linkForm ? null : { url: '', label: '' }); }}><Glyph name="link" size={14} />{tr('Add a link')}</button>
        <button type="button" className="mk-btn is-ghost is-small" onClick={() => fileRef.current && fileRef.current.click()}><Glyph name="upload" size={14} />{tr('Attach a file')}</button>
        <input ref={fileRef} type="file" hidden onChange={upload} />
      </div>
      {linkForm && (
        <form className={'mk-card mk-linkform' + (deliver ? ' is-done' : '')} onSubmit={addLink}>
          <h4 className="mk-h4"><Glyph name="link" size={16} />{deliver ? tr('A link to the finished work') : tr('Add a link')}</h4>
          <p className="mk-muted" style={{ margin: 0, fontSize: 13 }}>{deliver ? tr('Where the finished work lives: the published post, the shared folder… They are told.') : tr('A Google Drive folder, a Canva design, a post to copy, a website… It opens in a new tab.')}</p>
          <div className="mk-linkform-row">
            <input className="input mk-fill" autoFocus value={linkForm.url} onChange={(e) => { setLinkError(null); setLinkForm({ ...linkForm, url: e.target.value }); }} placeholder={tr('Paste the link')} aria-label={tr('Web link')} maxLength={2000} />
            <input className="input" value={linkForm.label} onChange={(e) => setLinkForm({ ...linkForm, label: e.target.value })} placeholder={tr('What is it? (optional)')} aria-label={tr('What is it?')} maxLength={160} />
            <button type="submit" className="mk-btn is-primary is-small" disabled={busy || !linkForm.url.trim()}>{tr('Add')}</button>
            <button type="button" className="mk-btn is-ghost is-small" onClick={() => setLinkForm(null)}>{tr('Cancel')}</button>
          </div>
          {linkError && <p className="mk-link-error" role="alert">{linkError}</p>}
        </form>
      )}
      {refs.length + refLinks.length > 0 && (
        <div className="mk-card mk-shelf">
          <h4 className="mk-h4"><Glyph name="file" size={16} />{tr('Files and links')}<span className="mk-muted mk-shelf-count">{[refs.length ? (refs.length === 1 ? tr('1 file') : tr('{n} files', { n: refs.length })) : null, refLinks.length ? (refLinks.length === 1 ? tr('1 link') : tr('{n} links', { n: refLinks.length })) : null].filter(Boolean).join(' · ')}</span></h4>
          {refs.length > 0 && <div className="mk-ftiles">{refs.map((a) => <FileTile key={a.id} a={a} id={id} onOpen={() => viewAll(a)} canRemove={mayRemove(a)} onRemoved={setR} />)}</div>}
          {refLinks.length > 0 && <div className="mk-links">{refLinks.map((k) => <LinkRow key={k.id} k={k} canRemove={mayRemove(k)} onRemove={() => removeLink(k)} />)}</div>}
        </div>
      )}

      <div className="mk-card">
        <h4 className="mk-h4"><Glyph name="chat" size={16} />{tr('Talk about it')}</h4>
        <div className="mk-thread">
          {r.thread.map((m) => (
            <div key={m.id} className={'mk-msg' + (m.author.id === me ? ' is-mine' : '')}>
              <Photo id={m.author.id} name={m.author.name} photo={m.author.photo} size={28} />
              <div className="mk-msg-body"><div className="mk-msg-head"><span>{m.author.id === me ? tr('You') : m.author.name}</span><span>{dayLabel(m.at, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span></div><Linkified text={m.body} /></div>
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

// ---- routines -----------------------------------------------------------------
// Mon … Sun, the way the week reads here; JS days are 0 Sunday … 6 Saturday.
const WEEK = [1, 2, 3, 4, 5, 6, 0];
function dayName(d, style) { return new Date(Date.UTC(2030, 0, 6 + d)).toLocaleDateString(activeIntlLocale(), { weekday: style || 'short', timeZone: 'UTC' }); } // 6 Jan 2030 is a Sunday
function listOf(items) {
  try { return new Intl.ListFormat(activeIntlLocale(), { style: 'long', type: 'conjunction' }).format(items); } catch { return items.join(', '); }
}
// The same rule as the server's (mkRoutines.service.js fallsOn/nextOn), to
// show the next days it comes round while it is being set up.
function isoAdd(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function fallsOn(rt, iso) {
  if (iso < rt.startsOn || (rt.endsOn && iso > rt.endsOn)) return false;
  const n = Number(rt.everyN) || 1, d = new Date(iso + 'T00:00:00Z'), s = new Date(rt.startsOn + 'T00:00:00Z');
  if (rt.every === 'week') {
    if (!rt.weekdays.includes(d.getUTCDay())) return false;
    const mon = (x) => new Date(x.getTime() - ((x.getUTCDay() + 6) % 7) * 86400000);
    return Math.round((mon(d) - mon(s)) / (7 * 86400000)) % n === 0;
  }
  const months = (d.getUTCFullYear() - s.getUTCFullYear()) * 12 + d.getUTCMonth() - s.getUTCMonth();
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  return months % n === 0 && d.getUTCDate() === Math.min(Number(rt.monthDay), end);
}
function comingDays(rt, from, count) {
  const out = [];
  if (rt.every === 'week' ? !rt.weekdays.length : !rt.monthDay) return out;
  let day = from > rt.startsOn ? from : rt.startsOn;
  for (let i = 0; i < 800 && out.length < count; i++, day = isoAdd(day, 1)) {
    if (rt.endsOn && day > rt.endsOn) break;
    if (fallsOn(rt, day)) out.push(day);
  }
  return out;
}
function scheduleText(rt) {
  const n = Number(rt.everyN) || 1;
  if (rt.every === 'week') {
    const days = WEEK.filter((d) => rt.weekdays.includes(d));
    const names = days.length === 7 ? tr('every day') : listOf(days.map((d) => dayName(d, 'long')));
    return n === 1 ? tr('Every week on {days}', { days: names }) : tr('Every {n} weeks on {days}', { n, days: names });
  }
  if (Number(rt.monthDay) >= 31) return n === 1 ? tr('Every month on its last day') : tr('Every {n} months on the last day', { n });
  return n === 1 ? tr('Every month on day {day}', { day: rt.monthDay }) : tr('Every {n} months on day {day}', { n, day: rt.monthDay });
}
function dueText(n) {
  n = Number(n) || 0;
  return n === 0 ? tr('needed the same day') : n === 1 ? tr('needed the next day') : tr('needed {n} days later', { n });
}
const longDay = (iso) => dayLabel(iso, { weekday: 'short', day: 'numeric', month: 'short' });
function aheadText(n) {
  if (n === null || n === undefined || n === '') return tr('No heads-up');
  return Number(n) === 1 ? tr('The day before it comes round') : tr('{n} days before it comes round', { n });
}
function dueRemindText(n) {
  if (n === null || n === undefined || n === '') return tr('No reminder before it is needed');
  n = Number(n);
  return n === 0 ? tr('On the day it is needed') : n === 1 ? tr('The day before it is needed, and on the day') : tr('{n} days before it is needed, and on the day', { n });
}

function RoutineCard({ rt, me, focus, onEdit, onChanged }) {
  const [busy, setBusy] = useState(false);
  async function run(fn, text) {
    setBusy(true);
    try { await fn(); onChanged(text); } catch (e) { onChanged(e.message); } finally { setBusy(false); }
  }
  const pause = () => run(() => api.post('/mk/routines/' + rt.id + '/pause', { paused: !rt.paused }), rt.paused ? tr('Routine resumed.') : tr('Routine paused: nothing is made until it is resumed.'));
  const stop = () => window.confirm(tr('Stop the routine "{title}"? The requests it made stay.', { title: rt.title }))
    && run(() => api.del('/mk/routines/' + rt.id), tr('Routine stopped.'));
  const faces = [rt.lead, ...rt.team].filter(Boolean);
  return (
    <div id={'rt-' + rt.id} className={'mk-card mk-routine' + (rt.paused ? ' is-paused' : rt.ended ? ' is-ended' : '') + (focus ? ' is-focus' : '')}>
      <div className="mk-routine-top">
        <span className="mk-icon"><Glyph name={REQUEST_GLYPH[rt.kind]} size={16} /></span>
        <span className="mk-fill">
          <strong className="mk-card-title" style={{ fontSize: 14.5 }}>{rt.title}</strong>
          <span className="mk-muted">{L(REQUEST_KINDS, rt.kind)} · {rt.company.name}</span>
        </span>
        {rt.paused ? <Pill tone="warn" glyph="pause">{tr('Paused')}</Pill> : rt.ended ? <Pill tone="muted">{tr('Ended')}</Pill> : rt.priority === 'urgent' ? <Pill tone="bad" glyph="fire">{tr('Urgent')}</Pill> : null}
      </div>
      <div className="mk-routine-when">
        <Glyph name="repeat" size={15} />
        <span><strong>{scheduleText(rt)}</strong>, {dueText(rt.dueAfterDays)}</span>
      </div>
      {rt.nextOn && <div className="mk-routine-next"><span>{tr('Next one')}</span><strong>{longDay(rt.nextOn)}</strong></div>}
      <div className={'mk-routine-bell' + (rt.remindAheadDays === null && rt.remindDueDays === null ? ' is-off' : '')}>
        <Glyph name="bell" size={14} />
        {rt.remindAheadDays === null && rt.remindDueDays === null ? <span>{tr('No reminders')}</span> : (
          <span>
            {[rt.remindAheadDays !== null && aheadText(rt.remindAheadDays), rt.remindDueDays !== null && dueRemindText(rt.remindDueDays)].filter(Boolean).join(' · ')}
            {rt.remindBySms && <em> · {tr('by text too')}</em>}
          </span>
        )}
      </div>
      <div className="mk-routine-foot">
        <span className="mk-faces">
          <Photo id={rt.owner.id} name={rt.owner.name} photo={rt.owner.photo} size={24} />
          {faces.slice(0, 3).map((p) => <Photo key={p.id} id={p.id} name={p.name} photo={p.photo} size={24} />)}
          {faces.length > 3 && <span className="mk-faces-more">+{faces.length - 3}</span>}
        </span>
        <span className="mk-muted mk-fill">{rt.owner.id === me ? tr('Your routine') : rt.owner.name}{rt.lead ? ' · ' + tr('{name} leads', { name: rt.lead.name }) : ''}</span>
        <span className="mk-routine-made" title={tr('Requests made so far')}>{rt.made === 1 ? tr('1 made') : tr('{n} made', { n: rt.made })}{rt.open > 0 ? ' · ' + tr('{n} open', { n: rt.open }) : ''}</span>
      </div>
      {rt.canEdit && (
        <div className="mk-chips">
          <button type="button" className="mk-btn is-ghost is-small" disabled={busy} onClick={onEdit}>{tr('Edit')}</button>
          {!rt.ended && <button type="button" className="mk-btn is-ghost is-small" disabled={busy} onClick={pause}><Glyph name={rt.paused ? 'play' : 'pause'} size={13} />{rt.paused ? tr('Resume') : tr('Pause')}</button>}
          <button type="button" className="mk-btn is-danger is-small" disabled={busy} onClick={stop}>{tr('Stop')}</button>
        </div>
      )}
    </div>
  );
}

function RoutineDialog({ companies, canManage, start, onClose, onDone }) {
  const existing = start && start.id ? start : null;
  const draft = (start && start.draft) || {};
  const [f, setF] = useState(() => existing ? {
    company: existing.company.code, kind: existing.kind, title: existing.title, brief: existing.brief, audience: existing.audience, priority: existing.priority,
    every: existing.every, everyN: existing.everyN, weekdays: existing.weekdays, monthDay: existing.monthDay || 1, dueAfterDays: existing.dueAfterDays,
    startsOn: existing.startsOn, endsOn: existing.endsOn || '', assignedTo: existing.lead ? existing.lead.id : '', teamIds: existing.team.map((m) => m.id), campaignId: existing.campaign ? existing.campaign.id : '',
    remindAheadDays: existing.remindAheadDays === null ? '' : existing.remindAheadDays, remindDueDays: existing.remindDueDays === null ? '' : existing.remindDueDays, remindBySms: existing.remindBySms
  } : {
    company: draft.company || (companies[0] && companies[0].code) || 'BPL', kind: draft.kind || 'social_post', title: draft.title || '', brief: draft.brief || '', audience: draft.audience || '',
    priority: draft.priority || 'normal', every: 'week', everyN: 1, weekdays: [new Date().getDay()], monthDay: 1, dueAfterDays: 2,
    startsOn: todayIso(), endsOn: '', assignedTo: '', teamIds: [], campaignId: '',
    remindAheadDays: 1, remindDueDays: 1, remindBySms: true
  });
  const [team, setTeam] = useState([]);
  const [people, setPeople] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!canManage) return;
    api.get('/mk/requests/team').then(setTeam).catch(() => {});
    api.get('/mk/requests/people').then(setPeople).catch(() => {});
  }, [canManage]);
  useEffect(() => { if (canManage) api.get('/mk/campaigns/options?company=' + f.company).then(setCampaigns).catch(() => {}); }, [canManage, f.company]);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const toggleDay = (d) => setF({ ...f, weekdays: f.weekdays.includes(d) ? f.weekdays.filter((x) => x !== d) : [...f.weekdays, d] });
  const next = comingDays(f, f.startsOn > todayIso() ? f.startsOn : todayIso(), 4);

  async function save(e) {
    e.preventDefault();
    setSaving(true); setError(null);
    const body = { ...f, endsOn: f.endsOn || null, everyN: Number(f.everyN), monthDay: Number(f.monthDay), dueAfterDays: Number(f.dueAfterDays),
      remindAheadDays: f.remindAheadDays === '' ? null : Number(f.remindAheadDays), remindDueDays: f.remindDueDays === '' ? null : Number(f.remindDueDays) };
    if (canManage) { body.assignedTo = f.assignedTo || null; body.campaignId = f.campaignId || null; } else { delete body.assignedTo; delete body.teamIds; delete body.campaignId; }
    try {
      const rt = existing ? await api.put('/mk/routines/' + existing.id, body) : await api.post('/mk/routines', body);
      onDone(rt, !existing);
    } catch (err) { setError(err.message); setSaving(false); }
  }
  return (
    <MkDialog wide title={existing ? tr('Edit the routine') : tr('Set up a routine')} sub={tr('A request that comes round on its own. On each day, it is made and marketing (or the lead and team below) is told.')} onClose={() => !saving && onClose()}
      footer={<><button type="button" className="mk-btn is-ghost" onClick={onClose} disabled={saving}>{tr('Cancel')}</button><button type="submit" form="mk-routine" className="mk-btn is-primary" disabled={saving}>{saving ? tr('Saving…') : existing ? tr('Save') : tr('Set it up')}</button></>}>
      <form id="mk-routine" className="mk-form" onSubmit={save}>
        <div className="field is-span"><span>{tr('What is needed each time?')}</span>
          <div className="mk-kinds" role="radiogroup" aria-label={tr('Kind')}>
            {Object.keys(REQUEST_KINDS).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={f.kind === k} className={'mk-kind' + (f.kind === k ? ' is-on' : '')} onClick={() => setF({ ...f, kind: k })}>
                <Glyph name={REQUEST_GLYPH[k]} size={22} />{L(REQUEST_KINDS, k)}
              </button>
            ))}
          </div>
        </div>
        <label className="field is-span"><span>{tr('In a few words')}</span><input className="input" required maxLength={160} value={f.title} onChange={set('title')} placeholder={tr('e.g. Instagram post: the week\'s offer')} /></label>
        <label className="field is-span"><span>{tr('The brief')}</span><textarea className="input" rows={3} maxLength={4000} value={f.brief} onChange={set('brief')} placeholder={tr('What each one is for and must say. The same brief goes on every request.')} /></label>

        <div className="field is-span mk-routine-plan">
          <span>{tr('How often')}</span>
          <div className="mk-chippick" role="radiogroup" aria-label={tr('How often')}>
            {[['week', tr('Weekly')], ['month', tr('Monthly')]].map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={f.every === k} className={'mk-chipopt' + (f.every === k ? ' is-on' : '')} onClick={() => setF({ ...f, every: k, everyN: 1 })}>{label}</button>
            ))}
          </div>
          {f.every === 'week' ? (
            <>
              <div className="mk-weekdays" role="group" aria-label={tr('On which days')}>
                {WEEK.map((d) => (
                  <button key={d} type="button" aria-pressed={f.weekdays.includes(d)} className={'mk-weekday' + (f.weekdays.includes(d) ? ' is-on' : '')} onClick={() => toggleDay(d)} title={dayName(d, 'long')}>{dayName(d, 'short')}</button>
                ))}
              </div>
              <label className="mk-row mk-inline">
                <select className="input" value={f.everyN} onChange={set('everyN')} aria-label={tr('How often')}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n === 1 ? tr('Every week') : tr('Every {n} weeks', { n })}</option>)}</select>
              </label>
            </>
          ) : (
            <div className="mk-row mk-inline" style={{ flexWrap: 'wrap' }}>
              <label className="mk-row">{tr('On day')}
                <select className="input" value={f.monthDay} onChange={set('monthDay')}>
                  {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
                  <option value={31}>{tr('the last day')}</option>
                </select>
              </label>
              <label className="mk-row">
                <select className="input" value={f.everyN} onChange={set('everyN')} aria-label={tr('How often')}>{[1, 2, 3, 6, 12].map((n) => <option key={n} value={n}>{n === 1 ? tr('every month') : tr('every {n} months', { n })}</option>)}</select>
              </label>
            </div>
          )}
          <label className="mk-row mk-inline">{tr('Needed')}
            <select className="input" value={f.dueAfterDays} onChange={set('dueAfterDays')}>
              {[0, 1, 2, 3, 4, 5, 7, 10, 14, 21, 28].map((n) => <option key={n} value={n}>{dueText(n)}</option>)}
            </select>
          </label>
          <div className="mk-routine-preview" aria-live="polite">
            {next.length ? <>
              <span className="mk-muted">{tr('Comes round on')}</span>
              {next.map((d) => <span key={d} className="mk-routine-day"><strong>{longDay(d)}</strong><small>{tr('needed {date}', { date: dayLabel(addDays(d, Number(f.dueAfterDays))) })}</small></span>)}
            </> : <span className="mk-muted">{tr('Pick when it comes round to see the next days.')}</span>}
          </div>
        </div>

        <label className="field"><span>{tr('Starts on')}</span><input className="input" type="date" required min={existing ? undefined : todayIso()} value={f.startsOn} onChange={set('startsOn')} /></label>
        <label className="field"><span>{tr('Ends on (optional)')}</span><input className="input" type="date" min={f.startsOn} value={f.endsOn} onChange={set('endsOn')} /></label>
        <label className="field"><span>{tr('Who will see it')}</span><input className="input" maxLength={300} value={f.audience} onChange={set('audience')} placeholder={tr('e.g. Walk-in customers, hotel buyers')} /></label>
        {companies.length > 1 && (
          <label className="field"><span>{tr('For')}</span>
            <select className="input" value={f.company} onChange={set('company')} disabled={!!existing}>{companies.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select>
          </label>
        )}
        {canManage && <>
          <label className="field"><span>{tr('Who leads it')}</span>
            <select className="input" value={f.assignedTo} onChange={(e) => setF({ ...f, assignedTo: e.target.value, teamIds: f.teamIds.filter((x) => x !== e.target.value) })}>
              <option value="">{tr('Nobody yet: marketing is told each time')}</option>{team.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select></label>
          <label className="field"><span>{tr('Part of a campaign')}</span>
            <select className="input" value={f.campaignId} onChange={set('campaignId')}>
              <option value="">{tr('No campaign')}</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select></label>
          <div className="field is-span"><span>{tr('Team working on it')}</span>
            <PeoplePicker employees={people.filter((p) => p.id !== f.assignedTo)} value={f.teamIds} onChange={(ids) => setF({ ...f, teamIds: ids })}
              emptyText={tr('Nobody else yet. Each request will have this team, and they are told every time.')} placeholder={tr('Add someone: type a name…')} />
          </div>
        </>}
        <label className="field is-span"><span className="mk-row" style={{ gap: 8 }}>
          <input type="checkbox" checked={f.priority === 'urgent'} onChange={(e) => setF({ ...f, priority: e.target.checked ? 'urgent' : 'normal' })} style={{ width: 18, height: 18 }} />
          {tr('Each one is urgent')}</span></label>

        <div className="field is-span mk-remind">
          <span><Glyph name="bell" size={15} /> {tr('Reminders')}</span>
          <p className="mk-muted">{tr('To the one leading it and the team (marketing, when nobody is on it): in the OS and as a phone pop-up. The reminder before it is needed stops once the request is done.')}</p>
          <div className="mk-remind-grid">
            <label className="mk-remind-opt"><small>{tr('Heads-up')}</small>
              <select className="input" value={f.remindAheadDays} onChange={set('remindAheadDays')}>
                {['', 1, 2, 3, 7].map((n) => <option key={n} value={n}>{aheadText(n)}</option>)}
              </select></label>
            <label className="mk-remind-opt"><small>{tr('Before it is needed')}</small>
              <select className="input" value={f.remindDueDays} onChange={set('remindDueDays')}>
                {['', 0, 1, 2, 3].map((n) => <option key={n} value={n}>{dueRemindText(n)}</option>)}
              </select></label>
          </div>
          <label className="mk-row" style={{ gap: 8 }}>
            <input type="checkbox" checked={!!f.remindBySms} onChange={(e) => setF({ ...f, remindBySms: e.target.checked })} style={{ width: 18, height: 18 }} />
            {tr('Also by text message, to the phone on their staff record')}</label>
        </div>
      </form>
      {error && <div className="error-banner">{error}</div>}
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

// A file on a request: its picture (or a badge for its kind), name, size
// and who added it; pressed, it opens in the viewer with the others.
function sizeText(n) { return !n ? '' : n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (Math.round((n / (1024 * 1024)) * 10) / 10) + ' MB'; }
function FileTile({ a, id, onOpen, canRemove, onRemoved }) {
  const kind = fileKind(a.name, a.mime), badge = fileBadge(a.name, a.mime);
  const picture = useProtectedImage(kind === 'image' ? '/mk/requests/' + id + '/files/' + a.id : null);
  async function remove() {
    if (!window.confirm(tr('Remove {name}?', { name: a.name }))) return;
    try { onRemoved(await api.del('/mk/requests/' + id + '/files/' + a.id)); } catch { /* left as it was */ }
  }
  return (
    <span className={'mk-ftile' + (a.delivered ? ' is-done' : '')}>
      <button type="button" className="mk-ftile-open" onClick={onOpen} title={tr('Open {name}', { name: a.name })}>
        <span className="mk-ftile-art" style={{ '--fc': badge.tone }}>
          {picture ? <img src={picture} alt="" /> : <span className="mk-ftile-badge">{badge.label}</span>}
          <span className="mk-ftile-look"><Glyph name={kind === 'video' ? 'play' : kind === 'other' ? 'download' : 'eye'} size={18} /></span>
        </span>
        <span className="mk-ftile-name">{a.name}</span>
        <small>{[sizeText(a.size), a.by].filter(Boolean).join(' · ')}</small>
      </button>
      <span className="mk-ftile-acts">
        <button type="button" onClick={() => openFile('/mk/requests/' + id + '/files/' + a.id, true)} title={tr('Download')} aria-label={tr('Download')}><Glyph name="download" size={14} /></button>
        {canRemove && <button type="button" onClick={remove} title={tr('Remove')} aria-label={tr('Remove')}>×</button>}
      </span>
    </span>
  );
}

// A link on a request: the site, what it is, and where it goes; it opens in
// a new tab.
function LinkRow({ k, canRemove, onRemove }) {
  const site = siteOf(k.host);
  const where = k.url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
  return (
    <span className={'mk-link' + (k.delivered ? ' is-done' : '')}>
      <a href={k.url} target="_blank" rel="noopener noreferrer" title={k.url}>
        <span className="mk-link-site" style={{ '--s': site.color }} aria-hidden="true">{site.letter}</span>
        <span className="mk-link-text">
          <strong>{k.label || site.name || k.host}</strong>
          <small>{(k.label && site.name ? site.name + ' · ' : '') + where}</small>
        </span>
        <span className="mk-link-by">{k.by}</span>
        <Glyph name="external" size={15} />
      </a>
      {canRemove && <button type="button" onClick={onRemove} title={tr('Remove')} aria-label={tr('Remove')}>×</button>}
    </span>
  );
}
