import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Alert, AlertDescription, AlertTitle, Button, ContentContainer, Input, Label, PageHeader, PageState } from '@cqu-moe/ui';
import { RefreshCw } from 'lucide-react';
import { requestJson } from './api';
import { articleStatusLabel, formatDateTime, StandaloneHeader } from './components';

type Task = {
  id: string; kind?: string; sourceId?: string; articleId: string | null; articleTitle?: string; state: string;
  attemptNo: number; workflowInstanceId: string | null; attemptState: string | null;
  articleStatus: string | null; dueAt: number; lastError: string | null;
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

export function AdminTasksPage() {
  // Operator credentials exist only for this mounted page, never in URLs or browser storage.
  const [credential, setCredential] = useState('');
  const [token, setToken] = useState('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [articleId, setArticleId] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const intent = useRef<{ articleId: string; requestId: string } | null>(null);
  const activeTask = tasks.find(task => task.id === selected);

  async function load(operatorToken: string) {
    const result = await requestJson('/internal/capture-tasks', parseList, { headers: { Authorization: `Bearer ${operatorToken}` } });
    if (!result.ok) throw new Error(result.status === 401 ? '管理员凭据无效，请重新输入。' : result.message);
    setTasks(result.data);
  }
  async function action(run: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { await run(); } catch (cause) { setError(cause instanceof Error ? cause.message : '操作未确认，请稍后重试。'); }
    finally { setBusy(false); }
  }
  function connect(event: FormEvent) {
    event.preventDefault();
    void action(async () => { await load(credential); setToken(credential); setCredential(''); });
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void action(async () => {
      const id = articleId.trim();
      if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('请填写通知链接中的 24 位通知 ID。');
      if (intent.current?.articleId !== id) intent.current = { articleId: id, requestId: crypto.randomUUID() };
      const result = await requestJson('/internal/capture-tasks', parseCreated, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(intent.current),
      });
      if (!result.ok) throw new Error(result.status === 503 ? '暂时无法提交，请确认采集已启用后重试；重试会保留本次请求身份。' : result.message);
      setSelected(result.data.id);
      setTasks(prior => [result.data, ...prior.filter(task => task.id !== result.data.id)]);
      setNotice('采集任务已保存。刷新状态可查看接手与归档结果。');
      intent.current = null;
    });
  }
  function disconnect() {
    setToken(''); setCredential(''); setTasks([]); setSelected(null); setError(''); setNotice(''); intent.current = null;
  }
  function recover() {
    void action(async () => {
      const result = await requestJson('/internal/capture-tasks/recover', value => value, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      });
      if (!result.ok) throw new Error(result.message);
      await load(token);
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
        <PageHeader title="采集任务管理" description="对已发现的通知发起采集，查看任务接手、延期和归档结果。"
          actions={token ? <Button variant="outline" onClick={disconnect} disabled={busy}>退出管理</Button> : undefined} />
        {error && <Alert variant="destructive"><AlertTitle>操作未完成</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
        {notice && <p role="status">{notice}</p>}
        {!token ? <form className="feed-card feed-admin-form" onSubmit={connect}>
          <Label htmlFor="admin-token">管理员凭据</Label>
          <Input id="admin-token" type="password" autoComplete="off" value={credential} onChange={event => setCredential(event.target.value)} required disabled={busy} />
          <p className="feed-admin-note">凭据仅在此页面暂存，离开后需要重新输入。普通阅读权限不能用于管理采集。</p>
          <Button type="submit" disabled={busy || !credential}>{busy ? '正在验证…' : '进入管理'}</Button>
        </form> : <>
          <form className="feed-card feed-admin-form" onSubmit={submit}>
            <Label htmlFor="capture-article-id">通知 ID</Label>
            <Input id="capture-article-id" value={articleId} onChange={event => setArticleId(event.target.value)} placeholder="通知阅读链接中的 24 位 ID" maxLength={24} required disabled={busy} />
            <div className="feed-card-actions">
              <Button type="submit" disabled={busy || !articleId}>{busy ? '正在处理…' : '发起一次采集'}</Button>
              <Button type="button" variant="outline" disabled={busy} onClick={() => void action(() => load(token))}><RefreshCw aria-hidden="true" />刷新状态</Button>
              <Button type="button" variant="outline" disabled={busy} onClick={recover}>恢复到期任务</Button>
            </div>
          </form>
          {activeTask && <section className="feed-card feed-admin-detail" aria-label="所选任务详情">
            <h2>任务详情</h2>
            <dl className="feed-source-meta">
              <div><dt>任务</dt><dd>{label(activeTask.state)} · 第 {activeTask.attemptNo} 次执行</dd></div>
              <div><dt>Workflow 接手</dt><dd>{label(activeTask.attemptState)}</dd></div>
              <div><dt>通知归档</dt><dd>{activeTask.articleStatus ? articleStatusLabel(activeTask.articleStatus) : '未记录'}</dd></div>
              {activeTask.state === 'deferred' && <div><dt>最早恢复时间</dt><dd>{formatDateTime(new Date(activeTask.dueAt).toISOString())}</dd></div>}
            </dl>
            <p className="feed-admin-id">任务 ID：{activeTask.id}</p>
            <p className="feed-admin-id">实例 ID：{activeTask.workflowInstanceId ?? '尚未创建'}</p>
            {activeTask.lastError && <p role="status">{activeTask.lastError}</p>}
            {activeTask.articleId && <Button asChild variant="outline"><Link to={`/articles/${activeTask.articleId}`}>查看通知</Link></Button>}
          </section>}
          <section aria-label="最近采集任务">
            <h2>最近采集任务</h2>
            {tasks.length === 0 ? <PageState state="empty" title="还没有采集任务" description="填写已发现通知的 ID，发起第一次采集。" /> :
              <div className="feed-article-list">{tasks.map(task => <article className="feed-card" key={task.id}>
                <div className="feed-article-topline"><strong>{task.articleTitle ?? task.articleId ?? `栏目发现 / 验证 · ${task.sourceId ?? ''}`}</strong><span className="feed-status">{label(task.state)}</span></div>
                <p className="feed-admin-id">{task.id}</p>
                <Button variant="outline" onClick={() => setSelected(task.id)} aria-pressed={selected === task.id}>查看任务详情</Button>
              </article>)}</div>}
          </section>
        </>}
      </div>
    </ContentContainer>
  </div>;
}
