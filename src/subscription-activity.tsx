import { useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle, Button } from '@cqu-moe/ui';
import { RefreshCw } from 'lucide-react';
import { parseSubscriptionMatches, requestJson, type NotificationMatch } from './api';
import { formatDateTime, LoginRequiredState } from './components';

const statusLabels: Record<string, string> = {
  pending_immediate: '等待及时提醒', merged_immediate: '并入及时提醒',
  pending_daily_digest: '等待每日摘要', waiting_date_verification: '等待核实日期',
  mail_off: '邮件已关闭', suppressed: '不发送邮件', claimed: '已排入邮件',
  sent: '已提交服务商', accepted: '服务商已受理', delivered: '收件服务器已接收',
  submission_unknown: '发送结果待确认', cancelled: '已取消',
  prepared: '邮件已准备，等待提交', submitting: '邮件提交中', deferred: '邮件延期，等待重试',
  rejected: '服务商已拒绝', bounced: '邮件已退信', complained: '收件人已投诉',
  auth_unavailable: '等待权益服务恢复', quota_exceeded: '等待额度恢复',
  email_unverified: '等待验证邮箱', paused: '订阅已暂停',
  access_revoked: '访问权益已停用', deleted: '订阅已删除',
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
  email_bounced: '邮箱已退信，暂不发送',
  email_complained: '邮箱已投诉，暂不发送',
  mode_changed: '邮件模式已变化，按当前设置处理',
  recovered_backlog: '补发前重新核对当前设置',
  no_eligible_match: '当前没有可发送的匹配',
  access_revoked: '访问权益已停用，候选已保留',
  quota_exceeded: '超出当前额度，候选已保留',
  email_unverified: '邮箱未验证，候选已保留',
  paused: '订阅已暂停，候选已保留',
  deleted: '订阅已删除，候选已保留',
};

function reasonLabel(value: string): string {
  return reasonLabels[value] ?? (/[\u4e00-\u9fff]/.test(value) ? value : '投递原因待确认');
}

type ActivityState = { kind: 'loading' } | { kind: 'ready'; matches: NotificationMatch[] }
  | { kind: 'error'; message: string } | { kind: 'unauthorized' };

export function SubscriptionActivity({ subscriptionId, version }: { subscriptionId: string; version: number }) {
  const [state, setState] = useState<ActivityState>({ kind: 'loading' });
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'loading' });
    requestJson(`/api/subscriptions/${subscriptionId}`, parseSubscriptionMatches, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      setState(result.ok ? { kind: 'ready', matches: result.data }
        : result.status === 401 ? { kind: 'unauthorized' } : { kind: 'error', message: result.message });
    });
    return () => controller.abort();
  }, [subscriptionId, version, refresh]);

  const grouped = new Map<string, { match: NotificationMatch; labels: Set<string>; reasons: Set<string> }>();
  if (state.kind === 'ready') for (const match of state.matches) {
    const entry = grouped.get(match.eventId) ?? { match, labels: new Set<string>(), reasons: new Set<string>() };
    entry.labels.add(statusLabels[match.status] ?? '状态待确认');
    if (match.reason) entry.reasons.add(reasonLabel(match.reason));
    grouped.set(match.eventId, entry);
  }
  return <section id={`activity-${subscriptionId}`} className="feed-subscription-activity" aria-label="订阅通知记录">
    <div className="feed-source-heading">
      <h3>通知记录</h3>
      <Button type="button" variant="outline" disabled={state.kind === 'loading'} onClick={() => setRefresh(value => value + 1)}>
        <RefreshCw aria-hidden="true" />刷新记录
      </Button>
    </div>
    {state.kind === 'loading' && <p role="status">正在读取通知记录…</p>}
    {state.kind === 'unauthorized' && <LoginRequiredState />}
    {state.kind === 'error' && <Alert variant="destructive"><AlertTitle>通知记录读取失败</AlertTitle>
      <AlertDescription>{state.message}</AlertDescription></Alert>}
    {state.kind === 'ready' && !grouped.size && <p>还没有匹配记录。栏目中新通知准备完整后，记录会出现在这里。</p>}
    {state.kind === 'ready' && grouped.size > 0 && <ol className="feed-notification-list">
      {[...grouped.values()].map(({ match, labels, reasons }) => <li key={match.eventId}>
        <h4>{match.title}</h4>
        <p>{match.eventKind === 'update' ? '内容更新' : '新通知'} · 完整归档于 {formatDateTime(match.readyAt)}</p>
        <p className="feed-notification-status">{[...labels].join('；')}</p>
        {[...reasons].map(reason => <p key={reason}>{reason}</p>)}
      </li>)}
    </ol>}
  </section>;
}
