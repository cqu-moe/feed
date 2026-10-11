import {json} from './utils.mjs';
import sources from './sources.json';
import {serveObject,serveSnapshot} from './storage.mjs';
const columns=`a.id,a.title,a.source_id AS sourceId,s.name AS sourceName,a.url,a.published_at AS publishedAt,a.captured_at AS capturedAt,a.status,a.attachment_count AS attachmentCount,a.excerpt`;
export async function apiRoute(request,env){
  const url=new URL(request.url),path=url.pathname;
  if(!['GET','HEAD'].includes(request.method))return json({error:'Method not allowed'},405);
  if(path==='/api/sources'){
    const rows=await env.DB.prepare('SELECT s.*, (SELECT COUNT(*) FROM articles a WHERE a.source_id=s.id) AS articleCount FROM sources s').all();
    return json({sources:sources.map(s=>{const row=rows.results.find(r=>r.id===s.id);return {id:s.id,name:s.name,url:s.url,lastRunAt:row?.last_run_at??null,articleCount:row?.articleCount??0,error:row?.error??null};})});
  }
  if(path==='/api/articles'){
    const q=(url.searchParams.get('q')??'').trim().slice(0,100),source=url.searchParams.get('source')??'';
    const page=Math.min(500,Math.max(1,parseInt(url.searchParams.get('page')??'1')||1)),pageSize=20;
    const where=[],bind=[];
    if(source){if(!sources.some(s=>s.id===source))return json({error:'未知来源'},400);where.push('a.source_id=?');bind.push(source);}
    let join='';
    if(q){
      if([...q].length>=3){join=' JOIN article_search f ON f.id=a.id';where.push('article_search MATCH ?');bind.push('"'+q.replace(/"/g,'""')+'"');}
      else{const like='%'+q.replace(/[\\%_]/g,'\\$&')+'%';where.push("(a.title LIKE ? ESCAPE '\\' OR a.body_text LIKE ? ESCAPE '\\')");bind.push(like,like);}
    }
    const filter=where.length?' WHERE '+where.join(' AND '):'';
    const count=await env.DB.prepare(`SELECT COUNT(*) AS n FROM articles a${join}${filter}`).bind(...bind).first();
    const rows=await env.DB.prepare(`SELECT ${columns} FROM articles a JOIN sources s ON s.id=a.source_id${join}${filter} ORDER BY a.published_at DESC,a.id LIMIT ? OFFSET ?`).bind(...bind,pageSize,(page-1)*pageSize).all();
    return json({articles:rows.results,total:count.n,page,pageSize});
  }
  const detail=/^\/api\/articles\/([a-f0-9]{24})$/.exec(path);
  if(detail){
    const article=await env.DB.prepare(`SELECT ${columns},a.body_text AS bodyText,a.error,a.snapshot_key,a.screenshot_key FROM articles a JOIN sources s ON s.id=a.source_id WHERE a.id=?`).bind(detail[1]).first();
    if(!article)return json({error:'通知不存在'},404);
    const rows=await env.DB.prepare('SELECT id,name,bytes,content_type AS contentType,status,error,filename,role,original_url AS originalUrl FROM attachments WHERE article_id=? ORDER BY id').bind(article.id).all();
    article.bodyHtml=null;article.snapshotUrl=article.snapshot_key?`/api/snapshots/${article.id}`:null;article.screenshotUrl=article.screenshot_key?`/api/screenshots/${article.id}`:null;
    delete article.snapshot_key;delete article.screenshot_key;
    return json({article,attachments:rows.results.map(row=>{const file=row.filename?`/api/files/${article.id}/${row.filename}`:null;return {...row,url:file,downloadUrl:file?file+'?download=1':null};})});
  }
  const file=/^\/api\/files\/([a-f0-9]{24})\/(attachment-\d+\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z|bin))$/.exec(path);
  if(file){
    const row=await env.DB.prepare('SELECT * FROM attachments WHERE article_id=? AND filename=? AND object_key IS NOT NULL').bind(file[1],file[2]).first();
    if(!row)return json({error:'附件尚未存档'},404);
    const pdf=file[2].endsWith('.pdf');
    return serveObject(request,env,row.object_key,{name:row.name,type:pdf?'application/pdf':'application/octet-stream',download:!pdf||url.searchParams.has('download')});
  }
  const snapshot=/^\/api\/(snapshots|screenshots)\/([a-f0-9]{24})$/.exec(path);
  if(snapshot){
    const article=await env.DB.prepare('SELECT id,snapshot_key,screenshot_key FROM articles WHERE id=?').bind(snapshot[2]).first();if(!article)return json({error:'通知不存在'},404);
    return snapshot[1]==='snapshots'?serveSnapshot(env,article):article.screenshot_key?serveObject(request,env,article.screenshot_key,{type:'image/png'}):json({error:'截图尚未存档'},404);
  }
  return json({error:'Not found'},404);
}
