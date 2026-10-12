import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {oauthProvider,login} from './helpers/oauth-provider.mjs';

const articleId='a1b2c3d4e5f6a1b2c3d4e5f6';
const articleUrl='https://jwc.cqu.edu.cn/info/1082/900.htm';

// This boundary catches real Queue -> Workflow startup and event handoffs. A
// direct OCR invocation with a manually-running task cannot exercise that path.
for(const failAfterOcrStore of [false,true]){
test(`queued OCR publishes readable content${failAfterOcrStore?' after a storage commit failure':''} without paying twice`,async()=>{
  const {mf,auth,ocr}=await fixture({failAfterOcrStore});
  try{
    const cookie=await login(mf,auth);
    const read=path=>mf.dispatchFetch('https://feed.test'+path,{headers:{Cookie:cookie}});
    const admin=(path,body)=>mf.dispatchFetch('https://feed.test'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer reading-admin','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    const command={articleId,requestId:'reading-queue-capture-001'};
    const submitted=await admin('/internal/capture-tasks',command);
    assert.equal(submitted.status,202,await submitted.clone().text());
    const taskId=(await submitted.json()).task.id;
    await until(async()=>{
      const task=await(await admin('/internal/capture-tasks/'+taskId)).json();
      assert.equal(task.task.state,'succeeded',JSON.stringify(task));
    });
    const history=await(await read(`/api/articles/${articleId}/revisions`)).json();
    assert.equal(history.revisions.length,1);
    const revisionId=history.revisions[0].id;
    const versionPath=`/api/articles/${articleId}/revisions/${revisionId}`;
    const pending=await(await read(versionPath)).json();
    assert.equal(pending.revision.state,'assembling');
    assert.equal(pending.article.bodyText,'');
    assert.equal(pending.article.snapshotUrl,null);
    assert.ok(pending.attachments.every(file=>file.url===null));
    await until(async()=>{
      const tasks=await(await admin('/internal/capture-tasks')).json();
      assert.equal(ocr.held,true,JSON.stringify(tasks));
    });
    ocr.release();
    await until(async()=>{
      const response=await read(`/api/articles/${articleId}`);
      const detail=await response.json();
      assert.equal(response.status,200,JSON.stringify(detail));
      assert.equal(detail.revision.state,'ready',JSON.stringify(detail));
      assert.match(detail.article.bodyText,/桥接验收名单/);
      assert.equal(detail.article.ocr.pages[0].text,'桥接验收名单 测试同学 1200');
    });
    const exact=await(await read(versionPath)).json();
    assert.match(exact.article.bodyText,/桥接验收名单/);
    assert.equal(exact.article.ocr.pages[0].page,1);
    assert.equal(exact.article.ocr.pages[0].filename,'attachment-1.pdf');
    const search=await(await read('/api/articles?q='+encodeURIComponent('桥接验收名单'))).json();
    assert.equal(search.articles.length,1);
    assert.equal(search.articles[0].id,articleId);
    const filePath=exact.attachments[0].url;
    assert.ok(filePath.includes(`/revisions/${revisionId}/`));
    const file=await mf.dispatchFetch('https://feed.test'+filePath,{headers:{Cookie:cookie,Range:'bytes=0-7'}});
    assert.equal(file.status,206);
    assert.equal(await file.text(),'%PDF-1.7');
    assert.equal((await mf.dispatchFetch('https://feed.test'+filePath)).status,401);
    assert.equal((await admin('/internal/capture-tasks',command)).status,202);
    await admin('/internal/capture-tasks/recover',{});
    assert.equal((await(await read(`/api/articles/${articleId}/revisions`)).json()).revisions.length,1);
    assert.equal(ocr.calls,1,'replaying a durable OCR step must reuse its saved result');
    assert.equal(ocr.faults,failAfterOcrStore?1:0);
    auth.setAccess(false);
    assert.equal((await read(versionPath)).status,403);
  }finally{ocr.release?.();await mf.dispose();}
});
}

async function fixture({failAfterOcrStore=false}={}){
  const pdf=scannedPdf();
  const cloudflarePlugin={name:'reading-workflow-platform',setup(api){
    api.onResolve({filter:/^cloudflare:workers$/},()=>({path:'workers',namespace:'reading-platform'}));
    api.onLoad({filter:/.*/,namespace:'reading-platform'},()=>({loader:'js',contents:'export class WorkflowEntrypoint{constructor(env){this.env=env;}}'}));
  }};
  const providerPlugin={name:'reading-firecrawl-provider',setup(api){
    api.onResolve({filter:/\.\/firecrawl\.mjs$/},()=>({path:'provider',namespace:'reading-provider'}));
    api.onLoad({filter:/.*/,namespace:'reading-provider'},()=>({loader:'js',contents:`
      const encoded=value=>btoa(String.fromCharCode(...new TextEncoder().encode(value)));
      export async function scrape(){
        const html='<html><body><h1>正文识别验收通知</h1></body></html>';
        const page={bodyRecognized:true,page:{url:${JSON.stringify(articleUrl)}},bodyText:'',errors:[],
          attachmentCandidates:[{url:'https://jwc.cqu.edu.cn/archive.pdf',name:'正文.pdf',role:'body-pdf'}],
          downloads:[{url:'https://jwc.cqu.edu.cn/archive.pdf',originalFile:true,fetchedAt:new Date().toISOString(),saved:{name:'attachment-1.pdf'}}],
          artifacts:[{name:'snapshot.html',base64:encoded(html),contentType:'text/html'},{name:'offline.html',base64:encoded(html),contentType:'text/html'},
            {name:'attachment-1.pdf',base64:encoded(${JSON.stringify(pdf)}),contentType:'application/pdf'}]};
        return {markdown:'',rawHtml:html,metadata:{statusCode:200,creditsUsed:1},actions:{javascriptReturns:[{value:JSON.stringify(page)}]}};
      }
    `}));
  }};
  const app=await build({stdin:{resolveDir:process.cwd(),sourcefile:'reading-journey-fixture.mjs',contents:`
    import worker from './worker/index.mjs';
    import {CaptureWorkflow} from './worker/capture-workflow.mjs';
    import {ArchiveOcrWorkflow} from './worker/archive-ocr.mjs';
    const instances=new Map(),active=[];
    let providerReturned=false,faultArmed=false,faultInjected=false;
    const step={async do(_name,options,fn){
      const run=typeof options==='function'?options:fn;
      try{return await run();}catch(error){
        if(error.message!=='Injected storage commit failure')throw error;
        // Cloudflare may replay a failed durable step. Only the injected
        // platform failure is retried here; product failures still surface.
        return run();
      }
    },async sleep(){}};
    function platform(Workflow,env){
      const get=id=>{if(!instances.has(id))throw new Error('Instance missing');return {id,status:async()=>({status:instances.get(id).status,error:instances.get(id).error})};};
      return {async get(id){return get(id);},async create({id,params}){
        if(instances.has(id))throw new Error('Instance exists');
        const state={status:'running',error:null};instances.set(id,state);
        const execution=new Workflow(env).run({instanceId:id,payload:params},step);
        active.push(execution);execution.then(()=>{state.status='complete';},error=>{state.status='errored';state.error=String(error);});
        return get(id);
      }};
    }
    function environment(raw){
      const env={...raw};env.CAPTURE=platform(CaptureWorkflow,env);env.ARCHIVE_OCR=platform(ArchiveOcrWorkflow,env);
      if(${JSON.stringify(failAfterOcrStore)}){
        env.ARCHIVE=new Proxy(raw.ARCHIVE,{get(target,key){
          if(key==='put')return async(...args)=>{
            const result=await target.put(...args);
            if(providerReturned&&!faultInjected&&args[2]?.httpMetadata?.contentType==='application/json')faultArmed=true;
            return result;
          };
          const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
        }});
        env.DB=new Proxy(raw.DB,{get(target,key){
          if(key==='batch')return async(...args)=>{
            if(faultArmed&&!faultInjected){
              faultInjected=true;await raw.TEST_STORAGE_FAULT.fetch('https://fixture.test/injected');
              throw new Error('Injected storage commit failure');
            }
            return target.batch(...args);
          };
          const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
        }});
      }
      globalThis.fetch=async(input,init)=>{
        const request=new Request(input,init);
        if(request.url==='https://api.mistral.ai/v1/ocr'){
          const response=await raw.TEST_OCR.fetch(request);providerReturned=true;return response;
        }
        throw new Error('Unexpected external URL');
      };
      return env;
    }
    export default{
      fetch(request,raw){return worker.fetch(request,environment(raw));},
      async queue(batch,raw){await worker.queue(batch,environment(raw));await Promise.allSettled(active.splice(0));}
    };
  `},bundle:true,write:false,format:'esm',platform:'browser',external:['node:*'],plugins:[cloudflarePlugin,providerPlugin]});
  const auth=oauthProvider(),ocr={calls:0,faults:0,held:false,release:null};
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:app.outputFiles[0].text,
    compatibilityDate:'2026-10-11',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['ARCHIVE'],
    serviceBindings:{AUTH:request=>auth.fetch(request),TEST_STORAGE_FAULT:()=>{ocr.faults++;return new Response('injected');},TEST_OCR:async request=>{
      const body=await request.json();assert.deepEqual(body.pages,[0]);ocr.calls++;ocr.held=true;
      if(ocr.calls===1)await new Promise(resolve=>{ocr.release=resolve;});
      return Response.json({model:'mistral-ocr-4-1',pages:[{index:0,markdown:'桥接验收名单 测试同学 1200',tables:[]}],usage_info:{pages_processed:1,doc_size_bytes:pdf.length}});
    }},bindings:{...auth.bindings,ADMIN_TOKEN:'reading-admin',BASE_URL:'https://feed.test',BRIDGE_SECRET:'test-bridge',
      CRAWL_ENABLED:'true',TASK_RUNTIME_ENABLED:'true',ARCHIVE_VERSIONS_ENABLED:'true',ARCHIVE_READS_ENABLED:'true',
      SOURCE_MANAGEMENT_ENABLED:'false',PDF_OCR_ENABLED:'true',PDF_OCR_MODEL:'mistral-ocr-4-1',MISTRAL_API_KEY:'test-mistral'},
    queueProducers:{FEED_JOBS:{queueName:'feed-jobs'},FEED_EVENTS:{queueName:'feed-events'}},
    queueConsumers:{'feed-jobs':{maxBatchSize:1,maxRetries:0},'feed-events':{maxBatchSize:1,maxRetries:0}},
  }));
  const db=await mf.getD1Database('DB');
  for(const name of ['0001_feed.sql','0002_auth.sql','0003_collection_lease.sql','0004_pdf_ocr.sql','0005_task_runtime.sql','0006_sources.sql','0007_archive_versions.sql','0008_content_events.sql','0009_subscriptions.sql','0010_subscription_editing.sql','0013_notification_matching.sql']){
    const sql=await readFile('migrations/'+name,'utf8');
    for(const statement of sql.split(/;\s*\n(?=CREATE|ALTER|PRAGMA|INSERT|UPDATE|$)/).map(s=>s.trim()).filter(s=>s&&!/^PRAGMA\b/.test(s)))await db.prepare(statement).run();
  }
  await db.prepare("INSERT OR IGNORE INTO sources(id,name,url) VALUES ('jwc','教务处','https://jwc.cqu.edu.cn')").run();
  await db.prepare("INSERT INTO articles(id,source_id,url,title,published_at,discovered_at) VALUES (?,'jwc',?,'正文识别验收通知','2026-10-12','2026-10-12T00:00:00Z')").bind(articleId,articleUrl).run();
  return {mf,auth,ocr};
}
async function until(check){
  let failure;
  for(let n=0;n<200;n++){try{return await check();}catch(error){failure=error;await new Promise(resolve=>setTimeout(resolve,25));}}
  throw failure;
}
function scannedPdf(){
  const stream='q 200 0 0 200 20 20 cm /Im0 Do Q';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\nP\nendstream'];
  let pdf='%PDF-1.7\n';const offsets=[];
  objects.forEach((object,index)=>{offsets.push(pdf.length);pdf+=`${index+1} 0 obj\n${object}\nendobj\n`;});
  const start=pdf.length;pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('');
  return pdf+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
}
