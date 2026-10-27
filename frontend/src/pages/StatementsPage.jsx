import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, API_URL } from '../api/client';
import { money } from '../lib/currency';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './StatementsPage.css';

// Customer statements (Quotations & Invoicing → Statements; backend
// statements.service.js, migration 0197): who owes us what and for how
// long, the most overdue first; a customer's statement of account — what
// they owed at the start, each invoice, payment and credit note with the
// running balance, how old what they owe is — sent by email with its PDF,
// on WhatsApp, or as a link; their credit limit and a statement every month.

function dayText(d) { return d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—'; }
function hue(name) { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function monthsBack(n) { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 10); }
const KIND = { invoice: '🧾', payment: '💰', credit: '↩️', refund: '💸' };
// How old what is owed is, newest to oldest: one hue, light to dark.
const AGE = [['current', msg('Not yet due')], ['d1to30', msg('1–30 days')], ['d31to60', msg('31–60 days')], ['d61to90', msg('61–90 days')], ['d90plus', msg('Over 90 days')]];

// t: the public statement passes docTr (the company's document language).
export function AgeingBar({ ageing, currency, labels = true, t = tr }) {
  const total = AGE.reduce((n, [k]) => n + (ageing[k] || 0), 0);
  return (
    <div className="stm-age">
      <div className="stm-age-bar" role="img" aria-label={AGE.map(([k, l]) => t(l) + ' ' + money(ageing[k] || 0, currency)).join(', ')}>
        {total > 0 ? AGE.map(([k], i) => ageing[k] > 0 && <i key={k} className={'is-' + i} style={{ flexGrow: ageing[k] }} title={t(AGE[i][1]) + ': ' + money(ageing[k], currency)} />) : <i className="is-none" />}
      </div>
      {labels && (
        <ul className="stm-age-legend">
          {AGE.map(([k, l], i) => <li key={k} className={ageing[k] > 0 ? '' : 'is-zero'}><i className={'is-' + i} aria-hidden="true" /><span>{t(l)}</span><b>{money(ageing[k] || 0, currency)}</b></li>)}
        </ul>
      )}
    </div>
  );
}

function SettingsForm({ st, onSaved, onCancel }) {
  const [limit, setLimit] = useState(st.customer.creditLimit == null ? '' : String(st.customer.creditLimit));
  const [monthly, setMonthly] = useState(!!st.customer.statementMonthly);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onSaved(await api.put('/statements/customers/' + st.customer.id, { creditLimit: limit === '' ? null : Number(limit), statementMonthly: monthly })); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <form className="stm-form" onSubmit={save}>
      <h3>⚙️ {tr('Credit and statements')}</h3>
      <label><span>{tr('Credit limit')}</span><input className="input" type="number" min="0" step="1" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder={tr('No limit')} />
        <small>{tr('An invoice that takes what they owe over it needs a second yes.')}</small></label>
      <label className="stm-switch"><input type="checkbox" checked={monthly} onChange={(e) => setMonthly(e.target.checked)} />
        <span><b>{tr('Email a statement every month')}</b><small>{st.customer.email ? tr('In the first days of the month, while they owe something, to {email}.', { email: st.customer.email }) : tr('Add an email address to the customer first.')}</small></span></label>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>{tr('Back')}</button>
        <button type="submit" className="btn btn-primary" disabled={busy}>{tr('Save')}</button>
      </div>
    </form>
  );
}

