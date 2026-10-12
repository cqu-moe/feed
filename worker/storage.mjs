import {json} from './utils.mjs';
export function parseRange(header,size){
  if(!header)return null;
  const match=/^bytes=(\d*)-(\d*)$/.exec(header);if(!match||(!match[1]&&!match[2]))throw new Error('range');
  let start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2]));
  let end=match[1]?(match[2]?Number(match[2]):size-1):size-1;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start)throw new Error('range');
  end=Math.min(end,size-1);return {offset:start,length:end-start+1};
}
export async function serveObject(request,env,key,{name,type,download=false}={}){
  const head=await env.ARCHIVE.head(key);if(!head)return json({error:'文件暂不可用'},404);
  const headers=new Headers({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes','ETag':head.httpEtag});
  let range;
  try{range=parseRange(request.headers.get('if-range')&&request.headers.get('if-range')!==head.httpEtag?null:request.headers.get('range'),head.size);}
  catch{return new Response(null,{status:416,headers:{...Object.fromEntries(headers),'Content-Range':`bytes */${head.size}`}});}
  headers.set('Content-Type',type||head.httpMetadata?.contentType||'application/octet-stream');
  headers.set('Content-Length',String(range?.length??head.size));
  if(name)headers.set('Content-Disposition',`${download?'attachment':'inline'}; filename="file"; filename*=UTF-8''${encodeURIComponent(name).replace(/'/g,'%27')}`);
  if(range)headers.set('Content-Range',`bytes ${range.offset}-${range.offset+range.length-1}/${head.size}`);
  const object=request.method==='HEAD'?null:await env.ARCHIVE.get(key,range?{range}:undefined);
  return new Response(object?.body??null,{status:range?206:200,headers});
}
export async function serveSnapshot(env,article,{files:versionFiles=null,fileReferences=[],revisionId=null}={}){
  if(!article.snapshot_key)return json({error:'原貌存档尚未完成'},404);
  const object=await env.ARCHIVE.get(article.snapshot_key);if(!object)return json({error:'原貌存档不存在'},404);
  const files=versionFiles??(await env.DB.prepare("SELECT filename FROM attachments WHERE article_id=? AND object_key IS NOT NULL").bind(article.id).all()).results.map(row=>row.filename);
  const pdfs=new Set(files.filter(file=>file?.endsWith('.pdf')));
  const rewriter=new HTMLRewriter();
  for(const selector of ['script','base','meta','object','embed','applet','link[rel="preload"]','link[rel="prefetch"]'])rewriter.on(selector,{element(e){e.remove();}});
  rewriter
    .on('form',{element(e){e.removeAndKeepContent();}})
    .on('*',{element(e){for(const [key]of [...e.attributes])if(/^on/i.test(key)||['srcdoc','ping','autofocus','formaction'].includes(key))e.removeAttribute(key);}})
    .on('iframe',{element(e){const file=e.getAttribute('data-feed-pdf');if(!pdfs.has(file)){e.remove();return;}e.removeAttribute('sandbox');e.setAttribute('src',revisionId?`/reader/${article.id}/revisions/${revisionId}/${file}`:`/reader/${article.id}/${file}`);e.setAttribute('title','已存档的 PDF');}})
    .on('a',{element(e){
      const href=e.getAttribute('href')??'';
      if(/^\s*(javascript|data|vbscript):/i.test(href))e.removeAttribute('href');
      else if(revisionId){
        const match=new RegExp(`^/api/files/${article.id}/([^?#]+)(?:[?#]|$)`).exec(href);
        const original=fileReferences.find(row=>row.originalUrl===href.replace(/&amp;/g,'&'));
        const filename=match&&files.includes(match[1])?match[1]:original?.filename;
        if(filename)e.setAttribute('href',`/api/articles/${article.id}/revisions/${revisionId}/files/${filename}?download=1`);
      }
      e.setAttribute('rel','noopener noreferrer');
    }});
  return rewriter.transform(new Response(object.body,{headers:{
    'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',
    // Only our authenticated, self-hosted PDF.js route is embedded. Source
    // scripts/forms/network stay restricted; PDF bytes still come from private R2.
    'Content-Security-Policy':"default-src 'none'; script-src 'none'; style-src 'unsafe-inline' data:; img-src data:; font-src data:; frame-src 'self'; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
  }}));
}
