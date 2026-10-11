import {Buffer} from 'node:buffer';
import {bridgeHTML} from './bridge-page.mjs';
import {recognizeDigits} from './captcha-ai.mjs';
import {bounded,encoder,equal,json,cleanError,reserveBudget,fileKind} from './utils.mjs';
import sources from './sources.json';
async function mac(env,payload) {
  const key = await crypto.subtle.importKey('raw',encoder.encode(env.BRIDGE_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return Buffer.from(await crypto.subtle.sign('HMAC',key,encoder.encode(payload))).toString('hex');
}
export async function issueGrant(env,source,runId,articleId) {
  const grant={runId,articleId,channel:crypto.randomUUID(),origin:new URL(source.url).origin,expires:Date.now()+300000};
  const payload=Buffer.from(JSON.stringify(grant)).toString('base64url');
  const token=payload+'.'+await mac(env,payload);
  return {...grant,token};
}
async function readGrant(request,env) {
  if(!env.BRIDGE_SECRET)return null;
  const token=new URL(request.url).searchParams.get('grant')??request.headers.get('X-Grant')??'';
  if(token.length>1000)return null;
  const parts=token.split('.'); if(parts.length!==2||!await equal(parts[1],await mac(env,parts[0])))return null;
  try{
    const grant=JSON.parse(Buffer.from(parts[0],'base64url').toString());
    if(!sources.some(s=>new URL(s.url).origin===grant.origin)||!Number.isFinite(grant.expires)||grant.expires<Date.now()||grant.expires>Date.now()+310000||!/^[-a-f0-9]{36}$/.test(grant.runId)||!/^[-a-f0-9]{36}$/.test(grant.channel))return null;
    if(grant.articleId!==undefined&&!/^[a-f0-9]{24}$/.test(grant.articleId))return null;
    return {...grant,token};
  }catch{return null;}
}
export async function bridgeRoute(request,env) {
  const path=new URL(request.url).pathname;
  if(!['/internal/bridge','/internal/solve','/internal/upload'].includes(path))return null;
  const grant=await readGrant(request,env);if(!grant)return json({error:'Invalid temporary capability'},401);
  if(path==='/internal/bridge'&&request.method==='GET')return new Response(bridgeHTML(grant),{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"}});
  if(request.method!=='POST')return json({error:'Method not allowed'},405);
  if(request.headers.get('origin')!==new URL(request.url).origin)return json({error:'Wrong origin'},403);
  if(path==='/internal/upload')return uploadAttachment(request,env,grant);
  if(path!=='/internal/solve')return json({error:'Not found'},404);
  let body;try{body=JSON.parse(new TextDecoder().decode(await bounded(request,180*1024)));}catch{return json({error:'Invalid JSON'},400);}
  if(!Number.isInteger(body.slot)||body.slot<0||body.slot>=16||!['image/jpeg','image/png'].includes(body.mime)||typeof body.image!=='string'||body.image.length>175000||!/^[-A-Za-z0-9+/=]+$/.test(body.image))return json({error:'Invalid image'},400);
  const bytes=Buffer.from(body.image,'base64');
  if(bytes.length>128*1024||!(bytes[0]===255&&bytes[1]===216||bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a'))return json({error:'Invalid image'},400);
  const inserted=await env.DB.prepare('INSERT OR IGNORE INTO ocr_slots(run_id,slot,created_at) VALUES (?,?,?) RETURNING run_id').bind(grant.runId,body.slot,new Date().toISOString()).first();
  if(!inserted){const row=await env.DB.prepare('SELECT result FROM ocr_slots WHERE run_id=? AND slot=?').bind(grant.runId,body.slot).first();return row?.result?json(JSON.parse(row.result)):json({error:'OCR running'},409);}
  const result={};const started=Date.now();
  try{
    await reserveBudget(env,'ocr',Number(env.MAX_OCR_PER_DAY||100));
    result.digits=await recognizeDigits({run:async(...args)=>{const value=await env.AI.run(...args);result.usage=value.usage;return value;}},bytes,body.mime);
  }catch(error){result.error=cleanError(error);}
  result.aiMs=Date.now()-started;
  await env.DB.prepare('UPDATE ocr_slots SET result=? WHERE run_id=? AND slot=?').bind(JSON.stringify(result),grant.runId,body.slot).run();
  return json(result,result.error?502:200);
}

async function uploadAttachment(request,env,grant){
  const name=request.headers.get('X-Filename')??'',size=Number(request.headers.get('Content-Length'));
  if(!grant.articleId||!/^attachment-[1-8]\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|bin)$/.test(name)||!Number.isSafeInteger(size)||size<8||size>64*1024*1024||!request.body)return json({error:'Invalid bounded upload'},400);
  const day=new Date().toISOString().slice(0,10);
  await env.DB.prepare("INSERT OR IGNORE INTO usage(day,kind,used) VALUES (?,'archive_bytes',0)").bind(day).run();
  const budget=await env.DB.prepare("UPDATE usage SET used=used+? WHERE day=? AND kind='archive_bytes' AND used+?<=? RETURNING used").bind(size,day,size,Number(env.MAX_UPLOAD_BYTES_PER_DAY||268435456)).first();
  if(!budget)return json({error:'Daily upload budget reached'},429);
  const key=`articles/${grant.articleId}/${grant.runId}/${name}`,manifestKey=key+'.upload.json';
  const prior=await env.ARCHIVE.get(manifestKey);if(prior)return json({saved:await prior.json()});
  const digest=new crypto.DigestStream('SHA-256'),hashWriter=digest.getWriter();
  const fixed=new FixedLengthStream(size),sink=fixed.writable.getWriter();
  const mime=name.endsWith('.pdf')?'application/pdf':'application/octet-stream';
  const storage=env.ARCHIVE.put(key,fixed.readable,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:mime}});
  let seen=0,signature=[];
  const pump=(async()=>{
    const reader=request.body.getReader();
    try{
      while(true){const {value,done}=await reader.read();if(done)break;seen+=value.length;if(seen>size)throw new Error('Upload length exceeded');
        if(signature.length<8){signature.push(...value.subarray(0,8-signature.length));if(signature.length===8&&!fileKind(new Uint8Array(signature)))throw new Error('Invalid file signature');}
        await Promise.all([hashWriter.write(value),sink.write(value)]);
      }
      if(seen!==size)throw new Error('Incomplete upload');await Promise.all([hashWriter.close(),sink.close()]);
    }catch(error){await reader.cancel().catch(()=>{});await Promise.allSettled([hashWriter.abort(error),sink.abort(error)]);throw error;}
  })();
  try{
    const [object,,hash]=await Promise.all([storage,pump,digest.digest]);
    if(!object)return json({error:'Upload already in progress'},409);
    const saved={key,name,bytes:seen,sha256:Buffer.from(hash).toString('hex'),contentType:mime};
    await env.ARCHIVE.put(manifestKey,JSON.stringify(saved),{httpMetadata:{contentType:'application/json'}});
    return json({saved});
  }catch(error){return json({error:cleanError(error)},400);}
}
