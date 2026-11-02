import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {scrape} from '../worker/browser-scrape.mjs';

const job={url:'https://jwc.cqu.edu.cn/info/1080/6203.htm',siteId:'site-7fd03676e5751e9b6dd95ecb',jobId:'11111111-2222-3333-4444-555555555555',
  formats:['rawHtml'],actions:[{type:'executeJavascript',script:'1'}]};
const successBody=JSON.stringify({success:true,data:{metadata:{statusCode:200}}});

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
const completionFor=jobId=>new Request('https://browser.internal/scrape-complete',{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jobId}),
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
  assert.deepEqual(JSON.parse(bindingCalls[1].body),{jobId:sent.jobId});
  assert.equal(instance.proxyEvents.filter(event=>event.request).length,1,'completion must remain control-plane only');
  assert.deepEqual(await (await instance.fetch(completionFor(sent.jobId))).json(),{stopped:false});
  assert.equal(instance.proxyEvents.filter(event=>event.stoppedAt).length,1);
});

test('busy or stale requests cannot stop another accepted response stream',async()=>{
  const {FeedBrowser}=await loadWorker(),instance=new FeedBrowser();
  const response=await instance.fetch(requestFor());
  assert.equal(response.status,200);
  instance.busy=true;
  const secondId='aaaaaaaa-1111-4222-8333-444444444444';
  const busy=await instance.fetch(requestFor({...job,jobId:secondId}));
  assert.equal(busy.status,429);
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
