import { useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription, AlertTitle, Button, PageState } from '@cqu-moe/ui';
import { RefreshCw } from 'lucide-react';
import { requestJson } from './api';

type BusinessId = string | null;

type Identity = {
  sourceId: BusinessId;
  taskId: BusinessId;
  revisionId: BusinessId;
  eventId: BusinessId;
  articleId: BusinessId;
  messageId: BusinessId;
  deliveryId: BusinessId;
};

type QueueDeadLetter = Identity & {
  outboxId: string;
  topic: 'feed-jobs' | 'feed-events' | 'feed-mail';
  messageType: string;
  kind: string;
  attempts: number;
  replayCount: number;
  ageMs: number;
  lastError: string | null;
};

type TaskDiagnostic = Identity & {
  id: string;
  kind: string;
  state: string;
  attemptNo: number;
  workflowInstanceId: string | null;
  handedOffAt: string | null;
  errorCode: string | null;
  lastError: string | null;
};

type RequirementDiagnostic = Identity & {
  revisionId: string;
  slotKey: string;
  requirementKind: string;
  state: string;
  errorCode: string | null;
};

type MessageDiagnostic = Identity & {
  kind: string;
  messageId: string;
  state: string;
  attempts: number;
  lastError: string | null;
};

type Diagnostics = {
  generatedAt: string;
  limit: number;
  queues: Array<{ topic: QueueDeadLetter['topic']; deadLetters: QueueDeadLetter[] }>;
  tasks: TaskDiagnostic[];
  requirements: RequirementDiagnostic[];
  messages: MessageDiagnostic[];
  metrics: {
    oldestBacklog: { id: string; scope: string; ageMs: number } | null;
    readyLatency: { count: number; minMs: number | null; maxMs: number | null };
    missingRequirements: number;
    paidVendorCalls: number;
    paidOcrPages: number;
    authUnavailable: number;
    mailUnknown: number;
    referencedImmutableArtifacts: number;
  };
};

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: Diagnostics }
  | { kind: 'error'; message: string };

const topicLabels: Record<QueueDeadLetter['topic'], string> = {
  'feed-jobs': '采集任务队列',
  'feed-events': '内容事件队列',
  'feed-mail': '邮件队列',
};

const kindLabels: Record<string, string> = {
  queue_handoff: 'Queue 交接失败或结果不明',
  workflow_failure: 'Workflow 执行失败',
  workflow_deferred: 'Workflow 已延期',
  workflow_blocked: 'Workflow 等待处理',
  workflow_stale: 'Workflow 状态待核对',
  matching_pending: '订阅匹配未完成',
  missing_requirement: '版本必要内容缺项',
  mail_unknown: '邮件提交结果不明',
  auth_unavailable: 'Auth 暂不可用',
};

