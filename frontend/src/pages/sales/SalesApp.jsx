import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import ProtectedRoute from '../../auth/ProtectedRoute';
import LoginPage from '../LoginPage';
import CrmOverviewPage from '../crm/CrmOverviewPage';
import CrmBoardPage from '../crm/CrmBoardPage';
import CrmLeadsPage from '../crm/CrmLeadsPage';
import CrmVisitsPage from '../crm/CrmVisitsPage';
import CrmCommissionsPage from '../crm/CrmCommissionsPage';
import { CrmCustomersHub, CrmInboxHub } from '../crm/CrmTabs';
import CrmHealthPage from '../crm/CrmHealthPage';
import QuotationsPage from '../QuotationsPage';
import InvoicesPage from '../InvoicesPage';
import SalesOrdersPage from '../SalesOrdersPage';
import MkCalendarPage from '../marketing/MkCalendarPage';
import MkRequestsPage from '../marketing/MkRequestsPage';
import SalesShell from './SalesShell';
import { HOME, OS_URL, SALES_ITEMS, allowed } from './salesNav';
import { msg, tr } from '../../lib/i18n.jsx';
import './SalesLogin.css';

// The sales team's own app: sales.oseitutu.com (tools/build-sales.mjs),
// and oseitutu.com/sales in the OS. A rep signs in with their OS account —
// email and password, and the two-step code if theirs has it on — and sees
// only Sales & CRM: their board, inbox and follow-ups, leads, customers and
// prospects, site visits, and the quotations, invoices, sales orders and
// commissions those lead to, with the marketing calendar and requests to
// marketing (SalesShell.jsx; salesNav.js). The pages are
// the OS's own, at the same addresses, so their links work here unchanged;
// anything else (a link into the rest of the OS) offers to open the OS.

const PAGES = {
  crmboard: CrmBoardPage, crm: CrmOverviewPage, crminbox: CrmInboxHub, crmleads: CrmLeadsPage, crmcustomers: CrmCustomersHub,
  crmvisits: CrmVisitsPage, crmhealth: CrmHealthPage, crmcommissions: CrmCommissionsPage,
  quotations: QuotationsPage, invoices: InvoicesPage, salesorders: SalesOrdersPage,
  mkcalendar: MkCalendarPage, mkrequests: MkRequestsPage
};
const AREAS = [
  ['target', msg('Your sales board: who to call today')],
  ['chat', msg('WhatsApp, calls and follow-ups')],
  ['pin', msg('Site visits on the road')],
  ['doc', msg('Quotations and invoices')],
  ['cash', msg('Your commission')],
  ['lock', msg('Only what your account may see')]
];

// The sign-in screen's picture: a rep's day in three cards, floating.
function Art() {
  return (
    <div className="sl-art" aria-hidden="true">
      <div className="sl-card is-a"><span className="sl-dot is-hot" /><b>{tr('Hot lead')}</b><small>{tr('Called back in 5 minutes')}</small></div>
      <div className="sl-card is-b"><span className="sl-emoji">🤝</span><b>{tr('Quotation accepted')}</b><small>{tr('Sales order on its way')}</small></div>
      <div className="sl-card is-c"><span className="sl-emoji">🔥</span><b>{tr('5-day streak')}</b><small>{tr('Today\'s goal met')}</small></div>
    </div>
  );
}

// A page of the sales app, if this person's account may open it.
function Page({ item }) {
  const { can } = useAuth();
  const Screen = PAGES[item.key];
  if (!allowed(item, can)) return <Elsewhere reason="locked" />;
  return <Screen />;
}

// A link to the rest of the OS, or a page this account cannot open.
export function Elsewhere({ reason }) {
  const location = useLocation();
  const url = OS_URL + location.pathname + location.search;
  return (
    <div className="sa-else">
      <span className="sa-else-art" aria-hidden="true">{reason === 'locked' ? '🔒' : '🧭'}</span>
      <h2>{reason === 'locked' ? tr('Not for your account') : tr('That is in the full OS')}</h2>
      <p>{reason === 'locked' ? tr('Your role does not include this page. Ask an administrator if you need it.') : tr('The sales app has Sales & CRM only. This page opens in the company OS, with the same email and password.')}</p>
      {reason !== 'locked' && <a className="btn btn-primary" href={url} target="_blank" rel="noopener noreferrer">{tr('Open it in the OS')}</a>}
    </div>
  );
}

export default function SalesApp() {
  return (
    <Routes>
      <Route path="/login" element={
        <LoginPage home={HOME} brand={{
          tone: 'sales', eyebrow: tr('Bamboo Products · Sales team'), heading: tr('Bamboo Sales'), art: <Art />, areas: AREAS,
          sub: tr('Your leads, customers and follow-ups, straight to work. Sign in with your company email and password.')
        }} />
      } />
      <Route element={<ProtectedRoute />}>
        <Route element={<SalesShell />}>
          <Route index element={<Navigate to={HOME} replace />} />
          {SALES_ITEMS.map((item) => <Route key={item.key} path={item.key} element={<Page item={item} />} />)}
          {/* Old addresses of pages that became tabs (as in the OS, App.jsx). */}
          <Route path="crmprospects" element={<Navigate to="/crmcustomers?tab=prospects" replace />} />
          <Route path="crmfollowups" element={<Navigate to="/crminbox?tab=followups" replace />} />
          <Route path="dashboard" element={<Navigate to={HOME} replace />} />
          <Route path="*" element={<Elsewhere />} />
        </Route>
      </Route>
    </Routes>
  );
}
