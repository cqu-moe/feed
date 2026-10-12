import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const feedOrigin = 'https://feed.test';
const authOrigin = 'https://auth.test';
const clientId = 'feed-test-client';
const clientSecret = 'feed-test-secret';
const encryptionKey = 'feed-test-session-encryption-key';
const articleId = '1234567890abcdef12345678';
const retryArticleId = 'abcdef1234567890abcdef12';
const pdfOnlyArticleId = '111111111111111111111111';
const articleUrl = 'https://jwc.cqu.edu.cn/info/1082/1.htm';
const retryArticleUrl = 'https://jwc.cqu.edu.cn/info/1082/2.htm';
const pdfOnlyArticleUrl = 'https://jwc.cqu.edu.cn/info/1082/3.htm';
const bodyPdfUrl = 'https://jwc.cqu.edu.cn/system/_content/download.jsp?urltype=1501&body.pdf';
const utilsModulePath = resolve('worker/utils.mjs');

const workersStub = {
  name: 'archive-version-workers-stub',
  setup(buildApi) {
    buildApi.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
      path: 'cloudflare-workers',
      namespace: 'archive-version-workers-stub',
    }));
    buildApi.onLoad({ filter: /.*/, namespace: 'archive-version-workers-stub' }, (args) => {
      if (args.path !== 'cloudflare-workers') return undefined;
      return {
        loader: 'js',
        resolveDir: process.cwd(),
        contents: `
          export class WorkflowEntrypoint{constructor(env={}){this.env=env;}}
          export class WorkerEntrypoint{constructor(_ctx,env={}){this.env=env;}}
        `,
      };
    });
    buildApi.onResolve({ filter: /\.\/firecrawl\.mjs$/ }, () => ({
      path: 'archive-version-firecrawl',
      namespace: 'archive-version-workers-stub',
    }));
    buildApi.onLoad({ filter: /.*/, namespace: 'archive-version-workers-stub' }, (args) => {
      if (args.path !== 'archive-version-firecrawl') return undefined;
      return {
        loader: 'js',
        resolveDir: process.cwd(),
        contents: `
          import { reserveBudget } from ${JSON.stringify(utilsModulePath)};

          export async function scrape(env,url,options){
            await reserveBudget(env,'firecrawl',Number(env.MAX_FIRECRAWL_PER_DAY||120));
            return globalThis.__archiveScrape(url,options);
          }
        `,
      };
    });
  },
};

let miniflare;
let db;
let authWorker;

