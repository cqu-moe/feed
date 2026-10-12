import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { createResendProvider } from '../worker/mail-provider-resend.mjs';

const now = Date.parse('2026-10-12T04:00:00.000Z');
const webhookSecret='whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';

test('send submits a fixed payload with the idempotency key and accepts a valid response', async () => {
  const calls = [];
  const provider = createResendProvider({
    RESEND_API_KEY: 're_test_key',
  }, {
    fetch: async (url, init) => {
      calls.push({url, init});
      return new Response(JSON.stringify({id: '4ef9a417-02e9-4d39-ad75-9611e0fcc33c'}), {status: 200});
    },
    now: () => now,
  });

  const result = await provider.send({
    from: '重大通知 <notifications@feed.cqu.moe>',
    to: 'uu@401.moe',
    subject: '通知标题',
    html: '<p>正文</p>',
    text: '正文',
    tags: [{name: 'message_id', value: 'event-001'}],
  }, {idempotencyKey: 'feed-event-001'});

  assert.deepEqual(result, {status: 'accepted', providerId: '4ef9a417-02e9-4d39-ad75-9611e0fcc33c'});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer re_test_key');
  assert.equal(calls[0].init.headers['idempotency-key'], 'feed-event-001');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.equal(calls[0].init.body, JSON.stringify({
    from: '重大通知 <notifications@feed.cqu.moe>',
    to: 'uu@401.moe',
    subject: '通知标题',
    html: '<p>正文</p>',
    text: '正文',
    tags: [{name: 'message_id', value: 'event-001'}],
  }));
});

test('send classifies provider failures without exposing response content', async () => {
  const cases=[
    {response:{status:429,headers:{'retry-after':'7'}},expected:{status:'deferred',code:'rate_limit_exceeded',retryAfterMs:7000}},
    {response:{status:409,body:{name:'concurrent_idempotent_requests'}},
      expected:{status:'deferred',code:'concurrent_idempotent_requests',retryAfterMs:0}},
    {response:{status:409,body:{name:'invalid_idempotent_request'}},
      expected:{status:'rejected',code:'invalid_idempotent_request'}},
    {response:{status:422,body:{name:'invalid_request',message:'raw recipient leakage'}},
      expected:{status:'rejected',code:'invalid_request'}},
    {response:{status:503,body:{name:'service_unavailable'}},expected:{status:'unknown',code:'server_error'}},
    {response:{status:302},expected:{status:'unknown',code:'unexpected_status'}},
    {response:{status:200,body:'not json'},expected:{status:'unknown',code:'invalid_response'}},
  ];
  for(const item of cases){
    const provider=createResendProvider({RESEND_API_KEY:'re_test_key'},{
      fetch:async()=>new Response(typeof item.response.body==='object'?JSON.stringify(item.response.body):item.response.body??'{}',{
        status:item.response.status,
        headers:item.response.headers??{},
      }),
      now:()=>now,
    });
    const result=await provider.send(snapshot(),{idempotencyKey:'same-key'});
    assert.deepEqual(result,item.expected,JSON.stringify(result));
  }
});

test('network and timeout failures remain unknown', async () => {
  for(const failure of [
    {error:Object.assign(new Error('socket secret'),{name:'TypeError'}),code:'network'},
    {error:Object.assign(new Error('timed out'),{name:'AbortError'}),code:'timeout'},
  ]){
    const provider=createResendProvider({RESEND_API_KEY:'re_test_key'},{
      fetch:async()=>{throw failure.error;},
      now:()=>now,
    });
    assert.deepEqual(await provider.send(snapshot(),{idempotencyKey:'same-key'}),
      {status:'unknown',code:failure.code});
  }
});

test('send defers a definitely unconfigured provider without fetching', async () => {
  let fetched=false;
  const provider=createResendProvider({},{
    fetch:async()=>{fetched=true;return new Response('{}');},
    now:()=>now,
  });
  assert.deepEqual(await provider.send(snapshot(),{idempotencyKey:'unconfigured'}),
    {status:'deferred',code:'provider_not_configured',retryAfterMs:60_000});
  assert.equal(fetched,false);
});

