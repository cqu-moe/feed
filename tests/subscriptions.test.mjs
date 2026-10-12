import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

import {login,oauthProvider} from './helpers/oauth-provider.mjs';

const feedOrigin='https://feed.test';
const policyOrigin='https://policy.test';
const staticSiteId='7fd03676e5751e9b6dd95ecb';
const sharedArticleUrl='https://jwc.cqu.edu.cn/info/2026/1.htm';

async function fixture({mailEnabled=false}={}){
  const app=await build({
    stdin:{contents:`import worker from './worker/index.mjs'; export default {fetch:worker.fetch};`,resolveDir:process.cwd()},
    bundle:true,write:false,format:'esm',platform:'browser',
    external:['node:buffer','node:*','cloudflare:workers'],
  });
  const policy=await build({
    stdin:{
      contents:`
        import {WorkerEntrypoint} from 'cloudflare:workers';
        const state={
          policies:{},
          defaultPolicy:{access:true,limit:{kind:'limited',value:10}},
          recipients:{},
          defaultRecipient:{status:'verified',email:'reader@example.test'},
          outage:false,
          result:'normal',
          switchAfterCalls:0,
          switchTo:null,
          policyCalls:0,
        };
        function envelope(data){return {ok:true,contractVersion:1,checkedAt:Date.now(),data};}
        function policyFor(userId){return state.policies[userId]??state.defaultPolicy;}
        function recipientFor(userId){return state.recipients[userId]??state.defaultRecipient;}
        export class AuthService extends WorkerEntrypoint{
          async getFeedPolicy(request){
            if(request.contractVersion!==1||request.clientId!=='feed-rpc-client'||request.clientSecret!=='feed-rpc-secret'){
              return {ok:false,code:request.contractVersion===1?'INVALID_CLIENT':'UNSUPPORTED_VERSION',retryable:false,requestId:'test'};
            }
            if(state.outage)throw new Error('policy unavailable');
            if(state.result==='malformed')return envelope({access:true,subscriptionLimit:{kind:'limited',value:'2'}});
            const policy=policyFor(request.userId);
            state.policyCalls+=1;
            if(state.switchAfterCalls===state.policyCalls&&state.switchTo){
              if('outage' in state.switchTo)state.outage=state.switchTo.outage;
              if('result' in state.switchTo)state.result=state.switchTo.result;
              if('limit' in state.switchTo)state.policies[request.userId]={access:policy.access,limit:state.switchTo.limit};
            }
            return envelope({access:policy.access,subscriptionLimit:policy.limit});
          }
          async getFeedRecipient(request){
            const checked=await this.getFeedPolicy(request);
            if(!checked.ok)return checked;
            return envelope({policy:checked.data,recipient:recipientFor(request.userId)});
          }
        }
        export default {
          async fetch(request){
            const url=new URL(request.url);
            if(url.pathname==='/state'&&request.method==='POST'){
              Object.assign(state,await request.json());
              return Response.json(state);
            }
            return Response.json(state);
          },
        };
      `,
      resolveDir:process.cwd(),
    },
    bundle:true,write:false,format:'esm',platform:'browser',
    external:['cloudflare:workers'],
  });
  const provider=oauthProvider();
  const mf=new Miniflare(convertV4MiniflareOptions({
    workers:[
      {
        name:'feed',modules:true,script:app.outputFiles[0].text,compatibilityDate:'2026-10-11',
        compatibilityFlags:['nodejs_compat'],
        bindings:{...provider.bindings,ADMIN_TOKEN:'test-admin-token',BASE_URL:feedOrigin,SOURCE_MANAGEMENT_ENABLED:'true',MAIL_ENABLED:String(mailEnabled),FEED_AUTH_RPC_CLIENT_ID:'feed-rpc-client',FEED_AUTH_RPC_CLIENT_SECRET:'feed-rpc-secret'},
        d1Databases:['DB'],r2Buckets:['ARCHIVE'],
    serviceBindings:{AUTH:request=>provider.fetch(request),AUTH_FEED_RPC:{name:'policy',entrypoint:'AuthService'}},
      },
      {
        name:'policy',modules:true,script:policy.outputFiles[0].text,compatibilityDate:'2026-10-11',
        compatibilityFlags:['nodejs_compat'],
      },
    ],
  }));
  const db=await mf.getD1Database('DB','feed');
  for(const name of ['0001_feed.sql','0002_auth.sql','0003_collection_lease.sql','0004_pdf_ocr.sql','0005_task_runtime.sql','0006_sources.sql','0007_archive_versions.sql','0009_subscriptions.sql','0010_subscription_editing.sql']){
    await applyMigration(db,await readFile(`migrations/${name}`,'utf8'));
  }
  const policyWorker=await mf.getWorker('policy');
  return {
    mf,db,
    login:(subject='user-a')=>login(mf,provider,subject),
    revokeAccess(){provider.setAccess(false);},
    async setPolicy(subject,policy){await post(policyWorker,`${policyOrigin}/state`,{policies:{[subject]:policy}});},
    async setPolicyService(changes){await post(policyWorker,`${policyOrigin}/state`,changes);},
    async switchAfterPolicyCall(subject,switchTo){await post(policyWorker,`${policyOrigin}/state`,{switchAfterCalls:1,switchTo,policies:{[subject]:{access:true,limit:{kind:'limited',value:1}}}});},
  };
}

