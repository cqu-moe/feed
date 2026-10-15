import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  PageHeader,
  PageState,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@cqu-moe/ui';
import { Archive, ArrowLeft, ExternalLink, FileText, History } from 'lucide-react';
import {
  parseArticleDetail,
  parseArticleRevisions,
  requestJson,
  type ArticleDetailResponse,
  type ArticleRevisionsResponse,
  type Attachment,
  type RevisionRequirement,
} from './api';
import {
  AccessDeniedState,
  LoginRequiredState,
  RetryButton,
  articleStatusLabel,
  formatBytes,
  formatDateTime,
  formatPublicationDate,
  isPdf,
} from './components';
import { OcrReading } from './ocr-reading';
import { captureFeedEvent } from './telemetry';

type RequestState<T> =
  | { kind: 'loading' }
  | { kind: 'success'; data: T }
  | { kind: 'error'; message: string }
  | { kind: 'forbidden' }
  | { kind: 'unauthorized' }
  | { kind: 'not-found' };

type DetailState = RequestState<ArticleDetailResponse>;
type RevisionListState = RequestState<ArticleRevisionsResponse>;
type DetailPanel = null | 'history' | 'archive';

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

function requirementTitle(requirement: RevisionRequirement): string {
  return requirement.name ?? requirement.filename ?? requirementKindLabel(requirement.kind);
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

function attachmentFormat(attachment: Attachment): string {
  const extension = attachment.name.match(/\.([a-z0-9]+)$/i)?.[1];
  return extension?.toUpperCase() ?? attachment.contentType ?? '未知格式';
}

function readingParagraphs(value: string): string[] {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/附件【[^\n】]*】已下载\s*(?:\d+)?次/g, '')
    .replace(/^(?:上一条|下一条)[：:][^\n]*$/gm, '')
    .split(/\n{2,}/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean);
}

