import {test} from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

const articleId='1234567890abcdef12345678';
const articleUrl='https://jwc.cqu.edu.cn/info/1082/1.htm';

const workerStubPlugin={
  name:'archive-worker-stub',
  setup(buildApi){
    buildApi.onResolve({filter:/^cloudflare:workers$/},()=>({path:'cloudflare-workers',namespace:'archive-worker-stub'}));
    buildApi.onLoad({filter:/.*/,namespace:'archive-worker-stub'},()=>({
      loader:'js',
      contents:'export class WorkflowEntrypoint{constructor(env={}){this.env=env;}}',
    }));
  },
};

async function fixture(){
  const bundle=await build({
    stdin:{
      contents:`
        import {apiRoute} from './worker/api.mjs';
        import {createArchive} from './worker/archive.mjs';
        import {createCollector} from './worker/collect.mjs';
        import {bridgeRoute} from './worker/bridge.mjs';

        const base64=value=>btoa(String.fromCharCode(...new TextEncoder().encode(value)));
        const pdf='%PDF-1.7\\n测试附件';
        const snapshot='<html><body><main><h1>通知正文</h1><p>中文归档正文</p></main></body></html>';
        const attachmentUrl='https://jwc.cqu.edu.cn/system/_content/download.jsp?urltype=1501&file.pdf';
        const uploadUrl='https://jwc.cqu.edu.cn/system/_content/download.jsp?urltype=1501&large.zip';
        const uploadedBytes=Buffer.alloc(2*1024*1024+17,42);uploadedBytes.set([0x50,0x4b,0x03,0x04]);
        const page={
          bodyRecognized:true,
          page:{url:${JSON.stringify(articleUrl)}},
          bodyText:'中文归档正文',
          errors:[],
          artifacts:[
            {name:'attachment-1.pdf',base64:base64(pdf),contentType:'application/pdf'},
            {name:'snapshot.html',base64:base64(snapshot),contentType:'text/html; charset=utf-8'},
            {name:'offline.html',base64:base64(snapshot),contentType:'text/html; charset=utf-8'},
          ],
          attachmentCandidates:[
            {url:attachmentUrl,name:'通知附件.pdf',role:'attachment'},
          ],
          downloads:[
            {url:attachmentUrl,originalFile:true,saved:{name:'attachment-1.pdf'}},
          ],
        };
        globalThis.SCRAPE_CALLS=[];
        globalThis.HOLD_SCRAPE=false;
        const scrape=async(env,url,options)=>{
          globalThis.SCRAPE_CALLS.push({url:${JSON.stringify(articleUrl)}});
          while(globalThis.HOLD_SCRAPE)await new Promise(resolve=>setTimeout(resolve,10));
          const uploadCapture=globalThis.UPLOAD_CAPTURE===true;
          if(uploadCapture){
            const match=options.actions[0].script.match(/"bridgeURL":"([^"]+)"/);
            const token=new URL(match[1]).searchParams.get('grant');
            const response=await bridgeRoute(new Request('https://feed.test/internal/upload',{
              method:'POST',headers:{Origin:'https://feed.test','X-Grant':token,
                'X-Filename':'attachment-2.zip','Content-Length':String(uploadedBytes.length)},body:uploadedBytes,
            }),env);
            if(!response.ok)throw new Error(await response.text());
          }
          const uploadPage=uploadCapture?{
            ...page,
            attachmentCandidates:[...page.attachmentCandidates,{url:uploadUrl,name:'大型附件.zip',role:'attachment'}],
            downloads:[...page.downloads,{url:uploadUrl,originalFile:true,kind:'zip',
              saved:{name:'attachment-2.zip',uploaded:true,bytes:uploadedBytes.length}}],
          }:page;
          await new Promise(resolve=>setTimeout(resolve,30));
          return {
            markdown:'中文归档正文',
            rawHtml:snapshot,
            screenshot:{contentType:'image/png',base64:'iVBORw0KGgo='},
            metadata:{statusCode:200,creditsUsed:1,proxyUsed:true},
            actions:{javascriptReturns:[{value:JSON.stringify(uploadPage)}]},
          };
        };

        export default {
          async fetch(request,env){
            const url=new URL(request.url);
            if(['/capture','/capture-uploaded'].includes(url.pathname)){
              globalThis.UPLOAD_CAPTURE=url.pathname==='/capture-uploaded';
              const archive=createArchive(env,{collector:createCollector({scrape})});
              const article={id:${JSON.stringify(articleId)},url:${JSON.stringify(articleUrl)},title:'并发采集通知'};
              const source={id:'jwc',siteId:'7fd03676e5751e9b6dd95ecb',name:'教务处',url:'https://jwc.cqu.edu.cn/'};
              if(url.pathname==='/capture-uploaded')return Response.json(await archive.capture(source,article));
              return Response.json(await Promise.all([
                archive.capture(source,article),
                archive.capture(source,article),
              ]));
            }
            if(url.pathname==='/capture-task'){
              const archive=createArchive(env,{collector:createCollector({scrape})});
              return Response.json(await archive.captureTask(url.searchParams.get('taskId'),Number(url.searchParams.get('attempt'))));
            }
            if(url.pathname==='/scrape-control'){
              if(request.method==='POST'){
                const body=await request.json();
                globalThis.HOLD_SCRAPE=body.hold;
              }
              return Response.json({hold:globalThis.HOLD_SCRAPE});
            }
            if(url.pathname==='/external-calls')return Response.json({calls:globalThis.SCRAPE_CALLS});
            return apiRoute(request,env);
          },
        }
      `,
      resolveDir:process.cwd(),
      sourcefile:'archive-fixture.mjs',
    },
    bundle:true,
    write:false,
    format:'esm',
    platform:'browser',
    external:['node:buffer','node:*'],
    plugins:[workerStubPlugin],
  });
  const mf=new Miniflare(convertV4MiniflareOptions({
    modules:true,
    script:bundle.outputFiles[0].text,
    compatibilityDate:'2026-10-11',
    compatibilityFlags:['nodejs_compat'],
    bindings:{BASE_URL:'https://feed.test',BRIDGE_SECRET:'test-bridge-secret'},
    d1Databases:['DB'],
    r2Buckets:['ARCHIVE'],
  }));
  const db=await mf.getD1Database('DB');
  for(const name of ['0001_feed.sql','0003_collection_lease.sql','0004_pdf_ocr.sql','0005_task_runtime.sql']){
    await applyMigration(db,await readFile(`migrations/${name}`,'utf8'));
  }
  await db.prepare("INSERT INTO sources(id,name,url) VALUES ('jwc','教务处','https://jwc.cqu.edu.cn/')").run();
  await db.prepare("INSERT INTO articles(id,source_id,url,title,published_at,discovered_at,status,attempts,lease_until) VALUES (?,'jwc',?,?,'2026-01-03','2026-01-01','pending',0,0)")
    .bind(articleId,articleUrl,'并发采集通知').run();
  const bucket=await mf.getR2Bucket('ARCHIVE');
  return {mf,db,bucket};
}