test('an owner can retrieve the same private RSS link after creating, retrying and logging in again',async()=>{
  const {mf,login,setPolicy}=await fixture({mailEnabled:true});
  try{
    await setPolicy('user-a',{access:true,limit:{kind:'limited',value:2}});
    const cookie=await login();
    const command={requestId:'create-site-subscription',name:'教务处通知',siteIds:[staticSiteId],sourceIds:[],emailMode:'daily_digest'};
    const created=await call(mf,'/api/subscriptions',{cookie,method:'POST',origin:feedOrigin,body:command});
    assert.equal(created.status,201,JSON.stringify(created));
    assert.equal(created.body.created,true);
    assert.equal(created.body.subscription.name,'教务处通知');
    assert.equal(created.body.subscription.requestedEnabled,true);
    assert.equal(created.body.subscription.effectiveStatus,'active');
    assert.equal(created.body.subscription.emailMode,'daily_digest');
    assert.deepEqual(created.body.subscription.targetSourceIds,['jwc']);
    assert.match(created.body.subscription.rssUrl,/^\/rss\?token=[A-Za-z0-9_-]{43}$/);

    const replay=await call(mf,'/api/subscriptions',{cookie,method:'POST',origin:feedOrigin,body:command});
    assert.equal(replay.status,200,JSON.stringify(replay));
    assert.equal(replay.body.created,false);
    assert.equal(replay.body.subscription.id,created.body.subscription.id);
    assert.equal(replay.body.subscription.rssUrl,created.body.subscription.rssUrl);
    assert.equal(replay.body.subscription.rssUrl,created.body.subscription.rssUrl);
    const newSession=await login('user-a');
    const listed=await call(mf,'/api/subscriptions',{cookie:newSession});
    assert.deepEqual(listed.body.outputChannels.email,{enabled:true});
    assert.equal(listed.body.subscriptions[0].rssUrl,created.body.subscription.rssUrl);
    const otherSession=await login('other-owner');
    const other=await call(mf,'/api/subscriptions',{cookie:otherSession});
    assert.deepEqual(other.body.subscriptions,[]);
    assert.equal(JSON.stringify(other.body).includes(created.body.subscription.rssUrl),false);
  }finally{
    await mf.dispose();
  }
});

test('subscription listing exposes policy, source options, and preserved configuration for revoked reading access',async()=>{
  const {mf,login,setPolicy,revokeAccess}=await fixture();
  try{
    await setPolicy('revoked-reader',{access:true,limit:{kind:'limited',value:1}});
    const cookie=await login('revoked-reader');
    const created=await call(mf,'/api/subscriptions',{cookie,method:'POST',origin:feedOrigin,body:{
      requestId:'revoked-reader-subscription',name:'撤权前订阅',siteIds:[],sourceIds:['jwc'],emailMode:'daily_digest',
    }});
    assert.equal(created.status,201);
    revokeAccess();
    await setPolicy('revoked-reader',{access:false,limit:{kind:'limited',value:1}});
    const list=await call(mf,'/api/subscriptions',{cookie});
    assert.equal(list.status,200,JSON.stringify(list));
    assert.deepEqual(list.body.policy,{status:'available',access:false,subscriptionLimit:{kind:'limited',value:1}});
    assert.equal(list.body.usage,1);
    assert.equal(list.body.subscriptions[0].effectiveStatus,'access_revoked');
    assert.equal(list.body.subscriptions[0].id,created.body.subscription.id);
    assert.ok(list.body.sites.some(site=>site.id===staticSiteId));
    assert.ok(list.body.sources.some(source=>source.id==='jwc'&&source.siteId===staticSiteId));
    assert.deepEqual(list.body.outputChannels,{rss:{enabled:true},email:{enabled:false,reason:'disabled'}});

    const denied=await call(mf,'/api/subscriptions',{cookie,method:'POST',origin:feedOrigin,body:{
      requestId:'revoked-reader-new',name:'撤权后创建',siteIds:[],sourceIds:['jwc'],emailMode:'daily_digest',
    }});
    assert.equal(denied.status,403);
    assert.equal((await call(mf,'/api/subscriptions',{cookie})).body.usage,1);
  }finally{
    await mf.dispose();
  }
});

