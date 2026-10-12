import {Buffer} from 'node:buffer';
import {json,equal} from './utils.mjs';
import {createArchive} from './archive.mjs';
import {createSources} from './sources.mjs';
import {createTaskRuntime,ValidationError} from './task-runtime.mjs';
import {repairPdfText} from './pdf-text.mjs';

export async function internalRoute(request,env){
  const url=new URL(request.url);
  if(!await requireAdmin(request,env))return json({error:'Unauthorized'},401);
  if(url.pathname.startsWith('/internal/capture-tasks')){
    const runtime=createTaskRuntime(env);
    if(request.method==='POST'&&(env.TASK_RUNTIME_ENABLED!=='true'||env.CRAWL_ENABLED!=='true'))return json({error:'Capture task runtime is disabled'},503);
    if(url.pathname==='/internal/capture-tasks/recover'&&request.method==='POST')return json(await runtime.recover());
    if(request.method==='POST'&&url.pathname==='/internal/capture-tasks'){
      let payload;
      try{payload=await request.json();}catch{return json({error:'Invalid JSON'},400);}
      if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(key=>!['articleId','requestId'].includes(key)))return json({error:'articleId and requestId are required'},400);
      try{
        const submitted=await runtime.submitCapture(payload);
        // The committed task is accepted even if the Queue is temporarily unavailable.
        await runtime.dispatchDueOutbox().catch(()=>{});
        return json(submitted,202);
      }catch(error){
        if(error instanceof ValidationError)return json({error:error.message},error.message==='Article not found'?404:400);
        throw error;
      }
    }
    const detail=/^\/internal\/capture-tasks\/([a-f0-9]{24})$/.exec(url.pathname);
    if(detail&&request.method==='GET'){
      const task=await runtime.status(detail[1]);
      if(!task)return json({error:'Task not found'},404);
      const {articleStatus,articleCapturedAt,attemptState,startedAt,endedAt,errorCode,workflowInstanceId,...head}=task;
      return json({
        task:head,
        attempt:{state:attemptState,workflowInstanceId,startedAt,endedAt,errorCode},
        article:{id:head.articleId,status:articleStatus,capturedAt:articleCapturedAt},
      });
    }
    if(url.pathname==='/internal/capture-tasks'&&request.method==='GET')return json({tasks:await runtime.list()});
    return json({error:'Method not allowed'},405);
  }

  const archive=createArchive(env);
  const ocr=/^\/internal\/pdf-ocr\/([a-f0-9]{24})$/.exec(url.pathname);
  if(ocr){
    if(request.method==='GET')return json(url.searchParams.has('model')?await archive.extractResults(ocr[1],url.searchParams.get('model')):await archive.extractStatus(ocr[1]));
    if(request.method==='POST'){
      const payload=await request.json();
      if(typeof payload.model!=='string'||typeof payload.publish!=='boolean')return json({error:'model and publish required'},400);
      return json(await archive.extract(ocr[1],payload),202);
    }
  }
  const repair=/^\/internal\/repair-text\/([a-f0-9]{24})$/.exec(url.pathname);
  if(repair&&request.method==='POST')return json(await repairPdfText(env,repair[1]));
  if(url.pathname==='/internal/run'&&request.method==='POST')return json({ids:await createSources(env).scheduleDaily(crypto.randomUUID().slice(0,8))},202);
  if(url.pathname==='/internal/auth-check'&&request.method==='GET'){
    const r=await env.AUTH.fetch(new URL('/api/v1/auth/oauth2/introspect',env.AUTH_BASE_URL),{method:'POST',headers:{Authorization:'Basic '+Buffer.from(env.FEED_AUTH_CLIENT_ID+':'+env.FEED_AUTH_CLIENT_SECRET).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:'feed-readiness-invalid-token'}),signal:AbortSignal.timeout(10000)});
    const type=r.headers.get('content-type')??'';const result=type.includes('json')?await r.json():{};
    return json({providerStatus:r.status,ready:r.ok&&result.active===false},r.ok?200:503);
  }
  if(url.pathname==='/internal/status'&&request.method==='GET'){
    const [runs,articles,usage]=await Promise.all([
      env.DB.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 20').all(),
      env.DB.prepare('SELECT source_id,status,COUNT(*) AS n FROM articles GROUP BY source_id,status').all(),
      env.DB.prepare('SELECT * FROM usage ORDER BY day DESC LIMIT 20').all(),
    ]);return json({runs:runs.results,articles:articles.results,usage:usage.results});
  }
  return json({error:'Not found'},404);
}

export async function requireAdmin(request,env){
  return Boolean(env.ADMIN_TOKEN&&await equal(request.headers.get('Authorization'),`Bearer ${env.ADMIN_TOKEN}`));
}
