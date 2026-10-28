import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import QRCode from 'qrcode';
import { api } from '../api/client';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import Photo, { useBlobUrl } from '../components/Photo';
import QrScanner from '../components/QrScanner';
import './seventeenth.css';
import './twentysecond.css';

// Staff ID cards (People → Staff ID cards; backend staffCards.service.js,
// migration 0205): a card for each person, printed with their photo and a QR
// code that clocks them in at the kiosk instead of their PIN and lets them
// through the gate. The gate tab is the guard's: scan a card (the camera, a
// scanner, or the number typed) and see who it is and whether it is good.

const RESULT = {
  ok: ['✅', msg('Let them through'), 'is-ok'], revoked: ['⛔', msg('This card has been stopped'), 'is-bad'], expired: ['⌛', msg('This card has run out'), 'is-bad'],
  inactive: ['🚫', msg('They no longer work here'), 'is-bad'], unknown: ['❓', msg('Not one of our cards'), 'is-bad']
};
// What the guard does next when a card is not good.
const HINT = {
  ok: msg('The gate keeps a record of the scan; they still clock in at the kiosk.'),
  revoked: msg('Keep the card if you can, and check who they are another way before letting them in.'),
  expired: msg('Let them in if you know them, and send them to HR for a new card.'),
  inactive: msg('Do not let them in on this card: call the supervisor.'),
  unknown: msg('Not a card we issued, or a damaged one: check who they are another way, or call the supervisor.')
};
const FILTERS = { all: msg('Everyone'), none: msg('No card'), print: msg('Not printed'), photo: msg('No photo') };

