import {createCollector} from './collect.mjs';
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
    async capture(source,article){
      const lease=await env.DB.prepare(`
        UPDATE articles
           SET status='collecting',attempts=attempts+1,lease_until=?
         WHERE id=? AND status IN ('pending','partial','failed') AND attempts<3
         RETURNING id,prefix
      `).bind(Date.now()+10*60000,article.id).first();
      if(!lease)return {skipped:true};

      try{
        return await collector(env,source,article);
      }catch(error){
        const message=cleanError(error);
        if(isGlobalLimitError(message)){
          await env.DB.prepare(`
            UPDATE articles
               SET status=CASE WHEN ? IS NULL THEN 'pending' ELSE 'partial' END,
                   attempts=attempts-1,lease_until=0,error=?
             WHERE id=? AND status='collecting'
          `).bind(lease.prefix,message,article.id).run();
          return {deferred:true,error:message};
        }
        await env.DB.prepare(`
          UPDATE articles
             SET status=CASE WHEN prefix IS NULL THEN 'failed' ELSE 'partial' END,error=?
           WHERE id=?
        `).bind(message,article.id).run();
        return {error:message};
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
