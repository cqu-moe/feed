export type SessionUser = {
  name?: string;
  email?: string;
};

export type SubscriptionLimit =
  | { kind: 'limited'; value: number }
  | { kind: 'unlimited' }
  | { kind: 'missing' };

export type AccountEmail =
  | { status: 'verified'; address: string }
  | { status: 'unverified' }
  | { status: 'blocked' };

export type AvailableSessionAccount = {
  status: 'available';
  access: boolean;
  subscriptionLimit: SubscriptionLimit;
  email: AccountEmail;
};

export type UnavailableSessionAccount = {
  status: 'auth_unavailable' | 'unavailable';
  reason?: string;
};

export type SessionAccount = AvailableSessionAccount | UnavailableSessionAccount;

export type Session = {
  authenticated: boolean;
  entitled: boolean;
  user?: SessionUser;
  account?: SessionAccount;
};

export type Source = {
  id: string;
  siteId: string;
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
  filename?: string | null;
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

export type RevisionState = 'assembling' | 'ready' | 'blocked';

export type ArticleRevision = {
  id: string;
  articleId: string;
  revisionNo: number;
  title: string;
  state: RevisionState;
  observedAt: string;
  readyAt: string | null;
  changeKind: string;
  missingCount: number;
};

export type RevisionRequirement = {
  slotKey: string;
  kind: string;
  required: boolean;
  state: string;
  name: string | null;
  filename: string | null;
  originalUrl: string | null;
  errorCode: string | null;
  fetchedAt: string | null;
};

export type ArticleDetailResponse = {
  article: ArticleDetail;
  attachments: Attachment[];
  revision?: ArticleRevision;
  requirements?: RevisionRequirement[];
};

export type ArticleRevisionsResponse = {
  revisions: ArticleRevision[];
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

async function errorResult(response: Response): Promise<{ ok: false; status: number; message: string }> {
  let message = `请求失败（HTTP ${response.status}）。`;
  try {
    const value = await readJson(response);
    if (isRecord(value) && typeof value.error === 'string' && value.error) message = value.error;
  } catch {
    // Keep the HTTP fallback when the server could not return structured JSON.
  }
  return { ok: false, status: response.status, message };
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
      return await errorResult(response);
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
    account: value.account === undefined ? undefined : parseAccount(value.account),
  };
}

function parseSubscriptionLimit(value: unknown): SubscriptionLimit {
  if (!isRecord(value)) throw new Error('会话接口结构不匹配。');
  if (value.kind === 'unlimited' || value.kind === 'missing') return { kind: value.kind };
  if (
    value.kind === 'limited' &&
    typeof value.value === 'number' &&
    Number.isSafeInteger(value.value) &&
    value.value >= 0
  ) {
    return { kind: 'limited', value: value.value };
  }
  throw new Error('会话接口结构不匹配。');
}

function parseAccountEmail(value: unknown): AccountEmail {
  if (!isRecord(value)) throw new Error('会话接口结构不匹配。');
  if (value.status === 'unverified' || value.status === 'blocked') return { status: value.status };
  if (value.status === 'verified' && typeof value.address === 'string' && value.address) {
    return { status: 'verified', address: value.address };
  }
  throw new Error('会话接口结构不匹配。');
}

function parseAccount(value: unknown): SessionAccount {
  if (!isRecord(value)) throw new Error('会话接口结构不匹配。');
  if (value.status === 'auth_unavailable' || value.status === 'unavailable') {
    return {
      status: value.status,
      ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    };
  }
  if (
    value.status !== 'available' ||
    typeof value.access !== 'boolean' ||
    !isRecord(value.subscriptionLimit) ||
    !isRecord(value.email)
  ) {
    throw new Error('会话接口结构不匹配。');
  }
  return {
    status: 'available',
    access: value.access,
    subscriptionLimit: parseSubscriptionLimit(value.subscriptionLimit),
    email: parseAccountEmail(value.email),
  };
}

function parseSource(value: unknown): Source {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.siteId !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.url !== 'string' ||
    (value.lastRunAt !== null && typeof value.lastRunAt !== 'string') ||
    typeof value.articleCount !== 'number' ||
    !Number.isFinite(value.articleCount)
  ) {
    throw new Error('采集来源接口结构不匹配。');
  }
  return {
    id: value.id,
    siteId: value.siteId,
    name: value.name,
    url: value.url,
    lastRunAt: value.lastRunAt,
    articleCount: value.articleCount,
    error: stringOrNull(value.error),
  };
}

