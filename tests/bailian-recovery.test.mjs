import {test} from 'node:test';
import assert from 'node:assert/strict';
import {searchFixture,seedSources,notice} from './helpers/bailian-fixture.mjs';

// Exercise the production adapter and sync state machine; only Bailian HTTP
// is replaced. Neither local file receipts nor import states are seeded.
async function recoveryFixture(t){
  const remote={failure:null,acceptRegistration:false,calls:[],files:new Map(),leases:new Map()};
  let serial=0;
  const success=data=>Response.json({code:'Success',status_code:200,status:'SUCCESS',success:true,data});
  const f=await searchFixture(t,`
    import {runBailianSync,getBailianStatus,retryBailianFailures} from './worker/bailian-sync.mjs';
    let now=Date.now();
    export default {async fetch(req,env){
      const url=new URL(req.url);
      if(url.pathname==='/tick')await runBailianSync(env,{now:now+=Number(url.searchParams.get('advance')??86400001)});
      if(url.pathname==='/retry')await retryBailianFailures(env);
      return Response.json(await getBailianStatus(env));
    }};`,{outbound:async req=>{
    const url=new URL(req.url),body=req.method==='POST'?await req.json():{};
    const action=req.method==='PUT'?'upload':url.pathname.split('/').at(-1);
    remote.calls.push(action);
    if(remote.failure===action&&!(action==='addFile'&&remote.acceptRegistration))
      return new Response(null,{status:503});
    if(action==='applyFileUploadLease'){
      if(remote.failure==='throttle')return new Response(null,{status:429});
      const id='file-'+(++serial);
      remote.leases.set(id,{fileId:id,fileName:body.fileName,sizeBytes:Number(body.sizeBytes),category:body.category});
      return success({type:'OSS.PreSignedUrl',leaseId:id,param:{method:'PUT',headers:{},url:'https://local.oss-cn-beijing.aliyuncs.com/'+id}});
    }
    if(action==='upload'){
      remote.leases.get(url.pathname.slice(1)).text=await req.text();
      return new Response(null,{status:200});
    }
    if(action==='addFile'){
      remote.files.set(body.leaseId,remote.leases.get(body.leaseId));
      if(remote.failure==='addFile')return new Response(null,{status:503});
      return success({fileId:body.leaseId});
    }
    if(action==='listFile')return success({fileList:[...remote.files.values()].filter(file=>file.fileName.replace(/\.[^.]+$/,'')===body.fileName)});
    if(action==='describeFile')return success(remote.files.get(body.fileId));
    if(action==='create')return success({ingestionId:body.docIds[0]});
    if(action==='status')return success({ingestion_status:'COMPLETED',total_count:1,rows:[{doc_id:url.searchParams.get('job_id'),status:'FINISH'}]});
    if(action==='delete_file')return success({deleted:body.doc_ids});
    if(action==='deleteFile'){
      remote.files.delete(body.fileId);
      return Response.json({code:'Success',status_code:200,data:{}});
    }
    throw new Error('Unexpected provider request '+action);
  }});
  const id='a'.repeat(24);
  await seedSources(f.db);await notice(f.db,id,'补考','报名费 100 元','2025-01-01');
  const run=async path=>{
    const response=await f.fetch(path);
    assert.equal(response.status,200,await response.clone().text());
    return response.json();
  };
  return {...f,id,remote,run,tick:()=>run('/tick'),count:action=>remote.calls.filter(call=>call===action).length};
}

test('obsolete document deletion stops at its retry limit and resumes only after administrator retry',async t=>{
  const f=await recoveryFixture(t);
  for(let i=0;i<3;i++)await f.tick();
  f.remote.failure='delete_file';
  await f.db.prepare("UPDATE articles SET body_text='报名费 200 元' WHERE id=?").bind(f.id).run();
  let status;
  for(let i=0;i<12;i++)status=await f.tick();
  assert.equal(f.count('delete_file'),6,'six failed attempts exhaust the deletion budget');
  assert.equal(status.blockedCleanup,1);
  assert.equal(status.notices.ready,1,'the new content is searchable while obsolete cleanup is blocked');
  f.remote.failure=null;
  await f.tick();
  assert.equal(f.count('delete_file'),6,'provider recovery alone does not bypass the blocked state');
  await f.run('/retry');
  await f.tick();status=await f.tick();
  assert.equal(status.cleanup,0);
  assert.equal(f.remote.files.size,1);
  assert.match([...f.remote.files.values()][0].text,/200 元/);
});

for(const stage of ['applyFileUploadLease','upload'])test('a temporary '+stage+' failure backs off and recovers without manual reconciliation',async t=>{
  const f=await recoveryFixture(t);
  f.remote.failure=stage;
  await f.tick();
  assert.equal(f.count('addFile'),0,'registration was not submitted');
  const calls=f.remote.calls.length;
  await f.run('/tick?advance=0');
  assert.equal(f.remote.calls.length,calls,'do not retry before the persisted backoff expires');
  f.remote.failure=null;
  let status;
  for(let i=0;i<3;i++)status=await f.tick();
  assert.equal(status.notices.ready,1);
  assert.equal(f.count('addFile'),1);
  assert.equal(f.remote.files.size,1);
});

test('repeated throttling while registering retains the failure budget across safe retries',async t=>{
  const f=await recoveryFixture(t);f.remote.failure='throttle';
  let status;
  for(let i=0;i<12;i++)status=await f.tick();
  assert.equal(f.count('applyFileUploadLease'),6);
  assert.equal(f.count('addFile'),0);
  assert.equal(status.notices.failed,1);
});

for(const accepted of [false,true])test('an uncertain addFile response '+(accepted?'recovers the saved receipt':'remains blocked')+' without registering twice',async t=>{
  const f=await recoveryFixture(t);
  f.remote.failure='addFile';f.remote.acceptRegistration=accepted;
  await f.tick();f.remote.failure=null;
  let status;
  for(let i=0;i<3;i++)status=await f.tick();
  assert.equal(f.count('addFile'),1);
  if(accepted){
    assert.equal(status.notices.ready,1);
    assert.equal(f.remote.files.size,1);
  }else{
    assert.equal(status.notices.failed,1);
    assert.equal(status.needsAttention[0].error,'unconfirmed_receipt');
    await f.run('/retry');await f.tick();
    assert.equal(f.count('addFile'),1,'administrator retry cannot recharge an uncertain registration');
  }
});
