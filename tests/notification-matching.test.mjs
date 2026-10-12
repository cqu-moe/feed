import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  adminRequest,
  feedJobsInvoke,
  notificationInvoke,
  subscriptionCall,
  subscriptionsFixture,
  subscriptionsInvoke,
} from './helpers/subscriptions-fixture.mjs';

const now = Date.parse('2026-10-12T04:00:00.000Z');

test('one event matches multiple subscriptions but creates one immediate user delivery with durable paging', async () => {
  const { mf, login, setPolicy } = await subscriptionsFixture({ clock: now, notificationPageSize: 1 });
  try {
    await setPolicy('matching-owner', { access: true, limit: { kind: 'limited', value: 10 } });
    const cookie = await login('matching-owner');
    const subscriptions = [];
    for (const [index, emailMode] of ['immediate', 'daily_digest'].entries()) {
      const created = await subscriptionsInvoke(mf, 'change', { id: 'matching-owner' }, {
        requestId: `matching-subscription-${index}`,
        name: index === 0 ? '及时订阅' : '摘要订阅',
        sourceIds: ['jwc'],
        emailMode,
      });
      assert.equal(created.status, 200, JSON.stringify(created));
      subscriptions.push(created.body.subscription);
    }

    const eventId = await seedReadyEvent(mf, {
      id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      sourceId: 'jwc',
      firstSeenAt: now + 30_000,
      observedAt: now + 30_000,
      readyAt: now + 120_000,
      publishedAt: new Date(now + 60_000).toISOString(),
      datePrecision: 'minute',
    });

    const enqueued = await notificationInvoke(mf, 'enqueueEvent', eventId);
    assert.equal(enqueued.status, 200, JSON.stringify(enqueued));
    assert.equal(enqueued.body.tasks, 1, JSON.stringify(enqueued));
    const firstPage = await notificationInvoke(mf, 'processMatchTask', enqueued.body.messages[0]);
    assert.equal(firstPage.status, 200, JSON.stringify(firstPage));
    assert.equal(firstPage.body.state, 'queued');
    assert.equal(firstPage.body.page, 1);
    assert.equal(firstPage.body.hasNext, true);
    const replayFirst = await notificationInvoke(mf, 'processMatchTask', enqueued.body.messages[0]);
    assert.equal(replayFirst.status, 200, JSON.stringify(replayFirst));
    assert.equal(replayFirst.body.state, 'superseded');
    const finalPage = await notificationInvoke(mf, 'drainDue', 10);
    assert.equal(finalPage.body.processed, 2, JSON.stringify(finalPage));
    assert.equal(finalPage.body.pendingPages, 0);
    const ownerView = await subscriptionCall(mf, `/api/subscriptions/${subscriptions[0].id}`, { cookie });
    assert.equal(ownerView.status, 200, JSON.stringify(ownerView));
    assert.equal(ownerView.body.subscription.notificationMatches.length, 1);
    const match = ownerView.body.subscription.notificationMatches[0];
    assert.equal(match.eventId, eventId);
    assert.equal(match.eventKind, 'initial');
    assert.equal(match.title, '及时匹配通知');
    assert.equal(match.status, 'pending_immediate');
    assert.equal(match.reason, '发布时间不早于栏目生效时间');
    const otherCookie = await login('other-owner');
    const forbiddenView = await subscriptionCall(mf, `/api/subscriptions/${subscriptions[0].id}`, { cookie: otherCookie });
    assert.equal(forbiddenView.status, 404, JSON.stringify(forbiddenView));

    const digestView = await subscriptionCall(mf, `/api/subscriptions/${subscriptions[1].id}`, { cookie });
    assert.equal(digestView.status, 200, JSON.stringify(digestView));
    assert.equal(digestView.body.subscription.notificationMatches.length, 1, JSON.stringify(digestView));
    assert.equal(digestView.body.subscription.notificationMatches[0].status, 'merged_immediate');
    assert.equal(digestView.body.subscription.notificationMatches[0].reason, '同一事件已被及时提醒占用');

    const adminView = await adminRequest(mf, `/internal/notification-events/${eventId}`, undefined, { method: 'GET' });
    assert.equal(adminView.status, 200, JSON.stringify(adminView));
    assert.equal(adminView.body.event.id, eventId);
    assert.deepEqual(adminView.body.matches.map(match => `${match.subscriptionName}:${match.reason}`), [
      '及时订阅:发布时间不早于栏目生效时间',
      '摘要订阅:发布时间不早于栏目生效时间',
    ]);
    assert.equal(adminView.body.delivery.ownerSub, 'matching-owner');
    assert.equal(adminView.body.delivery.state, 'pending');
    assert.equal(adminView.body.delivery.kind, 'immediate');
    assert.equal(adminView.body.matchTasks[0].state, 'succeeded');
    assert.equal(adminView.body.matchTasks[0].pages, 2, JSON.stringify(adminView.body.matchTasks));
  } finally {
    await mf.dispose();
  }
});

