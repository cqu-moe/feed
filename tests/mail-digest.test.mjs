import {test} from 'node:test';
import assert from 'node:assert/strict';
import {subscriptionsFixture,subscriptionsInvoke,notificationInvoke,adminRequest} from './helpers/subscriptions-fixture.mjs';
import {seedReadyEvent} from './helpers/notification-event.mjs';

const morning=Date.parse('2026-10-12T04:00:00Z');
const evening=Date.parse('2026-10-12T12:00:00Z');

test('a competing delivery claim cannot leave a digest containing an item it did not acquire',async()=>{
  const sent=[];
  const f=await subscriptionsFixture({clock:morning,mailHarness:{async fetch(request){sent.push(await request.json());return Response.json({id:'44444444-4444-4444-8444-444444444444'});}}});
  try{
    await subscriptionsInvoke(f.mf,'change',{id:'digest-owner'},{requestId:'digest-race-create',name:'每日通知',sourceIds:['jwc'],emailMode:'daily_digest'});
    const ids=[];
    for(let i=0;i<2;i++){
      const id=await seedReadyEvent(f.mf,{id:`ff`+String(i).repeat(22),sourceId:'jwc',firstSeenAt:morning+1,observedAt:morning+1,readyAt:morning+2,publishedAt:new Date(morning+1).toISOString(),datePrecision:'minute',title:i?'留在摘要':'竞争者已受理'});
      ids.push(id);await notificationInvoke(f.mf,'enqueueEvent',id);await notificationInvoke(f.mf,'replayMatchOutbox');
    }
    // Fault seam: the competing sender wins after qualification but before the compiler's atomic claims.
    await f.db.prepare(`CREATE TRIGGER competing_claim BEFORE UPDATE ON mail_digest_windows
      WHEN NEW.claim_token IS NOT NULL AND OLD.claim_token IS NULL BEGIN
      UPDATE user_deliveries SET state='accepted',claimed_message_id='aaaaaaaaaaaaaaaaaaaaaaaa' WHERE event_id='${ids[0]}'; END`).run();
    await f.mailClock(evening);await f.mail('prepareDigests');await f.replayMail();assert.equal(sent.length,0);
    assert.equal((await adminRequest(f.mf,'/internal/mail',undefined,{method:'GET'})).body.messages.length,0);
    const remaining=await adminRequest(f.mf,`/internal/notification-events/${ids[1]}`,undefined,{method:'GET'});
    assert.equal(remaining.body.delivery.state,'pending');
    await f.db.prepare('DROP TRIGGER competing_claim').run();
    await f.mail('prepareDigests');await f.replayMail();
    assert.equal(sent.length,1);assert.match(sent[0].text,/留在摘要/);assert.ok(!sent[0].text.includes('竞争者已受理'));
  }finally{await f.mf.dispose();}
});

test('Auth outage backlog stays a digest and an uncertain submission keeps the same complete snapshot and key',async()=>{
  const sent=[];
  const f=await subscriptionsFixture({clock:morning,mailHarness:{async fetch(request){
    sent.push({key:request.headers.get('idempotency-key'),body:await request.json()});
    return sent.length===1?new Response('lost response',{status:502}):Response.json({id:'55555555-5555-4555-8555-555555555555'});
  }}});
  try{
    await subscriptionsInvoke(f.mf,'change',{id:'digest-owner'},{requestId:'digest-backlog-create',name:'及时通知',sourceIds:['jwc'],emailMode:'immediate'});
    for(let i=0;i<2;i++){
      const id=await seedReadyEvent(f.mf,{id:`f${i}`+'6'.repeat(22),sourceId:'jwc',firstSeenAt:morning+1,observedAt:morning+1,readyAt:morning+2,publishedAt:new Date(morning+1).toISOString(),datePrecision:'minute',title:`积压${i}`});
      await notificationInvoke(f.mf,'enqueueEvent',id);await notificationInvoke(f.mf,'replayMatchOutbox');
    }
    await f.setPolicyService({outage:true});await f.mailClock(morning+60_000);await f.mail('recover');await f.replayMail();
    assert.equal(sent.length,0);
    await f.setPolicyService({outage:false});await f.mailClock(evening);await f.mail('recover');await f.replayMail();
    assert.equal(sent.length,1);assert.match(sent[0].body.subject,/每日摘要/);
    assert.match(sent[0].body.text,/积压0/);assert.match(sent[0].body.text,/积压1/);
    assert.equal((await adminRequest(f.mf,'/internal/mail',undefined,{method:'GET'})).body.messages[0].state,'submission_unknown');
    await f.mailClock(evening+120_000);await f.mail('recover');await f.replayMail();
    assert.equal(sent.length,2);assert.deepEqual(sent[1],sent[0]);
    await f.mailClock(evening+86400_000);await f.mail('recover');await f.replayMail();assert.equal(sent.length,2);
    const view=await adminRequest(f.mf,'/internal/mail',undefined,{method:'GET'});
    assert.equal(view.body.messages.length,1);assert.equal(view.body.messages[0].state,'accepted');
  }finally{await f.mf.dispose();}
});

