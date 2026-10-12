import { useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle, Button, PageState } from '@cqu-moe/ui';
import { RefreshCw } from 'lucide-react';
import { requestJson } from './api';
import { formatDateTime } from './components';

type MailMessage = {
  id: string;
  ownerSub: string;
  kind: 'immediate' | 'daily_digest';
  state: MailState;
  providerId: string | null;
  submittedAt: number | null;
  acceptedAt: number | null;
  deliveredAt: number | null;
  bouncedAt: number | null;
  complainedAt: number | null;
  nextAttemptAt: number | null;
  attempts: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};

type MailResponse = { enabled: boolean; messages: MailMessage[] };

type MailState =
  | 'prepared'
  | 'submitting'
  | 'deferred'
  | 'submission_unknown'
  | 'accepted'
  | 'delivered'
  | 'bounced'
  | 'complained'
  | 'cancelled'
  | 'rejected';

type MailLoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: MailResponse }
  | { kind: 'error'; message: string; retryable: boolean };

const mailStates: Record<MailState, string> = {
  prepared: '已准备，等待提交',
  submitting: '正在提交服务商',
  deferred: '已延期，等待重试',
  submission_unknown: '提交结果待确认',
  accepted: '服务商已受理',
  delivered: '收件服务器已接收',
  bounced: '已退信',
  complained: '已投诉',
  cancelled: '已取消',
  rejected: '服务商已拒绝',
};

const mailKinds: Record<MailMessage['kind'], string> = {
  immediate: '及时邮件',
  daily_digest: '每日摘要',
};

const reasonLabels: Record<string, string> = {
  auth_unavailable: 'Auth 服务暂不可用，邮件已延期',
  reconciliation_required: '提交结果需要对账，暂不重发',
  retry_limit_reached: '已达重试上限，需要人工处理',
  recipient_changed: '收件人已变更，本邮件不再发送',
  date_unverified: '发布日期待核实，暂缓发送',
  provider_not_configured: '邮件服务商未配置，等待配置后重试',
  provider_unavailable: '邮件服务商暂不可用，稍后重试',
  provider_error: '邮件服务商返回错误，稍后重试',
  rate_limit_exceeded: '邮件服务商限流，稍后重试',
  concurrent_idempotent_requests: '同一邮件正在提交，等待结果',
  invalid_idempotent_request: '幂等请求无效，需要人工处理',
  invalid_request: '邮件请求被拒绝，需要人工处理',
  request_rejected: '邮件请求被拒绝，需要人工处理',
  server_error: '邮件服务商异常，提交结果待确认',
  unexpected_status: '邮件服务商响应异常，提交结果待确认',
  invalid_response: '邮件服务商响应无效，提交结果待确认',
  network: '网络中断，提交结果待确认',
  timeout: '提交超时，结果待确认',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMailMessage(value: unknown): MailMessage {
  if (!isRecord(value)) throw new Error('邮件列表不完整。');
  const timestamps = [
    value.submittedAt, value.acceptedAt, value.deliveredAt, value.bouncedAt,
    value.complainedAt, value.nextAttemptAt,
  ] as const;
  if (typeof value.id !== 'string' || !/^[a-f0-9]{24}$/.test(value.id)
    || typeof value.ownerSub !== 'string' || !value.ownerSub
    || (value.kind !== 'immediate' && value.kind !== 'daily_digest')
    || typeof value.state !== 'string' || !Object.hasOwn(mailStates, value.state)
    || (value.providerId !== null && typeof value.providerId !== 'string')
    || timestamps.some(timestamp => timestamp !== null && !Number.isSafeInteger(timestamp))
    || typeof value.attempts !== 'number' || !Number.isSafeInteger(value.attempts) || value.attempts < 0
    || (value.lastError !== null && typeof value.lastError !== 'string')
    || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.updatedAt)) {
    throw new Error('邮件列表不完整。');
  }
  return { ...(value as MailMessage) };
}

function parseMailResponse(value: unknown): MailResponse {
  if (!isRecord(value) || typeof value.enabled !== 'boolean' || !Array.isArray(value.messages)) {
    throw new Error('邮件列表不完整。');
  }
  return { enabled: value.enabled, messages: value.messages.map(parseMailMessage) };
}

