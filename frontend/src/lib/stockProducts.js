import { useEffect, useState } from 'react';
import { api } from '../api/client';

// Products & inventory, for linking a document's lines to stock (an invoice
// takes what it sells off stock — backend inventorySales.service.js). Only
// for people who may see stock; everyone else gets null and the documents
// look as they always did.
export function useStockProducts(canSee) {
  const [list, setList] = useState(null);
  useEffect(() => {
    if (!canSee) { setList(null); return undefined; }
    let alive = true;
    api.get('/products').then((rows) => {
      if (alive) setList((rows || []).filter((p) => p.active !== false).sort((a, b) => a.name.localeCompare(b.name)));
    }).catch(() => alive && setList(null));
    return () => { alive = false; };
  }, [canSee]);
  return list;
}
