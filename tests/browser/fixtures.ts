import { test, expect, type Page } from '@playwright/test';
export { test, expect };

export const articleId = 'c65a90333229c47e1c30157c';
export const revisionId = 'current-reading-fixture';
export const oldRevisionId = 'previous-reading-fixture';

export interface PdfPage {
  width?: number;
  height?: number;
  text?: string;
}

export interface ReadingAttachment {
  id: string;
  name: string;
  filename: string;
  role?: 'body-pdf' | 'attachment' | (string & {});
  status: string;
  error?: string | null;
  contentType: string;
  bytes: number;
  url: string;
  downloadUrl: string;
}

export interface ReadingDetail {
  article: {
    id: string;
    title: string;
    sourceId: string;
    sourceName: string;
    url: string;
    publishedAt: string;
    capturedAt: string;
    status: string;
    attachmentCount: number;
    excerpt: string;
    bodyText: string;
    bodyHtml: null;
    snapshotUrl: string;
    screenshotUrl: string;
  };
  attachments: ReadingAttachment[];
  revision: {
    id: string;
    articleId: string;
    revisionNo: number;
    title: string;
    state: string;
    observedAt: string;
    readyAt: string;
    changeKind: string;
    missingCount: number;
  };
  requirements: Array<{
    slotKey: string;
    kind: string;
    required: boolean;
    state: string;
    name: string | null;
    filename: string | null;
    originalUrl: string | null;
    errorCode: string | null;
    fetchedAt: string | null;
  }>;
}