test('outbound requests carry a bounded abort signal and classify aborts as unknown', async () => {
  const originalTimeout=AbortSignal.timeout;
  const controller=new AbortController();
  let observedSignal;
  AbortSignal.timeout=()=>controller.signal;
  try{
    const provider=createResendProvider({RESEND_API_KEY:'re_test_key'},{
      fetch:async(_url,init)=>{
        observedSignal=init.signal;
        return new Promise((_resolve,reject)=>{
          if(init.signal.aborted){
            const immediate=new Error('This operation was aborted');
            immediate.name='AbortError';
            reject(immediate);
            return;
          }
          init.signal.addEventListener('abort',()=>{
            const error=new Error('This operation was aborted');
            error.name='AbortError';
            reject(error);
          });
        });
      },
      now:()=>now,
    });
    const sendResult=provider.send(snapshot(),{idempotencyKey:'bounded'});
    assert.equal(observedSignal,controller.signal);
    controller.abort();
    assert.deepEqual(await sendResult,
      {status:'unknown',code:'timeout'});
    const getResult=provider.get('4ef9a417-02e9-4d39-ad75-9611e0fcc33c');
    assert.equal(observedSignal,controller.signal);
    assert.deepEqual(await getResult,
      {status:'unavailable',code:'timeout'});
  }finally{
    AbortSignal.timeout=originalTimeout;
  }
});

test('the same idempotency key and immutable payload replay the original provider id', async () => {
  const bodies=[];
  const provider=createResendProvider({RESEND_API_KEY:'re_test_key'},{
    fetch:async(_url,init)=>{
      bodies.push(init.body);
      return new Response(JSON.stringify({id:'56761188-7520-42d8-8898-ff6fc54ce618'}),{status:200});
    },
    now:()=>now,
  });
  const input=snapshot();
  assert.deepEqual(await provider.send(input,{idempotencyKey:'feed-event-001'}),
    {status:'accepted',providerId:'56761188-7520-42d8-8898-ff6fc54ce618'});
  assert.deepEqual(await provider.send(input,{idempotencyKey:'feed-event-001'}),
    {status:'accepted',providerId:'56761188-7520-42d8-8898-ff6fc54ce618'});
  assert.deepEqual(bodies,[bodies[0],bodies[0]]);
});

test('get maps a singular recipient and tags from the email record', async () => {
  const provider=createResendProvider({RESEND_API_KEY:'re_test_key'},{
    fetch:async url=>{
      assert.equal(url,'https://api.resend.com/emails/4ef9a417-02e9-4d39-ad75-9611e0fcc33c');
      return new Response(JSON.stringify({
        object:'email',
        id:'4ef9a417-02e9-4d39-ad75-9611e0fcc33c',
        to:['uu@401.moe'],
        last_event:'delivered',
        tags:[{name:'message_id',value:'event-001'}],
      }),{status:200});
    },
    now:()=>now,
  });

  assert.deepEqual(await provider.get('4ef9a417-02e9-4d39-ad75-9611e0fcc33c'),{
    status:'found',
    providerId:'4ef9a417-02e9-4d39-ad75-9611e0fcc33c',
    recipient:'uu@401.moe',
    event:'delivered',
    tags:{message_id:'event-001'},
  });
});

test('get returns safe unavailable and not-found outcomes', async () => {
  const cases=[
    {status:404,expected:{status:'not_found'}},
    {status:503,expected:{status:'unavailable',code:'server_error'}},
    {status:200,body:'not json',expected:{status:'unavailable',code:'invalid_response'}},
    {status:200,body:{id:'4ef9a417-02e9-4d39-ad75-9611e0fcc33c',to:[],last_event:'delivered'},
      expected:{status:'unavailable',code:'invalid_response'}},
  ];
  for(const item of cases){
    const provider=createResendProvider({RESEND_API_KEY:'re_test_key'},{
      fetch:async()=>new Response(typeof item.body==='object'?JSON.stringify(item.body):item.body??'{}',{status:item.status}),
      now:()=>now,
    });
    assert.deepEqual(await provider.get('4ef9a417-02e9-4d39-ad75-9611e0fcc33c'),item.expected);
  }
  const unavailable=createResendProvider({},{
    fetch:async()=>{throw new Error('must not fetch');},
    now:()=>now,
  });
  assert.deepEqual(await unavailable.get('4ef9a417-02e9-4d39-ad75-9611e0fcc33c'),
    {status:'unavailable',code:'provider_unavailable'});
  await assert.rejects(()=>unavailable.get('../escape'),
    error=>error.status===400&&/Invalid mail provider id/.test(error.message));
});

test('verifyWebhook authenticates raw bytes and maps relevant events', async () => {
  const provider=createResendProvider({RESEND_WEBHOOK_SECRET:webhookSecret},{now:()=>now});
  const event=webhookEvent('email.bounced');
  const result=await provider.verifyWebhook(signedRequest(event));

  assert.deepEqual(result,{
    id:'msg_001',
    type:'bounced',
    providerId:'56761188-7520-42d8-8898-ff6fc54ce618',
    recipient:'uu@401.moe',
    tags:{message_id:'event-001'},
    occurredAt:Date.parse('2026-10-12T04:00:01.000Z'),
    rawBody:JSON.stringify(event),
  });
});

