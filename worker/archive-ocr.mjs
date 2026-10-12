import {mistralOcr} from './mistral-ocr.mjs';
import {pdfPages} from './pdf-text.mjs';
import {aggregateOcrProjection,applyOcrEntries,validateOcrProjection} from './archive-ocr-view.mjs';
import {reservePages} from './pdf-ocr.mjs';
import {storeTextObject} from './archive-objects.mjs';
import {launchOutboxId,launchOutboxStatement} from './task-statements.mjs';
import {WorkflowEntrypoint} from 'cloudflare:workers';
import {createTaskRuntime,failOcrTask,finishOcrTask} from './task-runtime.mjs';
import {sha} from './utils.mjs';

export const OCR_PROCESSOR='mistral-ocr';
const hashPattern=/^[a-f0-9]{64}$/;
const idPattern=/^[a-f0-9]{24}$/;
const processorVersion=env=>/^v[1-9][0-9a-z.-]{0,19}$/.test(env.ARCHIVE_OCR_PROCESSOR_VERSION??'')?env.ARCHIVE_OCR_PROCESSOR_VERSION:'v1';

export async function ocrDescriptor(env){
  const model=env.PDF_OCR_MODEL??'mistral-ocr-4-1';
  const options={model,pageDetection:'pdf-operators-v1',includeImageBase64:false,tableFormat:null};
  const optionsHash=await sha(JSON.stringify(options));
  return {inputProcessor:OCR_PROCESSOR,processorVersion:processorVersion(env),options,optionsHash};
}

export async function withOcrIdentity(env,row){
  if(row.kind!=='body_ocr')return row;
  const descriptor=await ocrDescriptor(env);
  return {...row,processor:descriptor.inputProcessor,processorVersion:descriptor.processorVersion,optionsHash:descriptor.optionsHash};
}

export async function ocrTaskStatements(env,row,timestamp,{articleId=null}={}){
  if(row.kind!=='body_ocr'||!hashPattern.test(row.inputHash??''))return [];
  const businessKey=JSON.stringify(['ocr',row.inputHash,row.processor,row.processorVersion,row.optionsHash]);
  const taskId=(await sha(businessKey)).slice(0,24),outboxId=await launchOutboxId(taskId,1);
  const payload={v:1,inputHash:row.inputHash,processor:row.processor,processorVersion:row.processorVersion,
    optionsHash:row.optionsHash,options:{model:row.options?.model??env.PDF_OCR_MODEL??'mistral-ocr-4-1'}};
  return [
    env.DB.prepare(`INSERT INTO tasks(id,kind,business_key,article_id,payload_json,state,due_at,created_at,updated_at)
      VALUES (?,'ocr',?,?,?,'queued',?,?,?) ON CONFLICT(business_key) DO NOTHING`)
      .bind(taskId,businessKey,articleId,JSON.stringify(payload),timestamp,timestamp,timestamp),
    launchOutboxStatement(env,{id:outboxId,taskId,attempt:1,timestamp,payload:{v:1,type:'start-job',outboxId,taskId,attempt:1}}),
  ];
}

