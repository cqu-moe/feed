import './subscriptions.css';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ActionButton,
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Label,
  PageHeader,
  PageState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@cqu-moe/ui';
import {
  Bell,
  Check,
  Copy,
  Mail,
  MoreHorizontal,
  Pause,
  Pencil,
  Plus,
  RefreshCw,
  Rss,
  Trash2,
} from 'lucide-react';
import {
  parseSubscriptionChange,
  parseSubscriptionCreate,
  parseSubscriptionList,
  requestJson,
  type ApiResult,
  type Subscription,
  type SubscriptionCreateResponse,
  type SubscriptionList,
} from './api';
import { LoginRequiredState, RetryButton, formatDateTime } from './components';
import { SubscriptionActivity } from './subscription-activity';
import { captureFeedEvent } from './telemetry';

type ListState =
  | { kind: 'loading' }
  | { kind: 'success'; data: SubscriptionList; refreshError?: string }
  | { kind: 'error'; message: string }
  | { kind: 'unauthorized' };

type Draft = {
  requestId: string;
  name: string;
  siteIds: string[];
  sourceIds: string[];
  emailMode: 'off' | 'immediate' | 'daily_digest';
};

type EditDraft = Pick<Subscription, 'name' | 'emailMode' | 'requestedEnabled' | 'priority'> & {
  sourceIds: string[];
};

type SaveState = 'idle' | 'loading' | 'success' | 'error';
type SubscriptionFilter = 'all' | 'active' | 'paused' | 'deleted';
type ConfirmAction = 'delete' | 'rotate' | 'revoke';
type Mutation = { path: string; method: string; body: Record<string, unknown> };
type SubscriptionMutationData = {
  created?: boolean;
  changed?: boolean;
  subscription: Subscription;
};
type SubscriptionOperation = 'create' | 'update' | 'delete' | 'restore' | 'rss_rotate' | 'rss_revoke';

const emailModeLabels = new Map([
  ['off', '不发送邮件'],
  ['immediate', '及时提醒'],
  ['daily_digest', '每日摘要'],
] as const);

const statusLabels = new Map([
  ['active', '运行中'],
  ['paused', '已暂停'],
  ['access_revoked', '缺少访问权益'],
  ['quota_exceeded', '超出当前额度'],
  ['auth_unavailable', 'Auth 暂不可用'],
  ['deleted', '已删除'],
] as const);