function StatementSheet({ id, onClose, onChanged }) {
  const [q, setQ] = useState({ from: monthsBack(5), currency: '' });
  const [st, setSt] = useState(null);
  const [mode, setMode] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => {
    const s = new URLSearchParams({ from: q.from });
    if (q.currency) s.set('currency', q.currency);
    return api.get('/statements/customers/' + id + '?' + s.toString()).then((d) => { setSt(d); setTo((t) => t || d.customer.email || ''); }).catch((e) => setError(e.message));
  }, [id, q]);
  useEffect(() => { load(); }, [load]);
  async function send(via) {
    setBusy(true); setError(null); setFlash(null);
    try {
      const r = await api.post('/statements/customers/' + id + '/send', { via, to: via === 'email' ? to : undefined, from: q.from, currency: st.currency });
      if (r.whatsappUrl) { window.open(r.whatsappUrl, '_blank', 'noopener'); setFlash('💬 ' + tr('WhatsApp opened with the statement\'s link.')); }
      else setFlash('✉️ ' + tr('Statement emailed to {to}, with its PDF.', { to: r.to }));
      setMode(''); load(); onChanged();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function copyLink() {
    setBusy(true); setError(null);
    try {
      const r = await api.post('/statements/customers/' + id + '/link', { from: q.from, currency: st.currency });
      try { await navigator.clipboard.writeText(r.url); setFlash('🔗 ' + tr('Link copied: it works for 30 days.')); } catch { setFlash('🔗 ' + r.url); }
      load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function pdf() {
    const s = new URLSearchParams({ from: q.from });
    if (st.currency) s.set('currency', st.currency);
    const res = await fetch(API_URL + '/statements/customers/' + id + '/pdf?' + s.toString(), { headers: api.authHeaders() });
    if (!res.ok) { setError(tr('The PDF could not be made.')); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await res.blob());
    a.download = 'statement-' + st.customer.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + st.to + '.pdf';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog stm-sheet" role="dialog" aria-modal="true" aria-labelledby="stm-title" onClick={(e) => e.stopPropagation()}>
        {!st ? <p className="stm-wait">{error || tr('Loading…')}</p> : (
          <>
            <div className={'stm-hero' + (st.overdue > 0 ? ' is-late' : st.owed > 0 ? '' : ' is-clear')}>
              <span className="stm-avatar" style={{ '--h': hue(st.customer.name) }} aria-hidden="true">{st.customer.name.charAt(0).toUpperCase()}</span>
              <div>
                <small>{tr('Statement of account')} · {dayText(st.from)} – {dayText(st.to)}</small>
                <h2 id="stm-title">{st.customer.name}</h2>
                <p><b>{money(st.owed, st.currency)}</b> {tr('owed')}{st.overdue > 0 && <span className="stm-pill">⏰ {tr('{amount} overdue', { amount: money(st.overdue, st.currency) })}</span>}{st.credit.over && <span className="stm-pill">🚫 {tr('Over the credit limit')}</span>}</p>
              </div>
              <button type="button" className="stm-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
            </div>
            <div className="stm-bar">
              <div className="stm-seg" role="group" aria-label={tr('Period')}>
                {[[2, tr('3 months')], [5, tr('6 months')], [11, tr('12 months')], [35, tr('3 years')]].map(([n, l]) => <button key={n} type="button" className={q.from === monthsBack(n) ? 'is-on' : ''} onClick={() => setQ({ ...q, from: monthsBack(n) })}>{l}</button>)}
              </div>
              {st.currencies.length > 1 && <select className="input stm-cur" value={st.currency} onChange={(e) => setQ({ ...q, currency: e.target.value })} aria-label={tr('Currency')}>{st.currencies.map((c) => <option key={c} value={c}>{c}</option>)}</select>}
            </div>
            <div className="stm-cards">
              <span><small>{tr('Brought forward')}</small><b>{money(st.opening, st.currency)}</b></span>
              <span><small>{tr('Invoiced')}</small><b>{money(st.totals.invoiced, st.currency)}</b></span>
              <span><small>{tr('Paid')}</small><b>{money(st.totals.paid, st.currency)}</b></span>
              <span className={st.credit.over ? 'is-bad' : ''}><small>{tr('Credit limit')}</small><b>{st.credit.limit == null ? tr('None') : money(st.credit.limit, st.currency)}</b>{st.credit.limit != null && <i>{st.credit.available < 0 ? tr('{amount} over', { amount: money(-st.credit.available, st.currency) }) : tr('{amount} left', { amount: money(st.credit.available, st.currency) })}</i>}</span>
            </div>
            <AgeingBar ageing={st.ageing} currency={st.currency} />
            <div className="stm-table-wrap">
              <table className="stm-table">
                <thead><tr><th>{tr('Date')}</th><th>{tr('Details')}</th><th className="num">{tr('Charged')}</th><th className="num">{tr('Paid')}</th><th className="num">{tr('Balance')}</th></tr></thead>
                <tbody>
                  <tr className="is-bf"><td>{dayText(st.from)}</td><td>{tr('Balance brought forward')}</td><td /><td /><td className="num">{money(st.opening, st.currency)}</td></tr>
                  {st.lines.map((l, i) => (
                    <tr key={i} className={'is-' + l.kind}>
                      <td>{dayText(l.date)}</td>
                      <td><em aria-hidden="true">{KIND[l.kind]}</em> <b>{l.kind === 'invoice' ? l.ref : ''}</b> {l.kind === 'invoice' ? (l.dueDate ? tr('due {date}', { date: dayText(l.dueDate) }) : '') : l.text}</td>
                      <td className="num">{l.debit ? money(l.debit, st.currency) : ''}</td>
                      <td className="num">{l.credit ? money(l.credit, st.currency) : ''}</td>
                      <td className="num"><b>{money(l.balance, st.currency)}</b></td>
                    </tr>
                  ))}
                  {!st.lines.length && <tr><td colSpan={5} className="stm-none">{tr('Nothing in this period.')}</td></tr>}
                </tbody>
                <tfoot><tr><td colSpan={4}>{tr('Balance at {date}', { date: dayText(st.to) })}</td><td className="num"><b>{money(st.closing, st.currency)}</b></td></tr></tfoot>
              </table>
            </div>
            {st.open.length > 0 && (
              <div className="stm-open">
                <h3>{tr('Still open')}</h3>
                {st.open.map((o) => (
                  <span key={o.id} className={'stm-open-row' + (o.daysOverdue > 0 ? ' is-late' : '')}>
                    <b>{o.invoiceNo}</b><span>{tr('due {date}', { date: dayText(o.dueDate) })}</span>
                    <i>{o.daysOverdue > 0 ? (o.daysOverdue === 1 ? tr('1 day late') : tr('{n} days late', { n: o.daysOverdue })) : tr('Not yet due')}</i>
                    <b className="num">{money(o.balance, st.currency)}</b>
                  </span>
                ))}
              </div>
            )}
            {flash && <div className="stm-flash" role="status">{flash}</div>}
            {error && <div className="error-banner" role="alert">{error}</div>}
            {mode === 'email' && (
              <form className="stm-form" onSubmit={(e) => { e.preventDefault(); send('email'); }}>
                <h3>✉️ {tr('Email the statement')}</h3>
                <label><span>{tr('To')}</span><input className="input" type="email" required value={to} onChange={(e) => setTo(e.target.value)} /></label>
                <div className="dialog-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setMode('')}>{tr('Back')}</button>
                  <button type="submit" className="btn btn-primary" disabled={busy}>{tr('Send with the PDF')}</button>
                </div>
              </form>
            )}
            {mode === 'settings' && <SettingsForm st={st} onCancel={() => setMode('')} onSaved={(d) => { setSt(d); setMode(''); setFlash('✅ ' + tr('Saved.')); onChanged(); }} />}
            {!mode && (
              <div className="stm-actions">
                {st.canManage && <button type="button" className="btn btn-primary" onClick={() => setMode('email')}>✉️ {tr('Email')}</button>}
                {st.canManage && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => send('whatsapp')}>💬 WhatsApp</button>}
                {st.canManage && <button type="button" className="btn btn-secondary" disabled={busy} onClick={copyLink}>🔗 {tr('Copy the link')}</button>}
                <button type="button" className="btn btn-secondary" onClick={pdf}>📄 PDF</button>
                {st.canManage && <button type="button" className="btn btn-secondary stm-gear" onClick={() => setMode('settings')}>⚙️ {tr('Credit and statements')}</button>}
              </div>
            )}
            {st.sends.length > 0 && (
              <p className="stm-sends">{tr('Last sent')}: {st.sends.slice(0, 3).map((s) => (s.channel === 'email' ? '✉️ ' : s.channel === 'whatsapp' ? '💬 ' : '🔗 ') + new Date(s.at).toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short' }) + (s.automatic ? ' (' + tr('monthly') + ')' : '')).join(' · ')}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function StatementsPage() {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [only, setOnly] = useState('owing');
  const load = useCallback(() => api.get('/statements').then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const openId = params.get('customer');
  const open = (id) => setParams((p) => { const n = new URLSearchParams(p); if (id) n.set('customer', id); else n.delete('customer'); return n; });
  if (!data) return <div className="stm"><p className="stm-wait">{error || tr('Loading…')}</p></div>;
  const s = data.summary;
  const words = q.trim().toLowerCase();
  const list = data.customers.filter((c) => (only === 'owing' ? c.owed > 0 : only === 'overdue' ? c.overdue > 0 : only === 'limit' ? c.creditLimit != null : true) && (!words || c.name.toLowerCase().includes(words)));
  return (
    <div className="stm">
      <header className="stm-head">
        <div>
          <h1>📒 {tr('Customer statements')}</h1>
          <p>{tr('Who owes us what and for how long. Open a customer for their statement of account: send it, set a credit limit, or a statement every month.')}</p>
        </div>
      </header>
      <div className="stm-tiles">
        <div className="stm-tile is-calm"><small>💰 {tr('Owed to us')}</small><b>{money(s.owed, 'GHS')}</b><span>{s.customers === 1 ? tr('1 customer') : tr('{n} customers', { n: s.customers })}</span></div>
        <div className="stm-tile is-warn"><small>⏰ {tr('Overdue')}</small><b>{money(s.overdue, 'GHS')}</b><span>{s.owed ? tr('{n}% of what is owed', { n: Math.round(s.overdue / s.owed * 100) }) : '—'}</span></div>
        <div className="stm-tile is-bad"><small>🕰️ {tr('Over 60 days')}</small><b>{money(s.old, 'GHS')}</b><span>{tr('the hardest to collect')}</span></div>
        <div className="stm-tile is-violet"><small>🚫 {tr('Over their limit')}</small><b>{s.overLimit}</b><span>{tr('{n} sent a statement monthly', { n: s.monthly })}</span></div>
      </div>
      <div className="stm-tools">
        <div className="stm-seg" role="tablist">
          {[['owing', tr('Owing')], ['overdue', tr('Overdue')], ['limit', tr('With a limit')], ['all', tr('All')]].map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={only === k} className={only === k ? 'is-on' : ''} onClick={() => setOnly(k)}>{l}</button>)}
        </div>
        <input className="input stm-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Search a customer')} aria-label={tr('Search')} />
      </div>
      {!list.length ? <div className="stm-empty"><span aria-hidden="true">🌴</span><p>{tr('Nobody owes anything here.')}</p></div> : (
        <div className="stm-list">
          {list.map((c) => {
            const fresh = Math.max(0, c.owed - c.overdue), mid = Math.max(0, c.overdue - c.old);
            return (
              <button key={c.id} type="button" className={'stm-row' + (c.over ? ' is-over' : c.overdue > 0 ? ' is-late' : '')} onClick={() => open(c.id)}>
                <span className="stm-avatar" style={{ '--h': hue(c.name) }} aria-hidden="true">{c.name.charAt(0).toUpperCase()}</span>
                <span className="stm-who">
                  <b>{c.name}</b>
                  <small>{c.open === 1 ? tr('1 open invoice') : tr('{n} open invoices', { n: c.open })}{c.daysOverdue > 0 ? ' · ' + tr('oldest {n} days late', { n: c.daysOverdue }) : ''}{c.lastPaid ? ' · ' + tr('last paid {date}', { date: dayText(c.lastPaid) }) : ''}</small>
                  {c.owed > 0 && (
                    <span className="stm-mini" role="img" aria-label={tr('Not yet due') + ' ' + money(fresh, c.currency) + ', ' + tr('overdue') + ' ' + money(c.overdue, c.currency)}>
                      {fresh > 0 && <i className="is-0" style={{ flexGrow: fresh }} />}{mid > 0 && <i className="is-2" style={{ flexGrow: mid }} />}{c.old > 0 && <i className="is-4" style={{ flexGrow: c.old }} />}
                    </span>
                  )}
                </span>
                <span className="stm-tags">
                  {c.monthly && <i className="is-month">📅 {tr('Monthly')}</i>}
                  {c.creditLimit != null && <i className={c.over ? 'is-over' : ''}>{c.over ? '🚫 ' : ''}{tr('{n}% of limit', { n: c.used })}</i>}
                </span>
                <span className="stm-money"><b>{money(c.owed, c.currency)}</b>{c.overdue > 0 && <small>{tr('{amount} overdue', { amount: money(c.overdue, c.currency) })}</small>}</span>
              </button>
            );
          })}
        </div>
      )}
      {openId && <StatementSheet key={openId} id={openId} onClose={() => open(null)} onChanged={load} />}
    </div>
  );
}
