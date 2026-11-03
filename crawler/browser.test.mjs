import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {openBrowser} from './browser.mjs';
import {scrapePage} from './scrape.mjs';
import {createServer} from 'node:http';

async function processes(){
  const rows=[];
  for(const pid of (await readdir('/proc')).filter(name=>/^\d+$/.test(name))){
    try{
      const stat=await readFile(`/proc/${pid}/stat`,'utf8');
      const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
      const command=await readFile(`/proc/${pid}/cmdline`,'utf8');
      rows.push({pid:Number(pid),state:fields[0],group:Number(fields[2]),command});
    }catch(error){if(error.code!=='ENOENT'&&error.code!=='ESRCH')throw error;}
  }
  return rows;
}

test('cancelling a stalled capture rejects pending work and removes the Chrome process tree and profile',{timeout:30000},async()=>{
  const before=new Set((await readdir('/tmp')).filter(name=>name.startsWith('feed-capture-')));
  const controller=new AbortController();
  const browser=await openBrowser({signal:controller.signal});
  let group;
  try{
    await browser.navigate('data:text/html,<h1>Cancellation contract</h1>');
    await browser.evaluate('document.readyState');
    const root=(await processes()).find(row=>row.command.includes('--user-data-dir=/tmp/feed-capture-'));
    assert.ok(root,'the actual Chrome browser started in an isolated profile');
    group=root.group;
    assert.ok((await processes()).filter(row=>row.group===group&&row.state!=='Z').length>1,'Chrome has real subprocesses');
    const pending=browser.evaluate('new Promise(()=>{})',{timeoutMs:null}).then(()=>null,error=>error.message);
    await delay(50);
    // A stopped process cannot finish a graceful shutdown. This exercises the
    // same forced cleanup used for a hung browser or an aborted capture.
    process.kill(-group,'SIGSTOP');
    controller.abort(new Error('Caller disconnected'));
    await browser.close();
    assert.equal(await pending,'Browser closed');
    await delay(50);
    assert.deepEqual((await processes()).filter(row=>row.group===group&&row.state!=='Z').map(row=>row.pid),[]);
    assert.deepEqual((await readdir('/tmp')).filter(name=>name.startsWith('feed-capture-')&&!before.has(name)),[]);
  }finally{
    if(group){try{process.kill(-group,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}
    await browser.close();
  }
});


test('stalled VSB counters cannot block article parsing while content scripts still run',async()=>{
  const requested=[];
  const server=createServer((request,response)=>{
    requested.push(request.url);
    if(request.url.startsWith('/system/resource/js/'))return;
    if(request.url==='/content.js'){
      response.setHeader('content-type','text/javascript');
      return response.end('window.articleValue="loaded"');
    }
    response.setHeader('content-type','text/html');
    response.end('<script src="/system/resource/js/counter.js"></script><script src="/system/resource/js/dynclicks.js"></script><script src="/content.js"></script><article>Public notice</article>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await openBrowser({signal:AbortSignal.timeout(15000)});
  try{
    await browser.navigate(`http://127.0.0.1:${server.address().port}/`);
    let page;
    for(let i=0;i<40;i++){
      page=await browser.evaluate('({body:document.querySelector("article")?.textContent,value:window.articleValue})');
      if(page?.body)break;
      await delay(100);
    }
    assert.deepEqual(page,{body:'Public notice',value:'loaded'});
    assert.equal(requested.some(url=>url.startsWith('/system/resource/js/')),false);
  }finally{
    await browser.close();server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
});

test('the signed CAPTCHA bridge can open without transient user activation',async()=>{
  const browser=await openBrowser({signal:AbortSignal.timeout(15000)});
  try{
    await browser.navigate('data:text/html,<title>Notice</title><article>Public notice</article>');
    const result=await browser.evaluate(`(() => {
      const popup=window.open('about:blank','captcha-bridge','popup,width=360,height=240');
      const result={opened:!!popup,hasOpener:popup?.opener===window};
      popup?.close();return result;
    })()`);
    assert.deepEqual(result,{opened:true,hasOpener:true});
  }finally{await browser.close();}
});

test('HTTP and JavaScript redirects keep the main document status separate from a denied PDF frame',async()=>{
  let frameRequests=0;
  const server=createServer((request,response)=>{
    if(request.url==='/info/1009/25310.htm'){
      response.writeHead(302,{location:'/redirect.htm'});
      return response.end();
    }
    response.setHeader('content-type','text/html; charset=utf-8');
    if(request.url==='/redirect.htm')return response.end('<script>location.replace("/content.jsp?urltype=news.NewsContentUrl&wbtreeid=1009&wbnewsid=25310")</script>');
    if(request.url==='/denied.pdf'){
      frameRequests++;
      response.statusCode=403;
      return response.end('Denied PDF');
    }
    if(request.url.startsWith('/content.jsp?'))return response.end('<article>Public notice</article><iframe src="/denied.pdf" onload="window.frameLoaded=true"></iframe>');
    response.statusCode=404;response.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const result=await scrapePage({
      url:`http://127.0.0.1:${server.address().port}/info/1009/25310.htm`,formats:[],
      actions:[{type:'executeJavascript',script:`(async()=>{
        while(!window.frameLoaded)await new Promise(resolve=>setTimeout(resolve,20));
        return {path:location.pathname,tree:new URL(location.href).searchParams.get('wbtreeid'),body:document.querySelector('article')?.textContent};
      })()`}],
    },AbortSignal.timeout(15000));
    assert.deepEqual(result.actions.javascriptReturns[0].value,{path:'/content.jsp',tree:'1009',body:'Public notice'});
    assert.equal(result.metadata.statusCode,200);
    assert.equal(frameRequests,1);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('origin errors identify the final main document without leaking query values or fragments',async()=>{
  const server=createServer((request,response)=>{
    response.setHeader('content-type','text/html; charset=utf-8');
    if(request.url==='/info/1009/25310.htm')return response.end('<script>location.replace("/content.jsp?token=private-value#private-fragment")</script>');
    response.statusCode=404;response.end('<article>Missing notice</article>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    await assert.rejects(scrapePage({
      url:`http://127.0.0.1:${server.address().port}/info/1009/25310.htm`,formats:[],
      actions:[{type:'executeJavascript',script:'({unexpected:true})'}],
    },AbortSignal.timeout(15000)),error=>{
      assert.equal(error.code,'origin_http');
      assert.equal(error.httpStatus,404);
      assert.match(error.message,/path \/content\.jsp/);
      assert.match(error.message,/main 200>404/);
      assert.doesNotMatch(error.message,/private-|token=|https?:\/\//);
      return true;
    });
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('list probes skip the stalled CS carousel while captures retain it',async()=>{
  let carouselRequests=0;
  const server=createServer((request,response)=>{
    if(request.url==='/2024/lib/js/swiper.min.js'){carouselRequests++;return;}
    response.setHeader('content-type','text/html');
    response.end('<main><a href="/info/1549/12202.htm">Notice</a></main><script src="/2024/lib/js/swiper.min.js"></script>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    for(const list of [true,false]){
      const browser=await openBrowser({signal:AbortSignal.timeout(15000),skipCarousel:list});
      try{
        await browser.navigate(`http://127.0.0.1:${server.address().port}/`);
        let state;
        for(let i=0;i<20;i++){
          state=await browser.evaluate('({parsed:document.readyState!=="loading",title:document.querySelector("main a")?.textContent})');
          if(state.title&&(list?state.parsed:carouselRequests>0))break;
          await delay(100);
        }
        assert.deepEqual(state,{parsed:list,title:'Notice'});
        assert.equal(carouselRequests,list?0:1);
      }finally{await browser.close();}
    }
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

// Reduced from JWC's live 学籍管理 list on 2026-11-03: HTTP 200, no
// articles, and the VSB paginator explicitly says there are zero records.
test('an explicitly empty VSB list reaches extraction instead of timing out',async()=>{
  const server=createServer((_request,response)=>{
    response.setHeader('content-type','text/html; charset=utf-8');
    response.end('<main><ul></ul><div class="pb_sys_common"><span class="p_t">共0条</span><span class="p_t">0/0</span></div></main>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const result=await scrapePage({
      url:`http://127.0.0.1:${server.address().port}/list.htm`,
      readiness:{articlePattern:'^/info/\\d+/\\d+\\.htm$'},formats:[],
      actions:[{type:'executeJavascript',script:'({extracted:true})'}],
    },AbortSignal.timeout(10000));
    assert.deepEqual(result.actions.javascriptReturns[0].value,{extracted:true});
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
