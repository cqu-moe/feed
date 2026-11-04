import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
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
import { ChevronLeft, ChevronRight, Paperclip, Search, X } from 'lucide-react';
import {
  parseArticleList,
  parseSources,
  requestJson,
  type ArticleListItem,
  type ArticleList,
  type Source,
} from './api';
import {
  AccessDeniedState,
  LoginRequiredState,
  RetryButton,
  formatPublicationDate,
} from './components';
import { captureFeedEvent } from './telemetry';
import './notices.css';

type RequestState<T> =
  | { kind: 'loading' }
  | { kind: 'success'; data: T }
  | { kind: 'error'; message: string }
  | { kind: 'forbidden' }
  | { kind: 'unauthorized' }
  | { kind: 'not-found' };

type SourceState = RequestState<Source[]>;
type ArticleListState = RequestState<ArticleList>;

const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function fromResult<T>(
  result: Awaited<ReturnType<typeof requestJson<T>>>,
): RequestState<T> {
  if (result.ok) return { kind: 'success', data: result.data };
  if (result.status === 403) return { kind: 'forbidden' };
  if (result.status === 401) return { kind: 'unauthorized' };
  if (result.status === 404) return { kind: 'not-found' };
  return { kind: 'error', message: result.message };
}

function noticeDate(article: ArticleListItem): { value: string | null; label: string } {
  if (article.publishedAt) {
    return { value: article.publishedAt, label: formatPublicationDate(article.publishedAt) };
  }
  if (article.capturedAt) {
    return {
      value: article.capturedAt,
      label: `采集于 ${formatPublicationDate(article.capturedAt)}`,
    };
  }
  return { value: null, label: '时间未记录' };
}

function dateRangeLabel(from: string, to: string): string {
  if (from && to) return `${from} 至 ${to}`;
  if (from) return `${from} 起`;
  return `${to} 前`;
}