test('verifyWebhook accepts any valid v1 signature and ignores non-delivery events', async () => {
  const provider=createResendProvider({RESEND_WEBHOOK_SECRET:webhookSecret},{now:()=>now});
  const event=webhookEvent('email.opened');
  const request=signedRequest(event,{
    signatures:['v1,AAAA'.repeat(32).slice(0,67),signatureFor(event)],
  });

  assert.equal((await provider.verifyWebhook(request)).type,'ignored');
});

test('verifyWebhook maps every relevant Resend event type', async () => {
  const provider=createResendProvider({RESEND_WEBHOOK_SECRET:webhookSecret},{now:()=>now});
  for(const [source,type] of [
    ['email.sent','accepted'],
    ['email.delivered','delivered'],
    ['email.bounced','bounced'],
    ['email.complained','complained'],
  ]){
    assert.equal((await provider.verifyWebhook(signedRequest(webhookEvent(source)))).type,type);
  }
});

test('verifyWebhook rejects replayed, changed, malformed, and oversized input safely', async () => {
  const provider=createResendProvider({RESEND_WEBHOOK_SECRET:webhookSecret},{now:()=>now});
  const event=webhookEvent('email.sent');
  const checks=[
    {request:signedRequest(event,{timestamp:now-301_000}),status:401},
    {request:signedRequest({...event,data:{...event.data,subject:'changed'}},
      {signatures:[signatureFor(event)]}),status:401},
    {request:new Request('https://feed.cqu.moe/webhooks/resend',{
      method:'POST',headers:{'svix-timestamp':String(now),'svix-signature':signatureFor(event)},body:'{}',
    }),status:400},
    {request:new Request('https://feed.cqu.moe/webhooks/resend',{
      method:'POST',
      headers:{
        'svix-id':'msg_001',
        'svix-timestamp':String(Math.floor(now/1000)),
        'svix-signature':signatureForBody('{}'),
      },
      body:'{}',
    }),status:400},
  ];
  for(const item of checks){
    await assert.rejects(()=>provider.verifyWebhook(item.request),error=>{
      assert.equal(error.status,item.status);
      assert.equal(error.name,'MailProviderError');
      assert.ok(!error.message.includes('uu@401.moe'));
      return true;
    });
  }

  const large=webhookEvent('email.sent');
  large.data.subject='x'.repeat(256*1024);
  await assert.rejects(()=>provider.verifyWebhook(signedRequest(large)),error=>error.status===413);
});

test('verifyWebhook rejects an oversized Content-Length before reading the body', async () => {
  const provider=createResendProvider({RESEND_WEBHOOK_SECRET:webhookSecret},{now:()=>now});
  const signed=signedRequest(webhookEvent('email.sent'));
  const request=new Request('https://feed.cqu.moe/webhooks/resend',{
    method:'POST',
    headers:{...Object.fromEntries(signed.headers.entries()),'content-length':String(256*1024+1)},
    body:'x',
  });
  await assert.rejects(()=>provider.verifyWebhook(request),error=>error.status===413);
});

test('verifyWebhook reports missing configuration without reading provider state', async () => {
  const provider=createResendProvider({},{now:()=>now});
  await assert.rejects(()=>provider.verifyWebhook(new Request('https://feed.cqu.moe/webhooks/resend',{
    method:'POST',body:'{}',
  })),error=>error.status===503&&error.name==='MailProviderError');
});

function snapshot(){
  return {
    from:'重大通知 <notifications@feed.cqu.moe>',
    to:'uu@401.moe',
    subject:'通知标题',
    html:'<p>正文</p>',
    text:'正文',
    tags:[{name:'message_id',value:'event-001'}],
  };
}

function webhookEvent(type){
  return {
    type,
    created_at:'2026-10-12T04:00:01.000Z',
    data:{
      email_id:'56761188-7520-42d8-8898-ff6fc54ce618',
      to:['uu@401.moe'],
      subject:'通知标题',
      tags:{message_id:'event-001'},
    },
  };
}

function signedRequest(event,{timestamp=now,signatures}={}){
  const id='msg_001',body=JSON.stringify(event);
  return new Request('https://feed.cqu.moe/webhooks/resend',{
    method:'POST',
    headers:{
      'svix-id':id,
      'svix-timestamp':String(Math.floor(timestamp/1000)),
      'svix-signature':(signatures??[signatureFor(event)]).join(' '),
    },
    body,
  });
}

function signatureFor(event,timestamp=now){
  return signatureForBody(JSON.stringify(event),timestamp);
}

function signatureForBody(body,timestamp=now){
  return `v1,${createHmac('sha256',Buffer.from(webhookSecret.slice(6),'base64'))
    .update(`msg_001.${Math.floor(timestamp/1000)}.${body}`)
    .digest('base64')}`;
}
