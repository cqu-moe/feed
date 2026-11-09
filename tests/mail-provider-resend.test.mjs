import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createResendProvider } from '../worker/mail-provider-resend.mjs';

const now = Date.parse('2026-10-12T04:00:00.000Z');

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
