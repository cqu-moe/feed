import {createServer} from 'node:https';
import {readFileSync} from 'node:fs';
// Only the acceptance Chrome wrapper resolves these fictitious hostnames to loopback.
const sourceNames=['a','b','c'];
const hosts=new Set(sourceNames.map(name=>name+'.feed63.cqu.edu.cn'));
const server=createServer({cert:readFileSync('/app/fixture.pem'),key:readFileSync('/app/fixture.key')},(req,res)=>{
  const {host}=req.headers;
  if(!hosts.has(host)||!/^\/(one|two|old|delay)$/.test(req.url)){res.writeHead(404);return res.end();}
  const start=Date.now();
  // Hold each actual HTTPS request open so concurrent Chrome intervals are measurable.
  setTimeout(()=>{
    res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
    res.end('<title>'+host+req.url+' '+start+' '+Date.now()+'</title><main><div class="pb_sys_common"><span class="p_t">共0条</span><span class="p_t">0/0</span></div></main>');
  },25000);
});
server.listen(8443,'127.0.0.1');
