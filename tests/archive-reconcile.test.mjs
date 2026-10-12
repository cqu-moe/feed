import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

const articleId='1234567890abcdef12345678';
const articleUrl='https://jwc.cqu.edu.cn/info/1082/1.htm';
const taskId='abcdefabcdefabcdef123456';

const workerStubPlugin={
  name:'archive-reconcile-worker-stub',
  setup(buildApi){
    buildApi.onResolve({filter:/^cloudflare:workers$/},()=>({path:'cloudflare-workers',namespace:'archive-reconcile-stub'}));
    buildApi.onLoad({filter:/.*/,namespace:'archive-reconcile-stub'},()=>({
      loader:'js',
      contents:'export class WorkflowEntrypoint{constructor(env={}){this.env=env;}}',
    }));
  },
};

test('only Archive reconcile publishes a complete no-OCR revision and one stable event',async()=>{
  const bundle=await build({
    stdin:{
      contents:`
        import {createArchive} from './worker/archive.mjs';
        import {createCollector} from './worker/collect.mjs';
        const base64=value=>btoa(String.fromCharCode(...new TextEncoder().encode(value)));
        const snapshot='<html><body><main><h1>统一发布通知</h1><p>完整正文</p></main></body></html>';
        const attachmentUrl='https://jwc.cqu.edu.cn/system/_content/download.jsp?urltype=1501&file.pdf';
        const page={
          bodyRecognized:true,page:{url:${JSON.stringify(articleUrl)}},bodyText:'完整正文',errors:[],
          artifacts:[
            {name:'attachment-1.pdf',base64:base64('%PDF-1.7\\n普通附件'),contentType:'application/pdf'},
            {name:'snapshot.html',base64:base64(snapshot),contentType:'text/html; charset=utf-8'},
            {name:'offline.html',base64:base64(snapshot),contentType:'text/html; charset=utf-8'},
          ],
          attachmentCandidates:[{url:attachmentUrl,name:'普通附件.pdf',role:'attachment'}],
          downloads:[{url:attachmentUrl,originalFile:true,saved:{name:'attachment-1.pdf'},fetchedAt:new Date().toISOString()}],
        };
        const scrape=async()=>({markdown:'完整正文',rawHtml:snapshot,metadata:{statusCode:200,creditsUsed:1},
          actions:{javascriptReturns:[{value:JSON.stringify(page)}]}});
        async function inspect(env,revisionId){
          const [revision,readModel,event,eventSources,outbox]=await Promise.all([
            env.DB.prepare('SELECT id,state,ready_at FROM article_revisions WHERE id=?').bind(revisionId).first(),
            env.DB.prepare('SELECT readable_text FROM article_read_models WHERE article_id=?').bind(${JSON.stringify(articleId)}).first(),
            env.DB.prepare('SELECT id,revision_id,kind,history_only,date_state FROM content_events WHERE revision_id=?').bind(revisionId).first(),
            env.DB.prepare('SELECT event_id,source_id,discovery_class,date_precision FROM event_sources ORDER BY source_id').all(),
            env.DB.prepare("SELECT topic,dedupe_key,payload_json FROM outbox ORDER BY dedupe_key").all(),
          ]);
          return {revision,readModel,event,eventSources:eventSources.results,outbox:outbox.results};
        }
        export default{
          async fetch(request,env){
            try{
              const url=new URL(request.url);
              const archive=createArchive(env,{collector:createCollector({scrape})});
              if(url.pathname==='/capture')return Response.json(await archive.captureTask(${JSON.stringify(taskId)},1));
              if(url.pathname==='/reconcile'){
                const revisionId=url.searchParams.get('revisionId');
                if(!/^[a-f0-9]{24}$/.test(revisionId??''))return Response.json({error:'Invalid revision id'},400);
                return Response.json(await archive.reconcileRevision(revisionId));
              }
              if(url.pathname==='/inspect'){
                const revisionId=url.searchParams.get('revisionId');
                if(!/^[a-f0-9]{24}$/.test(revisionId??''))return Response.json({error:'Invalid revision id'},400);
                return Response.json(await inspect(env,revisionId));
              }
              return new Response('Not found',{status:404});
            }catch(error){
              return Response.json({error:String(error?.message??error),stack:String(error?.stack??'')},{status:500});
            }
          }
        }
      `,
      resolveDir:process.cwd(),sourcefile:'archive-reconcile-fixture.mjs',
    },
    bundle:true,write:false,format:'esm',platform:'browser',external:['node:buffer','node:*'],plugins:[workerStubPlugin],
  });
  const mf=new Miniflare(convertV4MiniflareOptions({
    modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-11',compatibilityFlags:['nodejs_compat'],
    bindings:{BASE_URL:'https://feed.test',BRIDGE_SECRET:'test-bridge-secret',ARCHIVE_VERSIONS_ENABLED:'true'},
    d1Databases:['DB'],r2Buckets:['ARCHIVE'],
  }));
  try{
    const db=await mf.getD1Database('DB');
    for(const name of ['0001_feed.sql','0003_collection_lease.sql','0004_pdf_ocr.sql','0005_task_runtime.sql','0006_sources.sql','0007_archive_versions.sql','0008_content_events.sql']){
      await applyMigration(db,await readFile(`migrations/${name}`,'utf8'));
    }
    const now=Date.now();
    await db.prepare("INSERT INTO sources(id,name,url) VALUES ('jwc','教务处','https://jwc.cqu.edu.cn/')").run();
    await db.prepare(`INSERT INTO articles(id,source_id,url,title,published_at,discovered_at,status,attempts,lease_until)
      VALUES (?,'jwc',?,?,'2026-01-03','2026-01-01','pending',0,0)`).bind(articleId,articleUrl,'统一发布通知').run();
    await db.prepare(`INSERT INTO tasks(id,kind,business_key,source_id,article_id,payload_json,state,due_at,attempt_no,created_at,updated_at)
      VALUES (?,'capture',?, 'jwc',?,'{}','running',?,1,?,?)`)
      .bind(taskId,`capture:${articleId}:reconcile`,articleId,now,now,now).run();
    await db.prepare(`INSERT INTO task_attempts(task_id,attempt_no,workflow_instance_id,state,started_at)
      VALUES (?,1,?,'running',?)`).bind(taskId,`task-${taskId}-a1`,now).run();

    const captured=await(await mf.dispatchFetch('https://feed.test/capture')).json();
    assert.deepEqual({revisionState:captured.revisionState,status:captured.status,outcome:captured.outcome},
      {revisionState:'assembling',status:'partial',outcome:'new'});
    let state=await(await mf.dispatchFetch('https://feed.test/inspect?revisionId='+captured.revisionId)).json();
    assert.equal(state.revision.state,'assembling');
    assert.equal(state.readModel,null);
    const readyMessage=JSON.parse(state.outbox[0].payload_json);
    assert.deepEqual({...readyMessage,outboxId:'x'.repeat(readyMessage.outboxId.length)},
      {v:1,type:'check-ready',outboxId:'x'.repeat(24),revisionId:captured.revisionId,generation:1});

    const first=await(await mf.dispatchFetch('https://feed.test/reconcile?revisionId='+captured.revisionId)).json();
    assert.deepEqual(first,{state:'ready',eventCreated:true});
    state=await(await mf.dispatchFetch('https://feed.test/inspect?revisionId='+captured.revisionId)).json();
    assert.equal(state.revision.state,'ready');
    assert.ok(state.revision.ready_at);
    assert.equal(state.readModel.readable_text,'完整正文');
    assert.deepEqual({...state.event,revision_id:captured.revisionId},
      {id:state.event.id,revision_id:captured.revisionId,kind:'initial',history_only:0,date_state:'verified'});
    assert.deepEqual(state.eventSources,[{event_id:state.event.id,source_id:'jwc',discovery_class:'live',date_precision:'day'}]);
    assert.equal(new Set(state.outbox.map(row=>row.dedupe_key)).size,2);

    const second=await(await mf.dispatchFetch('https://feed.test/reconcile?revisionId='+captured.revisionId)).json();
    assert.deepEqual(second,{state:'ready',eventCreated:false});
    state=await(await mf.dispatchFetch('https://feed.test/inspect?revisionId='+captured.revisionId)).json();
    assert.equal(state.outbox.length,2);
  }finally{
    await mf.dispose();
  }
});

