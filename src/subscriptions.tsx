import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ActionButton,
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Checkbox,
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
import { BellPlus, Copy, RefreshCw } from 'lucide-react';
import {
  parseSubscriptionCreate,
  parseSubscriptionList,
  requestJson,
  type Subscription,
  type SubscriptionCreateResponse,
  type SubscriptionList,
} from './api';
import { LoginRequiredState, RetryButton, formatDateTime } from './components';

type ListState =
  | { kind: 'loading' }
  | { kind: 'success'; data: SubscriptionList }
  | { kind: 'error'; message: string }
  | { kind: 'unauthorized' };

type Draft = {
  requestId: string;
  name: string;
  siteIds: string[];
  sourceIds: string[];
  emailMode: 'off' | 'immediate' | 'daily_digest';
};

type SaveState = 'idle' | 'loading' | 'success' | 'error';

const emailModeLabels = new Map([
  ['off', '不发送邮件'],
  ['immediate', '及时提醒'],
  ['daily_digest', '每日摘要（默认）'],
] as const);

const statusLabels = new Map([
  ['active', '运行中'],
  ['paused', '已暂停'],
  ['access_revoked', '缺少访问权益'],
  ['quota_exceeded', '超出当前额度'],
  ['auth_unavailable', 'Auth 暂不可用'],
] as const);

function emptyDraft(): Draft {
  return {
    requestId: crypto.randomUUID(),
    name: '',
    siteIds: [],
    sourceIds: [],
    emailMode: 'daily_digest',
  };
}

function listFromResult(result: Awaited<ReturnType<typeof requestJson<SubscriptionList>>>): ListState {
  if (result.ok) return { kind: 'success', data: result.data };
  if (result.status === 401) return { kind: 'unauthorized' };
  return { kind: 'error', message: result.message };
}

function quotaLabel(data: SubscriptionList): string {
  const policy = data.policy;
  if (policy.status !== 'available') return 'Auth 暂不可用';
  if (!policy.access) return '缺少 feed.access';
  const limit = policy.subscriptionLimit;
  if (limit.kind === 'unlimited') return `${data.usage} 个 / 无限`;
  if (limit.kind === 'missing') return `${data.usage} 个 / 未配置（按 0 个执行）`;
  return `${data.usage} / ${limit.value} 个`;
}

function canCreate(data: SubscriptionList): boolean {
  const policy = data.policy;
  if (policy.status !== 'available' || !policy.access) return false;
  const limit = policy.subscriptionLimit;
  return limit.kind === 'unlimited' || (limit.kind === 'limited' && data.usage < limit.value);
}

function statusClass(status: Subscription['effectiveStatus']): string {
  if (status === 'active') return 'is-ok';
  if (status === 'paused' || status === 'auth_unavailable') return 'is-warning';
  return 'is-error';
}

