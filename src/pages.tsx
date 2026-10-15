import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams, useRouteLoaderData } from 'react-router';
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
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileText,
  Search,
  UserRound,
} from 'lucide-react';
import {
  parseArticleList,
  parseSources,
  requestJson,
  type ArticleList,
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
  formatDateTime,
  formatPublicationDate,
  safeNext,
} from './components';
import { captureFeedEvent } from './telemetry';

type RequestState<T> =
  | { kind: 'loading' }
  | { kind: 'success'; data: T }
  | { kind: 'error'; message: string }
  | { kind: 'forbidden' }
  | { kind: 'unauthorized' }
  | { kind: 'not-found' };

type SourceState = RequestState<Source[]>;
type ArticleListState = RequestState<ArticleList>;

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
  const searchOperation = useRef<{
    id: string;
    attemptId: string;
    startedAt: number;
    hasQuery: boolean;
    hasSourceFilter: boolean;
    page: number;
  } | null>(null);

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
      if (!controller.signal.aborted) {
        setListState(fromResult(result));
        const operation = searchOperation.current;
        if (operation) {
          if (result.ok) {
            captureFeedEvent('feed_search_completed', {
              operation: 'search_filter',
              flow: 'reading',
              stage: 'result',
              outcome: 'success',
              operation_id: operation.id,
              attempt_id: operation.attemptId,
              result_count: result.data.total,
              zero_results: result.data.total === 0,
              has_query: operation.hasQuery,
              has_source_filter: operation.hasSourceFilter,
              page: result.data.page,
              duration_ms: Math.max(0, Math.round(performance.now() - operation.startedAt)),
              duration_basis: 'user_action_to_search_result',
            });
            searchOperation.current = null;
          } else {
            captureFeedEvent('feed_search_completed', {
              operation: 'search_filter',
              flow: 'reading',
              stage: 'result',
              outcome: 'failure',
              operation_id: operation.id,
              attempt_id: operation.attemptId,
              error_code: result.status === 0 ? 'network_failed' : `http_${result.status}`,
              has_query: operation.hasQuery,
              has_source_filter: operation.hasSourceFilter,
              page: operation.page,
              duration_ms: Math.max(0, Math.round(performance.now() - operation.startedAt)),
              duration_basis: 'user_action_to_search_result',
            });
          }
        }
      }
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
    if (params.toString() === search.toString()) setListReloadKey((key) => key + 1);
    else setParams(search, { replace: false });
    searchOperation.current = {
      id: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      startedAt: performance.now(),
      hasQuery: Boolean(nextQuery.trim()),
      hasSourceFilter: Boolean(nextSource),
      page: nextPage,
    };
  }

  function retrySearch() {
    searchOperation.current = searchOperation.current
      ? { ...searchOperation.current, attemptId: crypto.randomUUID() }
      : null;
    setListReloadKey((key) => key + 1);
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
          action={<RetryButton onClick={retrySearch} />}
        />
      )}
      {listState.kind === 'not-found' && (
        <PageState
          state="not-found"
          title="通知索引不可用"
          description="索引尚未就绪或链接已失效，请稍后重试。"
          action={<RetryButton onClick={retrySearch} />}
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
