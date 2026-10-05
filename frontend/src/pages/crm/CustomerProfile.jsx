import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import ContactButtons from '../../components/ContactButtons';
import { Empty, Icon, Status, fmtDate } from '../../components/DashKit';
import { tr } from '../../lib/i18n.jsx';
import { StageTag, addDays, followUpClass, followUpText, todayISO } from './crmShared';
import { CATEGORIES, CHANNELS, CategoryTag, ChannelDot, CustMark, REASONS, RepSelect, ago, channelLabel, ghsOr, nextStepText, ourAuthor, reasonText, timeOf } from './crmHubShared';

// One customer, whole (GET /api/crm/profiles/:id): who they are and every
// way to reach them, their rep, why they need a follow-up, every
// conversation on every channel, what they were quoted, ordered (each
// order with its rep) and invoiced, and one timeline of all of it.

const DOC_STATUS_TONE = { paid: 'good', partial: 'warn', partially_paid: 'warn', unpaid: 'info', overdue: 'bad', sent: 'info', viewed: 'info', accepted: 'good', declined: 'bad', expired: 'muted', draft: 'muted', delivered: 'good', cancelled: 'muted' };
const KIND_LABEL = { phone: 'Phone', email: 'Email', instagram: 'Instagram', facebook: 'Facebook', other: 'Other' };
const KIND_CHANNEL = { phone: 'whatsapp', email: 'email', instagram: 'instagram', facebook: 'facebook', other: 'other' };
function kindLabel(k) {
  switch (k) { case 'phone': return tr('Phone'); case 'email': return tr('Email'); case 'instagram': return tr('Instagram'); case 'facebook': return tr('Facebook'); default: return tr('Other'); }
}
function docStatus(s) {
  switch (s) {
    case 'paid': return tr('Paid'); case 'partial': case 'partially_paid': return tr('Part paid'); case 'unpaid': return tr('Unpaid'); case 'void': return tr('Void'); case 'overdue': return tr('Overdue'); case 'sent': return tr('Sent'); case 'viewed': return tr('Viewed');
    case 'accepted': return tr('Accepted'); case 'declined': return tr('Declined'); case 'expired': return tr('Expired'); case 'draft': return tr('Draft');
    case 'pending': return tr('Pending'); case 'in_progress': return tr('In progress'); case 'ready': return tr('Ready'); case 'delivered': return tr('Delivered'); case 'cancelled': return tr('Cancelled');
    default: return s;
  }
}