test('date verification records auditable evidence and rematches the same event', async () => {
  const { mf, login, setPolicy } = await subscriptionsFixture({ clock: now, notificationPageSize: 1 });
  try {
    await setPolicy('matching-owner', { access: true, limit: { kind: 'limited', value: 10 } });
    const cookie = await login('matching-owner');
    const created = await subscriptionsInvoke(mf, 'change', { id: 'matching-owner' }, {
      requestId: 'date-verification-subscription',
      name: '日期核实订阅',
      sourceIds: ['jwc'],
      emailMode: 'immediate',
    });
    assert.equal(created.status, 200, JSON.stringify(created));

    const eventId = await seedReadyEvent(mf, {
      id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
      sourceId: 'jwc',
      firstSeenAt: now + 30_000,
      observedAt: now + 30_000,
      readyAt: now + 120_000,
      datePrecision: 'unknown',
      title: '未知日期通知',
    });
    const enqueued = await notificationInvoke(mf, 'enqueueEvent', eventId);
    await notificationInvoke(mf, 'drainDue', 10);
    let ownerView = await subscriptionCall(mf, `/api/subscriptions/${created.body.subscription.id}`, { cookie });
    assert.equal(ownerView.body.subscription.notificationMatches[0].status, 'waiting_date_verification');
    assert.equal(ownerView.body.subscription.notificationMatches[0].datePrecision, 'unknown');

    const verified = await notificationInvoke(mf, 'verifyDate', eventId, {
      requestId: 'verify-unknown-date-first',
      sourceId: 'jwc',
      verifiedBy: 'feed-admin',
      datePrecision: 'minute',
      publishedAt: new Date(now + 60_000).toISOString(),
      evidence: { sourceUrl: 'https://jwc.cqu.edu.cn/info/2026/date.htm', method: 'source-page' },
    });
    assert.equal(verified.status, 200, JSON.stringify(verified));
    assert.equal(verified.body.correction.generation, 1);
    assert.equal(verified.body.correction.eventId, eventId);
    assert.match(verified.body.correction.evidenceObjectHash, /^[a-f0-9]{64}$/);

    const drained = await notificationInvoke(mf, 'drainDue', 10);
    assert.equal(drained.body.pendingPages, 0, JSON.stringify(drained));
    ownerView = await subscriptionCall(mf, `/api/subscriptions/${created.body.subscription.id}`, { cookie });
    assert.equal(ownerView.body.subscription.notificationMatches[0].status, 'pending_immediate');
    assert.equal(ownerView.body.subscription.notificationMatches[0].datePrecision, 'minute');

    const adminView = await adminRequest(mf, `/internal/notification-events/${eventId}`, undefined, { method: 'GET' });
    assert.equal(adminView.body.event.id, eventId);
    assert.equal(adminView.body.sources[0].firstSeenAt, new Date(now + 30_000).toISOString());
    assert.equal(adminView.body.sources[0].correctionGeneration, 1);
    assert.equal(adminView.body.delivery.state, 'pending');
    const evidence = await adminRequest(
      mf,
      `/internal/notification-events/${eventId}/sources/jwc/date-evidence/1`,
      undefined,
      { method: 'GET' },
    );
    assert.equal(evidence.status, 200, JSON.stringify(evidence));
    assert.equal(evidence.body.eventId, eventId);
    assert.equal(evidence.body.verifiedBy, 'feed-admin');
    assert.equal(evidence.body.evidence.method, 'source-page');
  } finally {
    await mf.dispose();
  }
});

