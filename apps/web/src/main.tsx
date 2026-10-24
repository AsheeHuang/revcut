import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Link, Outlet } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { HealthPage } from './HealthPage';
import { MusicPage } from './MusicPage';
import { ProjectPage } from './ProjectPage';
import { ProjectsPage } from './ProjectsPage';
import './index.css';

function Layout() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <nav className="flex items-center gap-6 border-b border-slate-200 bg-white px-8 py-3">
        <Link to="/" className="text-lg font-semibold">
          revcut
        </Link>
        <Link to="/music" className="text-sm text-slate-600 hover:text-slate-900">
          曲庫
        </Link>
        <Link to="/health" className="text-sm text-slate-600 hover:text-slate-900">
          系統檢查
        </Link>
      </nav>
      <Outlet />
    </div>
  );
}

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <ProjectsPage /> },
      { path: '/projects/:id', element: <ProjectPage /> },
      { path: '/music', element: <MusicPage /> },
      { path: '/health', element: <HealthPage /> },
    ],
  },
]);

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
