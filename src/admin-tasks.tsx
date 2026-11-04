import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Alert, AlertDescription, AlertTitle, Button, ContentContainer, Input, Label, PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from '@cqu-moe/ui';
import { Plus, RefreshCw } from 'lucide-react';
import { StandaloneHeader } from './components';
import { AdminMailPanel } from './admin-mail';
import { AdminNotificationEvents } from './admin-notifications';
import { AdminOperationsPanel } from './admin-operations';
import { adminRequestMessage, requestJson } from './api';
import { parseList, parseCreated, states, type Task, type TaskState } from './task-list-data';
import { TaskDirectory } from './task-directory';
import { recoverListedTask } from './task-recovery';
import './task-management.css';

export function AdminTasksPage() {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [articleId, setArticleId] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const intent = useRef<{ articleId: string; requestId: string } | null>(null);
  const [diagnosticRevision, setDiagnosticRevision] = useState(0);
  const [tab, setTab] = useState('tasks');
  const [showForm, setShowForm] = useState(false);
  const [filter, setFilter] = useState<TaskState | 'all'>('failed');
  const [initialLoading, setInitialLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    requestJson('/internal/capture-tasks', parseList).then(result => {
      if (cancelled) return;
      setInitialLoading(false);
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
    if (busy || initialLoading) return;
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
      setTasks(prior => [result.data, ...(prior ?? []).filter(task => task.id !== result.data.id)].slice(0, 50));
      setFilter(result.data.state); setTab('tasks'); setShowForm(false);
      setNotice('采集任务已创建。');
      intent.current = null;
    });
  }
  function retry(task: Task) {
    void action(async () => {
      const result = await recoverListedTask(task.id);
      setNotice(result.recovered ? '已将这条任务重新排队。' : '没有启动新执行。当前状态：' + (states[result.state as TaskState] ?? result.state) + '。');
      await load();
    });
  }
  function recover() {
    void action(async () => {
      const result = await requestJson('/internal/capture-tasks/recover', value => value, {
        method: 'POST',
      });
      if (!result.ok) throw new Error(adminRequestMessage(result.status, '恢复', result.message));
      setDiagnosticRevision(value => value + 1);
      setNotice('已检查到期任务。余额不足和需要人工处理的任务会保留原因。');
      await load();
    });
  }

  return <div className="feed-standalone-page">
    <StandaloneHeader actions={
      <Button asChild variant="outline" size="sm">
        <Link to="/admin/sources">来源管理</Link>
      </Button>
    } />
    <ContentContainer width="standard">
      <div className="feed-admin-content task-page">
        <PageHeader title="采集任务管理" description="先处理失败任务，再查看其他执行记录。"
          actions={<Button variant="outline" disabled={initialLoading || busy} aria-expanded={showForm} onClick={() => setShowForm(!showForm)}><Plus aria-hidden="true" />手动采集</Button>} />
        {error && <Alert variant="destructive"><AlertTitle>{notice ? '列表刷新失败' : '操作未完成'}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
        {notice && <p role="status">{notice}</p>}
        {showForm && <form className="feed-card feed-admin-form" onSubmit={submit}>
          <Label htmlFor="capture-article-id">通知 ID</Label>
          <Input id="capture-article-id" value={articleId} onChange={event => setArticleId(event.target.value)} placeholder="通知阅读链接中的 24 位 ID" maxLength={24} required disabled={busy} />
          <Button type="submit" disabled={busy || !articleId}>{busy ? '正在处理…' : '发起一次采集'}</Button>
        </form>}
        <Tabs value={tab} onValueChange={setTab} className="feed-task-tabs">
          <TabsList variant="line" aria-label="管理视图">
            <TabsTrigger value="tasks">任务列表</TabsTrigger>
            <TabsTrigger value="diagnostics">运行诊断</TabsTrigger>
            <TabsTrigger value="events">订阅匹配</TabsTrigger>
            <TabsTrigger value="mail">邮件投递</TabsTrigger>
          </TabsList>
          <TabsContent value="tasks">
            <div className="task-list-tools">
              <span>按创建时间显示最近 50 条任务</span>
              <Button variant="ghost" size="sm" disabled={busy || initialLoading} onClick={() => void action(load)}><RefreshCw aria-hidden="true" />刷新状态</Button>
            </div>
            {initialLoading && <p role="status">正在读取任务…</p>}
            {tasks && <TaskDirectory tasks={tasks} filter={filter} onFilter={value => { setSelected(null); setFilter(value); }}
              revealId={selected} busy={busy} onRetry={retry} />}
          </TabsContent>
          <TabsContent value="diagnostics">
            <div className="feed-diagnostic-tools"><Button variant="outline" size="sm" disabled={busy || initialLoading} onClick={recover}>恢复到期任务</Button>
              <a className="feed-plain-link" href="https://us.posthog.com/project/662666/dashboard/2205863" target="_blank" rel="noreferrer">查看采集趋势与积压</a></div>
            <AdminOperationsPanel key={diagnosticRevision} />
          </TabsContent>
          <TabsContent value="events"><AdminNotificationEvents /></TabsContent>
          <TabsContent value="mail"><AdminMailPanel /></TabsContent>
        </Tabs>
      </div>
    </ContentContainer>
  </div>;
}
