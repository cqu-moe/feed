import {Buffer} from 'node:buffer';
import {cleanError,sha,fileKind} from './utils.mjs';
import {reconcileRevision} from './archive-reconcile.mjs';
import {readingText} from './reading.mjs';
import {pdfPages} from './pdf-text.mjs';

const RUN_ID='mvp-v1';
const idPattern=/^[a-f0-9]{24}$/;
const requestPattern=/^[A-Za-z0-9._:-]{8,100}$/;
const immutableKey=hash=>`objects/sha256/${hash.slice(0,2)}/${hash}`;
const legacyRevision=`a.prefix IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM article_revisions r WHERE r.article_id=a.id
  AND NOT EXISTS(SELECT 1 FROM archive_migration_articles m WHERE m.revision_id=r.id))`;
const unclaimedLegacy=`a.prefix IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM article_revisions r WHERE r.article_id=a.id)
  AND NOT EXISTS(SELECT 1 FROM archive_migration_articles m WHERE m.article_id=a.id)`;

export class MigrationValidationError extends Error{}
export class MigrationConflictError extends Error{}
export class MigrationNotFoundError extends Error{}

export function createArchiveMigration(env,{now=()=>Date.now()}={}){
  return {
    async submit({requestId,batchSize=20}={}){
      validateRequest({requestId,batchSize});
      const request={v:1,requestId,batchSize};
      const requestJson=JSON.stringify(request);
      let run=await runStatus();
      if(run&&run.request_json!==requestJson)throw new MigrationConflictError('The MVP migration already has a different request identity');
      if(!run){
        const timestamp=now(),checkpoint=JSON.stringify({v:1,lastArticleId:null});
        try{
          await env.DB.prepare(`INSERT INTO archive_migration_runs(id,request_id,request_json,state,batch_size,
            checkpoint_json,report_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
            .bind(RUN_ID,requestId,requestJson,'running',size(request.batchSize),checkpoint,JSON.stringify(emptyReport()),timestamp,timestamp).run();
          run=await runStatus();
        }catch(error){
          run=await runStatus();
          if(!run||run.request_json!==requestJson)throw error;
        }
      }
      return processBatch(size(run.batch_size));
    },
    async process({batchSize}={}){
      const run=await runStatus();
      if(!run)throw new MigrationNotFoundError('The MVP migration has not been submitted');
      return processBatch(batchSize===undefined?size(run.batch_size):validatedSize(batchSize));
    },
    async repair({articleId}={}){
      if(typeof articleId!=='string'||!idPattern.test(articleId))
        throw new MigrationValidationError('articleId is required');
      const record=await env.DB.prepare('SELECT revision_id,state FROM archive_migration_articles WHERE run_id=? AND article_id=?')
        .bind(RUN_ID,articleId).first();
      if(!record)throw new MigrationNotFoundError('Migration article record is missing');
      if(record.state==='excluded')return {state:'excluded',repaired:false};
      if(!record.revision_id){
        if(record.state!=='failed')throw new MigrationConflictError('Only an unfinished migration can be repaired');
        await env.DB.prepare(`UPDATE archive_migration_articles SET state='imported',updated_at=? WHERE run_id=? AND article_id=?`)
          .bind(now(),RUN_ID,articleId).run();
        const {state}=await processRecord(articleId);
        await finalize();
        return {state,repaired:['ready','blocked'].includes(state)};
      }
      if(record.state==='ready')return {state:'ready',repaired:false};
      const state=await repairRecord(articleId);
      await finalize();
      return {state,repaired:state!==record.state};
    },
    async status(){
      const run=await runStatus();
      const remaining=await remainingCount();
      return run?{run:presentRun(run),report:JSON.parse(run.report_json),remaining}:null;
    },
    async articles({after=null,limit=20}={}){
      validatedSize(limit);
      if(after!==null&&(typeof after!=='string'||!idPattern.test(after)))
        throw new MigrationValidationError('after must be an article ID');
      const rows=await env.DB.prepare(`SELECT article_id,revision_id,state,comparison_json,differences_json
        FROM archive_migration_articles WHERE run_id=? AND (? IS NULL OR article_id>?) ORDER BY article_id LIMIT ?`)
        .bind(RUN_ID,after,after,limit+1).all();
      return {articles:rows.results.slice(0,limit).map(row=>({articleId:row.article_id,revisionId:row.revision_id,
        state:row.state,comparison:JSON.parse(row.comparison_json),differences:JSON.parse(row.differences_json)})),
        nextCursor:rows.results.length>limit?rows.results[limit-1].article_id:null};
    },
  };

  async function processBatch(batchSize){
    const timestamp=now();
    await env.DB.prepare(`UPDATE archive_migration_runs SET state='running',updated_at=? WHERE id=?`)
      .bind(timestamp,RUN_ID).run();

    let rows=await env.DB.prepare(`SELECT article_id,state FROM archive_migration_articles
      WHERE run_id=? AND state IN ('imported','failed') ORDER BY article_id LIMIT ?`)
      .bind(RUN_ID,batchSize).all();
    if(rows.results.length<batchSize)rows={results:[...rows.results,...await claimArticles(batchSize-rows.results.length)]};

    let processed=0,blocked=0;
    for(const row of rows.results){
      const result=await processRecord(row.article_id);
      processed++;
      if(result.state==='blocked')blocked++;
    }
    const state=await finalize();
    return {run:await presentRun(await runStatus()),processed,remaining:await remainingCount(),blocked,state};
  }

  async function claimArticles(count){
    if(count<1)return [];
    const run=await runStatus();
    if(!run)throw new MigrationNotFoundError('The MVP migration run is missing');
    const cursor=parseJson(run.checkpoint_json,{}).lastArticleId??null;
    let candidates=await env.DB.prepare(`SELECT a.id FROM articles a WHERE ${unclaimedLegacy}
      AND (? IS NULL OR a.id>?) ORDER BY a.id LIMIT ?`).bind(cursor,cursor,count).all();
    if(!candidates.results.length&&cursor){
      candidates=await env.DB.prepare(`SELECT a.id FROM articles a WHERE ${unclaimedLegacy}
        ORDER BY a.id LIMIT ?`).bind(count).all();
      if(candidates.results.length)await env.DB.prepare('UPDATE archive_migration_runs SET last_article_id=NULL,updated_at=? WHERE id=?')
        .bind(now(),RUN_ID).run();
    }
    const claimed=[];
    for(const candidate of candidates.results){
      const timestamp=now(),comparison=JSON.stringify(excludedComparison('pending'));
      const inserted=await env.DB.prepare(`INSERT INTO archive_migration_articles(run_id,article_id,state,comparison_json,differences_json,created_at,updated_at)
        SELECT ?,?,'imported',?,'[]',?,? FROM articles a WHERE a.id=? AND a.prefix IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM article_revisions r WHERE r.article_id=a.id)
        ON CONFLICT(run_id,article_id) DO NOTHING`).bind(RUN_ID,candidate.id,comparison,timestamp,timestamp,candidate.id).run();
      if(inserted.meta.changes)claimed.push({article_id:candidate.id});
      else{
        await env.DB.prepare(`INSERT INTO archive_migration_articles(run_id,article_id,state,comparison_json,differences_json,created_at,updated_at)
          SELECT ?,?,'excluded',?,'[]',?,? FROM articles a WHERE a.id=?
            AND (a.prefix IS NULL OR EXISTS(SELECT 1 FROM article_revisions r WHERE r.article_id=a.id))
          ON CONFLICT(run_id,article_id) DO NOTHING`).bind(RUN_ID,candidate.id,JSON.stringify(excludedComparison('formal-version')),timestamp,timestamp,candidate.id).run();
      }
    }
    return claimed;
  }

  async function processRecord(articleId){
    if(!idPattern.test(articleId??''))throw new MigrationValidationError('Invalid legacy article id');
    await env.DB.prepare(`UPDATE archive_migration_articles SET attempt_count=attempt_count+1,updated_at=? WHERE run_id=? AND article_id=?`)
      .bind(now(),RUN_ID,articleId).run();
    const record=await env.DB.prepare('SELECT * FROM archive_migration_articles WHERE run_id=? AND article_id=?')
      .bind(RUN_ID,articleId).first();
    if(!record)throw new MigrationNotFoundError('Migration article record is missing');
    if(record.state==='excluded'){await advanceCursor(articleId);return {state:'excluded'};}

    try{
      if(!record.revision_id){
        const existing=await env.DB.prepare('SELECT id FROM article_revisions WHERE article_id=? ORDER BY revision_no LIMIT 1')
          .bind(articleId).first();
        if(existing){
          await excludeRecord(articleId,'formal-version');
          await advanceCursor(articleId);
          return {state:'excluded'};
        }
        await importArticle(articleId,record);
      }
      const state=await finishRecord(articleId);
      await advanceCursor(articleId);
      return {state};
    }catch(error){
      const current=await env.DB.prepare('SELECT revision_id,state FROM archive_migration_articles WHERE run_id=? AND article_id=?')
        .bind(RUN_ID,articleId).first();
      if(current?.revision_id&&['imported','ready','blocked'].includes(current.state)){
        const state=await finishRecord(articleId);
        await advanceCursor(articleId);
        return {state};
      }
      const differences=parseJson(record.differences_json,[]);
      differences.push({code:'migration_failed',message:cleanError(error),confirmed:false});
      await env.DB.prepare(`UPDATE archive_migration_articles SET state='failed',differences_json=?,updated_at=?
        WHERE run_id=? AND article_id=?`).bind(JSON.stringify(differences),now(),RUN_ID,articleId).run();
      await finalize();
      return {state:'failed'};
    }
  }

  async function importArticle(articleId,record){
    const article=await env.DB.prepare('SELECT * FROM articles WHERE id=?').bind(articleId).first();
    if(!article?.prefix)throw new MigrationNotFoundError('Legacy article is missing');
    const attachments=await legacyAttachments(articleId);
    const sourceRows=await env.DB.prepare('SELECT * FROM article_sources WHERE article_id=? ORDER BY source_id').bind(articleId).all();
    const legacyManifest=await legacyManifestFor(env,article);
    const objects=new Map(),differences=[],ocrComparisons=[];
    const inventory=[];
    const observedAt=legacyTime(article.captured_at)??legacyTime(article.discovered_at);
    if(observedAt===null)differences.push({code:'observed_time_missing',message:'Legacy capture and discovery times are missing',confirmed:false});

    const body=await inspectLegacyObject({
      article,prefix:article.prefix,key:`${article.prefix}/body.txt`,kind:'body',slotKey:'body',name:'正文',
      expectedHash:legacyManifest?.descriptor(`${article.prefix}/body.txt`,'body.txt')?.sha256,
      expectedBytes:legacyManifest?.descriptor(`${article.prefix}/body.txt`,'body.txt')?.bytes,
      required:true,errorCode:'body_missing',differences,objects,observedAt:observedAt??0,
    });
    inventory.push(body.row);
    const snapshotKey=article.snapshot_key??`${article.prefix}/offline.html`;
    const snapshotFrozen=legacyManifest?.descriptor(snapshotKey,'offline.html');
    const snapshot=await inspectLegacyObject({
      article,prefix:article.prefix,key:snapshotKey,kind:'snapshot',slotKey:'snapshot',name:'原貌存档',
      expectedHash:snapshotFrozen?.sha256,expectedBytes:snapshotFrozen?.bytes,
      required:true,errorCode:'snapshot_missing',differences,objects,observedAt:observedAt??0,
    });
    inventory.push(snapshot.row);
    if(article.screenshot_key){
      const screenshotFrozen=legacyManifest?.descriptor(article.screenshot_key,'original.png');
      const screenshot=await inspectLegacyObject({
        article,prefix:article.prefix,key:article.screenshot_key,kind:'screenshot',slotKey:'screenshot',name:'截图',
        expectedHash:screenshotFrozen?.sha256,expectedBytes:screenshotFrozen?.bytes,
        required:false,errorCode:'screenshot_missing',differences,objects,observedAt:observedAt??0,
      });
      inventory.push(screenshot.row);
    }

    const filenames=new Map();
    const expectedCount=Number.isSafeInteger(article.attachment_count)?article.attachment_count:attachments.results.length;
    const attachmentRows=[...attachments.results];
    for(let index=attachmentRows.length;index<expectedCount;index++){
      attachmentRows.push({id:`missing-${index+1}`,article_id:articleId,name:`附件 ${index+1}`,original_url:null,
        filename:null,object_key:null,bytes:0,content_type:null,sha256:null,status:'failed',role:'attachment'});
    }
    for(const [index,attachment] of attachmentRows.entries()){
      const slotNo=index+1,filename=attachment.filename??`attachment-${slotNo}.bin`;
      if(filename&&filenames.has(filename))differences.push({
        slotKey:`attachment:${slotNo}`,code:'duplicate_filename',message:`Filename ${filename} is used by multiple legacy attachments`,confirmed:false,
      });
      filenames.set(filename,slotNo);
      const frozenAttachment=frozenAttachmentDescriptor({legacyManifest,attachment,slotNo});
      const inspectAttachment=frozenAttachment&&!attachment.object_key
        ?{...attachment,object_key:frozenAttachment.key,bytes:frozenAttachment.bytes,
            content_type:frozenAttachment.contentType,sha256:frozenAttachment.sha256}
        :attachment;
      if(validHash(attachment.sha256)&&validHash(frozenAttachment?.sha256)&&attachment.sha256!==frozenAttachment.sha256){
        differences.push({slotKey:`attachment:${slotNo}`,code:'manifest_hash_conflict',
          message:'Legacy attachment hash conflicts with its captured manifest',confirmed:false});
      }
      const inspected=await inspectLegacyObject({
        article,prefix:article.prefix,key:inspectAttachment.object_key,kind:inspectAttachment.role==='body-pdf'?'body_pdf':'attachment',
        slotKey:`attachment:${slotNo}`,name:inspectAttachment.name??filename,filename,originalUrl:inspectAttachment.original_url,
        expectedHash:inspectAttachment.sha256??frozenAttachment?.sha256,expectedBytes:inspectAttachment.bytes??frozenAttachment?.bytes,
        contentType:inspectAttachment.content_type??frozenAttachment?.contentType,required:true,
        requireSignature:true,errorCode:attachment.status==='complete'?'artifact_invalid':'artifact_missing',
        differences,objects,observedAt:observedAt??0,
      });
      const duplicate=filename&&[...filenames.entries()].some(([name,slot])=>name===filename&&slot!==slotNo);
      if(duplicate&&inspected?.row){
        inspected.row.state='failed';inspected.row.errorCode='duplicate_filename';
      }
      if(inspected)inventory.push(inspected.row);
      if(inspectAttachment.role!=='body-pdf')continue;
      if(!inspected?.bytes){
        continue;
      }
      let analysis=null;
      try{
        analysis=await pdfPages(inspected.bytes);
        if(analysis.totalPages<1)throw new Error('PDF has no pages');
      }catch(error){
        differences.push({slotKey:`attachment:${slotNo}`,code:'body_pdf_unreadable',message:cleanError(error),confirmed:false});
      }
      if(!analysis){
        const processing=await legacyOcrIdentity(env,article,inspectAttachment);
        inventory.push(requirementRow(`ocr:${slotNo}`,'body_ocr',inspectAttachment,true,'failed',null,
          inspected.row.objectHash,null,'ocr_unverifiable',filename,processing));
        continue;
      }
      const wanted=analysis.pages.filter(page=>page.needsOcr).length;
      if(!wanted)continue;
      const adopted=await adoptLegacyOcr({article,attachment:inspectAttachment,analysis,objects,differences,ocrComparisons,timestamp:now()});
      const processing=adopted??await legacyOcrIdentity(env,article,inspectAttachment);
      inventory.push(requirementRow(`ocr:${slotNo}`,'body_ocr',inspectAttachment,true,adopted?'fulfilled':'failed',
        adopted?.resultHash??null,inspected.row.objectHash,adopted?.outputId??null,
        adopted?null:'ocr_unverifiable',filename,
        processing));
    }

    const missingRequired=inventory.some(row=>row.required&&row.state!=='fulfilled');
    const taskId=(await sha(JSON.stringify(['archive-migration',RUN_ID,'task',articleId]))).slice(0,24);
    const revisionId=(await sha(JSON.stringify(['archive-migration',RUN_ID,'revision',articleId]))).slice(0,24);
    const manifest={v:1,migration:RUN_ID,articleId,legacyPrefix:article.prefix,legacyUrl:article.url,
      observedAt,requirements:inventory.map(({...row})=>({...row,objectHash:row.objectHash??null,inputHash:row.inputHash??null}))};
    const manifestObject=await storeImmutable(env,new TextEncoder().encode(JSON.stringify(manifest)),'application/json',now());
    rememberObject(objects,manifestObject);
    const originalObjects=[...objects.values()].filter(object=>!object.derived);
    const rawFingerprint=await sha(JSON.stringify({v:1,title:article.title,
      files:inventory.map(row=>[row.slotKey,row.kind,row.objectHash,row.inputHash])}));
    const semanticFingerprint=await sha(JSON.stringify({v:1,title:normalizeText(article.title),
      body:normalizeText(readingText(body?.text??'')),
      files:inventory.filter(row=>row.kind==='attachment'||row.kind==='body_pdf')
        .map(row=>[normalizeText(row.name??''),row.kind,row.objectHash])}));
    const result={v:1,articleId,revisionId,state:missingRequired?'blocked':'assembling'};
    const sourceStatements=await sourceStatementsFor({article,sourceRows,timestamp:now()});
    const statements=[...objectStatements(env,objects),
      ...sourceStatements,
      env.DB.prepare(`INSERT INTO tasks(id,kind,business_key,article_id,payload_json,state,due_at,attempt_no,created_at,updated_at)
        VALUES (?,'migration',?,?,?,'succeeded',?,1,?,?) ON CONFLICT(id) DO NOTHING`)
        .bind(taskId,`archive-migration:${RUN_ID}:${articleId}`,articleId,
          JSON.stringify({v:1,migration:RUN_ID,articleId}),now(),now(),now()),
      env.DB.prepare(`INSERT INTO task_attempts(task_id,attempt_no,workflow_instance_id,state,started_at,ended_at,result_json)
        VALUES (?,1,?,'succeeded',?,?,?) ON CONFLICT(task_id,attempt_no) DO NOTHING`)
        .bind(taskId,`migration-${taskId}-a1`,observedAt??0,now(),JSON.stringify(result)),
      env.DB.prepare(`INSERT INTO article_revisions(id,article_id,revision_no,capture_task_id,observed_at,state,
        requirement_count,manifest_object_hash,raw_fingerprint,semantic_fingerprint,fingerprint_version,change_kind,title,
        published_at,source_metadata_json,diagnostics_json)
        VALUES (?,?,1,?,?,?,?,?,?,?,?,'baseline',?,?,?,?) ON CONFLICT(capture_task_id) DO NOTHING`)
        .bind(revisionId,articleId,taskId,observedAt??0,missingRequired?'blocked':'assembling',inventory.length,
          manifestObject.sha256,rawFingerprint,semanticFingerprint,'migration-body-files-v1',article.title,normalizedDay(article.published_at),
          JSON.stringify({v:1,migration:RUN_ID,captureIntent:'migrated',legacyPrefix:article.prefix,legacyUrl:article.url,
            sourceIds:[...new Set([...sourceRows.results.map(row=>row.source_id),article.source_id])]}),
          JSON.stringify(differences)),
    ];
    const derivedStatements=[];
    for(const object of objects.values())if(object.derived)derivedStatements.push(...object.statements);
    statements.push(...derivedStatements);
    for(const row of inventory){
      statements.push(env.DB.prepare(`INSERT INTO revision_requirements(revision_id,slot_key,kind,original_url,filename,name,
        required,state,object_hash,input_hash,derived_output_id,fetched_at,error_code,processor,processor_version,options_hash)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(revision_id,slot_key) DO NOTHING`)
        .bind(revisionId,row.slotKey,row.kind,row.originalUrl??null,row.filename??null,row.name??null,row.required?1:0,
          row.state,row.objectHash??null,row.inputHash??null,row.derivedOutputId??null,row.fetchedAt??null,row.errorCode??null,
          row.processor??null,row.processorVersion??null,row.optionsHash??null));
    }
    statements.push(
      env.DB.prepare(`INSERT INTO capture_observations(task_id,article_id,revision_id,observed_at,outcome)
        VALUES (?,?,?,?,'new') ON CONFLICT(task_id) DO NOTHING`).bind(taskId,articleId,revisionId,observedAt??0),
      env.DB.prepare(`UPDATE articles SET latest_observed_revision_id=?,next_revision_no=2
        WHERE id=? AND latest_observed_revision_id IS NULL AND next_revision_no=1
          AND NOT EXISTS(SELECT 1 FROM article_revisions other WHERE other.article_id=? AND other.id<>?)
        RETURNING id`).bind(revisionId,articleId,articleId,revisionId),
      env.DB.prepare(`UPDATE archive_migration_articles SET revision_id=?,task_id=?,state='imported',
        comparison_json=?,differences_json=?,updated_at=? WHERE run_id=? AND article_id=? AND revision_id IS NULL
        RETURNING article_id`).bind(revisionId,taskId,
          JSON.stringify(initialComparison({article,attachmentRows,sourceRows,inventory,ocrComparisons,objects,legacyManifest})),
          JSON.stringify(differences),now(),RUN_ID,articleId),
    );
    const committed=await env.DB.batch(statements);
    if(!committed.at(-1).results?.length)throw new MigrationConflictError('Legacy article was claimed by another version');
  }

  async function inspectLegacyObject({article,prefix,key,kind,slotKey,name,filename=null,originalUrl=null,
    expectedHash=null,expectedBytes=null,contentType=null,required=true,requireSignature=false,errorCode,
    differences,objects,observedAt}){
    const row=requirementRow(slotKey,kind,{name,originalUrl,filename},required,'failed',null,null,null,errorCode,filename);
    const invalid=()=>({row,object:null,bytes:null,text:null});
    if(!key||!key.startsWith(`${prefix}/`)){
      differences.push({slotKey,code:key?'object_key_invalid':'object_missing',message:key?'Object key is outside the legacy prefix':'Object key is missing',confirmed:false});
      return invalid();
    }
    const object=await env.ARCHIVE.get(key).catch(()=>null);
    if(!object){
      differences.push({slotKey,code:errorCode,message:`Legacy object ${key} is unavailable`,confirmed:false});
      return invalid();
    }
    if(object.size>12*1024*1024){
      differences.push({slotKey,code:'object_too_large',message:'Legacy object exceeds 12 MiB',confirmed:false});
      return invalid();
    }
    const bytes=new Uint8Array(await object.arrayBuffer()),hash=await sha(bytes);
    const issues=[];
    if(expectedHash!==null&&!validHash(expectedHash))issues.push({code:'stored_hash_invalid',
      message:'Legacy attachment sha256 is invalid'});
    if(expectedBytes!==null&&expectedBytes!==undefined&&(!Number.isSafeInteger(expectedBytes)||expectedBytes<0))issues.push({
      code:'stored_size_invalid',message:'Legacy attachment size is invalid'});
    if(validHash(expectedHash)&&expectedHash!==hash)issues.push({code:'object_hash_mismatch',
      message:`Stored sha256 ${expectedHash} does not match ${hash}`});
    if(Number.isSafeInteger(expectedBytes)&&expectedBytes>=0&&expectedBytes!==bytes.byteLength)issues.push({
      code:'object_size_mismatch',message:`Stored size ${expectedBytes} does not match ${bytes.byteLength}`});
    if(requireSignature&&!fileKind(bytes))issues.push({code:'object_signature_invalid',
      message:'Attachment bytes do not have a supported file signature'});
    if(issues.length){
      differences.push(...issues.map(issue=>({slotKey,...itemFrom(issue),confirmed:false})));
      return invalid();
    }
    const mediaType=contentType??object.httpMetadata?.contentType??'application/octet-stream';
    const immutable=await storeImmutable(env,bytes,mediaType,now());
    rememberObject(objects,immutable);
    row.state='fulfilled';row.objectHash=immutable.sha256;row.fetchedAt=observedAt;row.errorCode=null;
    return {row,object:immutable,bytes,text:kind==='body'?new TextDecoder().decode(bytes):null};
  }

  async function adoptLegacyOcr({article,attachment,analysis,objects,differences,ocrComparisons,timestamp,expectedJobs=null}){
    const jobs=await env.DB.prepare(`SELECT * FROM pdf_ocr_jobs WHERE article_id=? AND attachment_id=?
      AND source_hash=? AND source_key=? AND filename=? AND status='complete' ORDER BY updated_at DESC,id`)
      .bind(article.id,attachment.id,attachment.sha256,attachment.object_key,attachment.filename).all();
    for(const job of jobs.results){
      if(expectedJobs?.length&&!expectedJobs.some(expected=>
        String(expected.jobId)===String(job.id)&&expected.sourceHash===job.source_hash
        &&expected.sourceKey===job.source_key&&(!expected.filename||expected.filename===job.filename)
        &&expected.model===job.model&&expected.resultKey===job.result_key
        &&expected.totalPages===job.total_pages&&expected.ocrPages===job.ocr_pages)){
        continue;
      }
      const comparison={jobId:job.id,expected:{sourceHash:job.source_hash,sourceKey:job.source_key,
        model:job.model,resultKey:job.result_key,totalPages:job.total_pages,ocrPages:job.ocr_pages},
        adopted:null,differences:[]};
      ocrComparisons.push(comparison);
      if(!job.result_key){
        comparison.differences.push({code:'ocr_result_missing'});
        differences.push({slotKey:`attachment:${attachment.id}`,code:'ocr_result_missing',message:'Complete OCR job has no result object',confirmed:false});
        continue;
      }
      const processor='legacy-mvp-ocr',processorVersion='mvp-v1';
      const options={model:job.model,pageCoverage:'all-pages',adoption:'mvp-result-v1'};
      const optionsHash=await sha(JSON.stringify(options));
      const existing=await env.DB.prepare(`SELECT d.id,d.result_hash,d.completed_at,o.r2_key,o.byte_size
        FROM derived_outputs d JOIN artifact_objects o ON o.sha256=d.result_hash
        WHERE d.input_hash=? AND d.processor=? AND d.processor_version=? AND d.options_hash=?`)
        .bind(attachment.sha256,processor,processorVersion,optionsHash).first();
      let normalized;
      if(existing){
        const saved=await env.ARCHIVE.get(existing.r2_key).catch(()=>null);
        if(!saved){
          comparison.differences.push({code:'ocr_result_unavailable'});
          differences.push({slotKey:`attachment:${attachment.id}`,code:'ocr_result_unavailable',message:'Adopted OCR result is unavailable',confirmed:false});
          continue;
        }
        normalized=await saved.json();
      }
      if(!normalized){
        const saved=await env.ARCHIVE.get(job.result_key).catch(()=>null);
        if(!saved){
          comparison.differences.push({code:'ocr_result_missing'});
          differences.push({slotKey:`attachment:${attachment.id}`,code:'ocr_result_missing',message:`OCR result ${job.result_key} is unavailable`,confirmed:false});
          continue;
        }
        if(saved.size>8*1024*1024){
          comparison.differences.push({code:'ocr_result_too_large'});
          differences.push({slotKey:`attachment:${attachment.id}`,code:'ocr_result_too_large',message:'OCR result exceeds 8 MiB',confirmed:false});
          continue;
        }
        let output;
        try{output=await saved.json();}catch{
          comparison.differences.push({code:'ocr_result_invalid'});
          differences.push({slotKey:`attachment:${attachment.id}`,code:'ocr_result_invalid',message:'OCR result is not valid JSON',confirmed:false});
          continue;
        }
        const invalid=validateLegacyOcr(output,analysis,job);
        if(invalid){
          comparison.differences.push({code:'ocr_result_invalid',message:invalid});
          differences.push({slotKey:`attachment:${attachment.id}`,code:'ocr_result_invalid',message:invalid,confirmed:false});
          continue;
        }
        const createdAt=validTime(output.createdAt)??validTime(job.updated_at)??null;
        normalized={v:1,inputHash:attachment.sha256,processor,processorVersion,optionsHash,model:job.model,
          totalPages:analysis.totalPages,pages:output.pages.map(page=>({index:page.index,text:page.text,
            markdown:page.markdown,source:page.source})),legacy:{jobId:job.id,resultKey:job.result_key,
            sourceHash:output.sourceHash,estimatedUsd:output.estimatedUsd??job.estimated_usd??null},createdAt};
      }
      const invalid=validateLegacyOcr(normalized,analysis,{...job,model:normalized.model});
      if(invalid){
        comparison.differences.push({code:'ocr_result_invalid',message:invalid});
        differences.push({slotKey:`attachment:${attachment.id}`,code:'ocr_result_invalid',message:invalid,confirmed:false});
        continue;
      }
      const resultObject=await storeImmutable(env,new TextEncoder().encode(JSON.stringify(normalized)),'application/json',timestamp);
      const outputId=(await sha(JSON.stringify(['derived',attachment.sha256,processor,processorVersion,optionsHash]))).slice(0,24);
      const completedAt=legacyTime(normalized.createdAt)??0;
      const derived={...resultObject,derived:true,inputHash:attachment.sha256,processor,processorVersion,
        optionsHash,outputId,completedAt,
        statements:[
          env.DB.prepare(`INSERT INTO artifact_objects(sha256,r2_key,byte_size,media_type,verified_at)
            VALUES (?,?,?,?,?) ON CONFLICT(sha256) DO NOTHING`).bind(resultObject.sha256,resultObject.r2Key,
            resultObject.byteSize,resultObject.mediaType,resultObject.verifiedAt),
          env.DB.prepare(`INSERT INTO derived_outputs(id,input_hash,processor,processor_version,options_hash,result_hash,completed_at)
            VALUES (?,?,?,?,?,?,?) ON CONFLICT(input_hash,processor,processor_version,options_hash) DO NOTHING`)
            .bind(outputId,attachment.sha256,processor,processorVersion,optionsHash,resultObject.sha256,completedAt),
        ]};
      rememberObject(objects,derived);
      comparison.adopted={outputId,resultHash:resultObject.sha256,inputHash:attachment.sha256,processor,
        processorVersion,optionsHash,model:normalized.model,totalPages:normalized.totalPages};
      return comparison.adopted;
    }
    if(!jobs.results.length)differences.push({slotKey:`attachment:${attachment.id}`,code:'ocr_result_missing',
      message:'No complete OCR job matches the body PDF identity',confirmed:false});
    return null;
  }

  async function sourceStatementsFor({article,sourceRows,timestamp}){
    const statements=[];
    if(!sourceRows.results.some(row=>row.source_id===article.source_id)){
      const firstSeen=legacyTime(article.discovered_at)??0,lastSeen=legacyTime(article.captured_at)??firstSeen;
      const day=normalizedDay(article.published_at);
      statements.push(env.DB.prepare(`INSERT INTO article_sources(article_id,source_id,first_seen_at,last_seen_at,
        discovery_class,published_at,published_day,date_precision,source_timezone) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(article_id,source_id) DO NOTHING`).bind(article.id,article.source_id,firstSeen,lastSeen,
        'migrated',day,day,day?'day':'unknown','Asia/Shanghai'));
    }
    for(const row of sourceRows.results){
      const minute=row.date_precision==='minute'&&typeof row.published_at==='string'
        &&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(row.published_at)&&validTime(row.published_at)!==null;
      const day=['day','minute'].includes(row.date_precision)?normalizedDay(row.published_day)
        ??(row.date_precision==='day'?normalizedDay(row.published_at):null):null;
      const precision=minute?'minute':row.date_precision==='day'&&day?'day':'unknown';
      const publishedAt=minute?row.published_at:precision==='day'?day:null;
      if(row.published_at!==publishedAt||row.published_day!==day||row.date_precision!==precision){
        statements.push(env.DB.prepare(`UPDATE article_sources SET published_at=?,published_day=?,date_precision=?
          WHERE article_id=? AND source_id=? AND first_seen_at=?`).bind(publishedAt,day,precision,article.id,row.source_id,row.first_seen_at));
      }
    }
    return statements;
  }

  async function finishRecord(articleId){
    const record=await env.DB.prepare('SELECT revision_id,state FROM archive_migration_articles WHERE run_id=? AND article_id=?')
      .bind(RUN_ID,articleId).first();
    if(!record?.revision_id)throw new MigrationNotFoundError('Imported revision is missing');
    if(!['imported','failed'].includes(record.state))return record.state;
    const result=await reconcileRevision(env,record.revision_id);
    if(result.notFound)throw new MigrationNotFoundError('Imported revision is missing');
    const state=result.state==='ready'?'ready':'blocked';
    const comparison=await refreshComparison(articleId,record.revision_id,state);
    await env.DB.prepare(`UPDATE archive_migration_articles SET state=?,comparison_json=?,updated_at=?
      WHERE run_id=? AND article_id=? AND state IN ('imported','failed')`).bind(state,JSON.stringify(comparison),now(),RUN_ID,articleId).run();
    return state;
  }

  async function refreshComparison(articleId,revisionId,state){
    const row=await env.DB.prepare(`SELECT m.comparison_json,r.requirement_count,
      (SELECT COUNT(*) FROM revision_requirements q WHERE q.revision_id=r.id) AS requirements,
      (SELECT COUNT(*) FROM revision_requirements q WHERE q.revision_id=r.id AND q.required=1 AND q.state='fulfilled') AS fulfilled,
      (SELECT COUNT(DISTINCT q.object_hash) FROM revision_requirements q WHERE q.revision_id=r.id AND q.object_hash IS NOT NULL) AS objectHashes,
      (SELECT COUNT(*) FROM content_events e WHERE e.revision_id=r.id AND e.history_only=1) AS historyOnlyEvents,
      (SELECT COUNT(*) FROM event_sources es JOIN content_events e ON e.id=es.event_id WHERE e.revision_id=r.id) AS eventSources
      FROM archive_migration_articles m JOIN article_revisions r ON r.id=m.revision_id
      WHERE m.run_id=? AND m.article_id=?`).bind(RUN_ID,articleId).first();
    if(!row)throw new MigrationNotFoundError('Migration comparison is missing');
    const comparison=parseJson(row.comparison_json,{});
    const sources=await env.DB.prepare(`SELECT es.source_id AS sourceId,es.article_source_first_seen_at AS firstSeenAt,
      es.discovery_class AS discoveryClass,es.published_at AS publishedAt,es.published_day AS publishedDay,
      es.date_precision AS datePrecision,es.source_timezone AS sourceTimezone
      FROM event_sources es JOIN content_events e ON e.id=es.event_id WHERE e.revision_id=? ORDER BY es.source_id`)
      .bind(revisionId).all();
    const originals=await env.DB.prepare(`SELECT q.slot_key AS slotKey,q.kind,q.filename,q.state,
      q.object_hash AS sha256,o.byte_size AS bytes FROM revision_requirements q
      LEFT JOIN artifact_objects o ON o.sha256=q.object_hash WHERE q.revision_id=? AND q.kind<>'body_ocr' ORDER BY q.slot_key`)
      .bind(revisionId).all();
    const adoptedOcr=await env.DB.prepare(`SELECT q.derived_output_id AS outputId,q.input_hash AS inputHash,
      q.object_hash AS resultHash,q.processor,q.processor_version AS processorVersion,q.options_hash AS optionsHash
      FROM revision_requirements q WHERE q.revision_id=? AND q.kind='body_ocr' AND q.state='fulfilled' ORDER BY q.slot_key`)
      .bind(revisionId).all();
    comparison.actual={...comparison.actual,state,requirements:row.requirements,
      fulfilledRequirements:row.fulfilled,verifiedObjectHashes:row.objectHashes,historyOnlyEvents:row.historyOnlyEvents,
      eventSources:row.eventSources,sources:sources.results,originals:originals.results,adoptedOcr:adoptedOcr.results,
      verifiedFiles:originals.results.filter(file=>['attachment','body_pdf'].includes(file.kind)&&file.state==='fulfilled').length};
    return comparison;
  }

  async function repairRecord(articleId){
    const context=await env.DB.prepare(`SELECT m.state,m.differences_json,m.comparison_json,r.id AS revision_id,r.title AS revision_title,a.*
      FROM archive_migration_articles m JOIN article_revisions r ON r.id=m.revision_id
      JOIN articles a ON a.id=m.article_id WHERE m.run_id=? AND m.article_id=?`).bind(RUN_ID,articleId).first();
    if(!context)throw new MigrationNotFoundError('Imported revision is missing');
    const requirements=await env.DB.prepare(`SELECT * FROM revision_requirements WHERE revision_id=? ORDER BY slot_key`)
      .bind(context.revision_id).all();
    const attachments=await legacyAttachments(articleId);
    const legacyManifest=await legacyManifestFor(env,context);
    const objects=new Map(),bodyInputs=new Map(),differences=[],statements=[];
    const expected=parseJson(context.comparison_json,{}).expected??{};
    const frozenArtifact=(key,name)=>expected.manifestArtifacts?.find(item=>
      (key&&item.key===key)||(name&&item.name===name))??null;

    async function fulfilledBodyInput(requirement,ocrRequirement){
      const slot=Number(requirement.slot_key.split(':')[1]),rawAttachment=attachments.results[slot-1]??null;
      const frozen=frozenArtifact(null,requirement.filename);
      const expectedJob=expected.ocrJobs?.find(job=>job.sourceHash===ocrRequirement.input_hash
        &&job.filename===requirement.filename)??null;
      const sourceKey=expectedJob?.sourceKey??frozen?.key??rawAttachment?.object_key??null;
      if(!sourceKey||!String(sourceKey).startsWith(`${context.prefix}/`))return null;
      if(rawAttachment?.filename&&requirement.filename&&rawAttachment.filename!==requirement.filename)return null;
      if(validHash(rawAttachment?.sha256)&&rawAttachment.sha256!==ocrRequirement.input_hash)return null;
      if(validHash(frozen?.sha256)&&frozen.sha256!==ocrRequirement.input_hash)return null;
      const saved=await env.ARCHIVE.get(immutableKey(requirement.object_hash)).catch(()=>null);
      if(!saved)return null;
      const bytes=new Uint8Array(await saved.arrayBuffer()),hash=await sha(bytes);
      if(hash!==requirement.object_hash||hash!==ocrRequirement.input_hash)return null;
      return {attachment:{
        id:rawAttachment?.id??`missing-${slot}`,article_id:articleId,name:requirement.name,
        original_url:requirement.original_url,filename:requirement.filename,object_key:sourceKey,
        bytes:saved.size,content_type:null,sha256:hash,status:'complete',role:'body-pdf',
      },bytes,objectHash:hash};
    }

    for(const requirement of requirements.results){
      if(requirement.kind==='body_pdf'&&requirement.object_hash){
        const slot=Number(requirement.slot_key.split(':')[1]),ocrSlot=`ocr:${slot}`;
        const ocrRequirement=requirements.results.find(row=>row.slot_key===ocrSlot);
        if(ocrRequirement?.required&&ocrRequirement.state!=='fulfilled'&&!ocrRequirement.derived_output_id){
          const input=await fulfilledBodyInput(requirement,ocrRequirement);
          if(input)bodyInputs.set(requirement.slot_key,input);
        }
        continue;
      }
      if(requirement.state==='fulfilled'||requirement.object_hash)continue;
      let inspected=null;
      if(requirement.kind==='body'){
        const key=`${context.prefix}/body.txt`,frozen=frozenArtifact(key,'body.txt');
        if(frozen)inspected=await inspectLegacyObject({article:context,prefix:context.prefix,key,
          kind:'body',slotKey:requirement.slot_key,name:requirement.name??'正文',filename:requirement.filename,
          originalUrl:requirement.original_url,expectedHash:frozen.sha256,expectedBytes:frozen.bytes,
          required:requirement.required,errorCode:requirement.error_code,differences,objects,observedAt:now()});
      }else if(requirement.kind==='snapshot'){
        const key=context.snapshot_key??`${context.prefix}/offline.html`;
        const frozen=frozenArtifact(key,'offline.html');
        if(frozen)inspected=await inspectLegacyObject({article:context,prefix:context.prefix,key,kind:'snapshot',
          slotKey:requirement.slot_key,name:requirement.name??'原貌存档',filename:requirement.filename,
          originalUrl:requirement.original_url,expectedHash:frozen.sha256,expectedBytes:frozen.bytes,
          required:requirement.required,errorCode:requirement.error_code,differences,objects,observedAt:now()});
      }else if(requirement.kind==='screenshot'){
        const frozen=context.screenshot_key?frozenArtifact(context.screenshot_key,'original.png'):null;
        if(frozen)inspected=await inspectLegacyObject({article:context,prefix:context.prefix,key:context.screenshot_key,
          kind:'screenshot',slotKey:requirement.slot_key,name:requirement.name??'截图',filename:requirement.filename,
          originalUrl:requirement.original_url,expectedHash:frozen.sha256,expectedBytes:frozen.bytes,
          required:requirement.required,errorCode:requirement.error_code,differences,objects,observedAt:now()});
      }else if(['attachment','body_pdf'].includes(requirement.kind)){
        const slot=Number(requirement.slot_key.split(':')[1]);
        const attachment=attachments.results[slot-1]??{
          id:`missing-${slot}`,article_id:articleId,name:requirement.name??`附件 ${slot}`,
          original_url:requirement.original_url,filename:requirement.filename,object_key:null,bytes:0,
          content_type:null,sha256:null,status:'failed',role:requirement.kind==='body_pdf'?'body-pdf':'attachment',
        };
        const expectedAttachment=expected.attachmentHashes?.[slot-1]??null;
        const frozen=frozenArtifact(null,requirement.filename??attachment.filename);
        const attachmentHash=expectedAttachment?.sha256??null,manifestHash=frozen?.sha256??null;
        const attachmentBytes=expectedAttachment?.bytes??null,manifestBytes=frozen?.bytes??null;
        const hashesAgree=!validHash(attachmentHash)||!validHash(manifestHash)||attachmentHash===manifestHash;
        const expectedHash=validHash(attachmentHash)?attachmentHash:validHash(manifestHash)?manifestHash:null;
        const expectedBytes=Number.isSafeInteger(attachmentBytes)&&attachmentBytes>=0
          ?attachmentBytes:Number.isSafeInteger(manifestBytes)&&manifestBytes>=0?manifestBytes:null;
        const liveKey=attachment.object_key??legacyManifest?.descriptor(null,requirement.filename??attachment.filename)?.key??null;
        const key=frozen?.key??liveKey;
        const identityMatches=(!requirement.filename||attachment.filename===requirement.filename)
          &&(!validHash(expectedHash)||!requirement.input_hash||expectedHash===requirement.input_hash)
          &&hashesAgree&&validHash(expectedHash)&&Number.isSafeInteger(expectedBytes)&&expectedBytes>=0;
        if(identityMatches&&key){
          inspected=await inspectLegacyObject({article:context,prefix:context.prefix,key,
            kind:requirement.kind,slotKey:requirement.slot_key,name:attachment.name??requirement.name,
            filename:attachment.filename??requirement.filename,originalUrl:attachment.original_url,
            expectedHash,expectedBytes,
            contentType:attachment.content_type??frozen?.contentType,required:requirement.required,
            requireSignature:true,errorCode:requirement.error_code,differences,objects,observedAt:now()});
          if(inspected?.bytes&&requirement.kind==='body_pdf')
            bodyInputs.set(requirement.slot_key,{attachment:{...attachment,sha256:expectedHash,
              bytes:expectedBytes},bytes:inspected.bytes,objectHash:inspected.row.objectHash});
        }
      }
      if(inspected?.row?.state==='fulfilled'){
        statements.push(env.DB.prepare(`UPDATE revision_requirements SET state='fulfilled',object_hash=?,fetched_at=?,error_code=NULL
          WHERE revision_id=? AND slot_key=? AND state<>'fulfilled' AND object_hash IS NULL`)
          .bind(inspected.row.objectHash,now(),context.revision_id,requirement.slot_key));
      }
    }

    for(const [slotKey,input] of bodyInputs){
      let analysis;
      try{analysis=await pdfPages(input.bytes);}catch{continue;}
      if(!analysis.pages.some(page=>page.needsOcr))continue;
      const adopted=await adoptLegacyOcr({article:context,attachment:input.attachment,analysis,objects,
        differences,ocrComparisons:[],timestamp:now(),expectedJobs:expected.ocrJobs??null});
      const slot=slotKey.split(':')[1],ocrSlot=`ocr:${slot}`;
      const existing=requirements.results.find(row=>row.slot_key===ocrSlot);
      if(existing){
        const identityMatches=adopted&&['processor','processorVersion','optionsHash'].every(key=>
          existing[{processor:'processor',processorVersion:'processor_version',optionsHash:'options_hash'}[key]]===adopted[key]);
        if(!identityMatches)continue;
        statements.push(env.DB.prepare(`UPDATE revision_requirements SET state='fulfilled',object_hash=?,derived_output_id=?,
          fetched_at=?,error_code=NULL WHERE revision_id=? AND slot_key=? AND state<>'fulfilled' AND derived_output_id IS NULL`)
          .bind(adopted.resultHash,adopted.outputId,now(),context.revision_id,ocrSlot));
      }else{
        const processing=adopted??await legacyOcrIdentity(env,context,input.attachment);
        statements.push(env.DB.prepare(`UPDATE article_revisions SET requirement_count=requirement_count+1,
          requirement_generation=requirement_generation+1 WHERE id=? AND state<>'ready'
          AND NOT EXISTS(SELECT 1 FROM revision_requirements WHERE revision_id=? AND slot_key=?)`)
          .bind(context.revision_id,context.revision_id,ocrSlot));
        statements.push(env.DB.prepare(`INSERT INTO revision_requirements(revision_id,slot_key,kind,original_url,filename,name,
          required,state,object_hash,input_hash,derived_output_id,fetched_at,error_code,processor,processor_version,options_hash)
          VALUES (?,?,'body_ocr',?,?,?,1,?,?,?,?,?,?,?,?,?) ON CONFLICT(revision_id,slot_key) DO NOTHING`)
          .bind(context.revision_id,ocrSlot,input.attachment.original_url??null,input.attachment.filename??null,
            input.attachment.name??null,adopted?'fulfilled':'failed',adopted?.resultHash??null,input.objectHash,
            adopted?.outputId??null,now(),adopted?null:'ocr_unverifiable',
            processing.processor,processing.processorVersion,processing.optionsHash));
      }
    }

    const preamble=[...objectStatements(env,objects)];
    for(const object of objects.values())if(object.derived)preamble.push(...object.statements);
    if(preamble.length||statements.length)await env.DB.batch([...preamble,...statements]);
    const missing=await env.DB.prepare(`SELECT COUNT(*) AS n FROM revision_requirements
      WHERE revision_id=? AND required=1 AND state<>'fulfilled'`).bind(context.revision_id).first();
    let state='blocked';
    if(!missing.n){
      const complete=await env.DB.prepare(`SELECT slot_key,kind,name,object_hash,input_hash FROM revision_requirements WHERE revision_id=?`)
        .bind(context.revision_id).all();
      const body=complete.results.find(row=>row.kind==='body');
      const bodyText=await(await env.ARCHIVE.get(immutableKey(body.object_hash))).text();
      const files=complete.results.filter(row=>['attachment','body_pdf'].includes(row.kind))
        .sort((a,b)=>Number(a.slot_key.split(':')[1])-Number(b.slot_key.split(':')[1]));
      const semanticFingerprint=await sha(JSON.stringify({v:1,title:normalizeText(context.revision_title),
        body:normalizeText(readingText(bodyText)),files:files.map(row=>[normalizeText(row.name??''),row.kind,row.object_hash])}));
      await env.DB.prepare(`UPDATE article_revisions SET state='assembling',semantic_fingerprint=? WHERE id=? AND state='blocked'
        AND NOT EXISTS(SELECT 1 FROM revision_requirements q WHERE q.revision_id=article_revisions.id AND q.required=1 AND q.state<>'fulfilled')`)
        .bind(semanticFingerprint,context.revision_id).run();
      const result=await reconcileRevision(env,context.revision_id);
      state=result.state==='ready'?'ready':'blocked';
    }
    const nextDifferences=state==='ready'?differences:[...parseJson(context.differences_json,[]),...differences];
    const comparison=await refreshComparison(articleId,context.revision_id,state);
    await env.DB.prepare(`UPDATE archive_migration_articles SET state=?,comparison_json=?,differences_json=?,updated_at=?
      WHERE run_id=? AND article_id=? AND state IN ('blocked','failed','imported')`)
      .bind(state,JSON.stringify(comparison),JSON.stringify(nextDifferences),now(),RUN_ID,articleId).run();
    return state;
  }

  async function excludeRecord(articleId,reason){
    await env.DB.prepare(`UPDATE archive_migration_articles SET state='excluded',comparison_json=?,updated_at=?
      WHERE run_id=? AND article_id=? AND revision_id IS NULL`).bind(JSON.stringify(excludedComparison(reason)),now(),RUN_ID,articleId).run();
  }

  async function legacyAttachments(articleId){
    return env.DB.prepare(`SELECT * FROM attachments WHERE article_id=? ORDER BY
      CASE WHEN filename GLOB 'attachment-[0-9]*.*' THEN CAST(substr(filename,12) AS INTEGER) ELSE 2147483647 END,id`)
      .bind(articleId).all();
  }

  async function advanceCursor(articleId){
    await env.DB.prepare(`UPDATE archive_migration_runs SET last_article_id=CASE
      WHEN last_article_id IS NULL OR ?>last_article_id THEN ? ELSE last_article_id END,updated_at=? WHERE id=?`)
      .bind(articleId,articleId,now(),RUN_ID).run();
  }

  async function finalize(){
    const report=await buildReport(),remaining=await remainingCount();
    const counts=report.imported;
    const state=counts.failed>0?'failed':remaining>0?'running':counts.blocked>0?'blocked':'succeeded';
    const checkpoint={v:1,lastArticleId:(await runStatus())?.last_article_id??null,remaining};
    await env.DB.prepare(`UPDATE archive_migration_runs SET state=?,report_json=?,checkpoint_json=?,updated_at=? WHERE id=?`)
      .bind(state,JSON.stringify(report),JSON.stringify(checkpoint),now(),RUN_ID).run();
    return state;
  }

  async function buildReport(){
    const [legacy,states,revisions,events,historyEvents,eventSources,objectRefs,differences,excluded]=await Promise.all([
      legacyReport(),
      env.DB.prepare(`SELECT state,COUNT(*) AS n FROM archive_migration_articles WHERE run_id=? GROUP BY state`).bind(RUN_ID).all(),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM article_revisions r JOIN archive_migration_articles m ON m.revision_id=r.id WHERE m.run_id=?`).bind(RUN_ID).first(),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM content_events e JOIN archive_migration_articles m ON m.revision_id=e.revision_id WHERE m.run_id=?`).bind(RUN_ID).first(),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM content_events e JOIN archive_migration_articles m ON m.revision_id=e.revision_id WHERE m.run_id=? AND e.history_only=1`).bind(RUN_ID).first(),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM event_sources es JOIN content_events e ON e.id=es.event_id
        JOIN archive_migration_articles m ON m.revision_id=e.revision_id WHERE m.run_id=?`).bind(RUN_ID).first(),
      env.DB.prepare(`SELECT COUNT(DISTINCT q.object_hash) AS n FROM revision_requirements q
        JOIN archive_migration_articles m ON m.revision_id=q.revision_id WHERE m.run_id=? AND q.object_hash IS NOT NULL`).bind(RUN_ID).first(),
      env.DB.prepare(`SELECT DISTINCT json_extract(value,'$.code') AS code FROM archive_migration_articles,json_each(differences_json)`).all(),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM articles a WHERE a.prefix IS NOT NULL
        AND EXISTS(SELECT 1 FROM article_revisions r WHERE r.article_id=a.id
          AND NOT EXISTS(SELECT 1 FROM archive_migration_articles m WHERE m.revision_id=r.id))`).first(),
    ]);
    const byState=Object.fromEntries(states.results.map(row=>[row.state,row.n]));
    const importedArticles=(byState.ready??0)+(byState.blocked??0)+(byState.failed??0)+(byState.imported??0);
    return {
      legacy,
      imported:{articles:importedArticles,ready:byState.ready??0,blocked:byState.blocked??0,
        failed:byState.failed??0,importing:byState.imported??0,excluded:byState.excluded??0,
        revisions:revisions.n,contentEvents:events.n,historyOnlyEvents:historyEvents.n,
        eventSources:eventSources.n,objectReferences:objectRefs.n},
      comparison:{differences:differences.results.map(row=>row.code).filter(Boolean).sort()},
    };
  }

  async function legacyReport(){
    const [articles,attachments,sources,bodyPdfs,ocrJobs]=await Promise.all([
      env.DB.prepare(`SELECT COUNT(*) AS n FROM articles a WHERE ${legacyRevision}`).first(),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM attachments t JOIN articles a ON a.id=t.article_id WHERE ${legacyRevision}`).first(),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM article_sources s JOIN articles a ON a.id=s.article_id WHERE ${legacyRevision}`).first(),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM attachments t JOIN articles a ON a.id=t.article_id WHERE ${legacyRevision} AND t.role='body-pdf'`).first(),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM pdf_ocr_jobs j JOIN articles a ON a.id=j.article_id WHERE ${legacyRevision} AND j.status='complete'`).first(),
    ]);
    return {articles:articles.n,attachments:attachments.n,sourceAssociations:sources.n,
      bodyPdfObjects:bodyPdfs.n,completeOcrJobs:ocrJobs.n};
  }

  async function remainingCount(){
    return (await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM articles a WHERE ${unclaimedLegacy})+
      (SELECT COUNT(*) FROM archive_migration_articles WHERE run_id=? AND state IN ('imported','failed')) AS n`)
      .bind(RUN_ID).first()).n;
  }

  async function runStatus(){
    return env.DB.prepare('SELECT * FROM archive_migration_runs WHERE id=?').bind(RUN_ID).first();
  }
}

function objectStatements(env,objects){
  return [...objects.values()].filter(object=>!object.derived).map(object=>
    env.DB.prepare(`INSERT INTO artifact_objects(sha256,r2_key,byte_size,media_type,verified_at)
      VALUES (?,?,?,?,?) ON CONFLICT(sha256) DO NOTHING`)
      .bind(object.sha256,object.r2Key,object.byteSize,object.mediaType,object.verifiedAt));
}

async function legacyManifestFor(env,article){
  const key=`${article.prefix}/manifest.json`;
  const object=await env.ARCHIVE.get(key).catch(()=>null);
  if(!object||object.size>2*1024*1024)return null;
  let manifest;
  try{manifest=await object.json();}catch{return null;}
  const runId=article.prefix.split('/').at(-1);
  if(manifest?.id!==article.id||manifest?.url!==article.url||manifest?.runId!==runId
    ||!Array.isArray(manifest.artifacts))return null;
  const artifacts=manifest.artifacts.filter(item=>item?.key?.startsWith(`${article.prefix}/`)
    &&validHash(item.sha256)&&Number.isSafeInteger(item.bytes)&&item.bytes>=0
    &&typeof item.name==='string'&&item.name);
  return {
    manifest,
    artifacts,
    descriptor(key,name){
      const exact=key?artifacts.find(item=>item.key===key):null;
      return exact??(name?artifacts.find(item=>item.name===name):null);
    },
  };
}

function frozenAttachmentDescriptor({legacyManifest,attachment,slotNo}){
  if(!legacyManifest)return null;
  if(attachment.object_key){
    const exact=legacyManifest.descriptor(attachment.object_key,null);
    if(exact)return exact;
  }
  if(attachment.filename)return legacyManifest.descriptor(null,attachment.filename);
  const pattern=new RegExp(`^attachment-${slotNo}\\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z|bin)$`,'i');
  return legacyManifest.artifacts.find(item=>pattern.test(item.name))??null;
}

async function legacyOcrIdentity(env,article,attachment){
  const job=await env.DB.prepare(`SELECT model FROM pdf_ocr_jobs WHERE article_id=? AND attachment_id=?
    AND source_hash=? AND source_key=? AND filename=? ORDER BY CASE WHEN status='complete' THEN 0 ELSE 1 END,updated_at DESC,id LIMIT 1`)
    .bind(article.id,attachment.id,attachment.sha256,attachment.object_key,attachment.filename).first();
  const model=job?.model??article.ocr_model??env.PDF_OCR_MODEL??'unknown';
  const processor='legacy-mvp-ocr',processorVersion='mvp-v1';
  const options={model,pageCoverage:'all-pages',adoption:'mvp-result-v1'};
  return {processor,processorVersion,optionsHash:await sha(JSON.stringify(options))};
}

function rememberObject(map,object){
  const existing=map.get(object.sha256);
  if(!existing){map.set(object.sha256,object);return;}
  if(existing.derived&&object.derived)existing.statements.push(...object.statements.filter(statement=>!existing.statements.includes(statement)));
}

async function storeImmutable(env,bytes,mediaType,timestamp){
  const value=bytes instanceof Uint8Array?bytes:new TextEncoder().encode(bytes);
  const hash=await sha(value),key=immutableKey(hash);
  let object=await env.ARCHIVE.head(key);
  if(!object){
    object=await env.ARCHIVE.put(key,value,{onlyIf:{etagDoesNotMatch:'*'},sha256:hash,
      httpMetadata:{contentType:mediaType}});
    object??=await env.ARCHIVE.head(key);
  }
  if(!object||object.size!==value.byteLength)throw new Error('Immutable object verification failed');
  const checksum=object.checksums?.sha256;
  if(!checksum||Buffer.from(checksum).toString('hex')!==hash)throw new Error('Immutable object checksum is not verified');
  return {sha256:hash,r2Key:key,byteSize:value.byteLength,mediaType,verifiedAt:timestamp};
}

function requirementRow(slotKey,kind,attachment,required,state,objectHash,inputHash,derivedOutputId,errorCode,filename,processing={}){
  return {slotKey,kind,name:attachment.name??filename??slotKey,filename:filename??attachment.filename??null,
    originalUrl:attachment.originalUrl??null,required,state,objectHash:objectHash??null,inputHash:inputHash??null,
    derivedOutputId:derivedOutputId??null,fetchedAt:null,errorCode,processor:processing.processor??null,
    processorVersion:processing.processorVersion??null,optionsHash:processing.optionsHash??null};
}

function initialComparison({article,attachmentRows,sourceRows,inventory,ocrComparisons,objects,legacyManifest}){
  const files=inventory.filter(row=>row.kind==='attachment'||row.kind==='body_pdf');
  return {
    expected:{
      legacyStatus:article.status,attachmentCount:Number.isSafeInteger(article.attachment_count)?article.attachment_count:attachmentRows.length,
      attachmentRecords:attachmentRows.length,sourceAssociations:sourceRows.results.length,
      sourceIds:sourceRows.results.map(row=>row.source_id),bodyPdfs:attachmentRows.filter(row=>row.role==='body-pdf').length,
      attachmentHashes:attachmentRows.map(row=>({id:row.id,sha256:row.sha256??null,bytes:Number.isSafeInteger(row.bytes)?row.bytes:null})),
      manifestArtifacts:legacyManifest?.artifacts.map(item=>({key:item.key,name:item.name,sha256:item.sha256,bytes:item.bytes}))??[],
      ocrJobs:ocrComparisons.map(item=>({jobId:item.jobId,...item.expected})),
    },
    actual:{
      requirements:inventory.length,fulfilledRequirements:inventory.filter(row=>row.required&&row.state==='fulfilled').length,
      verifiedFiles:files.filter(row=>row.state==='fulfilled').length,
      verifiedObjectHashes:new Set([...objects.values()].map(object=>object.sha256)).size,
      adoptedOcr:ocrComparisons.filter(item=>item.adopted).map(item=>item.adopted),
    },
  };
}

function excludedComparison(reason){
  return {expected:{},actual:{state:'excluded'},reason};
}

function validateLegacyOcr(output,analysis,job){
  if(!output||typeof output!=='object')return 'OCR result is not an object';
  if(!validHash(output.sourceHash)&&!validHash(output.inputHash))return 'OCR result has no original PDF identity';
  if(!Number.isSafeInteger(job.total_pages)||job.total_pages!==analysis.totalPages)return 'OCR job page count does not cover the PDF';
  if(!Number.isSafeInteger(job.ocr_pages)||job.ocr_pages!==analysis.pages.filter(page=>page.needsOcr).length)
    return 'OCR job recognized-page count does not match the PDF';
  if(output.inputHash!==undefined&&output.inputHash!==job.source_hash)return 'OCR input identity does not match the original PDF';
  if(output.sourceHash!==undefined&&output.sourceHash!==job.source_hash)return 'OCR source hash does not match the original PDF';
  if(output.model!==job.model)return 'OCR model does not match its legacy job';
  if(!Number.isSafeInteger(output.totalPages)||output.totalPages!==analysis.totalPages)return 'OCR page count does not cover the PDF';
  if(!Array.isArray(output.pages)||output.pages.length!==analysis.totalPages)return 'OCR pages do not cover the PDF';
  const indexes=new Set();
  for(const page of output.pages){
    if(!page||typeof page!=='object'||!Number.isSafeInteger(page.index)||page.index<0||page.index>=analysis.totalPages
      ||indexes.has(page.index)||typeof page.text!=='string'||typeof page.markdown!=='string'
      ||!['native','ocr'].includes(page.source))return `OCR page ${page?.index+1} is invalid`;
    indexes.add(page.index);
  }
  for(const page of analysis.pages){
    const result=output.pages.find(item=>item.index===page.index);
    if(page.needsOcr&&(result.source!=='ocr'||!result.text.trim()||!result.markdown.trim()))
      return `OCR page ${page.index+1} is incomplete`;
    if(!page.needsOcr&&result.source!=='native')return `Native PDF page ${page.index+1} was changed by OCR`;
  }
  return null;
}

function presentRun(row){
  return {...row,report:undefined,checkpoint:parseJson(row.checkpoint_json,{})};
}

function emptyReport(){
  return {legacy:{articles:0,attachments:0,sourceAssociations:0,bodyPdfObjects:0,completeOcrJobs:0},
    imported:{articles:0,ready:0,blocked:0,failed:0,importing:0,excluded:0,revisions:0,contentEvents:0,
      historyOnlyEvents:0,eventSources:0,objectReferences:0},
    comparison:{differences:[]}};
}

function validateRequest(payload){
  if(!payload||typeof payload!=='object'||Array.isArray(payload)
    ||Object.keys(payload).some(key=>!['requestId','batchSize'].includes(key))||!('requestId' in payload))
    throw new MigrationValidationError('requestId and batchSize are required');
  if(!requestPattern.test(payload.requestId??''))throw new MigrationValidationError('requestId must contain 8-100 URI-safe characters');
  if(payload.batchSize!==undefined)validatedSize(payload.batchSize);
}

function validatedSize(value){
  if(!Number.isSafeInteger(value)||value<1||value>100)throw new MigrationValidationError('batchSize must be an integer from 1 through 100');
  return value;
}
const size=(value,fallbionValue=20)=>Number.isSafeInteger(value)?Math.min(100,Math.max(1,value)):fallbionValue;
const itemFrom=({code,message})=>({code,message});
const normalizeText=value=>String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim();
function normalizedDay(value){
  const day=String(value??'').match(/^(20\d{2})-(\d{2})-(\d{2})$/)?.[0];
  return day&&Number.isFinite(Date.parse(day))&&new Date(day).toISOString().startsWith(day)?day:null;
}
function legacyTime(value){
  if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)return value;
  const time=Date.parse(String(value??''));
  return Number.isFinite(time)?time:null;
}
const validTime=value=>legacyTime(value);
const validHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function parseJson(value,fallthrough){try{return JSON.parse(value);}catch{return fallthrough;}}
