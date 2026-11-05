import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBailianClient } from '../worker/bailian-client.mjs';

const env = {
  BAILIAN_API_KEY: 'bailian-key',
  BAILIAN_WORKSPACE_ID: 'feed-workspace',
  BAILIAN_CATEGORY_ID: 'feed-category',
  BAILIAN_INDEX_ID: 'feed-index',
  BAILIAN_SEARCH_SERVICE_ID: 'feed-search-agent',
};
const noticeText = '# 补考通知\n挂科以后可以申请补考。';

async function withFetch(mockFetch, action) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function withDigest(action) {
  const originalDigest = crypto.subtle.digest;
  crypto.subtle.digest = async (algorithm, data) => createHash(algorithm.toLowerCase()).update(data).digest();
  try {
    return await action();
  } finally {
    crypto.subtle.digest = originalDigest;
  }
}

async function route(calls, handler) {
  return withFetch(async (url, init) => {
    const parsed = new URL(url);
    const request = { url: parsed, init, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined };
    calls.push(request);
    const response = await handler(request);
    if (response === undefined) throw new Error(`unexpected Bailian request: ${url.pathname}${url.search}`);
    await response.clone().arrayBuffer();
    return response;
  }, async () => {
    const client = createBailianClient(env);
    const file = await client.registerFile({ name: 'notice.md', text: noticeText, tags: ['site:jwc', 'source:news'] });
    assert.equal(file, 'file-1');
    const jobId = await client.startImport([file]);
    assert.equal(jobId, 'job-1');
    assert.deepEqual(await client.checkImport(jobId), {
      state: 'done',
      files: [{ fileId: file, state: 'done' }],
    });
    assert.deepEqual(await client.search({
      query: '挂科以后怎么考试',
      tagGroups: [['site:jwc'], ['source:news', 'source:notice']],
    }), [{
      fileId: 'file-1',
      content: '可以申请补考',
      heading: '补考安排',
    }]);
    await client.removeDocument('file-1');
    await client.removeFile('file-1');
  });
}

