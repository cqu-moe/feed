import { Button } from '@cqu-moe/ui';
import { CircleAlert, CircleCheck, Clock3, ExternalLink, Pause, XCircle } from 'lucide-react';
import { Link } from 'react-router';
import { articleStatusLabel, formatDateTime } from './components';
import { DirectorySite, DirectoryEntry } from './directory-rows';
import { states, type Task, type TaskState } from './task-list-data';

const filters: TaskState[] = ['failed', 'blocked', 'cancelled', 'queued', 'starting', 'running', 'deferred', 'succeeded'];
const alwaysVisible = new Set<TaskState>(['failed', 'cancelled', 'queued', 'succeeded']);
const kindLabels: Record<string, string> = {
  discover: '栏目检查', capture: '通知采集', recheck: '通知复查', backfill: '历史补采',
  ocr: '文字识别', 'match-event': '订阅匹配', migration: '数据迁移',
};
const results: Record<TaskState, string> = {
  failed: '任务执行失败，未记录具体原因。', blocked: '任务等待人工处理。', cancelled: '任务已取消，不会继续执行。',
  queued: '任务已排队，等待执行。', starting: '任务正在启动。', running: '任务正在执行。',
  deferred: '任务已延期，等待下次调度。', succeeded: '本次任务已完成。',
};
function appearance(state: TaskState) {
  switch (state) {
    case 'failed': return { tone: 'is-error', Icon: CircleAlert };
    case 'blocked': return { tone: 'is-paused', Icon: Pause };
    case 'cancelled': return { tone: 'is-paused', Icon: XCircle };
    case 'succeeded': return { tone: 'is-ok', Icon: CircleCheck };
    default: return { tone: 'is-warning', Icon: Clock3 };
  }
}
function time(value?: number) {
  return typeof value === 'number' && Number.isFinite(new Date(value).getTime())
    ? formatDateTime(new Date(value).toISOString()) : '未记录';
}
function column(task: Task) {
  const name = task.sourceName || task.sourceId || '';
  const prefix = task.siteName + ' · ';
  return task.siteName && name.startsWith(prefix) ? name.slice(prefix.length) : name;
}
function groupTasks(tasks: Task[]) {
  const sites = new Map<string, { name: string; rows: Task[]; counts: Partial<Record<TaskState, number>> }>();
  for (const task of tasks) {
    const key = task.siteId ? 'site:' + task.siteId : task.sourceId ? 'source:' + task.sourceId : 'unassigned';
    const site = sites.get(key) ?? { name: task.siteName || task.sourceName || task.sourceId || '未关联网站', rows: [], counts: {} };
    site.rows.push(task); site.counts[task.state] = (site.counts[task.state] ?? 0) + 1;
    sites.set(key, site);
  }
  return sites;
}

export function TaskDirectory({ tasks, filter, onFilter, revealId, busy, onRetry }: {
  tasks: Task[]; filter: TaskState | 'all'; onFilter: (value: TaskState | 'all') => void;
  revealId: string | null; busy: boolean; onRetry: (task: Task) => void;
}) {
  const visible = filter === 'all' ? tasks : tasks.filter(task => task.state === filter);
  const sites = groupTasks(visible);
  const counts = new Map<TaskState, number>();
  for (const task of tasks) counts.set(task.state, (counts.get(task.state) ?? 0) + 1);
  return <section className="feed-directory task-directory" aria-label="最近采集任务">
    <div className="task-filters" role="group" aria-label="按任务状态筛选">
      {([...filters.filter(key => alwaysVisible.has(key) || counts.has(key) || filter === key), 'all'] as const).map(key =>
        <Button key={key} size="sm" variant="outline" aria-pressed={key === filter} onClick={() => onFilter(key)}>
          <i className={'task-filter-dot ' + (key === 'all' ? '' : appearance(key).tone)} aria-hidden="true" />
          {key === 'all' ? '全部' : states[key]} {key === 'all' ? tasks.length : counts.get(key) ?? 0}
        </Button>)}
    </div>
    <div className="directory-caption"><h2>{filter === 'all' ? '全部任务' : filter === 'failed' ? '需要排查' : states[filter]}</h2>
      <span>{visible.length} 条任务 · 按网站分组</span></div>
    {!visible.length && <p>{!tasks.length ? '还没有采集任务。' : '最近的任务中没有' + (filter === 'all' ? '' : '「' + states[filter] + '」') + '记录。'}</p>}
    {Array.from(sites, ([id, site]) => <DirectorySite key={id} name={site.name} count={site.rows.length + ' 条任务'}
      reveal={site.rows.some(task => task.id === revealId)}
      totals={filters.filter(state => site.counts[state]).map(state => <span key={state} className={appearance(state).tone}>{states[state]} {site.counts[state]}</span>)}>
      {site.rows.map(task => {
        const { tone, Icon } = appearance(task.state);
        const kind = kindLabels[task.kind ?? ''] ?? '采集任务';
        return <DirectoryEntry key={task.id} title={task.articleTitle || column(task) || kind} reveal={task.id === revealId}
          badge={<span className={'directory-badge ' + tone}><Icon aria-hidden="true" />{states[task.state]}</span>}>
          <TaskDetails task={task} kind={kind} busy={busy} retry={() => onRetry(task)} />
        </DirectoryEntry>;
      })}
    </DirectorySite>)}
  </section>;
}

function TaskDetails({ task, kind, busy, retry }: { task: Task; kind: string; busy: boolean; retry: () => void }) {
  const retryable = task.state === 'failed' && ['discover', 'capture', 'ocr'].includes(task.kind ?? '');
  return <div className="directory-detail">
    <div className="task-result"><span>{task.state === 'failed' ? '失败原因' : '执行结果'}</span>
      <p>{task.lastError || results[task.state]}</p></div>
    <dl>
      <div><dt>任务类型</dt><dd>{kind}</dd></div>
      {task.articleTitle && column(task) && <div><dt>栏目</dt><dd>{column(task)}</dd></div>}
      <div><dt>状态更新</dt><dd>{time(task.updatedAt)}</dd></div>
      <div><dt>执行次数</dt><dd>{task.attemptNo} 次</dd></div>
      {task.state === 'deferred' && <div><dt>最早恢复时间</dt><dd>{time(task.dueAt)}</dd></div>}
      {task.articleStatus && <div><dt>通知归档</dt><dd>{articleStatusLabel(task.articleStatus)}</dd></div>}
      {!!task.missingRequirements?.length && <div><dt>必要内容缺项</dt><dd><ul>{task.missingRequirements.map((item, index) =>
        <li key={index}>{item.name || item.filename || item.kind} · {item.error || item.state}</li>)}</ul></dd></div>}
    </dl>
    <div className="task-actions">
      {task.listUrl && /^https?:\/\//i.test(task.listUrl) && <a className="feed-plain-link" href={task.listUrl} target="_blank" rel="noreferrer">打开原栏目 <ExternalLink aria-hidden="true" /></a>}
      {task.articleId && <Link className="feed-plain-link" to={'/articles/' + task.articleId}>查看通知</Link>}
      {retryable && <Button variant="outline" size="sm" disabled={busy} onClick={retry}>重试此任务</Button>}
    </div>
    <details className="task-refs"><summary>执行记录</summary>
      <p>创建时间：{time(task.createdAt)}</p><p>执行进度：{task.attemptState ? states[task.attemptState as TaskState] ?? task.attemptState : '尚未接手'}</p>
      <p>任务 ID：{task.id}</p><p>实例 ID：{task.workflowInstanceId ?? '尚未创建'}</p>
    </details>
  </div>;
}
