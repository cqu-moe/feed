import staticSources from './sources.json';
import {savedDiscoveryPage} from './discovery-journal.mjs';
import {verifySource} from './source-validation.mjs';
import {launchOutboxId,launchOutboxStatement} from './task-statements.mjs';
import {articleSourceAssociationStatements} from './notifications.mjs';
import {articleId,cleanError,cutoffDate,sha} from './utils.mjs';

const sourceSelect=`SELECT s.*,st.origin AS site_origin,st.enabled AS site_enabled
  FROM sources s JOIN sites st ON st.id=s.site_id`;
const trackingParameters=[/^utm_/i,/^fbclid$/i,/^gclid$/i,/^spm$/i];

export function createSources(env,{now=()=>Date.now(),scrape}={}){
  const timestamp=()=>{const value=now();return value instanceof Date?value.getTime():value;};

  async function list(){
    if(env.SOURCE_MANAGEMENT_ENABLED!=='true')return staticSources.map(sourceFromStatic);
    try{
      const rows=await env.DB.prepare(`${sourceSelect} ORDER BY st.origin,s.id`).all();
      return rows.results.map(rowFromDb);
    }catch(error){
      if(/no such column|no such table/i.test(String(error)))return staticSources.map(sourceFromStatic);
      throw error;
    }
  }

  return {
    all:list,
    async find(sourceId){
      if(typeof sourceId!=='string'||!sourceId) return null;
      if(env.SOURCE_MANAGEMENT_ENABLED!=='true')return staticSources.find(source=>source.id===sourceId)??null;
      try{
        const row=await env.DB.prepare(`${sourceSelect} WHERE s.id=?`).bind(sourceId).first();
        return row?rowFromDb(row):null;
      }catch(error){
        if(/no such column|no such table/i.test(String(error)))return staticSources.find(source=>source.id===sourceId)??null;
        throw error;
      }
    },

    async listSites(){
      const rows=await env.DB.prepare('SELECT * FROM sites ORDER BY origin,id').all();
      return rows.results.map(row=>({
        id:row.id,name:row.name,origin:row.origin,enabled:row.enabled===1,
        updatedAt:row.updated_at,
      }));
    },
    async createSite({name,origin,requestId}){
      if(!/^[A-Za-z0-9._:-]{8,100}$/.test(requestId??''))throw validationError('requestId must contain 8-100 URI-safe characters');
      const parsed=parseOrigin(origin),title=requiredText(name,'name',80);
      const id=(await sha(`site-create:${requestId}`)).slice(0,24),at=timestamp();
      const commandHash=await sha(JSON.stringify({name:title,origin:parsed.origin}));
      await env.DB.prepare(`INSERT INTO sites(id,name,origin,create_command_hash,enabled,created_at,updated_at)
        VALUES (?,?,?,?,1,?,?) ON CONFLICT(id) DO NOTHING`).bind(id,title,parsed.origin,commandHash,at,at).run();
      const row=await env.DB.prepare('SELECT create_command_hash FROM sites WHERE id=?').bind(id).first();
      if(row?.create_command_hash!==commandHash){
        const error=validationError('This requestId was used for a different site creation command');error.status=409;throw error;
      }
      return {site:await this.site(id)};
    },
    async site(id){
      if(!/^[a-f0-9]{24}$/.test(id??''))return null;
      const row=await env.DB.prepare('SELECT * FROM sites WHERE id=?').bind(id).first();
      return row?{id:row.id,name:row.name,origin:row.origin,enabled:row.enabled===1,updatedAt:row.updated_at}:null;
    },
    async updateSite(id,{name,enabled}){
      const values=await parseUpdate({name,enabled});
      if(!Object.keys(values).length)throw validationError('No site fields to update');
      const assignments=Object.entries(values).map(([key])=>`${key}=?`).join(',');
      const row=await env.DB.prepare(`UPDATE sites SET ${assignments},updated_at=? WHERE id=? RETURNING *`)
        .bind(...Object.values(values),timestamp(),id).first();
      return row?this.site(id):null;
    },

    async listSources(){
      const sources=await list();
      try{
        const rows=await env.DB.prepare(`SELECT source_id,COUNT(*) AS n FROM article_sources GROUP BY source_id`).all();
        const counts=new Map(rows.results.map(row=>[row.source_id,row.n]));
        return sources.map(source=>({...source,articleCount:counts.get(source.id)??0}));
      }catch(error){
        if(!/no such table/i.test(String(error)))throw error;
        const rows=await env.DB.prepare('SELECT source_id,COUNT(*) AS n FROM articles GROUP BY source_id').all();
        const counts=new Map(rows.results.map(row=>[row.source_id,row.n]));
        return sources.map(source=>({...source,articleCount:counts.get(source.id)??0}));
      }
    },
    async createSource(command){
      const input=await parseSourceCommand(env,command,{forCreate:true});
      const id=(await sha(`source:${input.siteId}:${input.listUrl.href}`)).slice(0,24),at=timestamp();
      await env.DB.prepare(`INSERT INTO sources(id,site_id,name,url,list_url,adapter_key,config_json,config_version,
        enabled,refresh_interval_sec,next_discovery_at,baseline_cutoff_at,source_timezone,validation_state,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,1,0,?,0,?,?,'draft',?,?) ON CONFLICT(id) DO NOTHING`)
        .bind(id,input.siteId,input.name,input.origin,input.listUrl.href,input.adapterKey,
          JSON.stringify({articlePattern:input.articlePattern,sampleArticleUrl:input.sampleArticleUrl.href}),input.refreshIntervalSec,
          input.baselineCutoffAt,input.timezone,at,at).run();
      const source=await this.readSource(id);
      if(source.siteId!==input.siteId||source.name!==input.name||source.listUrl!==input.listUrl.href
        ||source.config.articlePattern!==input.articlePattern||source.config.sampleArticleUrl!==input.sampleArticleUrl.href
        ||source.refreshIntervalSec!==input.refreshIntervalSec||source.timezone!==input.timezone){
        const error=validationError('This list URL already has a source; edit its existing configuration');error.status=409;throw error;
      }
      return {source};
    },
    async readSource(id){
      const source=await this.find(id);
      if(!source)return null;
      const rows=await env.DB.prepare('SELECT COUNT(*) AS n FROM article_sources WHERE source_id=?').bind(id).first();
      return {...source,articleCount:rows.n};
    },
    async discoveries(id){
      const rows=await env.DB.prepare(`SELECT article_id AS articleId,source_id AS sourceId,
        first_seen_at AS firstSeenAt,last_seen_at AS lastSeenAt,discovery_class AS discoveryClass,
        published_at AS publishedAt,published_day AS publishedDay,date_precision AS datePrecision,source_timezone AS timezone
        FROM article_sources WHERE source_id=? ORDER BY first_seen_at DESC,article_id LIMIT 100`).bind(id).all();
      return rows.results;
    },
    async updateSource(id,command){
      const current=await this.find(id);
      if(!current)return null;
      const input=await parseSourceCommand(env,{...commandToCurrent(current),...command},{forCreate:false});
      const nextConfig={
        articlePattern:input.articlePattern,
        ...(input.listUrl.href===current.listUrl&&Array.isArray(current.config.listUrls)?{listUrls:current.config.listUrls}:{}),
        ...(input.sampleArticleUrl?{sampleArticleUrl:input.sampleArticleUrl.href}:{}),
      };
      const semanticChanged=input.name!==current.name||input.listUrl.href!==current.listUrl
        ||input.articlePattern!==current.config.articlePattern||input.refreshIntervalSec!==current.refreshIntervalSec
        ||input.timezone!==current.timezone||input.siteId!==current.siteId
        ||(input.sampleArticleUrl?.href??null)!==(current.config.sampleArticleUrl??null)
        ||input.baselineCutoffAt!==(current.baselineCutoffAt??null);
      const enabled=command.enabled===undefined?current.enabled:command.enabled;
      if(typeof enabled!=='boolean')throw validationError('enabled must be boolean');
      if(enabled&&current.validationState!=='verified'){
        const error=validationError('Source must pass sample verification before enablement');error.status=409;throw error;
      }
      if(semanticChanged&&enabled&&!['verified'].includes(current.validationState))throw validationError('Source must pass sample verification before enablement');
      if(semanticChanged&&current.enabled)throw validationError('Disable the source before changing its adapter configuration');
      if(semanticChanged&&enabled)throw validationError('Disable the source before changing its adapter configuration');
      const version=semanticChanged?current.configVersion+1:current.configVersion;
      const state=semanticChanged?'draft':current.validationState;
      const changed=await env.DB.prepare(`UPDATE sources SET site_id=?,name=?,url=?,list_url=?,config_json=?,config_version=?,
        enabled=?,refresh_interval_sec=?,baseline_cutoff_at=?,source_timezone=?,validation_state=?,validation_json=?,
        validated_at=?,updated_at=? WHERE id=? AND config_version=? AND enabled=? RETURNING id`)
        .bind(input.siteId,input.name,input.origin,input.listUrl.href,JSON.stringify(nextConfig),
          version,enabled?1:0,input.refreshIntervalSec,input.baselineCutoffAt,input.timezone,
          state,semanticChanged?null:JSON.stringify(current.validationJson),semanticChanged?null:current.validatedAt,timestamp(),id,current.configVersion,current.enabled?1:0).first();
      if(!changed){const error=validationError('Source changed; reload before saving');error.status=409;throw error;}
      return {source:await this.readSource(id)};
    },
    async submitValidation(id,{requestId}={}){
      if(!/^[A-Za-z0-9._:-]{8,100}$/.test(requestId??''))throw validationError('requestId must contain 8-100 URI-safe characters');
      const source=await this.find(id);
      if(!source)throw validationError('Source not found');
      if(source.enabled)throw validationError('Disable the source before sample verification');
      const key=`validate:${id}:${source.configVersion}:${requestId}`,taskId=(await sha(key)).slice(0,24),at=timestamp();
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO tasks(id,kind,business_key,source_id,payload_json,state,due_at,created_at,updated_at)
          SELECT ?,'discover',?,?,?,'queued',?,?,? FROM sources WHERE id=? AND config_version=? AND enabled=0
          ON CONFLICT(business_key) DO NOTHING`)
          .bind(taskId,key,id,JSON.stringify({source,mode:'validate'}),at,at,at,id,source.configVersion),
        env.DB.prepare(`UPDATE sources SET validation_task_id=?,validation_state='draft',validation_json=NULL,validated_at=NULL
          WHERE id=? AND config_version=? AND enabled=0 AND EXISTS(SELECT 1 FROM tasks WHERE id=? AND state='queued')`)
          .bind(taskId,id,source.configVersion,taskId),
        launchOutboxStatement(env,{id:await launchOutboxId(taskId,1),taskId,attempt:1,timestamp:at}),
      ]);
      const task=await env.DB.prepare('SELECT id,state,source_id AS sourceId FROM tasks WHERE id=?').bind(taskId).first();
      if(!task){const error=validationError('Source changed; reload before verification');error.status=409;throw error;}
      return {task,source:await this.readSource(id)};
    },

    async submitBackfill(id,command={}){
      if(!/^[A-Za-z0-9._:-]{8,100}$/.test(command?.requestId??''))throw validationError('requestId must contain 8-100 URI-safe characters');
      if(command?.windowDays!==undefined&&(!Number.isSafeInteger(command.windowDays)||command.windowDays<1||command.windowDays>3650))
        throw validationError('windowDays must be an integer from 1 to 3650');
      const source=await this.find(id);
      if(!source)return null;
      if(!source.enabled||!source.siteEnabled||source.validationState!=='verified')
        throw validationError('Backfill requires an enabled, verified source');
      if(source.backfill.state!=='idle'&&source.backfill.state!=='failed'){
        return {source:await this.readSource(id),task:source.backfill.state==='running'
          ?await env.DB.prepare(`SELECT id,state FROM tasks WHERE source_id=? AND kind='backfill'
              AND state IN ('queued','starting','running','deferred') ORDER BY created_at DESC,id LIMIT 1`).bind(id).first()
          :null};
      }
      const at=timestamp(),windowDays=command.windowDays??source.backfill.windowDays
        ??boundedInteger(env.DEFAULT_BACKFILL_WINDOW_DAYS,365,1,3650);
      const runId=(await sha(`backfill-run:${id}:${command.requestId}`)).slice(0,16);
      const windowStart=localDay(at-windowDays*86400000,source.timezone);
      const checkpoint={nextUrls:sourceStartUrls(source),visited:[],processedArticleIds:[]};
      const snapshot={...source,backfill:{...source.backfill,state:'running',windowDays,windowStart,runId}};
      const built=await backfillTaskStatements(env,snapshot,{
        page:1,checkpoint,runId,windowStart,
      },{timestamp:at});
      const committed=await env.DB.batch([
        env.DB.prepare(`UPDATE sources SET backfill_state='running',backfill_window_days=?,backfill_window_start=?,
            backfill_run_id=?,backfill_next_at=?,backfill_started_at=?,backfill_completed_at=NULL,
            backfill_seen_pages=0,backfill_processed_articles=0,backfill_last_error=NULL,updated_at=?
          WHERE id=? AND config_version=? AND enabled=1 AND backfill_state IN ('idle','failed')`)
          .bind(windowDays,windowStart,runId,at+60000,at,at,id,source.configVersion),
        ...built.statements,
      ]);
      if(!committed[0].meta?.changes){
        const error=validationError('Backfill changed; reload before starting');error.status=409;throw error;
      }
      return {source:await this.readSource(id),task:await env.DB.prepare('SELECT id,state FROM tasks WHERE id=?').bind(built.taskId).first()};
    },

    async pauseBackfill(id){
      const source=await this.find(id);
      if(!source)return null;
      if(!['running','failed'].includes(source.backfill.state)){
        const error=validationError(`Backfill cannot pause from ${source.backfill.state}`);error.status=409;throw error;
      }
      await env.DB.prepare(`UPDATE sources SET backfill_state='paused',backfill_next_at=?,updated_at=?
        WHERE id=? AND config_version=? AND backfill_state IN ('running','failed')`)
        .bind(timestamp(),timestamp(),id,source.configVersion).run();
      return {source:await this.readSource(id)};
    },

    async resumeBackfill(id){
      const source=await this.find(id);
      if(!source)return null;
      if(source.backfill.state!=='paused'){
        const error=validationError(`Backfill cannot resume from ${source.backfill.state}`);error.status=409;throw error;
      }
      const at=timestamp();
      await env.DB.batch([
        env.DB.prepare(`UPDATE tasks SET due_at=?,updated_at=?
          WHERE source_id=? AND kind='backfill' AND state='deferred'`)
          .bind(at,at,id),
        env.DB.prepare(`UPDATE tasks SET state='deferred',due_at=?,updated_at=?
          WHERE source_id=? AND kind='backfill' AND state IN ('failed','blocked','cancelled')`)
          .bind(at,at,id),
        env.DB.prepare(`UPDATE sources SET backfill_state='running',backfill_next_at=?,updated_at=?
          WHERE id=? AND config_version=? AND backfill_state='paused'`)
          .bind(at,at,id,source.configVersion),
      ]);
      return {source:await this.readSource(id)};
    },
    async recordValidation(id,configVersion,evidence,{taskId,attemptNo}){
      const at=timestamp(),outcome={sourceId:id,mode:'validate',verified:true,evidence};
      const guard=`EXISTS(SELECT 1 FROM tasks WHERE id=? AND attempt_no=? AND state='running')`;
      const committed=await env.DB.batch([
        env.DB.prepare(`UPDATE sources SET validation_state='verified',validation_json=?,validated_at=?,updated_at=?
          WHERE id=? AND config_version=? AND validation_task_id=? AND enabled=0 AND ${guard} RETURNING id`)
          .bind(JSON.stringify(evidence),at,at,id,configVersion,taskId,taskId,attemptNo),
        env.DB.prepare(`UPDATE task_attempts SET result_json=COALESCE(result_json,?) WHERE task_id=? AND attempt_no=? AND ${guard}
          AND EXISTS(SELECT 1 FROM sources WHERE id=? AND config_version=? AND validation_task_id=? AND validated_at=?)`)
          .bind(JSON.stringify(outcome),taskId,attemptNo,taskId,attemptNo,id,configVersion,taskId,at),
      ]);
      return committed[0].results?.length?outcome:{superseded:true};
    },
    async recordValidationFailure(id,configVersion,error,{taskId,attemptNo}){
      await env.DB.prepare(`UPDATE sources SET validation_state='failed',validation_json=?,updated_at=?
        WHERE id=? AND config_version=? AND validation_task_id=?
        AND EXISTS(SELECT 1 FROM tasks WHERE id=? AND attempt_no=? AND state='running')`)
        .bind(JSON.stringify({error:cleanError(error)}),timestamp(),id,configVersion,taskId,taskId,attemptNo).run();
    },

    async scheduleDaily(nonce='daily'){
      if(env.CRAWL_ENABLED!=='true')return [];
      const time=timestamp(),day=new Date(time).toISOString().slice(0,10),ids=[];
      for(const source of staticSources){
        const id=`${day}-${source.id}-${nonce}`;
        try{
          await env.INGEST.create({id,params:{sourceId:source.id,cutoff:cutoffDate(time)}});
          ids.push(id);
        }catch(error){
          if(!/already exists/i.test(String(error)))throw error;
          ids.push(id);
        }
      }
      return ids;
    },

    async scheduleDue({limit=20}={}){
      if(env.CRAWL_ENABLED!=='true'||env.TASK_RUNTIME_ENABLED!=='true'||env.SOURCE_MANAGEMENT_ENABLED!=='true')return {scheduled:[]};
      const at=timestamp(),size=boundedInteger(limit,20,1,100);
      const liveBudget=Math.min(size,boundedInteger(env.MAX_LIVE_DISCOVERY_TASKS_PER_RUN,20,1,100));
      const backfillBudget=Math.min(size,boundedInteger(env.MAX_BACKFILL_TASKS_PER_RUN,5,1,100));
      const rows=await env.DB.prepare(`${sourceSelect}
        WHERE s.enabled=1 AND st.enabled=1 AND s.validation_state='verified' AND s.next_discovery_at<=?
        ORDER BY s.next_discovery_at,s.id LIMIT ?`).bind(at,liveBudget).all();
      const scheduled=[];const scheduledIds=[];
      for(const row of rows.results){
        try{
          const source=rowFromDb(row),slot=row.next_discovery_at>0?row.next_discovery_at:at;
          const built=await discoveryTaskStatements(env,source,{
            page:1,checkpoint:{nextUrls:sourceStartUrls(source),visited:[]},scheduledSlot:slot,previousDue:row.next_discovery_at,
          },{timestamp:at,advanceSource:true});
          const committed=await env.DB.batch(built.statements);
          if(!committed[1].results?.length)continue;
          const taskId=built.taskId;
          scheduled.push(taskId);
          scheduledIds.push(taskId);
        }catch(error){
          if(!/UNIQUE constraint failed: tasks.business_key/i.test(String(error)))throw error;
        }
      }
      const backfillRows=await env.DB.prepare(`${sourceSelect}
        WHERE s.enabled=1 AND st.enabled=1 AND s.validation_state='verified'
          AND s.backfill_state='running' AND s.backfill_next_at<=?
          AND NOT EXISTS(SELECT 1 FROM tasks pending_backfill
            WHERE pending_backfill.source_id=s.id AND pending_backfill.kind='backfill'
              AND pending_backfill.state IN ('queued','starting','running','deferred'))
        ORDER BY s.backfill_next_at,s.id LIMIT ?`).bind(at,backfillBudget).all();
      for(const row of backfillRows.results){
        try{
          const source=rowFromDb(row),checkpoint=source.backfillCursor??{nextUrls:sourceStartUrls(source),visited:[],processedArticleIds:[]};
          const page=boundedInteger(Number(source.backfillCursor?.page),1,1,1000);
          const built=await backfillTaskStatements(env,source,{
            page,checkpoint,runId:source.backfill.runId,windowStart:source.backfill.windowStart,
          },{timestamp:at});
          const committed=await env.DB.batch([
            env.DB.prepare(`UPDATE sources SET backfill_next_at=?,updated_at=?
              WHERE id=? AND config_version=? AND backfill_state='running'
                AND NOT EXISTS(SELECT 1 FROM tasks pending_backfill
                  WHERE pending_backfill.source_id=sources.id AND pending_backfill.kind='backfill'
                    AND pending_backfill.state IN ('queued','starting','running','deferred'))`)
              .bind(at+60000,at,source.id,source.configVersion),
            ...built.statements,
          ]);
          if(!committed[0].meta?.changes&&!committed[1].results?.length)continue;
          if(committed[1].results?.length){
            scheduled.push(built.taskId);
            scheduledIds.push(built.taskId);
          }
        }catch(error){
          if(!/UNIQUE constraint failed: tasks.business_key/i.test(String(error)))throw error;
        }
      }
      return {scheduled,taskIds:scheduledIds};
    },

    async discover(taskId,attemptNo){
      if(!/^[a-f0-9]{24}$/.test(taskId??''))throw validationError('Invalid discovery task id');
      const task=await env.DB.prepare(`SELECT t.*,ta.result_json FROM tasks t
        JOIN task_attempts ta ON ta.task_id=t.id AND ta.attempt_no=t.attempt_no
      WHERE t.id=? AND t.kind IN ('discover','backfill') AND t.attempt_no=? AND t.state='running'`).bind(taskId,attemptNo).first();
      if(!task)return {superseded:true};
      if(task.result_json)return JSON.parse(task.result_json);
      const context=JSON.parse(task.payload_json),source=context.source;
      if(context.mode==='validate')return verifySource(env,this,source.id,{source,taskId,attemptNo,scrape});
      if(source?.id!==task.source_id||source?.configVersion===undefined)throw validationError('Discovery source snapshot is invalid');
      const isBackfill=context.mode==='backfill';
      if(isBackfill){
        const control=await env.DB.prepare('SELECT backfill_state FROM sources WHERE id=? AND config_version=?')
          .bind(source.id,source.configVersion).first();
        if(control?.backfill_state!=='running')
          return {deferred:true,error:'Backfill is paused',retryAfterMs:12*60*60*1000};
      }
      const checkpoint=context.checkpoint??{};
      let urls=Array.isArray(checkpoint.nextUrls)?checkpoint.nextUrls:[source.listUrl];
      const visited=new Set(Array.isArray(checkpoint.visited)?checkpoint.visited:[]);
      const processedArticleIds=new Set(Array.isArray(checkpoint.processedArticleIds)?checkpoint.processedArticleIds:[]);
      const page=boundedInteger(context.page,1,1,1000);
      const currentUrl=urls.shift();
      if(typeof currentUrl!=='string'||visited.has(currentUrl))throw validationError('Discovery cursor is invalid');
      let result;
      try{
        result=await savedDiscoveryPage(env,source,taskId,currentUrl,{
          scrape,now,
          baselineCutoffAt:isBackfill?context.windowStart:(source.baselineCutoffAt??cutoffDate(timestamp())),
        });
      }catch(error){
        if(isBackfill)await env.DB.prepare(`UPDATE sources SET backfill_last_error=?,updated_at=?
          WHERE id=? AND config_version=? AND backfill_state='running'`)
          .bind(cleanError(error),timestamp(),source.id,source.configVersion).run();
        throw error;
      }
      visited.add(currentUrl);
      const nextPageUrls=[...new Set([...urls,...result.next])].filter(url=>!visited.has(url));
      const candidates=result.articles.filter(row=>{
        if(row.precision==='unknown')return true;
        const today=new Date(timestamp()+86400000).toISOString().slice(0,10);
        return row.publishedDay>=result.baselineCutoff&&row.publishedDay<=today;
      });
      const at=timestamp(),statements=[];
      const activeTask={sql:'EXISTS(SELECT 1 FROM tasks active_task WHERE active_task.id=? AND active_task.attempt_no=? AND active_task.state=\'running\')',args:[taskId,attemptNo]};
      for(const row of candidates){
        const aid=await articleId(row.url);
        processedArticleIds.add(aid);
        const captureBusinessKey=`capture:${aid}:discovery-initial`;
        const captureTaskId=(await sha(captureBusinessKey)).slice(0,24);
        statements.push(
          env.DB.prepare(`INSERT INTO articles(id,source_id,url,title,published_at,discovered_at,status)
            SELECT ?,?,?,?,?,?,'pending' WHERE ${activeTask.sql} ON CONFLICT(url) DO NOTHING`)
            .bind(aid,source.id,row.url,row.title,row.precision==='unknown'?'unknown':row.publishedDay,new Date(result.observedAt).toISOString(),...activeTask.args),
          env.DB.prepare(`INSERT INTO article_sources(article_id,source_id,first_seen_at,last_seen_at,discovery_class,published_at,published_day,date_precision,source_timezone)
            SELECT ?,?,?,?,?,?,?,?,? WHERE ${activeTask.sql}
            ON CONFLICT(article_id,source_id) DO UPDATE SET last_seen_at=excluded.last_seen_at`)
            .bind(aid,source.id,result.observedAt,result.observedAt,
              isBackfill?'backfill':'live',row.precision==='minute'?row.publishedAt:null,row.precision==='unknown'?null:row.publishedDay,
              row.precision,source.timezone,...activeTask.args),
          env.DB.prepare(`INSERT INTO tasks(id,kind,business_key,source_id,article_id,payload_json,state,priority,due_at,attempt_no,created_at,updated_at)
            SELECT ?,'capture',?,?,?,?,'queued',80,?,1,?,? WHERE ${activeTask.sql}
              AND EXISTS(SELECT 1 FROM article_sources WHERE article_id=? AND source_id=?)
            ON CONFLICT(business_key) DO NOTHING`)
            .bind(captureTaskId,captureBusinessKey,source.id,aid,
              JSON.stringify({source,captureIntent:isBackfill?'backfill':'live',discovery:{articleId:aid,configVersion:source.configVersion,page,scheduledSlot:context.scheduledSlot,captureIntent:isBackfill?'backfill':'live'}}),
              at,at,at,...activeTask.args,aid,source.id),
          launchOutboxStatement(env,{id:await launchOutboxId(captureTaskId,1),taskId:captureTaskId,attempt:1,timestamp:at,
            guardSql:'kind=? AND '+activeTask.sql,guardArgs:['capture',...activeTask.args]}),
        );
        const association=await articleSourceAssociationStatements(env,{
          articleId:aid,sourceId:source.id,timestamp:at,discoveryTaskId:taskId,taskGuard:activeTask,
        });
        statements.push(...association.statements);
      }
      const continuation=!isBackfill&&nextPageUrls.length&&page<boundedInteger(env.MAX_DISCOVERY_PAGES_PER_RUN,2,1,10);
      const hasBackfillContinuation=isBackfill&&nextPageUrls.length>0;
      const checkpointJson=JSON.stringify({
        nextUrls:continuation||hasBackfillContinuation?nextPageUrls:[],visited:[...visited],verifiedUpTo:currentUrl,page,
        processedArticleIds:[...processedArticleIds],
      });
      if(!isBackfill&&continuation){
        const continuationTask=await discoveryTaskStatements(env,source,{
          page:page+1,checkpoint:{nextUrls:nextPageUrls,visited:[...visited]},scheduledSlot:context.scheduledSlot,
        },{timestamp:at,advanceSource:false,taskGuard:activeTask});
        statements.push(...continuationTask.statements);
        statements.push(env.DB.prepare(`UPDATE tasks SET checkpoint_json=? WHERE id=? AND ${activeTask.sql} RETURNING id`)
          .bind(JSON.stringify({continuationTaskId:continuationTask.taskId}),taskId,...activeTask.args));
      }else if(isBackfill&&nextPageUrls.length){
        const continuationTask=await backfillTaskStatements(env,source,{
          page:page+1,checkpoint:{nextUrls:nextPageUrls,visited:[...visited],processedArticleIds:[...processedArticleIds]},
          runId:context.runId,windowStart:context.windowStart,
        },{timestamp:at,taskGuard:activeTask});
        statements.push(...continuationTask.statements);
        statements.push(env.DB.prepare(`UPDATE tasks SET checkpoint_json=? WHERE id=? AND ${activeTask.sql} RETURNING id`)
          .bind(JSON.stringify({continuationTaskId:continuationTask.taskId}),taskId,...activeTask.args));
      }else{
        statements.push(env.DB.prepare(`UPDATE tasks SET checkpoint_json=? WHERE id=? AND ${activeTask.sql} RETURNING id`)
          .bind(checkpointJson,taskId,...activeTask.args));
      }
      const checkpointIndex=statements.length-1;
      const outcome={sourceId:source.id,mode:isBackfill?'backfill':'live',page,candidates:candidates.length,
        undated:result.undated,continuation:Boolean(continuation||hasBackfillContinuation),checkpoint:JSON.parse(checkpointJson)};
      statements.push(env.DB.prepare(`UPDATE task_attempts SET result_json=COALESCE(result_json,?) WHERE task_id=? AND attempt_no=? AND ${activeTask.sql}`)
        .bind(JSON.stringify(outcome),taskId,attemptNo,...activeTask.args));
      statements.push(isBackfill
        ?env.DB.prepare(`UPDATE sources SET last_run_at=?,error=NULL,backfill_cursor=?,backfill_seen_pages=backfill_seen_pages+1,
            backfill_processed_articles=?,backfill_next_at=?,
            backfill_state=CASE WHEN ? THEN 'completed' ELSE 'running' END,
            backfill_completed_at=CASE WHEN ? THEN ? ELSE backfill_completed_at END,
            backfill_last_error=NULL,updated_at=? WHERE id=? AND config_version=? AND backfill_state='running' AND ${activeTask.sql}`)
          .bind(new Date(at).toISOString(),checkpointJson,processedArticleIds.size,at,
            nextPageUrls.length?0:1,nextPageUrls.length?0:1,nextPageUrls.length?null:at,
            at,source.id,source.configVersion,...activeTask.args)
        :env.DB.prepare(`UPDATE sources SET last_run_at=?,error=NULL,updated_at=? WHERE id=? AND config_version=? AND ${activeTask.sql}`)
          .bind(new Date(at).toISOString(),at,source.id,source.configVersion,...activeTask.args));
      let committed;
      try{committed=await env.DB.batch(statements);}
      catch(error){
        if(isBackfill)await env.DB.prepare(`UPDATE sources SET backfill_last_error=?,updated_at=?
          WHERE id=? AND config_version=? AND backfill_state='running'`)
          .bind(cleanError(error),timestamp(),source.id,source.configVersion).run().catch(()=>{});
        const receipt=await env.DB.prepare('SELECT result_json FROM task_attempts WHERE task_id=? AND attempt_no=?').bind(taskId,attemptNo).first();
        if(receipt?.result_json)return JSON.parse(receipt.result_json);
        return {deferred:true,error:cleanError(error),savedPage:true};
      }
      if(!committed[checkpointIndex].results?.length)return {superseded:true};
      return outcome;
    },
  };
}

async function discoveryTaskStatements(env,source,context,{timestamp,advanceSource,taskGuard}){
  const businessKey=`discover:${source.id}:${source.configVersion}:${context.scheduledSlot}:p${context.page}`;
  const taskId=(await sha(businessKey)).slice(0,24);
  const payload={source,checkpoint:context.checkpoint,page:context.page,scheduledSlot:context.scheduledSlot};
  const nextDue=timestamp+source.refreshIntervalSec*1000;
  const statements=[];
  const sourceGuard=advanceSource
    ?'enabled=1 AND validation_state=\'verified\' AND next_discovery_at=?'
    :"enabled=1 AND validation_state='verified'";
  if(advanceSource){
    statements.push(env.DB.prepare(`UPDATE sources SET next_discovery_at=?,updated_at=? WHERE id=? AND next_discovery_at=? AND config_version=? AND enabled=1 AND validation_state='verified'
        AND EXISTS(SELECT 1 FROM sites WHERE sites.id=sources.site_id AND sites.enabled=1)`)
      .bind(nextDue,timestamp,source.id,context.previousDue,source.configVersion));
  }
  const parentGuard=taskGuard?` AND ${taskGuard.sql}`:'';
  const parentGuardArgs=taskGuard?[...taskGuard.args]:[];
  statements.push(
    env.DB.prepare(`INSERT INTO tasks(id,kind,business_key,source_id,article_id,payload_json,state,priority,due_at,attempt_no,created_at,updated_at)
      SELECT ?,'discover',?,?,NULL,?,'queued',90,?,1,?,? FROM sources WHERE id=? AND config_version=? AND EXISTS(SELECT 1 FROM sites WHERE sites.id=sources.site_id AND sites.enabled=1) AND ${sourceGuard}${parentGuard}
      ON CONFLICT(business_key) DO NOTHING RETURNING id`)
      .bind(taskId,businessKey,source.id,JSON.stringify(payload),timestamp,timestamp,timestamp,source.id,source.configVersion,...(advanceSource?[nextDue]:[]),...parentGuardArgs),
    launchOutboxStatement(env,{id:await launchOutboxId(taskId,1),taskId,attempt:1,timestamp,
      guardSql:'kind=?',guardArgs:['discover']}),
  );
  return {taskId,statements};
}

async function backfillTaskStatements(env,source,context,{timestamp,taskGuard}){
  const cursorHash=(await sha(JSON.stringify(context.checkpoint))).slice(0,16);
  const businessKey=`backfill:${source.id}:${context.runId}:p${context.page}:${cursorHash}`;
  const taskId=(await sha(businessKey)).slice(0,24);
  const payload={source,mode:'backfill',page:context.page,checkpoint:context.checkpoint,
    runId:context.runId,windowStart:context.windowStart};
  const parentGuard=taskGuard?` AND ${taskGuard.sql}`:'';
  const parentGuardArgs=taskGuard?[...taskGuard.args]:[];
  return {
    taskId,
    statements:[
      env.DB.prepare(`INSERT INTO tasks(id,kind,business_key,source_id,payload_json,state,priority,due_at,attempt_no,created_at,updated_at)
        SELECT ?,'backfill',?,?,?,'queued',85,?,1,?,?
        FROM sources WHERE id=? AND config_version=? AND enabled=1 AND backfill_state='running'
          AND EXISTS(SELECT 1 FROM sites WHERE sites.id=sources.site_id AND sites.enabled=1)${parentGuard}
        ON CONFLICT(business_key) DO NOTHING RETURNING id`)
        .bind(taskId,businessKey,source.id,JSON.stringify(payload),timestamp,timestamp,timestamp,
          source.id,source.configVersion,...parentGuardArgs),
      launchOutboxStatement(env,{id:await launchOutboxId(taskId,1),taskId,attempt:1,timestamp,
        guardSql:"kind='backfill'",guardArgs:[]}),
    ],
  };
}

function sourceStartUrls(source){
  const configured=source.config?.listUrls;
  if(Array.isArray(configured)&&configured.length)return [...new Set(configured.filter(url=>typeof url==='string'))];
  return [source.listUrl];
}

function rowFromDb(row){
  const config=safeJson(row.config_json,{});
  const cursor=safeJson(row.backfill_cursor,null);
  return {
    id:row.id,siteId:row.site_id,name:row.name,url:row.site_origin??row.url,listUrl:row.list_url??row.url,
    articlePattern:config.articlePattern,listUrls:config.listUrls??[row.list_url??row.url],
    adapterKey:row.adapter_key,config:{
      articlePattern:config.articlePattern??'^/info/\\d+/\\d+\\.htm$',
      ...(Array.isArray(config.listUrls)?{listUrls:config.listUrls}:{}),
      ...(config.sampleArticleUrl?{sampleArticleUrl:config.sampleArticleUrl}:{}),
    },
    configVersion:row.config_version,enabled:row.enabled===1,siteEnabled:row.site_enabled===1,
    refreshIntervalSec:row.refresh_interval_sec,nextDiscoveryAt:row.next_discovery_at,
    baselineCutoffAt:row.baseline_cutoff_at,backfillCursor:cursor,
    validationState:row.validation_state,validationJson:safeJson(row.validation_json,null),
    validatedAt:row.validated_at,validationTaskId:row.validation_task_id,timezone:row.source_timezone,
    lastRunAt:row.last_run_at,error:row.error,
    backfill:{
      state:row.backfill_state,windowDays:row.backfill_window_days,windowStart:row.backfill_window_start,
      runId:row.backfill_run_id,nextAt:row.backfill_next_at,startedAt:row.backfill_started_at,
      completedAt:row.backfill_completed_at,seenPages:row.backfill_seen_pages,
      processedArticles:row.backfill_processed_articles,lastError:row.backfill_last_error,
      remainingUrls:Array.isArray(cursor?.nextUrls)?cursor.nextUrls.length:null,
    },
  };
}

function sourceFromStatic(source){
  return {
    ...source,id:source.id,name:source.name,url:source.url,listUrl:source.listUrls[0],adapterKey:'cqu-generic',
    config:{articlePattern:source.articlePattern,listUrls:source.listUrls},configVersion:1,enabled:true,siteEnabled:true,
    refreshIntervalSec:86400,nextDiscoveryAt:0,baselineCutoffAt:null,backfillCursor:null,
    validationState:'verified',validationJson:null,validatedAt:null,timezone:'Asia/Shanghai',lastRunAt:null,error:null,
    backfill:{state:'idle',windowDays:null,windowStart:null,runId:null,nextAt:0,startedAt:null,
      completedAt:null,seenPages:0,processedArticles:0,lastError:null,remainingUrls:null},
  };
}

async function parseSourceCommand(env,command,{forCreate}){
  if(!command||typeof command!=='object'||Array.isArray(command))throw validationError('Invalid source command');
  const name=requiredText(command.name,'name',80);
  const listUrl=parseHttpsUrl(command.listUrl,'listUrl');
  const articlePattern=requiredText(command.articlePattern,'articlePattern',500);
  if(!safePattern(articlePattern))throw validationError('articlePattern must be a valid regular expression');
  const site=await env.DB.prepare('SELECT * FROM sites WHERE id=?').bind(command.siteId).first();
  if(!site)throw validationError('Site not found');
  if(listUrl.origin!==site.origin)throw validationError('listUrl must use the site origin');
  const sampleArticleUrl=command.sampleArticleUrl?parseHttpsUrl(command.sampleArticleUrl,'sampleArticleUrl'):null;
  if(forCreate&&!sampleArticleUrl)throw validationError('sampleArticleUrl is required');
  if(sampleArticleUrl&&sampleArticleUrl.origin!==site.origin)throw validationError('sampleArticleUrl must use the site origin');
  if(sampleArticleUrl&&!new RegExp(articlePattern).test(sampleArticleUrl.pathname))throw validationError('sampleArticleUrl must match articlePattern');
  const refreshIntervalSec=command.refreshIntervalSec??86400;
  if(!Number.isSafeInteger(refreshIntervalSec)||refreshIntervalSec<1800||refreshIntervalSec>604800)throw validationError('refreshIntervalSec must be an integer from 1800 to 604800');
  const timezone=Intl.supportedValuesOf('timeZone').includes(command.timezone)?command.timezone:null;
  if(!timezone)throw validationError('timezone is not supported');
  return {siteId:site.id,name,origin:site.origin,listUrl,adapterKey:'cqu-generic',articlePattern,
    refreshIntervalSec,timezone,sampleArticleUrl,
    baselineCutoffAt:forCreate?new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()):parseBaselineCutoff(command.baselineCutoffAt)};
}

function commandToCurrent(source){
  return {
    siteId:source.siteId,name:source.name,listUrl:source.listUrl,articlePattern:source.config.articlePattern,
    refreshIntervalSec:source.refreshIntervalSec,timezone:source.timezone,
    baselineCutoffAt:source.baselineCutoffAt,sampleArticleUrl:source.config.sampleArticleUrl??null,
  };
}

function parseBaselineCutoff(value){
  if(value===undefined||value===null)return null;
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||Number.isNaN(Date.parse(value)))throw validationError('baselineCutoffAt must be a YYYY-MM-DD date');
  return value;
}

async function parseUpdate({name,enabled}){
  const values={};
  if(name!==undefined)values.name=requiredText(name,'name',80);
  if(enabled!==undefined){
    if(typeof enabled!=='boolean')throw validationError('enabled must be boolean');
    values.enabled=enabled?1:0;
  }
  return values;
}

export function canonicalUrl(value){
  const url=parseHttpsUrl(value,'url');
  url.hash='';
  for(const key of [...url.searchParams.keys()]){
    if(trackingParameters.some(pattern=>pattern.test(key)))url.searchParams.delete(key);
  }
  return url;
}

export function parseOrigin(value){
  const url=parseHttpsUrl(value,'origin');
  if(url.pathname!=='/'||url.search)return Object.assign(new URL(url.origin),{});
  return new URL(url.origin);
}

function parseHttpsUrl(value,field){
  if(typeof value!=='string'||value.length>2000)throw validationError(`${field} must be an HTTPS URL`);
  let url;try{url=new URL(value);}catch{throw validationError(`${field} must be an HTTPS URL`);}
  if(url.protocol!=='https:'||url.username||url.password||!url.hostname.includes('.'))throw validationError(`${field} must be an HTTPS URL`);
  return url;
}

function requiredText(value,field,max){
  if(typeof value!=='string'||!value.trim()||value.trim().length>max)throw validationError(`${field} is required`);
  return value.trim();
}

function safePattern(value){
  try{new RegExp(value);return true;}catch{return false;}
}

function safeJson(value,fallback){
  try{return JSON.parse(value)??fallback;}catch{return fallback;}
}

function boundedInteger(value,fallback,min,max){
  const n=Number(value);
  return Number.isSafeInteger(n)?Math.min(max,Math.max(min,n)):fallback;
}

function localDay(value,timezone){
  try{
    return new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'})
      .format(new Date(value));
  }catch{
    return new Date(value).toISOString().slice(0,10);
  }
}

export function validationError(message){const error=new Error(message);error.name='ValidationError';return error;}