test('date precision and history rules explain eligible and suppressed candidates', async () => {
  const { mf, login, setPolicy } = await subscriptionsFixture({ clock: now });
  try {
    await setPolicy('matching-owner', { access: true, limit: { kind: 'limited', value: 10 } });
    const cookie = await login('matching-owner');
    const created = await subscriptionsInvoke(mf, 'change', { id: 'matching-owner' }, {
      requestId: 'eligibility-matrix-subscription',
      name: '资格规则订阅',
      sourceIds: ['jwc'],
      emailMode: 'immediate',
    });
    assert.equal(created.status, 200, JSON.stringify(created));

    const cases=[
      {id:'aaaaaaaaaaaaaaaaaaaa0001',title:'分钟合格',publishedAt:new Date(now+60_000).toISOString(),datePrecision:'minute',
        expected:['pending_immediate','发布时间不早于栏目生效时间']},
      {id:'aaaaaaaaaaaaaaaaaaaa0002',title:'分钟过早',publishedAt:new Date(now-60_000).toISOString(),datePrecision:'minute',
        expected:['suppressed','发布时间早于栏目生效时间']},
      {id:'aaaaaaaaaaaaaaaaaaaa0003',title:'当天合格',publishedDay:'2026-10-12',datePrecision:'day',
        expected:['pending_immediate','发布日期不早于栏目生效当天']},
      {id:'aaaaaaaaaaaaaaaaaaaa0004',title:'日级过早',publishedDay:'2026-10-11',datePrecision:'day',
        expected:['suppressed','发布日期或首次发现早于栏目生效']},
      {id:'aaaaaaaaaaaaaaaaaaaa0005',title:'未知日期',datePrecision:'unknown',
        expected:['waiting_date_verification','日期待核实']},
      {id:'aaaaaaaaaaaaaaaaaaaa0006',title:'历史基线',publishedDay:'2026-10-12',datePrecision:'day',
        discoveryClass:'backfill',historyOnly:1,expected:['suppressed','历史导入或迁移基线不补发邮件']},
      {id:'aaaaaaaaaaaaaaaaaaaa0007',title:'旧文更新',datePrecision:'unknown',kind:'update',
        firstSeenAt:now+10_000,observedAt:now+30_000,expected:['pending_immediate','修改在栏目生效后发生']},
      {id:'aaaaaaaaaaaaaaaaaaaa0008',title:'生效前更新',datePrecision:'unknown',kind:'update',
        firstSeenAt:now+10_000,observedAt:now-30_000,expected:['suppressed','修改发生在栏目生效前']},
      {id:'aaaaaaaaaaaaaaaaaaaa0009',title:'晚到关联更新',datePrecision:'unknown',kind:'update',
        firstSeenAt:now+60_000,observedAt:now+30_000,expected:['suppressed','栏目在修改观察后才出现']},
      {id:'aaaaaaaaaaaaaaaaaaaa0010',title:'订阅前观察',publishedAt:new Date(now+60_000).toISOString(),datePrecision:'minute',
        firstSeenAt:now-60_000,expected:['suppressed','订阅前已观察到的内容不补发']},
    ];
    for(const item of cases){
      await seedReadyEvent(mf,{
        id:item.id,sourceId:'jwc',title:item.title,
        firstSeenAt:item.firstSeenAt??now+30_000,observedAt:item.observedAt??now+30_000,readyAt:now+120_000,
        publishedAt:item.publishedAt,publishedDay:item.publishedDay,datePrecision:item.datePrecision,
        kind:item.kind,historyOnly:item.historyOnly,discoveryClass:item.discoveryClass,
      });
      const enqueued=await notificationInvoke(mf,'enqueueEvent',item.id);
      assert.equal(enqueued.status,200,JSON.stringify(enqueued));
    }
    const drained=await notificationInvoke(mf,'drainDue',100);
    assert.equal(drained.body.pendingPages,0,JSON.stringify(drained));

    const ownerView=await subscriptionCall(mf,`/api/subscriptions/${created.body.subscription.id}`,{cookie});
    assert.equal(ownerView.status,200,JSON.stringify(ownerView));
    const byEvent=new Map(ownerView.body.subscription.notificationMatches.map(match=>[match.eventId,match]));
    assert.deepEqual([...byEvent.keys()].sort(),cases.map(item=>item.id).sort());
    for(const item of cases){
      assert.deepEqual([byEvent.get(item.id).status,byEvent.get(item.id).reason],item.expected,
        JSON.stringify(byEvent.get(item.id)));
    }
  } finally{
    await mf.dispose();
  }
});

