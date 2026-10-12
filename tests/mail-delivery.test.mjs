import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {subscriptionsFixture,subscriptionsInvoke,notificationInvoke,adminRequest,feedJobsInvoke} from './helpers/subscriptions-fixture.mjs';
import {seedReadyEvent} from './helpers/notification-event.mjs';

const start=Date.parse('2026-10-12T04:00:00Z');
test('two subscriptions and duplicate preparation submit one immutable version email',async()=>{
  const submissions=[];
  const fixture=await subscriptionsFixture({clock:start,mailHarness:{async fetch(request){
    if(request.method==='GET')return Response.json({id:'11111111-1111-4111-8111-111111111111',to:['reader@example.test'],last_event:'delivered',tags:submissions[0].body.tags});
    submissions.push({key:request.headers.get('idempotency-key'),body:await request.json()});
    return Response.json({id:'11111111-1111-4111-8111-111111111111'});
  }}});
  const {mf}=fixture;
  try{
    for(const [i,name] of ['及时一','及时二'].entries())await subscriptionsInvoke(mf,'change',{id:'mail-owner'},{requestId:`mail-create-${i}`,name,sourceIds:['jwc'],emailMode:'immediate'});
    const eventId=await seedReadyEvent(mf,{id:'a11111111111111111111111',sourceId:'jwc',firstSeenAt:start+1,observedAt:start+1,readyAt:start+2,publishedAt:new Date(start+1).toISOString(),datePrecision:'minute',title:'申请 <script>alert(1)</script>'});
    await notificationInvoke(mf,'enqueueEvent',eventId);
    await notificationInvoke(mf,'replayMatchOutbox');
    const [prepared,again]=await Promise.all([adminRequest(mf,'/internal/mail/prepare',{}),adminRequest(mf,'/internal/mail/prepare',{})]);
    assert.equal(prepared.status,202,JSON.stringify(prepared));
    assert.equal(again.status,202);
    let view=await adminRequest(mf,'/internal/mail',undefined,{method:'GET'});
    assert.equal(view.body.messages.length,1,JSON.stringify(view));
    await fixture.mailClock(Date.now());
    const replay=await fixture.replayMail();
    assert.equal(replay.retried,0);
    await fixture.replayMail({duplicate:true});
    assert.equal(submissions.length,1);
    assert.equal(submissions[0].body.to,'reader@example.test');
    assert.match(submissions[0].body.html,/&lt;script&gt;/);
    assert.ok(!submissions[0].body.html.includes('<script>'));
    assert.match(submissions[0].body.text,new RegExp(`/articles/${eventId}\\?revision=${eventId}`));
    assert.ok(submissions[0].key.startsWith('feed-mail/'));
    view=await adminRequest(mf,'/internal/mail',undefined,{method:'GET'});
    assert.equal(view.body.messages[0].state,'accepted');
    assert.ok(!JSON.stringify(view).includes('reader@example.test'));
    const event=await adminRequest(mf,`/internal/notification-events/${eventId}`,undefined,{method:'GET'});
    assert.equal(event.body.deliveries.length,1);
    assert.equal(event.body.deliveries[0].state,'accepted');
    const reconciled=await adminRequest(mf,`/internal/mail/${view.body.messages[0].id}/reconcile`,{});
    assert.equal(reconciled.status,200,JSON.stringify(reconciled));
    assert.equal(reconciled.body.state,'delivered');
    assert.equal(submissions.length,1);
  }finally{await mf.dispose();}
});

