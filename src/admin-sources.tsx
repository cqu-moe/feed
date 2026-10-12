import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  ContentContainer,
  Input,
  Label,
  PageHeader,
  PageState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@cqu-moe/ui';
import { ExternalLink, Plus, RefreshCw } from 'lucide-react';
import { StandaloneHeader } from './components';

type JsonRecord = Record<string, unknown>;

type Site = {
  id: string;
  name: string;
  origin: string;
  enabled: boolean;
};

type Source = {
  id: string;
  siteId: string;
  name: string;
  listUrl: string;
  config: {
    articlePattern: string;
    sampleArticleUrl?: string;
  };
  configVersion: number;
  enabled: boolean;
  siteEnabled: boolean;
  refreshIntervalSec: number;
  nextDiscoveryAt: number | null;
  baselineCutoffAt: string | null;
  validationState: string;
  validationJson: JsonRecord | null;
  validatedAt: number | null;
  validationTaskId: string | null;
  timezone: string;
  articleCount: number;
  error: string | null;
};

type SourceForm = {
  siteId: string;
  name: string;
  listUrl: string;
  articlePattern: string;
  sampleArticleUrl: string;
  refreshMinutes: string;
  timezone: string;
};

type SiteForm = {
  name: string;
  origin: string;
};

class AdminRequestError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(detail || `HTTP ${status}`);
    this.status = status;
    this.detail = detail;
  }
}

const sourceDefaults = {
  articlePattern: '^/info/\\d+/\\d+\\.htm$',
  timezone: 'Asia/Shanghai',
};
const supportedTimeZones = Intl.supportedValuesOf('timeZone');

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label}接口结构不匹配。`);
  return value;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function integerValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function parseSite(value: unknown): Site {
  if (!isRecord(value)) throw new Error('站点接口结构不匹配。');
  return {
    id: requiredString(value.id, '站点'),
    name: requiredString(value.name, '站点'),
    origin: requiredString(value.origin, '站点'),
    enabled: booleanValue(value.enabled),
  };
}

function parseSites(value: unknown): Site[] {
  if (!isRecord(value) || !Array.isArray(value.sites)) throw new Error('站点列表结构不匹配。');
  return value.sites.map(parseSite);
}

function parseSiteResponse(value: unknown): Site {
  if (!isRecord(value) || !isRecord(value.site)) throw new Error('站点保存结果结构不匹配。');
  return parseSite(value.site);
}

function parseSource(value: unknown): Source {
  if (!isRecord(value)) throw new Error('栏目接口结构不匹配。');
  const config = isRecord(value.config) ? value.config : {};
  const articlePattern = typeof config.articlePattern === 'string' ? config.articlePattern : '';
  return {
    id: requiredString(value.id, '栏目'),
    siteId: typeof value.siteId === 'string' ? value.siteId : '',
    name: requiredString(value.name, '栏目'),
    listUrl: requiredString(value.listUrl ?? value.url, '栏目'),
    config: {
      articlePattern,
      ...(typeof config.sampleArticleUrl === 'string' ? { sampleArticleUrl: config.sampleArticleUrl } : {}),
    },
    configVersion: integerValue(value.configVersion) ?? 1,
    enabled: booleanValue(value.enabled),
    siteEnabled: value.siteEnabled === undefined ? true : booleanValue(value.siteEnabled),
    refreshIntervalSec: integerValue(value.refreshIntervalSec) ?? 86400,
    nextDiscoveryAt: integerValue(value.nextDiscoveryAt),
    baselineCutoffAt: typeof value.baselineCutoffAt === 'string' ? value.baselineCutoffAt : null,
    validationState: typeof value.validationState === 'string' ? value.validationState : 'unknown',
    validationJson: isRecord(value.validationJson) ? value.validationJson : null,
    validatedAt: integerValue(value.validatedAt),
    validationTaskId: typeof value.validationTaskId === 'string' ? value.validationTaskId : null,
    timezone: typeof value.timezone === 'string' ? value.timezone : 'Asia/Shanghai',
    articleCount: integerValue(value.articleCount) ?? 0,
    error: typeof value.error === 'string' && value.error ? value.error : null,
  };
}

function parseSources(value: unknown): Source[] {
  if (!isRecord(value) || !Array.isArray(value.sources)) throw new Error('栏目列表结构不匹配。');
  return value.sources.map(parseSource);
}

function parseSourceResponse(value: unknown): Source {
  if (!isRecord(value) || !isRecord(value.source)) throw new Error('栏目保存结果结构不匹配。');
  return parseSource(value.source);
}

function parseVerification(value: unknown): { source: Source; taskId: string } {
  if (!isRecord(value) || !isRecord(value.source) || !isRecord(value.task)) {
    throw new Error('服务端任务确认结果结构不匹配。');
  }
  return { source: parseSource(value.source), taskId: requiredString(value.task.id, '验证任务') };
}

function parseValidationTask(value: unknown): { state: string; error: string | null } {
  if (!isRecord(value) || !isRecord(value.task)) throw new Error('验证任务状态结构不匹配。');
  return { state: requiredString(value.task.state, '验证任务'), error: typeof value.task.lastError === 'string' ? value.task.lastError : null };
}

function responseDetail(value: unknown): string {
  if (!isRecord(value)) return '';
  for (const key of ['error', 'message']) {
    const detail = value[key];
    if (typeof detail === 'string' && detail) return detail;
  }
  if (value.details !== undefined) {
    try {
      const detail = JSON.stringify(value.details);
      if (detail && detail !== '{}') return detail;
    } catch {
      return '';
    }
  }
  return '';
}

async function adminJson<T>(
  path: string,
  token: string,
  validate: (value: unknown) => T,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...init?.headers,
      },
    });
  } catch {
    throw new Error('网络连接失败，操作结果未确认。');
  }

  let value: unknown = null;
  try {
    value = await response.json();
  } catch {
    if (!response.ok) throw new AdminRequestError(response.status, '');
    throw new Error('接口返回的不是有效 JSON。');
  }
  if (!response.ok) throw new AdminRequestError(response.status, responseDetail(value));
  return validate(value);
}

function emptySiteForm(): SiteForm {
  return { name: '', origin: '' };
}

function sourceForm(source: Source): SourceForm {
  return {
    siteId: source.siteId,
    name: source.name,
    listUrl: source.listUrl,
    articlePattern: source.config.articlePattern,
    sampleArticleUrl: source.config.sampleArticleUrl ?? source.listUrl,
    refreshMinutes: String(Math.round(source.refreshIntervalSec / 60)),
    timezone: source.timezone || sourceDefaults.timezone,
  };
}

function newSourceForm(sites: Site[]): SourceForm {
  return {
    siteId: sites[0]?.id ?? '',
    name: '',
    listUrl: '',
    articlePattern: sourceDefaults.articlePattern,
    sampleArticleUrl: '',
    refreshMinutes: '1440',
    timezone: sourceDefaults.timezone,
  };
}

function sameSourceForm(left: SourceForm, right: SourceForm): boolean {
  return left.siteId === right.siteId
    && left.name.trim() === right.name.trim()
    && left.listUrl.trim() === right.listUrl.trim()
    && left.articlePattern.trim() === right.articlePattern.trim()
    && left.sampleArticleUrl.trim() === right.sampleArticleUrl.trim()
    && left.refreshMinutes.trim() === right.refreshMinutes.trim()
    && left.timezone === right.timezone;
}

function requiredText(value: string, label: string, max: number): string {
  const text = value.trim();
  if (!text) throw new Error(`请填写${label}。`);
  if (text.length > max) throw new Error(`${label}不能超过 ${max} 个字符。`);
  return text;
}

function httpsUrl(value: string, label: string): URL {
  const text = value.trim();
  if (!text || text.length > 2000) throw new Error(`${label}必须是 HTTPS URL。`);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${label}必须是 HTTPS URL。`);
  }
  if (url.protocol !== 'https:' || !url.hostname.includes('.')) throw new Error(`${label}必须是 HTTPS URL。`);
  return url;
}

