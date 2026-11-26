import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api/client';
import { phoneKey } from '../lib/contacts';
import { tr } from '../lib/i18n.jsx';
import './CustomerPicker.css';

// Search-or-browse customer field for the Quotations/Estimates/Invoices
// wizard's Details step, replacing a plain <select> that made finding one
// customer among dozens (this app's customer list runs well past what a
// dropdown can browse comfortably) painful. Unlike CatalogPicker, the
// submitted value here has to be a real customer id (not free text), so
// this keeps its own "are we searching or showing the selection" state
// rather than making the input's value the thing that gets submitted.
//
// It looks among the leads too (leads, from lib/contacts useLeadsToPick):
// someone who asked about a product but isn't a customer yet. Picking one
// makes them a customer — or puts the lead on the customer with the same
// phone number or email, their WhatsApp contact say (backend
// customers.service fromLead). And it adds a new customer (canAdd), after
// showing anyone already in the OS with that name, number or email. Phone
// numbers match however they are written. onAdded(customer) hands the
// page the customer made or found, to add to its list.
//
// Portaled to document.body for the same reason as CatalogPicker: every
// call site sits inside a dialog with its own scrolling body, and a plain
// position:absolute dropdown would get clipped by that overflow.

function normalize(v) { return (v == null ? '' : String(v)).toLowerCase().trim(); }
const STAGE = { new: 'New lead', contacted: 'Contacted', follow_up: 'Follow-up', qualified: 'Qualified', quote_sent: 'Quote sent', negotiation: 'Negotiation', won: 'Won', lost: 'Lost' };
function stageName(s) { return STAGE[s] ? tr(STAGE[s]) : s; }
const CATEGORY = { lead: 'Lead', prospect: 'Prospect', active: 'Customer', inactive: 'Inactive', vip: 'VIP', contact: 'Contact' };

// Does this person (a customer or a lead) answer the search q?
function matches(p, q, qPhone) {
  if (!q) return true;
  if ([p.name, p.company, p.contactPerson, p.email, p.ref, p.item, p.location].some((v) => normalize(v).includes(q))) return true;
  return qPhone.length >= 3 && phoneKey(p.phone).includes(qPhone);
}

// Who is already in the OS with this name, number or email.
function alreadyHere(f, customers, leads) {
  const name = normalize(f.name), ph = phoneKey(f.phone), mail = normalize(f.email);
  const same = (p) => (name.length >= 3 && (normalize(p.name) === name || normalize(p.company) === name || normalize(p.contactPerson) === name))
    || (ph.length >= 9 && phoneKey(p.phone).slice(-9) === ph.slice(-9))
    || (mail.includes('@') && normalize(p.email) === mail);
  return { customers: customers.filter(same).slice(0, 4), leads: leads.filter(same).slice(0, 4) };
}

