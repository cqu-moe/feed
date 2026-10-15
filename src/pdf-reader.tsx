import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { Button, PageState } from '@cqu-moe/ui';
import { ChevronLeft, ChevronRight, Download, Minus, Plus } from 'lucide-react';
import { Document, Page, pdfjs } from 'react-pdf';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { captureFeedEvent } from './telemetry';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import './pdf-reader.css';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

const options = {
  cMapUrl: '/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/pdfjs/standard_fonts/',
  wasmUrl: '/pdfjs/wasm/',
  isEvalSupported: false,
};

type PageGeometry = { width: number; height: number };
type ViewportSize = { width: number; height: number };
type ReadingAnchor = { pageNumber: number; xRatio: number; yRatio: number };
type ReaderError = { title: string; description: string };

function readPage(value: string | null): number {
  const page = Number.parseInt(value ?? '1', 10);
  return Number.isSafeInteger(page) && page >= 1 ? page : 1;
}

function clampPage(page: number, pageCount: number): number {
  return Math.min(Math.max(1, page), Math.max(1, pageCount));
}

function sameSize(left: ViewportSize, right: ViewportSize): boolean {
  return left.width === right.width && left.height === right.height;
}

function describeDocumentError(error: unknown): ReaderError {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const title = 'PDF 暂时无法预览';
  if (/(^|[^0-9])401([^0-9]|$)|unauthorized/i.test(message)) {
    return { title, description: '文件会话已失效，请重新登录后再打开此 PDF。' };
  }
  if (/(^|[^0-9])403([^0-9]|$)|forbidden/i.test(message)) {
    return { title, description: '当前访问权益不允许读取此 PDF。' };
  }
  if (/(^|[^0-9])404([^0-9]|$)|not found|missing pdf/i.test(message)) {
    return { title, description: 'PDF 文件不存在或暂时不可用，请重试预览。' };
  }
  if (/invalidpdf|invalid pdf|pdf ?structure|parse error/i.test(message)) {
    return { title, description: 'PDF 文件已损坏或无法解析，请重试预览。' };
  }
  return { title, description: '请确认登录仍有效，或下载原文件阅读。' };
}

