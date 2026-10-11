export type SessionUser = {
  name?: string;
  email?: string;
};

export type Session = {
  authenticated: boolean;
  entitled: boolean;
  user?: SessionUser;
};

export type Source = {
  id: string;
  name: string;
  url: string;
  lastRunAt: string | null;
  articleCount: number;
  error?: string | null;
};

export type ArticleListItem = {
  id: string;
  title: string;
  sourceId: string;
  sourceName: string;
  url: string;
  publishedAt: string | null;
  capturedAt: string | null;
  status: string;
  attachmentCount: number;
  excerpt: string;
};

export type ArticleList = {
  articles: ArticleListItem[];
  total: number;
  page: number;
  pageSize: number;
};

export type Attachment = {
  id: string;
  name: string;
  bytes: number | null;
  contentType: string | null;
  status: string;
  error?: string | null;
  url: string | null;
  downloadUrl: string | null;
};

export type OcrPage = {
  page: number;
  filename: string;
  source: 'ocr' | 'native';
  markdown: string;
  text: string;
};

export type ArticleOcr = {
  status: 'complete' | 'partial' | 'pending' | 'failed';
  model: string;
  htmlText: string;
  pages: OcrPage[];
  updatedAt: string | null;
};

export type ArticleDetail = ArticleListItem & {
  bodyText: string;
  bodyHtml: string | null;
  snapshotUrl: string | null;
  screenshotUrl: string | null;
  attachments: Attachment[];
  ocr?: ArticleOcr;
};

export type ArticleDetailResponse = {
  article: ArticleDetail;
  attachments: Attachment[];
};

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error('接口返回的不是有效 JSON。');
  }
}

export async function requestJson<T>(
  path: string,
  validate: (value: unknown) => T,
  init?: RequestInit,
): Promise<ApiResult<T>> {
  try {
    const response = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...init?.headers,
      },
    });

    if (!response.ok) {
      return { ok: false, status: response.status, message: `请求失败（HTTP ${response.status}）。` };
    }

    return { ok: true, data: validate(await readJson(response)) };
  } catch (error) {
    const message = error instanceof Error ? error.message : '网络连接失败。';
    return { ok: false, status: 0, message };
  }
}

function parseUser(value: unknown): SessionUser | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error('用户信息结构不匹配。');
  return {
    name: stringOrNull(value.name) ?? undefined,
    email: stringOrNull(value.email) ?? undefined,
  };
}

export function parseSession(value: unknown): Session {
  if (!isRecord(value)) throw new Error('会话接口结构不匹配。');
  if (typeof value.authenticated !== 'boolean' || typeof value.entitled !== 'boolean') {
    throw new Error('会话接口结构不匹配。');
  }
  return {
    authenticated: value.authenticated,
    entitled: value.entitled,
    user: parseUser(value.user),
  };
}

function parseSource(value: unknown): Source {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.url !== 'string' ||
    typeof value.lastRunAt !== 'string' ||
    typeof value.articleCount !== 'number' ||
    !Number.isFinite(value.articleCount)
  ) {
    throw new Error('采集来源接口结构不匹配。');
  }
  return {
    id: value.id,
    name: value.name,
    url: value.url,
    lastRunAt: value.lastRunAt,
    articleCount: value.articleCount,
    error: stringOrNull(value.error),
  };
}

export function parseSources(value: unknown): Source[] {
  if (!isRecord(value) || !Array.isArray(value.sources)) {
    throw new Error('采集来源接口结构不匹配。');
  }
  return value.sources.map(parseSource);
}

