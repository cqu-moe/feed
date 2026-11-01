import type { Page } from '@playwright/test';
import { test, expect, installReadingRoutes } from './fixtures';

async function openAnonymousLanding(page: Page, next: string) {
  await installReadingRoutes(page, { authenticated: false });
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await expect(page.getByRole('heading', { level: 1, name: /^重大通知/ })).toBeVisible();
}

test('anonymous landing CTAs preserve a safe return target', async ({ page }) => {
  const cases = [
    { next: '/subscriptions?view=saved', authNext: '/subscriptions?view=saved' },
    { next: 'https://redirect.example.test/', authNext: '/' },
  ];

  for (const { next, authNext } of cases) {
    await openAnonymousLanding(page, next);
    const expectedHref = `/auth/login?next=${encodeURIComponent(authNext)}`;
    const mainAndFooterLogin = page.getByRole('link', { name: '登录并开始阅读' });
    await expect(mainAndFooterLogin).toHaveCount(2);
    await expect(mainAndFooterLogin.nth(0)).toHaveAttribute('href', expectedHref);
    await expect(mainAndFooterLogin.nth(1)).toHaveAttribute('href', expectedHref);
    const ctaColors = await mainAndFooterLogin.evaluateAll(links => links.map(link => {
      const styles = getComputedStyle(link);
      return { background: styles.backgroundColor, foreground: styles.color };
    }));
    expect(ctaColors).toHaveLength(2);
    for (const cta of ctaColors) expect(cta.foreground).not.toBe(cta.background);
    await expect(page.getByRole('link', { name: '登录', exact: true }))
      .toHaveAttribute('href', expectedHref);
    await expect(page.getByRole('link', { name: '登录并设置订阅' }))
      .toHaveAttribute('href', '/auth/login?next=%2Fsubscriptions');
  }
});

test('landing demo search keeps archive and delivery previews synchronized', async ({ page }) => {
  await openAnonymousLanding(page, '/subscriptions');
  const search = page.getByRole('textbox', { name: '搜索通知示例' });
  const examTitle = '关于期中考试安排的通知';
  const examFile = '期中考试安排表.pdf';

  await search.fill('不存在');
  await expect(page.getByText('没有找到这条通知')).toBeVisible();
  await page.getByRole('button', { name: '查看全部示例' }).click();
  await expect(page.getByText('4 条通知示例')).toBeVisible();

  await page.getByRole('button', { name: '选课', exact: true }).click();
  await expect(page.getByText('1 条通知示例')).toBeVisible();
  await expect(page.getByRole('button', { name: /关于开展本科生课程补选的通知/ })).toBeVisible();
  await expect(page.getByRole('button', { name: new RegExp(examTitle) })).not.toBeVisible();

  await page.getByRole('button', { name: '考试', exact: true }).click();
  await expect(page.getByText('1 条通知示例')).toBeVisible();
  await page.getByRole('button', { name: new RegExp(examTitle) }).click();
  await expect(page.getByRole('heading', { level: 3, name: examTitle })).toBeVisible();

  await page.getByRole('button', { name: /^查看附件/ }).click();
  await expect(page.getByRole('button', { name: new RegExp(examFile) })).toBeVisible();

  await page.getByRole('button', { name: /^有更新，就发邮件/ }).click();
  const immediateHeading = page.getByRole('heading', { level: 3, name: '你关注的栏目有新通知。' });
  await expect(immediateHeading).toBeVisible();
  await expect(immediateHeading.locator('..')).toContainText(examTitle);
  await expect(immediateHeading.locator('..')).toContainText('即时邮件');
});

test('mobile landing stays keyboard-usable and overflow-free in both themes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAnonymousLanding(page, '/subscriptions');

  for (const theme of ['light', 'dark']) {
    await page.evaluate(nextTheme => localStorage.setItem('cqu-moe-theme', nextTheme), theme);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

    const search = page.getByRole('textbox', { name: '搜索通知示例' });
    await search.focus();
    await page.keyboard.type('考试');
    await expect(page.getByText('1 条通知示例')).toBeVisible();

    const exam = page.getByRole('button', { name: /关于期中考试安排的通知/ });
    await exam.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 3, name: '关于期中考试安排的通知' })).toBeVisible();

    const immediate = page.getByRole('button', { name: /^有更新，就发邮件/ });
    await immediate.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 3, name: '你关注的栏目有新通知。' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});
