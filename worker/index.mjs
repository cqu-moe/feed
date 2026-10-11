import {themeInitScript} from '@cqu-moe/theme';
import {Buffer} from 'node:buffer';
import {session,authRoute} from './auth.mjs';
import {bridgeRoute} from './bridge.mjs';
import {apiRoute} from './api.mjs';
import {json,equal,encoder,cleanError} from './utils.mjs';
import {startDaily} from './workflow.mjs';
export {FeedIngest} from './workflow.mjs';

export default {
  async scheduled(controller,env,ctx){ctx.waitUntil(startDaily(env));},
  async fetch(request,env){
    const url=new URL(request.url);
    try{
      if(url.pathname==='/health')return json({ok:true,service:'cqu-feed'});
      const bridge=await bridgeRoute(request,env);if(bridge)return bridge;
      if(url.pathname.startsWith('/internal/')){
        if(!env.ADMIN_TOKEN||!await equal(request.headers.get('Authorization'),`Bearer ${env.ADMIN_TOKEN}`))return json({error:'Unauthorized'},401);
        if(url.pathname==='/internal/run'&&request.method==='POST')return json({ids:await startDaily(env,crypto.randomUUID().slice(0,8))},202);
        if(url.pathname==='/internal/auth-check'&&request.method==='GET'){
          const r=await env.AUTH.fetch(new URL('/api/v1/auth/oauth2/introspect',env.AUTH_BASE_URL),{method:'POST',headers:{Authorization:'Basic '+Buffer.from(env.FEED_AUTH_CLIENT_ID+':'+env.FEED_AUTH_CLIENT_SECRET).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:'feed-readiness-invalid-token'}),signal:AbortSignal.timeout(10000)});
          const type=r.headers.get('content-type')??'';const result=type.includes('json')?await r.json():{};
          return json({providerStatus:r.status,ready:r.ok&&result.active===false},r.ok?200:503);
        }
        if(url.pathname==='/internal/status'&&request.method==='GET'){
          const [runs,articles,usage]=await Promise.all([
            env.DB.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 20').all(),
            env.DB.prepare('SELECT source_id,status,COUNT(*) AS n FROM articles GROUP BY source_id,status').all(),
            env.DB.prepare('SELECT * FROM usage ORDER BY day DESC LIMIT 20').all(),
          ]);return json({runs:runs.results,articles:articles.results,usage:usage.results});
        }
        return json({error:'Not found'},404);
      }
      const auth=await authRoute(request,env);if(auth)return auth;
      if(url.pathname.startsWith('/api/')){
        const state=await session(request,env);
        if(state.error==='unavailable')return json({error:'认证服务暂时不可用，请稍后重试'},503);
        if(url.pathname==='/api/session')return json(state);
        if(!state.authenticated)return json({error:'请先登录'},401);
        if(!state.entitled)return json({error:'需要 feed.access 权益'},403);
        return apiRoute(request,env);
      }
      const response=await env.ASSETS.fetch(request),headers=new Headers(response.headers);
      if(headers.get('Content-Type')?.includes('text/html')){
        const hash=Buffer.from(await crypto.subtle.digest('SHA-256',encoder.encode(themeInitScript))).toString('base64');
        const reader=url.pathname.startsWith('/reader/');
        headers.set('Content-Security-Policy',`default-src 'self'; script-src 'self' 'sha256-${hash}'${reader?" 'wasm-unsafe-eval'":''}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; worker-src 'self'; frame-ancestors ${reader?"'self'":"'none'"}`);
        headers.set('Cache-Control','no-cache');
      }
      headers.set('Referrer-Policy','strict-origin-when-cross-origin');headers.set('X-Content-Type-Options','nosniff');
      return new Response(response.body,{status:response.status,headers});
    }catch(error){console.error(JSON.stringify({event:'request_failed',path:url.pathname,error:cleanError(error)}));return json({error:'服务暂时不可用，请稍后重试'},503);}
  },
};
