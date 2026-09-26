import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import ContactButtons from '../../components/ContactButtons';
import { Empty, Icon, Status, fmtDate } from '../../components/DashKit';
import { money } from '../../lib/currency';
import { activeIntlLocale, msg, tr } from '../../lib/i18n.jsx';

// What the CRM pages share (pages/crm/*): the stages a lead goes through,
// the lead window, the new-lead form, the spreadsheet import and the site
// visit form. Backed by /api/crm (backend/src/services/crm.service.js).

export const STAGES = [
  { key: 'new', label: msg('New lead'), tone: 'info', help: msg('Just came in. Nobody has spoken to them yet.') },
  { key: 'contacted', label: msg('Contacted'), tone: 'info', help: msg('We have replied or called.') },
  { key: 'follow_up', label: msg('Follow-up'), tone: 'warn', help: msg('Waiting on them, or we owe them a call.') },
  { key: 'qualified', label: msg('Qualified'), tone: 'info', help: msg('A real job: they know what they want and can pay.') },
  { key: 'quote_sent', label: msg('Quote sent'), tone: 'info', help: msg('They have our price.') },
  { key: 'negotiation', label: msg('Negotiation'), tone: 'warn', help: msg('Agreeing the price, the design or the date.') },
  { key: 'won', label: msg('Won'), tone: 'good', help: msg('They bought. The sale is linked to its invoice.') },
  { key: 'lost', label: msg('Lost'), tone: 'bad', help: msg('They went elsewhere or stopped answering.') }
];
export const OPEN_STAGES = STAGES.slice(0, 6).map((s) => s.key);
export function stage(key) { return STAGES.find((s) => s.key === key) || STAGES[0]; }
export function StageTag({ value }) { const s = stage(value); return <Status tone={s.tone}>{tr(s.label)}</Status>; }
export const ghs = (n) => money(n, 'GHS');

