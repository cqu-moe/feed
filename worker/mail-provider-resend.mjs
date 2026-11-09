const apiBase='https://api.resend.com';
const providerTimeoutMs=30_000;

export function createResendProvider(env,{fetch=globalThis.fetch,now=()=>Date.now()}={}){
  const apiKey=typeof env?.RESEND_API_KEY==='string'?env.RESEND_API_KEY:'';

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

  return {send};
}

function invalidRequest(message){
  const error=new Error(message);
  error.name='MailProviderError';
  error.status=400;
  return error;
}