export async function adoptExistingOcrStatements(env,revisionId,row,timestamp){
  if(row.kind!=='body_ocr'||!hashPattern.test(row.inputHash??''))return [];
  const outboxId=(await sha(`outbox:ready:${revisionId}:adopt:${row.inputHash}:${row.processor}:${row.processorVersion}:${row.optionsHash}`)).slice(0,24);
  return [
    env.DB.prepare(`UPDATE revision_requirements SET state='fulfilled',object_hash=(
        SELECT result_hash FROM derived_outputs WHERE input_hash=revision_requirements.input_hash
          AND processor=revision_requirements.processor AND processor_version=revision_requirements.processor_version
          AND options_hash=revision_requirements.options_hash),
      derived_output_id=(SELECT id FROM derived_outputs WHERE input_hash=revision_requirements.input_hash
          AND processor=revision_requirements.processor AND processor_version=revision_requirements.processor_version
          AND options_hash=revision_requirements.options_hash),
      fetched_at=COALESCE(fetched_at,(SELECT completed_at FROM derived_outputs WHERE input_hash=revision_requirements.input_hash
          AND processor=revision_requirements.processor AND processor_version=revision_requirements.processor_version
          AND options_hash=revision_requirements.options_hash)),error_code=NULL
      WHERE revision_id=? AND slot_key=? AND state='pending' AND EXISTS(
        SELECT 1 FROM derived_outputs d WHERE d.input_hash=revision_requirements.input_hash
          AND d.processor=revision_requirements.processor AND d.processor_version=revision_requirements.processor_version
          AND d.options_hash=revision_requirements.options_hash)`)
      .bind(revisionId,row.slotKey),
    env.DB.prepare(`UPDATE article_revisions SET requirement_generation=requirement_generation+1
      WHERE id=? AND state='assembling' AND EXISTS(SELECT 1 FROM revision_requirements q WHERE q.revision_id=article_revisions.id
        AND q.slot_key=? AND q.state='fulfilled' AND q.derived_output_id IS NOT NULL)`)
      .bind(revisionId,row.slotKey),
    env.DB.prepare(`INSERT INTO outbox(id,topic,dedupe_key,payload_json,available_at,created_at,updated_at)
      SELECT ?,'feed-events',?,?,?,?,? FROM article_revisions WHERE id=? AND state='assembling'
        AND EXISTS(SELECT 1 FROM revision_requirements q WHERE q.revision_id=article_revisions.id
          AND q.slot_key=? AND q.state='fulfilled' AND q.derived_output_id IS NOT NULL)
      ON CONFLICT(topic,dedupe_key) DO NOTHING`)
      .bind(outboxId,`ready:${revisionId}:task:null`,JSON.stringify({v:1,type:'check-ready',outboxId,revisionId,sourceTaskId:null}),
        timestamp,timestamp,timestamp,revisionId,row.slotKey),
  ];
}

export async function processOcrTask(env,taskId,attemptNo,{provider=mistralOcr,now=()=>Date.now()}={}){
  if(!idPattern.test(taskId??''))throw new Error('Invalid OCR task id');
  const task=await env.DB.prepare(`SELECT t.*,a.state AS attempt_state
    FROM tasks t JOIN task_attempts a ON a.task_id=t.id AND a.attempt_no=t.attempt_no
    WHERE t.id=? AND t.kind='ocr' AND t.attempt_no=?`).bind(taskId,attemptNo).first();
  if(!task||task.attempt_state!=='running')return {skipped:true};
  const descriptor=validateTaskPayload(task);
  let derived=await findDerived(env,descriptor);
  if(!derived){
    derived=await recognize(env,descriptor,provider);
  }
  const adopted=await adoptDerivedOutput(env,task,descriptor,derived,now());
  await updateCurrentProjection(env,descriptor,derived);
  return {taskId,derivedOutputId:derived.id,resultHash:derived.result_hash,adoptedRequirements:adopted};
}

export async function redoArchiveOcr(env,articleId,options={}){
  if(!idPattern.test(articleId??''))throw new Error('Invalid article id');
  const descriptor=await ocrDescriptor(env);
  if(options.model!==undefined&&options.model!==descriptor.options.model)throw new Error('OCR model does not match the configured processor options');
  if(options.publish===false)return {tasks:[],projectionUpdates:0,skipped:true};
  const rows=await env.DB.prepare(`SELECT q.input_hash AS inputHash
    FROM articles a
    JOIN article_revisions r ON r.id=a.latest_ready_revision_id AND r.state='ready'
    JOIN revision_requirements q ON q.revision_id=r.id
    WHERE a.id=? AND q.kind='body_ocr' AND q.state='fulfilled' AND q.input_hash IS NOT NULL
    ORDER BY q.slot_key`).bind(articleId).all();
  if(!rows.results.length)return {tasks:[],projectionUpdates:0,reason:'body_ocr_not_required'};
  const tasks=[],timestamp=Date.now();
  let projectionUpdates=0;
  for(const requirement of rows.results){
    const identity={kind:'body_ocr',inputHash:requirement.inputHash,processor:descriptor.inputProcessor,
      processorVersion:descriptor.processorVersion,optionsHash:descriptor.optionsHash,options:descriptor.options};
    const derived=await findDerived(env,identity);
    if(derived){
      await updateCurrentProjection(env,identity,derived);
      projectionUpdates++;
      continue;
    }
    const businessKey=JSON.stringify(['ocr',identity.inputHash,identity.processor,identity.processorVersion,identity.optionsHash]);
    const committed=await env.DB.batch(await ocrTaskStatements(env,identity,timestamp,{articleId}));
    const task=await env.DB.prepare('SELECT id,state FROM tasks WHERE business_key=?').bind(businessKey).first();
    if(!task)throw new Error('OCR redo task was not committed');
    tasks.push({taskId:task.id,state:task.state,duplicate:committed[0].meta.changes===0});
  }
  return {tasks,projectionUpdates};
}

