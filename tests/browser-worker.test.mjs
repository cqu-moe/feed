import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {cloudflareEntrypointPlugin} from './helpers/cloudflare-entrypoint-plugin.ts';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {claimSiteExecution} from '../worker/site-scheduler.mjs';
const adapter=await build({entryPoints:['worker/browser-scrape.mjs'],bundle:true,write:false,format:'esm',platform:'node',plugins:[cloudflareEntrypointPlugin]});
const {scrape}=await import(`data:text/javascript;base64,${Buffer.from(adapter.outputFiles[0].text).toString('base64')}`);

const job={url:'https://jwc.cqu.edu.cn/info/1080/6203.htm',siteId:'site-7fd03676e5751e9b6dd95ecb',jobId:'11111111-2222-3333-4444-555555555555',generation:1,
  formats:['rawHtml'],actions:[{type:'executeJavascript',script:'1'}]};
const successBody=JSON.stringify({success:true,data:{metadata:{statusCode:200}}});

async function schedulerDb(){
  const db=new DatabaseSync(':memory:');
  for(const name of ['0001_feed.sql','0003_collection_lease.sql','0005_task_runtime.sql','0006_sources.sql','0015_history_backfill.sql','0019_site_execution_leases.sql']){
    db.exec(await readFile(`migrations/${name}`,'utf8'));
  }
  return {
    prepare(sql){
      return {
        bind(...args){
          const statement=db.prepare(sql);
          return {
            async first(){return args.length?statement.get(...args):statement.get();},
            async run(){return {meta:{changes:(args.length?statement.run(...args):statement.run()).changes}};},
          };
        },
      };
    },
  };
}

async function loadWorker(){
  const bundle=await build({
    stdin:{
      contents:"export {FeedBrowser} from './crawler/worker.mjs';",
      resolveDir:process.cwd(),
      sourcefile:'browser-worker-fixture.mjs',
    },
    bundle:true,
    write:false,
    format:'esm',
    platform:'neutral',
    plugins:[{
      name:'containers-stub',
      setup(api){
        api.onResolve({filter:/^@cloudflare\/containers$/},()=>({path:'containers',namespace:'stub'}));
        api.onLoad({filter:/.*/,namespace:'stub'},()=>({
          loader:'js',
          contents:`
            export class Container{
              constructor(){this.proxyEvents=[];}
              async fetch(request){
                this.proxyEvents.push({request,body:await request.text()});
                if(this.busy)return Response.json({success:false,error:'busy',code:'capacity_busy'},{status:429});
                if(this.failNextScrape){this.failNextScrape=false;throw new Error('cold start failed');}
                await new Promise(resolve=>setTimeout(resolve,20));
                const bytes=new TextEncoder().encode(JSON.stringify({success:true,data:{metadata:{statusCode:200}}}));
                const stream=new ReadableStream({
                  start(controller){
                    setTimeout(()=>{
                      controller.enqueue(bytes);
                      controller.close();
                    },5);
                  }
                });
                return new Response(stream,{status:200,headers:{'content-type':'application/json'}});
              }
              async stop(){this.proxyEvents.push({stoppedAt:Date.now()});}
              async onStop(){}
              renewActivityTimeout(){this.renewed=true;}
              async onActivityExpired(){await this.stop();}
            }
          `,
        }));
      },
    }],
  });
  return await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
}

const requestFor=(body=job)=>new Request('https://browser.internal/scrape',{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),
});
const completionFor=(jobId,generation=1)=>new Request('https://browser.internal/scrape-complete',{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jobId,generation}),
});

