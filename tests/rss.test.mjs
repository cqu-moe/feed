import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  feedOrigin,
  subscriptionCall,
  subscriptionsFixture,
} from './helpers/subscriptions-fixture.mjs';

test('a valid private RSS emits dated historical and update events with stable identity and conditional reads', async () => {
  const { mf, login, setPolicy, setRecipient, setPolicyService } = await subscriptionsFixture();
  try {
    const cookie = await login('rss-reader');
    const created = await subscriptionCall(mf, '/api/subscriptions', {
      cookie,
      method: 'POST',
      origin: feedOrigin,
      body: {
        requestId: 'create-rss-subscription',
        name: '私有 RSS',
        siteIds: [],
        sourceIds: ['jwc'],
        emailMode: 'off',
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const rssUrl = new URL(created.body.subscription.rssUrl, feedOrigin);
    assert.equal(rssUrl.pathname, '/rss');
    assert.match(rssUrl.searchParams.get('token'), /^[A-Za-z0-9_-]{43}$/);

    const history = await seedReadyEvent(mf, {
      articleId: 'aaa000000000000000000001',
      taskId: 'bbb000000000000000000001',
      revisionId: 'ccc000000000000000000001',
      revisionNo: 1,
      title: '历史通知 & 附件',
      body: '已核实的历史正文',
      intent: 'backfill',
      changeKind: 'baseline',
      precision: 'minute',
    });
    const update = await seedReadyEvent(mf, {
      articleId: history.articleId,
      taskId: 'bbb000000000000000000002',
      revisionId: 'ccc000000000000000000002',
      revisionNo: 2,
      previousRevisionId: history.revisionId,
      title: '历史通知 & <更新>',
      body: '实质更新正文 <script>alert("rss")</script>',
      intent: 'live',
      changeKind: 'substantive',
      precision: 'minute',
    });
    const unknownDate = await seedReadyEvent(mf, {
      articleId: 'aaa000000000000000000002',
      taskId: 'bbb000000000000000000003',
      revisionId: 'ccc000000000000000000003',
      revisionNo: 1,
      title: '未知日期通知',
      body: '这条日期未核实，不应进入 RSS',
      intent: 'live',
      changeKind: 'baseline',
      precision: 'unknown',
    });
    assert.equal(unknownDate.dateState, 'date_unknown');
    const dated = await seedReadyEvent(mf, {
      articleId: 'aaa000000000000000000003',
      taskId: 'bbb000000000000000000004',
      revisionId: 'ccc000000000000000000004',
      revisionNo: 1,
      title: '日级日期历史通知',
      body: '日级日期已核实的历史正文',
      intent: 'backfill',
      changeKind: 'baseline',
      precision: 'day',
    });
    const unrelated = await seedReadyEvent(mf, {
      articleId: 'aaa000000000000000000004',
      taskId: 'bbb000000000000000000005',
      revisionId: 'ccc000000000000000000005',
      revisionNo: 1,
      sourceId: 'intex',
      title: '非订阅栏目通知',
      body: '这条来自未订阅栏目，不应进入 RSS',
      intent: 'live',
      changeKind: 'baseline',
      precision: 'minute',
    });
    assert.equal(dated.dateState, 'verified');
    assert.equal(unrelated.dateState, 'verified');

    const first = await mf.dispatchFetch(rssUrl);
    if (first.status !== 200) {
      const errors = await (await mf.dispatchFetch(`${feedOrigin}/__test/errors`)).text();
      assert.fail(`${await first.text()}\nworker errors: ${errors}`);
    }
    assert.equal(first.headers.get('Content-Type'), 'application/rss+xml; charset=utf-8');
    assert.equal(first.headers.get('Cache-Control'), 'private, no-store');
    const xml = await first.text();
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<rss version="2\.0">/);
    assert.equal(extract(xml, 'title'), '私有 RSS');
    assert.deepEqual([...items(xml).map(item => extract(item, 'title'))].sort(), [
      '历史通知 &amp; &lt;更新&gt;',
      '历史通知 &amp; 附件',
      '日级日期历史通知',
    ]);
    assert.doesNotMatch(xml, /未知日期通知|非订阅栏目通知|<script>alert/);
    const updateItem = items(xml).find(item => extract(item, 'title') === '历史通知 &amp; &lt;更新&gt;');
    assert.equal(extract(updateItem, 'description'), '实质更新正文 &lt;script&gt;alert(&quot;rss&quot;)&lt;/script&gt;');
    assert.equal(extract(updateItem, 'category'), '更新');
    assert.notEqual(extract(updateItem, 'guid'), extract(items(xml).find(item => item !== updateItem), 'guid'));
    const updateLink = extract(updateItem, 'link');
    assert.equal(new URL(updateLink, feedOrigin).pathname, `/api/articles/${history.articleId}/revisions/${update.revisionId}`);
    assert.doesNotMatch(xml, /\/files\//);

    const etag = first.headers.get('ETag');
    assert.match(etag, /^"[a-f0-9]{64}"$/);
    const conditional = await mf.dispatchFetch(rssUrl, { headers: { 'If-None-Match': etag } });
    assert.equal(conditional.status, 304);
    assert.equal(conditional.headers.get('Cache-Control'), 'private, no-store');
    assert.equal((await mf.dispatchFetch(rssUrl, { headers: { 'If-None-Match': etag } })).headers.get('ETag'), etag);
    const repeat = await mf.dispatchFetch(rssUrl);
    assert.equal(repeat.status, 200);
    const repeatXml = await repeat.text();
    assert.deepEqual(items(repeatXml).map(item => extract(item, 'guid')).sort(), items(xml).map(item => extract(item, 'guid')).sort());

    await setPolicyService({ outage: true, policyCalls: 0 });
    const unknownDuringOutage = await mf.dispatchFetch(`${feedOrigin}/rss?token=not-the-current-token`);
    if (unknownDuringOutage.status !== 404) {
      const errors = await (await mf.dispatchFetch(`${feedOrigin}/__test/errors`)).text();
      assert.fail(`${await unknownDuringOutage.text()}\nworker errors: ${errors}`);
    }
    const authOutage = await mf.dispatchFetch(rssUrl);
    assert.equal(authOutage.status, 503, await authOutage.clone().text());
    assert.equal(authOutage.headers.get('Retry-After'), '1');
    assert.equal((await authOutage.clone().json()).error, '认证服务暂时不可用，请稍后重试');
    await setPolicyService({ outage: false });

    await setPolicy('rss-reader', { access: false, limit: { kind: 'unlimited' } });
    assert.equal((await mf.dispatchFetch(rssUrl)).status, 403);
    await setPolicy('rss-reader', { access: true, limit: { kind: 'limited', value: 0 } });
    assert.equal((await mf.dispatchFetch(rssUrl)).status, 403);
    await setPolicy('rss-reader', { access: true, limit: { kind: 'limited', value: 1 } });
    await setRecipient('rss-reader', { status: 'unverified' });
    assert.equal((await mf.dispatchFetch(rssUrl, { headers: { 'If-None-Match': etag } })).status, 304);

    const rotate = await subscriptionCall(mf, `/api/subscriptions/${created.body.subscription.id}/rss/rotate`, {
      cookie,
      method: 'POST',
      origin: feedOrigin,
      body: { requestId: 'rotate-rss-after-read', expectedVersion: 1 },
    });
    assert.equal(rotate.status, 200, JSON.stringify(rotate.body));
    assert.equal((await mf.dispatchFetch(rssUrl)).status, 404);
    const rotatedUrl = new URL(rotate.body.subscription.rssUrl, feedOrigin);
    assert.equal((await mf.dispatchFetch(rotatedUrl)).status, 200);
    const forcedFailure = await mf.dispatchFetch(`${feedOrigin}/__test/rss-failure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: rotatedUrl.href }),
    });
    if (forcedFailure.status !== 503) {
      const errors = await (await mf.dispatchFetch(`${feedOrigin}/__test/errors`)).text();
      assert.fail(`${await forcedFailure.text()}\nworker errors: ${errors}`);
    }
    const errors = await (await mf.dispatchFetch(`${feedOrigin}/__test/errors`)).json();
    assert.ok(errors.some(args => args.join(' ').includes('"event":"request_failed","path":"/rss"')));
    assert.equal(JSON.stringify(errors).includes(rotatedUrl.searchParams.get('token')), false);
  } finally {
    await mf.dispose();
  }
});

async function seedReadyEvent(mf, options) {
  const db = await mf.getD1Database('DB', 'feed');
  const bucket = await mf.getR2Bucket('ARCHIVE', 'feed');
  const {
    articleId, taskId, revisionId, revisionNo, sourceId = 'jwc', previousRevisionId = null,
    title, body, intent, changeKind, precision,
  } = options;
  const now = Date.parse('2026-10-12T08:00:00.000Z');
  const bytes = new TextEncoder().encode(body);
  const bodyHash = createHash('sha256').update(bytes).digest('hex');
  const bodyKey = `objects/sha256/${bodyHash.slice(0, 2)}/${bodyHash}`;
  await bucket.put(bodyKey, bytes, { sha256: bodyHash, httpMetadata: { contentType: 'text/plain; charset=utf-8' } });
  await db.prepare('INSERT INTO artifact_objects(sha256,r2_key,byte_size,media_type,verified_at) VALUES (?,?,?,?,?)')
    .bind(bodyHash, bodyKey, bytes.byteLength, 'text/plain; charset=utf-8', now).run();
  if (revisionNo === 1) {
    await db.prepare(`INSERT INTO articles(id,source_id,url,title,published_at,discovered_at,status,attempts,lease_until)
      VALUES (?,?,?,?,?,?,'pending',0,0)`)
      .bind(articleId, sourceId, `https://${sourceId === 'intex' ? 'intex' : 'jwc'}.cqu.edu.cn/info/1082/${articleId.slice(-4)}.htm`, title, now - 86_400_000, now - 43_200_000).run();
    await db.prepare(`INSERT INTO article_sources(article_id,source_id,first_seen_at,last_seen_at,discovery_class,published_at,published_day,date_precision,source_timezone)
      VALUES (?,?,?,?,?,?,?,?, 'Asia/Shanghai')`)
      .bind(articleId, sourceId, now - 43_200_000, now, intent, precision === 'minute' ? '2026-10-11T09:00:00+08:00' : null, precision === 'unknown' ? null : '2026-10-11', precision).run();
  }
  await db.prepare(`INSERT INTO tasks(id,kind,business_key,source_id,article_id,payload_json,state,due_at,attempt_no,created_at,updated_at)
    VALUES (?,'capture',?, ?,?,'{}','succeeded',?,1,?,?)`)
    .bind(taskId, `capture:${articleId}:${taskId}`, sourceId, articleId, now, now, now).run();
  await db.prepare(`INSERT INTO article_revisions(id,article_id,revision_no,previous_revision_id,capture_task_id,observed_at,state,
      requirement_count,requirement_generation,manifest_object_hash,raw_fingerprint,semantic_fingerprint,change_kind,title,published_at,source_metadata_json,diagnostics_json)
    VALUES (?,?,?,?,?,?,'assembling',1,1,?,?,?,?,?,NULL,?, '[]')`)
    .bind(revisionId, articleId, revisionNo, previousRevisionId, taskId, now, bodyHash, `raw-${revisionId}`, `semantic-${revisionId}`, changeKind, title,
      JSON.stringify({ captureIntent: intent })).run();
  await db.prepare(`INSERT INTO revision_requirements(revision_id,slot_key,kind,name,required,state,object_hash,fetched_at)
    VALUES (?, 'body','body','正文',1,'fulfilled',?,?)`)
    .bind(revisionId, bodyHash, now).run();
  const response = await mf.dispatchFetch(`${feedOrigin}/__test/reconcile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revisionId }),
  });
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  return { ...JSON.parse(responseText), articleId, revisionId, dateState: precision === 'unknown' ? 'date_unknown' : 'verified' };
}

function extract(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return match?.[1];
}

function items(xml) {
  return xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
}
