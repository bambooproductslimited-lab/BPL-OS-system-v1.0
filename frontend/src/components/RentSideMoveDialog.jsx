import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { money } from '../lib/currency';
import { tr } from '../lib/i18n.jsx';
import { fmtDate } from './DashKit';
import './EmailDocumentDialog.css';
import './RentSideMoveDialog.css';

// Rent-side invoices that sit in Bamboo Products' invoices — CAM and water &
// power fees, mostly from Square — brought over to Poki (backend
// rentSideMove.service.js). Grouped by customer: untick what isn't rent,
// say what each customer's charges are, and pick the Poki tenant they belong
// to (or let them become one). Nothing moves until "Move".

const KINDS = ['cam', 'utility', 'rent', 'other'];
function kindName(k) {
  return { cam: tr('CAM / service charge'), utility: tr('Water & power'), rent: tr('Rent'), other: tr('Several of these') }[k] || k;
}

export default function RentSideMoveDialog({ tenants, onClose, onDone }) {
  const [groups, setGroups] = useState(null);
  const [pick, setPick] = useState({}); // invoiceId -> true
  const [kind, setKind] = useState({}); // customerId -> kind
  const [tenant, setTenant] = useState({}); // customerId -> tenantId | ''
  const [open, setOpen] = useState({});
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(null);

  useEffect(() => {
    let alive = true;
    api.get('/poki/rent-side-invoices').then((g) => {
      if (!alive) return;
      setGroups(g);
      const p = {}, k = {}, t = {};
      g.forEach((x) => { x.invoices.forEach((i) => { p[i.id] = true; }); k[x.customerId] = x.suggestedKind || ''; t[x.customerId] = x.matchTenantId || ''; });
      setPick(p); setKind(k); setTenant(t);
    }).catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, []);

  const chosen = useMemo(() => (groups || []).map((g) => ({ g, ids: g.invoices.filter((i) => pick[i.id]).map((i) => i.id) })).filter((x) => x.ids.length), [groups, pick]);
  const count = chosen.reduce((s, x) => s + x.ids.length, 0);
  // A choice is only needed for invoices whose lines don't say what they are.
  const unknownIn = (g) => g.invoices.filter((i) => pick[i.id] && !i.kind);
  const missingKind = chosen.filter((x) => unknownIn(x.g).length && !kind[x.g.customerId]);

  async function save() {
    setSaving(true); setError(null);
    try {
      const r = await api.post('/poki/rent-side-invoices/move', {
        groups: chosen.map(({ g, ids }) => ({ customerId: g.customerId, invoiceIds: ids, kind: kind[g.customerId], tenantId: tenant[g.customerId] || undefined }))
      });
      setDone(r);
      if (onDone) onDone(r);
    } catch (e) { setError(e.message); }
    setSaving(false);
  }

  const toggleGroup = (g, on) => setPick((p) => { const n = { ...p }; g.invoices.forEach((i) => { n[i.id] = on; }); return n; });

  return (
    <div className="dialog-backdrop" onClick={() => !saving && onClose()}>
      <div className="dialog ed rsm" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="rsm-title">
        <div className="ed-head">
          <div>
            <h2 id="rsm-title">{tr('Bring rent-side invoices over from Bamboo Products')}</h2>
            <p className="ed-sub">{tr('CAM, water & power and other rent-side invoices found in Bamboo Products\' invoices. Untick anything that is not rent-side, say what each customer\'s charges are, then move them to Poki. Payments and receipts move with them.')}</p>
          </div>
        </div>

        {!groups && !error && <p className="ed-sub">{tr('Looking…')}</p>}
        {error && <div className="error-banner" role="alert">{error}</div>}

        {done ? (
          <div className="ed-done" role="status">
            <strong>{tr('{n} invoices moved to Poki', { n: done.moved })}</strong>
            <span>{done.tenantsMade ? tr('{n} customers were added as Poki tenants.', { n: done.tenantsMade }) : tr('They are now in Rent & utilities.')}</span>
          </div>
        ) : groups && !groups.length ? (
          <div className="ed-done"><strong>{tr('Nothing to move')}</strong><span>{tr('No rent-side invoices were found in Bamboo Products\' invoices.')}</span></div>
        ) : groups && (
          <ul className="rsm-list">
            {groups.map((g) => {
              const sel = g.invoices.filter((i) => pick[i.id]);
              const all = sel.length === g.invoices.length;
              return (
                <li key={g.customerId} className={'rsm-group' + (sel.length ? ' is-on' : '')}>
                  <div className="rsm-head">
                    <label className="rsm-check">
                      <input type="checkbox" checked={all} ref={(el) => { if (el) el.indeterminate = sel.length > 0 && !all; }} onChange={(e) => toggleGroup(g, e.target.checked)} />
                      <span><strong>{g.customerName}</strong><small>{[g.phone, tr('{n} invoices', { n: g.invoices.length }), money(g.total), g.owed > 0 ? tr('{amount} owed', { amount: money(g.owed) }) : null].filter(Boolean).join(' · ')}</small></span>
                    </label>
                    <button type="button" className="rsm-more" onClick={() => setOpen((o) => ({ ...o, [g.customerId]: !o[g.customerId] }))} aria-expanded={!!open[g.customerId]}>
                      {open[g.customerId] ? tr('Hide invoices') : tr('Show invoices')}
                    </button>
                  </div>
                  {sel.length > 0 && (
                    <div className="rsm-fields">
                      {unknownIn(g).length ? (
                        <label className="field">
                          <span className="field-label">{unknownIn(g).length === sel.length ? tr('These are') : tr('The {n} that don\'t say what they are', { n: unknownIn(g).length })}</span>
                          <select className={'input' + (!kind[g.customerId] ? ' is-missing' : '')} value={kind[g.customerId] || ''} onChange={(e) => setKind((k) => ({ ...k, [g.customerId]: e.target.value }))}>
                            <option value="">{tr('Choose…')}</option>
                            {KINDS.map((k) => <option key={k} value={k}>{kindName(k)}</option>)}
                          </select>
                        </label>
                      ) : (
                        <div className="field">
                          <span className="field-label">{tr('Each keeps what its lines say')}</span>
                          <span className="rsm-kinds">{KINDS.map((k) => [k, sel.filter((i) => i.kind === k).length]).filter(([, n]) => n).map(([k, n]) => n + ' × ' + kindName(k)).join(' · ')}</span>
                        </div>
                      )}
                      <label className="field">
                        <span className="field-label">{tr('Poki tenant')}</span>
                        <select className="input" value={tenant[g.customerId] || ''} onChange={(e) => setTenant((t) => ({ ...t, [g.customerId]: e.target.value }))}>
                          <option value="">{tr('Add {name} as a new tenant', { name: g.customerName })}</option>
                          {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}{t.id === g.matchTenantId ? ' · ' + tr('same name or phone') : ''}</option>)}
                        </select>
                      </label>
                    </div>
                  )}
                  {open[g.customerId] && (
                    <ul className="rsm-invoices">
                      {g.invoices.map((i) => (
                        <li key={i.id}>
                          <label>
                            <input type="checkbox" checked={!!pick[i.id]} onChange={(e) => setPick((p) => ({ ...p, [i.id]: e.target.checked }))} />
                            <span className="rsm-inv-main"><strong>{i.invoiceNo}</strong> · {fmtDate(i.issuedAt)} · {money(i.grandTotal, i.currency)}{i.balanceDue > 0 ? ' · ' + tr('{amount} owed', { amount: money(i.balanceDue, i.currency) }) : ' · ' + tr('paid')}</span>
                            <span className="rsm-inv-lines">{i.lines || '—'}{i.kind ? ' · ' + kindName(i.kind) : ''}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <div className="dialog-actions">
          {done || (groups && !groups.length) ? <button type="button" className="btn btn-primary" onClick={onClose}>{tr('Done')}</button> : (
            <>
              <button type="button" className="btn btn-secondary" disabled={saving} onClick={onClose}>{tr('Cancel')}</button>
              <button type="button" className="btn btn-primary" disabled={saving || !count || missingKind.length > 0} onClick={save}
                title={missingKind.length ? tr('Say what {name}\'s invoices are first.', { name: missingKind[0].g.customerName }) : undefined}>
                {saving ? tr('Moving…') : tr('Move {n} invoices to Poki', { n: count })}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
