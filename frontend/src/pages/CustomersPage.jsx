import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import ContactButtons from '../components/ContactButtons';
import Photo from '../components/Photo';
import RowMenu from '../components/RowMenu';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { Glossary, Hero, Insights, Section, Status, avatarColor, fmtDate, initials, jump } from '../components/DashKit';
import { money, moneyBreakdown } from '../lib/currency';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels.js';
import './EmployeesPage.css';
import './ToolRoomPage.css';
import './RestaurantsPage.css';
import './PokiRentals.css';
import './CustomersPage.css';

// Clients — the companies and people Bamboo Products quotes and invoices.
// Same "explains itself" layout as the dashboards (components/DashKit.jsx):
// the key numbers (clients buying, owed and overdue, quotations waiting for
// an answer, paid in the last twelve months), what stands out (who owes
// most and for how long, quotations out, good clients gone quiet, leads
// never quoted), the clients along the path from lead to VIP, and the
// clients as cards or a list — each with what they owe, a call or WhatsApp
// button and a window with everything done with them
// (customers.service.js list and activity).

const CATEGORIES = [
  { key: 'lead', label: msg('Lead') }, { key: 'prospect', label: msg('Prospect') }, { key: 'active', label: msg('Active') },
  { key: 'vip', label: msg('VIP') }, { key: 'inactive', label: msg('Inactive') }
];
const EMPTY_FORM = { name: '', contactPerson: '', email: '', phone: '', address: '', category: 'lead', accountManagerId: '', notes: '', preferredCurrency: 'GHS', taxId: '', paymentTerms: 'Net 30' };
const QUIET_DAYS = 120;
const KIND_LABELS = { estimate: msg('Estimate'), quotation: msg('Quotation'), invoice: msg('Invoice'), payment: msg('Payment') };

function readPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* remembered for this visit only */ } }
function daysSince(iso) {
  if (!iso) return null;
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((t - new Date(String(iso).slice(0, 10) + 'T00:00')) / 86400000);
}
function catLabel(c) { return tr((CATEGORIES.find((x) => x.key === c) || CATEGORIES[0]).label); }
function owes(c) { return c.outstanding && c.outstanding.length > 0; }
function isBuying(c) { return c.category === 'active' || c.category === 'vip'; }
function Mark({ c, size = 44 }) {
  return <span className="pk-avatar cu-mark" style={{ width: size, height: size, background: avatarColor(c.name), fontSize: Math.round(size * 0.34) }} aria-hidden="true">{initials(c.name)}</span>;
}

