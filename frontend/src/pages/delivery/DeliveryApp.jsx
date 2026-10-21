import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { restaurantLogoUrl } from '../../lib/restaurantLogos';
import { tr } from '../../lib/i18n.jsx';
import { applyTheme, getInitialTheme, THEME_KEY } from '../../lib/theme';
import { playNewTicket, unlockAudio } from '../../kiosk/kioskSounds';
import DeviceLanguage from '../../components/DeviceLanguage';
import { Icon } from '../../components/DashKit';
import DeliveryMap from './DeliveryMap';
import { ActiveCard, DoneCard, NewOrderCard, TurnedDownCard, WaitingCard } from './DlCards';
import { SendDialog, SettingsDialog } from './DlDialogs';
import RidersPanel from './DlRiders';
import { money } from '../../lib/currency';
import { chipOf, kmText, minText, payName, riderSpot, statusName, trafficMinutes, vehicleEmoji, vehicleName, wayOf } from './dlShared';
import '../till/till.css';
import '../../components/DashKit.css';
import '../RestaurantPosPage.css';
import './delivery.css';

// The delivery screen (delivery.starbartema.com; tools/build-site.mjs),
// signed in with a staff PIN (the delivery permission). What it is for,
// left to right: the website's new orders to accept or turn down, food
// cooking, food ready to go out with a rider, deliveries on their way, and
// today's done — with the riders, and a map of it all where riders glide
// to the door (live from their phone, or estimated: dlShared riderSpot).
// The board is asked for every few seconds (backend restaurantDelivery
// board); a new website order rings.

const SESSION_KEY = 'bamboo.delivery.session';
const POLL_MS = 5000;
const TABS = [
  ['new', 'spark', () => tr('New')], ['cooking', 'clock', () => tr('Kitchen')], ['ready', 'bag', () => tr('Ready')],
  ['road', 'send', () => tr('On the way')], ['done', 'check', () => tr('Done')], ['riders', 'people', () => tr('Riders')]
];

function readSession() { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; } }

export default function DeliveryApp() {
  const [session, setSession] = useState(readSession);
  const [theme, setTheme] = useState(getInitialTheme);
  useEffect(() => { applyTheme(theme); try { localStorage.setItem(THEME_KEY, theme); } catch { /* not kept */ } }, [theme]);
  const signOut = useCallback((reason) => {
    if (session && reason !== 'ended') posFetch('POST', '/pos/logout', session.token, { reason: 'manual' }).catch(() => {});
    try { localStorage.removeItem(SESSION_KEY); } catch { /* nothing kept */ }
    setSession(null);
  }, [session]);
  const themeButton = (
    <button type="button" className="dl-icon-btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={theme === 'dark' ? tr('Light mode') : tr('Dark mode')}>{theme === 'dark' ? '☀' : '☾'}</button>
  );
  if (!session) return <Gate onIn={(s) => { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* not kept */ } setSession(s); }} themeButton={themeButton} />;
  return <Desk session={session} onSignOut={signOut} themeButton={themeButton} />;
}