test('register, import, search, and deletion use the documented Bailian protocol', async () => {
  const calls = [];
  const client = createBailianClient(env);
  await withDigest(async () => {
    await route(calls, ({ url, init, body }) => {
      if (url.href === 'https://oss-cn-beijing.aliyuncs.com/upload?signature=test') {
      assert.equal(init.headers.Authorization, undefined);
      assert.equal(init.headers['x-bailian-extra'], 'lease-extra');
      assert.equal(init.headers['Content-Type'], 'text/markdown');
      assert.deepEqual(new Uint8Array(init.body), new TextEncoder().encode(noticeText));
      return new Response(null, { status: 200 });
    }
      if (url.pathname === '/api/v1/connector/dash/applyFileUploadLease') {
      assert.deepEqual(body, {
        category: 'feed-category',
        fileName: 'notice.md',
        sizeBytes: String(new TextEncoder().encode(noticeText).length),
        contentMd5: createHash('md5').update(noticeText).digest('base64'),
      });
      return Response.json({
        code: 'Success',
        status: 200,
        data: {
          type: 'OSS.PreSignedUrl',
          leaseId: 'lease-1',
          param: {
            method: 'PUT',
            url: 'https://oss-cn-beijing.aliyuncs.com/upload?signature=test',
            headers: { 'x-bailian-extra': 'lease-extra', 'Content-Type': 'text/markdown' },
          },
        },
      });
    }
      if (url.pathname === '/api/v1/connector/dash/addFile') {
      assert.deepEqual(body, {
        leaseId: 'lease-1',
        category: 'feed-category',
        categoryType: 'UNSTRUCTURED',
        parser: 'AUTO_SELECT',
        tags: ['site:jwc', 'source:news'],
      });
      return Response.json({ code: 'Success', status_code: 200, data: { fileId: 'file-1' } });
    }
      if (url.pathname === '/api/v1/indices/rag/index/job/create') {
      assert.deepEqual(body, {
        indexId: 'feed-index',
        sourceType: 'DATA_CENTER_FILE',
        docIds: ['file-1'],
      });
      return Response.json({
        code: 'Success', status_code: 200, data: { ingestionId: 'job-1', status: 'PENDING' },
      });
    }
    if (url.pathname === '/api/v1/indices/rag/index_job/status') {
      assert.equal(url.searchParams.get('index_id'), 'feed-index');
      assert.equal(url.searchParams.get('job_id'), 'job-1');
      assert.equal(url.searchParams.get('page_size'), '100');
      return Response.json({
        code: 'Success', status_code: 200, data: { total_count: 1, ingestion_status: 'COMPLETED', rows: [{ doc_id: 'file-1', status: 'FINISH' }] },
      });
    }
      if (url.pathname === '/api/v1/indices/knowledge/search') {
      assert.deepEqual(body, {
        agent_id: 'feed-search-agent',
        query: '挂科以后怎么考试',
        images: [],
        kb_search_configs: [{
          id: 'feed-index',
          search_filters: [
            { tags: ['site:jwc'] },
            { tags: ['source:news', 'source:notice'] },
          ],
        }],
      });
      return Response.json({
        success: true, status: 'SUCCESS', data: { nodes: [{ metadata: { doc_id: 'file-1', title: '补考安排', content: '可以申请补考' } }] },
      });
    }
      if (url.pathname === '/api/v1/indices/rag/index/delete_file') {
      assert.deepEqual(body, { index_id: 'feed-index', doc_ids: ['file-1'] });
      return Response.json({ code: 'Success', status_code: 200, data: { deleted: [] }, success: true, status: 'SUCCESS' });
    }
      if (url.pathname === '/api/v1/connector/dash/deleteFile') {
      assert.deepEqual(body, { fileId: 'file-1' });
      return Response.json({ code: 'Success', status_code: 200, data: {} });
    }
    });
  });

  assert.deepEqual(calls.map(call => call.url.href), [
    'https://feed-workspace.cn-beijing.maas.aliyuncs.com/api/v1/connector/dash/applyFileUploadLease',
    'https://oss-cn-beijing.aliyuncs.com/upload?signature=test',
    'https://feed-workspace.cn-beijing.maas.aliyuncs.com/api/v1/connector/dash/addFile',
    'https://feed-workspace.cn-beijing.maas.aliyuncs.com/api/v1/indices/rag/index/job/create',
    'https://feed-workspace.cn-beijing.maas.aliyuncs.com/api/v1/indices/rag/index_job/status?index_id=feed-index&job_id=job-1&page_number=1&page_size=100',
    'https://feed-workspace.cn-beijing.maas.aliyuncs.com/api/v1/indices/knowledge/search',
    'https://feed-workspace.cn-beijing.maas.aliyuncs.com/api/v1/indices/rag/index/delete_file',
    'https://feed-workspace.cn-beijing.maas.aliyuncs.com/api/v1/connector/dash/deleteFile',
  ]);
  for (const call of calls.filter(call => call.init.method === 'POST')) {
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.Authorization, 'Bearer bailian-key');
    assert.equal(call.init.redirect, 'manual');
    assert.ok(call.init.signal instanceof AbortSignal);
  }
  const upload = calls[1];
  assert.equal(upload.init.method, 'PUT');
  assert.equal(upload.init.redirect, 'manual');
  assert.equal(upload.init.headers.Authorization, undefined);
  assert.ok(upload.init.signal instanceof AbortSignal);

  for (const [operation, response] of [
    [() => client.removeDocument('file-1'), { code: 'Success', status_code: 200, data: { deleted: [] }, success: false, status: 'SUCCESS' }],
    [() => client.removeDocument('file-1'), { code: 'Success', status_code: 200, data: { deleted: [] }, success: false, status: 'FAILED' }],
    [() => client.removeFile('file-1'), { code: 'Success', status: 200, data: {}, success: false, status: 'SUCCESS' }],
    [() => client.removeFile('file-1'), { code: 'Success', status: 200, data: {}, success: false, status: 'FAILED' }],
  ]) {
    await withFetch(() => Response.json(response), async () => {
      await assert.rejects(operation, error => {
        assert.equal(error.kind, 'response');
        return true;
      });
    });
  }
});