export function todayISO() { return new Date().toISOString().slice(0, 10); }
export function addDays(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
export function daysUntil(iso) { return iso ? Math.round((new Date(iso + 'T00:00:00Z') - new Date(todayISO() + 'T00:00:00Z')) / 86400000) : null; }
// "3 days overdue", "today", "tomorrow", "in 4 days"
export function followUpText(iso) {
  const d = daysUntil(iso);
  if (d === null) return tr('no follow-up set');
  if (d < 0) return d === -1 ? tr('1 day overdue') : tr('{n} days overdue', { n: -d });
  if (d === 0) return tr('today');
  if (d === 1) return tr('tomorrow');
  return tr('in {n} days', { n: d });
}
export function followUpClass(iso) { const d = daysUntil(iso); return d === null ? '' : d < 0 ? 'is-bad' : d === 0 ? 'is-warn' : ''; }
export function monthLabel(ym) { return new Date(ym + '-01T00:00:00').toLocaleDateString(activeIntlLocale(), { month: 'short', year: '2-digit' }); }

// The CRM settings and the people who can be picked as a rep or assessor.
export function useCrmBasics() {
  const [settings, setSettings] = useState(null);
  const [people, setPeople] = useState([]);
  const load = useCallback(async () => {
    const [s, p] = await Promise.all([api.get('/crm/settings'), api.get('/crm/people')]);
    setSettings(s); setPeople(p);
  }, []);
  useEffect(() => { load().catch(() => {}); }, [load]);
  return { settings, people, reload: load };
}

export function usePerms() {
  const { can } = useAuth();
  return { canManage: can('crm.manage'), canCommission: can('crm.commission'), canCustomer: can('customer.manage') };
}

export function Toast({ text, onDone }) {
  useEffect(() => { if (!text) return undefined; const t = setTimeout(onDone, 3500); return () => clearTimeout(t); }, [text, onDone]);
  return text ? <div className="toast" role="status">{text}</div> : null;
}

// ── a lead's form: new, or its details edited ────────────────────────
export function LeadFields({ form, set, settings, people }) {
  const sources = settings ? settings.sources : [];
  return (
    <div className="tl-form">
      <div className="field"><label htmlFor="cl-name">{tr('Name')}</label><input id="cl-name" className="input" value={form.name} onChange={(e) => set({ name: e.target.value })} required autoFocus /></div>
      <div className="field"><label htmlFor="cl-company">{tr('Company (optional)')}</label><input id="cl-company" className="input" value={form.company} onChange={(e) => set({ company: e.target.value })} /></div>
      <div className="field"><label htmlFor="cl-phone">{tr('Phone')}</label><input id="cl-phone" className="input" type="tel" value={form.phone} onChange={(e) => set({ phone: e.target.value })} /></div>
      <div className="field"><label htmlFor="cl-email">{tr('Email')}</label><input id="cl-email" className="input" type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} /></div>
      <div className="field"><label htmlFor="cl-location">{tr('Location')}</label><input id="cl-location" className="input" value={form.location} onChange={(e) => set({ location: e.target.value })} /></div>
      <div className="field">
        <label htmlFor="cl-source">{tr('How they found us')}</label>
        <select id="cl-source" className="input" value={form.source} onChange={(e) => set({ source: e.target.value })}>
          <option value="">{tr('Not known')}</option>
          {sources.map((s) => <option key={s} value={s}>{s}</option>)}
          {form.source && !sources.includes(form.source) && <option value={form.source}>{form.source}</option>}
        </select>
      </div>
      <div className="field tl-span"><label htmlFor="cl-item">{tr('What they want')}</label><input id="cl-item" className="input" placeholder={tr('e.g. sliding door, bamboo bed, 20 poles')} value={form.item} onChange={(e) => set({ item: e.target.value })} /></div>
      <div className="field">
        <label htmlFor="cl-rep">{tr('Sales rep')}</label>
        <select id="cl-rep" className="input" value={form.repId || ''} onChange={(e) => set({ repId: e.target.value })}>
          <option value="">{form.repName ? form.repName + ' ' + tr('(not in the OS)') : tr('Nobody yet')}</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <div className="field"><label htmlFor="cl-received">{tr('Date received')}</label><input id="cl-received" className="input" type="date" value={form.receivedOn} onChange={(e) => set({ receivedOn: e.target.value })} /></div>
      <div className="field"><label htmlFor="cl-follow">{tr('Next follow-up')}</label><input id="cl-follow" className="input" type="date" value={form.nextFollowUp || ''} onChange={(e) => set({ nextFollowUp: e.target.value })} /></div>
      <div className="field tl-span"><label htmlFor="cl-comments">{tr('Comments')}</label><textarea id="cl-comments" className="input" rows={3} value={form.comments} onChange={(e) => set({ comments: e.target.value })} /></div>
    </div>
  );
}
export function blankLead(meId) {
  return { name: '', company: '', phone: '', email: '', location: '', source: '', item: '', repId: meId || '', repName: '', receivedOn: todayISO(), nextFollowUp: '', comments: '' };
}
function leadToForm(l) {
  return { name: l.name, company: l.company, phone: l.phone, email: l.email, location: l.location, source: l.source, item: l.item, repId: l.repId || '', repName: l.repId ? '' : (l.repName || ''), receivedOn: l.receivedOn, nextFollowUp: l.nextFollowUp || '', comments: l.comments };
}
function formToBody(f) {
  const b = { ...f, nextFollowUp: f.nextFollowUp || null };
  if (!f.repId) { b.repId = null; b.repName = f.repName || ''; }
  return b;
}