before(async () => {
  const app = await build({
    stdin: {
      contents: `
        import FeedWorker, { CaptureWorkflow } from './worker/index.mjs';
        import { createTaskRuntime, handleFeedJobs } from './worker/task-runtime.mjs';

        const providerState = {
          variant: 'a',
          hold: false,
          failAfterCapture: false,
          failNextD1: false,
        };
        const patchedDatabases = new WeakSet();
        const installedRuntimes = new WeakSet();
        const runtimeState = {
          instances: new Map(),
          queuedJobs: [],
          allJobs: [],
          clock: Date.now(),
        };

        function base64(value) {
          let binary = '';
          const bytes = new TextEncoder().encode(value);
          for (const byte of bytes) binary += String.fromCharCode(byte);
          return btoa(binary);
        }

        function page(variant, incomplete = false) {
          if (variant === 'pdf-only') {
            const snapshot = \`<html><body><main><h1>PDF-only notice</h1><a href="${bodyPdfUrl}">通知正文.pdf</a></main></body></html>\`;
            return {
              bodyRecognized: true,
              page: { url: ${JSON.stringify(pdfOnlyArticleUrl)} },
              bodyText: '',
              errors: [],
              artifacts: [
                { name: 'snapshot.html', base64: base64(snapshot), contentType: 'text/html; charset=utf-8' },
                { name: 'offline.html', base64: base64(snapshot), contentType: 'text/html; charset=utf-8' },
              ],
              attachmentCandidates: [{ url: ${JSON.stringify(bodyPdfUrl)}, name: '通知正文.pdf', role: 'body-pdf' }],
              downloads: [],
            };
          }
          const body = incomplete
            ? '这是缺少附件与原貌的候选版本。'
            : \`这是不可变版本 \${variant.toUpperCase()} 的中文正文。\\n\\n附件字节也随版本固定。\`;
          const pdf = \`%PDF-1.7\\nimmutable-\${variant}\\n\`;
          const snapshot = \`<html><body><main><h1>版本 \${variant.toUpperCase()}</h1><p>\${body}</p><a href="/api/files/${articleId}/attachment-1.pdf?download=1">原始附件</a><iframe data-feed-pdf="attachment-1.pdf" src="https://jwc.cqu.edu.cn/old.pdf" width="700"></iframe></main><script>alert(1)</script></body></html>\`;
          const artifacts = incomplete ? [] : [
            { name: 'attachment-1.pdf', base64: base64(pdf), contentType: 'application/pdf' },
            { name: 'snapshot.html', base64: base64(snapshot), contentType: 'text/html; charset=utf-8' },
            { name: 'offline.html', base64: base64(snapshot), contentType: 'text/html; charset=utf-8' },
          ];
          const attachmentUrl = 'https://jwc.cqu.edu.cn/system/_content/download.jsp?urltype=1501&file.pdf';
          return {
            bodyRecognized: true,
            page: { url: ${JSON.stringify(articleUrl)} },
            bodyText: body,
            errors: [],
            artifacts,
            attachmentCandidates: [{ url: attachmentUrl, name: '通知附件.pdf', role: 'attachment' }],
            downloads: incomplete ? [] : [
              { url: attachmentUrl, originalFile: true, saved: { name: 'attachment-1.pdf' } },
            ],
          };
        }

        globalThis.__archiveScrape = async (url) => {
          while (providerState.hold) await new Promise(resolve => setTimeout(resolve, 20));
          if (providerState.failAfterCapture) providerState.failNextD1 = true;
          const incomplete = providerState.variant === 'incomplete';
          const capturedPage = page(providerState.variant, incomplete);
          return {
            markdown: capturedPage.bodyText,
            rawHtml: '<html><body><main>provider raw html</main></body></html>',
            metadata: { statusCode: 200, creditsUsed: 1, proxyUsed: true },
            actions: { javascriptReturns: [{ value: JSON.stringify(capturedPage) }] },
          };
        };

        function patchDatabase(env) {
          if (!env.DB || patchedDatabases.has(env.DB)) return;
          const batch = env.DB.batch.bind(env.DB);
          patchedDatabases.add(env.DB);
          env.DB.batch = async statements => {
            if (providerState.failNextD1) {
              providerState.failNextD1 = false;
              throw new Error('injected D1 unavailable after R2 writes');
            }
            return batch(statements);
          };
        }

        function installRuntimeAdapter(env) {
          if (installedRuntimes.has(env)) return;
          installedRuntimes.add(env);
          const queue = {
            async send(body) {
              runtimeState.queuedJobs.push(body);
              runtimeState.allJobs.push(body);
            },
          };
          const workflow = {
            async create({ id, params }) {
              const record = { id, status: 'queued', error: null, result: null, promise: null, start: null };
              runtimeState.instances.set(id, record);
              record.start = () => {
                if (record.promise) return;
                record.status = 'running';
                record.promise = Promise.resolve()
                  .then(() => new CaptureWorkflow(env).run({ instanceId: id, payload: params }, step))
                  .then(result => {
                    record.status = 'complete';
                    record.result = result;
                    return result;
                  })
                  .catch(error => {
                    record.status = 'errored';
                    record.error = error instanceof Error ? error : new Error(String(error));
                    throw error;
                  });
              };
              return {
                async status() {
                  return { status: record.status, error: record.error };
                },
              };
            },
            async get(id) {
              const record = runtimeState.instances.get(id);
              if (!record) throw new Error(\`Unknown workflow instance \${id}\`);
              return {
                async status() {
                  return { status: record.status, error: record.error };
                },
              };
            },
          };
          env.CAPTURE = workflow;
          env.FEED_JOBS = queue;
          env.FEED_EVENTS = queue;
        }

        const step = {
          async do(_name, config, fn) {
            return (typeof config === 'function' ? config : fn)();
          },
          async sleep() {},
        };

        export default {
          async fetch(request, env, ctx) {
            patchDatabase(env);
            installRuntimeAdapter(env);
            const url = new URL(request.url);
            if (url.pathname === '/__test/provider' && request.method === 'POST') {
              Object.assign(providerState, await request.json());
              return Response.json({ ok: true });
            }
            if (url.pathname === '/__test/configuration') {
              return Response.json({
                baseUrl: Boolean(env.BASE_URL),
                authBaseUrl: Boolean(env.AUTH_BASE_URL),
                clientId: Boolean(env.FEED_AUTH_CLIENT_ID),
                clientSecret: Boolean(env.FEED_AUTH_CLIENT_SECRET),
                encryptionKey: Boolean(env.FEED_SESSION_ENCRYPTION_KEY),
              });
            }
            if (url.pathname === '/__test/handle-jobs' && request.method === 'POST') {
              const messages = runtimeState.queuedJobs.splice(0).map(body => ({
                body,
                ack() {},
                retry() {},
              }));
              await handleFeedJobs({ messages }, env, {
                queue: env.FEED_JOBS,
                workflow: env.CAPTURE,
              });
              return Response.json({ handled: messages.length });
            }
            if (url.pathname === '/__test/replay-job' && request.method === 'POST') {
              const index = Number(url.searchParams.get('index') ?? '0');
              const body = runtimeState.allJobs[index];
              if (!body) return Response.json({ error: 'job not found' }, 404);
              await handleFeedJobs({ messages: [{ body, ack() {}, retry() {} }] }, env, {
                queue: env.FEED_JOBS,
                workflow: env.CAPTURE,
              });
              return Response.json({ replayed: true });
            }
            if (url.pathname === '/__test/workflows') {
              const records = [...runtimeState.instances.values()];
              for (const record of records) record.start();
              ctx?.waitUntil?.(Promise.allSettled(records.map(record => record.promise)));
              const waitMs = Number(url.searchParams.get('waitMs') ?? '2000');
              if (Number.isSafeInteger(waitMs) && waitMs > 0) {
                await Promise.race([
                  Promise.allSettled([...runtimeState.instances.values()].map(record => record.promise)),
                  new Promise(resolve => setTimeout(resolve, waitMs)),
                ]);
              }
              return Response.json({
                instances: [...runtimeState.instances.values()].map(({ id, status, error, result }) => ({
                  id,
                  status,
                  error: error?.message ?? null,
                  result,
                })),
              });
            }
            if (url.pathname === '/__test/recover' && request.method === 'POST') {
              const advance = Number(url.searchParams.get('advanceMs') ?? '0');
              if (Number.isSafeInteger(advance) && advance > 0) runtimeState.clock = Math.max(Date.now(),runtimeState.clock) + advance;
              const result = await createTaskRuntime(env, {
                queue: env.FEED_JOBS,
                workflow: env.CAPTURE,
                now: () => runtimeState.clock,
              }).recover();
              return Response.json(result);
            }
            return FeedWorker.fetch(request, env);
          },
        };
      `,
      resolveDir: process.cwd(),
      sourcefile: 'archive-versions-fixture.mjs',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    external: ['node:buffer', 'node:*'],
    plugins: [workersStub],
  });

  const provider = await build({
    stdin: {
      contents: `
        import { exportJWK, generateKeyPair, SignJWT } from 'jose';
        import { WorkerEntrypoint } from 'cloudflare:workers';

        const state = { codeCounter: 0, tokenCounter: 0 };
        const codes = new Map();
        const tokens = new Map();
        let keyPairPromise;

        async function keys() {
          keyPairPromise ??= generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
          return keyPairPromise;
        }

        async function idToken(nonce, subject) {
          const { publicKey, privateKey } = await keys();
          const jwk = await exportJWK(publicKey);
          return new SignJWT({ nonce })
            .setProtectedHeader({ alg: 'EdDSA', kid: 'auth-test-key' })
            .setIssuer('${authOrigin}/api/auth')
            .setAudience('${clientId}')
            .setSubject(subject)
            .setIssuedAt()
            .setExpirationTime('10m')
            .sign(privateKey);
        }

        function json(body, status = 200) {
          return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
        }

        export class AuthService extends WorkerEntrypoint {
          async getFeedPolicy(request) {
            if (request.contractVersion !== 1 || request.clientId !== 'feed-rpc-client') {
              return { ok: false, code: 'INVALID_CLIENT', retryable: false, requestId: 'test' };
            }
            return {
              ok: true,
              contractVersion: 1,
              checkedAt: Date.now(),
              data: { access: true, subscriptionLimit: { kind: 'limited', value: 10 } },
            };
          }
          async getFeedRecipient(request) {
            const policy = await this.getFeedPolicy(request);
            return {
              ...policy,
              data: { policy: policy.data, recipient: { status: 'verified', email: 'reader@401.moe' } },
            };
          }
        }

        export default {
          async fetch(request) {
            const url = new URL(request.url);
            if (url.pathname === '/api/v1/auth/jwks') {
              const { publicKey } = await keys();
              const jwk = await exportJWK(publicKey);
              return json({ keys: [{ ...jwk, kid: 'auth-test-key', alg: 'EdDSA', use: 'sig' }] });
            }
            if (url.pathname === '/api/v1/auth/oauth2/authorize' && request.method === 'GET') {
              const code = 'auth-code-' + ++state.codeCounter;
              codes.set(code, {
                nonce: url.searchParams.get('nonce'),
                challenge: url.searchParams.get('code_challenge'),
                redirectUri: url.searchParams.get('redirect_uri'),
              });
              const callback = new URL(url.searchParams.get('redirect_uri'));
              callback.searchParams.set('code', code);
              callback.searchParams.set('state', url.searchParams.get('state'));
              return new Response(null, { status: 302, headers: { Location: callback.href } });
            }
            if (url.pathname === '/api/v1/auth/oauth2/token' && request.method === 'POST') {
              const form = new URLSearchParams(await request.text());
              const code = codes.get(form.get('code'));
              if (!code) return json({ error: 'invalid_grant' }, 400);
              codes.delete(code);
              const accessToken = 'access-token-' + ++state.tokenCounter;
              tokens.set(accessToken, { sub: 'user-uu', sid: 'central-session-' + state.tokenCounter });
              return json({
                access_token: accessToken,
                refresh_token: 'refresh-token-' + state.tokenCounter,
                token_type: 'Bearer',
                expires_in: 3600,
                id_token: await idToken(code.nonce, 'user-uu'),
              });
            }
            if (url.pathname === '/api/v1/auth/oauth2/userinfo' && request.method === 'GET') {
              const token = tokens.get((request.headers.get('Authorization') ?? '').replace(/^Bearer /, ''));
              if (!token) return json({ error: 'invalid_token' }, 401);
              return json({ sub: token.sub, name: 'UU', email: 'reader@401.moe' });
            }
            if (url.pathname === '/api/v1/auth/oauth2/introspect' && request.method === 'POST') {
              const token = tokens.get(new URLSearchParams(await request.text()).get('token'));
              if (!token) return json({ active: false });
              return json({
                active: true,
                client_id: '${clientId}',
                sub: token.sub,
                sid: token.sid,
                exp: Math.floor(Date.now() / 1000) + 600,
                caps: { feed: { access: true } },
              });
            }
            return json({ error: 'not found' }, 404);
          },
        };
      `,
      resolveDir: process.cwd(),
      sourcefile: 'archive-versions-auth.mjs',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    plugins: [workersStub],
  });

  miniflare = new Miniflare(convertV4MiniflareOptions({
    workers: [
      {
        name: 'feed',
        modules: true,
        script: app.outputFiles[0].text,
        compatibilityDate: '2026-10-11',
        compatibilityFlags: ['nodejs_compat'],
        bindings: {
          BASE_URL: feedOrigin,
          AUTH_BASE_URL: authOrigin,
          BRIDGE_SECRET: 'test-bridge-secret',
          ADMIN_TOKEN: 'test-admin-token',
          TASK_RUNTIME_ENABLED: 'true',
          CRAWL_ENABLED: 'true',
          ARCHIVE_VERSIONS_ENABLED: 'true',
          ARCHIVE_READS_ENABLED: 'true',
          PDF_OCR_ENABLED: 'false',
          FEED_AUTH_CLIENT_ID: clientId,
          FEED_AUTH_CLIENT_SECRET: clientSecret,
          FEED_SESSION_ENCRYPTION_KEY: encryptionKey,
          FEED_AUTH_RPC_CLIENT_ID: 'feed-rpc-client',
          FEED_AUTH_RPC_CLIENT_SECRET: 'feed-rpc-secret',
        },
        d1Databases: ['DB'],
        r2Buckets: ['ARCHIVE'],
        serviceBindings: {
          AUTH: 'auth',
          AUTH_FEED_RPC: { name: 'auth', entrypoint: 'AuthService' },
        },
      },
      {
        name: 'auth',
        modules: true,
        script: provider.outputFiles[0].text,
        compatibilityDate: '2026-10-11',
        compatibilityFlags: ['nodejs_compat'],
      },
    ],
  }));
  db = await miniflare.getD1Database('DB', 'feed');
  authWorker = await miniflare.getWorker('auth');

  for (const name of [
    '0001_feed.sql',
    '0002_auth.sql',
    '0003_collection_lease.sql',
    '0004_pdf_ocr.sql',
    '0005_task_runtime.sql',
    '0006_sources.sql',
    '0007_archive_versions.sql',
    '0008_content_events.sql',
    '0009_subscriptions.sql',
    '0010_subscription_editing.sql',
    '0013_notification_matching.sql',
  ]) {
    await applyMigration(db, await readFile(`migrations/${name}`, 'utf8'));
  }

  await db.prepare("INSERT OR IGNORE INTO sources(id,name,url) VALUES ('jwc','教务处','https://jwc.cqu.edu.cn/')").run();
  await db.prepare(`INSERT INTO articles(id,source_id,url,title,published_at,discovered_at,status,attempts,lease_until)
    VALUES (?,'jwc',?,'不可变版本通知','2026-01-03','2026-01-01','pending',0,0),
      (?,'jwc',?,'提交失败重试通知','2026-01-04','2026-01-01','pending',0,0),
      (?,'jwc',?,'PDF 正文暂不可用通知','2026-01-05','2026-01-01','pending',0,0)`)
    .bind(articleId, articleUrl, retryArticleId, retryArticleUrl, pdfOnlyArticleId, pdfOnlyArticleUrl).run();
});

after(async () => {
  await miniflare?.dispose();
});

test('immutable revisions preserve A-B-A bytes, reject incomplete defaults, and require auth', { concurrency: false }, async () => {
  const unauthenticated = await miniflare.dispatchFetch(`${feedOrigin}/api/articles/${articleId}/revisions`);
  if (unauthenticated.status !== 401) assert.fail(await unauthenticated.text());

  const first = await capture('request-version-a', 'a');
  assert.equal(first.revisionState, 'assembling');
  await replaySameTask(first.taskId);

  await capture('request-version-b', 'b');
  await capture('request-version-a-again', 'a');
  await capture('request-version-incomplete', 'incomplete');

  const cookie = await login();
  const revisions = await json(miniflare.dispatchFetch(`${feedOrigin}/api/articles/${articleId}/revisions`, {
    headers: { Cookie: cookie },
  }));
  assert.deepEqual(revisions.revisions.map(({ revisionNo, state }) => ({ revisionNo, state })), [
    { revisionNo: 4, state: 'blocked' },
    { revisionNo: 3, state: 'ready' },
    { revisionNo: 2, state: 'ready' },
    { revisionNo: 1, state: 'ready' },
  ]);
  for (const revision of revisions.revisions) {
    assert.equal(typeof revision.id, 'string');
    assert.equal(revision.articleId, articleId);
    assert.equal(Number.isSafeInteger(revision.revisionNo), true);
    assert.ok(!Number.isNaN(Date.parse(revision.observedAt)));
    assert.equal(revision.readyAt === null, revision.state !== 'ready');
  }

  const current = await detail(articleId, undefined, cookie);
  assert.equal(current.revision.revisionNo, 3);
  assert.match(current.article.bodyText, /版本 A 的中文正文/);
  const currentSearch = await json(miniflare.dispatchFetch(`${feedOrigin}/api/articles?q=${encodeURIComponent('版本 A')}`, {
    headers: { Cookie: cookie },
  }));
  assert.deepEqual(currentSearch.articles.map(row=>row.id),[articleId]);
  const oldSearch = await json(miniflare.dispatchFetch(`${feedOrigin}/api/articles?q=${encodeURIComponent('版本 B')}`, {
    headers: { Cookie: cookie },
  }));
  assert.equal(oldSearch.total,0);

  const incompleteRevision = revisions.revisions.find(({ revisionNo }) => revisionNo === 4);
  const incomplete = await detail(articleId, incompleteRevision.id, cookie);
  assert.equal(incomplete.revision.state, 'blocked');
  assert.ok(incomplete.revision.missingCount > 0);
  assert.equal(incomplete.article.bodyText, '');
  assert.ok(Array.isArray(incomplete.requirements));
  assert.ok(incomplete.requirements.some(({ state }) => state !== 'fulfilled'));
  for (const attachment of incomplete.attachments) {
    assert.equal(attachment.url, null);
    assert.equal(attachment.downloadUrl, null);
  }

  const revisionA1 = revisions.revisions.find(({ revisionNo }) => revisionNo === 1);
  const revisionB = revisions.revisions.find(({ revisionNo }) => revisionNo === 2);
  const revisionA3 = revisions.revisions.find(({ revisionNo }) => revisionNo === 3);
  const fileA1 = await file(articleId, revisionA1.id, cookie);
  const fileB = await file(articleId, revisionB.id, cookie);
  const fileA3 = await file(articleId, revisionA3.id, cookie);
  assert.equal(await fileA1.text(), '%PDF-1.7\nimmutable-a\n');
  assert.equal(await fileB.text(), '%PDF-1.7\nimmutable-b\n');
  assert.equal(await fileA3.text(), '%PDF-1.7\nimmutable-a\n');
  assert.equal(fileA1.headers.get('etag'), fileA3.headers.get('etag'));

  const range = await miniflare.dispatchFetch(fileUrl(articleId, revisionA1.id), {
    headers: { Cookie: cookie, Range: 'bytes=0-4' },
  });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), '%PDF-');

  for (const revision of [revisionA1, revisionB, revisionA3]) {
    const snapshot = await miniflare.dispatchFetch(snapshotUrl(articleId, revision.id), {
      headers: { Cookie: cookie },
    });
    assert.equal(snapshot.status, 200);
    const html = await snapshot.text();
    assert.match(html, new RegExp(`/reader/${articleId}/revisions/${revision.id}/attachment-1\\.pdf`));
    assert.match(html, new RegExp(`/api/articles/${articleId}/revisions/${revision.id}/files/attachment-1\\.pdf`));
    assert.doesNotMatch(html, /src="https:\/\/jwc\.cqu\.edu\.cn\/old\.pdf"|href="https:\/\/jwc\.cqu\.edu\.cn\/system\//i);
    assert.doesNotMatch(html, /<script|sandbox=|javascript:/i);
    assert.match(snapshot.headers.get('content-security-policy'), /script-src 'none'/);
  }

  assert.equal(await firecrawlUsage(), 4);
});

test('a PDF-only observation with an unavailable required original remains blocked', { concurrency: false }, async () => {
  const cookie = await login();
  const captured = await capture('request-pdf-only-unavailable', 'pdf-only', pdfOnlyArticleId);
  const status = await taskStatus(captured.taskId);
  assert.ok(
    status.task.state === 'succeeded' && status.task.lastError === null,
    `PDF-only capture should save a blocked observation, got task ${status.task.state}: ${status.task.lastError}`,
  );

  const pdfOnlyRevisions = await revisions(pdfOnlyArticleId, cookie);
  assert.deepEqual(pdfOnlyRevisions.revisions.map(({ revisionNo, state }) => ({ revisionNo, state })), [
    { revisionNo: 1, state: 'blocked' },
  ]);
  const blocked = pdfOnlyRevisions.revisions[0];
  assert.ok(blocked.missingCount > 0);
  const blockedDetail = await detail(pdfOnlyArticleId, blocked.id, cookie);
  assert.equal(blockedDetail.revision.state, 'blocked');
  assert.equal(blockedDetail.article.bodyText, '');
  const bodyPdf = blockedDetail.requirements.find(({ kind }) => kind === 'body_pdf');
  assert.equal(bodyPdf?.state, 'failed');
  assert.equal(bodyPdf?.error, 'attachment_missing');
  assert.equal(bodyPdf?.originalUrl, bodyPdfUrl);
  const listing = await json(miniflare.dispatchFetch(`${feedOrigin}/api/articles`, { headers: { Cookie: cookie } }));
  const listed = listing.articles.find(row=>row.id===pdfOnlyArticleId);
  assert.equal(listed?.status,'partial');
  assert.equal(listed?.attachmentCount,1);
  assert.ok(listed?.capturedAt);
  for (const attachment of blockedDetail.attachments) {
    assert.equal(attachment.url, null);
    assert.equal(attachment.downloadUrl, null);
  }
});

test('a stale fence cannot add an observation after the current capture moves on', { concurrency: false }, async () => {
  await provider({ variant: 'a', hold: false, failAfterCapture: false, failNextD1: false });
  const cookie = await login();
  const before = await detail(articleId, undefined, cookie);
  const revisionCountBefore = (await revisions(articleId, cookie)).revisions.length;
  await provider({ hold: true });
  const usageBefore = await firecrawlUsage();
  const created = await submit('request-stale-fence');
  await handleJobs();
  const held = await waitWorkflows(0);
  assert.equal(held.instances.at(-1)?.status, 'running');
  await waitFor(async () => assert.equal(await firecrawlUsage(), usageBefore + 1));
  await db.prepare('UPDATE articles SET capture_fence=capture_fence+1 WHERE id=?').bind(articleId).run();
  await provider({ hold: false });
  const outcome = await waitWorkflows(5000);
  assert.equal(outcome.instances.at(-1)?.status, 'complete');
  const stale = await taskStatus(created.task.id);
  assert.equal(stale.task.state, 'failed');
  assert.match(stale.task.lastError ?? '', /Capture fence expired/);

  assert.equal((await revisions(articleId, cookie)).revisions.length, revisionCountBefore);
  const after = await detail(articleId, undefined, cookie);
  assert.equal(after.revision.id, before.revision.id);
});

test('R2 success followed by D1 failure reuses the captured observation on retry', { concurrency: false }, async () => {
  const cookie = await login();
  await provider({ variant: 'a', failAfterCapture: true });
  const usageBefore = await firecrawlUsage();
  const created = await submit('request-r2-d1-retry', retryArticleId);
  await handleJobs();
  const firstAttempt = await waitWorkflows();
  assert.equal(firstAttempt.instances.at(-1)?.status, 'complete');
  const deferred = await taskStatus(created.task.id);
  assert.equal(deferred.task.state, 'deferred');
  assert.match(deferred.task.lastError ?? '', /injected D1 unavailable after R2 writes/);
  assert.equal(await firecrawlUsage(), usageBefore + 1);

  await provider({ variant: 'a', failAfterCapture: false });
  const recovery = await recover(25 * 60 * 1000);
  assert.equal(recovery.recovered, 1, JSON.stringify(recovery));
  assert.equal((await handleJobs()).handled, 1);
  const recovered = await waitWorkflows();
  await handleJobs();
  const retryWorkflow = recovered.instances.at(-1);
  assert.ok(
    retryWorkflow?.status === 'complete' && !retryWorkflow.result?.error,
    `Captured observation should be reusable on retry, got ${JSON.stringify(retryWorkflow)}`,
  );
  assert.equal(await firecrawlUsage(), usageBefore + 1);
  const retryRevisions = await revisions(retryArticleId, cookie);
  assert.deepEqual(retryRevisions.revisions.map(({ revisionNo, state }) => ({ revisionNo, state })), [
    { revisionNo: 1, state: 'ready' },
  ]);
  const detailResponse = await detail(retryArticleId, retryRevisions.revisions[0].id, cookie);
  assert.equal(detailResponse.revision.revisionNo, 1);
});

async function provider(state) {
  const response = await miniflare.dispatchFetch(`${feedOrigin}/__test/provider`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state),
  });
  assert.equal(response.status, 200);
}

