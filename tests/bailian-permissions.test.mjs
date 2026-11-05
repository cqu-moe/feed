import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {subscriptionsFixture,subscriptionCall,applyMigration} from './helpers/subscriptions-fixture.mjs';

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
