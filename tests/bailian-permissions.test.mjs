import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {subscriptionsFixture,subscriptionCall,applyMigration} from './helpers/subscriptions-fixture.mjs';

test('only an entitled administrator can preview before cutover or advance a same-origin batch',async t=>{
  let requests=0;
  const f=await subscriptionsFixture({recheckMigration:true,recheckVars:{
    BAILIAN_SEARCH_READS:'false',BAILIAN_SEARCH_WRITES:'true',BAILIAN_API_KEY:'test-only',BAILIAN_WORKSPACE_ID:'example',
    BAILIAN_CATEGORY_ID:'test-category',BAILIAN_INDEX_ID:'test-index',BAILIAN_SEARCH_SERVICE_ID:'test-service',
  },outboundService:request=>{
    assert.equal(new URL(request.url).pathname,'/api/v1/indices/knowledge/search');
    requests++;return Response.json({success:true,status:'SUCCESS',data:{nodes:[]}});
  }});
  t.after(()=>f.mf.dispose());
  await applyMigration(f.db,(await readFile('migrations/0022_bailian_search.sql','utf8')).replace(/^\s*--[^\n]*/gm,''));
  const reader=await f.login('reader'),path='/api/articles/search?q=补考',preview=path+'&preview=1';
  assert.equal((await subscriptionCall(f.mf,preview)).status,401);
  assert.equal((await subscriptionCall(f.mf,preview,{cookie:reader})).status,503);
  assert.equal((await subscriptionCall(f.mf,path,{cookie:f.admin.cookie})).status,503);
  assert.equal(requests,0);
  assert.equal((await subscriptionCall(f.mf,preview,{cookie:f.admin.cookie})).body.searchKind,'related');
  assert.equal(requests,1);
  const batch=(cookie,origin)=>subscriptionCall(f.mf,'/internal/operations/notice-search',{cookie,origin,method:'POST',body:{action:'process-batch'}});
  assert.equal((await batch(reader,'https://feed.test')).status,403);
  assert.equal((await batch(f.admin.cookie,'https://elsewhere.test')).status,403);
  await f.db.prepare('UPDATE bailian_control SET paused=1 WHERE id=1').run();
  assert.equal((await batch(f.admin.cookie,'https://feed.test')).body.pausedOrBusy,true);
  f.revokeAccess();
  assert.equal((await subscriptionCall(f.mf,preview,{cookie:f.admin.cookie})).status,403);
  assert.equal(requests,1);
});

test('search follows live reading access; backfill has a separate same-origin admin gate',async t=>{
  const f=await subscriptionsFixture({recheckMigration:true,recheckVars:{BAILIAN_SEARCH_READS:'true'}});
  t.after(()=>f.mf.dispose());
  await applyMigration(f.db,(await readFile('migrations/0022_bailian_search.sql','utf8')).replace(/^\s*--[^\n]*/gm,''));
  const cookie=await f.login('reader'),search='/api/articles/search?q=补考',admin='/internal/operations/notice-search';
  assert.equal((await subscriptionCall(f.mf,search)).status,401);
  assert.equal((await subscriptionCall(f.mf,admin,{cookie})).status,403);
  const write=(origin)=>subscriptionCall(f.mf,admin,{cookie:f.admin.cookie,origin,method:'POST',body:{action:'start-backfill'}});
  assert.equal((await write('https://unrelated.test')).status,403);
  const started=await write('https://feed.test');
  assert.equal(started.status,200);assert.equal(started.body.backfill,'running');assert.equal(started.body.writes,false);
  f.revokeAccess();
  const result=await subscriptionCall(f.mf,search,{cookie});
  assert.equal(result.status,403);assert.equal(result.body.articles,undefined);
});
