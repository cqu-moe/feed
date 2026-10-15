import { defineConfig } from '@playwright/test';
import { join } from 'node:path';

if (!['firefox', 'webkit'].includes(process.env.FEED_E2E_BROWSER ?? '')) throw new Error('Use FEED_E2E_CROSS_BROWSER=1 with the Feed runner');

export default defineConfig({
  testDir: '.',
  testMatch: 'reading.cross-browser.spec.ts',
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: join(process.env.FEED_E2E_OUTPUT!, 'results'),
  reporter: [['list'], ['json', { outputFile: join(process.env.FEED_E2E_OUTPUT!, 'playwright-report.json') }]],
  use: { trace: 'off', screenshot: 'off', video: 'off' },
});
