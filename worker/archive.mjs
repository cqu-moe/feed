import {createCollector} from './collect.mjs';
import {createSources} from './sources.mjs';
import {
  enqueuePdfOcr,
  pdfOcrResults,
  pdfOcrStatus,
  resumePdfOcr,
} from './pdf-ocr.mjs';
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
      const task=await env.DB.prepare(`SELECT t.payload_json,a.id,a.source_id,a.title,a.url,ta.result_json
        FROM tasks t JOIN articles a ON a.id=t.article_id
        JOIN task_attempts ta ON ta.task_id=t.id AND ta.attempt_no=t.attempt_no
        WHERE t.id=? AND t.kind='capture' AND t.attempt_no=? AND t.state='running'`)
        .bind(taskId,attemptNo).first();
      if(!task)return {superseded:true};
      if(task.result_json)return JSON.parse(task.result_json);
      const source=JSON.parse(task.payload_json).source??createSources(env).find(task.source_id);
      if(!source||source.id!==task.source_id||new URL(source.url).origin!==new URL(task.url).origin
        ||!new RegExp(source.articlePattern).test(new URL(task.url).pathname))throw new Error('Capture source context is invalid');
      return this.capture(source,task,{taskId,attemptNo});
    },
    async capture(source,article,{taskId=null,attemptNo=null}={}){
      const timestamp=Date.now();
      const lease=await env.DB.prepare(`UPDATE articles
        SET status='collecting',attempts=attempts+1,lease_until=?,capture_fence=capture_fence+1
        WHERE id=? AND (status<>'collecting' OR lease_until<=?) AND (
          (? IS NULL AND status IN ('pending','partial','failed','collecting') AND attempts<3)
          OR (? IS NOT NULL AND EXISTS(SELECT 1 FROM tasks WHERE id=? AND article_id=articles.id AND attempt_no=? AND state='running'))
        ) RETURNING id,prefix,capture_fence,lease_until`)
        .bind(timestamp+10*60000,article.id,timestamp,taskId,taskId,taskId,attemptNo).first();
      if(!lease)return {skipped:true};
      try{
        return await collector(env,source,article,{fence:lease.capture_fence,taskId,attemptNo});
      }catch(error){
        const message=cleanError(error),deferred=isGlobalLimitError(message);
        await env.DB.prepare(`UPDATE articles
          SET status=CASE WHEN prefix IS NULL THEN ? ELSE 'partial' END,
              attempts=attempts-?,lease_until=0,error=?
          WHERE id=? AND status='collecting' AND capture_fence=?`)
          .bind(deferred?'pending':'failed',deferred?1:0,message,article.id,lease.capture_fence).run();
        return {...(deferred?{deferred:true}:{}),...(Number.isFinite(error.retryAfterMs)?{retryAfterMs:error.retryAfterMs}:{}),error:message};
      }
    },
    extract(articleId,options){
      return enqueuePdfOcr(env,articleId,options);
    },
    resumeExtract(){
      return resumePdfOcr(env);
    },
    extractStatus(articleId){
      return pdfOcrStatus(env,articleId);
    },
    extractResults(articleId,model){
      return pdfOcrResults(env,articleId,model);
    },
  };
}
