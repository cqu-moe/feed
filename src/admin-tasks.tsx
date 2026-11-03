import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Alert, AlertDescription, AlertTitle, Button, ContentContainer, Input, Label, PageHeader, PageState } from '@cqu-moe/ui';
import { RefreshCw } from 'lucide-react';
import { articleStatusLabel, formatDateTime, StandaloneHeader } from './components';
import { AdminMailPanel } from './admin-mail';
import { AdminNotificationEvents } from './admin-notifications';
import { AdminOperationsPanel } from './admin-operations';
import { adminRequestMessage, requestJson } from './api';

type Task = {
  id: string; kind?: string; sourceId?: string; articleId: string | null; articleTitle?: string; state: string;
  attemptNo: number; workflowInstanceId: string | null; attemptState: string | null;
  articleStatus: string | null; dueAt: number; lastError: string | null;
  createdAt?: number; updatedAt?: number;
  missingRequirements?: Array<{ kind: string; name: string | null; filename: string | null; state: string; error: string | null }>;
};
const states: Record<string, string> = {
  queued: '等待接手', starting: '正在交接', running: '执行中', succeeded: '执行结束',
  deferred: '已延期', blocked: '等待处理', failed: '执行失败', cancelled: '已取消',
};
function parseTask(value: unknown): Task {
  if (!value || typeof value !== 'object') throw new Error('任务数据不完整。');
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !/^[a-f0-9]{24}$/.test(row.id)
    || (row.articleId !== null && (typeof row.articleId !== 'string' || !/^[a-f0-9]{24}$/.test(row.articleId)))
    || typeof row.state !== 'string' || !Object.hasOwn(states, row.state)
    || !Number.isSafeInteger(row.attemptNo) || typeof row.dueAt !== 'number') throw new Error('任务数据不完整。');
  for (const key of ['workflowInstanceId', 'attemptState', 'articleStatus', 'lastError']) {
    if (row[key] !== null && typeof row[key] !== 'string') throw new Error('任务状态不完整。');
  }
  if (row.missingRequirements !== undefined && !Array.isArray(row.missingRequirements)) throw new Error('任务缺项数据不完整。');
  for (const requirement of row.missingRequirements ?? []) {
    if (!requirement || typeof requirement !== 'object' || typeof requirement.kind !== 'string'
      || typeof requirement.state !== 'string' || (requirement.name !== null && typeof requirement.name !== 'string')
      || (requirement.filename !== null && typeof requirement.filename !== 'string')
      || (requirement.error !== null && typeof requirement.error !== 'string')) throw new Error('任务缺项数据不完整。');
  }
  return row as Task;
}
function parseList(value: unknown): Task[] {
  if (!value || typeof value !== 'object' || !('tasks' in value) || !Array.isArray(value.tasks)) throw new Error('任务列表不完整。');
  return value.tasks.map(parseTask);
}
function parseCreated(value: unknown): Task {
  if (!value || typeof value !== 'object' || !('task' in value)) throw new Error('任务未返回确认结果。');
  return parseTask(value.task);
}
const label = (state: string | null) => state ? states[state] ?? state : '尚未接手';
const taskTime = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value)
  ? formatDateTime(new Date(value).toISOString()) : '未记录';

