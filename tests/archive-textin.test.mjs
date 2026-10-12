import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {mixedPdf} from './helpers/mixed-pdf.mjs';

test('formal OCR defaults to TextIn without Mistral credentials and preserves native pages',async()=>{
  const f=await fixture();
  try{
    const task=await f.start();
    const response=await f.call('/run',{taskId:task.id});
    assert.equal(response.status,200,await response.clone().text());
    const state=await f.state();
    assert.equal(state.calls.length,1);
    assert.equal(state.calls[0].url,'https://api.textin.com/api/v1/xparse/parse/sync');
    assert.equal(state.calls[0].config.scope.page_range,'2');
    assert.equal(state.calls[0].config.config.engine_params.parse_mode,'auto');
    assert.equal(state.tasks[0].state,'succeeded');
    assert.equal(state.outputs[0].model,'textin-xparse-auto');
    assert.deepEqual(state.outputs[0].pages.map(page=>[page.index,page.source,page.text]),[
      [0,'native','CQU mixed notice first page'],[1,'ocr','TextIn 扫描正文'],
    ]);
  }finally{await f.mf.dispose();}
});

test('formal OCR adopts an existing MVP TextIn result across processor revisions without a new charge',async()=>{
  const f=await fixture({credentials:false});
  try{
    // This is the persisted 7fb8e2a cache namespace and document shape, not a new descriptor.
    const key=`derived/pdf/${f.hash}/textin-xparse-auto/v1-no-text-75eefb13df7f1ce9/result.json`;
    const saved=JSON.stringify({sourceHash:f.hash,model:'textin-xparse-auto',totalPages:2,
      pages:[{index:0,source:'native',text:'CQU mixed notice first page',markdown:'CQU mixed notice first page'},
        {index:1,source:'ocr',text:'已付费 MVP 结果',markdown:'已付费 MVP 结果'}],createdAt:'2026-10-10T00:00:00.000Z'});
    await f.bucket.put(key,saved);
    for(const version of ['v1','v2']){
      const task=await f.start(version),response=await f.call('/run',{taskId:task.id});
      assert.equal(response.status,200,await response.clone().text());
    }
    const state=await f.state();
    assert.equal(state.calls.length,0,'an already paid PDF must not be sent to the provider again');
    assert.equal(state.outputs.length,2);
    assert.ok(state.outputs.every(output=>output.pages[1].text==='已付费 MVP 结果'));
    assert.equal(await (await f.bucket.get(key)).text(),saved,'MVP evidence remains immutable');
    assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM pdf_ocr_budget').first()).n,0);
  }finally{await f.mf.dispose();}
});

test('potentially paid failures retain evidence and block automatic recharge',async t=>{
  for(const mode of ['timeout','invalid-json','invalid-schema','raw-write'])await t.test(mode,async()=>{
    const f=await fixture();
    try{
      await f.call('/control',{mode});
      const task=await f.start();
      assert.equal((await f.call('/run',{taskId:task.id})).status,500);
      const state=await f.state();
      assert.equal(state.tasks[0].state,'blocked');
      assert.match(state.tasks[0].last_error,/review required/i);
      const keys=(await f.bucket.list()).objects.map(object=>object.key);
      assert.ok(keys.some(key=>key.endsWith('.request.json')));
      if(mode.startsWith('invalid-')){
        const rawKey=keys.find(key=>key.endsWith('.raw.json'));
        assert.ok(rawKey,'raw response survives even when JSON/schema parsing fails');
        if(mode==='invalid-json')assert.equal(await (await f.bucket.get(rawKey)).text(),'charged but incomplete JSON');
      }
      // Losing the D1 cache row or changing the projection version cannot erase R2 billing evidence.
      await f.db.prepare('DELETE FROM pdf_ocr_calls').run();
      await f.call('/control',{mode:'normal'});
      const retry=await f.start('v2');
      assert.equal((await f.call('/run',{taskId:retry.id})).status,500);
      assert.equal((await f.state()).calls.length,1);
    }finally{await f.mf.dispose();}
  });
});

test('formal OCR repairs a normalized-write failure from durable raw data without another upload',async()=>{
  const f=await fixture();
  try{
    await f.call('/control',{mode:'result-write'});
    const first=await f.start();
    assert.equal((await f.call('/run',{taskId:first.id})).status,500);
    assert.equal((await f.state()).tasks[0].state,'blocked');
    await f.call('/control',{mode:'normal'});
    const repaired=await f.start('v2');
    const response=await f.call('/run',{taskId:repaired.id});
    assert.equal(response.status,200,await response.clone().text());
    const state=await f.state();
    assert.equal(state.calls.length,1);
    assert.equal(state.outputs[0].pages[1].text,'TextIn 扫描正文');
  }finally{await f.mf.dispose();}
});

