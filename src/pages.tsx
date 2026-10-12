import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams, useRouteLoaderData } from 'react-router';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Input,
  Label,
  PageHeader,
  PageState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@cqu-moe/ui';
import {
  Archive,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  Search,
  UserRound,
} from 'lucide-react';
import {
  parseArticleDetail,
  parseArticleList,
  parseArticleRevisions,
  parseSources,
  requestJson,
  type ArticleDetailResponse,
  type ArticleList,
  type ArticleRevisionsResponse,
  type ArticleRevision,
  type Attachment,
  type RevisionRequirement,
  type Session,
  type SessionAccount,
  type AvailableSessionAccount,
  type Source,
} from './api';
import {
  AccessDeniedState,
  LoginRequiredState,
  RetryButton,
  StandaloneHeader,
  articleStatusLabel,
  attachmentStatusLabel,
  formatBytes,
  formatDateTime,
  formatPublicationDate,
  isPdf,
  safeNext,
} from './components';
import { OcrReading } from './ocr-reading';

type RequestState<T> =
  | { kind: 'loading' }
  | { kind: 'success'; data: T }
  | { kind: 'error'; message: string }
  | { kind: 'forbidden' }
  | { kind: 'unauthorized' }
  | { kind: 'not-found' };

type SourceState = RequestState<Source[]>;
type ArticleListState = RequestState<ArticleList>;
type DetailState = RequestState<ArticleDetailResponse>;
type RevisionListState = RequestState<ArticleRevisionsResponse>;

const revisionStates = new Map([
  ['ready', '完整版本'],
  ['assembling', '正在核对'],
  ['blocked', '缺项或失败'],
]);

const changeKinds = new Map([
  ['baseline', '首次存档'],
  ['substantive', '实质变化'],
  ['presentation_only', '排版变化'],
  ['unclassified', '待分类'],
]);

const requirementKinds = new Map([
  ['body', '统一正文'],
  ['snapshot', '原貌存档'],
  ['attachment', '附件'],
  ['body_pdf', '正文 PDF'],
  ['body_ocr', '正文识别'],
  ['screenshot', '截图'],
]);

const requirementStates = new Map([
  ['fulfilled', '已验证'],
  ['pending', '等待'],
  ['failed', '失败'],
]);

const requirementErrors = new Map([
  ['ocr_pending', '正文扫描页仍在识别中'],
  ['artifact_missing', '源站产物未保存成功'],
  ['attachment_missing', '附件未保存成功'],
]);

function revisionStateLabel(state: string): string {
  return revisionStates.get(state) ?? state;
}

function changeKindLabel(changeKind: string): string {
  return changeKinds.get(changeKind) ?? changeKind;
}

function requirementKindLabel(kind: string): string {
  return requirementKinds.get(kind) ?? kind;
}

function requirementStateLabel(state: string): string {
  return requirementStates.get(state) ?? state;
}

function requirementErrorLabel(error: string | null | undefined): string | null {
  if (!error) return null;
  return requirementErrors.get(error) ?? error;
}

function revisionStatusClass(state: string): string {
  if (['ready', 'complete', 'archived', 'success'].includes(state)) return 'is-ready';
  if (state === 'blocked') return 'is-blocked';
  return 'is-assembling';
}

function attachmentFilename(attachment: Attachment): string | null {
  const fromUrl = attachment.url?.match(/\/(?:files|reader)\/[^/]+\/(?:revisions\/[^/]+\/)?([^/?#]+\.pdf)$/i);
  return attachment.filename ?? fromUrl?.[1] ?? null;
}

function pdfReaderUrl(articleId: string, attachment: Attachment, revisionId?: string): string | null {
  if (!attachment.url) return null;
  const filename = attachmentFilename(attachment);
  if (revisionId && filename) {
    return `/reader/${encodeURIComponent(articleId)}/revisions/${encodeURIComponent(revisionId)}/${filename}`;
  }
  return attachment.url.replace('/api/files/', '/reader/');
}

function fromResult<T>(
  result: Awaited<ReturnType<typeof requestJson<T>>>,
): RequestState<T> {
  if (result.ok) return { kind: 'success', data: result.data };
  if (result.status === 403) return { kind: 'forbidden' };
  if (result.status === 401) return { kind: 'unauthorized' };
  if (result.status === 404) return { kind: 'not-found' };
  return { kind: 'error', message: result.message };
}

export function LoginPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));

  return (
    <div className="feed-standalone-page">
      <StandaloneHeader />
      <main className="feed-standalone-main">
        <div className="feed-standalone-card feed-login-card">
          <PageHeader
            title="登录重大通知存档"
            description="使用 auth.cqu.moe 统一账号登录，登录后继续访问校园通知存档。"
          />
          <div className="feed-login-actions">
            <Button asChild>
              <a href="/auth/login">
                <ExternalLink aria-hidden="true" />
                使用 auth.cqu.moe 登录
              </a>
            </Button>
            {next !== '/' && <p className="feed-login-next">登录后将返回 {next}</p>}
          </div>
          <p className="feed-login-note">访问内容还需要账号拥有 feed.access 权益。</p>
        </div>
      </main>
    </div>
  );
}

