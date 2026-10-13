import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

import { login, oauthProvider } from './oauth-provider.mjs';

export const feedOrigin = 'https://feed.test';
const policyOrigin = 'https://policy.test';
export const staticSiteId = '7fd03676e5751e9b6dd95ecb';
export const sharedArticleUrl = 'https://jwc.cqu.edu.cn/info/2026/1.htm';

const telemetryStubPlugin = {
  name: 'feed-telemetry-stub',
  setup(buildApi) {
    buildApi.onResolve({ filter: /(^|\/)telemetry\.mjs$/ }, () => ({
      path: 'feed-telemetry-stub',
      namespace: 'feed-telemetry-stub',
    }));
    buildApi.onLoad({ filter: /.*/, namespace: 'feed-telemetry-stub' }, () => ({
      loader: 'js',
      contents: `
        const calls=[];
        globalThis.FEED_TELEMETRY_EVENTS=calls;
        globalThis.FEED_TELEMETRY_STUB_LOADED=true;
        export function captureFeedWorkerEvent(_env,_lifecycle,event,distinctId,properties={}) {
          calls.push({event,distinctId,properties});
        }
        export async function captureFeedPipelineSummaries() {}
      `,
    }));
  },
};

const recheckWorkersPlugin = {
  name: 'recheck-workers-stub',
  setup(buildApi) {
    buildApi.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cloudflare-workers', namespace: 'recheck-workers-stub' }));
    buildApi.onLoad({ filter: /.*/, namespace: 'recheck-workers-stub' }, () => ({
      loader: 'js',
      contents: 'export class WorkflowEntrypoint{constructor(env={}){this.env=env;}}',
    }));
  },
};

const recheckFirecrawlPlugin = {
  name: 'recheck-firecrawl-stub',
  setup(buildApi) {
    buildApi.onResolve({ filter: /firecrawl\.mjs$/ }, () => ({ path: 'recheck-firecrawl', namespace: 'recheck-firecrawl-stub' }));
    buildApi.onLoad({ filter: /.*/, namespace: 'recheck-firecrawl-stub' }, () => ({
      loader: 'js',
      contents: `
        const calls=[];
        globalThis.RECHECK_SOURCE_CALLS=calls;
        globalThis.RECHECK_SOURCE_MODE='changed';
        const base64=value=>btoa(String.fromCharCode(...new TextEncoder().encode(value)));
        const source=mode=>{
          if(mode==='unavailable')throw new Error('source unavailable');
          const changed=mode==='changed';
          const body=changed?'实质修改正文':'原始正文';
          const attachment=changed?'%PDF-1.7\\nchanged':'%PDF-1.7\\noriginal';
          const snapshot='<html><body><main><h1>复查通知</h1><p>'+body+'</p></main></body></html>';
          const attachmentUrl='https://jwc.cqu.edu.cn/system/_content/download.jsp?urltype=1501&recheck.pdf';
          return {markdown:body,rawHtml:snapshot,metadata:{statusCode:200,creditsUsed:1},actions:{javascriptReturns:[{value:JSON.stringify({
            bodyRecognized:true,page:{url:${JSON.stringify(sharedArticleUrl)}},heading:'复查通知',bodyText:body,bodyCapturedAt:new Date().toISOString(),errors:[],
            artifacts:[
              {name:'attachment-1.pdf',base64:base64(attachment),contentType:'application/pdf'},
              {name:'snapshot.html',base64:base64(snapshot),contentType:'text/html; charset=utf-8'},
              {name:'offline.html',base64:base64(snapshot),contentType:'text/html; charset=utf-8'},
            ],
            attachmentCandidates:[{url:attachmentUrl,name:'复查附件.pdf',role:'attachment'}],
            downloads:[{url:attachmentUrl,originalFile:true,saved:{name:'attachment-1.pdf'},fetchedAt:new Date().toISOString()}],
          })}]},
          };
        };
        export async function scrape(_env,url){
          calls.push({url,mode:globalThis.RECHECK_SOURCE_MODE});
          return source(globalThis.RECHECK_SOURCE_MODE);
        }
      `,
    }));
  },
};

