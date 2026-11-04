import { Alert, AlertDescription, AlertTitle } from '@cqu-moe/ui';
import { CircleAlert, CircleCheck, Clock3, ExternalLink, Pause } from 'lucide-react';
import type { Source } from './api';
import { formatDateTime } from './components';
import { sourceStatus, type SourceStatusTone, type SourceStatus } from './source-status';
import { DirectorySite, DirectoryEntry } from './directory-rows';

function refreshIntervalLabel(value: number | null | undefined): string {
  if (value === null || value === undefined) return '未知';
  if (value % 86400 === 0) return `${value / 86400} 天`;
  return `${Math.round(value / 60)} 分钟`;
}

function discoveryTimeLabel(value: number | null | undefined): string {
  if (value === null || value === undefined) return '等待调度';
  if (value === 0) return '等待调度';
  return formatDateTime(new Date(value).toISOString());
}

const summaryLabels: Record<SourceStatusTone, string> = {
  'is-error': '异常', 'is-warning': '待检查', 'is-paused': '暂停', 'is-ok': '正常',
};

const statusIcons = { 'is-error': CircleAlert, 'is-warning': Clock3, 'is-paused': Pause, 'is-ok': CircleCheck };
const tones = Object.keys(summaryLabels) as SourceStatusTone[];

function groupBySite(sources: Source[]) {
  const sites = new Map<string, {
    name: string;
    counts: Partial<Record<SourceStatusTone, number>>;
    columns: { source: Source; status: SourceStatus }[];
  }>();
  const now = Date.now();
  for (const source of sources) {
    const key = source.siteId || source.url;
    let site = sites.get(key);
    if (!site) {
      const host = URL.canParse(source.url) ? new URL(source.url).hostname : '';
      site = { name: source.siteName || host || '未命名网站', counts: {}, columns: [] };
      sites.set(key, site);
    }
    const status = sourceStatus(source, now);
    site.counts[status.tone] = (site.counts[status.tone] ?? 0) + 1;
    site.columns.push({ source, status });
  }
  return sites;
}

export function SourceDirectory({ sources, admin }: { sources: Source[]; admin: boolean }) {
  const sites = groupBySite(sources);
  return <section className="feed-directory" aria-labelledby="source-directory-title">
    <div className="directory-caption"><h2 id="source-directory-title">网站目录</h2><span>{sites.size} 个网站 · {sources.length} 个栏目</span></div>
    {Array.from(sites, ([id, site]) => <DirectorySite key={id} name={site.name} count={`${site.columns.length} 个栏目`}
      totals={tones.filter(tone => site.counts[tone]).map(tone =>
        <span className={tone} key={tone}>{summaryLabels[tone]} {site.counts[tone]}</span>)}>
      {site.columns.map(({ source, status }) => {
        const Icon = statusIcons[status.tone];
        const prefix = site.name + ' · ';
        const name = source.name.startsWith(prefix) ? source.name.slice(prefix.length) : source.name;
        return <DirectoryEntry key={source.id} title={name}
          badge={<span className={`directory-badge ${status.tone}`}><Icon aria-hidden="true" />{status.label}</span>}>
          <ColumnDetails source={source} status={status} admin={admin} />
        </DirectoryEntry>;
      })}
    </DirectorySite>)}
  </section>;
}

function ColumnDetails({ source, status, admin }: { source: Source; status: SourceStatus; admin: boolean }) {
  const scheduled = source.enabled && source.siteEnabled && source.validationState === 'verified';
  const plannedAt = scheduled ? source.scheduledDiscoveryAt : null;
  return <div className="directory-detail">
    {source.error && <Alert variant="destructive"><AlertTitle>最近一次采集失败</AlertTitle><AlertDescription>{source.error}</AlertDescription></Alert>}
    <dl>
      <div><dt>{status.timeLabel}</dt><dd>{formatDateTime(source.lastRunAt)}</dd></div>
      {admin && <div><dt>刷新间隔</dt><dd>{refreshIntervalLabel(source.refreshIntervalSec)}</dd></div>}
      <div><dt>已存档</dt><dd>{source.articleCount} 条</dd></div>
      {plannedAt != null && plannedAt > 0
        ? <div><dt>本轮最早检查</dt><dd>{discoveryTimeLabel(plannedAt)}</dd></div>
        : admin && <div><dt>下次检查</dt><dd>{!source.maintenanceStateKnown ? '未知' : scheduled ? discoveryTimeLabel(source.nextDiscoveryAt) : '未安排'}</dd></div>}
    </dl>
    <a className="feed-plain-link" href={source.listUrl ?? source.url} target="_blank" rel="noreferrer">打开原栏目 <ExternalLink aria-hidden="true" /></a>
  </div>;
}
