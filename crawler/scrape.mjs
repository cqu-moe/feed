import {setTimeout as delay} from 'node:timers/promises';
import {openBrowser} from './browser.mjs';

export function validateJob(input){
  const url=new URL(input?.url);
  if(url.protocol!=='https:'||url.port||url.username||url.password
    ||!(url.hostname==='cqu.edu.cn'||url.hostname.endsWith('.cqu.edu.cn')))
    throw new Error('Only public CQU HTTPS sources are allowed');
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(input?.siteId??''))
    throw new Error('Explicit site identity is required');
  if(!Array.isArray(input.actions)||input.actions.length!==1
    ||input.actions[0]?.type!=='executeJavascript'||typeof input.actions[0].script!=='string'
    ||!input.actions[0].script.trim()||input.actions[0].script.length>3*1024*1024)
    throw new Error('One bounded page action is required');
  if(!Array.isArray(input.formats)||input.formats.length>4)throw new Error('Invalid formats');
  return {...input,url:url.href};
}

export async function scrapePage(job,signal){
  const start=Date.now(),browser=await openBrowser({signal});
  try{
    await browser.navigate(job.url);
    const readyDeadline=Date.now()+45000;
    let state;
    while(Date.now()<readyDeadline){
      signal.throwIfAborted();
      try{state=await browser.evaluate(`({url:location.href,ready:document.readyState,text:document.body?.innerText??'',links:document.querySelectorAll('a[href]').length})`);}
      catch(error){if(signal.aborted)throw error;}
      const status=browser.documents.at(-1)?.status;
      if(state?.url&&new URL(state.url).origin!==new URL(job.url).origin&&state.url!=='about:blank')
        throw Object.assign(new Error('Unexpected navigation origin'),{code:'origin_redirect'});
      if(status===404)throw Object.assign(new Error('Origin HTTP 404'),{code:'origin_http',httpStatus:404});
      if(status>=200&&status<300&&state?.ready==='complete'&&(state.links>0||state.text.length>100))break;
      await delay(500,undefined,{signal});
    }
    const status=browser.documents.at(-1)?.status;
    if(!(status>=200&&status<300)||state?.ready!=='complete')
      throw Object.assign(new Error(`Origin did not become ready${status?` (HTTP ${status})`:''}`),
        {code:'origin_unavailable',httpStatus:status,retryable:true});
    const value=await browser.evaluate(job.actions[0].script,{timeoutMs:220000,userGesture:true});
    const data={actions:{javascriptReturns:[{value}]},metadata:{provider:'browser-container',statusCode:status}};
    if(job.formats.includes('rawHtml'))data.rawHtml=await browser.evaluate('document.documentElement.outerHTML');
    // The page action owns body extraction; navigation text is not a substitute.
    if(job.formats.includes('markdown')&&value?.bodyText)data.markdown=value.bodyText;
    if(job.formats.some(format=>format==='screenshot'||format?.type==='screenshot')){
      data.screenshot=await browser.screenshot();
      if(data.screenshot.base64.length>12*1024*1024)throw new Error('Screenshot exceeds limit');
    }
    data.metadata.elapsedMs=Date.now()-start;
    return data;
  }finally{
    await browser.close();
  }
}