export function NewLeadDialog({ settings, people, meId, onClose, onSaved }) {
  const [form, setForm] = useState(() => blankLead(meId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  async function save(e) {
    e.preventDefault();
    setSaving(true); setError(null);
    try { onSaved(await api.post('/crm/leads', formToBody(form))); } catch (err) { setError(err.message); setSaving(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={() => !saving && onClose()}>
      <form className="dialog tl-dialog crm-dialog" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>{tr('New lead')}</h2>
        <p className="dialog-body">{tr('Someone asked about a product. Write down who, how to reach them and what they want; the rest can wait.')}</p>
        <LeadFields form={form} set={(p) => setForm((f) => ({ ...f, ...p }))} settings={settings} people={people} />
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : tr('Add lead')}</button>
        </div>
      </form>
    </div>
  );
}

// ── the lead window ──────────────────────────────────────────────────
const NOTE_ICON = { note: 'doc', call: 'phone', stage: 'arrow', visit: 'calendar', deal: 'cash' };

export function LeadDialog({ leadId, settings, people, onClose, onChanged, onVisit }) {
  const navigate = useNavigate();
  const { canManage, canCommission, canCustomer } = usePerms();
  const [lead, setLead] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null);
  const [noteText, setNoteText] = useState('');
  const [noteKind, setNoteKind] = useState('call');
  const [losing, setLosing] = useState(null);
  const [linking, setLinking] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    try { setLead(await api.get('/crm/leads/' + leadId)); } catch (err) { setError(err.message); }
  }, [leadId]);
  useEffect(() => { load(); }, [load]);

  async function act(fn) {
    setBusy(true); setError(null);
    try { const r = await fn(); if (r && r.id === leadId) setLead(r); else await load(); if (onChanged) onChanged(); return true; } catch (err) { setError(err.message); return false; } finally { setBusy(false); }
  }
  const moveTo = (st, extra) => act(() => api.post('/crm/leads/' + leadId + '/stage', { stage: st, ...extra }));
  const setFollowUp = (iso) => act(() => api.put('/crm/leads/' + leadId, { nextFollowUp: iso }));

  async function openLinking() {
    setLinking({ q: '', list: null, kind: 'commission', repId: lead.repId || '' });
    try { const list = await api.get('/crm/invoices-to-link?leadId=' + leadId); setLinking((l) => l && { ...l, list }); } catch (err) { setError(err.message); }
  }
  async function searchInvoices(q) {
    setLinking((l) => ({ ...l, q }));
    try { const list = await api.get('/crm/invoices-to-link?leadId=' + leadId + '&q=' + encodeURIComponent(q)); setLinking((l) => l && { ...l, list }); } catch { /* keep the last list */ }
  }

  if (!lead) {
    return (
      <div className="dialog-backdrop" onClick={onClose}>
        <div className="dialog tl-dialog crm-dialog crm-lead" onClick={(e) => e.stopPropagation()}>{error ? <div className="error-banner">{error}</div> : <div className="eyebrow">{tr('Loading…')}</div>}</div>
      </div>
    );
  }
  const st = stage(lead.stage);
  const isOpen = OPEN_STAGES.includes(lead.stage);
  const today = todayISO();

  return (
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <div className="dialog tl-dialog crm-dialog crm-lead" role="dialog" aria-modal="true" aria-labelledby="crm-lead-title" onClick={(e) => e.stopPropagation()}>
        <div className="crm-lead-head">
          <div>
            <p className="dk-eyebrow">{lead.ref}{lead.sheetRef ? ' · ' + tr('{ref} in the sheet', { ref: lead.sheetRef }) : ''} · {tr('received {date}', { date: fmtDate(lead.receivedOn) })}</p>
            <h2 id="crm-lead-title">{lead.name}{lead.company ? <span className="dk-muted"> · {lead.company}</span> : null}</h2>
            <p className="dk-muted crm-lead-want">{lead.item ? tr('Wants: {item}', { item: lead.item }) : tr('What they want isn\'t written down yet.')}</p>
          </div>
          <button type="button" className="crm-x" onClick={onClose} aria-label={tr('Close')}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg></button>
        </div>

        {/* the stages, one tap to move */}
        <ol className="crm-steps" aria-label={tr('Stage')}>
          {STAGES.map((s, i) => {
            const at = STAGES.findIndex((x) => x.key === lead.stage);
            const cls = s.key === lead.stage ? ' is-now is-' + s.tone : (lead.stage !== 'lost' && s.key !== 'lost' && i < at ? ' is-done' : '');
            return (
              <li key={s.key} className={'crm-step' + cls + (s.key === 'won' || s.key === 'lost' ? ' is-end' : '')}>
                <button type="button" disabled={!canManage || busy || s.key === lead.stage} title={tr(s.help)}
                  onClick={() => (s.key === 'lost' ? setLosing('') : moveTo(s.key))}>
                  <span className="crm-step-dot">{s.key === 'won' ? <Icon name="check" /> : s.key === 'lost' ? <Icon name="void" /> : i + 1}</span>
                  <span className="crm-step-label">{tr(s.label)}</span>
                </button>
              </li>
            );
          })}
        </ol>
        <p className="dk-muted tl-small crm-step-help"><StageTag value={lead.stage} /> {tr(st.help)}{lead.stage === 'lost' && lead.lostReason ? ' ' + tr('Reason: {reason}', { reason: lead.lostReason }) : ''}</p>
        {losing !== null && (
          <div className="crm-inline">
            <input className="input" autoFocus placeholder={tr('Why was it lost? e.g. price, went elsewhere, no reply')} value={losing} onChange={(e) => setLosing(e.target.value)} />
            <button type="button" className="btn btn-primary" disabled={busy} onClick={async () => { if (await moveTo('lost', { lostReason: losing })) setLosing(null); }}>{tr('Mark as lost')}</button>
            <button type="button" className="btn btn-secondary" onClick={() => setLosing(null)}>{tr('Cancel')}</button>
          </div>
        )}
        {lead.stage === 'won' && !lead.dealCount && <div className="crm-note is-warn"><Icon name="warn" /> {tr('Won, but no sale is linked yet — link its invoice below so the revenue and the rep\'s commission count.')}</div>}
        {lead.sameContact && lead.sameContact.length > 0 && (
          <div className="crm-note is-info"><Icon name="info" /> {tr('Probably the same person as {leads} (same phone or email).', { leads: lead.sameContact.map((x) => x.ref + ' ' + x.name).join(', ') })}</div>
        )}
        {error && <div className="error-banner" role="alert">{error}</div>}

        <div className="crm-lead-grid">
          <div className="crm-lead-col">
            {/* who they are */}
            <section className="crm-box">
              <div className="crm-box-head">
                <h3 className="dk-h3">{tr('Contact')}</h3>
                {canManage && !editing && <button type="button" className="dk-link" onClick={() => setEditing(leadToForm(lead))}>{tr('Edit details')}</button>}
              </div>
              {editing ? (
                <form onSubmit={async (e) => { e.preventDefault(); if (await act(() => api.put('/crm/leads/' + leadId, formToBody(editing)))) setEditing(null); }}>
                  <LeadFields form={editing} set={(p) => setEditing((f) => ({ ...f, ...p }))} settings={settings} people={people} />
                  <div className="dialog-actions crm-box-actions">
                    <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>{tr('Cancel')}</button>
                    <button type="submit" className="btn btn-primary" disabled={busy}>{tr('Save')}</button>
                  </div>
                </form>
              ) : (
                <>
                  <dl className="crm-facts">
                    <div><dt>{tr('Phone')}</dt><dd>{lead.phone || '—'}</dd></div>
                    <div><dt>{tr('Email')}</dt><dd>{lead.email || '—'}</dd></div>
                    <div><dt>{tr('Location')}</dt><dd>{lead.location || '—'}</dd></div>
                    <div><dt>{tr('How they found us')}</dt><dd>{lead.source || '—'}</dd></div>
                    <div><dt>{tr('Sales rep')}</dt><dd>{lead.repName || tr('Nobody yet')}</dd></div>
                    <div><dt>{tr('Customer')}</dt><dd>{lead.customerName || tr('Not a customer yet')}</dd></div>
                  </dl>
                  <ContactButtons name={lead.name} phone={lead.phone} email={lead.email} />
                  {lead.comments && <p className="crm-comments">{lead.comments}</p>}
                </>
              )}
            </section>

            {/* when to get back to them */}
            {isOpen && (
              <section className="crm-box">
                <h3 className="dk-h3">{tr('Next follow-up')}</h3>
                <p className={'crm-follow ' + followUpClass(lead.nextFollowUp)}>
                  <Icon name="calendar" /> {lead.nextFollowUp ? fmtDate(lead.nextFollowUp) + ' · ' + followUpText(lead.nextFollowUp) : tr('Not set — a lead with no date is easily forgotten.')}
                </p>
                {canManage && (
                  <div className="crm-chips">
                    {[[tr('Tomorrow'), 1], [tr('In 3 days'), 3], [tr('Next week'), 7], [tr('In 2 weeks'), 14]].map(([label, n]) => (
                      <button key={n} type="button" className="ppl-chip" disabled={busy} onClick={() => setFollowUp(addDays(today, n))}>{label}</button>
                    ))}
                    <input className="input crm-date" type="date" aria-label={tr('Pick a date')} value={lead.nextFollowUp || ''} onChange={(e) => e.target.value && setFollowUp(e.target.value)} />
                    {lead.nextFollowUp && <button type="button" className="dk-link" onClick={() => setFollowUp(null)}>{tr('Clear')}</button>}
                  </div>
                )}
              </section>
            )}

            {/* the sale */}
            <section className="crm-box">
              <div className="crm-box-head">
                <h3 className="dk-h3">{tr('Sale')}</h3>
                {canManage && !linking && <button type="button" className="dk-link" onClick={openLinking}>{tr('Link an invoice')}</button>}
              </div>
              {lead.deals.length ? (
                <ul className="dk-rows">
                  {lead.deals.map((d) => (
                    <li key={d.id} className="dk-row crm-deal">
                      <span className={'dk-lead-icon ' + (d.ready ? 'is-good' : 'is-warn')}><Icon name="receipt" /></span>
                      <div className="dk-row-main">
                        <div className="dk-row-title">{d.invoiceNo} · {d.customerName}</div>
                        <div className="dk-muted dk-row-meta">
                          {fmtDate(d.issuedAt)} · {d.discountPct ? tr('{pct}% discount', { pct: d.discountPct }) : tr('no discount')}
                          {d.balance > 0 ? ' · ' + tr('{amount} still owed', { amount: ghs(d.balance) }) : ' · ' + tr('paid in full')}
                        </div>
                        {d.commission !== null && (
                          <div className="dk-muted dk-row-meta">
                            {d.kind === 'kickback' ? tr('Kick-back') : tr('Commission')} {d.repName ? tr('for {name}', { name: d.repName }) : ''}: {tr('{base}% − {disc}% discount = {rate}%', { base: d.baseRate, disc: d.discountPct, rate: d.rate })} → <strong>{ghs(d.commission)}</strong>
                          </div>
                        )}
                      </div>
                      <div className="dk-row-side">
                        <div className="dk-row-amount">{ghs(d.total)}</div>
                        <div className="dk-row-note"><Status tone={d.status === 'paid' ? 'good' : d.status === 'not_eligible' ? 'muted' : d.ready ? 'warn' : 'info'}>
                          {d.status === 'paid' ? tr('Commission paid') : d.status === 'not_eligible' ? tr('No commission') : d.ready ? tr('Commission to pay') : tr('Waiting for payment')}
                        </Status></div>
                        {canManage && d.status !== 'paid' && <button type="button" className="dk-link" onClick={() => act(() => api.del('/crm/deals/' + d.id))}>{tr('Unlink')}</button>}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : !linking && (
                <p className="dk-muted tl-small">
                  {lead.customerId ? tr('When they buy, raise the quotation and invoice for {name}, then link the invoice here.', { name: lead.customerName }) : tr('To quote or invoice them, first add them as a customer.')}
                </p>
              )}
              {!lead.customerId && canManage && canCustomer && !linking && (
                <button type="button" className="btn btn-secondary crm-mt" disabled={busy} onClick={() => act(() => api.post('/crm/leads/' + leadId + '/customer', {}))}>{tr('Add as a customer')}</button>
              )}
              {lead.customerId && isOpen && <button type="button" className="btn btn-secondary crm-mt" onClick={() => navigate('/quotations')}>{tr('Open quotations')}</button>}
              {linking && (
                <div className="crm-link">
                  <div className="crm-inline">
                    <input className="input" placeholder={tr('Search invoice number or customer')} value={linking.q} onChange={(e) => searchInvoices(e.target.value)} />
                    <select className="input" value={linking.kind} onChange={(e) => setLinking({ ...linking, kind: e.target.value })} aria-label={tr('Who gets the share')}>
                      <option value="commission">{tr('Commission (sales rep)')}</option>
                      <option value="kickback">{tr('Kick-back (someone else)')}</option>
                    </select>
                    <select className="input" value={linking.repId} onChange={(e) => setLinking({ ...linking, repId: e.target.value })} aria-label={tr('Paid to')}>
                      <option value="">{tr('Nobody')}</option>
                      {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </div>
                  {!linking.list ? <p className="dk-muted tl-small">{tr('Loading…')}</p> : !linking.list.length ? <Empty icon="receipt">{tr('No sales invoice to link. Raise the invoice first (Quotations & Invoicing), then come back.')}</Empty> : (
                    <ul className="crm-pick">
                      {linking.list.map((iv) => (
                        <li key={iv.id}>
                          <button type="button" disabled={busy} onClick={async () => { if (await act(() => api.post('/crm/leads/' + leadId + '/deals', { invoiceId: iv.id, kind: linking.kind, repId: linking.repId || null }))) setLinking(null); }}>
                            <span><strong>{iv.invoiceNo}</strong> · {iv.customerName}{iv.sameCustomer ? <span className="crm-badge">{tr('this customer')}</span> : null}</span>
                            <span className="dk-muted">{fmtDate(iv.issuedAt)} · {ghs(iv.total)}{iv.balance > 0 ? ' · ' + tr('{amount} owed', { amount: ghs(iv.balance) }) : ''}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <button type="button" className="dk-link" onClick={() => setLinking(null)}>{tr('Cancel')}</button>
                </div>
              )}
              {!canCommission && lead.deals.some((d) => d.commission === null) && <p className="dk-muted tl-small">{tr('Commission on another rep\'s sale is only shown to them and to managers.')}</p>}
            </section>

            {/* site visits */}
            <section className="crm-box">
              <div className="crm-box-head">
                <h3 className="dk-h3">{tr('Site visits')}</h3>
                {canManage && onVisit && <button type="button" className="dk-link" onClick={() => onVisit({ leadId: lead.id, client: lead.name, location: lead.location })}>{tr('Book a visit')}</button>}
              </div>
              {lead.visits.length ? (
                <ul className="crm-mini">
                  {lead.visits.map((v) => (
                    <li key={v.id}><Status tone={v.status === 'visited' ? 'good' : v.status === 'cancelled' ? 'muted' : 'info'}>{visitLabel(v.status)}</Status> {fmtDate(v.scheduledOn)}{v.location ? ' · ' + v.location : ''}{v.findings ? <span className="dk-muted"> — {v.findings}</span> : null}</li>
                  ))}
                </ul>
              ) : <p className="dk-muted tl-small">{tr('No visit booked.')}</p>}
            </section>
          </div>

          <div className="crm-lead-col">
            {/* what happened */}
            <section className="crm-box">
              <h3 className="dk-h3">{tr('History')}</h3>
              {canManage && (
                <form className="crm-noteform" onSubmit={async (e) => { e.preventDefault(); if (noteText.trim() && await act(() => api.post('/crm/leads/' + leadId + '/notes', { kind: noteKind, body: noteText }))) setNoteText(''); }}>
                  <div className="dk-segment" role="radiogroup" aria-label={tr('Kind')}>
                    {[['call', tr('Call')], ['note', tr('Note')]].map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={noteKind === k} className={noteKind === k ? 'is-on' : ''} onClick={() => setNoteKind(k)}>{label}</button>)}
                  </div>
                  <textarea className="input" rows={2} placeholder={noteKind === 'call' ? tr('What did they say?') : tr('Anything worth remembering')} value={noteText} onChange={(e) => setNoteText(e.target.value)} />
                  <button type="submit" className="btn btn-primary" disabled={busy || !noteText.trim()}>{tr('Add to history')}</button>
                </form>
              )}
              <ol className="crm-history">
                {lead.notes.map((n) => (
                  <li key={n.id} className={'is-' + n.kind}>
                    <span className="crm-history-icon"><Icon name={NOTE_ICON[n.kind] || 'doc'} /></span>
                    <div>
                      <p className="crm-history-text">
                        {n.kind === 'stage' && n.toStage ? (n.fromStage ? tr('Moved from {from} to {to}.', { from: tr(stage(n.fromStage).label), to: tr(stage(n.toStage).label) }) : tr('Added at the {stage} stage.', { stage: tr(stage(n.toStage).label) })) : null}
                        {n.kind === 'call' ? <strong>{tr('Call')}: </strong> : null}
                        {n.body && !(n.kind === 'stage' && n.body === 'Lead added.') ? ' ' + historyText(n.body) : ''}
                      </p>
                      <p className="dk-muted tl-small">{new Date(n.at).toLocaleString(activeIntlLocale(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}{n.by ? ' · ' + n.by : ''}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
            {canManage && (
              <div className="crm-danger">
                {!confirmDelete ? <button type="button" className="dk-link" disabled={lead.dealCount > 0} title={lead.dealCount > 0 ? tr('A lead with a sale linked is kept.') : undefined} onClick={() => setConfirmDelete(true)}>{tr('Delete this lead')}</button> : (
                  <span className="crm-inline">
                    {tr('Delete {ref} and its history?', { ref: lead.ref })}
                    <button type="button" className="btn btn-danger" disabled={busy} onClick={async () => { setBusy(true); try { await api.del('/crm/leads/' + leadId); if (onChanged) onChanged(); onClose(); } catch (err) { setError(err.message); setBusy(false); } }}>{tr('Delete')}</button>
                    <button type="button" className="btn btn-secondary" onClick={() => setConfirmDelete(false)}>{tr('Keep')}</button>
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// The history lines the server writes itself, in the reader's language.
function historyText(body) {
  let m;
  if (body === 'Imported from the spreadsheet.') return tr('Imported from the spreadsheet.');
  if (body === 'Added as a customer.') return tr('Added as a customer.');
  if (body === 'Linked to the existing customer with the same contact details.') return tr('Linked to the existing customer with the same contact details.');
  if (body === 'Site visit cancelled.') return tr('Site visit cancelled.');
  if ((m = /^Sale linked: invoice (.+)\.$/.exec(body))) return tr('Sale linked: invoice {no}.', { no: m[1] });
  if ((m = /^Sale unlinked: invoice (.+)\.$/.exec(body))) return tr('Sale unlinked: invoice {no}.', { no: m[1] });
  if ((m = /^Site visit booked for (\d{4}-\d{2}-\d{2})\.$/.exec(body))) return tr('Site visit booked for {date}.', { date: fmtDate(m[1]) });
  if ((m = /^Site visited\.\s*(.*)$/.exec(body))) return tr('Site visited.') + (m[1] ? ' ' + m[1] : '');
  return body;
}

export function visitLabel(s) { return s === 'visited' ? tr('Visited') : s === 'cancelled' ? tr('Cancelled') : tr('Booked'); }

// ── a site visit's form ──────────────────────────────────────────────
export function VisitDialog({ visit, people, onClose, onSaved, onDeleted }) {
  const [form, setForm] = useState(() => ({
    client: visit.client || '', location: visit.location || '', scheduledOn: visit.scheduledOn || todayISO(), status: visit.status || 'scheduled',
    assessorIds: visit.assessors ? visit.assessors.map((a) => a.id) : [], assessorsText: visit.assessorsText || '', findings: visit.findings || '', leadId: visit.leadId || null
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (p) => setForm((f) => ({ ...f, ...p }));
  async function save(e) {
    e.preventDefault();
    setSaving(true); setError(null);
    try { onSaved(visit.id ? await api.put('/crm/visits/' + visit.id, form) : await api.post('/crm/visits', form)); } catch (err) { setError(err.message); setSaving(false); }
  }
  return (
    <div className="dialog-backdrop crm-over" onClick={() => !saving && onClose()}>
      <form className="dialog tl-dialog crm-dialog" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>{visit.id ? tr('Site visit') : tr('Book a site visit')}</h2>
        <div className="tl-form">
          <div className="field"><label htmlFor="cv-client">{tr('Client')}</label><input id="cv-client" className="input" value={form.client} onChange={(e) => set({ client: e.target.value })} required /></div>
          <div className="field"><label htmlFor="cv-loc">{tr('Location')}</label><input id="cv-loc" className="input" value={form.location} onChange={(e) => set({ location: e.target.value })} /></div>
          <div className="field"><label htmlFor="cv-date">{tr('Date')}</label><input id="cv-date" className="input" type="date" value={form.scheduledOn} onChange={(e) => set({ scheduledOn: e.target.value })} required /></div>
          <div className="field">
            <span className="tl-label">{tr('Status')}</span>
            <div className="dk-segment" role="radiogroup" aria-label={tr('Status')}>
              {['scheduled', 'visited', 'cancelled'].map((s) => <button key={s} type="button" role="radio" aria-checked={form.status === s} className={form.status === s ? 'is-on' : ''} onClick={() => set({ status: s })}>{visitLabel(s)}</button>)}
            </div>
          </div>
          <div className="field tl-span">
            <span className="tl-label">{tr('Who goes')}</span>
            <div className="crm-people">
              {people.map((p) => (
                <label key={p.id} className={'ppl-chip' + (form.assessorIds.includes(p.id) ? ' is-on' : '')}>
                  <input type="checkbox" className="sr-only" checked={form.assessorIds.includes(p.id)} onChange={(e) => set({ assessorIds: e.target.checked ? [...form.assessorIds, p.id] : form.assessorIds.filter((x) => x !== p.id) })} />
                  {p.name}
                </label>
              ))}
            </div>
            <input className="input crm-mt" placeholder={tr('Anyone else (not in the OS)')} value={form.assessorsText} onChange={(e) => set({ assessorsText: e.target.value })} />
          </div>
          <div className="field tl-span"><label htmlFor="cv-find">{tr('What was found')}</label><textarea id="cv-find" className="input" rows={3} placeholder={tr('Measurements, the site, what the client decided')} value={form.findings} onChange={(e) => set({ findings: e.target.value })} /></div>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions">
          {visit.id && onDeleted && <button type="button" className="btn btn-secondary crm-left" disabled={saving} onClick={async () => { setSaving(true); try { await api.del('/crm/visits/' + visit.id); onDeleted(); } catch (err) { setError(err.message); setSaving(false); } }}>{tr('Delete')}</button>}
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : tr('Save')}</button>
        </div>
      </form>
    </div>
  );
}

// ── the spreadsheet import ───────────────────────────────────────────
const TAB_LABEL = { leads: msg('Leads'), purchases: msg('Purchases (sales)'), visits: msg('Site visits'), referrals: msg('Referrals'), prospects: msg('Prospects') };

export function ImportDialog({ onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function send(path, f) {
    const body = new FormData();
    body.append('file', f);
    return api.upload(path, body);
  }
  async function pick(f) {
    setFile(f); setPreview(null); setResult(null); setError(null);
    if (!f) return;
    setBusy(true);
    try { setPreview(await send('/crm/import/preview', f)); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function run() {
    setBusy(true); setError(null);
    try { setResult(await send('/crm/import', file)); if (onDone) onDone(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  const rows = preview ? [['leads', preview.leads], ['sales', preview.sales], ['visits', preview.visits], ['referrals', preview.referrals], ['prospects', preview.prospects]].filter(([, c]) => c.found) : [];
  const names = { leads: tr('Leads'), sales: tr('Sales (won leads)'), visits: tr('Site visits'), referrals: tr('Referrals'), prospects: tr('Prospects') };
  return (
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <div className="dialog tl-dialog crm-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>{tr('Import from a spreadsheet')}</h2>
        <ol className="crm-howto">
          <li>{tr('Open the Google Sheet (the CRM or the customer leads list).')}</li>
          <li>{tr('File → Download → Microsoft Excel (.xlsx).')}</li>
          <li>{tr('Choose that file here. You see what it holds before anything is saved.')}</li>
        </ol>
        <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => pick(e.target.files[0] || null)} disabled={busy} />
        {busy && !preview && <p className="dk-muted tl-small">{tr('Reading the workbook…')}</p>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        {preview && !result && (
          <>
            <p className="dk-muted tl-small">{tr('Tabs read: {tabs}. The dashboard, summary and lists are worked out by the OS, so they aren\'t imported.', { tabs: preview.tabs.map((t) => (t.name.trim().toLowerCase() === tr(TAB_LABEL[t.kind]).toLowerCase() ? t.name : t.name + ' → ' + tr(TAB_LABEL[t.kind]))).join(', ') })}</p>
            <ul className="dk-rows">
              {rows.map(([k, c]) => (
                <Row2 key={k} title={names[k]} meta={c.already ? tr('{n} already in the OS — left as they are', { n: c.already }) : tr('none in the OS yet')} amount={tr('{n} new', { n: c.new })} />
              ))}
            </ul>
            {preview.unknownPeople.length > 0 && <div className="crm-note is-info"><Icon name="info" /> {tr('Not found among OS staff, so kept as names: {names}. Pick the right person on each lead later if they are staff.', { names: preview.unknownPeople.join(', ') })}</div>}
            {preview.salesJoiningLeads > 0 && <div className="crm-note is-info"><Icon name="info" /> {tr('{n} of the sales are by people already among the leads, so they are marked won on that lead instead of being added twice.', { n: preview.salesJoiningLeads })}</div>}
            {preview.sales.new > 0 && <p className="dk-muted tl-small">{tr('Each sale becomes a won lead. It is linked to its OS invoice when exactly one invoice matches the customer, the amount and the date; the others wait for someone to link them.')}</p>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
              <button type="button" className="btn btn-primary" disabled={busy || !rows.some(([, c]) => c.new)} onClick={run}>{busy ? tr('Importing…') : tr('Import')}</button>
            </div>
          </>
        )}
        {result && (
          <>
            <div className="crm-note is-good"><Icon name="check" /> {tr('Imported: {leads} leads, {sales} sales ({linked} linked to invoices), {visits} site visits, {referrals} referrals, {prospects} prospects.', result)}</div>
            {result.joined > 0 && <p className="dk-muted tl-small">{tr('{n} sales went on leads that were already there, so nobody is counted twice.', { n: result.joined })}</p>}
            {result.unlinkedSales.length > 0 && <p className="dk-muted tl-small">{tr('{n} sales have no matching OS invoice yet. They are won leads with a note saying so; link each one\'s invoice from the lead when it is in the OS.', { n: result.unlinkedSales.length })}</p>}
            <div className="dialog-actions"><button type="button" className="btn btn-primary" onClick={onClose}>{tr('Done')}</button></div>
          </>
        )}
      </div>
    </div>
  );
}
function Row2({ title, meta, amount }) {
  return (
    <li className="dk-row">
      <div className="dk-row-main"><div className="dk-row-title">{title}</div><div className="dk-muted dk-row-meta">{meta}</div></div>
      <div className="dk-row-side"><div className="dk-row-amount">{amount}</div></div>
    </li>
  );
}
