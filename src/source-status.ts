import type { Source } from './api';

export type SourceStatusTone = 'is-ok' | 'is-paused' | 'is-warning' | 'is-error';

export type SourceStatus = {
  label: string;
  tone: SourceStatusTone;
  timeLabel: string;
};

// Wait for the next hourly scan, then allow ten minutes for Queue processing.
const CRON_TOLERANCE_MS = 70 * 60 * 1000;
const PROCESSING_GRACE_MS = 10 * 60 * 1000;

function parseTime(value: string | null): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

export function sourceStatus(source: Source, now = Date.now()): SourceStatus {
  if (!source.maintenanceStateKnown) {
    if (parseTime(source.lastRunAt) === null) {
      return { label: '状态未知', tone: 'is-warning', timeLabel: '最近检查' };
    }
    return {
      label: source.error ? '最近有错误' : '运行正常',
      tone: source.error ? 'is-error' : 'is-ok',
      timeLabel: '最近检查',
    };
  }
  if (source.siteEnabled === false) {
    return { label: '站点已暂停', tone: 'is-paused', timeLabel: '最近检查' };
  }
  if (source.enabled === false) {
    return { label: '采集已暂停', tone: 'is-paused', timeLabel: '最近检查' };
  }
  if (source.validationState === 'failed') {
    return { label: '配置验证失败', tone: 'is-error', timeLabel: '最近检查' };
  }
  if (source.validationState !== 'verified') {
    if (source.validationState === undefined) return { label: '配置状态未知', tone: 'is-warning', timeLabel: '最近检查' };
    return { label: '配置待验证', tone: 'is-warning', timeLabel: '最近检查' };
  }
  if (source.error) {
    return { label: '最近有错误', tone: 'is-error', timeLabel: '最近检查' };
  }
  if (source.scheduledDiscoveryAt != null && source.scheduledDiscoveryAt > 0) {
    const label = now > source.scheduledDiscoveryAt + PROCESSING_GRACE_MS
      ? '检查已超期' : now < source.scheduledDiscoveryAt ? '等待计划检查' : '检查处理中';
    return { label, tone: 'is-warning', timeLabel: source.lastRunAt ? '最近成功检查' : '最近检查' };
  }
  if (!source.lastRunAt) {
    return { label: '等待首次采集', tone: 'is-warning', timeLabel: '最近检查' };
  }

  const lastRunAt = parseTime(source.lastRunAt);
  const interval = source.refreshIntervalSec ?? 86400;
  if (lastRunAt === null) {
    return { label: '状态未知', tone: 'is-warning', timeLabel: '最近检查' };
  }
  if (now - lastRunAt > interval * 1000 + CRON_TOLERANCE_MS) {
    return { label: '检查已超期', tone: 'is-warning', timeLabel: '最近成功检查' };
  }
  return { label: '运行正常', tone: 'is-ok', timeLabel: '最近成功检查' };
}
