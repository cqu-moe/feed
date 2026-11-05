import {readingTitleSql} from './reading.mjs';
import {revisionOcr} from './archive-versions.mjs';
import {loadLegacySearchNotice} from './bailian-legacy.mjs';
import {appendSearchPdf,webSearchText} from './bailian-evidence.mjs';

const maxTextBytes=8*1024*1024;

export async function loadSearchNotice(env,articleId){
  const article=await env.DB.prepare(`SELECT a.id,r.id AS revisionId,r.source_metadata_json AS sourceMetadata,
      ${readingTitleSql('r.title','a.title','r.observed_at')} AS title,r.published_at AS publishedAt,
      m.ocr_result_hash AS ocrResultHash,m.ocr_model AS ocrModel,m.ocr_updated_at AS ocrUpdatedAt,
      s.id AS sourceId,s.site_id AS siteId
    FROM articles a JOIN article_revisions r ON r.id=a.latest_ready_revision_id AND r.state='ready'
    LEFT JOIN article_read_models m ON m.article_id=a.id AND m.revision_id=r.id
    JOIN sources s ON s.id=a.source_id WHERE a.id=?`).bind(articleId).first();
  if(!article)return loadLegacySearchNotice(env,articleId);
  const requirements=await env.DB.prepare(`SELECT q.slot_key AS slot,q.slot_key AS slotKey,q.input_hash AS inputHash,q.kind,q.state,q.filename,q.name,
      q.object_hash AS objectHash,o.r2_key AS objectKey,o.byte_size AS bytes,o.media_type AS contentType
    FROM revision_requirements q LEFT JOIN artifact_objects o ON o.sha256=q.object_hash
    WHERE q.revision_id=? ORDER BY q.slot_key`).bind(article.revisionId).all();
  const ocr=await revisionOcr(env,requirements.results,article);
  const readable=requirements.results.filter(row=>row.state==='fulfilled'&&row.objectHash&&row.objectKey);
  const body=readable.find(row=>row.kind==='body');
  if(!body)throw new Error('Readable revision body is unavailable');

  const associated=await env.DB.prepare(`SELECT src.site_id AS siteId,src.id AS sourceId
    FROM article_sources a JOIN sources src ON src.id=a.source_id
    WHERE a.article_id=? ORDER BY src.id`).bind(articleId).all();
  const membershipMap=new Map(associated.results.map(row=>[`${row.siteId}\0${row.sourceId}`,row]));
  membershipMap.set(`${article.siteId}\0${article.sourceId}`,{
    siteId:article.siteId,sourceId:article.sourceId,
  });
  const projection={
    articleId,
    revisionId:article.revisionId,
    title:article.title,
    publishedDay:normalizedDay(article.publishedAt),
    memberships:[...membershipMap.values()],
    documents:[],
    skipped:[],
  };

  const files=readable.filter(row=>row.kind==='attachment'||row.kind==='body_pdf');
  const byObject=new Map();
  for(const file of files){
    if(!byObject.has(file.objectHash))byObject.set(file.objectHash,[]);
    byObject.get(file.objectHash).push(file);
  }
  const pdfDocuments=[];
  for(const group of byObject.values()){
    const primary=group.find(row=>row.kind==='body_pdf')
      ??group.slice().sort((left,right)=>left.slot.localeCompare(right.slot,undefined,{numeric:true}))[0];
    projection.skipped.push(...group.filter(row=>row.slot!==primary.slot)
      .map(row=>({slot:row.slot,reason:'duplicate_original'})));
    const knownPages=ocr?.pages
      ?.filter(page=>page.filename===primary.filename)
      .map(page=>({number:page.page,text:page.text}));
    const before=projection.documents.length;
    await appendSearchPdf(env,projection,primary,knownPages?.length?knownPages:undefined);
    if(projection.documents.length>before)pdfDocuments.push(projection.documents.at(-1));
  }

  if(body.bytes>maxTextBytes)throw new Error('Readable revision body exceeds extraction limit');
  const bodyObject=await env.ARCHIVE.get(body.objectKey);
  if(!bodyObject)throw new Error('Readable revision body object is unavailable');
  const sourceMetadata=JSON.parse(article.sourceMetadata??'{}');
  const tableKey=sourceMetadata.tableMarkupHash===undefined
    ?readable.find(row=>row.kind==='snapshot')?.objectKey
    :sourceMetadata.tableMarkupHash?objectKeyFromHash(sourceMetadata.tableMarkupHash):null;
  const text=normalizeText(await webSearchText(env,tableKey,await bodyObject.text(),pdfDocuments));
  projection.documents.push({slot:'body',filename:null,label:text?'网页正文':'通知标题',text});
  projection.documents.sort((left,right)=>left.slot.localeCompare(right.slot,undefined,{numeric:true}));
  projection.skipped.sort((left,right)=>left.slot.localeCompare(right.slot,undefined,{numeric:true}));
  return projection;
}

function normalizeText(value){
  return String(value??'')
    .replace(/\r\n?/g,'\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'')
    .replace(/[ \t]+/g,' ')
    .replace(/ ?\n ?/g,'\n')
    .replace(/\n{3,}/g,'\n\n')
    .trim();
}

function normalizedDay(value){
  if(typeof value!=='string')return null;
  const match=/^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match?match[1]:null;
}

function objectKeyFromHash(hash){
  return `objects/sha256/${hash.slice(0,2)}/${hash}`;
}
