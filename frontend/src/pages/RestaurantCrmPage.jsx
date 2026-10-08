import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import ContactButtons from '../components/ContactButtons';
import RowMenu from '../components/RowMenu';
import SearchInput from '../components/SearchInput';
import { CompanySwitcher, Glossary, Hero, Insights, RankList, Section, Status, fmtDate, jump } from '../components/DashKit';
import { money } from '../lib/currency';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import Bars from './RestaurantBars';
import './EmployeesPage.css';
import './ToolRoomPage.css';
import './RestaurantsPage.css';
import './RestaurantCrmPage.css';

// A restaurant's guest CRM (backend: restaurantCrm.service.js), starting
// with Bamboo Garden. Pick the restaurant; the key numbers (orders, guests,
// how many came back, the rating); what stands out (complaints nobody has
// called back, regulars who stopped ordering, feedback not asked for,
// guests without a number); and four views:
//   Overview — orders month by month, how they come in (phone, WhatsApp,
//     Bolt, the till) and how they are served, the top guests and dishes,
//     the busy days and what guests say;
//   Orders — the order log customer service keeps (it replaces the BG ORDER
//     RECORD sheet, which can be imported once), each linked to its sale on
//     Square so it is counted once and shows what it cost;
//   Guests — each guest with where they stand (regular, gone quiet, new …),
//     their favourite dish, and the same guest typed twice to put together;
//   Follow-ups — complaints to call back, regulars to invite back.
// A guest's profile shows every order, from the log and from the till.

const VIEWS = ['overview', 'orders', 'guests', 'followups'];
const RANGES = [['30', msg('30 days')], ['90', msg('90 days')], ['365', msg('12 months')], ['all', msg('All time')]];
const CHANNEL = { phone: msg('Phone call'), whatsapp: msg('WhatsApp'), bolt: msg('Bolt'), walk_in: msg('Walk-in'), instagram: msg('Instagram'), facebook: msg('Facebook'), website: msg('Website'), other: msg('Other'), till: msg('At the till') };
const CHANNELS = ['phone', 'whatsapp', 'bolt', 'walk_in', 'instagram', 'facebook', 'website', 'other'];
const SERVICE = { pickup: msg('Pick-up'), dine_in: msg('Dine-in'), delivery: msg('Delivery'), reservation: msg('Reservation'), counter: msg('At the counter') };
const SERVICES = ['pickup', 'dine_in', 'delivery', 'reservation'];
const THEME = { portion: msg('Small portions'), order: msg('Wrong or missing items'), wait: msg('Waited too long'), taste: msg('Taste or temperature'), service: msg('Service'), price: msg('Price'), praise: msg('Praise') };
const SEGMENT = {
  regular: [msg('Regular'), 'good'], quiet: [msg('Gone quiet'), 'warn'], returning: [msg('Came back'), 'info'],
  new: [msg('New'), 'info'], once: [msg('Ordered once'), 'muted'], none: [msg('No orders yet'), 'muted']
};
const GUEST_CHIPS = [['all', msg('Everyone')], ['regular', msg('Regulars')], ['quiet', msg('Gone quiet')], ['returning', msg('Came back')], ['new', msg('New')], ['once', msg('Ordered once')], ['complaints', msg('Complained')], ['nophone', msg('No number')]];
const ORDER_CHIPS = [['all', msg('All orders')], ['feedback', msg('With feedback')], ['open', msg('To call back')], ['notill', msg('Not on the till')]];
const PAGE = 50;

function readPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* this visit only */ } }
function today() { return new Date().toISOString().slice(0, 10); }
function monthLabel(m, long) { return new Date(m + '-01T00:00:00Z').toLocaleDateString(activeIntlLocale(), { month: long ? 'long' : 'short', year: long ? 'numeric' : undefined, timeZone: 'UTC' }); }
function weekdayName(i, long) { return new Date(Date.UTC(2024, 0, 7 + i)).toLocaleDateString(activeIntlLocale(), { weekday: long ? 'long' : 'short', timeZone: 'UTC' }); }
function ordersText(n) { return n === 1 ? tr('1 order') : tr('{n} orders', { n }); }
function stars(r) { return r ? '★'.repeat(r) + '☆'.repeat(5 - r) : ''; }
function isBg(c) { return /bamboo\s*garden/i.test(c.name) || /^BG/i.test(c.code); }

function Stars({ value }) {
  if (!value) return null;
  return <span className="rc-stars" title={tr('{n} out of 5', { n: value })} aria-label={tr('{n} out of 5', { n: value })}>{stars(value)}</span>;
}
function Tag({ children, tone }) { return <span className={'rc-tag' + (tone ? ' is-' + tone : '')}>{children}</span>; }

