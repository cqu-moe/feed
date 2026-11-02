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
}

export class FeedBrowser extends Container{
  defaultPort=8080;
  sleepAfter='1s';
  startingJobs=new Set;
  activeJobs=new Set;

  async fetch(request){
    const path=new URL(request.url).pathname;
    if(path==='/scrape-complete'){
      if(request.method!=='POST')return new Response('Method not allowed',{status:405});
      let completion;
      try{completion=await request.json();}
      catch{return new Response('Invalid completion',{status:400});}
      const stopped=await this.completeScrape(completion);
      return Response.json({stopped});
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

  async completeScrape(completion){
    const jobId=completion?.jobId;
    if(typeof jobId!=='string'||!this.activeJobs.has(jobId))return false;
    this.activeJobs.delete(jobId);
    if(this.startingJobs.size||this.activeJobs.size)return false;
    await this.stop();
    return true;
  }
}
