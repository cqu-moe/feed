import type { Browser } from '@e2e-dev/web';
import { credentials, expect } from './test-api';
import type { JsonValue, Screen } from 'e2e';

export type AppSurface = { open(path?: string): Promise<void> };

export type ApiRequest = {
  method?: string;
  origin?: string;
  body?: JsonValue;
};

export type ApiResult<T> = {
  status: number;
  body: T;
};

export async function apiFetch<T>(browser: Browser, path: string, request: ApiRequest = {}): Promise<ApiResult<T>> {
  return (await apiFetchMany<T>(browser, path, [request]))[0]!;
}

export async function apiFetchMany<T>(browser: Browser, path: string, requests: ApiRequest[]): Promise<ApiResult<T>[]> {
  const payload = await browser.evaluate(async (input: { path: string; requests: ApiRequest[] }) => {
    async function one(command: ApiRequest) {
      const response = await fetch(input.path, {
        method: command.method ?? 'GET',
        headers: {
          ...(command.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(command.origin ? { origin: command.origin } : {}),
        },
        body: command.body === undefined ? undefined : JSON.stringify(command.body),
      });
      const text = await response.text();
      let body: unknown = null;
      if (text) {
        try { body = JSON.parse(text); } catch { body = text; }
      }
      return JSON.stringify({ status: response.status, body });
    }
    return JSON.stringify(await Promise.all(input.requests.map(one)));
  }, { path, requests });
  return (JSON.parse(payload) as string[]).map(item => JSON.parse(item) as ApiResult<T>);
}

export async function control(action: string, input: Record<string, unknown> = {}) {
  const response = await fetch(`${process.env.FEED_E2E_CONTROL_URL}/control`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.FEED_E2E_CONTROL_SECRET}` },
    body: JSON.stringify({ action, ...input }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Runtime control ${action} failed (${response.status}): ${detail}`);
  }
  return response.status === 204 ? null : response.json();
}

export async function login(app: AppSurface, screen: Screen, browser: Browser, role: 'OWNER' | 'OTHER') {
  await app.open('/subscriptions');
  await screen.getByRole('link', '使用 auth.cqu.moe 登录').click();
  await expect(browser).toHaveURL(new RegExp(`^${escapeOrigin(new URL(process.env.FEED_E2E_AUTH_URL!).origin)}/login`));
  await screen.getByLabel('邮箱').fill(credentials.user(role.toLowerCase()).username);
  await browser.locator('#password').fill(credentials.user(role.toLowerCase()).password);
  await screen.getByRole('button', '登录', { exact: true }).click();
  await expect(browser).toHaveURL(/\/subscriptions$/);
}

export function escapeOrigin(origin: string) {
  return origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
