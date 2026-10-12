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
    const finalPage = await notificationInvoke(mf, 'replayMatchOutbox', 10);
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
    await notificationInvoke(mf, 'replayMatchOutbox', 10);
    let ownerView = await subscriptionCall(mf, `/api/subscriptions/${created.body.subscription.id}`, { cookie });
    assert.equal(ownerView.body.subscription.notificationMatches[0].status, 'waiting_date_verification');
    assert.equal(ownerView.body.subscription.notificationMatches[0].datePrecision, 'unknown');

    const verification = {
      requestId: 'verify-unknown-date-first',
      sourceId: 'jwc',
      verifiedBy: 'feed-admin',
      datePrecision: 'minute',
      publishedAt: new Date(now + 60_000).toISOString(),
      evidence: { sourceUrl: 'https://jwc.cqu.edu.cn/info/2026/date.htm', method: 'source-page' },
    };
    const verified = await notificationInvoke(mf, 'verifyDate', eventId, verification);
    assert.equal(verified.status, 200, JSON.stringify(verified));
    assert.equal(verified.body.correction.generation, 1);
    assert.equal(verified.body.correction.eventId, eventId);
    assert.match(verified.body.correction.evidenceObjectHash, /^[a-f0-9]{64}$/);
    const replay=await adminRequest(mf,`/internal/notification-events/${eventId}/date-verification`,verification);
    assert.equal(replay.status,202);
    assert.deepEqual(replay.body,verified.body);
    const conflict=await adminRequest(mf,`/internal/notification-events/${eventId}/date-verification`,{
      ...verification,publishedAt:new Date(now-60_000).toISOString(),
    });
    assert.equal(conflict.status,409,JSON.stringify(conflict));

    const drained = await notificationInvoke(mf, 'replayMatchOutbox', 10);
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
    const withdrawal=await notificationInvoke(mf,'verifyDate',eventId,{
      ...verification,requestId:'withdraw-verified-date',datePrecision:'unknown',publishedAt:null,
    });
    assert.equal(withdrawal.status,200,JSON.stringify(withdrawal));
    await notificationInvoke(mf,'replayMatchOutbox',10);
    const withdrawn=await adminRequest(mf,`/internal/notification-events/${eventId}`,undefined,{method:'GET'});
    assert.equal(withdrawn.body.delivery.suppressionReason,'date_unverified');
    assert.equal(withdrawn.body.matches[0].eligibilityKind,'pending');
  } finally {
    await mf.dispose();
  }
});