test('an Auth RPC outage pauses computed running state without dropping saved configuration',async()=>{
  const {mf,login,setPolicy,setPolicyService}=await fixture();
  try{
    await setPolicy('list-outage-user',{access:true,limit:{kind:'limited',value:1}});
    const cookie=await login('list-outage-user');
    const created=await call(mf,'/api/subscriptions',{cookie,method:'POST',origin:feedOrigin,body:{
      requestId:'list-outage-subscription',name:'故障前订阅',siteIds:[],sourceIds:['jwc'],emailMode:'daily_digest',
    }});
    assert.equal(created.status,201);
    await setPolicyService({outage:true,result:'normal',switchAfterCalls:0,switchTo:null,policyCalls:0});
    const list=await call(mf,'/api/subscriptions',{cookie});
    assert.equal(list.status,200,JSON.stringify(list));
    assert.deepEqual(list.body.policy,{status:'auth_unavailable'});
    assert.equal(list.body.usage,1);
    assert.equal(list.body.subscriptions[0].effectiveStatus,'auth_unavailable');
  }finally{
    await mf.dispose();
  }
});

test('finite quota prevents concurrent over-creation while paused configs still count and soft-deleted configs do not',async()=>{
  const {mf,db,login,setPolicy}=await fixture();
  try{
    await setPolicy('quota-user',{access:true,limit:{kind:'limited',value:2}});
    const cookie=await login('quota-user');
    const commands=[0,1,2].map(index=>({
      requestId:`quota-concurrent-${index}`,name:`订阅 ${index}`,siteIds:[],sourceIds:['jwc'],emailMode:'off',
    }));
    const [first,second,third]=await Promise.all(commands.map(command=>
      call(mf,'/api/subscriptions',{cookie,method:'POST',origin:feedOrigin,body:command})));
    const successes=[first,second,third].filter(result=>result.status===201);
    assert.equal(successes.length,2);
    assert.equal([first,second,third].filter(result=>result.status===403).length,1);
    assert.equal(successes[0].body.subscription.effectiveStatus,'active');
    assert.equal(successes[1].body.subscription.effectiveStatus,'active');
    assert.equal((await call(mf,'/api/subscriptions',{cookie})).body.usage,2);

    await db.prepare('UPDATE subscriptions SET requested_enabled=0 WHERE id=?').bind(successes[0].body.subscription.id).run();
    await setPolicy('quota-user',{access:true,limit:{kind:'limited',value:1}});
    const afterPause=await call(mf,'/api/subscriptions',{cookie});
    assert.equal(afterPause.body.subscriptions.find(subscription=>subscription.id===successes[1].body.subscription.id).effectiveStatus,'active');
    await setPolicy('quota-user',{access:true,limit:{kind:'limited',value:2}});
    const pausedStillCounts=await call(mf,'/api/subscriptions',{cookie,method:'POST',origin:feedOrigin,body:{
      requestId:'quota-after-pause',name:'暂停后创建',siteIds:[],sourceIds:['jwc'],emailMode:'daily_digest',
    }});
    assert.equal(pausedStillCounts.status,403);

    await db.prepare('UPDATE subscriptions SET deleted_at=? WHERE owner_sub=? AND name=?').bind(Date.now(),'quota-user','订阅 0').run();
    const afterDelete=await call(mf,'/api/subscriptions',{cookie,method:'POST',origin:feedOrigin,body:{
      requestId:'quota-after-delete',name:'删除后创建',siteIds:[],sourceIds:['jwc'],emailMode:'immediate',
    }});
    assert.equal(afterDelete.status,201,JSON.stringify(afterDelete));
    assert.equal((await call(mf,'/api/subscriptions',{cookie})).body.usage,2);
    assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE owner_sub=? AND deleted_at IS NOT NULL').bind('quota-user').first('n'),1);
  }finally{
    await mf.dispose();
  }
});

