import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { assertSelectedAttemptCleanup } from './evidence.mjs';
import { join, resolve } from 'node:path';

// A control counts only when its intended failure and physical teardown are
// independently observed. Never accept an arbitrary nonzero runner exit.
const root = resolve(process.env.FEED_E2E_CONTROL_OUTPUT || `.e2e/mail-controls-${Date.now()}`);
if (!root.startsWith(resolve('.e2e') + '/') || root.includes('/auth-checkout/')) throw new Error('Controls require a fresh .e2e child');
await mkdir(root);
const definitions = [
  { name: 'missing-auth', env: { FEED_E2E_AUTH_CHECKOUT: '' }, reason: /FEED_E2E_AUTH_CHECKOUT is required/, early: true },
  { name: 'zero-tests', args: ['--grep', '__no_feed04_test__', '--pass-with-no-tests'], reason: /suite was empty/ },
  { name: 'wrong-oracle', env: { FEED_E2E_MAIL_WRONG_ORACLE: '1' }, reason: /expected ["']accepted["'] to be ["']delivered["']|Expected:\s*"delivered"[\s\S]*Received:\s*"accepted"/ },
  { name: 'disabled-mail-consumer', env: { FEED_E2E_DISABLE_MAIL_CONSUMER: '1' }, reason: /Timed out waiting for native mail Queue provider acceptance/ },
  { name: 'wrong-heading', env: { FEED_E2E_BREAK_ASSERTION: '1' }, reason: /故意错误的邮件成功断言/ },
  { name: 'startup', env: { FEED_E2E_FAIL_STARTUP: '1' }, reason: /Injected startup failure after real Worker initialization/ },
  { name: 'cleanup', env: { FEED_E2E_FAIL_CLEANUP: '1' }, reason: /Injected cleanup failure after successful physical cleanup/ },
  { name: 'startup-and-cleanup', env: { FEED_E2E_FAIL_STARTUP: '1', FEED_E2E_FAIL_CLEANUP: '1' }, reason: /Injected startup failure after real Worker initialization/, secondary: /Injected cleanup failure after successful physical cleanup/ },
];
const results = [];
try {
  for (const definition of definitions) {
    const output = join(root, definition.name);
    const env = { ...process.env, FEED_E2E_SUITE: 'mail', FEED_E2E_VARIANT: 'desktop', FEED_E2E_OUTPUT: output, ...definition.env };
    // Inherited fault controls must not change the reason another control fails.
    for (const key of ['FEED_E2E_DISABLE_MAIL_CONSUMER', 'FEED_E2E_DISABLE_CONSUMERS', 'FEED_E2E_MAIL_WRONG_ORACLE', 'FEED_E2E_BREAK_ASSERTION', 'FEED_E2E_FAIL_STARTUP', 'FEED_E2E_FAIL_CLEANUP']) env[key] = definition.env?.[key] ?? '';
    let log = '';
    const child = spawn(process.execPath, ['e2e/run.mjs', ...(definition.args ?? [])], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', bytes => { log += bytes; }); child.stderr.on('data', bytes => { log += bytes; });
    const stop = () => child.kill('SIGTERM'); process.once('SIGINT', stop); process.once('SIGTERM', stop);
    let code;
    try { code = await new Promise((done, fail) => { child.once('error', fail); child.once('close', value => done(value)); }); }
    finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
    // Failure reasons come from owned private evidence, never public console replay.
    const privateLog = definition.early ? '' : await readFile(join(output, 'desktop/.private-child.log'), 'utf8');
    const plainLog = (log + '\n' + privateLog).replace(/\u001b\[[0-9;]*m/g, '');
    if (code === 0 || code === null || !definition.reason.test(plainLog) || (definition.secondary && !definition.secondary.test(plainLog))) throw new Error(`${definition.name}: intended nonzero failure was not observed`);
    const result = { control: definition.name, exit: code, intendedFailureObserved: true };
    if (!definition.early) {
      const run = JSON.parse(await readFile(join(output, 'public/run.json')));
      const variant = run.variants[0];
      if (!run.errors.length || !variant?.cleanup.storageRemoved || variant.cleanup.portsClosed?.length !== 3) throw new Error(`${definition.name}: physical cleanup evidence missing`);
      if (definition.name === 'startup-and-cleanup' && ![definition.reason, definition.secondary].every(pattern => run.errors.some(error => pattern.test(error)))) throw new Error('Primary or cleanup cause was lost');
      if (definition.name === 'cleanup' && (variant.summary?.passed !== 1 || variant.summary.failed !== 0)) throw new Error('Cleanup control did not pass the full business journey first');
      if (definition.name === 'zero-tests' && variant.summary?.executed !== 0) throw new Error('Zero-test control unexpectedly ran tests');
      if (definition.name === 'disabled-mail-consumer') {
        const mail = JSON.parse(await readFile(join(output, 'public/desktop/mail.json')));
        const ingestion = JSON.parse(await readFile(join(output, 'public/desktop/ingestion.json')));
        if (mail.calls.length || mail.mail_messages.length !== 2 || !mail.mail_messages.every(message => message.state === 'prepared') || ingestion.events.length !== 2 || !ingestion.attempts.length) throw new Error('Disabled consumer did not isolate real ingestion from missing mail delivery');
        result.readyEvents = ingestion.events.length; result.preparedMessages = mail.mail_messages.length; result.providerCalls = mail.calls.length;
      }
      await stat(join(output, 'desktop/.runtime')).then(() => { throw new Error('Control runtime directory remains'); }, error => { if (error.code !== 'ENOENT') throw error; });
      await Promise.all(variant.cleanup.portsClosed.map(assertClosed));
      if (variant.summary?.executed) {
        const directory = join(output, 'public/desktop');
        // Export redaction may rename a receipt; use its published reference.
        const receipts = process.env.FEED_E2E_CROSS_BROWSER === '1'
          ? (variant.nativeAttempts ?? []).map(attempt => attempt.receipt)
          : (await readdir(directory)).filter(name => name.startsWith('browser-cleanup-'));
        if (!receipts.length) throw new Error(`${definition.name}: no browser cleanup receipt`);
        for (const name of receipts) {
          const receipt = JSON.parse(await readFile(join(directory, name)));
          if (!receipt.exited || !receipt.profileRemoved) throw new Error('Control browser cleanup failed');
          if (process.env.FEED_E2E_CROSS_BROWSER === '1') {
            const attempt = variant.nativeAttempts.find(attempt => attempt.receipt === name);
            if (receipt.testId !== attempt.id || receipt.attemptId !== attempt.attemptId || receipt.engine !== process.env.FEED_E2E_BROWSER) throw new Error('Control receipt identity differs from actual native attempt');
            if (receipt.cleanup !== 'complete' || receipt.errors.length || receipt.unexpected.length || !receipt.profiles.every(profile => profile.disconnected && profile.removed)) throw new Error('Control native browser cleanup failed');
          } else await assertClosed(receipt.cdpPortClosed);
        }
        if (process.env.FEED_E2E_CROSS_BROWSER === '1') {
          if (!variant.nativeAttempts?.length || variant.nativeAttempts.some(attempt => attempt.cleanup !== 'complete' || attempt.retry !== 0)) throw new Error('Control native attempt evidence missing');
        } else assertSelectedAttemptCleanup(JSON.parse(await readFile(join(directory, 'report.json'))));
        const profiles = await readdir(join(output, 'desktop/.profiles')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
        if (profiles.length) throw new Error('Control browser profile remains');
        result.browserCleanup = { receipts: receipts.length, engine: process.env.FEED_E2E_BROWSER || 'chromium',
          cdpPortsClosed: process.env.FEED_E2E_CROSS_BROWSER === '1' ? null : true, profilesRemoved: true };
      }
      // Only sanitized exports may be uploaded. Keep raw runtime and reports private.
      const names = await readdir(join(output, 'public'));
      if (!names.includes('run.json')) throw new Error('Missing safe control export');
      result.cleanup = variant.cleanup;
    }
    results.push(result);
    console.log(`${definition.name}: intended failure ${code}, physical cleanup verified${definition.early ? ' (not started)' : ''}`);
    await writeFile(join(root, 'controls.json'), JSON.stringify({ results }, null, 2) + '\n');
  }
} catch (error) {
  await writeFile(join(root, 'controls.json'), JSON.stringify({ results, error: error.message }, null, 2) + '\n');
  throw error;
}

async function assertClosed(port) {
  await new Promise((done, fail) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(2000);
    socket.once('connect', () => { socket.destroy(); fail(new Error(`Control port ${port} remains open`)); });
    socket.once('timeout', () => { socket.destroy(); fail(new Error('Control cleanup readback timed out')); });
    socket.once('error', error => error.code === 'ECONNREFUSED' ? done() : fail(error));
  });
}
