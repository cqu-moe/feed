import { lazy, Suspense, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  createBrowserRouter,
  isRouteErrorResponse,
  Link,
  NavLink,
  Outlet,
  redirect,
  RouterProvider,
  useLoaderData,
  useNavigate,
  useRouteError,
  useRouteLoaderData,
} from 'react-router';
import {
  AppShell,
  Button,
  ContentContainer,
  PageHeader,
  PageState,
  ThemeMenu,
  ThemeProvider,
  Toaster,
  toast,
} from '@cqu-moe/ui';
import { BellPlus, House, RefreshCw, UserRound } from 'lucide-react';
import { parseSession, requestJson, type Session } from './api';
import { AccessDeniedState, LoginRequiredState, LogoutButton, safeNext } from './components';
import { AccessPage, AccountPage, ArticleDetailPage, ArticlesPage, LoginPage, SourcesPage } from './pages';
import { AdminTasksPage } from './admin-tasks';
import { AdminSourcesPage } from './admin-sources';
import { SubscriptionsPage } from './subscriptions';
import '@cqu-moe/theme/styles.css';
import '@cqu-moe/ui/styles.css';
import './styles.css';

const PdfReader = lazy(() => import('./pdf-reader'));

type RootLoader = { session: Session };

async function loadAuthenticatedSession(): Promise<RootLoader> {
  const result = await requestJson('/api/session', parseSession);
  if (!result.ok) throw new Response(null, { status: result.status });
  if (!result.data.authenticated) throw redirect('/login');
  return { session: result.data };
}

async function loadProtectedSession(): Promise<RootLoader> {
  const result = await requestJson('/api/session', parseSession);
  if (!result.ok) throw new Response(null, { status: result.status });
  if (!result.data.authenticated) throw redirect('/login');
  if (!result.data.entitled) {
    const current = window.location.pathname + window.location.search;
    throw redirect(`/access?returnTo=${encodeURIComponent(current)}`);
  }
  return { session: result.data };
}

async function loadLogin() {
  const result = await requestJson('/api/session', parseSession);
  if (!result.ok) return null;
  if (!result.data.authenticated) return null;
  if (!result.data.entitled) throw redirect('/account');
  throw redirect('/');
}

async function loadAccess() {
  const result = await requestJson('/api/session', parseSession);
  if (!result.ok) throw new Response(null, { status: result.status });
  if (!result.data.authenticated) throw redirect('/login');
  if (result.data.entitled) {
    throw redirect(safeNext(new URL(window.location.href).searchParams.get('returnTo')));
  }
  return { session: result.data };
}

function Layout() {
  const { session } = useLoaderData() as RootLoader;
  const navigate = useNavigate();
  const [loggingOut, setLoggingOut] = useState(false);

  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    const result = await requestJson('/auth/logout', () => null, { method: 'POST' });
    setLoggingOut(false);
    if (!result.ok && result.status !== 401) {
      toast.error('退出失败，请稍后重试。');
      return;
    }
    navigate('/login', { replace: true });
  }

  return (
    <AppShell
      brand="重大通知存档"
      utilities={
        <div className="feed-shell-utilities">
          <LogoutButton session={session} busy={loggingOut} onLogout={logout} />
          <ThemeMenu />
        </div>
      }
      navigation={
        <>
          <NavLink to="/" end>
            <House aria-hidden="true" />
            通知
          </NavLink>
          <NavLink to="/sources">
            <RefreshCw aria-hidden="true" />
            采集状态
          </NavLink>
          <NavLink to="/subscriptions">
            <BellPlus aria-hidden="true" />
            我的订阅
          </NavLink>
          <NavLink to="/account">
            <UserRound aria-hidden="true" />
            账户
          </NavLink>
        </>
      }
    >
      <ContentContainer width="standard">
        <Outlet />
      </ContentContainer>
    </AppShell>
  );
}

function RouteError() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : 0;

  if (status === 401) return <LoginRequiredState />;
  if (status === 403) return <AccessDeniedState />;

  return (
    <main className="feed-standalone-main">
      <div className="feed-standalone-card">
        <PageHeader title="页面加载失败" description="请稍后重试，或返回通知列表继续阅读。" />
        <PageState
          state={status === 404 ? 'not-found' : 'error'}
          title={status === 404 ? '未找到页面' : '暂时无法完成请求'}
          description={
            status === 404
              ? '这个地址没有对应的通知或页面。'
              : `请求失败${status ? `（HTTP ${status}）` : ''}，已采集内容不会因此丢失。`
          }
          action={
            <Button asChild variant="outline">
              <Link to="/">返回通知列表</Link>
            </Button>
          }
        />
      </div>
    </main>
  );
}

function NotFound() {
  return (
    <>
      <PageHeader title="页面不存在" description="这个地址没有对应的通知或页面。" />
      <PageState
        state="not-found"
        title="未找到页面"
        description="请检查链接，或回到通知列表继续阅读。"
        action={
          <Button asChild variant="outline">
            <Link to="/">返回通知列表</Link>
          </Button>
        }
      />
    </>
  );
}

const router = createBrowserRouter([
  { path: '/admin/tasks', element: <AdminTasksPage />, errorElement: <RouteError /> },
  { path: '/admin/sources', element: <AdminSourcesPage />, errorElement: <RouteError /> },
  {
    path: '/reader/:articleId/revisions/:revisionId/:filename',
    loader: loadProtectedSession,
    element: <Suspense fallback={<p role="status">正在加载 PDF 阅读器…</p>}><PdfReader /></Suspense>,
    errorElement: <RouteError />,
  },
  {
    path: '/reader/:id/:filename',
    loader: loadProtectedSession,
    element: <Suspense fallback={<p role="status">正在加载 PDF 阅读器…</p>}><PdfReader /></Suspense>,
    errorElement: <RouteError />,
  },
  {
    path: '/login',
    loader: loadLogin,
    element: <LoginPage />,
    errorElement: <LoginPage />,
  },
  {
    path: '/access',
    loader: loadAccess,
    element: <AccessPage />,
    errorElement: <AccessDeniedState />,
  },
  {
    path: '/',
    id: 'feed-root',
    loader: loadAuthenticatedSession,
    element: <Layout />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <ArticlesPage /> },
      { path: 'articles/:id', element: <ArticleDetailPage /> },
      { path: 'sources', element: <SourcesPage /> },
      { path: 'subscriptions', element: <SubscriptionsPage /> },
      { path: 'account', element: <AccountPage /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <RouterProvider router={router} />
    <Toaster />
  </ThemeProvider>,
);