export default function CustomerProfile({ id, onClose, onChanged, reps }) {
  const navigate = useNavigate();
  const { can, session } = useAuth();
  const meId = session && session.employee ? session.employee.id : null;
  const canManage = can('crm.manage');
  const canAssign = can('crm.assign');
  const [p, setP] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(null);
  const [follow, setFollow] = useState({ on: '', note: '' });
  const [ident, setIdent] = useState({ kind: 'phone', value: '' });
  const [log, setLog] = useState({ channel: 'call', direction: 'out', body: '' });
  const [tab, setTab] = useState('all');
  const [saved, setSaved] = useState(null);

  const load = useCallback(async () => {
    try {
      const x = await api.get('/crm/profiles/' + id);
      setP(x); setError(null);
      setFollow({ on: x.followUpOn || '', note: x.followUpNote || '' });
    } catch (err) { setError(err.message); }
  }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const k = (e) => { if (e.key === 'Escape' && !busy) onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [busy, onClose]);

  async function run(fn, done) {
    setBusy(true); setError(null);
    setSaved(null);
    try { const out = await fn(); if (out && out.id === id) setP(out); else await load(); if (done) setSaved(done); if (onChanged) onChanged(); return true; } catch (err) { setError(err.message); return false; } finally { setBusy(false); }
  }
  const go = (path) => { onClose(); navigate(path); };

  if (!p) {
    return (
      <div className="dialog-backdrop" onClick={onClose}>
        <div className="dialog crm-dialog" onClick={(e) => e.stopPropagation()}>{error ? <div className="error-banner">{error}</div> : <p className="eyebrow">{tr('Loading…')}</p>}</div>
      </div>
    );
  }

  const fu = p.followUps || { reasons: [] };
  const mineOrFree = !p.rep || p.rep.id === meId;
  const canPickRep = canAssign || (canManage && !p.rep);
  const invoicesByOrder = {};
  p.invoiceList.forEach((i) => { if (i.salesOrderId) (invoicesByOrder[i.salesOrderId] = invoicesByOrder[i.salesOrderId] || []).push(i); });
  const looseInvoices = p.invoiceList.filter((i) => !i.salesOrderId || !p.orders.some((o) => o.id === i.salesOrderId));
  const timeline = p.timeline.filter((t) => tab === 'all' || (tab === 'messages' ? t.kind === 'message' : t.kind !== 'message'));

  function startEdit() {
    setForm({ name: p.name, contactPerson: p.contactPerson || '', phone: p.phone || '', email: p.email || '', location: p.location || '', address: p.address || '', category: p.category, notes: p.notes || '', marketingOptOut: p.marketingOptOut });
    setEditing(true);
  }

  return (
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <div className="dialog crm-lead hub-profile" role="dialog" aria-modal="true" aria-labelledby="hub-p-name" onClick={(e) => e.stopPropagation()}>
        <div className="crm-lead-head">
          <div className="hub-p-who">
            <CustMark name={p.name} size={52} />
            <div>
              <p className="eyebrow">{tr('Customer profile')}{p.origin ? ' · ' + tr('first wrote on {channel}', { channel: channelLabel(p.origin) }) : ''}</p>
              <h2 id="hub-p-name">{p.name}</h2>
              <div className="crm-chips">
                <CategoryTag value={p.category} />
                {p.location && <span className="dk-muted tl-small"><Icon name="arrow" /> {p.location}</span>}
                {p.marketingOptOut && <Status tone="muted">{tr('No marketing messages')}</Status>}
                {p.contactPerson && <span className="dk-muted tl-small">{tr('Contact: {name}', { name: p.contactPerson })}</span>}
              </div>
            </div>
          </div>
          <div className="hub-p-headacts">
            <ContactButtons name={p.name} phone={p.phone} email={p.email} />
            <button type="button" className="crm-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
          </div>
        </div>

        {error && <div className="error-banner" role="alert">{error}</div>}
        {saved && <div className="crm-note is-good" role="status"><Icon name="check" /><span>{saved}</span></div>}

        {p.duplicateOf.length > 0 && (
          <div className="crm-note is-warn">
            <Icon name="people" />
            <span>{p.duplicateOf.length === 1 ? tr('This may be the same customer as {name}.', { name: p.duplicateOf[0].name }) : tr('This may be the same customer as {n} other profiles.', { n: p.duplicateOf.length })}</span>
            <button type="button" className="dk-link" onClick={() => go('/crmhealth?pair=' + p.duplicateOf[0].suggestionId)}>{tr('Compare')} <Icon name="arrow" /></button>
          </div>
        )}

        {fu.reasons.length > 0 && (
          <section className="hub-p-due" aria-label={tr('Why they need a follow-up')}>
            <div className="hub-p-due-head"><Icon name="warn" /> <strong>{tr('Needs a follow-up')}</strong></div>
            <ul>{fu.reasons.map((r, i) => <li key={i} className={'is-' + (REASONS[r.type] || REASONS.quiet).tone}><Icon name={(REASONS[r.type] || REASONS.quiet).icon} /> {reasonText(r)}</li>)}</ul>
            <p className="hub-p-next"><Icon name="arrow" /> {nextStepText(fu)}</p>
          </section>
        )}

        <div className="hub-p-stats">
          <div><span>{tr('Bought in all')}</span><strong>{ghsOr(p.lifetime)}</strong><small>{tr('{n} invoices', { n: p.invoices })}</small></div>
          <div className={p.outstanding > 0 ? (p.overdue > 0 ? 'is-bad' : 'is-warn') : ''}><span>{tr('Still owes')}</span><strong>{ghsOr(p.outstanding)}</strong><small>{p.overdue > 0 ? tr('{amount} overdue', { amount: ghsOr(p.overdue) }) : tr('nothing overdue')}</small></div>
          <div><span>{tr('Open quotations')}</span><strong>{p.openQuotes}</strong><small>{tr('{n} in all', { n: p.quotations.length })}</small></div>
          <div className={p.waitingSince ? 'is-bad' : ''}><span>{tr('Last contact')}</span><strong>{ago(p.lastContactAt)}</strong><small>{p.waitingSince ? tr('waiting for us since {time}', { time: ago(p.waitingSince) }) : tr('{n} conversations', { n: p.conversations })}</small></div>
        </div>

        <div className="crm-lead-grid">
          <div className="crm-lead-col">
            <section className="crm-box">
              <div className="crm-box-head"><h3 className="dk-h3">{tr('Sales rep')}</h3>{p.repAssignedAt && <span className="dk-muted tl-small">{tr('since {date}', { date: fmtDate(p.repAssignedAt) })}</span>}</div>
              {canPickRep ? (
                <div className="crm-inline">
                  <RepSelect reps={reps || []} value={p.rep ? p.rep.id : ''} disabled={busy} emptyLabel={tr('No rep yet')}
                    onChange={(v) => v && run(() => api.post('/crm/assign', { customerIds: [p.id], repId: v }), tr('{name} now looks after this customer.', { name: (reps.find((r) => r.id === v) || {}).name || '' }))} />
                </div>
              ) : <p className="crm-big">{p.rep ? p.rep.name : tr('No rep yet')}</p>}
              {!p.rep && canManage && meId && !canAssign && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => run(() => api.post('/crm/assign', { customerIds: [p.id], repId: meId }), tr('This customer is now yours.'))}>{tr('Take this customer')}</button>}
              {!p.rep && <p className="dk-muted tl-small">{tr('Nobody is looking after this customer. Every customer should have one rep who answers them and follows up.')}</p>}
            </section>

            {canManage && (
              <section className="crm-box">
                <h3 className="dk-h3">{tr('Next follow-up')}</h3>
                <p className={'crm-follow ' + followUpClass(p.followUpOn)}><Icon name="calendar" /> {p.followUpOn ? fmtDate(p.followUpOn) + ' · ' + followUpText(p.followUpOn) : tr('No date set')}</p>
                {p.followUpNote && <p className="crm-comments">{p.followUpNote}</p>}
                <div className="crm-inline">
                  <input type="date" className="input crm-date" value={follow.on} min={todayISO()} onChange={(e) => setFollow({ ...follow, on: e.target.value })} aria-label={tr('Date')} />
                  {[[1, tr('Tomorrow')], [7, tr('In a week')], [30, tr('In a month')]].map(([n, l]) => <button key={n} type="button" className="ppl-chip" onClick={() => setFollow({ ...follow, on: addDays(todayISO(), n) })}>{l}</button>)}
                </div>
                <input className="input" placeholder={tr('What for? e.g. send the new price list')} value={follow.note} onChange={(e) => setFollow({ ...follow, note: e.target.value })} aria-label={tr('What for')} />
                <div className="crm-chips">
                  <button type="button" className="btn btn-primary" disabled={busy || !follow.on} onClick={() => run(() => api.put('/crm/profiles/' + p.id + '/follow-up', follow), tr('Follow-up saved.'))}>{tr('Save the date')}</button>
                  {p.followUpOn && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => run(() => api.put('/crm/profiles/' + p.id + '/follow-up', { on: null }), tr('Marked done.'))}><Icon name="check" /> {tr('Done')}</button>}
                </div>
              </section>
            )}

            <section className="crm-box">
              <div className="crm-box-head"><h3 className="dk-h3">{tr('Sales: order → invoice')}</h3></div>
              {p.orders.length === 0 && p.invoiceList.length === 0 && p.quotations.length === 0 && <p className="dk-muted tl-small">{tr('No quotations, orders or invoices yet.')}</p>}
              {p.orders.length > 0 && (
                <ul className="hub-chain">
                  {p.orders.map((o) => (
                    <li key={o.id}>
                      <button type="button" className="hub-chain-doc" onClick={() => go('/salesorders?open=' + o.id)}>
                        <Icon name="bag" /><span><strong>{o.ref}</strong> <span className="dk-muted">{ghsOr(o.amount, o.currency)}</span></span>
                        <Status tone={DOC_STATUS_TONE[o.status]}>{docStatus(o.status)}</Status>
                      </button>
                      <span className="hub-chain-rep">{o.rep ? tr('Rep: {name}', { name: o.rep.name }) : tr('No rep on this order')}</span>
                      {(invoicesByOrder[o.id] || []).map((i) => (
                        <button key={i.id} type="button" className="hub-chain-doc is-inv" onClick={() => go('/invoices?open=' + i.id)}>
                          <Icon name="receipt" /><span><strong>{i.ref}</strong> <span className="dk-muted">{ghsOr(i.amount, i.currency)}{i.balance > 0 ? ' · ' + tr('{amount} to pay', { amount: ghsOr(i.balance, i.currency) }) : ''}</span></span>
                          <Status tone={DOC_STATUS_TONE[i.status]}>{docStatus(i.status)}</Status>
                        </button>
                      ))}
                      {!(invoicesByOrder[o.id] || []).length && <span className="dk-muted tl-small hub-chain-none">{tr('No invoice yet')}</span>}
                    </li>
                  ))}
                </ul>
              )}
              {looseInvoices.length > 0 && (
                <ul className="crm-mini">
                  {looseInvoices.slice(0, 8).map((i) => (
                    <li key={i.id}><button type="button" className="hub-chain-doc is-inv" onClick={() => go('/invoices?open=' + i.id)}><Icon name="receipt" /><span><strong>{i.ref}</strong> <span className="dk-muted">{fmtDate(i.issuedAt)} · {ghsOr(i.amount, i.currency)}</span></span><Status tone={DOC_STATUS_TONE[i.status]}>{docStatus(i.status)}</Status></button></li>
                  ))}
                </ul>
              )}
              {p.quotations.length > 0 && (
                <>
                  <h4 className="hub-subhead">{tr('Quotations')}</h4>
                  <ul className="crm-mini">
                    {p.quotations.slice(0, 6).map((x) => (
                      <li key={x.id}><button type="button" className="hub-chain-doc" onClick={() => go('/quotations?open=' + x.id)}><Icon name="doc" /><span><strong>{x.ref}</strong> <span className="dk-muted">{x.title || ''} · {ghsOr(x.amount, x.currency)}</span></span><Status tone={DOC_STATUS_TONE[x.status]}>{docStatus(x.status)}</Status></button></li>
                    ))}
                  </ul>
                </>
              )}
              {p.leads.length > 0 && (
                <>
                  <h4 className="hub-subhead">{tr('Leads')}</h4>
                  <ul className="crm-mini">
                    {p.leads.map((l) => <li key={l.id}><button type="button" className="hub-chain-doc" onClick={() => go('/crmleads?lead=' + l.id)}><Icon name="people" /><span><strong>{l.ref}</strong> <span className="dk-muted">{l.item || ''}</span></span><StageTag value={l.stage} /></button></li>)}
                  </ul>
                </>
              )}
            </section>

            {p.interests.length > 0 && (
              <section className="crm-box">
                <h3 className="dk-h3">{tr('What they buy and ask about')}</h3>
                <div className="crm-chips">{p.interests.map((x) => <span key={x.name} className={'hub-interest' + (x.bought ? ' is-bought' : '')} title={x.bought ? tr('Bought') : tr('Quoted')}>{x.name} <small>×{x.times}</small></span>)}</div>
              </section>
            )}

            <section className="crm-box">
              <h3 className="dk-h3">{tr('How to reach them')}</h3>
              <p className="dk-muted tl-small">{tr('Every number, address and account of this customer. A message from any of them lands on this profile.')}</p>
              <ul className="hub-idents">
                {p.identities.map((i) => (
                  <li key={i.id}>
                    <ChannelDot channel={KIND_CHANNEL[i.kind]} />
                    <span className="hub-ident-text"><span className="dk-muted tl-small">{kindLabel(i.kind)}</span> {i.label || i.value}</span>
                    {canManage && <button type="button" className="hub-ident-x" disabled={busy} onClick={() => run(() => api.del('/crm/profiles/' + p.id + '/identities/' + i.id))} aria-label={tr('Remove {what}', { what: i.label || i.value })}>✕</button>}
                  </li>
                ))}
                {!p.identities.length && <li className="dk-muted tl-small">{tr('None yet.')}</li>}
              </ul>
              {canManage && (
                <form className="crm-inline" onSubmit={(e) => { e.preventDefault(); run(() => api.post('/crm/profiles/' + p.id + '/identities', ident), tr('Added.')).then((ok) => ok && setIdent({ ...ident, value: '' })); }}>
                  <select className="input hub-kind" value={ident.kind} onChange={(e) => setIdent({ ...ident, kind: e.target.value })} aria-label={tr('Kind')}>
                    {Object.keys(KIND_LABEL).map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}
                  </select>
                  <input className="input" value={ident.value} onChange={(e) => setIdent({ ...ident, value: e.target.value })} placeholder={ident.kind === 'phone' ? '024 000 0000' : ident.kind === 'email' ? 'name@example.com' : tr('Account name or link')} aria-label={tr('Number, address or account')} />
                  <button type="submit" className="btn btn-secondary" disabled={busy || !ident.value.trim()}>{tr('Add')}</button>
                </form>
              )}
            </section>

            <section className="crm-box">
              <div className="crm-box-head"><h3 className="dk-h3">{tr('Details')}</h3>{canManage && !editing && <button type="button" className="dk-link" onClick={startEdit}>{tr('Edit')}</button>}</div>
              {!editing ? (
                <dl className="crm-facts">
                  <div><dt>{tr('Phone')}</dt><dd>{p.phone || '—'}</dd></div>
                  <div><dt>{tr('Email')}</dt><dd>{p.email || '—'}</dd></div>
                  <div><dt>{tr('Location')}</dt><dd>{p.location || '—'}</dd></div>
                  <div><dt>{tr('Address')}</dt><dd>{p.address || '—'}</dd></div>
                  <div><dt>{tr('In the OS since')}</dt><dd>{fmtDate(p.createdAt)}</dd></div>
                  <div><dt>{tr('Marketing messages')}</dt><dd>{p.marketingOptOut ? tr('Said no') : tr('Yes')}</dd></div>
                  {p.notes && <div className="tl-span"><dt>{tr('Notes')}</dt><dd className="crm-comments">{p.notes}</dd></div>}
                </dl>
              ) : (
                <form className="tl-form" onSubmit={(e) => { e.preventDefault(); run(() => api.put('/crm/profiles/' + p.id, form), tr('Saved.')).then((ok) => ok && setEditing(false)); }}>
                  <div className="field"><label htmlFor="hp-name">{tr('Name')}</label><input id="hp-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></div>
                  <div className="field"><label htmlFor="hp-cp">{tr('Contact person')}</label><input id="hp-cp" className="input" value={form.contactPerson} onChange={(e) => setForm({ ...form, contactPerson: e.target.value })} /></div>
                  <div className="field"><label htmlFor="hp-ph">{tr('Phone')}</label><input id="hp-ph" className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
                  <div className="field"><label htmlFor="hp-em">{tr('Email')}</label><input id="hp-em" className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
                  <div className="field"><label htmlFor="hp-loc">{tr('Location')}</label><input id="hp-loc" className="input" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} /></div>
                  <div className="field">
                    <label htmlFor="hp-cat">{tr('Kind of customer')}</label>
                    <select id="hp-cat" className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>{CATEGORIES.map((c) => <option key={c.key} value={c.key}>{tr(c.label)}</option>)}</select>
                  </div>
                  <div className="field tl-span"><label htmlFor="hp-addr">{tr('Address')}</label><input id="hp-addr" className="input" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></div>
                  <div className="field tl-span"><label htmlFor="hp-notes">{tr('Notes')}</label><textarea id="hp-notes" className="input" rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
                  <label className="tl-span hub-check"><input type="checkbox" checked={form.marketingOptOut} onChange={(e) => setForm({ ...form, marketingOptOut: e.target.checked })} /> {tr('They don\'t want marketing messages')}</label>
                  <div className="tl-span crm-chips"><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Save')}</button><button type="button" className="btn btn-secondary" onClick={() => setEditing(false)}>{tr('Cancel')}</button></div>
                </form>
              )}
            </section>
          </div>

          <div className="crm-lead-col">
            <section className="crm-box">
              <div className="crm-box-head"><h3 className="dk-h3">{tr('Conversations')}</h3><span className="dk-muted tl-small">{tr('{n} in all', { n: p.threads.length })}</span></div>
              {p.threads.length ? (
                <ul className="hub-threads">
                  {p.threads.map((t) => (
                    <li key={t.id}>
                      <button type="button" onClick={() => go('/crminbox?c=' + t.id)}>
                        <ChannelDot channel={t.channel} />
                        <span className="hub-thread-main">
                          <span className="hub-thread-top"><strong>{t.subject || channelLabel(t.channel)}</strong><span className="dk-muted tl-small">{ago(t.lastMessageAt)}</span></span>
                          <span className="dk-muted tl-small hub-clip">{t.lastDirection === 'out' ? tr('You:') + ' ' : ''}{t.lastPreview}</span>
                        </span>
                        {t.lastDirection === 'in' && t.status === 'open' && <span className="hub-waiting-dot" title={tr('Waiting for a reply')} />}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : <p className="dk-muted tl-small">{tr('No conversations yet. Messages from their numbers and addresses will show here.')}</p>}
              {canManage && (
                <form className="crm-noteform hub-log" onSubmit={(e) => { e.preventDefault(); run(() => api.post('/crm/profiles/' + p.id + '/log', log), tr('Written down.')).then((ok) => ok && setLog({ ...log, body: '' })); }}>
                  <div className="crm-chips">
                    <span className="tl-small"><strong>{tr('Log a call or visit')}</strong></span>
                    {CHANNELS.filter((c) => ['call', 'visit', 'sms', 'other'].includes(c.key)).map((c) => (
                      <button key={c.key} type="button" className={'ppl-chip' + (log.channel === c.key ? ' is-on' : '')} aria-pressed={log.channel === c.key} onClick={() => setLog({ ...log, channel: c.key })}>{tr(c.label)}</button>
                    ))}
                    <select className="input crm-date" value={log.direction} onChange={(e) => setLog({ ...log, direction: e.target.value })} aria-label={tr('Who reached out')}>
                      <option value="out">{tr('We reached out')}</option>
                      <option value="in">{tr('They reached out')}</option>
                    </select>
                  </div>
                  <textarea className="input" rows={2} value={log.body} onChange={(e) => setLog({ ...log, body: e.target.value })} placeholder={tr('What was said, and what happens next')} aria-label={tr('What was said')} />
                  <button type="submit" className="btn btn-secondary" disabled={busy || !log.body.trim()}>{tr('Write it down')}</button>
                </form>
              )}
            </section>

            <section className="crm-box">
              <div className="crm-box-head">
                <h3 className="dk-h3">{tr('Everything, newest first')}</h3>
                <div className="dk-segment" role="radiogroup" aria-label={tr('Show')}>
                  {[['all', tr('All')], ['messages', tr('Messages')], ['docs', tr('Sales')]].map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={tab === k} className={tab === k ? 'is-on' : ''} onClick={() => setTab(k)}>{l}</button>)}
                </div>
              </div>
              {timeline.length ? (
                <ol className="hub-timeline">
                  {timeline.slice(0, 150).map((t, i) => <TimelineItem key={i} t={t} go={go} />)}
                </ol>
              ) : <Empty icon="clock">{tr('Nothing yet.')}</Empty>}
            </section>
            {!mineOrFree && !canAssign && <p className="dk-muted tl-small">{tr('{name} looks after this customer.', { name: p.rep.name })}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

function TimelineItem({ t, go }) {
  if (t.kind === 'message') {
    return (
      <li className={'hub-tl is-msg hub-from-' + (t.direction === 'in' ? 'them' : 'us')}>
        <ChannelDot channel={t.channel} />
        <div className="hub-tl-body">
          <p className="hub-tl-meta"><strong>{t.direction === 'in' ? t.author || tr('Customer') : ourAuthor(t.sentBy, t.author)}</strong> · {channelLabel(t.channel)} · <time>{timeOf(t.at)}</time></p>
          <button type="button" className="hub-tl-text" onClick={() => go('/crminbox?c=' + t.conversationId)}>{t.body || '—'}</button>
        </div>
      </li>
    );
  }
  const icon = { quotation: 'doc', order: 'bag', invoice: 'receipt', payment: 'cash', lead: 'people', merge: 'layers' }[t.kind] || 'info';
  let text;
  switch (t.kind) {
    case 'quotation': text = tr('Quotation {ref} · {amount}', { ref: t.ref, amount: ghsOr(t.amount, t.currency) }); break;
    case 'order': text = tr('Sales order {ref} · {amount}', { ref: t.ref, amount: ghsOr(t.amount, t.currency) }) + (t.rep ? ' · ' + tr('Rep: {name}', { name: t.rep }) : ''); break;
    case 'invoice': text = tr('Invoice {ref} · {amount}', { ref: t.ref, amount: ghsOr(t.amount, t.currency) }) + (t.balance > 0 ? ' · ' + tr('{amount} to pay', { amount: ghsOr(t.balance, t.currency) }) : ''); break;
    case 'payment': text = tr('Paid {amount}', { amount: ghsOr(t.amount, t.currency) }) + (t.method ? ' · ' + t.method : ''); break;
    case 'lead': text = tr('Lead {ref}', { ref: t.ref }) + (t.title ? ': ' + t.title : ''); break;
    case 'merge': text = tr('Merged with the profile “{name}”', { name: t.title }); break;
    default: text = t.kind;
  }
  const link = t.kind === 'quotation' ? '/quotations?open=' + t.id : t.kind === 'order' ? '/salesorders?open=' + t.id : t.kind === 'invoice' ? '/invoices?open=' + t.id : t.kind === 'lead' ? '/crmleads?lead=' + t.id : null;
  return (
    <li className={'hub-tl is-doc is-' + t.kind}>
      <span className="hub-tl-icon"><Icon name={icon} /></span>
      <div className="hub-tl-body">
        <p className="hub-tl-meta"><time>{timeOf(t.at)}</time>{t.status && t.kind !== 'lead' ? ' · ' + docStatus(t.status) : ''}</p>
        {link ? <button type="button" className="hub-tl-text is-doc" onClick={() => go(link)}>{text}</button> : <p className="hub-tl-text is-doc">{text}</p>}
      </div>
    </li>
  );
}
