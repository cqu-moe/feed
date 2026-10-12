const apiBase='https://api.resend.com';
const maxWebhookBytes=256*1024;
const providerTimeoutMs=30_000;
const textEncoder=new TextEncoder();

export function createResendProvider(env,{fetch=globalThis.fetch,now=()=>Date.now()}={}){
  const apiKey=typeof env?.RESEND_API_KEY==='string'?env.RESEND_API_KEY:'';
  const webhookSecret=typeof env?.RESEND_WEBHOOK_SECRET==='string'?env.RESEND_WEBHOOK_SECRET:'';

  async function send(snapshot,{idempotencyKey}={}){
    if(!apiKey)return {status:'deferred',code:'provider_not_configured',retryAfterMs:60_000};
    const payload=sendPayload(snapshot,idempotencyKey);
    let response;
    try{
      response=await fetch(`${apiBase}/emails`,{
        method:'POST',
        headers:{
          authorization:`Bearer ${apiKey}`,
          'content-type':'application/json',
          'idempotency-key':idempotencyKey,
        },
        signal:AbortSignal.timeout(providerTimeoutMs),
        body:payload,
      });
    }catch(error){
      return {status:'unknown',code:error?.name==='AbortError'?'timeout':'network'};
    }
    if(!response.ok)return classifyFailure(response);
    let body;
    try{body=await response.json();}
    catch{return {status:'unknown',code:'invalid_response'};}
    if(typeof body?.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(body.id))
      return {status:'unknown',code:'invalid_response'};
    return {status:'accepted',providerId:body.id};
  }

  async function get(providerId){
    if(typeof providerId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(providerId))
      throw invalidRequest('Invalid mail provider id');
    if(!apiKey)return {status:'unavailable',code:'provider_unavailable'};
    let response;
    try{
      response=await fetch(`${apiBase}/emails/${encodeURIComponent(providerId)}`,{
        headers:{authorization:`Bearer ${apiKey}`},
        signal:AbortSignal.timeout(providerTimeoutMs),
      });
    }catch(error){
      return {status:'unavailable',code:error?.name==='AbortError'?'timeout':'network'};
    }
    if(response.status===404)return {status:'not_found'};
    if(response.status>=500)return {status:'unavailable',code:'server_error'};
    if(!response.ok)return {status:'unavailable',code:'provider_error'};
    let body;
    try{body=await response.json();}
    catch{return {status:'unavailable',code:'invalid_response'};}
    if(body?.id!==providerId||!Array.isArray(body.to)||body.to.length!==1
      ||typeof body.to[0]!=='string'||!body.to[0])
      return {status:'unavailable',code:'invalid_response'};
    const event=body.last_event==='sent'||body.last_event==='accepted'?'accepted'
      :['delivered','bounced','complained'].includes(body.last_event)?body.last_event:'unknown';
    let tags;
    try{tags=tagObject(body.tags);}
    catch{return {status:'unavailable',code:'invalid_response'};}
    return {status:'found',providerId,recipient:body.to[0],event,tags};
  }

  async function verifyWebhook(request){
    if(!webhookSecret)throw providerError('Mail webhook verifier is unavailable',503);
    if(!request||typeof request!=='object'||typeof request.method!=='string')
      throw invalidRequest('Invalid mail webhook request');
    if(request.method.toUpperCase()!=='POST')throw invalidRequest('Invalid mail webhook method');
    const id=request.headers.get('svix-id'),timestamp=request.headers.get('svix-timestamp'),
      signatureHeader=request.headers.get('svix-signature');
    if(typeof id!=='string'||!/^[A-Za-z0-9_.:-]{1,256}$/.test(id)
      ||typeof timestamp!=='string'||!/^\d{10}$/.test(timestamp))
      throw invalidRequest('Invalid mail webhook headers');
    const eventTime=Number(timestamp)*1000;
    const currentTime=currentTimestamp();
    if(!Number.isSafeInteger(currentTime)||!Number.isSafeInteger(eventTime)
      ||Math.abs(currentTime-eventTime)>300_000)
      throw providerError('Mail webhook timestamp is invalid',401);
    if(typeof signatureHeader!=='string'||!signatureHeader)throw invalidRequest('Invalid mail webhook signature header');
    const rawBody=await boundedRequestBody(request);
    if(!await signatureMatches(rawBody,id,timestamp,signatureHeader,webhookSecret))
      throw providerError('Mail webhook signature is invalid',401);
    let event;
    try{event=JSON.parse(rawBody);}
    catch{throw invalidRequest('Invalid mail webhook payload');}
    if(!event||typeof event!=='object'||Array.isArray(event)||typeof event.type!=='string'
      ||!event.data||typeof event.data!=='object'||Array.isArray(event.data))
      throw invalidRequest('Invalid mail webhook payload');
    const occurredAt=Date.parse(event.created_at);
    const data=event.data;
    if(!Number.isFinite(occurredAt)||typeof data.email_id!=='string'
      ||!/^[A-Za-z0-9_-]{1,128}$/.test(data.email_id)
      ||!Array.isArray(data.to)||data.to.length!==1||typeof data.to[0]!=='string'||!data.to[0])
      throw invalidRequest('Invalid mail webhook identity');
    let tags;
    try{tags=webhookTags(data.tags);}
    catch{throw invalidRequest('Invalid mail webhook tags');}
    const type=event.type==='email.sent'?'accepted'
      :['email.delivered','email.bounced','email.complained'].includes(event.type)
        ?event.type.split('.')[1]:'ignored';
    return {id,type,providerId:data.email_id,recipient:data.to[0],tags,occurredAt,rawBody};
  }

  function sendPayload(snapshot,idempotencyKey){
    if(typeof idempotencyKey!=='string'||idempotencyKey.length<1||idempotencyKey.length>256)
      throw invalidRequest('Invalid idempotency key');
    if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot))throw invalidRequest('Invalid mail snapshot');
    for(const key of ['from','to','subject','html','text']){
      if(typeof snapshot[key]!=='string'||!snapshot[key])throw invalidRequest('Invalid mail snapshot');
    }
    if(!Array.isArray(snapshot.tags))throw invalidRequest('Invalid mail tags');
    const tags=snapshot.tags.map(tag=>{
      if(!tag||typeof tag!=='object'||Array.isArray(tag)
        ||typeof tag.name!=='string'||typeof tag.value!=='string')
        throw invalidRequest('Invalid mail tags');
      return {name:tag.name,value:tag.value};
    });
    return JSON.stringify({
      from:snapshot.from,
      to:snapshot.to,
      subject:snapshot.subject,
      html:snapshot.html,
      text:snapshot.text,
      tags,
    });
  }

  function currentTimestamp(){
    const value=now();
    return value instanceof Date?value.getTime():value;
  }

  async function classifyFailure(response){
    if(response.status===429)
      return {status:'deferred',code:'rate_limit_exceeded',retryAfterMs:retryAfterMs(response)};
    if(response.status>=500)return {status:'unknown',code:'server_error'};
    if(response.status<400)return {status:'unknown',code:'unexpected_status'};
    let body;
    try{body=await response.json();}
    catch{body={};}
    const code=safeCode(body?.name??body?.code);
    if(response.status===409&&code==='concurrent_idempotent_requests')
      return {status:'deferred',code,retryAfterMs:retryAfterMs(response)};
    return {status:'rejected',code:code??'request_rejected'};
  }

  function retryAfterMs(response){
    const value=response.headers.get('retry-after');
    if(value===null)return 0;
    const seconds=Number(value);
    if(Number.isSafeInteger(seconds)&&seconds>=0)return Math.min(seconds*1000,2_147_483_647);
    const date=Date.parse(value);
    if(Number.isFinite(date))return Math.max(0,Math.min(date-currentTimestamp(),2_147_483_647));
    return 0;
  }

  function safeCode(value){
    return typeof value==='string'&&/^[a-z0-9_.-]{1,64}$/.test(value)?value:null;
  }

  return {send,get,verifyWebhook};
}

