import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { AuthProvider } from './hooks/useAuth';
import { TerminalTabsProvider } from './hooks/useTerminalTabs';
import { RequireAuth } from './components/RequireAuth';
import { Layout } from './components/Layout';
import { LoginPage } from './routes/Login';
import { ConnectionsPage } from './routes/Connections';
import { CredentialsPage } from './routes/Credentials';
import { TerminalPage } from './routes/Terminal';
import { SessionsPage } from './routes/Sessions';
import { SettingsPage } from './routes/Settings';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });

const basename = import.meta.env.BASE_URL.replace(/\/$/, '') || '/';

const router = createBrowserRouter(
  [
    { path: '/login', element: <LoginPage /> },
    {
      element: (
        <RequireAuth>
          <TerminalTabsProvider>
            <Layout />
          </TerminalTabsProvider>
        </RequireAuth>
      ),
      children: [
        { index: true, element: <Navigate to="/connections" replace /> },
        { path: 'connections', element: <ConnectionsPage /> },
        { path: 'credentials', element: <CredentialsPage /> },
        { path: 'terminal/:connectionId', element: <TerminalPage /> },
        { path: 'terminal', element: <TerminalPage /> },
        { path: 'sessions', element: <SessionsPage /> },
        { path: 'settings', element: <SettingsPage /> },
      ],
    },
    { path: '*', element: <Navigate to="/" replace /> },
  ],
  { basename },
);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
