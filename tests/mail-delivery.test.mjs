import {test} from 'node:test';
import assert from 'node:assert/strict';
import {subscriptionsFixture,subscriptionsInvoke,notificationInvoke,adminRequest,feedJobsInvoke} from './helpers/subscriptions-fixture.mjs';
import {seedReadyEvent} from './helpers/notification-event.mjs';

const start=Date.parse('2026-10-12T04:00:00Z');

async function telemetryEvents(fixture){
  const response=await fixture.mf.dispatchFetch('https://feed.test/__test/telemetry');
  const body=await response.json();
  assert.equal(body.loaded,true);
  return body.events;
}

test('mail telemetry records provider acceptance without claiming delivery',async()=>{
  const sent=[];
  const f=await subscriptionsFixture({clock:start,telemetryHarness:true,mailHarness:{async fetch(request){
    const body=await request.json();
    sent.push({key:request.headers.get('idempotency-key'),body});
    return Response.json({id:'88888888-8888-4888-8888-888888888888'});
  }}});
  try{
    await subscriptionsInvoke(f.mf,'change',{id:'mail-owner'},{requestId:'mail-telemetry-create',name:'及时通知',sourceIds:['jwc'],emailMode:'immediate'});
    const eventId=await seedReadyEvent(f.mf,{id:'f55555555555555555555555',sourceId:'jwc',firstSeenAt:start+1,observedAt:start+1,readyAt:start+2,publishedAt:new Date(start+1).toISOString(),datePrecision:'minute'});
    await notificationInvoke(f.mf,'enqueueEvent',eventId);await notificationInvoke(f.mf,'replayMatchOutbox');
    await f.mailClock(start+120_000);await f.mail('preparePending');await f.replayMail();
    const view=await adminRequest(f.mf, f.admin,'/internal/mail',undefined,{method:'GET'});
    const messageId=view.body.messages[0].id;
    const events=(await telemetryEvents(f)).filter(event=>event.event==='feed_delivery_finalized');
    assert.equal(events.length,1);
    assert.equal(events[0].properties.state,'accepted');
    assert.equal(events[0].properties.outcome,'unverified');
    assert.equal(events[0].properties.provider_submission,true);
    assert.equal(events[0].properties.delivered,false);
    assert.equal(events[0].properties.operation_id,messageId);
    assert.equal(events[0].properties.attempt_id,`${messageId}:1`);
    assert.equal(events[0].properties.owner_sub,'mail-owner');
    assert.equal(JSON.stringify(events).includes('reader@example.test'),false);
    assert.equal(JSON.stringify(events).includes(sent[0].body.subject),false);
    assert.equal(JSON.stringify(events).includes(sent[0].body.text),false);
  }finally{await f.mf.dispose();}
});

test('a suppression committed at the final submission boundary prevents a provider call',async()=>{
  let submissions=0;
  const f=await subscriptionsFixture({clock:start,mailHarness:{async fetch(){submissions++;return Response.json({id:'77777777-7777-4777-8777-777777777777'});}}});
  try{
    await subscriptionsInvoke(f.mf,'change',{id:'mail-owner'},{requestId:'mail-concurrent-bounce',name:'及时通知',sourceIds:['jwc'],emailMode:'immediate'});
    const id=await seedReadyEvent(f.mf,{id:'f33333333333333333333333',sourceId:'jwc',firstSeenAt:start+1,observedAt:start+1,readyAt:start+2,publishedAt:new Date(start+1).toISOString(),datePrecision:'minute'});
    await notificationInvoke(f.mf,'enqueueEvent',id);await notificationInvoke(f.mf,'replayMatchOutbox');
    await f.mailClock(start+120_000);await f.mail('preparePending');
    await f.db.prepare(`CREATE TRIGGER concurrent_suppression BEFORE UPDATE ON mail_messages
      WHEN NEW.state='submitting' AND OLD.state='prepared' BEGIN
      INSERT INTO mail_suppressions(recipient_hash,reason,provider_id,created_at)
      VALUES (OLD.recipient_hash,'bounced','concurrent-webhook',${start}); END`).run();
    await f.replayMail();await f.mail('recover');await f.replayMail();
    assert.equal(submissions,0);
    const view=await adminRequest(f.mf, f.admin,'/internal/mail',undefined,{method:'GET'});
    assert.equal(view.body.messages[0].state,'cancelled');
    assert.equal(view.body.messages[0].lastError,'email_bounced');
  }finally{await f.mf.dispose();}
});

