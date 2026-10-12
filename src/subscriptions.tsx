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
  parseSubscriptionChange,
  parseSubscriptionList,
  requestJson,
  type Subscription,
  type SubscriptionCreateResponse,
  type SubscriptionList,
} from './api';
import { LoginRequiredState, RetryButton, formatDateTime } from './components';
import { SubscriptionActivity } from './subscription-activity';

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
  ['deleted', '已删除'],
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

type EditDraft = Pick<Subscription, 'name' | 'emailMode' | 'requestedEnabled' | 'priority'> & {
  sourceIds: string[];
};
type Mutation = { path: string; method: string; body: Record<string, unknown> };

function SubscriptionCard({ subscription, data, onChanged }: {
  subscription: Subscription; data: SubscriptionList; onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EditDraft>(() => editable(subscription));
  const [save, setSave] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'delete' | 'rotate' | 'revoke' | null>(null);
  const [pending, setPending] = useState<Mutation | null>(null);
  const busy = useRef(false);
  const [copied, setCopied] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const base = `/api/subscriptions/${subscription.id}`;
  const deleted = subscription.deletedAt !== null;
  const availableIds = new Set(data.sources.map(source => source.id));
  const options = [
    ...data.sources.map(source => {
      const siteName = data.sites.find(site => site.id === source.siteId)?.name;
      return { id: source.id, name: !siteName || siteName === source.name ? source.name : `${siteName} · ${source.name}` };
    }),
    ...subscription.targets.filter(target => !availableIds.has(target.sourceId))
      .map(target => ({ id: target.sourceId, name: `${target.sourceName}（暂不可新增）` })),
    ...(deleted ? subscription.savedSourceIds.filter(id => !availableIds.has(id))
      .map(id => ({ id, name: '已停用的原栏目（恢复前请移除或改选）' })) : []),
  ];

  function editable(value: Subscription): EditDraft {
    return { name: value.name, emailMode: value.emailMode, requestedEnabled: value.requestedEnabled,
      priority: value.priority, sourceIds: value.deletedAt ? value.savedSourceIds : value.targetSourceIds };
  }
  function edit(changes: Partial<EditDraft>) {
    if (busy.current) return;
    setDraft(current => ({ ...current, ...changes }));
    setPending(null); setError(null); setSave('idle');
  }
  function operation(path: string, method: string, changes: Record<string, unknown> = {}): Mutation {
    return { path, method, body: { requestId: crypto.randomUUID(), expectedVersion: subscription.version, ...changes } };
  }
  async function run(mutation: Mutation) {
    if (busy.current) return;
    busy.current = true; setPending(mutation); setSave('loading'); setError(null); setMessage(null);
    const result = await requestJson(mutation.path, parseSubscriptionChange, {
      method: mutation.method, body: JSON.stringify(mutation.body),
    });
    busy.current = false;
    if (!result.ok) {
      setSave('error'); setError(result.message);
      if (result.status >= 400 && result.status < 500) setPending(null);
      return;
    }
    setSave('success'); setPending(null); setConfirm(null); setEditing(false); setCopied(false);
    setMessage('修改已保存。');
    await onChanged();
  }
  async function copy() {
    if (!subscription.rssUrl) return;
    try {
      await navigator.clipboard.writeText(new URL(subscription.rssUrl, window.location.origin).href);
      setCopied(true); setMessage('RSS 链接已复制。');
    } catch { setError('暂时无法复制，请手动选择链接。'); }
  }
  function saveEdit(event: FormEvent) {
    event.preventDefault();
    if (!draft.name.trim() || !draft.sourceIds.length || !Number.isSafeInteger(draft.priority) || draft.priority < 0) {
      setError('请填写名称、至少选择一个栏目，并使用非负整数优先级。'); return;
    }
    void run(pending ?? operation(deleted ? `${base}/restore` : base, deleted ? 'POST' : 'PATCH', draft));
  }
  const emailStatus = subscription.emailStatus === 'mail_off' ? '邮件已关闭'
    : subscription.emailStatus === 'email_unverified' ? '邮箱未验证，邮件暂停；RSS 不受影响'
      : statusLabels.get(subscription.emailStatus);
  return (
    <article className="feed-card feed-subscription-card" aria-label={`订阅：${subscription.name}`}>
      <div className="feed-source-heading">
        <div><h2>{subscription.name}</h2><p>创建时间：{formatDateTime(subscription.createdAt)}</p></div>
        <span className={`feed-source-state ${statusClass(subscription.effectiveStatus)}`}>{statusLabels.get(subscription.effectiveStatus)}</span>
      </div>
      <dl className="feed-source-meta">
        <div><dt>关注栏目</dt><dd>{deleted ? '配置已保留，恢复后重新生效' : subscription.targets.map(target => target.sourceName).join('、')}</dd></div>
        <div><dt>邮件</dt><dd>{emailModeLabels.get(subscription.emailMode)} · {emailStatus}</dd></div>
        <div><dt>运行优先级</dt><dd>{subscription.priority} · {subscription.requestedEnabled ? '希望启用' : '主动暂停'}</dd></div>
      </dl>
      {subscription.effectiveStatus === 'quota_exceeded' && <p>配置已保留。编辑优先级可选择额度内保留运行的订阅；数字较小的优先。</p>}
      {subscription.rssStatus === 'rss_revoked' && !deleted && <p>RSS 已撤销。重置链接后可以重新订阅，不影响邮件设置。</p>}
      {!deleted && subscription.rssUrl && (
        <div className="feed-subscription-token">
          <Label htmlFor={`rss-${subscription.id}`}>私有 RSS 链接</Label>
          <Input id={`rss-${subscription.id}`} readOnly value={new URL(subscription.rssUrl, window.location.origin).href} />
          <Button type="button" variant="outline" onClick={copy}><Copy aria-hidden="true" />{copied ? '已复制' : '复制链接'}</Button>
        </div>
      )}
      {editing && (
        <form className="feed-subscription-editor" onSubmit={saveEdit}>
          {deleted && <p>恢复后栏目重新生效，并生成新的 RSS 链接。请检查栏目和启用意愿。</p>}
          <div className="feed-subscription-field">
            <Label htmlFor={`edit-name-${subscription.id}`}>订阅名称</Label>
            <Input id={`edit-name-${subscription.id}`} value={draft.name} maxLength={80} disabled={save === 'loading'} onChange={event => edit({ name: event.target.value })} />
          </div>
          <fieldset className="feed-subscription-field">
            <legend>关注栏目</legend>
            <p>新增栏目从保存时开始生效；移除后再加入也重新计算生效时间。</p>
            {options.map(source => (
              <label className="feed-subscription-check" key={source.id}>
                <Checkbox checked={draft.sourceIds.includes(source.id)} disabled={save === 'loading'}
                  onCheckedChange={checked => edit({ sourceIds: checked ? [...draft.sourceIds, source.id] : draft.sourceIds.filter(id => id !== source.id) })} />
                <span>{source.name}</span>
              </label>
            ))}
          </fieldset>
          <div className="feed-subscription-field">
            <Label htmlFor={`edit-mail-${subscription.id}`}>邮件模式</Label>
            <Select value={draft.emailMode} disabled={save === 'loading'} onValueChange={value => {
              if (value === 'off' || value === 'immediate' || value === 'daily_digest') edit({ emailMode: value });
            }}>
              <SelectTrigger id={`edit-mail-${subscription.id}`} aria-label="编辑邮件模式"><SelectValue /></SelectTrigger>
              <SelectContent>{[...emailModeLabels].map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="feed-subscription-field">
            <Label htmlFor={`edit-priority-${subscription.id}`}>运行优先级（数字越小越优先）</Label>
            <Input id={`edit-priority-${subscription.id}`} type="number" min={0} max={1000000000} step={1}
              value={draft.priority} disabled={save === 'loading'} onChange={event => edit({ priority: Number(event.target.value) })} />
            <p>同值时优先保留较早创建的订阅。暂停的订阅仍占创建额度。</p>
          </div>
          <label className="feed-subscription-check"><Checkbox checked={draft.requestedEnabled} disabled={save === 'loading'} onCheckedChange={checked => edit({ requestedEnabled: checked === true })} /><span>希望启用此订阅</span></label>
          <div className="feed-card-actions">
            <ActionButton type="submit" state={save} labels={{ idle: deleted ? '确认恢复订阅' : '保存修改', loading: '正在保存…', success: '已保存', error: '重试保存' }} />
            <Button type="button" variant="outline" disabled={save === 'loading'} onClick={() => { setEditing(false); setPending(null); setError(null); }}>取消编辑</Button>
          </div>
        </form>
      )}
      {!editing && (
        <div className="feed-card-actions">
          {deleted ? <Button type="button" disabled={save === 'loading'} onClick={() => { setDraft(editable(subscription)); setEditing(true); setPending(null); setSave('idle'); setError(null); }}>恢复订阅</Button> : <>
            <Button type="button" variant="outline" disabled={save === 'loading'} onClick={() => { setDraft(editable(subscription)); setEditing(true); setConfirm(null); setPending(null); setSave('idle'); setError(null); }}>编辑订阅</Button>
            <Button type="button" variant="outline" disabled={save === 'loading'} onClick={() => run(operation(base, 'PATCH', { ...editable(subscription), requestedEnabled: !subscription.requestedEnabled }))}>{subscription.requestedEnabled ? '暂停订阅' : '启用订阅'}</Button>
            <Button type="button" variant="outline" disabled={save === 'loading'} onClick={() => setConfirm('rotate')}>重置 RSS</Button>
            {subscription.rssUrl && <Button type="button" variant="outline" disabled={save === 'loading'} onClick={() => setConfirm('revoke')}>撤销 RSS</Button>}
            <Button type="button" variant="outline" disabled={save === 'loading'} onClick={() => setConfirm('delete')}>删除订阅</Button>
          </>}
        </div>
      )}
      {confirm && <Alert>
        <AlertTitle>{confirm === 'delete' ? '删除后停止此订阅的输出' : confirm === 'rotate' ? '重置后旧 RSS 链接立即失效' : '撤销后旧 RSS 链接立即失效'}</AlertTitle>
        <AlertDescription>{confirm === 'delete' ? '配置会保留，可在额度允许时恢复。' : confirm === 'rotate' ? '请用新链接更新阅读器中的订阅。' : '邮件设置保留，之后可重置 RSS 生成新链接。'}</AlertDescription>
        <div className="feed-card-actions">
          <Button type="button" disabled={save === 'loading'} onClick={() => run(operation(confirm === 'delete' ? base : `${base}/rss/${confirm}`, confirm === 'delete' ? 'DELETE' : 'POST'))}>{save === 'loading' ? '正在保存…' : '确认操作'}</Button>
          <Button type="button" variant="outline" disabled={save === 'loading'} onClick={() => setConfirm(null)}>取消</Button>
        </div>
      </Alert>}
      {error && <Alert variant="destructive"><AlertTitle>修改结果未确认</AlertTitle><AlertDescription>{error}</AlertDescription>
        <div className="feed-card-actions">
          {pending && <Button type="button" disabled={save === 'loading'} onClick={() => run(pending)}>重试原操作</Button>}
          <Button type="button" variant="outline" disabled={save === 'loading'} onClick={async () => { setEditing(false); setConfirm(null); setPending(null); setError(null); setSave('idle'); await onChanged(); }}>重新载入</Button>
        </div>
      </Alert>}
      {message && <p role="status">{message}</p>}
      {!deleted && <div className="feed-card-actions">
        <Button type="button" variant="outline" aria-expanded={showActivity} aria-controls={`activity-${subscription.id}`}
          onClick={() => setShowActivity(value => !value)}>{showActivity ? '收起通知记录' : '查看通知记录'}</Button>
      </div>}
      {!deleted && showActivity && <SubscriptionActivity subscriptionId={subscription.id} version={subscription.version} />}
    </article>
  );
}

export function SubscriptionsPage() {
  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [created, setCreated] = useState<SubscriptionCreateResponse | null>(null);
  const saving = useRef(false);

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
      {state.kind === 'success' && (
        <Alert>
          <AlertTitle>{state.data.outputChannels.rss.enabled ? '订阅输出状态' : '输出通道尚未开放'}</AlertTitle>
          <AlertDescription>
            {state.data.outputChannels.rss.enabled
              ? '私有 RSS 会输出标题、摘要和版本链接；正文与附件仍需登录。邮件按订阅设置发送，暂停与投递状态见通知记录。'
              : '订阅配置和私有 RSS 链接可以保存，输出开放后生效。'}
          </AlertDescription>
        </Alert>
      )}
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
                <SubscriptionCard key={subscription.id} subscription={subscription} data={state.data} onChanged={reload} />
              ))
            )}
          </section>
        </div>
      )}
    </>
  );
}
