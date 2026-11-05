import {sha} from './utils.mjs';
import {createBailianClient} from './bailian-client.mjs';
import {buildSearchTags} from './bailian-filters.mjs';
import {loadSearchNotice} from './bailian-projection.mjs';

const writeEnabled=env=>env.BAILIAN_SEARCH_WRITES==='true';
const eligible="(a.latest_ready_revision_id IS NOT NULL OR (a.latest_observed_revision_id IS NULL AND a.status='complete'))";
const retryDelay=n=>Math.min(24*3600_000,300_000*2**Math.min(n,8));
const failure=e=>e?.status===429?'rate_limited':e?.status===401||e?.status===403?'credentials':
  e?.kind==='request'?'configuration':e?.kind==='timeout'?'timeout':
  e?.stage?[e.stage,e.status||e.kind||'failed',e.reason].filter(Boolean).join(':'):'operation_failed';
const noRetry=e=>e?.kind==='request'||(e?.status>=400&&e.status<500&&![408,429].includes(e.status));
const control=(env,sql,...args)=>env.DB.prepare('UPDATE bailian_control SET '+sql+' WHERE id=1').bind(...args).run();
const nowValue=now=>typeof now==='function'?now():now;
export const pauseBailianSync=env=>control(env,'paused=1');
export const resumeBailianSync=env=>control(env,'paused=0');
export const startBailianBackfill=env=>control(env,"cursor=CASE WHEN backfill='done' THEN '' ELSE cursor END,backfill='running'");
export const pauseBailianBackfill=env=>control(env,"backfill='paused'");

// A lost job or registration receipt needs provider-side reconciliation.
export async function retryBailianFailures(env){
  await env.DB.batch([
    env.DB.prepare("UPDATE bailian_notices SET attempts=0,error=NULL,blocked=0,next_at=0 WHERE blocked=1"),
    env.DB.prepare("UPDATE bailian_files SET state='registered',job_id=NULL,blocked=0,error=NULL,next_at=0,attempts=0 WHERE state='failed' AND error='import_failed' AND file_id IS NOT NULL"),
    env.DB.prepare(`UPDATE bailian_files SET attempts=0,blocked=0,next_at=0,error=NULL
      WHERE blocked=1 AND state NOT IN ('failed','submitting') AND error IS NOT 'unconfirmed_receipt'`),
  ]);
}

export async function lookupSearchDocuments(env,fileIds){
  if(!fileIds.length)return [];
  const {results}=await env.DB.prepare(`SELECT f.file_id AS fileId,f.article_id AS articleId,
      f.revision_id AS revisionId,f.filename,f.label,f.slot,f.evidence_key AS evidenceKey
    FROM bailian_files f JOIN bailian_notices n ON n.article_id=f.article_id
    JOIN articles a ON a.id=f.article_id
    WHERE f.file_id IN (SELECT value FROM json_each(?)) AND f.state='ready'
      AND f.generation=n.generation AND n.projected=n.generation AND ${eligible}
      AND f.revision_id IS a.latest_ready_revision_id`).bind(JSON.stringify(fileIds)).all();
  return results;
}

