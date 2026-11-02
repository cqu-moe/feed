import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';

export async function openBrowser({signal}={}){
  const executablePath=process.env.CHROME_EXECUTABLE;
  if(!executablePath)throw new Error('CHROME_EXECUTABLE required');
  const documents=[];
  signal?.throwIfAborted();
  const profile=await mkdtemp(join(tmpdir(),'feed-capture-'));
  await mkdir(join(profile,'Default'));
  await writeFile(join(profile,'Default/Preferences'),JSON.stringify({intl:{accept_languages:'zh-CN,zh'}}));
  const portReservation=createServer();
  const debugPort=await new Promise((resolve,reject)=>{
    portReservation.once('error',reject);
    portReservation.listen(0,'127.0.0.1',()=>{
      const port=portReservation.address().port;
      portReservation.close(error=>error?reject(error):resolve(port));
    });
  });
  const child=spawn(executablePath,[
    `--remote-debugging-port=${debugPort}`,`--user-data-dir=${profile}`,'--no-first-run',
    '--no-default-browser-check','--no-sandbox','--disable-dev-shm-usage',
    '--window-size=1440,1000','about:blank',
  ],{stdio:'ignore',detached:true});
  let spawnError;
  child.on('error',error=>{spawnError=error;});
  let socket;
  const pending=new Map();
  let closing;
  const close=async () => closing ??= (async () => {
    signal?.removeEventListener('abort',abort);
    socket?.close();
    for(const {reject,timer} of pending.values()){clearTimeout(timer);reject(new Error('Browser closed'));}
    pending.clear();
    if(child.pid){
      try{child.kill('SIGTERM');}catch{}
      await delay(500);
      try{child.kill('SIGKILL');}catch{}
    }
    await rm(profile,{recursive:true,force:true});
  })();
  const abort=()=>{void close();};
  signal?.addEventListener('abort',abort,{once:true});
  try{
    let ready=false;
    const launchDeadline=Date.now()+30000;
    while(Date.now()<launchDeadline){
      signal?.throwIfAborted();
      if(spawnError)throw spawnError;
      if(child.exitCode!==null)throw new Error(`Chrome exited: ${child.exitCode}`);
      try{ready=(await fetch(`http://127.0.0.1:${debugPort}/json/version`,{signal:AbortSignal.timeout(1000)})).ok;}catch{}
      if(ready)break;
      await delay(200);
    }
    if(!ready)throw new Error('Chrome startup timeout');
    const tabs=await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    const target=tabs.find(tab=>tab.type==='page');
    if(!target)throw new Error('Chrome has no page');
    socket=new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('CDP connect timeout')),10000);
      socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
      socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('CDP connect failed'));},{once:true});
    });
    let id=0;
    const call=(method,params={},timeoutMs=45000)=>new Promise((resolve,reject)=>{
      signal?.throwIfAborted();
      const requestId=++id;
      const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error(`CDP timeout: ${method}`));},timeoutMs);
      pending.set(requestId,{resolve,reject,timer});
      socket.send(JSON.stringify({id:requestId,method,params}));
    });
    socket.addEventListener('close',()=>{
      for(const {reject,timer} of pending.values()){clearTimeout(timer);reject(new Error('Browser connection closed'));}
      pending.clear();
    });
    let mainFrameId;
    socket.addEventListener('message',event=>{
      const message=JSON.parse(event.data);
      if(message.id&&pending.has(message.id)){
        const {resolve,reject,timer}=pending.get(message.id);
        pending.delete(message.id);clearTimeout(timer);
        if(message.error)reject(new Error(`CDP ${message.error.message}`));
        else resolve(message.result);
      }else if(message.method==='Page.frameNavigated'&&!message.params.frame.parentId){
        mainFrameId=message.params.frame.id;
      }else if(message.method==='Network.responseReceived'&&message.params.type==='Document'&&message.params.frameId===mainFrameId){
        documents.push({url:message.params.response.url,status:message.params.response.status});
      }
    });
    // Auth's successful fresh-session flow does not call Runtime.enable.
    await call('Page.enable');
    mainFrameId=(await call('Page.getFrameTree')).frameTree.frame.id;
    await call('Network.enable');
    await call('Emulation.setLocaleOverride',{locale:'zh-CN'});
    await call('Emulation.setTimezoneOverride',{timezoneId:'Asia/Shanghai'});
    const {product}=await call('Browser.getVersion');
    return {
      version:product,documents,
      navigate:async url=>{
        const result=await call('Page.navigate',{url});
        if(result.errorText)throw new Error(result.errorText);
      },
      evaluate:async(script,{timeoutMs=45000,userGesture=false}={})=>{
        const result=await call('Runtime.evaluate',{
          expression:script,awaitPromise:true,returnByValue:true,userGesture,
        },timeoutMs);
        if(result.exceptionDetails)throw new Error('Page evaluation failed');
        return result.result.value;
      },
      screenshot:async()=>{
        const result=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,fromSurface:true});
        return {base64:result.data,contentType:'image/png'};
      },
      close,
    };
  }catch(error){await close();throw error;}
}
