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
import PlaceholderPage from './pages/PlaceholderPage';

// Every nav item gets a route so the shell is fully navigable now — screens
// not yet built render a placeholder rather than a dead link, matching the
// intended full nav structure (see layout/navModel.js). Built once at
// module scope so route elements stay referentially stable across renders.
const BUILT_SCREENS = {
  dashboard: DashboardPage, leave: LeavePage, people: EmployeesPage, departments: DepartmentsPage, attendance: AttendancePage,
  myspace: MySpacePage, tasks: TasksPage, projects: ProjectsPage
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