async function boundedRequestBody(request){
  const declaredLength=request.headers.get('content-length');
  if(declaredLength!==null){
    const length=Number(declaredLength);
    if(!Number.isSafeInteger(length)||length<0)throw invalidRequest('Invalid mail webhook body length');
    if(length>maxWebhookBytes)throw providerError('Mail webhook body is too large',413);
  }
  if(!request.body)throw invalidRequest('Invalid mail webhook body');
  const reader=request.body.getReader();
  const chunks=[];
  let received=0;
  try{
    for(;;){
      const {done,value}=await reader.read();
      if(done)break;
      if(!(value instanceof Uint8Array))throw providerError('Mail webhook body is unavailable',503);
      received+=value.length;
      if(received>maxWebhookBytes)throw providerError('Mail webhook body is too large',413);
      chunks.push(value);
    }
  }catch(error){
    await reader.cancel().catch(()=>{});
    if(error?.name==='MailProviderError')throw error;
    throw providerError('Mail webhook body is unavailable',503);
  }
  const body=new Uint8Array(received);
  let offset=0;
  for(const chunk of chunks){
    body.set(chunk,offset);
    offset+=chunk.length;
  }
  try{
    return new TextDecoder('utf-8',{fatal:true}).decode(body);
  }catch{
    throw invalidRequest('Invalid mail webhook body encoding');
  }
}