function siteOrigin(value: string): URL {
  const url = httpsUrl(value, '站点 Origin');
  if (url.pathname !== '/' || url.search) throw new Error('站点 Origin 只能填写域名首页，不能包含路径或查询参数。');
  return url;
}

function validateSourceForm(form: SourceForm, sites: Site[]): JsonRecord {
  const siteId = form.siteId.trim();
  if (!siteId) throw new Error('请选择所属站点。');
  const site = sites.find(item => item.id === siteId);
  if (!site) throw new Error('所属站点不存在，请刷新后重新选择。');
  const name = requiredText(form.name, '栏目名称', 80);
  const listUrl = httpsUrl(form.listUrl, '栏目列表 URL');
  const siteUrl = httpsUrl(site.origin, '所属站点 Origin');
  const articlePattern = requiredText(form.articlePattern, '文章路径正则', 500);
  const sampleArticleUrl = httpsUrl(form.sampleArticleUrl, '样本通知 URL');
  const minutes = Number(form.refreshMinutes.trim());
  if (!Number.isSafeInteger(minutes) || minutes < 30 || minutes > 10080) {
    throw new Error('刷新间隔必须在 30 到 10080 分钟之间。');
  }
  if (!supportedTimeZones.includes(form.timezone)) throw new Error('请填写系统支持的 IANA 时区。');

  let pattern: RegExp;
  try {
    pattern = new RegExp(articlePattern);
  } catch {
    throw new Error('文章路径正则不能被浏览器解析。');
  }
  if (sampleArticleUrl.origin !== listUrl.origin) throw new Error('列表 URL 和样本通知 URL 必须使用同一站点 Origin。');
  if (listUrl.origin !== siteUrl.origin) throw new Error('栏目列表 URL 必须使用所属站点 Origin。');
  if (!pattern.test(sampleArticleUrl.pathname)) throw new Error('样本通知路径必须匹配文章路径正则。');

  return {
    siteId,
    name,
    listUrl: listUrl.href,
    articlePattern,
    sampleArticleUrl: sampleArticleUrl.href,
    refreshIntervalSec: minutes * 60,
    timezone: form.timezone,
  };
}