test('repeated queue exhaustion before provider submission stops automatic recovery',async()=>{
  let submissions=0;
  const f=await subscriptionsFixture({clock:start,mailHarness:{async fetch(){submissions++;throw new Error('unexpected provider call');}}});
  try{
    await subscriptionsInvoke(f.mf,'change',{id:'mail-owner'},{requestId:'mail-bounded-recovery',name:'及时通知',sourceIds:['jwc'],emailMode:'immediate'});
    const id=await seedReadyEvent(f.mf,{id:'f44444444444444444444444',sourceId:'jwc',firstSeenAt:start+1,observedAt:start+1,readyAt:start+2,publishedAt:new Date(start+1).toISOString(),datePrecision:'minute'});
    await notificationInvoke(f.mf,'enqueueEvent',id);await notificationInvoke(f.mf,'replayMatchOutbox');
    await f.mailClock(start+120_000);await f.mail('preparePending');
    await f.db.prepare("UPDATE mail_messages SET payload_hash=?").bind('0'.repeat(64)).run();
    assert.equal((await f.replayMail()).retried,1);
    // Queue dispatches succeeded, but every delivery exhausted its platform retries before a provider call.
    for(let attempt=1;attempt<=7;attempt++){
      await f.db.prepare("UPDATE outbox SET state='sent',attempts=? WHERE topic='feed-mail'").bind(attempt).run();
      await f.mail('recover');
    }
    const view=await adminRequest(f.mf, f.admin,'/internal/mail',undefined,{method:'GET'});
    assert.equal(view.body.messages[0].state,'deferred');
    assert.equal(view.body.messages[0].nextAttemptAt,null);
    assert.equal(view.body.messages[0].lastError,'retry_limit_reached');
    assert.equal((await f.replayMail()).retried,0);
    assert.equal(submissions,0);
    const event=await adminRequest(f.mf, f.admin,`/internal/notification-events/${id}`,undefined,{method:'GET'});
    assert.equal(event.body.delivery.state,'claimed');
    assert.equal((await f.mail('preparePending')).prepared,0);
  }finally{await f.mf.dispose();}
});

test('two subscriptions and duplicate preparation submit one immutable version email',async()=>{
  const submissions=[];
  const fixture=await subscriptionsFixture({clock:start,mailHarness:{async fetch(request){
    submissions.push({key:request.headers.get('idempotency-key'),body:await request.json()});
    return Response.json({id:'11111111-1111-4111-8111-111111111111'});
  }}});
  const {mf,admin}=fixture;
  try{
    for(const [i,name] of ['及时一','及时二'].entries())await subscriptionsInvoke(mf,'change',{id:'mail-owner'},{requestId:`mail-create-${i}`,name,sourceIds:['jwc'],emailMode:'immediate'});
    const eventId=await seedReadyEvent(mf,{id:'a11111111111111111111111',sourceId:'jwc',firstSeenAt:start+1,observedAt:start+1,readyAt:start+2,publishedAt:new Date(start+1).toISOString(),datePrecision:'minute',title:'申请 <script>alert(1)</script>'});
    await notificationInvoke(mf,'enqueueEvent',eventId);
    await notificationInvoke(mf,'replayMatchOutbox');
    const [prepared,again]=await Promise.all([adminRequest(mf, admin,'/internal/mail/prepare',{}),adminRequest(mf, admin,'/internal/mail/prepare',{})]);
    assert.equal(prepared.status,202,JSON.stringify(prepared));
    assert.equal(again.status,202);
    let view=await adminRequest(mf, admin,'/internal/mail',undefined,{method:'GET'});
    assert.equal(view.body.messages.length,1,JSON.stringify(view));
    await fixture.mailClock(Date.now());
    const replay=await fixture.replayMail();
    assert.equal(replay.retried,0);
    await fixture.replayMail({duplicate:true});
    assert.equal(submissions.length,1);
    assert.equal(submissions[0].body.to,'reader@example.test');
    assert.equal(submissions[0].body.from,'CQU Feed <noreply@feed.cqu.moe>');
    assert.match(submissions[0].body.html,/&lt;script&gt;/);
    assert.ok(!submissions[0].body.html.includes('<script>'));
    assert.match(submissions[0].body.text,new RegExp(`/articles/${eventId}\\?revision=${eventId}`));
    assert.ok(submissions[0].key.startsWith('feed-mail/'));
    view=await adminRequest(mf, admin,'/internal/mail',undefined,{method:'GET'});
    assert.equal(view.body.messages[0].state,'accepted');
    assert.ok(!JSON.stringify(view).includes('reader@example.test'));
    const event=await adminRequest(mf, admin,`/internal/notification-events/${eventId}`,undefined,{method:'GET'});
    assert.equal(event.body.deliveries.length,1);
    assert.equal(event.body.deliveries[0].state,'accepted');
  }finally{await mf.dispose();}
});