test('request identity is owner-scoped and conflicting commands are explicit',async()=>{
  const {mf,login,setPolicy}=await fixture();
  try{
    await setPolicy('owner-a',{access:true,limit:{kind:'unlimited'}});
    await setPolicy('owner-b',{access:true,limit:{kind:'unlimited'}});
    const cookieA=await login('owner-a'),cookieB=await login('owner-b');
    const command={requestId:'same-request-id',name:'A 的订阅',siteIds:[],sourceIds:['jwc'],emailMode:'daily_digest'};
    const created=await call(mf,'/api/subscriptions',{cookie:cookieA,method:'POST',origin:feedOrigin,body:command});
    assert.equal(created.status,201);

    const listB=await call(mf,'/api/subscriptions',{cookie:cookieB});
    assert.equal(listB.body.usage,0);
    assert.deepEqual(listB.body.subscriptions,[]);
    const createdB=await call(mf,'/api/subscriptions',{cookie:cookieB,method:'POST',origin:feedOrigin,body:{
      ...command,name:'B 的订阅',
    }});
    assert.equal(createdB.status,201);
    assert.notEqual(createdB.body.subscription.id,created.body.subscription.id);

    const conflict=await call(mf,'/api/subscriptions',{cookie:cookieA,method:'POST',origin:feedOrigin,body:{
      ...command,name:'冲突命令',
    }});
    assert.equal(conflict.status,409);
    const replay=await call(mf,'/api/subscriptions',{cookie:cookieA,method:'POST',origin:feedOrigin,body:command});
    assert.equal(replay.body.subscription.id,created.body.subscription.id);
    assert.equal((await call(mf,'/api/subscriptions',{cookie:cookieA})).body.usage,1);

    const forgedOwner=await call(mf,'/api/subscriptions',{cookie:cookieA,method:'POST',origin:feedOrigin,body:{
      ...command,requestId:'forged-owner-request',ownerSub:'owner-b',
    }});
    assert.equal(forgedOwner.status,400);
    assert.equal((await call(mf,'/api/subscriptions',{cookie:cookieA})).body.usage,1);
  }finally{
    await mf.dispose();
  }
});

test('pre-check failures never write, while post-write downgrade or outage preserves the created config',async()=>{
  const {mf,login,setPolicy,setPolicyService}=await fixture();
  try{
    const cases=[
      ['missing',{access:true,limit:{kind:'missing'}}],
      ['zero',{access:true,limit:{kind:'limited',value:0}}],
      ['revoked',{access:false,limit:{kind:'limited',value:2}}],
    ];
    for(const [subject,policy] of cases){
      await setPolicy(subject,policy);
      const cookie=await login(subject);
      const response=await call(mf,'/api/subscriptions',{cookie,method:'POST',origin:feedOrigin,body:{
        requestId:`pre-${subject}`,name:'不应创建',siteIds:[],sourceIds:['jwc'],emailMode:'daily_digest',
      }});
      assert.equal(response.status,403,JSON.stringify(response));
      assert.equal((await call(mf,'/api/subscriptions',{cookie})).body.usage,0);
    }
    for(const [subject,mode] of [['invalid-user','result'],['outage-user','outage']]){
      await setPolicyService({result:'normal',outage:false});
      await setPolicy(subject,{access:true,limit:{kind:'limited',value:1}});
      if(mode==='result')await setPolicyService({result:'malformed'});
      else await setPolicyService({outage:true});
      const cookie=await login(subject);
      const response=await call(mf,'/api/subscriptions',{cookie,method:'POST',origin:feedOrigin,body:{
        requestId:`pre-${subject}`,name:'不应创建',siteIds:[],sourceIds:['jwc'],emailMode:'daily_digest',
      }});
      assert.equal(response.status,503,JSON.stringify(response));
      assert.equal((await call(mf,'/api/subscriptions',{cookie})).body.usage,0);
    }

    await setPolicyService({result:'normal',outage:false});
    await setPolicy('downgrade-user',{access:true,limit:{kind:'limited',value:1}});
    await setPolicyService({switchAfterCalls:1,switchTo:{limit:{kind:'limited',value:0}},policyCalls:0});
    const downgradeCookie=await login('downgrade-user');
    const downgraded=await call(mf,'/api/subscriptions',{cookie:downgradeCookie,method:'POST',origin:feedOrigin,body:{
      requestId:'post-downgrade',name:'写后降额',siteIds:[],sourceIds:['jwc'],emailMode:'daily_digest',
    }});
    assert.equal(downgraded.status,201,JSON.stringify(downgraded));
    assert.equal(downgraded.body.created,true);
    assert.equal(downgraded.body.subscription.effectiveStatus,'quota_exceeded');
    const downgradeReplay=await call(mf,'/api/subscriptions',{cookie:downgradeCookie,method:'POST',origin:feedOrigin,body:{
      requestId:'post-downgrade',name:'写后降额',siteIds:[],sourceIds:['jwc'],emailMode:'daily_digest',
    }});
    assert.equal(downgradeReplay.status,200);
    assert.equal(downgradeReplay.body.subscription.effectiveStatus,'quota_exceeded');
    assert.equal((await call(mf,'/api/subscriptions',{cookie:downgradeCookie})).body.usage,1);

    await setPolicyService({result:'normal',outage:false,switchAfterCalls:0,switchTo:null,policyCalls:0});
    await setPolicy('outage-after-user',{access:true,limit:{kind:'limited',value:1}});
    await setPolicyService({switchAfterCalls:1,switchTo:{outage:true},policyCalls:0});
    const outageCookie=await login('outage-after-user');
    const outage=await call(mf,'/api/subscriptions',{cookie:outageCookie,method:'POST',origin:feedOrigin,body:{
      requestId:'post-outage',name:'写后故障',siteIds:[],sourceIds:['jwc'],emailMode:'daily_digest',
    }});
    assert.equal(outage.status,201,JSON.stringify(outage));
    assert.equal(outage.body.created,true);
    assert.equal(outage.body.subscription.effectiveStatus,'auth_unavailable');
  }finally{
    await mf.dispose();
  }
});

