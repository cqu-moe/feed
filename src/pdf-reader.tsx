import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { Button, PageState } from '@cqu-moe/ui';
import { ChevronLeft, ChevronRight, Download, Minus, Plus } from 'lucide-react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

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

function readPage(value: string | null): number {
  const page = Number.parseInt(value ?? '1', 10);
  return Number.isSafeInteger(page) && page >= 1 ? page : 1;
}

function clampPage(page: number, pageCount: number): number {
  return Math.min(Math.max(1, page), Math.max(1, pageCount));
}

export default function PdfReader() {
  const { id = '', filename = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const requestedPage = readPage(params.get('page'));
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [scale, setScale] = useState(1);
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(requestedPage);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const contentRect = entries[0]?.contentRect;
      setWidth(Math.max(180, contentRect ? contentRect.width - 24 : 180));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setPage(pages ? clampPage(requestedPage, pages) : requestedPage);
  }, [id, filename, requestedPage, pages]);

  const valid = /^[a-f0-9]{24}$/.test(id) && /^attachment-\d+\.pdf$/.test(filename);
  if (!valid) {
    return (
      <PageState
        state="not-found"
        title="未找到 PDF"
        description="请从通知附件列表打开文件。"
      />
    );
  }

  const file = `/api/files/${id}/${filename}`;

  function goToPage(nextPage: number) {
    if (!pages) return;
    const target = clampPage(nextPage, pages);
    setPage(target);
    const search = new URLSearchParams(params);
    search.set('page', String(target));
    setParams(search, { replace: false });
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
        <span aria-live="polite">{page} / {pages || '—'}</span>
        <Button
          variant="outline"
          size="sm"
          aria-label="下一页"
          disabled={!pages || page >= pages}
          onClick={() => goToPage(page + 1)}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-label="缩小"
          disabled={scale <= 0.6}
          onClick={() => setScale(Math.max(0.6, scale - 0.2))}
        >
          <Minus aria-hidden="true" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-label="放大"
          disabled={scale >= 2}
          onClick={() => setScale(Math.min(2, scale + 0.2))}
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
      <div className="feed-reader-document" ref={container}>
        <Document
          file={file}
          options={options}
          onLoadSuccess={({ numPages }) => {
            setPages(numPages);
            const target = clampPage(requestedPage, numPages);
            setPage(target);
            if (target !== requestedPage) {
              const search = new URLSearchParams(params);
              search.set('page', String(target));
              setParams(search, { replace: true });
            }
          }}
          onItemClick={({ pageNumber }) => goToPage(pageNumber)}
          loading={<p role="status">正在读取已存档的 PDF…</p>}
          error={
            <PageState
              state="error"
              title="PDF 暂时无法预览"
              description="请确认登录仍有效，或下载原文件阅读。"
              action={
                <Button asChild>
                  <a href={`${file}?download=1`}>下载 PDF</a>
                </Button>
              }
            />
          }
          externalLinkTarget="_blank"
          externalLinkRel="noopener noreferrer"
        >
          <Page
            pageNumber={page}
            width={width * scale}
            renderTextLayer
            renderAnnotationLayer
            loading={<p role="status">正在呈现页面…</p>}
          />
        </Document>
      </div>
    </main>
  );
}
