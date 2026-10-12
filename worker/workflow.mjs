import {WorkflowEntrypoint} from 'cloudflare:workers';
import {createArchive} from './archive.mjs';
import {createSources} from './sources.mjs';
import {discoverPage} from './discovery.mjs';
import {cutoffDate,cleanError} from './utils.mjs';

export class FeedIngest extends WorkflowEntrypoint {
  async run(event,step){
    const sources=createSources(this.env),archive=createArchive(this.env);
    const source=await sources.find(event.payload.sourceId);if(!source)throw new Error('Unknown source');
    const runId=event.instanceId,cutoff=event.payload.cutoff||cutoffDate();
    await step.do('start',async()=>{
      await this.env.DB.batch([
        this.env.DB.prepare('INSERT INTO sources(id,name,url) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,url=excluded.url').bind(source.id,source.name,source.url),
        this.env.DB.prepare("INSERT OR IGNORE INTO runs(id,source_id,started_at,status) VALUES (?,?,?,'running')").bind(runId,source.id,new Date().toISOString()),
        this.env.DB.prepare("UPDATE articles SET status=CASE WHEN prefix IS NULL THEN 'failed' ELSE 'partial' END,error='Previous collection interrupted' WHERE source_id=? AND status='collecting' AND lease_until<?").bind(source.id,Date.now()),
      ]);
    });
    let discovered=0,captured=0;const errors=[];
    const queue=[...source.listUrls],visited=new Set();
    for(let i=0;queue.length&&i<12;i++){
      const url=queue.shift();if(visited.has(url))continue;visited.add(url);
      const result=await step.do(`discover-${i}`,{retries:{limit:0,delay:'5 seconds'},timeout:'5 minutes'},async()=>{
        try{return await discoverPage(this.env,source,url,cutoff);}catch(error){return {error:cleanError(error)};}
      });
      if(result.error){errors.push(result.error);break;}
      discovered+=result.added;
      if(result.undated)errors.push(`${result.undated} list entries have no reliable date`);
      queue.push(...result.next.filter(x=>!visited.has(x)));
    }
    if(queue.length)errors.push('Pagination limit reached; discovery incomplete');
    const articles=await step.do('pending',async()=>{
      const rows=await this.env.DB.prepare("SELECT id,url,title FROM articles WHERE source_id=? AND status IN ('pending','partial','failed') AND attempts<3 ORDER BY published_at DESC LIMIT ?").bind(source.id,Number(this.env.MAX_ARTICLES_PER_RUN||40)).all();
      return rows.results;
    });
    for(const article of articles){
      const result=await step.do(`article-${article.id}`,{retries:{limit:0,delay:'10 seconds'},timeout:'8 minutes'},async()=>{
        return archive.capture(source,article);
      });
      if(result.deferred){errors.push(`${article.id}: ${result.error}`);break;}
      if(result.error)errors.push(`${article.id}: ${result.error}`);
      else if(!result.skipped){captured++;if(result.status==='partial')errors.push(`${article.id}: archive incomplete`);}
      await step.sleep(`pace-${article.id}`,'2 seconds');
    }
    await step.do('finish',async()=>{
      const unfinished=await this.env.DB.prepare("SELECT COUNT(*) AS n FROM articles WHERE source_id=? AND status <> 'complete'").bind(source.id).first();
      if(unfinished.n>0)errors.push(`${unfinished.n} unfinished articles`);
      const now=new Date().toISOString(),error=errors.join('; ').slice(0,2000)||null;
      await this.env.DB.batch([
        this.env.DB.prepare('UPDATE runs SET finished_at=?,status=?,error=?,discovered=?,captured=? WHERE id=?').bind(now,error?'partial':'complete',error,discovered,captured,runId),
        this.env.DB.prepare('UPDATE sources SET last_run_at=?,error=? WHERE id=?').bind(now,error,source.id),
        this.env.DB.prepare("DELETE FROM ocr_slots WHERE created_at < datetime('now','-1 day')"),
      ]);
    });
    return {sourceId:source.id,discovered,captured,errors};
  }
}
