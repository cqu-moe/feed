import { useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle, Button } from '@cqu-moe/ui';
import { RefreshCw } from 'lucide-react';
import { parseSubscriptionMatches, requestJson, type NotificationMatch } from './api';
import { formatDateTime, LoginRequiredState } from './components';

const statusLabels: Record<string, string> = {
  pending_immediate: '等待及时提醒', merged_immediate: '并入及时提醒',
  pending_daily_digest: '等待每日摘要', waiting_date_verification: '等待核实日期',
  mail_off: '邮件已关闭', suppressed: '不发送邮件', claimed: '已排入邮件',
  sent: '已提交', accepted: '服务商已受理', delivered: '收件服务器已接收',
  submission_unknown: '发送结果待确认', cancelled: '已取消',
};

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
    if (match.reason) entry.reasons.add(match.reason);
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