function NewCustomer({ start, customers, leads, onCustomer, onLead, onClose }) {
  const [f, setF] = useState(start);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setF((o) => ({ ...o, [k]: v }));
  const here = alreadyHere(f, customers, leads);
  const found = here.customers.length + here.leads.length;
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onCustomer(await api.post('/customers', { name: f.name, contactPerson: f.contactPerson, phone: f.phone, email: f.email, address: f.address, category: 'lead' }), true); }
    catch (err) { setError(err.message); setBusy(false); }
  }
  async function takeLead(l) {
    setBusy(true); setError(null);
    try { await onLead(l); } catch (err) { setError(err.message); setBusy(false); }
  }
  return createPortal(
    <div className="dialog-backdrop custpick-new-back" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <form className="dialog custpick-new" role="dialog" aria-modal="true" aria-labelledby="custpick-new-title" onSubmit={save}>
        <h2 id="custpick-new-title">{tr('New customer')}</h2>
        <p className="dialog-body">{tr('Who the document is for. They are added to the customers, and to the leads with the same number.')}</p>
        <div className="custpick-new-grid">
          <label className="field custpick-span"><span>{tr('Name (a person or a company)')}</span>
            <input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} required maxLength={100} autoFocus />
          </label>
          <label className="field"><span>{tr('Phone')}</span>
            <input className="input" type="tel" value={f.phone} onChange={(e) => set('phone', e.target.value)} maxLength={40} />
          </label>
          <label className="field"><span>{tr('Email')}</span>
            <input className="input" type="email" value={f.email} onChange={(e) => set('email', e.target.value)} maxLength={120} />
          </label>
          <label className="field"><span>{tr('Contact person (optional)')}</span>
            <input className="input" value={f.contactPerson} onChange={(e) => set('contactPerson', e.target.value)} maxLength={100} />
          </label>
          <label className="field"><span>{tr('Location (optional)')}</span>
            <input className="input" value={f.address} onChange={(e) => set('address', e.target.value)} maxLength={200} />
          </label>
        </div>
        {found > 0 && (
          <div className="custpick-here" role="status">
            <strong>{tr('Already in the OS? Use them instead of adding them twice:')}</strong>
            <ul>
              {here.customers.map((c) => (
                <li key={c.id}>
                  <span><b>{c.name}</b> <small>{[tr(CATEGORY[c.category] || 'Customer'), c.phone, c.email].filter(Boolean).join(' · ')}</small></span>
                  <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => onCustomer(c, false)}>{tr('Use')}</button>
                </li>
              ))}
              {here.leads.map((l) => (
                <li key={l.id}>
                  <span><b>{l.name}</b> <small>{[tr('Lead') + ' ' + l.ref, l.company, l.phone].filter(Boolean).join(' · ')}</small></span>
                  <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => takeLead(l)}>{tr('Use')}</button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !f.name.trim()}>{busy ? tr('Saving…') : found ? tr('Add a new one anyway') : tr('Add the customer')}</button>
        </div>
      </form>
    </div>,
    document.body
  );
}

const SHOW_LEADS = 25;

