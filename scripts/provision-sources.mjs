#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';

const DEFAULT_CATALOG = fileURLToPath(new URL('../worker/source-catalog.json', import.meta.url));
const ARTICLE_PATTERN = '^/info/\\d+/\\d+\\.htm$';
const ACTIVE_TASK = new Set(['queued', 'starting', 'running', 'deferred']);
const RESTORE_IDS = ['civil', 'intex', 'news', 'xgb'];

function parseOptions(argv) {
  const args = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      apply: {type: 'boolean', default: false},
      catalog: {type: 'string'},
      'credentials-file': {type: 'string'},
      'retry-failed': {type: 'boolean', default: false},
      'restore-existing': {type: 'boolean', default: false},
      'timeout-minutes': {type: 'string'},
    },
  }).values;
  const timeoutMinutes = args['timeout-minutes'] === undefined ? 120 : Number(args['timeout-minutes']);
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 1440) {
    throw new Error('--timeout-minutes must be an integer from 1 to 1440');
  }
  return {
    apply: args.apply,
    catalogPath: resolve(args.catalog ?? DEFAULT_CATALOG),
    credentialsFile: args['credentials-file'],
    retryFailed: args['retry-failed'],
    restoreExisting: args['restore-existing'],
    timeoutMinutes,
  };
}

async function readCatalog(path) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (!value || value.version !== 1 || !Array.isArray(value.sites)) throw new Error('Catalog must contain version 1 and sites');
  const sites = value.sites.map(site => {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(site.key ?? '')) throw new Error(`Invalid site key: ${site.key}`);
    return {
      key: site.key,
      name: site.name,
      origin: new URL(site.origin).origin,
      sampleArticleUrl: site.sampleArticleUrl,
      columns: (site.columns ?? []).map(column => ({
        name: column.name,
        listUrl: column.listUrl,
        refreshIntervalSec: column.refreshIntervalSec ?? 86400,
      })),
    };
  });
  return {version: 1, restore: value.restore ?? {}, sites};
}

function dryRun(catalog, options) {
  return {
    ok: true,
    mode: 'dry-run',
    catalogPath: options.catalogPath,
    timeoutMinutes: options.timeoutMinutes,
    retryFailed: options.retryFailed,
    restoreExisting: options.restoreExisting,
    sites: catalog.sites.map(site => ({
      key: site.key,
      origin: site.origin,
      createRequestId: `catalog-v1-${site.key}`,
      columns: site.columns.map(column => ({...column, timezone: 'Asia/Shanghai'})),
    })),
    restore: options.restoreExisting ? catalog.restore : null,
    safety: {network: false, credentials: false, enableOnlyAfterSucceededVerification: true},
  };
}

async function readToken(options, token) {
  if (token) return token;
  if (options.credentialsFile) {
    const value = JSON.parse(await readFile(options.credentialsFile, 'utf8'));
    if (typeof value.ADMIN_TOKEN !== 'string' || !value.ADMIN_TOKEN) throw new Error('Credentials file needs ADMIN_TOKEN');
    return value.ADMIN_TOKEN;
  }
  if (!process.env.FEED_ADMIN_TOKEN) throw new Error('--apply needs FEED_ADMIN_TOKEN or --credentials-file');
  return process.env.FEED_ADMIN_TOKEN;
}

