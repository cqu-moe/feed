import { useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription, AlertTitle, Button } from '@cqu-moe/ui';
import { requestJson } from './api';
import { formatDateTime } from './components';

type EventSummary = { id: string; kind: string; title: string; readyAt: string; historyOnly: boolean; matches: number; deliveries: number };
type EventStatus = {
  sources: Array<{ sourceId: string; firstSeenAt: string; publishedAt: string | null; publishedDay: string | null; datePrecision: string; correctionGeneration: number }>;
  matches: Array<{ subscriptionId: string; subscriptionName: string; eligibilityKind: string; reason: string; matchedAt: string }>;
  deliveries: Array<{ id: string; state: string; kind: string; suppressionReason: string | null }>;
};
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function parseEvents(value: unknown): EventSummary[] {
  if (!record(value) || !Array.isArray(value.events)) throw new Error('通知匹配列表不完整。');
  return value.events.map((row: unknown) => {
    if (!record(row) || typeof row.id !== 'string' || !/^[a-f0-9]{24}$/.test(row.id)
      || typeof row.title !== 'string' || typeof row.kind !== 'string' || typeof row.readyAt !== 'string'
      || typeof row.historyOnly !== 'boolean' || !Number.isSafeInteger(row.matches) || !Number.isSafeInteger(row.deliveries)) {
      throw new Error('通知匹配列表不完整。');
    }
    return row as EventSummary;
  });
}
function parseStatus(value: unknown): EventStatus {
  if (!record(value) || !Array.isArray(value.sources) || !Array.isArray(value.matches) || !Array.isArray(value.deliveries)) {
    throw new Error('匹配详情不完整。');
  }
  for (const row of value.sources) {
    if (!record(row) || typeof row.sourceId !== 'string' || typeof row.firstSeenAt !== 'string'
      || typeof row.datePrecision !== 'string' || !Number.isSafeInteger(row.correctionGeneration)
      || (row.publishedAt !== null && typeof row.publishedAt !== 'string')
      || (row.publishedDay !== null && typeof row.publishedDay !== 'string')) throw new Error('来源日期证据不完整。');
  }
  for (const row of value.matches) {
    if (!record(row) || typeof row.subscriptionId !== 'string' || typeof row.subscriptionName !== 'string'
      || typeof row.eligibilityKind !== 'string' || typeof row.reason !== 'string' || typeof row.matchedAt !== 'string') {
      throw new Error('订阅匹配原因不完整。');
    }
  }
  for (const row of value.deliveries) {
    if (!record(row) || typeof row.id !== 'string' || typeof row.state !== 'string' || typeof row.kind !== 'string'
      || (row.suppressionReason !== null && typeof row.suppressionReason !== 'string')) throw new Error('投递候选不完整。');
  }
  return value as EventStatus;
}
const eligibility: Record<string, string> = { new: '新增提醒', update: '更新提醒', pending: '待核实', suppressed: '不发送' };
const deliveryStates: Record<string, string> = {
  pending: '等待准备', claimed: '已排入邮件', sent: '已提交', accepted: '服务商已受理', delivered: '收件服务器已接收',
  submission_unknown: '发送结果待确认', suppressed: '已抑制', cancelled: '已取消',
};

export function AdminNotificationEvents({ token }: { token: string }) {
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [selected, setSelected] = useState<{ event: EventSummary; detail: EventStatus } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function read(event?: EventSummary) {
    if (busy) return;
    const pending = new AbortController(); controller.current = pending;
    setBusy(true); setError('');
    const init = { signal: pending.signal, headers: { Authorization: `Bearer ${token}` } };
    if (event) {
      const result = await requestJson(`/internal/notification-events/${event.id}`, parseStatus, init);
      if (pending.signal.aborted) return;
      if (result.ok) setSelected({ event, detail: result.data }); else setError(result.message);
    } else {
      const result = await requestJson('/internal/notification-events', parseEvents, init);
      if (pending.signal.aborted) return;
      if (result.ok) { setEvents(result.data); setSelected(null); } else setError(result.message);
    }
    setBusy(false);
  }
  return <section className="feed-card" aria-label="通知匹配管理">
    <div className="feed-source-heading"><h2>通知匹配</h2>
      <Button type="button" variant="outline" disabled={busy} onClick={() => void read()}>{busy ? '正在读取…' : '刷新匹配记录'}</Button>
    </div>
    <p>查看完整通知的订阅命中、日期证据和邮件候选。同一用户的多个订阅共用一条投递记录。</p>
    {error && <Alert variant="destructive"><AlertTitle>匹配记录读取失败</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
    {events !== null && events.length === 0 && <p>还没有完整通知的匹配记录。</p>}
    {selected && <section className="feed-subscription-activity" aria-label="所选通知匹配详情">
      <h3>{selected.event.title}</h3>
      <p className="feed-admin-id">事件：{selected.event.id}</p>
      <h4>来源日期证据</h4>
      <ul className="feed-notification-list">{selected.detail.sources.map(source => <li key={source.sourceId}>
        <strong>{source.sourceId}</strong>
        <p>首次发现：{formatDateTime(source.firstSeenAt)}</p>
        <p>发布日期：{source.datePrecision === 'minute' ? formatDateTime(source.publishedAt) : source.publishedDay ?? '待核实'}
          {source.correctionGeneration > 0 ? ` · 已核实 ${source.correctionGeneration} 次` : ''}</p>
      </li>)}</ul>
      <h4>订阅命中</h4>
      {!selected.detail.matches.length && <p>尚未匹配到订阅。</p>}
      <ul className="feed-notification-list">{selected.detail.matches.map((match, index) => <li key={`${match.subscriptionId}-${index}`}>
        <strong>{match.subscriptionName} · {eligibility[match.eligibilityKind] ?? '状态待确认'}</strong>
        <p>{match.reason}</p><p>匹配于 {formatDateTime(match.matchedAt)}</p>
      </li>)}</ul>
      <h4>邮件候选</h4>
      {!selected.detail.deliveries.length && <p>没有邮件候选。</p>}
      <ul className="feed-notification-list">{selected.detail.deliveries.map(delivery => <li key={delivery.id}>
        <strong>{delivery.kind === 'immediate' ? '及时提醒' : '每日摘要'} · {deliveryStates[delivery.state] ?? '状态待确认'}</strong>
        {delivery.suppressionReason && <p>{delivery.suppressionReason}</p>}
      </li>)}</ul>
    </section>}
    {events && <ul className="feed-notification-list">{events.map(event => <li key={event.id}>
      <strong>{event.title}</strong>
      <p>{event.historyOnly ? '历史存档' : event.kind === 'update' ? '内容更新' : '新通知'} · {event.matches} 条命中 · {event.deliveries} 条候选</p>
      <Button type="button" variant="outline" disabled={busy} aria-pressed={selected?.event.id === event.id}
        onClick={() => void read(event)}>查看匹配原因</Button>
    </li>)}</ul>}
  </section>;
}