export default function RestaurantCrmPage() {
  const { can } = useAuth();
  const canManage = can('restaurant.manage');
  const [companies, setCompanies] = useState([]);
  const [companyCode, setCompanyCode] = useState(() => readPref('bos.restaurantCrmCompany', ''));
  const [view, setView] = useState(() => { const v = new URLSearchParams(window.location.search).get('view'); return VIEWS.includes(v) ? v : 'overview'; });
  const [range, setRange] = useState(() => readPref('bos.restaurantCrmRange', '365'));
  const [ov, setOv] = useState(null);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [orders, setOrders] = useState(null);
  const [orderChip, setOrderChip] = useState('all');
  const [orderSearch, setOrderSearch] = useState('');
  const [orderChannel, setOrderChannel] = useState('');
  const [orderService, setOrderService] = useState('');
  const [orderOffset, setOrderOffset] = useState(0);

  const [guests, setGuests] = useState(null);
  const [guestChip, setGuestChip] = useState('all');
  const [guestSearch, setGuestSearch] = useState('');
  const [guestSort, setGuestSort] = useState('recent');
  const [dupes, setDupes] = useState([]);

  const [orderDialog, setOrderDialog] = useState(null);
  const [profileId, setProfileId] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const [followDialog, setFollowDialog] = useState(null);
  const [tillDialog, setTillDialog] = useState(null);

  useEffect(() => {
    api.get('/restaurant/companies').then(setCompanies).catch((err) => setError(err.message));
  }, []);
  const shown = useMemo(() => {
    const running = companies.filter((c) => c.menuItems > 0 || c.orders30 > 0 || isBg(c));
    return (running.length ? running : companies).slice().sort((x, y) => isBg(y) - isBg(x) || y.orders30 - x.orders30 || String(x.name).localeCompare(String(y.name)));
  }, [companies]);
  const current = companies.find((c) => c.code === companyCode) || shown[0] || null;
  const companyId = current ? current.id : null;
  function pickCompany(code) { setCompanyCode(code); writePref('bos.restaurantCrmCompany', code); setOrderOffset(0); }
  function pickView(v) {
    setView(v);
    const url = new URL(window.location.href);
    url.searchParams.set('view', v);
    window.history.replaceState(null, '', url);
    setTimeout(() => jump('rc-views'), 0);
  }
  function pickRange(r) { setRange(r); writePref('bos.restaurantCrmRange', r); }

  const loadOverview = useCallback(async () => {
    if (!companyId) return;
    try { setOv(await api.get('/restaurant-crm/overview?' + new URLSearchParams({ companyId, range }))); setError(null); } catch (err) { setError(err.message); }
  }, [companyId, range]);
  useEffect(() => { setOv(null); loadOverview(); }, [loadOverview]);

  const loadOrders = useCallback(async () => {
    if (!companyId) return;
    const q = { companyId, limit: PAGE, offset: orderOffset };
    if (orderSearch.trim()) q.q = orderSearch.trim();
    if (orderChannel) q.channel = orderChannel;
    if (orderService) q.service = orderService;
    if (orderChip === 'feedback') q.feedback = '1';
    if (orderChip === 'open') q.followUp = 'open';
    if (orderChip === 'notill') q.till = 'none';
    try { setOrders(await api.get('/restaurant-crm/orders?' + new URLSearchParams(q))); } catch (err) { setError(err.message); }
  }, [companyId, orderOffset, orderSearch, orderChannel, orderService, orderChip]);
  useEffect(() => { if (view === 'orders') loadOrders(); }, [view, loadOrders]);

  const loadGuests = useCallback(async () => {
    if (!companyId) return;
    const q = { companyId, segment: guestChip, sort: guestSort, limit: 300 };
    if (guestSearch.trim()) q.q = guestSearch.trim();
    try {
      const [g, d] = await Promise.all([api.get('/restaurant-crm/guests?' + new URLSearchParams(q)), api.get('/restaurant-crm/duplicates?companyId=' + companyId)]);
      setGuests(g); setDupes(d);
    } catch (err) { setError(err.message); }
  }, [companyId, guestChip, guestSort, guestSearch]);
  useEffect(() => { if (view === 'guests') loadGuests(); }, [view, loadGuests]);

  function refresh() { loadOverview(); if (view === 'orders') loadOrders(); if (view === 'guests') loadGuests(); }
  function say(text) { setToast(text); setTimeout(() => setToast(null), 3500); }

  async function merge(pair) {
    const keep = pair.a.orders >= pair.b.orders ? pair.a : pair.b;
    const drop = keep === pair.a ? pair.b : pair.a;
    if (!window.confirm(tr('Put {drop} together with {keep}? Their orders move to {keep}, and {drop} is removed.', { drop: drop.name, keep: keep.name }))) return;
    try { await api.post('/restaurant-crm/guests/merge', { keepId: keep.id, dropId: drop.id }); say(tr('{name} is now one guest.', { name: keep.name })); refresh(); } catch (err) { setError(err.message); }
  }

  if (!current) return error ? <div className="dk tl"><div className="error-banner">{error}</div></div> : <div className="dk tl"><p className="eyebrow">{tr('Loading…')}</p></div>;
  const t = ov ? ov.totals : null;
  const rangeName = tr((RANGES.find((r) => r[0] === range) || RANGES[2])[1]);

  // ── the key numbers ──
  const stats = t ? [
    { icon: 'receipt', value: String(t.orders), label: tr('orders'), note: rangeName + (t.logged ? ' · ' + tr('{n} by phone, WhatsApp or Bolt', { n: t.logged }) : ''), onClick: () => pickView('orders') },
    { icon: 'people', value: String(t.guests), label: tr('guests'), note: tr('{n} new', { n: t.newGuests }) + ' · ' + tr('{n} ordered again', { n: t.repeatGuests }), onClick: () => pickView('guests') },
    { icon: 'up', value: t.guests ? Math.round(t.repeatGuests / t.guests * 100) + '%' : '—', label: tr('came back'), note: tr('guests with two orders or more'), tone: t.guests && t.repeatGuests / t.guests < 0.25 ? 'alert' : '' },
    { icon: 'spark', value: t.avgRating ? t.avgRating.toLocaleString(activeIntlLocale()) + ' / 5' : '—', label: tr('average rating'), note: t.feedbackRate === null ? tr('no feedback yet') : tr('feedback on {pct}% of orders', { pct: t.feedbackRate }), tone: t.openFollowUps ? 'bad' : '', onClick: () => pickView('followups') }
  ] : [];

  // ── what stands out ──
  const insights = [];
  if (t) {
    if (t.openFollowUps) insights.push({ tone: 'bad', icon: 'warn', text: t.openFollowUps === 1 ? tr('1 guest complained and has not been called back yet.') : tr('{n} guests complained and have not been called back yet.', { n: t.openFollowUps }), action: { label: tr('Show them'), run: () => pickView('followups') } });
    if (ov.quietCount) insights.push({ tone: 'warn', icon: 'clock', text: ov.quietCount === 1 ? tr('{name} used to order regularly and has not ordered for {days} days.', { name: ov.quiet[0].name, days: ov.quiet[0].daysSince }) : tr('{n} regulars have stopped ordering — {name} last ordered {days} days ago.', { n: ov.quietCount, name: ov.quiet[0].name, days: ov.quiet[0].daysSince }), action: { label: tr('Invite them back'), run: () => pickView('followups') } });
    const worst = ov.themes.find((x) => x.key !== 'praise');
    if (worst && worst.count >= 2) insights.push({ tone: 'warn', icon: 'warn', text: tr('{n} complaints about {theme}, for example: “{example}”', { n: worst.count, theme: tr(THEME[worst.key]).toLowerCase(), example: worst.example }), action: { label: tr('Show them'), run: () => { setOrderChip('feedback'); pickView('orders'); } } });
    if (t.logged >= 5 && t.feedbackRate !== null && t.feedbackRate < 50) insights.push({ tone: 'info', icon: 'info', text: tr('Feedback was taken on only {pct}% of the phone, WhatsApp and Bolt orders. Ask each guest the next day how the food was.', { pct: t.feedbackRate }), action: null });
    if (t.noPhone && t.guests) insights.push({ tone: 'info', icon: 'phone', text: tr('{n} of the {total} guests have no phone number, so nobody can call them back or invite them again.', { n: t.noPhone, total: t.guests }), action: { label: tr('Show them'), run: () => { setGuestChip('nophone'); pickView('guests'); } } });
    if (t.logged && t.linkedToTill < t.logged) insights.push({ tone: 'info', icon: 'receipt', text: tr('{n} of the {total} logged orders are not linked to their sale on the till yet, so what they cost is not known. Import from Square brings the sales; an order can also be linked by hand.', { n: t.logged - t.linkedToTill, total: t.logged }), action: { label: tr('Show them'), run: () => { setOrderChip('notill'); pickView('orders'); } } });
    const top = ov.channels[0];
    if (top && t.orders >= 5) insights.push({ tone: 'good', icon: 'spark', text: tr('Most orders come by {channel}: {pct}%.', { channel: tr(CHANNEL[top.key] || top.key), pct: Math.round(top.orders / t.orders * 100) }), action: null });
  }

  const views = [
    ['overview', tr('Overview'), null],
    ['orders', tr('Orders'), t ? t.logged : null],
    ['guests', tr('Guests'), t ? t.allGuests : null],
    ['followups', tr('Follow-ups'), t ? (t.openFollowUps + (ov.quietCount || 0)) || null : null]
  ];

  return (
    <div className="dk tl rs rc">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <CompanySwitcher companies={shown} company={current.code} onPick={pickCompany}
        describe={(co) => (co.orders30 ? tr('{n} sales in 30 days', { n: co.orders30 }) : tr('no sales yet'))} />

      <Hero
        eyebrow={tr('Guest CRM')}
        title={current.name}
        sub={tr('Who orders, how often, how they order and what they think of the food. Orders come from the till (Square) and from the order log customer service keeps for phone, WhatsApp and Bolt orders. Press a number to go to it.')}
        actions={canManage && (
          <>
            <button type="button" className="btn btn-primary" onClick={() => setOrderDialog({})}>{tr('Log an order')}</button>
            <button type="button" className="btn btn-secondary" onClick={() => setImportOpen(true)}>{tr('Import the order sheet')}</button>
          </>
        )}
        stats={stats} />

      <Insights items={insights.slice(0, 6)} />

      <div id="rc-views" className="rs-views" role="tablist" aria-label={tr('Show')}>
        {views.map(([k, label, n]) => (
          <button key={k} type="button" role="tab" aria-selected={view === k} className={'rs-view' + (view === k ? ' is-on' : '')} onClick={() => pickView(k)}>
            {label}{n ? <span className="ppl-chip-n">{n}</span> : null}
          </button>
        ))}
      </div>

      {!ov && <p className="eyebrow">{tr('Loading…')}</p>}
      {ov && view === 'overview' && <Overview ov={ov} range={range} onRange={pickRange} onGuest={setProfileId} onLog={canManage ? () => setOrderDialog({}) : null} onImport={canManage ? () => setImportOpen(true) : null} />}

      {ov && view === 'orders' && (
        <Section id="rc-orders" title={tr('Order log')} sub={tr('Orders customer service takes by phone, WhatsApp or Bolt, newest first, with what the guest said. Each is linked to its sale on the till when the OS finds it.')}
          action={canManage && <button type="button" className="btn btn-secondary tl-btn" onClick={() => setOrderDialog({})}>{tr('Log an order')}</button>}>
          <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
            {ORDER_CHIPS.map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={orderChip === k} className={'ppl-chip' + (orderChip === k ? ' is-on' : '')} onClick={() => { setOrderChip(k); setOrderOffset(0); }}>
                {tr(label)}{k === 'open' && t.openFollowUps ? <span className="ppl-chip-n">{t.openFollowUps}</span> : null}
              </button>
            ))}
          </div>
          <div className="rc-filters">
            <div className="tl-search"><SearchInput value={orderSearch} onChange={(v) => { setOrderSearch(v); setOrderOffset(0); }} placeholder={tr('Search guest, dish or feedback…')} /></div>
            <select className="input" value={orderChannel} onChange={(e) => { setOrderChannel(e.target.value); setOrderOffset(0); }} aria-label={tr('How it came in')}>
              <option value="">{tr('Every channel')}</option>
              {CHANNELS.map((c) => <option key={c} value={c}>{tr(CHANNEL[c])}</option>)}
            </select>
            <select className="input" value={orderService} onChange={(e) => { setOrderService(e.target.value); setOrderOffset(0); }} aria-label={tr('How it was served')}>
              <option value="">{tr('Pick-up, dine-in and delivery')}</option>
              {SERVICES.map((s) => <option key={s} value={s}>{tr(SERVICE[s])}</option>)}
            </select>
          </div>
          {!orders ? <p className="eyebrow">{tr('Loading…')}</p> : !orders.orders.length ? (
            <div className="dk-empty tl-empty"><p>{orders.total === 0 && orderChip === 'all' && !orderSearch && !orderChannel && !orderService
              ? tr('No orders logged yet. Log the next phone, WhatsApp or Bolt order, or import the order sheet kept so far.')
              : tr('Nothing matches. Try another search or filter.')}</p></div>
          ) : (
            <>
              <ul className="rc-orders">
                {orders.orders.map((o) => (
                  <OrderRow key={o.id} o={o} canManage={canManage} onGuest={setProfileId}
                    onEdit={() => setOrderDialog(o)}
                    onTill={() => setTillDialog({ order: o })}
                    onFollow={() => setFollowDialog({ order: o, note: o.followUpNote || '' })}
                    onReopen={async () => { try { await api.post('/restaurant-crm/orders/' + o.id + '/follow-up', { status: 'open' }); say(tr('Back on the list to call.')); refresh(); } catch (err) { setError(err.message); } }}
                    onDelete={async () => { if (!window.confirm(tr('Remove this order from the log? The sale on the till is not touched.'))) return; try { await api.del('/restaurant-crm/orders/' + o.id); say(tr('Order removed from the log.')); refresh(); } catch (err) { setError(err.message); } }} />
                ))}
              </ul>
              {orders.total > PAGE && (
                <div className="rc-pager">
                  <button type="button" className="btn btn-secondary tl-btn" disabled={orderOffset === 0} onClick={() => setOrderOffset(Math.max(0, orderOffset - PAGE))}>{tr('Newer')}</button>
                  <span className="dk-muted tl-small">{tr('{from}–{to} of {total}', { from: orderOffset + 1, to: Math.min(orders.total, orderOffset + PAGE), total: orders.total })}</span>
                  <button type="button" className="btn btn-secondary tl-btn" disabled={orderOffset + PAGE >= orders.total} onClick={() => setOrderOffset(orderOffset + PAGE)}>{tr('Older')}</button>
                </div>
              )}
            </>
          )}
        </Section>
      )}

      {ov && view === 'guests' && (
        <>
          {dupes.length > 0 && (
            <Section id="rc-dupes" title={tr('The same guest twice?')} sub={tr('The same number, or the same name where one has no number. Putting them together keeps every order on one profile.')} card>
              <ul className="rc-dupes">
                {dupes.slice(0, 8).map((d) => (
                  <li key={d.a.id + d.b.id}>
                    <span><strong>{d.a.name}</strong> <span className="dk-muted tl-small">{[d.a.phone, ordersText(d.a.orders)].filter(Boolean).join(' · ')}</span></span>
                    <span className="dk-muted">+</span>
                    <span><strong>{d.b.name}</strong> <span className="dk-muted tl-small">{[d.b.phone, ordersText(d.b.orders)].filter(Boolean).join(' · ')}</span></span>
                    <Tag>{d.reason === 'phone' ? tr('same number') : tr('same name')}</Tag>
                    {canManage && <button type="button" className="btn btn-secondary tl-btn" onClick={() => merge(d)}>{tr('Put together')}</button>}
                  </li>
                ))}
              </ul>
            </Section>
          )}
          <Section id="rc-guests" title={tr('Guests')} sub={tr('Everyone who has ordered, from the till or the order log. Press a guest for every order and what they said.')}>
            <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
              {GUEST_CHIPS.map(([k, label]) => {
                const n = guests ? (k === 'all' ? guests.counts.all : guests.counts[k]) : null;
                if (k !== 'all' && guests && !n) return null;
                return (
                  <button key={k} type="button" role="radio" aria-checked={guestChip === k} className={'ppl-chip' + (guestChip === k ? ' is-on' : '')} onClick={() => setGuestChip(k)}>
                    {tr(label)}{n !== null ? <span className="ppl-chip-n">{n}</span> : null}
                  </button>
                );
              })}
            </div>
            <div className="rc-filters">
              <div className="tl-search"><SearchInput value={guestSearch} onChange={setGuestSearch} placeholder={tr('Search name or number…')} /></div>
              <select className="input" value={guestSort} onChange={(e) => setGuestSort(e.target.value)} aria-label={tr('Order by')}>
                <option value="recent">{tr('Last order first')}</option>
                <option value="orders">{tr('Most orders first')}</option>
                <option value="name">{tr('By name')}</option>
              </select>
            </div>
            {!guests ? <p className="eyebrow">{tr('Loading…')}</p> : !guests.guests.length ? (
              <div className="dk-empty tl-empty"><p>{guests.counts.all ? tr('Nothing matches. Try another search or filter.') : tr('No guests yet. They appear as orders are logged, imported, or rung up on Square with a customer.')}</p></div>
            ) : (
              <div className="tl-grid rc-guests">
                {guests.guests.map((g) => (
                  <article key={g.id} className="tl-card rc-guest" role="button" tabIndex={0} onClick={() => setProfileId(g.id)} onKeyDown={(e) => { if (e.key === 'Enter') setProfileId(g.id); }}>
                    <div className="rc-guest-head">
                      <span className="tl-card-head">
                        <span className="tl-name">{g.name}</span>
                        <span className="dk-muted tl-small">{g.phone || tr('No number')}</span>
                      </span>
                      <ContactButtons name={g.name} phone={g.phone} />
                    </div>
                    <div className="tl-tags">
                      <Status tone={SEGMENT[g.segment][1]}>{tr(SEGMENT[g.segment][0])}</Status>
                      {g.openFollowUps > 0 && <Status tone="bad">{tr('To call back')}</Status>}
                      {g.possibleDuplicate && <Status tone="warn">{tr('Twice?')}</Status>}
                      {g.fromSquare && <Tag>Square</Tag>}
                    </div>
                    <p className="tl-small rc-guest-line">
                      {g.orders ? ordersText(g.orders) + ' · ' + tr('last {date}', { date: fmtDate(g.lastOn) }) : tr('No orders yet')}
                      {g.avgGap && g.orders >= 3 ? ' · ' + tr('about every {n} days', { n: g.avgGap }) : ''}
                    </p>
                    {(g.favourite || g.avgRating) && <p className="dk-muted tl-small rc-guest-line">{g.favourite ? tr('Usually: {dish}', { dish: g.favourite }) : ''} {g.avgRating ? <Stars value={Math.round(g.avgRating)} /> : null}</p>}
                  </article>
                ))}
              </div>
            )}
          </Section>
        </>
      )}

      {ov && view === 'followups' && (
        <div className="dk-two">
          <Section id="rc-calls" title={tr('Complaints to call back')} sub={tr('A rating of 3 or less, or a complaint in what the guest said. Call, apologise, and write what was done.')} card>
            {ov.openFollowUps.length ? (
              <ul className="rc-follow">
                {ov.openFollowUps.map((f) => (
                  <li key={f.id}>
                    <div className="rc-follow-head">
                      <button type="button" className="rc-name" onClick={() => f.guest && setProfileId(f.guest.id)}>{f.guest ? f.guest.name : tr('A guest')}</button>
                      {f.guest && <ContactButtons name={f.guest.name} phone={f.guest.phone} />}
                    </div>
                    <p className="dk-muted tl-small">{fmtDate(f.day)} · {f.items || '—'}</p>
                    <p className="rc-quote">{f.feedback ? '“' + f.feedback + '”' : null} <Stars value={f.rating} /></p>
                    {f.themes.length > 0 && <div className="tl-tags">{f.themes.map((th) => <Tag key={th} tone="bad">{tr(THEME[th])}</Tag>)}</div>}
                    {f.guest && !f.guest.phone && <p className="dk-muted tl-small">{tr('No number saved — reach them through the channel they ordered on, and add their number to their profile.')}</p>}
                    {canManage && <button type="button" className="btn btn-primary tl-btn" onClick={() => setFollowDialog({ order: { id: f.id, guest: f.guest, feedback: f.feedback, orderedOn: f.day }, note: '' })}>{tr('Called back')}</button>}
                  </li>
                ))}
              </ul>
            ) : <div className="dk-empty"><p>{tr('Nobody is waiting for a call back.')}</p></div>}
          </Section>
          <Section id="rc-quiet" title={tr('Regulars to invite back')} sub={tr('Guests with three orders or more who have not ordered for twice as long as usual (at least 30 days). A message with what they like often brings them back.')} card>
            {ov.quiet.length ? (
              <ul className="rc-follow">
                {ov.quiet.map((q) => (
                  <li key={q.id}>
                    <div className="rc-follow-head">
                      <button type="button" className="rc-name" onClick={() => setProfileId(q.id)}>{q.name}</button>
                      <ContactButtons name={q.name} phone={q.phone} />
                    </div>
                    <p className="tl-small">{ordersText(q.orders)}{q.avgGap ? ' · ' + tr('usually every {n} days', { n: q.avgGap }) : ''}</p>
                    <p className="dk-muted tl-small">{tr('Last ordered {date}, {n} days ago.', { date: fmtDate(q.lastOn), n: q.daysSince })}</p>
                    {!q.phone && <p className="dk-muted tl-small">{tr('No number saved — add it on their profile next time they order.')}</p>}
                  </li>
                ))}
              </ul>
            ) : <div className="dk-empty"><p>{tr('No regular has gone quiet.')}</p></div>}
          </Section>
        </div>
      )}

      <Glossary items={[
        [tr('Order log'), tr('The orders customer service takes by phone, WhatsApp or Bolt, kept here instead of the order sheet. They are rung up on Square too; the OS links each to its sale so it is counted once.')],
        [tr('Linked to the till'), tr('The sale on Square that is this order: same day, same dishes, and Bolt, pick-up or delivery and the name agreeing where Square has them. When two sales fit as well, choose it by hand.')],
        [tr('Regular'), tr('Three orders or more.')],
        [tr('Gone quiet'), tr('A regular who has not ordered for twice as long as they usually wait between orders, and at least 30 days.')],
        [tr('Came back'), tr('Two orders so far.')],
        [tr('New'), tr('A first order in the last 30 days.')],
        [tr('Complaint'), tr('A rating of 3 out of 5 or less, or feedback about small portions, a wrong or missing item, a long wait, or the taste, service or price said with a "not", "too" or "but".')],
        [tr('Feedback rate'), tr('Of the orders in the log, how many have a rating or something the guest said.')]
      ]} />

      {orderDialog && <OrderDialog order={orderDialog.id ? orderDialog : null} preset={orderDialog.id ? null : orderDialog} companyId={companyId}
        onClose={() => setOrderDialog(null)} onSaved={(o) => { setOrderDialog(null); say(o.till ? tr('Order saved and linked to the sale {no} ({amount}).', { no: o.till.orderNo, amount: money(o.till.total) }) : tr('Order saved.')); refresh(); }} />}
      {profileId && <GuestProfile id={profileId} canManage={canManage} onClose={() => setProfileId(null)} onOpen={setProfileId}
        onLog={(g) => { setProfileId(null); setOrderDialog({ guest: g }); }} onChanged={refresh} onToast={say} />}
      {importOpen && <ImportDialog companyId={companyId} companyName={current.name} onClose={() => setImportOpen(false)} onDone={(r) => { setImportOpen(false); say(tr('{n} orders imported, {g} new guests, {l} linked to the till.', { n: r.added, g: r.newGuests, l: r.linkedToTill })); refresh(); }} />}
      {followDialog && <FollowDialog state={followDialog} onClose={() => setFollowDialog(null)} onSaved={() => { setFollowDialog(null); say(tr('Follow-up recorded.')); refresh(); }} />}
      {tillDialog && <TillDialog order={tillDialog.order} onClose={() => setTillDialog(null)} onSaved={(o) => { setTillDialog(null); say(o.till ? tr('Linked to the sale {no}.', { no: o.till.orderNo }) : tr('Marked as not on the till.')); refresh(); }} />}

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