test('late source associations rematch ready events without changing event identity', async () => {
  const { mf, db, login, setPolicy } = await subscriptionsFixture({ clock: now });
  try {
    await setPolicy('matching-owner', { access: true, limit: { kind: 'limited', value: 10 } });
    const cookie = await login('matching-owner');
    const created = await subscriptionsInvoke(mf, 'change', { id: 'matching-owner' }, {
      requestId: 'late-source-subscription',
      name: '晚到栏目订阅',
      sourceIds: ['news'],
      emailMode: 'immediate',
    });
    assert.equal(created.status, 200, JSON.stringify(created));

    const eventBeforeSource='dddddddddddddddddddddddd';
    await seedReadyEvent(mf,{
      id:eventBeforeSource,sourceId:'jwc',title:'先就绪后关联',
      firstSeenAt:now+30_000,observedAt:now+30_000,readyAt:now+120_000,
      publishedAt:new Date(now+60_000).toISOString(),datePrecision:'minute',
    });
    await db.prepare(`INSERT INTO article_sources(article_id,source_id,first_seen_at,last_seen_at,discovery_class,
        published_at,published_day,date_precision,source_timezone)
      VALUES (?,'news',?,?,'live',?,NULL,'minute','Asia/Shanghai')`)
      .bind(eventBeforeSource,now+30_000,now+30_000,new Date(now+60_000).toISOString()).run();
    const associated=await notificationInvoke(mf,'associateArticleSource',eventBeforeSource,'news');
    assert.equal(associated.status,200,JSON.stringify(associated));
    assert.deepEqual(associated.body,{events:1,tasks:1});

    const sourceBeforeEvent='eeeeeeeeeeeeeeeeeeeeeeee';
    await seedReadyEvent(mf,{
      id:sourceBeforeEvent,sourceId:'jwc',title:'先关联后就绪',additionalSourceIds:['news'],
      firstSeenAt:now+30_000,observedAt:now+30_000,readyAt:now+120_000,
      publishedAt:new Date(now+60_000).toISOString(),datePrecision:'minute',
    });
    const enqueued=await notificationInvoke(mf,'enqueueEvent',sourceBeforeEvent);
    assert.equal(enqueued.body.tasks,2,JSON.stringify(enqueued));

    const drained=await notificationInvoke(mf,'drainDue',100);
    assert.equal(drained.body.pendingPages,0,JSON.stringify(drained));
    const ownerView=await subscriptionCall(mf,`/api/subscriptions/${created.body.subscription.id}`,{cookie});
    assert.equal(ownerView.status,200,JSON.stringify(ownerView));
    assert.deepEqual(ownerView.body.subscription.notificationMatches.map(match=>[match.eventId,match.status]).sort(),[
      [eventBeforeSource,'pending_immediate'],[sourceBeforeEvent,'pending_immediate'],
    ]);
    for(const eventId of [eventBeforeSource,sourceBeforeEvent]){
      const adminView=await adminRequest(mf,`/internal/notification-events/${eventId}`,undefined,{method:'GET'});
      assert.deepEqual(adminView.body.sources.map(source=>source.sourceId).sort(),['jwc','news']);
      assert.equal(adminView.body.sources.find(source=>source.sourceId==='news').firstSeenAt,new Date(now+30_000).toISOString());
      assert.equal(adminView.body.delivery.kind,'immediate');
    }
  } finally{
    await mf.dispose();
  }
});

