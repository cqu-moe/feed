import { House, Check } from 'lucide-react';
import { createRoot } from 'react-dom/client';
import {
  createBrowserRouter,
  RouterProvider,
  NavLink,
  Outlet,
  Link,
  useRouteError,
  isRouteErrorResponse,
} from 'react-router';
import {
  ThemeProvider,
  Toaster,
  toast,
  ThemeMenu,
  AppShell,
  ContentContainer,
  PageHeader,
  PageState,
  Button,
} from '@cqu-moe/ui';
import '@cqu-moe/theme/styles.css';
import '@cqu-moe/ui/styles.css';
import './styles.css';
function Layout() {
  return (
    <AppShell
      brand="CQU Moe"
      utilities={<ThemeMenu />}
      navigation={
        <NavLink to="/" end>
          <House aria-hidden="true" />
          首页
        </NavLink>
      }
    >
      <ContentContainer>
        <Outlet />
      </ContentContainer>
    </AppShell>
  );
}
function Home() {
  return (
    <>
      <PageHeader title="新的工作空间" description="从共享组件开始，专注于你的业务。" />
      <Button onClick={() => toast.success('共享组件已就绪。')}>
        <Check aria-hidden="true" />
        检查交互
      </Button>
    </>
  );
}
function RouteError() {
  const error = useRouteError();
  const forbidden = isRouteErrorResponse(error) && error.status === 403;
  return (
    <main>
      <ContentContainer>
        <PageHeader title={forbidden ? '访问受限' : '页面加载失败'} />
        <PageState
          state={forbidden ? 'forbidden' : 'error'}
          title={forbidden ? '没有访问权限' : '暂时无法加载页面'}
          description={forbidden ? '请联系管理员确认权限。' : '请稍后重试；仍失败时联系管理员。'}
          action={
            <Button asChild variant="outline">
              <Link to="/">返回首页</Link>
            </Button>
          }
        />
      </ContentContainer>
    </main>
  );
}
const router = createBrowserRouter([
  {
    element: <Layout />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Home /> },
      {
        path: '*',
        element: (
          <>
            <PageHeader title="页面不存在" />
            <PageState
              state="not-found"
              title="未找到页面"
              description="请检查链接，或返回首页。"
              action={
                <Button asChild variant="outline">
                  <Link to="/">返回首页</Link>
                </Button>
              }
            />
          </>
        ),
      },
    ],
  },
]);
createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <RouterProvider router={router} />
    <Toaster />
  </ThemeProvider>,
);
