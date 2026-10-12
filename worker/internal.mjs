import {Buffer} from 'node:buffer';
import {json,equal} from './utils.mjs';
import {createArchive} from './archive.mjs';
import {createSources} from './sources.mjs';
import {createTaskRuntime,ValidationError} from './task-runtime.mjs';
import {repairPdfText} from './pdf-text.mjs';

export async function internalRoute(request,env){
  const url=new URL(request.url);
  if(!await requireAdmin(request,env))return json({error:'Unauthorized'},401);
  if((url.pathname.startsWith('/internal/sites')||url.pathname.startsWith('/internal/sources'))&&env.SOURCE_MANAGEMENT_ENABLED!=='true'){
    return json({error:'Source management is disabled'},503);
  }
  if(url.pathname.startsWith('/internal/sites')){
    const sources=createSources(env),detail=/^\/internal\/sites\/([a-f0-9]{24})$/.exec(url.pathname);
    if(url.pathname==='/internal/sites'&&request.method==='GET')return json({sites:await sources.listSites()});
    if(url.pathname==='/internal/sites'&&request.method==='POST'){
      try{return json(await sources.createSite(await readJson(request)),201);}
      catch(error){return validationResponse(error);}
    }
    if(detail&&request.method==='PATCH'){
      try{
        const result=await sources.updateSite(detail[1],await readJson(request));
        return result?json({site:result}):json({error:'Site not found'},404);
      }catch(error){return validationResponse(error);}
    }
    return json({error:'Method not allowed'},405);
  }
  if(url.pathname.startsWith('/internal/sources')){
    const sources=createSources(env),detail=/^\/internal\/sources\/([a-zA-Z0-9_-]{1,64})$/.exec(url.pathname);
    const verify=/^\/internal\/sources\/([a-zA-Z0-9_-]{1,64})\/verify$/.exec(url.pathname);
    if(url.pathname==='/internal/sources'&&request.method==='GET')return json({sources:await sources.listSources()});
    if(url.pathname==='/internal/sources'&&request.method==='POST'){
      try{return json(await sources.createSource(await readJson(request)),201);}
      catch(error){return validationResponse(error);}
    }
    if(url.pathname==='/internal/sources/schedule'&&request.method==='POST'){
      if(env.TASK_RUNTIME_ENABLED!=='true'||env.CRAWL_ENABLED!=='true')return json({error:'Discovery runtime is disabled'},503);
      const result=await sources.scheduleDue();
      await createTaskRuntime(env).dispatchDueOutbox().catch(()=>{});
      return json(result,202);
    }
    const discoveries=/^\/internal\/sources\/([a-zA-Z0-9_-]{1,64})\/discoveries$/.exec(url.pathname);
    if(discoveries&&request.method==='GET')return json({discoveries:await sources.discoveries(discoveries[1])});
    if(detail&&request.method==='GET'){
      const source=await sources.readSource(detail[1]);
      return source?json({source}):json({error:'Source not found'},404);
    }
    if(detail&&request.method==='PATCH'){
      try{
        const result=await sources.updateSource(detail[1],await readJson(request));
        return result?json(result):json({error:'Source not found'},404);
      }catch(error){return validationResponse(error);}
    }
    if(verify&&request.method==='POST'){
      if(env.TASK_RUNTIME_ENABLED!=='true'||env.CRAWL_ENABLED!=='true')return json({error:'Discovery runtime is disabled'},503);
      try{
        const result=await sources.submitValidation(verify[1],await readJson(request));
        await createTaskRuntime(env).dispatchDueOutbox().catch(()=>{});
        return json(result,202);
      }
      catch(error){return validationResponse(error);}
    }
    return json({error:'Method not allowed'},405);
  }
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
  const archiveOcrArticle=/^\/internal\/articles\/([a-f0-9]{24})\/pdf-ocr$/.exec(url.pathname);
  if(archiveOcrArticle){
    if(env.ARCHIVE_VERSIONS_ENABLED!=='true')return json({error:'Archive OCR runtime is disabled'},503);
    if(request.method==='GET')return json(await archive.extractStatus(archiveOcrArticle[1]));
    if(request.method==='POST'){
      let payload={};
      try{payload=await request.json();}catch{}
      if(!payload||typeof payload!=='object'||Array.isArray(payload)
        ||Object.keys(payload).some(key=>!['model','publish'].includes(key)))return json({error:'Invalid OCR redo request'},400);
      const submitted=await archive.extract(archiveOcrArticle[1],payload);
      await createTaskRuntime(env).dispatchDueOutbox().catch(()=>{});
      return json(submitted,202);
    }
    return json({error:'Method not allowed'},405);
  }
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

async function readJson(request){
  const bytes=new Uint8Array(await request.arrayBuffer());
  if(bytes.byteLength>65536)throw validationJsonError('JSON body too large');
  try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw validationJsonError('Invalid JSON');}
}

function validationResponse(error){
  if(error?.name==='ValidationError')return json({error:error.message},error.status??400);
  throw error;
}

function validationJsonError(message){const error=new Error(message);error.name='ValidationError';return error;}

export async function requireAdmin(request,env){
  return Boolean(env.ADMIN_TOKEN&&await equal(request.headers.get('Authorization'),`Bearer ${env.ADMIN_TOKEN}`));
}
