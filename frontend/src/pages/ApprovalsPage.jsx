import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import Photo, { fetchBlobUrl, useBlobUrl } from '../components/Photo';
import { Glossary, Hero, Insights, Section, Status, fmtDate, jump } from '../components/DashKit';
import { money } from '../lib/currency';
import { tr, msg } from '../lib/i18n.jsx';
import './EmployeesPage.css';
import './ToolRoomPage.css';
import './ApprovalsPage.css';

// The Approval centre — every request waiting for this person's decision
// (leave, purchases, expense claims), in the same "explains itself" layout
// as the dashboards (components/DashKit.jsx): how many are waiting and for
// how long, the money involved, what stands out (waiting long, leave that
// overlaps with others away or goes past the balance, claims without a
// receipt, purchases needed soon), the requests as cards with the facts to
// decide them, a window for each with a note to the requester, and what
// was decided lately (GET /approvals/queue and /approvals/history,
// approvals.service.js).
//
// Each decision goes to the endpoint of its own workflow (leave,
// procurement, expenses), which checks the approver's permission and
// scope again and tells the requester, with the note if one was given.

const KINDS = {
  leave_request: { label: msg('Leave'), page: '/leave', pageLabel: msg('Open Leave'), path: (id) => '/leave/' + id + '/decision' },
  procurement_request: { label: msg('Purchase request'), page: '/procurement', pageLabel: msg('Open Procurement'), path: (id) => '/procurement/' + id + '/decision' },
  expense: { label: msg('Expense claim'), page: '/expenses', pageLabel: msg('Open Expenses'), path: (id) => '/expenses/' + id + '/decision' }
};
const LONG_WAIT_DAYS = 3;
const SOON_DAYS = 7;

