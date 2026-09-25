import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { Glossary, Hero, Insights, Section, Status, avatarColor, fmtDate, initials, jump } from '../components/DashKit';
import { money, moneyBreakdown } from '../lib/currency';
import { tr, msg } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels';
import './EmployeesPage.css';
import './ToolRoomPage.css';
import './RestaurantsPage.css';
import './PokiRentals.css';
import './CustomersPage.css';
import './EstimatesPage.css';
import './RemindersPage.css';

// Payment reminders (reminders.service.js): everyone whose rent, utility
// bill or invoice is overdue or due soon, and every Poki tenant whose
// booking is ending. Two ways to reach them:
//   - WhatsApp: opens WhatsApp on this phone or computer, in their chat,
//     with the message (and a link to the bill) already typed. WhatsApp
//     can't be sent by the OS itself, so the person here presses send.
//   - Text: sent at once through the company's mNotify account (shown only
//     when that is set up), after a confirm, since it uses credit.
// Every reminder is recorded, so nobody is chased twice in a morning. The
// OS can also text on its own (Company settings → Messaging); the page
// says whether that is on.
//
// Same "explains itself" layout as the dashboards (components/DashKit.jsx):
// overdue, due soon, not chased lately, bookings ending; what stands out;
// then the bills or the bookings as cards or a list, each with its buttons
// and a window with every reminder sent.

const WINDOWS = [3, 7, 14, 30];
const BOOKING_WINDOWS = [30, 60, 90];
const CHASE_DAYS = 7;
const KINDS = { rent: msg('Rent'), utility: msg('Utility bill'), deposit: msg('Deposit'), maintenance: msg('Maintenance'), sale: msg('Invoice') };

function readPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* remembered for this visit only */ } }
function daysAgo(at) { return at ? Math.floor((Date.now() - new Date(at).getTime()) / 86400000) : null; }
function agoText(at) {
  const mins = Math.round((Date.now() - new Date(at).getTime()) / 60000);
  if (mins < 60) return tr('{n} min ago', { n: Math.max(1, mins) });
  const hours = Math.round(mins / 60);
  if (hours < 24) return tr('{n} h ago', { n: hours });
  return tr('{n} days ago', { n: Math.round(hours / 24) });
}
function howText(last) { return last.automatic ? tr('automatic text') : last.channel === 'sms' ? tr('by text') : tr('on WhatsApp'); }
function dueText(days) { return days > 0 ? tr('{n} days overdue', { n: days }) : days === 0 ? tr('Due today') : tr('Due in {n} days', { n: -days }); }
function kindLabel(k) { return KINDS[k] ? tr(KINDS[k]) : codeLabel(k); }
function chased(r) { return r.lastReminder && daysAgo(r.lastReminder.at) < CHASE_DAYS; }
function sums(list) {
  const m = {};
  list.forEach((r) => { m[r.currency] = (m[r.currency] || 0) + r.balanceDue; });
  return Object.entries(m).map(([currency, amount]) => ({ currency, amount }));
}

function Mark({ name, size = 44 }) {
  return <span className="pk-avatar cu-mark" style={{ width: size, height: size, background: avatarColor(name), fontSize: Math.round(size * 0.34) }} aria-hidden="true">{initials(name)}</span>;
}
function LastSent({ last, countLabel }) {
  if (!last) return <span className="pk-owe">{tr('Not reminded yet')}</span>;
  return <>{tr('Reminded {when}', { when: agoText(last.at) })} · {howText(last)}{last.by ? ' · ' + last.by : ''}{last.count > 1 ? ' · ' + countLabel(last.count) : ''}</>;
}