export default function PdfReader() {
  const { articleId: revisionArticleId, id: legacyArticleId, revisionId, filename = '' } = useParams();
  const articleId = revisionArticleId ?? legacyArticleId ?? '';
  const [params, setParams] = useSearchParams();
  const requestedPage = readPage(params.get('page'));
  const container = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const scrollFrame = useRef<number | null>(null);
  const anchor = useRef<ReadingAnchor | null>(null);
  const stableAnchor = useRef<ReadingAnchor | null>(null);
  const programmaticUrlPage = useRef<number | null>(null);
  const navigationPage = useRef<number | null>(null);
  const navigateToPage = useRef<(pageNumber: number) => void>(() => {});
  const documentVersion = useRef(0);
  const [viewport, setViewportSize] = useState<ViewportSize>({ width: 640, height: 720 });
  const [scale, setScale] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [geometries, setGeometries] = useState<PageGeometry[]>([]);
  const [page, setPage] = useState(requestedPage);
  const [renderWindow, setRenderWindow] = useState({ first: 1, last: 1 });
  const [readerError, setReaderError] = useState<ReaderError | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const openOperation = useRef<{ id: string; attemptId: string; startedAt: number }>({
    id: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    startedAt: performance.now(),
  });
  const openCompleted = useRef(false);

  const valid = /^[a-f0-9]{24}$/.test(articleId)
    && (revisionId === undefined || /^[A-Za-z0-9_-]+$/.test(revisionId))
    && /^attachment-\d+\.pdf$/.test(filename);
  const file = revisionId
    ? `/api/articles/${articleId}/revisions/${encodeURIComponent(revisionId)}/files/${filename}`
    : `/api/files/${articleId}/${filename}`;

  const captureAnchor = (): ReadingAnchor | null => {
    const element = container.current;
    if (!element || !pageRefs.current.length) return null;
    const centerX = element.scrollLeft + element.clientWidth / 2;
    const centerY = element.scrollTop + element.clientHeight / 2;
    let target: ReadingAnchor | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    pageRefs.current.forEach((pageElement, index) => {
      if (!pageElement) return;
      const xRatio = (centerX - pageElement.offsetLeft) / pageElement.offsetWidth;
      const yRatio = (centerY - pageElement.offsetTop) / pageElement.offsetHeight;
      const distance = Math.abs(xRatio - 0.5) + Math.abs(yRatio - 0.5);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        target = {
          pageNumber: index + 1,
          xRatio: Math.min(Math.max(xRatio, 0), 1),
          yRatio: Math.min(Math.max(yRatio, 0), 1),
        };
      }
    });
    return target;
  };

  const pageLayout = geometries.map(geometry => {
    const width = Math.max(80, Math.round(viewport.width * scale));
    return { width, height: Math.round(width * geometry.height / geometry.width) };
  });
  const minimumPageHeight = pageLayout.length ? Math.min(...pageLayout.map(item => item.height)) : 1;
  const renderRadius = Math.max(1, Math.ceil(viewport.height / minimumPageHeight) + 1);

  function applyRenderWindow(targetPage: number) {
    if (!pageCount) return;
    const nextWindow = {
      first: Math.max(1, targetPage - renderRadius),
      last: Math.min(pageCount, targetPage + renderRadius),
    };
    setRenderWindow(current => (
      current.first === nextWindow.first && current.last === nextWindow.last ? current : nextWindow
    ));
  }

  function syncPageToUrl(targetPage: number, replace = true) {
    if (params.get('page') === String(targetPage)) {
      if (navigationPage.current === targetPage) navigationPage.current = null;
      return;
    }
    programmaticUrlPage.current = targetPage;
    const search = new URLSearchParams(params);
    search.set('page', String(targetPage));
    setParams(search, { replace });
  }

  function updateVisiblePage() {
    const element = container.current;
    if (!element) return;
    const visibleTop = element.scrollTop;
    const visibleBottom = visibleTop + element.clientHeight;
    let target = 0;
    let largestArea = 0;
    pageRefs.current.forEach((pageElement, index) => {
      if (!pageElement) return;
      const top = pageElement.offsetTop;
      const bottom = top + pageElement.offsetHeight;
      const area = Math.max(0, Math.min(bottom, visibleBottom) - Math.max(top, visibleTop));
      if (area > largestArea) {
        largestArea = area;
        target = index + 1;
      }
    });
    if (!target) return;
    setPage(target);
    applyRenderWindow(target);
    if (navigationPage.current !== target) syncPageToUrl(target);
    stableAnchor.current = captureAnchor();
  }

  function handleScroll() {
    if (scrollFrame.current !== null) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null;
      updateVisiblePage();
    });
  }

  function scrollToPage(targetPage: number) {
    const element = container.current;
    const pageElement = pageRefs.current[targetPage - 1];
    if (!element || !pageElement) return;
    pageElement.scrollIntoView({ block: 'start', inline: 'nearest' });
  }

  function goToPage(nextPage: number) {
    if (!pageCount) return;
    const target = clampPage(nextPage, pageCount);
    navigationPage.current = target;
    setPage(target);
    applyRenderWindow(target);
    scrollToPage(target);
    stableAnchor.current = captureAnchor();
    syncPageToUrl(target, false);
  }

  function zoom(nextScale: number) {
    const currentAnchor = stableAnchor.current ?? captureAnchor();
    if (currentAnchor) anchor.current = currentAnchor;
    setScale(nextScale);
  }

  function retryDocument() {
    documentVersion.current += 1;
    setReaderError(null);
    setPageCount(0);
    setGeometries([]);
    setPage(requestedPage);
    setRenderWindow({ first: 1, last: 1 });
    pageRefs.current = [];
    setReloadNonce(current => current + 1);
  }

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      const nextSize = {
        width: Math.max(180, Math.round(rect.width)),
        height: Math.max(180, Math.round(rect.height)),
      };
      anchor.current = stableAnchor.current ?? captureAnchor();
      setViewportSize(current => (sameSize(current, nextSize) ? current : nextSize));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    documentVersion.current += 1;
    setReaderError(null);
    setPageCount(0);
    setGeometries([]);
    setPage(requestedPage);
    setRenderWindow({ first: 1, last: 1 });
    programmaticUrlPage.current = null;
    navigationPage.current = null;
    anchor.current = null;
    openOperation.current = { id: crypto.randomUUID(), attemptId: crypto.randomUUID(), startedAt: performance.now() };
    openCompleted.current = false;
    pageRefs.current = [];
  }, [articleId, revisionId, filename]);

  useEffect(() => () => {
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
  }, []);

  useEffect(() => {
    if (!pageCount) return;
    applyRenderWindow(page);
  }, [page, pageCount, renderRadius]);

  useEffect(() => {
    navigateToPage.current = goToPage;
  });

  useEffect(() => {
    const savedAnchor = anchor.current;
    if (!savedAnchor || !pageLayout.length) return;
    const element = container.current;
    const pageElement = pageRefs.current[savedAnchor.pageNumber - 1];
    if (!element || !pageElement) return;
    element.scrollTop = pageElement.offsetTop + savedAnchor.yRatio * pageElement.offsetHeight - element.clientHeight / 2;
    element.scrollLeft = pageElement.offsetLeft + savedAnchor.xRatio * pageElement.offsetWidth - element.clientWidth / 2;
    stableAnchor.current = savedAnchor;
    anchor.current = null;
  }, [scale, viewport, geometries, pageLayout.length]);

  useEffect(() => {
    if (!geometries.length) return;
    const target = clampPage(requestedPage, geometries.length);
    if (programmaticUrlPage.current === target) {
      programmaticUrlPage.current = null;
      navigationPage.current = null;
      return;
    }
    if (navigationPage.current === target) {
      navigationPage.current = null;
      return;
    }
    setPage(target);
    scrollToPage(target);
    stableAnchor.current = captureAnchor();
    if (params.get('page') !== String(target)) {
      programmaticUrlPage.current = target;
      const search = new URLSearchParams(params);
      search.set('page', String(target));
      setParams(search, { replace: true });
    }
  }, [requestedPage, geometries]);

  async function handleDocumentLoad(pdf: PDFDocumentProxy) {
    const version = documentVersion.current;
    setPageCount(pdf.numPages);
    setGeometries([]);
    const target = clampPage(requestedPage, pdf.numPages);
    setPage(target);
    setRenderWindow({
      first: target,
      last: target,
    });

    if (!openCompleted.current && window.self === window.top) {
      const operation = openOperation.current;
      captureFeedEvent('feed_item_opened', {
        operation: 'pdf_read',
        flow: 'reading',
        stage: 'opened',
        outcome: 'success',
        operation_id: operation.id,
        attempt_id: operation.attemptId,
        article_id: articleId,
        revision_id: revisionId ?? null,
        content_kind: 'pdf',
        ocr_used: false,
        revision_state: 'ready',
        duration_ms: Math.max(0, Math.round(performance.now() - operation.startedAt)),
        duration_basis: 'content_request_to_readable_response',
      });
      openCompleted.current = true;
    }

    try {
      const pageProxies = await Promise.all(
        Array.from({ length: pdf.numPages }, (_, index) => pdf.getPage(index + 1)),
      );
      if (documentVersion.current !== version) return;
      setGeometries(pageProxies.map((pdfPage: PDFPageProxy) => {
        const viewportDimensions = pdfPage.getViewport({ scale: 1 });
        return { width: viewportDimensions.width, height: viewportDimensions.height };
      }));
    } catch {
      if (documentVersion.current === version) {
        setReaderError({
          title: 'PDF 页面信息暂时无法读取',
          description: '请重试预览，或下载原文件阅读。',
        });
      }
    }
  }

  function handleDocumentLoadError(error: unknown) {
    setReaderError(describeDocumentError(error));
  }

  if (!valid) {
    return (
      <PageState
        state="not-found"
        title="未找到 PDF"
        description="请从通知附件列表打开文件。"
      />
    );
  }

  return (
    <main className="feed-reader" aria-label="已存档的 PDF 阅读器">
      <div className="feed-reader-toolbar" role="toolbar" aria-label="PDF 翻页和缩放">
        <Button
          variant="outline"
          size="sm"
          aria-label="上一页"
          disabled={page <= 1}
          onClick={() => goToPage(page - 1)}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <span aria-live="polite">{page} / {pageCount || '—'}</span>
        <Button
          variant="outline"
          size="sm"
          aria-label="下一页"
          disabled={!pageCount || page >= pageCount}
          onClick={() => goToPage(page + 1)}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-label="缩小"
          disabled={scale <= 0.6}
          onClick={() => zoom(Math.max(0.6, scale - 0.2))}
        >
          <Minus aria-hidden="true" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-label="放大"
          disabled={scale >= 2}
          onClick={() => zoom(Math.min(2, scale + 0.2))}
        >
          <Plus aria-hidden="true" />
        </Button>
        <Button asChild variant="outline" size="sm">
          <a href={`${file}?download=1`}>
            <Download aria-hidden="true" />
            下载
          </a>
        </Button>
      </div>
      <div
        className="feed-reader-document"
        ref={container}
        role="region"
        aria-label="PDF 连续阅读"
        tabIndex={0}
        onScroll={handleScroll}
      >
        {readerError && (
          <PageState
            state="error"
            title={readerError.title}
            description={readerError.description}
            action={
              <>
                <Button onClick={retryDocument}>重试预览</Button>
                <Button asChild variant="outline">
                  <a href={`${file}?download=1`}>下载 PDF</a>
                </Button>
              </>
            }
          />
        )}
        {!readerError && (
          <Document
            key={reloadNonce}
            file={file}
            options={options}
            suspense={false}
            onLoadSuccess={handleDocumentLoad}
            onLoadError={handleDocumentLoadError}
            onItemClick={({ pageNumber }) => navigateToPage.current(pageNumber)}
            loading={<p role="status">正在读取已存档的 PDF…</p>}
            error={
              <PageState
                state="error"
                title="PDF 暂时无法预览"
                description="请确认登录仍有效，或下载原文件阅读。"
                action={
                  <>
                    <Button onClick={retryDocument}>重试预览</Button>
                    <Button asChild variant="outline">
                      <a href={`${file}?download=1`}>下载 PDF</a>
                    </Button>
                  </>
                }
              />
            }
            externalLinkTarget="_blank"
            externalLinkRel="noopener noreferrer"
          >
            {pageLayout.map((layout, index) => {
              const pageNumber = index + 1;
              const isRendered = pageNumber >= renderWindow.first && pageNumber <= renderWindow.last;
              return (
                <div
                  key={pageNumber}
                  className="feed-reader-page"
                  aria-label={`PDF 第 ${pageNumber} 页`}
                  data-feed-page-state={isRendered ? 'rendered' : 'placeholder'}
                  style={{ width: layout.width, height: layout.height }}
                  ref={element => {
                    pageRefs.current[index] = element;
                  }}
                >
                  {isRendered ? (
                    <Page
                      pageNumber={pageNumber}
                      width={layout.width}
                      renderTextLayer
                      renderAnnotationLayer
                      loading={<p role="status">正在呈现第 {pageNumber} 页…</p>}
                    />
                  ) : (
                    <p>第 {pageNumber} 页</p>
                  )}
                </div>
              );
            })}
          </Document>
        )}
      </div>
    </main>
  );
}
