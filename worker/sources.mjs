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
      const rows=await env.DB.prepare(`${sourceSelect}
        WHERE s.enabled=1 AND st.enabled=1 AND s.validation_state='verified' AND s.next_discovery_at<=?
        ORDER BY s.next_discovery_at,s.id LIMIT ?`).bind(at,size).all();
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
      return {scheduled,taskIds:scheduledIds};
    },

    async discover(taskId,attemptNo){
      if(!/^[a-f0-9]{24}$/.test(taskId??''))throw validationError('Invalid discovery task id');
      const task=await env.DB.prepare(`SELECT t.*,ta.result_json FROM tasks t
        JOIN task_attempts ta ON ta.task_id=t.id AND ta.attempt_no=t.attempt_no
        WHERE t.id=? AND t.kind='discover' AND t.attempt_no=? AND t.state='running'`).bind(taskId,attemptNo).first();
      if(!task)return {superseded:true};
      if(task.result_json)return JSON.parse(task.result_json);
      const context=JSON.parse(task.payload_json),source=context.source;
      if(context.mode==='validate')return verifySource(env,this,source.id,{source,taskId,attemptNo,scrape});
      if(source?.id!==task.source_id||source?.configVersion===undefined)throw validationError('Discovery source snapshot is invalid');
      const checkpoint=context.checkpoint??{};
      let urls=Array.isArray(checkpoint.nextUrls)?checkpoint.nextUrls:[source.listUrl];
      const visited=new Set(Array.isArray(checkpoint.visited)?checkpoint.visited:[]);
      const page=boundedInteger(context.page,1,1,1000);
      const currentUrl=urls.shift();
      if(typeof currentUrl!=='string'||visited.has(currentUrl))throw validationError('Discovery cursor is invalid');
      const result=await savedDiscoveryPage(env,source,taskId,currentUrl,{
        scrape,now,baselineCutoffAt:source.baselineCutoffAt??cutoffDate(timestamp()),
      });
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
        const captureBusinessKey=`capture:${aid}:discovery-initial`;
        const captureTaskId=(await sha(captureBusinessKey)).slice(0,24);
        statements.push(
          env.DB.prepare(`INSERT INTO articles(id,source_id,url,title,published_at,discovered_at,status)
            SELECT ?,?,?,?,?,?,'pending' WHERE ${activeTask.sql} ON CONFLICT(url) DO NOTHING`)
            .bind(aid,source.id,row.url,row.title,row.precision==='unknown'?'unknown':row.publishedDay,new Date(result.observedAt).toISOString(),...activeTask.args),
          env.DB.prepare(`INSERT INTO article_sources(article_id,source_id,first_seen_at,last_seen_at,discovery_class,published_at,published_day,date_precision,source_timezone)
            SELECT ?,?,?,?,'live',?,?,?,? WHERE ${activeTask.sql}
            ON CONFLICT(article_id,source_id) DO UPDATE SET last_seen_at=excluded.last_seen_at`)
            .bind(aid,source.id,result.observedAt,result.observedAt,
              row.precision==='minute'?row.publishedAt:null,row.precision==='unknown'?null:row.publishedDay,
              row.precision,source.timezone,...activeTask.args),
          env.DB.prepare(`INSERT INTO tasks(id,kind,business_key,source_id,article_id,payload_json,state,priority,due_at,attempt_no,created_at,updated_at)
            SELECT ?,'capture',?,?,?,?,'queued',80,?,1,?,? WHERE ${activeTask.sql}
              AND EXISTS(SELECT 1 FROM article_sources WHERE article_id=? AND source_id=?)
            ON CONFLICT(business_key) DO NOTHING`)
            .bind(captureTaskId,captureBusinessKey,source.id,aid,
              JSON.stringify({source,discovery:{articleId:aid,configVersion:source.configVersion,page,scheduledSlot:context.scheduledSlot}}),
              at,at,at,...activeTask.args,aid,source.id),
          launchOutboxStatement(env,{id:await launchOutboxId(captureTaskId,1),taskId:captureTaskId,attempt:1,timestamp:at,
            guardSql:'kind=? AND '+activeTask.sql,guardArgs:['capture',...activeTask.args]}),
        );
        const association=await articleSourceAssociationStatements(env,{
          articleId:aid,sourceId:source.id,timestamp:at,
          source:{
            first_seen_at:result.observedAt,last_seen_at:result.observedAt,discovery_class:'live',
            published_at:row.precision==='minute'?row.publishedAt:null,
            published_day:row.precision==='unknown'?null:row.publishedDay,
            date_precision:row.precision,source_timezone:source.timezone,
          },
        });
        statements.push(...association.statements);
      }
      const continuation=nextPageUrls.length&&page<boundedInteger(env.MAX_DISCOVERY_PAGES_PER_RUN,2,1,10);
      const checkpointJson=JSON.stringify({
        nextUrls:continuation?nextPageUrls:[],visited:[...visited],verifiedUpTo:currentUrl,page,
      });
      if(continuation){
        const continuationTask=await discoveryTaskStatements(env,source,{
          page:page+1,checkpoint:{nextUrls:nextPageUrls,visited:[...visited]},scheduledSlot:context.scheduledSlot,
        },{timestamp:at,advanceSource:false,taskGuard:activeTask});
        statements.push(...continuationTask.statements);
        statements.push(env.DB.prepare(`UPDATE tasks SET checkpoint_json=? WHERE id=? AND ${activeTask.sql} RETURNING id`)
          .bind(JSON.stringify({continuationTaskId:continuationTask.taskId}),taskId,...activeTask.args));
      }else{
        statements.push(env.DB.prepare(`UPDATE tasks SET checkpoint_json=? WHERE id=? AND ${activeTask.sql} RETURNING id`)
          .bind(checkpointJson,taskId,...activeTask.args));
      }
      const checkpointIndex=statements.length-1;
      const outcome={sourceId:source.id,page,candidates:candidates.length,undated:result.undated,continuation:Boolean(continuation),checkpoint:JSON.parse(checkpointJson)};
      statements.push(env.DB.prepare(`UPDATE task_attempts SET result_json=COALESCE(result_json,?) WHERE task_id=? AND attempt_no=? AND ${activeTask.sql}`)
        .bind(JSON.stringify(outcome),taskId,attemptNo,...activeTask.args));
      statements.push(env.DB.prepare(`UPDATE sources SET last_run_at=?,error=NULL,updated_at=? WHERE id=? AND config_version=? AND ${activeTask.sql}`)
        .bind(new Date(at).toISOString(),at,source.id,source.configVersion,...activeTask.args));
      let committed;
      try{committed=await env.DB.batch(statements);}
      catch(error){
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

function sourceStartUrls(source){
  const configured=source.config?.listUrls;
  if(Array.isArray(configured)&&configured.length)return [...new Set(configured.filter(url=>typeof url==='string'))];
  return [source.listUrl];
}

function rowFromDb(row){
  const config=safeJson(row.config_json,{});
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
    baselineCutoffAt:row.baseline_cutoff_at,backfillCursor:safeJson(row.backfill_cursor,null),
    validationState:row.validation_state,validationJson:safeJson(row.validation_json,null),
    validatedAt:row.validated_at,validationTaskId:row.validation_task_id,timezone:row.source_timezone,
    lastRunAt:row.last_run_at,error:row.error,
  };
}

function sourceFromStatic(source){
  return {
    ...source,id:source.id,name:source.name,url:source.url,listUrl:source.listUrls[0],adapterKey:'cqu-generic',
    config:{articlePattern:source.articlePattern,listUrls:source.listUrls},configVersion:1,enabled:true,siteEnabled:true,
    refreshIntervalSec:86400,nextDiscoveryAt:0,baselineCutoffAt:null,backfillCursor:null,
    validationState:'verified',validationJson:null,validatedAt:null,timezone:'Asia/Shanghai',lastRunAt:null,error:null,
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

export function validationError(message){const error=new Error(message);error.name='ValidationError';return error;}