export async function getBailianStatus(env){
  const [settings,inventory,notices,files,cleanup,usage,originals,attention]=await env.DB.batch([
    env.DB.prepare('SELECT paused,backfill,cursor,cooldown_until AS cooldownUntil FROM bailian_control WHERE id=1'),
    env.DB.prepare('SELECT count(*) AS readable FROM articles a WHERE '+eligible),
    env.DB.prepare(`SELECT status,count(*) AS count FROM (SELECT n.article_id,CASE
      WHEN n.blocked=1 OR MAX(COALESCE(f.blocked,0))=1 THEN 'failed'
      WHEN n.projected<>n.generation OR COUNT(f.id)=0 OR SUM(f.state NOT IN ('skipped','ready'))>0 THEN 'pending'
      WHEN SUM(f.state='ready')>0 THEN 'ready' ELSE 'skipped' END AS status
      FROM bailian_notices n JOIN articles a ON a.id=n.article_id LEFT JOIN bailian_files f
      ON f.article_id=n.article_id AND f.generation=n.generation WHERE ${eligible} GROUP BY n.article_id) GROUP BY status`),
    env.DB.prepare(`SELECT CASE WHEN f.slot='body' THEN 'web' WHEN f.label='正文 PDF' THEN 'body_pdf' ELSE 'attachment' END AS kind,f.state,f.error,f.blocked,count(*) AS count FROM bailian_files f JOIN bailian_notices n
      ON n.article_id=f.article_id AND n.generation=f.generation GROUP BY kind,f.state,f.error,f.blocked`),
    env.DB.prepare(`SELECT count(*) AS count,COALESCE(SUM(f.blocked),0) AS blocked FROM bailian_files f JOIN bailian_notices n ON n.article_id=f.article_id WHERE f.generation<>n.generation`),
    env.DB.prepare("SELECT day,kind,used FROM usage WHERE kind LIKE 'bailian:%' AND day>=date('now','-7 days') ORDER BY day DESC,kind"),
    env.DB.prepare(`SELECT kind,COUNT(*) AS files,SUM(COALESCE(bytes,0)) AS bytes FROM (
      SELECT q.kind,o.byte_size AS bytes FROM articles a JOIN revision_requirements q ON q.revision_id=a.latest_ready_revision_id
      LEFT JOIN artifact_objects o ON o.sha256=q.object_hash WHERE q.state='fulfilled'
      AND (q.kind IN ('body','body_pdf') OR (q.kind='attachment' AND q.filename LIKE '%.pdf'))
      UNION ALL SELECT CASE WHEN t.role='body-pdf' THEN 'body_pdf' ELSE 'attachment' END,t.bytes FROM articles a
      JOIN attachments t ON t.article_id=a.id WHERE a.latest_observed_revision_id IS NULL AND a.status='complete'
      AND t.status='complete' AND t.filename LIKE '%.pdf'
      UNION ALL SELECT 'body',length(CAST(a.body_text AS BLOB)) FROM articles a WHERE a.latest_observed_revision_id IS NULL
      AND a.status='complete') GROUP BY kind`),
    env.DB.prepare(`SELECT article_id AS articleId,slot,id,file_id AS fileId,job_id AS jobId,state,error
      FROM bailian_files WHERE blocked=1 ORDER BY (error='unconfirmed_receipt') DESC,id LIMIT 20`),
  ]);
  let configured=true;
  try{createBailianClient(env);}catch{configured=false;}
  return {configured,writes:writeEnabled(env),reads:env.BAILIAN_SEARCH_READS==='true',...settings.results[0],
    readable:inventory.results[0].readable,notices:Object.fromEntries(notices.results.map(r=>[r.status,r.count])),
    files:files.results,cleanup:cleanup.results[0].count,blockedCleanup:cleanup.results[0].blocked,usage:usage.results,originals:originals.results,needsAttention:attention.results};
}