test('switching a pending digest subscription to immediate sends through the shared claim before 20:00',async()=>{
  const sent=[];
  const f=await subscriptionsFixture({clock:morning,mailHarness:{async fetch(request){sent.push(await request.json());return Response.json({id:'66666666-6666-4666-8666-666666666666'});}}});
  try{
    const created=await subscriptionsInvoke(f.mf,'change',{id:'digest-owner'},{requestId:'digest-mode-create',name:'每日通知',sourceIds:['jwc'],emailMode:'daily_digest'});
    const id=await seedReadyEvent(f.mf,{id:'ee'+'5'.repeat(22),sourceId:'jwc',firstSeenAt:morning+1,observedAt:morning+1,readyAt:morning+2,publishedAt:new Date(morning+1).toISOString(),datePrecision:'minute'});
    await notificationInvoke(f.mf,'enqueueEvent',id);await notificationInvoke(f.mf,'replayMatchOutbox');
    const changed=await subscriptionsInvoke(f.mf,'update',{id:'digest-owner'},created.body.subscription.id,{requestId:'digest-mode-change',expectedVersion:1,name:'及时通知',sourceIds:['jwc'],requestedEnabled:true,priority:100,emailMode:'immediate'});
    assert.equal(changed.status,200);
    await f.mailClock(morning+60_000);await f.mail('recover');await f.replayMail();
    assert.equal(sent.length,1);assert.match(sent[0].subject,/新通知/);
    await f.mailClock(evening);await f.mail('recover');await f.replayMail();assert.equal(sent.length,1);
  }finally{await f.mf.dispose();}
});

test('configured item and UTF-8 payload limits split a large digest without losing or repeating any event',async()=>{
  for(const mode of ['items','bytes']){
    const sent=[];
    const f=await subscriptionsFixture({clock:morning,mailHarness:{bindings:{DIGEST_MAX_ITEMS:mode==='items'?'2':'50',DIGEST_MAX_BYTES:'8192'},async fetch(request){
      sent.push({key:request.headers.get('idempotency-key'),body:await request.json()});return Response.json({id:`77777777-7777-4777-8777-${String(sent.length).padStart(12,'0')}`});
    }}});
    try{
      await subscriptionsInvoke(f.mf,'change',{id:'digest-owner'},{requestId:'digest-size-create',name:'每日通知',sourceIds:['jwc'],emailMode:'daily_digest'});
      const ids=[];
      for(let i=0;i<5;i++){
        const id=await seedReadyEvent(f.mf,{id:`d${i}`+'4'.repeat(22),sourceId:'jwc',firstSeenAt:morning+1,observedAt:morning+1,readyAt:morning+2,publishedAt:new Date(morning+1).toISOString(),datePrecision:'minute',title:`第${i}篇`+'字'.repeat(mode==='bytes'?497:4)});
        ids.push(id);await notificationInvoke(f.mf,'enqueueEvent',id);await notificationInvoke(f.mf,'replayMatchOutbox');
      }
      await f.mailClock(evening);
      for(let i=0;i<5;i++){await f.mail('recover');await f.replayMail();}
      if(mode==='items')assert.equal(sent.length,3);
      else assert.ok(sent.length>1);
      assert.equal(new Set(sent.map(mail=>mail.key)).size,sent.length);
      for(const mail of sent){
        assert.ok(Buffer.byteLength(JSON.stringify(mail.body))<=8192);
        if(mode==='items')assert.ok((mail.body.text.match(/\?revision=/g)??[]).length<=2);
      }
      for(const id of ids)assert.equal(sent.map(mail=>mail.body.text).join('\n').split(`?revision=${id}`).length-1,1,id);
      await f.mail('recover');await f.replayMail({duplicate:true});
      assert.equal((await adminRequest(f.mf,'/internal/mail',undefined,{method:'GET'})).body.messages.length,sent.length);
    }finally{await f.mf.dispose();}
  }
});

