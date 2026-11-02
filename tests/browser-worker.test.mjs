import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {scrape} from '../worker/browser-scrape.mjs';

const job={url:'https://jwc.cqu.edu.cn/info/1080/6203.htm',siteId:'site-7fd03676e5751e9b6dd95ecb',jobId:'11111111-2222-3333-4444-555555555555',
  formats:['rawHtml'],actions:[{type:'executeJavascript',script:'1'}]};

async function loadWorker(){
  const bundle=await build({
    stdin:{
      contents:"import worker,{FeedBrowser} from './crawler/worker.mjs';export {worker,FeedBrowser};",
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
                if(new URL(request.url).pathname==='/scrape-complete')return Response.json({ok:true});
                await new Promise(resolve=>setTimeout(resolve,20));
                const bytes=new TextEncoder().encode('{\"success\":true}');
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

test('browser service routes one CQU scrape by explicit site identity and stops after its response',async()=>{
  const {worker,FeedBrowser}=await loadWorker();
  const instance=new FeedBrowser();
  const namespace={getByName(siteId){instance.proxyEvents.push({selected:siteId});return instance;}};
  const streamStarted=Date.now();
  const response=await worker.fetch(new Request('https://browser.internal/scrape',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(job),
  }),{BROWSER:namespace});
  assert.equal(response.status,200);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[...new TextEncoder().encode('{"success":true}')]);
  assert.deepEqual(instance.proxyEvents.map(event=>event.selected).filter(Boolean),[job.siteId]);
  const scrapeEvent=instance.proxyEvents.find(event=>event.request);
  assert.equal(scrapeEvent.request.method,'POST');
  assert.deepEqual(JSON.parse(scrapeEvent.body),job);
  const completion=await worker.fetch(new Request('https://browser.internal/scrape-complete',{
    method:'POST',headers:{'content-type':'application/json','x-feed-browser-site-id':job.siteId},
    body:JSON.stringify({jobId:job.jobId}),
  }),{BROWSER:{getByName:()=>instance}});
  assert.deepEqual(await completion.json(),{stopped:true});
  const stoppedAt=instance.proxyEvents.find(event=>event.stoppedAt)?.stoppedAt;
  assert.ok(stoppedAt);
  assert.ok(stoppedAt>=streamStarted+20);
  assert.equal(new FeedBrowser().sleepAfter,'1s');
});

test('browser service keeps an accepted stream active when another request is busy',async()=>{
  const {worker,FeedBrowser}=await loadWorker();
  const instance=new FeedBrowser();
  const namespace={getByName:siteId=>siteId==='busy'?{fetch:async()=>new Response('busy',{status:429})}:instance};
  const firstJob={...job,jobId:'aaaaaaaa-1111-4222-8333-444444444444'};
  const firstResponse=worker.fetch(new Request('https://browser.internal/scrape',{
    method:'POST',headers:{'content-type':'application/json','x-feed-browser-job-id':firstJob.jobId},
    body:JSON.stringify(firstJob),
  }),{BROWSER:namespace});
  assert.ok(firstResponse instanceof Promise);
  const response=await firstResponse;
  assert.equal(response.status,200);
  const busyResponse=await worker.fetch(new Request('https://browser.internal/scrape',{
    method:'POST',headers:{'content-type':'application/json','x-feed-browser-job-id':firstJob.jobId},
    body:JSON.stringify({...job,siteId:'busy'})},
  ),{BROWSER:namespace});
  assert.equal(busyResponse.status,429);
  const wrongJobCompletion=await worker.fetch(new Request('https://browser.internal/scrape-complete',{
    method:'POST',headers:{'content-type':'application/json','x-feed-browser-site-id':'site-other'},
    body:JSON.stringify({jobId:'bbbbbbbb-1111-4222-8333-444444444444'}),
  }),{BROWSER:namespace});
  assert.deepEqual(await wrongJobCompletion.json(),{stopped:false});
  assert.equal(instance.proxyEvents.some(event=>event.stoppedAt),false);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[...new TextEncoder().encode('{"success":true}')]);
  assert.equal(instance.proxyEvents.some(event=>event.stoppedAt),false);
  const completion=await worker.fetch(new Request('https://browser.internal/scrape-complete',{
    method:'POST',headers:{'content-type':'application/json','x-feed-browser-site-id':firstJob.siteId},
    body:JSON.stringify({jobId:firstJob.jobId}),
  }),{BROWSER:{getByName:()=>instance}});
  assert.deepEqual(await completion.json(),{stopped:true});
  assert.equal(instance.proxyEvents.filter(event=>event.stoppedAt).length,1);
});

test('capture adapter sends only the private scrape contract with the configured site identity',async()=>{
  let serviceRequest;
  const response=await scrape({BROWSER:{fetch:async(input,init)=>{
    serviceRequest={input,init};
    return Response.json({success:true,data:{markdown:'正文',metadata:{statusCode:200}}});
  }}},job.url,{
    source:{id:'jwc',siteId:'7fd03676e5751e9b6dd95ecb',name:'教务处',validationJson:{internal:'not forwarded'}},
    formats:['markdown'],
  });
  assert.equal(response.markdown,'正文');
  assert.equal(serviceRequest.input,'https://browser.internal/scrape');
  assert.deepEqual(JSON.parse(serviceRequest.init.body),{
    url:job.url,siteId:'site-7fd03676e5751e9b6dd95ecb',formats:['markdown'],
  });
});

test('browser service exposes no other scrape route and rejects unsafe targets or identities',async()=>{
  const {worker,FeedBrowser}=await loadWorker();
  const instance=new FeedBrowser(),namespace={getByName:()=>instance};
  const get=await worker.fetch(new Request('https://browser.internal/scrape'),{BROWSER:namespace});
  assert.equal(get.status,405);
  const wrongMethod=await worker.fetch(new Request('https://browser.internal/scrape',{method:'PUT',body:'{}'}),{BROWSER:namespace});
  assert.equal(wrongMethod.status,405);
  for(const url of ['https://example.com/info/1.htm','http://jwc.cqu.edu.cn/info/1.htm','https://jwc.cqu.edu.cn:8443/info/1.htm']){
    const response=await worker.fetch(new Request('https://browser.internal/scrape',{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...job,url}),
    }),{BROWSER:namespace});
    assert.equal(response.status,400);
  }
  const wrongIdentity=await worker.fetch(new Request('https://browser.internal/scrape',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...job,siteId:'jwc.cqu.edu.cn'}),
  }),{BROWSER:namespace});
  assert.equal(wrongIdentity.status,400);
});