async function signatureMatches(rawBody,id,timestamp,signatureHeader,webhookSecret){
  let secret;
  try{secret=decodeWebhookSecret(webhookSecret);}
  catch{throw providerError('Mail webhook verifier is unavailable',503);}
  const expected=new Uint8Array(await crypto.subtle.sign('HMAC',await crypto.subtle.importKey(
    'raw',secret,{name:'HMAC',hash:'SHA-256'},false,['sign'],
  ),textEncoder.encode(`${id}.${timestamp}.${rawBody}`)));
  for(const candidate of signatureHeader.split(/\s+/)){
    const [version,value]=candidate.split(',');
    if(version!=='v1'||typeof value!=='string')continue;
    let provided;
    try{provided=decodeBase64(value);}
    catch{continue;}
    if(await fixedTimeEqual(expected,provided))return true;
  }
  return false;
}

function tagObject(value){
  if(!Array.isArray(value))throw new Error('Invalid tags');
  const tags={};
  for(const tag of value){
    if(!tag||typeof tag!=='object'||Array.isArray(tag)||typeof tag.name!=='string'
      ||typeof tag.value!=='string'||Object.hasOwn(tags,tag.name))
      throw new Error('Invalid tags');
    tags[tag.name]=tag.value;
  }
  return tags;
}

function webhookTags(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid tags');
  const tags={};
  for(const [name,tagValue] of Object.entries(value)){
    if(typeof tagValue!=='string')throw new Error('Invalid tags');
    Object.defineProperty(tags,name,{value:tagValue,enumerable:true,writable:true,configurable:true});
  }
  return tags;
}

function decodeWebhookSecret(value){
  if(typeof value!=='string'||!value.startsWith('whsec_'))throw new Error('Invalid webhook secret');
  return decodeBase64(value.slice(6));
}

function decodeBase64(value){
  if(typeof value!=='string'||value.length<4||value.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw new Error('Invalid base64');
  const binary=atob(value);
  return Uint8Array.from(binary,char=>char.charCodeAt(0));
}

function fixedTimeEqual(left,right){
  let difference=left.length^right.length;
  const length=Math.max(left.length,right.length);
  for(let index=0;index<length;index+=1){
    difference|=(left[index]??0)^(right[index]??0);
  }
  return difference===0;
}

function invalidRequest(message){
  const error=new Error(message);
  error.name='MailProviderError';
  error.status=400;
  return error;
}

function providerError(message,status){
  const error=new Error(message);
  error.name='MailProviderError';
  error.status=status;
  return error;
}
