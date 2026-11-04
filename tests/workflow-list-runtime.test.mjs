import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';

const bundle=await build({entryPoints:['worker/task-runtime.mjs'],bundle:true,write:false,format:'esm',platform:'node',
  plugins:[{name:'workflow-list-runtime-platform',setup(api){
    api.onResolve({filter:/^cloudflare:workers$/},()=>({path:'platform',namespace:'workflow-list-runtime-platform'}));
    api.onLoad({filter:/./,namespace:'workflow-list-runtime-platform'},()=>({
      contents:'export class WorkflowEntrypoint{constructor(env={}){this.env=env;}}',
      loader:'js',
    }));
  }}]});
const {createTaskRuntime}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

test('a live list launch hands its exact attempt to Workflow without claiming the site',async()=>{
  const db=new DatabaseSync(':memory:');
  for(const name of ['0001_feed.sql','0005_task_runtime.sql','0006_sources.sql','0018_outbox_receipts.sql','0019_site_execution_leases.sql']){
    db.exec(await readFile(`migrations/${name}`,'utf8'));
  }
  const now=Date.now(),taskId='111111111111111111111111',outboxId='222222222222222222222222';
  db.prepare(`INSERT INTO sources(id,site_id,name,url,list_url,config_json,config_version,enabled,refresh_interval_sec,next_discovery_at,source_timezone,created_at,updated_at)
    VALUES('jwc','7fd03676e5751e9b6dd95ecb','教务处','https://jwc.cqu.edu.cn/','https://jwc.cqu.edu.cn/index/tzgg.htm','{}',1,1,1800,0,'Asia/Shanghai',?,?)`).all(now,now);
  db.prepare(`INSERT INTO tasks(id,kind,business_key,source_id,payload_json,state,due_at,created_at,updated_at)
    VALUES (?,'discover',?, 'jwc',?,'queued',?,?,?)`).all(taskId,'live-list',JSON.stringify({
    source:{id:'jwc',siteId:'7fd03676e5751e9b6dd95ecb',configVersion:1},page:1,
  }),now,now,now);
  db.prepare(`INSERT INTO outbox(id,topic,dedupe_key,payload_json,state,available_at,created_at,updated_at)
    VALUES (?,'feed-jobs',?,?,'queued',?,?,?)`).all(outboxId,`start:${taskId}:a1`,JSON.stringify({
    v:1,type:'start-job',outboxId,taskId,attempt:1,
  }),now,now,now);

  const calls=[];
  const status={status:'running',error:null};
  const workflow={async create({id,params}){
    calls.push({op:'create',id,params});
    return {status:async()=>status};
  },async get(id){
    calls.push({op:'get',id});
    return {status:async()=>status};
  }};
  const runtime=createTaskRuntime({DB:testDb(db),COLLECTION_EXECUTOR:'workflow'},{
    now:()=>now,workflows:{discover:workflow},
  });
  const result=await runtime.startJob({v:1,type:'start-job',outboxId,taskId,attempt:1});

  assert.equal(result.workflowInstanceId,`task-${taskId}-a1`);
  assert.deepEqual(calls,[{op:'create',id:`task-${taskId}-a1`,params:{taskId,attempt:1}}]);
  const attempt=db.prepare('SELECT workflow_instance_id,state,handed_off_at FROM task_attempts').get();
  assert.equal(attempt.workflow_instance_id,`task-${taskId}-a1`);
  assert.equal(attempt.state,'running');
  assert.equal(typeof attempt.handed_off_at,'number');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM site_execution_leases WHERE owner_task_id IS NOT NULL').get().n,0);

  await runtime.startJob({v:1,type:'start-job',outboxId,taskId,attempt:1});
  assert.deepEqual(calls.map(call=>call.op),['create','get']);
});