test('a queued TextIn descriptor cannot silently switch its paid request configuration',async()=>{
  const f=await fixture();
  try{
    const task=await f.start(),payload=JSON.parse(task.payload_json);
    payload.options.requestConfig.config.engine_params.parse_mode='scan';
    await f.db.prepare('UPDATE tasks SET payload_json=? WHERE id=?').bind(JSON.stringify(payload),task.id).run();
    const response=await f.call('/run',{taskId:task.id});
    assert.equal(response.status,500);
    assert.match((await response.json()).error,/configuration|identity/i);
    assert.equal((await f.state()).calls.length,0);
  }finally{await f.mf.dispose();}
});

test('concurrent formal and MVP jobs share the paid-request lease and cache',async()=>{
  const f=await fixture();
  let running;
  try{
    await f.db.prepare("INSERT INTO sources(id,name,url) VALUES ('jwc','教务处','https://jwc.cqu.edu.cn')").run();
    await f.db.prepare("INSERT INTO articles(id,source_id,url,title,published_at,discovered_at,body_text) VALUES ('legacy','jwc','https://jwc.cqu.edu.cn/legacy','Legacy','unknown','2026-10-10','')").run();
    await f.db.prepare("INSERT INTO attachments(id,article_id,name,original_url,filename,object_key,sha256,status,role) VALUES ('legacy-pdf','legacy','正文','https://jwc.cqu.edu.cn/original.pdf','original.pdf','original.pdf',?,'complete','body-pdf')").bind(f.hash).run();
    await f.call('/control',{mode:'held'});
    const first=await f.start();
    running=f.call('/run',{taskId:first.id});
    for(let count=0;count<100&&(await f.state()).calls.length===0;count++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal((await f.state()).calls.length,1,'first workflow reached provider');
    const second=await f.start('v2');
    assert.equal((await f.call('/run',{taskId:second.id})).status,500);
    assert.equal((await f.state()).tasks.find(task=>task.id===second.id).state,'deferred');
    const legacy=await (await f.call('/legacy-start',{})).json();
    await f.call('/legacy-run',{jobId:legacy.jobs[0].id});
    assert.equal((await f.db.prepare('SELECT status FROM pdf_ocr_jobs').first()).status,'deferred_busy');
    await f.call('/control',{mode:'normal'});
    assert.equal((await running).status,200);
    await f.call('/legacy-run',{jobId:legacy.jobs[0].id});
    assert.equal((await f.db.prepare('SELECT status FROM pdf_ocr_jobs').first()).status,'complete');
    assert.equal((await f.state()).calls.length,1);
  }finally{await f.call('/control',{mode:'normal'});await running;await f.mf.dispose();}
});

async function fixture({credentials=true}={}){
  const bundle=await build({stdin:{contents:`
    import {ArchiveOcrWorkflow,ocrTaskStatements,withOcrIdentity} from './worker/archive-ocr.mjs';
    import {PdfOcrWorkflow,enqueuePdfOcr} from './worker/pdf-ocr.mjs';
    let calls=[],mode='normal',release;
    globalThis.fetch=async(url,options)=>{
      if(String(url)!=='https://api.textin.com/api/v1/xparse/parse/sync')throw new Error('Unexpected external request');
      calls.push({url:String(url),config:JSON.parse(options.body.get('config'))});
      if(mode==='held')await new Promise(resolve=>{release=resolve});
      if(mode==='timeout')throw new Error('TextIn response timed out after upload');
      if(mode==='invalid-json')return new Response('charged but incomplete JSON');
      if(mode==='invalid-schema')return Response.json({code:200,data:{schema_version:'1.4.0'}});
      return Response.json({code:200,data:{schema_version:'1.4.0',success_count:1,metadata:{page_count:2},
        pages:[{page_number:2,status:'Success',element_ids:['text']}],
        elements:[{element_id:'text',page_number:2,type:'NarrativeText',text:'TextIn 扫描正文',metadata:{}}]}});
    };
    const step={async do(name,options,fn){return (typeof options==='function'?options:fn)();}};
    export default{async fetch(request,raw){try{
      const archive=new Proxy(raw.ARCHIVE,{get(target,key){
        if(key==='put')return async(key,value,options)=>{
          if(mode==='raw-write'&&key.endsWith('.raw.json'))throw new Error('Controlled raw persistence failure');
          if(mode==='result-write'&&/ocr-[0-9-]+[.]json$/.test(key))throw new Error('Controlled normalized persistence failure');
          return target.put(key,value,options);
        };
        const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
      }});
      const env={...raw,ARCHIVE:archive,PDF_OCR:{async create(){return {id:'fixture-launch'}}}};
      const url=new URL(request.url),body=request.method==='POST'?await request.json():{};
      if(url.pathname==='/control'){mode=body.mode;release?.();return new Response('ok');}
      if(url.pathname==='/legacy-start')return Response.json(await enqueuePdfOcr(env,'legacy'));
      if(url.pathname==='/legacy-run')return Response.json(await new PdfOcrWorkflow(env).run({payload:body},step));
      if(url.pathname==='/start'){
        const row=await withOcrIdentity({...env,ARCHIVE_OCR_PROCESSOR_VERSION:body.version??'v1'},{kind:'body_ocr',inputHash:body.hash});
        await env.DB.batch(await ocrTaskStatements(env,row,Date.now()));
        const task=await env.DB.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 1').first();
        await env.DB.prepare("UPDATE tasks SET state='starting' WHERE id=?").bind(task.id).run();
        await env.DB.prepare("INSERT INTO task_attempts(task_id,attempt_no,workflow_instance_id,state,started_at) VALUES (?,1,?,'starting',?) ON CONFLICT(task_id,attempt_no) DO UPDATE SET state='starting'")
          .bind(task.id,'task-'+task.id+'-a1',Date.now()).run();
        return Response.json(task);
      }
      if(url.pathname==='/run')return Response.json(await new ArchiveOcrWorkflow(env).run({instanceId:'task-'+body.taskId+'-a1',payload:{taskId:body.taskId,attempt:1}},step));
      if(url.pathname==='/state'){
        const tasks=(await env.DB.prepare('SELECT id,state,last_error,payload_json FROM tasks').all()).results;
        const derived=(await env.DB.prepare('SELECT d.*,o.r2_key FROM derived_outputs d JOIN artifact_objects o ON o.sha256=d.result_hash').all()).results;
        const outputs=await Promise.all(derived.map(async row=>(await env.ARCHIVE.get(row.r2_key)).json()));
        return Response.json({calls,tasks,derived,outputs});
      }
      return new Response('missing',{status:404});
    }catch(error){return Response.json({error:error.message},{status:500});}}};
  `,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser',external:['node:*'],plugins:[{
    name:'workflow-platform',setup(b){
      b.onResolve({filter:/^cloudflare:workers$/},()=>({path:'platform',namespace:'platform'}));
      b.onLoad({filter:/.*/,namespace:'platform'},()=>({contents:'export class WorkflowEntrypoint{constructor(env){this.env=env}}',loader:'js'}));
    },
  }]});
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,
    compatibilityDate:'2026-10-11',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['ARCHIVE'],
    bindings:{...(credentials?{TEXTIN_APP_ID:'fixture-id',TEXTIN_SECRET_CODE:'fixture-secret'}:{}),MAX_PDF_OCR_PAGES_PER_DAY:'100'}}));
  try{
    const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('ARCHIVE');
    for(const file of (await readdir('migrations')).filter(name=>name.endsWith('.sql')).sort()){
      const sql=await readFile('migrations/'+file,'utf8');
      for(const statement of sql.split(/;\s*\n(?=CREATE|ALTER|PRAGMA|$)/).map(s=>s.trim()).filter(Boolean)){
        if(!/^PRAGMA\b/i.test(statement))await db.prepare(statement).run();
      }
    }
    const bytes=Buffer.from(mixedPdf()),hash=createHash('sha256').update(bytes).digest('hex'),key='original.pdf';
    await bucket.put(key,bytes);
    await db.prepare('INSERT INTO artifact_objects(sha256,r2_key,byte_size,media_type,verified_at) VALUES (?,?,?,?,?)')
      .bind(hash,key,bytes.length,'application/pdf',Date.now()).run();
    const call=(path,body)=>mf.dispatchFetch('https://feed.test'+path,body?{method:'POST',body:JSON.stringify(body)}:{});
    return {mf,db,bucket,hash,call,start:async(version='v1')=>(await call('/start',{hash,version})).json(),state:async()=>(await call('/state')).json()};
  }catch(error){await mf.dispose();throw error;}
}
