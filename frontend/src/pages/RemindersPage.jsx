import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { tr, activeIntlLocale } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels';
import { formatDate } from '../lib/dates';
import './RemindersPage.css';

// Payment reminders (backend reminders.service.js): every customer and tenant
// whose rent, utility bill or invoice is overdue or due soon — and, on the
// second tab, every Poki tenant whose booking is ending. Each row has two
// ways to reach them:
//   - WhatsApp: opens WhatsApp on this phone or computer, in their chat,
//     with the message (and a link to the bill) already typed. The OS can't
//     send WhatsApp messages by itself, so the person here presses send.
//   - Text: sent at once through the company's mNotify account (shown only
//     when that is set up), after a confirm, since it uses credit.
// Every reminder is recorded, so the list shows who was reminded, when, how.

const WINDOWS = [3, 7, 14, 30];
const BOOKING_WINDOWS = [30, 60, 90];

function money(currency, amount) {
  return currency + ' ' + Number(amount).toLocaleString(activeIntlLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function dueText(days) {
  if (days > 0) return tr('{n} days overdue', { n: days });
  if (days === 0) return tr('Due today');
  return tr('Due in {n} days', { n: -days });
}

function agoText(at) {
  const mins = Math.round((Date.now() - new Date(at).getTime()) / 60000);
  if (mins < 60) return tr('{n} min ago', { n: Math.max(1, mins) });
  const hours = Math.round(mins / 60);
  if (hours < 24) return tr('{n} h ago', { n: hours });
  return tr('{n} days ago', { n: Math.round(hours / 24) });
}

function howText(last) {
  if (last.automatic) return tr('automatic text');
  return last.channel === 'sms' ? tr('by text') : tr('on WhatsApp');
}

// "Reminded 2 h ago · by text · Ama Mensah", or "Not yet".
function LastSent({ last, countLabel }) {
  if (!last) return tr('Not yet');
  return (
    <>
      {agoText(last.at)} · {howText(last)}{last.by && <> · {last.by}</>}
      {last.count > 1 && <div>{countLabel(last.count)}</div>}
    </>
  );
}

// The two buttons, or the reason there are none.
function SendButtons({ row, smsAvailable, sending, onWhatsApp, onSms, noPhoneLink, cantSend }) {
  if (!row.whatsapp) {
    return <Link className="btn btn-secondary" to={noPhoneLink}>{tr('Add phone number')}</Link>;
  }
  return (
    <div className="reminders-buttons">
      <button type="button" className="btn btn-primary reminders-wa" disabled={!row.canSend || !!sending}
        title={row.canSend ? undefined : cantSend} onClick={() => onWhatsApp(row)}>
        {sending === row.key ? tr('Opening…') : tr('WhatsApp')}
      </button>
      {smsAvailable && (
        <button type="button" className="btn btn-secondary" disabled={!row.canSend || !!sending}
          title={row.canSend ? undefined : cantSend} onClick={() => onSms(row)}>
          {sending === row.key + ':sms' ? tr('Sending…') : tr('Send text')}
        </button>
      )}
    </div>
  );
}

// Shared by both tabs: open WhatsApp, or text after a confirm.
function useSender(load, setError, setToast) {
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
      await load();
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
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(null);
    }
  }

  return { sending, whatsapp, sms };
}