export function AdminTasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [articleId, setArticleId] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const intent = useRef<{ articleId: string; requestId: string } | null>(null);
  const activeTask = tasks.find(task => task.id === selected);

  useEffect(() => {
    let cancelled = false;
    requestJson('/internal/capture-tasks', parseList).then(result => {
      if (cancelled) return;
      if (!result.ok) setError(adminRequestMessage(result.status, '读取', result.message));
      else setTasks(result.data);
    });
    return () => { cancelled = true; };
  }, []);

  async function load() {
    const result = await requestJson('/internal/capture-tasks', parseList);
    if (!result.ok) throw new Error(adminRequestMessage(result.status, '读取', result.message));
    setTasks(result.data);
  }
  async function action(run: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { await run(); } catch (cause) { setError(cause instanceof Error ? cause.message : '操作未确认，请稍后重试。'); }
    finally { setBusy(false); }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void action(async () => {
      const id = articleId.trim();
      if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('请填写通知链接中的 24 位通知 ID。');
      if (intent.current?.articleId !== id) intent.current = { articleId: id, requestId: crypto.randomUUID() };
      const result = await requestJson('/internal/capture-tasks', parseCreated, {
        method: 'POST', body: JSON.stringify(intent.current),
      });
      if (!result.ok) throw new Error(adminRequestMessage(result.status, '提交', result.message));
      setSelected(result.data.id);
      setTasks(prior => [result.data, ...prior.filter(task => task.id !== result.data.id)]);
      setNotice('采集任务已保存。刷新状态可查看接手与归档结果。');
      intent.current = null;
    });
  }
  function recover() {
    void action(async () => {
      const result = await requestJson('/internal/capture-tasks/recover', value => value, {
        method: 'POST',
      });
      if (!result.ok) throw new Error(adminRequestMessage(result.status, '恢复', result.message));
      await load();
      setNotice('已检查到期任务。余额不足和需要人工处理的任务会保留原因。');
    });
  }

  return <div className="feed-standalone-page">
    <StandaloneHeader actions={
      <Button asChild variant="outline" size="sm">
        <Link to="/admin/sources">来源管理</Link>
      </Button>
    } />
    <ContentContainer width="standard">
      <div className="feed-admin-content">
        <PageHeader title="采集任务管理" description="对已发现的通知发起采集，查看任务接手、延期和归档结果。" />
        {error && <Alert variant="destructive"><AlertTitle>操作未完成</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
        {notice && <p role="status">{notice}</p>}
        <>
          <form className="feed-card feed-admin-form" onSubmit={submit}>
            <Label htmlFor="capture-article-id">通知 ID</Label>
            <Input id="capture-article-id" value={articleId} onChange={event => setArticleId(event.target.value)} placeholder="通知阅读链接中的 24 位 ID" maxLength={24} required disabled={busy} />
            <div className="feed-card-actions">
              <Button type="submit" disabled={busy || !articleId}>{busy ? '正在处理…' : '发起一次采集'}</Button>
              <Button type="button" variant="outline" disabled={busy} onClick={() => void action(() => load())}><RefreshCw aria-hidden="true" />刷新状态</Button>
              <Button type="button" variant="outline" disabled={busy} onClick={recover}>恢复到期任务</Button>
            </div>
          </form>
          {activeTask && <section className="feed-card feed-admin-detail" aria-label="所选任务详情">
            <h2>任务详情</h2>
            <dl className="feed-source-meta">
              <div><dt>任务</dt><dd>{label(activeTask.state)} · 第 {activeTask.attemptNo} 次执行</dd></div>
              <div><dt>创建时间</dt><dd>{taskTime(activeTask.createdAt)}</dd></div>
              <div><dt>状态更新时间</dt><dd>{taskTime(activeTask.updatedAt)}</dd></div>
              <div><dt>Workflow 接手</dt><dd>{label(activeTask.attemptState)}</dd></div>
              <div><dt>通知归档</dt><dd>{activeTask.articleStatus ? articleStatusLabel(activeTask.articleStatus) : '未记录'}</dd></div>
              {activeTask.state === 'deferred' && <div><dt>最早恢复时间</dt><dd>{formatDateTime(new Date(activeTask.dueAt).toISOString())}</dd></div>}
              {(activeTask.missingRequirements?.length ?? 0) > 0 && <div className="feed-admin-missing">
                <dt>必要内容缺项</dt>
                <dd>
                  <ul>
                    {(activeTask.missingRequirements ?? []).map(requirement => (
                      <li key={`${requirement.kind}-${requirement.filename ?? requirement.name ?? ''}`}>
                        {requirement.name ?? requirement.filename ?? requirement.kind} · {requirement.error ?? requirement.state}
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>}
            </dl>
            <p className="feed-admin-id">任务 ID：{activeTask.id}</p>
            <p className="feed-admin-id">实例 ID：{activeTask.workflowInstanceId ?? '尚未创建'}</p>
            {activeTask.lastError && <p role="status">{activeTask.lastError}</p>}
            {activeTask.articleId && <Button asChild variant="outline"><Link to={`/articles/${activeTask.articleId}`}>查看通知</Link></Button>}
          </section>}
          <AdminOperationsPanel />
          <AdminNotificationEvents />
          <AdminMailPanel />
          <section aria-label="最近采集任务">
            <h2>最近采集任务</h2>
            <p>列表保留历史执行结果；请结合状态更新时间判断近期运行情况。</p>
            <p><a href="https://us.posthog.com/project/662666/dashboard/2205863" target="_blank" rel="noreferrer">在 PostHog 查看采集趋势与积压</a></p>
            {tasks.length === 0 ? <PageState state="empty" title="还没有采集任务" description="填写已发现通知的 ID，发起第一次采集。" /> :
              <div className="feed-article-list">{tasks.map(task => <article className="feed-card" key={task.id}>
                <div className="feed-article-topline"><strong>{task.articleTitle ?? task.articleId ?? `栏目发现 / 验证 · ${task.sourceId ?? ''}`}</strong><span className="feed-status">{label(task.state)}</span></div>
                <p>状态更新：{taskTime(task.updatedAt)} · 第 {task.attemptNo} 次执行</p>
                <p className="feed-admin-id">{task.id}</p>
                <Button variant="outline" onClick={() => setSelected(task.id)} aria-pressed={selected === task.id}>查看任务详情</Button>
              </article>)}</div>}
          </section>
        </>
      </div>
    </ContentContainer>
  </div>;
}