// Execute native Workflow steps, D1 and R2. Only the browser/service boundary
// and elapsed sleep time are synthetic; every production query is executed.
const runtimeBundle=await build({stdin:{resolveDir:process.cwd(),contents:`
  import {DiscoveryWorkflow} from './worker/discovery-workflow.mjs';
  import {createTaskRuntime} from './worker/task-runtime.mjs';
  export class LocalDiscoveryWorkflow extends DiscoveryWorkflow {
    async run(event,step){
      const raw=this.env,db=raw.DB;
      let failures=raw.COMMIT_FAULT==='before-repeated'?3:raw.COMMIT_FAULT?1:0;
      this.env={...raw,DB:{prepare:sql=>db.prepare(sql),batch:async statements=>{
        // Start the database outage once the paid list is durable, regardless
        // of the number, SQL text or order of earlier database operations.
        const inject=failures>0&&await raw.ARCHIVE.head('discovery/'+event.payload.taskId+'/list.json');
        if(inject)failures--;
        if(inject&&raw.COMMIT_FAULT!=='after')throw new Error('D1 unavailable before commit');
        const result=await db.batch(statements);
        if(inject)throw new Error('D1 commit response lost');
        return result;
      }},BROWSER:{getByName:()=>({fetch:request=>raw.BROWSER_SERVICE.fetch(request)})}};
      return super.run(event,{do:(...args)=>step.do(...args),sleep:async(name,ms)=>{
        await raw.OBSERVER.fetch('https://observer.test/sleep',{method:'POST',body:JSON.stringify({name,ms,taskId:event.payload.taskId})});
        return step.sleep(name,1);
      }});
    }
  }
  export default {async fetch(request,env){
    const url=new URL(request.url),id=url.searchParams.get('id');
    const {attempt_no:attempt}=await env.DB.prepare('SELECT attempt_no FROM tasks WHERE id=?').bind(id).first();
    if(url.pathname==='/start'){
      const outbox=await env.DB.prepare('SELECT id FROM outbox WHERE dedupe_key=?').bind('start:'+id+':a'+attempt).first();
      return Response.json(await createTaskRuntime(env).startJob({v:1,type:'start-job',taskId:id,attempt,outboxId:outbox.id}));
    }
    const instance=await env.DISCOVERY.get('task-'+id+'-a'+attempt);
    return Response.json(await instance.status());
  }};
`},bundle:true,write:false,format:'esm',platform:'neutral',external:['cloudflare:workers','node:*']});