// ── overview ───────────────────────────────────────────────────────────
function Overview({ ov, range, onRange, onGuest, onLog, onImport }) {
  const t = ov.totals;
  if (!t.orders && !ov.firstOrderOn) {
    return (
      <Section title={tr('Nothing here yet')} card>
        <p>{tr('Guests appear here from three places: the order sheet customer service has kept (import it once), new phone, WhatsApp and Bolt orders logged here, and sales rung up on Square with a customer.')}</p>
        <div className="rc-start">
          {onImport && <button type="button" className="btn btn-primary" onClick={onImport}>{tr('Import the order sheet')}</button>}
          {onLog && <button type="button" className="btn btn-secondary" onClick={onLog}>{tr('Log an order')}</button>}
        </div>
      </Section>
    );
  }
  const monthRows = ov.months.map((m, i) => ({
    key: m.month, value: m.orders, current: i === ov.months.length - 1, label: monthLabel(m.month),
    tip: monthLabel(m.month, true) + ': ' + ordersText(m.orders) + ' · ' + tr('{n} guests, {k} new', { n: m.guests, k: m.newGuests }) + (m.amount ? ' · ' + money(m.amount) : '')
  }));
  const dayRows = [1, 2, 3, 4, 5, 6, 0].map((d) => ({ key: String(d), value: ov.weekdays[d], label: weekdayName(d), tip: weekdayName(d, true) + ': ' + ordersText(ov.weekdays[d]) }));
  const busiest = dayRows.slice().sort((a, b) => b.value - a.value)[0];
  const chanRows = ov.channels.map((c) => ({ key: c.key, name: tr(CHANNEL[c.key] || c.key), value: c.orders, amount: Math.round(c.orders / t.orders * 100) + '%', meta: ordersText(c.orders) }));
  const servRows = ov.services.map((c) => ({ key: c.key, name: tr(SERVICE[c.key] || c.key), value: c.orders, amount: Math.round(c.orders / t.orders * 100) + '%', meta: ordersText(c.orders) }));
  const dishRows = ov.dishes.map((d) => ({ key: d.key, name: d.name, value: d.orders, amount: ordersText(d.orders) }));
  const complaints = ov.themes.filter((x) => x.key !== 'praise');
  const praise = ov.themes.find((x) => x.key === 'praise');
  return (
    <>
      <div className="ppl-chips rc-range" role="radiogroup" aria-label={tr('Period')}>
        {RANGES.map(([k, label]) => (
          <button key={k} type="button" role="radio" aria-checked={range === k} className={'ppl-chip' + (range === k ? ' is-on' : '')} onClick={() => onRange(k)}>{tr(label)}</button>
        ))}
        <span className="dk-muted tl-small">{tr('{from} to {to}', { from: fmtDate(ov.from), to: fmtDate(ov.to) })}</span>
      </div>
      <Section title={tr('Orders, month by month')} sub={tr('Point at a month for its guests and how many were new.')} card>
        {t.orders ? <Bars rows={monthRows} format={(v) => String(v)} label={tr('Orders, month by month')} className="rc-months" /> : <p className="dk-muted tl-small">{tr('No orders in this period.')}</p>}
        <div className="rc-kpis">
          <div><strong>{t.orders}</strong><span>{tr('orders')}</span></div>
          <div><strong>{t.guests}</strong><span>{tr('guests')}</span></div>
          <div><strong>{t.repeatGuests}</strong><span>{tr('ordered again')}</span></div>
          <div><strong>{t.feedbackRate === null ? '—' : t.feedbackRate + '%'}</strong><span>{tr('with feedback')}</span></div>
          <div><strong>{t.amountOrders ? money(t.amount) : '—'}</strong><span>{t.amountOrders ? tr('from {n} orders with a known amount', { n: t.amountOrders }) : tr('amounts come from the till')}</span></div>
        </div>
      </Section>
      <div className="dk-two">
        <Section title={tr('How orders come in')} sub={rangeSub(ov)} card>{chanRows.length ? <RankList rows={chanRows} /> : <p className="dk-muted tl-small">—</p>}</Section>
        <Section title={tr('How they are served')} sub={rangeSub(ov)} card>{servRows.length ? <RankList rows={servRows} /> : <p className="dk-muted tl-small">—</p>}</Section>
        <Section title={tr('Top guests')} sub={tr('Most orders in the period. Press one for their profile.')} card>
          {ov.topGuests.length ? (
            <ol className="dk-rank">
              {ov.topGuests.map((g, i) => (
                <li key={g.id}>
                  <span className={'dk-rank-n' + (i === 0 ? ' is-first' : '')}>{i + 1}</span>
                  <div className="dk-rank-main">
                    <div className="dk-rank-row">
                      <button type="button" className="rc-name dk-rank-name" onClick={() => onGuest(g.id)}>{g.name}</button>
                      <span className="dk-rank-amount">{ordersText(g.inRange)}</span>
                    </div>
                    <div className="dk-track" aria-hidden="true"><span style={{ width: Math.round(g.inRange / ov.topGuests[0].inRange * 100) + '%' }} /></div>
                    <div className="dk-muted dk-rank-meta">{tr(SEGMENT[g.segment][0])} · {tr('last {date}', { date: fmtDate(g.lastOn) })}</div>
                  </div>
                </li>
              ))}
            </ol>
          ) : <p className="dk-muted tl-small">{tr('No named guests in this period.')}</p>}
        </Section>
        <Section title={tr('Most ordered')} sub={tr('Dishes by how many orders had them. Menu codes such as A90 are read as the dish.')} card>
          {dishRows.length ? <RankList rows={dishRows} /> : <p className="dk-muted tl-small">—</p>}
        </Section>
        <Section title={tr('Busiest days')} sub={busiest && busiest.value ? tr('Orders by day of the week; most on {day}.', { day: weekdayName(Number(busiest.key), true) }) : tr('Orders by day of the week.')} card>
          <Bars rows={dayRows} format={(v) => String(v)} label={tr('Busiest days')} />
        </Section>
        <Section title={tr('What guests say')} sub={t.feedback ? tr('From {n} orders with feedback or a rating.', { n: t.feedback }) : tr('No feedback in this period yet.')} card>
          {complaints.length || praise ? (
            <ul className="rc-themes">
              {complaints.map((x) => (
                <li key={x.key}><Tag tone="bad">{tr(THEME[x.key])}</Tag><strong>{x.count}</strong>{x.example && <span className="dk-muted tl-small">“{x.example}”</span>}</li>
              ))}
              {praise && <li><Tag tone="good">{tr(THEME.praise)}</Tag><strong>{praise.count}</strong>{praise.example && <span className="dk-muted tl-small">“{praise.example}”</span>}</li>}
            </ul>
          ) : <p className="dk-muted tl-small">{tr('Ask guests how the food was; what they say shows here, grouped.')}</p>}
        </Section>
      </div>
    </>
  );
}
function rangeSub(ov) { return tr('{from} to {to}.', { from: fmtDate(ov.from), to: fmtDate(ov.to) }); }

