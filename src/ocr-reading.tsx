import { Link } from 'react-router';
import { Button } from '@cqu-moe/ui';
import { ExternalLink } from 'lucide-react';
import Markdown, { type Components, type UrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ArticleOcr } from './api';

const allowedElements = [
  'a',
  'blockquote',
  'code',
  'dd',
  'del',
  'dl',
  'dt',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'li',
  'ol',
  'p',
  'pre',
  'strong',
  'em',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
] as const;

const safeMarkdownUrl: UrlTransform = (url) => (/^https?:\/\//i.test(url) ? url : '');

const markdownComponents: Components = {
  a({ children, href }) {
    if (!href) return <span>{children}</span>;
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  table({ children }) {
    return (
      <div className="feed-markdown-table" role="region" aria-label="识别结果表格">
        <table>{children}</table>
      </div>
    );
  },
};

function statusLabel(ocr: ArticleOcr): string {
  if (ocr.pages.length === 0) {
    return ocr.status === 'pending' ? '识别结果准备中' : '暂无可读识别页';
  }
  if (ocr.status === 'complete') return `已识别 ${ocr.pages.length} 页`;
  if (ocr.status === 'partial') return `部分识别完成 · ${ocr.pages.length} 页可读`;
  if (ocr.status === 'pending') return `识别结果准备中 · 已有 ${ocr.pages.length} 页`;
  return `识别未完成 · 保留 ${ocr.pages.length} 页已验证结果`;
}

export function OcrReading({
  articleId,
  revisionId,
  ocr,
}: {
  articleId: string;
  revisionId?: string;
  ocr: ArticleOcr;
}) {
  return (
    <section className="feed-detail-section feed-ocr-section" aria-labelledby="feed-ocr-title">
      <h2 id="feed-ocr-title">PDF 正文与附件文字</h2>
      <div className="feed-ocr-shell">
        <p className="feed-ocr-intro">
          以下文字来自已存档的 PDF；扫描页由 OCR 自动识别。姓名和数字可能有误，请以原 PDF 为准。
        </p>
        {ocr.htmlText && <div className="feed-prose">{ocr.htmlText}</div>}
        <p className="feed-ocr-status">{statusLabel(ocr)}</p>
        {ocr.pages.length > 0 && (
          <div className="feed-ocr-page-list">
            {ocr.pages.map((item) => (
              <article className="feed-ocr-page" key={`${item.filename}-${item.page}`}>
                <header className="feed-ocr-page-header">
                  <h3>{ocr.pages.some((page) => page.filename !== item.filename) && `${item.filename} · `}第 {item.page} 页</h3>
                  <Button asChild variant="outline" size="sm">
                    <Link
                      to={
                        revisionId
                          ? `/reader/${articleId}/revisions/${encodeURIComponent(revisionId)}/${item.filename}?page=${item.page}`
                          : `/reader/${articleId}/${item.filename}?page=${item.page}`
                      }
                    >
                      <ExternalLink aria-hidden="true" />
                      打开原 PDF
                    </Link>
                  </Button>
                </header>
                <div className="feed-ocr-markdown">
                  <Markdown
                    allowedElements={allowedElements}
                    components={markdownComponents}
                    remarkPlugins={[remarkGfm]}
                    skipHtml
                    urlTransform={safeMarkdownUrl}
                  >
                    {item.markdown.trim() || item.text.trim()}
                  </Markdown>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