function BillsTab({ setToast }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [windowDays, setWindowDays] = useState(7);
  const [search, setSearch] = useState('');
  const [company, setCompany] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try { setData(await api.get('/reminders?days=' + windowDays)); } catch (err) { setError(err.message); }
  }, [windowDays]);
  useEffect(() => { load(); }, [load]);
  const sender = useSender(load, setError, setToast);

  const rows = useMemo(() => (data ? data.rows.map((r) => ({ ...r, key: r.invoiceId })) : []), [data]);
  const companies = useMemo(() => Array.from(new Set(rows.map((r) => r.company))), [rows]);
  const visible = rows.filter((r) => (!company || r.company === company) &&
    matchesQuery(search, r.customerName, r.contactPerson, r.invoiceNo, r.unit, r.phone));
  const overdue = visible.filter((r) => r.daysOverdue > 0);
  const soon = visible.filter((r) => r.daysOverdue <= 0);
  const totals = (list) => {
    const t = {};
    list.forEach((r) => { t[r.currency] = (t[r.currency] || 0) + r.balanceDue; });
    return Object.keys(t).map((c) => money(c, t[c])).join(' + ') || money('GHS', 0);
  };

  return (
    <>
      <div className="reminders-toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder={tr('Search customers, bills, units…')} />
        <select className="input reminders-select" value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value))} aria-label={tr('Due within')}>
          {WINDOWS.map((d) => <option key={d} value={d}>{tr('Overdue or due within {n} days', { n: d })}</option>)}
        </select>
        {companies.length > 1 && (
          <select className="input reminders-select" value={company} onChange={(e) => setCompany(e.target.value)} aria-label={tr('Company')}>
            <option value="">{tr('Both companies')}</option>
            <option value="bpl">Bamboo Products</option>
            <option value="poki">Poki Properties</option>
          </select>
        )}
      </div>

      {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}

      {data && (
        <div className="reminders-summary">
          <div className="reminders-stat reminders-stat-overdue">
            <span className="reminders-stat-n">{overdue.length}</span>
            <span>{tr('overdue')} · {totals(overdue)}</span>
          </div>
          <div className="reminders-stat">
            <span className="reminders-stat-n">{soon.length}</span>
            <span>{tr('due soon')} · {totals(soon)}</span>
          </div>
        </div>
      )}

      {!data ? (
        !error && <p className="reminders-note">{tr('Loading…')}</p>
      ) : !visible.length ? (
        <p className="reminders-note">{rows.length ? tr('No bills match "{search}"', { search }) : tr('Nothing overdue or due soon. 🎉')}</p>
      ) : (
        <div className="reminders-scroll">
          <table className="table reminders-table">
            <thead>
              <tr>
                <th>{tr('Customer')}</th>
                <th>{tr('Bill')}</th>
                <th className="reminders-num">{tr('Amount due')}</th>
                <th>{tr('Due')}</th>
                <th>{tr('Last reminded')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.invoiceId} className={r.daysOverdue > 0 ? 'is-overdue' : undefined}>
                  <td>
                    <div className="reminders-name">{r.customerName}</div>
                    <div className="reminders-meta">
                      {r.phone || <span className="reminders-missing">{tr('No phone number')}</span>}
                      {r.unit && <> · {r.unit}</>}
                    </div>
                  </td>
                  <td>
                    <div>{r.invoiceNo}</div>
                    <div className="reminders-meta">{codeLabel(r.kind)} · {r.company === 'poki' ? 'Poki' : 'Bamboo Products'}</div>
                  </td>
                  <td className="reminders-num"><strong>{money(r.currency, r.balanceDue)}</strong></td>
                  <td>
                    <div className={r.daysOverdue > 0 ? 'reminders-overdue' : undefined}>{dueText(r.daysOverdue)}</div>
                    <div className="reminders-meta">{formatDate(r.dueDate)}</div>
                  </td>
                  <td className="reminders-meta">
                    <LastSent last={r.lastReminder} countLabel={(n) => tr('{n} reminders so far', { n })} />
                  </td>
                  <td className="reminders-action">
                    <SendButtons row={r} smsAvailable={data.smsAvailable} sending={sender.sending} noPhoneLink="/customers"
                      cantSend={tr('Your role can see this bill but not send reminders for it.')}
                      onWhatsApp={(row) => sender.whatsapp('/reminders/' + row.invoiceId + '/whatsapp', row)}
                      onSms={(row) => sender.sms('/reminders/' + row.invoiceId + '/sms', row)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function BookingsTab({ setToast }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [windowDays, setWindowDays] = useState(60);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try { setData(await api.get('/reminders/bookings?days=' + windowDays)); } catch (err) { setError(err.message); }
  }, [windowDays]);
  useEffect(() => { load(); }, [load]);
  const sender = useSender(load, setError, setToast);

  const rows = useMemo(() => (data ? data.rows.map((r) => ({ ...r, key: r.bookingId })) : []), [data]);
  const visible = rows.filter((r) => matchesQuery(search, r.customerName, r.contactPerson, r.bookingNo, r.unit, r.phone));

  return (
    <>
      <div className="reminders-toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder={tr('Search tenants, bookings, units…')} />
        <select className="input reminders-select" value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value))} aria-label={tr('Ending within')}>
          {BOOKING_WINDOWS.map((d) => <option key={d} value={d}>{tr('Ending within {n} days', { n: d })}</option>)}
        </select>
      </div>

      {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}

      {!data ? (
        !error && <p className="reminders-note">{tr('Loading…')}</p>
      ) : !visible.length ? (
        <p className="reminders-note">{rows.length ? tr('No bookings match "{search}"', { search }) : tr('No bookings ending in the next {n} days.', { n: windowDays })}</p>
      ) : (
        <div className="reminders-scroll">
          <table className="table reminders-table">
            <thead>
              <tr>
                <th>{tr('Tenant')}</th>
                <th>{tr('Booking')}</th>
                <th>{tr('Ends')}</th>
                <th>{tr('Last told')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.bookingId}>
                  <td>
                    <div className="reminders-name">{r.customerName}</div>
                    <div className="reminders-meta">{r.phone || <span className="reminders-missing">{tr('No phone number')}</span>}</div>
                  </td>
                  <td>
                    <div>{r.unit}</div>
                    <div className="reminders-meta">{r.bookingNo}</div>
                  </td>
                  <td>
                    <div className={r.daysLeft <= 7 ? 'reminders-overdue' : undefined}>
                      {r.daysLeft === 0 ? tr('Ends today') : tr('In {n} days', { n: r.daysLeft })}
                    </div>
                    <div className="reminders-meta">{formatDate(r.endDate)}</div>
                  </td>
                  <td className="reminders-meta">
                    <LastSent last={r.lastNotice} countLabel={(n) => tr('{n} notices so far', { n })} />
                  </td>
                  <td className="reminders-action">
                    <SendButtons row={r} smsAvailable={data.smsAvailable} sending={sender.sending} noPhoneLink="/pokitenants"
                      cantSend={tr('Your role can see this booking but not contact the tenant about it.')}
                      onWhatsApp={(row) => sender.whatsapp('/reminders/bookings/' + row.bookingId + '/whatsapp', row)}
                      onSms={(row) => sender.sms('/reminders/bookings/' + row.bookingId + '/sms', row)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export default function RemindersPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState('bills');
  const [toast, setToast] = useState(null);
  const showBookings = can('poki.read') || can('poki.manage');

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <div>
      <p className="reminders-intro">
        {tr('Everyone whose rent, utility bill or invoice is overdue or due soon. "WhatsApp" opens WhatsApp with a polite reminder and a link to the bill already written — you press send. "Send text" texts it straight away through the company\'s SMS account. Each reminder is recorded here, so nobody is chased twice in a morning.')}
      </p>

      {showBookings && (
        <div className="seg reminders-tabs">
          {[{ key: 'bills', label: tr('Bills') }, { key: 'bookings', label: tr('Bookings ending') }].map((opt) => (
            <label className="seg-opt" key={opt.key}>
              <input type="radio" name="reminders-tab" checked={tab === opt.key} onChange={() => setTab(opt.key)} />
              <span>{opt.label}</span>
            </label>
          ))}
        </div>
      )}

      {tab === 'bookings' && showBookings ? <BookingsTab setToast={setToast} /> : <BillsTab setToast={setToast} />}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