function timeText(d) { return d ? new Date(d).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' }) : ''; }
function dayText(d) { return d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—'; }

function Dialog({ title, icon, sub, onClose, onSubmit, children, busy, error, submit, width, danger }) {
  return createPortal(
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog x7-dlg" style={{ width: 'min(' + (width || 520) + 'px, calc(100vw - 24px))' }} role="dialog" aria-modal="true" aria-labelledby="idc-d-t" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">{icon}</span><div><h2 id="idc-d-t">{title}</h2>{sub && <p>{sub}</p>}</div></div>
        {children}
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>{submit && <button type="submit" className={'btn ' + (danger ? 'btn-danger' : 'btn-primary')} disabled={busy}>{submit}</button>}</div>
      </form>
    </div>,
    document.body
  );
}

// One printed card: the front (photo, name, role, the QR) and the back.
function PrintCard({ c, returnTo }) {
  const [qr, setQr] = useState(null);
  const photo = useBlobUrl(c.photo ? '/messages/people/' + c.id + '/photo' : null, c.photo);
  useEffect(() => { QRCode.toDataURL(c.qr, { margin: 1, width: 240, errorCorrectionLevel: 'M' }).then(setQr); }, [c.qr]);
  return (
    <div className="idc-pair">
      <div className="idc-card idc-front">
        <div className="idc-band"><b>{c.company || 'Bamboo Products'}</b><small>{tr('Staff ID card')}</small></div>
        <div className="idc-face">{photo ? <img src={photo} alt="" /> : <span>{c.name.split(' ').map((w) => w[0]).slice(0, 2).join('')}</span>}</div>
        <div className="idc-who"><b>{c.name}</b><small>{c.role || '—'}</small><small>{c.department}</small></div>
        <div className="idc-code">{qr && <img src={qr} alt="" />}<small>{c.card.number}</small></div>
      </div>
      <div className="idc-card idc-back">
        <b>{tr('This card belongs to {company}.', { company: returnTo.name || 'Bamboo Products Limited' })}</b>
        <p>{tr('Show it at the gate and scan it at the clock to come in and go out. It is yours alone: do not lend it.')}</p>
        <p>{returnTo.address || returnTo.phone ? tr('If found, please return it to:') + ' ' + [returnTo.address, returnTo.phone].filter(Boolean).join(' · ') : tr('If found, please hand it in at the gate.')}</p>
        <small>{c.card.number}{c.card.validUntil ? ' · ' + tr('valid until {date}', { date: dayText(c.card.validUntil) }) : ''}</small>
      </div>
    </div>
  );
}
function PrintSheet({ data, onClose }) {
  return createPortal(
    <div className="idc-print">
      <div className="idc-print-bar"><b>🖨️ {tr('{n} cards to print', { n: data.cards.length })}</b><small>{tr('Print on card stock, or on paper to laminate: each card is credit-card size, the front beside its back.')}</small>
        <button type="button" className="btn btn-primary" onClick={() => window.print()}>🖨️ {tr('Print')}</button><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Close')}</button></div>
      <div className="idc-print-cards">{data.cards.map((c) => <PrintCard key={c.card.id} c={c} returnTo={data.returnTo} />)}</div>
    </div>,
    document.body
  );
}

function Gate({ d, onScanned }) {
  const [direction, setDirection] = useState('in');
  const [camera, setCamera] = useState(false);
  const [code, setCode] = useState('');
  const [last, setLast] = useState(null);
  const [error, setError] = useState(null);
  const box = useRef(null);
  const busy = useRef(false);
  const scan = useCallback(async (text) => {
    if (busy.current || !text) return;
    busy.current = true; setError(null);
    try { const r = await api.post('/staff-cards/scan', { code: text.trim(), direction, gate: '' }); setLast(r); onScanned(); } catch (e) { setError(e.message); }
    busy.current = false; setCode('');
    if (box.current) box.current.focus();
  }, [direction, onScanned]);
  const res = last && RESULT[last.result];
  return (
    <div className="idc-gate">
      <section className="x7-card idc-scan">
        <div className="x7-seg idc-dir" role="radiogroup" aria-label={tr('Which way')}>
          <button type="button" role="radio" aria-checked={direction === 'in'} className={direction === 'in' ? 'is-on' : ''} onClick={() => setDirection('in')}>➡️ {tr('Coming in')}</button>
          <button type="button" role="radio" aria-checked={direction === 'out'} className={direction === 'out' ? 'is-on' : ''} onClick={() => setDirection('out')}>⬅️ {tr('Heading out')}</button>
        </div>
        {camera ? <QrScanner onCode={scan} className="idc-camera" /> : <button type="button" className="idc-cam-btn" onClick={() => setCamera(true)}><span aria-hidden="true">📷</span>{tr('Scan with the camera')}</button>}
        <form className="idc-type" onSubmit={(e) => { e.preventDefault(); scan(code); }}>
          <input ref={box} className="input" autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder={tr('Or scan with a scanner here')} aria-label={tr('Card code')} />
          <button type="submit" className="btn btn-primary" disabled={!code.trim()}>{tr('Check card')}</button>
        </form>
        {error && <div className="error-banner" role="alert">{error}</div>}
      </section>
      <section className={'idc-result ' + (res ? res[2] : 'is-idle')} aria-live="polite">
        {!last ? <div className="idc-wait"><span aria-hidden="true">🪪</span><p>{tr('Scan a card to see who it is.')}</p></div> : <>
          <div className="idc-verdict"><span aria-hidden="true">{res[0]}</span><b>{tr(res[1])}</b><small>{last.direction === 'in' ? tr('coming in') : tr('going out')} · {timeText(last.at)}</small></div>
          {last.person && <div className="idc-person">
            <Photo id={last.person.id} name={last.person.name} photo={last.person.photo} size={96} />
            <div><b>{last.person.name}</b><small>{[last.person.role, last.person.department].filter(Boolean).join(' · ')}</small><small>{last.person.company}{last.person.card ? ' · ' + last.person.card.number : ''}</small>
              {last.person.card && last.person.card.reason && last.result === 'revoked' && <em>{last.person.card.reason}</em>}
              {last.last && <em>{tr('Last seen {way} at {time}', { way: last.last.direction === 'in' ? tr('coming in') : tr('going out'), time: new Date(last.last.at).toLocaleString(activeIntlLocale(), { weekday: 'short', hour: '2-digit', minute: '2-digit' }) })}</em>}</div>
          </div>}
          {HINT[last.result] && <p className="idc-hint">{tr(HINT[last.result])}</p>}
        </>}
      </section>
      <section className="x7-card idc-onsite">
        <h2>🏭 {tr('On site now')} <small>{d.onSite.length}</small></h2>
        {!d.onSite.length ? <p className="x7-muted">{tr('Nobody scanned in today yet.')}</p> : <div className="idc-onsite-list">{d.onSite.map((p) => <span key={p.id} className="x7-pill is-good">{p.name} · {timeText(p.since)}</span>)}</div>}
      </section>
      <section className="x7-card">
        <h2>🚧 {tr('At the gate')} <small>{tr('two days')}</small></h2>
        {!d.scans.length ? <p className="x7-muted">{tr('No cards scanned yet.')}</p> : <div className="x7-list">{d.scans.slice(0, 30).map((s) => (
          <div key={s.id} className={'x7-row idc-scan-row ' + RESULT[s.result][2]}>
            {s.person ? <Photo id={s.person.id} name={s.person.name} photo={s.person.photo} size={36} /> : <span className="x7-icon" aria-hidden="true">❓</span>}
            <span className="x7-who"><b>{s.person ? s.person.name : tr('Unknown card')}</b><small>{new Date(s.at).toLocaleString(activeIntlLocale(), { weekday: 'short', hour: '2-digit', minute: '2-digit' })}{s.card ? ' · ' + s.card : ''}{s.by ? ' · ' + s.by : ''}</small></span>
            <span className="x7-pill">{s.direction === 'in' ? '➡️ ' + tr('coming in') : '⬅️ ' + tr('going out')}</span>
            <span className={'x7-pill ' + (s.result === 'ok' ? 'is-good' : 'is-bad')}>{RESULT[s.result][0]}</span>
          </div>
        ))}</div>}
      </section>
    </div>
  );
}

export default function StaffCardsPage() {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState(null);
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [pick, setPick] = useState({});
  const [busy, setBusy] = useState(false);
  const [print, setPrint] = useState(null);
  const [stop, setStop] = useState(null);
  const [flash, setFlash] = useState(null);
  const load = useCallback(() => api.get('/staff-cards').then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const people = useMemo(() => (d ? d.people.filter((p) => (filter === 'none' ? !p.card : filter === 'print' ? p.card && !p.card.printedAt : filter === 'photo' ? !p.photo : true)
    && (!q || (p.name + ' ' + p.role + ' ' + p.department + ' ' + (p.card ? p.card.number : '')).toLowerCase().indexOf(q.toLowerCase()) >= 0)) : []), [d, filter, q]);
  if (!d) return <div className="x7"><p className="x7-wait">{error || tr('Loading…')}</p></div>;
  const view = tab || (d.canIssue ? 'cards' : 'gate');
  const s = d.summary;
  const chosen = d.people.filter((p) => pick[p.id]);
  const withCard = chosen.filter((p) => p.card);
  async function issue() {
    if (chosen.some((p) => p.card) && !window.confirm(tr('{n} of them have a card already: a new one stops the old one. Go on?', { n: chosen.filter((p) => p.card).length }))) return;
    setBusy(true); setError(null);
    try { const r = await api.post('/staff-cards', { employeeIds: chosen.map((p) => p.id) }); setFlash(r.issued === 1 ? tr('1 card issued: print it now.') : tr('{n} cards issued: print them now.', { n: r.issued })); await load(); setPrint(await api.post('/staff-cards/print', { cardIds: r.cardIds })); setPick({}); } catch (e) { setError(e.message); }
    setBusy(false);
  }
  async function printChosen() {
    setBusy(true); setError(null);
    try { setPrint(await api.post('/staff-cards/print', { cardIds: withCard.map((p) => p.card.id) })); await load(); } catch (e) { setError(e.message); }
    setBusy(false);
  }
  return (
    <div className="x7 idc">
      <header className="x7-head">
        <div>
          <h1>🪪 {tr('Staff ID cards')}</h1>
          <p>{tr('A card for everyone, with their photo and a QR code: it clocks them in at the kiosk instead of their PIN, and the guard scans it at the gate. A new card stops the old one.')}</p>
        </div>
        {d.canIssue && d.canGate && <div className="x7-seg"><button type="button" className={view === 'cards' ? 'is-on' : ''} onClick={() => setTab('cards')}>🪪 {tr('Cards')}</button><button type="button" className={view === 'gate' ? 'is-on' : ''} onClick={() => setTab('gate')}>🚧 {tr('The gate')}</button></div>}
      </header>
      <div className="x7-tiles">
        {d.canIssue && <div className="x7-tile is-teal"><small>🪪 {tr('With a card')}</small><b>{s.carded}</b><span>{tr('of {n} staff', { n: s.staff })}</span></div>}
        {d.canIssue && <div className={'x7-tile ' + (s.noCard ? 'is-warn' : 'is-good')}><small>🙋 {tr('No card yet')}</small><b>{s.noCard}</b><span>{s.notPrinted ? tr('{n} issued, not printed', { n: s.notPrinted }) : tr('all printed')}</span></div>}
        {d.canIssue && <div className={'x7-tile ' + (s.noPhoto ? 'is-warn' : 'is-good')}><small>📸 {tr('No photo')}</small><b>{s.noPhoto}</b><span>{tr('add one on their record first')}</span></div>}
        <div className="x7-tile is-calm"><small>🏭 {tr('On site now')}</small><b>{s.onSite}</b><span>{tr('{n} scans today', { n: s.scansToday })}</span></div>
        <div className={'x7-tile ' + (s.turnedAway ? 'is-bad' : 'is-good')}><small>⛔ {tr('Turned away today')}</small><b>{s.turnedAway}</b><span>{(s.revokedYear === 1 ? tr('1 card stopped this year') : tr('{n} cards stopped this year', { n: s.revokedYear }))}</span></div>
      </div>
      {flash && <p className="x7-flash is-good" role="status">✅ {flash}</p>}
      {error && <div className="error-banner" role="alert">{error}</div>}
      {view === 'gate' ? <Gate d={d} onScanned={load} /> : <>
        <div className="x7-bar">
          <div className="x7-chips">{Object.keys(FILTERS).map((k) => <button key={k} type="button" className={filter === k ? 'is-on' : ''} onClick={() => setFilter(k)}>{tr(FILTERS[k])}</button>)}</div>
          <input className="input idc-find" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Find someone')} aria-label={tr('Find someone')} />
        </div>
        {!people.length ? <div className="x7-empty"><span aria-hidden="true">🪪</span><p>{tr('Nobody here.')}</p></div> : <div className="idc-grid">{people.map((p) => (
          <label key={p.id} className={'idc-tile' + (pick[p.id] ? ' is-on' : '') + (p.card ? '' : ' is-none')}>
            <input type="checkbox" checked={!!pick[p.id]} onChange={(e) => setPick({ ...pick, [p.id]: e.target.checked })} aria-label={p.name} />
            <span className="idc-tile-band" />
            <Photo id={p.id} name={p.name} photo={p.photo} size={58} />
            <b>{p.name}</b><small>{p.role || '—'}</small><small className="idc-dept">{p.department}{p.companyCode ? ' · ' + p.companyCode : ''}</small>
            {p.card ? <span className={'x7-pill ' + (p.card.expired ? 'is-bad' : p.card.printedAt ? 'is-good' : 'is-warn')}>{p.card.number}{p.card.printedAt ? '' : ' · ' + tr('not printed')}</span> : <span className="x7-pill">{tr('No card')}</span>}
            {!p.photo && <span className="idc-nophoto" title={tr('No photo')}>📸</span>}
            {p.card && <button type="button" className="idc-stop" onClick={(e) => { e.preventDefault(); setStop(p); }} title={tr('Stop this card')} aria-label={tr('Stop this card')}>⛔</button>}
          </label>
        ))}</div>}
        {chosen.length > 0 && <div className="idc-action-bar" role="region" aria-label={tr('Chosen')}>
          <b>{tr('{n} chosen', { n: chosen.length })}</b>
          <button type="button" className="btn btn-secondary" onClick={() => setPick({})}>{tr('Clear')}</button>
          {withCard.length > 0 && <button type="button" className="btn btn-secondary" disabled={busy} onClick={printChosen}>🖨️ {tr('Print {n}', { n: withCard.length })}</button>}
          <button type="button" className="btn btn-primary" disabled={busy} onClick={issue}>🪪 {chosen.some((p) => p.card) ? tr('New cards for {n}', { n: chosen.length }) : tr('Issue {n} cards', { n: chosen.length })}</button>
        </div>}
      </>}
      {print && <PrintSheet data={print} onClose={() => setPrint(null)} />}
      {stop && <StopDialog p={stop} onClose={() => setStop(null)} onDone={() => { setStop(null); setFlash(tr('{name}\'s card is stopped.', { name: stop.name })); load(); }} />}
    </div>
  );
}

function StopDialog({ p, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function go() { setBusy(true); try { await api.post('/staff-cards/' + p.card.id + '/revoke', { reason }); onDone(); } catch (e) { setError(e.message); setBusy(false); } }
  return (
    <Dialog title={tr('Stop {name}\'s card', { name: p.name })} icon="⛔" sub={tr('{card} stops working at the gate and the kiosk at once.', { card: p.card.number })} onClose={onClose} onSubmit={go} busy={busy} error={error} submit={tr('Stop the card')} danger>
      <label><span>{tr('Why')}</span><input className="input" required autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder={tr('e.g. lost, left the company')} /></label>
    </Dialog>
  );
}
