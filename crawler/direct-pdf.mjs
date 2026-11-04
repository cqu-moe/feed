// Chrome hands attachment responses to its downloader and native PDF viewing
// creates a viewer document. Capture the response itself before either happens.
export function pdfResponse(event,origin,frameId){
  if(event.frameId!==frameId||event.responseStatusCode!==200)return false;
  const url=new URL(event.request.url);
  if(url.origin!==origin)return false;
  const headers=new Map(event.responseHeaders?.map(({name,value})=>[name.toLowerCase(),value]));
  const mime=headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  return mime==='application/pdf'||mime==='application/octet-stream'||mime==='application/x-pdf'
    ||/^attachment\b/i.test(headers.get('content-disposition')??'')||/\.pdf$/i.test(url.pathname)||/\.pdf(?:["';\s]|$)/i.test(headers.get('content-disposition')??'');
}

export async function capturePdfResponse(call,requestId){
  const {stream}=await call('Fetch.takeResponseBodyAsStream',{requestId});
  const chunks=[];
  let size=0;
  try{
    while(true){
      const {data,base64Encoded,eof}=await call('IO.read',{handle:stream,size:256*1024});
      const chunk=Buffer.from(data,base64Encoded?'base64':'utf8');
      size+=chunk.length;
      if(size>64*1024*1024)throw new Error('PDF exceeds 64 MiB');
      chunks.push(chunk);
      if(eof)break;
    }
  }finally{await call('IO.close',{handle:stream});}
  const bytes=Buffer.concat(chunks,size);
  if(bytes.subarray(0,5).toString('latin1')!=='%PDF-')throw new Error('Invalid PDF document signature');
  return bytes;
}

export async function directPdfReport({url,bytes},config,signal){
  const filename='attachment-1.pdf',title=config.title||'通知';
  const artifact=(name,buffer,contentType)=>({name,contentType,base64:buffer.toString('base64')});
  const candidate={url,name:/\.pdf$/i.test(title)?title:title+'.pdf',role:'body-pdf'};
  const escaped=title.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'})[c]);
  // A direct PDF has no source HTML. This static snapshot opens the saved
  // original through serveSnapshot's revision-bound, authenticated viewer.
  const html=Buffer.from(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escaped}</title><style>body{margin:0}iframe{display:block;width:100%;height:100vh;border:0}</style><iframe title="已存档的 PDF" data-feed-pdf="${filename}"></iframe></html>`);
  const artifacts=['snapshot.html','offline.html'].map(name=>artifact(name,html,'text/html; charset=utf-8'));
  const saved={name:filename,bytes:bytes.length};
  if(bytes.length>2*1024*1024){
    const target=new URL(config.uploadUrl);
    const response=await fetch(target,{method:'POST',redirect:'error',
      headers:{Origin:target.origin,'X-Grant':config.grant,'X-Filename':filename,'Content-Type':'application/pdf'},
      body:bytes,signal:AbortSignal.any([signal,AbortSignal.timeout(65000)])});
    if(!response.ok||(await response.json()).saved?.bytes!==bytes.length)throw new Error(`PDF archive upload failed (HTTP ${response.status})`);
    saved.uploaded=true;
  }else artifacts.push(artifact(filename,bytes,'application/pdf'));
  const fetchedAt=new Date().toISOString();
  return {bodyRecognized:true,page:{title,url},heading:title,bodyText:'',bodyHtml:'',bodyCapturedAt:fetchedAt,
    attachmentCandidates:[candidate],downloads:[{...candidate,kind:'pdf',contentType:'application/pdf',fetchedAt,originalFile:true,saved}],
    artifacts,errors:[]};
}