async function applyMigration(db,sql){
  for(const statement of sql.split(/;\s*\n(?=CREATE|ALTER|PRAGMA|$)/).map(value=>value.trim()).filter(Boolean)){
    if(!/^PRAGMA\b/i.test(statement))await db.prepare(statement).run();
  }
}

test('content events preserve observation order, capture intent, source dates, and suppress presentation changes',async()=>{
  const bundle=await build({
    stdin:{contents:`
      import {reconcileRevision} from './worker/archive-reconcile.mjs';
      import {readRevision} from './worker/archive-versions.mjs';
      let raceNextBatch=false;
      function racingDb(db,revisionId){
        return new Proxy(db,{get(target,key){
          if(key!=='batch')return Reflect.get(target,key,target);
          return async(...statements)=>{
            if(raceNextBatch){
              raceNextBatch=false;
              await target.prepare('UPDATE article_revisions SET requirement_generation=requirement_generation+1 WHERE id=?').bind(revisionId).run();
            }
            return target.batch(...statements);
          };
        }});
      }
      export default{
        async fetch(request,env){
          try{
            const url=new URL(request.url);
            if(url.pathname==='/reconcile'){
              const revisionId=url.searchParams.get('revisionId');
              if(url.searchParams.get('race')==='1'){
                raceNextBatch=true;
                return Response.json(await reconcileRevision({...env,DB:racingDb(env.DB,revisionId)},revisionId));
              }
              return Response.json(await reconcileRevision(env,revisionId));
            }
            if(url.pathname==='/read')return Response.json(await readRevision(env,url.searchParams.get('articleId'),url.searchParams.get('revisionId')));
            return new Response('Not found',{status:404});
          }catch(error){
            return Response.json({error:String(error?.message??error)},{status:500});
          }
        }
      }
    `,resolveDir:process.cwd(),sourcefile:'archive-event-classification-fixture.mjs'},
    bundle:true,write:false,format:'esm',platform:'browser',external:['node:buffer','node:*'],plugins:[workerStubPlugin],
  });
  const mf=new Miniflare(convertV4MiniflareOptions({
    modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-11',compatibilityFlags:['nodejs_compat'],
    d1Databases:['DB'],r2Buckets:['ARCHIVE'],
  }));
  try{
    const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('ARCHIVE');
    for(const name of ['0001_feed.sql','0003_collection_lease.sql','0004_pdf_ocr.sql','0005_task_runtime.sql','0006_sources.sql','0007_archive_versions.sql','0008_content_events.sql']){
      await applyMigration(db,await readFile(`migrations/${name}`,'utf8'));
    }
    await db.prepare("INSERT INTO sources(id,name,url) VALUES ('jwc','教务处','https://jwc.cqu.edu.cn/')").run();
    await db.prepare("INSERT INTO sources(id,name,url) VALUES ('news','新闻网','https://news.cqu.edu.cn/')").run();

    const historyArticle='aaaaaaaaaaaaaaaaaaaaaaaa',unknownArticle='bbbbbbbbbbbbbbbbbbbbbbbb',raceArticle='cccccccccccccccccccccccc';
    await db.prepare(`INSERT INTO articles(id,source_id,url,title,published_at,discovered_at,status,attempts,lease_until)
      VALUES (?,'jwc','https://jwc.cqu.edu.cn/a','历史文章','2026-01-01','2026-01-02','pending',0,0)`).bind(historyArticle).run();
    await db.prepare(`INSERT INTO article_sources(article_id,source_id,first_seen_at,last_seen_at,discovery_class,published_at,published_day,date_precision,source_timezone)
      VALUES (?,'jwc',1,1,'backfill','2026-01-01T09:00:00+08:00','2026-01-01','minute','Asia/Shanghai'),
      (?,'news',2,2,'migrated',NULL,'2026-01-02','day','Asia/Shanghai')`).bind(historyArticle,historyArticle).run();
    await db.prepare(`INSERT INTO articles(id,source_id,url,title,published_at,discovered_at,status,attempts,lease_until)
      VALUES (?,'jwc','https://jwc.cqu.edu.cn/b','未知日期文章','2026-01-03','2026-01-04','pending',0,0)`).bind(unknownArticle).run();
    await db.prepare(`INSERT INTO article_sources(article_id,source_id,first_seen_at,last_seen_at,discovery_class,published_at,published_day,date_precision,source_timezone)
      VALUES (?,'jwc',3,3,'live',NULL,NULL,'unknown','Asia/Shanghai')`).bind(unknownArticle).run();
    await db.prepare(`INSERT INTO articles(id,source_id,url,title,published_at,discovered_at,status,attempts,lease_until)
      VALUES (?,'jwc','https://jwc.cqu.edu.cn/c','并发完整性通知','2026-01-04','2026-01-05','pending',0,0)`).bind(raceArticle).run();
    await db.prepare(`INSERT INTO article_sources(article_id,source_id,first_seen_at,last_seen_at,discovery_class,date_precision,source_timezone)
      VALUES (?,'jwc',4,4,'live','unknown','Asia/Shanghai')`).bind(raceArticle).run();

    const baseline=await seedRevision({db,bucket,articleId:historyArticle,taskId:'c10000000000000000000001',revisionId:'d10000000000000000000001',
      revisionNo:1,title:'历史文章',body:'历史基线正文',intent:'backfill',changeKind:'baseline',semantic:'baseline'});
    const changed=await seedRevision({db,bucket,articleId:historyArticle,taskId:'c10000000000000000000002',revisionId:'d10000000000000000000002',
      revisionNo:2,title:'历史文章',body:'实质修改后的 live 正文',intent:'live',changeKind:'substantive',semantic:'changed',previousId:baseline.revisionId});
    const presentation=await seedRevision({db,bucket,articleId:historyArticle,taskId:'c10000000000000000000003',revisionId:'d10000000000000000000003',
      revisionNo:3,title:'历史文章',body:'实质修改后的 live 正文\n排版变化',intent:'live',changeKind:'presentation_only',semantic:'changed',previousId:changed.revisionId});
    const unknown=await seedRevision({db,bucket,articleId:unknownArticle,taskId:'c20000000000000000000001',revisionId:'d20000000000000000000001',
      revisionNo:1,title:'未知日期文章',body:'未知日期正文',intent:'live',changeKind:'baseline',semantic:'unknown'});
    const raced=await seedRevision({db,bucket,articleId:raceArticle,taskId:'c30000000000000000000001',revisionId:'d30000000000000000000001',
      revisionNo:1,title:'并发完整性通知',body:'并发完整性正文',intent:'live',changeKind:'baseline',semantic:'race',generation:2});

    await bucket.delete(unknown.snapshotKey);
    const unavailable=await mf.dispatchFetch(`https://feed.test/reconcile?revisionId=${unknown.revisionId}`);
    assert.equal(unavailable.status,500,await unavailable.clone().text());
    assert.match((await unavailable.json()).error,/Immutable object unavailable/);
    const unavailableRead=await(await mf.dispatchFetch(`https://feed.test/read?articleId=${unknownArticle}&revisionId=${unknown.revisionId}`)).json();
    assert.equal(unavailableRead.revision.state,'assembling');
    assert.equal(unavailableRead.article.bodyText,'');
    await bucket.put(unknown.snapshotKey,unknown.snapshotBytes,{
      sha256:unknown.snapshotHash,httpMetadata:{contentType:'text/html; charset=utf-8'},
    });

    assert.deepEqual(await reconcile(mf,baseline.revisionId),{state:'ready',eventCreated:true});
    assert.deepEqual(await reconcile(mf,changed.revisionId),{state:'ready',eventCreated:true});
    assert.deepEqual(await reconcile(mf,presentation.revisionId),{state:'ready',eventCreated:false});
    assert.deepEqual(await reconcile(mf,unknown.revisionId),{state:'ready',eventCreated:true});

    const historyEvents=await db.prepare(`SELECT e.kind,e.history_only,e.date_state
      FROM content_events e JOIN article_revisions r ON r.id=e.revision_id WHERE e.article_id=? ORDER BY r.revision_no`)
      .bind(historyArticle).all();
    assert.deepEqual(historyEvents.results.map(({kind,history_only,date_state})=>({kind,historyOnly:history_only,dateState:date_state})),[
      {kind:'initial',historyOnly:1,dateState:'verified'},
      {kind:'update',historyOnly:0,dateState:'verified'},
    ]);
    const associations=await db.prepare(`SELECT source_id,discovery_class,date_precision FROM event_sources WHERE event_id=(
      SELECT id FROM content_events WHERE revision_id=?) ORDER BY source_id`).bind(baseline.revisionId).all();
    assert.deepEqual(associations.results,[
      {source_id:'jwc',discovery_class:'backfill',date_precision:'minute'},
      {source_id:'news',discovery_class:'migrated',date_precision:'day'},
    ]);
    assert.equal((await db.prepare('SELECT date_state FROM content_events WHERE revision_id=?').bind(unknown.revisionId).first()).date_state,'date_unknown');
    const stale=await mf.dispatchFetch(`https://feed.test/reconcile?revisionId=${raced.revisionId}&race=1`);
    assert.equal(stale.status,500,await stale.clone().text());
    assert.match((await stale.json()).error,/Revision requirements changed before readiness commit/);
    const staleRead=await(await mf.dispatchFetch(`https://feed.test/read?articleId=${raceArticle}&revisionId=${raced.revisionId}`)).json();
    assert.equal(staleRead.revision.state,'assembling');
    assert.equal(staleRead.article.bodyText,'');
    assert.deepEqual(await reconcile(mf,raced.revisionId),{state:'ready',eventCreated:true});
    const racedRead=await(await mf.dispatchFetch(`https://feed.test/read?articleId=${raceArticle}&revisionId=${raced.revisionId}`)).json();
    assert.equal(racedRead.revision.state,'ready');
    assert.match(racedRead.article.bodyText,/并发完整性正文/);
    const read=await(await mf.dispatchFetch(`https://feed.test/read?articleId=${historyArticle}&revisionId=${presentation.revisionId}`)).json();
    assert.equal(read.revision.state,'ready');
    assert.match(read.article.bodyText,/排版变化/);
  }finally{await mf.dispose();}
});

