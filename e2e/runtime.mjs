import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';

import { seedSyntheticReadingArchive } from './reading-fixtures.mjs';

import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from 'miniflare';
import { createMailFixture } from './mail-runtime.mjs';
import { createIngestionFixture } from './ingestion-runtime.mjs';

export const FEED_E2E_BASE_COMMIT = 'dc57c11a324e9e0091dfc3f0c0ddf666f205069e';
export const AUTH_E2E_COMMIT = 'd9bf0c5e6d5cc459029da6a345991b8d0f13f514';

function base64Url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function reservePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolvePort(port));
    });
  });
}

function migrationStatements(sql) {
  const statements = [];
  let current = '';
  let trigger = false;
  for (const rawLine of sql.replace(/^\s*--.*$/gm, '').split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    current += (current ? '\n' : '') + line;
    if (/^\s*CREATE\s+TRIGGER/i.test(line)) trigger = true;
    if (trigger) {
      if (/^\s*END\s*;\s*$/i.test(line)) {
        statements.push(current.trim());
        current = '';
        trigger = false;
      }
      continue;
    }
    if (line.trim().endsWith(';')) {
      statements.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements.filter(statement => !/^PRAGMA\s+foreign_keys/i.test(statement));
}

async function applyMigrations(db, directory) {
  const files = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
  const applied = [];
  for (const name of files) {
    const sql = await readFile(join(directory, name), 'utf8');
    const statements = migrationStatements(sql);
    for (const statement of statements) await db.prepare(statement).run();
    applied.push({ name, sha256: createHash('sha256').update(sql).digest('hex'), statements: statements.length });
  }
  if (!applied.length) throw new Error('No migrations applied');
  return applied;
}

async function seedOAuthClient(db, { authOrigin, feedOrigin, clientSecret, clientId, approved = true, rpc = false }) {
  const clientSecretHash = createHash('sha256').update(clientSecret).digest('base64url');
  const now = new Date().toISOString();
  const issuer = new URL('/api/auth', authOrigin).href;
  const statements = [
    db.prepare(`INSERT OR IGNORE INTO oauthResource(id,identifier,name,accessTokenTtl,refreshTokenTtl,createdAt,updatedAt)
      VALUES ('feed-e2e-resource',?, 'Feed E2E',60,604800,?,?)`)
      .bind(issuer, now, now),
    db.prepare(`INSERT INTO oauthClient(id,clientId,clientSecret,disabled,skipConsent,enableEndSession,
      scopes,redirectUris,postLogoutRedirectUris,tokenEndpointAuthMethod,grantTypes,responseTypes,public,type,
      requirePKCE,name,uri,metadata,createdAt,updatedAt,applicationType)
      VALUES (?,?,?,0,?,1,?,?,?,?,?,?,0,'web',1,?,?,?,?,?,'web')`)
      .bind(
        `${clientId}-row`, clientId, clientSecretHash, approved ? 1 : 0,
        JSON.stringify(rpc ? [] : ['openid', 'profile', 'offline_access']),
        JSON.stringify(rpc ? [] : [`${feedOrigin}/auth/callback`]),
        JSON.stringify(rpc ? [] : [`${feedOrigin}/auth/logout`]),
        'client_secret_basic',
        JSON.stringify(rpc ? [] : ['authorization_code', 'refresh_token']),
        JSON.stringify(rpc ? [] : ['code']),
        'Feed E2E', feedOrigin,
        JSON.stringify({ subsystem: 'feed', ...(rpc ? { rpcMethods: ['getFeedPolicy', 'getFeedRecipient'] } : {}) }),
        now, now,
      ),
    db.prepare(`INSERT INTO oauthClientResource(id,clientId,resourceId,createdAt)
      VALUES (?,?,?,?)`).bind(`${clientId}-resource`, clientId, issuer, now),
  ];
  for (const statement of statements) await statement.run();
  const client = await db.prepare(`SELECT disabled,skipConsent,enableEndSession,scopes,redirectUris,postLogoutRedirectUris,
    tokenEndpointAuthMethod,grantTypes,responseTypes,public,type,requirePKCE,name,uri,metadata,createdAt,updatedAt,applicationType
    FROM oauthClient WHERE clientId=?`).bind(clientId).first();
  const expected = {
    disabled: 0,
    skipConsent: approved ? 1 : 0,
    enableEndSession: 1,
    scopes: JSON.stringify(rpc ? [] : ['openid', 'profile', 'offline_access']),
    redirectUris: JSON.stringify(rpc ? [] : [`${feedOrigin}/auth/callback`]),
    postLogoutRedirectUris: JSON.stringify(rpc ? [] : [`${feedOrigin}/auth/logout`]),
    tokenEndpointAuthMethod: 'client_secret_basic',
    grantTypes: JSON.stringify(rpc ? [] : ['authorization_code', 'refresh_token']),
    responseTypes: JSON.stringify(rpc ? [] : ['code']),
    public: 0,
    type: 'web',
    requirePKCE: 1,
    name: 'Feed E2E',
    uri: feedOrigin,
    metadata: JSON.stringify({ subsystem: 'feed', ...(rpc ? { rpcMethods: ['getFeedPolicy', 'getFeedRecipient'] } : {}) }),
    createdAt: now,
    updatedAt: now,
    applicationType: 'web',
  };
  for (const [key, value] of Object.entries(expected)) {
    if (client?.[key] !== value) {
      throw new Error(`OAuth client seed field ${key} did not read back as configured: ${JSON.stringify(client?.[key])}`);
    }
  }
  return { clientId, clientSecret };
}

export async function setFeedEntitlements(db, userId, { access = true, limit = 3 }) {
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO user_entitlement(user_id,subsystem,capability,value,updated_at)
      VALUES (?,'feed','access',?,?) ON CONFLICT(user_id,subsystem,capability) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
      .bind(userId, access ? '1' : '0', now),
    db.prepare(`INSERT INTO user_entitlement(user_id,subsystem,capability,value,updated_at)
      VALUES (?,'feed','sub_limit',?,?) ON CONFLICT(user_id,subsystem,capability) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
      .bind(userId, String(limit), now),
  ]);
}

export async function seedSyntheticNotification(db, bucket) {
  const id = 'e2e000000000000000000001';
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>FEED-01 合成通知</title></head>
<body><main><h1>FEED-01 合成通知</h1><p>这是本地 R2 中的源貌字节，不来自学校站点请求。</p></main></body></html>`;
  const bytes = new TextEncoder().encode(html);
  const objectHash = createHash('sha256').update(bytes).digest('hex');
  const key = `notifications/${id}/original.html`;
  const manifest = new TextEncoder().encode(JSON.stringify({ version: 1, requirements: [] }));
  const manifestHash = createHash('sha256').update(manifest).digest('hex');
  const manifestKey = `notifications/${id}/manifest.json`;
  await bucket.put(key, bytes, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
  await bucket.put(manifestKey, manifest, { httpMetadata: { contentType: 'application/json' } });
  const firstSeen = Date.parse('2026-10-15T09:01:00.000Z');
  const ready = Date.parse('2026-10-15T09:01:02.000Z');
  await db.batch([
    db.prepare(`INSERT INTO articles(id,source_id,url,title,published_at,discovered_at,status,snapshot_key,body_text)
      VALUES (?,'jwc',?, 'FEED-01 合成通知','2026-10-15',?,'archived',?,'这是 FEED-01 的预置阅读数据，不是抓取结果。')`)
      .bind(id, 'https://jwc.cqu.edu.cn/info/2026/feed-01.htm', new Date(firstSeen).toISOString(), key),
    db.prepare(`INSERT INTO article_sources(article_id,source_id,first_seen_at,last_seen_at,discovery_class,
      published_at,published_day,date_precision,source_timezone) VALUES (?,'jwc',?,?, 'migrated',?,'2026-10-15','minute','Asia/Shanghai')`)
      .bind(id, firstSeen, firstSeen, new Date(firstSeen).toISOString()),
    db.prepare(`INSERT INTO tasks(id,kind,business_key,source_id,article_id,payload_json,state,due_at,created_at,updated_at)
      VALUES (?,'capture',?,? ,?,'{}','succeeded',?,?,?)`)
      .bind(id, `capture:${id}`, 'jwc', id, new Date(ready).toISOString(), new Date(firstSeen).toISOString(), new Date(ready).toISOString()),
    db.prepare(`INSERT INTO artifact_objects(sha256,r2_key,byte_size,media_type,verified_at)
      VALUES (?,?,?, 'text/html; charset=utf-8',?)`).bind(objectHash, key, bytes.byteLength, new Date(firstSeen).toISOString()),
    db.prepare(`INSERT INTO artifact_objects(sha256,r2_key,byte_size,media_type,verified_at)
      VALUES (?,?,?, 'application/json',?)`).bind(manifestHash, manifestKey, manifest.byteLength, new Date(firstSeen).toISOString()),
    db.prepare(`INSERT INTO article_revisions(id,article_id,revision_no,capture_task_id,observed_at,state,
      requirement_generation,requirement_count,manifest_object_hash,raw_fingerprint,semantic_fingerprint,change_kind,
      title,published_at,source_metadata_json,ready_at)
      VALUES (?, ?,1,?,?,'ready',1,1,?,?,?, 'baseline',?,?,'{}',?)`)
      .bind(id, id, id, new Date(firstSeen).toISOString(), manifestHash,
        createHash('sha256').update(`${id}:raw`).digest('hex'),
        createHash('sha256').update(`${id}:semantic`).digest('hex'),
        'FEED-01 合成通知', new Date(firstSeen).toISOString(), new Date(ready).toISOString()),
    db.prepare(`INSERT INTO content_events(id,revision_id,article_id,kind,observed_at,ready_at,history_only,
      date_state,payload_hash,created_at) VALUES (?,?,?, 'initial',?,?,0,'verified',?,?)`)
      .bind(id, id, id, firstSeen, ready, createHash('sha256').update(`${id}:payload`).digest('hex'), new Date(ready).toISOString()),
    db.prepare(`INSERT INTO event_sources(event_id,source_id,article_source_first_seen_at,discovery_class,
      published_at,published_day,date_precision,source_timezone) VALUES (?,'jwc',?, 'migrated',?,'2026-10-15','minute','Asia/Shanghai')`)
      .bind(id, firstSeen, new Date(firstSeen).toISOString()),
  ]);
  return { id, objectHash, key, manifestHash, manifestKey };
}

export async function startFeedRuntime({ buildDir, stateDir, authDir, ingestion = false, disableConsumers = false, corruptReadingPdf = false, mail = false, disableMailConsumer = false }) {
  await rm(stateDir, { recursive: true, force: true });
  const feedBundle = await readFile(join(buildDir, 'feed', 'index.js'), 'utf8');
  const authBundle = await readFile(join(buildDir, 'auth', 'index.js'), 'utf8');
  const feedPort = await reservePort();
  const authPort = await reservePort();
  const oauthClientSecret = base64Url(randomBytes(32));
  const rpcClientSecret = base64Url(randomBytes(32));
  const controlSecret = base64Url(randomBytes(32));
  const modes = { rpcOutage: false, httpOutage: false, consentClient: false };
  const observations = [];
  const unexpected = [];
  const mails = new Map();
  const ingest = ingestion || mail ? createIngestionFixture({ dateOnly: mail }) : null;
  const mailFixture = mail ? createMailFixture() : null;
  let mf;
  let feedDb;
  let authDb;
  let readingArchive;
  let bucket;

  const denyUnexpected = async request => {
    const mailResponse = await mailFixture?.outbound(request, mf);
    if (mailResponse) return mailResponse;
    const fixtureResponse = await ingest?.outbound(request);
    if (fixtureResponse) return fixtureResponse;
    const url = new URL(request.url);
    if (url.origin === 'https://api.resend.com' && url.pathname === '/emails' && request.method === 'POST') {
      const mail = await request.json();
      const otp = mail.html?.match(/letter-spacing:6px">(\d{6})</)?.[1];
      if (!otp) throw new Error('Unexpected external email payload');
      for (const recipient of [].concat(mail.to)) {
        if (!recipient.endsWith('@example.test')) throw new Error('Non-synthetic email denied');
        mails.set(recipient, otp);
      }
      return Response.json({ id: crypto.randomUUID() });
    }
    unexpected.push(`${request.method} ${url.origin}${url.pathname}`);
    return new Response('Unexpected Worker request denied', { status: 502 });
  };

  const makeOptions = () => convertV4MiniflareOptions({
    name: 'feed-e2e',
    host: '127.0.0.1',
    port: feedPort,
    https: true,
    resourcePersistencePath: join(stateDir, 'resources'),
    log: new Log(LogLevel.ERROR),
    workers: [
      {
        name: 'feed',
        modules: [...(mailFixture ? [{ type: 'ESModule', path: join(buildDir, 'feed', 'mail-entry.mjs'), contents: mailFixture.module('./index.js', controlSecret) }] : []), { type: 'ESModule', path: join(buildDir, 'feed', 'index.js'), contents: feedBundle }],
        compatibilityDate: '2026-10-11',
        compatibilityFlags: ['nodejs_compat'],
        bindings: {
          BASE_URL: `https://127.0.0.1:${feedPort}`,
          AUTH_BASE_URL: `http://127.0.0.1:${authPort}`,
          FEED_AUTH_CLIENT_ID: modes.consentClient ? 'feed-e2e-consent' : 'feed-e2e-browser',
          FEED_AUTH_CLIENT_SECRET: oauthClientSecret,
          FEED_AUTH_RPC_CLIENT_ID: 'feed-e2e-rpc',
          FEED_AUTH_RPC_CLIENT_SECRET: rpcClientSecret,
          FEED_SESSION_ENCRYPTION_KEY: 'feed-e2e-session-encryption-key-never-use',
          ENVIRONMENT: 'test',
          POSTHOG_HOST: `https://127.0.0.1:${feedPort}`,
          CRAWL_ENABLED: 'false',
          TASK_RUNTIME_ENABLED: 'false',
          MAIL_ENABLED: 'false',
          SOURCE_MANAGEMENT_ENABLED: 'true',
          ARCHIVE_VERSIONS_ENABLED: 'true',
          ARCHIVE_READS_ENABLED: 'true',
          MAX_FIRECRAWL_PER_DAY: '0',
          MAX_OCR_PER_DAY: '0',
          MAX_PDF_OCR_PAGES_PER_DAY: '0',
          MAX_PDF_OCR_PAGES_PER_MONTH: '0',
          ...(ingest?.bindings ?? {}),
          ...(mailFixture?.bindings ?? {}),
        },
        d1Databases: { DB: 'feed-e2e-database' },
        r2Buckets: { ARCHIVE: 'feed-e2e-archive' },
        queueProducers: { FEED_JOBS: 'feed-e2e-jobs', FEED_EVENTS: 'feed-e2e-events', FEED_MAIL: 'feed-e2e-mail' },
        ...(ingest ? { queueConsumers: disableConsumers ? {} : { ...ingest.consumers, ...(mailFixture && !disableMailConsumer ? { 'feed-e2e-mail': { maxBatchSize: 1, maxBatchTimeout: 0, maxRetries: 0, deadLetterQueue: 'feed-e2e-dlq' } } : {}) } } : {}),
        workflows: {
          INGEST: { name: 'feed-e2e-ingest', className: 'FeedIngest' },
          PDF_OCR: { name: 'feed-e2e-pdf-ocr', className: 'PdfOcrWorkflow' },
          CAPTURE: { name: 'feed-e2e-capture', className: 'CaptureWorkflow' },
          DISCOVERY: { name: 'feed-e2e-discovery', className: 'DiscoveryWorkflow' },
          ARCHIVE_OCR: { name: 'feed-e2e-archive-ocr', className: 'ArchiveOcrWorkflow' },
        },
        serviceBindings: {
          ...(mailFixture ? { MAIL_E2E_GATE: () => mailFixture.queueGate() } : {}),
          AUTH: modes.httpOutage ? 'auth-outage' : 'auth',
          AUTH_FEED_RPC: { name: modes.rpcOutage ? 'auth-outage' : 'auth', entrypoint: 'AuthService' },
        },
        outboundService: denyUnexpected,
        assets: {
          directory: resolve('dist'),
          binding: 'ASSETS',
          run_worker_first: true,
          routerConfig: { has_user_worker: true },
          assetConfig: { not_found_handling: 'single-page-application' },
        },
      },
      ...(ingest ? [ingest.deadLetterObserver] : []),
      {
        name: 'auth',
        modules: [{ type: 'ESModule', path: join(buildDir, 'auth', 'index.js'), contents: authBundle }],
        compatibilityDate: '2026-05-01',
        compatibilityFlags: ['nodejs_compat'],
        unsafeDirectSockets: [{ host: '127.0.0.1', port: authPort, entrypoint: 'default' }],
        bindings: {
          BETTER_AUTH_URL: `http://127.0.0.1:${authPort}`,
          BETTER_AUTH_SECRET: 'synthetic-feed-e2e-auth-secret-never-use',
          ENCRYPTION_KEY: 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=',
          RESEND_API_KEY: 're_synthetic',
          ENVIRONMENT: 'development',
          BIND_EMAIL_DOMAIN: 'example.test',
          QUICKLOGIN_DEVICE_MODE: 'on',
          QUICKLOGIN_CLIENT_ID: 'quicklogin-test-client',
        },
        d1Databases: { DATABASE: 'auth-e2e-database' },
        durableObjects: {
          CQU_SESSION: 'CquSessionDO',
          CQU_LOGIN: { className: 'CquLoginContainer', useSQLite: true },
          CQU_QUICKLOGIN_ACCOUNT: { className: 'CquQuickloginAccountDO', useSQLite: true },
          CQU_QUICKLOGIN_DEVICE: { className: 'CquQuickloginDeviceDO', useSQLite: true },
        },
        outboundService: denyUnexpected,
        assets: {
          directory: resolve(authDir, 'frontend/dist'),
          binding: 'ASSETS',
          run_worker_first: true,
          routerConfig: { has_user_worker: true },
          assetConfig: { not_found_handling: 'single-page-application' },
        },
      },
      {
        name: 'auth-outage',
        modules: [{ type: 'ESModule', path: join(buildDir, 'auth', 'index.js'), contents: authBundle }],
        compatibilityDate: '2026-05-01',
        compatibilityFlags: ['nodejs_compat'],
        bindings: {
          BETTER_AUTH_URL: `http://127.0.0.1:${authPort}`,
          BETTER_AUTH_SECRET: 'synthetic-feed-e2e-auth-secret-never-use',
          ENCRYPTION_KEY: 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=',
          ENVIRONMENT: 'development',
        },
        outboundService: denyUnexpected,
      },
    ],
  });

  const control = createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== `Bearer ${controlSecret}` && !(request.method === 'GET' && request.url?.startsWith('/mail?') && !request.headers.origin)) {
        response.writeHead(403).end();
        return;
      }
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/mail') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ otp: mails.get(url.searchParams.get('email')) ?? null }));
        return;
      }
      if (request.method !== 'POST' || url.pathname !== '/control') {
        response.writeHead(404).end();
        return;
      }
      let body = '';
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      if (mailFixture && input.action.startsWith('mail-')) {
        const result = await mailFixture.control(input, { mf, db: feedDb, authDb, controlSecret });
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
        return;
      }
      if (ingest && input.action.startsWith('ingestion-')) {
        const result = await ingest.control(input, { mf, db: feedDb });
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
        return;
      }
      if (input.action === 'add-verified-source') {
        const now = Date.now();
        await feedDb.batch([
          feedDb.prepare(`INSERT INTO sources(id,site_id,name,url,list_url,config_json,config_version,enabled,
            refresh_interval_sec,next_discovery_at,validation_state,validated_at,source_timezone,created_at,updated_at)
            VALUES ('e2e-new','7fd03676e5751e9b6dd95ecb','FEED 新栏目','https://jwc.cqu.edu.cn/','https://jwc.cqu.edu.cn/e2e/list','{}',1,1,
            86400,0,'verified',?, 'Asia/Shanghai',?,?)`).bind(now, now, now),
        ]);
      } else if (input.action === 'set-entitlements') {
        await setFeedEntitlements(authDb, input.userId, { access: input.access, limit: input.limit });
      } else if (input.action === 'reading-manifest') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          ...readingArchive.manifest,
          currentPdfSha256: readingArchive.manifest.currentPdf.sha256,
          currentPdfByteSize: readingArchive.manifest.currentPdf.byteSize,
          oldPdfSha256: readingArchive.manifest.oldPdf.sha256,
          ordinaryPdfSha256: readingArchive.manifest.ordinaryPdf.sha256,
        }));
        return;
      } else if (input.action === 'remove-reading-object' || input.action === 'restore-reading-object') {
        const object = readingArchive.objects.get(input.kind);
        if (!object) {
          response.writeHead(400).end();
          return;
        }
        if (input.action === 'remove-reading-object') await bucket.delete(object.key);
        else await bucket.put(object.key, object.bytes, { httpMetadata: { contentType: object.mediaType } });
      } else if (input.action === 'revoke-oauth') {
        const now = new Date().toISOString();
        await authDb.batch([
          authDb.prepare(`UPDATE oauthAccessToken SET revoked=? WHERE userId=? AND clientId='feed-e2e-browser' AND revoked IS NULL`)
            .bind(now, input.userId),
          authDb.prepare(`UPDATE oauthRefreshToken SET revoked=? WHERE userId=? AND clientId='feed-e2e-browser' AND revoked IS NULL`)
            .bind(now, input.userId),
        ]);
      } else if (['set-rpc-outage', 'set-http-outage', 'set-consent-client'].includes(input.action)) {
        const key = { 'set-rpc-outage': 'rpcOutage', 'set-http-outage': 'httpOutage', 'set-consent-client': 'consentClient' }[input.action];
        modes[key] = Boolean(input.enabled);
        await mf.setOptions(makeOptions());
        feedDb = await mf.getD1Database('DB', 'feed');
        authDb = await mf.getD1Database('DATABASE', 'auth');
        bucket = await mf.getR2Bucket('ARCHIVE', 'feed');
        ingest?.rebind(bucket);
      } else if (['session-state', 'expire-session', 'expire-access'].includes(input.action)) {
        const rows = await feedDb.prepare('SELECT token_hash,payload,revision FROM feed_session').all();
        const key = await crypto.subtle.importKey('raw', createHash('sha256').update('feed-session-v1:feed-e2e-session-encryption-key-never-use').digest(), 'AES-GCM', false, ['decrypt']);
        let result = null;
        for (const row of rows.results) {
          const [,iv,payload] = row.payload.split('.');
          const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(iv,'base64url') }, key, Buffer.from(payload,'base64url'));
          const credentials = JSON.parse(new TextDecoder().decode(bytes));
          if (credentials.sub === input.userId && input.action === 'expire-access') {
            // Fault injection expires an already-issued credential; tokens still come only from real OAuth.
            credentials.accessExpiresAt = Date.now() - 1000;
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const encryptionKey = await crypto.subtle.importKey('raw', createHash('sha256').update('feed-session-v1:feed-e2e-session-encryption-key-never-use').digest(), 'AES-GCM', false, ['encrypt']);
            const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encryptionKey, new TextEncoder().encode(JSON.stringify(credentials)));
            await feedDb.prepare('UPDATE feed_session SET payload=? WHERE token_hash=?').bind(`v1.${Buffer.from(iv).toString('base64url')}.${Buffer.from(encrypted).toString('base64url')}`, row.token_hash).run();
            await authDb.prepare("UPDATE oauthAccessToken SET expiresAt=? WHERE userId=? AND clientId='feed-e2e-browser'").bind(new Date(Date.now() - 1000).toISOString(), input.userId).run();
            observations.push({ action: 'expire-access', revision: row.revision });
          }
          if (credentials.sub === input.userId && input.action === 'expire-session') {
            await feedDb.prepare('UPDATE feed_session SET expires_at=? WHERE token_hash=?').bind(Date.now() - 1000, row.token_hash).run();
          }
          if (credentials.sub === input.userId) result = {
            revision: row.revision,
            subject: credentials.sub,
            readyForRefresh: credentials.accessExpiresAt <= Date.now() + 30000,
            expiresInSeconds: Math.round((credentials.accessExpiresAt - Date.now()) / 1000),
            tokenFingerprint: createHash('sha256').update(credentials.accessToken).digest('hex'),
          };
        }
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
        return;
      } else if (input.action === 'read-subscriptions') {
        const rows = await feedDb.prepare('SELECT id,name,requested_enabled,priority,email_mode,deleted_at,config_version FROM subscriptions WHERE owner_sub=? ORDER BY priority,created_at,id').bind(input.userId).all();
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(rows.results));
        return;
      } else if (input.action === 'csrf-probe') {
        if (
          typeof input.cookie !== 'string' || !input.cookie ||
          typeof input.path !== 'string' || !input.path.startsWith('/api/subscriptions/') ||
          input.method !== 'PATCH' || input.origin !== 'https://csrf.example.test' ||
          typeof input.body !== 'object' || input.body === null
        ) {
          response.writeHead(400).end();
          return;
        }
        const workerResponse = await mf.dispatchFetch(`https://127.0.0.1:${feedPort}${input.path}`, {
          method: 'PATCH',
          headers: {
            cookie: input.cookie,
            origin: input.origin,
            'content-type': 'application/json',
          },
          body: JSON.stringify(input.body),
        });
        response.writeHead(workerResponse.status, { 'content-type': 'application/json' });
        response.end(await workerResponse.text());
        return;
      } else {
        response.writeHead(400).end();
        return;
      }
      observations.push({ action: input.action, ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}) });
      response.writeHead(204).end();
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error.message }));
    }
  });

  try {
    mf = new Miniflare(makeOptions());
    await mf.ready;
    feedDb = await mf.getD1Database('DB', 'feed');
    authDb = await mf.getD1Database('DATABASE', 'auth');
    const migrations = {
      feed: await applyMigrations(feedDb, 'migrations'),
      auth: await applyMigrations(authDb, join(authDir, 'drizzle/migrations')),
    };
    const baseline = {
      subscriptions: (await feedDb.prepare('SELECT COUNT(*) AS n FROM subscriptions').first()).n,
      bffSessions: (await feedDb.prepare('SELECT COUNT(*) AS n FROM feed_session').first()).n,
      authSessions: (await authDb.prepare('SELECT COUNT(*) AS n FROM session').first()).n,
      archiveObjects: (await (await mf.getR2Bucket('ARCHIVE', 'feed')).list()).objects.length,
    };
    if (Object.values(baseline).some(n => n !== 0)) throw new Error('Fresh runtime contains prior user state');
    await authDb.prepare("INSERT INTO entitlement_config(key,value) VALUES ('invitation_required','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
    bucket = await mf.getR2Bucket('ARCHIVE', 'feed');
    const synthetic = ingest ? null : await seedSyntheticNotification(feedDb, bucket);
    if (ingest) await ingest.initialize(feedDb, bucket);
    else {
      readingArchive = await seedSyntheticReadingArchive(feedDb, bucket);
      if (corruptReadingPdf) {
        const object = readingArchive.objects.get('current-pdf');
        await bucket.put(object.key, Buffer.concat([object.bytes, Buffer.from('\nFEED02 corrupted bytes negative control\n')]), { httpMetadata: { contentType: object.mediaType } });
      }
    }
    await new Promise(done => control.listen(0, '127.0.0.1', done));
    const authOrigin = (await mf.unsafeGetDirectURL('auth')).href;
    const feedOrigin = `https://127.0.0.1:${feedPort}`;
    const oauth = await seedOAuthClient(authDb, { authOrigin, feedOrigin, clientId: 'feed-e2e-browser', clientSecret: oauthClientSecret });
    await seedOAuthClient(authDb, { authOrigin, feedOrigin, clientId: 'feed-e2e-consent', clientSecret: oauthClientSecret, approved: false });
    await seedOAuthClient(authDb, { authOrigin, feedOrigin, clientId: 'feed-e2e-rpc', clientSecret: rpcClientSecret, rpc: true });
    const readiness = [];
    for (const path of ['/health', '/api/session', '/login']) {
      const ready = await localGet(`${feedOrigin}${path}`);
      if (ready.status !== 200) throw new Error(`Feed readiness ${path} returned ${ready.status}`);
      readiness.push({ path, status: ready.status });
    }
    return {
      feedOrigin,
      readiness,
      migrations,
      baseline,
      authOrigin,
      controlOrigin: `http://127.0.0.1:${control.address().port}`,
      controlSecret,
      async sensitiveValues() {
        const values = [oauthClientSecret, rpcClientSecret, controlSecret, ingest?.bindings.ADMIN_TOKEN, mailFixture?.bindings.RESEND_API_KEY, mailFixture?.bindings.RESEND_WEBHOOK_SECRET, ...mails.values()].filter(Boolean);
        for (const table of ['session', 'oauthAccessToken', 'oauthRefreshToken']) {
          const rows = await authDb.prepare(`SELECT token FROM ${table}`).all();
          values.push(...rows.results.map(row => row.token).filter(Boolean));
        }
        return values;
      },
      observations,
      ingestion: ingest,
      mail: mailFixture,
      async mailState() { return mailFixture.control({ action: 'mail-state' }, { mf, db: feedDb }); },
      get feedDb() { return feedDb; },
      get authDb() { return authDb; },
      oauth,
      synthetic,
      mails,
      async close() {
        ingest?.release();
        mailFixture?.release();
        const ports = [feedPort, authPort, control.address()?.port].filter(Boolean);
        const results = await Promise.allSettled([
          new Promise((done, fail) => control.close(error => error ? fail(error) : done())),
          mf.dispose(),
        ]);
        results.push(...await Promise.allSettled([rm(stateDir, { recursive: true, force: true })]));
        const readback = await Promise.allSettled([
          ...ports.map(assertPortClosed),
          stat(stateDir).then(() => { throw new Error('Runtime storage remains after cleanup'); }, error => { if (error.code !== 'ENOENT') throw error; }),
        ]);
        const errors = [...results, ...readback].filter(result => result.status === 'rejected').map(result => result.reason);
        if (unexpected.length) errors.push(new Error(`Unexpected Worker egress denied: ${unexpected.join(', ')}`));
        if (errors.length) throw new AggregateError(errors, 'Feed E2E runtime cleanup failed');
        return { portsClosed: ports, storageRemoved: true, unexpectedEgress: unexpected };
      },
    };
  } catch (error) {
    const cleanup = await Promise.allSettled([
      new Promise((done, fail) => control.close(e => e && e.code !== 'ERR_SERVER_NOT_RUNNING' ? fail(e) : done())),
      mf?.dispose(),
    ]);
    cleanup.push(...await Promise.allSettled([rm(stateDir, { recursive: true, force: true })]));
    const cleanupErrors = cleanup.filter(r => r.status === 'rejected').map(r => r.reason);
    const failure = new AggregateError([error, ...cleanupErrors], 'Feed runtime startup failed');
    failure.cleanup = { status: cleanupErrors.length ? 'failed' : 'passed', storageRemoved: !cleanupErrors.length };
    throw failure;
  }
}

async function assertPortClosed(port) {
  await new Promise((done, fail) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(2000);
    socket.once('connect', () => { socket.destroy(); fail(new Error(`Port ${port} remains open`)); });
    socket.once('timeout', () => { socket.destroy(); fail(new Error(`Port ${port} cleanup readback timed out`)); });
    socket.once('error', error => error.code === 'ECONNREFUSED' ? done() : fail(error));
  });
}

async function localGet(url) {
  return new Promise((done, fail) => {
    const req = httpsRequest(url, { rejectUnauthorized: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => done({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
      response.once('error', fail);
    });
    req.setTimeout(10000, () => req.destroy(new Error('Local HTTPS readiness timed out')));
    req.once('error', fail);
    req.end();
  });
}