function reasonLabel(value: string | null): string | null {
  if (value === null) return null;
  if (reasonLabels[value]) return reasonLabels[value];
  if (/[\u4e00-\u9fff]/.test(value)) return value;
  return /^[a-z0-9_]{1,80}$/.test(value) ? `原因待确认（${value}）` : '原因待确认';
}

function mailTime(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export function AdminMailPanel({ token }: { token: string }) {
  const [state, setState] = useState<MailLoadState>({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'loading' });
    requestJson('/internal/mail', parseMailResponse, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}` },
    }).then(result => {
      if (controller.signal.aborted) return;
      if (result.ok) {
        setState({ kind: 'ready', data: result.data });
      } else {
        setState({
          kind: 'error',
          message: result.status === 401 ? '管理员凭据无效，请重新进入管理。' : result.message,
          retryable: result.status !== 401,
        });
      }
    });
    return () => controller.abort();
  }, [token, reloadKey]);

  const loading = state.kind === 'loading';
  return <section className="feed-card feed-admin-mail" aria-label="邮件投递管理">
    <div className="feed-source-heading">
      <div>
        <h2>邮件投递</h2>
        <p>查看及时邮件与每日摘要的准备、受理和接收进度。</p>
      </div>
      <Button type="button" variant="outline" disabled={loading} onClick={() => setReloadKey(value => value + 1)}>
        <RefreshCw aria-hidden="true" />{loading ? '正在读取…' : '刷新邮件'}
      </Button>
    </div>
    {state.kind === 'ready' && (
      <Alert>
        <AlertTitle>{state.data.enabled ? '邮件发送已启用' : '邮件发送未启用'}</AlertTitle>
        <AlertDescription>
          {state.data.enabled
            ? '当前环境开关已开放发送；这里只展示投递状态，不展示收件人和邮件内容。'
            : '当前环境开关未开放发送；已保存的投递状态仍会在这里显示。'}
        </AlertDescription>
      </Alert>
    )}
    {state.kind === 'loading' && <PageState state="loading" title="正在读取邮件" description="正在获取邮件投递状态。" />}
    {state.kind === 'error' && (
      <Alert variant="destructive">
        <AlertTitle>邮件状态读取失败</AlertTitle>
        <AlertDescription>{state.message}</AlertDescription>
        {state.retryable && <div className="feed-card-actions">
          <Button type="button" onClick={() => setReloadKey(value => value + 1)}>重新读取</Button>
        </div>}
      </Alert>
    )}
    {state.kind === 'ready' && state.data.messages.length === 0 && (
      <p>还没有邮件投递记录。符合条件的及时提醒准备完成后会出现在这里。</p>
    )}
    {state.kind === 'ready' && state.data.messages.length > 0 && (
      <ul className="feed-notification-list">
        {state.data.messages.map(message => {
          const reason = reasonLabel(message.lastError);
          return <li className="feed-mail-item" key={message.id}>
            <div className="feed-article-topline">
              <strong>{mailKinds[message.kind]}</strong>
              <span className="feed-status">{mailStates[message.state]}</span>
            </div>
            <p className="feed-admin-id">消息 ID：{message.id}</p>
            <dl className="feed-mail-meta">
              <div><dt>创建</dt><dd>{formatDateTime(mailTime(message.createdAt))}</dd></div>
              <div><dt>提交</dt><dd>{formatDateTime(mailTime(message.submittedAt))}</dd></div>
              <div><dt>受理</dt><dd>{formatDateTime(mailTime(message.acceptedAt))}</dd></div>
              <div><dt>接收</dt><dd>{formatDateTime(mailTime(message.deliveredAt))}</dd></div>
              {message.bouncedAt !== null && <div><dt>退信</dt><dd>{formatDateTime(mailTime(message.bouncedAt))}</dd></div>}
              {message.complainedAt !== null && <div><dt>投诉</dt><dd>{formatDateTime(mailTime(message.complainedAt))}</dd></div>}
              <div><dt>尝试</dt><dd>{message.attempts} 次</dd></div>
              <div><dt>下次尝试</dt><dd>{formatDateTime(mailTime(message.nextAttemptAt))}</dd></div>
              <div><dt>更新</dt><dd>{formatDateTime(mailTime(message.updatedAt))}</dd></div>
            </dl>
            {reason && <p className="feed-mail-reason">{reason}</p>}
          </li>;
        })}
      </ul>
    )}
  </section>;
}
