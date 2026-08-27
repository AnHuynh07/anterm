import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

const navClass = ({ isActive }: { isActive: boolean }) => (isActive ? 'active' : undefined);

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">AnTerm</div>
        <nav>
          <NavLink to="/dashboard" className={navClass}>
            Dashboard
          </NavLink>
          <NavLink to="/connections" className={navClass}>
            Connections
          </NavLink>
          <NavLink to="/credentials" className={navClass}>
            Credentials
          </NavLink>
          <NavLink to="/terminal" className={navClass}>
            Terminal
          </NavLink>
          <NavLink to="/sessions" className={navClass}>
            History
          </NavLink>
          <NavLink to="/settings" className={navClass}>
            Settings
          </NavLink>
        </nav>
        <div className="spacer" />
        <span className="who">{user?.username}</span>
        <button
          className="btn ghost"
          onClick={async () => {
            await logout();
            navigate('/login');
          }}
        >
          Sign out
        </button>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