export default function CustomerPicker({ customers, value, onChange, placeholder, required, id, leads, canAdd, onAdded }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [rect, setRect] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(null);
  const wrapRef = useRef(null);
  const panelRef = useRef(null);

  const selected = (customers || []).find((c) => c.id === value) || null;
  const displayValue = open ? query : (selected ? selected.name : '');

  function openPanel() {
    setQuery('');
    setError(null);
    if (wrapRef.current) setRect(wrapRef.current.getBoundingClientRect());
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return undefined;
    function onDocMouseDown(e) {
      if (wrapRef.current && wrapRef.current.contains(e.target)) return;
      if (panelRef.current && panelRef.current.contains(e.target)) return;
      setOpen(false);
    }
    function reposition() { if (wrapRef.current) setRect(wrapRef.current.getBoundingClientRect()); }
    document.addEventListener('mousedown', onDocMouseDown);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open]);

  const q = normalize(query);
  const qPhone = phoneKey(query);
  const list = useMemo(() => customers || [], [customers]);
  const filtered = useMemo(() => list.filter((c) => matches(c, q, qPhone)), [list, q, qPhone]);
  // Leads only where they can become customers here.
  const leadList = useMemo(() => (canAdd && leads ? leads.filter((l) => matches(l, q, qPhone)).slice(0, q ? SHOW_LEADS : 8) : []), [canAdd, leads, q, qPhone]);
  const options = filtered.map((c) => ({ kind: 'customer', item: c })).concat(leadList.map((l) => ({ kind: 'lead', item: l })));

  function pick(c) {
    onChange(c.id);
    setOpen(false);
    setQuery('');
    setHighlight(0);
  }
  // A lead becomes a customer (or goes on the one with its number), then is picked.
  async function pickLead(l) {
    setBusy(true); setError(null);
    try {
      const c = await api.post('/customers/from-lead', { leadId: l.id });
      if (onAdded) onAdded(c);
      pick(c);
    } catch (err) { setError(err.message); throw err; } finally { setBusy(false); }
  }
  function choose(o) { if (o.kind === 'lead') pickLead(o.item).catch(() => {}); else pick(o.item); }
  function startNew() {
    const raw = query.trim();
    const start = { name: '', phone: '', email: '', contactPerson: '', address: '' };
    if (raw.includes('@')) start.email = raw;
    else if (phoneKey(raw).length >= 6 && /^[\d\s+()-]+$/.test(raw)) start.phone = raw;
    else start.name = raw;
    setOpen(false);
    setAdding(start);
  }

  function onKeyDown(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) openPanel(); setHighlight((h) => Math.min(h + 1, options.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') { if (open && options[highlight]) { e.preventDefault(); choose(options[highlight]); } }
    else if (e.key === 'Escape') { setOpen(false); }
  }

  const withLeads = !!(canAdd && leads);
  return (
    <div className="custpick-wrap" ref={wrapRef}>
      <div className="custpick-input-wrap">
        <svg className="custpick-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <circle cx="9" cy="9" r="6.5" stroke="currentColor" strokeWidth="1.6" />
          <path d="M18 18L14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <input
          id={id}
          type="text"
          className="input custpick-input"
          required={required}
          value={displayValue}
          placeholder={placeholder || (withLeads ? tr('Search customers and leads: name, phone, email…') : tr('Search customers…'))}
          onFocus={openPanel}
          onChange={(e) => { setQuery(e.target.value); if (!open) setOpen(true); setHighlight(0); }}
          onKeyDown={onKeyDown}
        />
      </div>
      {open && rect && createPortal(
        <div className={'custpick-panel' + (withLeads ? ' is-wide' : '')} ref={panelRef} style={{ top: rect.bottom + 3, left: rect.left, minWidth: rect.width }}>
          {withLeads && <div className="custpick-head">{tr('Customers')}</div>}
          {filtered.length === 0 && <div className="custpick-empty">{tr('No matching customers')}</div>}
          {filtered.map((c, i) => (
            <button
              type="button"
              key={c.id}
              className={'custpick-option' + (i === highlight ? ' custpick-option-active' : '')}
              onMouseDown={(e) => { e.preventDefault(); pick(c); }}
              onMouseEnter={() => setHighlight(i)}
            >
              <span className="custpick-option-name">{c.name}{withLeads && c.category && CATEGORY[c.category] ? <span className="custpick-tag">{tr(CATEGORY[c.category])}</span> : null}</span>
              {(c.email || c.phone) && <span className="custpick-option-sub">{[c.phone, c.email].filter(Boolean).join(' · ')}</span>}
            </button>
          ))}
          {leadList.length > 0 && (
            <>
              <div className="custpick-head">{tr('Leads, not customers yet')} <small>{tr('picked, they become a customer')}</small></div>
              {leadList.map((l, k) => {
                const i = filtered.length + k;
                return (
                  <button
                    type="button"
                    key={l.id}
                    disabled={busy}
                    className={'custpick-option is-lead' + (i === highlight ? ' custpick-option-active' : '')}
                    onMouseDown={(e) => { e.preventDefault(); pickLead(l).catch(() => {}); }}
                    onMouseEnter={() => setHighlight(i)}
                  >
                    <span className="custpick-option-name">{l.name}{l.company ? ' · ' + l.company : ''}<span className="custpick-tag is-lead">{l.ref} · {stageName(l.stage)}</span></span>
                    <span className="custpick-option-sub">{[l.phone, l.email, l.item].filter(Boolean).join(' · ') || '—'}</span>
                  </button>
                );
              })}
            </>
          )}
          {busy && <div className="custpick-empty">{tr('Making them a customer…')}</div>}
          {error && <div className="custpick-error" role="alert">{error}</div>}
          {canAdd && (
            <button type="button" className="custpick-add" onMouseDown={(e) => { e.preventDefault(); startNew(); }}>
              ＋ {query.trim() ? tr('New customer: {name}', { name: query.trim() }) : tr('New customer')}
            </button>
          )}
        </div>,
        document.body
      )}
      {adding && (
        <NewCustomer start={adding} customers={list} leads={leads || []} onClose={() => setAdding(null)}
          onCustomer={(c, made) => { if (made && onAdded) onAdded(c); pick(c); setAdding(null); }}
          onLead={async (l) => { await pickLead(l); setAdding(null); }} />
      )}
    </div>
  );
}
