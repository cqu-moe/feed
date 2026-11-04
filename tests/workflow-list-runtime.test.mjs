import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
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
  for(const name of ['0001_feed.sql','0005_task_runtime.sql','0006_sources.sql','0019_site_execution_leases.sql']){
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

test('a Workflow list retries one origin Retry-After response in the same task attempt',async()=>{
  const {runSiteTask}=await import(`data:text/javascript;base64,${Buffer.from(
    (await build({entryPoints:['worker/site-scheduler.mjs'],bundle:true,write:false,format:'esm',platform:'node'})).outputFiles[0].text
  ).toString('base64')}`);
  const calls=[],sleeps=[];
  const step={async do(name,_config,run){return await run();},async sleep(name,seconds){sleeps.push({name,seconds});}};
  const taskRow={id:'444444444444444444444444',kind:'discover',attempt_no:1};
  const statements=[() => taskRow,() => ({site_id:'site',generation:1}),() => taskRow,() => ({site_id:'site',generation:2})];
  const prepared=sql=>({bind(...args){return {first:async()=>statements.shift()?.(...args),run:async()=>({meta:{changes:0}}),all:async()=>({results:[]})};},
    first:async()=>statements.shift()?.(),run:async()=>({meta:{changes:0}}),all:async()=>({results:[]})});
  const error=new Error('Origin HTTP 429');
  error.httpStatus=429;
  error.retryAfterMs=12*60*1000;
  const result=await runSiteTask({TASK_RETRY_BASE_DELAY_MS:'60000',DB:{prepare:prepared}},step,'444444444444444444444444',1,'discover-page','5 minutes',
    async()=>{
      calls.push(calls.length);
      if(calls.length===1)throw error;
      return {sourceId:'jwc',page:1};
    });
  assert.deepEqual(result,{sourceId:'jwc',page:1});
  assert.equal(calls.length,2);
  assert.deepEqual(sleeps,[{name:'discover-page-wait-0',seconds:720000}]);
});

function testDb(sqlite){
  const statementInfo=new WeakMap();
  const wrap=statement=>({
    bind(...args){
      const bound={get:(...values)=>statement.get(...(values.length?values:args)),
        all:(...values)=>statement.all(...(values.length?values:args)),
        run:()=>statement.run(...args)};
      statementInfo.set(bound,{statement:bound,args});
      return wrap(bound);
    },
    async first(...args){return statement.get(...args);},
    async all(...args){return statement.all(...args);},
    async run(...args){const result=statement.run(...args);return {meta:{changes:result.changes}};},
  });
  return {
    prepare(sql){const statement=sqlite.prepare(sql);statementInfo.set(wrap(statement),{statement,args:[]});return wrap(statement);},
    async batch(statements){
      const results=[];
      for(const statement of statements){
        const info=statementInfo.get(statement);
        const result=info?info.statement.run():statement.run();
        results.push({meta:{changes:result.changes},results:[]});
      }
      return results;
    },
  };
}
