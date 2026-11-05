import {json} from './utils.mjs';
import {createSources} from './sources.mjs';
import {noticeFilters,noticeWhere} from './bailian-filters.mjs';
import {listRevisions,readRevision,revisionArtifact} from './archive-versions.mjs';
import {serveObject,serveSnapshot} from './storage.mjs';
import {readingTitleSql} from './reading.mjs';

export async function archiveRoute(request,env,listFilters){
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
    // A verified snapshot is usable while an unrelated attachment or OCR is pending.
    const snapshotPart=object.bytes>0&&(artifact==='snapshot'||(object.kind==='body_pdf'&&filename?.endsWith('.pdf')));
    if(!object.readable&&!snapshotPart)return json({error:'版本仍有缺项，尚未开放阅读'},409);
    if(artifact==='snapshot'){
      const files=await env.DB.prepare(`SELECT filename,original_url AS originalUrl FROM revision_requirements WHERE revision_id=?
        AND (kind='body_pdf' OR (kind='attachment' AND ?=1)) AND state='fulfilled'`).bind(revisionId,object.readable).all();
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
  if(path==='/api/articles')return versionedList(env,url,listFilters);
  return null;
}
const publishedDay="NULLIF(COALESCE(r.published_at,observed.published_at,a.published_at),'unknown')";
const storedTitle='COALESCE(m.title,observed.title,a.title)';
const title=readingTitleSql(storedTitle,'a.title','COALESCE(r.observed_at,observed.observed_at)');

async function versionedList(env,url,filters){
  const query=(url.searchParams.get('q')??'').trim().slice(0,100);
  const page=Math.min(500,Math.max(1,parseInt(url.searchParams.get('page')??'1')||1));
  filters??=await noticeFilters(url.searchParams,await createSources(env).all());
  if(filters.error)return json({error:filters.error},400);
  const {clauses,bindings}=noticeWhere(filters,publishedDay,env.SOURCE_MANAGEMENT_ENABLED==='true');
  if(query){
    if([...query].length>=3){
      clauses.push(`(EXISTS(SELECT 1 FROM article_read_search WHERE id=a.id AND article_read_search MATCH ?)
        OR (${title}<>${storedTitle} AND ${title} LIKE ? ESCAPE '\\')
        OR (m.article_id IS NULL AND observed.id IS NULL
          AND EXISTS(SELECT 1 FROM article_search WHERE id=a.id AND article_search MATCH ?)))`);
      const match='"'+query.replace(/"/g,'""')+'"';bindings.push(match,'%'+query.replace(/[\\%_]/g,'\\$&')+'%',match);
    }else{
      clauses.push(`(${title} LIKE ? ESCAPE '\\'
        OR (CASE WHEN m.article_id IS NOT NULL THEN m.readable_text
          WHEN observed.id IS NULL THEN a.body_text ELSE '' END LIKE ? ESCAPE '\\'))`);
      const match='%'+query.replace(/[\\%_]/g,'\\$&')+'%';bindings.push(match,match);
    }
  }
  return json(await articleCards(env,clauses,bindings,page,true));
}

// The archive list and related search must present the same title/date/reading identity.
export async function relatedArticleCards(env,filters,ids){
  if(!ids.length)return [];
  const {clauses,bindings}=noticeWhere(filters,publishedDay,env.SOURCE_MANAGEMENT_ENABLED==='true');
  clauses.push('a.id IN (SELECT value FROM json_each(?))');
  bindings.push(JSON.stringify(ids));
  clauses.push("(m.revision_id IS NOT NULL OR (observed.id IS NULL AND a.status='complete'))");
  return (await articleCards(env,clauses,bindings,1,false)).articles;
}

async function articleCards(env,clauses,bindings,page,includeCount){
  const pageSize=20;
  const from=`FROM articles a JOIN sources s ON s.id=a.source_id LEFT JOIN article_read_models m ON m.article_id=a.id
    LEFT JOIN article_revisions r ON r.id=m.revision_id
    LEFT JOIN article_revisions observed ON observed.id=a.latest_observed_revision_id`;
  const where=clauses.length?' WHERE '+clauses.join(' AND '):'';
  const count=includeCount?await env.DB.prepare(`SELECT COUNT(*) AS n ${from}${where}`).bind(...bindings).first():null;
  const rows=await env.DB.prepare(`SELECT a.id,${title} AS title,a.source_id AS sourceId,s.name AS sourceName,a.url,
    ${publishedDay} AS publishedAt,a.captured_at AS capturedAt,
    COALESCE(r.observed_at,observed.observed_at) AS revisionObservedAt,
    CASE WHEN m.revision_id IS NOT NULL THEN 'complete' WHEN observed.id IS NOT NULL THEN 'partial' ELSE a.status END AS status,
    CASE WHEN m.revision_id IS NULL AND observed.id IS NULL THEN a.attachment_count ELSE (SELECT COUNT(*) FROM revision_requirements q
      WHERE q.revision_id=COALESCE(m.revision_id,observed.id) AND q.kind IN ('attachment','body_pdf')) END AS attachmentCount,
    COALESCE(m.summary,a.excerpt) AS excerpt ${from}${where} ORDER BY publishedAt DESC,a.id LIMIT ? OFFSET ?`)
    .bind(...bindings,includeCount?pageSize:100,(page-1)*pageSize).all();
  return {articles:rows.results.map(({revisionObservedAt,...row})=>({...row,capturedAt:revisionObservedAt===null?row.capturedAt:new Date(revisionObservedAt).toISOString()})),total:count?.n??rows.results.length,page,pageSize};
}
