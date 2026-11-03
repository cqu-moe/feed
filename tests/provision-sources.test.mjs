import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {test} from 'node:test';
import {promisify} from 'node:util';
import {run} from '../scripts/provision-sources.mjs';

const exec = promisify(execFile);
const sessionCookie = '__Host-feed_session=test-session-cookie';
const RESTORE_IDS = ['civil', 'intex', 'news', 'xgb'];

test('default dry run reads the catalog without credentials or network', async () => {
  const {stdout, stderr} = await exec(process.execPath, ['scripts/provision-sources.mjs'], {
    env: {...process.env, FEED_SESSION_COOKIE: ''},
  });
  const summary = JSON.parse(stdout);
  assert.equal(summary.mode, 'dry-run');
  assert.equal(summary.safety.network, false);
  assert.equal(summary.safety.credentials, false);
  assert.equal(summary.sites.flatMap(site => site.columns).length, 51);
  assert.ok(summary.sites.flatMap(site => site.columns).every(column => column.refreshIntervalSec === 86400));
  assert.equal(stderr, '');
  assert.equal(stdout.includes(sessionCookie), false);
});

test('transport failures retry bounded reads without replaying a possibly committed write', async t => {
  for (const mode of ['transient-read', 'persistent-read', 'committed-write']) await t.test(mode, async () => {
    const api = apiFixture();
    let failures = 0;
    const attempt = run(['--apply', '--catalog', 'tests/fixtures/one-column.json'], {
      baseUrl: 'https://feed.test', cookie: sessionCookie, sleep: async () => {},
      fetch: async (url, options) => {
        if (new URL(url).pathname === '/internal/sites') {
          if (options.method === 'GET' && mode !== 'committed-write' && (mode === 'persistent-read' || failures === 0)) {
            failures++;
            throw new TypeError('fetch failed');
          }
          if (options.method === 'POST' && mode === 'committed-write') {
            failures++;
            await api.fetch(url, options);
            throw new TypeError('fetch failed');
          }
        }
        return api.fetch(url, options);
      },
    });
    if (mode === 'persistent-read') {
      await assert.rejects(attempt, /fetch failed/);
      assert.equal(failures, 3);
      assert.equal(api.sites.length, 0);
    } else {
      const result = await attempt;
      assert.equal(result.ok, mode === 'transient-read');
      assert.equal(failures, 1);
      assert.equal(api.sites.length, 1);
      assert.equal(api.calls.filter(call => call.method === 'POST' && call.path === '/internal/sites').length, 1);
    }
  });
});

test('repeat apply reuses enabled verified sources without recreating or reverifying', async () => {
  const api = apiFixture();
  api.sources.created = {
    id: 'created', siteId: 'site-uc', name: '新闻中心', listUrl: 'https://uc.cqu.edu.cn/index/xwzx.htm',
    enabled: true, validationState: 'verified', validationTaskId: null, configVersion: 1,
    config: {articlePattern: '^/info/\\d+/\\d+\\.htm$', sampleArticleUrl: 'https://uc.cqu.edu.cn/info/1004/4525.htm'},
    refreshIntervalSec: 3600,
    timezone: 'Asia/Shanghai',
    articlePattern: '^/info/\\d+/\\d+\\.htm$',
  };
  api.sites.push({id: 'site-uc', origin: 'https://uc.cqu.edu.cn/', enabled: true});
  await run(['--apply', '--catalog', 'tests/fixtures/one-column.json'], {baseUrl: 'https://feed.test', cookie: sessionCookie, fetch: api.fetch});
  const callsBefore = api.calls.length;

  const summary = await run(['--apply', '--catalog', 'tests/fixtures/one-column.json'], {baseUrl: 'https://feed.test', cookie: sessionCookie, fetch: api.fetch});

  assert.equal(summary.ok, true);
  assert.equal(summary.results[0].status, 'already-enabled-verified');
  assert.equal(api.calls.length - callsBefore, 2);
  assert.deepEqual(api.calls.slice(callsBefore).map(call => call.method), ['GET', 'GET']);
});

test('failed verification stays disabled and a quota task error stops the run', async () => {
  const api = apiFixture({outcomes: {failing: {state: 'failed', error: 'HTTP 402: insufficient credits'}, passing: {state: 'verified'}}});
  const summary = await run(['--apply', '--catalog', catalogPath('failing-passing.json')], {
    baseUrl: 'https://feed.test', cookie: sessionCookie, fetch: api.fetch,
    sleep: async () => {
      for (const source of Object.values(api.sources)) {
        const outcome = api.outcomes[source.id];
        if (outcome?.state !== 'verified') continue;
        source.validationState = 'verified';
        api.tasks[source.validationTaskId].state = 'succeeded';
      }
    },
  });

  assert.equal(summary.ok, false);
  assert.equal(summary.results[0].status, 'failed');
  assert.equal(summary.results[0].sourceId, 'failing');
  assert.equal(summary.failures[0].sourceId, 'failing');
  assert.equal(api.sources.failing.enabled, false);
  assert.equal(api.sources.failing.validationState, 'failed');
  assert.equal(summary.quotaStopped, true);
  assert.equal(JSON.stringify(summary).includes(sessionCookie), false);
});

