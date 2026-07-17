import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

const NAV = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/upload', label: 'Upload Lists' },
  { to: '/screen', label: 'Run Screening' },
  { to: '/history', label: 'History' },
  { to: '/record-found', label: 'Record Found' },
  { to: '/sync-logs', label: 'Sync Logs' },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="min-h-screen">
      <header className="bg-brand-700 text-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <span className="text-lg font-semibold">Compliance Screening Portal</span>
          <div className="flex items-center gap-4 text-sm">
            <span className="hidden text-brand-50 sm:inline">{user?.full_name}</span>
            <button
              onClick={handleLogout}
              className="rounded bg-white/10 px-3 py-1 hover:bg-white/20"
            >
              Log out
            </button>
          </div>
        </div>
        <nav className="border-t border-white/10">
          <div className="mx-auto flex max-w-6xl gap-1 px-4">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `px-3 py-2 text-sm font-medium ${
                    isActive ? 'border-b-2 border-white' : 'text-brand-50 hover:text-white'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </div>
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