test('the Worker queue consumes match-source messages through the public task runtime', async () => {
  const { mf, login, setPolicy } = await subscriptionsFixture({ clock: now });
  try {
    await setPolicy('queue-owner', { access: true, limit: { kind: 'limited', value: 10 } });
    const cookie = await login('queue-owner');
    const created = await subscriptionsInvoke(mf, 'change', { id: 'queue-owner' }, {
      requestId: 'queue-match-subscription',
      name: '队列匹配订阅',
      sourceIds: ['jwc'],
      emailMode: 'immediate',
    });
    assert.equal(created.status, 200, JSON.stringify(created));
    const eventId = await seedReadyEvent(mf, {
      id: 'ffffffffffffffffffffffff',
      sourceId: 'jwc',
      title: '队列匹配通知',
      firstSeenAt: now + 30_000,
      observedAt: now + 30_000,
      readyAt: now + 120_000,
      publishedAt: new Date(now + 60_000).toISOString(),
      datePrecision: 'minute',
    });
    const enqueued = await notificationInvoke(mf, 'enqueueEvent', eventId);
    assert.equal(enqueued.status, 200, JSON.stringify(enqueued));

    const consumed = await feedJobsInvoke(mf, enqueued.body.messages[0]);
    assert.equal(consumed.status, 200, JSON.stringify(consumed));
    assert.deepEqual(consumed.body.messages, [{ acked: true, retried: false }]);

    const adminView = await adminRequest(mf, `/internal/notification-events/${eventId}`, undefined, { method: 'GET' });
    assert.equal(adminView.status, 200, JSON.stringify(adminView));
    assert.equal(adminView.body.matchTasks[0].state, 'succeeded', JSON.stringify(adminView.body));
    const ownerView = await subscriptionCall(mf, `/api/subscriptions/${created.body.subscription.id}`, { cookie });
    assert.equal(ownerView.body.subscription.notificationMatches[0].status, 'pending_immediate');
  } finally {
    await mf.dispose();
  }
});