test('draft source resumes its running validation task without duplicate submission', async () => {
  const api = apiFixture({sources: [draftSource('running')]});
  const summary = await run(['--apply', '--catalog', catalogPath('running.json')], {
    baseUrl: 'https://feed.test', cookie: sessionCookie, fetch: api.fetch, sleep: async () => {
      api.sources.running.validationState = 'verified';
      api.tasks.running.state = 'succeeded';
    },
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.results[0].status, 'verified-and-enabled');
  assert.equal(summary.results[0].taskId, 'running');
  assert.equal(api.calls.some(call => call.path.endsWith('/verify')), false);
  assert.equal(api.sources.running.enabled, true);
});

test('configuration drift pauses, patches, and revalidates an existing source', async () => {
  const api = apiFixture({sources: [{
    id: 'drift', siteId: 'site-uc', name: '新闻中心', listUrl: 'https://uc.cqu.edu.cn/index/xwzx.htm',
    enabled: true, validationState: 'verified', validationTaskId: null, configVersion: 1,
    refreshIntervalSec: 86400, timezone: 'Asia/Shanghai',
    config: {articlePattern: '^/info/\\d+/\\d+\\.htm$', sampleArticleUrl: 'https://uc.cqu.edu.cn/info/1004/4525.htm'},
  }]});
  api.sites.push({id: 'site-uc', origin: 'https://uc.cqu.edu.cn/', enabled: true});
  const summary = await run(['--apply', '--catalog', 'tests/fixtures/one-column.json', '--retry-failed'], {
    baseUrl: 'https://feed.test', cookie: sessionCookie, fetch: api.fetch,
  });

  const patch = api.calls.find(call => call.method === 'PATCH' && call.body?.refreshIntervalSec === 3600);
  assert.notEqual(patch, undefined, JSON.stringify(api.calls));
  assert.equal(summary.ok, true);
  assert.equal(summary.results[0].status, 'verified-and-enabled');
  assert.equal(api.calls.some(call => call.path.endsWith('/verify')), true, JSON.stringify(api.calls));
  assert.equal(api.calls[api.calls.indexOf(patch)-1].body.enabled, false);
  assert.equal(api.sources.drift.enabled, true);
});

test('failed source with a deferred task resumes it instead of submitting a duplicate', async () => {
  const api = apiFixture({sources: [{
    ...draftSource('deferred'), validationState: 'failed',
  }]});
  api.tasks.deferred.state = 'deferred';
  const summary = await run(['--apply', '--catalog', catalogPath('running.json')], {
    baseUrl: 'https://feed.test', cookie: sessionCookie, fetch: api.fetch, sleep: async () => {
      api.tasks.deferred.state = 'succeeded';
      api.sources.deferred.validationState = 'verified';
    },
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.results[0].status, 'verified-and-enabled');
  assert.equal(api.calls.some(call => call.path.endsWith('/verify')), false);
  assert.equal(api.sources.deferred.enabled, true);
});


test('xgb restore updates its sample and waits for a running verification to finish', async () => {
  const api = apiFixture({outcomes: {xgb: {state: 'running'}}, sources: [existingSource('xgb'), ...RESTORE_IDS.slice(0, 3).map(id => ({
    id, siteId: id, name: id, listUrl: `https://${id}.test/`, enabled: false,
    validationState: 'verified', validationTaskId: null, configVersion: 1, config: {},
  }))]});
  let seenRunningTask = false;
  const summary = await run(['--apply', '--catalog', catalogPath('xgb-restore.json'), '--restore-existing'], {
    baseUrl: 'https://feed.test', cookie: sessionCookie, fetch: api.fetch, sleep: async () => {
      if (seenRunningTask) throw new Error('poll should stop at terminal source and task state');
      seenRunningTask = true;
      api.tasks['xgb-task'].state = 'succeeded';
      api.sources.xgb.validationState = 'verified';
    },
  });

  assert.equal(summary.ok, true, JSON.stringify(summary));
  assert.equal(summary.results.find(row => row.restoreId === 'xgb').status, 'verified-and-enabled');
  assert.equal(seenRunningTask, true);
  assert.equal(api.sources.xgb.config.sampleArticleUrl, 'https://xgb.cqu.edu.cn/info/1024/5808.htm');
  assert.equal(api.calls.some(call => call.path.endsWith('/verify')), true, JSON.stringify(api.calls));
  assert.equal(api.sources.xgb.enabled, true);
});

function catalogPath(name) {
  return new URL(`./fixtures/${name}`, import.meta.url).pathname;
}

function draftSource(id) {
  return {
    id, siteId: 'site-uc', name: 'Running', listUrl: 'https://uc.cqu.edu.cn/running.htm',
    enabled: false, validationState: 'draft', validationTaskId: id, configVersion: 1,
    config: {articlePattern: '^/info/\\d+/\\d+\\.htm$', sampleArticleUrl: 'https://uc.cqu.edu.cn/info/1004/4525.htm'},
    refreshIntervalSec: 86400, timezone: 'Asia/Shanghai',
  };
}

function existingSource(id) {
  return {
    id, siteId: 'legacy-xgb', name: '学工部', listUrl: 'https://xgb.cqu.edu.cn/legacy.htm',
    enabled: false, validationState: 'draft', validationTaskId: `${id}-task`, configVersion: 2,
    config: {articlePattern: '^/info/\\d+/\\d+\\.htm$', sampleArticleUrl: 'https://xgb.cqu.edu.cn/old.htm'},
    timezone: 'Asia/Shanghai',
  };
}

function apiFixture({sources = [], outcomes = {}} = {}) {
  let created = 0;
  const state = {
    calls: [],
    credentials: sessionCookie,
    sites: [],
    sources: Object.fromEntries(sources.map(source => [source.id, source])),
    tasks: Object.fromEntries(sources.filter(source => source.validationTaskId).map(source => [
      source.validationTaskId,
      {id: source.validationTaskId, state: source.validationState === 'draft' ? 'running' : 'succeeded'},
    ])),
    outcomes,
  };
  state.fetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    assert.equal(init.headers?.Cookie, sessionCookie);
    assert.equal(init.headers?.Origin, 'https://feed.test');
    assert.equal(init.headers?.Authorization, undefined);
    const body = init.body ? JSON.parse(init.body) : null;
    state.calls.push({method, path: url.pathname, body});
    if (method === 'GET') {
      if (url.pathname === '/internal/sites') return response({sites: state.sites});
      if (url.pathname === '/internal/sources') return response({sources: Object.values(state.sources)});
      if (url.pathname.startsWith('/internal/sources/')) {
        const id = url.pathname.split('/').pop();
        return response({source: state.sources[id]});
      }
      if (url.pathname.startsWith('/internal/capture-tasks/')) {
        const id = url.pathname.split('/').pop();
        return response({task: state.tasks[id]});
      }
    }
    if (url.pathname === '/internal/sites' && method === 'POST') {
      const site = {id: 'site-uc', name: body.name, origin: body.origin, enabled: true};
      state.sites.push(site);
      return response({site}, 201);
    }
    if (url.pathname === '/internal/sources' && method === 'POST') {
      const id = sources.length ? `created-${++created}` : (created++ === 0 ? 'failing' : 'passing');
      const source = {...body, id, enabled: false, validationState: 'draft', validationTaskId: null,
        configVersion: 1, config: {articlePattern: body.articlePattern, sampleArticleUrl: body.sampleArticleUrl}};
      state.sources[id] = source;
      return response({source}, 201);
    }
    if (url.pathname.endsWith('/verify') && method === 'POST') {
      const id = url.pathname.split('/').at(-2);
      const configured = state.outcomes[id] ?? {state: 'verified'};
      const outcome = configured.state;
      const task = {id: state.sources[id].validationTaskId ?? `${id}-task`, state: 'running'};
      Object.assign(state.sources[id], {validationState: 'draft', validationTaskId: task.id});
      state.tasks[task.id] = task;
      if (outcome === 'verified') {
        task.state = 'succeeded';
        state.sources[id].validationState = 'verified';
      }
      if (outcome === 'failed') {
        task.state = 'failed';
        task.error = configured.error;
        state.sources[id].validationState = 'failed';
      }
      return response({source: state.sources[id], task}, 202);
    }
    if (url.pathname.startsWith('/internal/sources/') && method === 'PATCH') {
      const id = url.pathname.split('/').pop();
      const configKeys=['name','refreshIntervalSec','timezone','articlePattern','sampleArticleUrl'];
      const changed=configKeys.some(key=>body[key]!==undefined && body[key] !== (['articlePattern','sampleArticleUrl'].includes(key)?state.sources[id].config[key]:state.sources[id][key]));
      if(changed){state.sources[id].configVersion++;state.sources[id].validationState='draft';}
      Object.assign(state.sources[id], body);
      if (body.enabled !== undefined) state.sources[id].enabled = body.enabled;
      if (body.enabled === true && state.sources[id].validationState !== 'verified') state.sources[id].enabled = false;
      for(const key of ['articlePattern','sampleArticleUrl'])if(body[key]!==undefined)state.sources[id].config[key]=body[key];
      return response({source: state.sources[id]});
    }
    throw new Error(`Unexpected API call ${method} ${url.pathname}`);
  };
  return state;
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
}