async function project(env,n,load){
  const db=env.DB, notice=await load(n.article_id),statements=[];
  const tags=notice?await buildSearchTags(notice.memberships,notice.publishedDay):[];
  const docs=[...(notice?.documents??[]),...(notice?.skipped??[])];
  for(const doc of docs){
    const label=doc.label??doc.slot, filename=doc.filename??null;
    const pages=doc.pages??null;
    const text=doc.reason?null:('# '+notice.title+'\n\n'+(pages?pages.map(p=>'## 第 '+p.number+' 页\n\n'+p.text).join('\n\n'):doc.text));
    const fingerprint=await sha(JSON.stringify([notice.revisionId,doc.slot,filename,label,text,tags,doc.reason]));
    const old=await db.prepare(`SELECT id FROM bailian_files WHERE article_id=? AND slot=? AND fingerprint=?
      AND state NOT IN ('removing','unlinking') ORDER BY generation DESC LIMIT 1`).bind(n.article_id,doc.slot,fingerprint).first();
    if(old){
      statements.push(db.prepare('UPDATE bailian_files SET generation=? WHERE id=?').bind(n.generation,old.id));
      continue;
    }
    const id=await sha(JSON.stringify([n.article_id,n.generation,fingerprint]));
    const textKey=text?'bailian/text/'+id+'.md':null;
    const evidenceKey=pages?'bailian/pages/'+id+'.json':null;
    const skip=doc.reason??null;
    const blocked=Number(doc.blocked??false);
    if(textKey)await env.ARCHIVE.put(textKey,text);
    if(evidenceKey)await env.ARCHIVE.put(evidenceKey,JSON.stringify(pages));
    statements.push(db.prepare(`INSERT INTO bailian_files(id,article_id,generation,slot,revision_id,filename,label,
      fingerprint,evidence_key,text_key,tags,state,error,blocked) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id,n.article_id,n.generation,doc.slot,notice.revisionId??null,filename,label,fingerprint,evidenceKey,
        textKey,JSON.stringify(tags),skip?(blocked?'failed':'skipped'):'new',skip,blocked));
  }
  // The generation captured before reading D1/R2 is the only one these files
  // may satisfy. A concurrent correction keeps the notice hidden and dirty.
  statements.push(db.prepare('UPDATE bailian_notices SET projected=?,attempts=0,error=NULL,blocked=0,next_at=0 WHERE article_id=? AND generation=?')
    .bind(n.generation,n.article_id,n.generation));
  await db.batch(statements);
}

async function backfill(env,cursor,size){
  const {results}=await env.DB.prepare('SELECT a.id FROM articles a WHERE a.id>? AND '+eligible+' ORDER BY a.id LIMIT ?').bind(cursor,size).all();
  await env.DB.batch([...results.map(row=>env.DB.prepare('INSERT OR IGNORE INTO bailian_notices(article_id,priority) VALUES(?,0)').bind(row.id)),
    env.DB.prepare("UPDATE bailian_control SET cursor=?,backfill=CASE WHEN backfill='paused' THEN backfill ELSE ? END WHERE id=1")
      .bind(results.at(-1)?.id??cursor,results.length<size?'done':'running')]);
}

async function usage(env,kind,at){
  await env.DB.prepare('INSERT INTO usage(day,kind,used) VALUES(?,?,1) ON CONFLICT(day,kind) DO UPDATE SET used=used+1')
    .bind(new Date(at).toISOString().slice(0,10),'bailian:'+kind).run();
}

async function advance(env,f,client,at){
  const db=env.DB;
  const set=(sql,...args)=>db.prepare('UPDATE bailian_files SET '+sql+' WHERE id=?').bind(...args,f.id).run();
  // Starting or retrying an operation must retain its accumulated failures.
  const completed=s=>set('state=?,attempts=0,next_at=0,error=NULL,blocked=0',s);
  const call=async(kind,fn)=>{await usage(env,kind,at);return fn();};
  const name='feed-'+f.id+'.md';
  if(f.stale||f.state==='removing'||f.state==='unlinking'){
    if(!f.file_id&&f.state==='registering'){
      const text=await stagedText(env,f);
      const recovered=await call('reconcile',()=>client.findFile({name,text}));
      if(!recovered)throw Object.assign(new Error(),{kind:'ambiguous'});
      await set('file_id=?,state=?',recovered,'removing');
      return;
    }
    if(f.file_id&&f.state!=='unlinking'){
      if(f.state==='importing'&&f.job_id){
        const progress=await call('poll',()=>client.checkImport(f.job_id));
        if(progress.state==='pending'){await set('next_at=?',at+300_000);return;}
      }
      if(f.state==='submitting')throw Object.assign(new Error(),{kind:'ambiguous'});
      await set("state='removing'");
      await call('delete_document',()=>client.removeDocument(f.file_id)).catch(ignoreMissing);
      await completed('unlinking');
      return;
    }
    if(f.file_id)await call('delete_file',()=>client.removeFile(f.file_id)).catch(ignoreMissing);
    for(const key of [f.text_key,f.evidence_key])if(key)await env.ARCHIVE.delete(key);
    await db.prepare('DELETE FROM bailian_files WHERE id=?').bind(f.id).run();
    return;
  }
  if(f.state==='new'||f.state==='registering'){
    const text=await stagedText(env,f);
    let id;
    if(f.state==='registering'){
      id=await call('reconcile',()=>client.findFile({name,text}));
      if(!id)throw Object.assign(new Error(),{kind:'ambiguous'});
    }else{
      await set("state='registering'");
      try{id=await call('register',()=>client.registerFile({name,text,tags:JSON.parse(f.tags)}));}
      catch(e){if(e.registrationAttempted===false||e.status===429||noRetry(e))await set("state='new'");throw e;}
    }
    await set("file_id=?,state='registered',attempts=0,next_at=0,error=NULL",id);
  }else if(f.state==='registered'){
    await set("state='submitting'");
    let job;
    try{job=await call('import',()=>client.startImport([f.file_id]));}
    catch(e){if(e.status===429||noRetry(e))await set("state='registered'");throw e;}
    await set("job_id=?,state='importing',attempts=0,next_at=0,error=NULL",job);
  }else if(f.state==='submitting'){
    // No job id survived the interrupted submit. Replaying could bill twice.
    throw Object.assign(new Error(),{kind:'ambiguous'});
  }else if(f.state==='importing'){
    const result=await call('poll',()=>client.checkImport(f.job_id));
    const file=result.files.find(item=>item.fileId===f.file_id);
    if(result.state==='failed'||file?.state==='failed'||(result.state==='done'&&file?.state!=='done')){
      await set("state='failed',error='import_failed',blocked=1");
    }else if(result.state==='done'&&file?.state==='done')await completed('ready');
    else await set('next_at=?',at+300_000);
  }
}

async function stagedText(env,f){
  const object=await env.ARCHIVE.get(f.text_key);
  if(!object)throw new Error('Missing staged file');
  return object.text();
}
function ignoreMissing(e){if(e.status!==404)throw e;}

export async function runBailianSync(env,{now=Date.now,batchSize=4,backfillBatchSize=5,client,loadNotice}={}){
  if(!writeEnabled(env))return {enabled:false};
  const at=nowValue(now),db=env.DB,lease=crypto.randomUUID();
  // The lease outlasts a scheduled Worker invocation. A crashed tick cannot
  // overlap its successor; durable upload/import receipts survive expiration.
  const ctl=await db.prepare('UPDATE bailian_control SET lease=?,lease_until=? WHERE id=1 AND paused=0 AND cooldown_until<=? AND lease_until<=? RETURNING backfill,cursor')
    .bind(lease,at+16*60_000,at,at).first();
  if(!ctl)return {enabled:true,pausedOrBusy:true};
  try{
    if(!client){
      try{client=createBailianClient(env);}catch{
        await control(env,'cooldown_until=?',at+300_000);
        return {enabled:true,configured:false};
      }
    }
    if(ctl.backfill==='running')await backfill(env,ctl.cursor,Math.min(20,Math.max(1,backfillBatchSize)));
    const dirty=await db.prepare('SELECT * FROM bailian_notices WHERE generation<>projected AND blocked=0 AND next_at<=? ORDER BY priority DESC,generation DESC,article_id LIMIT 2').bind(at).all();
    for(const n of dirty.results){
      try{await project(env,n,loadNotice??(id=>loadSearchNotice(env,id)));}
      catch(e){await db.prepare('UPDATE bailian_notices SET error=?,attempts=attempts+1,blocked=?,next_at=? WHERE article_id=? AND generation=?')
        .bind(failure(e),n.attempts>=4?1:0,at+retryDelay(n.attempts),n.article_id,n.generation).run();}
    }
    const due=await db.prepare(`SELECT f.*,f.generation<>n.generation AS stale FROM bailian_files f JOIN bailian_notices n ON n.article_id=f.article_id
      WHERE n.projected=n.generation AND f.next_at<=? AND
      ((f.generation<>n.generation AND (f.blocked=0 OR (f.state NOT IN ('registering','submitting','removing','unlinking'))))
       OR (f.generation=n.generation AND f.blocked=0 AND f.state NOT IN ('ready','skipped','failed')))
      ORDER BY f.next_at, n.priority DESC, f.generation<>n.generation, f.id LIMIT ?`).bind(at,Math.min(4,Math.max(1,batchSize))).all();
    for(const f of due.results){
      const live=await db.prepare(`SELECT n.generation,n.projected,c.paused FROM bailian_notices n,bailian_control c
        WHERE n.article_id=? AND c.id=1`).bind(f.article_id).first();
      if(live.paused)break;
      if(live.generation!==live.projected||Boolean(f.stale)!==(f.generation!==live.generation))continue;
      try{await advance(env,f,client,at);}
      catch(e){
        const code=e.kind==='ambiguous'?'unconfirmed_receipt':failure(e);
        await db.prepare('UPDATE bailian_files SET attempts=attempts+1,next_at=?,blocked=?,error=? WHERE id=?')
          .bind(at+retryDelay(f.attempts),noRetry(e)||e.kind==='ambiguous'||f.attempts>=5?1:0,code,f.id).run();
        await usage(env,code,at);
        if(code==='rate_limited'||code==='timeout'||code==='credentials'){
          await control(env,'cooldown_until=?',at+retryDelay(f.attempts));
          break;
        }
      }
    }
    return {enabled:true,projected:dirty.results.length,processed:due.results.length};
  }finally{await db.prepare('UPDATE bailian_control SET lease=NULL,lease_until=0 WHERE id=1 AND lease=?').bind(lease).run();}
}