export type SubscriptionEffectiveStatus =
  | 'active'
  | 'paused'
  | 'access_revoked'
  | 'quota_exceeded'
  | 'auth_unavailable'
  | 'deleted';

export type SubscriptionTarget = {
  sourceId: string;
  sourceName: string;
  effectiveFrom: string;
};

export type Subscription = {
  id: string;
  version: number;
  name: string;
  requestedEnabled: boolean;
  priority: number;
  emailMode: 'off' | 'immediate' | 'daily_digest';
  activatedAt: string;
  createdAt: string;
  deletedAt: string | null;
  targetSourceIds: string[];
  savedSourceIds: string[];
  targets: SubscriptionTarget[];
  effectiveStatus: SubscriptionEffectiveStatus;
  rssStatus: SubscriptionEffectiveStatus | 'rss_revoked';
  emailStatus: SubscriptionEffectiveStatus | 'mail_off' | 'email_unverified';
  rssUrl: string | null;
};

export type SubscriptionPolicy =
  | {
      status: 'available';
      access: boolean;
      subscriptionLimit: SubscriptionLimit;
    }
  | { status: 'auth_unavailable' };

export type SubscriptionSite = {
  id: string;
  name: string;
};

export type SubscriptionSourceOption = {
  id: string;
  siteId: string;
  name: string;
};

export type SubscriptionList = {
  subscriptions: Subscription[];
  policy: SubscriptionPolicy;
  usage: number;
  sites: SubscriptionSite[];
  sources: SubscriptionSourceOption[];
  outputChannels: {
    rss: { enabled: true } | { enabled: false; reason: string };
    email: { enabled: false; reason: string };
  };
};

export type SubscriptionCreateResponse = {
  created: boolean;
  subscription: Subscription;
};

function parseSubscriptionEffectiveStatus(value: unknown): SubscriptionEffectiveStatus {
  if (
    value === 'active' ||
    value === 'paused' ||
    value === 'access_revoked' ||
    value === 'quota_exceeded' ||
    value === 'auth_unavailable' ||
    value === 'deleted'
  ) return value;
  throw new Error('订阅状态结构不匹配。');
}

function parseSubscriptionEmailMode(value: unknown): Subscription['emailMode'] {
  if (value === 'off' || value === 'immediate' || value === 'daily_digest') return value;
  throw new Error('订阅邮件模式结构不匹配。');
}

function parseSubscriptionTarget(value: unknown): SubscriptionTarget {
  if (!isRecord(value) || typeof value.sourceId !== 'string' || typeof value.sourceName !== 'string' || typeof value.effectiveFrom !== 'string') {
    throw new Error('订阅栏目结构不匹配。');
  }
  return { sourceId: value.sourceId, sourceName: value.sourceName, effectiveFrom: value.effectiveFrom };
}

function parseSubscription(value: unknown): Subscription {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 1 ||
    typeof value.name !== 'string' ||
    typeof value.requestedEnabled !== 'boolean' ||
    typeof value.priority !== 'number' ||
    typeof value.activatedAt !== 'string' ||
    typeof value.createdAt !== 'string' ||
    !Array.isArray(value.targetSourceIds) ||
    !Array.isArray(value.savedSourceIds) ||
    value.savedSourceIds.some((item) => typeof item !== 'string') ||
    value.targetSourceIds.some((item) => typeof item !== 'string') ||
    !Array.isArray(value.targets) ||
    (value.rssUrl !== null && (typeof value.rssUrl !== 'string' || !/^\/rss\?token=[A-Za-z0-9_-]{43}$/.test(value.rssUrl)))
  ) throw new Error('订阅结构不匹配。');
  return {
    id: value.id,
    name: value.name,
    requestedEnabled: value.requestedEnabled,
    priority: value.priority,
    emailMode: parseSubscriptionEmailMode(value.emailMode),
    activatedAt: value.activatedAt,
    createdAt: value.createdAt,
    version: value.version as number,
    deletedAt: stringOrNull(value.deletedAt),
    targetSourceIds: value.targetSourceIds,
    savedSourceIds: value.savedSourceIds,
    targets: value.targets.map(parseSubscriptionTarget),
    effectiveStatus: parseSubscriptionEffectiveStatus(value.effectiveStatus),
    rssStatus: value.rssStatus === 'rss_revoked' ? value.rssStatus : parseSubscriptionEffectiveStatus(value.rssStatus),
    emailStatus: value.emailStatus === 'mail_off' || value.emailStatus === 'email_unverified'
      ? value.emailStatus : parseSubscriptionEffectiveStatus(value.emailStatus),
    rssUrl: value.rssUrl,
  };
}