function dayNum(iso) { return Math.floor(new Date(String(iso).slice(0, 10) + 'T00:00').getTime() / 86400000); }
function todayNum() { const t = new Date(); return Math.floor(new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime() / 86400000); }
function hoursSince(ts) { return Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 36e5)); }
function daysWaiting(a) { return Math.floor(hoursSince(a.createdAt) / 24); }
function waitedText(a) {
  const h = hoursSince(a.createdAt);
  if (h < 1) return tr('asked just now');
  if (h < 24) return h === 1 ? tr('waiting 1 hour') : tr('waiting {n} hours', { n: h });
  const d = Math.floor(h / 24);
  return d === 1 ? tr('waiting 1 day') : tr('waiting {n} days', { n: d });
}
function durText(h) {
  if (h < 1) return tr('an hour');
  if (h < 24) return h === 1 ? tr('1 hour') : tr('{n} hours', { n: h });
  const d = Math.round(h / 24);
  return d === 1 ? tr('1 day') : tr('{n} days', { n: d });
}
function tookText(h) { return h < 1 ? tr('decided within the hour') : tr('took {d}', { d: durText(h) }); }
function isImage(r) { return r && (/^image\//.test(r.type || '') || /\.(jpe?g|png|webp|heic|heif)$/i.test(r.name || '')); }

// The one line that says what is being asked.
function factLine(a) {
  const f = a.facts;
  if (!f) return a.title;
  if (a.subjectType === 'leave_request') return (f.days === 1 ? tr('1 day of {type}', { type: f.leaveType }) : tr('{n} days of {type}', { n: f.days, type: f.leaveType })) + ' · ' + (f.startDate === f.endDate ? fmtDate(f.startDate) : fmtDate(f.startDate) + ' → ' + fmtDate(f.endDate));
  if (a.subjectType === 'procurement_request') return tr('{qty} × {item} · about {amount}', { qty: f.quantity, item: f.item, amount: money(f.estimatedPrice, 'GHS') });
  return tr('{category} · {amount} · spent {date}', { category: f.category, amount: money(f.amount, 'GHS'), date: fmtDate(f.date) });
}
// What an approver should look at twice.
function flagsOf(a) {
  const f = a.facts || {};
  const out = [];
  if (daysWaiting(a) > LONG_WAIT_DAYS) out.push({ tone: 'warn', text: waitedText(a) });
  if (a.subjectType === 'leave_request') {
    if (f.balance && f.balance.leftAfter < 0) out.push({ tone: 'bad', text: tr('{n} days past the balance', { n: -f.balance.leftAfter }) });
    if (f.awayThen && f.awayThen.length) out.push({ tone: 'warn', text: f.awayThen.length === 1 ? tr('{name} is also away then', { name: f.awayThen[0].name }) : tr('{n} others in the team away then', { n: f.awayThen.length }) });
  }
  if (a.subjectType === 'expense' && !f.receipt) out.push({ tone: 'warn', text: tr('No receipt') });
  if (a.subjectType === 'procurement_request') {
    if (f.priority === 'high') out.push({ tone: 'bad', text: tr('High priority') });
    if (f.requiredDate && dayNum(f.requiredDate) - todayNum() <= SOON_DAYS) out.push({ tone: dayNum(f.requiredDate) < todayNum() ? 'bad' : 'warn', text: tr('Needed by {date}', { date: fmtDate(f.requiredDate) }) });
  }
  return out;
}
function needsLook(a) { return flagsOf(a).some((x) => x.tone === 'bad' || x.text !== waitedText(a)); }

function ReceiptPreview({ a }) {
  const r = a.facts && a.facts.receipt;
  const url = useBlobUrl(r && isImage(r) ? '/expenses/' + a.subjectId + '/receipt?inline=1' : null, 1);
  if (!r) return null;
  return url ? <img className="ap-receipt" src={url} alt={tr('Receipt')} /> : null;
}

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState([]);
  const [history, setHistory] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [companyFilter, setCompanyFilter] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [decidingId, setDecidingId] = useState(null);
  const [search, setSearch] = useState('');
  const [chip, setChip] = useState('all');
  const [histChip, setHistChip] = useState('all');
  const [detail, setDetail] = useState(null);
  const [note, setNote] = useState('');

  // Departments already carry companyId/companyName (departments.service.js#list)
  // so the company list is derived from one fetch.
  const companies = useMemo(() => {
    const seen = new Map();
    departments.forEach((d) => { if (d.companyId && !seen.has(d.companyId)) seen.set(d.companyId, { id: d.companyId, name: d.companyName }); });
    return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [departments]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams();
      if (companyFilter) params.set('companyId', companyFilter);
      if (deptFilter) params.set('departmentId', deptFilter);
      const [queue, hist, depts] = await Promise.all([api.get('/approvals/queue?' + params.toString()), api.get('/approvals/history?' + params.toString()), api.get('/departments')]);
      setApprovals(queue);
      setHistory(hist);
      setDepartments(depts);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [companyFilter, deptFilter]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  function openDetail(a) { setNote(''); setDetail(a.id); }
  async function decide(a, decision) {
    setDecidingId(a.id);
    setError(null);
    try {
      await api.post(KINDS[a.subjectType].path(a.subjectId), { decision, note: detail === a.id ? note : '' });
      setToast(decision === 'approved' ? tr('Approved: {what} for {name}.', { what: tr(KINDS[a.subjectType].label), name: a.requesterName }) : tr('Rejected: {what} for {name}. They have been told.', { what: tr(KINDS[a.subjectType].label), name: a.requesterName }));
      setDetail(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setDecidingId(null);
    }
  }
  function openReceipt(a) {
    const win = window.open('', '_blank');
    fetchBlobUrl('/expenses/' + a.subjectId + '/receipt?inline=1', 1).then((u) => {
      if (u && win) win.location.href = u;
      else { if (win) win.close(); setError(tr('The receipt could not be opened.')); }
    });
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const byAge = approvals.slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const oldest = byAge[0];
  const longWait = byAge.filter((a) => daysWaiting(a) > LONG_WAIT_DAYS);
  const moneyItems = approvals.filter((a) => a.amount);
  const moneyTotal = moneyItems.reduce((s, a) => s + a.amount, 0);
  const claims = approvals.filter((a) => a.subjectType === 'expense');
  const purchases = approvals.filter((a) => a.subjectType === 'procurement_request');
  const leaves = approvals.filter((a) => a.subjectType === 'leave_request');
  const overBalance = leaves.filter((a) => a.facts && a.facts.balance && a.facts.balance.leftAfter < 0);
  const clashes = leaves.filter((a) => a.facts && a.facts.awayThen && a.facts.awayThen.length);
  const noReceipt = claims.filter((a) => a.facts && !a.facts.receipt);
  const neededSoon = purchases.filter((a) => a.facts && a.facts.requiredDate && dayNum(a.facts.requiredDate) - todayNum() <= SOON_DAYS);
  const recent = history.filter((h) => Date.now() - new Date(h.decidedAt).getTime() <= 30 * 86400000);
  const mine = recent.filter((h) => h.byMe);
  const approvedShare = recent.length ? Math.round((recent.filter((h) => h.status === 'approved').length / recent.length) * 100) : null;
  const medianHours = (() => {
    if (!recent.length) return null;
    const hs = recent.map((h) => h.hoursToDecide).sort((a, b) => a - b);
    return hs[Math.floor(hs.length / 2)];
  })();

  function showOnly(key) { setChip(chip === key ? 'all' : key); jump('ap-list'); }
  const stats = [
    { icon: 'clock', value: String(approvals.length), label: tr('waiting for your decision'), note: oldest ? tr('the oldest {wait}', { wait: waitedText(oldest) }) : tr('you\'re all caught up'), tone: longWait.length ? 'warn' : approvals.length ? '' : 'good', onClick: () => showOnly('all') },
    { icon: 'warn', value: String(longWait.length), label: tr('waiting more than {n} days', { n: LONG_WAIT_DAYS }), note: longWait.length ? tr('people are waiting on these') : tr('nothing has waited long'), tone: longWait.length ? 'bad' : 'good', onClick: () => showOnly('long') },
    { icon: 'cash', value: money(moneyTotal, 'GHS'), label: tr('money asked for'), note: tr('{c} claims · {p} purchases', { c: claims.length, p: purchases.length }), onClick: () => showOnly('money') },
    { icon: 'check', value: String(recent.length), label: tr('decided in the last 30 days'), note: recent.length ? tr('{pct}% approved · half within {took} · {mine} by you', { pct: approvedShare, took: durText(medianHours), mine: mine.length }) : tr('nothing decided lately'), onClick: () => jump('ap-history') }
  ];

  const insights = [];
  if (longWait.length) insights.push({ tone: 'bad', icon: 'clock', text: longWait.length === 1 ? tr('{name}\'s {what} has been {wait}.', { name: longWait[0].requesterName, what: tr(KINDS[longWait[0].subjectType].label).toLowerCase(), wait: waitedText(longWait[0]) }) : tr('{n} requests have waited more than {d} days; the oldest is from {name}.', { n: longWait.length, d: LONG_WAIT_DAYS, name: longWait[0].requesterName }), action: { label: longWait.length === 1 ? tr('Open') : tr('Show them'), run: () => (longWait.length === 1 ? openDetail(longWait[0]) : showOnly('long')) } });
  if (overBalance.length) insights.push({ tone: 'bad', icon: 'calendar', text: tr('{name} asks for {days} days of {type}, {over} more than they have left.', { name: overBalance[0].requesterName, days: overBalance[0].facts.days, type: overBalance[0].facts.leaveType.toLowerCase(), over: -overBalance[0].facts.balance.leftAfter }), action: { label: tr('Open'), run: () => openDetail(overBalance[0]) } });
  if (clashes.length) insights.push({ tone: 'warn', icon: 'people', text: tr('{name}\'s leave overlaps with {others} from the same team.', { name: clashes[0].requesterName, others: clashes[0].facts.awayThen.map((x) => x.name).join(', ') }), action: { label: tr('Open'), run: () => openDetail(clashes[0]) } });
  if (noReceipt.length) insights.push({ tone: 'warn', icon: 'receipt', text: noReceipt.length === 1 ? tr('{name}\'s {amount} claim has no receipt attached.', { name: noReceipt[0].requesterName, amount: money(noReceipt[0].amount, 'GHS') }) : tr('{n} expense claims have no receipt attached.', { n: noReceipt.length }), action: { label: noReceipt.length === 1 ? tr('Open') : tr('Show them'), run: () => (noReceipt.length === 1 ? openDetail(noReceipt[0]) : showOnly('look')) } });
  if (neededSoon.length) insights.push({ tone: 'warn', icon: 'bag', text: tr('{item} for {name} is needed by {date}.', { item: neededSoon[0].facts.item, name: neededSoon[0].requesterName, date: fmtDate(neededSoon[0].facts.requiredDate) }), action: { label: tr('Open'), run: () => openDetail(neededSoon[0]) } });
  if (!insights.length) insights.push(approvals.length ? { tone: 'info', icon: 'info', text: tr('Nothing unusual in the requests waiting. Open one to see its details, or approve it from its card.') } : { tone: 'good', icon: 'check', text: tr('You\'re all caught up. Requests from the people you\'re responsible for will appear here.') });

  const chipTest = {
    all: () => true, leave_request: (a) => a.subjectType === 'leave_request', procurement_request: (a) => a.subjectType === 'procurement_request',
    expense: (a) => a.subjectType === 'expense', long: (a) => daysWaiting(a) > LONG_WAIT_DAYS, look: needsLook, money: (a) => !!a.amount
  };
  const visible = byAge.filter(chipTest[chip] || chipTest.all)
    .filter((a) => matchesQuery(search, a.title, a.requesterName, a.requesterRole, a.department, a.company, factLine(a), a.reason));
  const chips = [
    ['all', tr('All'), approvals.length], ['look', tr('Worth a closer look'), approvals.filter(needsLook).length], ['long', tr('Waiting long'), longWait.length],
    ['leave_request', tr('Leave'), leaves.length], ['procurement_request', tr('Purchases'), purchases.length], ['expense', tr('Expense claims'), claims.length]
  ].filter(([k, , c]) => c > 0 || k === 'all' || k === chip);

  const histTest = { all: () => true, mine: (h) => h.byMe, approved: (h) => h.status === 'approved', rejected: (h) => h.status === 'rejected' };
  const histRows = history.filter(histTest[histChip] || histTest.all).slice(0, 30);
  const histChips = [['all', tr('All'), history.length], ['mine', tr('By you'), history.filter(histTest.mine).length], ['approved', tr('Approved'), history.filter(histTest.approved).length], ['rejected', tr('Rejected'), history.filter(histTest.rejected).length]]
    .filter(([k, , c]) => c > 0 || k === 'all' || k === histChip);

  const cur = detail ? approvals.find((a) => a.id === detail) : null;
  const cf = cur ? cur.facts || {} : {};

  return (
    <div className="dk tl ap">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <Hero
        eyebrow={tr('Governance')}
        title={tr('Approval centre')}
        sub={tr('Leave, purchases and expense claims waiting for your decision, with what you need to decide each one. The person is told as soon as you decide. Press a number to show only those.')}
        stats={stats} />

      <Insights items={insights.slice(0, 5)} />

      <Section id="ap-list" title={tr('Waiting for you')} sub={tr('Oldest first. Approve from the card, or open one to see everything and add a note.')}>
        <div className="tl-tools ap-tools">
          <div className="tl-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search approval queue…')} /></div>
          {companies.length > 1 && (
            <select className="input ap-filter" value={companyFilter} aria-label={tr('Filter by company')} onChange={(e) => { setCompanyFilter(e.target.value); setDeptFilter(''); }}>
              <option value="">{tr('All companies')}</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
          <select className="input ap-filter" value={deptFilter} aria-label={tr('Filter by department')} onChange={(e) => setDeptFilter(e.target.value)}>
            <option value="">{tr('All departments')}</option>
            {departments.filter((d) => !companyFilter || d.companyId === companyFilter).map((d) => (
              <option key={d.id} value={d.id}>{companyFilter || companies.length < 2 ? d.name : d.name + ' — ' + d.companyName}</option>
            ))}
          </select>
        </div>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {chips.map(([key, label, c]) => (
            <button key={key} type="button" role="radio" aria-checked={chip === key} className={'ppl-chip' + (chip === key ? ' is-on' : '')} onClick={() => setChip(key)}>
              {label} <span className="ppl-chip-n">{c}</span>
            </button>
          ))}
        </div>
        {!visible.length ? (
          <div className="dk-empty tl-empty">
            <p>{approvals.length ? tr('Nothing matches. Try another search or filter.') : tr('You\'re all caught up')}</p>
          </div>
        ) : (
          <div className="ap-list">
            {visible.map((a) => {
              const flags = flagsOf(a);
              return (
                <article key={a.id} className={'ap-item is-' + a.subjectType + (flags.some((x) => x.tone === 'bad') ? ' st-late' : '')}>
                  <button type="button" className="ap-open" onClick={() => openDetail(a)}>
                    <Photo id={a.requesterId} name={a.requesterName} photo={a.requesterPhoto} size={44} />
                    <span className="ap-body">
                      <span className="dk-muted tl-small">{tr(KINDS[a.subjectType].label)} · {waitedText(a)}</span>
                      <span className="tl-name">{a.requesterName}</span>
                      <span className="dk-muted tl-small">{[a.requesterRole, a.department, companies.length > 1 ? a.company : null].filter(Boolean).join(' · ')}</span>
                      <strong className="ap-fact">{factLine(a)}</strong>
                      {a.reason && <span className="ap-reason">“{a.reason}”</span>}
                    </span>
                  </button>
                  {flags.length > 0 && <div className="tl-tags ap-flags">{flags.map((x, i) => <Status key={i} tone={x.tone}>{x.text}</Status>)}</div>}
                  <div className="ap-actions">
                    <button type="button" className="btn btn-secondary" onClick={() => openDetail(a)}>{tr('Reject…')}</button>
                    <button type="button" className="btn btn-primary" disabled={decidingId === a.id} onClick={() => decide(a, 'approved')}>{tr('Approve')}</button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </Section>

      <Section id="ap-history" title={tr('Decided lately')} sub={tr('The last 90 days of requests you could decide, newest first: who decided, how, and how long it took.')}>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {histChips.map(([key, label, c]) => (
            <button key={key} type="button" role="radio" aria-checked={histChip === key} className={'ppl-chip' + (histChip === key ? ' is-on' : '')} onClick={() => setHistChip(key)}>
              {label} <span className="ppl-chip-n">{c}</span>
            </button>
          ))}
        </div>
        {!histRows.length ? (
          <div className="dk-empty"><p>{tr('Nothing decided in the last 90 days.')}</p></div>
        ) : (
          <ul className="ap-history">
            {histRows.map((h) => (
              <li key={h.id}>
                <Photo id={h.requesterId} name={h.requesterName} photo={h.requesterPhoto} size={32} />
                <span className="ap-h-main">
                  <span><strong>{h.requesterName}</strong> · {tr(KINDS[h.subjectType].label)} · {factLine(h)}</span>
                  <span className="dk-muted tl-small">
                    {h.byMe ? tr('You') : h.decidedByName} · {fmtDate(h.decidedAt)} · {tookText(h.hoursToDecide)}
                    {h.note ? ' · “' + h.note + '”' : ''}
                  </span>
                </span>
                <Status tone={h.status === 'approved' ? 'good' : 'bad'}>{h.status === 'approved' ? tr('Approved') : tr('Rejected')}</Status>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Glossary items={[
        [tr('Approval centre'), tr('Requests that need someone with your permissions to decide: leave, purchase requests and expense claims from the people in your scope. Your own requests go to someone else.')],
        [tr('Waiting long'), tr('Waiting more than {n} days since it was asked. The person can\'t plan until you decide.', { n: LONG_WAIT_DAYS })],
        [tr('Balance left'), tr('The days of that leave type the person still has this year after this request, if it is approved.')],
        [tr('Away then'), tr('Others in the same department with leave approved or asked for on any of the same days.')],
        [tr('Note'), tr('Optional words sent to the person with your decision — worth adding when you reject, so they know why.')],
        [tr('Decided lately'), tr('Requests decided in the last 90 days by anyone who could decide them, including you. The time taken runs from the request to the decision.')]
      ]} />

      {cur && (
        <div className="dialog-backdrop" onClick={() => setDetail(null)}>
          <div className="dialog tl-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="tl-detail-head">
              <Photo id={cur.requesterId} name={cur.requesterName} photo={cur.requesterPhoto} size={56} />
              <div>
                <span className="dk-muted tl-small">{tr(KINDS[cur.subjectType].label)} · {waitedText(cur)}</span>
                <h2>{cur.requesterName}</h2>
                <span className="dk-muted tl-small">{[cur.requesterRole, cur.department, cur.company].filter(Boolean).join(' · ')}</span>
              </div>
              <button type="button" className="tl-close" onClick={() => setDetail(null)} aria-label={tr('Close')}>×</button>
            </div>
            <p className="ap-fact ap-fact-big">{factLine(cur)}</p>
            {flagsOf(cur).length > 0 && <div className="tl-tags ap-flags">{flagsOf(cur).map((x, i) => <Status key={i} tone={x.tone}>{x.text}</Status>)}</div>}
            <dl className="tl-facts">
              <div><dt>{tr('Asked')}</dt><dd>{fmtDate(cur.createdAt)}</dd></div>
              {cur.subjectType === 'leave_request' && <>
                <div><dt>{tr('Leave type')}</dt><dd>{cf.leaveType}{cf.paid === false ? ' · ' + tr('unpaid') : ''}</dd></div>
                <div><dt>{tr('Balance left')}</dt><dd className={cf.balance && cf.balance.leftAfter < 0 ? 'pk-owe' : ''}>{cf.balance ? tr('{n} days after this (of {total})', { n: cf.balance.leftAfter, total: cf.balance.entitled }) : '—'}</dd></div>
              </>}
              {cur.subjectType === 'procurement_request' && <>
                <div><dt>{tr('Priority')}</dt><dd>{tr(cf.priority === 'high' ? 'High' : cf.priority === 'low' ? 'Low' : 'Medium')}</dd></div>
                <div><dt>{tr('Needed by')}</dt><dd>{cf.requiredDate ? fmtDate(cf.requiredDate) : '—'}</dd></div>
              </>}
              {cur.subjectType === 'expense' && <div><dt>{tr('Receipt')}</dt><dd>{cf.receipt ? <button type="button" className="ap-link" onClick={() => openReceipt(cur)}>{tr('Open the receipt')}</button> : tr('None attached')}</dd></div>}
            </dl>
            {cur.subjectType === 'leave_request' && cf.awayThen && cf.awayThen.length > 0 && (
              <>
                <h3 className="tl-h3">{tr('Also away then')}</h3>
                <ul className="ap-away">
                  {cf.awayThen.map((x, i) => <li key={i}><span>{x.name}</span><span className="dk-muted tl-small">{fmtDate(x.startDate)} → {fmtDate(x.endDate)} · {x.status === 'approved' ? tr('approved') : tr('asked, not decided')}</span></li>)}
                </ul>
              </>
            )}
            {cur.subjectType === 'expense' && <ReceiptPreview a={cur} />}
            {cur.reason && <><h3 className="tl-h3">{tr('Their reason')}</h3><p className="tl-notes">{cur.reason}</p></>}
            <div className="field">
              <label htmlFor="ap-note">{tr('Note to {name} (optional)', { name: cur.requesterName })}</label>
              <textarea id="ap-note" className="input" rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr('Worth adding if you reject, so they know why')} />
            </div>
            <div className="dialog-actions tl-actions">
              <Link className="btn btn-secondary" to={KINDS[cur.subjectType].page}>{tr(KINDS[cur.subjectType].pageLabel)}</Link>
              <button type="button" className="btn btn-secondary" disabled={decidingId === cur.id} onClick={() => decide(cur, 'rejected')}>{tr('Reject')}</button>
              <button type="button" className="btn btn-primary" disabled={decidingId === cur.id} onClick={() => decide(cur, 'approved')}>{tr('Approve')}</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
