import {bounded} from './utils.mjs';
import {handoffOrReleaseSiteExecution} from './site-scheduler.mjs';
import {createTaskRuntime} from './task-runtime.mjs';

function siteIdentity(source){
  const identity=source?.siteId;
  if(typeof identity!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(identity))
    throw new Error('Capture site identity is invalid');
  return `site-${identity}`;
}

export async function scrape(env,url,options={}){
  if(!env.BROWSER?.getByName)throw new Error('Browser container binding unavailable');
  const signal=AbortSignal.timeout(285000);
  const {source,siteAdmission,executionHandoff=true,...request}=options;
  const jobId=crypto.randomUUID();
  const siteId=siteIdentity(source);
  const browser=env.BROWSER.getByName(siteId);
  try{
    const response=await browser.fetch(new Request('https://browser.internal/scrape',{
      method:'POST',
      headers:{'content-type':'application/json','x-feed-browser-job-id':jobId},
      body:JSON.stringify({url,siteId,jobId,...request,...(siteAdmission?{generation:siteAdmission.generation}:{})}),
      signal,
    }));
    const bytes=await bounded(response,40*1024*1024);
    const acceptedJobId=response.headers.get('x-feed-browser-job-id');
    if(acceptedJobId===jobId){
      let stop=executionHandoff,outboxId;
      if(siteAdmission&&executionHandoff){
        const handoff=await handoffOrReleaseSiteExecution(env,siteAdmission);
        outboxId=handoff.outboxId;
        if(outboxId)stop=false;
      }
      await browser.fetch(new Request('https://browser.internal/scrape-complete',{
        method:'POST',body:JSON.stringify({jobId,stop,...(siteAdmission?{generation:siteAdmission.generation}:{})}),
        signal:AbortSignal.timeout(10000),headers:{'content-type':'application/json'},
      })).catch(()=>{});
      if(outboxId)await createTaskRuntime(env).dispatchOutbox(outboxId).catch(()=>false);
    }
    const text=new TextDecoder().decode(bytes);
    let result;
    try{result=JSON.parse(text);}catch{
      if(response.ok)throw Object.assign(new Error('Browser response interrupted'),{code:'browser_transient',retryable:true});
    }
    if(!response.ok||!result?.success){
      // The SDK's pre-execution capacity responses are plaintext. Origin failures
      // arrive in the executor's HTTP 200 envelope with their own status/code.
      const capacity=[429,503].includes(response.status)&&!acceptedJobId;
      const error=new Error(`Browser ${result?.error??`HTTP ${response.status}`}`);
      error.code=capacity?'container_capacity':result?.code??(response.status>=500?'browser_transient':'capture_failed');
      error.httpStatus=result?.httpStatus??response.status;
      error.retryable=result?.retryable===true||capacity||response.status>=500;
      const after=response.headers.get('retry-after');
      if(after){
        const ms=/^\d+(\.\d+)?$/.test(after)?Number(after)*1000:Date.parse(after)-Date.now();
        if(Number.isFinite(ms))error.retryAfterMs=Math.max(0,ms);
      }
      throw error;
    }
    if((result.data?.metadata?.statusCode??200)>=400){
      const status=result.data.metadata.statusCode;
      throw Object.assign(new Error(`Origin HTTP ${status}`),{code:'origin_http',httpStatus:status,retryable:status===429||status>=500});
    }
    return result.data;
  }catch(error){
    if(signal.aborted||error.name==='TypeError'||/network|connection|fetch failed|aborted|timed out|cold start/i.test(error.message)){
      error.retryable=true;error.code??='browser_transient';
    }
    throw error;
  }
}