export async function subscriptionsFixture({
  editingMigration = true,
  clock,
  notificationPageSize,
  mailHarness,
  telemetryHarness = false,
  recheckMigration = false,
  recheckHarness = false,
  recheckVars = {},
} = {}) {
  const app = await build({
    stdin: { contents: `
      import worker from './worker/index.mjs';
      import {createMail} from './worker/notification-mail.mjs';
      import {createSubscriptions} from './worker/subscriptions.mjs';
      import {createNotifications} from './worker/notifications.mjs';
      import {handleFeedJobs} from './worker/task-runtime.mjs';
      import {createArchive} from './worker/archive.mjs';
      import {createCollector} from './worker/collect.mjs';
      import {finishCaptureTask} from './worker/task-runtime.mjs';
      import {scrape} from './worker/firecrawl.mjs';
      import {replayMatchOutbox} from './tests/helpers/notification-replay.mjs';
      import {reconcileRevision} from './worker/archive-reconcile.mjs';
      let mailClock=${clock ?? 'Date.now()'};
      let notificationClock=${clock ?? 'null'};
      const notificationNow=()=>notificationClock??Date.now();
      const workerErrors=[];
      console.error=(...args)=>{workerErrors.push(args.map(String));};
      export default {async fetch(request,env,context){
        if(new URL(request.url).pathname==='/__test/mail'){
          const {method,args=[],at}=await request.json();
          if(at!==undefined)mailClock=at;
          if(method==='clock')return Response.json({at:mailClock});
          if(method==='recoverDisabled')return Response.json(await createMail({...env,MAIL_ENABLED:'false'},{now:()=>mailClock}).recover());
          if(method==='replay'){
            const rows=await env.DB.prepare("SELECT payload_json FROM outbox WHERE topic='feed-mail' AND (state='queued' OR ?=1) ORDER BY created_at,id").bind(args[0]?.duplicate?1:0).all();
            let acked=0,retried=0;
            for(const row of rows.results){const body=JSON.parse(row.payload_json);
              await handleFeedJobs({messages:[{body,ack(){acked++},retry(){retried++}}]},env,{now:()=>mailClock});
              if(!retried)await env.DB.prepare("UPDATE outbox SET state='sent' WHERE id=?").bind(body.outboxId).run();
            }
            return Response.json({acked,retried});
          }
          return Response.json(await createMail(env,{now:()=>mailClock})[method](...args));
        }
        if(${clock !== undefined}&&new URL(request.url).pathname==='/__test/subscriptions'){
          const {method,actor,args}=await request.json();
          try{return Response.json(await createSubscriptions(env,{now:()=>${clock ?? 0}})[method](actor,...args));}
          catch(error){return Response.json({error:error.message},{status:error.status??503});}
        }
        if(new URL(request.url).pathname==='/__test/notifications'){
          const {method,args}=await request.json();
          if(method==='clock'){notificationClock=args[0];return Response.json({at:notificationClock});}
          if(method==='replayMatchOutbox')return Response.json(await replayMatchOutbox(env,notificationNow,...args));
          try{return Response.json(await createNotifications(env,{now:notificationNow})[method](...args));}
          catch(error){return Response.json({error:error.message},{status:error.status??503});}
        }
        if(new URL(request.url).pathname==='/__test/feed-jobs'){
          const {messages}=await request.json();
          const batch={messages:messages.map(body=>({body,acked:false,retried:false,
            ack(){this.acked=true;},retry(){this.retried=true;}}))};
          await handleFeedJobs(batch,env,{now:()=>${clock ?? 'Date.now()'}});
          return Response.json({messages:batch.messages.map(({acked,retried})=>({acked,retried}))});
        }
        if(new URL(request.url).pathname==='/__test/reconcile'){
          const {revisionId}=await request.json();
          return Response.json(await reconcileRevision(env,revisionId));
        }
        if(new URL(request.url).pathname==='/__test/scheduled'){
          const pending=[];
          await worker.scheduled({cron:'*/5 * * * *'},env,{waitUntil(promise){pending.push(promise);}});
          await Promise.all(pending);
          return Response.json({completed:true});
        }
        if(new URL(request.url).pathname==='/__test/recheck-source'){
          if(request.method==='POST'){
            const body=await request.json();
            globalThis.RECHECK_SOURCE_MODE=body.mode;
          }
          return Response.json({mode:globalThis.RECHECK_SOURCE_MODE,calls:globalThis.RECHECK_SOURCE_CALLS});
        }
        if(new URL(request.url).pathname==='/__test/recheck-capture'){
          const {taskId}=await request.json();
          const existing=await env.DB.prepare('SELECT result_json FROM task_attempts WHERE task_id=? AND attempt_no=1').bind(taskId).first();
          if(existing?.result_json)return Response.json(JSON.parse(existing.result_json));
          const task=await env.DB.prepare("SELECT id FROM tasks WHERE id=? AND kind='recheck' AND state='queued'").bind(taskId).first();
          if(!task)return Response.json({error:'Recheck task is not queued'},{status:409});
          await env.DB.batch([
            env.DB.prepare("UPDATE tasks SET state='running',updated_at=? WHERE id=? AND state='queued'").bind(Date.now(),taskId),
            env.DB.prepare("INSERT INTO task_attempts(task_id,attempt_no,workflow_instance_id,state,started_at) VALUES (?,1,?,'running',?) ON CONFLICT(task_id,attempt_no) DO NOTHING")
              .bind(taskId,'task-'+taskId+'-a1',Date.now()),
          ]);
          const result=await createArchive(env,{collector:createCollector({scrape})}).captureTask(taskId,1);
          await finishCaptureTask(env,taskId,1,result);
          return Response.json(result);
        }
        if(new URL(request.url).pathname==='/__test/errors')return Response.json(workerErrors);
        if(new URL(request.url).pathname==='/__test/telemetry')return Response.json({
          loaded:globalThis.FEED_TELEMETRY_STUB_LOADED===true,
          events:globalThis.FEED_TELEMETRY_EVENTS??[],
        });
        if(new URL(request.url).pathname==='/__test/rss-failure'){
          const {url}=await request.json();
          return worker.fetch(new Request(url,{method:'GET'}),{...env,BASE_URL:'https://feed.test/#not-canonical'});
        }
        if(new URL(request.url).pathname==='/rss'){
          const originalFetch=globalThis.fetch;
          globalThis.fetch=async()=>{throw new Error('Unexpected external fetch during RSS')};
          try{return await worker.fetch(request,env,context);}
          finally{globalThis.fetch=originalFetch;}
        }
        return worker.fetch(request,env,context);
      }};
    `, resolveDir: process.cwd() },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    external: ['node:buffer', 'node:*', 'cloudflare:workers'],
    plugins: [
      ...(telemetryHarness ? [telemetryStubPlugin] : []),
      ...(recheckHarness ? [recheckWorkersPlugin, recheckFirecrawlPlugin] : []),
    ],
  });
  const policy = await build({
    stdin: {
      contents: `
        import {WorkerEntrypoint} from 'cloudflare:workers';
        const state={
          policies:{},
          defaultPolicy:{access:true,limit:{kind:'limited',value:10}},
	          recipients:{},
	          defaultRecipient:{status:'verified',email:'reader@example.test'},
          outage:false,
          result:'normal',
          switchAfterCalls:0,
          switchTo:null,
          policyCalls:0,
        };
        function envelope(data){return {ok:true,contractVersion:1,checkedAt:Date.now(),data};}
        function policyFor(userId){return state.policies[userId]??state.defaultPolicy;}
	        function recipientFor(userId){return state.recipients[userId]??state.defaultRecipient;}
        export class AuthService extends WorkerEntrypoint{
          async getFeedPolicy(request){
            if(request.contractVersion!==1||request.clientId!=='feed-rpc-client'||request.clientSecret!=='feed-rpc-secret'){
              return {ok:false,code:request.contractVersion===1?'INVALID_CLIENT':'UNSUPPORTED_VERSION',retryable:false,requestId:'test'};
            }
            if(state.outage)throw new Error('policy unavailable');
            if(state.result==='malformed')return envelope({access:true,subscriptionLimit:{kind:'limited',value:'2'}});
            const policy=policyFor(request.userId);
            state.policyCalls+=1;
            if(state.switchAfterCalls===state.policyCalls&&state.switchTo){
              if('outage' in state.switchTo)state.outage=state.switchTo.outage;
              if('result' in state.switchTo)state.result=state.switchTo.result;
              if('limit' in state.switchTo)state.policies[request.userId]={access:policy.access,limit:state.switchTo.limit};
            }
            return envelope({access:policy.access,subscriptionLimit:policy.limit});
          }
	          async getFeedRecipient(request){
	            const checked=await this.getFeedPolicy(request);
	            if(!checked.ok)return checked;
	            return envelope({policy:checked.data,recipient:recipientFor(request.userId)});
	          }
        }
        export default {
          async fetch(request){
            const url=new URL(request.url);
            if(url.pathname==='/state'&&request.method==='POST'){
              Object.assign(state,await request.json());
              return Response.json(state);
            }
            return Response.json(state);
          },
        };
      `,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    external: ['cloudflare:workers'],
  });
  const provider = oauthProvider();
  const mf = new Miniflare(convertV4MiniflareOptions({
    workers: [
      {
        name: 'feed',
        modules: true,
        script: app.outputFiles[0].text,
        compatibilityDate: '2026-10-11',
        compatibilityFlags: ['nodejs_compat'],
        bindings: { ...(mailHarness?{MAIL_ENABLED:'true',MAIL_FROM:'Feed <notifications@feed.test>',RESEND_API_KEY:'test-key',RESEND_WEBHOOK_SECRET:'whsec_dGVzdC1zaWduaW5nLWtleQ==',...mailHarness.bindings}:{}),...provider.bindings, ADMIN_TOKEN: 'test-admin-token', BASE_URL: feedOrigin, SOURCE_MANAGEMENT_ENABLED: 'true', FEED_AUTH_RPC_CLIENT_ID: 'feed-rpc-client', FEED_AUTH_RPC_CLIENT_SECRET: 'feed-rpc-secret', ...(notificationPageSize === undefined ? {} : { NOTIFICATION_MATCH_PAGE_SIZE: notificationPageSize }), ...(recheckMigration ? { ARCHIVE_VERSIONS_ENABLED: 'true', ARCHIVE_READS_ENABLED: 'true', TASK_RUNTIME_ENABLED: 'true', CRAWL_ENABLED: 'true', BRIDGE_SECRET: 'test-bridge-secret', ...recheckVars } : {}) },
        ...(mailHarness?{outboundService:request=>mailHarness.fetch(request)}:{}),
        d1Databases: ['DB'],
        r2Buckets: ['ARCHIVE'],
        serviceBindings: { AUTH: request => provider.fetch(request), AUTH_FEED_RPC: { name: 'policy', entrypoint: 'AuthService' } },
      },
      {
        name: 'policy',
        modules: true,
        script: policy.outputFiles[0].text,
        compatibilityDate: '2026-10-11',
        compatibilityFlags: ['nodejs_compat'],
      },
    ],
  }));
  const db = await mf.getD1Database('DB', 'feed');
  const migrationNames = ['0001_feed.sql', '0002_auth.sql', '0003_collection_lease.sql', '0004_pdf_ocr.sql', '0005_task_runtime.sql', '0006_sources.sql', '0007_archive_versions.sql', '0008_content_events.sql', '0009_subscriptions.sql'];
  if (editingMigration) migrationNames.push('0010_subscription_editing.sql');
  migrationNames.push('0018_outbox_receipts.sql');
  migrationNames.push('0013_notification_matching.sql');
  if(mailHarness)migrationNames.push('0014_mail_delivery.sql','0016_mail_digests.sql');
  if(recheckMigration)migrationNames.push('0015_history_backfill.sql','0017_archive_recheck.sql');
  for (const name of migrationNames) {
    await applyMigration(db, await readFile(`migrations/${name}`, 'utf8'));
  }
  const policyWorker = await mf.getWorker('policy');
  return {
    mf,
    db,
    async mail(method,...args){const res=await mf.dispatchFetch(feedOrigin+'/__test/mail',{method:'POST',body:JSON.stringify({method,args})});return res.json();},
    async mailClock(at){const res=await mf.dispatchFetch(feedOrigin+'/__test/mail',{method:'POST',body:JSON.stringify({method:'clock',at})});return res.json();},
    async replayMail(options={}){const res=await mf.dispatchFetch(feedOrigin+'/__test/mail',{method:'POST',body:JSON.stringify({method:'replay',args:[options]})});return res.json();},
    login: (subject = 'user-a') => login(mf, provider, subject),
    revokeAccess() { provider.setAccess(false); },
    async setPolicy(subject, policy) { await post(policyWorker, `${policyOrigin}/state`, { policies: { [subject]: policy } }); },
	    async setRecipient(subject, recipient) { await post(policyWorker, `${policyOrigin}/state`, { recipients: { [subject]: recipient } }); },
    async setPolicyService(changes) { await post(policyWorker, `${policyOrigin}/state`, changes); return (await policyWorker.fetch(`${policyOrigin}/state`)).json(); },
    async switchAfterPolicyCall(subject, switchTo) { await post(policyWorker, `${policyOrigin}/state`, { switchAfterCalls: 1, switchTo, policies: { [subject]: { access: true, limit: { kind: 'limited', value: 1 } } } }); },
  };
}

export async function subscriptionCall(mf, path, { cookie, method = 'GET', origin, body } = {}) {
  const response = await mf.dispatchFetch(feedOrigin + path, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

export async function subscriptionsInvoke(mf, method, actor, ...args) {
  const response = await mf.dispatchFetch(feedOrigin + '/__test/subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, actor, args }),
  });
  return { status: response.status, body: await response.json() };
}

export async function adminRequest(mf, path, body, { method = 'POST' } = {}) {
  const response = await mf.dispatchFetch(feedOrigin + path, {
    method,
    headers: { Authorization: 'Bearer test-admin-token', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

export async function notificationInvoke(mf, method, ...args) {
  const response = await mf.dispatchFetch(feedOrigin + '/__test/notifications', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, args }),
  });
  return { status: response.status, body: await response.json() };
}

export async function feedJobsInvoke(mf, ...messages) {
  const response = await mf.dispatchFetch(feedOrigin + '/__test/feed-jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  });
  return { status: response.status, body: await response.json() };
}

async function post(worker, path, body) {
  const response = await worker.fetch(path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  if (response.status !== 200) throw new Error(`policy fixture update failed: ${await response.text()}`);
}

export async function applyMigration(db, sql) {
  const statements = sql.split(/;\s*\n(?=CREATE|ALTER|PRAGMA|CREATE INDEX|INSERT|UPDATE|$)/)
    .map(statement => statement.trim())
    .filter(statement => statement && !/^PRAGMA\b/i.test(statement));
  for (const statement of statements) await db.prepare(statement).run();
}
