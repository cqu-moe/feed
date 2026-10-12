import {bounded,reserveBudget} from './utils.mjs';
export async function scrape(env,url,options={}){
  await reserveBudget(env,'firecrawl',Number(env.MAX_FIRECRAWL_PER_DAY||120));
  const response=await fetch('https://api.firecrawl.dev/v2/scrape',{
    method:'POST',headers:{'Content-Type':'application/json',...(env.FIRECRAWL_API_KEY?{Authorization:`Bearer ${env.FIRECRAWL_API_KEY}`}:{})},
    body:JSON.stringify({url,proxy:'auto',maxAge:0,timeout:210000,waitFor:2000,...options}),
    signal:AbortSignal.timeout(235000),
  });
  const text=new TextDecoder().decode(await bounded(response,40*1024*1024));
  let result;try{result=JSON.parse(text);}catch{result={error:'Invalid provider response'};}
  if(!response.ok||!result.success){
    const error=new Error(`Firecrawl HTTP ${response.status}: ${String(result.error??'Unsuccessful').slice(0,160)}`);
    error.httpStatus=response.status;
    const header=response.headers.get('Retry-After');
    if(header){
      const delay=/^\d+(\.\d+)?$/.test(header)?Number(header)*1000:Date.parse(header)-Date.now();
      if(Number.isFinite(delay))error.retryAfterMs=Math.max(0,delay);
    }
    throw error;
  }
  if((result.data?.metadata?.statusCode??200)>=400)throw new Error(`Origin HTTP ${result.data.metadata.statusCode}`);
  return result.data;
}
