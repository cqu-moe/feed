import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  feedOrigin,
  adminRequest,
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
    assert.equal(new URL(updateLink, feedOrigin).href, `${feedOrigin}/articles/${history.articleId}?revision=${update.revisionId}`);
    assert.equal(extract(updateItem, 'guid'), `urn:cqu-feed:event:${await eventIdFor(mf, update.revisionId)}`);
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

test('RSS eligibility follows the subscription target source date association', async () => {
  const { mf, login } = await subscriptionsFixture();
  try {
    const cookie = await login('rss-source-date-reader');
    const subscriptions = [];
    for (const sourceId of ['jwc', 'intex']) {
      const created = await subscriptionCall(mf, '/api/subscriptions', {
        cookie,
        method: 'POST',
        origin: feedOrigin,
        body: {
          requestId: `create-${sourceId}-rss`,
          name: `${sourceId} 日期精确订阅`,
          siteIds: [],
          sourceIds: [sourceId],
          emailMode: 'off',
        },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      subscriptions.push(new URL(created.body.subscription.rssUrl, feedOrigin));
    }

    const knownElsewhere = await seedReadyEvent(mf, {
      articleId: 'aaa000000000000000000101',
      taskId: 'bbb000000000000000000101',
      revisionId: 'ccc000000000000000000101',
      revisionNo: 1,
      title: '其他栏目已知日期',
      body: '订阅栏目自己的日期仍未核实',
      intent: 'live',
      changeKind: 'baseline',
      precision: 'minute',
    });
    await associateEventSource(mf, {
      articleId: knownElsewhere.articleId,
      revisionId: knownElsewhere.revisionId,
      sourceId: 'intex',
      precision: 'unknown',
    });

    const initiallyUnknown = await seedReadyEvent(mf, {
      articleId: 'aaa000000000000000000102',
      taskId: 'bbb000000000000000000102',
      revisionId: 'ccc000000000000000000102',
      revisionNo: 1,
      sourceId: 'intex',
      title: '后来栏目日期已知',
      body: '事件聚合状态保持未知，但订阅目标关联已核实',
      intent: 'live',
      changeKind: 'baseline',
      precision: 'unknown',
    });
    await associateEventSource(mf, {
      articleId: initiallyUnknown.articleId,
      revisionId: initiallyUnknown.revisionId,
      sourceId: 'jwc',
      precision: 'day',
    });
    assert.equal(await eventDateState(mf, initiallyUnknown.revisionId), 'date_unknown');

    const [jwcResponse, intexResponse] = await Promise.all(subscriptions.map(url => mf.dispatchFetch(url)));
    assert.equal(jwcResponse.status, 200);
    assert.equal(intexResponse.status, 200);
    const jwcXml = await jwcResponse.text();
    const intexXml = await intexResponse.text();
    assert.deepEqual(itemTitles(intexXml), []);
    assert.deepEqual(itemTitles(jwcXml).sort(), ['其他栏目已知日期', '后来栏目日期已知']);
  } finally {
    await mf.dispose();
  }
});

test('latest source date corrections govern RSS eligibility and invalidate prior ETags', async () => {
  const { mf, login } = await subscriptionsFixture();
  try {
    const cookie = await login('rss-correction-reader');
    const subscriptions = new Map();
    for (const sourceId of ['jwc', 'intex', 'news']) {
      const created = await subscriptionCall(mf, '/api/subscriptions', {
        cookie,
        method: 'POST',
        origin: feedOrigin,
        body: {
          requestId: `create-${sourceId}-correction-rss`,
          name: `${sourceId} 日期修正订阅`,
          siteIds: [],
          sourceIds: [sourceId],
          emailMode: 'off',
        },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      subscriptions.set(sourceId, new URL(created.body.subscription.rssUrl, feedOrigin));
    }

    const unknownForJwc = await seedReadyEvent(mf, {
      articleId: 'aaa000000000000000000201',
      taskId: 'bbb000000000000000000201',
      revisionId: 'ccc000000000000000000201',
      revisionNo: 1,
      title: '来源各自修正的日期',
      body: 'RSS 按订阅栏目自己的最新核实结果判断',
      intent: 'live',
      changeKind: 'baseline',
      precision: 'unknown',
    });
    await associateEventSource(mf, {
      articleId: unknownForJwc.articleId,
      revisionId: unknownForJwc.revisionId,
      sourceId: 'intex',
      precision: 'minute',
    });
    await associateEventSource(mf, {
      articleId: unknownForJwc.articleId,
      revisionId: unknownForJwc.revisionId,
      sourceId: 'news',
      precision: 'unknown',
    });
    const eventId = await eventIdFor(mf, unknownForJwc.revisionId);

    const initial = await rssTitlesBySource(mf, subscriptions);
    assert.deepEqual(initial, new Map([
      ['jwc', []],
      ['intex', ['来源各自修正的日期']],
      ['news', []],
    ]));
    const emptyEtag = await rssEtag(mf, subscriptions.get('jwc'));

    const verified = await adminRequest(mf, `/internal/notification-events/${eventId}/date-verification`, {
      requestId: 'verify-jwc-rss-minute',
      sourceId: 'jwc',
      verifiedBy: 'rss-admin',
      datePrecision: 'minute',
      publishedAt: '2026-10-12T09:01:00.000Z',
      evidence: { sourceUrl: 'https://jwc.cqu.edu.cn/info/2026/corrected.htm', method: 'source-page' },
    });
    assert.equal(verified.status, 202, JSON.stringify(verified.body));
    assert.equal(verified.body.correction.generation, 1);

    const afterVerify = await mf.dispatchFetch(subscriptions.get('jwc'), {
      headers: { 'If-None-Match': emptyEtag },
    });
    const verifiedXml = await afterVerify.text();
    assert.equal(afterVerify.status, 200, verifiedXml);
    assert.deepEqual(itemTitles(verifiedXml), ['来源各自修正的日期']);
    const verifiedEtag = afterVerify.headers.get('ETag');
    assert.notEqual(verifiedEtag, emptyEtag);
    assert.deepEqual(await rssTitlesBySource(mf, subscriptions), new Map([
      ['jwc', ['来源各自修正的日期']],
      ['intex', ['来源各自修正的日期']],
      ['news', []],
    ]));

    const hidden = await adminRequest(mf, `/internal/notification-events/${eventId}/date-verification`, {
      requestId: 'verify-jwc-rss-unknown',
      sourceId: 'jwc',
      verifiedBy: 'rss-admin',
      datePrecision: 'unknown',
      evidence: { sourceUrl: 'https://jwc.cqu.edu.cn/info/2026/withdrawn-date.htm', method: 'source-page' },
    });
    assert.equal(hidden.status, 202, JSON.stringify(hidden.body));
    assert.equal(hidden.body.correction.generation, 2);

    const afterHide = await mf.dispatchFetch(subscriptions.get('jwc'), {
      headers: { 'If-None-Match': verifiedEtag },
    });
    const hiddenXml = await afterHide.text();
    assert.equal(afterHide.status, 200, hiddenXml);
    assert.deepEqual(itemTitles(hiddenXml), []);
    assert.notEqual(afterHide.headers.get('ETag'), verifiedEtag);
    assert.deepEqual(await rssTitlesBySource(mf, subscriptions), new Map([
      ['jwc', []],
      ['intex', ['来源各自修正的日期']],
      ['news', []],
    ]));
    assert.equal(await eventDateState(mf, unknownForJwc.revisionId), 'date_unknown');
    assert.equal(await sourceDatePrecision(mf, eventId, 'jwc'), 'unknown');
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

async function associateEventSource(mf, { articleId, revisionId, sourceId, precision }) {
  const db = await mf.getD1Database('DB', 'feed');
  const event = await db.prepare('SELECT id FROM content_events WHERE revision_id=?').bind(revisionId).first();
  assert.ok(event, 'Seed revision did not create a content event');
  const now = Date.parse('2026-10-12T08:00:00.000Z');
  await db.prepare(`INSERT INTO article_sources(article_id,source_id,first_seen_at,last_seen_at,discovery_class,published_at,published_day,date_precision,source_timezone)
    VALUES (?,?,?,?,?,?,?,?,'Asia/Shanghai')`)
    .bind(articleId, sourceId, now - 21_600_000, now, 'migrated', precision === 'minute' ? '2026-10-12T09:00:00+08:00' : null,
      precision === 'unknown' ? null : '2026-10-12', precision).run();
  await db.prepare(`INSERT INTO event_sources(event_id,source_id,article_source_first_seen_at,discovery_class,published_at,published_day,date_precision,source_timezone)
    VALUES (?,?,?,?,?,?,?,'Asia/Shanghai')`)
    .bind(event.id, sourceId, now - 21_600_000, 'migrated', precision === 'minute' ? '2026-10-12T09:00:00+08:00' : null,
      precision === 'unknown' ? null : '2026-10-12', precision).run();
}

async function eventIdFor(mf, revisionId) {
  const db = await mf.getD1Database('DB', 'feed');
  const event = await db.prepare('SELECT id FROM content_events WHERE revision_id=?').bind(revisionId).first();
  assert.ok(event, 'Expected a content event for the RSS item');
  return event.id;
}

async function eventDateState(mf, revisionId) {
  const db = await mf.getD1Database('DB', 'feed');
  const event = await db.prepare('SELECT date_state AS dateState FROM content_events WHERE revision_id=?').bind(revisionId).first();
  assert.ok(event, 'Expected a content event');
  return event.dateState;
}

async function rssTitlesBySource(mf, subscriptions) {
  const titles = await Promise.all([...subscriptions].map(async ([sourceId, url]) => {
    const response = await mf.dispatchFetch(url);
    const xml = await response.text();
    assert.equal(response.status, 200, xml);
    return [sourceId, itemTitles(xml)];
  }));
  return new Map(titles);
}

async function rssEtag(mf, url) {
  const response = await mf.dispatchFetch(url);
  assert.equal(response.status, 200, await response.text());
  return response.headers.get('ETag');
}

async function sourceDatePrecision(mf, eventId, sourceId) {
  const db = await mf.getD1Database('DB', 'feed');
  const source = await db.prepare('SELECT date_precision AS datePrecision FROM event_sources WHERE event_id=? AND source_id=?')
    .bind(eventId, sourceId).first();
  assert.ok(source, 'Expected the frozen event source');
  return source.datePrecision;
}

function extract(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return match?.[1];
}

function items(xml) {
  return xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
}

function itemTitles(xml) {
  return items(xml).map(item => extract(item, 'title'));
}