test('a queued date generation superseded by verification becomes terminal on replay', async () => {
  const {mf}=await subscriptionsFixture({clock:now});
  try{
    const eventId=await seedReadyEvent(mf,{
      id:'bbbbbbbbbbbbbbbbbbbb0020',sourceId:'jwc',firstSeenAt:now+30_000,
      observedAt:now+30_000,readyAt:now+120_000,datePrecision:'unknown',
    });
    const old=await notificationInvoke(mf,'enqueueEvent',eventId);
    const verified=await notificationInvoke(mf,'verifyDate',eventId,{
      requestId:'supersede-old-matching',sourceId:'jwc',verifiedBy:'feed-admin',
      datePrecision:'day',publishedDay:'2026-10-12',evidence:{method:'source-page'},
    });
    assert.equal(verified.status,200,JSON.stringify(verified));
    const replay=await feedJobsInvoke(mf,old.body.messages[0]);
    assert.deepEqual(replay.body.messages,[{acked:true,retried:false}]);
    const details=await adminRequest(mf,`/internal/notification-events/${eventId}`,undefined,{method:'GET'});
    assert.equal(details.body.matchTasks.find(task=>task.id===old.body.messages[0].taskId).state,'cancelled');
    const drained=await notificationInvoke(mf,'replayMatchOutbox',100);
    assert.equal(drained.body.pendingPages,0);
    const completed=await adminRequest(mf,`/internal/notification-events/${eventId}`,undefined,{method:'GET'});
    assert.deepEqual(completed.body.matchTasks.map(task=>task.state).sort(),['cancelled','succeeded']);
  }finally{await mf.dispose();}
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
      {id:'aaaaaaaaaaaaaaaaaaaa0007',title:'旧文更新',datePrecision:'day',publishedDay:'2026-09-12',kind:'update',
        firstSeenAt:now+10_000,observedAt:now+30_000,expected:['pending_immediate','修改在栏目生效后发生']},
      {id:'aaaaaaaaaaaaaaaaaaaa0008',title:'生效前更新',datePrecision:'day',publishedDay:'2026-09-12',kind:'update',
        firstSeenAt:now+10_000,observedAt:now-30_000,expected:['suppressed','修改发生在栏目生效前']},
      {id:'aaaaaaaaaaaaaaaaaaaa0009',title:'晚到关联更新',datePrecision:'day',publishedDay:'2026-09-12',kind:'update',
        firstSeenAt:now+60_000,observedAt:now+30_000,expected:['suppressed','栏目在修改观察后才出现']},
      {id:'aaaaaaaaaaaaaaaaaaaa0010',title:'订阅前观察',publishedAt:new Date(now+60_000).toISOString(),datePrecision:'minute',
        firstSeenAt:now-60_000,expected:['suppressed','订阅前已观察到的内容不补发']},
      {id:'aaaaaaaaaaaaaaaaaaaa0011',title:'未知日期更新',datePrecision:'unknown',kind:'update',
        expected:['waiting_date_verification','日期待核实']},
      {id:'aaaaaaaaaaaaaaaaaaaa0012',title:'补抓旧文的新修改',datePrecision:'day',publishedDay:'2026-09-12',kind:'update',
        discoveryClass:'backfill',firstSeenAt:now-60_000,expected:['pending_immediate','修改在栏目生效后发生']},
      {id:'aaaaaaaaaaaaaaaaaaaa0013',title:'迁移旧文的新修改',datePrecision:'day',publishedDay:'2026-09-12',kind:'update',
        discoveryClass:'migrated',firstSeenAt:now-60_000,expected:['pending_immediate','修改在栏目生效后发生']},
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
    const drained=await notificationInvoke(mf,'replayMatchOutbox',100);
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

test('eligible notifications survive Auth failures, quota pauses and unverified mail as digest backlog', async () => {
  for(const blockedBy of ['auth_unavailable','quota_exceeded','email_unverified','paused']){
    const {mf,login,setPolicy,setRecipient,setPolicyService}=await subscriptionsFixture({clock:now});
    try{
      const cookie=await login('backlog-owner');
      const created=await subscriptionsInvoke(mf,'change',{id:'backlog-owner'}, {
        requestId:'backlog-subscription',name:'积压订阅',sourceIds:['jwc'],emailMode:'immediate',
      });
      assert.equal(created.status,200,JSON.stringify(created));
      const subscription=created.body.subscription;
      const editEnabled=enabled=>subscriptionsInvoke(mf,'update',{id:'backlog-owner'},subscription.id,{
        requestId:`backlog-enabled-${enabled}`,expectedVersion:enabled?2:1,name:'积压订阅',
        sourceIds:['jwc'],emailMode:'immediate',requestedEnabled:enabled,priority:0,
      });
      if(blockedBy==='auth_unavailable')await setPolicyService({outage:true});
      if(blockedBy==='quota_exceeded')await setPolicy('backlog-owner',{access:true,limit:{kind:'limited',value:0}});
      if(blockedBy==='email_unverified')await setRecipient('backlog-owner',{status:'unverified'});
      if(blockedBy==='paused')assert.equal((await editEnabled(false)).status,200);
      const eventId=await seedReadyEvent(mf,{
        id:'bbbbbbbbbbbbbbbbbbbb0010',sourceId:'jwc',firstSeenAt:now+30_000,observedAt:now+30_000,
        readyAt:now+120_000,publishedDay:'2026-10-12',datePrecision:'day',
      });
      await notificationInvoke(mf,'enqueueEvent',eventId);
      const drained=await notificationInvoke(mf,'replayMatchOutbox',100);
      assert.equal(drained.status,200,JSON.stringify(drained));
      const details=await adminRequest(mf,`/internal/notification-events/${eventId}`,undefined,{method:'GET'});
      assert.equal(details.body.delivery?.state,'pending',`${blockedBy}: ${JSON.stringify(details.body)}`);
      assert.equal(details.body.delivery.kind,'daily_digest');
      assert.equal(details.body.delivery.suppressionReason,blockedBy);
      const blocked=await subscriptionCall(mf,`/api/subscriptions/${subscription.id}`,{cookie});
      assert.equal(blocked.body.subscription.notificationMatches[0].status,blockedBy,JSON.stringify(blocked));
      await setPolicyService({outage:false});
      await setPolicy('backlog-owner',{access:true,limit:{kind:'limited',value:10}});
      await setRecipient('backlog-owner',{status:'verified',email:'reader@example.test'});
      if(blockedBy==='paused')assert.equal((await editEnabled(true)).status,200);
      const restored=await subscriptionCall(mf,`/api/subscriptions/${subscription.id}`,{cookie});
      assert.equal(restored.body.subscription.notificationMatches[0].status,'pending_daily_digest',JSON.stringify(restored));
      const verification=await notificationInvoke(mf,'verifyDate',eventId,{
        requestId:'rematch-recovered-backlog',sourceId:'jwc',verifiedBy:'feed-admin',
        datePrecision:'day',publishedDay:'2026-10-12',evidence:{method:'source-page'},
      });
      assert.equal(verification.status,200,JSON.stringify(verification));
      await notificationInvoke(mf,'replayMatchOutbox',100);
      const rematched=await adminRequest(mf,`/internal/notification-events/${eventId}`,undefined,{method:'GET'});
      assert.equal(rematched.body.delivery.kind,'daily_digest',`${blockedBy}: ${JSON.stringify(rematched)}`);
    }finally{await mf.dispose();}
  }
});

test('current eligible reasons across sources select one candidate independently of match-page order',async()=>{
  const {mf,login}=await subscriptionsFixture({clock:now,notificationPageSize:1});
  try{
    const cookie=await login('multi-source-owner'),subscriptions=[];
    for(const [sourceId,emailMode] of [['jwc','immediate'],['news','daily_digest']]){
      const created=await subscriptionsInvoke(mf,'change',{id:'multi-source-owner'},{
        requestId:`multi-source-${sourceId}`,name:sourceId,sourceIds:[sourceId],emailMode,
      });
      assert.equal(created.status,200,JSON.stringify(created));subscriptions.push(created.body.subscription);
    }
    const eventId=await seedReadyEvent(mf,{
      id:'bbbbbbbbbbbbbbbbbbbb0030',sourceId:'jwc',additionalSourceIds:['news'],firstSeenAt:now+30_000,
      observedAt:now+30_000,readyAt:now+120_000,publishedDay:'2026-10-12',datePrecision:'day',
    });
    const enqueued=await notificationInvoke(mf,'enqueueEvent',eventId);
    for(const message of enqueued.body.messages.toReversed())assert.deepEqual((await feedJobsInvoke(mf,message)).body.messages,[{acked:true,retried:false}]);
    const read=async()=>(await adminRequest(mf,`/internal/notification-events/${eventId}`,undefined,{method:'GET'})).body;
    const initial=await read();
    assert.equal(initial.deliveries.length,1);assert.equal(initial.delivery.kind,'immediate');
    const correct=async(sourceId,precision)=>{
      const verified=await notificationInvoke(mf,'verifyDate',eventId,{
        requestId:`multi-source-${sourceId}-${precision}`,sourceId,verifiedBy:'feed-admin',datePrecision:precision,
        ...(precision==='day'?{publishedDay:'2026-10-12'}:{}),evidence:{method:'source-page'},
      });
      assert.equal(verified.status,200,JSON.stringify(verified));
      for(let page=0;page<3;page++){
        const result=await notificationInvoke(mf,'replayMatchOutbox',100);
        assert.equal(result.status,200,JSON.stringify(result));if(!result.body.pendingPages)break;
      }
    };
    await correct('jwc','unknown');
    const otherSource=await read();
    assert.equal(otherSource.delivery.id,initial.delivery.id);
    assert.equal(otherSource.delivery.kind,'daily_digest');assert.equal(otherSource.delivery.suppressionReason,null);
    const unknownView=await subscriptionCall(mf,`/api/subscriptions/${subscriptions[0].id}`,{cookie});
    assert.equal(unknownView.body.subscription.notificationMatches[0].status,'waiting_date_verification');
    await correct('news','unknown');
    assert.equal((await read()).delivery.suppressionReason,'date_unverified');
    await correct('jwc','day');
    const restored=await read();
    assert.equal(restored.deliveries.length,1);assert.equal(restored.delivery.id,initial.delivery.id);
    assert.equal(restored.delivery.kind,'immediate');assert.equal(restored.delivery.suppressionReason,null);
  }finally{await mf.dispose();}
});

test('the Worker queue consumes match-source messages through the public task runtime', async () => {
  const { mf, db, login, setPolicy } = await subscriptionsFixture({ clock: now });
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

    await db.prepare(`CREATE TRIGGER fail_candidate BEFORE INSERT ON user_deliveries
      BEGIN SELECT RAISE(ABORT,'injected candidate commit failure'); END`).run();
    const failed=await feedJobsInvoke(mf,enqueued.body.messages[0]);
    assert.deepEqual(failed.body.messages,[{acked:false,retried:true}]);
    const rolledBack=await adminRequest(mf,`/internal/notification-events/${eventId}`,undefined,{method:'GET'});
    assert.equal(rolledBack.body.matches.length,0);
    assert.equal(rolledBack.body.delivery,null);
    assert.equal(rolledBack.body.matchTasks[0].pages,0);
    await db.exec('DROP TRIGGER fail_candidate');
    const consumed = await feedJobsInvoke(mf, enqueued.body.messages[0]);
    assert.equal(consumed.status, 200, JSON.stringify(consumed));
    assert.deepEqual(consumed.body.messages, [{ acked: true, retried: false }]);
    const replayed=await feedJobsInvoke(mf,enqueued.body.messages[0]);
    assert.deepEqual(replayed.body.messages,[{acked:true,retried:false}]);

    const adminView = await adminRequest(mf, `/internal/notification-events/${eventId}`, undefined, { method: 'GET' });
    assert.equal(adminView.status, 200, JSON.stringify(adminView));
    assert.equal(adminView.body.matchTasks[0].state, 'succeeded', JSON.stringify(adminView.body));
    assert.equal(adminView.body.deliveries.length,1);
    assert.equal(adminView.body.matches.length,1);
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