export function ArticleDetailPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const selectedRevisionId = params.get('revision') ?? '';
  const [state, setState] = useState<DetailState>({ kind: 'loading' });
  const [revisionState, setRevisionState] = useState<RevisionListState>({ kind: 'loading' });
  const [openPanel, setOpenPanel] = useState<DetailPanel>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const openOperation = useRef<{
    key: string;
    id: string;
    attemptId: string;
    startedAt: number;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'loading' });
    const operationKey = `${id}\0${selectedRevisionId}`;
    const previous = openOperation.current;
    openOperation.current = previous?.key === operationKey
      ? { ...previous, attemptId: crypto.randomUUID(), startedAt: performance.now() }
      : { key: operationKey, id: crypto.randomUUID(), attemptId: crypto.randomUUID(), startedAt: performance.now() };
    const detailPath = selectedRevisionId
      ? `/api/articles/${encodeURIComponent(id)}/revisions/${encodeURIComponent(selectedRevisionId)}`
      : `/api/articles/${encodeURIComponent(id)}`;
    requestJson(detailPath, parseArticleDetail, {
      signal: controller.signal,
    }).then((result) => {
      if (!controller.signal.aborted) {
        setState(fromResult(result));
        const operation = openOperation.current;
        if (result.ok && operation && (!result.data.revision || result.data.revision.state === 'ready')) {
          captureFeedEvent('feed_item_opened', {
            operation: 'article_read',
            flow: 'reading',
            stage: 'opened',
            outcome: 'success',
            operation_id: operation.id,
            attempt_id: operation.attemptId,
            article_id: result.data.article.id,
            revision_id: result.data.revision?.id ?? null,
            content_kind: 'article',
            ocr_used: Boolean(result.data.article.ocr?.pages.length),
            revision_state: result.data.revision?.state ?? 'ready',
            duration_ms: Math.max(0, Math.round(performance.now() - operation.startedAt)),
            duration_basis: 'content_request_to_readable_response',
          });
          openOperation.current = null;
        }
      }
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

  if (state.kind === 'forbidden') return <AccessDeniedState title="这篇通知暂时无法访问" />;
  if (state.kind === 'unauthorized') return <LoginRequiredState />;
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
  const paragraphs = readingParagraphs(article.bodyText);

  function selectRevision(revisionId: string | null) {
    const next = new URLSearchParams(params);
    if (revisionId) next.set('revision', revisionId);
    else next.delete('revision');
    setParams(next, { replace: false });
  }

  return (
    <article className="feed-reading-page">
      <Link className="feed-back-link" to="/">
        <ArrowLeft aria-hidden="true" />
        返回通知列表
      </Link>
      <header className="feed-reading-header">
        <PageHeader
          title={article.title}
          description={`${article.sourceName} · 发布 ${formatPublicationDate(article.publishedAt)}`}
        />
        <a className="feed-reading-source" href={article.url} target="_blank" rel="noreferrer">
          查看原网页
          <ExternalLink aria-hidden="true" />
        </a>
      </header>
      <nav className="feed-reading-toolbar" aria-label="通知操作">
        {attachments.length > 0 && (
          <a className="feed-text-action" href="#notice-attachments">
            附件 {attachments.length}
          </a>
        )}
        <div className="feed-reading-actions">
          {selectedRevisionId && (
            <Button type="button" variant="outline" size="sm" onClick={() => selectRevision(null)}>
              返回最新完整版本
            </Button>
          )}
          <Button type="button" variant="ghost" size="sm" data-detail-panel="history" onClick={() => setOpenPanel('history')}>
            <History aria-hidden="true" />
            历史版本
          </Button>
          <Button type="button" variant="ghost" size="sm" data-detail-panel="archive" onClick={() => setOpenPanel('archive')}>
            <Archive aria-hidden="true" />
            存档信息
          </Button>
        </div>
      </nav>

      {revision && !canReadRevision && (
        <Alert variant={revision.state === 'blocked' ? 'destructive' : 'default'} className="feed-revision-alert">
          <AlertTitle>{revisionStateLabel(revision.state)}的版本不能作为完整阅读</AlertTitle>
          <AlertDescription>
            这次观察只显示元数据和缺项原因。正文、附件链接和原貌入口会在全部必需产物验证后开放。
          </AlertDescription>
        </Alert>
      )}

      <ArticleBody
        article={article}
        canRead={canReadRevision}
        paragraphs={paragraphs}
        articleId={article.id}
        revisionId={revision?.id}
      />
      <AttachmentList
        attachments={attachments}
        canRead={canReadRevision}
        articleId={article.id}
        revisionId={revision?.id}
      />
      <HistorySheet
        open={openPanel === 'history'}
        onOpenChange={(open) => {
          if (!open) setOpenPanel(null);
        }}
        state={revisionState}
        revisions={revisions}
        activeRevisionId={activeRevisionId}
        currentRevisionId={currentRevisionId}
        onSelect={(revisionId) => {
          selectRevision(revisionId);
          setOpenPanel(null);
        }}
        onRetry={() => setReloadKey((key) => key + 1)}
      />
      <ArchiveSheet
        open={openPanel === 'archive'}
        onOpenChange={(open) => {
          if (!open) setOpenPanel(null);
        }}
        article={article}
        revision={revision ?? selectedRevision}
        canRead={canReadRevision}
        requirements={selectedRevision ? requirements ?? [] : []}
      />
    </article>
  );
}

function HistorySheet({
  open,
  onOpenChange,
  state,
  revisions,
  activeRevisionId,
  currentRevisionId,
  onSelect,
  onRetry,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: RevisionListState;
  revisions: ArticleRevisionsResponse['revisions'];
  activeRevisionId?: string;
  currentRevisionId?: string;
  onSelect: (revisionId: string | null) => void;
  onRetry: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="feed-detail-sheet"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          document.querySelector<HTMLButtonElement>('[data-detail-panel="history"]')?.focus();
        }}
      >
        <SheetHeader>
          <SheetTitle>历史版本</SheetTitle>
          <SheetDescription>按存档时间查看通知的不同完整版本。</SheetDescription>
        </SheetHeader>
        <div className="feed-detail-sheet-body">
          {state.kind === 'loading' && <p role="status">正在读取版本历史…</p>}
          {state.kind === 'error' && (
            <Alert variant="destructive">
              <AlertTitle>版本历史加载失败</AlertTitle>
              <AlertDescription>
                当前内容仍可阅读。{state.message}
                <Button type="button" size="sm" variant="outline" onClick={onRetry}>
                  重试版本
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {state.kind === 'not-found' && <p>这篇通知还没有版本时间线，将继续使用兼容阅读数据。</p>}
          {state.kind === 'success' && revisions.length === 0 && <p>这篇通知还没有版本历史。</p>}
          {revisions.length > 0 && (
            <ol className="feed-history-list">
              {revisions.map((item) => {
                const active = item.id === activeRevisionId;
                return (
                  <li key={item.id}>
                    <div>
                      <strong>版本 {item.revisionNo}</strong>
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
                      disabled={item.state !== 'ready'}
                      onClick={() => onSelect(item.id === currentRevisionId ? null : item.id)}
                    >
                      {active ? '当前查看' : '查看版本'}
                    </Button>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ArchiveSheet({
  open,
  onOpenChange,
  article,
  revision,
  canRead,
  requirements,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  article: ArticleDetailResponse['article'];
  revision?: ArticleRevisionsResponse['revisions'][number];
  canRead: boolean;
  requirements: ArticleDetailResponse['requirements'];
}) {
  const requirementRows = requirements ?? [];
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="feed-detail-sheet"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          document.querySelector<HTMLButtonElement>('[data-detail-panel="archive"]')?.focus();
        }}
      >
        <SheetHeader>
          <SheetTitle>存档信息</SheetTitle>
          <SheetDescription>核对这篇通知的来源、采集时间和归档产物。</SheetDescription>
        </SheetHeader>
        <div className="feed-detail-sheet-body">
          <dl className="feed-archive-facts">
            <div>
              <dt>来源</dt>
              <dd>{article.sourceName}</dd>
            </div>
            <div>
              <dt>发布时间</dt>
              <dd>{formatPublicationDate(article.publishedAt)}</dd>
            </div>
            <div>
              <dt>存档时间</dt>
              <dd>{formatDateTime(revision?.observedAt ?? article.capturedAt)}</dd>
            </div>
          </dl>
          <div className="feed-archive-links">
            <Button asChild variant="outline">
              <a href={article.url} target="_blank" rel="noreferrer">
                <ExternalLink aria-hidden="true" />
                原始通知
              </a>
            </Button>
            {canRead && article.snapshotUrl && (
              <Button asChild variant="outline">
                <a href={article.snapshotUrl} target="_blank" rel="noreferrer">
                  <Archive aria-hidden="true" />
                  原貌存档
                </a>
              </Button>
            )}
            {canRead && article.screenshotUrl && (
              <Button asChild variant="outline">
                <a href={article.screenshotUrl} target="_blank" rel="noreferrer">
                  <ExternalLink aria-hidden="true" />
                  网页截图
                </a>
              </Button>
            )}
          </div>
          {requirementRows.length > 0 && (
            <section aria-labelledby="feed-requirements-title">
              <h3 id="feed-requirements-title">版本产物</h3>
              <ul className="feed-archive-requirements">
                {requirementRows.map((requirement) => (
                  <li key={requirement.slotKey}>
                    <p>
                      {requirementTitle(requirement)} · {requirement.required ? '必需' : '可选'} ·{' '}
                      {requirementStateLabel(requirement.state)}
                    </p>
                    {requirement.errorCode && (
                      <p className="feed-requirement-error">
                        {requirementErrorLabel(requirement.errorCode)}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ArticleBody({
  article,
  canRead,
  paragraphs,
  articleId,
  revisionId,
}: {
  article: ArticleDetailResponse['article'];
  canRead: boolean;
  paragraphs: string[];
  articleId: string;
  revisionId?: string;
}) {
  if (!canRead) return null;
  if (article.ocr?.pages.length) {
    return <OcrReading articleId={articleId} revisionId={revisionId} ocr={article.ocr} />;
  }

  return (
    <section className="feed-reading-body" aria-labelledby="feed-reading-body-title">
      <h2 id="feed-reading-body-title" className="sr-only">通知正文</h2>
      {paragraphs.length > 0 ? paragraphs.map((paragraph, index) => (
        <p key={index}>{paragraph}</p>
      )) : (
        <p className="feed-reading-empty">这个版本还没有可发布的完整正文。</p>
      )}
    </section>
  );
}

function AttachmentList({
  attachments,
  canRead,
  articleId,
  revisionId,
}: {
  attachments: Attachment[];
  canRead: boolean;
  articleId: string;
  revisionId?: string;
}) {
  if (attachments.length === 0) {
    return <p className="feed-reading-empty">这篇通知没有附件。</p>;
  }

  return (
    <section className="feed-attachment-section" id="notice-attachments" aria-labelledby="feed-attachments-title">
      <div className="feed-attachment-heading-row">
        <h2 id="feed-attachments-title">附件</h2>
        <span>{attachments.length} 份</span>
      </div>
      <ol className="feed-attachment-list">
        {attachments.map((attachment) => (
          <AttachmentRow
            key={attachment.id}
            attachment={attachment}
            canRead={canRead}
            articleId={articleId}
            revisionId={revisionId}
          />
        ))}
      </ol>
    </section>
  );
}

function AttachmentRow({
  attachment,
  canRead,
  articleId,
  revisionId,
}: {
  attachment: Attachment;
  canRead: boolean;
  articleId: string;
  revisionId?: string;
}) {
  const format = attachmentFormat(attachment);
  return (
    <li className="feed-attachment-row">
      <FileText className="feed-attachment-icon" aria-hidden="true" />
      <div className="feed-attachment-content">
        {attachment.downloadUrl ? (
          <h3>
            <a href={attachment.downloadUrl}>{attachment.name}</a>
          </h3>
        ) : (
          <h3>{attachment.name}</h3>
        )}
        <p>
          {format} · {formatBytes(attachment.bytes)}
          {attachment.error ? ` · ${attachment.error}` : ''}
        </p>
      </div>
      {canRead && attachment.url && isPdf(attachment) && (
        <iframe
          className="feed-pdf-frame"
          src={pdfReaderUrl(articleId, attachment, revisionId) ?? attachment.url}
          title={`${attachment.name} PDF 预览`}
        >
          <p>
            当前浏览器不支持内嵌 PDF。请
            <a href={attachment.url}>直接打开 PDF</a>。
          </p>
        </iframe>
      )}
    </li>
  );
}