function parseArticleListItem(value: unknown): ArticleListItem {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.sourceId !== 'string' ||
    typeof value.sourceName !== 'string' ||
    typeof value.url !== 'string' ||
    (typeof value.capturedAt !== 'string' && value.capturedAt !== null) ||
    typeof value.status !== 'string' ||
    typeof value.attachmentCount !== 'number' ||
    !Number.isFinite(value.attachmentCount) ||
    typeof value.excerpt !== 'string'
  ) {
    throw new Error('通知列表接口结构不匹配。');
  }
  return {
    id: value.id,
    title: value.title,
    sourceId: value.sourceId,
    sourceName: value.sourceName,
    url: value.url,
    publishedAt: stringOrNull(value.publishedAt),
    capturedAt: stringOrNull(value.capturedAt),
    status: value.status,
    attachmentCount: value.attachmentCount,
    excerpt: value.excerpt,
  };
}

export function parseArticleList(value: unknown): ArticleList {
  if (
    !isRecord(value) ||
    !Array.isArray(value.articles) ||
    typeof value.total !== 'number' ||
    !Number.isFinite(value.total) ||
    typeof value.page !== 'number' ||
    !Number.isFinite(value.page) ||
    typeof value.pageSize !== 'number' ||
    !Number.isFinite(value.pageSize)
  ) {
    throw new Error('通知列表接口结构不匹配。');
  }
  return {
    articles: value.articles.map(parseArticleListItem),
    total: value.total,
    page: value.page,
    pageSize: value.pageSize,
  };
}

function parseAttachment(value: unknown): Attachment {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.status !== 'string'
  ) {
    throw new Error('附件接口结构不匹配。');
  }
  return {
    id: value.id,
    name: value.name,
    bytes: numberOrNull(value.bytes),
    contentType: stringOrNull(value.contentType),
    status: value.status,
    error: stringOrNull(value.error),
    url: stringOrNull(value.url),
    downloadUrl: stringOrNull(value.downloadUrl),
  };
}

function parseOcrPage(value: unknown): OcrPage {
  if (
    !isRecord(value) ||
    typeof value.page !== 'number' ||
    !Number.isSafeInteger(value.page) ||
    value.page < 1 ||
    typeof value.filename !== 'string' ||
    !/^attachment-[1-9]\d*\.pdf$/.test(value.filename) ||
    (value.source !== 'ocr' && value.source !== 'native') ||
    typeof value.markdown !== 'string' ||
    typeof value.text !== 'string'
  ) {
    throw new Error('扫描件识别结果接口结构不匹配。');
  }
  return {
    page: value.page,
    filename: value.filename,
    source: value.source,
    markdown: value.markdown,
    text: value.text,
  };
}

function parseOcr(value: unknown): ArticleOcr {
  if (
    !isRecord(value) ||
    (value.status !== 'complete' &&
      value.status !== 'partial' &&
      value.status !== 'pending' &&
      value.status !== 'failed') ||
    typeof value.model !== 'string' ||
    !Array.isArray(value.pages) ||
    (typeof value.updatedAt !== 'string' && value.updatedAt !== null)
  ) {
    throw new Error('扫描件识别结果接口结构不匹配。');
  }
  return {
    status: value.status,
    model: value.model,
    htmlText: typeof value.htmlText === 'string' ? value.htmlText : '',
    pages: value.pages.map(parseOcrPage),
    updatedAt: stringOrNull(value.updatedAt),
  };
}

export function parseArticleDetail(value: unknown): ArticleDetailResponse {
  if (!isRecord(value) || !isRecord(value.article) || !Array.isArray(value.attachments)) {
    throw new Error('通知详情接口结构不匹配。');
  }
  if (typeof value.article.bodyText !== 'string') {
    throw new Error('通知正文接口结构不匹配。');
  }

  const parsedAttachments = value.attachments.map(parseAttachment);
  const article: ArticleDetail = {
    ...parseArticleListItem(value.article),
    bodyText: value.article.bodyText,
    bodyHtml: stringOrNull(value.article.bodyHtml),
    snapshotUrl: stringOrNull(value.article.snapshotUrl),
    screenshotUrl: stringOrNull(value.article.screenshotUrl),
    attachments: parsedAttachments,
    ...(value.article.ocr === undefined ? {} : { ocr: parseOcr(value.article.ocr) }),
  };

  return { article, attachments: parsedAttachments };
}