test('capture adapter uses the existing Worker namespace and stops only after receiving the complete result',async()=>{
  const {FeedBrowser}=await loadWorker(),instance=new FeedBrowser();
  const selected=[],bindingCalls=[];
  const binding={getByName(siteId){
    selected.push(siteId);
    return {fetch:async request=>{
      bindingCalls.push({method:request.method,path:new URL(request.url).pathname,body:await request.clone().text()});
      return instance.fetch(request);
    }};
  }};
  const response=await scrape({BROWSER:binding},job.url,{
    source:{id:'jwc',siteId:'7fd03676e5751e9b6dd95ecb',name:'教务处',validationJson:{internal:'not forwarded'}},
    formats:['rawHtml'],actions:job.actions,
  });
  assert.equal(response.metadata.statusCode,200);
  assert.deepEqual(selected,[job.siteId]);
  assert.deepEqual(bindingCalls.map(({method,path})=>({method,path})),[
    {method:'POST',path:'/scrape'},{method:'POST',path:'/scrape-complete'},
  ]);
  const sent=JSON.parse(bindingCalls[0].body);
  assert.match(sent.jobId,/^[0-9a-f-]{36}$/i);
  assert.deepEqual(sent,{url:job.url,siteId:job.siteId,jobId:sent.jobId,formats:['rawHtml'],actions:job.actions});
  assert.deepEqual(JSON.parse(bindingCalls[1].body),{jobId:sent.jobId,stop:true});
  assert.deepEqual(await (await instance.fetch(completionFor(sent.jobId))).json(),{stopped:false});
  assert.equal(instance.proxyEvents.filter(event=>event.stoppedAt).length,1);
});

test('Youth public notices use the official content endpoint without changing other source URLs',async()=>{
  for(const [url,expected] of [
    ['https://youth.cqu.edu.cn/info/1009/25310.htm','https://youth.cqu.edu.cn/content.jsp?urltype=news.NewsContentUrl&wbtreeid=1009&wbnewsid=25310'],
    ['https://youth.cqu.edu.cn/info/1009/25311.htm','https://youth.cqu.edu.cn/content.jsp?urltype=news.NewsContentUrl&wbtreeid=1009&wbnewsid=25311'],
    ['https://youth.cqu.edu.cn/index/xxgs.htm','https://youth.cqu.edu.cn/index/xxgs.htm'],
    ['https://youth.cqu.edu.cn/info/1008/25310.htm','https://youth.cqu.edu.cn/info/1008/25310.htm'],
    [job.url,job.url],
  ]){
    const calls=[];
    await scrape({BROWSER:{getByName(siteId){
      assert.equal(siteId,'site-youth');
      return {async fetch(request){calls.push(await request.json());return new Response(successBody);}};
    }}},url,{source:{siteId:'youth'},actions:job.actions,formats:[]});
    assert.equal(calls.length,1);
    assert.equal(calls[0].url,expected);
    assert.deepEqual(calls[0].actions,job.actions);
  }
});