async function submit(requestId, id = articleId) {
  const response = await miniflare.dispatchFetch(`${feedOrigin}/internal/capture-tasks`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-admin-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ articleId: id, requestId }),
  });
  assert.equal(response.status, 202);
  return response.json();
}

async function capture(requestId, variant, id = articleId) {
  await provider({ variant });
  const created = await submit(requestId, id);
  await handleJobs();
  const outcome = await waitWorkflows();
  await handleJobs();
  const workflow = outcome.instances.at(-1);
  if (workflow?.status !== 'complete') assert.fail(JSON.stringify(workflow));
  return { ...created.task, ...workflow.result, taskId: created.task.id };
}

async function replaySameTask(taskId) {
  const usageBefore = await firecrawlUsage();
  const response = await miniflare.dispatchFetch(`${feedOrigin}/__test/replay-job?index=0`, { method: 'POST' });
  if (!response.ok) assert.fail(await response.text());
  await waitWorkflows();
  assert.equal(await firecrawlUsage(), usageBefore);
}

async function handleJobs() {
  const response = await miniflare.dispatchFetch(`${feedOrigin}/__test/handle-jobs`, { method: 'POST' });
  if (!response.ok) assert.fail(await response.text());
  return response.json();
}

async function waitWorkflows(waitMs = 2000) {
  const response = await miniflare.dispatchFetch(`${feedOrigin}/__test/workflows?waitMs=${waitMs}`);
  if (!response.ok) assert.fail(await response.text());
  return response.json();
}

