import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {openBrowser} from './browser.mjs';
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

test('closing a stalled capture terminates the Chrome process tree before deleting its temporary profile',async()=>{
  const before=new Set((await readdir('/tmp')).filter(name=>name.startsWith('feed-capture-')));
  const browser=await openBrowser({signal:AbortSignal.timeout(30000)});
  let group;
  try{
    await browser.navigate('data:text/html,<h1>Cancellation contract</h1>');
    await browser.evaluate('document.readyState');
    const root=(await processes()).find(row=>row.command.includes('--user-data-dir=/tmp/feed-capture-'));
    assert.ok(root,'the actual Chrome browser started in an isolated profile');
    group=root.group;
    assert.ok((await processes()).filter(row=>row.group===group&&row.state!=='Z').length>1,'Chrome has real subprocesses');
    // A stopped process cannot finish a graceful shutdown. This exercises the
    // same forced cleanup used for a hung browser or an aborted capture.
    process.kill(-group,'SIGSTOP');
    await browser.close();
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
