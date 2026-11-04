export type TaskState = keyof typeof states;
export type Task = {
  id: string; kind?: string; sourceId?: string | null; siteId?: string | null; siteName?: string | null; listUrl?: string | null; sourceName?: string | null; articleId: string | null; articleTitle?: string | null; state: TaskState;
  attemptNo: number; workflowInstanceId: string | null; attemptState: string | null;
  articleStatus: string | null; dueAt: number; lastError: string | null;
  createdAt?: number; updatedAt?: number;
  missingRequirements?: Array<{ kind: string; name: string | null; filename: string | null; state: string; error: string | null }>;
};
export const states = {
  queued: '排队中', starting: '正在启动', running: '执行中', succeeded: '已完成',
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
  for (const key of ['kind','sourceId','sourceName','siteId','siteName','listUrl','articleTitle']) {
    if (row[key] != null && typeof row[key] !== 'string') throw new Error('任务来源数据不完整。');
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
export function parseList(value: unknown): Task[] {
  if (!value || typeof value !== 'object' || !('tasks' in value) || !Array.isArray(value.tasks)) throw new Error('任务列表不完整。');
  return value.tasks.map(parseTask);
}
export function parseCreated(value: unknown): Task {
  if (!value || typeof value !== 'object' || !('task' in value)) throw new Error('任务未返回确认结果。');
  return parseTask(value.task);
}