function parseSubscriptionPolicy(value: unknown): SubscriptionPolicy {
  if (!isRecord(value)) throw new Error('订阅额度结构不匹配。');
  if (value.status === 'auth_unavailable') return { status: value.status };
  if (
    value.status !== 'available' ||
    typeof value.access !== 'boolean' ||
    !isRecord(value.subscriptionLimit)
  ) throw new Error('订阅额度结构不匹配。');
  return {
    status: 'available',
    access: value.access,
    subscriptionLimit: parseSubscriptionLimit(value.subscriptionLimit),
  };
}

function parseRssOutputChannel(value: unknown): { enabled: true } | { enabled: false; reason: string } {
  if (isRecord(value) && value.enabled === true) return { enabled: true };
  return parseDisabledOutputChannel(value, 'RSS');
}

function parseDisabledOutputChannel(value: unknown, label: string): { enabled: false; reason: string } {
  if (!isRecord(value) || value.enabled !== false || typeof value.reason !== 'string') {
    throw new Error(`${label}输出通道结构不匹配。`);
  }
  return { enabled: false, reason: value.reason };
}

export function parseSubscriptionList(value: unknown): SubscriptionList {
  if (
    !isRecord(value) ||
    !Array.isArray(value.subscriptions) ||
    !Array.isArray(value.sites) ||
    !Array.isArray(value.sources) ||
    typeof value.usage !== 'number' ||
    !Number.isSafeInteger(value.usage) ||
    value.usage < 0 ||
    !isRecord(value.outputChannels) ||
    !isRecord(value.outputChannels.rss) ||
    !isRecord(value.outputChannels.email)
  ) throw new Error('订阅列表结构不匹配。');
  if (
    value.sites.some((item) => !isRecord(item) || typeof item.id !== 'string' || typeof item.name !== 'string') ||
    value.sources.some((item) => !isRecord(item) || typeof item.id !== 'string' || typeof item.siteId !== 'string' || typeof item.name !== 'string')
  ) throw new Error('订阅栏目选项结构不匹配。');
  return {
    subscriptions: value.subscriptions.map(parseSubscription),
    policy: parseSubscriptionPolicy(value.policy),
    usage: value.usage,
    sites: value.sites as SubscriptionSite[],
    sources: value.sources as SubscriptionSourceOption[],
    outputChannels: {
      rss: parseRssOutputChannel(value.outputChannels.rss),
      email: parseDisabledOutputChannel(value.outputChannels.email, '邮件'),
    },
  };
}

export function parseSubscriptionCreate(value: unknown): SubscriptionCreateResponse {
  if (!isRecord(value) || typeof value.created !== 'boolean' || !isRecord(value.subscription)) {
    throw new Error('订阅保存结果结构不匹配。');
  }
  return {
    created: value.created,
    subscription: parseSubscription(value.subscription),
  };
}

export function parseSubscriptionChange(value: unknown): { changed: boolean; subscription: Subscription } {
  if (!isRecord(value) || typeof value.changed !== 'boolean') throw new Error('订阅修改结果结构不匹配。');
  return { changed: value.changed, subscription: parseSubscription(value.subscription) };
}

export type NotificationMatch = {
  eventId: string;
  eventKind: 'initial' | 'update';
  title: string;
  status: string;
  reason: string;
  readyAt: string;
  matchedAt: string;
};

