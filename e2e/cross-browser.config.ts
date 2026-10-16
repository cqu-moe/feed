import { defineConfig } from '@playwright/test';
import { join } from 'node:path';

if (!['firefox', 'webkit'].includes(process.env.FEED_E2E_BROWSER ?? '')) throw new Error('Use FEED_E2E_CROSS_BROWSER=1 with the Feed runner');

export default defineConfig({
  testDir: '.',
  testMatch: process.env.FEED_E2E_SUITE === 'ingestion' ? 'ingestion.e2e.ts'
    : process.env.FEED_E2E_SUITE === 'mail' ? 'mail.e2e.ts' : ['journey.e2e.ts', 'reading.e2e.ts'],
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: ['ingestion', 'mail'].includes(process.env.FEED_E2E_SUITE ?? '') ? 300_000 : 120_000,
  expect: { timeout: 10_000 },
  outputDir: join(process.env.FEED_E2E_OUTPUT!, 'results'),
  reporter: [['list'], ['json', { outputFile: join(process.env.FEED_E2E_OUTPUT!, 'playwright-report.json') }]],
  use: { trace: 'off', screenshot: 'off', video: 'off' },
});
