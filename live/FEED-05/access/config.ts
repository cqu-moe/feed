import type { E2EConfig } from 'e2e';
import { resolve } from 'node:path';
import { web } from '@e2e-dev/web';
import { provider } from '../browser/provider';
import { account, FEED, PROJECT, output } from '../browser/state.mjs';
export default {
  tests: ['access.live.e2e.ts'], workers: 1, retries: 0,
  timeout: 300000, assertionTimeout: 15000, trace: 'off', video: 'off',
  output: process.env.FEED05_MODE === 'execute' ? output() : resolve(PROJECT, 'live/FEED-05/access/.offline/collection'), reporters: ['json'],
  credentials: { owner: { username: 'FEED05-owner', password: async () => (await account('owner')).password } },
  secrets: { ownerEmail: async () => (await account('owner')).email },
  targets: [{ name: 'isolated-access', engine: web({ browser: provider, viewport: { width: 1440, height: 900 } }),
    app: { url: FEED, environment: 'staging' } }],
} satisfies E2EConfig;