const idLabels: Array<[keyof Identity, string]> = [
  ['sourceId', '来源'],
  ['taskId', '任务'],
  ['revisionId', '版本'],
  ['eventId', '事件'],
  ['articleId', '通知'],
  ['messageId', '邮件'],
  ['deliveryId', '投递'],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalId(value: unknown): BusinessId {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function nonNegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseIdentity(value: unknown): Identity {
  if (!isRecord(value)) throw new Error('诊断身份数据不完整。');
  return {
    sourceId: optionalId(value.sourceId),
    taskId: optionalId(value.taskId),
    revisionId: optionalId(value.revisionId),
    eventId: optionalId(value.eventId),
    articleId: optionalId(value.articleId),
    messageId: optionalId(value.messageId),
    deliveryId: optionalId(value.deliveryId),
  };
}

function parseQueueItem(value: unknown): QueueDeadLetter {
  if (!isRecord(value) || typeof value.outboxId !== 'string' || !/^[a-f0-9]{24}$/.test(value.outboxId)
    || (value.topic !== 'feed-jobs' && value.topic !== 'feed-events' && value.topic !== 'feed-mail')
    || typeof value.messageType !== 'string' || typeof value.kind !== 'string'
    || !nonNegativeInteger(value.attempts) || !nonNegativeInteger(value.replayCount)
    || !nonNegativeInteger(value.ageMs) || (value.lastError !== null && typeof value.lastError !== 'string'))
    throw new Error('队列诊断数据不完整。');
  return { ...parseIdentity(value), ...(value as QueueDeadLetter) };
}

function parseTask(value: unknown): TaskDiagnostic {
  if (!isRecord(value) || typeof value.id !== 'string' || !/^[a-f0-9]{24}$/.test(value.id)
    || typeof value.kind !== 'string' || typeof value.state !== 'string'
    || !nonNegativeInteger(value.attemptNo) || Number(value.attemptNo) < 1
    || (value.workflowInstanceId !== null && typeof value.workflowInstanceId !== 'string')
    || (value.handedOffAt !== null && typeof value.handedOffAt !== 'string')
    || (value.errorCode !== null && typeof value.errorCode !== 'string')
    || (value.lastError !== null && typeof value.lastError !== 'string'))
    throw new Error('任务诊断数据不完整。');
  return { ...parseIdentity(value), ...(value as TaskDiagnostic) };
}

function parseRequirement(value: unknown): RequirementDiagnostic {
  if (!isRecord(value) || typeof value.revisionId !== 'string' || !/^[a-f0-9]{24}$/.test(value.revisionId)
    || typeof value.slotKey !== 'string' || typeof value.requirementKind !== 'string' || typeof value.state !== 'string'
    || (value.errorCode !== null && typeof value.errorCode !== 'string'))
    throw new Error('版本缺项数据不完整。');
  return { ...parseIdentity(value), ...(value as RequirementDiagnostic) };
}

function parseMessage(value: unknown): MessageDiagnostic {
  if (!isRecord(value) || typeof value.messageId !== 'string' || !/^[a-f0-9]{24}$/.test(value.messageId)
    || typeof value.kind !== 'string' || typeof value.state !== 'string'
    || !nonNegativeInteger(value.attempts) || (value.lastError !== null && typeof value.lastError !== 'string'))
    throw new Error('邮件诊断数据不完整。');
  return { ...parseIdentity(value), ...(value as MessageDiagnostic) };
}

function parseDiagnostics(value: unknown): Diagnostics {
  if (!isRecord(value) || typeof value.generatedAt !== 'string' || !nonNegativeInteger(value.limit)
    || !Array.isArray(value.queues) || !Array.isArray(value.tasks)
    || !Array.isArray(value.requirements) || !Array.isArray(value.messages) || !isRecord(value.metrics))
    throw new Error('运行诊断数据不完整。');
  return {
    generatedAt: value.generatedAt,
    limit: Number(value.limit),
    queues: value.queues.map((row: unknown) => {
      if (!isRecord(row) || (row.topic !== 'feed-jobs' && row.topic !== 'feed-events' && row.topic !== 'feed-mail')
        || !Array.isArray(row.deadLetters)) throw new Error('队列诊断数据不完整。');
      return { topic: row.topic, deadLetters: row.deadLetters.map(parseQueueItem) };
    }),
    tasks: value.tasks.map(parseTask),
    requirements: value.requirements.map(parseRequirement),
    messages: value.messages.map(parseMessage),
    metrics: parseMetrics(value.metrics),
  };
}

function parseMetrics(value: unknown): Diagnostics['metrics'] {
  if (!isRecord(value)) throw new Error('运行指标数据不完整。');
  for (const key of ['missingRequirements', 'paidVendorCalls', 'paidOcrPages', 'authUnavailable', 'mailUnknown', 'referencedImmutableArtifacts']) {
    if (!nonNegativeInteger(value[key])) throw new Error('运行指标数据不完整。');
  }
  const latency = value.readyLatency;
  if (!isRecord(latency) || !nonNegativeInteger(latency.count)
    || (latency.minMs !== null && !nonNegativeInteger(latency.minMs))
    || (latency.maxMs !== null && !nonNegativeInteger(latency.maxMs))) throw new Error('运行指标数据不完整。');
  const backlog = value.oldestBacklog;
  if (backlog !== null && (!isRecord(backlog) || typeof backlog.id !== 'string' || typeof backlog.scope !== 'string'
    || !nonNegativeInteger(backlog.ageMs))) throw new Error('运行指标数据不完整。');
  return value as Diagnostics['metrics'];
}

function parseRecoveryResult(value: unknown): { state: string; recovered: number } {
  if (!isRecord(value) || typeof value.state !== 'string' || !nonNegativeInteger(value.recovered))
    throw new Error('任务恢复结果不完整。');
  return { state: value.state, recovered: Number(value.recovered) };
}

export function AdminOperationsPanel({ token }: { token: string }) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [busyAction, setBusyAction] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    const pending = new AbortController();
    controller.current = pending;
    setState({ kind: 'loading' });
    requestJson('/internal/operations/diagnostics', parseDiagnostics, {
      signal: pending.signal,
      headers: { Authorization: `Bearer ${token}` },
    }).then(result => {
      if (pending.signal.aborted) return;
      if (result.ok) setState({ kind: 'ready', data: result.data });
      else setState({ kind: 'error', message: result.status === 401 ? '管理员凭据无效，请重新进入管理。' : result.message });
    });
    return () => pending.abort();
  }, [token, reloadKey]);

  async function refresh() {
    setReloadKey(value => value + 1);
  }

  async function runAction(key: string, request: () => Promise<void>) {
    if (busyAction) return;
    setBusyAction(key); setActionError(''); setNotice('');
    try {
      await request();
      await refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '操作未确认，请稍后重试。');
    } finally {
      setBusyAction('');
    }
  }

  function replayDeadLetter(item: QueueDeadLetter) {
    const key = `replay:${item.outboxId}`;
    void runAction(key, async () => {
      const result = await requestJson('/internal/operations/replay', value => value, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ outboxId: item.outboxId, topic: item.topic }),
      });
      if (!result.ok) throw new Error(result.message);
      setNotice(`已按原业务身份重放 ${item.outboxId}。`);
    });
  }

  function recoverTask(task: TaskDiagnostic) {
    const key = `task:${task.id}`;
    void runAction(key, async () => {
      const result = await requestJson(`/internal/operations/tasks/${task.id}/recover`, parseRecoveryResult, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!result.ok) throw new Error(result.message);
      setNotice(result.data.recovered === 1
        ? `已为任务 ${task.id} 创建第 ${task.attemptNo + 1} 次执行。`
        : `任务 ${task.id} 仍在 ${task.state}，未重复启动。`);
    });
  }

  const loading = state.kind === 'loading';
  const diagnostics = state.kind === 'ready' ? state.data : null;
  const deadLetters = diagnostics?.queues.flatMap(queue => queue.deadLetters) ?? [];

  return <section className="feed-card feed-admin-operations" aria-label="运行诊断与恢复">
    <div className="feed-source-heading">
      <div>
        <h2>运行诊断</h2>
        <p>定位队列交接、Workflow 执行、版本缺项和邮件结果不明的指定工作。</p>
      </div>
      <Button type="button" variant="outline" disabled={loading || Boolean(busyAction)} onClick={() => void refresh()}>
        <RefreshCw aria-hidden="true" />{loading ? '正在读取…' : '刷新诊断'}
      </Button>
    </div>
    {actionError && <Alert variant="destructive"><AlertTitle>恢复操作未完成</AlertTitle><AlertDescription>{actionError}</AlertDescription></Alert>}
    {notice && <p role="status">{notice}</p>}
    {state.kind === 'loading' && <PageState state="loading" title="正在读取运行诊断" description="正在汇总队列、任务、版本和邮件状态。" />}
    {state.kind === 'error' && <Alert variant="destructive"><AlertTitle>运行诊断读取失败</AlertTitle><AlertDescription>{state.message}</AlertDescription></Alert>}
    {diagnostics && <>
      <dl className="feed-operations-metrics" aria-label="运行指标">
        <Metric label="最老积压" value={diagnostics.metrics.oldestBacklog ? formatDuration(diagnostics.metrics.oldestBacklog.ageMs) : '无'} />
        <Metric label="发现到 ready" value={formatLatency(diagnostics.metrics.readyLatency)} />
        <Metric label="必要缺项" value={String(diagnostics.metrics.missingRequirements)} />
        <Metric label="付费调用" value={`${diagnostics.metrics.paidVendorCalls} 次`} />
        <Metric label="OCR 页数" value={`${diagnostics.metrics.paidOcrPages} 页`} />
        <Metric label="Auth 不可用" value={String(diagnostics.metrics.authUnavailable)} />
        <Metric label="邮件结果不明" value={String(diagnostics.metrics.mailUnknown)} />
        <Metric label="引用历史原件" value={String(diagnostics.metrics.referencedImmutableArtifacts)} />
      </dl>
      <section aria-label="队列死信检查">
        <h3>业务队列死信</h3>
        {deadLetters.length === 0 ? <p>三条业务队列没有超过重试窗口的未确认消息。</p> : <ul className="feed-notification-list">
          {diagnostics.queues.map(queue => queue.deadLetters.map(item => <li key={item.outboxId}>
            <div className="feed-article-topline">
              <strong>{topicLabels[item.topic]} · {item.messageType}</strong>
              <span className="feed-status">{kindLabels[item.kind] ?? item.kind}</span>
            </div>
            <IdentityLinks identity={item} />
            <p>等待 {formatDuration(item.ageMs)} · 出站 {item.attempts} 次 · 人工重放 {item.replayCount} 次</p>
            {item.lastError && <p className="feed-mail-reason">{item.lastError}</p>}
            <Button type="button" variant="outline" disabled={Boolean(busyAction)}
              onClick={() => replayDeadLetter(item)}>
              {busyAction === `replay:${item.outboxId}` ? '正在重放…' : '按原身份重放'}
            </Button>
          </li>))}
        </ul>}
      </section>
      <section aria-label="任务与缺项">
        <h3>任务与版本缺项</h3>
        {diagnostics.tasks.length === 0 && diagnostics.requirements.length === 0
          ? <p>当前没有需要处理的 Workflow 失败或必要内容缺项。</p>
          : <>
            {diagnostics.tasks.length > 0 && <ul className="feed-notification-list">
              {diagnostics.tasks.map(task => <li key={task.id}>
                <div className="feed-article-topline">
                  <strong>{kindLabels[task.kind] ?? task.kind} · 第 {task.attemptNo} 次</strong>
                  <span className="feed-status">{task.state}</span>
                </div>
                <IdentityLinks identity={task} />
                {task.workflowInstanceId && <p className="feed-admin-id">实例：{task.workflowInstanceId}</p>}
                {task.errorCode && <p className="feed-mail-reason">{task.errorCode}</p>}
                {task.lastError && <p className="feed-mail-reason">{task.lastError}</p>}
                {(task.kind === 'workflow_failure' || task.kind === 'workflow_deferred' || task.kind === 'workflow_stale') && (
                  <Button type="button" variant="outline" disabled={Boolean(busyAction)}
                    onClick={() => recoverTask(task)}>
                    {busyAction === `task:${task.id}` ? '正在核对…' : task.kind === 'workflow_stale' ? '核对并按账本恢复' : '从任务账本恢复'}
                  </Button>
                )}
              </li>)}
            </ul>}
            {diagnostics.requirements.length > 0 && <ul className="feed-notification-list">
              {diagnostics.requirements.map(requirement => <li key={`${requirement.revisionId}:${requirement.slotKey}`}>
                <div className="feed-article-topline">
                  <strong>{requirement.slotKey}</strong>
                  <span className="feed-status">{requirement.state}</span>
                </div>
                <IdentityLinks identity={requirement} />
                {requirement.errorCode && <p className="feed-mail-reason">{requirement.errorCode}</p>}
              </li>)}
            </ul>}
          </>}
      </section>
      <section aria-label="邮件结果">
        <h3>邮件结果不明</h3>
        {diagnostics.messages.length === 0 ? <p>没有需要人工确认的及时邮件。</p> : <ul className="feed-notification-list">
          {diagnostics.messages.map(message => <li key={message.messageId}>
            <div className="feed-article-topline">
              <strong>{kindLabels[message.kind] ?? message.kind}</strong>
              <span className="feed-status">{message.state}</span>
            </div>
            <IdentityLinks identity={message} />
            <p>已尝试 {message.attempts} 次 · 不能确认受理结果前保留人工处理，不自动重发。</p>
            {message.lastError && <p className="feed-mail-reason">{message.lastError}</p>}
          </li>)}
        </ul>}
      </section>
      <p className="feed-admin-note">本次最多展示 {diagnostics.limit} 条同类诊断；界面只显示业务 ID和服务端已脱敏的原因。</p>
    </>}
  </section>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="feed-operations-metric">
    <dt>{label}</dt>
    <dd>{value}</dd>
  </div>;
}

function IdentityLinks({ identity }: { identity: Identity }) {
  const links = idLabels.filter(([key]) => identity[key] !== null);
  if (!links.length) return null;
  return <p className="feed-operations-links">
    {links.map(([key, label]) => <span key={key}>{label} <code>{identity[key]}</code></span>)}
  </p>;
}

function formatDuration(value: number): string {
  if (value < 60_000) return `${Math.max(1, Math.round(value / 1000))} 秒`;
  if (value < 3_600_000) return `${Math.round(value / 60_000)} 分钟`;
  if (value < 86_400_000) return `${(value / 3_600_000).toFixed(1)} 小时`;
  return `${(value / 86_400_000).toFixed(1)} 天`;
}

function formatLatency(value: Diagnostics['metrics']['readyLatency']): string {
  if (!value.count) return '暂无样本';
  const min = value.minMs === null ? '—' : formatDuration(value.minMs);
  const max = value.maxMs === null ? '—' : formatDuration(value.maxMs);
  return `${min} - ${max}`;
}