export function AccessPage() {
  return (
    <div className="feed-standalone-page">
      <StandaloneHeader />
      <main className="feed-standalone-main">
        <AccessDeniedState title="需要 feed.access 权益" />
      </main>
    </div>
  );
}

function subscriptionLimitLabel(account: AvailableSessionAccount) {
  const limit = account.subscriptionLimit;
  if (limit.kind === 'unlimited') return '无限';
  if (limit.kind === 'missing') return '未配置（按 0 个执行）';
  return `${limit.value} 个`;
}

function accountStateLabel(account: SessionAccount) {
  if (account.status !== 'available') {
    if (account.status === 'auth_unavailable') return 'Auth 暂不可用';
    if (account.reason === 'AUTH_DATA_INVALID') return '权益数据异常';
    if (account.reason === 'SUBJECT_UNAVAILABLE') return '用户当前不可用';
    if (account.reason === 'INVALID_CLIENT' || account.reason === 'CLIENT_NOT_ALLOWED') return '服务身份配置异常';
    return '账户状态暂不可用';
  }
  return account.access ? '订阅能力可用' : '缺少访问权益';
}

function accountEmailLabel(account: AvailableSessionAccount) {
  if (account.email.status === 'verified') return account.email.address;
  if (account.email.status === 'unverified') return '未验证（暂不投递邮件）';
  return '无访问权益（不显示邮箱）';
}

export function AccountPage() {
  const { session } = useRouteLoaderData('feed-root') as { session: Session };
  const account = session.account;
  const availableAccount = account?.status === 'available' ? account : undefined;
  const stateClass = availableAccount
    ? availableAccount.access
      ? 'is-ok'
      : 'is-error'
    : 'is-warning';

  return (
    <>
      <PageHeader
        title="账户与订阅"
        description="这里显示 Auth 当前授予的 Feed 访问能力、订阅额度和邮件投递状态。"
      />
      <article className="feed-card feed-account-card">
        <div className="feed-source-heading">
          <div>
            <h2>{session.user?.name ?? session.user?.email ?? '当前账号'}</h2>
            <p className="feed-account-note">
              订阅额度由 Auth 管理，可在“我的订阅”中选择栏目和投递方式。
            </p>
          </div>
          <span
            className={`feed-source-state ${stateClass}`}
          >
            {account ? accountStateLabel(account) : '账户状态暂不可用'}
          </span>
        </div>
        {availableAccount ? (
          <dl className="feed-source-meta feed-account-meta">
            <div>
              <dt>通知存档访问</dt>
              <dd>{availableAccount.access ? '已开通' : '未开通'}</dd>
            </div>
            <div>
              <dt>订阅额度</dt>
              <dd>{subscriptionLimitLabel(availableAccount)}</dd>
            </div>
            <div>
              <dt>邮件投递</dt>
              <dd>{accountEmailLabel(availableAccount)}</dd>
            </div>
          </dl>
        ) : (
          <Alert variant={account?.status === 'auth_unavailable' ? 'default' : 'destructive'}>
            <AlertTitle>{account?.status === 'auth_unavailable' ? 'Auth 暂不可用' : '暂时无法确认账户状态'}</AlertTitle>
            <AlertDescription>
              当前配置和已采集内容会保留；请在服务恢复后重新打开此页面，不会把本次故障当作撤权。
            </AlertDescription>
          </Alert>
        )}
      </article>
    </>
  );
}