async function seedReadyEvent(mf, {
  id,
  sourceId,
  firstSeenAt,
  observedAt,
  readyAt,
  publishedAt,
  publishedDay = null,
  datePrecision,
  kind = 'initial',
  historyOnly = 0,
  discoveryClass = 'live',
  additionalSourceIds = [],
  title = '及时匹配通知',
}) {
  const db = await mf.getD1Database('DB', 'feed');
  const articleId = id;
  const revisionId = id;
  const taskId = id;
  const objectHash = createHash('sha256').update(`${id}:manifest`).digest('hex');
  await db.batch([
    db.prepare(`INSERT INTO articles(id,source_id,url,title,published_at,discovered_at,status)
      VALUES (?,?,?,?,?,?, 'archived')`)
      .bind(articleId, sourceId, `https://jwc.cqu.edu.cn/info/2026/${id}.htm`, title,
        publishedDay ?? publishedAt?.slice(0, 10) ?? 'unknown', new Date(firstSeenAt).toISOString()),
    db.prepare(`INSERT INTO article_sources(article_id,source_id,first_seen_at,last_seen_at,discovery_class,
      published_at,published_day,date_precision,source_timezone) VALUES (?,? ,?,?,?,?,?,?,'Asia/Shanghai')`)
      .bind(articleId, sourceId, firstSeenAt, firstSeenAt, discoveryClass, datePrecision === 'minute' ? publishedAt : null,
        datePrecision === 'unknown' ? null : publishedDay ?? publishedAt?.slice(0, 10), datePrecision),
    ...additionalSourceIds.map(sourceId=>db.prepare(`INSERT INTO article_sources(article_id,source_id,first_seen_at,last_seen_at,discovery_class,
        published_at,published_day,date_precision,source_timezone) VALUES (?,?,?,?,?,?,?,?, 'Asia/Shanghai')`)
      .bind(articleId,sourceId,firstSeenAt,firstSeenAt,discoveryClass,datePrecision==='minute'?publishedAt:null,
        datePrecision==='unknown'?null:publishedDay??publishedAt?.slice(0,10),datePrecision)),
    db.prepare(`INSERT INTO tasks(id,kind,business_key,source_id,article_id,payload_json,state,due_at,created_at,updated_at)
      VALUES (?,'capture',?,? ,?,'{}','succeeded',?,?,?)`)
      .bind(taskId, `capture:${id}`, sourceId, articleId, readyAt, firstSeenAt, readyAt),
    db.prepare(`INSERT INTO artifact_objects(sha256,r2_key,byte_size,media_type,verified_at)
      VALUES (?,?,1,'application/json',?)`)
      .bind(objectHash, `notifications/${id}/manifest.json`, firstSeenAt),
    db.prepare(`INSERT INTO article_revisions(id,article_id,revision_no,capture_task_id,observed_at,state,
      requirement_generation,requirement_count,manifest_object_hash,raw_fingerprint,semantic_fingerprint,change_kind,
      title,published_at,source_metadata_json,ready_at)
      VALUES (?, ?,1,?,?,'ready',1,1,?,?,? ,? ,?,?,'{}',?)`)
      .bind(revisionId, articleId, taskId, observedAt, objectHash,
        createHash('sha256').update(`${id}:raw`).digest('hex'),
        createHash('sha256').update(`${id}:semantic`).digest('hex'),
        kind === 'update' ? 'substantive' : 'baseline', title, publishedAt ?? publishedDay ?? null, readyAt),
    db.prepare(`INSERT INTO content_events(id,revision_id,article_id,kind,observed_at,ready_at,history_only,
      date_state,payload_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, revisionId, articleId, kind, observedAt, readyAt, historyOnly,
        datePrecision === 'unknown' ? 'date_unknown' : 'verified',
        createHash('sha256').update(`${id}:payload`).digest('hex'), readyAt),
    db.prepare(`INSERT INTO event_sources(event_id,source_id,article_source_first_seen_at,discovery_class,
      published_at,published_day,date_precision,source_timezone) VALUES (?,?,?, ?,?,?,?,'Asia/Shanghai')`)
      .bind(id, sourceId, firstSeenAt, discoveryClass, datePrecision === 'minute' ? publishedAt : null,
        datePrecision === 'unknown' ? null : publishedDay ?? publishedAt?.slice(0, 10), datePrecision),
    ...additionalSourceIds.map(sourceId=>db.prepare(`INSERT INTO event_sources(event_id,source_id,article_source_first_seen_at,discovery_class,
        published_at,published_day,date_precision,source_timezone) VALUES (?,?,?,?,?,?,?, 'Asia/Shanghai')`)
      .bind(id,sourceId,firstSeenAt,discoveryClass,datePrecision==='minute'?publishedAt:null,
        datePrecision==='unknown'?null:publishedDay??publishedAt?.slice(0,10),datePrecision)),
  ]);
  return id;
}
