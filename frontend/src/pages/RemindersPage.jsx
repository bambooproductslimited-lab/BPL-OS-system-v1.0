import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { tr, activeIntlLocale } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels';
import { formatDate } from '../lib/dates';
import './RemindersPage.css';

// Payment reminders (backend reminders.service.js): every customer and tenant
// whose rent, utility bill or invoice is overdue or due soon, with a button
// that opens WhatsApp on this phone or computer, in their chat, with a
// polite reminder and a link to the bill already typed. The OS can't send
// WhatsApp messages by itself (that needs the paid WhatsApp Business API),
// so the person here presses send. Each reminder opened is recorded, so the
// list shows who was reminded when.

const WINDOWS = [3, 7, 14, 30];

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

export default function RemindersPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [windowDays, setWindowDays] = useState(7);
  const [search, setSearch] = useState('');
  const [company, setCompany] = useState('');
  const [sending, setSending] = useState(null);
  const [toast, setToast] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try { setData(await api.get('/reminders?days=' + windowDays)); } catch (err) { setError(err.message); }
  }, [windowDays]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const rows = useMemo(() => (data ? data.rows : []), [data]);
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

  async function send(row) {
    // Opened now, while the click still counts as the person's own action —
    // a window opened after waiting for the server is blocked as a pop-up.
    const win = window.open('', '_blank');
    setSending(row.invoiceId);
    setError(null);
    try {
      const r = await api.post('/reminders/' + row.invoiceId + '/whatsapp', { origin: window.location.origin });
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

  return (
    <div>
      <p className="reminders-intro">
        {tr('Everyone whose rent, utility bill or invoice is overdue or due soon. "Send on WhatsApp" opens WhatsApp with a polite reminder and a link to the bill already written — you press send. Each reminder is recorded here, so nobody is chased twice in a morning.')}
      </p>

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
                    {r.lastReminder ? (
                      <>
                        {agoText(r.lastReminder.at)}{r.lastReminder.by && <> · {r.lastReminder.by}</>}
                        {r.lastReminder.count > 1 && <div>{tr('{n} reminders so far', { n: r.lastReminder.count })}</div>}
                      </>
                    ) : tr('Not yet')}
                  </td>
                  <td className="reminders-action">
                    {!r.whatsapp ? (
                      <Link className="btn btn-secondary" to="/customers">{tr('Add phone number')}</Link>
                    ) : (
                      <button type="button" className="btn btn-primary reminders-wa" disabled={!r.canSend || sending === r.invoiceId}
                        title={r.canSend ? undefined : tr('Your role can see this bill but not send reminders for it.')}
                        onClick={() => send(r)}>
                        {sending === r.invoiceId ? tr('Opening…') : tr('Send on WhatsApp')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