// The buttons, or the reason there are none.
function SendButtons({ row, smsAvailable, sending, onWhatsApp, onSms, noPhoneLink, cantSend }) {
  if (!row.whatsapp) return <Link className="btn btn-secondary rm-btn" to={noPhoneLink}>{tr('Add phone number')}</Link>;
  return (
    <div className="rm-buttons">
      <button type="button" className="btn btn-primary rm-btn rm-wa" disabled={!row.canSend || !!sending} title={row.canSend ? undefined : cantSend} onClick={() => onWhatsApp(row)}>
        {sending === row.key ? tr('Opening…') : tr('WhatsApp')}
      </button>
      {smsAvailable && (
        <button type="button" className="btn btn-secondary rm-btn" disabled={!row.canSend || !!sending} title={row.canSend ? undefined : cantSend} onClick={() => onSms(row)}>
          {sending === row.key + ':sms' ? tr('Sending…') : tr('Send text')}
        </button>
      )}
    </div>
  );
}

// Shared by both lists: open WhatsApp, or text after a confirm.
function useSender(reload, setError, setToast) {
  const [sending, setSending] = useState(null);
  async function whatsapp(path, row) {
    // Opened now, while the click still counts as the person's own action —
    // a window opened after waiting for the server is blocked as a pop-up.
    const win = window.open('', '_blank');
    setSending(row.key);
    setError(null);
    try {
      const r = await api.post(path, { origin: window.location.origin });
      if (win) win.location.href = r.whatsappUrl;
      else window.location.href = r.whatsappUrl;
      setToast(tr('WhatsApp opened for {name} — press send there.', { name: row.customerName }));
      await reload();
    } catch (err) {
      if (win) win.close();
      setError(err.message);
    } finally {
      setSending(null);
    }
  }
  async function sms(path, row) {
    if (!window.confirm(tr('Text this reminder to {name} on {phone} now? It uses SMS credit.', { name: row.customerName, phone: row.phone }))) return;
    setSending(row.key + ':sms');
    setError(null);
    try {
      await api.post(path, { origin: window.location.origin });
      setToast(tr('Text sent to {name}.', { name: row.customerName }));
      await reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(null);
    }
  }
  return { sending, whatsapp, sms };
}

