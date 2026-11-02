import { useEffect, useState } from 'react';
import { Link, useSearchParams, useRouteLoaderData } from 'react-router';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  PageHeader,
  PageState,
} from '@cqu-moe/ui';
import { ExternalLink } from 'lucide-react';
import {
  parseSources,
  requestJson,
  type Session,
  type SessionAccount,
  type AvailableSessionAccount,
  type Source,
} from './api';
import {
  AccessDeniedState,
  LoginRequiredState,
  RetryButton,
  StandaloneHeader,
  formatDateTime,
  safeNext,
} from './components';
import { FeedLanding } from './landing';
import { sourceStatus } from './source-status';

type RequestState<T> =
  | { kind: 'loading' }
  | { kind: 'success'; data: T }
  | { kind: 'error'; message: string }
  | { kind: 'forbidden' }
  | { kind: 'unauthorized' }
  | { kind: 'not-found' };

type SourceState = RequestState<Source[]>;

function refreshIntervalLabel(value: number | null | undefined): string {
  if (value === null || value === undefined) return '未知';
  if (value % 86400 === 0) return `${value / 86400} 天`;
  return `${Math.round(value / 60)} 分钟`;
}

function discoveryTimeLabel(value: number | null | undefined): string {
  if (value === null || value === undefined) return '等待调度';
  if (value === 0) return '等待调度';
  return formatDateTime(new Date(value).toISOString());
}

function fromResult<T>(
  result: Awaited<ReturnType<typeof requestJson<T>>>,
): RequestState<T> {
  if (result.ok) return { kind: 'success', data: result.data };
  if (result.status === 403) return { kind: 'forbidden' };
  if (result.status === 401) return { kind: 'unauthorized' };
  if (result.status === 404) return { kind: 'not-found' };
  return { kind: 'error', message: result.message };
}

export function LoginPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));

  return <FeedLanding loginHref={`/auth/login?next=${encodeURIComponent(next)}`} />;
}

export function AccessPage() {
  return (
    <div className="feed-standalone-page">
      <StandaloneHeader />
      <AccessDeniedState title="开通 Feed 访问权限" />
    </div>
  );
}

function subscriptionLimitLabel(account: AvailableSessionAccount) {
  const limit = account.subscriptionLimit;
  if (limit.kind === 'unlimited') return '无限';
  if (limit.kind === 'missing') return '未配置（按 0 个执行）';
  return `${limit.value} 个`;
}

function accountStateLabel(account: SessionAccount) {
  if (account.status !== 'available') {
    if (account.status === 'auth_unavailable') return 'Auth 暂不可用';
    if (account.reason === 'AUTH_DATA_INVALID') return '权益数据异常';
    if (account.reason === 'SUBJECT_UNAVAILABLE') return '用户当前不可用';
    if (account.reason === 'INVALID_CLIENT' || account.reason === 'CLIENT_NOT_ALLOWED') return '服务身份配置异常';
    return '账户状态暂不可用';
  }
  return account.access ? '订阅能力可用' : '缺少访问权益';
}

function accountEmailLabel(account: AvailableSessionAccount) {
  if (account.email.status === 'verified') return account.email.address;
  if (account.email.status === 'unverified') return '未验证（暂不投递邮件）';
  return '无访问权益（不显示邮箱）';
}

