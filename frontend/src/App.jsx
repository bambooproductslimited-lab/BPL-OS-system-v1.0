import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import ProtectedRoute from './auth/ProtectedRoute';
import AppShell from './layout/AppShell';
import { ALL_NAV_ITEMS } from './layout/navModel';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import LeavePage from './pages/LeavePage';
import EmployeesPage from './pages/EmployeesPage';
import DepartmentsPage from './pages/DepartmentsPage';
import AttendancePage from './pages/AttendancePage';
import MySpacePage from './pages/MySpacePage';
import TasksPage from './pages/TasksPage';
import ProjectsPage from './pages/ProjectsPage';
import AnnouncementsPage from './pages/AnnouncementsPage';
import DocumentsPage from './pages/DocumentsPage';
import MessagesPage from './pages/MessagesPage';
import SuppliersPage from './pages/SuppliersPage';
import InventoryPage from './pages/InventoryPage';
import AssetsPage from './pages/AssetsPage';
import WaybillsPage from './pages/WaybillsPage';
import ToolRoomPage from './pages/ToolRoomPage';
import ItDevicesPage from './pages/ItDevicesPage';
import ProductionPage from './pages/ProductionPage';
import ProcurementPage from './pages/ProcurementPage';
import ApprovalsPage from './pages/ApprovalsPage';
import ExpensesPage from './pages/ExpensesPage';
import ReportsPage from './pages/ReportsPage';
import FinanceDashboardPage from './pages/FinanceDashboardPage';
import PayrollPage from './pages/PayrollPage';
import CustomersPage from './pages/CustomersPage';
import CatalogPage from './pages/CatalogPage';
import EstimatesPage from './pages/EstimatesPage';
import QuotationsPage from './pages/QuotationsPage';
import InvoicesPage from './pages/InvoicesPage';
import PaymentsPage from './pages/PaymentsPage';
import ReceiptsPage from './pages/ReceiptsPage';
import QIOverviewPage from './pages/QIOverviewPage';
import BillingSettingsPage from './pages/BillingSettingsPage';
import MarketingDashboardPage from './pages/MarketingDashboardPage';
import SalesOrdersPage from './pages/SalesOrdersPage';
import RolesPage from './pages/RolesPage';
import UsersPage from './pages/UsersPage';
import AuditPage from './pages/AuditPage';
import CompanySettingsPage from './pages/CompanySettingsPage';
import IntegrationsPage from './pages/IntegrationsPage';
import AssistantPage from './pages/AssistantPage';
import PlaceholderPage from './pages/PlaceholderPage';

// Every nav item gets a route so the shell is fully navigable now — screens
// not yet built render a placeholder rather than a dead link, matching the
// intended full nav structure (see layout/navModel.js). Built once at
// module scope so route elements stay referentially stable across renders.
const BUILT_SCREENS = {
  dashboard: DashboardPage, leave: LeavePage, people: EmployeesPage, departments: DepartmentsPage, attendance: AttendancePage,
  myspace: MySpacePage, tasks: TasksPage, projects: ProjectsPage, announcements: AnnouncementsPage,
  documents: DocumentsPage, messages: MessagesPage, suppliers: SuppliersPage, inventory: InventoryPage,
  assets: AssetsPage, waybills: WaybillsPage, toolroom: ToolRoomPage, itdevices: ItDevicesPage, production: ProductionPage, procurement: ProcurementPage, approvals: ApprovalsPage,
  expenses: ExpensesPage, reports: ReportsPage, financedash: FinanceDashboardPage, payroll: PayrollPage, customers: CustomersPage,
  catalog: CatalogPage, estimates: EstimatesPage, quotations: QuotationsPage, invoices: InvoicesPage,
  payments: PaymentsPage, receipts: ReceiptsPage, qioverview: QIOverviewPage, billingsettings: BillingSettingsPage,
  marketing: MarketingDashboardPage, salesorders: SalesOrdersPage, roles: RolesPage, users: UsersPage,
  audit: AuditPage, settings: CompanySettingsPage, integrations: IntegrationsPage, assistant: AssistantPage
};
const SCREEN_ROUTES = ALL_NAV_ITEMS.map((item) => {
  const Screen = BUILT_SCREENS[item.key];
  return { key: item.key, element: Screen ? <Screen /> : <PlaceholderPage title={item.label} /> };
});

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />

        <Route element={<ProtectedRoute />}>
          <Route element={<AppShell />}>
            <Route index element={<Navigate to="/dashboard" replace />} />
            {SCREEN_ROUTES.map((route) => (
              <Route key={route.key} path={route.key} element={route.element} />
            ))}
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Route>
        </Route>
      </Routes>
    </AuthProvider>
  );
}
