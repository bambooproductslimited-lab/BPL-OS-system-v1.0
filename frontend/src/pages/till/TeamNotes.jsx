import { useCallback, useEffect, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { activeIntlLocale, msg, tr } from '../../lib/i18n.jsx';
import './twelfth.css';

// Notes for the team on the till (backend restaurantTeamNotes.service,
// migration 0193): whoever signs in sees the notes they have not read, and
// taps "Got it"; a manager writes them (for a day or up to two weeks,
// urgent or good news, pinned on top) and sees who has read each.

const TONES = [['info', '📌', msg('Note')], ['urgent', '⚠️', msg('Urgent')], ['good', '🎉', msg('Good news')]];
const DAYS = [1, 2, 3, 7, 14];
function when(d) { return new Date(d).toLocaleString(activeIntlLocale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
function untilWords(d) { return tr('up until {day}', { day: new Date(d).toLocaleDateString(activeIntlLocale(), { weekday: 'short', day: 'numeric', month: 'short' }) }); }

function Note({ n, i, isNew, children }) {
  const tone = TONES.find((t) => t[0] === n.tone) || TONES[0];
  return (
    <li className={'crew-note is-' + n.tone} style={{ '--i': i }}>
      <div className="crew-tags">
        {isNew && <span className="crew-tag is-new">{tr('New')}</span>}
        {n.tone !== 'info' && <span className={'crew-tag is-' + n.tone}>{tone[1]} {tr(tone[2])}</span>}
        {n.pinned && <span className="crew-tag">📍 {tr('Pinned')}</span>}
        {n.live === false && <span className="crew-tag">{tr('Ended')}</span>}
      </div>
      <p>{n.body}</p>
      <small>{n.by} · {when(n.at)} · {untilWords(n.until)}</small>
      {children}
    </li>
  );
}

export default function TeamNotes({ token, isManager, initial, onClose }) {
  const [mine, setMine] = useState(initial || null);
  const [all, setAll] = useState(null); // a manager's: every note with who has read it
  const [body, setBody] = useState('');
  const [tone, setTone] = useState('info');
  const [days, setDays] = useState(1);
  const [pinned, setPinned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const manage = useCallback((p) => posFetch('POST', '/pos/team-notes/manage', token, p), [token]);
  useEffect(() => {
    if (!initial) posFetch('GET', '/pos/team-notes', token).then(setMine).catch((e) => setError(e.message));
    if (isManager) manage({ action: 'list' }).then(setAll).catch((e) => setError(e.message));
  }, [token, isManager, initial, manage]);
  const unread = mine ? mine.notes.filter((n) => !n.read) : [];
  async function gotIt() {
    setBusy(true);
    try { const r = await posFetch('POST', '/pos/team-notes/read', token, { ids: unread.map((n) => n.id) }); setMine(r); onClose(r); } catch (e) { setError(e.message); setBusy(false); }
  }
  async function act(p) {
    setBusy(true); setError(null);
    try {
      setAll(await manage(p));
      if (p.action === 'add') { setBody(''); setTone('info'); setDays(1); setPinned(false); }
      setMine(await posFetch('GET', '/pos/team-notes', token));
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={() => !busy && onClose(mine)}>
      <div className="dialog crew" role="dialog" aria-modal="true" aria-labelledby="crew-title" onClick={(e) => e.stopPropagation()}>
        <div className="crew-head">
          <span className="crew-head-art" aria-hidden="true">{unread.length ? '📣' : '📌'}</span>
          <div><h2 id="crew-title">{tr('Notes for the team')}</h2>
            <p>{unread.length ? (unread.length === 1 ? tr('1 new note from the manager') : tr('{n} new notes from the manager', { n: unread.length })) : isManager ? tr('Write one: everyone sees it when they sign in.') : tr('Nothing new. These are up now.')}</p></div>
        </div>
        {isManager && (
          <form className="crew-write" onSubmit={(e) => { e.preventDefault(); act({ action: 'add', body, tone, days, pinned }); }}>
            <textarea className="input" maxLength={500} value={body} onChange={(e) => setBody(e.target.value)} placeholder={tr('e.g. No tilapia today: offer the grilled chicken. Party of 20 at 8 on tables 4 to 7.')} aria-label={tr('The note')} />
            <div className="crew-write-row">
              <div className="crew-tones" role="radiogroup" aria-label={tr('Kind')}>
                {TONES.map(([k, icon, label]) => <button key={k} type="button" role="radio" aria-checked={tone === k} className={tone === k ? 'is-on' : ''} onClick={() => setTone(k)}>{icon} {tr(label)}</button>)}
              </div>
              <select className="input" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label={tr('Up for')} style={{ width: 'auto' }}>
                {DAYS.map((d) => <option key={d} value={d}>{d === 1 ? tr('Today') : tr('{n} days', { n: d })}</option>)}
              </select>
              <label className="dk-muted"><input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> {tr('Pin it on top')}</label>
              <button type="submit" className="btn btn-primary" disabled={busy || body.trim().length < 3}>📣 {tr('Post it')}</button>
            </div>
          </form>
        )}
        {error && <div className="error-banner" role="alert">{error}</div>}
        {isManager && all ? (
          <ul className="crew-list">
            {all.notes.map((n, i) => (
              <Note key={n.id} n={n} i={i} isNew={false}>
                <div className="crew-reads">
                  {n.readBy.map((r, k) => <span key={k} title={when(r.at)}>✓ {r.name}</span>)}
                  {n.notYet.map((name, k) => <span key={'n' + k} className="is-not">{name}</span>)}
                </div>
                <div className="crew-write-row" style={{ marginTop: 6 }}>
                  <small className="dk-muted">{tr('{n} of {total} have read it', { n: n.readBy.length, total: n.readBy.length + n.notYet.length })}</small>
                  <button type="button" className="pos-link" disabled={busy} onClick={() => act({ action: 'pin', id: n.id })}>{n.pinned ? tr('Unpin') : tr('Pin')}</button>
                  <button type="button" className="pos-link is-bad" disabled={busy} onClick={() => act({ action: 'remove', id: n.id })}>{tr('Take it down')}</button>
                </div>
              </Note>
            ))}
            {!all.notes.length && <li className="dk-muted">{tr('No notes yet.')}</li>}
          </ul>
        ) : mine ? (
          <ul className="crew-list">
            {mine.notes.map((n, i) => <Note key={n.id} n={n} i={i} isNew={!n.read} />)}
            {!mine.notes.length && <li className="dk-muted">{tr('No notes up now.')}</li>}
          </ul>
        ) : <p className="dk-muted">{tr('Loading…')}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={() => onClose(mine)} disabled={busy}>{unread.length ? tr('Later') : tr('Close')}</button>
          {unread.length > 0 && <button type="button" className="btn btn-primary" onClick={gotIt} disabled={busy}>👍 {tr('Got it')}</button>}
        </div>
      </div>
    </div>
  );
}