export function AccountPage() {
  const { session } = useRouteLoaderData('feed-root') as { session: Session };
  const account = session.account;
  const availableAccount = account?.status === 'available' ? account : undefined;
  const stateClass = availableAccount
    ? availableAccount.access
      ? 'is-ok'
      : 'is-error'
    : 'is-warning';

  return (
    <>
      <PageHeader
        title="账户与订阅"
        description="查看访问权限、订阅额度和用于接收通知的邮箱。"
      />
      <article className="feed-card feed-account-card feed-account-overview" data-feed-sensitive>
        <div className="feed-source-heading">
          <div>
            <h2>{session.user?.name ?? session.user?.email ?? '当前账号'}</h2>
            <p className="feed-account-note">
              在「我的订阅」中选择栏目和接收方式。
            </p>
          </div>
          <span
            className={`feed-source-state ${stateClass}`}
          >
            {account ? accountStateLabel(account) : '账户状态暂不可用'}
          </span>
        </div>
        {availableAccount ? (
          <dl className="feed-source-meta feed-account-meta">
            <div>
              <dt>通知存档访问</dt>
              <dd>{availableAccount.access ? '已开通' : '未开通'}</dd>
            </div>
            <div>
              <dt>订阅额度</dt>
              <dd>{subscriptionLimitLabel(availableAccount)}</dd>
            </div>
            <div>
              <dt>邮件投递</dt>
              <dd>{accountEmailLabel(availableAccount)}</dd>
            </div>
          </dl>
        ) : (
          <Alert variant={account?.status === 'auth_unavailable' ? 'default' : 'destructive'}>
            <AlertTitle>{account?.status === 'auth_unavailable' ? 'Auth 暂不可用' : '暂时无法确认账户状态'}</AlertTitle>
            <AlertDescription>
              当前配置和已采集内容会保留；请在服务恢复后重新打开此页面，不会把本次故障当作撤权。
            </AlertDescription>
          </Alert>
        )}
      </article>
    </>
  );
}

export function SourcesPage() {
  const [state, setState] = useState<SourceState>({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'loading' });
    requestJson('/api/sources', parseSources, { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) setState(fromResult(result));
    });
    return () => controller.abort();
  }, [reloadKey]);

  if (state.kind === 'forbidden') {
    return <AccessDeniedState />;
  }
  if (state.kind === 'unauthorized') {
    return <LoginRequiredState />;
  }

  return (
    <>
      <PageHeader title="采集状态" description="查看每个通知栏目最近一次云端采集和归档结果。"
        actions={<Button asChild variant="outline"><Link to="/admin/tasks">管理员入口</Link></Button>} />
      {state.kind === 'loading' && (
        <PageState state="loading" title="正在加载采集状态" description="正在读取各栏目最近运行结果。" />
      )}
      {state.kind === 'error' && (
        <PageState
          state="error"
          title="暂时无法加载采集状态"
          description={`${state.message}请稍后重试。`}
          action={<RetryButton onClick={() => setReloadKey((key) => key + 1)} />}
        />
      )}
      {state.kind === 'not-found' && (
        <PageState
          state="not-found"
          title="采集状态不可用"
          description="请稍后重试。"
          action={<RetryButton onClick={() => setReloadKey((key) => key + 1)} />}
        />
      )}
      {state.kind === 'success' && state.data.length === 0 && (
        <PageState state="empty" title="还没有配置栏目" description="首批栏目接入后会显示采集状态。" />
      )}
      {state.kind === 'success' && state.data.length > 0 && (
        <div className="feed-source-grid feed-source-ledger">
          {state.data.map((source) => {
            const status = sourceStatus(source);
            const scheduled = source.enabled === true && source.siteEnabled === true && source.validationState === 'verified';
            return (
              <article className="feed-card feed-source-card" key={source.id}>
                <div className="feed-source-heading">
                  <div>
                    <h2>{source.name}</h2>
                    <a href={source.listUrl ?? source.url} target="_blank" rel="noreferrer">
                      栏目列表
                      <ExternalLink aria-hidden="true" />
                    </a>
                  </div>
                  <span className={`feed-source-state ${status.tone}`}>{status.label}</span>
                </div>
                <dl className="feed-source-meta">
                  <div>
                    <dt>已存档通知</dt>
                    <dd>{source.articleCount}</dd>
                  </div>
                  <div>
                    <dt>{status.timeLabel}</dt>
                    <dd>{formatDateTime(source.lastRunAt)}</dd>
                  </div>
                  <div>
                    <dt>刷新间隔</dt>
                    <dd>{refreshIntervalLabel(source.refreshIntervalSec)}</dd>
                  </div>
                  <div>
                    <dt>下次检查</dt>
                    <dd>{!source.maintenanceStateKnown ? '未知' : scheduled ? discoveryTimeLabel(source.nextDiscoveryAt) : '暂停'}</dd>
                  </div>
                </dl>
                {source.error && (
                  <Alert variant="destructive">
                    <AlertTitle>最近一次采集失败</AlertTitle>
                    <AlertDescription>{source.error}</AlertDescription>
                  </Alert>
                )}
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