export function ArticlesPage() {
  const [params, setParams] = useSearchParams();
  const committedQuery = params.get('q') ?? '';
  const committedSource = params.get('source') ?? '';
  const committedPage = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
  const [query, setQuery] = useState(committedQuery);
  const [sourceState, setSourceState] = useState<SourceState>({ kind: 'loading' });
  const [listState, setListState] = useState<ArticleListState>({ kind: 'loading' });
  const [sourceReloadKey, setSourceReloadKey] = useState(0);
  const [listReloadKey, setListReloadKey] = useState(0);

  useEffect(() => {
    setQuery(committedQuery);
  }, [committedQuery]);

  useEffect(() => {
    const controller = new AbortController();
    setSourceState({ kind: 'loading' });
    requestJson('/api/sources', parseSources, { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) setSourceState(fromResult(result));
    });
    return () => controller.abort();
  }, [sourceReloadKey]);

  useEffect(() => {
    const controller = new AbortController();
    setListState({ kind: 'loading' });
    const search = new URLSearchParams();
    if (committedQuery.trim()) search.set('q', committedQuery.trim());
    if (committedSource) search.set('source', committedSource);
    if (committedPage > 1) search.set('page', String(committedPage));
    const suffix = search.size > 0 ? `?${search.toString()}` : '';
    requestJson(`/api/articles${suffix}`, parseArticleList, { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) setListState(fromResult(result));
    });
    return () => controller.abort();
  }, [committedQuery, committedSource, committedPage, listReloadKey]);

  const sources = sourceState.kind === 'success' ? sourceState.data : [];
  const selectedSource = sources.find((source) => source.id === committedSource);

  function updateUrl(nextQuery: string, nextSource: string, nextPage = 1) {
    const search = new URLSearchParams();
    if (nextQuery.trim()) search.set('q', nextQuery.trim());
    if (nextSource) search.set('source', nextSource);
    if (nextPage > 1) search.set('page', String(nextPage));
    setParams(search, { replace: false });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    updateUrl(query, committedSource);
  }

  if (
    sourceState.kind === 'forbidden' ||
    sourceState.kind === 'unauthorized' ||
    listState.kind === 'forbidden' ||
    listState.kind === 'unauthorized'
  ) {
    if (sourceState.kind === 'unauthorized' || listState.kind === 'unauthorized') {
      return <LoginRequiredState />;
    }
    return <AccessDeniedState />;
  }

  return (
    <>
      <PageHeader
        title="重大通知存档"
        description="统一阅读已接入站点和栏目的通知，查看正文、附件与历史版本。"
      />

      <form className="feed-list-toolbar" role="search" onSubmit={submit}>
        <div className="feed-search-field">
          <Label htmlFor="feed-query">搜索通知</Label>
          <div className="feed-search-input">
            <Search aria-hidden="true" />
            <Input
              id="feed-query"
              name="q"
              type="search"
              placeholder="输入标题或正文关键词"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </div>
        <div className="feed-source-field">
          <Label htmlFor="feed-source">通知来源</Label>
          <Select
            value={committedSource || 'all'}
            onValueChange={(value) => updateUrl(committedQuery, value === 'all' ? '' : value)}
          >
            <SelectTrigger id="feed-source" aria-label="通知来源">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部来源</SelectItem>
              {sources.map((source) => (
                <SelectItem key={source.id} value={source.id}>
                  {source.name}
                </SelectItem>
              ))}
              {!selectedSource && committedSource && (
                <SelectItem value={committedSource}>当前筛选来源</SelectItem>
              )}
            </SelectContent>
          </Select>
        </div>
        <Button type="submit" className="feed-search-submit">
          <Search aria-hidden="true" />
          搜索
        </Button>
        {(committedQuery || committedSource) && (
          <Button
            type="button"
            variant="outline"
            className="feed-clear-button"
            onClick={() => {
              setQuery('');
              updateUrl('', '');
            }}
          >
            清除筛选
          </Button>
        )}
      </form>

      {sourceState.kind === 'error' && (
        <Alert variant="destructive" className="feed-source-alert">
          <AlertTitle>来源筛选加载失败</AlertTitle>
          <AlertDescription>
            通知列表仍可查看。{sourceState.message}
            <Button type="button" size="sm" variant="outline" onClick={() => setSourceReloadKey((key) => key + 1)}>
              重试来源
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {listState.kind === 'loading' && (
        <PageState state="loading" title="正在加载通知" description="正在读取通知索引，请稍候。" />
      )}
      {listState.kind === 'error' && (
        <PageState
          state="error"
          title="暂时无法加载通知"
          description={`${listState.message}筛选条件已保留，你可以重试。`}
          action={<RetryButton onClick={() => setListReloadKey((key) => key + 1)} />}
        />
      )}
      {listState.kind === 'not-found' && (
        <PageState
          state="not-found"
          title="通知索引不可用"
          description="索引尚未就绪或链接已失效，请稍后重试。"
          action={<RetryButton onClick={() => setListReloadKey((key) => key + 1)} />}
        />
      )}
      {listState.kind === 'success' && listState.data.articles.length === 0 && (
        <PageState
          state="empty"
          title={committedQuery || committedSource ? '没有找到匹配通知' : '还没有采集到通知'}
          description={
            committedQuery || committedSource
              ? '试试其他关键词，或清除当前来源筛选。'
              : '每日采集运行后，新通知会出现在这里。'
          }
          action={
            committedQuery || committedSource ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setQuery('');
                  updateUrl('', '');
                }}
              >
                清除筛选
              </Button>
            ) : undefined
          }
        />
      )}
      {listState.kind === 'success' && listState.data.articles.length > 0 && (
        <>
          <p className="feed-result-summary" aria-live="polite">
            共 {listState.data.total} 条通知 · 第 {listState.data.page} /{' '}
            {Math.max(1, Math.ceil(listState.data.total / listState.data.pageSize))} 页
          </p>
          <div className="feed-article-list">
            {listState.data.articles.map((article) => (
              <article className="feed-card feed-article-card" key={article.id}>
                <div className="feed-article-topline">
                  <span>{article.sourceName}</span>
                  <span className={`feed-status feed-article-status-${article.status.toLowerCase()}`}>
                    {articleStatusLabel(article.status)}
                  </span>
                </div>
                <h2>
                  <Link className="feed-article-title" to={`/articles/${article.id}`}>
                    {article.title}
                  </Link>
                </h2>
                <p className="feed-excerpt">{article.excerpt}</p>
                <dl className="feed-article-meta">
                  <div>
                    <dt>发布时间</dt>
                    <dd>{formatPublicationDate(article.publishedAt)}</dd>
                  </div>
                  <div>
                    <dt>采集时间</dt>
                    <dd>{article.capturedAt ? formatDateTime(article.capturedAt) : '待采集'}</dd>
                  </div>
                  <div>
                    <dt>附件</dt>
                    <dd>{article.attachmentCount} 个</dd>
                  </div>
                </dl>
                <div className="feed-card-actions">
                  <Button asChild variant="outline" size="sm">
                    <Link to={`/articles/${article.id}`}>
                      <FileText aria-hidden="true" />
                      统一阅读
                    </Link>
                  </Button>
                  <a className="feed-plain-link" href={article.url} target="_blank" rel="noreferrer">
                    原始通知
                    <ExternalLink aria-hidden="true" />
                  </a>
                </div>
              </article>
            ))}
          </div>
          <nav className="feed-pagination" aria-label="通知分页">
            <Button
              type="button"
              variant="outline"
              disabled={listState.data.page <= 1}
              onClick={() => updateUrl(committedQuery, committedSource, committedPage - 1)}
            >
              <ChevronLeft aria-hidden="true" />
              上一页
            </Button>
            <span aria-current="page">第 {listState.data.page} 页</span>
            <Button
              type="button"
              variant="outline"
              disabled={
                listState.data.page >= Math.max(1, Math.ceil(listState.data.total / listState.data.pageSize))
              }
              onClick={() => updateUrl(committedQuery, committedSource, committedPage + 1)}
            >
              下一页
              <ChevronRight aria-hidden="true" />
            </Button>
          </nav>
        </>
      )}
    </>
  );
}

