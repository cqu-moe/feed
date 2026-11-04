import {createServer} from 'node:http';
import {scrapePage,validateJob} from './scrape.mjs';

// Only the binding-only Worker forwards to this port. CDP stays on loopback.
let busy=false;
const server=createServer(async(request,response)=>{
  const reply=(status,body,headers={})=>{
    response.writeHead(status,{'content-type':'application/json','cache-control':'no-store',...headers});
    response.end(JSON.stringify(body));
  };
  if(request.url==='/health'&&request.method==='GET')return reply(200,{ready:true,busy});
  if(request.url!=='/scrape'||request.method!=='POST')return reply(404,{error:'Not found'});
  if(busy)
    return reply(429,{error:'Browser capacity busy',code:'capacity_busy',retryable:true},{'retry-after':'60'});
  let job;
  try{
    const chunks=[];let size=0;
    for await(const chunk of request){
      size+=chunk.length;
      if(size>4*1024*1024)return reply(413,{error:'Request too large'});
      chunks.push(chunk);
    }
    job=validateJob(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  }catch{return reply(400,{error:'Invalid scrape request'});}
  if(busy)
    return reply(429,{error:'Browser capacity busy',code:'capacity_busy',retryable:true},{'retry-after':'60'});
  busy=true;
  const controller=new AbortController();
  const disconnected=()=>{if(!response.writableEnded)controller.abort(new Error('Caller disconnected'));};
  response.once('close',disconnected);
  response.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
  response.flushHeaders();
  const heartbeat=setInterval(()=>{if(!response.destroyed)response.write('\n');},10000);
  try{
    const data=await scrapePage(job,controller.signal);
    const body=JSON.stringify({success:true,data});
    if(Buffer.byteLength(body)>40*1024*1024)throw new Error('Browser response exceeds limit');
    response.end(body);
  }catch(error){
    const retryable=controller.signal.aborted||error.retryable===true
      ||/CDP timeout|Browser (connection closed|closed)|fetch failed|net::ERR_|startup timeout/.test(error.message);
    response.end(JSON.stringify({success:false,
      error:String(error.message).replace(/https?:\/\/\S+/g,'[URL omitted]').slice(0,200),
      code:error.code??(retryable?'browser_transient':'capture_failed'),retryable,httpStatus:error.httpStatus,retryAfter:error.retryAfter}));
  }finally{
    clearInterval(heartbeat);
    response.removeListener('close',disconnected);
    busy=false;
  }
});
server.requestTimeout=300000;
server.listen(8080,'0.0.0.0');