export default function CustomersPage() {
  const { can } = useAuth();
  const canManage = can('customer.manage');

  const [customers, setCustomers] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [currencies, setCurrencies] = useState(['GHS']);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [search, setSearch] = useState('');
  const [chip, setChip] = useState('all');
  const [stage, setStage] = useState('');
  const [view, setView] = useState(() => readPref('bos.clientsView', 'cards'));

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [dialogError, setDialogError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [detail, setDetail] = useState(null);
  const [activity, setActivity] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setCustomers(await api.get('/customers'));
      if (canManage) setEmployees(await api.get('/employees').catch(() => []));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
    try {
      const settings = await api.get('/settings');
      if (settings.commercial && settings.commercial.currencies) setCurrencies(settings.commercial.currencies);
    } catch { /* falls back to GHS only */ }
  }, [canManage]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    setActivity(null);
    if (!detail) return;
    api.get('/customers/' + detail + '/activity').then(setActivity).catch(() => setActivity([]));
  }, [detail]);

  function openNew(category) {
    setDialogError(null);
    setEditId(null);
    setForm({ ...EMPTY_FORM, category: category || 'lead' });
    setDialogOpen(true);
  }
  function openEdit(c) {
    setDialogError(null);
    setEditId(c.id);
    setForm({
      name: c.name, contactPerson: c.contactPerson || '', email: c.email || '', phone: c.phone || '',
      address: c.address || '', category: c.category, accountManagerId: c.accountManagerId || '', notes: c.notes || '',
      preferredCurrency: c.preferredCurrency || 'GHS', taxId: c.taxId || '', paymentTerms: c.paymentTerms || 'Net 30'
    });
    setDetail(null);
    setDialogOpen(true);
  }
  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      if (editId) await api.put('/customers/' + editId, form);
      else await api.post('/customers', form);
      setToast(editId ? tr('Customer updated.') : tr('Customer added.'));
      setDialogOpen(false);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }
  async function setCategory(c, category) {
    try {
      await api.post('/customers/' + c.id + '/category', { category });
      setToast(tr('{name} is now {category}.', { name: c.name, category: catLabel(category) }));
      await load();
    } catch (err) { setError(err.message); }
  }
  async function confirmDelete() {
    setDeleting(true);
    try {
      await api.del('/customers/' + deleteTarget.id);
      setToast(tr('{name} deleted.', { name: deleteTarget.name }));
      setDeleteTarget(null);
      setDetail(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const buying = customers.filter(isBuying);
  const owing = customers.filter(owes);
  const behind = customers.filter((c) => c.overdue && c.overdue.length).sort((x, y) => y.daysOverdue - x.daysOverdue);
  const waiting = customers.filter((c) => c.openQuotes > 0);
  const quiet = buying.filter((c) => c.lastActivity && daysSince(c.lastActivity) >= QUIET_DAYS && !owes(c));
  const neverQuoted = customers.filter((c) => (c.category === 'lead' || c.category === 'prospect') && !c.quotedTotals.length && !c.invoiceCount);
  const sum = (list, key) => { const m = {}; list.forEach((c) => (c[key] || []).forEach((o) => { m[o.currency] = (m[o.currency] || 0) + o.amount; })); return Object.entries(m).map(([currency, amount]) => ({ currency, amount })); };
  const owedAll = sum(owing, 'outstanding');
  const overdueAll = sum(behind, 'overdue');
  const paidAll = sum(customers, 'paid12');
  const top = customers.filter((c) => c.paid12 && c.paid12.length).sort((x, y) => (y.paid12[0] ? y.paid12[0].amount : 0) - (x.paid12[0] ? x.paid12[0].amount : 0));

  function showOnly(key) { setStage(''); setChip(chip === key ? 'all' : key); jump('cu-list'); }
  const stats = [
    { icon: 'people', value: String(buying.length), label: tr('clients buying'), note: tr('{n} on file in all', { n: customers.length }), onClick: () => { setChip('all'); setStage('active'); jump('cu-list'); } },
    { icon: 'owed', value: moneyBreakdown(owedAll, money(0)), label: tr('owed by clients'), note: overdueAll.length ? tr('{amount} of it overdue', { amount: moneyBreakdown(overdueAll) }) : tr('nothing past its due date'), tone: behind.length ? 'bad' : '', onClick: () => showOnly(behind.length ? 'behind' : 'owing') },
    { icon: 'doc', value: String(waiting.length), label: tr('waiting on a quotation'), note: tr('sent and not yet answered'), onClick: () => showOnly('quoted') },
    { icon: 'cash', value: moneyBreakdown(paidAll, money(0)), label: tr('paid in the last 12 months'), note: top.length ? tr('most from {name}', { name: top[0].name }) : tr('nothing paid yet'), tone: paidAll.length ? 'good' : '', onClick: () => showOnly('paid') }
  ];

  const insights = [];
  if (behind.length) insights.push({ tone: 'bad', icon: 'owed', text: behind.length === 1 ? tr('{name} owes {amount}, {days} days overdue.', { name: behind[0].name, amount: moneyBreakdown(behind[0].overdue), days: behind[0].daysOverdue }) : tr('{n} clients are overdue; {name} the longest, {days} days.', { n: behind.length, name: behind[0].name, days: behind[0].daysOverdue }), action: { label: behind.length === 1 ? tr('Open') : tr('Show them'), run: () => (behind.length === 1 ? setDetail(behind[0].id) : showOnly('behind')) } });
  if (waiting.length) insights.push({ tone: 'info', icon: 'doc', text: waiting.length === 1 ? tr('{name} has a quotation waiting for an answer. Follow it up.', { name: waiting[0].name }) : tr('{n} clients have quotations waiting for an answer.', { n: waiting.length }), action: { label: tr('Show them'), run: () => showOnly('quoted') } });
  if (quiet.length) insights.push({ tone: 'warn', icon: 'clock', text: quiet.length === 1 ? tr('{name} hasn\'t bought or been quoted since {date}.', { name: quiet[0].name, date: fmtDate(quiet[0].lastActivity) }) : tr('{n} good clients have gone quiet for four months or more.', { n: quiet.length }), action: { label: tr('Show them'), run: () => showOnly('quiet') } });
  if (neverQuoted.length) insights.push({ tone: 'info', icon: 'spark', text: neverQuoted.length === 1 ? tr('{name} is a lead with no quotation yet.', { name: neverQuoted[0].name }) : tr('{n} leads and prospects have never been quoted.', { n: neverQuoted.length }), action: { label: tr('Show them'), run: () => showOnly('noquote') } });
  if (!insights.length && customers.length) insights.push({ tone: 'good', icon: 'check', text: tr('Nobody is overdue and every quotation has been answered.') });

  const chipTest = {
    all: (c) => c.category !== 'inactive', owing: owes, behind: (c) => behind.includes(c), quoted: (c) => c.openQuotes > 0,
    quiet: (c) => quiet.includes(c), noquote: (c) => neverQuoted.includes(c), paid: (c) => c.paid12 && c.paid12.length > 0,
    inactive: (c) => c.category === 'inactive', everyone: () => true
  };
  const visible = customers.filter(chipTest[chip] || chipTest.all)
    .filter((c) => !stage || c.category === stage || (stage === 'active' && c.category === 'vip'))
    .filter((c) => matchesQuery(search, c.name, c.contactPerson, c.email, c.phone, c.managerName, c.taxId));
  const chips = [
    ['all', tr('Current'), customers.filter(chipTest.all).length], ['owing', tr('Owing'), owing.length], ['behind', tr('Overdue'), behind.length],
    ['quoted', tr('Quotation waiting'), waiting.length], ['quiet', tr('Gone quiet'), quiet.length], ['noquote', tr('Never quoted'), neverQuoted.length],
    ['paid', tr('Paid this year'), customers.filter(chipTest.paid).length], ['inactive', tr('Inactive'), customers.filter(chipTest.inactive).length], ['everyone', tr('All'), customers.length]
  ].filter(([k, , c]) => c > 0 || k === 'all' || k === chip);
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c.key, customers.filter((x) => x.category === c.key).length]));

  function stateOf(c) {
    if (c.overdue && c.overdue.length) return { tone: 'bad', text: tr('{days} days overdue', { days: c.daysOverdue }) };
    if (owes(c)) return { tone: 'warn', text: tr('{amount} owed', { amount: moneyBreakdown(c.outstanding) }) };
    if (c.openQuotes) return { tone: 'info', text: c.openQuotes === 1 ? tr('Quotation waiting') : tr('{n} quotations waiting', { n: c.openQuotes }) };
    if (quiet.includes(c)) return { tone: 'warn', text: tr('Quiet since {date}', { date: fmtDate(c.lastActivity) }) };
    if (c.lastActivity) return { tone: 'muted', text: tr('Last active {date}', { date: fmtDate(c.lastActivity) }) };
    return { tone: 'muted', text: tr('Nothing done yet') };
  }
  function actionsFor(c) {
    const canDelete = canManage && !(c.quotedTotals.length || c.invoicedTotals.length || c.invoiceCount);
    const next = { lead: 'prospect', prospect: 'active', active: 'vip' }[c.category];
    return [
      { label: tr('Open'), onClick: () => setDetail(c.id) },
      canManage && { label: tr('Edit'), onClick: () => openEdit(c) },
      canManage && next && { label: tr('Move to {stage}', { stage: catLabel(next) }), onClick: () => setCategory(c, next) },
      canManage && c.category !== 'inactive' && { label: tr('Mark inactive'), onClick: () => setCategory(c, 'inactive') },
      canManage && c.category === 'inactive' && { label: tr('Mark active'), onClick: () => setCategory(c, 'active') },
      canDelete && { label: tr('Delete'), onClick: () => setDeleteTarget(c), danger: true }
    ].filter(Boolean);
  }

  const cur = detail ? customers.find((c) => c.id === detail) : null;
  const winRate = cur && cur.quotesWon + cur.quotesLost ? Math.round((cur.quotesWon / (cur.quotesWon + cur.quotesLost)) * 100) : null;

  return (
    <div className="dk tl pk cu">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <Hero
        eyebrow={tr('Quotations & Invoicing')}
        title={tr('Clients')}
        sub={tr('The companies and people Bamboo Products quotes and invoices: where each one stands, what they owe and how to reach them. Press a number to show only those.')}
        actions={canManage && (
          <>
            <button type="button" className="btn btn-primary" onClick={() => openNew()}>{tr('Add customer')}</button>
            <Link className="btn btn-secondary" to="/quotations">{tr('Quotations')}</Link>
          </>
        )}
        stats={stats} />

      <Insights items={insights.slice(0, 5)} />

      <Section id="cu-stages" title={tr('From lead to VIP')} sub={tr('How many clients are at each stage. Press one to show only those.')}>
        <div className="cu-stages" role="radiogroup" aria-label={tr('Stage')}>
          {CATEGORIES.map((s, i) => (
            <button key={s.key} type="button" role="radio" aria-checked={stage === s.key} className={'cu-stage is-' + s.key + (stage === s.key ? ' is-on' : '')}
              onClick={() => { setChip(s.key === 'inactive' ? 'inactive' : 'all'); setStage(stage === s.key ? '' : s.key); jump('cu-list'); }}>
              <strong>{counts[s.key] || 0}</strong>
              <span>{tr(s.label)}</span>
              {i < 3 && <i className="cu-stage-arrow" aria-hidden="true">→</i>}
            </button>
          ))}
        </div>
      </Section>

      <Section id="cu-list" title={tr('Clients')} sub={tr('Press a client for everything done with them.')}
        action={(
          <div className="ppl-view" role="radiogroup" aria-label={tr('View')}>
            {[['cards', tr('Cards')], ['list', tr('List')]].map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={view === k} className={view === k ? 'is-on' : ''} onClick={() => { setView(k); writePref('bos.clientsView', k); }}>{label}</button>
            ))}
          </div>
        )}>
        <div className="tl-tools"><div className="tl-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search customers…')} /></div></div>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {chips.map(([key, label, c]) => (
            <button key={key} type="button" role="radio" aria-checked={chip === key} className={'ppl-chip' + (chip === key ? ' is-on' : '')} onClick={() => { setChip(key); setStage(''); }}>
              {label} <span className="ppl-chip-n">{c}</span>
            </button>
          ))}
          {stage && <button type="button" className="ppl-chip is-on" onClick={() => setStage('')}>{catLabel(stage)} ×</button>}
        </div>
        {!visible.length ? (
          <div className="dk-empty tl-empty">
            <p>{customers.length ? tr('Nothing matches. Try another search or filter.') : tr('No customers on file yet')}</p>
            {canManage && !customers.length && <button type="button" className="btn btn-primary" onClick={() => openNew()}>{tr('Add customer')}</button>}
          </div>
        ) : view === 'cards' ? (
          <div className="tl-grid">
            {visible.map((c) => {
              const st = stateOf(c);
              return (
                <article key={c.id} className={'tl-card' + (st.tone === 'bad' ? ' st-late' : '') + (c.category === 'inactive' ? ' st-retired' : '')}>
                  <button type="button" className="tl-card-open" onClick={() => setDetail(c.id)}>
                    <Mark c={c} />
                    <span className="tl-card-head">
                      <span className="dk-muted tl-small">{catLabel(c.category)}{c.contactPerson ? ' · ' + c.contactPerson : ''}</span>
                      <span className="tl-name">{c.name}</span>
                    </span>
                  </button>
                  <span className="tl-menu"><RowMenu actions={actionsFor(c)} /></span>
                  <div className="tl-tags"><Status tone={st.tone}>{st.text}</Status>{c.category === 'vip' && <Status tone="good">{tr('VIP')}</Status>}</div>
                  <div className="tl-foot">
                    <span className="tl-small">{c.paid12 && c.paid12.length ? <><strong>{moneyBreakdown(c.paid12)}</strong> <span className="dk-muted">{tr('in 12 months')}</span></> : <span className="dk-muted">{c.managerName !== '—' ? tr('managed by {name}', { name: c.managerName }) : tr('no sales yet')}</span>}</span>
                    <ContactButtons name={c.contactPerson || c.name} phone={c.phone} email={c.email} />
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="tl-table-wrap">
            <table className="tl-table">
              <thead><tr><th>{tr('Customer')}</th><th>{tr('Stage')}</th><th className="is-num">{tr('Owes')}</th><th className="is-num">{tr('Paid, 12 months')}</th><th>{tr('Contact')}</th><th /></tr></thead>
              <tbody>
                {visible.map((c) => (
                  <tr key={c.id} className={c.category === 'inactive' ? 'st-retired' : ''}>
                    <td><button type="button" className="tl-row-open" onClick={() => setDetail(c.id)}><Mark c={c} size={32} /><span><span className="tl-name">{c.name}</span><span className="dk-muted tl-small">{c.contactPerson || c.email || c.phone || '—'}</span></span></button></td>
                    <td>{catLabel(c.category)}</td>
                    <td className={'is-num' + (c.overdue && c.overdue.length ? ' pk-owe' : '')}>{owes(c) ? moneyBreakdown(c.outstanding) : '—'}</td>
                    <td className="is-num">{c.paid12 && c.paid12.length ? moneyBreakdown(c.paid12) : '—'}</td>
                    <td><ContactButtons name={c.contactPerson || c.name} phone={c.phone} email={c.email} /></td>
                    <td className="tl-menu-cell"><RowMenu actions={actionsFor(c)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Glossary items={[
        [tr('Lead'), tr('Someone who has shown interest. Nothing quoted yet.')],
        [tr('Prospect'), tr('Being quoted or talked to; hasn\'t bought yet.')],
        [tr('Active'), tr('Buys from us.')],
        [tr('VIP'), tr('One of the clients that matter most.')],
        [tr('Owed'), tr('Invoices not fully paid, in each currency. Overdue means past the due date. Voided invoices don\'t count.')],
        [tr('Gone quiet'), tr('An active client with nothing quoted, invoiced or paid for four months.')]
      ]} />

      {/* ── one client ── */}
      {cur && (
        <div className="dialog-backdrop" onClick={() => setDetail(null)}>
          <div className="dialog tl-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="tl-detail-head">
              <Mark c={cur} size={56} />
              <div>
                <span className="dk-muted tl-small">{catLabel(cur.category)}{cur.taxId ? ' · ' + tr('TIN {no}', { no: cur.taxId }) : ''}</span>
                <h2>{cur.name}</h2>
                <div className="tl-tags"><Status tone={stateOf(cur).tone}>{stateOf(cur).text}</Status></div>
              </div>
              <button type="button" className="tl-close" onClick={() => setDetail(null)} aria-label={tr('Close')}>×</button>
            </div>
            <div className="tl-holder is-inline">
              <div className="tl-holder-head">
                <span className="tl-holder-name"><strong>{cur.contactPerson || cur.name}</strong><span className="dk-muted tl-small">{[cur.phone, cur.email].filter(Boolean).join(' · ') || tr('no phone or email')}</span></span>
                <ContactButtons name={cur.contactPerson || cur.name} phone={cur.phone} email={cur.email} />
              </div>
            </div>
            <dl className="tl-facts">
              <div><dt>{tr('Owes')}</dt><dd className={cur.overdue && cur.overdue.length ? 'pk-owe' : ''}>{owes(cur) ? moneyBreakdown(cur.outstanding) : tr('nothing')}</dd></div>
              <div><dt>{tr('Paid, 12 months')}</dt><dd>{cur.paid12 && cur.paid12.length ? moneyBreakdown(cur.paid12) : '—'}</dd></div>
              <div><dt>{tr('Invoiced in all')}</dt><dd>{cur.invoicedTotals.length ? moneyBreakdown(cur.invoicedTotals.map((r) => ({ currency: r.currency, amount: r.invoiced }))) : '—'}</dd></div>
              <div><dt>{tr('Quotations won')}</dt><dd>{cur.quotesWon + cur.quotesLost ? tr('{won} of {n} ({pct}%)', { won: cur.quotesWon, n: cur.quotesWon + cur.quotesLost, pct: winRate }) : '—'}</dd></div>
              <div><dt>{tr('Last paid')}</dt><dd>{cur.lastPaidOn ? fmtDate(cur.lastPaidOn) : '—'}</dd></div>
              <div><dt>{tr('Payment terms')}</dt><dd>{cur.paymentTerms || '—'} · {cur.preferredCurrency}</dd></div>
              <div><dt>{tr('Account manager')}</dt><dd className="cu-manager">{cur.accountManagerId && <Photo id={cur.accountManagerId} name={cur.managerName} photo={cur.managerPhoto} size={22} />}{cur.managerName}</dd></div>
              {cur.address && <div><dt>{tr('Address')}</dt><dd>{cur.address}</dd></div>}
            </dl>
            {cur.notes && <p className="tl-notes">{cur.notes}</p>}
            <h3 className="tl-h3">{tr('History')}</h3>
            {activity === null ? <p className="dk-muted tl-small">{tr('Loading…')}</p> : activity.length ? (
              <ul className="tl-log">
                {activity.map((a) => {
                  const d = new Date(a.day + 'T00:00');
                  return (
                    <li key={a.kind + a.id} className={'tl-log-row is-' + ({ estimate: 'count', quotation: 'checkout', invoice: 'issue', payment: 'restock' }[a.kind])}>
                      <span className="tl-date" aria-hidden="true"><strong>{d.getDate()}</strong><span>{d.toLocaleDateString(activeIntlLocale(), { month: 'short', year: '2-digit' })}</span></span>
                      <span className="tl-log-main">
                        <span className="tl-log-title">{tr(KIND_LABELS[a.kind])} · {a.no} · {money(a.amount, a.currency)}</span>
                        <span className="dk-muted tl-small">{codeLabel(a.status)}{a.kind === 'invoice' && a.balance > 0 && a.status !== 'void' ? ' · ' + tr('{amount} still to pay', { amount: money(a.balance, a.currency) }) : ''}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : <p className="dk-muted tl-small">{tr('Nothing done with them yet.')}</p>}
            <div className="dialog-actions tl-actions">
              {canManage && !(cur.quotedTotals.length || cur.invoicedTotals.length || cur.invoiceCount) && <button type="button" className="btn btn-secondary" onClick={() => setDeleteTarget(cur)}>{tr('Delete')}</button>}
              {canManage && <button type="button" className="btn btn-secondary" onClick={() => openEdit(cur)}>{tr('Edit')}</button>}
              {owes(cur) && <Link className="btn btn-secondary" to="/invoices">{tr('Invoices')}</Link>}
              <Link className="btn btn-primary" to="/quotations">{tr('New quotation')}</Link>
            </div>
          </div>
        </div>
      )}

      {/* ── add / edit ── */}
      {dialogOpen && (
        <div className="dialog-backdrop" onClick={() => !saving && setDialogOpen(false)}>
          <form className="dialog tl-dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h2>{editId ? tr('Edit customer') : tr('Add customer')}</h2>
            <div className="tl-form">
              <div className="field tl-span">
                <label htmlFor="cu-name">{tr('Name')}</label>
                <input id="cu-name" className="input" maxLength={100} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              </div>
              <div className="field">
                <label htmlFor="cu-contact">{tr('Contact person')}</label>
                <input id="cu-contact" className="input" value={form.contactPerson} onChange={(e) => setForm({ ...form, contactPerson: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="cu-phone">{tr('Phone')}</label>
                <input id="cu-phone" className="input" type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="cu-email">{tr('Email')}</label>
                <input id="cu-email" className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="cu-tin">{tr('Tax ID (TIN)')}</label>
                <input id="cu-tin" className="input" value={form.taxId} onChange={(e) => setForm({ ...form, taxId: e.target.value })} disabled={!editId} placeholder={editId ? '' : tr('after saving')} />
              </div>
              <div className="field tl-span">
                <label htmlFor="cu-address">{tr('Address')}</label>
                <input id="cu-address" className="input" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
              </div>
              <div className="field tl-span">
                <span className="tl-label">{tr('Stage')}</span>
                <div className="tl-seg" role="radiogroup" aria-label={tr('Stage')}>
                  {CATEGORIES.map((c) => <button key={c.key} type="button" role="radio" aria-checked={form.category === c.key} className={'tl-seg-btn' + (form.category === c.key ? ' is-on' : '')} onClick={() => setForm({ ...form, category: c.key })}>{tr(c.label)}</button>)}
                </div>
              </div>
              <div className="field">
                <label htmlFor="cu-currency">{tr('Preferred currency')}</label>
                <select id="cu-currency" className="input" value={form.preferredCurrency} onChange={(e) => setForm({ ...form, preferredCurrency: e.target.value })}>
                  {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="cu-terms">{tr('Payment terms')}</label>
                <input id="cu-terms" className="input" list="cu-termlist" value={form.paymentTerms} onChange={(e) => setForm({ ...form, paymentTerms: e.target.value })} disabled={!editId} />
                <datalist id="cu-termlist"><option value="Due on receipt" /><option value="Net 7" /><option value="Net 14" /><option value="Net 30" /><option value="Net 60" /></datalist>
              </div>
              <div className="field tl-span">
                <label htmlFor="cu-manager">{tr('Account manager')}</label>
                <select id="cu-manager" className="input" value={form.accountManagerId} onChange={(e) => setForm({ ...form, accountManagerId: e.target.value })}>
                  <option value="">{tr('Me')}</option>
                  {employees.filter((e) => e.status !== 'terminated').map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}
                </select>
              </div>
              <div className="field tl-span">
                <label htmlFor="cu-notes">{tr('Notes (optional)')}</label>
                <textarea id="cu-notes" className="input tl-textarea" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </div>
            </div>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialogOpen(false)} disabled={saving}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : editId ? tr('Save changes') : tr('Add customer')}</button>
            </div>
          </form>
        </div>
      )}

      {deleteTarget && (
        <div className="dialog-backdrop" onClick={() => setDeleteTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Delete {name}', { name: deleteTarget.name })}</h2>
            <p className="dialog-body">{tr('This cannot be undone.')}</p>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDeleteTarget(null)}>{tr('Cancel')}</button>
              <button type="button" className="btn btn-primary" disabled={deleting} onClick={confirmDelete}>{deleting ? tr('Deleting…') : tr('Delete')}</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