// ── one order in the log ───────────────────────────────────────────────
function OrderRow({ o, canManage, onGuest, onEdit, onTill, onFollow, onReopen, onDelete }) {
  const d = new Date(o.orderedOn + 'T00:00:00Z');
  return (
    <li className={'rc-order' + (o.followUp === 'open' ? ' is-open' : '')}>
      <span className="rc-date" aria-hidden="true">
        <strong>{d.getUTCDate()}</strong>
        <span>{d.toLocaleDateString(activeIntlLocale(), { month: 'short', timeZone: 'UTC' })}</span>
      </span>
      <div className="rc-order-main">
        <div className="rc-order-head">
          {o.guest ? <button type="button" className="rc-name" onClick={() => onGuest(o.guest.id)}>{o.guest.name}</button> : <strong>{tr('A guest')}</strong>}
          {o.guest && <ContactButtons name={o.guest.name} phone={o.guest.phone} />}
          <span className="dk-muted tl-small rc-when">{fmtDate(o.orderedOn)}</span>
        </div>
        <p className="rc-items">{o.items || (o.service === 'reservation' ? tr('Table booked') : '—')}{o.itemsRead ? <span className="dk-muted rc-read"> = {o.itemsRead}</span> : null}</p>
        <div className="tl-tags">
          <Tag>{tr(CHANNEL[o.channel] || o.channel)}</Tag>
          <Tag>{tr(SERVICE[o.service] || o.service)}</Tag>
          {o.partySize ? <Tag>{tr('{n} guests', { n: o.partySize })}</Tag> : null}
          {o.tableNote ? <Tag>{o.tableNote}</Tag> : null}
          {o.themes.map((th) => <Tag key={th} tone="bad">{tr(THEME[th])}</Tag>)}
        </div>
        {(o.feedback || o.rating) && <p className="rc-quote">{o.feedback ? '“' + o.feedback + '”' : null} <Stars value={o.rating} /></p>}
        {o.followUp === 'open' && <p className="rc-flag is-bad">{tr('To call back')}</p>}
        {o.followUp === 'done' && <p className="rc-flag is-good">{tr('Called back')}{o.followedUpByName ? ' · ' + o.followedUpByName : ''}{o.followedUpAt ? ' · ' + fmtDate(o.followedUpAt) : ''}{o.followUpNote ? ': ' + o.followUpNote : ''}</p>}
        <p className="dk-muted tl-small rc-till">
          {o.till ? tr('On the till: {no}, {amount}', { no: o.till.orderNo, amount: money(o.till.total) }) + (o.till.link === 'staff' ? ' · ' + tr('linked by hand') : '')
            : o.tillLink === 'none' ? tr('Not on the till')
              : tr('Not linked to a sale on the till yet')}
          {!o.till && o.amount !== null ? ' · ' + money(o.amount) : ''}
        </p>
      </div>
      {canManage && <RowMenu actions={[
        { label: tr('Edit'), onClick: onEdit },
        { label: o.till ? tr('Change the sale on the till') : tr('Find the sale on the till'), onClick: onTill },
        o.followUp === 'open' ? { label: tr('Called back'), onClick: onFollow } : { label: tr('Call back'), onClick: onReopen, hidden: o.followUp === 'none' && !o.feedback && !o.rating },
        o.followUp === 'done' ? { label: tr('Edit what was done'), onClick: onFollow } : null,
        { label: tr('Remove from the log'), onClick: onDelete, danger: true }
      ]} />}
    </li>
  );
}

