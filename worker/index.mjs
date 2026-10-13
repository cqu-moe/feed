import {themeInitScript} from '@cqu-moe/theme';
import {Buffer} from 'node:buffer';
import {session,authRoute} from './auth.mjs';
import {bridgeRoute} from './bridge.mjs';
import {apiRoute} from './api.mjs';
import {internalRoute} from './internal.mjs';
import {subscriptionsRoute} from './subscriptions.mjs';
import {rssRoute} from './rss.mjs';
import {createMail} from './notification-mail.mjs';
import {json,encoder,cleanError} from './utils.mjs';
import {createArchive} from './archive.mjs';
import {createSources} from './sources.mjs';
import {createTaskRuntime,handleFeedJobs} from './task-runtime.mjs';
import {createArchiveRecheck} from './archive-recheck.mjs';
import {captureFeedPipelineSummaries} from './telemetry.mjs';
export {FeedIngest} from './workflow.mjs';
export {PdfOcrWorkflow} from './pdf-ocr.mjs';
export {CaptureWorkflow} from './capture-workflow.mjs';
export {DiscoveryWorkflow} from './discovery-workflow.mjs';
export {ArchiveOcrWorkflow} from './archive-ocr.mjs';

export default {
  async scheduled(controller,env,ctx){
    const sources=createSources(env),archive=createArchive(env);
    const jobs=[];
    if(controller.cron==='0 0 * * *'){
      jobs.push(archive.resumeExtract());
      if(env.TASK_RUNTIME_ENABLED!=='true')jobs.push(sources.scheduleDaily());
    }
    if(controller.cron==='*/5 * * * *'&&env.TASK_RUNTIME_ENABLED==='true'){
      jobs.push(sources.scheduleDue());
      if(env.ARCHIVE_VERSIONS_ENABLED==='true')jobs.push(createArchiveRecheck(env).scheduleDue());
      jobs.push(createTaskRuntime(env).recover());
      jobs.push(captureFeedPipelineSummaries(env,ctx).catch(()=>{}));
    }
    if(controller.cron==='*/5 * * * *'&&(env.MAIL_ENABLED==='true'||env.RESEND_WEBHOOK_SECRET)){
      jobs.push(createMail(env,{lifecycle:ctx}).recover().then(()=>createTaskRuntime(env).dispatchDueOutbox()));
    }
    ctx.waitUntil(Promise.all(jobs));
  },
  async queue(batch,env,ctx){await handleFeedJobs(batch,env,{lifecycle:ctx});},
  async fetch(request,env,ctx){
    const url=new URL(request.url);
    try{
      if(url.pathname==='/health')return json({ok:true,service:'cqu-feed'});
      if(url.pathname==='/webhooks/resend'){
        if(request.method!=='POST')return json({error:'Method not allowed'},405);
        try{return json(await createMail(env,{lifecycle:ctx}).receiveWebhook(request));}
        catch(error){return json({error:'Mail webhook could not be accepted'},error.status??503);}
      }
      const rss=await rssRoute(request,env);if(rss)return rss;
      const bridge=await bridgeRoute(request,env);if(bridge)return bridge;
      if(url.pathname.startsWith('/internal/')){
        return await internalRoute(request,env,ctx);
      }
      const auth=await authRoute(request,env);if(auth)return auth;
      if(url.pathname.startsWith('/api/')){
        const state=await session(request,env,{includeAccount:url.pathname==='/api/session'});
        if(state.error==='unavailable')return json({error:'认证服务暂时不可用，请稍后重试'},503);
        if(url.pathname==='/api/session')return json(state);
        const subscriptions=await subscriptionsRoute(request,env,state);if(subscriptions)return subscriptions;
        if(!state.authenticated)return json({error:'请先登录'},401);
        if(!state.entitled)return json({error:'需要 feed.access 权益'},403);
        return apiRoute(request,env);
      }
      const response=await env.ASSETS.fetch(request),headers=new Headers(response.headers);
      if(headers.get('Content-Type')?.includes('text/html')){
        const hash=Buffer.from(await crypto.subtle.digest('SHA-256',encoder.encode(themeInitScript))).toString('base64');
        const reader=url.pathname.startsWith('/reader/');
        headers.set('Content-Security-Policy',`default-src 'self'; script-src 'self' https://p.cqu.moe 'sha256-${hash}'${reader?" 'wasm-unsafe-eval'":''}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' https://p.cqu.moe; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; worker-src 'self'; frame-ancestors ${reader?"'self'":"'none'"}`);
        headers.set('Cache-Control','no-cache');
      }
      headers.set('Referrer-Policy','strict-origin-when-cross-origin');headers.set('X-Content-Type-Options','nosniff');
      return new Response(response.body,{status:response.status,headers});
    }catch(error){console.error(JSON.stringify({event:'request_failed',path:url.pathname,error:cleanError(error)}));return json({error:'服务暂时不可用，请稍后重试'},503);}
  },
};