export function ArticleDetailPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const selectedRevisionId = params.get('revision') ?? '';
  const [state, setState] = useState<DetailState>({ kind: 'loading' });
  const [revisionState, setRevisionState] = useState<RevisionListState>({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'loading' });
    const detailPath = selectedRevisionId
      ? `/api/articles/${encodeURIComponent(id)}/revisions/${encodeURIComponent(selectedRevisionId)}`
      : `/api/articles/${encodeURIComponent(id)}`;
    requestJson(detailPath, parseArticleDetail, {
      signal: controller.signal,
    }).then((result) => {
      if (!controller.signal.aborted) setState(fromResult(result));
    });
    return () => controller.abort();
  }, [id, selectedRevisionId, reloadKey]);

  useEffect(() => {
    const controller = new AbortController();
    setRevisionState({ kind: 'loading' });
    requestJson(`/api/articles/${encodeURIComponent(id)}/revisions`, parseArticleRevisions, {
      signal: controller.signal,
    }).then((result) => {
      if (!controller.signal.aborted) setRevisionState(fromResult(result));
    });
    return () => controller.abort();
  }, [id, reloadKey]);

  if (state.kind === 'forbidden') {
    return <AccessDeniedState title="这篇通知暂时无法访问" />;
  }
  if (state.kind === 'unauthorized') {
    return <LoginRequiredState />;
  }
  if (state.kind === 'loading') {
    return <PageState state="loading" title="正在加载通知" description="正在读取正文、附件和存档信息。" />;
  }
  if (state.kind === 'error') {
    return (
      <PageState
        state="error"
        title="暂时无法加载通知"
        description={`${state.message}请重试，已采集内容仍会保留。`}
        action={<RetryButton onClick={() => setReloadKey((key) => key + 1)} />}
      />
    );
  }
  if (state.kind === 'not-found') {
    return (
      <PageState
        state="not-found"
        title="未找到这篇通知"
        description="它可能尚未采集，或存档链接已发生变化。"
        action={
          <Button asChild variant="outline">
            <Link to="/">
              <ArrowLeft aria-hidden="true" />
              返回通知列表
            </Link>
          </Button>
        }
      />
    );
  }

  const { article, attachments, revision, requirements } = state.data;
  const revisions = revisionState.kind === 'success' ? revisionState.data.revisions : [];
  const currentRevisionId = revisions.filter((item) => item.state === 'ready')
    .sort((a, b) => b.revisionNo - a.revisionNo)[0]?.id
    ?? (!selectedRevisionId && revision?.state === 'ready' ? revision.id : undefined);
  const selectedRevision = selectedRevisionId
    ? revision ?? revisions.find((item) => item.id === selectedRevisionId)
    : undefined;
  const activeRevisionId = selectedRevisionId || currentRevisionId;
  const canReadRevision = !revision || revision.state === 'ready';
  const paragraphs = article.bodyText.replace(/\r\n/g, '\n').split(/\n{2,}/);
  const selectedRequirements = selectedRevision ? requirements ?? [] : [];

  function selectRevision(revisionId: string | null) {
    const next = new URLSearchParams(params);
    if (revisionId) next.set('revision', revisionId);
    else next.delete('revision');
    setParams(next, { replace: false });
  }

  return (
    <>
      <Link className="feed-back-link" to="/">
        <ArrowLeft aria-hidden="true" />
        返回通知列表
      </Link>
      <PageHeader
        title={article.title}
        description={`${article.sourceName} · 发布 ${formatPublicationDate(article.publishedAt)} · 采集 ${
          formatDateTime(selectedRevision?.observedAt ?? article.capturedAt)
        }`}
        actions={
          <span className={`feed-status feed-revision-status ${revisionStatusClass(revision?.state ?? article.status)}`}>
            {revision ? revisionStateLabel(revision.state) : articleStatusLabel(article.status)}
          </span>
        }
      />

      <section className="feed-detail-section feed-revision-section" aria-labelledby="feed-revisions-title">
        <div className="feed-revision-heading">
          <div>
            <h2 id="feed-revisions-title">版本时间线</h2>
            <p>每次观察独立保存。编号保留采集顺序，失败或缺项不会顶替当前完整阅读。</p>
          </div>
          {selectedRevisionId && (
            <Button type="button" variant="outline" onClick={() => selectRevision(null)}>
              返回最新完整版本
            </Button>
          )}
        </div>
        {revisionState.kind === 'loading' && (
          <p className="feed-revision-loading" role="status">正在读取版本历史…</p>
        )}
        {revisionState.kind === 'error' && (
          <Alert variant="destructive">
            <AlertTitle>版本历史加载失败</AlertTitle>
            <AlertDescription>
              当前内容仍可阅读。{revisionState.message}
              <Button type="button" size="sm" variant="outline" onClick={() => setReloadKey((key) => key + 1)}>
                重试版本
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {revisionState.kind === 'not-found' && (
          <p className="feed-revision-loading">这篇通知还没有版本时间线，将继续使用兼容阅读数据。</p>
        )}
        {revisionState.kind === 'success' && revisions.length === 0 && (
          <p className="feed-revision-loading">这篇通知还没有版本历史。</p>
        )}
        {revisions.length > 0 && (
          <ol className="feed-revision-list">
            {revisions.map((item) => {
              const active = item.id === activeRevisionId;
              return (
                <li key={item.id}>
                  <article className={`feed-revision-card ${active ? 'is-active' : ''}`}>
                    <div className="feed-revision-card-main">
                      <div className="feed-revision-topline">
                        <strong>版本 {item.revisionNo}</strong>
                        <span className={`feed-status feed-revision-status ${revisionStatusClass(item.state)}`}>
                          {revisionStateLabel(item.state)}
                        </span>
                        {item.id === currentRevisionId && <span className="feed-revision-current">当前完整阅读</span>}
                      </div>
                      <p>{formatDateTime(item.observedAt)} · {changeKindLabel(item.changeKind)}</p>
                      <p>
                        {item.state === 'ready'
                          ? `完整于 ${formatDateTime(item.readyAt)}`
                          : item.state === 'blocked'
                            ? `${item.missingCount} 个必需项未完成`
                            : '仍在归档核对中'}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant={active ? 'default' : 'outline'}
                      size="sm"
                      aria-pressed={active}
                      onClick={() => selectRevision(item.id === currentRevisionId ? null : item.id)}
                    >
                      {active ? '当前查看' : '查看版本'}
                    </Button>
                  </article>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {revision && !canReadRevision && (
        <Alert variant={revision.state === 'blocked' ? 'destructive' : 'default'} className="feed-revision-alert">
          <AlertTitle>{revisionStateLabel(revision.state)}的版本不能作为完整阅读</AlertTitle>
          <AlertDescription>
            这次观察只显示元数据和缺项原因。正文、附件链接和原貌入口会在全部必需产物验证后开放；默认阅读仍使用最新完整版本。
          </AlertDescription>
        </Alert>
      )}

      <div className="feed-detail-actions">
        <Button asChild variant="outline">
          <a href={article.url} target="_blank" rel="noreferrer">
            原始通知
            <ExternalLink aria-hidden="true" />
          </a>
        </Button>
        {canReadRevision && article.snapshotUrl && (
          <Button asChild>
            <a href={article.snapshotUrl} target="_blank" rel="noreferrer">
              <Archive aria-hidden="true" />
              原貌存档
            </a>
          </Button>
        )}
        {canReadRevision && article.screenshotUrl && (
          <Button asChild variant="outline">
            <a href={article.screenshotUrl} target="_blank" rel="noreferrer">
              <ExternalLink aria-hidden="true" />
              存档截图
            </a>
          </Button>
        )}
      </div>

      {canReadRevision && article.ocr?.pages.length ? (
        <OcrReading articleId={article.id} revisionId={revision?.id} ocr={article.ocr} />
      ) : <section className="feed-detail-section" aria-labelledby="feed-body-title">
        <h2 id="feed-body-title">统一阅读</h2>
        <div className="feed-article-body">
          {canReadRevision ? paragraphs.map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          )) : (
            <p className="feed-revision-empty">这个版本还没有可发布的完整正文。</p>
          )}
        </div>
      </section>}

      {selectedRevision && (
        <section className="feed-detail-section" aria-labelledby="feed-requirements-title">
          <h2 id="feed-requirements-title">版本产物</h2>
          <div className="feed-requirement-list">
            {selectedRequirements.length === 0 ? (
              <p className="feed-empty-detail">这个版本还没有可显示的产物清单。</p>
            ) : selectedRequirements.map((requirement) => (
              <RequirementRow key={requirement.slotKey} requirement={requirement} />
            ))}
          </div>
        </section>
      )}

      <section className="feed-detail-section" aria-labelledby="feed-attachments-title">
        <h2 id="feed-attachments-title">附件与 PDF</h2>
        {attachments.length === 0 ? (
          <p className="feed-empty-detail">这篇通知没有采集到附件。</p>
        ) : (
          <div className="feed-attachment-list">
            {attachments.map((attachment) => (
              <article className="feed-attachment" key={attachment.id}>
                <div className="feed-attachment-heading">
                  <div>
                    <h3>{attachment.name}</h3>
                    <p>
                      {formatBytes(attachment.bytes)}
                      {attachment.contentType ? ` · ${attachment.contentType}` : ''} ·{' '}
                      {attachmentStatusLabel(attachment.status)}
                    </p>
                    {attachment.error && <p className="feed-attachment-error">{attachment.error}</p>}
                  </div>
                  {attachment.downloadUrl && (
                    <Button asChild variant="outline" size="sm">
                      <a href={attachment.downloadUrl}>
                        <Download aria-hidden="true" />
                        下载
                      </a>
                    </Button>
                  )}
                </div>
                {canReadRevision && attachment.url && isPdf(attachment) && (
                  <iframe
                    className="feed-pdf-frame"
                    src={pdfReaderUrl(article.id, attachment, revision?.id) ?? attachment.url}
                    title={`${attachment.name} PDF 预览`}
                  >
                    <p>
                      当前浏览器不支持内嵌 PDF。请
                      <a href={attachment.url}>直接打开 PDF</a>。
                      {attachment.downloadUrl && (
                        <>
                          或<a href={attachment.downloadUrl}>下载附件</a>。
                        </>
                      )}
                    </p>
                  </iframe>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function RequirementRow({ requirement }: { requirement: RevisionRequirement }) {
  const failed = requirement.state === 'failed';
  return (
    <article className={`feed-requirement ${failed ? 'is-failed' : ''}`}>
      <div>
        <h3>{requirement.name ?? requirement.filename ?? requirementKindLabel(requirement.kind)}</h3>
        <p>
          {requirementKindLabel(requirement.kind)} · {requirement.required ? '必需' : '可选'} ·{' '}
          {requirementStateLabel(requirement.state)}
        </p>
        {requirement.errorCode && (
          <p className="feed-attachment-error">{requirementErrorLabel(requirement.errorCode)}</p>
        )}
      </div>
    </article>
  );
}

export function SourcesPage() {
  const [state, setState] = useState<SourceState>({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'loading' });
    requestJson('/api/sources', parseSources, { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) setState(fromResult(result));
    });
    return () => controller.abort();
  }, [reloadKey]);

  if (state.kind === 'forbidden') {
    return <AccessDeniedState />;
  }
  if (state.kind === 'unauthorized') {
    return <LoginRequiredState />;
  }

  return (
    <>
      <PageHeader title="采集状态" description="查看每个通知栏目最近一次云端采集和归档结果。"
        actions={<Button asChild variant="outline"><Link to="/admin/tasks">管理员入口</Link></Button>} />
      {state.kind === 'loading' && (
        <PageState state="loading" title="正在加载采集状态" description="正在读取各栏目最近运行结果。" />
      )}
      {state.kind === 'error' && (
        <PageState
          state="error"
          title="暂时无法加载采集状态"
          description={`${state.message}请稍后重试。`}
          action={<RetryButton onClick={() => setReloadKey((key) => key + 1)} />}
        />
      )}
      {state.kind === 'not-found' && (
        <PageState
          state="not-found"
          title="采集状态不可用"
          description="请稍后重试。"
          action={<RetryButton onClick={() => setReloadKey((key) => key + 1)} />}
        />
      )}
      {state.kind === 'success' && state.data.length === 0 && (
        <PageState state="empty" title="还没有配置栏目" description="首批栏目接入后会显示采集状态。" />
      )}
      {state.kind === 'success' && state.data.length > 0 && (
        <div className="feed-source-grid">
          {state.data.map((source) => (
            <article className="feed-card feed-source-card" key={source.id}>
              <div className="feed-source-heading">
                <div>
                  <h2>{source.name}</h2>
                  <a href={source.url} target="_blank" rel="noreferrer">
                    栏目首页
                    <ExternalLink aria-hidden="true" />
                  </a>
                </div>
                <span className={`feed-source-state ${source.error ? 'is-error' : 'is-ok'}`}>
                  {source.error ? '最近有错误' : '运行正常'}
                </span>
              </div>
              <dl className="feed-source-meta">
                <div>
                  <dt>已存档通知</dt>
                  <dd>{source.articleCount}</dd>
                </div>
                <div>
                  <dt>最近采集</dt>
                  <dd>{formatDateTime(source.lastRunAt)}</dd>
                </div>
              </dl>
              {source.error && (
                <Alert variant="destructive">
                  <AlertTitle>最近一次采集失败</AlertTitle>
                  <AlertDescription>{source.error}</AlertDescription>
                </Alert>
              )}
            </article>
          ))}
        </div>
      )}
    </>
  );
}