const taskId='444444444444444444444444',siteId='7fd03676e5751e9b6dd95ecb';
async function liveFixture(t,{limit=3,fault='',responses=[]}={}){
  const calls=[],sleeps=[],completions=[],hooks={},errors=[];
  let db;
  const mf=new Miniflare(convertV4MiniflareOptions({
    modules:[{type:'ESModule',path:'workflow-list-fixture.mjs',contents:runtimeBundle.outputFiles[0].text}],
    compatibilityDate:'2026-10-11',compatibilityFlags:['nodejs_compat'],
    bindings:{COLLECTION_EXECUTOR:'workflow',MAX_TASK_ATTEMPTS:String(limit),TASK_RETRY_BASE_DELAY_MS:'60000',COMMIT_FAULT:fault},
    d1Databases:{DB:'workflow-list-db'},r2Buckets:{ARCHIVE:'workflow-list-archive'},
    workflows:{DISCOVERY:{name:'local-list',className:'LocalDiscoveryWorkflow'}},
    serviceBindings:{
      BROWSER_SERVICE:async request=>{
        const input=await request.json();
        if(new URL(request.url).pathname==='/scrape-complete'){
          completions.push(input);await hooks.onCompletion?.(input);return Response.json({stopped:input.stop});
        }
        calls.push(input);await hooks.onScrape?.(input);
        const response=responses[Math.min(calls.length-1,responses.length-1)];
        if(response==='oci')return new Response('OCI runtime error: container exited',{status:500});
        if(response==='capacity')return new Response('No container available',{status:503,headers:{'retry-after':'90'}});
        const headers={'x-feed-browser-job-id':input.jobId};
        if(response==='rate')return Response.json({success:false,error:'Origin HTTP 429',httpStatus:429,retryable:true,retryAfter:'120'}, {headers});
        if(response==='network')return Response.json({success:false,error:'Origin connection closed',code:'browser_transient',retryable:true},{headers});
        if(response==='quota')return Response.json({success:false,error:'Daily browser quota exhausted',code:'quota_exhausted'},{headers});
        if(response==='permanent')return Response.json({success:false,error:'Origin HTTP 404',code:'origin_http',httpStatus:404},{headers});
        return Response.json({success:true,data:{metadata:{statusCode:200},actions:{javascriptReturns:[{value:JSON.stringify({
          articles:[{url:'https://jwc.cqu.edu.cn/info/1/2.htm',title:'Runtime notice',publishedAt:null}],next:[],
        })}]}}},{headers});
      },
      OBSERVER:async request=>{
        try{
          const sleep=await request.json();
          const lease=await db.prepare('SELECT owner_task_id FROM site_execution_leases WHERE site_id=?').bind(siteId).first();
          assert.notEqual(lease?.owner_task_id,sleep.taskId,'sleep must release its own site lease');
          const receipt=await db.prepare('SELECT a.result_json FROM task_attempts a JOIN tasks t ON t.id=a.task_id AND t.attempt_no=a.attempt_no WHERE t.id=?').bind(sleep.taskId).first();
          assert.equal(receipt.result_json,null,'transient results must not become terminal receipts');
          sleeps.push(sleep);await hooks.onSleep?.(sleep);return new Response('ok');
        }catch(error){errors.push(error);return new Response('Observation failed',{status:500});}
      },
    },
    outboundService:()=>new Response('Unexpected network access',{status:502}),
  }));
  t.after(()=>mf.dispose());
  db=await mf.getD1Database('DB');
  for(const name of (await readdir('migrations')).filter(name=>name.endsWith('.sql')).sort()){
    // D1 exec requires one statement per line.
    await db.exec((await readFile('migrations/'+name,'utf8')).replace(/--[^\n]*/g,'').replace(/\n/g,' '));
  }
  const now=Date.now();
  const source={id:'runtime69',siteId,configVersion:1,url:'https://jwc.cqu.edu.cn/',listUrl:'https://jwc.cqu.edu.cn/index/tzgg.htm',
    articlePattern:'^/info/',config:{articlePattern:'^/info/'},timezone:'Asia/Shanghai',refreshIntervalSec:1800};
  await db.prepare(`INSERT INTO sources(id,site_id,name,url,list_url,config_json,config_version,enabled,refresh_interval_sec,next_discovery_at,source_timezone,created_at,updated_at)
    VALUES('runtime69',?,'Runtime source',?,?,?,1,1,1800,0,'Asia/Shanghai',?,?)`).bind(siteId,source.url,source.listUrl,JSON.stringify(source.config),now,now).run();
  await db.prepare(`INSERT INTO tasks(id,kind,business_key,source_id,payload_json,state,due_at,created_at,updated_at)
    VALUES (?,'discover','runtime-list','runtime69',?,'queued',?,?,?)`).bind(taskId,JSON.stringify({source,page:1}),now,now,now).run();
  await db.prepare(`INSERT INTO outbox(id,topic,dedupe_key,payload_json,state,available_at,created_at,updated_at)
    VALUES ('222222222222222222222222','feed-jobs',?,?,'queued',?,?,?)`).bind(`start:${taskId}:a1`,JSON.stringify({v:1,type:'start-job',taskId,attempt:1,outboxId:'222222222222222222222222'}),now,now,now).run();
  return {mf,db,calls,sleeps,completions,hooks,async start(id=taskId){
    await db.prepare("UPDATE outbox SET state='sent' WHERE dedupe_key='start:'||?||':a'||(SELECT attempt_no FROM tasks WHERE id=?)").bind(id,id).run();
    const start=await mf.dispatchFetch('https://fixture.test/start?id='+id);
    assert.equal(start.status,200,await start.clone().text());
  },async run(id=taskId){await this.start(id);return this.wait(id);},async wait(id=taskId){
    const deadline=Date.now()+15000;
    while(Date.now()<deadline){
      const status=await (await mf.dispatchFetch('https://fixture.test/status?id='+id)).json();
      if(status.status==='complete'){if(errors.length)throw errors[0];return status.output;}
      if(status.status==='errored')assert.fail(JSON.stringify(status));
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.fail('Local Workflow did not complete');
  }};
}

test('a saved list resumes in the same native Workflow after an uncommitted D1 failure',async t=>{
  const f=await liveFixture(t,{fault:'before'});
  const result=await f.run();
  assert.equal(result.candidates,1);
  assert.equal(f.calls.length,1,'saved list must avoid another source access');
  assert.deepEqual(f.sleeps.map(s=>s.ms),[60000]);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE kind='capture'").first()).n,1);
  assert.equal((await f.db.prepare('SELECT state,attempt_no FROM tasks WHERE id=?').bind(taskId).first()).state,'succeeded');
});

test('saved-list persistence retries are bounded without recapturing the origin',async t=>{
  const f=await liveFixture(t,{fault:'before-repeated'});
  const result=await f.run();
  assert.equal(result.originAttemptsExhausted,true);
  assert.equal(f.calls.length,1);
  assert.deepEqual(f.sleeps.map(s=>s.ms),[60000,120000]);
  assert.equal((await f.db.prepare('SELECT state FROM tasks WHERE id=?').bind(taskId).first()).state,'blocked');
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE kind='capture'").first()).n,0);
});

test('a lost list commit response reuses its receipt without duplicate capture work',async t=>{
  const f=await liveFixture(t,{fault:'after'});
  assert.equal((await f.run()).candidates,1);
  assert.equal(f.calls.length,1);
  assert.equal(f.sleeps.length,0);
  // Replay the original Queue launch through the native runtime boundary.
  await f.run();
  assert.equal(f.calls.length,1);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE kind='capture'").first()).n,1);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM task_attempts').first()).n,1);
});

test('native list retries preserve the source budget, Retry-After and terminal receipt',async t=>{
  for(const scenario of [
    {name:'first source access counts at a limit of one',limit:1,responses:['rate'],calls:1,sleeps:[],state:'blocked',code:'rate_limited'},
    {name:'source failures exhaust exactly three accesses',responses:['network'],calls:3,sleeps:[60000,120000],state:'blocked',code:'browser_transient'},
    {name:'source Retry-After takes precedence over exponential delay',responses:['rate','ok'],calls:2,sleeps:[120000],state:'succeeded'},
    {name:'OCI transport failure retries in the same instance',responses:['oci','ok'],calls:2,sleeps:[60000],state:'succeeded'},
    {name:'platform capacity never spends the source attempt budget',limit:1,responses:['capacity','capacity','ok'],calls:3,sleeps:[90000,90000],state:'succeeded'},
    {name:'business quota exhaustion is terminal',responses:['quota'],calls:1,sleeps:[],state:'blocked',code:'quota_exhausted'},
    {name:'permanent origin errors do not retry',responses:['permanent'],calls:1,sleeps:[],state:'failed'},
  ])await t.test(scenario.name,async t=>{
    const f=await liveFixture(t,scenario);
    if(['rate','network','oci'].includes(scenario.responses[0]))f.hooks.onSleep=async()=>{
      const task=await f.db.prepare('SELECT due_at FROM tasks WHERE id=?').bind(taskId).first();
      assert.ok(task.due_at>Date.now(),'a source retry waiting until later must not appear ready for warm handoff');
    };
    await f.run();
    assert.equal(f.calls.length,scenario.calls);
    assert.deepEqual(f.sleeps.map(s=>s.ms),scenario.sleeps);
    const task=await f.db.prepare('SELECT state,attempt_no FROM tasks WHERE id=?').bind(taskId).first();
    assert.deepEqual(task,{state:scenario.state,attempt_no:1});
    const attempt=await f.db.prepare('SELECT state,error_code,result_json FROM task_attempts WHERE task_id=?').bind(taskId).first();
    assert.equal(attempt.state,scenario.state);
    if(scenario.code)assert.equal(attempt.error_code,scenario.code);
    assert.equal(Boolean(JSON.parse(attempt.result_json).originAttemptsExhausted),['rate_limited','browser_transient'].includes(scenario.code));
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM task_attempts').first()).n,1);
    assert.ok(f.completions.every(c=>c.stop===true),'a waiting or finished task without a successor requests container stop');
  });
});

test('Workflow cutover preserves consumed source tries and explicit backfill budget resets',async t=>{
  const failure={error:'Origin connection closed',code:'browser_transient',retryable:true,deferred:true};
  for(const scenario of [
    {name:'two legacy source failures leave only one access',kind:'discover',prior:[failure,failure],calls:1},
    {name:'capacity, pause, lease wait and archive-only retries spend no source tries',kind:'backfill',prior:[
      {error:'No Container available',code:'container_capacity',capacity:true,deferred:true},
      {skipped:true},{error:'Backfill paused',paused:true,deferred:true},
      {error:'Commit unavailable',resumeSaved:true,savedPage:true,deferred:true},failure,
    ],calls:2},
    {name:'manual backfill resume starts the explicitly reset budget',kind:'backfill',retryFrom:4,prior:[failure,failure,failure],calls:3},
  ])await t.test(scenario.name,async t=>{
    const f=await liveFixture(t,{responses:['network']});
    const attempt=scenario.prior.length+1;
    for(const [index,result] of scenario.prior.entries())await f.db.prepare(`INSERT INTO task_attempts(task_id,attempt_no,workflow_instance_id,state,started_at,handed_off_at,ended_at,result_json)
      VALUES (?,?,?,'deferred',1,1,2,?)`).bind(taskId,index+1,`queue-${taskId}-a${index+1}`,JSON.stringify(result)).run();
    await f.db.prepare('UPDATE tasks SET attempt_no=?,kind=?,backfill_retry_from=? WHERE id=?')
      .bind(attempt,scenario.kind,scenario.retryFrom??1,taskId).run();
    if(scenario.kind==='backfill'){
      await f.db.prepare("UPDATE sources SET validation_state='verified',backfill_state='running',backfill_run_id='legacy-run',backfill_max_pages=10 WHERE id='runtime69'").run();
      await f.db.prepare(`UPDATE tasks SET payload_json=json_set(payload_json,'$.mode','backfill','$.runId','legacy-run',
        '$.windowStart','2025-11-04','$.windowEnd','2026-11-04') WHERE id=?`).bind(taskId).run();
    }
    await f.db.prepare(`UPDATE outbox SET dedupe_key=?,payload_json=? WHERE topic='feed-jobs'`).bind(`start:${taskId}:a${attempt}`,JSON.stringify({v:1,type:'start-job',taskId,attempt,outboxId:'222222222222222222222222'})).run();
    const result=await f.run();
    assert.equal(f.calls.length,scenario.calls,scenario.name);
    assert.equal(result.originAttemptsExhausted,true);
    assert.equal(f.sleeps.length,scenario.calls-1);
    assert.equal((await f.db.prepare('SELECT state FROM tasks WHERE id=?').bind(taskId).first()).state,'blocked');
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM task_attempts WHERE task_id=?').bind(taskId).first()).n,attempt);
  });
});

test('a ready same-site Workflow inherits the warm container and the last one requests stop',async t=>{
  const f=await liveFixture(t);
  const nextId='555555555555555555555555',outboxId='666666666666666666666666';
  await f.db.prepare(`INSERT INTO tasks(id,kind,business_key,source_id,payload_json,state,due_at,created_at,updated_at)
    SELECT ?,'discover','same-site-successor',source_id,payload_json,'queued',due_at,created_at,updated_at FROM tasks WHERE id=?`)
    .bind(nextId,taskId).run();
  await f.db.prepare(`INSERT INTO outbox(id,topic,dedupe_key,payload_json,state,available_at,created_at,updated_at)
    VALUES (?,'feed-jobs',?,?,'queued',0,0,0)`).bind(outboxId,`start:${nextId}:a1`,JSON.stringify({v:1,type:'start-job',taskId:nextId,attempt:1,outboxId})).run();
  let waiting,complete;
  const waitingForSite=new Promise(resolve=>{waiting=resolve;});
  const firstCompleted=new Promise(resolve=>{complete=resolve;});
  f.hooks.onScrape=async()=>{
    if(f.calls.length===1){await f.start(nextId);await waitingForSite;}
  };
  f.hooks.onSleep=async sleep=>{
    if(sleep.taskId===nextId){waiting();await firstCompleted;}
  };
  f.hooks.onCompletion=()=>complete();
  await f.run();
  await f.wait(nextId);
  assert.equal(f.calls.length,2);
  assert.deepEqual(f.completions.map(c=>c.stop),[false,true]);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE kind='capture'").first()).n,1);
  assert.equal((await f.db.prepare('SELECT owner_task_id FROM site_execution_leases WHERE site_id=?').bind(siteId).first()).owner_task_id,null);
});

function testDb(sqlite){
  const wrap=(sql,args=[])=>({
    bind(...values){return wrap(sql,values);},
    async first(){return sqlite.prepare(sql).get(...args)??null;},
    async all(){return {results:sqlite.prepare(sql).all(...args)};},
    async run(){const statement=sqlite.prepare(sql);return statement.columns().length
      ?{results:statement.all(...args),meta:{changes:sqlite.prepare('SELECT changes() AS n').get().n}}
      :{results:[],meta:{changes:statement.run(...args).changes}};},
  });
  return {prepare:wrap,async batch(statements){
    sqlite.exec('BEGIN');
    try{const result=[];for(const statement of statements)result.push(await statement.run());sqlite.exec('COMMIT');return result;}
    catch(error){sqlite.exec('ROLLBACK');throw error;}
  }};
}
