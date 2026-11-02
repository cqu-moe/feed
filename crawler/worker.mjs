import {Container} from '@cloudflare/containers';

function validate(job){
  const url=new URL(job?.url);
  if(url.protocol!=='https:'||url.port||url.username||url.password
    ||!(url.hostname==='cqu.edu.cn'||url.hostname.endsWith('.cqu.edu.cn')))
    throw new Error('Only public CQU HTTPS sources are allowed');
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(job?.siteId??''))
    throw new Error('Explicit site identity is required');
  if(!Array.isArray(job.actions)||job.actions.length!==1
    ||job.actions[0]?.type!=='executeJavascript'||typeof job.actions[0].script!=='string')
    throw new Error('One bounded page action is required');
  if(!/^[0-9a-f-]{36}$/i.test(job?.jobId??''))
    throw new Error('Scrape job identity is required');
  if(job?.generation!==undefined&&(!Number.isSafeInteger(job.generation)||job.generation<1))
    throw new Error('Scrape generation is invalid');
}

export class FeedBrowser extends Container{
  defaultPort=8080;
  sleepAfter='1s';
  startingJobs=new Set;
  activeJobs=new Set;
  generation=0;
  stopRequested=false;

  async fetch(request){
    const path=new URL(request.url).pathname;
    if(path==='/scrape-complete'){
      if(request.method!=='POST')return new Response('Method not allowed',{status:405});
      let completion;
      try{completion=await request.json();}
      catch{return new Response('Invalid completion',{status:400});}
      return Response.json(await this.completeScrape(completion));
    }

    if(path!=='/scrape')return new Response('Not found',{status:404});
    if(request.method!=='POST')return new Response('Method not allowed',{status:405});
    let job;
    try{job=await request.json();validate(job);}
    catch{return new Response('Invalid scrape request',{status:400});}
    const jobId=job.jobId;
    request=new Request(request.url,{
      method:'POST',headers:{'content-type':'application/json','x-feed-browser-job-id':jobId},
      body:JSON.stringify(job),signal:request.signal,
    });
    if(this.stopRequested)
      return Response.json({success:false,error:'Browser stop is in progress',code:'container_capacity',retryable:true},
        {status:503,headers:{'retry-after':'1'}});
    if(this.startingJobs.size||this.activeJobs.size)
      return Response.json({success:false,error:'Site browser busy',code:'container_capacity',retryable:true},
        {status:503,headers:{'retry-after':'1'}});
    if(job.generation!==undefined&&job.generation<this.generation)
      return new Response('Browser generation is stale',{status:409});
    if(job.generation!==undefined)this.generation=job.generation;
    this.startingJobs.add(jobId);
    let response;
    try{response=await super.fetch(request);}
    catch(error){this.startingJobs.delete(jobId);throw error;}
    if(response.status!==200){
      this.startingJobs.delete(jobId);
      return response;
    }

    this.startingJobs.delete(jobId);
    this.activeJobs.add(jobId);
    request.signal.addEventListener('abort',()=>{
      this.startingJobs.delete(jobId);this.activeJobs.delete(jobId);
    },{once:true});
    const headers=new Headers(response.headers);
    headers.set('x-feed-browser-job-id',jobId);
    return new Response(response.body,{status:response.status,headers});
  }

  async onActivityExpired(){
    // The SDK arms its idle alarm before port readiness and inflight tracking.
    // A real cold-start job is work, not idle time; defer only that gap.
    if(this.startingJobs.size){
      this.renewActivityTimeout();
      return;
    }
    await super.onActivityExpired();
  }

  async completeScrape(completion){
    const jobId=completion?.jobId;
    if(typeof jobId!=='string'||!this.activeJobs.delete(jobId))return {stopped:false};
    if(completion.stop===false||this.startingJobs.size||this.activeJobs.size)return {stopped:false};
    if(completion.generation!==undefined&&completion.generation<this.generation)return {stopped:false};
    this.stopRequested=true;
    await this.stop();
    return {stopped:true};
  }

  async onStop(params){
    this.stopRequested=false;
    // The SDK can deliver the previous exit while a new fetch is starting.
    this.activeJobs.clear();
    await super.onStop(params);
  }
}
