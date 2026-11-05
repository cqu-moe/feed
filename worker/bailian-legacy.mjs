import {appendSearchPdf,webSearchText} from './bailian-evidence.mjs';

export async function loadLegacySearchNotice(env,articleId){
  const a=await env.DB.prepare(`SELECT a.*,s.site_id AS siteId FROM articles a JOIN sources s ON s.id=a.source_id WHERE a.id=?
    AND a.status='complete' AND a.latest_observed_revision_id IS NULL AND a.latest_ready_revision_id IS NULL`).bind(articleId).first();
  if(!a)return null;
  const {results:memberships}=await env.DB.prepare(`SELECT site_id AS siteId,id AS sourceId FROM sources
    WHERE id=? OR id IN (SELECT source_id FROM article_sources WHERE article_id=?) ORDER BY id`).bind(a.source_id,articleId).all();
  const p={articleId,revisionId:null,title:a.title,publishedDay:a.published_at==='unknown'?null:a.published_at.slice(0,10),memberships,documents:[],skipped:[]};
  let ocr;
  if(a.ocr_result_key){
    const object=await env.ARCHIVE.get(a.ocr_result_key);
    if(!object)throw new Error('Missing current OCR');
    ocr=await object.json();
  }
  const {results:files}=await env.DB.prepare(`SELECT id,filename,name,role,sha256 AS objectHash,object_key AS objectKey,bytes FROM attachments
    WHERE article_id=? ORDER BY (role='body-pdf') DESC,id`).bind(articleId).all();
  const seen=new Set();
  for(const f of files){
    const slot='attachment:'+f.id,identity=f.objectHash||f.objectKey;
    if(identity&&seen.has(identity)){p.skipped.push({slot,reason:'duplicate_original',blocked:false});continue;}
    if(identity)seen.add(identity);
    const known=ocr?.pages?.filter(page=>page.filename===f.filename).map(page=>({number:page.page,text:page.markdown||page.text}));
    await appendSearchPdf(env,p,{...f,slot,kind:f.role==='body-pdf'?'body_pdf':'attachment'},known?.length?known:undefined);
  }
  const text=await webSearchText(env,a.snapshot_key,ocr?.htmlText??a.body_text,p.documents);
  p.documents.unshift({slot:'body',filename:null,label:text?'网页正文':'通知标题',text});
  return p;
}
