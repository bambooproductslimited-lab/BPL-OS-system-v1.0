import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { NAV_GROUPS, ALL_NAV_ITEMS } from './navModel';
import NotificationsBell from '../components/NotificationsBell';
import './AppShell.css';

export default function AppShell() {
  const { session, logout, can } = useAuth();
  const location = useLocation();

  const currentKey = location.pathname.split('/')[1] || 'dashboard';
  const currentItem = ALL_NAV_ITEMS.find((item) => item.key === currentKey);
  const currentGroup = NAV_GROUPS.find((group) => group.items.some((item) => item.key === currentKey));

  const employee = session && session.employee;
  const roleLine = session
    ? (session.roleNames || []).join(', ') + (employee ? ' · ' + employee.positionTitle : '')
    : '';

  async function handleLogout() {
    await logout();
  }

  return (
    <div className="shell">
      <aside className="shell-sidebar">
        <div className="shell-brand">
          <img src="/logo.png" alt="" className="shell-brand-logo" />
          <div>
            <div className="shell-brand-name">Bamboo Products</div>
            <div className="shell-brand-sub">Company OS · Phase 1</div>
          </div>
        </div>

        <nav className="shell-nav">
          {NAV_GROUPS.map((group) => {
            const visibleItems = group.items.filter((item) => !item.perm || can(item.perm));
            if (!visibleItems.length) return null;
            return (
              <div className="shell-nav-group" key={group.label}>
                <div className="shell-nav-group-label">{group.label}</div>
                {visibleItems.map((item) => (
                  <NavLink
                    key={item.key}
                    to={'/' + item.key}
                    className={({ isActive }) => 'shell-nav-item' + (isActive ? ' is-active' : '')}
                  >
                    {item.label}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>

        <div className="shell-user">
          <div className="shell-user-name">{employee ? employee.firstName + ' ' + employee.lastName : ''}</div>
          <div className="shell-user-role">{roleLine}</div>
          <button type="button" className="btn btn-secondary shell-signout" onClick={handleLogout}>
            Sign out
          </button>
        </div>
      </aside>

      <main className="shell-main">
        <header className="shell-header">
          <div>
            <div className="eyebrow">{currentGroup ? currentGroup.label : 'Bamboo OS'}</div>
            <h1 className="shell-header-title">{currentItem ? currentItem.label : 'Not found'}</h1>
          </div>
          <NotificationsBell />
        </header>
        <div className="shell-content">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