// ── logging or changing an order ───────────────────────────────────────
function OrderDialog({ order, preset, companyId, onClose, onSaved }) {
  const g0 = order ? order.guest : preset && preset.guest;
  const [form, setForm] = useState(() => ({
    guestId: g0 ? g0.id : '', name: g0 ? g0.name : '', phone: g0 ? g0.phone || '' : '',
    orderedOn: order ? order.orderedOn : today(), channel: order ? order.channel : 'phone', service: order ? order.service : 'pickup',
    items: order ? order.items : '', amount: order && order.amount !== null && !order.amountFromTill ? String(order.amount) : '',
    partySize: order && order.partySize ? String(order.partySize) : '', tableNote: order ? order.tableNote : '',
    feedback: order ? order.feedback : '', rating: order ? order.rating : null
  }));
  const [suggest, setSuggest] = useState([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const timer = useRef(null);
  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }
  function typeName(v) {
    setForm((f) => ({ ...f, name: v, guestId: '' }));
    clearTimeout(timer.current);
    if (v.trim().length < 2) { setSuggest([]); return; }
    timer.current = setTimeout(async () => {
      try { setSuggest((await api.get('/restaurant-crm/guests?' + new URLSearchParams({ companyId, q: v.trim(), limit: 6, sort: 'orders' }))).guests); } catch { setSuggest([]); }
    }, 250);
  }
  async function save(e) {
    e.preventDefault();
    setSaving(true); setErr(null);
    const body = {
      companyId, orderedOn: form.orderedOn, channel: form.channel, service: form.service, items: form.items,
      amount: form.amount === '' ? null : Number(form.amount), partySize: form.partySize === '' ? null : Number(form.partySize),
      tableNote: form.tableNote, feedback: form.feedback, rating: form.rating
    };
    if (form.guestId) body.guestId = form.guestId; else body.guest = { name: form.name, phone: form.phone };
    try { onSaved(order ? await api.put('/restaurant-crm/orders/' + order.id, body) : await api.post('/restaurant-crm/orders', body)); } catch (ex) { setErr(ex.message); setSaving(false); }
  }
  const seated = form.service === 'dine_in' || form.service === 'reservation';
  return (
    <div className="dialog-backdrop" onClick={() => !saving && onClose()}>
      <form className="dialog tl-dialog rc-dialog" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>{order ? tr('Change the order') : tr('Log an order')}</h2>
        <p className="dk-muted tl-small">{tr('An order taken by phone, WhatsApp or Bolt. Ring it up on Square as usual; the OS links the two by the day and the dishes.')}</p>
        <div className="tl-form">
          <div className="field rc-guest-pick">
            <label htmlFor="rc-name">{tr('Guest')}</label>
            <input id="rc-name" className="input" value={form.name} onChange={(e) => typeName(e.target.value)} placeholder={tr('Name, as they give it')} autoComplete="off" required={!form.phone} />
            {suggest.length > 0 && !form.guestId && (
              <ul className="rc-suggest" role="listbox">
                {suggest.map((g) => (
                  <li key={g.id}><button type="button" onClick={() => { setForm((f) => ({ ...f, guestId: g.id, name: g.name, phone: g.phone || f.phone })); setSuggest([]); }}>
                    <strong>{g.name}</strong> <span className="dk-muted tl-small">{[g.phone, ordersText(g.orders)].filter(Boolean).join(' · ')}</span>
                  </button></li>
                ))}
              </ul>
            )}
            {form.guestId ? <span className="dk-muted tl-small">{tr('A guest already known.')} <button type="button" className="dk-link" onClick={() => set('guestId', '')}>{tr('Someone else')}</button></span>
              : <span className="dk-muted tl-small">{tr('Pick them if they are listed; otherwise a new guest is made (or found by their number).')}</span>}
          </div>
          <div className="field">
            <label htmlFor="rc-phone">{tr('Phone number')}</label>
            <input id="rc-phone" className="input" inputMode="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder="024 000 0000" disabled={!!form.guestId} />
          </div>
          <div className="field">
            <label htmlFor="rc-date">{tr('Date')}</label>
            <input id="rc-date" className="input" type="date" max={today()} value={form.orderedOn} onChange={(e) => set('orderedOn', e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="rc-channel">{tr('How it came in')}</label>
            <select id="rc-channel" className="input" value={form.channel} onChange={(e) => set('channel', e.target.value)}>
              {CHANNELS.map((c) => <option key={c} value={c}>{tr(CHANNEL[c])}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="rc-service">{tr('How it was served')}</label>
            <select id="rc-service" className="input" value={form.service} onChange={(e) => set('service', e.target.value)}>
              {SERVICES.map((s) => <option key={s} value={s}>{tr(SERVICE[s])}</option>)}
            </select>
          </div>
          <div className="field tl-span">
            <label htmlFor="rc-items">{tr('What they ordered')}</label>
            <textarea id="rc-items" className="input" rows={2} maxLength={1000} value={form.items} onChange={(e) => set('items', e.target.value)} placeholder={tr('Assorted fried rice, beef sauce — or menu codes: A90, A85')} required={form.service !== 'reservation'} />
          </div>
          {seated && (
            <>
              <div className="field"><label htmlFor="rc-party">{tr('Number of guests')}</label><input id="rc-party" className="input" type="number" min="1" max="500" value={form.partySize} onChange={(e) => set('partySize', e.target.value)} /></div>
              <div className="field"><label htmlFor="rc-table">{tr('Table')}</label><input id="rc-table" className="input" maxLength={100} value={form.tableNote} onChange={(e) => set('tableNote', e.target.value)} placeholder={tr('Table 10')} /></div>
            </>
          )}
          <div className="field">
            <label htmlFor="rc-amount">{tr('Amount (if not rung up on Square)')}</label>
            <input id="rc-amount" className="input" type="number" min="0" step="0.01" value={form.amount} onChange={(e) => set('amount', e.target.value)} disabled={order && order.amountFromTill} />
            {order && order.amountFromTill && <span className="dk-muted tl-small">{tr('Taken from the sale on the till.')}</span>}
          </div>
          <div className="field tl-span">
            <label htmlFor="rc-feedback">{tr('What the guest said (feedback)')}</label>
            <textarea id="rc-feedback" className="input" rows={2} maxLength={1000} value={form.feedback} onChange={(e) => set('feedback', e.target.value)} placeholder={tr('The food was good but the protein was small')} />
          </div>
          <div className="field tl-span">
            <span className="tl-label">{tr('Rating')}</span>
            <div className="rc-rate" role="radiogroup" aria-label={tr('Rating')}>
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} type="button" role="radio" aria-checked={form.rating === n} className={'rc-rate-star' + (form.rating && n <= form.rating ? ' is-on' : '')} onClick={() => set('rating', form.rating === n ? null : n)} aria-label={tr('{n} out of 5', { n })}>★</button>
              ))}
              <span className="dk-muted tl-small">{form.rating ? tr('{n} out of 5', { n: form.rating }) : tr('Not asked')}</span>
            </div>
            <span className="dk-muted tl-small">{tr('A rating of 3 or less, or a complaint, puts the guest on the list to call back.')}</span>
          </div>
        </div>
        {err && <div className="error-banner">{err}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : order ? tr('Save changes') : tr('Save the order')}</button>
        </div>
      </form>
    </div>
  );
}

// ── a guest's profile ──────────────────────────────────────────────────
function GuestProfile({ id, canManage, onClose, onOpen, onLog, onChanged, onToast }) {
  const [g, setG] = useState(null);
  const [err, setErr] = useState(null);
  const [edit, setEdit] = useState(null);
  const load = useCallback(async () => { try { setG(await api.get('/restaurant-crm/guests/' + id)); } catch (ex) { setErr(ex.message); } }, [id]);
  useEffect(() => { setG(null); load(); }, [load]);
  async function saveEdit(e) {
    e.preventDefault();
    try { await api.put('/restaurant/guests/' + id, edit); setEdit(null); onToast(tr('Guest saved.')); load(); onChanged(); } catch (ex) { setErr(ex.message); }
  }
  async function merge(other) {
    const keep = g.orders >= other.orders ? g : other;
    const drop = keep === g ? other : g;
    if (!window.confirm(tr('Put {drop} together with {keep}? Their orders move to {keep}, and {drop} is removed.', { drop: drop.name, keep: keep.name }))) return;
    try { await api.post('/restaurant-crm/guests/merge', { keepId: keep.id, dropId: drop.id }); onToast(tr('{name} is now one guest.', { name: keep.name })); onChanged(); if (keep.id !== id) onOpen(keep.id); else load(); } catch (ex) { setErr(ex.message); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog tl-dialog rc-profile" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={g ? g.name : tr('Guest')}>
        {!g ? (err ? <div className="error-banner">{err}</div> : <p className="eyebrow">{tr('Loading…')}</p>) : (
          <>
            <div className="rc-profile-head">
              <div>
                <h2>{g.name}</h2>
                <p className="dk-muted tl-small">{g.phone || tr('No number')}{g.fromSquare ? ' · ' + tr('a customer on Square') : ''}</p>
              </div>
              <ContactButtons name={g.name} phone={g.phone} />
              <Status tone={SEGMENT[g.segment][1]}>{tr(SEGMENT[g.segment][0])}</Status>
            </div>
            {err && <div className="error-banner">{err}</div>}
            <div className="rc-kpis">
              <div><strong>{g.orders}</strong><span>{tr('orders')}</span></div>
              <div><strong>{g.firstOn ? fmtDate(g.firstOn) : '—'}</strong><span>{tr('first order')}</span></div>
              <div><strong>{g.lastOn ? fmtDate(g.lastOn) : '—'}</strong><span>{g.daysSince !== null ? tr('{n} days ago', { n: g.daysSince }) : tr('last order')}</span></div>
              <div><strong>{g.avgGap ? tr('{n} days', { n: g.avgGap }) : '—'}</strong><span>{tr('usually between orders')}</span></div>
              <div><strong>{g.avgRating ? g.avgRating + ' / 5' : '—'}</strong><span>{tr('average rating')}</span></div>
              <div><strong>{g.amount ? money(g.amount) : '—'}</strong><span>{tr('spent (known amounts)')}</span></div>
            </div>
            {g.segment === 'quiet' && <p className="rc-flag is-warn">{tr('Used to order about every {n} days; nothing for {d} days. A message with what they like may bring them back.', { n: g.avgGap || 30, d: g.daysSince })}</p>}
            {g.notes && !edit && <p className="rc-notes">{g.notes}</p>}
            {g.dishes.length > 0 && <div className="rc-block"><h4>{tr('What they like')}</h4><div className="tl-tags">{g.dishes.map((d) => <Tag key={d.key}>{d.name} · {d.orders}</Tag>)}</div></div>}
            {g.channels.length > 0 && <div className="rc-block"><h4>{tr('How they order')}</h4><div className="tl-tags">{g.channels.map((c) => <Tag key={c.key}>{tr(CHANNEL[c.key] || c.key)} · {c.orders}</Tag>)}</div></div>}
            {g.duplicates.length > 0 && (
              <div className="rc-block">
                <h4>{tr('The same guest?')}</h4>
                <ul className="rc-dupes">
                  {g.duplicates.map((d) => (
                    <li key={d.id}>
                      <button type="button" className="rc-name" onClick={() => onOpen(d.id)}>{d.name}</button>
                      <span className="dk-muted tl-small">{[d.phone, ordersText(d.orders), d.reason === 'phone' ? tr('same number') : tr('same name')].filter(Boolean).join(' · ')}</span>
                      {canManage && <button type="button" className="btn btn-secondary tl-btn" onClick={() => merge(d)}>{tr('Put together')}</button>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {edit && (
              <form className="tl-form rc-block" onSubmit={saveEdit}>
                <div className="field"><label htmlFor="rg-name">{tr('Name')}</label><input id="rg-name" className="input" maxLength={100} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required /></div>
                <div className="field"><label htmlFor="rg-phone">{tr('Phone number')}</label><input id="rg-phone" className="input" value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></div>
                <div className="field tl-span"><label htmlFor="rg-notes">{tr('Notes')}</label><textarea id="rg-notes" className="input" rows={2} value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} placeholder={tr('Allergic to nuts; likes a corner table')} /></div>
                <div className="dialog-actions tl-span"><button type="button" className="btn btn-secondary" onClick={() => setEdit(null)}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary">{tr('Save')}</button></div>
              </form>
            )}
            <div className="rc-block">
              <h4>{tr('Every order')}</h4>
              {g.timeline.length ? (
                <ul className="rc-timeline">
                  {g.timeline.map((o) => (
                    <li key={o.kind + o.id}>
                      <span className="dk-muted tl-small rc-tl-date">{fmtDate(o.day)}</span>
                      <div>
                        <p className="rc-items">{o.items || (o.service === 'reservation' ? tr('Table booked') : '—')}{o.amount !== null ? <strong className="rc-tl-amount">{money(o.amount)}</strong> : null}</p>
                        <div className="tl-tags">
                          <Tag>{tr(CHANNEL[o.channel] || o.channel)}</Tag>
                          <Tag>{tr(SERVICE[o.service] || o.service)}</Tag>
                          {o.kind === 'till' && <Tag>{tr('Till only')}</Tag>}
                          {o.kind === 'log' && o.tillOrderId && <Tag tone="good">{tr('On the till')}</Tag>}
                          {o.themes.map((th) => <Tag key={th} tone="bad">{tr(THEME[th])}</Tag>)}
                        </div>
                        {(o.feedback || o.rating) && <p className="rc-quote">{o.feedback ? '“' + o.feedback + '”' : null} <Stars value={o.rating} /></p>}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : <p className="dk-muted tl-small">{tr('No orders yet')}</p>}
            </div>
            <div className="dialog-actions">
              {canManage && !edit && <button type="button" className="btn btn-secondary" onClick={() => setEdit({ name: g.name, phone: g.phone || '', notes: g.notes || '' })}>{tr('Edit name, number or notes')}</button>}
              {canManage && <button type="button" className="btn btn-secondary" onClick={() => onLog({ id: g.id, name: g.name, phone: g.phone })}>{tr('Log an order for them')}</button>}
              <button type="button" className="btn btn-primary" onClick={onClose}>{tr('Close')}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── importing the order sheet ──────────────────────────────────────────
function ImportDialog({ companyId, companyName, onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [pv, setPv] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  async function preview(f) {
    setFile(f); setPv(null); setErr(null);
    if (!f) return;
    setBusy(true);
    const body = new FormData(); body.append('companyId', companyId); body.append('file', f);
    try { setPv(await api.upload('/restaurant-crm/import/preview', body)); } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  }
  async function run() {
    setBusy(true); setErr(null);
    const body = new FormData(); body.append('companyId', companyId); body.append('file', file);
    try { onDone(await api.upload('/restaurant-crm/import', body)); } catch (ex) { setErr(ex.message); setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <div className="dialog tl-dialog rc-import" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={tr('Import the order sheet')}>
        <h2>{tr('Import the order sheet')}</h2>
        <p className="dk-muted tl-small">{tr('The sheet customer service has kept for {name} (BG ORDER RECORD): date, customer name, order details, how it came in, pick-up/dine-in/delivery, feedback and phone number. Download it as Excel (.xlsx). Importing it again later only adds the new rows.', { name: companyName })}</p>
        <div className="field">
          <label htmlFor="rc-file">{tr('Order sheet (.xlsx)')}</label>
          <input id="rc-file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => preview(e.target.files[0] || null)} />
        </div>
        {busy && !pv && <p className="eyebrow">{tr('Reading the sheet…')}</p>}
        {pv && (
          <>
            <div className="rc-kpis">
              <div><strong>{pv.newOrders}</strong><span>{tr('new orders')}</span></div>
              <div><strong>{pv.alreadyImported}</strong><span>{tr('already here')}</span></div>
              <div><strong>{pv.guests}</strong><span>{tr('guests ({n} new)', { n: pv.newGuests })}</span></div>
              <div><strong>{pv.repeatGuests}</strong><span>{tr('ordered more than once')}</span></div>
            </div>
            <ul className="rc-understood">
              <li>{tr('Tab “{sheet}”, {from} to {to}.', { sheet: pv.sheet, from: fmtDate(pv.from), to: fmtDate(pv.to) })}</li>
              <li>{pv.channels.map((c) => tr(CHANNEL[c.key]) + ' ' + c.orders).join(' · ')}</li>
              <li>{pv.services.map((c) => tr(SERVICE[c.key]) + ' ' + c.orders).join(' · ')}</li>
              <li>{tr('{n} guests with a phone number.', { n: pv.withPhone })}</li>
              {pv.ratings > 0 && <li>{tr('{n} ratings.', { n: pv.ratings })}{pv.ratingsFromDates ? ' ' + tr('{n} of them typed like 3/5 had been turned into dates by the spreadsheet; they are read as ratings again.', { n: pv.ratingsFromDates }) : ''}</li>}
              {pv.reservations > 0 && <li>{tr('{n} table bookings; the number of guests and the table written under Feedback are kept as such, not as feedback.', { n: pv.reservations })}</li>}
              {pv.feedback > 0 && <li>{tr('{n} orders with feedback, {c} of them complaints.', { n: pv.feedback, c: pv.complaints })}</li>}
              {pv.skippedCount > 0 && <li className="is-warn">{tr('{n} rows left out: {why}', { n: pv.skippedCount, why: pv.skipped.slice(0, 5).map((s) => tr('row {row} ({reason})', { row: s.row, reason: s.reason })).join(', ') })}</li>}
            </ul>
            <div className="rc-sample">
              <table className="table">
                <thead><tr><th>{tr('Date')}</th><th>{tr('Guest')}</th><th>{tr('Order')}</th><th>{tr('Came in')}</th><th>{tr('Served')}</th><th>{tr('Feedback')}</th></tr></thead>
                <tbody>
                  {pv.sample.map((s) => (
                    <tr key={s.row} className={s.already ? 'is-old' : ''}>
                      <td>{fmtDate(s.day)}</td><td>{s.name}</td><td>{s.items || '—'}</td><td>{tr(CHANNEL[s.channel])}</td>
                      <td>{tr(SERVICE[s.service])}{s.partySize ? ' · ' + tr('{n} guests', { n: s.partySize }) : ''}{s.tableNote ? ' · ' + s.tableNote : ''}</td>
                      <td>{s.feedback}{s.rating ? ' ' + stars(s.rating) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {err && <div className="error-banner">{err}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
          <button type="button" className="btn btn-primary" disabled={busy || !pv || !pv.newOrders} onClick={run}>{busy && pv ? tr('Importing…') : pv && !pv.newOrders ? tr('Nothing new to import') : tr('Import {n} orders', { n: pv ? pv.newOrders : 0 })}</button>
        </div>
      </div>
    </div>
  );
}

// ── calling back ───────────────────────────────────────────────────────
function FollowDialog({ state, onClose, onSaved }) {
  const [note, setNote] = useState(state.note || '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const o = state.order;
  async function save(e) {
    e.preventDefault();
    setSaving(true); setErr(null);
    try { await api.post('/restaurant-crm/orders/' + o.id + '/follow-up', { status: 'done', note }); onSaved(); } catch (ex) { setErr(ex.message); setSaving(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={() => !saving && onClose()}>
      <form className="dialog tl-dialog" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>{tr('Called back')}</h2>
        <p className="tl-small"><strong>{o.guest ? o.guest.name : tr('A guest')}</strong> · {fmtDate(o.orderedOn)}{o.feedback ? ' · “' + o.feedback + '”' : ''}</p>
        <div className="field">
          <label htmlFor="rc-note">{tr('What was said and done')}</label>
          <textarea id="rc-note" className="input" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr('Called her, apologised; extra protein on her next order')} required />
        </div>
        {err && <div className="error-banner">{err}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : tr('Save')}</button>
        </div>
      </form>
    </div>
  );
}

// ── choosing the sale on the till ──────────────────────────────────────
function TillDialog({ order, onClose, onSaved }) {
  const [list, setList] = useState(null);
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { api.get('/restaurant-crm/orders/' + order.id + '/till').then(setList).catch((ex) => setErr(ex.message)); }, [order.id]);
  async function pick(tillOrderId) {
    setSaving(true); setErr(null);
    try { onSaved(await api.post('/restaurant-crm/orders/' + order.id + '/till', { tillOrderId })); } catch (ex) { setErr(ex.message); setSaving(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={() => !saving && onClose()}>
      <div className="dialog tl-dialog rc-till-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={tr('The sale on the till')}>
        <h2>{tr('The sale on the till')}</h2>
        <p className="tl-small"><strong>{order.guest ? order.guest.name : tr('A guest')}</strong> · {fmtDate(order.orderedOn)} · {order.items}</p>
        <p className="dk-muted tl-small">{tr('The sales of that day and the days either side, the best fit first. Sales already linked to another order are not shown.')}</p>
        {!list ? (err ? null : <p className="eyebrow">{tr('Loading…')}</p>) : !list.length ? <div className="dk-empty"><p>{tr('No sales on the till for those days. Import from Square on Menu & inventory brings them.')}</p></div> : (
          <ul className="rc-candidates">
            {list.map((s) => (
              <li key={s.id} className={s.linked ? 'is-on' : ''}>
                <div>
                  <p className="tl-small"><strong>{s.orderNo}</strong> · {new Date(s.at).toLocaleString(activeIntlLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · <strong>{money(s.total)}</strong></p>
                  <p className="dk-muted tl-small">{s.items || '—'}</p>
                  <div className="tl-tags">
                    {s.source && <Tag>{s.source}</Tag>}
                    {s.fulfillment && <Tag>{tr(SERVICE[s.fulfillment] || s.fulfillment)}</Tag>}
                    {s.customerName && <Tag>{s.customerName}</Tag>}
                    {s.fit >= 1.5 && <Tag tone="good">{tr('Good fit')}</Tag>}
                  </div>
                </div>
                {s.linked ? <Status tone="good">{tr('Linked')}</Status> : <button type="button" className="btn btn-secondary tl-btn" disabled={saving} onClick={() => pick(s.id)}>{tr('This one')}</button>}
              </li>
            ))}
          </ul>
        )}
        {err && <div className="error-banner">{err}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => pick(null)}>{tr('It is not on the till')}</button>
          <button type="button" className="btn btn-primary" onClick={onClose} disabled={saving}>{tr('Close')}</button>
        </div>
      </div>
    </div>
  );
}
