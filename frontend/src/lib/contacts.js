import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';

// Who a document can be for, beyond the customers: the leads that are not
// customers yet (backend customers.service leadsToPick). Used by the
// customer field (components/CustomerPicker.jsx) of estimates, quotations
// and invoices. Loaded when the document's form opens, so it is fresh.
export function useLeadsToPick(enabled) {
  const [leads, setLeads] = useState([]);
  const load = useCallback(() => api.get('/customers/pick-leads').then(setLeads).catch(() => setLeads([])), []);
  useEffect(() => { if (enabled) load(); }, [enabled, load]);
  // A lead that has just become a customer leaves the list.
  const drop = useCallback((id) => setLeads((l) => l.filter((x) => x.id !== id)), []);
  return { leads, reload: load, drop };
}

// A customer list with one more (or one changed), in name order.
export function withCustomer(list, c) {
  return (list || []).filter((x) => x.id !== c.id).concat(c).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

// Phone numbers compared however they are written: "024 412 3456",
// "+233 24 412 3456" and "0244123456" are the same number.
export function phoneKey(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('233') && d.length >= 12) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  return d;
}