test('warm handoff admits live discovery and skips unadmitted backfill',async()=>{
  const binding={
    calls:[],
    getByName(){
      return {fetch:async request=>{
        const body=JSON.parse(await request.clone().text());
        const entry={path:new URL(request.url).pathname,body};
        binding.calls.push(entry);
        const path=new URL(request.url).pathname;
        if(path==='/scrape')
          return new Response(JSON.stringify({success:true,data:{metadata:{statusCode:200}}}),{
            headers:{'x-feed-browser-job-id':body.jobId},
          });
        return new Response('{}');
      }};
    },
  };
  const env={
    BROWSER:binding,
    FEED_JOBS:{async send(){}},
    DB:await schedulerDb(),
  };
  const running=taskId=>env.DB.prepare("UPDATE tasks SET state='running' WHERE id=?").bind(taskId).run();
  const siteId='7fd03676e5751e9b6dd95ecb';
  const now=Date.now()-1,snapshot={id:'scheduler',siteId,configVersion:2};
  const insertTask=(id,kind,priority,payload={})=>env.DB.prepare(`INSERT INTO tasks(
      id,kind,business_key,source_id,payload_json,state,priority,due_at,attempt_no,created_at,updated_at
    ) VALUES (?,?,?,'scheduler',?,'queued',?,?,1,?,?)`)
    .bind(id,kind,`handoff-${id}`,JSON.stringify({source:snapshot,...payload}),priority,now,now,now).run();
  const insertOutbox=(id,taskId)=>env.DB.prepare(`INSERT INTO outbox(
      id,topic,dedupe_key,payload_json,state,available_at,created_at,updated_at
    ) VALUES (?,'feed-jobs',?,?,'queued',?,?,?)`)
    .bind(id,`start:${taskId}:a1`,JSON.stringify({v:1,type:'start-job',outboxId:id,taskId,attempt:1}),now,now,now).run();
  await env.DB.prepare(`INSERT INTO sources(id,site_id,name,url,config_version,backfill_state,backfill_run_id)
    VALUES ('scheduler',?,'教务处','https://jwc.cqu.edu.cn/',2,'running','run-1')`).bind(siteId).run();
  await insertTask('333333333333333333333333','discover',0);
  await insertOutbox('111111111111111111111111','333333333333333333333333');
  await insertTask('343434343434343434343434','backfill',1,{runId:'run-1'});
  await insertOutbox('141414141414141414141414','343434343434343434343434');
  await insertTask('444444444444444444444444','capture',2);
  await insertOutbox('222222222222222222222222','444444444444444444444444');
  await insertTask('454545454545454545454545','discover',3,{mode:'validate'});
  await insertOutbox('232323232323232323232323','454545454545454545454545');
  await insertTask('555555555555555555555555','capture',4);
  await insertOutbox('535353535353535353535353','555555555555555555555555');
  await env.DB.prepare(`UPDATE outbox SET state='sent' WHERE id='535353535353535353535353'`).bind().run();
  const owner=await claimSiteExecution(env,{id:'555555555555555555555555',kind:'capture',attempt_no:1});
  assert.deepEqual(owner,{admitted:true,siteId,generation:1,taskId:'555555555555555555555555',attemptNo:1});
  await running(owner.taskId);
  const result=await scrape(env,'https://jwc.cqu.edu.cn/info/1082/1.htm',{
    source:snapshot,siteAdmission:owner,
    formats:[],
  });
  assert.equal(result.metadata.statusCode,200);
  assert.equal((await env.DB.prepare(`SELECT state FROM outbox WHERE id='111111111111111111111111'`).bind().first()).state,'sent');
  assert.equal((await env.DB.prepare(`SELECT state FROM outbox WHERE id='141414141414141414141414'`).bind().first()).state,'queued');
  assert.equal((await env.DB.prepare(`SELECT state FROM outbox WHERE id='222222222222222222222222'`).bind().first()).state,'queued');
  const discovery=await claimSiteExecution(env,{id:'333333333333333333333333',kind:'discover',attempt_no:1});
  assert.equal(discovery.admitted,true);
  await running(discovery.taskId);
  await scrape(env,'https://jwc.cqu.edu.cn/list.htm',{source:snapshot,siteAdmission:discovery,formats:[]});
  assert.equal((await env.DB.prepare(`SELECT state FROM outbox WHERE id='222222222222222222222222'`).bind().first()).state,'sent');
  assert.deepEqual(binding.calls.filter(call=>call.path==='/scrape-complete').map(call=>call.body.stop),[false,false]);
  const capture=await claimSiteExecution(env,{id:'444444444444444444444444',kind:'capture',attempt_no:1});
  assert.equal(capture.admitted,true);
  await running(capture.taskId);
  await scrape(env,'https://jwc.cqu.edu.cn/info/1082/2.htm',{
    source:snapshot,siteAdmission:capture,
    formats:[],
  });
  assert.equal((await env.DB.prepare(`SELECT state FROM outbox WHERE id='232323232323232323232323'`).bind().first()).state,'sent');
  assert.equal(binding.calls.filter(call=>call.path==='/scrape-complete').map(call=>call.body.stop).at(-1),false);
  const validation=await claimSiteExecution(env,{id:'454545454545454545454545',kind:'discover',attempt_no:1});
  assert.equal(validation.admitted,true);
  await running(validation.taskId);
  await scrape(env,'https://jwc.cqu.edu.cn/info/1082/3.htm',{source:snapshot,siteAdmission:validation,formats:[]});
  assert.deepEqual(binding.calls.filter(call=>call.path==='/scrape-complete').slice(-2).map(call=>call.body.stop),[false,true]);
});

test('busy or stale requests cannot stop another accepted response stream',async()=>{
  const {FeedBrowser}=await loadWorker(),instance=new FeedBrowser();
  const response=await instance.fetch(requestFor());
  assert.equal(response.status,200);
  instance.busy=true;
  const secondId='aaaaaaaa-1111-4222-8333-444444444444';
  const busy=await instance.fetch(requestFor({...job,jobId:secondId}));
  assert.equal(busy.status,503);
  assert.deepEqual(await (await instance.fetch(completionFor(secondId))).json(),{stopped:false});
  assert.equal(instance.proxyEvents.some(event=>event.stoppedAt),false);
  assert.deepEqual(JSON.parse(await response.text()),JSON.parse(successBody));
  assert.equal(instance.proxyEvents.some(event=>event.stoppedAt),false);
  assert.deepEqual(await (await instance.fetch(completionFor(job.jobId))).json(),{stopped:true});
  assert.equal(instance.proxyEvents.filter(event=>event.stoppedAt).length,1);
});