test('concurrent Archive captures use one external scrape and feed the reading API',async()=>{
  const {mf}=await fixture();
  try{
    const capture=await mf.dispatchFetch('https://feed.test/capture');
    if(!capture.ok)assert.fail(await capture.text());
    const results=await capture.json();
    assert.equal(results.filter(result=>result.skipped).length,1);
    assert.equal(results.filter(result=>result.status==='complete').length,1);
    assert.deepEqual(await(await mf.dispatchFetch('https://feed.test/external-calls')).json(),{
      calls:[{url:articleUrl}],
    });

    const search=await(await mf.dispatchFetch('https://feed.test/api/articles?'+new URLSearchParams({q:'中文归档'}))).json();
    assert.deepEqual(search.articles.map(article=>article.id),[articleId]);
    const detail=await(await mf.dispatchFetch(`https://feed.test/api/articles/${articleId}`)).json();
    assert.equal(detail.article.title,'并发采集通知');
    assert.equal(detail.article.bodyText,'中文归档正文');
    assert.equal(detail.attachments[0].filename,'attachment-1.pdf');

    const file=await mf.dispatchFetch(`https://feed.test/api/files/${articleId}/attachment-1.pdf`,{headers:{Range:'bytes=0-4'}});
    assert.equal(file.status,206);
    assert.equal(await file.text(),'%PDF-');
    const snapshot=await mf.dispatchFetch(`https://feed.test/api/snapshots/${articleId}`);
    assert.equal(snapshot.status,200);
    assert.match(await snapshot.text(),/中文归档正文/);
  }finally{
    await mf.dispose();
  }
});

test('a signed upload is adopted by Archive and served as the exact original bytes',async()=>{
  const {mf,db,bucket}=await fixture();
  try{
    const capture=await mf.dispatchFetch('https://feed.test/capture-uploaded');
    const result=await capture.json();
    if(!capture.ok)assert.fail(JSON.stringify(result));
    assert.deepEqual(result,{id:articleId,status:'complete',attachments:2,downloaded:2});

    const rows=await db.prepare('SELECT filename,object_key,bytes,content_type,sha256,status FROM attachments WHERE article_id=? ORDER BY id')
      .bind(articleId).all();
    assert.deepEqual(rows.results.map(row=>({filename:row.filename,bytes:row.bytes,status:row.status})),[
      {filename:'attachment-1.pdf',bytes:Buffer.from('%PDF-1.7\n测试附件').length,status:'complete'},
      {filename:'attachment-2.zip',bytes:2*1024*1024+17,status:'complete'},
    ]);
    assert.equal(rows.results[1].content_type,'application/octet-stream');
    assert.equal(rows.results[1].sha256,createHash('sha256').update(Buffer.concat([Buffer.from([0x50,0x4b,0x03,0x04]),Buffer.alloc(2*1024*1024+13,42)])).digest('hex'));
    const immutable=await bucket.get(rows.results[1].object_key);
    assert.equal(immutable.size,2*1024*1024+17);
    assert.equal(immutable.httpMetadata?.contentType,'application/octet-stream');
    assert.equal((await immutable.arrayBuffer()).byteLength,2*1024*1024+17);
    const original=await mf.dispatchFetch(`https://feed.test/api/files/${articleId}/attachment-2.zip`,{
      headers:{Range:'bytes=0-3'},
    });
    assert.equal(original.status,206);
    assert.equal(await original.text(),'PK\x03\x04');
  }finally{
    await mf.dispose();
  }
});

