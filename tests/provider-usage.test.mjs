import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { loginAdmin, oauthProvider } from './helpers/oauth-provider.mjs';

const endpoint = '/internal/operations/provider-usage';
const workerModulesStub = {
  name: 'provider-usage-worker-modules-stub',
  setup(buildApi) {
    buildApi.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cloudflare-workers', namespace: 'provider-usage-worker-modules-stub' }));
    buildApi.onLoad({ filter: /^cloudflare-workers$/, namespace: 'provider-usage-worker-modules-stub' }, () => ({
      loader: 'js',
      contents: 'export class DurableObject{}; export class WorkerEntrypoint{}; export class WorkflowEntrypoint{constructor(env={}){this.env=env;}}',
    }));
    buildApi.onResolve({ filter: /^posthog-node\/edge$/ }, () => ({ path: 'posthog-edge', namespace: 'provider-usage-worker-modules-stub' }));
    buildApi.onLoad({ filter: /^posthog-edge$/, namespace: 'provider-usage-worker-modules-stub' }, () => ({
      loader: 'js',
      contents: 'export const PostHog=class{};',
    }));
  },
};

test('admin provider usage reports an allowlisted TextIn balance and ignores Firecrawl credentials', async () => {
  const { mf, admin } = await fixture(async (url) => {
    if (url === 'https://api.textin.com/user/finance/balance') {
      return Response.json({
        code: 200,
        data: {
          balance: 10.2,
          available_balance: 9.2,
          unavailable_balance: 1,
          pay_type: 2,
          postpaid_amount: 1.2,
          unpaid: 0,
          t_coin_give_total: 10000,
          t_coin_give_used: 2500,
          sensitiveExtra: 'textin-secret',
        },
      });
    }
    if (url === 'https://api.textin.com/user/finance/package?api_path=https%3A%2F%2Fapi.textin.com%2Fai%2Fservice%2Fv1%2Fpdf_to_markdown&include_all=0') {
      return Response.json({
        code: 200,
        data: {
          list: [{
            id: 1001,
            service_list: ['ocr'],
            start_time: '2026-10-01 00:00:00',
            end_time: '2026-11-01 00:00:00',
            total_count: 10000,
            remain_count: 7500,
            use_count: 2500,
            sensitiveExtra: 'package-secret',
          }],
        },
      });
    }
    return new Response('unexpected provider request', { status: 500 });
  });

  try {
    const response = await mf.dispatchFetch(`https://feed.test${endpoint}`, {
      headers: admin.headers,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {
      providers: {
        textin: {
          status: 'ok',
          balance: {
            balance: 10.2,
            available_balance: 9.2,
            unavailable_balance: 1,
            pay_type: 2,
            postpaid_amount: 1.2,
            unpaid: 0,
            t_coin_give_total: 10000,
            t_coin_give_used: 2500,
          },
          packages: [{
            id: 1001,
            service_list: ['ocr'],
            start_time: '2026-10-01 00:00:00',
            end_time: '2026-11-01 00:00:00',
            total_count: 10000,
            remain_count: 7500,
            use_count: 2500,
          }],
          missingFields: [],
          unavailableRequests: [],
        },
      },
    });

    const calls = await fixtureCalls(mf);
    assert.deepEqual(calls.map(call => call.url), [
      'https://api.textin.com/user/finance/balance',
      'https://api.textin.com/user/finance/package?api_path=https%3A%2F%2Fapi.textin.com%2Fai%2Fservice%2Fv1%2Fpdf_to_markdown&include_all=0',
    ]);
    assert.deepEqual(await fixtureTimeouts(mf), [10000, 8000, 8000]);
    for (const call of calls) {
      assert.equal(call.init.method, 'GET');
      assert.equal(call.init.redirect, 'manual');
      assert.equal(call.init.body, undefined);
    }
    for (const call of calls) {
      assert.equal(call.init.headers.Authorization, undefined);
      assert.equal(call.init.headers['x-ti-app-id'], 'textin-app');
      assert.equal(call.init.headers['x-ti-secret-code'], 'textin-secret-code');
    }
  } finally {
    await mf.dispose();
  }
});

test('provider usage requires an administrator and read-only GET', async () => {
  const { mf, admin } = await fixture(async () => {
    throw new Error('provider must not be called');
  });

  try {
    const unauthorized = await mf.dispatchFetch(`https://feed.test${endpoint}`);
    assert.equal(unauthorized.status, 401);
    const invalid = await mf.dispatchFetch(`https://feed.test${endpoint}`, {
      headers: { Authorization: 'Bearer wrong-admin-token' },
    });
    assert.equal(invalid.status, 401);
    const mutation = await mf.dispatchFetch(`https://feed.test${endpoint}`, {
      method: 'POST',
      headers: admin.headers,
    });
    assert.equal(mutation.status, 405);
    assert.deepEqual(await fixtureCalls(mf), []);
  } finally {
    await mf.dispose();
  }
});

test('provider usage preserves available TextIn requests through partial failures and missing fields', async () => {
  const { mf, admin } = await fixture(async url => {
    if (url === 'https://api.textin.com/user/finance/balance') {
      return Response.json({
        code: 200,
        data: {
          balance: 12.5,
          available_balance: 12.5,
          unavailable_balance: 0,
          postpaid_amount: 0,
          unpaid: 0,
          t_coin_give_total: 10000,
          t_coin_give_used: 8000,
          leaked: 'textin-balance-raw-secret',
        },
      });
    }
    return new Response('textin package failure includes textin-package-raw-secret', { status: 500 });
  });

  try {
    const response = await mf.dispatchFetch(`https://feed.test${endpoint}`, {
      headers: admin.headers,
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.providers.textin, {
      status: 'partial',
      balance: {
        balance: 12.5,
        available_balance: 12.5,
        unavailable_balance: 0,
        postpaid_amount: 0,
        unpaid: 0,
        t_coin_give_total: 10000,
        t_coin_give_used: 8000,
      },
      packages: null,
      missingFields: ['pay_type'],
      unavailableRequests: ['packages'],
      errors: { packages: { kind: 'http', status: 500 } },
    });
    const raw = JSON.stringify(body);
    assert.doesNotMatch(raw, /raw-secret|Authorization|x-ti-secret-code|FIRECRAWL_API_KEY|TEXTIN_SECRET_CODE/);
  } finally {
    await mf.dispose();
  }
});

test('provider usage accepts the remaining_count alias and rejects oversized responses without leaking them', async () => {
  const { mf, admin } = await fixture(async url => {
    if (url === 'https://api.textin.com/user/finance/balance')
      return new Response('x'.repeat(256 * 1024 + 1), { status: 200 });
    if (url === 'https://api.textin.com/user/finance/package?api_path=https%3A%2F%2Fapi.textin.com%2Fai%2Fservice%2Fv1%2Fpdf_to_markdown&include_all=0') {
      return Response.json({
        code: 200,
        data: {
          list: [{
            id: 2002,
            service_list: ['ocr'],
            start_time: '2026-10-01 00:00:00',
            end_time: '2026-11-01 00:00:00',
            total_count: 10000,
            remaining_count: 10000,
            use_count: 0,
            leaked: 'package-alias-secret',
          }],
        },
      });
    }
    return new Response('unexpected provider request', { status: 500 });
  });

  try {
    const response = await mf.dispatchFetch(`https://feed.test${endpoint}`, {
      headers: admin.headers,
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.providers.textin.errors, { balance: { kind: 'response_too_large' } });
    assert.deepEqual(body.providers.textin.packages, [{
      id: 2002,
      service_list: ['ocr'],
      start_time: '2026-10-01 00:00:00',
      end_time: '2026-11-01 00:00:00',
      total_count: 10000,
      remain_count: 10000,
      use_count: 0,
    }]);
    assert.doesNotMatch(JSON.stringify(body), /oversize-test-secret|package-alias-secret/);
  } finally {
    await mf.dispose();
  }
});

test('provider usage does not call Firecrawl or TextIn without TextIn credentials', async () => {
  const { mf, admin } = await fixture(async () => {
    throw new Error('provider must not be called');
  }, {
    FIRECRAWL_API_KEY: 'firecrawl-key',
    TEXTIN_APP_ID: '',
    TEXTIN_SECRET_CODE: '',
  });

  try {
    const response = await mf.dispatchFetch(`https://feed.test${endpoint}`, {
      headers: admin.headers,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      providers: {
        textin: { status: 'not_configured', balance: null, packages: null, missingFields: [], unavailableRequests: [] },
      },
    });
    assert.deepEqual(await fixtureCalls(mf), []);
  } finally {
    await mf.dispose();
  }
});

test('provider redirects fail closed without sending credentials to the redirect target', async()=>{
  const {mf,admin}=await fixture(async()=>new Response('provider redirect',{status:302,headers:{Location:'https://untrusted.example/collect'}}));
  try{
    const response=await mf.dispatchFetch(`https://feed.test${endpoint}`,{headers:admin.headers});
    const body=await response.json();
    assert.deepEqual(body.providers.textin.errors,{balance:{kind:'http',status:302},packages:{kind:'http',status:302}});
    const calls=await fixtureCalls(mf);
    assert.equal(calls.length,2);
    assert.ok(calls.every(call=>call.init.redirect==='manual'&&!call.url.includes('untrusted.example')));
  }finally{await mf.dispose()}
});

async function fixture(providerFetch, bindings = {}) {
  const provider = oauthProvider();
  const bundle = await build({
    stdin: {
      contents: `import worker from './worker/index.mjs';
        globalThis.PROVIDER_USAGE_CALLS=[];
        globalThis.PROVIDER_USAGE_TIMEOUTS=[];
        globalThis.PROVIDER_USAGE_FETCH=${providerFetch};
        export default {
          async fetch(request, env, context) {
            const url=new URL(request.url);
            if(url.pathname==='/fixture/provider-usage/calls')return Response.json(globalThis.PROVIDER_USAGE_CALLS);
            if(url.pathname==='/fixture/provider-usage/timeouts')return Response.json(globalThis.PROVIDER_USAGE_TIMEOUTS);
            if(url.pathname==='${endpoint}') {
              const actualFetch=globalThis.fetch;
              const actualTimeout=AbortSignal.timeout;
              AbortSignal.timeout=milliseconds=>{
                globalThis.PROVIDER_USAGE_TIMEOUTS.push(milliseconds);
                return actualTimeout(milliseconds);
              };
              globalThis.fetch=(resource,init)=>{
                new Request(resource,init); // Preserve native Workers Request option validation at the HTTP boundary.
                globalThis.PROVIDER_USAGE_CALLS.push({url:String(resource),init});
                return globalThis.PROVIDER_USAGE_FETCH(String(resource),init);
              };
              try{return await worker.fetch(request,env,context);}
              finally{
                globalThis.fetch=actualFetch;
                AbortSignal.timeout=actualTimeout;
              }
            }
            return worker.fetch(request,env,context);
          },
        };`,
      resolveDir: process.cwd(),
      sourcefile: 'provider-usage-fixture.mjs',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    external: ['node:buffer', 'node:*'],
    plugins: [workerModulesStub],
    target: 'es2022',
  });
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-10-11',
    compatibilityFlags: ['nodejs_compat'],
    bindings: {
      ...provider.bindings,
      BASE_URL: 'https://feed.test',
      FIRECRAWL_API_KEY: 'firecrawl-key',
      TEXTIN_APP_ID: 'textin-app',
      TEXTIN_SECRET_CODE: 'textin-secret-code',
      ...bindings,
    },
    serviceBindings: {AUTH: request => provider.fetch(request)},
    d1Databases: ['DB'],
  }));
  const db = await mf.getD1Database('DB');
  await applyMigration(db, await readFile('migrations/0002_auth.sql', 'utf8'));
  const admin = await loginAdmin(mf, provider);
  return {mf, admin};
}

async function applyMigration(db, sql) {
  for (const statement of sql.split(/;\s*\n(?=CREATE|ALTER|PRAGMA|INSERT|UPDATE|$)/)
    .map(statement => statement.trim())
    .filter(statement => statement && !/^PRAGMA\b/i.test(statement))) {
    await db.prepare(statement).run();
  }
}

async function fixtureCalls(mf) {
  const response = await mf.dispatchFetch('https://feed.test/fixture/provider-usage/calls');
  return response.json();
}

async function fixtureTimeouts(mf) {
  const response = await mf.dispatchFetch('https://feed.test/fixture/provider-usage/timeouts');
  return response.json();
}
