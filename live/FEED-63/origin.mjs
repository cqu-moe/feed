import {createServer} from 'node:https';
import {readFileSync} from 'node:fs';
// Only the acceptance Chrome wrapper resolves these fictitious hostnames to loopback.
const sourceNames=['a','b','c'];
const hosts=new Set(sourceNames.map(name=>name+'.feed63.cqu.edu.cn'));
const server=createServer({cert:readFileSync(process.env.FIXTURE_TLS_DIR+'/cert'),key:readFileSync(process.env.FIXTURE_TLS_DIR+'/key')},(req,res)=>{
  const {host}=req.headers;
  const {pathname,searchParams}=new URL(req.url,'https://fixture.test');
  if(!hosts.has(host)||!/^\/(one|two|old|delay|rate)$/.test(pathname)){res.writeHead(404);return res.end();}
  const start=Date.now();
  if(pathname==='/rate'){
    const allowedAt=Number(searchParams.get('after'));
    if(!Number.isSafeInteger(allowedAt)||allowedAt<=0){res.writeHead(400);return res.end();}
    if(start<allowedAt){
      res.writeHead(429,{'retry-after':new Date(allowedAt).toUTCString(),'content-type':'text/plain'});
      return res.end('Retry after the agreed time');
    }
  }
  // Hold each actual HTTPS request open so concurrent Chrome intervals are measurable.
  setTimeout(()=>{
    res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
    res.end('<title>'+host+pathname+' '+start+' '+Date.now()+'</title><main><div class="pb_sys_common"><span class="p_t">共0条</span><span class="p_t">0/0</span></div></main>');
  },25000);
});
server.listen(8443,'127.0.0.1');