test('findFile reconciles an addFile timeout only when name and content length match', async () => {
  const client = createBailianClient(env);
  const cases = [
    { files: [{ fileId: 'file-1', fileName: 'notice.md', sizeBytes: new TextEncoder().encode(noticeText).length }], expected: 'file-1' },
    { files: [{ fileId: 'file-1', fileName: 'notice.md', sizeBytes: 1 }], expected: null },
    { files: [
      { fileId: 'file-1', fileName: 'notice.md', sizeBytes: new TextEncoder().encode(noticeText).length },
      { fileId: 'file-2', fileName: 'notice.md', sizeBytes: new TextEncoder().encode(noticeText).length },
    ], expected: null },
    { files: [], expected: null },
  ];
  for (const item of cases) {
    let requested;
    const found = await withDigest(() => withFetch(async (url, init) => {
      const pathname = new URL(url).pathname;
      const body = JSON.parse(init.body);
      if (pathname.endsWith('/describeFile')) {
        assert.deepEqual(body, { fileId: item.expected });
        return Response.json({
          code: 'Success',
          status: 200,
          data: {
            fileId: item.expected,
            fileName: 'notice.md',
            sizeBytes: new TextEncoder().encode(noticeText).length,
            category: 'feed-category',
          },
        });
      }
      requested = body;
      return Response.json({ code: 'Success', status: 200, data: { fileList: item.files } });
    }, () => client.findFile({ name: 'notice.md', text: noticeText })));
    assert.equal(found, item.expected);
    assert.deepEqual(requested, { categoryId: 'feed-category', fileName: 'notice', maxResult: 100 });
  }
});

test('import status maps every file before reporting completion', async () => {
  const client = createBailianClient(env);
  const cases = [
    { status: 'RUNNING', rows: [{ doc_id: 'a', status: 'RUNNING' }, { doc_id: 'b', code: 'FINISH' }], expected: { state: 'pending', files: [{ fileId: 'a', state: 'pending' }, { fileId: 'b', state: 'done' }] } },
    { status: 'COMPLETED', rows: [{ doc_id: 'a', code: 'FINISH' }, { doc_id: 'b', status: 'INSERT_ERROR' }], expected: { state: 'failed', files: [{ fileId: 'a', state: 'done' }, { fileId: 'b', state: 'failed' }] } },
  ];
  for (const item of cases) {
    const result = await withFetch(() => Response.json({
      code: 'Success', status_code: 200, data: { total_count: 2, ingestion_status: item.status, rows: item.rows },
    }), () => client.checkImport('job-1'));
    assert.deepEqual(result, item.expected);
  }

  await withFetch(() => Response.json({
    code: 'Success', status_code: 200, data: { total_count: 2, ingestion_status: 'COMPLETED', rows: [{ doc_id: 'a', status: 'FINISH' }] },
  }), async () => {
    await assert.rejects(() => client.checkImport('job-1'), error => error.kind === 'response');
  });
});