async function reconcile(mf,revisionId){
  const response=await mf.dispatchFetch('https://feed.test/reconcile?revisionId='+revisionId);
  assert.equal(response.status,200,await response.clone().text());
  return response.json();
}

async function seedRevision({db,bucket,articleId,taskId,revisionId,revisionNo,title,body,intent,changeKind,semantic,previousId=null,generation=1}){
  const {createHash}=await import('node:crypto');
  const snapshot=`<html><body><main>${body}</main></body></html>`,manifest={v:1,articleId,taskId,body};
  const rows=[];
  for(const [name,value,type] of [
    ['body.txt',body,'text/plain; charset=utf-8'],
    ['snapshot.html',snapshot,'text/html; charset=utf-8'],
    ['manifest.json',JSON.stringify(manifest),'application/json'],
  ]){
    const bytes=new TextEncoder().encode(value),hash=createHash('sha256').update(bytes).digest('hex'),key=`objects/sha256/${hash.slice(0,2)}/${hash}`;
    await bucket.put(key,bytes,{sha256:hash,httpMetadata:{contentType:type}});
    await db.prepare('INSERT INTO artifact_objects(sha256,r2_key,byte_size,media_type,verified_at) VALUES (?,?,?,?,?)')
      .bind(hash,key,bytes.byteLength,type,1).run();
    rows.push({name,hash});
  }
  const now=Date.now();
  await db.prepare(`INSERT INTO tasks(id,kind,business_key,source_id,article_id,payload_json,state,due_at,attempt_no,created_at,updated_at)
    VALUES (?,'capture',?, 'jwc',?,'{}','succeeded',?,1,?,?)`).bind(taskId,`capture:${articleId}:${taskId}`,articleId,now,now,now).run();
  await db.prepare(`INSERT INTO article_revisions(id,article_id,revision_no,previous_revision_id,capture_task_id,observed_at,state,
      requirement_count,requirement_generation,manifest_object_hash,raw_fingerprint,semantic_fingerprint,change_kind,title,published_at,source_metadata_json,diagnostics_json)
    VALUES (?,?,?,?,?,?,'assembling',2,?,?,?,?,?,?,NULL,?,? )`)
    .bind(revisionId,articleId,revisionNo,previousId,taskId,now,generation,rows[2].hash,`raw-${revisionId}`,`semantic-${semantic}`,changeKind,title,
      JSON.stringify({captureIntent:intent}),'[]').run();
  for(const [slot,kind] of [['body','body'],['snapshot','snapshot']]){
    await db.prepare(`INSERT INTO revision_requirements(revision_id,slot_key,kind,name,required,state,object_hash,fetched_at)
      VALUES (?,?,?,? ,1,'fulfilled',?,?)`).bind(revisionId,slot,kind,slot==='body'?'正文':'原貌存档',
      rows[slot==='body'?0:1].hash,now).run();
  }
  return {revisionId,snapshotKey:`objects/sha256/${rows[1].hash.slice(0,2)}/${rows[1].hash}`,snapshotHash:rows[1].hash,
    snapshotBytes:new TextEncoder().encode(snapshot)};
}