test('provider acceptance followed by a local commit failure retries the original message after its lease',async()=>{
  const sent=[];
  const f=await subscriptionsFixture({clock:start,mailHarness:{async fetch(request){sent.push({key:request.headers.get('idempotency-key'),body:await request.json()});return Response.json({id:'55555555-5555-4555-8555-555555555555'});}}});
  try{
    await subscriptionsInvoke(f.mf,'change',{id:'mail-owner'},{requestId:'mail-commit-create',name:'及时通知',sourceIds:['jwc'],emailMode:'immediate'});
    const id=await seedReadyEvent(f.mf,{id:'f11111111111111111111111',sourceId:'jwc',firstSeenAt:start+1,observedAt:start+1,readyAt:start+2,publishedAt:new Date(start+1).toISOString(),datePrecision:'minute'});
    await notificationInvoke(f.mf,'enqueueEvent',id);await notificationInvoke(f.mf,'replayMatchOutbox');
    const at=start+120_000;await f.mailClock(at);await f.mail('preparePending');
    await f.db.prepare("CREATE TRIGGER fail_accept BEFORE UPDATE ON mail_messages WHEN NEW.state='accepted' BEGIN SELECT RAISE(ABORT,'acceptance commit unavailable'); END").run();
    assert.equal((await f.replayMail()).retried,1);
    assert.equal(sent.length,1);
    await f.replayMail();assert.equal(sent.length,1);
    await f.db.prepare('DROP TRIGGER fail_accept').run();
    await f.mailClock(at+121_000);await f.mail('recover');await f.replayMail();
    assert.equal(sent.length,2);assert.deepEqual(sent[0],sent[1]);
    const view=await adminRequest(f.mf, f.admin,'/internal/mail',undefined,{method:'GET'});
    assert.equal(view.body.messages.length,1);assert.equal(view.body.messages[0].state,'accepted');
  }finally{await f.mf.dispose();}
});

test('first submission rechecks current Auth, target preference, address and unconsumed date corrections',async()=>{
  for(const scenario of ['auth','unverified','off','date','address']){
    const submissions=[];
    const f=await subscriptionsFixture({clock:start,mailHarness:{async fetch(request){submissions.push(await request.json());return Response.json({id:'22222222-2222-4222-8222-222222222222'});}}});
    try{
      const created=await subscriptionsInvoke(f.mf,'change',{id:'mail-owner'},{requestId:'mail-preflight-create',name:'及时通知',sourceIds:['jwc'],emailMode:'immediate'});
      assert.equal(created.status,200,JSON.stringify(created));
      const id=await seedReadyEvent(f.mf,{id:'b11111111111111111111111',sourceId:'jwc',firstSeenAt:start+1,observedAt:start+1,readyAt:start+2,publishedAt:new Date(start+1).toISOString(),datePrecision:'minute'});
      await notificationInvoke(f.mf,'enqueueEvent',id);await notificationInvoke(f.mf,'replayMatchOutbox');
      const at=Date.now();await f.mailClock(at);
      assert.equal((await f.mail('preparePending')).prepared,1);
      if(scenario==='auth')await f.setPolicyService({outage:true});
      if(scenario==='unverified')await f.setRecipient('mail-owner',{status:'unverified'});
      if(scenario==='address')await f.setRecipient('mail-owner',{status:'verified',email:'new@example.test'});
      if(scenario==='off'){
        const updated=await subscriptionsInvoke(f.mf,'update',{id:'mail-owner'},created.body.subscription.id,{requestId:'mail-preflight-off',expectedVersion:1,name:'及时通知',sourceIds:['jwc'],requestedEnabled:true,priority:100,emailMode:'off'});
        assert.equal(updated.status,200,JSON.stringify(updated));
      }
      if(scenario==='date'){
        const corrected=await notificationInvoke(f.mf,'verifyDate',id,{requestId:'mail-date-withdraw',sourceId:'jwc',verifiedBy:'operator',datePrecision:'unknown',evidence:{note:'date withdrawn'}});
        assert.equal(corrected.status,200,JSON.stringify(corrected));
        // Its rematch message deliberately remains queued: send must read authoritative evidence.
      }
      await f.replayMail();
      assert.equal(submissions.length,0,scenario);
      const view=await adminRequest(f.mf, f.admin,'/internal/mail',undefined,{method:'GET'});
      assert.equal(view.body.messages[0].state,scenario==='auth'?'deferred':'cancelled',scenario);
      if(scenario==='address'){
        assert.equal((await f.mail('preparePending')).prepared,1);
        await f.replayMail();
        assert.equal(submissions.length,1);
        assert.equal(submissions[0].to,'new@example.test');
      }
      if(scenario==='auth'){
        await f.setPolicyService({outage:false});await f.mailClock(at+120_000);
        await f.mail('recover');await f.replayMail();
        assert.equal(submissions.length,0);
        const event=await adminRequest(f.mf, f.admin,`/internal/notification-events/${id}`,undefined,{method:'GET'});
        assert.equal(event.body.delivery.kind,'daily_digest');assert.equal(event.body.delivery.state,'pending');
      }
    }finally{await f.mf.dispose();}
  }
});

