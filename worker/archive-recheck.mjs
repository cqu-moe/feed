import {sha} from './utils.mjs';
import {createSources} from './sources.mjs';
import {launchOutboxId,launchOutboxStatement} from './task-statements.mjs';
import {articleAgeMs,boundedInteger,parseRecheckPolicy} from './recheck-policy.mjs';

const eligibleSource=`s.enabled=1 AND st.enabled=1 AND s.validation_state='verified'
  AND (s.id=a.source_id OR EXISTS(SELECT 1 FROM article_sources als WHERE als.article_id=a.id AND als.source_id=s.id))
  AND substr(a.url,1,length(st.origin)+1)=st.origin||'/'`;

export function createArchiveRecheck(env,{now=()=>Date.now()}={}){
  const timestamp=()=>{
    const value=now();
    return value instanceof Date?value.getTime():value;
  };
  const policy=parseRecheckPolicy(env);

  return {
    async scheduleDue({limit=20}={}){
      if(env.CRAWL_ENABLED!=='true'||env.TASK_RUNTIME_ENABLED!=='true'||env.ARCHIVE_VERSIONS_ENABLED!=='true')
        return {scheduled:[],duplicate:false};
      const at=timestamp(),pageSize=boundedInteger(limit,20,1,100);
      const managed=env.SOURCE_MANAGEMENT_ENABLED==='true';
      const cursor=await env.DB.prepare('SELECT due_at,article_id,generation FROM archive_recheck_cursor WHERE id=1').first();
      const rows=await env.DB.prepare(`SELECT a.id,a.url,a.source_id,a.next_recheck_at AS due_at,
        r.observed_at AS observedAt,r.published_at AS publishedAt
        FROM articles a
        JOIN article_revisions r ON r.id=a.latest_ready_revision_id AND r.article_id=a.id
        WHERE a.latest_ready_revision_id IS NOT NULL AND a.next_recheck_at<=?
          AND (a.next_recheck_at>? OR (a.next_recheck_at=? AND a.id>?))
          ${managed?`AND EXISTS(SELECT 1 FROM sources s JOIN sites st ON st.id=s.site_id WHERE ${eligibleSource})`:''}
        ORDER BY a.next_recheck_at,a.id LIMIT ?`).bind(at,cursor.due_at,cursor.due_at,cursor.article_id,pageSize).all();

      const statements=[];
      for(const row of rows.results){
        const candidates=managed?(await env.DB.prepare(`SELECT s.id FROM articles a JOIN sources s
          JOIN sites st ON st.id=s.site_id WHERE a.id=? AND ${eligibleSource}
          ORDER BY s.id=a.source_id DESC,s.id`).bind(row.id).all()).results:[{id:row.source_id}];
        let source=null;
        for(const candidate of candidates){
          const current=await createSources(env).find(candidate.id);
          if(!current||(managed&&(!current.enabled||!current.siteEnabled||current.validationState!=='verified')))continue;
          const url=new URL(row.url);
          if(url.origin!==new URL(current.url).origin||!new RegExp(current.config?.articlePattern??current.articlePattern).test(url.pathname))continue;
          source=current;break;
        }
        if(!source)continue;
        const gate=managed?`AND EXISTS(SELECT 1 FROM sources s JOIN sites st ON st.id=s.site_id
          WHERE s.id=? AND s.config_version=? AND ${eligibleSource})`:'';
        const gateArgs=managed?[source.id,source.configVersion]:[];
        const age=articleAgeMs(row,at);
        const nextDue=at+(age<=policy.recentAfterMs?policy.recentIntervalMs:policy.oldIntervalMs);
        const businessKey=`recheck:${row.id}:${row.due_at}`;
        const taskId=(await sha(businessKey)).slice(0,24);
        const payload={source,recheck:{articleId:row.id,dueAt:row.due_at,configVersion:source.configVersion}};
        statements.push(
          env.DB.prepare(`INSERT INTO tasks(id,kind,business_key,source_id,article_id,payload_json,state,priority,due_at,attempt_no,created_at,updated_at)
            SELECT ?,'recheck',?,?,?,?,'queued',70,?,1,?,?
            FROM articles a WHERE id=? AND url=? AND latest_ready_revision_id IS NOT NULL AND next_recheck_at=? ${gate}
            ON CONFLICT(business_key) DO NOTHING RETURNING id`)
            .bind(taskId,businessKey,source.id,row.id,JSON.stringify(payload),at,at,at,row.id,row.url,row.due_at,...gateArgs),
          launchOutboxStatement(env,{id:await launchOutboxId(taskId,1),taskId,attempt:1,timestamp:at,
            guardSql:'kind=?',guardArgs:['recheck']}),
          env.DB.prepare(`UPDATE articles AS a SET next_recheck_at=? WHERE id=? AND url=? AND latest_ready_revision_id IS NOT NULL AND next_recheck_at=?
            ${gate} AND EXISTS(SELECT 1 FROM tasks t WHERE t.id=? AND t.kind='recheck' AND t.article_id=a.id AND t.source_id=?)`)
            .bind(nextDue,row.id,row.url,row.due_at,...gateArgs,taskId,source.id),
        );
      }
      // Scan progress is separate from the due date: incompatible archives remain
      // due but cannot monopolize every bounded page. Wrap after the current tail.
      const last=rows.results.length===pageSize?rows.results.at(-1):null;
      const taskStatements=statements.length;
      statements.push(env.DB.prepare(`UPDATE archive_recheck_cursor SET due_at=?,article_id=?,generation=generation+1
        WHERE id=1 AND generation=?`).bind(last?.due_at??0,last?.id??'',cursor.generation));
      const committed=await env.DB.batch(statements);
      const scheduled=[];
      for(let index=0;index<taskStatements;index+=3){
        const inserted=committed[index].results?.map(result=>result.id)??[];
        scheduled.push(...inserted);
      }
      return {scheduled,duplicate:scheduled.length===0};
    },

    async status(){
      const at=timestamp();
      const row=await env.DB.prepare(`SELECT
          COUNT(*) AS ready_articles,
          SUM(next_recheck_at<=?) AS due,
          (SELECT COUNT(*) FROM tasks WHERE kind='recheck') AS scheduled_tasks
        FROM articles WHERE latest_ready_revision_id IS NOT NULL`).bind(at).first();
      return {
        readyArticles:row.ready_articles,
        due:row.due??0,
        scheduledTasks:row.scheduled_tasks,
        intervalsSeconds:{
          recentAfter:policy.recentAfterMs/1000,
          recent:policy.recentIntervalMs/1000,
          old:policy.oldIntervalMs/1000,
        },
      };
    },
  };
}