async function recover(advanceMs) {
  const response = await miniflare.dispatchFetch(`${feedOrigin}/__test/recover?advanceMs=${advanceMs}`, {
    method: 'POST',
  });
  if (!response.ok) assert.fail(await response.text());
  return response.json();
}

async function taskStatus(taskId) {
  const response = await miniflare.dispatchFetch(`${feedOrigin}/internal/capture-tasks/${taskId}`, {
    headers: { Authorization: 'Bearer test-admin-token' },
  });
  if (!response.ok) assert.fail(await response.text());
  return response.json();
}

async function firecrawlUsage() {
  const response = await miniflare.dispatchFetch(`${feedOrigin}/internal/status`, {
    headers: { Authorization: 'Bearer test-admin-token' },
  });
  if (!response.ok) assert.fail(await response.text());
  const status = await response.json();
  assert.ok(Array.isArray(status.usage));
  return status.usage
    .filter(({ kind }) => kind === 'firecrawl')
    .reduce((total, { used }) => total + Number(used), 0);
}

async function login() {
  const configurationResponse = await miniflare.dispatchFetch(`${feedOrigin}/__test/configuration`);
  if (!configurationResponse.ok) assert.fail(await configurationResponse.text());
  const configuration = await configurationResponse.json();
  assert.deepEqual(configuration, {
    baseUrl: true,
    authBaseUrl: true,
    clientId: true,
    clientSecret: true,
    encryptionKey: true,
  });
  const login = await miniflare.dispatchFetch(`${feedOrigin}/auth/login`, { redirect: 'manual' });
  assert.equal(login.status, 303);
  const loginCookie = cookie(login, '__Host-feed_login');
  const authorization = await authWorker.fetch(login.headers.get('Location'), { redirect: 'manual' });
  assert.equal(authorization.status, 302);
  const callback = await miniflare.dispatchFetch(authorization.headers.get('Location'), {
    redirect: 'manual',
    headers: { Cookie: `__Host-feed_login=${loginCookie}` },
  });
  assert.equal(callback.status, 303);
  const sessionCookie = cookie(callback, '__Host-feed_session');
  assert.ok(sessionCookie);
  return `__Host-feed_session=${sessionCookie}`;
}