export function ArticlesPage() {
  const [params, setParams] = useSearchParams();
  const committedQuery = params.get('q') ?? '';
  const committedSite = params.get('site') ?? '';
  const committedSource = params.get('source') ?? '';
  const committedFrom = params.get('from') ?? '';
  const committedTo = params.get('to') ?? '';
  const committedPage = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
  const [query, setQuery] = useState(committedQuery);
  const [site, setSite] = useState(committedSite);
  const [source, setSource] = useState(committedSource);
  const [from, setFrom] = useState(committedFrom);
  const [to, setTo] = useState(committedTo);
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
    setSite(committedSite);
    setSource(committedSource);
    setFrom(committedFrom);
    setTo(committedTo);
  }, [committedQuery, committedSite, committedSource, committedFrom, committedTo]);

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
    if (committedSite) search.set('site', committedSite);
    if (committedSource) search.set('source', committedSource);
    if (committedFrom) search.set('from', committedFrom);
    if (committedTo) search.set('to', committedTo);
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
  }, [committedQuery, committedSite, committedSource, committedFrom, committedTo, committedPage, listReloadKey]);

  const sources = sourceState.kind === 'success' ? sourceState.data : [];
  const committedSiteSource = sources.find((item) => item.siteId === committedSite);
  const committedSelectedSource = sources.find((item) => item.id === committedSource);
  const draftSelectedSource = sources.find((item) => item.id === source);
  const sourceBelongsToSite = draftSelectedSource?.siteId === site;
  const visibleSources = sources.filter((item) => !site || item.siteId === site);

  function canonicalSearch(
    nextQuery: string,
    nextSource: string,
    nextSite: string,
    nextFrom: string,
    nextTo: string,
    nextPage = 1,
  ) {
    const search = new URLSearchParams();
    if (nextQuery.trim()) search.set('q', nextQuery.trim());
    if (nextSite) search.set('site', nextSite);
    if (nextSource) search.set('source', nextSource);
    if (nextFrom) search.set('from', nextFrom);
    if (nextTo) search.set('to', nextTo);
    if (nextPage > 1) search.set('page', String(nextPage));
    return search;
  }

  function updatePage(nextPage: number) {
    const search = canonicalSearch(
      committedQuery,
      committedSource,
      committedSite,
      committedFrom,
      committedTo,
      nextPage,
    );
    setParams(search, { replace: false });
    searchOperation.current = {
      id: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      startedAt: performance.now(),
      hasQuery: Boolean(committedQuery.trim()),
      hasSourceFilter: Boolean(committedSource),
      page: nextPage,
    };
  }

  function retrySearch() {
    searchOperation.current = searchOperation.current
      ? { ...searchOperation.current, attemptId: crypto.randomUUID() }
      : null;
    setListReloadKey((key) => key + 1);
  }

  function clearFilters() {
    setQuery('');
    setSite('');
    setSource('');
    setFrom('');
    setTo('');
    if (params.size > 0) setParams(new URLSearchParams(), { replace: false });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const nextFrom = from.match(ISO_DAY_PATTERN) ? from : '';
    const nextTo = to.match(ISO_DAY_PATTERN) ? to : '';
    if (from !== nextFrom) setFrom('');
    if (to !== nextTo) setTo('');
    const nextQuery = query.trim();
    const nextSource = sourceBelongsToSite || !site ? source : '';
    if (nextSource !== source) setSource(nextSource);
    const nextSearch = canonicalSearch(nextQuery, nextSource, site, nextFrom, nextTo);
    if (params.toString() === nextSearch.toString()) return;
    searchOperation.current = { id: crypto.randomUUID(), attemptId: crypto.randomUUID(),
      startedAt: performance.now(), hasQuery: Boolean(nextQuery), hasSourceFilter: Boolean(nextSource), page: 1 };
    setParams(nextSearch, { replace: false });
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

  const hasFilters = Boolean(
    committedQuery || committedSite || committedSource || committedFrom || committedTo,
  );
  const relatedResults = listState.kind === 'success' && listState.data.searchKind === 'related';

  return (
    <>
      <PageHeader
        title="重大通知存档"
        description="集中浏览、搜索与回看已接入站点和栏目的校园通知。"
      />

      <form className="notice-tools" role="search" onSubmit={submit}>
        <div className="notice-search">
          <Label className="notice-sr-only" htmlFor="notice-query">
            搜索通知
          </Label>
          <Search aria-hidden="true" />
          <Input
            id="notice-query"
            name="q"
            type="search"
            placeholder="搜索通知标题或内容"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </div>
        <div className="notice-site">
          <Label className="notice-sr-only" htmlFor="notice-site">
            发布站点
          </Label>
          <Select
            value={site || 'all'}
            onValueChange={(value) => {
              const nextSite = value === 'all' ? '' : value;
              setSite(nextSite);
              if (nextSite && draftSelectedSource?.siteId !== nextSite) setSource('');
            }}
          >
            <SelectTrigger id="notice-site" className="notice-site-trigger" aria-label="按发布站点筛选">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部站点</SelectItem>
              {[...new Map(sources.map((source) => [source.siteId, source])).values()].map((source) => (
                <SelectItem key={source.siteId} value={source.siteId}>
                  {source.siteName || source.siteId}
                </SelectItem>
              ))}
              {!sources.some((item) => item.siteId === site) && site && (
                <SelectItem value={site}>当前筛选站点</SelectItem>
              )}
            </SelectContent>
          </Select>
        </div>
        <div className="notice-source">
          <Label className="notice-sr-only" htmlFor="notice-source">
            通知来源
          </Label>
          <Select
            value={source || 'all'}
            onValueChange={(value) => {
              setSource(value === 'all' ? '' : value);
            }}
          >
            <SelectTrigger id="notice-source" className="notice-source-trigger" aria-label="按来源筛选">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部来源</SelectItem>
              {visibleSources.map((source) => (
                <SelectItem key={source.id} value={source.id}>
                  {source.name}
                </SelectItem>
              ))}
              {!visibleSources.some((item) => item.id === source) && source && (
                <SelectItem value={source}>当前筛选来源</SelectItem>
              )}
            </SelectContent>
          </Select>
        </div>
        <div className="notice-date-range">
          <Label className="notice-sr-only" htmlFor="notice-from">
            发布开始日期
          </Label>
          <Input
            id="notice-from"
            name="from"
            type="date"
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
            }}
          />
          <span aria-hidden="true">至</span>
          <Label className="notice-sr-only" htmlFor="notice-to">
            发布结束日期
          </Label>
          <Input
            id="notice-to"
            name="to"
            type="date"
            value={to}
            onChange={(event) => {
              setTo(event.target.value);
            }}
          />
        </div>
        <Button type="submit">
          <Search aria-hidden="true" />
          搜索
        </Button>
      </form>

      {sourceState.kind === 'error' && (
        <Alert variant="destructive" className="notice-source-alert">
          <AlertTitle>来源筛选加载失败</AlertTitle>
          <AlertDescription>
            通知列表仍可查看。{sourceState.message}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setSourceReloadKey((key) => key + 1)}
            >
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
          action={<><RetryButton onClick={retrySearch} />{committedQuery &&
            <Button variant="outline" onClick={() => setParams(canonicalSearch('', committedSource, committedSite, committedFrom, committedTo))}>按当前条件浏览</Button>}</>}
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
          title={hasFilters ? '没有找到匹配通知' : '还没有采集到通知'}
          description={
            hasFilters
                  ? '试试其他关键词，或调整筛选条件。'
              : '每日采集运行后，新通知会出现在这里。'
          }
          action={hasFilters ? <Button variant="outline" onClick={clearFilters}>清除筛选</Button> : undefined}
        />
      )}
      {listState.kind === 'success' && listState.data.articles.length > 0 && (
        <>
          <div className="notice-result-meta" aria-live="polite">
            <span aria-current="page">
              {relatedResults
                ? `相关通知 ${listState.data.total} 条`
                : `共 ${listState.data.total} 条通知`}
              {committedQuery ? ` · “${committedQuery}”` : ''}
              {committedSiteSource ? ` · ${committedSiteSource.siteName || committedSiteSource.siteId}` : ''}
              {committedSelectedSource ? ` · ${committedSelectedSource.name}` : ''}
              {committedFrom || committedTo ? ` · ${dateRangeLabel(committedFrom, committedTo)}` : ''}
            </span>
            {hasFilters ? (
              <Button type="button" variant="ghost" onClick={clearFilters}>
                <X aria-hidden="true" />
                清除筛选
              </Button>
            ) : (
              <span>按发布时间排列</span>
            )}
          </div>

          <div className="feed-article-list notice-list" data-feed-sensitive>
            {listState.data.articles.map((article) => {
              const date = noticeDate(article);
              return (
                <article className="notice-row" key={article.id}>
                  <div className="notice-main">
                    <p className="notice-kicker">
                      <span>{article.sourceName}</span>
                      {date.value ? (
                        <time dateTime={date.value}>{date.label}</time>
                      ) : (
                        <span>{date.label}</span>
                      )}
                    </p>
                    <h2>
                      <Link className="notice-title" to={`/articles/${article.id}`}>
                        {article.title}
                      </Link>
                    </h2>
                    {article.match && (
                      <p className="notice-match">
                        {article.match.href ? (
                          <Link to={article.match.href}>{article.match.label}</Link>
                        ) : (
                          article.match.label
                        )}
                      </p>
                    )}
                    {article.excerpt && <p className="notice-excerpt">{article.excerpt}</p>}
                  </div>
                  <div className="notice-end">
                    {article.attachmentCount > 0 && (
                      <span aria-label={`${article.attachmentCount} 个附件`}>
                        <Paperclip aria-hidden="true" />
                        {article.attachmentCount}
                      </span>
                    )}
                    <Button asChild variant="ghost" size="icon">
                      <Link to={`/articles/${article.id}`} aria-label="统一阅读">
                        <ChevronRight aria-hidden="true" />
                      </Link>
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>

          {!relatedResults && (
            <nav className="notice-pagination" aria-label="通知分页">
              <span>
                第 {listState.data.page} /{' '}
                {Math.max(1, Math.ceil(listState.data.total / listState.data.pageSize))} 页
              </span>
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="上一页"
                  disabled={listState.data.page <= 1}
                onClick={() => updatePage(committedPage - 1)}
                >
                  <ChevronLeft aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="下一页"
                  disabled={
                    listState.data.page >=
                    Math.max(1, Math.ceil(listState.data.total / listState.data.pageSize))
                  }
                  onClick={() => updatePage(committedPage + 1)}
                >
                  <ChevronRight aria-hidden="true" />
                </Button>
              </div>
            </nav>
          )}
        </>
      )}
    </>
  );
}