test('site retries keep the first source snapshot and the retrievable RSS credential is encrypted at rest',async()=>{
  const {mf,db,login,setPolicy}=await fixture();
  try{
    await setPolicy('freeze-user',{access:true,limit:{kind:'unlimited'}});
    const cookie=await login('freeze-user');
    const command={requestId:'freeze-site',name:'冻结站点',siteIds:[staticSiteId],sourceIds:[],emailMode:'daily_digest'};
    const created=await call(mf,'/api/subscriptions',{cookie,method:'POST',origin:feedOrigin,body:command});
    assert.equal(created.status,201,JSON.stringify(created));
    assert.deepEqual(created.body.subscription.targetSourceIds,['jwc']);
    const token=new URL(created.body.subscription.rssUrl,feedOrigin).searchParams.get('token');
    const credential=await db.prepare('SELECT rss_token_hash AS hash,rss_token_ciphertext AS ciphertext FROM subscriptions WHERE id=?').bind(created.body.subscription.id).first();
    assert.match(credential.hash,/^[a-f0-9]{64}$/);
    assert.notEqual(credential.hash,token);
    assert.match(credential.ciphertext,/^v1\./);
    assert.equal(credential.ciphertext.includes(token),false);

    const added=await adminRequest(mf,'/internal/sources',{
      siteId:staticSiteId,name:'教务处新栏目',listUrl:'https://jwc.cqu.edu.cn/new/list.htm',
      articlePattern:'^/info/[0-9]+/[0-9]+[.]htm$',refreshIntervalSec:1800,
      sampleArticleUrl:sharedArticleUrl,timezone:'Asia/Shanghai',
    });
    assert.equal(added.status,201,JSON.stringify(added));
    assert.equal(added.body.source.siteId,staticSiteId);
    assert.equal(added.body.source.validationState,'draft');
    await db.prepare(`UPDATE sources SET enabled=1,validation_state='verified',updated_at=? WHERE id=?`)
      .bind(Date.now(),added.body.source.id).run();
    const replay=await call(mf,'/api/subscriptions',{cookie,method:'POST',origin:feedOrigin,body:command});
    assert.equal(replay.status,200);
    assert.deepEqual(replay.body.subscription.targetSourceIds,['jwc']);
    assert.equal(replay.body.subscription.rssUrl,created.body.subscription.rssUrl);
    assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM subscription_sources WHERE subscription_id=?').bind(created.body.subscription.id).first('n'),1);

    const sources=(await call(mf,'/api/sources',{cookie})).body.sources;
    assert.equal(sources.filter(source=>source.siteId===staticSiteId).length,2);
  }finally{
    await mf.dispose();
  }
});