test('lost provider responses retain the original claim, payload and key and stop outside the reconciliation window',async()=>{
  for(const mode of ['retry','expired','changed-address','limited-retry']){
    const submissions=[];
    const f=await subscriptionsFixture({clock:start,mailHarness:{async fetch(request){
      submissions.push({key:request.headers.get('idempotency-key'),body:await request.json()});
      if(submissions.length===1)return new Response('upstream lost',{status:502});
      if(mode==='limited-retry')return Response.json({name:'rate_limit_exceeded'},{status:429});
      return Response.json({id:'33333333-3333-4333-8333-333333333333'});
    }}});
    try{
      const created=await subscriptionsInvoke(f.mf,'change',{id:'mail-owner'},{requestId:'mail-unknown-create',name:'及时通知',sourceIds:['jwc'],emailMode:'immediate'});
      assert.equal(created.status,200);
      const id=await seedReadyEvent(f.mf,{id:'c11111111111111111111111',sourceId:'jwc',firstSeenAt:start+1,observedAt:start+1,readyAt:start+2,publishedAt:new Date(start+1).toISOString(),datePrecision:'minute'});
      await notificationInvoke(f.mf,'enqueueEvent',id);await notificationInvoke(f.mf,'replayMatchOutbox');
      const at=start+120_000;await f.mailClock(at);await f.mail('preparePending');await f.replayMail();
      let events=await adminRequest(f.mf, f.admin,`/internal/notification-events/${id}`,undefined,{method:'GET'});
      assert.equal(events.body.delivery.state,'submission_unknown');
      assert.equal((await f.mail('preparePending')).prepared,0);
      if(mode==='changed-address')await f.setRecipient('mail-owner',{status:'verified',email:'new@example.test'});
      await f.mailClock(at+(mode==='expired'?25*3600_000:120_000));
      await f.mail('recover');await f.replayMail();
      assert.equal(submissions.length,['retry','limited-retry'].includes(mode)?2:1,mode);
      const view=await adminRequest(f.mf, f.admin,'/internal/mail',undefined,{method:'GET'});
      assert.equal(view.body.messages.length,1);
      assert.equal(view.body.messages[0].state,mode==='retry'?'accepted':'submission_unknown');
      events=await adminRequest(f.mf, f.admin,`/internal/notification-events/${id}`,undefined,{method:'GET'});
      assert.equal(events.body.delivery.state,mode==='retry'?'accepted':'submission_unknown');
      if(mode==='retry')assert.deepEqual(submissions[1],submissions[0]);
      if(mode==='expired')assert.equal(view.body.messages[0].lastError,'reconciliation_required');
    }finally{await f.mf.dispose();}
  }
});