test('recovery sends the due digest and carries late-ready and late-matched events into the next day without empty mail',async()=>{
  const sent=[];
  const f=await subscriptionsFixture({clock:morning,mailHarness:{async fetch(request){sent.push(await request.json());return Response.json({id:`88888888-8888-4888-8888-${String(sent.length).padStart(12,'0')}`});}}});
  try{
    await subscriptionsInvoke(f.mf,'change',{id:'digest-owner'},{requestId:'digest-late-create',name:'每日通知',sourceIds:['jwc'],emailMode:'daily_digest'});
    await f.mailClock(evening-60_000);await f.mail('recover');assert.equal(sent.length,0);
    const publish=async(index,title,readyAt)=>{
      const id=await seedReadyEvent(f.mf,{id:`c${index}`+'3'.repeat(22),sourceId:'jwc',firstSeenAt:morning+1,observedAt:morning+1,readyAt,publishedAt:new Date(morning+1).toISOString(),datePrecision:'minute',title});
      await notificationInvoke(f.mf,'enqueueEvent',id);await notificationInvoke(f.mf,'replayMatchOutbox');
    };
    await publish(0,'正常就绪',morning+2);
    await f.mailClock(evening);await f.mail('recover');await f.replayMail();
    assert.equal(sent.length,1);assert.match(sent[0].text,/正常就绪/);
    await notificationInvoke(f.mf,'clock',evening+60_000);
    await publish(1,'稍晚完成正文OCR',evening+30_000);
    await publish(2,'很早就绪但稍晚匹配',morning+2);
    await f.mailClock(evening+300_000);await f.mail('recover');await f.replayMail();assert.equal(sent.length,1);
    await f.mailClock(evening+86400_000);await f.mail('recover');await f.replayMail();
    assert.equal(sent.length,2);assert.match(sent[1].text,/稍晚完成正文OCR/);assert.match(sent[1].text,/很早就绪但稍晚匹配/);
    assert.ok(!sent[1].text.includes('正常就绪'));
    await f.mailClock(evening+2*86400_000);await f.mail('recover');await f.replayMail();assert.equal(sent.length,2);
  }finally{await f.mf.dispose();}
});

test('digest send preflight checks every item when a date is withdrawn after compilation',async()=>{
  for(const withdrawn of [0,1]){
    let sent=0;
    const f=await subscriptionsFixture({clock:morning,mailHarness:{async fetch(){sent++;return Response.json({id:'99999999-9999-4999-8999-999999999999'});}}});
    try{
      await subscriptionsInvoke(f.mf,'change',{id:'digest-owner'},{requestId:'digest-date-preflight',name:'每日通知',sourceIds:['jwc'],emailMode:'daily_digest'});
      const ids=[];
      for(let i=0;i<2;i++){
        const id=await seedReadyEvent(f.mf,{id:`b${i}`+'2'.repeat(22),sourceId:'jwc',firstSeenAt:morning+1,observedAt:morning+1,readyAt:morning+2,publishedAt:new Date(morning+1).toISOString(),datePrecision:'minute'});
        ids.push(id);await notificationInvoke(f.mf,'enqueueEvent',id);await notificationInvoke(f.mf,'replayMatchOutbox');
      }
      await f.mailClock(evening);assert.equal((await f.mail('prepareDigests')).prepared,1);
      const result=await notificationInvoke(f.mf,'verifyDate',ids[withdrawn],{requestId:'digest-date-withdraw',sourceId:'jwc',verifiedBy:'operator',datePrecision:'unknown',evidence:{note:'date withdrawn before digest'}});
      assert.equal(result.status,200);
      await f.replayMail();assert.equal(sent,0,`withdrawn item ${withdrawn}`);
      assert.equal((await adminRequest(f.mf,'/internal/mail',undefined,{method:'GET'})).body.messages[0].state,'cancelled');
    }finally{await f.mf.dispose();}
  }
});

test('20:00 Shanghai compiles one immutable cross-subscription digest and repeated Cron does not resend it',async()=>{
  const sent=[];
  const f=await subscriptionsFixture({clock:morning,mailHarness:{async fetch(request){sent.push({key:request.headers.get('idempotency-key'),body:await request.json()});return Response.json({id:'88888888-8888-4888-8888-888888888888'});}}});
  try{
    for(let i=0;i<2;i++)await subscriptionsInvoke(f.mf,'change',{id:'digest-owner'},{requestId:`digest-subscription-${i}`,name:`每日订阅${i}`,sourceIds:['jwc'],emailMode:'daily_digest'});
    for(const [index,title] of ['第一篇通知','第二篇通知'].entries()){
      const eventId=await seedReadyEvent(f.mf,{id:`a${index}`+'1'.repeat(22),sourceId:'jwc',firstSeenAt:morning+1,observedAt:morning+1,readyAt:morning+2,publishedAt:new Date(morning+1).toISOString(),datePrecision:'minute',title});
      await notificationInvoke(f.mf,'enqueueEvent',eventId);await notificationInvoke(f.mf,'replayMatchOutbox');
    }
    await f.mailClock(evening-60_000);await f.mail('prepareDigests');
    assert.equal((await adminRequest(f.mf,'/internal/mail',undefined,{method:'GET'})).body.messages.length,0);
    await f.mailClock(evening);await Promise.all([f.mail('prepareDigests'),f.mail('prepareDigests')]);
    await f.replayMail();await f.mail('prepareDigests');await f.replayMail({duplicate:true});
    assert.equal(sent.length,1);
    assert.match(sent[0].body.subject,/每日摘要/);
    assert.match(sent[0].body.text,/第一篇通知/);assert.match(sent[0].body.text,/第二篇通知/);
    const view=await adminRequest(f.mf,'/internal/mail',undefined,{method:'GET'});
    assert.equal(view.body.messages.length,1);assert.equal(view.body.messages[0].kind,'daily_digest');
    assert.equal(view.body.messages[0].state,'accepted');
  }finally{await f.mf.dispose();}
});