export function parseSubscriptionMatches(value: unknown): NotificationMatch[] {
  if (!isRecord(value) || !isRecord(value.subscription) || !Array.isArray(value.subscription.notificationMatches)) {
    throw new Error('通知记录不完整，请刷新重试。');
  }
  return value.subscription.notificationMatches.map((item: unknown) => {
    if (!isRecord(item) || typeof item.eventId !== 'string' || !/^[a-f0-9]{24}$/.test(item.eventId)
      || (item.eventKind !== 'initial' && item.eventKind !== 'update')
      || typeof item.title !== 'string' || typeof item.status !== 'string' || typeof item.reason !== 'string'
      || typeof item.readyAt !== 'string' || !Number.isFinite(Date.parse(item.readyAt))
      || typeof item.matchedAt !== 'string' || !Number.isFinite(Date.parse(item.matchedAt))) {
      throw new Error('通知记录不完整，请刷新重试。');
    }
    return { eventId: item.eventId, eventKind: item.eventKind, title: item.title, status: item.status,
      reason: item.reason, readyAt: item.readyAt, matchedAt: item.matchedAt };
  });
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
    filename: stringOrNull(value.filename),
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

function parseRevisionState(value: unknown): RevisionState {
  if (value === 'assembling' || value === 'ready' || value === 'blocked') return value;
  throw new Error('通知版本状态结构不匹配。');
}

function parseRevision(value: unknown): ArticleRevision {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.articleId !== 'string' ||
    typeof value.revisionNo !== 'number' ||
    !Number.isSafeInteger(value.revisionNo) ||
    value.revisionNo < 1 ||
    typeof value.title !== 'string' ||
    typeof value.observedAt !== 'string' ||
    typeof value.missingCount !== 'number' ||
    !Number.isSafeInteger(value.missingCount) ||
    value.missingCount < 0 ||
    typeof value.changeKind !== 'string'
  ) {
    throw new Error('通知版本接口结构不匹配。');
  }
  if (Number.isNaN(Date.parse(value.observedAt))) throw new Error('通知版本时间结构不匹配。');

  return {
    id: value.id,
    articleId: value.articleId,
    revisionNo: value.revisionNo,
    title: value.title,
    state: parseRevisionState(value.state),
    observedAt: value.observedAt,
    readyAt: stringOrNull(value.readyAt),
    changeKind: value.changeKind,
    missingCount: value.missingCount,
  };
}

function parseRequirement(value: unknown): RevisionRequirement {
  if (
    !isRecord(value) ||
    typeof value.slotKey !== 'string' ||
    typeof value.kind !== 'string' ||
    !(value.required === true || value.required === false || value.required === 0 || value.required === 1) ||
    typeof value.state !== 'string'
  ) {
    throw new Error('版本产物清单结构不匹配。');
  }

  return {
    slotKey: value.slotKey,
    kind: value.kind,
    required: value.required === true || value.required === 1,
    state: value.state,
    name: stringOrNull(value.name),
    filename: stringOrNull(value.filename),
    originalUrl: stringOrNull(value.originalUrl),
    errorCode: stringOrNull(value.errorCode) ?? stringOrNull(value.error),
    fetchedAt: stringOrNull(value.fetchedAt),
  };
}

export function parseArticleRevisions(value: unknown): ArticleRevisionsResponse {
  if (!isRecord(value) || !Array.isArray(value.revisions)) {
    throw new Error('通知版本时间线结构不匹配。');
  }
  return { revisions: value.revisions.map(parseRevision) };
}

export function parseArticleDetail(value: unknown): ArticleDetailResponse {
  if (
    !isRecord(value) ||
    !isRecord(value.article) ||
    !Array.isArray(value.attachments) ||
    (value.revision !== undefined && value.revision !== null && !isRecord(value.revision)) ||
    (value.requirements !== undefined && value.requirements !== null && !Array.isArray(value.requirements))
  ) {
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

  return {
    article,
    attachments: parsedAttachments,
    ...(value.revision === undefined || value.revision === null ? {} : { revision: parseRevision(value.revision) }),
    ...(value.requirements === undefined || value.requirements === null
      ? {}
      : { requirements: value.requirements.map(parseRequirement) }),
  };
}