function makeApi(baseUrl, token, fetchImpl, sleep) {
  const base = new URL(baseUrl);
  return async function api(path, method = 'GET', body) {
    let response, data;
    for (let attempt = 0;; attempt++) {
      try {
        response = await fetchImpl(new URL(path, base), {
          method,
          headers: {Authorization: `Bearer ${token}`, ...(body && {'Content-Type': 'application/json'})},
          body: body && JSON.stringify(body),
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
        });
        data = response.headers.get('content-type')?.includes('json') ? await response.json() : null;
        break;
      } catch (error) {
        // A lost write response may already have committed on the server.
        if (method !== 'GET' || attempt >= 2 || !['TypeError', 'TimeoutError', 'AbortError'].includes(error.name)) throw error;
        await sleep(1000 * 2 ** attempt);
      }
    }
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}: ${path}`);
      error.status = response.status;
      error.quota = response.status === 402 || /quota|balance|insufficient credits?|payment required/i.test(String(data?.error ?? ''));
      throw error;
    }
    return data;
  };
}

function progress(message) {
  process.stderr.write(`[${new Date().toISOString()}] ${message}\n`);
}

function requestKey(sourceId, listUrl, retry) {
  const hash = createHash('sha256').update(listUrl).digest('hex').slice(0, 16);
  return `catalog-v1-${sourceId}-${hash}${retry ? `-retry-${Date.now()}` : ''}`;
}

function validationFailure(sourceId, task) {
  const detail = task?.lastError ?? task?.error ?? task?.state ?? 'missing task';
  const error = new Error(`Sample verification failed for ${sourceId}: ${detail}`);
  error.quota = /quota|balance|insufficient credits?|payment required|402/i.test(String(detail));
  return error;
}

async function poll(api, sourceId, configVersion, deadline, sleep) {
  for (;;) {
    const {source} = await api(`/internal/sources/${sourceId}`);
    if (source.configVersion !== configVersion) throw new Error(`Source ${sourceId} changed during verification`);
    const {task} = source.validationTaskId
      ? await api(`/internal/capture-tasks/${source.validationTaskId}`) : {task: null};
    if (!ACTIVE_TASK.has(task?.state)) {
      if (source.validationState === 'verified' && task?.state === 'succeeded') return source;
      throw validationFailure(sourceId, task);
    }
    if (Date.now() >= deadline) throw new Error(`Validation timeout for ${sourceId}`);
    await sleep(15_000);
  }
}

async function verifyAndEnable(api, source, listUrl, options, sleep, force = false) {
  const deadline = Math.min(options.deadline, Date.now() + 10 * 60_000);
  if (source.enabled) {
    if (!force && source.validationState === 'verified') return {status: 'already-enabled-verified'};
    throw new Error(`Source ${source.id} must be disabled before verification`);
  }
  let current = source;
  if (!force && source.validationTaskId) {
    const {task} = await api(`/internal/capture-tasks/${source.validationTaskId}`);
    if (ACTIVE_TASK.has(task?.state)) current = await poll(api, source.id, source.configVersion, deadline, sleep);
  }
  if (current.validationState !== 'verified' || force) {
    if (current.validationState === 'failed' && !options.retryFailed) {
      throw new Error(`Source ${current.id} has a failed validation; rerun with --retry-failed`);
    }
    await api(`/internal/sources/${current.id}/verify`, 'POST', {
      requestId: requestKey(current.id, listUrl, current.validationState === 'failed' || force && current.validationState === 'verified'),
    });
    current = await poll(api, current.id, current.configVersion, deadline, sleep);
  }
  const enabled = await api(`/internal/sources/${current.id}`, 'PATCH', {enabled: true});
  if (!enabled.source.enabled || enabled.source.validationState !== 'verified') throw new Error(`Enable rejected for ${current.id}`);
  return {status: 'verified-and-enabled', taskId: current.validationTaskId ?? null};
}

async function provisionCatalog(catalog, options, token, fetchImpl, sleep) {
  const api = makeApi(options.baseUrl, token, fetchImpl, sleep);
  const deadline = options.deadline;
  const existingSites = (await api('/internal/sites')).sites;
  const existingSources = (await api('/internal/sources')).sources;
  const results = [];
  const failures = [];
  let quota = false;

  outer: for (const site of catalog.sites) {
    const targetOrigin = new URL(site.origin).origin;
    let siteId = existingSites.find(row => new URL(row.origin).origin === targetOrigin)?.id;
    for (const column of site.columns) {
      const label = `${site.key}:${column.name}`;
      progress(`${label} start`);
      const result = {siteKey: site.key, column: column.name, listUrl: column.listUrl};
      try {
        if (Date.now() >= deadline) throw new Error('Overall provisioning timeout reached');
        if (!siteId) siteId = (await api('/internal/sites', 'POST', {
          name: site.name, origin: site.origin, requestId: `catalog-v1-${site.key}`,
        })).site.id;
        const matches = existingSources.filter(source => source.listUrl === column.listUrl);
        if (matches.length > 1) throw new Error(`Multiple sources use ${column.listUrl}`);
        let source = matches[0];
        if (!source) {
          source = (await api('/internal/sources', 'POST', {
            siteId, name: column.name, listUrl: column.listUrl, articlePattern: ARTICLE_PATTERN,
            refreshIntervalSec: column.refreshIntervalSec, timezone: 'Asia/Shanghai', sampleArticleUrl: site.sampleArticleUrl,
          })).source;
          existingSources.push(source);
          result.created = true;
        } else {
          const drift = source.name !== column.name || source.refreshIntervalSec !== column.refreshIntervalSec
            || source.timezone !== 'Asia/Shanghai' || source.config?.articlePattern !== ARTICLE_PATTERN
            || source.config?.sampleArticleUrl !== site.sampleArticleUrl;
          if (drift) {
           if (source.enabled) source = (await api(`/internal/sources/${source.id}`, 'PATCH', {enabled: false})).source;
           source = (await api(`/internal/sources/${source.id}`, 'PATCH', {
             name: column.name, refreshIntervalSec: column.refreshIntervalSec, timezone: 'Asia/Shanghai',
             articlePattern: ARTICLE_PATTERN, sampleArticleUrl: site.sampleArticleUrl,
           })).source;
           result.configurationUpdated = true;
         }
        }
        if (source.siteId !== siteId) throw new Error(`Source ${source.id} belongs to a different site`);
        result.sourceId = source.id;
        Object.assign(result, await verifyAndEnable(api, source, column.listUrl, options, sleep, result.configurationUpdated === true));
        progress(`${label} ${result.status}`);
        results.push(result);
      } catch (error) {
        result.status = 'failed';
        result.error = redact(error.message, token);
        failures.push({siteKey: site.key, column: column.name, sourceId: result.sourceId ?? null, error: result.error});
        progress(`${label} failed: ${result.error}`);
        results.push(result);
        if (error.quota) { quota = true; break outer; }
        if (Date.now() >= deadline) break outer;
      }
    }
  }

  if (options.restoreExisting && !quota && Date.now() < deadline) {
    for (const id of RESTORE_IDS) {
      progress(`restore:${id} start`);
      const result = {restoreId: id};
      try {
        let source = existingSources.find(row => row.id === id);
        if (!source) throw new Error(`Existing source ${id} not found`);
        if (id === 'xgb') {
          if (source.enabled) source = (await api(`/internal/sources/${id}`, 'PATCH', {enabled: false})).source;
          if (source.config?.sampleArticleUrl !== catalog.restore.xgb?.sampleArticleUrl) {
            source = (await api(`/internal/sources/${id}`, 'PATCH', {sampleArticleUrl: catalog.restore.xgb.sampleArticleUrl})).source;
          }
          Object.assign(result, await verifyAndEnable(api, source, source.listUrl, options, sleep, true), {forceVerification: true});
        } else if (!source.enabled && source.validationState === 'verified') {
          await api(`/internal/sources/${id}`, 'PATCH', {enabled: true});
          Object.assign(result, {status: 'enabled-verified'});
        } else {
          if (!source.enabled || source.validationState !== 'verified') throw new Error(`Existing source ${id} is not verified`);
          Object.assign(result, {status: 'already-enabled'});
        }
        progress(`restore:${id} ${result.status}`);
      } catch (error) {
        result.status = 'failed';
        result.error = redact(error.message, token);
        failures.push({restoreId: id, error: result.error});
        progress(`restore:${id} failed: ${result.error}`);
        if (error.quota) { quota = true; results.push(result); break; }
      }
      results.push(result);
    }
  }

  return {ok: failures.length === 0, mode: 'apply', baseUrl: options.baseUrl, timeoutMinutes: options.timeoutMinutes,
    retryFailed: options.retryFailed, restoreExisting: options.restoreExisting, results, failures, quotaStopped: quota,
    timedOut: Date.now() >= deadline};
}

function redact(value, token) {
  return token ? String(value).split(token).join('[redacted]') : String(value);
}

export async function run(argv, {
  fetch: fetchImpl = globalThis.fetch,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  token,
  baseUrl,
} = {}) {
  const options = parseOptions(argv);
  const catalog = await readCatalog(options.catalogPath);
  if (!options.apply) return dryRun(catalog, options);
  const target = new URL(baseUrl ?? process.env.FEED_URL ?? 'https://feed.cqu.moe');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && loopback)) {
    throw new Error('FEED_URL must use HTTPS (HTTP is allowed only for loopback testing)');
  }
  options.baseUrl = target.origin;
  options.deadline = Date.now() + options.timeoutMinutes * 60_000;
  return provisionCatalog(catalog, options, await readToken(options, token), fetchImpl, sleep);
}

if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then(summary => {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    process.exitCode = summary.ok ? 0 : 1;
  }, error => {
    process.stdout.write(`${JSON.stringify({ok: false, error: redact(error.message, process.env.FEED_ADMIN_TOKEN ?? '')})}\n`);
    process.exitCode = 1;
  });
}