export default function RemindersPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const showBills = can('invoice.read') || can('poki.read') || can('poki.manage');
  const showBookings = can('poki.read') || can('poki.manage');
  const [bills, setBills] = useState(null);
  const [bookings, setBookings] = useState(null);
  const [windowDays, setWindowDays] = useState(7);
  const [bookingDays, setBookingDays] = useState(60);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [tab, setTab] = useState('bills');
  const [chip, setChip] = useState('all');
  const [company, setCompany] = useState('');
  const [search, setSearch] = useState('');
  const [view, setView] = useState(() => readPref('bos.remindersView', 'cards'));
  const [detail, setDetail] = useState(null);
  const [history, setHistory] = useState(null);

  const loadBills = useCallback(async () => {
    if (!showBills) return;
    try { setBills(await api.get('/reminders?days=' + windowDays)); } catch (err) { setError(err.message); }
  }, [windowDays, showBills]);
  const loadBookings = useCallback(async () => {
    if (!showBookings) return;
    try { setBookings(await api.get('/reminders/bookings?days=' + bookingDays)); } catch (err) { setError(err.message); }
  }, [bookingDays, showBookings]);
  useEffect(() => { loadBills(); }, [loadBills]);
  useEffect(() => { loadBookings(); }, [loadBookings]);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  const reload = useCallback(async () => { await Promise.all([loadBills(), loadBookings()]); }, [loadBills, loadBookings]);
  const sender = useSender(reload, setError, setToast);

  useEffect(() => {
    setHistory(null);
    if (!detail) return;
    api.get('/reminders/' + detail + '/history').then(setHistory).catch(() => setHistory([]));
  }, [detail, bills]);

  const rows = useMemo(() => (bills ? bills.rows.map((r) => ({ ...r, key: r.invoiceId })) : []), [bills]);
  const brows = useMemo(() => (bookings ? bookings.rows.map((r) => ({ ...r, key: r.bookingId })) : []), [bookings]);

  if (!bills && !bookings && !error) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const overdue = rows.filter((r) => r.daysOverdue > 0);
  const soon = rows.filter((r) => r.daysOverdue <= 0);
  const notChased = overdue.filter((r) => !chased(r));
  const never = overdue.filter((r) => !r.lastReminder);
  const noPhone = rows.filter((r) => !r.whatsapp);
  const longest = overdue.slice().sort((a, b) => b.daysOverdue - a.daysOverdue)[0];
  const endingWeek = brows.filter((r) => r.daysLeft <= 7);
  const companies = Array.from(new Set(rows.map((r) => r.company)));
  const smsAvailable = bills ? bills.smsAvailable : bookings ? bookings.smsAvailable : false;
  const auto = (bills && bills.auto) || { payments: false, bookings: false };

  function showBillsChip(key) { setTab('bills'); setChip(chip === key ? 'all' : key); jump('rm-list'); }
  const stats = [
    { icon: 'warn', value: moneyBreakdown(sums(overdue), money(0)), label: tr('overdue'), note: overdue.length === 1 ? tr('1 bill') : tr('{n} bills', { n: overdue.length }), tone: overdue.length ? 'bad' : 'good', onClick: () => showBillsChip('overdue') },
    { icon: 'calendar', value: moneyBreakdown(sums(soon), money(0)), label: tr('due in the next {n} days', { n: windowDays }), note: soon.length === 1 ? tr('1 bill') : tr('{n} bills', { n: soon.length }), tone: soon.length ? 'warn' : '', onClick: () => showBillsChip('soon') },
    { icon: 'send', value: String(notChased.length), label: tr('overdue, not reminded this week'), note: never.length ? tr('{n} never reminded', { n: never.length }) : tr('everyone overdue was reminded before'), tone: notChased.length ? 'warn' : 'good', onClick: () => showBillsChip('notchased') },
    showBookings
      ? { icon: 'clock', value: String(brows.length), label: tr('bookings ending in {n} days', { n: bookingDays }), note: endingWeek.length ? tr('{n} this week', { n: endingWeek.length }) : tr('none this week'), tone: endingWeek.length ? 'warn' : '', onClick: () => { setTab('bookings'); jump('rm-list'); } }
      : { icon: 'check', value: String(rows.filter(chased).length), label: tr('reminded this week'), note: tr('of {n} on the list', { n: rows.length }), onClick: () => showBillsChip('chased') }
  ];

  const insights = [];
  if (never.length) insights.push({ tone: 'bad', icon: 'send', text: never.length === 1 ? tr('{name} is {days} days overdue on {no} and has never been reminded.', { name: never[0].customerName, days: never[0].daysOverdue, no: never[0].invoiceNo }) : tr('{n} overdue bills have never had a reminder.', { n: never.length }), action: { label: never.length === 1 ? tr('Open') : tr('Show them'), run: () => (never.length === 1 ? setDetail(never[0].invoiceId) : showBillsChip('never')) } });
  if (longest && longest.daysOverdue > 30) insights.push({ tone: 'bad', icon: 'clock', text: tr('{name} is the longest overdue: {amount}, {days} days.', { name: longest.customerName, amount: money(longest.balanceDue, longest.currency), days: longest.daysOverdue }), action: { label: tr('Open'), run: () => setDetail(longest.invoiceId) } });
  if (noPhone.length) insights.push({ tone: 'warn', icon: 'phone', text: noPhone.length === 1 ? tr('{name} has no phone number, so they can\'t be reminded.', { name: noPhone[0].customerName }) : tr('{n} bills belong to people with no phone number, so they can\'t be reminded.', { n: noPhone.length }), action: { label: tr('Show them'), run: () => showBillsChip('nophone') } });
  if (endingWeek.length) insights.push({ tone: 'warn', icon: 'calendar', text: endingWeek.length === 1 ? tr('{name}\'s booking of {unit} ends on {date}.', { name: endingWeek[0].customerName, unit: endingWeek[0].unit, date: fmtDate(endingWeek[0].endDate) }) : tr('{n} bookings end this week.', { n: endingWeek.length }), action: { label: tr('Show them'), run: () => { setTab('bookings'); jump('rm-list'); } } });
  if (smsAvailable && !auto.payments && rows.length) insights.push({ tone: 'info', icon: 'info', text: tr('Automatic reminder texts are off, so every reminder has to be sent from here. They can be turned on in Company settings.'), action: can('settings.manage') ? { label: tr('Company settings'), run: () => navigate('/settings') } : null });
  if (!smsAvailable) insights.push({ tone: 'info', icon: 'info', text: tr('Text messages aren\'t set up, so reminders go by WhatsApp only.'), action: null });
  if (!overdue.length && rows.length === 0 && showBills) insights.push({ tone: 'good', icon: 'check', text: tr('Nothing overdue or due soon.') });

  const chipTest = {
    all: () => true, overdue: (r) => r.daysOverdue > 0, soon: (r) => r.daysOverdue <= 0, notchased: (r) => notChased.includes(r),
    never: (r) => never.includes(r), chased: (r) => chased(r), nophone: (r) => !r.whatsapp
  };
  const visible = rows.filter(chipTest[chip] || chipTest.all).filter((r) => !company || r.company === company)
    .filter((r) => matchesQuery(search, r.customerName, r.contactPerson, r.invoiceNo, r.unit, r.phone));
  const bvisible = brows.filter((r) => matchesQuery(search, r.customerName, r.contactPerson, r.bookingNo, r.unit, r.phone));
  const chips = [
    ['all', tr('All'), rows.length], ['overdue', tr('Overdue'), overdue.length], ['soon', tr('Due soon'), soon.length], ['notchased', tr('Not reminded this week'), notChased.length],
    ['never', tr('Never reminded'), never.length], ['chased', tr('Reminded this week'), rows.filter(chased).length], ['nophone', tr('No phone number'), noPhone.length]
  ].filter(([k, , c]) => c > 0 || k === 'all' || k === chip);
  const cur = detail ? rows.find((r) => r.invoiceId === detail) : null;
  const sendBill = { whatsapp: (row) => sender.whatsapp('/reminders/' + row.invoiceId + '/whatsapp', row), sms: (row) => sender.sms('/reminders/' + row.invoiceId + '/sms', row) };

  return (
    <div className="dk tl pk cu rm">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <Hero
        eyebrow={tr('Finance')}
        title={tr('Payment reminders')}
        sub={tr('Everyone whose rent, utility bill or invoice is overdue or due soon. "WhatsApp" opens WhatsApp with a polite reminder and a link to the bill already written — you press send. "Send text" texts it straight away. Each reminder is recorded here, so nobody is chased twice in a morning.')}
        actions={(
          <>
            <Link className="btn btn-secondary" to="/invoices">{tr('Invoices')}</Link>
            <span className="rm-auto">{auto.payments ? <Status tone="good">{tr('Automatic texts on')}</Status> : smsAvailable ? <Status tone="muted">{tr('Automatic texts off')}</Status> : null}</span>
          </>
        )}
        stats={stats} />

      <Insights items={insights.slice(0, 5)} />

      <Section id="rm-list" title={tab === 'bookings' ? tr('Bookings ending') : tr('Bills to chase')} sub={tab === 'bookings' ? tr('Poki tenants whose booking ends soon and hasn\'t been renewed. Let them know in good time.') : tr('Press a bill to see every reminder sent for it.')}
        action={(
          <div className="rm-head-actions">
            {showBookings && showBills && (
              <div className="ppl-view" role="radiogroup" aria-label={tr('Show')}>
                {[['bills', tr('Bills')], ['bookings', tr('Bookings ending')]].map(([k, label]) => (
                  <button key={k} type="button" role="radio" aria-checked={tab === k} className={tab === k ? 'is-on' : ''} onClick={() => setTab(k)}>{label}</button>
                ))}
              </div>
            )}
            <div className="ppl-view" role="radiogroup" aria-label={tr('View')}>
              {[['cards', tr('Cards')], ['list', tr('List')]].map(([k, label]) => (
                <button key={k} type="button" role="radio" aria-checked={view === k} className={view === k ? 'is-on' : ''} onClick={() => { setView(k); writePref('bos.remindersView', k); }}>{label}</button>
              ))}
            </div>
          </div>
        )}>
        <div className="tl-tools rm-tools">
          <div className="tl-search"><SearchInput value={search} onChange={setSearch} placeholder={tab === 'bookings' ? tr('Search tenants, bookings, units…') : tr('Search customers, bills, units…')} /></div>
          {tab === 'bookings' ? (
            <select className="input rm-select" value={bookingDays} onChange={(e) => setBookingDays(Number(e.target.value))} aria-label={tr('Ending within')}>
              {BOOKING_WINDOWS.map((d) => <option key={d} value={d}>{tr('Ending within {n} days', { n: d })}</option>)}
            </select>
          ) : (
            <>
              <select className="input rm-select" value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value))} aria-label={tr('Due within')}>
                {WINDOWS.map((d) => <option key={d} value={d}>{tr('Overdue or due within {n} days', { n: d })}</option>)}
              </select>
              {companies.length > 1 && (
                <select className="input rm-select" value={company} onChange={(e) => setCompany(e.target.value)} aria-label={tr('Company')}>
                  <option value="">{tr('Both companies')}</option>
                  <option value="bpl">Bamboo Products</option>
                  <option value="poki">Poki Properties</option>
                </select>
              )}
            </>
          )}
        </div>

        {tab === 'bills' ? (
          <>
            <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
              {chips.map(([key, label, c]) => (
                <button key={key} type="button" role="radio" aria-checked={chip === key} className={'ppl-chip' + (chip === key ? ' is-on' : '')} onClick={() => setChip(key)}>
                  {label} <span className="ppl-chip-n">{c}</span>
                </button>
              ))}
            </div>
            {!visible.length ? (
              <div className="dk-empty tl-empty"><p>{rows.length ? tr('Nothing matches. Try another search or filter.') : tr('Nothing overdue or due soon.')}</p></div>
            ) : view === 'cards' ? (
              <div className="tl-grid">
                {visible.map((r) => (
                  <article key={r.key} className={'tl-card' + (r.daysOverdue > 0 && !chased(r) ? ' st-late' : '')}>
                    <button type="button" className="tl-card-open" onClick={() => setDetail(r.invoiceId)}>
                      <Mark name={r.customerName} />
                      <span className="tl-card-head">
                        <span className="dk-muted tl-small">{kindLabel(r.kind)} · {r.invoiceNo}{r.company === 'poki' ? ' · Poki' : ''}</span>
                        <span className="tl-name">{r.customerName}</span>
                      </span>
                    </button>
                    {r.unit && <p className="dk-muted tl-small es-items">{r.unit}</p>}
                    <div className="tl-tags"><Status tone={r.daysOverdue > 0 ? 'bad' : r.daysOverdue === 0 ? 'warn' : 'info'}>{dueText(r.daysOverdue)}</Status></div>
                    <p className="tl-small dk-muted rm-last"><LastSent last={r.lastReminder} countLabel={(n) => tr('{n} reminders so far', { n })} /></p>
                    <div className="tl-foot rm-foot">
                      <span className="es-total">{money(r.balanceDue, r.currency)}</span>
                      <SendButtons row={r} smsAvailable={smsAvailable} sending={sender.sending} noPhoneLink={r.company === 'poki' ? '/pokitenants' : '/customers'}
                        cantSend={tr('Your role can see this bill but not send reminders for it.')} onWhatsApp={sendBill.whatsapp} onSms={sendBill.sms} />
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="tl-table-wrap">
                <table className="tl-table">
                  <thead><tr><th>{tr('Customer')}</th><th>{tr('Bill')}</th><th className="is-num">{tr('Amount due')}</th><th>{tr('Due')}</th><th>{tr('Last reminded')}</th><th /></tr></thead>
                  <tbody>
                    {visible.map((r) => (
                      <tr key={r.key}>
                        <td><button type="button" className="tl-row-open" onClick={() => setDetail(r.invoiceId)}><Mark name={r.customerName} size={32} /><span><span className="tl-name">{r.customerName}</span><span className="dk-muted tl-small">{r.phone || tr('No phone number')}</span></span></button></td>
                        <td>{r.invoiceNo}<div className="dk-muted tl-small">{kindLabel(r.kind)}{r.unit ? ' · ' + r.unit : ''}</div></td>
                        <td className="is-num"><strong>{money(r.balanceDue, r.currency)}</strong></td>
                        <td className={r.daysOverdue > 0 ? 'pk-owe' : ''}>{dueText(r.daysOverdue)}<div className="dk-muted tl-small">{fmtDate(r.dueDate)}</div></td>
                        <td className="tl-small dk-muted"><LastSent last={r.lastReminder} countLabel={(n) => tr('{n} reminders so far', { n })} /></td>
                        <td><SendButtons row={r} smsAvailable={smsAvailable} sending={sender.sending} noPhoneLink={r.company === 'poki' ? '/pokitenants' : '/customers'}
                          cantSend={tr('Your role can see this bill but not send reminders for it.')} onWhatsApp={sendBill.whatsapp} onSms={sendBill.sms} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : !bvisible.length ? (
          <div className="dk-empty tl-empty"><p>{brows.length ? tr('No bookings match "{search}"', { search }) : tr('No bookings ending in the next {n} days.', { n: bookingDays })}</p></div>
        ) : view === 'cards' ? (
          <div className="tl-grid">
            {bvisible.map((r) => (
              <article key={r.key} className={'tl-card' + (r.daysLeft <= 7 ? ' st-low' : '')}>
                <div className="tl-card-open rm-static">
                  <Mark name={r.customerName} />
                  <span className="tl-card-head">
                    <span className="dk-muted tl-small">{r.bookingNo}</span>
                    <span className="tl-name">{r.customerName}</span>
                  </span>
                </div>
                <p className="dk-muted tl-small es-items">{r.unit}</p>
                <div className="tl-tags"><Status tone={r.daysLeft <= 7 ? 'warn' : 'info'}>{r.daysLeft === 0 ? tr('Ends today') : tr('Ends in {n} days', { n: r.daysLeft })}</Status></div>
                <p className="tl-small dk-muted rm-last"><LastSent last={r.lastNotice} countLabel={(n) => tr('{n} notices so far', { n })} /></p>
                <div className="tl-foot rm-foot">
                  <span className="tl-small">{fmtDate(r.endDate)}</span>
                  <SendButtons row={r} smsAvailable={smsAvailable} sending={sender.sending} noPhoneLink="/pokitenants"
                    cantSend={tr('Your role can see this booking but not contact the tenant about it.')}
                    onWhatsApp={(row) => sender.whatsapp('/reminders/bookings/' + row.bookingId + '/whatsapp', row)}
                    onSms={(row) => sender.sms('/reminders/bookings/' + row.bookingId + '/sms', row)} />
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="tl-table-wrap">
            <table className="tl-table">
              <thead><tr><th>{tr('Tenant')}</th><th>{tr('Booking')}</th><th>{tr('Ends')}</th><th>{tr('Last told')}</th><th /></tr></thead>
              <tbody>
                {bvisible.map((r) => (
                  <tr key={r.key}>
                    <td><span className="tl-name">{r.customerName}</span><div className="dk-muted tl-small">{r.phone || tr('No phone number')}</div></td>
                    <td>{r.unit}<div className="dk-muted tl-small">{r.bookingNo}</div></td>
                    <td className={r.daysLeft <= 7 ? 'pk-owe' : ''}>{r.daysLeft === 0 ? tr('Ends today') : tr('In {n} days', { n: r.daysLeft })}<div className="dk-muted tl-small">{fmtDate(r.endDate)}</div></td>
                    <td className="tl-small dk-muted"><LastSent last={r.lastNotice} countLabel={(n) => tr('{n} notices so far', { n })} /></td>
                    <td><SendButtons row={r} smsAvailable={smsAvailable} sending={sender.sending} noPhoneLink="/pokitenants"
                      cantSend={tr('Your role can see this booking but not contact the tenant about it.')}
                      onWhatsApp={(row) => sender.whatsapp('/reminders/bookings/' + row.bookingId + '/whatsapp', row)}
                      onSms={(row) => sender.sms('/reminders/bookings/' + row.bookingId + '/sms', row)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Glossary items={[
        [tr('WhatsApp'), tr('Opens WhatsApp in the person\'s chat with the reminder and a link to the bill already typed. You press send.')],
        [tr('Send text'), tr('Sends the reminder as a text message straight away, on the company\'s SMS credit.')],
        [tr('Automatic texts'), tr('When turned on in Company settings, the OS texts people itself before and after the due date, at most once per step.')],
        [tr('Not reminded this week'), tr('Overdue, and nobody has reminded them in the last seven days.')]
      ]} />

      {/* ── one bill ── */}
      {cur && (
        <div className="dialog-backdrop" onClick={() => setDetail(null)}>
          <div className="dialog tl-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="tl-detail-head">
              <Mark name={cur.customerName} size={56} />
              <div>
                <span className="dk-muted tl-small">{kindLabel(cur.kind)} · {cur.invoiceNo}</span>
                <h2>{cur.customerName}</h2>
                <div className="tl-tags"><Status tone={cur.daysOverdue > 0 ? 'bad' : 'warn'}>{dueText(cur.daysOverdue)}</Status></div>
              </div>
              <button type="button" className="tl-close" onClick={() => setDetail(null)} aria-label={tr('Close')}>×</button>
            </div>
            <dl className="tl-facts">
              <div><dt>{tr('Amount due')}</dt><dd><strong>{money(cur.balanceDue, cur.currency)}</strong></dd></div>
              <div><dt>{tr('Due')}</dt><dd>{fmtDate(cur.dueDate)}</dd></div>
              <div><dt>{tr('Phone')}</dt><dd>{cur.phone || '—'}</dd></div>
              {cur.contactPerson && <div><dt>{tr('Contact person')}</dt><dd>{cur.contactPerson}</dd></div>}
              {cur.unit && <div><dt>{tr('Unit')}</dt><dd>{cur.unit}</dd></div>}
            </dl>
            <h3 className="tl-h3">{tr('Reminders sent')}</h3>
            {history === null ? <p className="dk-muted tl-small">{tr('Loading…')}</p> : history.length ? (
              <ul className="rs-list rm-history">
                {history.map((h, i) => (
                  <li key={i} className="rs-row">
                    <div className="rs-row-open rm-hist">
                      <span className="rs-row-main">
                        <strong>{fmtDate(h.at)} · {howText(h)}{h.by ? ' · ' + h.by : ''}</strong>
                        <span className="dk-muted tl-small rm-msg">{h.message}</span>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : <p className="dk-muted tl-small">{tr('No reminders sent for this bill yet.')}</p>}
            <div className="dialog-actions tl-actions">
              {cur.company !== 'poki' && <Link className="btn btn-secondary" to={'/invoices?open=' + cur.invoiceId}>{tr('Open {no}', { no: cur.invoiceNo })}</Link>}
              <SendButtons row={cur} smsAvailable={smsAvailable} sending={sender.sending} noPhoneLink={cur.company === 'poki' ? '/pokitenants' : '/customers'}
                cantSend={tr('Your role can see this bill but not send reminders for it.')} onWhatsApp={sendBill.whatsapp} onSms={sendBill.sms} />
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
