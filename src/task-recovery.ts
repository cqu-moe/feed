import { adminRequestMessage, requestJson } from './api';

export async function recoverListedTask(taskId: string) {
  const result = await requestJson(`/internal/operations/tasks/${taskId}/recover`, value => {
    if (!value || typeof value !== 'object' || !('state' in value) || typeof value.state !== 'string'
      || !('recovered' in value) || (value.recovered !== 1 && value.recovered !== 0)) throw new Error('任务恢复结果不完整。');
    return { state: value.state, recovered: value.recovered };
  }, { method: 'POST' });
  if (!result.ok) throw new Error(adminRequestMessage(result.status, '恢复', result.message));
  return result.data;
}
