import {sha} from './utils.mjs';
import {createSources} from './sources.mjs';
import {launchOutboxId,launchOutboxStatement} from './task-statements.mjs';

const idPattern=/^[a-f0-9]{24}$/;

export function createArchiveRecheck(env,{now=()=>Date.now()}={}){
  const timestamp=()=>{
    const value=now();
    return value instanceof Date?value.getTime():value;
  };
  const recentAfterMs=boundedInteger(env.RECHECK_RECENT_AFTER_SEC,30*86_400,60,365*86_400,'RECHECK_RECENT_AFTER_SEC')*1000;
  const recentIntervalMs=boundedInteger(env.RECHECK_RECENT_INTERVAL_SEC,7*86_400,600,365*86_400,'RECHECK_RECENT_INTERVAL_SEC')*1000;
  const oldIntervalMs=boundedInteger(env.RECHECK_OLD_INTERVAL_SEC,30*86_400,600,365*86_400,'RECHECK_OLD_INTERVAL_SEC')*1000;

  return {
    async scheduleDue({limit=20}={}){
      const at=timestamp(),pageSize=boundedInteger(limit,20,1,100);
      const managed=env.SOURCE_MANAGEMENT_ENABLED==='true';
      const rows=await env.DB.prepare(`SELECT a.id,a.source_id,a.next_recheck_at AS due_at,r.observed_at,r.published_at
        FROM articles a
        JOIN article_revisions r ON r.id=a.latest_ready_revision_id AND r.article_id=a.id
        ${managed?'JOIN sources s ON s.id=a.source_id JOIN sites st ON st.id=s.site_id':''}
        WHERE a.latest_ready_revision_id IS NOT NULL AND a.next_recheck_at<=?
          ${managed?' AND s.enabled=1 AND st.enabled=1 AND s.validation_state=\'verified\'':''}
        ORDER BY a.next_recheck_at,a.id LIMIT ?`).bind(at,pageSize).all();
      if(!rows.results.length)return {scheduled:[],duplicate:false};

      const statements=[];
      for(const row of rows.results){
        const source=await createSources(env).find(row.source_id);
        if(!source)throw new Error(`Recheck source ${row.source_id} is unavailable`);
        const age=articleAgeMs(row,at);
        const interval=age<=recentAfterMs?recentIntervalMs:oldIntervalMs;
        const nextDue=at+interval,businessKey=`recheck:${row.id}:${row.due_at}`;
        const taskId=(await sha(businessKey)).slice(0,24);
        const payload={source,recheck:{articleId:row.id,dueAt:row.due_at,configVersion:source.configVersion}};
        statements.push(
          env.DB.prepare(`INSERT INTO tasks(id,kind,business_key,source_id,article_id,payload_json,state,priority,due_at,attempt_no,created_at,updated_at)
            SELECT ?,'recheck',?,?,?,?,'queued',70,?,1,?,?
            FROM articles WHERE id=? AND latest_ready_revision_id IS NOT NULL AND next_recheck_at=?
            ON CONFLICT(business_key) DO NOTHING RETURNING id`)
            .bind(taskId,businessKey,row.source_id,row.id,JSON.stringify(payload),at,at,at,row.id,row.due_at),
          launchOutboxStatement(env,{id:await launchOutboxId(taskId,1),taskId,attempt:1,timestamp:at,
            guardSql:'kind=?',guardArgs:['recheck']}),
          env.DB.prepare(`UPDATE articles SET next_recheck_at=? WHERE id=? AND latest_ready_revision_id IS NOT NULL AND next_recheck_at=?`)
            .bind(nextDue,row.id,row.due_at),
        );
      }
      const committed=await env.DB.batch(statements);
      const scheduled=[];
      for(let index=0;index<committed.length;index+=3){
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
          recentAfter:recentAfterMs/1000,
          recent:recentIntervalMs/1000,
          old:oldIntervalMs/1000,
        },
      };
    },
  };
}

function boundedInteger(value,fallback,min,max,name='setting'){
  if(value===undefined||value===null)return fallback;
  const number=Number(value);
  if(!Number.isSafeInteger(number)||number<min||number>max)
    throw new Error(`Recheck configuration ${name} must be an integer from ${min} to ${max}`);
  return number;
}

function articleAgeMs(row,at){
  const publishedAt=Date.parse(row.published_at??'');
  return Number.isFinite(publishedAt)?at-publishedAt:at-row.observed_at;
}
