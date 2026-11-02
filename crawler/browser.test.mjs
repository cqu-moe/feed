import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {openBrowser} from './browser.mjs';

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
