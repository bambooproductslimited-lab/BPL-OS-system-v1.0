import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { Empty, Glossary, Icon, RankList, Section, Status, fmtDate, jump } from '../../components/DashKit';
import { downloadCsv, rowsToCsv } from '../../lib/csvExport';
import { tr } from '../../lib/i18n.jsx';
import { Toast, ghs, useCrmBasics, usePerms } from './crmShared';
import { FxFacts, FxHero, FxRing } from '../finance/FinFun';
import '../EmployeesPage.css';
import '../ToolRoomPage.css';
import './CrmPage.css';

// Every won sale with the share it earns — the rep's commission or a
// kick-back — worked out from its invoice (the sheet's Purchases and Kick
// back tabs), and referral payments to people outside (its Referral tab).
// A commission is ready to pay once the customer has paid the invoice in
// full. Reps see their own; crm.commission sees everyone's and marks them
// paid.
//
// In the finance pages' look (pages/finance/FinFun.jsx): a banner with a
// ring for how much of what was earned has been paid out, lighter facts,
// who earned the most, and each sale as a card with its rate worked out.

function dealTone(d) { return d.status === 'paid' ? 'good' : d.status === 'not_eligible' ? 'muted' : d.ready ? 'warn' : 'info'; }
function dealState(d) { return d.status === 'paid' ? tr('Paid') : d.status === 'not_eligible' ? tr('No commission') : d.ready ? tr('To pay') : tr('Waiting for the customer'); }

