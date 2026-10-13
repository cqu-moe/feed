import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Button, PageHeader, PageState, ThemeMenu } from '@cqu-moe/ui';
import { ExternalLink, LogOut, RefreshCw } from 'lucide-react';
import type { Session } from './api';

export function safeNext(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

export function formatDateTime(value: string | null): string {
  if (!value) return '未记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间无效';
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Shanghai',
  }).format(date);
}

export function formatPublicationDate(value: string | null): string {
  if (!value) return '未记录';
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(dateOnly ? `${value}T00:00:00+08:00` : value);
  if (Number.isNaN(date.getTime())) return '时间无效';
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeZone: 'Asia/Shanghai',
  }).format(date);
}

export function formatBytes(value: number | null): string {
  if (value === null) return '未知大小';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = value;
  let unit = 'B';
  while (size >= 1024 && units.length > 0) {
    size /= 1024;
    unit = units.shift() as string;
  }
  return `${size >= 10 || unit === 'KB' ? Math.round(size) : size.toFixed(1)} ${unit}`;
}

const articleStatuses = new Map([
  ['complete', '已归档'],
  ['archived', '已归档'],
  ['success', '已归档'],
  ['partial', '部分完成'],
  ['pending', '处理中'],
  ['processing', '处理中'],
  ['failed', '失败'],
  ['error', '失败'],
]);

export function articleStatusLabel(status: string): string {
  return articleStatuses.get(status.toLowerCase()) ?? status;
}

const attachmentStatuses = new Map([
  ['complete', '已保存'],
  ['downloaded', '已保存'],
  ['success', '已保存'],
  ['pending', '待下载'],
  ['queued', '排队中'],
  ['processing', '下载中'],
  ['failed', '保存失败'],
  ['error', '保存失败'],
  ['missing', '未保存'],
  ['skipped', '未保存'],
]);

export function attachmentStatusLabel(status: string): string {
  return attachmentStatuses.get(status.toLowerCase()) ?? status;
}

export function isPdf(attachment: { name: string; url: string | null; contentType: string | null }): boolean {
  return (
    attachment.contentType?.toLowerCase().includes('pdf') === true ||
    /\.pdf(?:$|[?#])/i.test(attachment.url ?? '') ||
    /\.pdf$/i.test(attachment.name)
  );
}

export function FeedBrand() {
  return (
    <Link className="feed-brand" to="/">
      <span className="feed-brand-mark" aria-hidden="true">
        <img className="feed-logo-light" src="/brand/logo-black.svg" alt="" width="32" height="32" />
        <img className="feed-logo-dark" src="/brand/logo-white.svg" alt="" width="32" height="32" />
      </span>
      <span className="feed-brand-name">重大通知存档</span>
    </Link>
  );
}

export function StandaloneHeader({ actions }: { actions?: ReactNode }) {
  return (
    <header className="feed-standalone-header">
      <FeedBrand />
      <div className="feed-standalone-actions">
        {actions}
        <ThemeMenu />
      </div>
    </header>
  );
}

export function AccessDeniedState({ title = '没有访问权限' }: { title?: string }) {
  return (
    <main className="feed-standalone-main">
      <div className="feed-standalone-card">
        <PageHeader
          title={title}
          description="重大通知存档需要 auth.cqu.moe 授予 feed.access 权益后才能访问。"
        />
        <PageState
          state="forbidden"
          title="缺少 feed.access 权益"
          description="如果你可以管理自己的权益，请前往 auth.cqu.moe 添加；添加后回到这里重新进入。"
          action={
            <Button asChild>
              <a href="https://auth.cqu.moe/" target="_blank" rel="noreferrer">
                <ExternalLink aria-hidden="true" />
                前往 auth.cqu.moe
              </a>
            </Button>
          }
        />
      </div>
    </main>
  );
}

export function LoginRequiredState() {
  return (
    <main className="feed-standalone-main">
      <div className="feed-standalone-card">
        <PageHeader title="登录已过期" description="请重新登录后继续访问重大通知存档。" />
        <PageState
          state="forbidden"
          title="需要重新登录"
          description="当前会话已失效，已采集的通知和附件不会因此丢失。"
          action={
            <Button asChild>
              <a href="/auth/login">
                <ExternalLink aria-hidden="true" />
                重新登录
              </a>
            </Button>
          }
        />
      </div>
    </main>
  );
}

export function RetryButton({ onClick, label = '重新加载' }: { onClick: () => void; label?: string }) {
  return (
    <Button type="button" variant="outline" onClick={onClick}>
      <RefreshCw aria-hidden="true" />
      {label}
    </Button>
  );
}

export function LogoutButton({
  session,
  busy,
  onLogout,
}: {
  session: Session;
  busy: boolean;
  onLogout: () => void;
}) {
  const identity = session.user?.name ?? session.user?.email ?? '已登录';
  return (
    <div className="feed-shell-actions">
      <span className="feed-user" title={session.user?.email ?? undefined}>
        {identity}
      </span>
      <Button type="button" variant="ghost" size="sm" onClick={onLogout} disabled={busy}>
        <LogOut aria-hidden="true" />
        {busy ? '正在退出…' : '退出'}
      </Button>
    </div>
  );
}
