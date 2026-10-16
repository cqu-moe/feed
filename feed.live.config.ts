import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { account, FEED, output } from './live/FEED-05/browser/state.mjs';
import { provider } from './live/FEED-05/browser/provider';

export const liveEngine = web({ browser: provider, viewport: { width: 1440, height: 900 } });
export default {
  tests: ['live/FEED-05/browser/subscriptions.live.e2e.ts'],
  workers: 1, retries: 0, timeout: 600000, assertionTimeout: 15000,
  trace: 'off', video: 'off', output: output(), reporters: ['json'],
  credentials: Object.fromEntries(['owner', 'other'].map(role => [role, {
    username: `FEED05-${role}`, password: async () => (await account(role)).password,
  }])),
  secrets: Object.fromEntries(['owner', 'other'].map(role => [`${role}Email`, async () => (await account(role)).email])),
  targets: [{ name: 'isolated-live', engine: liveEngine, app: { url: FEED, environment: 'staging' } }],
} satisfies E2EConfig;
