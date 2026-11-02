import {bounded} from './utils.mjs';

function siteIdentity(source){
  const identity=source?.siteId;
  if(typeof identity!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(identity))
    throw new Error('Capture site identity is invalid');
  return `site-${identity}`;
}

export async function scrape(env,url,options={}){
  if(!env.BROWSER?.getByName)throw new Error('Browser container binding unavailable');
  const signal=AbortSignal.timeout(285000);
  const {source,...request}=options;
  const jobId=crypto.randomUUID();
  const siteId=siteIdentity(source);
  const browser=env.BROWSER.getByName(siteId);
  try{
    const response=await browser.fetch(new Request('https://browser.internal/scrape',{
      method:'POST',
      headers:{'content-type':'application/json','x-feed-browser-job-id':jobId},
      body:JSON.stringify({url,siteId,jobId,...request}),
      signal,
    }));
    const bytes=await bounded(response,40*1024*1024);
    const acceptedJobId=response.headers.get('x-feed-browser-job-id');
    if(acceptedJobId===jobId){
      await browser.fetch(new Request('https://browser.internal/scrape-complete',{
        method:'POST',
        body:JSON.stringify({jobId}),
        signal:AbortSignal.timeout(10000),
        headers:{'content-type':'application/json','x-feed-browser-site-id':siteId},
      })).catch(()=>{});
    }
    const text=new TextDecoder().decode(bytes);
    let result;
    try{result=JSON.parse(text);}
    catch{throw Object.assign(new Error('Browser response interrupted'),{retryable:true});}
    if(!response.ok||!result.success){
      const error=new Error(`Browser ${result.error??`HTTP ${response.status}`}`);
      error.code=result.code;
      error.httpStatus=result.httpStatus??response.status;
      error.retryable=result.retryable===true||response.status===429||response.status>=500;
      const after=response.headers.get('retry-after');
      if(after){
        const ms=/^\d+(\.\d+)?$/.test(after)?Number(after)*1000:Date.parse(after)-Date.now();
        if(Number.isFinite(ms))error.retryAfterMs=Math.max(0,ms);
      }
      throw error;
    }
    if((result.data?.metadata?.statusCode??200)>=400)
      throw new Error(`Origin HTTP ${result.data.metadata.statusCode}`);
    return result.data;
  }catch(error){
    if(signal.aborted||error.name==='TypeError'||/network|connection|fetch failed|aborted|timed out/i.test(error.message)){
      error.retryable=true;error.code??='browser_transient';
    }
    throw error;
  }
}