test('an expired task attempt cannot claim the article or start an external scrape',async()=>{
  const {mf,db}=await fixture();
  try{
    const taskId='1234567890abcdef12345678',now=Date.now();
    await db.prepare(`INSERT INTO tasks(id,kind,business_key,source_id,article_id,state,due_at,attempt_no,created_at,updated_at)
      VALUES (?,'capture',?,'jwc',?,'running',?,2,?,?)`)
      .bind(taskId,`capture:${articleId}:stale`,articleId,now,now,now).run();
    await db.prepare(`INSERT INTO task_attempts(task_id,attempt_no,workflow_instance_id,state,started_at)
      VALUES (?,1,?,'running',?),(?,2,?,'running',?)`)
      .bind(taskId,`task-${taskId}-a1`,now,taskId,`task-${taskId}-a2`,now).run();

    const result=await(await mf.dispatchFetch(`https://feed.test/capture-task?taskId=${taskId}&attempt=1`)).json();
    assert.deepEqual(result,{superseded:true});
    assert.deepEqual(await(await mf.dispatchFetch('https://feed.test/external-calls')).json(),{calls:[]});
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM attachments').first()).n,0);
    assert.equal((await db.prepare('SELECT status FROM articles WHERE id=?').bind(articleId).first()).status,'pending');
    const attempts=await db.prepare('SELECT attempt_no,state,result_json FROM task_attempts WHERE task_id=? ORDER BY attempt_no')
      .bind(taskId).all();
    assert.deepEqual(attempts.results.map(row=>[row.attempt_no,row.state,row.result_json]),[
      [1,'running',null],
      [2,'running',null],
    ]);
  }finally{
    await mf.dispose();
  }
});

test('a stale capture fence can leave temporary R2 objects but cannot publish attachment article or task receipt',async()=>{
  const {mf,db,bucket}=await fixture();
  try{
    const taskId='1234567890abcdef12345678',now=Date.now();
    await db.prepare(`INSERT INTO tasks(id,kind,business_key,source_id,article_id,state,due_at,attempt_no,created_at,updated_at)
      VALUES (?,'capture',?,'jwc',?,'running',?,1,?,?)`)
      .bind(taskId,`capture:${articleId}:fence`,articleId,now,now,now).run();
    await db.prepare(`INSERT INTO task_attempts(task_id,attempt_no,workflow_instance_id,state,started_at)
      VALUES (?,1,?,'running',?)`).bind(taskId,`task-${taskId}-a1`,now).run();
    await mf.dispatchFetch('https://feed.test/scrape-control',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({hold:true}),
    });
    const capturePromise=mf.dispatchFetch(`https://feed.test/capture-task?taskId=${taskId}&attempt=1`);
    await waitFor(async()=>{
      assert.equal((await(await mf.dispatchFetch('https://feed.test/external-calls')).json()).calls.length,1);
    });
    await db.prepare('UPDATE articles SET capture_fence=capture_fence+1 WHERE id=?').bind(articleId).run();
    await mf.dispatchFetch('https://feed.test/scrape-control',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({hold:false}),
    });
    const response=await capturePromise;
    const result=await response.json();
    assert.match(result.error,/Capture fence expired/);

    const article=await db.prepare('SELECT status,prefix,body_text,capture_fence FROM articles WHERE id=?')
      .bind(articleId).first();
    assert.equal(article.prefix,null);
    assert.equal(article.body_text,'');
    assert.equal(article.capture_fence,2);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM attachments').first()).n,0);
    const attempt=await db.prepare('SELECT state,result_json FROM task_attempts WHERE task_id=? AND attempt_no=1')
      .bind(taskId).first();
    assert.equal(attempt.state,'running');
    assert.equal(attempt.result_json,null);
    assert.ok((await bucket.list()).objects.length>0,'The collector must reach its post-R2 atomic D1 guard');
  }finally{
    await mf.dispose();
  }
});

async function applyMigration(db,sql){
  const statements=sql.split(/;\s*\n(?=CREATE|ALTER|PRAGMA|$)/)
    .map(statement=>statement.trim())
    .filter(statement=>statement&&!/^PRAGMA\b/i.test(statement));
  for(const statement of statements)await db.prepare(statement).run();
}

async function waitFor(check){
  let lastError;
  for(let i=0;i<80;i++){
    try{
      await check();
      return;
    }catch(error){
      lastError=error;
      await new Promise(resolve=>setTimeout(resolve,25));
    }
  }
  throw lastError;
}
