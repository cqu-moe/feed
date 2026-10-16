import * as web from '@e2e-dev/web';
import { credentials as armyCredentials, expect as armyExpect } from 'e2e';
import { test as nativeTest, expect as nativeExpect } from './cross-browser-api';

// Only the demonstrated Firefox/WebKit local TLS gap uses the native adapter.
// All original journey bodies and default Chromium operations stay with e2e.
const native = process.env.FEED_E2E_CROSS_BROWSER === '1';
export const test = (native ? nativeTest : web.test) as typeof web.test;
export const beforeEach = (native ? nativeTest.beforeEach : web.beforeEach) as typeof web.beforeEach;
export const afterEach = (native ? nativeTest.afterEach : web.afterEach) as typeof web.afterEach;
export const expect = (native ? nativeExpect : armyExpect) as typeof armyExpect;
export const credentials = native ? {
  user(role: string) {
    const username = process.env[`FEED_E2E_${role.toUpperCase()}_EMAIL`];
    const password = process.env[`FEED_E2E_${role.toUpperCase()}_PASSWORD`];
    if (!username || !password) throw new Error(`Missing synthetic credential role ${role}`);
    return { username, password };
  },
} : armyCredentials;
export type { Browser } from '@e2e-dev/web';