test('a cold-start failure does not strand a later accepted job completion',async()=>{
  const {FeedBrowser}=await loadWorker(),instance=new FeedBrowser();
  instance.failNextScrape=true;
  await assert.rejects(instance.fetch(requestFor()),/cold start failed/);
  const response=await instance.fetch(requestFor());
  await response.arrayBuffer();
  assert.deepEqual(await (await instance.fetch(completionFor(job.jobId))).json(),{stopped:true});
  assert.equal(instance.proxyEvents.filter(event=>event.stoppedAt).length,1);
});

test('the private container boundary rejects unsupported routes, targets and identities before starting',async()=>{
  const {FeedBrowser}=await loadWorker(),instance=new FeedBrowser();
  for(const [path,method,status] of [['/scrape','GET',405],['/scrape','PUT',405],['/scrape-complete','GET',405],['/anything','POST',404]]){
    assert.equal((await instance.fetch(new Request('https://browser.internal'+path,{method}))).status,status);
  }
  for(const url of ['https://example.com/info/1.htm','http://jwc.cqu.edu.cn/info/1.htm','https://jwc.cqu.edu.cn:8443/info/1.htm']){
    assert.equal((await instance.fetch(requestFor({...job,url}))).status,400);
  }
  assert.equal((await instance.fetch(requestFor({...job,siteId:'jwc.cqu.edu.cn'}))).status,400);
  assert.equal(instance.proxyEvents.length,0);
});

test('container transport distinguishes capacity from executed source failures and keeps Retry-After',async()=>{
  for(const [response,expected] of [
    [()=>new Response('There is no Container instance available at this time.',{status:503,headers:{'retry-after':'60'}}),{code:'container_capacity',retryable:true,httpStatus:503,retryAfterMs:60000}],
    [()=>new Response('Container start rate limited',{status:429}),{code:'container_capacity',retryable:true,httpStatus:429}],
    [()=>new Response('Failed to start container: timeout',{status:500}),{code:'browser_transient',retryable:true,httpStatus:500}],
    [()=>Response.json({success:false,error:'Origin did not become ready (HTTP 503)',code:'origin_unavailable',httpStatus:503,retryable:true}),{code:'origin_unavailable',retryable:true,httpStatus:503}],
    [()=>Response.json({success:false,error:'Origin HTTP 404',code:'origin_http',httpStatus:404,retryable:false}),{code:'origin_http',retryable:false,httpStatus:404}],
    [()=>Response.json({success:false,error:'Origin HTTP 429',code:'origin_http',httpStatus:429,retryable:true,retryAfter:'120'}),{code:'origin_http',retryable:true,httpStatus:429,retryAfterMs:120000}],
    [()=>new Response('{"success":'),{code:'browser_transient',retryable:true}],
  ]){
    const env={BROWSER:{getByName:()=>({fetch:async()=>response()})}};
    await assert.rejects(scrape(env,job.url,{source:{siteId:'test'},formats:[],actions:job.actions}),error=>{
      for(const [key,value] of Object.entries(expected))assert.equal(error[key],value,error.message);
      return true;
    });
  }
});

test('a cold start is busy and a new request waits for stop acknowledgement',async()=>{
  const {FeedBrowser}=await loadWorker(),instance=new FeedBrowser();
  const pending=instance.fetch(requestFor());
  await new Promise(resolve=>setTimeout(resolve,5));
  // A previous container's delayed exit callback can arrive during this start.
  await instance.onStop({exitCode:0,reason:'exit'});
  await instance.onActivityExpired();
  assert.equal(instance.proxyEvents.some(event=>event.stoppedAt),false);
  const response=await pending;await response.text();
  await instance.fetch(completionFor(job.jobId));
  const next={...job,jobId:'bbbbbbbb-1111-4222-8333-444444444444',generation:2};
  assert.equal((await instance.fetch(requestFor(next))).status,503);
  await instance.onStop({exitCode:0,reason:'stopped'});
  const resumed=await instance.fetch(requestFor(next));assert.equal(resumed.status,200);await resumed.text();
  assert.deepEqual(await(await instance.fetch(completionFor(job.jobId))).json(),{stopped:false});
  assert.deepEqual(await(await instance.fetch(completionFor(next.jobId,2))).json(),{stopped:true});
});