export async function archiveOcrStatus(env,articleId){
  if(!idPattern.test(articleId??''))throw new Error('Invalid article id');
  const current=await env.DB.prepare(`SELECT r.id AS revisionId,r.state,m.ocr_result_hash AS ocrResultHash,
      m.ocr_model AS ocrModel,m.ocr_updated_at AS ocrUpdatedAt,m.extraction_generation AS extractionGeneration
    FROM articles a LEFT JOIN article_read_models m ON m.article_id=a.id
    LEFT JOIN article_revisions r ON r.id=m.revision_id WHERE a.id=?`).bind(articleId).first();
  if(!current)throw new Error('Article not found');
  const tasks=await env.DB.prepare(`SELECT id,state,attempt_no AS attemptNo,last_error AS lastError,
      created_at AS createdAt,updated_at AS updatedAt FROM tasks WHERE article_id=? AND kind='ocr' ORDER BY created_at,id`)
    .bind(articleId).all();
  return {current,tasks:tasks.results};
}

function validateTaskPayload(task){
  let payload;
  try{payload=JSON.parse(task.payload_json);}catch{throw new Error('Invalid OCR task payload');}
  if(payload?.v!==1||!hashPattern.test(payload.inputHash??'')
    ||payload.processor!==OCR_PROCESSOR
    ||!/^[a-z][a-z0-9.-]{0,19}$/i.test(payload.processorVersion??'')
    ||!hashPattern.test(payload.optionsHash??'')||typeof payload.options?.model!=='string')
    throw new Error('OCR task identity is invalid');
  const businessKey=JSON.stringify(['ocr',payload.inputHash,payload.processor,payload.processorVersion,payload.optionsHash]);
  if(task.business_key!==businessKey)throw new Error('OCR task payload does not match its business key');
  return {inputHash:payload.inputHash,processor:payload.processor,processorVersion:payload.processorVersion,
    optionsHash:payload.optionsHash,model:payload.options.model};
}

async function findDerived(env,descriptor){
  return env.DB.prepare(`SELECT d.id,d.result_hash,o.r2_key,o.byte_size,o.media_type,d.completed_at
    FROM derived_outputs d JOIN artifact_objects o ON o.sha256=d.result_hash
    WHERE d.input_hash=? AND d.processor=? AND d.processor_version=? AND d.options_hash=?`)
    .bind(descriptor.inputHash,descriptor.processor,descriptor.processorVersion,descriptor.optionsHash).first();
}

