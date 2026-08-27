import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { Icon } from './icons';

const NAV = [
  ['/dashboard', 'Dashboard', 'dashboard', false],
  ['/connections', 'Connections', 'connections', false],
  ['/credentials', 'Credentials', 'credentials', false],
  ['/terminal', 'Terminal', 'terminal', false],
  ['/sessions', 'History', 'history', false],
  ['/users', 'Users', 'connections', true],
  ['/activity', 'Activity', 'history', true],
  ['/settings', 'Settings', 'settings', false],
] as const;

const navClass = ({ isActive }: { isActive: boolean }) => (isActive ? 'active' : undefined);
const ROLE_LABEL: Record<string, string> = { admin: 'Admin', operator: 'Operator', viewer: 'Viewer' };

export function Layout() {
  const { user, logout, isAdmin } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">❯_</span>
          AnTerm
        </div>
        <nav>
          {NAV.filter(([, , , adminOnly]) => !adminOnly || isAdmin).map(([to, label, icon]) => (
            <NavLink key={to} to={to} className={navClass}>
              <Icon name={icon} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="sidebar-user">
            <span className="avatar">{user?.username?.[0]?.toUpperCase() ?? '?'}</span>
            <span className="uname">
              {user?.username}
              <span className="role-tag">{ROLE_LABEL[user?.role ?? ''] ?? user?.role}</span>
            </span>
          </div>
          <button
            className="btn ghost sm signout"
            onClick={async () => {
              await logout();
              navigate('/login');
            }}
          >
            <Icon name="logout" />
            Sign out
          </button>
        </div>
      </aside>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
