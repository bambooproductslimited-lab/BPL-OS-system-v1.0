import { msg } from '../../lib/i18n.jsx';
import { ALL_NAV_ITEMS } from '../../layout/navModel';
import { osOrigin } from '../../lib/osOrigin';

// What the sales team's own app shows (SalesApp.jsx): the OS's Sales & CRM
// screens, and the quotations, invoices and sales orders those screens link
// to — the same pages, labels, icons and permissions as in the OS's menu
// (layout/navModel.js), grouped for a rep's day. TABS are the four at the
// bottom of a phone's screen; the rest are under "More".

const OS = Object.fromEntries(ALL_NAV_ITEMS.map((item) => [item.key, item]));
const pick = (keys) => keys.map((k) => OS[k]).filter(Boolean);

export const SALES_GROUPS = [
  { label: msg('My day'), items: pick(['crmboard', 'crminbox', 'crmvisits']) },
  { label: msg('Pipeline'), items: pick(['crmleads', 'crmcustomers', 'quotations', 'invoices', 'salesorders']) },
  { label: msg('Results'), items: pick(['crmcommissions', 'crm', 'crmhealth']) }
];
export const SALES_ITEMS = SALES_GROUPS.flatMap((g) => g.items);
export const TABS = ['crmboard', 'crminbox', 'crmleads', 'crmcustomers'];
export const HOME = '/crmboard';

// Whether this person may open an item, by its permission(s).
export function allowed(item, can) {
  if (!item.perm) return true;
  return Array.isArray(item.perm) ? item.perm.some(can) : can(item.perm);
}

// Where the full OS is: links to anything outside the sales app open there.
export const OS_URL = osOrigin();
