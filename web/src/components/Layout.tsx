import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { Icon } from './icons';

const NAV = [
  ['/dashboard', 'Dashboard', 'dashboard'],
  ['/connections', 'Connections', 'connections'],
  ['/credentials', 'Credentials', 'credentials'],
  ['/terminal', 'Terminal', 'terminal'],
  ['/sessions', 'History', 'history'],
  ['/settings', 'Settings', 'settings'],
] as const;

const navClass = ({ isActive }: { isActive: boolean }) => (isActive ? 'active' : undefined);

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">❯_</span>
          AnTerm
        </div>
        <nav>
          {NAV.map(([to, label, icon]) => (
            <NavLink key={to} to={to} className={navClass}>
              <Icon name={icon} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="sidebar-user">
            <span className="avatar">{user?.username?.[0]?.toUpperCase() ?? '?'}</span>
            <span className="uname">{user?.username}</span>
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