const filterLabels = new Map([
  ['all', '全部'],
  ['active', '运行中'],
  ['paused', '已暂停'],
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

function listFromResult(
  result: Awaited<ReturnType<typeof requestJson<SubscriptionList>>>,
  current?: ListState,
): ListState {
  if (result.ok) return { kind: 'success', data: result.data };
  if (result.status === 401) return { kind: 'unauthorized' };
  if (current?.kind === 'success') return { ...current, refreshError: result.message };
  return { kind: 'error', message: result.message };
}

function quotaLabel(data: SubscriptionList): string {
  const policy = data.policy;
  if (policy.status !== 'available') return `${data.usage} 个 / Auth 暂不可用`;
  if (!policy.access) return `${data.usage} 个 / 缺少 feed.access`;
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

function isRetryableFailure(status: number): boolean {
  return status === 0 || status >= 500;
}

function statusTone(status: Subscription['effectiveStatus']): string {
  if (status === 'active') return 'is-ok';
  if (status === 'paused' || status === 'auth_unavailable') return 'is-warning';
  return 'is-error';
}

function emailStatusLabel(status: Subscription['emailStatus']): string {
  if (status === 'mail_off') return '邮件已关闭';
  if (status === 'email_unverified') return '邮箱未验证，邮件暂停';
  return statusLabels.get(status) ?? '邮件状态待确认';
}

function rssStatusLabel(status: Subscription['rssStatus']): string {
  if (status === 'rss_revoked') return 'RSS 已撤销';
  return statusLabels.get(status) ?? 'RSS 状态待确认';
}

function sourceSummary(subscription: Subscription): string {
  if (subscription.deletedAt !== null) return '配置已保留，恢复后重新生效';
  const names = subscription.targets.map(target => target.sourceName);
  return names.length ? names.join('、') : '当前没有生效栏目';
}

function subscriptionOperation(mutation: Mutation): SubscriptionOperation {
  if (mutation.method === 'DELETE') return 'delete';
  if (mutation.path.endsWith('/restore')) return 'restore';
  if (mutation.path.endsWith('/rss/rotate')) return 'rss_rotate';
  if (mutation.path.endsWith('/rss/revoke')) return 'rss_revoke';
  return 'update';
}

function captureSubscriptionResult(
  operation: SubscriptionOperation,
  requestId: string,
  startedAt: number,
  attemptId: string,
  result: ApiResult<SubscriptionMutationData>,
  subscriptionId: string | null,
): void {
  const properties = result.ok
    ? {
        operation,
        flow: 'subscription',
        stage: 'finished',
        outcome: 'success',
        operation_id: requestId,
        attempt_id: attemptId,
        subscription_id: result.data.subscription.id,
        no_op: !result.data.changed,
        duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
        duration_basis: 'subscription_attempt_request_to_authoritative_response',
      }
    : {
        operation,
        flow: 'subscription',
        stage: 'finished',
        outcome: 'failure',
        operation_id: requestId,
        attempt_id: attemptId,
        error_code: result.status === 0 ? 'network_failed' : `http_${result.status}`,
        ...(subscriptionId ? { subscription_id: subscriptionId } : {}),
        duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
        duration_basis: 'subscription_attempt_request_to_authoritative_response',
      };
  captureFeedEvent('feed_subscription_finished', properties);
}

function editable(value: Subscription): EditDraft {
  return {
    name: value.name,
    emailMode: value.emailMode,
    requestedEnabled: value.requestedEnabled,
    priority: value.priority,
    sourceIds: value.deletedAt !== null ? value.savedSourceIds : value.targetSourceIds,
  };
}

function sourceName(source: SubscriptionList['sources'][number], sites: SubscriptionList['sites']): string {
  const siteName = sites.find(site => site.id === source.siteId)?.name;
  return !siteName || siteName === source.name ? source.name : `${siteName} · ${source.name}`;
}

function SubscriptionRow({ subscription, data, onChanged }: {
  subscription: Subscription;
  data: SubscriptionList;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EditDraft>(() => editable(subscription));
  const [save, setSave] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const [pending, setPending] = useState<Mutation | null>(null);
  const [failureStatus, setFailureStatus] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [rssOpen, setRssOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const busy = useRef(false);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const restoreTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sheetTitleRef = useRef<HTMLHeadingElement | null>(null);
  const overlayFocusRef = useRef<HTMLElement | null>(null);
  const base = `/api/subscriptions/${subscription.id}`;
  const deleted = subscription.deletedAt !== null;
  const availableIds = new Set(data.sources.map(source => source.id));
  const options = [
    ...data.sources.map(source => ({
      id: source.id,
      name: sourceName(source, data.sites),
      note: '可订阅',
    })),
    ...subscription.targets
      .filter(target => !availableIds.has(target.sourceId))
      .map(target => ({ id: target.sourceId, name: target.sourceName, note: '暂不可新增，可继续保留' })),
    ...(deleted
      ? subscription.savedSourceIds
          .filter(id => !availableIds.has(id))
          .map(id => ({ id, name: '已停用的原栏目', note: '恢复前请移除或改选' }))
      : []),
  ];

  function rememberFocus(trigger: HTMLElement | null) {
    overlayFocusRef.current = trigger?.isConnected ? trigger : menuTriggerRef.current;
  }

  function focusOverlayTrigger(event: Event) {
    event.preventDefault();
    const target = overlayFocusRef.current?.isConnected ? overlayFocusRef.current : menuTriggerRef.current;
    target?.focus();
  }

  function focusSheetTitle(event: Event) {
    event.preventDefault();
    sheetTitleRef.current?.focus();
  }

  function openEditor(trigger: HTMLElement | null = menuTriggerRef.current) {
    if (busy.current || pending !== null) return;
    rememberFocus(trigger);
    setDraft(editable(subscription));
    setPending(null);
    setSave('idle');
    setError(null);
    setConfirm(null);
    setEditing(true);
  }

  function edit(changes: Partial<EditDraft>) {
    if (busy.current || pending !== null) return;
    setDraft(current => ({ ...current, ...changes }));
    setSave('idle');
    setError(null);
  }

  function operation(path: string, method: string, changes: Record<string, unknown> = {}): Mutation {
    return {
      path,
      method,
      body: {
        requestId: crypto.randomUUID(),
        expectedVersion: subscription.version,
        ...changes,
      },
    };
  }

  async function run(mutation: Mutation) {
    if (busy.current) return;
    const startedAt = performance.now();
    const attemptId = crypto.randomUUID();
    busy.current = true;
    setPending(mutation);
    setSave('loading');
    setError(null);
    setMessage(null);
    const result = await requestJson(mutation.path, parseSubscriptionChange, {
      method: mutation.method,
      body: JSON.stringify(mutation.body),
    });
    busy.current = false;
    captureSubscriptionResult(
      subscriptionOperation(mutation),
      String(mutation.body.requestId),
      startedAt,
      attemptId,
      result,
      subscription.id,
    );
    if (!result.ok) {
      setFailureStatus(result.status);
      setSave('error');
      setError(result.message);
      if (result.status >= 400 && result.status < 500) setPending(null);
      return;
    }
    setFailureStatus(null);
    setSave('success');
    setPending(null);
    setConfirm(null);
    setEditing(false);
    setRssOpen(false);
    setCopied(false);
    setMessage('修改已保存。');
    await onChanged();
  }

  function saveEdit(event: FormEvent) {
    event.preventDefault();
    if (
      !draft.name.trim() ||
      !draft.sourceIds.length ||
      !Number.isSafeInteger(draft.priority) ||
      draft.priority < 0
    ) {
      setSave('error');
      setError('请填写名称、至少选择一个栏目，并使用非负整数优先级。');
      return;
    }
    void run(
      pending ??
        operation(
          deleted ? `${base}/restore` : base,
          deleted ? 'POST' : 'PATCH',
          draft,
        ),
    );
  }

  async function copyRss() {
    if (!subscription.rssUrl) return;
    try {
      await navigator.clipboard.writeText(new URL(subscription.rssUrl, window.location.origin).href);
      setCopied(true);
      setMessage('RSS 链接已复制。');
    } catch {
      setError('暂时无法复制，请手动选择链接。');
    }
  }

  const emailStatus = emailStatusLabel(subscription.emailStatus);
  const rssStatus = rssStatusLabel(subscription.rssStatus);
  const confirmCopy = confirm === 'delete'
    ? {
      title: '删除后停止此订阅的输出',
      description: '配置会保留，可在额度允许时恢复。删除后旧 RSS 链接立即失效。',
      action: '确认删除',
    }
    : confirm === 'rotate'
      ? {
        title: '重置后旧 RSS 链接立即失效',
        description: '请用新链接更新阅读器中的订阅。邮件设置不受影响。',
        action: '生成新链接',
      }
      : {
        title: '撤销后旧 RSS 链接立即失效',
        description: '邮件设置保留。之后可重置 RSS 生成新链接。',
        action: '确认撤销',
      };

  return (
    <article className="feed-subs-row" aria-label={`订阅：${subscription.name}`}>
      <div className="feed-subs-identity">
        <span className="feed-subs-icon" aria-hidden="true">
          <Bell />
        </span>
        <div className="feed-subs-title">
          <h2>
            <Button
              type="button"
              variant="link"
              className="feed-subs-title-button"
              aria-label={`编辑订阅：${subscription.name}`}
              onClick={event => openEditor(event.currentTarget)}
              disabled={save === 'loading' || pending !== null}
            >
              {subscription.name}
            </Button>
          </h2>
          <p>{sourceSummary(subscription)}</p>
          <dl>
            <div>
              <dt>优先级</dt>
              <dd>{subscription.priority}</dd>
            </div>
            <div>
              <dt>创建时间</dt>
              <dd>{formatDateTime(subscription.createdAt)}</dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="feed-subs-delivery">
        <Mail aria-hidden="true" />
        <div>
          <strong>{emailModeLabels.get(subscription.emailMode)}</strong>
          <small>{emailStatus}</small>
        </div>
      </div>

      <div className="feed-subs-state">
        <span className={`feed-subs-badge ${statusTone(subscription.effectiveStatus)}`}>
          {statusLabels.get(subscription.effectiveStatus)}
        </span>
        <small>{deleted ? '配置保留' : subscription.requestedEnabled ? '希望启用' : '主动暂停'}</small>
      </div>

      <div className="feed-subs-actions">
        {deleted ? (
          <Button
            type="button"
            ref={restoreTriggerRef}
            onClick={event => openEditor(event.currentTarget)}
            disabled={save === 'loading' || pending !== null}
          >
            恢复订阅
          </Button>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                ref={menuTriggerRef}
                variant="ghost"
                size="icon"
                aria-label={`更多操作：${subscription.name}`}
                disabled={save === 'loading' || pending !== null}
              >
                <MoreHorizontal aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => openEditor(menuTriggerRef.current)}>
                <Pencil aria-hidden="true" />
                编辑订阅
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  rememberFocus(menuTriggerRef.current);
                  void run(operation(base, 'PATCH', {
                    ...editable(subscription),
                    requestedEnabled: !subscription.requestedEnabled,
                  }));
                }}
              >
                <Pause aria-hidden="true" />
                {subscription.requestedEnabled ? '暂停订阅' : '启用订阅'}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  rememberFocus(menuTriggerRef.current);
                  setActivityOpen(true);
                }}
              >
                <Mail aria-hidden="true" />
                通知记录
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  rememberFocus(menuTriggerRef.current);
                  setCopied(false);
                  setRssOpen(true);
                }}
              >
                <Rss aria-hidden="true" />
                查看 RSS 链接
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  rememberFocus(menuTriggerRef.current);
                  setConfirm('rotate');
                }}
              >
                <RefreshCw aria-hidden="true" />
                重置 RSS
              </DropdownMenuItem>
              {subscription.rssUrl && (
                <DropdownMenuItem
                  onSelect={() => {
                    rememberFocus(menuTriggerRef.current);
                    setConfirm('revoke');
                  }}
                >
                  撤销 RSS
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => {
                    rememberFocus(menuTriggerRef.current);
                  setConfirm('delete');
                }}
              >
                <Trash2 aria-hidden="true" />
                删除订阅
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <div className="feed-subs-boundaries">
        {subscription.effectiveStatus === 'quota_exceeded' && (
          <span>配置已保留。调低优先级数字可选择额度内保留运行的订阅。</span>
        )}
        {subscription.rssStatus === 'rss_revoked' && !deleted && <span>{rssStatus}；可重置生成新链接。</span>}
        {subscription.emailStatus === 'email_unverified' && <span>邮箱未验证，邮件暂停；RSS 不受影响。</span>}
        {!data.outputChannels.rss.enabled && <span>RSS 输出通道暂未开放。</span>}
        {!data.outputChannels.email.enabled && <span>邮件输出通道暂未开放，设置会保留。</span>}
      </div>

      {message && <p className="feed-subs-message" role="status">{message}</p>}
      {error && !editing && !confirm && (
        <Alert className="feed-subs-alert" variant="destructive">
          <AlertTitle>修改结果未确认</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
          <div className="feed-subs-alert-actions">
            {pending && (
              <Button type="button" disabled={save === 'loading'} onClick={() => void run(pending)}>
                重试原操作
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={save === 'loading'}
              onClick={async () => {
                setEditing(false);
                setConfirm(null);
                setPending(null);
                setFailureStatus(null);
                setError(null);
                setSave('idle');
                await onChanged();
              }}
            >
              重新载入
            </Button>
          </div>
        </Alert>
      )}

      <Sheet
        open={editing}
        onOpenChange={open => {
          if (!open && (save === 'loading' || (pending !== null && failureStatus !== null && isRetryableFailure(failureStatus)))) return;
          if (!open) {
            setEditing(false);
            setPending(null);
            setFailureStatus(null);
            setSave('idle');
            setError(null);
          }
        }}
      >
        <SheetContent
          className="feed-subs-sheet"
          data-feed-sensitive
          onOpenAutoFocus={focusSheetTitle}
          onCloseAutoFocus={focusOverlayTrigger}
        >
          <SheetHeader>
            <SheetTitle ref={sheetTitleRef} tabIndex={-1}>
              {deleted ? '恢复订阅' : '编辑订阅'}
            </SheetTitle>
            <SheetDescription>
              {deleted
                ? '检查原配置后恢复；恢复会生成新的私有 RSS 链接。'
                : '调整关注栏目、邮件模式和运行设置。'}
            </SheetDescription>
          </SheetHeader>
          <form className="feed-subs-form" onSubmit={saveEdit}>
            {deleted && (
              <Alert>
                <AlertTitle>恢复前请检查栏目</AlertTitle>
                <AlertDescription>
                  已停用且仍被选中的栏目会导致恢复失败；请先移除或改选当前可用栏目。
                </AlertDescription>
              </Alert>
            )}
            <div className="feed-subs-field">
              <Label htmlFor={`edit-name-${subscription.id}`}>订阅名称</Label>
              <Input
                id={`edit-name-${subscription.id}`}
                value={draft.name}
                maxLength={80}
                disabled={save === 'loading' || pending !== null}
                aria-invalid={save === 'error' && !draft.name.trim()}
                onChange={event => edit({ name: event.target.value })}
              />
            </div>

            <fieldset className="feed-subs-field feed-subs-sources">
              <legend>关注栏目</legend>
              <p id={`edit-sources-help-${subscription.id}`}>
                新增栏目从保存时开始生效；移除后再加入也重新计算生效时间。
              </p>
              {options.map(source => (
                <label className="feed-subs-check" key={source.id}>
                  <Checkbox
                    checked={draft.sourceIds.includes(source.id)}
                    disabled={save === 'loading' || pending !== null}
                    aria-describedby={`edit-sources-help-${subscription.id}`}
                    onCheckedChange={checked =>
                      edit({
                        sourceIds: checked
                          ? [...new Set([...draft.sourceIds, source.id])]
                          : draft.sourceIds.filter(id => id !== source.id),
                      })
                    }
                  />
                  <span>
                    <strong>{source.name}</strong>
                    <small>{source.note}</small>
                  </span>
                </label>
              ))}
            </fieldset>

            <div className="feed-subs-field">
              <Label htmlFor={`edit-mail-${subscription.id}`}>邮件模式</Label>
              <Select
                value={draft.emailMode}
                disabled={save === 'loading' || pending !== null}
                onValueChange={value => {
                  if (value === 'off' || value === 'immediate' || value === 'daily_digest') {
                    edit({ emailMode: value });
                  }
                }}
              >
                <SelectTrigger id={`edit-mail-${subscription.id}`} aria-label="邮件模式">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[...emailModeLabels].map(([value, label]) => (
                    <SelectItem key={value} value={value}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p>RSS 与邮件分别管理。关闭邮件后，仍可通过 RSS 阅读。</p>
            </div>

            <details className="feed-subs-advanced">
              <summary>运行设置</summary>
              <div className="feed-subs-field">
                <Label htmlFor={`edit-priority-${subscription.id}`}>运行优先级（数字越小越优先）</Label>
                <Input
                  id={`edit-priority-${subscription.id}`}
                  type="number"
                  min={0}
                  max={1000000000}
                  step={1}
                  value={draft.priority}
                  disabled={save === 'loading' || pending !== null}
                  aria-invalid={save === 'error' && (!Number.isSafeInteger(draft.priority) || draft.priority < 0)}
                  onChange={event => edit({ priority: Number(event.target.value) })}
                />
                <p>额度不足时优先运行数字较小的订阅；同值时优先保留较早创建的订阅。暂停的订阅仍占创建额度。</p>
              </div>
              <label className="feed-subs-check">
                <Checkbox
                  checked={draft.requestedEnabled}
                  disabled={save === 'loading' || pending !== null}
                  onCheckedChange={checked => edit({ requestedEnabled: checked === true })}
                />
                <span>希望启用此订阅</span>
              </label>
            </details>

            {error && (
              <Alert variant="destructive">
                <AlertTitle>保存结果未确认</AlertTitle>
                <AlertDescription>
                  {error}
                  {pending && ' 可重试确认本次保存；同一保存请求不会重复修改。'}
                </AlertDescription>
              </Alert>
            )}

            <div className="feed-subs-form-actions">
              <Button
                type="button"
                variant="outline"
                disabled={save === 'loading' || (pending !== null && failureStatus !== null && isRetryableFailure(failureStatus))}
                onClick={() => setEditing(false)}
              >
                取消
              </Button>
              <ActionButton
                type="submit"
                state={save}
                labels={{
                  idle: deleted ? '确认恢复订阅' : '保存修改',
                  loading: '正在保存…',
                  success: '已保存',
                  error: pending ? '重试保存' : '重新保存',
                }}
              />
            </div>
          </form>
        </SheetContent>
      </Sheet>

      <Dialog open={confirm !== null} onOpenChange={open => {
        if (!open && save !== 'loading') setConfirm(null);
      }}>
        <DialogContent className="feed-subs-dialog" data-feed-sensitive onCloseAutoFocus={focusOverlayTrigger}>
          <DialogHeader>
            <DialogTitle>{confirmCopy.title}</DialogTitle>
            <DialogDescription>{confirmCopy.description}</DialogDescription>
          </DialogHeader>
          {error && confirm && (
            <Alert variant="destructive">
              <AlertTitle>操作结果未确认</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="feed-subs-dialog-actions">
            <Button type="button" variant="outline" disabled={save === 'loading'} onClick={() => setConfirm(null)}>
              取消
            </Button>
            <Button
              type="button"
              variant={confirm === 'rotate' ? 'default' : 'destructive'}
              disabled={save === 'loading'}
              onClick={() => {
                if (!confirm) return;
                void run(
                  pending ??
                    operation(
                      confirm === 'delete' ? base : `${base}/rss/${confirm}`,
                      confirm === 'delete' ? 'DELETE' : 'POST',
                    ),
                );
              }}
            >
              {save === 'loading' ? '正在保存…' : confirmCopy.action}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={rssOpen} onOpenChange={open => {
        if (!open && save !== 'loading') {
          setRssOpen(false);
          setCopied(false);
        }
      }}>
        <DialogContent className="feed-subs-dialog" data-feed-sensitive onCloseAutoFocus={focusOverlayTrigger}>
          <DialogHeader>
            <DialogTitle>添加到 RSS 阅读器</DialogTitle>
            <DialogDescription>
              {subscription.name} · {rssStatus}
            </DialogDescription>
          </DialogHeader>
          {subscription.rssUrl ? (
            <div className="feed-subs-field">
              <Label htmlFor={`rss-${subscription.id}`}>私有 RSS 链接</Label>
              <Input
                id={`rss-${subscription.id}`}
                readOnly
                value={new URL(subscription.rssUrl, window.location.origin).href}
                onFocus={event => event.target.select()}
              />
              <Button type="button" onClick={() => void copyRss()}>
                {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                {copied ? '已复制' : '复制链接'}
              </Button>
            </div>
          ) : (
            <div className="feed-subs-revoke-help">
              <p>RSS 已撤销。重置链接后可以重新订阅，不影响邮件设置。</p>
              <Button
                type="button"
                onClick={() => {
                  setRssOpen(false);
                  setConfirm('rotate');
                }}
              >
                <RefreshCw aria-hidden="true" />
                重置 RSS
              </Button>
            </div>
          )}
          <p className="feed-subs-note">私有 RSS 输出标题、摘要和版本链接；正文与附件仍需登录。</p>
          {!data.outputChannels.rss.enabled && (
            <Alert>
              <AlertTitle>RSS 输出暂未开放</AlertTitle>
              <AlertDescription>链接和订阅配置会保存，输出开放后生效。</AlertDescription>
            </Alert>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={activityOpen} onOpenChange={open => {
        if (!open) setActivityOpen(false);
      }}>
        <DialogContent
          className="feed-subs-dialog feed-subs-activity-dialog"
          data-feed-sensitive
          onCloseAutoFocus={focusOverlayTrigger}
        >
          <DialogHeader>
            <DialogTitle>通知记录</DialogTitle>
            <DialogDescription>{subscription.name} · 最近的匹配与邮件投递记录</DialogDescription>
          </DialogHeader>
          <SubscriptionActivity subscriptionId={subscription.id} version={subscription.version} />
        </DialogContent>
      </Dialog>
    </article>
  );
}

export function SubscriptionsPage() {
  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [filter, setFilter] = useState<SubscriptionFilter>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [failureStatus, setFailureStatus] = useState<number | null>(null);
  const [created, setCreated] = useState<SubscriptionCreateResponse | null>(null);
  const saving = useRef(false);
  const createTriggerRef = useRef<HTMLElement | null>(null);
  const createTitleRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setState(current => (current.kind === 'success' ? current : { kind: 'loading' }));
    requestJson('/api/subscriptions', parseSubscriptionList, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setState(current => listFromResult(result, current));
    });
    return () => controller.abort();
  }, [reloadKey]);

  function editDraft(changes: Partial<Omit<Draft, 'requestId'>>) {
    if (saving.current) return;
    setDraft(current => ({ ...current, ...changes, requestId: crypto.randomUUID() }));
    setSaveState('idle');
    setSaveError(null);
    setFailureStatus(null);
  }

  function toggleSite(siteId: string, checked: boolean) {
    editDraft({
      siteIds: checked
        ? [...new Set([...draft.siteIds, siteId])]
        : draft.siteIds.filter(id => id !== siteId),
    });
  }

  function toggleSource(sourceId: string, checked: boolean) {
    editDraft({
      sourceIds: checked
        ? [...new Set([...draft.sourceIds, sourceId])]
        : draft.sourceIds.filter(id => id !== sourceId),
    });
  }

  async function reload() {
    const controller = new AbortController();
    const result = await requestJson('/api/subscriptions', parseSubscriptionList, { signal: controller.signal });
    if (!controller.signal.aborted) setState(current => listFromResult(result, current));
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
    const startedAt = performance.now();
    const attemptId = crypto.randomUUID();
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
    const mutationResult: ApiResult<SubscriptionMutationData> = result.ok
      ? { ok: true, data: { changed: result.data.created, subscription: result.data.subscription } }
      : { ok: false, status: result.status, message: result.message };
    captureSubscriptionResult('create', draft.requestId, startedAt, attemptId, mutationResult, null);
    if (!result.ok) {
      setFailureStatus(result.status);
      setSaveState('error');
      setSaveError(result.message);
      await reload();
      return;
    }
    setFailureStatus(null);
    setCreated(result.data);
    setCreateOpen(false);
    setSaveState('success');
    setSaveError(null);
    setDraft(emptyDraft());
    await reload();
  }

  function openCreate(trigger?: HTMLElement | null) {
    if (trigger) createTriggerRef.current = trigger;
    setDraft(emptyDraft());
    setSaveState('idle');
    setSaveError(null);
    setFailureStatus(null);
    setCreateOpen(true);
  }

  function focusCreateSheetTitle(event: Event) {
    event.preventDefault();
    createTitleRef.current?.focus();
  }

  function focusCreateTrigger(event: Event) {
    event.preventDefault();
    createTriggerRef.current?.focus();
  }

  if (state.kind === 'unauthorized') return <LoginRequiredState />;

  const data = state.kind === 'success' ? state.data : null;
  const visibleSubscriptions = data?.subscriptions.filter(subscription => {
    if (filter === 'deleted') return subscription.deletedAt !== null;
    if (subscription.deletedAt !== null) return false;
    if (filter === 'active') return subscription.effectiveStatus === 'active';
    if (filter === 'paused') return subscription.effectiveStatus === 'paused';
    return true;
  }) ?? [];
  const createBlocked = data ? !canCreate(data) || data.sources.length === 0 : false;
  const retryableCreateFailure = failureStatus !== null && isRetryableFailure(failureStatus);

  return (
    <>
      <PageHeader
        title="我的订阅"
        description="按站点或栏目创建订阅；选择站点后，之后接入的新栏目不会自动加入。"
        actions={
          <>
            <Button type="button" variant="outline" onClick={() => {
              setCreated(null);
              setReloadKey(key => key + 1);
            }}>
              <RefreshCw aria-hidden="true" />
              刷新状态
            </Button>
            <Button
              type="button"
              onClick={event => openCreate(event.currentTarget)}
              disabled={!data || createBlocked}
            >
              <Plus aria-hidden="true" />
              新建订阅
            </Button>
          </>
        }
      />

      {state.kind === 'loading' && (
        <PageState
          state="loading"
          title="正在读取订阅状态"
          description="正在获取当前额度、栏目选项和已保存配置。"
        />
      )}
      {state.kind === 'error' && (
        <PageState
          state="error"
          title="暂时无法读取订阅状态"
          description={`${state.message}已保存配置不会因这次读取失败丢失。`}
          action={<RetryButton onClick={() => setReloadKey(key => key + 1)} />}
        />
      )}

      {data && (
        <>
          <div className="feed-subs-toolbar">
            <nav className="feed-subs-filters" aria-label="筛选订阅">
              {[...filterLabels].map(([key, label]) => (
                <Button
                  key={key}
                  type="button"
                  variant="ghost"
                  aria-pressed={filter === key}
                  onClick={() => setFilter(key)}
                >
                  {label}
                </Button>
              ))}
            </nav>
            <span className="feed-subs-quota">订阅额度：{quotaLabel(data)}</span>
          </div>

          {state.kind === 'success' && state.refreshError && (
            <Alert variant="destructive">
              <AlertTitle>订阅状态刷新失败</AlertTitle>
              <AlertDescription>
                {state.refreshError}当前显示上次成功读取的额度、栏目和配置；请重试读取最新状态。
              </AlertDescription>
            </Alert>
          )}

          {created && (
            <Alert data-feed-sensitive>
              <AlertTitle>已保存「{created.subscription.name}」</AlertTitle>
              <AlertDescription>
                当前范围包含 {created.subscription.targets.length} 个栏目。私有 RSS 链接可从该行的菜单查看。
              </AlertDescription>
            </Alert>
          )}

          {createBlocked && (
            <Alert>
              <AlertTitle>暂时不能新增订阅</AlertTitle>
              <AlertDescription>
                {data.policy.status === 'auth_unavailable'
                  ? 'Auth 暂不可用，不能确认创建额度。'
                  : data.sources.length === 0
                    ? '还没有可订阅的已验证栏目。'
                    : '当前 Auth 未授予可新增的订阅额度。'}
              </AlertDescription>
            </Alert>
          )}

          {visibleSubscriptions.length === 0 ? (
            <PageState
              state="empty"
              title={filter === 'deleted' ? '没有已删除的订阅' : '还没有匹配的订阅'}
              description={
                filter === 'deleted'
                  ? '删除的订阅会保留配置，方便日后恢复。'
                  : '从一个关心的栏目开始；创建后可以随时调整邮件模式和 RSS。'
              }
              action={
                filter === 'all' ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={event => openCreate(event.currentTarget)}
                    disabled={createBlocked}
                  >
                    <Plus aria-hidden="true" />
                    新建订阅
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <section className="feed-subs-list" data-feed-sensitive aria-label="已保存订阅">
              <div className="feed-subs-columns" aria-hidden="true">
                <span>订阅 / 关注栏目</span>
                <span>邮件接收</span>
                <span>状态</span>
                <span />
              </div>
              {visibleSubscriptions.map(subscription => (
                <SubscriptionRow
                  key={subscription.id}
                  subscription={subscription}
                  data={data}
                  onChanged={reload}
                />
              ))}
            </section>
          )}

          <details className="feed-subs-help">
            <summary>订阅与投递说明</summary>
            <dl>
              <div>
                <dt>RSS</dt>
                <dd>
                  {data.outputChannels.rss.enabled
                    ? '私有 RSS 输出标题、摘要和版本链接；正文与附件仍需登录。'
                    : '订阅配置和私有 RSS 链接可以保存，输出开放后生效。'}
                </dd>
              </div>
              <div>
                <dt>邮件</dt>
                <dd>
                  {data.outputChannels.email.enabled
                    ? '邮件按订阅设置发送，暂停与投递状态见通知记录。'
                    : '邮件发送暂时暂停，已保存的投递设置会保留。'}
                </dd>
              </div>
              <div>
                <dt>栏目生效</dt>
                <dd>新增栏目从保存时开始生效；移除后再加入会重新计算生效时间。</dd>
              </div>
              <div>
                <dt>额度</dt>
                <dd>暂停的订阅仍占创建额度；已删除订阅不计入当前可运行额度，恢复需要额度允许。</dd>
              </div>
            </dl>
          </details>
        </>
      )}

      <Sheet
        open={createOpen}
        onOpenChange={open => {
          if (!open && (saveState === 'loading' || retryableCreateFailure)) return;
          if (!open) {
            setCreateOpen(false);
            setSaveState('idle');
            setSaveError(null);
            setFailureStatus(null);
            setDraft(emptyDraft());
          }
        }}
      >
        <SheetContent
          className="feed-subs-sheet"
          data-feed-sensitive
          onOpenAutoFocus={focusCreateSheetTitle}
          onCloseAutoFocus={focusCreateTrigger}
        >
          <SheetHeader>
            <SheetTitle ref={createTitleRef} tabIndex={-1}>新建订阅</SheetTitle>
            <SheetDescription>
              选择关注范围和邮件模式。当前额度：{data ? quotaLabel(data) : '待确认'}。
            </SheetDescription>
          </SheetHeader>
          <form className="feed-subs-form" onSubmit={submit}>
            <div className="feed-subs-field">
              <Label htmlFor="subscription-name">订阅名称</Label>
              <Input
                id="subscription-name"
                value={draft.name}
                maxLength={80}
                disabled={saveState === 'loading' || retryableCreateFailure}
                autoComplete="off"
                aria-invalid={saveState === 'error' && !draft.name.trim()}
                aria-describedby={saveState === 'error' && !draft.name.trim() ? 'create-error' : undefined}
                onChange={event => editDraft({ name: event.target.value })}
              />
            </div>

            <fieldset className="feed-subs-field" aria-describedby="subscription-scope-help">
              <legend>关注范围</legend>
              <p id="subscription-scope-help">选择站点会订阅当前已验证栏目；之后新增的栏目不会自动加入。</p>
              <div className="feed-subs-site-options">
                {data?.sites.map(site => {
                  const siteSelected = draft.siteIds.includes(site.id);
                  return (
                    <div className="feed-subs-site" key={site.id}>
                      <label className="feed-subs-check">
                        <Checkbox
                          checked={siteSelected}
                          disabled={saveState === 'loading' || retryableCreateFailure}
                          onCheckedChange={checked => toggleSite(site.id, checked === true)}
                        />
                        <span>
                          <strong>{site.name}（整站快照）</strong>
                          <small>创建后新栏目不会自动加入</small>
                        </span>
                      </label>
                      <div className="feed-subs-site-sources">
                        {data.sources.filter(source => source.siteId === site.id).map(source => (
                          <label className="feed-subs-check" key={source.id}>
                            <Checkbox
                              checked={siteSelected || draft.sourceIds.includes(source.id)}
                              disabled={siteSelected || saveState === 'loading' || retryableCreateFailure}
                              onCheckedChange={checked => toggleSource(source.id, checked === true)}
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

            <div className="feed-subs-field">
              <Label htmlFor="subscription-email-mode">邮件模式</Label>
              <Select
                value={draft.emailMode}
                disabled={saveState === 'loading' || retryableCreateFailure}
                onValueChange={value => {
                  if (value === 'off' || value === 'immediate' || value === 'daily_digest') {
                    editDraft({ emailMode: value });
                  }
                }}
              >
                <SelectTrigger id="subscription-email-mode" aria-label="邮件模式">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily_digest">每日摘要</SelectItem>
                  <SelectItem value="immediate">及时提醒</SelectItem>
                  <SelectItem value="off">不发送邮件</SelectItem>
                </SelectContent>
              </Select>
              <p>RSS 与邮件分别管理。关闭邮件后，仍可通过 RSS 阅读。</p>
            </div>

            {saveError && (
              <Alert variant="destructive">
                <AlertTitle id="create-error">保存结果未确认</AlertTitle>
                <AlertDescription>
                  {saveError}
                  {retryableCreateFailure ? ' 可重试确认本次保存，已保存的订阅不会重复创建。' : ''}
                </AlertDescription>
              </Alert>
            )}

            <div className="feed-subs-form-actions">
              <Button
                type="button"
                variant="outline"
                disabled={saveState === 'loading' || retryableCreateFailure}
                onClick={() => setCreateOpen(false)}
              >
                取消
              </Button>
              <ActionButton
                type="submit"
                state={saveState}
                disabled={data
                  ? (!canCreate(data) || data.sources.length === 0) && saveState !== 'error'
                  : saveState !== 'error'}
                labels={{
                  idle: '创建订阅',
                  loading: '正在保存…',
                  success: '已保存',
                  error: '重试保存',
                }}
              />
            </div>
          </form>
        </SheetContent>
      </Sheet>
    </>
  );
}