function cookie(response, name) {
  return response.headers.getSetCookie()
    .find(value => value.startsWith(`${name}=`))
    ?.split(';')[0]?.slice(name.length + 1);
}

async function json(responsePromise) {
  const response = await responsePromise;
  if (!response.ok) assert.fail(await response.text());
  return response.json();
}

async function revisions(id, cookie) {
  return json(miniflare.dispatchFetch(`${feedOrigin}/api/articles/${id}/revisions`, {
    headers: { Cookie: cookie },
  }));
}

async function detail(id, revisionId, cookie) {
  const path = revisionId === undefined
    ? `/api/articles/${id}`
    : `/api/articles/${id}/revisions/${revisionId}`;
  return json(miniflare.dispatchFetch(`${feedOrigin}${path}`, { headers: { Cookie: cookie } }));
}

function fileUrl(id, revisionId) {
  return `${feedOrigin}/api/articles/${id}/revisions/${revisionId}/files/attachment-1.pdf`;
}

function snapshotUrl(id, revisionId) {
  return `${feedOrigin}/api/articles/${id}/revisions/${revisionId}/snapshot`;
}

async function file(id, revisionId, cookie) {
  const response = await miniflare.dispatchFetch(fileUrl(id, revisionId), {
    headers: { Cookie: cookie },
  });
  assert.equal(response.status, 200);
  return response;
}

async function waitFor(check) {
  let lastError;
  for (let index = 0; index < 100; index += 1) {
    try {
      await check();
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  throw lastError;
}

async function applyMigration(db, sql) {
  const statements = sql.split(/;\s*\n(?=CREATE|ALTER|PRAGMA|$)/)
    .map(statement => statement.trim())
    .filter(statement => statement && !/^PRAGMA\b/i.test(statement));
  for (const statement of statements) await db.prepare(statement).run();
}