test('the reserved static source seed preserves T04 adapter configuration',async()=>{
  const {mf,db,login}=await fixture();
  try{
    const cookie=await login('seed-user');
    assert.equal((await call(mf,'/api/sources',{cookie})).status,200);
    const rows=await db.prepare('SELECT id,config_json FROM sources ORDER BY id').all();
    const config=Object.fromEntries(rows.results.map(row=>[row.id,JSON.parse(row.config_json)]));
    assert.deepEqual(config.jwc.listUrls,['https://jwc.cqu.edu.cn/index/tzgg.htm','https://jwc.cqu.edu.cn/index/tzgg/xjgl.htm']);
    assert.equal(config.jwc.articlePattern,'^/info/\\d+/\\d+\\.htm$');
    assert.equal(config.news.articlePattern,'^/info/1008/\\d+\\.htm$');
  }finally{
    await mf.dispose();
  }
});

test('a removed target interval can be added again with a new effective time',async()=>{
  const {mf,db,login,setPolicy}=await fixture();
  try{
    await setPolicy('interval-user',{access:true,limit:{kind:'unlimited'}});
    const cookie=await login('interval-user');
    const created=await call(mf,'/api/subscriptions',{cookie,method:'POST',origin:feedOrigin,body:{
      requestId:'interval-target',name:'区间订阅',siteIds:[],sourceIds:['jwc'],emailMode:'daily_digest',
    }});
    assert.equal(created.status,201);
    await db.prepare('UPDATE subscription_sources SET removed_at=? WHERE subscription_id=? AND removed_at IS NULL')
      .bind(Date.now(),created.body.subscription.id).run();
    await db.prepare(`INSERT INTO subscription_sources(id,subscription_id,source_id,effective_from)
      VALUES ('bbbbbbbbbbbbbbbbbbbbbbbb',?, 'jwc',?)`).bind(created.body.subscription.id,Date.now()+1).run();
    const intervals=await db.prepare(`SELECT effective_from,removed_at FROM subscription_sources
      WHERE subscription_id=? ORDER BY effective_from`).bind(created.body.subscription.id).all();
    assert.equal(intervals.results.length,2);
    assert.notEqual(intervals.results[0].removed_at,null);
    assert.equal(intervals.results[1].removed_at,null);
  }finally{
    await mf.dispose();
  }
});

test('subscription writes require a session and same-origin POST',async()=>{
  const {mf,login,setPolicy}=await fixture();
  try{
    await setPolicy('csrf-user',{access:true,limit:{kind:'unlimited'}});
    const command={requestId:'csrf-command',name:'CSRF 订阅',siteIds:[],sourceIds:['jwc'],emailMode:'daily_digest'};
    assert.equal((await call(mf,'/api/subscriptions')).status,401);
    const cookie=await login('csrf-user');
    const wrongOrigin=await call(mf,'/api/subscriptions',{cookie,method:'POST',origin:'https://evil.test',body:command});
    assert.equal(wrongOrigin.status,403);
    const missingOrigin=await call(mf,'/api/subscriptions',{cookie,method:'POST',body:command});
    assert.equal(missingOrigin.status,403);
    assert.equal((await call(mf,'/api/subscriptions',{cookie})).body.usage,0);
  }finally{
    await mf.dispose();
  }
});

async function call(mf,path,{cookie,method='GET',origin,body}={}){
  const response=await mf.dispatchFetch(feedOrigin+path,{
    method,
    headers:{...(cookie?{Cookie:cookie}:{}),...(origin?{Origin:origin}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},
    body:body===undefined?undefined:JSON.stringify(body),
  });
  return {status:response.status,body:await response.json()};
}

async function post(worker,path,body){
  const response=await worker.fetch(path,{method:'POST',body:JSON.stringify(body),headers:{'Content-Type':'application/json'}});
  assert.equal(response.status,200);
}

async function adminRequest(mf,path,body){
  const response=await mf.dispatchFetch(feedOrigin+path,{
    method:'POST',headers:{Authorization:'Bearer test-admin-token','Content-Type':'application/json'},body:JSON.stringify(body),
  });
  return {status:response.status,body:await response.json()};
}

async function applyMigration(db,sql){
  const statements=sql.split(/;\s*\n(?=CREATE|ALTER|PRAGMA|CREATE INDEX|INSERT|UPDATE|$)/)
    .map(statement=>statement.trim())
    .filter(statement=>statement&&!/^PRAGMA\b/i.test(statement));
  for(const statement of statements)await db.prepare(statement).run();
}
