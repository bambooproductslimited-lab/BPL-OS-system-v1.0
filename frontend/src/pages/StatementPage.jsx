import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, API_ORIGIN } from '../api/client';
import { money } from '../lib/currency';
import { docTr, DOCUMENT_INTL_LOCALE } from '../lib/i18n.jsx';
import { AgeingBar } from './StatementsPage';
import './StatementsPage.css';

// A customer's statement of account behind its link (online.bplghana.com/
// statement/<link>; statements.service.js publicView): what they owe and
// how old it is, every invoice, payment and credit note with the running
// balance, and a Pay now on each invoice still open. Like a shared document
// (SharePage.jsx) it is in the company's document language.

function dayText(d) { return d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString(DOCUMENT_INTL_LOCALE, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—'; }
const KIND = { invoice: '🧾', payment: '💰', credit: '↩️', refund: '💸' };

export default function StatementPage() {
  const { token } = useParams();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api.get('/statement/' + token).then(setD).catch((e) => setError(e.message)); }, [token]);
  if (error) return <div className="stm-pub"><p className="stm-wait">{error}</p></div>;
  if (!d) return <div className="stm-pub"><p className="stm-wait">{docTr('Loading…')}</p></div>;
  const cur = d.currency;
  return (
    <div className="stm-pub">
      <div className="stm-pub-card">
        <header className="stm-pub-head">
          <div>
            <h1>{docTr('Statement of account')}</h1>
            <p>{d.customer.name} · {dayText(d.from)} – {dayText(d.to)}</p>
          </div>
          <div className="stm-pub-from"><b>{d.company.name}</b>{d.company.lines.slice(0, 3).map((l, i) => <span key={i}>{l}<br /></span>)}</div>
        </header>
        <div className={'stm-pub-owed' + (d.overdue > 0 ? ' is-late' : d.owed > 0 ? '' : ' is-clear')}>
          <span><small>{d.owed > 0 ? docTr('You owe') : docTr('All paid — thank you')}</small><b>{money(d.owed, cur)}</b></span>
          {d.overdue > 0 && <span className="stm-pill">⏰ {docTr('{amount} overdue', { amount: money(d.overdue, cur) })}</span>}
        </div>
        <AgeingBar ageing={d.ageing} currency={cur} t={docTr} />
        {d.open.length > 0 && (
          <div className="stm-open">
            <h3>{docTr('Invoices to pay')}</h3>
            {d.open.map((o) => (
              <span key={o.invoiceNo} className={'stm-open-row' + (o.daysOverdue > 0 ? ' is-late' : '')}>
                <b>{o.invoiceNo}</b><span>{docTr('due {date}', { date: dayText(o.dueDate) })}{o.daysOverdue > 0 ? ' · ' + (o.daysOverdue === 1 ? docTr('1 day late') : docTr('{n} days late', { n: o.daysOverdue })) : ''}</span>
                <b className="num">{money(o.balance, cur)}</b>
                {o.url && <a href={o.url}>{docTr('Pay now')} →</a>}
              </span>
            ))}
          </div>
        )}
        <div className="stm-table-wrap">
          <table className="stm-table">
            <thead><tr><th>{docTr('Date')}</th><th>{docTr('Details')}</th><th className="num">{docTr('Charged')}</th><th className="num">{docTr('Paid')}</th><th className="num">{docTr('Balance')}</th></tr></thead>
            <tbody>
              <tr className="is-bf"><td>{dayText(d.from)}</td><td>{docTr('Balance brought forward')}</td><td /><td /><td className="num">{money(d.opening, cur)}</td></tr>
              {d.lines.map((l, i) => (
                <tr key={i} className={'is-' + l.kind}>
                  <td>{dayText(l.date)}</td>
                  <td><em aria-hidden="true">{KIND[l.kind]}</em> <b>{l.kind === 'invoice' ? l.ref : ''}</b> {l.kind === 'invoice' ? (l.dueDate ? docTr('due {date}', { date: dayText(l.dueDate) }) : '') : l.text}</td>
                  <td className="num">{l.debit ? money(l.debit, cur) : ''}</td>
                  <td className="num">{l.credit ? money(l.credit, cur) : ''}</td>
                  <td className="num"><b>{money(l.balance, cur)}</b></td>
                </tr>
              ))}
              {!d.lines.length && <tr><td colSpan={5} className="stm-none">{docTr('Nothing in this period.')}</td></tr>}
            </tbody>
            <tfoot><tr><td colSpan={4}>{docTr('Balance at {date}', { date: dayText(d.to) })}</td><td className="num"><b>{money(d.closing, cur)}</b></td></tr></tfoot>
          </table>
        </div>
        <div className="stm-pub-actions">
          <a href={API_ORIGIN + d.pdf}>📄 {docTr('Download the PDF')}</a>
          <button type="button" onClick={() => window.print()}>🖨️ {docTr('Print')}</button>
        </div>
      </div>
      <p className="stm-pub-note">{docTr('This link works until {date}. Questions about your statement? Reply to our email or call us.', { date: dayText(d.expiresAt) })}</p>
    </div>
  );
}
