import {json} from './utils.mjs';
import {createSources} from './sources.mjs';
import {listRevisions,readRevision,revisionArtifact} from './archive-versions.mjs';
import {serveObject,serveSnapshot} from './storage.mjs';

export async function archiveRoute(request,env){
  if(env.ARCHIVE_READS_ENABLED!=='true')return null;
  const url=new URL(request.url),path=url.pathname;
  const history=/^\/api\/articles\/([a-f0-9]{24})\/revisions$/.exec(path);
  if(history)return json({revisions:await listRevisions(env,history[1])});
  const version=/^\/api\/articles\/([a-f0-9]{24})\/revisions\/([a-f0-9]{24})(?:\/(snapshot|screenshot|files\/(attachment-\d+\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z|bin))))?$/.exec(path);
  if(version){
    const [,articleId,revisionId,artifact,filename]=version;
    if(!artifact){const detail=await readRevision(env,articleId,revisionId);return detail?json(detail):json({error:'版本不存在'},404);}
    const object=await revisionArtifact(env,articleId,revisionId,{filename,kind:artifact});
    if(!object)return json({error:'版本产物尚未保存'},404);
    if(object.state!=='ready')return json({error:'版本仍有缺项，尚未开放阅读'},409);
    if(artifact==='snapshot'){
      const files=await env.DB.prepare(`SELECT filename,original_url AS originalUrl FROM revision_requirements WHERE revision_id=?
        AND kind IN ('attachment','body_pdf') AND state='fulfilled'`).bind(revisionId).all();
      return serveSnapshot(env,{id:articleId,snapshot_key:object.objectKey},{files:files.results.map(row=>row.filename),fileReferences:files.results,revisionId});
    }
    const pdf=filename?.endsWith('.pdf');
    return serveObject(request,env,object.objectKey,{name:filename?object.name:undefined,
      type:filename?(pdf?'application/pdf':'application/octet-stream'):'image/png',
      download:Boolean(filename&&(!pdf||url.searchParams.has('download')))});
  }
  const current=/^\/api\/articles\/([a-f0-9]{24})$/.exec(path);
  if(current){
    const article=await env.DB.prepare('SELECT latest_ready_revision_id,latest_observed_revision_id,prefix FROM articles WHERE id=?').bind(current[1]).first();
    if(!article)return json({error:'通知不存在'},404);
    if(article.latest_ready_revision_id)return json(await readRevision(env,current[1],article.latest_ready_revision_id,{current:true}));
    if(article.latest_observed_revision_id)return json(await readRevision(env,current[1],article.latest_observed_revision_id));
    return null;
  }
  if(path==='/api/articles')return versionedList(env,url);
  return null;
}
async function versionedList(env,url){
  const query=(url.searchParams.get('q')??'').trim().slice(0,100),source=url.searchParams.get('source')??'';
  const page=Math.min(500,Math.max(1,parseInt(url.searchParams.get('page')??'1')||1)),pageSize=20;
  const clauses=[],bindings=[];
  if(source){
    const configured=await createSources(env).all();
    if(!configured.some(row=>row.id===source))return json({error:'未知来源'},400);
    clauses.push(env.SOURCE_MANAGEMENT_ENABLED==='true'?'EXISTS(SELECT 1 FROM article_sources src WHERE src.article_id=a.id AND src.source_id=?)':'a.source_id=?');bindings.push(source);
  }
  if(query){
    if([...query].length>=3){
      clauses.push(`(EXISTS(SELECT 1 FROM article_read_search WHERE id=a.id AND article_read_search MATCH ?)
        OR (m.article_id IS NULL AND observed.id IS NULL
          AND EXISTS(SELECT 1 FROM article_search WHERE id=a.id AND article_search MATCH ?)))`);
      const match='"'+query.replace(/"/g,'""')+'"';bindings.push(match,match);
    }else{
      clauses.push(`(COALESCE(m.title,observed.title,a.title) LIKE ? ESCAPE '\\'
        OR (CASE WHEN m.article_id IS NOT NULL THEN m.readable_text
          WHEN observed.id IS NULL THEN a.body_text ELSE '' END LIKE ? ESCAPE '\\'))`);
      const match='%'+query.replace(/[\\%_]/g,'\\$&')+'%';bindings.push(match,match);
    }
  }
  const from=`FROM articles a JOIN sources s ON s.id=a.source_id LEFT JOIN article_read_models m ON m.article_id=a.id
    LEFT JOIN article_revisions r ON r.id=m.revision_id
    LEFT JOIN article_revisions observed ON observed.id=a.latest_observed_revision_id`;
  const where=clauses.length?' WHERE '+clauses.join(' AND '):'';
  const count=await env.DB.prepare(`SELECT COUNT(*) AS n ${from}${where}`).bind(...bindings).first();
  const rows=await env.DB.prepare(`SELECT a.id,COALESCE(m.title,observed.title,a.title) AS title,a.source_id AS sourceId,s.name AS sourceName,a.url,
    NULLIF(COALESCE(r.published_at,observed.published_at,a.published_at),'unknown') AS publishedAt,a.captured_at AS capturedAt,
    COALESCE(r.observed_at,observed.observed_at) AS revisionObservedAt,
    CASE WHEN m.revision_id IS NOT NULL THEN 'complete' WHEN observed.id IS NOT NULL THEN 'partial' ELSE a.status END AS status,
    CASE WHEN m.revision_id IS NULL AND observed.id IS NULL THEN a.attachment_count ELSE (SELECT COUNT(*) FROM revision_requirements q
      WHERE q.revision_id=COALESCE(m.revision_id,observed.id) AND q.kind IN ('attachment','body_pdf')) END AS attachmentCount,
    COALESCE(m.summary,a.excerpt) AS excerpt ${from}${where} ORDER BY publishedAt DESC,a.id LIMIT ? OFFSET ?`)
    .bind(...bindings,pageSize,(page-1)*pageSize).all();
  return json({articles:rows.results.map(({revisionObservedAt,...row})=>({...row,capturedAt:revisionObservedAt===null?row.capturedAt:new Date(revisionObservedAt).toISOString()})),total:count.n,page,pageSize});
}
