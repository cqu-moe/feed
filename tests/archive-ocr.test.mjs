import {mixedPdf} from './helpers/mixed-pdf.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

const articleId='abcdefabcdefabcdef123456';
const taskId='1234567890abcdef12345678';
const articleUrl='https://jwc.cqu.edu.cn/info/1082/1.htm';
const workflowPlugin={
  name:'archive-ocr-worker-stub',
  setup(buildApi){
    buildApi.onResolve({filter:/^cloudflare:workers$/},()=>({path:'cloudflare-workers',namespace:'archive-ocr-stub'}));
    buildApi.onLoad({filter:/.*/,namespace:'archive-ocr-stub'},()=>({loader:'js',contents:'export class WorkflowEntrypoint{constructor(env={}){this.env=env;}}'}));
  },
};

test('mixed PDF OCR is cached, adopted per revision, and reconciles out of order',async()=>{
  const secondTaskId='8765432109abcdef43214321';
  const thirdTaskId='1122334455aabbccddeeff99';
  const fourthTaskId='887766554433221100aabbcc';
  const fifthTaskId='99887766554433221100ff00';
  const pdf=mixedPdf();
  const bundle=await build({
    stdin:{contents:`
      import {createArchive} from './worker/archive.mjs';
      import {createCollector} from './worker/collect.mjs';
      import {ArchiveOcrWorkflow} from './worker/archive-ocr.mjs';
      import {readRevision} from './worker/archive-versions.mjs';
      import {handleFeedJobs} from './worker/task-runtime.mjs';
      import {redoArchiveOcr} from './worker/archive-ocr.mjs';
      import {internalRoute} from './worker/internal.mjs';
      const nativeFetch=globalThis.fetch.bind(globalThis);
      const base64=value=>btoa(String.fromCharCode(...new TextEncoder().encode(value)));
      const snapshot='<html><body><main><h1>混合正文通知</h1></main></body></html>';
      const pdfs=${JSON.stringify([pdf,mixedPdf({firstPageText:'CQU changed notice first page'}),mixedPdf({firstPageText:'CQU second document first page'})])};
      const makePage=()=>globalThis.PURE_HTML
        ?{
          bodyRecognized:true,page:{url:${JSON.stringify(articleUrl)}},bodyText:'纯 HTML 后续正文',errors:[],
          artifacts:[
            {name:'snapshot.html',base64:base64(snapshot),contentType:'text/html; charset=utf-8'},
            {name:'offline.html',base64:base64(snapshot),contentType:'text/html; charset=utf-8'},
          ],
          attachmentCandidates:[],downloads:[],
        }
        :({
        bodyRecognized:true,page:{url:${JSON.stringify(articleUrl)}},bodyText:'',errors:[],
        artifacts:[
          {name:'snapshot.html',base64:base64(snapshot),contentType:'text/html; charset=utf-8'},
          {name:'offline.html',base64:base64(snapshot),contentType:'text/html; charset=utf-8'},
          {name:'attachment-1.pdf',base64:base64(pdfs[globalThis.PDF_INDEX??0]),contentType:'application/pdf'},
        ],
        attachmentCandidates:[{url:'https://jwc.cqu.edu.cn/mixed.pdf',name:'混合正文.pdf',role:'body-pdf'}],
        downloads:[{url:'https://jwc.cqu.edu.cn/mixed.pdf',originalFile:true,saved:{name:'attachment-1.pdf'},fetchedAt:new Date().toISOString()}],
        });
      const twoPdfPage=()=>({
        bodyRecognized:true,page:{url:${JSON.stringify(articleUrl)}},bodyText:'',errors:[],
        artifacts:[
          {name:'snapshot.html',base64:base64(snapshot),contentType:'text/html; charset=utf-8'},
          {name:'offline.html',base64:base64(snapshot),contentType:'text/html; charset=utf-8'},
          {name:'attachment-1.pdf',base64:base64(pdfs[0]),contentType:'application/pdf'},
          {name:'attachment-2.pdf',base64:base64(pdfs[2]),contentType:'application/pdf'},
        ],
        attachmentCandidates:[
          {url:'https://jwc.cqu.edu.cn/mixed.pdf',name:'混合正文.pdf',role:'body-pdf'},
          {url:'https://jwc.cqu.edu.cn/second.pdf',name:'第二份正文.pdf',role:'body-pdf'},
        ],
        downloads:[
          {url:'https://jwc.cqu.edu.cn/mixed.pdf',originalFile:true,saved:{name:'attachment-1.pdf'},fetchedAt:new Date().toISOString()},
          {url:'https://jwc.cqu.edu.cn/second.pdf',originalFile:true,saved:{name:'attachment-2.pdf'},fetchedAt:new Date().toISOString()},
        ],
      });
      const scrape=async()=>{const page=globalThis.TWO_PDFS?twoPdfPage():makePage();return {markdown:'',rawHtml:snapshot,metadata:{statusCode:200,creditsUsed:1},
        actions:{javascriptReturns:[{value:JSON.stringify(page)}]}};};
      const step={async do(name,config,fn){return (typeof config==='function'?config:fn)();},async sleep(){}};
      async function inspect(env,revisionId){
        const [revision,pointer,readModel,requirements,events,outbox,derived,tasks]=await Promise.all([
          env.DB.prepare('SELECT id,state,revision_no,requirement_generation FROM article_revisions WHERE id=?').bind(revisionId).first(),
          env.DB.prepare('SELECT latest_ready_revision_id AS latest_ready FROM articles WHERE id=(SELECT article_id FROM article_revisions WHERE id=?)').bind(revisionId).first(),
          env.DB.prepare('SELECT revision_id,readable_text,ocr_result_hash,ocr_model,ocr_updated_at,extraction_generation FROM article_read_models').all(),
          env.DB.prepare('SELECT kind,required,state,error_code,input_hash,object_hash,derived_output_id,processor,processor_version,options_hash FROM revision_requirements WHERE revision_id=? ORDER BY slot_key').bind(revisionId).all(),
          env.DB.prepare('SELECT e.id,e.revision_id,e.kind,e.history_only,e.date_state FROM content_events e JOIN article_revisions r ON r.id=e.revision_id ORDER BY r.revision_no').all(),
          env.DB.prepare('SELECT topic,dedupe_key,payload_json FROM outbox ORDER BY dedupe_key').all(),
          env.DB.prepare('SELECT id,input_hash,processor,processor_version,options_hash,result_hash FROM derived_outputs').all(),
          env.DB.prepare("SELECT id,kind,state,payload_json FROM tasks WHERE kind='ocr'").all(),
        ]);
          return {revision:{...revision,latest_ready:pointer.latest_ready},readModels:readModel.results,requirements:requirements.results,events:events.results,outbox:outbox.results,
          derived:derived.results,tasks:tasks.results};
      }
      export default{
        async fetch(request,env){
          try{
            const url=new URL(request.url);
            if(url.pathname==='/capture')return Response.json(await createArchive(env,{collector:createCollector({scrape})}).captureTask(${JSON.stringify(taskId)},1));
            if(url.pathname==='/capture2')return Response.json(await createArchive(env,{collector:createCollector({scrape})}).captureTask(${JSON.stringify(secondTaskId)},1));
            if(url.pathname==='/capture3')return Response.json(await createArchive(env,{collector:createCollector({scrape})}).captureTask(${JSON.stringify(thirdTaskId)},1));
            if(url.pathname==='/capture4')return Response.json(await createArchive(env,{collector:createCollector({scrape})}).captureTask(${JSON.stringify(fourthTaskId)},1));
            if(url.pathname==='/capture5')return Response.json(await createArchive(env,{collector:createCollector({scrape})}).captureTask(${JSON.stringify(fifthTaskId)},1));
            if(url.pathname==='/run-ocr'){
              const taskId=url.searchParams.get('taskId');
              const timestamp=Date.now();
              await env.DB.batch([
                env.DB.prepare("UPDATE tasks SET state='running',updated_at=? WHERE id=? AND attempt_no=1 AND state='queued'").bind(timestamp,taskId),
                env.DB.prepare("INSERT INTO task_attempts(task_id,attempt_no,workflow_instance_id,state,started_at) VALUES (?,1,?,'running',?) ON CONFLICT(task_id,attempt_no) DO UPDATE SET state='running'").bind(taskId,'task-'+taskId+'-a1',timestamp),
              ]);
              return Response.json(await new ArchiveOcrWorkflow(env).run({instanceId:'task-'+taskId+'-a1',payload:{taskId,attempt:1}},step));
            }
            if(url.pathname==='/reconcile'){
              const revisionId=url.searchParams.get('revisionId');
              return Response.json(await createArchive(env,{collector:createCollector({scrape})}).reconcileRevision(revisionId));
            }
            if(url.pathname==='/read'){
              const revisionId=url.searchParams.get('revisionId');
              return Response.json(await readRevision(env,${JSON.stringify(articleId)},revisionId,{current:url.searchParams.get('current')==='1'}));
            }
            if(url.pathname==='/internal/articles/'+${JSON.stringify(articleId)}+'/pdf-ocr'){
              return await internalRoute(request,env);
            }
            if(url.pathname==='/processor-version'){
              const body=await request.json();
              env.ARCHIVE_OCR_PROCESSOR_VERSION=body.version;
              globalThis.OCR_TEXT=body.text;
              globalThis.OCR_SECOND_TEXT=body.secondText??globalThis.OCR_SECOND_TEXT??'第二份文件 第二页 扫描正文';
              return Response.json({version:env.ARCHIVE_OCR_PROCESSOR_VERSION});
            }
            if(url.pathname==='/pdf-version'){
              const body=await request.json();
              globalThis.PDF_INDEX=body.index;
              return Response.json({index:globalThis.PDF_INDEX});
            }
            if(url.pathname==='/html-version'){
              globalThis.PURE_HTML=true;
              return Response.json({html:true});
            }
            if(url.pathname==='/two-pdf-version'){
              globalThis.PURE_HTML=false;
              globalThis.TWO_PDFS=true;
              return Response.json({twoPdfs:true});
            }
            if(url.pathname==='/internal/capture-tasks'&&request.method==='GET'){
              return await internalRoute(request,env);
            }
            if(url.pathname==='/consume-feed-event'){
              const body=await request.json();
              let acked=false,retried=false;
              await handleFeedJobs({messages:[{body,attempt:1,ack(){acked=true;},retry(){retried=true;}}]},env,{});
              return Response.json({acked,retried});
            }
            if(url.pathname==='/inspect'){
              const revisionId=url.searchParams.get('revisionId');
              return Response.json(await inspect(env,revisionId));
            }
            if(url.pathname==='/provider'){
              globalThis.PROVIDER_CALLS=0;
              globalThis.fetch=async(input,init)=>{
                const request=new Request(input,init);
                if(request.url!=='https://api.mistral.ai/v1/ocr')return nativeFetch(request);
                globalThis.PROVIDER_CALLS++;
                const body=await request.json();
                if(body.model!=='mistral-ocr-4-1'||JSON.stringify(body.pages)!=='[1]')return Response.json({message:'unexpected OCR request'},400);
                const source=atob(body.document.document_url.split(',').at(-1));
                const text=source.includes('CQU second document first page')
                  ?globalThis.OCR_SECOND_TEXT??'第二份文件 第二页 扫描正文'
                  :globalThis.OCR_TEXT??'第二页 扫描正文 资助名单';
                return Response.json({model:body.model,pages:[{index:1,markdown:text,tables:[]}],
                  usage_info:{pages_processed:1,doc_size_bytes:${pdf.length}}});
              };
              return Response.json({ok:true});
            }
            if(url.pathname==='/provider-state')return Response.json({calls:globalThis.PROVIDER_CALLS??0});
            return new Response('Not found',{status:404});
          }catch(error){
            return Response.json({error:String(error?.message??error),stack:String(error?.stack??'')},{status:500});
          }
        }
      }
    `,resolveDir:process.cwd(),sourcefile:'archive-ocr-fixture.mjs'},
    bundle:true,write:false,format:'esm',platform:'browser',external:['node:buffer','node:*'],plugins:[workflowPlugin],
  });
  const mf=new Miniflare(convertV4MiniflareOptions({
    modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-11',compatibilityFlags:['nodejs_compat'],
    bindings:{BASE_URL:'https://feed.test',BRIDGE_SECRET:'test-bridge-secret',ARCHIVE_VERSIONS_ENABLED:'true',
      PDF_OCR_ENABLED:'true',PDF_OCR_MODEL:'mistral-ocr-4-1',MISTRAL_API_KEY:'test-mistral-key',ADMIN_TOKEN:'test-admin-token'},
    d1Databases:['DB'],r2Buckets:['ARCHIVE'],
  }));
  try{
    const db=await mf.getD1Database('DB');
    for(const name of ['0001_feed.sql','0003_collection_lease.sql','0004_pdf_ocr.sql','0005_task_runtime.sql','0006_sources.sql','0007_archive_versions.sql','0008_content_events.sql','0018_outbox_receipts.sql']){
      await applyMigration(db,await readFile(`migrations/${name}`,'utf8'));
    }
    const now=Date.now();
    await db.prepare("INSERT INTO sources(id,name,url) VALUES ('jwc','教务处','https://jwc.cqu.edu.cn/')").run();
    await db.prepare(`INSERT INTO articles(id,source_id,url,title,published_at,discovered_at,status,attempts,lease_until)
      VALUES (?,'jwc',?,'混合正文通知','2026-01-03','2026-01-01','pending',0,0)`).bind(articleId,articleUrl).run();
    for(const [id,key] of [[taskId,'first'],[secondTaskId,'second'],[thirdTaskId,'third'],[fourthTaskId,'fourth'],[fifthTaskId,'fifth']]){
      await db.prepare(`INSERT INTO tasks(id,kind,business_key,source_id,article_id,payload_json,state,due_at,attempt_no,created_at,updated_at)
        VALUES (?,'capture',?, 'jwc',?,'{}','running',?,1,?,?)`).bind(id,`capture:${articleId}:${key}`,articleId,now,now,now).run();
      await db.prepare(`INSERT INTO task_attempts(task_id,attempt_no,workflow_instance_id,state,started_at) VALUES (?,1,?,'running',?)`).bind(id,`task-${id}-a1`,now).run();
    }
    const first=await(await mf.dispatchFetch('https://feed.test/capture')).json();
    assert.equal(first.revisionState,'assembling');
    let state=await(await mf.dispatchFetch('https://feed.test/inspect?revisionId='+first.revisionId)).json();
    const bodyOcr=state.requirements.find(row=>row.kind==='body_ocr');
    assert.deepEqual({required:bodyOcr.required,state:bodyOcr.state,error_code:bodyOcr.error_code},
      {required:1,state:'pending',error_code:'ocr_pending'});
    assert.equal(bodyOcr.processor,'mistral-ocr');
    assert.equal(bodyOcr.processor_version,'v1');
    assert.match(bodyOcr.options_hash,/^[a-f0-9]{64}$/);
    assert.equal(state.tasks.length,1);
    const startMessage=JSON.parse(state.outbox.find(row=>row.topic==='feed-jobs').payload_json);
    assert.deepEqual(Object.keys(startMessage).sort(),['attempt','outboxId','taskId','type','v']);
    const adminTasks=await(await mf.dispatchFetch('https://feed.test/internal/capture-tasks',{
      headers:{Authorization:'Bearer test-admin-token'},
    })).json();
    assert.deepEqual(adminTasks.tasks.find(task=>task.id===taskId).missingRequirements.map(({kind,error})=>({kind,error})),[
      {kind:'body_ocr',error:'ocr_pending'},
    ]);
    const initialCheck=JSON.parse(state.outbox.find(row=>row.topic==='feed-events').payload_json);
    assert.deepEqual(await(await mf.dispatchFetch('https://feed.test/consume-feed-event',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(initialCheck),
    })).json(),{acked:true,retried:false});

    await(await mf.dispatchFetch('https://feed.test/provider',{method:'POST'})).json();
    const processed=await(await mf.dispatchFetch('https://feed.test/run-ocr?taskId='+state.tasks[0].id)).json();
    assert.equal(processed.adoptedRequirements,1);
    state=await(await mf.dispatchFetch('https://feed.test/inspect?revisionId='+first.revisionId)).json();
    assert.equal(state.requirements.find(row=>row.kind==='body_ocr').state,'fulfilled');
    assert.equal(state.derived.length,1);
    const progress=state.outbox.filter(row=>row.topic==='feed-events'&&row.dedupe_key.includes(':task:'));
    assert.equal(progress.length,1);

    const second=await(await mf.dispatchFetch('https://feed.test/capture2')).json();
    assert.equal(second.revisionState,'assembling');
    state=await(await mf.dispatchFetch('https://feed.test/inspect?revisionId='+second.revisionId)).json();
    assert.equal(state.requirements.find(row=>row.kind==='body_ocr').state,'fulfilled');
    assert.equal(state.tasks.length,1);
    assert.equal((await(await mf.dispatchFetch('https://feed.test/provider-state')).json()).calls,1);

    const reconciledSecond=await(await mf.dispatchFetch('https://feed.test/reconcile?revisionId='+second.revisionId)).json();
    assert.deepEqual(reconciledSecond,{state:'ready',eventCreated:true});
    const adoptedCheck=JSON.parse(state.outbox.find(row=>row.topic==='feed-events'
      &&JSON.parse(row.payload_json).sourceTaskId===null).payload_json);
    assert.deepEqual(await(await mf.dispatchFetch('https://feed.test/consume-feed-event',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(adoptedCheck),
    })).json(),{acked:true,retried:false});
    const reconciledFirst=await(await mf.dispatchFetch('https://feed.test/reconcile?revisionId='+first.revisionId)).json();
    assert.deepEqual(reconciledFirst,{state:'ready',eventCreated:true});
    state=await(await mf.dispatchFetch('https://feed.test/inspect?revisionId='+second.revisionId)).json();
    assert.equal(state.revision.latest_ready,second.revisionId);
    assert.deepEqual(state.readModels.map(row=>row.revision_id),[second.revisionId]);
    assert.deepEqual(state.events.map(({kind,revision_id})=>({kind,revision_id})),[
      {kind:'initial',revision_id:first.revisionId},
      {kind:'update',revision_id:second.revisionId},
    ]);
    assert.equal((await(await mf.dispatchFetch('https://feed.test/provider-state')).json()).calls,1);
    const historical=await(await mf.dispatchFetch('https://feed.test/read?revisionId='+first.revisionId)).json();
    assert.equal(historical.article.ocr.status,'complete');
    assert.equal(historical.article.ocr.model,'mistral-ocr-4-1');
    assert.deepEqual(historical.article.ocr.pages.map(({page,filename,source})=>({page,filename,source})),[
      {page:1,filename:'attachment-1.pdf',source:'native'},
      {page:2,filename:'attachment-1.pdf',source:'ocr'},
    ]);
    assert.match(historical.article.bodyText,/CQU mixed notice first page/);
    assert.match(historical.article.bodyText,/第二页 扫描正文 资助名单/);
    assert.equal(historical.article.bodyText.includes('PDF 正文暂未提取到'),false);
    const beforeRedo=await(await mf.dispatchFetch('https://feed.test/inspect?revisionId='+first.revisionId)).json();
    const frozenHash=beforeRedo.requirements.find(row=>row.kind==='body_ocr').object_hash;

    await(await mf.dispatchFetch('https://feed.test/processor-version',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({version:'v2',text:'第二页 重做后的扫描正文 1800'}),
    })).json();
    const redoResponse=await mf.dispatchFetch(`https://feed.test/internal/articles/${articleId}/pdf-ocr`,{
      method:'POST',headers:{Authorization:'Bearer test-admin-token'},
    });
    assert.equal(redoResponse.status,202,await redoResponse.clone().text());
    const redo=await redoResponse.json();
    assert.equal(redo.tasks.length,1);
    assert.equal(redo.tasks[0].duplicate,false);
    const redoRun=await(await mf.dispatchFetch('https://feed.test/run-ocr?taskId='+redo.tasks[0].taskId)).json();
    assert.equal(redoRun.error,undefined,JSON.stringify(redoRun));
    const afterRedo=await(await mf.dispatchFetch('https://feed.test/inspect?revisionId='+first.revisionId)).json();
    assert.equal(afterRedo.requirements.find(row=>row.kind==='body_ocr').object_hash,frozenHash);
    assert.equal(afterRedo.derived.length,2);
    assert.equal(afterRedo.events.length,2);
    assert.equal((await(await mf.dispatchFetch('https://feed.test/inspect?revisionId='+second.revisionId)).json()).readModels[0].revision_id,second.revisionId);
    const frozenAfterRedo=await(await mf.dispatchFetch('https://feed.test/read?revisionId='+first.revisionId)).json();
    assert.equal(frozenAfterRedo.article.ocr.model,'mistral-ocr-4-1');
    assert.match(frozenAfterRedo.article.bodyText,/第二页 扫描正文 资助名单/);
    assert.equal(frozenAfterRedo.article.bodyText.includes('重做后的扫描正文'),false);
    const currentAfterRedo=await(await mf.dispatchFetch('https://feed.test/read?revisionId='+second.revisionId+'&current=1')).json();
    assert.match(currentAfterRedo.article.bodyText,/第二页 重做后的扫描正文 1800/);
    assert.equal(currentAfterRedo.article.bodyText.includes('第二页 扫描正文 资助名单'),false);

    await(await mf.dispatchFetch('https://feed.test/processor-version',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({version:'v1',text:'第二页 变更后的扫描正文 2000'}),
    })).json();
    await(await mf.dispatchFetch('https://feed.test/pdf-version',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({index:1}),
    })).json();
    const third=await(await mf.dispatchFetch('https://feed.test/capture3')).json();
    assert.equal(third.revisionState,'assembling');
    let thirdState=await(await mf.dispatchFetch('https://feed.test/inspect?revisionId='+third.revisionId)).json();
    assert.equal(thirdState.tasks.length,3);
    await(await mf.dispatchFetch('https://feed.test/run-ocr?taskId='+thirdState.tasks.at(-1).id)).json();
    assert.deepEqual(await(await mf.dispatchFetch('https://feed.test/reconcile?revisionId='+third.revisionId)).json(),
      {state:'ready',eventCreated:true});
    thirdState=await(await mf.dispatchFetch('https://feed.test/inspect?revisionId='+third.revisionId)).json();
    assert.equal(thirdState.revision.latest_ready,third.revisionId);
    assert.equal(thirdState.events.length,3);
    const changedCurrentResponse=await mf.dispatchFetch('https://feed.test/read?revisionId='+third.revisionId+'&current=1');
    assert.equal(changedCurrentResponse.status,200,await changedCurrentResponse.clone().text());
    const changedCurrent=await changedCurrentResponse.json();
    assert.match(changedCurrent.article.bodyText,/CQU changed notice first page/);
    assert.match(changedCurrent.article.bodyText,/第二页 变更后的扫描正文 2000/);
    assert.equal(changedCurrent.article.ocr.status,'complete');
    assert.match(changedCurrent.article.ocr.pages.at(-1).text,/变更后的扫描正文 2000/);

    await(await mf.dispatchFetch('https://feed.test/html-version',{method:'POST'})).json();
    const fourth=await(await mf.dispatchFetch('https://feed.test/capture4')).json();
    assert.equal(fourth.revisionState,'assembling');
    assert.deepEqual(await(await mf.dispatchFetch('https://feed.test/reconcile?revisionId='+fourth.revisionId)).json(),
      {state:'ready',eventCreated:true});
    const htmlCurrent=await(await mf.dispatchFetch('https://feed.test/read?revisionId='+fourth.revisionId+'&current=1')).json();
    assert.equal(htmlCurrent.revision.state,'ready');
    assert.match(htmlCurrent.article.bodyText,/纯 HTML 后续正文/);
    assert.equal('ocr' in htmlCurrent.article,false);
    const historicalPdf=await(await mf.dispatchFetch('https://feed.test/read?revisionId='+third.revisionId)).json();
    assert.equal(historicalPdf.article.ocr.status,'complete');
    assert.match(historicalPdf.article.bodyText,/第二页 变更后的扫描正文 2000/);

    await(await mf.dispatchFetch('https://feed.test/two-pdf-version',{method:'POST'})).json();
    const fifth=await(await mf.dispatchFetch('https://feed.test/capture5')).json();
    assert.equal(fifth.revisionState,'assembling');
    let fifthState=await(await mf.dispatchFetch('https://feed.test/inspect?revisionId='+fifth.revisionId)).json();
    const twoPdfTasks=fifthState.tasks.slice(-2);
    await Promise.all(twoPdfTasks.map(task=>mf.dispatchFetch('https://feed.test/run-ocr?taskId='+task.id)));
    assert.deepEqual(await(await mf.dispatchFetch('https://feed.test/reconcile?revisionId='+fifth.revisionId)).json(),
      {state:'ready',eventCreated:true});
    fifthState=await(await mf.dispatchFetch('https://feed.test/inspect?revisionId='+fifth.revisionId)).json();
    const bodyOcrRequirements=fifthState.requirements.filter(row=>row.kind==='body_ocr');
    assert.equal(bodyOcrRequirements.length,2);
    assert.equal(fifthState.revision.latest_ready,fifth.revisionId,JSON.stringify(fifthState.revision));
    const initialTwoPdf=await(await mf.dispatchFetch('https://feed.test/read?revisionId='+fifth.revisionId+'&current=1')).json();
    assert.deepEqual(initialTwoPdf.article.ocr.pages.map(({page,filename})=>({page,filename})),[
      {page:1,filename:'attachment-1.pdf'},
      {page:2,filename:'attachment-1.pdf'},
      {page:1,filename:'attachment-2.pdf'},
      {page:2,filename:'attachment-2.pdf'},
    ]);
    assert.match(initialTwoPdf.article.bodyText,/CQU mixed notice first page/);
    assert.match(initialTwoPdf.article.bodyText,/CQU second document first page/);
    assert.equal(countOccurrences(initialTwoPdf.article.bodyText,'CQU mixed notice first page'),1);
    assert.equal(countOccurrences(initialTwoPdf.article.bodyText,'CQU second document first page'),1);
    assert.equal(countOccurrences(initialTwoPdf.article.bodyText,'第二页 扫描正文 资助名单'),1);
    assert.equal(countOccurrences(initialTwoPdf.article.bodyText,'第二份文件 第二页 扫描正文'),1);

    const taskForInput=async(inputHash,processorVersion)=>{
      const state=await(await mf.dispatchFetch('https://feed.test/inspect?revisionId='+fifth.revisionId)).json();
      const task=state.tasks.find(row=>{
        const payload=JSON.parse(row.payload_json);
        return payload.inputHash===inputHash&&payload.processorVersion===processorVersion;
      });
      if(!task)throw new Error('Missing OCR task for input '+inputHash);
      return task.id;
    };
    await(await mf.dispatchFetch('https://feed.test/processor-version',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({version:'v5',text:'第一份文件 重做后的正文 2100'}),
    })).json();
    let multiRedo=await(await mf.dispatchFetch(`https://feed.test/internal/articles/${articleId}/pdf-ocr`,{
      method:'POST',headers:{Authorization:'Bearer test-admin-token'},
    })).json();
    assert.equal(multiRedo.tasks.length,2,JSON.stringify(multiRedo));
    const firstMultiRedoRun=await(await mf.dispatchFetch('https://feed.test/run-ocr?taskId='+await taskForInput(bodyOcrRequirements[0].input_hash,'v5'))).json();
    assert.equal(firstMultiRedoRun.error,undefined,JSON.stringify(firstMultiRedoRun));
    await(await mf.dispatchFetch('https://feed.test/processor-version',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({version:'v6',text:'第一份占位',secondText:'第二份文件 重做后的正文 2200'}),
    })).json();
    multiRedo=await(await mf.dispatchFetch(`https://feed.test/internal/articles/${articleId}/pdf-ocr`,{
      method:'POST',headers:{Authorization:'Bearer test-admin-token'},
    })).json();
    assert.equal(multiRedo.tasks.length,2,JSON.stringify(multiRedo));
    const secondMultiRedoRun=await(await mf.dispatchFetch('https://feed.test/run-ocr?taskId='+await taskForInput(bodyOcrRequirements[1].input_hash,'v6'))).json();
    assert.equal(secondMultiRedoRun.error,undefined,JSON.stringify(secondMultiRedoRun));
    let twoPdfCurrent=await(await mf.dispatchFetch('https://feed.test/read?revisionId='+fifth.revisionId+'&current=1')).json();
    const projectionState=await(await mf.dispatchFetch('https://feed.test/inspect?revisionId='+fifth.revisionId)).json();
    assert.match(twoPdfCurrent.article.ocr.pages[1].text,/第一份文件 重做后的正文 2100/,JSON.stringify(twoPdfCurrent.article.ocr));
    assert.match(twoPdfCurrent.article.ocr.pages[3].text,/第二份文件 重做后的正文 2200/,
      JSON.stringify({run:secondMultiRedoRun,readModels:projectionState.readModels,requirements:projectionState.requirements,derived:projectionState.derived,ocr:twoPdfCurrent.article.ocr}));
    assert.match(twoPdfCurrent.article.bodyText,/第一份文件 重做后的正文 2100/);
    assert.match(twoPdfCurrent.article.bodyText,/第二份文件 重做后的正文 2200/);
    assert.equal(countOccurrences(twoPdfCurrent.article.bodyText,'第一份文件 重做后的正文 2100'),1);
    assert.equal(countOccurrences(twoPdfCurrent.article.bodyText,'第二份文件 重做后的正文 2200'),1);

    await(await mf.dispatchFetch('https://feed.test/processor-version',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({version:'v7',text:'第一份并发重做 2300',secondText:'第二份并发重做 2300'}),
    })).json();
    multiRedo=await(await mf.dispatchFetch(`https://feed.test/internal/articles/${articleId}/pdf-ocr`,{
      method:'POST',headers:{Authorization:'Bearer test-admin-token'},
    })).json();
    assert.equal(multiRedo.tasks.length,2);
    await Promise.all(multiRedo.tasks.map(task=>mf.dispatchFetch('https://feed.test/run-ocr?taskId='+task.taskId)));
    twoPdfCurrent=await(await mf.dispatchFetch('https://feed.test/read?revisionId='+fifth.revisionId+'&current=1')).json();
    assert.match(twoPdfCurrent.article.ocr.pages[1].text,/第一份并发重做 2300/);
    assert.match(twoPdfCurrent.article.ocr.pages[3].text,/第二份并发重做 2300/);
    assert.equal(countOccurrences(twoPdfCurrent.article.bodyText,'第一份并发重做 2300'),1);
    assert.equal(countOccurrences(twoPdfCurrent.article.bodyText,'第二份并发重做 2300'),1);
    const twoPdfHistorical=await(await mf.dispatchFetch('https://feed.test/read?revisionId='+fifth.revisionId)).json();
    assert.equal(twoPdfHistorical.article.ocr.pages.length,4);
    assert.equal(twoPdfHistorical.article.bodyText.includes('重做后的正文'),false);
    assert.equal(countOccurrences(twoPdfHistorical.article.bodyText,'第二页 扫描正文 资助名单'),1);
    assert.equal(countOccurrences(twoPdfHistorical.article.bodyText,'第二份文件 第二页 扫描正文'),1);
  }finally{await mf.dispose();}
});

function countOccurrences(value,needle){
  return value.split(needle).length-1;
}

async function applyMigration(db,sql){
  for(const statement of sql.split(/;\s*\n(?=CREATE|ALTER|PRAGMA|$)/).map(value=>value.trim()).filter(Boolean)){
    if(!/^PRAGMA\b/i.test(statement))await db.prepare(statement).run();
  }
}