test('signed durable webhooks reconcile unknown submissions and out-of-order bounce suppresses only mail',async()=>{
  const sent=[];
  const f=await subscriptionsFixture({clock:start,mailHarness:{async fetch(request){sent.push(await request.json());return new Response('lost',{status:502});}}});
  try{
    const created=await subscriptionsInvoke(f.mf,'change',{id:'mail-owner'},{requestId:'mail-webhook-create',name:'及时通知',sourceIds:['jwc'],emailMode:'immediate'});
    assert.equal(created.status,200);
    const id=await seedReadyEvent(f.mf,{id:'d11111111111111111111111',sourceId:'jwc',firstSeenAt:start+1,observedAt:start+1,readyAt:start+2,publishedAt:new Date(start+1).toISOString(),datePrecision:'minute'});
    await notificationInvoke(f.mf,'enqueueEvent',id);await notificationInvoke(f.mf,'replayMatchOutbox');
    await f.mailClock(start+120_000);await f.mail('preparePending');await f.replayMail();
    const messageId=sent[0].tags.find(tag=>tag.name==='feed_message_id').value;
    const requests=new Map();
    const sendHook=async(type,receiptId,overrides={})=>{
      const body=JSON.stringify({type,created_at:new Date().toISOString(),data:{email_id:'44444444-4444-4444-8444-444444444444',to:['reader@example.test'],tags:{feed_message_id:messageId},...overrides}});
      const timestamp=String(Math.floor(Date.now()/1000));
      const signature=createHmac('sha256',Buffer.from('test-signing-key')).update(`${receiptId}.${timestamp}.${body}`).digest('base64');
      const init={method:'POST',headers:{'content-type':'application/json','svix-id':receiptId,'svix-timestamp':timestamp,'svix-signature':`v1,${signature}`},body};
      requests.set(receiptId,init);
      return f.mf.dispatchFetch('https://feed.test/webhooks/resend',init);
    };
    await f.db.prepare("CREATE TRIGGER fail_receipt BEFORE INSERT ON mail_webhook_receipts BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END").run();
    let response=await sendHook('email.delivered','evt_delivered_1');
    assert.equal(response.status,503);
    await f.db.prepare('DROP TRIGGER fail_receipt').run();
    await f.db.prepare("CREATE TRIGGER fail_receipt_apply BEFORE UPDATE ON mail_messages BEGIN SELECT RAISE(ABORT,'apply unavailable'); END").run();
    response=await f.mf.dispatchFetch('https://feed.test/webhooks/resend',requests.get('evt_delivered_1'));
    assert.equal(response.status,200,await response.text());
    await f.db.prepare('DROP TRIGGER fail_receipt_apply').run();
    await f.mail('recoverDisabled');
    const recoveredWhileDisabled=await adminRequest(f.mf,'/internal/mail',undefined,{method:'GET'});
    assert.equal(recoveredWhileDisabled.body.messages[0].state,'delivered');
    response=await f.mf.dispatchFetch('https://feed.test/webhooks/resend',requests.get('evt_delivered_1'));
    assert.equal(response.status,200);
    response=await sendHook('email.sent','evt_accepted_older');assert.equal(response.status,200);
    let view=await adminRequest(f.mf,'/internal/mail',undefined,{method:'GET'});
    assert.equal(view.body.messages[0].state,'delivered');
    assert.ok(view.body.messages[0].acceptedAt&&view.body.messages[0].deliveredAt);
    response=await sendHook('email.bounced','evt_bounce_1');assert.equal(response.status,200);
    response=await sendHook('email.delivered','evt_delivered_2');assert.equal(response.status,200);
    view=await adminRequest(f.mf,'/internal/mail',undefined,{method:'GET'});
    assert.equal(view.body.messages[0].state,'bounced');
    assert.ok(view.body.messages[0].deliveredAt&&view.body.messages[0].bouncedAt);
    const second=await seedReadyEvent(f.mf,{id:'e11111111111111111111111',sourceId:'jwc',firstSeenAt:start+1,observedAt:start+1,readyAt:start+2,publishedAt:new Date(start+1).toISOString(),datePrecision:'minute'});
    await notificationInvoke(f.mf,'enqueueEvent',second);await notificationInvoke(f.mf,'replayMatchOutbox');
    assert.equal((await f.mail('preparePending')).prepared,0);
    const event=await adminRequest(f.mf,`/internal/notification-events/${second}`,undefined,{method:'GET'});
    assert.equal(event.body.delivery.suppressionReason,'email_bounced');
    const rss=await f.mf.dispatchFetch('https://feed.test'+created.body.subscription.rssUrl);
    assert.equal(rss.status,200);assert.match(await rss.text(),/及时匹配通知/);
    assert.equal(sent.length,1);
  }finally{await f.mf.dispose();}
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
    const view=await adminRequest(f.mf,'/internal/mail',undefined,{method:'GET'});
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
      const view=await adminRequest(f.mf,'/internal/mail',undefined,{method:'GET'});
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
        const event=await adminRequest(f.mf,`/internal/notification-events/${id}`,undefined,{method:'GET'});
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
      let events=await adminRequest(f.mf,`/internal/notification-events/${id}`,undefined,{method:'GET'});
      assert.equal(events.body.delivery.state,'submission_unknown');
      assert.equal((await f.mail('preparePending')).prepared,0);
      if(mode==='changed-address')await f.setRecipient('mail-owner',{status:'verified',email:'new@example.test'});
      await f.mailClock(at+(mode==='expired'?25*3600_000:120_000));
      await f.mail('recover');await f.replayMail();
      assert.equal(submissions.length,['retry','limited-retry'].includes(mode)?2:1,mode);
      const view=await adminRequest(f.mf,'/internal/mail',undefined,{method:'GET'});
      assert.equal(view.body.messages.length,1);
      assert.equal(view.body.messages[0].state,mode==='retry'?'accepted':'submission_unknown');
      events=await adminRequest(f.mf,`/internal/notification-events/${id}`,undefined,{method:'GET'});
      assert.equal(events.body.delivery.state,mode==='retry'?'accepted':'submission_unknown');
      if(mode==='retry')assert.deepEqual(submissions[1],submissions[0]);
      if(mode==='expired')assert.equal(view.body.messages[0].lastError,'reconciliation_required');
    }finally{await f.mf.dispose();}
  }
});