// ── signing in ──
function Gate({ onIn, themeButton }) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 20000); return () => clearInterval(t); }, []);
  async function go(p) {
    setBusy(true); setError(null);
    try { onIn(await posFetch('POST', '/pos/login', null, { pin: p, app: 'delivery' })); } catch (e) { setError(e.message); setPin(''); } finally { setBusy(false); }
  }
  function tap(d) { if (busy) return; const next = (pin + d).slice(0, 4); setPin(next); if (next.length === 4) go(next); }
  useEffect(() => {
    const onKey = (e) => { if (/^[0-9]$/.test(e.key)) tap(e.key); else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1)); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <div className="dk pos-shell pos-gate dl-gate">
      <span className="pos-orb is-a" aria-hidden="true" /><span className="pos-orb is-b" aria-hidden="true" />
      <div className="pos-gate-top"><DeviceLanguage className="pos-lang" />{themeButton}</div>
      <div className="pos-gate-card">
        <div className="pos-gate-side">
          <p className="dk-eyebrow">{now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
          <div className="dl-gate-art" aria-hidden="true"><span>🛵</span><i /><b>🏠</b></div>
          <h1 className="pos-gate-title">{tr('Deliveries')}</h1>
          <p className="dk-muted">{tr('Website orders to accept, food ready to go out, riders on the way and where they are. Sign in with your PIN.')}</p>
          <div className="pos-gate-logos">{['SBR', 'BGN'].map((c) => restaurantLogoUrl(c) && <img key={c} src={restaurantLogoUrl(c)} alt="" />)}</div>
        </div>
        <div className="pos-gate-pad">
          <div className={'pos-pin' + (error ? ' is-bad' : '')} aria-label={tr('PIN')}>{[0, 1, 2, 3].map((i) => <span key={i} className={i < pin.length ? 'is-on' : ''} />)}</div>
          <p className={'pos-pin-note' + (error ? ' is-bad' : '')} role="status">{busy ? tr('Checking…') : error || tr('Tap your PIN or type it.')}</p>
          <div className="pos-keypad">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => <button key={d} type="button" disabled={busy} onClick={() => tap(d)}>{d}</button>)}
            <button type="button" className="is-muted" disabled={busy} onClick={() => setPin('')}>{tr('Clear')}</button>
            <button type="button" disabled={busy} onClick={() => tap('0')}>0</button>
            <button type="button" className="is-muted" disabled={busy} onClick={() => setPin(pin.slice(0, -1))} aria-label={tr('Delete')}>⌫</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── the screen ──
