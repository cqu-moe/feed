import {test} from 'node:test';
import assert from 'node:assert/strict';
import {searchFixture,seedSources,notice} from './helpers/bailian-fixture.mjs';

test('bounded historical backfill resumes from its cursor; a stale import never restores withdrawn text',async t=>{
  const old='a'.repeat(24),next='b'.repeat(24);
  const f=await searchFixture(t,`
    import {runBailianSync,lookupSearchDocuments,startBailianBackfill,pauseBailianBackfill,
      getBailianStatus,pauseBailianSync,resumeBailianSync} from './worker/bailian-sync.mjs';
    const docs=new Map(),deleted=[];let id=0,now=Date.now(),done=false;
    const client={registerFile:async({text})=>{const k=String(++id);docs.set(k,text);return k},startImport:async ids=>ids[0],
      checkImport:async k=>({state:done?'done':'pending',files:[{fileId:k,state:done?'done':'pending'}]}),
      removeDocument:async k=>deleted.push('index:'+k),removeFile:async k=>{deleted.push('file:'+k);docs.delete(k)}};
    export default {async fetch(req,env){
      switch(new URL(req.url).pathname){
        case '/tick':await runBailianSync(env,{now:now+=300001,client,backfillBatchSize:1});break;
        case '/start':await startBailianBackfill(env);break;case '/stop':await pauseBailianBackfill(env);break;
        case '/pause':await pauseBailianSync(env);break;case '/resume':await resumeBailianSync(env);break;
        case '/done':done=true;break;
      }
      return Response.json({status:await getBailianStatus(env),remote:[...docs],deleted,visible:await lookupSearchDocuments(env,[...docs.keys()])});
    }};`,{beforeMigration:async db=>{await seedSources(db);await notice(db,old,'补考','报名金额 100 元','2025-01-01');await notice(db,next,'考试','期末考试安排','2025-01-03');}});
  const run=async path=>(await f.fetch('/'+path)).json();
  assert.equal((await run('tick')).remote.length,0);
  await run('start');let state=await run('tick');
  assert.equal(state.status.cursor,old);assert.equal(state.remote.length,1);
  await run('stop');await run('tick');state=await run('tick');
  assert.equal(state.status.cursor,old);assert.deepEqual(state.visible,[]);
  await run('pause');await run('done');
  assert.deepEqual((await run('tick')).visible,[]);
  // A correction arrives while the old import is still in flight.
  await f.db.prepare("UPDATE articles SET body_text='报名金额 300 元' WHERE id=?").bind(old).run();
  await run('resume');await run('start');
  for(let i=0;i<8;i++){
    state=await run('tick');
    assert.ok(!state.visible.some(v=>v.fileId==='1'),'late acknowledgment of the old file never becomes readable');
  }
  assert.equal(state.status.backfill,'done');assert.equal(state.status.notices.ready,2);
  assert.deepEqual(state.deleted,['index:1','file:1']);assert.equal(state.remote.length,2);
  assert.ok(state.remote.some(([,text])=>text.includes('300 元')));
});