export function SubscriptionsPage() {
  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [created, setCreated] = useState<SubscriptionCreateResponse | null>(null);
  const saving = useRef(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setState((current) => (current.kind === 'success' ? current : { kind: 'loading' }));
    requestJson('/api/subscriptions', parseSubscriptionList, { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) setState(listFromResult(result));
    });
    return () => controller.abort();
  }, [reloadKey]);

  function editDraft(changes: Partial<Omit<Draft, 'requestId'>>) {
    if (saving.current) return;
    setDraft((current) => ({ ...current, ...changes, requestId: crypto.randomUUID() }));
    setSaveState('idle');
    setSaveError(null);
  }

  function toggleSite(siteId: string, checked: boolean) {
    editDraft({
      siteIds: checked
        ? [...new Set([...draft.siteIds, siteId])]
        : draft.siteIds.filter((id) => id !== siteId),
    });
  }

  function toggleSource(sourceId: string, checked: boolean) {
    editDraft({
      sourceIds: checked
        ? [...new Set([...draft.sourceIds, sourceId])]
        : draft.sourceIds.filter((id) => id !== sourceId),
    });
  }

  async function reload() {
    const controller = new AbortController();
    const result = await requestJson('/api/subscriptions', parseSubscriptionList, { signal: controller.signal });
    if (!controller.signal.aborted) setState(listFromResult(result));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving.current || saveState === 'success') return;
    if (!draft.name.trim() || (!draft.siteIds.length && !draft.sourceIds.length)) {
      setSaveState('error');
      setSaveError('请填写订阅名称，并至少选择一个站点或栏目。');
      return;
    }
    saving.current = true;
    setSaveState('loading');
    setSaveError(null);
    const result = await requestJson('/api/subscriptions', parseSubscriptionCreate, {
      method: 'POST',
      body: JSON.stringify({
        requestId: draft.requestId,
        name: draft.name,
        siteIds: draft.siteIds,
        sourceIds: draft.sourceIds,
        emailMode: draft.emailMode,
      }),
    });
    saving.current = false;
    if (!result.ok) {
      setSaveState('error');
      setSaveError(result.message);
      await reload();
      return;
    }
    setCreated(result.data);
    setSaveState('success');
    setSaveError(null);
    setDraft(emptyDraft());
    await reload();
  }

  if (state.kind === 'unauthorized') return <LoginRequiredState />;

  async function copyRss(subscription: Subscription) {
    if (!subscription.rssUrl) return;
    try {
      await navigator.clipboard.writeText(new URL(subscription.rssUrl, window.location.origin).href);
      setCopiedId(subscription.id);
      setCopyError(null);
    } catch {
      setCopyError('暂时无法复制，请手动选择下方链接。');
    }
  }

  return (
    <>
      <PageHeader
        title="我的订阅"
        description="按站点或栏目创建订阅；选择站点后，之后接入的新栏目不会自动加入。"
        actions={
          <Button type="button" variant="outline" onClick={() => setReloadKey((key) => key + 1)}>
            <RefreshCw aria-hidden="true" />
            刷新状态
          </Button>
        }
      />
      <Alert>
        <AlertTitle>输出通道尚未开放</AlertTitle>
        <AlertDescription>
          订阅配置和私有 RSS 链接可以保存，RSS 内容和邮件投递将在开放后生效。
        </AlertDescription>
      </Alert>
      {state.kind === 'loading' && (
        <PageState state="loading" title="正在读取订阅状态" description="正在获取当前额度、栏目选项和已保存配置。" />
      )}
      {state.kind === 'error' && (
        <PageState
          state="error"
          title="暂时无法读取订阅状态"
          description={`${state.message}已保存配置不会因这次读取失败丢失。`}
          action={<RetryButton onClick={() => setReloadKey((key) => key + 1)} />}
        />
      )}
      {state.kind === 'success' && (
        <div className="feed-subscription-layout">
          <section className="feed-card feed-subscription-form" aria-label="新增订阅">
            <div className="feed-source-heading">
              <div>
                <h2>新增订阅</h2>
                <p>当前额度：{quotaLabel(state.data)}</p>
              </div>
              <span className={`feed-source-state ${canCreate(state.data) ? 'is-ok' : 'is-warning'}`}>
                {canCreate(state.data) ? '可创建' : '暂不能新增'}
              </span>
            </div>
            <form onSubmit={submit}>
              <div className="feed-subscription-field">
                <Label htmlFor="subscription-name">订阅名称</Label>
                <Input
                  id="subscription-name"
                  value={draft.name}
                  maxLength={80}
                  disabled={saveState === 'loading'}
                  autoComplete="off"
                  aria-invalid={saveState === 'error' && !draft.name.trim()}
                  onChange={(event) => editDraft({ name: event.target.value })}
                />
              </div>
              <fieldset className="feed-subscription-field">
                <legend>关注范围</legend>
                <div className="feed-subscription-options">
                  {state.data.sites.map((site) => {
                    const siteSelected = draft.siteIds.includes(site.id);
                    return (
                      <div className="feed-subscription-site" key={site.id}>
                        <label className="feed-subscription-check">
                          <Checkbox
                            checked={siteSelected}
                            disabled={saveState === 'loading'}
                            onCheckedChange={(checked) => toggleSite(site.id, checked === true)}
                          />
                          <span>
                            <strong>{site.name}（整站快照）</strong>
                            <small>创建后新栏目不会自动加入</small>
                          </span>
                        </label>
                        <div className="feed-subscription-sources">
                          {state.data.sources.filter((source) => source.siteId === site.id).map((source) => (
                            <label className="feed-subscription-check" key={source.id}>
                              <Checkbox
                                checked={siteSelected || draft.sourceIds.includes(source.id)}
                                disabled={siteSelected || saveState === 'loading'}
                                onCheckedChange={(checked) => toggleSource(source.id, checked === true)}
                              />
                              <span>{source.name}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </fieldset>
              <div className="feed-subscription-field">
                <Label htmlFor="subscription-email-mode">邮件模式</Label>
                <Select
                  value={draft.emailMode}
                  disabled={saveState === 'loading'}
                  onValueChange={(value) => {
                    if (value === 'off' || value === 'immediate' || value === 'daily_digest') {
                      editDraft({ emailMode: value });
                    }
                  }}
                >
                  <SelectTrigger id="subscription-email-mode" aria-label="邮件模式">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily_digest">每日摘要（默认）</SelectItem>
                    <SelectItem value="immediate">及时提醒</SelectItem>
                    <SelectItem value="off">不发送邮件</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {saveError && (
                <Alert variant="destructive">
                  <AlertTitle>保存结果未确认</AlertTitle>
                  <AlertDescription>
                    {saveError}
                    {' 可重试确认本次保存，已保存的订阅不会重复创建。'}
                  </AlertDescription>
                </Alert>
              )}
              <div className="feed-card-actions">
                <ActionButton
                  type="submit"
                  state={saveState}
                  disabled={(!canCreate(state.data) && saveState !== 'error') || state.data.sources.length === 0}
                  labels={{ idle: '创建订阅', loading: '正在保存…', success: '已保存', error: '重试保存' }}
                />
                {!canCreate(state.data) && (
                  <p className="feed-subscription-note">
                    {state.data.policy.status === 'auth_unavailable'
                      ? 'Auth 暂不可用，不能确认创建额度。'
                      : '当前 Auth 未授予可新增的订阅额度。'}
                  </p>
                )}
                {state.data.sources.length === 0 && (
                  <p className="feed-subscription-note">还没有可订阅的已验证栏目。</p>
                )}
              </div>
            </form>
          </section>

          <section className="feed-subscription-list" aria-label="已保存订阅">
            {copyError && <p role="alert">{copyError}</p>}
            {created && (
              <Alert>
                <AlertTitle>已保存「{created.subscription.name}」</AlertTitle>
                <AlertDescription>当前范围包含 {created.subscription.targets.length} 个栏目，私有 RSS 链接可在下方随时查看。</AlertDescription>
              </Alert>
            )}
            {state.data.subscriptions.length === 0 && !created ? (
              <div className="feed-card">
                <div className="feed-subscription-empty">
                  <BellPlus aria-hidden="true" />
                  <div>
                    <h3>还没有订阅</h3>
                    <p>创建第一组订阅后，这里会显示目标快照和运行状态。</p>
                  </div>
                </div>
              </div>
            ) : (
              state.data.subscriptions.map((subscription) => (
                <article className="feed-card feed-subscription-card" key={subscription.id}>
                  <div className="feed-source-heading">
                    <div>
                      <h2>{subscription.name}</h2>
                      <p>创建时间：{formatDateTime(subscription.createdAt)}</p>
                    </div>
                    <span className={`feed-source-state ${statusClass(subscription.effectiveStatus)}`}>
                      {statusLabels.get(subscription.effectiveStatus)}
                    </span>
                  </div>
                  <dl className="feed-source-meta">
                    <div>
                      <dt>栏目快照</dt>
                      <dd>{subscription.targets.map((target) => target.sourceName).join('、')}</dd>
                    </div>
                    <div>
                      <dt>邮件模式</dt>
                      <dd>{emailModeLabels.get(subscription.emailMode)}</dd>
                    </div>
                    <div>
                      <dt>启用意愿</dt>
                      <dd>{subscription.requestedEnabled ? '启用' : '暂停'}</dd>
                    </div>
                  </dl>
                  {subscription.rssUrl && (
                    <div className="feed-subscription-token">
                      <Label htmlFor={`rss-${subscription.id}`}>私有 RSS 链接</Label>
                      <Input id={`rss-${subscription.id}`} readOnly value={new URL(subscription.rssUrl, window.location.origin).href} />
                      <Button type="button" variant="outline" onClick={() => copyRss(subscription)}>
                        <Copy aria-hidden="true" />
                        {copiedId === subscription.id ? '已复制' : '复制链接'}
                      </Button>
                    </div>
                  )}
                </article>
              ))
            )}
          </section>
        </div>
      )}
    </>
  );
}