function Desk({ session, onSignOut, themeButton }) {
  const [board, setBoard] = useState(null);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [error, setError] = useState(null);
  const [offline, setOffline] = useState(false);
  const [tab, setTab] = useState(null);
  const [selected, setSelected] = useState(null);
  const [fitKey, setFitKey] = useState('start');
  const [sending, setSending] = useState(null); // a waiting order to send, or { reassign: delivery }
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const seenPending = useRef(null);
  const token = session.token;

  const load = useCallback(async () => {
    try {
      const b = await posFetch('GET', '/pos/delivery/board', token);
      // A website order not seen before rings, and says so in the tab's title.
      const ids = new Set(b.pending.map((o) => o.id));
      if (seenPending.current && b.pending.some((o) => !seenPending.current.has(o.id))) playNewTicket();
      seenPending.current = ids;
      setBoard(b); setFetchedAt(Date.now()); setError(null); setOffline(false);
      return b;
    } catch (e) {
      if (e.status === 401) onSignOut('ended');
      else if (e.status) setError(e.message); else setOffline(true);
      return null;
    }
  }, [token, onSignOut]);
  useEffect(() => { load(); const t = setInterval(load, POLL_MS); return () => clearInterval(t); }, [load]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { const u = () => unlockAudio(); window.addEventListener('pointerdown', u, { once: true }); return () => window.removeEventListener('pointerdown', u); }, []);
  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(null), 4000); return () => clearTimeout(t); }, [toast]);
  useEffect(() => {
    const n = board ? board.pending.length : 0;
    document.title = (n ? '(' + n + ') ' : '') + tr('Deliveries') + (board ? ' · ' + board.company.name : '');
  }, [board]);
  // The tab to start on: what needs someone first.
  useEffect(() => {
    if (!board || tab) return;
    setTab(board.pending.length ? 'new' : board.ready.length ? 'ready' : board.active.length ? 'road' : board.cooking.length ? 'cooking' : 'new');
  }, [board, tab]);

  async function act(path, body, done) {
    try {
      const r = await posFetch('POST', path, token, body);
      await load();
      if (done) done(r);
      return r;
    } catch (e) {
      if (e.status === 401) onSignOut('ended'); else setToast(e.message);
      return null;
    }
  }
  function pick(key) { setSelected(key); setFitKey(key + ':' + Date.now()); }

  const s = board && board.settings;
  const here = s && s.location ? { lat: s.location.lat, lng: s.location.lng } : null;

  // The map: the restaurant, each order where it goes, each rider where
  // they are and the way they went — each with its card (info) on it.
  const { markers, routes } = useMemo(() => {
    const mk = [], rt = [];
    if (!board) return { markers: mk, routes: rt };
    const where = (c) => c.address ? '📍 ' + c.address + (c.landmark ? ' · ' + c.landmark : '') : '';
    if (here) mk.push({ id: 'here', kind: 'restaurant', lat: here.lat, lng: here.lng, emoji: '🍽️', label: board.company.name, fit: !selected,
      info: [board.company.name, s.location.address ? '📍 ' + s.location.address : '', s.phone ? '📞 ' + s.phone : ''] });
    const place = (key, tone, emoji, c, label, info) => {
      if (!c || c.lat == null) return;
      mk.push({ id: key, kind: 'order', tone, lat: c.lat, lng: c.lng, emoji, label, sub: c.name, info, active: selected === key, fit: !selected || selected === key, onClick: () => pick(key) });
    };
    if (tab === 'new' || (selected && selected.startsWith('p:'))) board.pending.forEach((o) => place('p:' + o.id, 'new', '🛎️', o.customer, o.ref, [
      o.ref + ' · ' + o.customer.name, where(o.customer),
      tr('{n} dishes', { n: o.items.reduce((n, l) => n + Number(l.qty || 0), 0) }) + ' · ' + money(o.total) + ' · ' + payName(o.payMethod),
      (o.distanceKm != null ? kmText(o.distanceKm) + ' · ' : '') + tr('waiting {n} min', { n: o.waitingMinutes })
    ]));
    board.cooking.concat(board.ready).forEach((w) => place('w:' + w.key, w.stage === 'ready' ? 'ready' : 'cooking', w.stage === 'ready' ? '📦' : '🍳', w.customer, w.onlineRef || w.label, [
      (w.onlineRef || w.label) + ' · ' + w.customer.name, where(w.customer),
      w.items.slice(0, 3).join(', ') + (w.items.length > 3 ? '…' : ''),
      money(w.total) + (w.payMethod ? ' · ' + payName(w.payMethod) : '') + ' · ' + (w.stage === 'ready' ? tr('Ready') : tr('Cooking'))
    ]));
    board.active.forEach((d) => {
      const key = 'd:' + d.id;
      const on = !selected || selected === key;
      const spot = riderSpot(d, here, now, fetchedAt);
      const way = spot ? wayOf(d, here, spot, now) : null;
      const chip = way ? way.chip : chipOf(d, spot, now);
      const jam = trafficMinutes(d);
      if (d.customer.lat != null) mk.push({ id: key + ':home', kind: 'home', tone: 'active', lat: d.customer.lat, lng: d.customer.lng, emoji: '🏠', label: d.customer.name, sub: d.ref, active: selected === key, fit: on, onClick: () => pick(key),
        info: [d.ref + ' · ' + d.customer.name, where(d.customer), d.items.slice(0, 3).join(', ') + (d.items.length > 3 ? '…' : ''),
          d.toCollect ? money(d.toCollect) + ' ' + tr('to collect · {method}', { method: payName(d.collectMethod || 'cash') }) : tr('Paid at the till'), chip] });
      if (spot) {
        mk.push({ id: key + ':rider', kind: 'rider', lat: spot.lat, lng: spot.lng, emoji: vehicleEmoji(d.rider.vehicle), live: spot.live, label: d.rider.name,
          sub: (spot.live ? tr('live') : tr('estimated')) + ' · ' + statusName(d.status), fit: on, onClick: () => pick(key),
          info: [d.rider.name + ' · ' + d.ref, vehicleName(d.rider.vehicle) + (d.rider.plate ? ' · ' + d.rider.plate : ''), statusName(d.status) + (chip ? ' · ' + chip : ''),
            spot.live ? tr('Live from their phone') : tr('Estimated from the time on the way'), jam ? '🚦 ' + tr('{m} more than usual, traffic', { m: minText(jam) }) : '', d.rider.phone ? '📞 ' + d.rider.phone : ''] });
        if (way) rt.push({ ...way, id: key, tone: 'go' });
      }
    });
    return { markers: mk, routes: rt };
  }, [board, now, fetchedAt, selected, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!board) {
    return (
      <div className="dk dl-shell dl-loading">
        {error ? <div className="error-banner">{error}</div> : offline ? <div className="error-banner">{tr('Cannot reach the server. Check the internet and reload.')}</div> : <p className="dk-muted">{tr('Loading…')}</p>}
      </div>
    );
  }
  const counts = { new: board.pending.length, cooking: board.cooking.length, ready: board.ready.length, road: board.active.length, done: board.done.length + board.turnedDown.length, riders: board.riders.filter((r) => r.active).length };
  const free = board.riders.filter((r) => r.active && !r.busy).length;
  const logo = restaurantLogoUrl(board.company.code);

  return (
    <div className="dk dl-shell" data-brand={board.company.code}>
      <header className="dl-top">
        <div className="dl-brand">
          {logo ? <img src={logo} alt="" /> : <span className="dl-brand-mark">🛵</span>}
          <div><strong>{board.company.name}</strong><small>{tr('Deliveries')} · {session.employeeName}</small></div>
        </div>
        <button type="button" role="switch" aria-checked={s.open} className={'dl-open' + (s.open ? ' is-on' : '')} onClick={() => act('/pos/delivery/open', { open: !s.open }, (r) => setToast(r.open ? tr('The website takes orders now.') : tr('The website stopped taking orders.')))}>
          <span className="dl-open-dot" aria-hidden="true" />
          <span><strong>{s.open ? tr('Taking orders online') : tr('Online orders paused')}</strong><small>{board.siteUrl.replace(/^https?:\/\//, '')}</small></span>
          <span className={'ts-switch' + (s.open ? ' is-on' : '')} aria-hidden="true"><i /></span>
        </button>
        <div className="dl-stats">
          <Stat tone="new" n={counts.new} label={tr('new online')} onClick={() => setTab('new')} />
          <Stat tone="cooking" n={counts.cooking} label={tr('cooking')} onClick={() => setTab('cooking')} />
          <Stat tone="ready" n={counts.ready} label={tr('ready to go')} onClick={() => setTab('ready')} />
          <Stat tone="road" n={counts.road} label={tr('on the way')} onClick={() => setTab('road')} />
          <Stat tone="done" n={board.totals.delivered} label={board.totals.averageMinutes != null ? tr('delivered · {m} on average', { m: minText(board.totals.averageMinutes) }) : tr('delivered today')} onClick={() => setTab('done')} />
        </div>
        <div className="dl-tools">
          <span className="dl-free" title={tr('Riders free now')}>{free === 1 ? tr('1 rider free') : tr('{n} riders free', { n: free })}</span>
          <button type="button" className="dl-icon-btn" onClick={() => setSettingsOpen(true)} aria-label={tr('Delivery settings')} title={tr('Delivery settings')}><Icon name="key" /></button>
          <DeviceLanguage className="pos-lang" />
          {themeButton}
          <button type="button" className="btn btn-secondary tl-btn" onClick={() => onSignOut('manual')}>{tr('Log out')}</button>
        </div>
      </header>
      {offline && <div className="dl-banner is-bad">{tr('Cannot reach the server. Showing what was there a moment ago.')}</div>}
      {!here && <div className="dl-banner"><Icon name="map" />{tr('Set where the restaurant is (Delivery settings), so the map, the distances and the delivery fees work.')}<button type="button" className="pos-link" onClick={() => setSettingsOpen(true)}>{tr('Set it now')}</button></div>}

      <div className="dl-body">
        <section className="dl-side" aria-label={tr('Orders and deliveries')}>
          <nav className="dl-tabs" role="tablist">
            {TABS.map(([k, icon, label]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={'dl-tab is-' + k + (tab === k ? ' is-on' : '') + (k === 'new' && counts.new ? ' is-ringing' : '')} onClick={() => { setTab(k); setSelected(null); setFitKey('tab:' + k + Date.now()); }}>
                <Icon name={icon} /><span>{label()}</span>{counts[k] > 0 && <b>{counts[k]}</b>}
              </button>
            ))}
          </nav>
          <div className="dl-list">
            {tab === 'new' && (board.pending.length ? board.pending.map((o) => (
              <NewOrderCard key={o.id} o={o} settings={s} selected={selected === 'p:' + o.id} onSelect={() => pick('p:' + o.id)}
                onAccept={(m) => act('/pos/delivery/online/' + o.id + '/accept', { readyMinutes: m }, (r) => { setToast(tr('{ref} accepted: on the till and in the kitchen.', { ref: o.ref }) + (r.tab.kitchenTicket ? ' #' + r.tab.kitchenTicket.number : '')); })}
                onReject={(reason) => act('/pos/delivery/online/' + o.id + '/reject', { reason }, () => setToast(tr('{ref} turned down. The customer sees why.', { ref: o.ref })))} />
            )) : <Empty icon="🛎️" title={tr('No new website orders')} text={s.open ? tr('They ring here the moment a customer orders.') : tr('The website is not taking orders. Turn it on at the top when the kitchen is ready.')} />)}
            {tab === 'cooking' && (board.cooking.length ? board.cooking.map((w) => (
              <WaitingCard key={w.key} w={w} now={now} selected={selected === 'w:' + w.key} onSelect={() => pick('w:' + w.key)} onSend={() => setSending(w)} />
            )) : <Empty icon="🍳" title={tr('Nothing cooking for delivery')} text={tr('Delivery orders from the till and accepted website orders show here while the kitchen works on them.')} />)}
            {tab === 'ready' && (board.ready.length ? board.ready.map((w) => (
              <WaitingCard key={w.key} w={w} now={now} selected={selected === 'w:' + w.key} onSelect={() => pick('w:' + w.key)} onSend={() => setSending(w)} />
            )) : <Empty icon="📦" title={tr('Nothing waiting to go out')} text={tr('When the kitchen marks a delivery ready, it comes here to send with a rider.')} />)}
            {tab === 'road' && (board.active.length ? board.active.map((d) => (
              <ActiveCard key={d.id} d={d} now={now} fetchedAt={fetchedAt} here={here} selected={selected === 'd:' + d.id} onSelect={() => pick('d:' + d.id)}
                onStatus={(status, note) => act('/pos/delivery/' + d.id + '/status', { status, note }, () => setToast(d.ref + ': ' + statusName(status)))}
                onReassign={() => setSending({ reassign: d })} onCopied={() => setToast(tr('Link copied.'))} />
            )) : <Empty icon="🛵" title={tr('No riders out')} text={tr('Deliveries on their way show here, with where the rider is.')} />)}
            {tab === 'done' && (board.done.length || board.turnedDown.length ? <>
              {board.done.map((d) => <DoneCard key={d.id} d={d} selected={selected === 'd:' + d.id} onSelect={() => setSelected('d:' + d.id)} />)}
              {board.turnedDown.map((o) => <TurnedDownCard key={o.id} o={o} />)}
            </> : <Empty icon="✅" title={tr('Nothing done yet today')} text={tr('Delivered, not delivered and turned-down orders of today show here.')} />)}
            {tab === 'riders' && <RidersPanel token={token} riders={board.riders} onChanged={load} onError={setToast} />}
          </div>
        </section>
        <section className="dl-mapbox" aria-label={tr('Map')}>
          <DeliveryMap markers={markers} routes={routes} fitKey={fitKey} center={here ? [here.lat, here.lng] : undefined} />
          <div className="dl-legend" aria-hidden="true">
            <span><i className="is-new" />{tr('New')}</span><span><i className="is-cooking" />{tr('Cooking')}</span><span><i className="is-ready" />{tr('Ready')}</span>
            <span><i className="is-road" />{tr('On the way')}</span><span><b>●</b> {tr('live')} · <b>◌</b> {tr('estimated')}</span>
          </div>
        </section>
      </div>

      {sending && (
        <SendDialog token={token} target={sending.reassign ? null : sending} reassign={sending.reassign || null} riders={board.riders} settings={s}
          onClose={() => setSending(null)} onDone={(d, msgText) => { setSending(null); load(); setTab('road'); pick('d:' + d.id); if (msgText) setToast(msgText); }} />
      )}
      {settingsOpen && <SettingsDialog token={token} canSettings={board.can.settings} onClose={() => setSettingsOpen(false)} onSaved={() => { load(); setFitKey('settings' + Date.now()); }} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function Stat({ tone, n, label, onClick }) {
  return (
    <button type="button" className={'dl-stat is-' + tone + (n ? ' has-some' : '')} onClick={onClick}>
      <b>{n}</b><span>{label}</span>
    </button>
  );
}
function Empty({ icon, title, text }) {
  return <div className="dl-empty"><span aria-hidden="true">{icon}</span><strong>{title}</strong><p>{text}</p></div>;
}