function timestampLabel(value: number | null): string {
  if (value === null) return '未记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间无效';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai' }).format(date);
}

function yesNo(value: unknown): string {
  return value === true ? '通过' : '未确认';
}

function sourceStateLabel(source: Source): string {
  if (!source.siteEnabled) return '站点已暂停';
  if (!source.enabled) return source.validationState === 'verified' ? '已验证，未启用' : '未启用';
  return source.validationState === 'verified' ? '定时发现中' : '配置待验证';
}

function sourceStateClass(source: Source): string {
  if (!source.siteEnabled || !source.enabled) return 'is-warning';
  return source.validationState === 'verified' ? 'is-ok' : 'is-warning';
}

function validationLabel(state: string): string {
  if (state === 'verified') return '服务端已验证';
  if (state === 'failed') return '验证失败';
  if (state === 'draft') return '等待验证';
  return state || '未知状态';
}

function evidenceValue(source: Source, key: string): unknown {
  return source.validationJson?.[key];
}

function sourceSiteName(source: Source, sites: Site[]): string {
  if (!source.siteId) return '未关联新站点模型';
  return sites.find(site => site.id === source.siteId)?.name ?? `站点 ID ${source.siteId}`;
}

function safeFieldId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-');
}

export function AdminSourcesPage() {
  // The operator token and every draft stay in component memory only.
  const [credential, setCredential] = useState('');
  const [token, setToken] = useState('');
  const [sites, setSites] = useState<Site[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [siteForm, setSiteForm] = useState<SiteForm>(emptySiteForm);
  const [sourceDraft, setSourceDraft] = useState<SourceForm>(newSourceForm([]));
  const [createDraft, setCreateDraft] = useState<SourceForm>(newSourceForm([]));
  const [draftTouched, setDraftTouched] = useState(false);
  const [editingSiteId, setEditingSiteId] = useState<string | null>(null);
  const [siteNameDraft, setSiteNameDraft] = useState('');
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [errorDetail, setErrorDetail] = useState('');
  const [notice, setNotice] = useState('');
  const [validationStatus, setValidationStatus] = useState('');
  const verificationIntent = useRef<{ sourceId: string; configVersion: number; requestId: string } | null>(null);
  const siteCreationIntent = useRef<{ name: string; origin: string; requestId: string } | null>(null);

  const selectedSource = sources.find(source => source.id === selectedSourceId) ?? null;
  const selectedOriginal = selectedSource ? sourceForm(selectedSource) : null;
  const sourceDirty = selectedOriginal !== null && !sameSourceForm(sourceDraft, selectedOriginal);
  const selectedSite = sites.find(site => site.id === editingSiteId) ?? null;
  const siteDirty = selectedSite !== null && siteNameDraft.trim() !== selectedSite.name;

  useEffect(() => {
    setValidationStatus('');
    const sourceId = selectedSource?.id;
    const taskId = selectedSource?.validationTaskId;
    if (!token || !sourceId || !taskId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const [source, task] = await Promise.all([
          adminJson(`/internal/sources/${encodeURIComponent(sourceId!)}`, token, parseSourceResponse),
          adminJson(`/internal/capture-tasks/${encodeURIComponent(taskId!)}`, token, parseValidationTask),
        ]);
        if (cancelled) return;
        setSources(prior => prior.map(item => item.id === source.id ? source : item));
        const labels: Record<string, string> = {
          queued: '验证任务已保存，等待执行。', starting: '验证任务正在启动。', running: '服务端正在验证样本。',
          deferred: '验证已延期，系统会在到期后重试。', blocked: '验证需要管理员处理。',
          failed: '验证未完成，可以检查配置后重新验证。', cancelled: '验证任务已取消。',
          succeeded: source.validationState === 'verified' ? '样本验证通过，可以启用栏目。' : '此任务已结束，请检查当前配置的验证状态。',
        };
        setValidationStatus([labels[task.state] ?? task.state, task.error].filter(Boolean).join(' '));
        if (['queued', 'starting', 'running', 'deferred'].includes(task.state)) timer = setTimeout(poll, 3000);
      } catch (cause) {
        if (cancelled) return;
        if (cause instanceof AdminRequestError && cause.status === 401) {
          setToken(''); setCredential(''); setSources([]); setSites([]);
          setError('管理员凭据已失效，请重新输入。');
        } else {
          setValidationStatus('验证进度暂时无法读取，系统中的任务会继续执行。');
          timer = setTimeout(poll, 5000);
        }
      }
    }
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [token, selectedSource?.id, selectedSource?.validationTaskId]);

  function reportError(cause: unknown) {
    if (cause instanceof AdminRequestError && cause.status === 401) {
      setToken('');
      setCredential('');
      setSites([]);
      setSources([]);
      setSelectedSourceId(null);
      setEditingSiteId(null);
      setError('管理员凭据无效或已失效，请重新输入。');
      setErrorDetail(cause.detail);
      return;
    }
    if (cause instanceof AdminRequestError) {
      setError(`请求失败（HTTP ${cause.status}）。`);
      setErrorDetail(cause.detail);
      return;
    }
    setError(cause instanceof Error ? cause.message : '操作未确认，请稍后重试。');
    setErrorDetail('');
  }

  async function run(step: string, work: () => Promise<void>) {
    if (busy) return;
    setBusy(step);
    setError('');
    setErrorDetail('');
    setNotice('');
    try {
      await work();
    } catch (cause) {
      reportError(cause);
    } finally {
      setBusy('');
    }
  }

  async function loadLists(operatorToken: string, resetDraft = false): Promise<[Site[], Source[]]> {
    const [nextSites, nextSources] = await Promise.all([
      adminJson('/internal/sites', operatorToken, parseSites),
      adminJson('/internal/sources', operatorToken, parseSources),
    ]);
    setSites(nextSites);
    setSources(nextSources);
    const nextSelected = nextSources.find(source => source.id === selectedSourceId) ?? null;
    setSelectedSourceId(nextSelected?.id ?? null);
    if (nextSelected && (resetDraft || !draftTouched || !sourceDirty)) {
      setSourceDraft(sourceForm(nextSelected));
      setDraftTouched(false);
    }
    const nextEditingSite = nextSites.find(site => site.id === editingSiteId) ?? null;
    setEditingSiteId(nextEditingSite?.id ?? null);
    if (nextEditingSite) setSiteNameDraft(nextEditingSite.name);
    if (!selectedSourceId && !draftTouched && !nextSites.some(site => site.id === sourceDraft.siteId)) {
      setSourceDraft(form => ({ ...form, siteId: nextSites[0]?.id ?? '' }));
    }
    return [nextSites, nextSources];
  }

  function connect(event: FormEvent) {
    event.preventDefault();
    void run('connect', async () => {
      const [nextSites] = await loadLists(credential, true);
      setSourceDraft(newSourceForm(nextSites));
      setCreateDraft(newSourceForm(nextSites));
      setToken(credential);
      setCredential('');
      setNotice('已连接管理接口。');
    });
  }

  function disconnect() {
    verificationIntent.current = null;
    siteCreationIntent.current = null;
    setValidationStatus('');
    setToken('');
    setCredential('');
    setSites([]);
    setSources([]);
    setSiteForm(emptySiteForm());
    setSourceDraft(newSourceForm([]));
    setCreateDraft(newSourceForm([]));
    setDraftTouched(false);
    setEditingSiteId(null);
    setSelectedSourceId(null);
    setError('');
    setErrorDetail('');
    setNotice('');
  }

  function replaceSource(next: Source) {
    setSources(prior => prior.map(source => source.id === next.id ? next : source));
    setSelectedSourceId(next.id);
    setSourceDraft(sourceForm(next));
    setDraftTouched(false);
  }

  function createSite(event: FormEvent) {
    event.preventDefault();
    void run('create-site', async () => {
      const payload = {
        name: requiredText(siteForm.name, '站点名称', 80),
        origin: siteOrigin(siteForm.origin).href,
      };
      if (siteCreationIntent.current?.name !== payload.name || siteCreationIntent.current.origin !== payload.origin) {
        siteCreationIntent.current = { ...payload, requestId: crypto.randomUUID() };
      }
      const site = await adminJson('/internal/sites', token, parseSiteResponse, {
        method: 'POST',
        body: JSON.stringify(siteCreationIntent.current),
      });
      siteCreationIntent.current = null;
      setSiteForm(emptySiteForm());
      setSites(prior => [...prior.filter(item => item.id !== site.id), site]);
      setCreateDraft(form => ({ ...form, siteId: form.siteId || site.id }));
      setNotice(`站点已保存：${site.name}。现在可以创建它的栏目。`);
    });
  }

  function saveSite(site: Site) {
    void run(`save-site:${site.id}`, async () => {
      const name = requiredText(siteNameDraft, '站点名称', 80);
      const next = await adminJson(`/internal/sites/${encodeURIComponent(site.id)}`, token, parseSiteResponse, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      });
      setSites(prior => prior.map(item => item.id === next.id ? next : item));
      setEditingSiteId(next.id);
      setSiteNameDraft(next.name);
      setNotice('站点名称已保存。');
    });
  }

  function toggleSite(site: Site) {
    void run(`toggle-site:${site.id}`, async () => {
      const next = await adminJson(`/internal/sites/${encodeURIComponent(site.id)}`, token, parseSiteResponse, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !site.enabled }),
      });
      setSites(prior => prior.map(item => item.id === next.id ? next : item));
      setSources(prior => prior.map(source => source.siteId === next.id
        ? { ...source, siteEnabled: next.enabled }
        : source));
      setNotice(next.enabled ? '站点已恢复，到期栏目会继续调度。' : '站点已暂停，其栏目不会新增调度。');
    });
  }

  function createSource(event: FormEvent) {
    event.preventDefault();
    void run('create-source', async () => {
      const payload = validateSourceForm(createDraft, sites);
      const source = await adminJson('/internal/sources', token, parseSourceResponse, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      await loadLists(token, true);
      replaceSource(source);
      setCreateDraft(newSourceForm(sites));
      setNotice('栏目配置已保存为草稿。请先执行服务端样本验证，再单独启用。');
    });
  }

  function saveSource() {
    if (!selectedSource) return;
    void run(`save-source:${selectedSource.id}`, async () => {
      const payload = validateSourceForm(sourceDraft, sites);
      const next = await adminJson(`/internal/sources/${encodeURIComponent(selectedSource.id)}`, token, parseSourceResponse, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      replaceSource(next);
      setNotice(next.validationState === 'verified'
        ? '配置已保存；服务端仍返回已验证状态，请复核样本结果后再启用。'
        : '配置已保存为新的待验证版本。');
    });
  }

  function verifySource() {
    if (!selectedSource || sourceDirty) return;
    void run(`verify-source:${selectedSource.id}`, async () => {
      if (verificationIntent.current?.sourceId !== selectedSource.id || verificationIntent.current.configVersion !== selectedSource.configVersion) {
        verificationIntent.current = { sourceId: selectedSource.id, configVersion: selectedSource.configVersion, requestId: crypto.randomUUID() };
      }
      const result = await adminJson(
        `/internal/sources/${encodeURIComponent(selectedSource.id)}/verify`, token, parseVerification,
        { method: 'POST', body: JSON.stringify({ requestId: verificationIntent.current.requestId }) },
      );
      replaceSource(result.source);
      verificationIntent.current = null;
      setNotice('验证任务已保存，离开页面后仍会继续。验证通过后再启用栏目。');
    });
  }

  function toggleSource(enabled: boolean) {
    if (!selectedSource) return;
    if (enabled && selectedSource.validationState !== 'verified') return;
    void run(`toggle-source:${selectedSource.id}`, async () => {
      const next = await adminJson(`/internal/sources/${encodeURIComponent(selectedSource.id)}`, token, parseSourceResponse, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      });
      replaceSource(next);
      setNotice(enabled ? '栏目已启用；只有站点和栏目都启用且验证通过时才会调度。' : '栏目已暂停，已保存内容仍可读取。');
    });
  }

  return <div className="feed-standalone-page">
    <StandaloneHeader actions={token ? (
      <Button asChild variant="outline" size="sm" disabled={busy !== ''}>
        <Link to="/admin/tasks">采集任务</Link>
      </Button>
    ) : undefined} />
    <ContentContainer width="standard">
      <div className="feed-admin-content">
        <PageHeader
          title="来源配置管理"
          description="维护站点与栏目；配置保存后先由服务端验证列表、分页、正文和附件样本，再单独启用。"
          actions={token ? <>
            <Button type="button" variant="outline" disabled={busy !== ''} onClick={() => void run('refresh', async () => { await loadLists(token); })}>
              <RefreshCw aria-hidden="true" />刷新
            </Button>
            <Button type="button" variant="outline" disabled={busy !== ''} onClick={disconnect}>退出管理</Button>
          </> : undefined}
        />
        {error && (
          <Alert variant="destructive">
            <AlertTitle>操作未完成</AlertTitle>
            <AlertDescription>
              {error}
              {errorDetail && <span className="feed-admin-error-detail">接口返回：{errorDetail}</span>}
            </AlertDescription>
          </Alert>
        )}
        {notice && <p role="status">{notice}</p>}

        {!token ? (
          <form className="feed-card feed-admin-form" onSubmit={connect}>
            <Label htmlFor="sources-admin-token">管理员凭据</Label>
            <Input
              id="sources-admin-token"
              type="password"
              autoComplete="off"
              value={credential}
              onChange={event => setCredential(event.target.value)}
              required
              disabled={busy !== ''}
            />
            <p className="feed-admin-note">凭据仅在本页内存中暂存，不写入地址栏或浏览器存储；退出后立即清除。</p>
            <Button type="submit" disabled={busy !== '' || !credential}>{busy ? '正在验证…' : '进入管理'}</Button>
          </form>
        ) : busy === 'connect' || busy === 'refresh' ? (
          <PageState state="loading" title="正在读取配置" description="正在读取站点和栏目，请稍候。" />
        ) : (
          <Tabs defaultValue="sources" className="feed-admin-tabs">
            <TabsList aria-label="配置对象">
              <TabsTrigger value="sources">栏目</TabsTrigger>
              <TabsTrigger value="sites">站点</TabsTrigger>
            </TabsList>

            <TabsContent value="sources">
              <section className="feed-card feed-admin-editor" aria-label="新增栏目">
                <div className="feed-admin-section-heading">
                  <h2>新增栏目</h2>
                  <p>必填项与服务端解析一致：所属站点、名称、列表 URL、文章路径正则、样本通知 URL、刷新间隔和时区。</p>
                </div>
                <SourceFields
                  idPrefix="new-source"
                  form={createDraft}
                  sites={sites}
                  disabled={busy !== ''}
                  onChange={next => setCreateDraft(next)}
                />
                <div className="feed-card-actions">
                  <Button type="button" onClick={createSource} disabled={busy !== '' || sites.length === 0}>
                    <Plus aria-hidden="true" />保存栏目草稿
                  </Button>
                </div>
                {sites.length === 0 && <p className="feed-admin-note">请先在“站点”中创建 HTTPS 站点。</p>}
              </section>

              <section aria-label="栏目配置列表" className="feed-admin-list">
                <h2>栏目</h2>
                {sources.length === 0 ? (
                  <PageState state="empty" title="还没有栏目" description="保存首个栏目草稿后，在这里验证和启用。" />
                ) : <div className="feed-admin-source-list">{sources.map(source => (
                  <article className="feed-card feed-source-card" key={source.id}>
                    <div className="feed-source-heading">
                      <div>
                        <h3>{source.name}</h3>
                        <a href={source.listUrl} target="_blank" rel="noreferrer">
                          栏目列表<ExternalLink aria-hidden="true" />
                        </a>
                      </div>
                      <span className={`feed-source-state ${sourceStateClass(source)}`}>{sourceStateLabel(source)}</span>
                    </div>
                    <dl className="feed-source-meta">
                      <div><dt>站点</dt><dd>{sourceSiteName(source, sites)}</dd></div>
                      <div><dt>配置版本</dt><dd>v{source.configVersion}</dd></div>
                      <div><dt>刷新间隔</dt><dd>{Math.round(source.refreshIntervalSec / 60)} 分钟</dd></div>
                      <div><dt>样本验证</dt><dd>{validationLabel(source.validationState)}</dd></div>
                      <div><dt>下次发现</dt><dd>{source.enabled ? timestampLabel(source.nextDiscoveryAt) : '暂停'}</dd></div>
                      <div><dt>已关联通知</dt><dd>{source.articleCount}</dd></div>
                    </dl>
                    {source.error && <p role="status" className="feed-admin-server-error">{source.error}</p>}
                    <div className="feed-card-actions">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          setSelectedSourceId(source.id);
                          setSourceDraft(sourceForm(source));
                          setDraftTouched(false);
                          setNotice('');
                        }}
                        aria-pressed={selectedSourceId === source.id}
                        disabled={busy !== ''}
                      >
                        管理配置
                      </Button>
                    </div>
                  </article>
                ))}</div>}
              </section>

              {selectedSource && selectedOriginal && (
                <section className="feed-card feed-admin-editor" aria-label="栏目配置编辑">
                  <div className="feed-admin-section-heading">
                    <h2>编辑：{selectedSource.name}</h2>
                    <p className="feed-admin-id">栏目 ID：{selectedSource.id}</p>
                  </div>
                  <SourceFields
                    idPrefix={`source-${safeFieldId(selectedSource.id)}`}
                    form={sourceDraft}
                    sites={sites}
                    unknownSiteId={selectedSource.siteId}
                    disabled={busy !== ''}
                    onChange={next => {
                      setSourceDraft(next);
                      setDraftTouched(true);
                    }}
                  />
                  {validationStatus && <p role="status">{validationStatus}</p>}
                  <div className="feed-card-actions">
                    <Button type="button" onClick={saveSource} disabled={busy !== '' || !sourceDirty || selectedSource.enabled}>
                      保存配置版本
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={verifySource}
                      disabled={busy !== '' || selectedSource.enabled || sourceDirty}
                    >
                      {selectedSource.validationState === 'verified' ? '复查服务端样本' : '执行服务端验证'}
                    </Button>
                    {selectedSource.enabled ? (
                      <Button type="button" variant="outline" onClick={() => toggleSource(false)} disabled={busy !== ''}>
                        暂停栏目
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        onClick={() => toggleSource(true)}
                        disabled={busy !== '' || selectedSource.validationState !== 'verified'}
                      >
                        启用栏目
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setSourceDraft(selectedOriginal);
                        setDraftTouched(false);
                      }}
                      disabled={busy !== '' || !sourceDirty}
                    >
                      撤销未保存修改
                    </Button>
                  </div>
                  {selectedSource.enabled && sourceDirty && (
                    <p className="feed-admin-note">修改配置前请先暂停栏目；暂停不会影响已保存通知。</p>
                  )}
                  {!selectedSource.enabled && selectedSource.validationState !== 'verified' && (
                    <p className="feed-admin-note">样本验证通过后才能启用栏目。</p>
                  )}

                  <div className="feed-admin-evidence">
                    <h3>服务端验证结果</h3>
                    <dl className="feed-source-meta">
                      <div><dt>状态</dt><dd>{validationLabel(selectedSource.validationState)}</dd></div>
                      <div><dt>验证时间</dt><dd>{timestampLabel(selectedSource.validatedAt)}</dd></div>
                      <div><dt>列表页数</dt><dd>{typeof evidenceValue(selectedSource, 'listPages') === 'number' ? String(evidenceValue(selectedSource, 'listPages')) : '未返回'}</dd></div>
                      <div><dt>分页</dt><dd>{yesNo(evidenceValue(selectedSource, 'paginationVerified'))}</dd></div>
                      <div><dt>正文样本</dt><dd>{yesNo(evidenceValue(selectedSource, 'articleBody'))}</dd></div>
                      <div><dt>附件样本</dt><dd>{yesNo(evidenceValue(selectedSource, 'attachmentSample'))}</dd></div>
                      <div><dt>原貌样本</dt><dd>{yesNo(evidenceValue(selectedSource, 'snapshotSample'))}</dd></div>
                      <div><dt>历史基线</dt><dd>{selectedSource.baselineCutoffAt ?? '未记录'}</dd></div>
                    </dl>
                    {typeof evidenceValue(selectedSource, 'error') === 'string' && (
                      <p role="status" className="feed-admin-server-error">服务端失败原因：{String(evidenceValue(selectedSource, 'error'))}</p>
                    )}
                    {typeof evidenceValue(selectedSource, 'bodyTextSha256') === 'string' && (
                      <p className="feed-admin-id">正文样本 SHA-256：{String(evidenceValue(selectedSource, 'bodyTextSha256'))}</p>
                    )}
                  </div>
                </section>
              )}
            </TabsContent>

            <TabsContent value="sites">
              <section className="feed-card feed-admin-editor" aria-label="新增站点">
                <div className="feed-admin-section-heading">
                  <h2>新增站点</h2>
                  <p>站点 Origin 必须是 HTTPS 域名首页；创建后用于约束栏目列表和样本通知。</p>
                </div>
                <form className="feed-admin-fields" onSubmit={createSite}>
                  <div className="feed-admin-field">
                    <Label htmlFor="new-site-name">站点名称</Label>
                    <Input
                      id="new-site-name"
                      value={siteForm.name}
                      onChange={event => setSiteForm({ ...siteForm, name: event.target.value })}
                      maxLength={80}
                      required
                      disabled={busy !== ''}
                    />
                  </div>
                  <div className="feed-admin-field">
                    <Label htmlFor="new-site-origin">站点 Origin</Label>
                    <Input
                      id="new-site-origin"
                      type="url"
                      inputMode="url"
                      placeholder="https://example.edu.cn"
                      value={siteForm.origin}
                      onChange={event => setSiteForm({ ...siteForm, origin: event.target.value })}
                      maxLength={2000}
                      required
                      disabled={busy !== ''}
                    />
                  </div>
                  <div className="feed-card-actions">
                    <Button type="submit" disabled={busy !== ''}><Plus aria-hidden="true" />保存站点</Button>
                  </div>
                </form>
              </section>

              <section aria-label="站点列表" className="feed-admin-list">
                <h2>站点</h2>
                {sites.length === 0 ? (
                  <PageState state="empty" title="还没有站点" description="先保存一个 HTTPS 站点，再创建栏目。" />
                ) : <div className="feed-admin-source-list">{sites.map(site => (
                  <article className="feed-card feed-source-card" key={site.id}>
                    <div className="feed-source-heading">
                      <div>
                        <h3>{site.name}</h3>
                        <a href={site.origin} target="_blank" rel="noreferrer">
                          {new URL(site.origin).hostname}<ExternalLink aria-hidden="true" />
                        </a>
                      </div>
                      <span className={`feed-source-state ${site.enabled ? 'is-ok' : 'is-warning'}`}>
                        {site.enabled ? '运行中' : '已暂停'}
                      </span>
                    </div>
                    <p className="feed-admin-id">站点 ID：{site.id}</p>
                    {editingSiteId === site.id ? (
                      <form className="feed-admin-inline-form" onSubmit={event => {
                        event.preventDefault();
                        saveSite(site);
                      }}>
                        <Label htmlFor={`site-name-${site.id}`}>站点名称</Label>
                        <Input
                          id={`site-name-${site.id}`}
                          value={siteNameDraft}
                          onChange={event => setSiteNameDraft(event.target.value)}
                          maxLength={80}
                          required
                          disabled={busy !== ''}
                        />
                        <div className="feed-card-actions">
                          <Button type="submit" disabled={busy !== '' || !siteDirty}>保存名称</Button>
                          <Button type="button" variant="ghost" onClick={() => setEditingSiteId(null)} disabled={busy !== ''}>取消</Button>
                        </div>
                      </form>
                    ) : <div className="feed-card-actions">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          setEditingSiteId(site.id);
                          setSiteNameDraft(site.name);
                        }}
                        disabled={busy !== ''}
                      >
                        编辑名称
                      </Button>
                      <Button type="button" variant="outline" onClick={() => toggleSite(site)} disabled={busy !== ''}>
                        {site.enabled ? '暂停站点' : '恢复站点'}
                      </Button>
                    </div>}
                  </article>
                ))}</div>}
              </section>
            </TabsContent>
          </Tabs>
        )}
      </div>
    </ContentContainer>
  </div>;
}