test('Bailian redirects, credentials, timeouts, and oversized responses stay isolated', async () => {
  const client = createBailianClient(env);
  const secretBody = new Response('leaked bailian-key', {
    status: 302, headers: { location: 'https://untrusted.example/collect' },
  });
  const calls = [];
  await withFetch(async (url, init) => {
    calls.push({ url: String(url), init });
    return secretBody;
  }, async () => {
    await assert.rejects(() => client.search({ query: '补考' }), error => error.kind === 'http' && error.status === 302);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.redirect, 'manual');
  assert.notEqual(calls[0].url, 'https://untrusted.example/collect');

  for (const [timeoutMs, operation] of [
    [15000, () => client.search({ query: '补考' })],
    [15000, () => client.registerFile({ name: 'notice.md', text: noticeText })],
  ]) {
    await withDigest(() => withFetch(async () => {
      const abort = new Error('This operation was aborted');
      abort.name = 'TimeoutError';
      throw abort;
    }, async () => {
      await assert.rejects(operation, error => {
        assert.equal(error.kind, 'timeout');
        assert.equal(error.timeoutMs, timeoutMs);
        assert.doesNotMatch(error.message, /bailian-key/);
        return true;
      });
    }));
  }

  await withFetch(() => new Response('x'.repeat(2 * 1024 * 1024 + 1)), async () => {
    await assert.rejects(() => client.search({ query: '补考' }), error => error.kind === 'response' && !/bailian-key/.test(error.message));
  });
});

test('unsafe redirects, OSS origins, headers, and unvalidated responses fail closed', async () => {
  const lease = {
    code: 'Success', status: 200,
    data: {
      type: 'OSS.PreSignedUrl', leaseId: 'lease-1',
      param: {
        method: 'PUT',
        url: 'https://oss-cn-beijing.aliyuncs.com/upload',
        headers: { 'x-bailian-extra': 'lease' },
      },
    },
  };
  const cases = [
    'https://untrusted.example/upload',
    'http://oss-cn-beijing.aliyuncs.com/upload',
    'https://user:password@oss-cn-beijing.aliyuncs.com/upload',
    'https://aliyuncs.com/upload',
  ];
  for (const value of cases) {
    const client = createBailianClient(env);
    await withDigest(() => withFetch(async (url, init) => {
      assert.equal(url, `https://feed-workspace.cn-beijing.maas.aliyuncs.com/api/v1/connector/dash/applyFileUploadLease`);
      assert.ok(init.signal instanceof AbortSignal);
      return Response.json({ ...lease, data: { ...lease.data, param: { ...lease.data.param, url: value } } });
    }, async () => {
      await assert.rejects(() => client.registerFile({ name: 'notice.md', text: noticeText }), error => error.kind === 'response');
    }));
  }

  const invalidHeaders = [
    { Authorization: 'bearer bailian-key' },
    { [new Array(130).fill('a').join('')]: 'value' },
    { 'x-safe': 'value\r\nAuthorization: bearer bailian-key' },
  ];
  for (const headers of invalidHeaders) {
    const client = createBailianClient(env);
    await withDigest(() => withFetch(() => Response.json({ ...lease, data: { ...lease.data, param: { ...lease.data.param, headers } } }), async () => {
      await assert.rejects(() => client.registerFile({ name: 'notice.md', text: noticeText }), error => {
        assert.equal(error.kind, 'response');
        return true;
      });
    }));
  }

  const invalidPayloads = [
    { code: 'InvalidApiKey', status: 400, message: 'key bailian-key invalid' },
    { code: 'Success', status: 200, data: null },
    { success: true, status: 'SUCCESS', data: {} },
    { success: true, status: 'SUCCESS', data: { nodes: [{ metadata: { doc_id: 'file-1' } }] } },
  ];
  for (const payload of invalidPayloads) {
    const client = createBailianClient(env);
    await withFetch(() => Response.json(payload), async () => {
      await assert.rejects(() => client.search({ query: '补考' }), error => {
        assert.equal(error.kind, payload.data?.nodes ? 'request' : 'response');
        assert.doesNotMatch(error.message, /bailian-key/);
        return true;
      });
    });
  }
});

test('rejects invalid public inputs before any network call', async () => {
  const client = createBailianClient(env);
  const operations = [
    () => client.registerFile({ name: 'nested/file.md', text: noticeText }),
    () => client.registerFile({ name: 'notice.md', text: '' }),
    () => client.registerFile({ name: 'notice.md', text: noticeText, tags: ['site:jwc', 'site:jwc'] }),
    () => client.registerFile({ name: 'notice.md', text: noticeText, tags: Array(101).fill('x') }),
    () => client.startImport([]),
    () => client.startImport(Array(101).fill('file-1')),
    () => client.startImport(['bad file id']),
    () => client.checkImport('../job'),
    () => client.search({ query: '补考', tagGroups: [['site:jwc'], []] }),
    () => client.removeDocument('bad file id'),
    () => client.removeFile('bad file id'),
  ];
  for (const operation of operations) {
    await withFetch(async () => { throw new Error('network must not be called'); }, async () => {
      await assert.rejects(operation, error => {
        assert.equal(error.kind, 'request');
        return true;
      });
    });
  }
  assert.throws(() => createBailianClient({ ...env, BAILIAN_API_KEY: '' }), error => {
    assert.equal(error.kind, 'request');
    return true;
  });
});