async function recognize(env,descriptor,provider){
  const input=await env.DB.prepare('SELECT sha256,r2_key,byte_size,media_type FROM artifact_objects WHERE sha256=?')
    .bind(descriptor.inputHash).first();
  if(!input)throw new Error('OCR input object is missing');
  const object=await env.ARCHIVE.get(input.r2_key);
  if(!object||object.size!==input.byte_size)throw new Error('OCR input object is unavailable');
  const inspectBytes=await object.arrayBuffer(),analysis=await pdfPages(inspectBytes.slice(0));
  const wanted=analysis.pages.filter(page=>page.needsOcr).map(page=>page.index);
  if(wanted.length>20)throw new Error('PDF exceeds 20 OCR pages; requires a larger explicit budget');
  let output=await readDerivedJournal(env,descriptor),call=null;
  if(!output){
    if(wanted.length){
      await reservePages(env,analysis.totalPages);
      const source=await env.ARCHIVE.get(input.r2_key);
      call=await provider(env,{bytes:await source.arrayBuffer(),pages:wanted,model:descriptor.model});
    }
    const recognized=new Map((call?.pages??[]).map(page=>[page.index,page]));
    const pages=analysis.pages.map(page=>{
      const result=recognized.get(page.index);
      if(page.needsOcr&&!result)throw new Error(`OCR page ${page.index+1} is missing`);
      if(page.needsOcr&&!result.text.trim())throw new Error(`OCR page ${page.index+1} is empty`);
      return result?{...result,source:'ocr'}:{index:page.index,text:page.text,markdown:page.text,source:'native'};
    });
    output={v:1,inputHash:descriptor.inputHash,processor:descriptor.processor,processorVersion:descriptor.processorVersion,
      optionsHash:descriptor.optionsHash,model:descriptor.model,totalPages:analysis.totalPages,pages,
      usage:call?.usageInfo??null,providerModel:call?.model??null,estimatedUsd:call?.estimatedUsd??0,createdAt:new Date().toISOString()};
    output=await writeDerivedJournal(env,descriptor,output);
  }
  const resultObject=await storeTextObject(env,JSON.stringify(output),'application/json');
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO artifact_objects(sha256,r2_key,byte_size,media_type,verified_at)
      VALUES (?,?,?,?,?) ON CONFLICT(sha256) DO NOTHING`)
      .bind(resultObject.sha256,resultObject.r2Key,resultObject.byteSize,resultObject.mediaType,resultObject.verifiedAt),
    env.DB.prepare(`INSERT INTO derived_outputs(id,input_hash,processor,processor_version,options_hash,result_hash,completed_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(input_hash,processor,processor_version,options_hash) DO NOTHING`)
      .bind(await outputId(descriptor),descriptor.inputHash,descriptor.processor,descriptor.processorVersion,descriptor.optionsHash,
        resultObject.sha256,Date.parse(output.createdAt)),
  ]);
  const derived=await findDerived(env,descriptor);
  if(!derived)throw new Error('Derived OCR output was not committed');
  return derived;
}

function derivedJournalKey(descriptor){
  return `derived/ocr/${descriptor.inputHash}/${descriptor.processor}/${descriptor.processorVersion}/${descriptor.optionsHash}/result.json`;
}

async function readDerivedJournal(env,descriptor){
  const object=await env.ARCHIVE.get(derivedJournalKey(descriptor));
  if(!object)return null;
  if(object.size>8*1024*1024)throw new Error('Saved OCR result exceeds 8 MiB');
  const output=await object.json();
  if(output?.v!==1||output.inputHash!==descriptor.inputHash||output.processor!==descriptor.processor
    ||output.processorVersion!==descriptor.processorVersion||output.optionsHash!==descriptor.optionsHash
    ||typeof output.model!=='string'||!Number.isSafeInteger(output.totalPages)||output.totalPages<1
    ||!Array.isArray(output.pages)||output.pages.length!==output.totalPages)
    throw new Error('Saved OCR result identity is invalid');
  for(const page of output.pages){
    if(!page||typeof page!=='object'||!Number.isSafeInteger(page.index)||page.index<0||page.index>=output.totalPages
      ||typeof page.text!=='string'||typeof page.markdown!=='string'||!['native','ocr'].includes(page.source))
      throw new Error('Saved OCR result pages are invalid');
  }
  return output;
}

async function writeDerivedJournal(env,descriptor,output){
  const bytes=new TextEncoder().encode(JSON.stringify(output)),key=derivedJournalKey(descriptor);
  if(bytes.byteLength>8*1024*1024)throw new Error('OCR result exceeds 8 MiB');
  const saved=await env.ARCHIVE.put(key,bytes,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});
  if(saved)return output;
  const existing=await readDerivedJournal(env,descriptor);
  if(!existing)throw new Error('Saved OCR result is unavailable');
  return existing;
}

async function outputId(descriptor){
  return (await sha(JSON.stringify(['derived',descriptor.inputHash,descriptor.processor,descriptor.processorVersion,descriptor.optionsHash]))).slice(0,24);
}

async function adoptDerivedOutput(env,task,descriptor,derived,timestamp){
  const rows=await env.DB.prepare(`SELECT q.revision_id,q.slot_key FROM revision_requirements q
    JOIN article_revisions r ON r.id=q.revision_id
    WHERE q.kind='body_ocr' AND q.state='pending' AND q.input_hash=? AND q.processor=?
      AND q.processor_version=? AND q.options_hash=? AND r.state='assembling' ORDER BY q.revision_id,q.slot_key`)
    .bind(descriptor.inputHash,descriptor.processor,descriptor.processorVersion,descriptor.optionsHash).all();
  const statements=[];
  for(const row of rows.results){
    statements.push(env.DB.prepare(`UPDATE revision_requirements SET state='fulfilled',object_hash=?,derived_output_id=?,fetched_at=?,error_code=NULL
      WHERE revision_id=? AND slot_key=? AND state='pending' AND derived_output_id IS NULL`)
      .bind(derived.result_hash,derived.id,timestamp,row.revision_id,row.slot_key));
    statements.push(env.DB.prepare(`UPDATE article_revisions SET requirement_generation=requirement_generation+1
      WHERE id=? AND state='assembling' AND EXISTS(SELECT 1 FROM revision_requirements q WHERE q.revision_id=article_revisions.id
        AND q.slot_key=? AND q.derived_output_id=? AND q.state='fulfilled')`)
      .bind(row.revision_id,row.slot_key,derived.id));
    const outboxId=(await sha(`outbox:ready:${row.revision_id}:task:${task.id}`)).slice(0,24);
    statements.push(env.DB.prepare(`INSERT INTO outbox(id,topic,dedupe_key,payload_json,available_at,created_at,updated_at)
      SELECT ?,'feed-events',?,?,?,?,? FROM article_revisions WHERE id=? AND state='assembling'
        AND EXISTS(SELECT 1 FROM revision_requirements q WHERE q.revision_id=article_revisions.id
          AND q.slot_key=? AND q.derived_output_id=? AND q.state='fulfilled')
      ON CONFLICT(topic,dedupe_key) DO NOTHING`)
      .bind(outboxId,`ready:${row.revision_id}:task:${task.id}`,JSON.stringify({v:1,type:'check-ready',outboxId,revisionId:row.revision_id,sourceTaskId:task.id}),
        timestamp,timestamp,timestamp,row.revision_id,row.slot_key,derived.id));
  }
  if(statements.length)await env.DB.batch(statements);
  return rows.results.length;
}

async function updateCurrentProjection(env,descriptor,derived){
  const rows=await env.DB.prepare(`SELECT q.revision_id,r.article_id
    FROM revision_requirements q JOIN article_revisions r ON r.id=q.revision_id
    WHERE q.kind='body_ocr' AND q.input_hash=? AND r.state='ready'
      AND r.id=(SELECT a.latest_ready_revision_id FROM articles a WHERE a.id=r.article_id)
    ORDER BY r.revision_no DESC`).bind(descriptor.inputHash).all();
  for(const row of rows.results){
    const requirements=await env.DB.prepare(`SELECT q.slot_key,q.kind,q.filename,q.state,q.input_hash,q.object_hash
      FROM revision_requirements q WHERE q.revision_id=? ORDER BY q.slot_key`).bind(row.revision_id).all();
    const body=requirements.results.find(item=>item.kind==='body');
    if(!body?.object_hash)continue;
    const bodyObject=await env.ARCHIVE.get(objectKeyFromHash(body.object_hash));
    if(!bodyObject)throw new Error('Current projection body is unavailable');
    let text=await bodyObject.text();
    for(let attempt=0;attempt<5;attempt++){
      const model=await env.DB.prepare(`SELECT extraction_generation,ocr_result_hash FROM article_read_models
        WHERE article_id=? AND revision_id=? AND revision_id=(SELECT latest_ready_revision_id FROM articles WHERE id=article_id)`)
        .bind(row.article_id,row.revision_id).first();
      if(!model)break;
      const existing=model.ocr_result_hash?await readCurrentProjection(env,model.ocr_result_hash,requirements.results):null;
      const priorEntries=new Map((existing?.inputs??[]).map(entry=>[entry.slotKey,entry]));
      const entries=[];
      for(const requirement of requirements.results.filter(item=>item.kind==='body_ocr')){
        if(requirement.input_hash===descriptor.inputHash){
          const output=await readOutputObject(env,derived.r2_key);
          if(output.inputHash!==descriptor.inputHash)throw new Error('Current projection OCR identity is invalid');
          entries.push({
            slotKey:requirement.slot_key,inputHash:requirement.input_hash,resultHash:derived.result_hash,
            filename:requirement.filename,model:output.model??descriptor.model,
            updatedAt:output.createdAt??new Date(derived.completed_at).toISOString(),pages:output.pages,
          });
          continue;
        }
        const prior=priorEntries.get(requirement.slot_key);
        if(prior?.inputHash===requirement.input_hash){
          entries.push(prior);
          continue;
        }
        if(!requirement.object_hash)throw new Error('Current projection OCR result is unavailable');
        const output=await readOutputObject(env,objectKeyFromHash(requirement.object_hash));
        if(output.inputHash!==requirement.input_hash)throw new Error('Current projection OCR identity is invalid');
        entries.push({
          slotKey:requirement.slot_key,inputHash:requirement.input_hash,resultHash:requirement.object_hash,
          filename:requirement.filename,model:output.model??null,updatedAt:output.createdAt??null,pages:output.pages,
        });
      }
      const projection=aggregateOcrProjection(entries),object=await storeTextObject(env,JSON.stringify(projection),'application/json');
      const projectedText=applyOcrEntries(text,entries);
      const committed=await env.DB.batch([
        env.DB.prepare(`INSERT INTO artifact_objects(sha256,r2_key,byte_size,media_type,verified_at)
          VALUES (?,?,?,?,?) ON CONFLICT(sha256) DO NOTHING`)
          .bind(object.sha256,object.r2Key,object.byteSize,object.mediaType,object.verifiedAt),
        env.DB.prepare(`UPDATE article_read_models SET summary=?,readable_text=?,ocr_result_hash=?,ocr_model=?,ocr_updated_at=?,
          extraction_generation=extraction_generation+1
          WHERE article_id=? AND revision_id=? AND extraction_generation=?
            AND revision_id=(SELECT latest_ready_revision_id FROM articles WHERE id=article_id)
          RETURNING article_id`)
          .bind(projectedText.slice(0,180),projectedText,object.sha256,projection.model,projection.updatedAt,
            row.article_id,row.revision_id,model.extraction_generation),
      ]);
      if(committed[1].results?.length)break;
      if(attempt===4)throw new Error('Current OCR projection changed concurrently');
    }
  }
}

async function readCurrentProjection(env,resultHash,requirements){
  const ocrRequirements=requirements.filter(requirement=>requirement.kind==='body_ocr');
  const output=await readJsonObject(env,objectKeyFromHash(resultHash));
  if(Array.isArray(output.inputs)){
    return validateOcrProjection(output,ocrRequirements.map(requirement=>({
      slotKey:requirement.slot_key,inputHash:requirement.input_hash,filename:requirement.filename,
    })));
  }
  if(ocrRequirements.length!==1||output.inputHash!==ocrRequirements[0].input_hash)
    throw new Error('Current OCR projection identity is invalid');
  return aggregateOcrProjection([{
    slotKey:ocrRequirements[0].slot_key,inputHash:output.inputHash,resultHash,
    filename:ocrRequirements[0].filename,model:output.model??null,updatedAt:output.createdAt??null,pages:output.pages,
  }]);
}

async function readJsonObject(env,key){
  const object=await env.ARCHIVE.get(key);
  if(!object)throw new Error('Current projection OCR result is unavailable');
  return object.json();
}

async function readOutputObject(env,key){
  const output=await readJsonObject(env,key);
  if(!hashPattern.test(output?.inputHash??'')||!Array.isArray(output.pages)||!output.pages.length)
    throw new Error('Current projection OCR identity is invalid');
  return output;
}

function objectKeyFromHash(hash){
  return `objects/sha256/${hash.slice(0,2)}/${hash}`;
}

export class ArchiveOcrWorkflow extends WorkflowEntrypoint{
  async run(event,step){
    const taskId=event.payload?.taskId,attempt=event.payload?.attempt;
    if(!idPattern.test(taskId??'')||!Number.isSafeInteger(attempt)||attempt<1
      ||event.instanceId!==`task-${taskId}-a${attempt}`)throw new Error('Invalid OCR task identity');
    try{
      const claimed=await step.do('mark-running',async()=>{
        const result=await this.env.DB.batch([
          this.env.DB.prepare(`UPDATE tasks SET state='running',updated_at=?
            WHERE id=? AND attempt_no=? AND state IN ('starting','running')
            AND EXISTS(SELECT 1 FROM task_attempts WHERE task_id=? AND attempt_no=? AND workflow_instance_id=?) RETURNING id`)
            .bind(Date.now(),taskId,attempt,taskId,attempt,event.instanceId),
          this.env.DB.prepare(`UPDATE task_attempts SET state='running' WHERE task_id=? AND attempt_no=?
            AND workflow_instance_id=? AND EXISTS(SELECT 1 FROM tasks WHERE id=? AND attempt_no=? AND state='running')`)
            .bind(taskId,attempt,event.instanceId,taskId,attempt),
        ]);
        return result[0].results.length>0;
      });
      if(!claimed)return {superseded:true};
      const result=await step.do('extract',()=>processOcrTask(this.env,taskId,attempt));
      await step.do('finish',()=>finishOcrTask(this.env,taskId,attempt,result));
      await createTaskRuntime(this.env).dispatchDueOutbox().catch(()=>{});
      return result;
    }catch(error){
      await failOcrTask(this.env,taskId,attempt,error);
      throw error;
    }
  }
}
