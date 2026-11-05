import {articleContent,fileTarget} from '../crawler/article-content.mjs';

export function articlePageOptions(input){
  return {
    readiness:{articleTitle:input.title??null},
    actions:[{type:'executeJavascript',script:`var __name=value=>value; (${captchaPage.toString()})(${JSON.stringify(input)},${articleContent.toString()},${fileTarget.toString()})`}],
  };
}

// Runs in the original source browser page, including file fetches.
async function captchaPage(input,findContent,fileTarget) {
  const readyStarted=Date.now();
  let content=findContent(input.title,fileTarget);
  while(!content&&Date.now()-readyStarted<10000){
    await new Promise(resolve=>setTimeout(resolve,200));
    content=findContent(input.title,fileTarget);
  }
  const report = { page: { title:document.title, url:location.href }, downloads:[], artifacts:[], errors:[], bridge:{}, policyViolations:[] };
  report.pageReadyWaitMs=Date.now()-readyStarted;
  const start = Date.now();
  const clean = e => String(e?.message ?? e).replace(/https?:\/\/\S+/g,'[URL omitted]').slice(0,220);
  const to64 = bytes => { let s=''; for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s); };
  const kind = bytes => { const h=[...bytes.subarray(0,8)].map(x=>x.toString(16).padStart(2,'0')).join('');return h.startsWith('255044462d')?'pdf':h==='d0cf11e0a1b11ae1'?'ole':(h.startsWith('504b0304')||h.startsWith('504b0506'))?'zip':h.startsWith('526172211a07')?'rar':h.startsWith('377abcaf271c')?'7z':null; };
  async function read(url) {
    const target=new URL(url,location.href);if(target.origin!==location.origin)throw new Error('Unexpected download origin');
    const r=await fetch(target,{credentials:'include',signal:AbortSignal.timeout(45000)});
    if(new URL(r.url).origin!==location.origin)throw new Error('Cross-origin response');
    const reader=r.body.getReader(),chunks=[];let size=0;
    while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>64*1024*1024){await reader.cancel();throw new Error('File exceeds 64 MiB');}chunks.push(value);}
    const bytes=new Uint8Array(size);let off=0;for(const chunk of chunks){bytes.set(chunk,off);off+=chunk.length;}
    return {status:r.status,type:r.headers.get('content-type')??'',bytes,kind:kind(bytes),headers:{disposition:r.headers.get('content-disposition'),csp:r.headers.get('content-security-policy')}};
  }
  function inspectDownload(response,expectsPdf){
    if(response.status!==200)return {outcome:'http_error',error:`File download returned HTTP ${response.status}`};
    if(response.kind){
      if(expectsPdf&&response.kind!=='pdf')return {outcome:'wrong_format',error:'Expected PDF document'};
      return {outcome:'file'};
    }
    // Inspect only a bounded prefix of an unrecognized file. A server can label
    // an HTML error as application/pdf, or a verification form as plain text.
    const html=new TextDecoder().decode(response.bytes.subarray(0,128*1024));
    if(!/html/i.test(response.type)&&!/^\s*</.test(html))return {outcome:'unknown_format',error:'Unrecognized file response'};
    const doc=new DOMParser().parseFromString(html,'text/html');
    const field=doc.querySelector('input[name="codeValue"]');
    if(!field)return {outcome:'html',error:'Source returned HTML instead of a file'};
    const generated=/["'](\/system\/resource\/js\/filedownload\/createimage\.jsp)\?randnum=/.exec(html)?.[1];
    const imagePath=(field.form??doc).querySelector('img[src]')?.getAttribute('src')||(generated&&`${generated}?randnum=${Date.now()}`);
    return {outcome:'captcha',imagePath};
  }
  function save(name,data,contentType){const bytes=typeof data==='string'?new TextEncoder().encode(data):data;if(bytes.length>8*1024*1024)throw new Error('Artifact cap');report.artifacts.push({name,contentType,base64:to64(bytes)});return{name,bytes:bytes.length};}
  const policy=e=>report.policyViolations.push({directive:e.effectiveDirective,blockedOrigin:(()=>{try{return new URL(e.blockedURI).origin;}catch{return e.blockedURI;}})()});
  document.addEventListener('securitypolicyviolation',policy);
  let popup, listener;
  const pending=new Map();
  try {
    report.bodyRecognized=false;
    if(!content)return report;
    report.bodyText = content.innerText.trim();
    report.bodyHtml = content.innerHTML;
    report.bodyCapturedAt = new Date().toISOString();
    report.heading = document.querySelector('h1, .title')?.innerText?.trim() || input.title || document.title;
    report.dateText = document.querySelector('meta[name=\"PubDate\"]')?.content || document.body.innerText.slice(0,4000);
    const candidates=[],pdfUrls=new Set();
    for(const a of document.querySelectorAll('a[href],iframe[src],embed[src],object[data]')){
      try{
        const url=fileTarget(a);if(!url)continue;
        const role=a.tagName==='A'?'attachment':'body-pdf';
        if(role==='body-pdf'||/^application\/pdf(?:;|$)/i.test(a.type??a.getAttribute('type')??'')||
          /\.pdf$/i.test(url.pathname)||/\.pdf$/i.test((a.innerText||a.getAttribute('title')||'').trim()))pdfUrls.add(url.href);
        const existing=candidates.find(x=>x.url===url.href);
        if(existing){if(role==='body-pdf')existing.role=role;continue;}
        candidates.push({url:url.href,name:a.innerText?.trim()||a.getAttribute('title')||decodeURIComponent(url.pathname.split('/').pop())||'附件',role});
      }catch{}
    }
    // Some notices consist solely of a download link; substantive HTML plus
    // a PDF remains a web notice with an ordinary attachment.
    if(candidates.length===1&&candidates[0].role==='attachment'&&content!==document.body){
      const links=[...content.querySelectorAll('a[href]')];
      if(links.length===1&&fileTarget(links[0])?.href===candidates[0].url&&
        [links[0].getAttribute('type'),candidates[0].name,candidates[0].url].some(v=>/\.pdf(?:$|[?#])|^application\/pdf$/i.test(v??''))&&
        report.bodyText.trim()===links[0].innerText.trim())candidates[0].role='body-pdf';
    }
    report.attachmentCandidates=candidates;report.attachmentsDiscovered=candidates.length;
    report.bodyRecognized=true;
    let readyResolve;
    const ready=new Promise(resolve=>{readyResolve=resolve;});
    listener=event=>{if(event.origin!==input.bridgeOrigin||event.source!==popup||event.data?.channel!==input.channel)return;if(event.data.type==='ready')readyResolve(event.data);if(event.data.type==='result')pending.get(event.data.slot)?.(event.data);};
    window.addEventListener('message',listener);
    async function openBridge(){
    if(popup)return;
    popup=window.open(input.bridgeURL,`ocr_${input.channel}`,'popup,width=360,height=240');
    report.bridge.opened=!!popup;
    if(!popup)throw new Error('Auxiliary window was blocked');
    let readyTimer;
    const handshake=await Promise.race([ready,new Promise(resolve=>{readyTimer=setTimeout(()=>resolve(null),18000);})]);
    clearTimeout(readyTimer);report.bridge.ready=!!handshake;report.bridge.hasOpener=handshake?.hasOpener??false;
    if(!handshake)throw new Error('Auxiliary window handshake timed out');
    }
    async function solve(image,slot){
      await openBridge();
      let timer;const answerPromise=new Promise(resolve=>{pending.set(slot,resolve);timer=setTimeout(()=>resolve({error:'AI bridge timeout'}),50000);});
      popup.postMessage({channel:input.channel,type:'solve',slot,image:to64(image.bytes),mime:image.type.split(';')[0].trim()},input.bridgeOrigin);
      const answer=await answerPromise;clearTimeout(timer);pending.delete(slot);
      if(answer.error||!/^\d{4}$/.test(answer.digits??''))throw new Error(answer.error??'Invalid OCR response');return answer;
    }
    async function upload(name,bytes){
      await openBridge();
      const slot='upload-'+name;let timer;
      const promise=new Promise(resolve=>{pending.set(slot,resolve);timer=setTimeout(()=>resolve({error:'Cloud upload timeout'}),65000);});
      popup.postMessage({channel:input.channel,type:'upload',slot,name,bytes},input.bridgeOrigin,[bytes.buffer]);
      const answer=await promise;clearTimeout(timer);pending.delete(slot);
      if(answer.error||!answer.saved)throw new Error(answer.error||'Upload failed');
      return {name,bytes:answer.saved.bytes,uploaded:true};
    }
    for(let index=0;index<Math.min(candidates.length,8);index++){
      const item=candidates[index],row={...item,attemptCount:0,responses:[]};report.downloads.push(row);
      try{
        let url=new URL(item.url);
        while(true){
          const response=await read(url);
          const {outcome,error,imagePath}=inspectDownload(response,pdfUrls.has(item.url));
          row.responses.push({status:response.status,outcome});
          row.fetchedAt=new Date().toISOString();
          row.status=response.status;row.kind=response.kind;row.bytes=response.bytes.length;
          row.contentType=response.type;row.contentDisposition=response.headers.disposition;
          row.originalFile=outcome==='file';
          if(row.originalFile){
            const ext=response.kind==='pdf'?'pdf':/\.(docx?|xlsx?|pptx?|zip|rar|7z)$/i.exec(item.name)?.[1]?.toLowerCase()??'bin';
            const name=`attachment-${index+1}.${ext}`;
            row.saved=response.bytes.length>2*1024*1024?await upload(name,response.bytes):save(name,response.bytes,response.type);
            break;
          }
          if(outcome!=='captcha'){row.error=error;break;}
          if(row.attemptCount===2){row.error='Source still requires CAPTCHA after 2 submissions';break;}
          if(!imagePath)throw new Error('CAPTCHA image endpoint missing');
          const image=await read(new URL(imagePath,item.url));
          if(image.status!==200||!image.type.startsWith('image/')||!image.bytes.length||image.bytes.length>128*1024)throw new Error('Invalid CAPTCHA image response');
          const answer=await solve(image,index*2+row.attemptCount);
          url.searchParams.set('codeValue',answer.digits);
          row.attemptCount++;
        }
      }catch(e){row.error=clean(e);}
    }
  }catch(e){report.errors.push(clean(e));}
  finally{
    try{popup?.close();report.bridge.closed=popup?popup.closed:null;}catch{report.bridge.closed=false;}
    if(listener)window.removeEventListener('message',listener);document.removeEventListener('securitypolicyviolation',policy);
  }
  if(report.bodyRecognized){
    const replacements=[];
    try{
      for(const f of document.querySelectorAll('iframe[src],embed[src],object[data]')) {
        try {
          const url=fileTarget(f);if(!url)continue;
          const match=report.downloads.find(d=>d.saved&&d.kind==='pdf'&&d.url===url.href);
          if(match){
            const frame=document.createElement('iframe');
            frame.setAttribute('data-feed-pdf',match.saved.name);
            frame.setAttribute('title','已存档的 PDF');
            frame.style.cssText=f.style.cssText;
            frame.width=f.getAttribute('width')||String(Math.round(f.getBoundingClientRect().width)||700);
            frame.height=f.getAttribute('height')||String(Math.round(f.getBoundingClientRect().height)||700);
            frame.src='about:blank'; f.replaceWith(frame); replacements.push([frame,f]);
          }
        }catch{}
      }
      let doc;
      try{
        (0,eval)(input.bundle);
        const snapshot=await singlefile.getPageData(input.options);
        if(!snapshot.content?.trim())throw new Error('Empty HTML snapshot');
        report.snapshot=save('snapshot.html',snapshot.content,'text/html; charset=utf-8');
        doc=new DOMParser().parseFromString(snapshot.content,'text/html');
      }catch(error){
        // Keep the actual rendered document even if an external resource or
        // SingleFile failed. The protected snapshot route also strips scripts.
        report.errors.push('网页资源未完整打包：'+clean(error));
        doc=new DOMParser().parseFromString(document.documentElement.outerHTML,'text/html');
        const note=doc.createElement('p');
        note.textContent='采集时已保存网页结构，部分图片或样式未能离线保存。';
        doc.body.prepend(note);
      }
      let rewritten=0;
      for(const a of doc.querySelectorAll('a[href]')){
        let url;try{url=new URL(a.getAttribute('href'),location.href);}catch{continue;}
        const match=report.downloads.find(d=>d.saved&&d.url===url.href);
        if(match){a.setAttribute('href',`/api/files/${input.id}/${match.saved.name}?download=1`);a.removeAttribute('onclick');a.removeAttribute('target');rewritten++;}
      }
      for(const f of doc.querySelectorAll('[data-feed-pdf]')){f.removeAttribute('srcdoc');f.setAttribute('src',`/api/files/${input.id}/${f.getAttribute('data-feed-pdf')}`);}
      const frames=[...document.querySelectorAll('iframe[src],embed[src],object[data]')];
      report.pdfFrames=frames.map((f,index)=>{let url;try{url=new URL(f.src||f.data,location.href);}catch{return null;}if(!url.pathname.endsWith('.pdf'))return null;return {index,url:url.href,width:f.getBoundingClientRect().width,height:f.getBoundingClientRect().height};}).filter(Boolean);
      doc.querySelectorAll('base').forEach(e=>e.remove());report.offline=save('offline.html','<!doctype html>\n'+doc.documentElement.outerHTML,'text/html; charset=utf-8');report.attachmentLinksRewritten=rewritten;
    }catch(e){report.errors.push(clean(e));}
    finally{for(const [frame,original] of replacements)frame.replaceWith(original);}
  }
  report.durationMs=Date.now()-start;
  return report;
}