/** Real, selectable PDF pages, with an internal link from the first to last page. */
export function makePdf(pages: number | PdfPage[] = 2): Buffer {
  const specs = typeof pages === 'number' ? Array.from({ length: pages }, () => ({} as PdfPage)) : pages;
  const pageIds = specs.map((_, index) => 4 + index * 2);
  const annotationId = 4 + specs.length * 2;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${specs.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  specs.forEach((spec, index) => {
    const width = spec.width ?? 612;
    const height = spec.height ?? 792;
    const label = (spec.text ?? `PDF PAGE ${index + 1}`).replace(/[\\()]/g, '\\$&');
    const stream = `BT /F1 24 Tf 40 ${height - 60} Td (${label}) Tj ET\nBT /F1 14 Tf 40 ${height - 100} Td (Read this original document. Go to last page.) Tj ET\n`;
    const annotation = index === 0 && specs.length > 1 ? ` /Annots [${annotationId} 0 R]` : '';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R${annotation} >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  });
  if (specs.length > 1) {
    const height = specs[0].height ?? 792;
    objects.push(`<< /Type /Annot /Subtype /Link /Rect [40 ${height - 105} 400 ${height - 85}] /Border [0 0 0] /Dest [${pageIds.at(-1)} 0 R /Fit] >>`);
  }
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach(offset => { pdf += `${String(offset).padStart(10, '0')} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

export function readingDetail(kind: 'html' | 'pdf' = 'html', id = revisionId): ReadingDetail {
  const old = id === oldRevisionId;
  const prefix = `/api/articles/${articleId}/revisions/${id}`;
  const revision = {
    id, articleId, revisionNo: old ? 1 : 3,
    title: old ? '历史通知：第一批培养材料' : '关于开展2026—2027学年优异生工作的通知',
    state: 'ready', observedAt: old ? '2026-10-11T03:01:00Z' : '2026-10-14T01:10:00Z',
    readyAt: '2026-10-14T01:11:00Z', changeKind: old ? 'baseline' : 'substantive', missingCount: 0,
  };
  const attachments = [
    ...(kind === 'pdf' ? [{ id: 'original', name: old ? '历史通知原件.pdf' : '通知原件.pdf', filename: 'attachment-1.pdf', role: 'body-pdf' as const, status: 'complete', contentType: 'application/pdf', bytes: makePdf().length, url: `${prefix}/files/attachment-1.pdf`, downloadUrl: `${prefix}/files/attachment-1.pdf?download=1` }] : []),
    { id: 'application', name: old ? '历史申请表.doc' : '附件2：优异生申请表.doc', filename: 'attachment-2.doc', role: 'attachment' as const, status: 'complete', contentType: 'application/msword', bytes: 32, url: `${prefix}/files/attachment-2.doc`, downloadUrl: `${prefix}/files/attachment-2.doc?download=1` },
  ];
  return {
    article: {
      id: articleId, title: revision.title, sourceId: 'academic', sourceName: '教务处', url: 'https://example.edu/notice/42',
      publishedAt: '2026-09-24', capturedAt: revision.observedAt, status: 'complete', attachmentCount: attachments.length,
      excerpt: old ? '历史批次材料' : '请各学院开展优异生培养工作。',
      bodyText: old ? '历史正文：第一批材料由学院保存。\n\n历史附件索引：申请表。' : '各学院：\n\n请根据学校要求开展优异生培养工作。\n\n一、优异生选拔\n\n符合条件的学生可向学院提出申请。\n\n附件：1. 优异生指标\n2. 优异生申请表',
      bodyHtml: null, snapshotUrl: `${prefix}/snapshot`, screenshotUrl: `${prefix}/screenshot`,
    },
    attachments, revision, requirements: [],
  };
}

export interface ReadingOptions {
  kind?: 'html' | 'pdf';
  detail?: ReturnType<typeof readingDetail>;
  oldDetail?: ReturnType<typeof readingDetail>;
  revisions?: unknown[];
  pdf?: Buffer;
  files?: Record<string, Buffer | string>;
  authenticated?: boolean;
  entitled?: boolean;
  historyStatus?: number;
  historyDelay?: number;
  detailStatus?: number;
  fileStatus?: number;
  previewStatus?: number;
  downloadStatus?: number;
}

/** External HTTP data only is controlled; routes, components and PDF.js stay real. */
export async function installReadingRoutes(page: Page, options: ReadingOptions = {}) {
  const detail = options.detail ?? readingDetail(options.kind);
  const oldDetail = options.oldDetail ?? readingDetail(options.kind, oldRevisionId);
  const pdf = options.pdf ?? makePdf();
  await page.context().route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const selected = path.includes(`/revisions/${oldRevisionId}`) ? oldDetail : detail;
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === '/api/session') return json({ authenticated: options.authenticated ?? true, entitled: options.entitled ?? true, user: { id: 'browser-fixture', name: '测试读者' } });
    if (options.authenticated === false) return json({ error: 'unauthorized' }, 401);
    if (options.entitled === false) return json({ error: 'forbidden' }, 403);
    if (path === '/api/sources') return json({ sources: [{ id: 'academic', siteId: 'university', name: '教务处', url: 'https://example.edu/', lastRunAt: null, articleCount: 1 }] });
    if (path === '/api/articles') return json({ articles: [detail.article], total: 1, page: 1, pageSize: 20 });
    if (path === `/api/articles/${articleId}/revisions`) {
      if (options.historyDelay) await new Promise(resolve => setTimeout(resolve, options.historyDelay));
      return json({ revisions: options.revisions ?? [detail.revision, oldDetail.revision] }, options.historyStatus ?? 200);
    }
    if (path.endsWith('/snapshot')) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="zh"><meta charset="utf-8"><title>网页快照</title><h1>${selected.revision.title}的网页快照</h1><p>${selected.article.bodyText}</p><iframe title="快照中的 PDF" src="/reader/${articleId}/revisions/${selected.revision.id}/attachment-1.pdf" style="width:90vw;height:80vh"></iframe></html>` });
    if (path.endsWith('/screenshot')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="white"/></svg>' });
    if (path.includes('/files/')) {
      const fileStatus = url.searchParams.has('download')
        ? options.downloadStatus ?? options.fileStatus
        : options.previewStatus ?? options.fileStatus;
      if (fileStatus && fileStatus !== 200) return json({ error: 'file unavailable' }, fileStatus);
      const filename = path.split('/').at(-1)!;
      const bytes = options.files?.[path] ?? options.files?.[filename] ?? (filename.endsWith('.pdf') ? pdf : Buffer.from(`${selected.revision.id}: original application document`));
      return route.fulfill({ contentType: filename.endsWith('.pdf') ? 'application/pdf' : 'application/msword', headers: { 'Content-Disposition': `${url.searchParams.has('download') ? 'attachment' : 'inline'}; filename="${filename}"` }, body: bytes });
    }
    if (path === `/api/articles/${articleId}` || path.startsWith(`/api/articles/${articleId}/revisions/`)) return json(selected, options.detailStatus ?? 200);
    return json({ error: 'fixture route not found' }, 404);
  });
  return { detail, oldDetail, pdf };
}