function SourceFields({
  idPrefix,
  form,
  sites,
  unknownSiteId,
  disabled,
  onChange,
}: {
  idPrefix: string;
  form: SourceForm;
  sites: Site[];
  unknownSiteId?: string;
  disabled: boolean;
  onChange: (form: SourceForm) => void;
}) {
  const knownSite = sites.some(site => site.id === form.siteId);
  return <div className="feed-admin-fields">
    <div className="feed-admin-field">
      <Label htmlFor={`${idPrefix}-site`}>所属站点</Label>
      {sites.length === 0 ? (
        <Input id={`${idPrefix}-site`} value="" placeholder="先创建站点" disabled />
      ) : <Select
        value={form.siteId}
        onValueChange={siteId => onChange({ ...form, siteId })}
      >
        <SelectTrigger id={`${idPrefix}-site`} disabled={disabled}>
          <SelectValue placeholder="选择站点" />
        </SelectTrigger>
        <SelectContent>
          {sites.map(site => <SelectItem value={site.id} key={site.id}>{site.name} · {new URL(site.origin).hostname}</SelectItem>)}
          {!knownSite && unknownSiteId && <SelectItem value={unknownSiteId}>原站点 ID {unknownSiteId}</SelectItem>}
        </SelectContent>
      </Select>}
    </div>
    <div className="feed-admin-field">
      <Label htmlFor={`${idPrefix}-name`}>栏目名称</Label>
      <Input
        id={`${idPrefix}-name`}
        value={form.name}
        onChange={event => onChange({ ...form, name: event.target.value })}
        maxLength={80}
        required
        disabled={disabled}
      />
    </div>
    <div className="feed-admin-field feed-admin-field-wide">
      <Label htmlFor={`${idPrefix}-list-url`}>栏目列表 URL</Label>
      <Input
        id={`${idPrefix}-list-url`}
        type="url"
        inputMode="url"
        value={form.listUrl}
        onChange={event => onChange({ ...form, listUrl: event.target.value })}
        maxLength={2000}
        required
        disabled={disabled}
      />
    </div>
    <div className="feed-admin-field feed-admin-field-wide">
      <Label htmlFor={`${idPrefix}-pattern`}>文章路径正则</Label>
      <Textarea
        id={`${idPrefix}-pattern`}
        value={form.articlePattern}
        onChange={event => onChange({ ...form, articlePattern: event.target.value })}
        maxLength={500}
        rows={2}
        required
        disabled={disabled}
      />
      <p className="feed-admin-note">仅用于匹配同站文章路径；最终以服务端解析和样本验证为准。</p>
    </div>
    <div className="feed-admin-field feed-admin-field-wide">
      <Label htmlFor={`${idPrefix}-sample-url`}>样本通知 URL</Label>
      <Input
        id={`${idPrefix}-sample-url`}
        type="url"
        inputMode="url"
        value={form.sampleArticleUrl}
        onChange={event => onChange({ ...form, sampleArticleUrl: event.target.value })}
        maxLength={2000}
        required
        disabled={disabled}
      />
      <p className="feed-admin-note">服务端会用这个样本检查正文、附件/原貌和分页；页面不提供“已验证”勾选。</p>
    </div>
    <div className="feed-admin-field">
      <Label htmlFor={`${idPrefix}-refresh`}>刷新间隔（分钟）</Label>
      <Input
        id={`${idPrefix}-refresh`}
        type="number"
        inputMode="numeric"
        min={30}
        max={10080}
        step={1}
        value={form.refreshMinutes}
        onChange={event => onChange({ ...form, refreshMinutes: event.target.value })}
        required
        disabled={disabled}
      />
    </div>
    <div className="feed-admin-field">
      <Label htmlFor={`${idPrefix}-timezone`}>来源时区</Label>
      <Input
        id={`${idPrefix}-timezone`}
        value={form.timezone}
        onChange={event => onChange({ ...form, timezone: event.target.value })}
        list="feed-source-timezones"
        required
        disabled={disabled}
      />
      <datalist id="feed-source-timezones">
        {supportedTimeZones.map(timezone => <option value={timezone} key={timezone} />)}
      </datalist>
    </div>
  </div>;
}
