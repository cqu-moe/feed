import {createCollector} from './collect.mjs';
import {createSources} from './sources.mjs';
import {
  enqueuePdfOcr,
  pdfOcrResults,
  pdfOcrStatus,
  resumePdfOcr,
} from './pdf-ocr.mjs';
import {archiveOcrStatus,redoArchiveOcr} from './archive-ocr.mjs';
import {reconcileRevision} from './archive-reconcile.mjs';
import {createTaskRuntime} from './task-runtime.mjs';
import {cleanError} from './utils.mjs';

function isGlobalLimitError(message){
  return /Firecrawl HTTP 403|\b(?:429|402)\b|daily budget reached|\b(?:budget|quota|credit)s?\b/i.test(message);
}

export function createArchive(env,{
  collector=createCollector(),
}={}){
  return {
    async captureTask(taskId,attemptNo){
      if(!/^[a-f0-9]{24}$/.test(taskId??''))throw new Error('Invalid capture task id');
      const task=await env.DB.prepare(`SELECT t.payload_json,t.source_id AS task_source_id,a.id,a.source_id,a.title,a.url,a.published_at,ta.result_json
        FROM tasks t JOIN articles a ON a.id=t.article_id
        JOIN task_attempts ta ON ta.task_id=t.id AND ta.attempt_no=t.attempt_no
        WHERE t.id=? AND t.kind='capture' AND t.attempt_no=? AND t.state='running'`)
        .bind(taskId,attemptNo).first();
      if(!task)return {superseded:true};
      if(task.result_json)return JSON.parse(task.result_json);
      const taskPayload=JSON.parse(task.payload_json),source=taskPayload.source??await createSources(env).find(task.source_id);
      if(!source||source.id!==(task.task_source_id??task.source_id)||new URL(source.url).origin!==new URL(task.url).origin
        ||!new RegExp(source.articlePattern).test(new URL(task.url).pathname))throw new Error('Capture source context is invalid');
      return this.capture(source,task,{taskId,attemptNo,captureIntent:taskPayload.captureIntent??(taskPayload.discovery?'live':'live')});
    },
    async capture(source,article,{taskId=null,attemptNo=null,captureIntent='live'}={}){
      const timestamp=Date.now();
      const versioned=taskId&&env.ARCHIVE_VERSIONS_ENABLED==='true';
      const lease=await env.DB.prepare(`UPDATE articles
        SET status=${versioned?'status':"'collecting'"},attempts=attempts+1,lease_until=?,capture_fence=capture_fence+1${versioned?',next_revision_no=next_revision_no+1':''}
        WHERE id=? AND lease_until<=? AND (
          (? IS NULL AND status IN ('pending','partial','failed','collecting') AND attempts<3)
          OR (? IS NOT NULL AND EXISTS(SELECT 1 FROM tasks WHERE id=? AND article_id=articles.id AND attempt_no=? AND state='running'))
        ) RETURNING id,prefix,capture_fence,lease_until${versioned?',next_revision_no-1 AS observation_no':''}`)
        .bind(timestamp+10*60000,article.id,timestamp,taskId,taskId,taskId,attemptNo).first();
      if(!lease)return {skipped:true};
      try{
        return await collector(env,source,article,{fence:lease.capture_fence,taskId,attemptNo,observationNo:lease.observation_no,captureIntent});
      }catch(error){
        if(taskId){
          const receipt=await env.DB.prepare('SELECT result_json FROM task_attempts WHERE task_id=? AND attempt_no=?')
            .bind(taskId,attemptNo).first().catch(()=>null);
          if(receipt?.result_json)return JSON.parse(receipt.result_json);
        }
        const message=cleanError(error);
        const savedResult=versioned&&!/fence|identity|checksum|inventory/i.test(message)
          ?await env.ARCHIVE.head(`captures/${taskId}/result.json`).catch(()=>null):null;
        const deferred=isGlobalLimitError(message)||Boolean(savedResult);
        await env.DB.prepare(`UPDATE articles
          SET status=CASE WHEN ? THEN status WHEN prefix IS NULL THEN ? ELSE 'partial' END,
              attempts=attempts-?,lease_until=0,error=CASE WHEN ? THEN error ELSE ? END
          WHERE id=? AND capture_fence=?`)
          .bind(versioned?1:0,deferred?'pending':'failed',deferred?1:0,versioned?1:0,message,article.id,lease.capture_fence).run();
        return {...(deferred?{deferred:true}:{}),...(Number.isFinite(error.retryAfterMs)?{retryAfterMs:error.retryAfterMs}:{}),error:message};
      }
    },
    extract(articleId,options){
      if(env.ARCHIVE_VERSIONS_ENABLED==='true')return redoArchiveOcr(env,articleId,options??{});
      return enqueuePdfOcr(env,articleId,options);
    },
    reconcileRevision(revisionId){
      return reconcileRevision(env,revisionId);
    },
    resumeExtract(){
      if(env.ARCHIVE_VERSIONS_ENABLED==='true')return createTaskRuntime(env).recover();
      return resumePdfOcr(env);
    },
    extractStatus(articleId){
      if(env.ARCHIVE_VERSIONS_ENABLED==='true')return archiveOcrStatus(env,articleId);
      return pdfOcrStatus(env,articleId);
    },
    extractResults(articleId,model){
      if(env.ARCHIVE_VERSIONS_ENABLED==='true')return archiveOcrStatus(env,articleId);
      return pdfOcrResults(env,articleId,model);
    },
  };
}