export default function CrmCommissionsPage() {
  const navigate = useNavigate();
  const { canManage, canCommission } = usePerms();
  const { settings, people, reload } = useCrmBasics();
  const [deals, setDeals] = useState(null);
  const [refs, setRefs] = useState([]);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('topay');
  const [rep, setRep] = useState('');
  const [busy, setBusy] = useState(null);
  const [editing, setEditing] = useState(null);
  const [referral, setReferral] = useState(null);
  const [rates, setRates] = useState(null);
  const [toast, setToast] = useState(null);

  const load = useCallback(async () => {
    try {
      const [d, r] = await Promise.all([api.get('/crm/deals'), api.get('/crm/referrals')]);
      setDeals(d); setRefs(r); setError(null);
    } catch (err) { setError(err.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const shown = useMemo(() => (deals || []).filter((d) => {
    if (rep && (d.repId || d.repName) !== rep) return false;
    if (filter === 'topay') return d.status === 'pending' && d.ready;
    if (filter === 'waiting') return d.status === 'pending' && !d.ready;
    if (filter === 'paid') return d.status === 'paid';
    if (filter === 'none') return d.status === 'not_eligible';
    return true;
  }), [deals, filter, rep]);

  if (!deals) return <div className="dk">{error ? <div className="error-banner">{error}</div> : <div className="eyebrow">{tr('Loading…')}</div>}</div>;

  const sum = (list) => list.reduce((a, d) => a + (d.commission || 0), 0);
  const toPay = deals.filter((d) => d.status === 'pending' && d.ready);
  const waiting = deals.filter((d) => d.status === 'pending' && !d.ready);
  const paid = deals.filter((d) => d.status === 'paid');
  const refOwed = refs.filter((r) => r.status === 'pending');
  const reps = [...new Map(deals.filter((d) => d.repName).map((d) => [d.repId || d.repName, d.repName])).entries()];
  const earned = deals.filter((d) => d.status !== 'not_eligible' && d.commission);
  const earnedSum = sum(earned);
  const paidShare = earnedSum ? sum(paid) / earnedSum : null;
  // Who earned the most (paid, ready and waiting), and lighter facts.
  const byRep = new Map();
  earned.forEach((d) => {
    if (!d.repName) return;
    const k = d.repId || d.repName;
    const r = byRep.get(k) || { key: k, name: d.repName, value: 0, paid: 0, sales: 0 };
    r.value += d.commission; r.sales += 1; if (d.status === 'paid') r.paid += d.commission;
    byRep.set(k, r);
  });
  const board = [...byRep.values()].sort((a, b) => b.value - a.value);
  const biggest = earned.slice().sort((a, b) => b.commission - a.commission)[0];
  const rated = deals.filter((d) => d.rate !== null && d.status !== 'not_eligible');
  const avgRate = rated.length ? Math.round((rated.reduce((a, d) => a + d.rate, 0) / rated.length) * 10) / 10 : null;
  const fullRate = rated.filter((d) => !d.discountPct).length;
  const refPaid = refs.filter((r) => r.status === 'paid').reduce((a, r) => a + r.amount, 0);
  const facts = [
    canCommission && board.length > 1 ? { icon: 'spark', tone: 'sun', label: tr('Top earner'), value: board[0].name, note: tr('{amount} on {n} sales', { amount: ghs(board[0].value), n: board[0].sales }) } : null,
    biggest ? { icon: 'cash', tone: 'violet', label: tr('Biggest single share'), value: ghs(biggest.commission), note: biggest.leadName + ' · ' + biggest.invoiceNo } : null,
    avgRate !== null ? { icon: 'percent', tone: 'sky', label: tr('Average rate earned'), value: avgRate + '%', note: tr('of a {rate}% base, after discounts', { rate: settings ? settings.commissionRate : 20 }) } : null,
    rated.length ? { icon: 'check', tone: 'mint', label: tr('Sold with no discount'), value: tr('{a} of {b}', { a: fullRate, b: rated.length }), note: tr('those earn the full rate') } : null,
    refs.length ? { icon: 'people', tone: 'rose', label: tr('Paid to referrers'), value: ghs(refPaid), note: refs.length === 1 ? tr('1 referral recorded') : tr('{n} referrals recorded', { n: refs.length }) } : null
  ];

  async function setStatus(kind, id, status) {
    setBusy(id); setError(null);
    try { await api.post('/crm/' + kind + '/' + id + '/status', { status }); await load(); } catch (err) { setError(err.message); } finally { setBusy(null); }
  }
  async function saveDeal(e) {
    e.preventDefault();
    setBusy('deal');
    try { await api.put('/crm/deals/' + editing.id, { kind: editing.kind, repId: editing.repId || null, repName: editing.repId ? '' : editing.repName, coreTeam: editing.coreTeam, notes: editing.notes }); setEditing(null); await load(); } catch (err) { setError(err.message); } finally { setBusy(null); }
  }
  async function saveReferral(e) {
    e.preventDefault();
    setBusy('ref');
    try {
      const body = { referrerName: referral.referrerName, referrerPhone: referral.referrerPhone, location: referral.location, customerReferred: referral.customerReferred, dealValue: referral.dealValue === '' ? null : referral.dealValue, rate: referral.rate, notes: referral.notes };
      if (referral.id) await api.put('/crm/referrals/' + referral.id, body); else await api.post('/crm/referrals', body);
      setReferral(null); setToast(tr('Referral saved.')); await load();
    } catch (err) { setError(err.message); } finally { setBusy(null); }
  }
  async function saveRates(e) {
    e.preventDefault();
    setBusy('rates');
    try {
      await api.put('/crm/settings', { commissionRate: Number(rates.commissionRate), referralRate: Number(rates.referralRate), sources: rates.sources.split('\n').map((s) => s.trim()).filter(Boolean) });
      setRates(null); setToast(tr('Settings saved. Sales linked from now on use the new rate; earlier ones keep theirs.')); reload(); await load();
    } catch (err) { setError(err.message); } finally { setBusy(null); }
  }
  function csv() {
    downloadCsv('crm-commissions-' + new Date().toISOString().slice(0, 10) + '.csv', rowsToCsv([
      [tr('Invoice'), tr('Date'), tr('Customer'), tr('Lead'), tr('Paid to'), tr('Kind'), tr('Value (GHS)'), tr('Discount %'), tr('Rate %'), tr('Commission (GHS)'), tr('Still owed (GHS)'), tr('Status')],
      ...shown.map((d) => [d.invoiceNo, d.issuedAt, d.customerName, d.leadRef + ' ' + d.leadName, d.repName || '', d.kind === 'kickback' ? tr('Kick-back') : tr('Commission'), d.value, d.discountPct, d.rate === null ? '' : d.rate, d.commission === null ? '' : d.commission, d.balance, dealState(d)])
    ]));
  }

  const rate = settings ? settings.commissionRate : 20;
  return (
    <div className="dk crm fnx cm">
      {error && <div className="error-banner" role="alert">{error}</div>}
      <FxHero theme="commission" art="trophy"
        side={<FxRing value={paidShare === null ? null : Math.max(0.03, paidShare)} size={160} big={paidShare === null ? '—' : Math.round(paidShare * 100) + '%'} label={tr('paid out')} sub={tr('of {amount} earned', { amount: ghs(earnedSum) })} />}
        eyebrow={tr('Finance')} title={canCommission ? tr('Commissions') : tr('My commission')}
        sub={tr('The share each won sale earns: {rate}% less the discount given, on the price after discount. It can be paid once the customer has paid the invoice in full.', { rate })}
        actions={<>
          <button type="button" className="fnx-pill is-main" onClick={csv}><Icon name="doc" /> {tr('Download CSV')}</button>
          {canCommission && settings && <button type="button" className="fnx-pill" onClick={() => setRates({ commissionRate: settings.commissionRate, referralRate: settings.referralRate, sources: settings.sources.join('\n') })}><Icon name="percent" /> {tr('Rates & sources')}</button>}
        </>}
        stats={[
          { icon: 'cash', value: ghs(sum(toPay)), label: tr('ready to pay'), note: tr('{n} sales paid up by the customer', { n: toPay.length }), tone: toPay.length ? 'good' : '', onClick: () => { setFilter('topay'); jump('cm-sales'); } },
          { icon: 'clock', value: ghs(sum(waiting)), label: tr('waiting for the customer'), note: tr('{n} sales not fully paid yet', { n: waiting.length }), onClick: () => { setFilter('waiting'); jump('cm-sales'); } },
          { icon: 'check', value: ghs(sum(paid)), label: tr('paid out'), note: tr('{n} sales', { n: paid.length }), onClick: () => { setFilter('paid'); jump('cm-sales'); } },
          { icon: 'people', value: ghs(refOwed.reduce((a, r) => a + r.amount, 0)), label: tr('owed to referrers'), note: tr('{n} referrals not paid yet', { n: refOwed.length }), onClick: () => jump('crm-refs') }
        ]} />

      <FxFacts items={facts} />

      {canCommission && board.length > 1 && (
        <Section id="cm-board" title={tr('Who earned the most')} sub={tr('Every share earned so far: paid, ready to pay and waiting for the customer.')} card>
          <RankList rows={board.slice(0, 8).map((r) => ({ key: r.key, name: r.name, value: r.value, amount: ghs(r.value), meta: (r.sales === 1 ? tr('1 sale') : tr('{n} sales', { n: r.sales })) + ' · ' + tr('{amount} paid out', { amount: ghs(r.paid) }) }))} />
        </Section>
      )}

      <Section id="cm-sales" title={tr('Sales')} sub={tr('Each sale is an OS invoice linked to a won lead. Press the lead to open it.')}>
        <div className="crm-filters">
          <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
            {[['topay', tr('To pay'), toPay.length], ['waiting', tr('Waiting'), waiting.length], ['paid', tr('Paid'), paid.length], ['none', tr('No commission'), deals.filter((d) => d.status === 'not_eligible').length], ['all', tr('All'), deals.length]].map(([k, label, n]) => (
              <button key={k} type="button" role="radio" aria-checked={filter === k} className={'ppl-chip' + (filter === k ? ' is-on' : '')} onClick={() => setFilter(k)}>{label} <span className="ppl-chip-n">{n}</span></button>
            ))}
          </div>
          {canCommission && reps.length > 1 && (
            <select className="input" value={rep} onChange={(e) => setRep(e.target.value)} aria-label={tr('Paid to')}>
              <option value="">{tr('Everyone')}</option>
              {reps.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          )}
        </div>
        {shown.length ? (
          <div className="tl-grid">
            {shown.map((d) => (
              <article key={d.id} className={'tl-card fnx-deal is-' + dealTone(d)}>
                <div className="fnx-deal-top">
                  <span className="dk-muted tl-small">{d.invoiceNo} · {fmtDate(d.issuedAt)}</span>
                  <Status tone={dealTone(d)}>{dealState(d)}</Status>
                </div>
                <button type="button" className="crm-textbtn tl-name fnx-deal-lead" onClick={() => navigate('/crmleads?lead=' + d.leadId)}>{d.leadName}</button>
                <p className="dk-muted tl-small fnx-deal-who">
                  {d.kind === 'kickback' ? tr('Kick-back for {name}', { name: d.repName || tr('nobody') }) : tr('Commission for {name}', { name: d.repName || tr('nobody') })}
                  {d.coreTeam ? ' · ' + tr('team: {names}', { names: d.coreTeam }) : ''}
                </p>
                {d.rate !== null && (
                  <div className="fnx-eq" aria-label={tr('{base}% − {disc}% = {rate}%', { base: d.baseRate, disc: d.discountPct, rate: d.rate })}>
                    <span>{d.baseRate}%</span><i>−</i><span>{d.discountPct}%</span><i>=</i><strong>{d.rate}%</strong>
                    <small>{tr('of {value}', { value: ghs(d.value) })}</small>
                  </div>
                )}
                {d.rate === null && <p className="dk-muted tl-small">{tr('{value} after {disc}% discount', { value: ghs(d.value), disc: d.discountPct })}</p>}
                {d.balance > 0 && <p className="tl-small fnx-deal-owed">{tr('{amount} still owed by the customer', { amount: ghs(d.balance) })}</p>}
                <div className="tl-foot">
                  <span className="fnx-deal-amount">{d.commission === null ? '—' : ghs(d.commission)}{d.paidOn && <small className="dk-muted"> · {fmtDate(d.paidOn)}</small>}</span>
                  {canCommission && d.status !== 'paid' && d.status !== 'not_eligible' && <button type="button" className="btn btn-primary tl-btn" disabled={busy === d.id} onClick={() => setStatus('deals', d.id, 'paid')}>{tr('Mark paid')}</button>}
                </div>
                {(canCommission || (canManage && d.status !== 'paid')) && (
                  <div className="crm-card-acts">
                    {canCommission && d.status === 'pending' && <button type="button" className="dk-link" disabled={busy === d.id} onClick={() => setStatus('deals', d.id, 'not_eligible')}>{tr('No commission on this')}</button>}
                    {canCommission && d.status !== 'pending' && <button type="button" className="dk-link" disabled={busy === d.id} onClick={() => setStatus('deals', d.id, 'pending')}>{tr('Back to not paid')}</button>}
                    {canManage && d.status !== 'paid' && <button type="button" className="dk-link" onClick={() => setEditing({ id: d.id, kind: d.kind, repId: d.repId || '', repName: d.repId ? '' : d.repName || '', coreTeam: d.coreTeam, notes: d.notes })}>{tr('Change who gets it')}</button>}
                  </div>
                )}
              </article>
            ))}
          </div>
        ) : <Empty icon="cash">{deals.length ? tr('Nothing here. Try another tab.') : tr('No sales linked to leads yet. Open a won lead and link its invoice.')}</Empty>}
      </Section>

      <Section id="crm-refs" title={tr('Referrals')} sub={tr('People outside the company who sent a customer. They get {rate}% of the deal.', { rate: settings ? settings.referralRate : 20 })}
        action={canManage && <button type="button" className="btn btn-secondary" onClick={() => setReferral({ referrerName: '', referrerPhone: '', location: '', customerReferred: '', dealValue: '', rate: settings ? settings.referralRate : 20, notes: '' })}>{tr('Add a referral')}</button>}>
        {refs.length ? (
          <ul className="dk-rows">
            {refs.map((r) => (
              <li key={r.id} className="dk-row crm-deal">
                <span className={'dk-lead-icon is-' + (r.status === 'paid' ? 'good' : 'info')}><Icon name="people" /></span>
                <div className="dk-row-main">
                  <div className="dk-row-title">{r.referrerName}{r.referrerPhone ? <span className="dk-muted"> · {r.referrerPhone}</span> : null}</div>
                  <div className="dk-muted dk-row-meta">{tr('sent {customer}', { customer: r.customerReferred || tr('a customer') })} · {tr('{rate}% of {value}', { rate: r.rate, value: ghs(r.dealValue) })}</div>
                  <div className="crm-card-acts">
                    {canCommission && r.status === 'pending' && <button type="button" className="btn btn-secondary tl-btn" disabled={busy === r.id} onClick={() => setStatus('referrals', r.id, 'paid')}>{tr('Mark paid')}</button>}
                    {canCommission && r.status !== 'pending' && <button type="button" className="dk-link" disabled={busy === r.id} onClick={() => setStatus('referrals', r.id, 'pending')}>{tr('Back to not paid')}</button>}
                    {canManage && r.status !== 'paid' && <button type="button" className="dk-link" onClick={() => setReferral({ ...r, dealValue: r.invoiceId ? r.dealValue : (r.dealValue || '') })}>{tr('Edit')}</button>}
                  </div>
                </div>
                <div className="dk-row-side">
                  <div className="dk-row-amount">{ghs(r.amount)}</div>
                  <div className="dk-row-note"><Status tone={r.status === 'paid' ? 'good' : r.status === 'not_eligible' ? 'muted' : 'warn'}>{r.status === 'paid' ? tr('Paid') : r.status === 'not_eligible' ? tr('No commission') : tr('To pay')}</Status></div>
                </div>
              </li>
            ))}
          </ul>
        ) : <Empty icon="people">{tr('No referrals recorded.')}</Empty>}
      </Section>

      <Glossary items={[
        [tr('Commission'), tr('The sales rep\'s share: {rate}% minus the discount given, on the price after discount. 5% off leaves 15%; 20% off or more leaves nothing.', { rate })],
        [tr('Kick-back'), tr('The same share, paid to someone who isn\'t the sales rep for bringing in the sale.')],
        [tr('To pay'), tr('The customer has paid the invoice in full, so the share can be paid.')],
        [tr('Waiting for the customer'), tr('The invoice still has a balance. The share is paid once it is cleared.')],
        [tr('Rate at the time'), tr('A sale keeps the commission rate it was linked at, so changing the rate later doesn\'t change what was earned before.')]
      ]} />

      {editing && (
        <div className="dialog-backdrop" onClick={() => setEditing(null)}>
          <form className="dialog tl-dialog crm-dialog" onClick={(e) => e.stopPropagation()} onSubmit={saveDeal}>
            <h2>{tr('Who gets the share')}</h2>
            <div className="tl-form">
              <div className="field">
                <span className="tl-label">{tr('Kind')}</span>
                <div className="dk-segment" role="radiogroup" aria-label={tr('Kind')}>
                  {[['commission', tr('Commission')], ['kickback', tr('Kick-back')]].map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={editing.kind === k} className={editing.kind === k ? 'is-on' : ''} onClick={() => setEditing({ ...editing, kind: k })}>{label}</button>)}
                </div>
              </div>
              <div className="field">
                <label htmlFor="cd-rep">{tr('Paid to')}</label>
                <select id="cd-rep" className="input" value={editing.repId} onChange={(e) => setEditing({ ...editing, repId: e.target.value })}>
                  <option value="">{editing.repName ? editing.repName + ' ' + tr('(not in the OS)') : tr('Nobody')}</option>
                  {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div className="field tl-span"><label htmlFor="cd-team">{tr('Team who worked on it')}</label><input id="cd-team" className="input" value={editing.coreTeam} onChange={(e) => setEditing({ ...editing, coreTeam: e.target.value })} /></div>
              <div className="field tl-span"><label htmlFor="cd-notes">{tr('Notes')}</label><input id="cd-notes" className="input" value={editing.notes} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} /></div>
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={busy === 'deal'}>{tr('Save')}</button>
            </div>
          </form>
        </div>
      )}

      {referral && (
        <div className="dialog-backdrop" onClick={() => setReferral(null)}>
          <form className="dialog tl-dialog crm-dialog" onClick={(e) => e.stopPropagation()} onSubmit={saveReferral}>
            <h2>{referral.id ? tr('Referral') : tr('Add a referral')}</h2>
            <div className="tl-form">
              <div className="field"><label htmlFor="cr-name">{tr('Referrer')}</label><input id="cr-name" className="input" value={referral.referrerName} onChange={(e) => setReferral({ ...referral, referrerName: e.target.value })} required autoFocus /></div>
              <div className="field"><label htmlFor="cr-phone">{tr('Their phone')}</label><input id="cr-phone" className="input" type="tel" value={referral.referrerPhone} onChange={(e) => setReferral({ ...referral, referrerPhone: e.target.value })} /></div>
              <div className="field"><label htmlFor="cr-loc">{tr('Location')}</label><input id="cr-loc" className="input" value={referral.location} onChange={(e) => setReferral({ ...referral, location: e.target.value })} /></div>
              <div className="field"><label htmlFor="cr-cust">{tr('Customer they sent')}</label><input id="cr-cust" className="input" value={referral.customerReferred} onChange={(e) => setReferral({ ...referral, customerReferred: e.target.value })} /></div>
              <div className="field"><label htmlFor="cr-value">{tr('Deal value (GHS)')}</label><input id="cr-value" className="input" type="number" min="0" step="0.01" value={referral.dealValue} disabled={!!referral.invoiceId} onChange={(e) => setReferral({ ...referral, dealValue: e.target.value })} /></div>
              <div className="field"><label htmlFor="cr-rate">{tr('Their share (%)')}</label><input id="cr-rate" className="input" type="number" min="0" max="100" step="0.1" value={referral.rate} onChange={(e) => setReferral({ ...referral, rate: e.target.value })} /></div>
              <p className="dk-muted tl-small tl-span">{tr('They get {amount}.', { amount: ghs((Number(referral.dealValue) || 0) * (Number(referral.rate) || 0) / 100) })}</p>
            </div>
            <div className="dialog-actions">
              {referral.id && <button type="button" className="btn btn-secondary crm-left" onClick={async () => { try { await api.del('/crm/referrals/' + referral.id); setReferral(null); await load(); } catch (err) { setError(err.message); } }}>{tr('Delete')}</button>}
              <button type="button" className="btn btn-secondary" onClick={() => setReferral(null)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={busy === 'ref'}>{tr('Save')}</button>
            </div>
          </form>
        </div>
      )}

      {rates && (
        <div className="dialog-backdrop" onClick={() => setRates(null)}>
          <form className="dialog tl-dialog crm-dialog" onClick={(e) => e.stopPropagation()} onSubmit={saveRates}>
            <h2>{tr('Rates & sources')}</h2>
            <div className="tl-form">
              <div className="field"><label htmlFor="cs-rate">{tr('Commission base rate (%)')}</label><input id="cs-rate" className="input" type="number" min="0" max="100" step="0.1" value={rates.commissionRate} onChange={(e) => setRates({ ...rates, commissionRate: e.target.value })} /></div>
              <div className="field"><label htmlFor="cs-ref">{tr('Referral rate (%)')}</label><input id="cs-ref" className="input" type="number" min="0" max="100" step="0.1" value={rates.referralRate} onChange={(e) => setRates({ ...rates, referralRate: e.target.value })} /></div>
              <p className="dk-muted tl-small tl-span">{tr('With {rate}%, a sale with a 5% discount earns {a}%, and one with 10% off earns {b}%.', { rate: rates.commissionRate, a: Math.max(0, Number(rates.commissionRate) - 5), b: Math.max(0, Number(rates.commissionRate) - 10) })}</p>
              <div className="field tl-span"><label htmlFor="cs-src">{tr('How leads find us (one per line)')}</label><textarea id="cs-src" className="input" rows={6} value={rates.sources} onChange={(e) => setRates({ ...rates, sources: e.target.value })} /></div>
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setRates(null)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={busy === 'rates'}>{tr('Save')}</button>
            </div>
          </form>
        </div>
      )}
      <Toast text={toast} onDone={() => setToast(null)} />
    </div>
  );
}
