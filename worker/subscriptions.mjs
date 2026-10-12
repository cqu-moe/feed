import {json,sha} from './utils.mjs';
import {sealRssToken,rssUrlForOwner} from './subscription-credentials.mjs';
import {createSources} from './sources.mjs';
import {createFeedAuthClient} from './feed-auth-client.mjs';

const emailModes=new Set(['off','immediate','daily_digest']);

export function createSubscriptions(env,{now=()=>Date.now()}={}){
  const auth=createFeedAuthClient(env);
  const timestamp=()=>{const value=now();return value instanceof Date?value.getTime():value;};

  async function policyFor(owner){
    const response=await auth.getPolicy(owner);
    if(!response.ok)return {ok:false,response};
    return {ok:true,policy:response.data};
  }

  function failure(code,retryable){
    const error=new Error(code);
    error.name='SubscriptionError';
    error.code=code;
    error.retryable=retryable;
    error.status=503;
    return error;
  }

  function validationFailure(message,status=400){
    const error=new Error(message);
    error.name='SubscriptionError';
    error.code='INVALID_REQUEST';
    error.status=status;
    return error;
  }

  async function readCommand(body){
    if(!body||typeof body!=='object'||Array.isArray(body))throw validationFailure('订阅请求格式不正确');
    const allowed=['requestId','name','siteIds','sourceIds','emailMode'];
    if(Object.keys(body).some(key=>!allowed.includes(key)))throw validationFailure('订阅请求格式不正确');
    const requestId=body.requestId;
    if(!/^[A-Za-z0-9._:-]{8,100}$/.test(requestId??''))throw validationFailure('保存请求标识无效，请刷新后重试');
    if(typeof body.name!=='string'||!body.name.trim()||body.name.trim().length>80)throw validationFailure('请填写不超过 80 字的订阅名称');
    if(body.emailMode!==undefined&&!emailModes.has(body.emailMode))throw validationFailure('邮件模式无效');
    const siteIds=normalizeIds(body.siteIds??[],'siteIds');
    const sourceIds=normalizeIds(body.sourceIds??[],'sourceIds');
    if(!siteIds.length&&!sourceIds.length)throw validationFailure('请至少选择一个站点或栏目');
    const command={
      requestId,name:body.name.trim(),
      siteIds,sourceIds,
      emailMode:body.emailMode??'daily_digest',
    };
    command.hash=await sha(JSON.stringify({
      name:command.name,emailMode:command.emailMode,siteIds,sourceIds,
    }));
    return command;
  }

  async function expandTargets(command){
    const sources=await createSources(env).all();
    const available=sources.filter(source=>source.enabled&&source.siteEnabled&&source.validationState==='verified');
    const byId=new Map(available.map(source=>[source.id,source]));
    const selected=new Set(command.sourceIds);
    for(const siteId of command.siteIds){
      const siteSources=available.filter(source=>source.siteId===siteId);
      if(!siteSources.length)throw validationFailure('所选站点暂时没有可订阅栏目',404);
      for(const source of siteSources)selected.add(source.id);
    }
    if(command.sourceIds.some(sourceId=>!byId.has(sourceId)))throw validationFailure('部分所选栏目暂不可订阅，请刷新栏目列表',404);
    return [...selected].sort();
  }

  async function requestFor(owner,requestId){
    return await env.DB.prepare(`SELECT r.command_hash AS commandHash,r.subscription_id AS subscriptionId,
      s.id,s.owner_sub AS ownerSub,s.name,s.requested_enabled AS requestedEnabled,s.priority,s.email_mode AS emailMode,
      s.activated_at AS activatedAt,s.created_at AS createdAt,s.deleted_at AS deletedAt,
      s.rss_token_generation AS rssTokenGeneration,s.rss_token_ciphertext AS rssTokenCiphertext,s.rss_revoked_at AS rssRevokedAt
      FROM subscription_requests r JOIN subscriptions s ON s.id=r.subscription_id
      WHERE r.owner_sub=? AND r.request_id=?`).bind(owner,requestId).first();
  }

  async function subscriptionView(row,policyState,rank){
    const rows=await env.DB.prepare(`SELECT t.source_id AS sourceId,t.effective_from AS effectiveFrom,s.name AS sourceName
      FROM subscription_sources t JOIN sources s ON s.id=t.source_id WHERE t.subscription_id=? AND t.removed_at IS NULL ORDER BY t.source_id`).bind(row.id).all();
    return {
      id:row.id,name:row.name,requestedEnabled:row.requestedEnabled===1,priority:row.priority,
      emailMode:row.emailMode,activatedAt:new Date(row.activatedAt).toISOString(),
      createdAt:new Date(row.createdAt).toISOString(),
      targetSourceIds:rows.results.map(target=>target.sourceId),
      targets:rows.results.map(target=>({sourceId:target.sourceId,sourceName:target.sourceName,effectiveFrom:new Date(target.effectiveFrom).toISOString()})),
      effectiveStatus:effectiveStatus(row,policyState,rank),
      rssUrl:await rssUrlForOwner(env,row),
    };
  }

  function effectiveStatus(row,policyState,rank){
    if(policyState.status==='auth_unavailable')return 'auth_unavailable';
    if(!policyState.policy.access)return 'access_revoked';
    if(row.requestedEnabled!==1)return 'paused';
    const limit=policyState.policy.subscriptionLimit;
    if(limit.kind==='missing')return 'quota_exceeded';
    if(limit.kind==='limited'&&rank>=limit.value)return 'quota_exceeded';
    return 'active';
  }

  async function readSubscription(id){
    return await env.DB.prepare(`SELECT id,owner_sub AS ownerSub,name,requested_enabled AS requestedEnabled,priority,
      email_mode AS emailMode,activated_at AS activatedAt,created_at AS createdAt,deleted_at AS deletedAt,
      rss_token_generation AS rssTokenGeneration,rss_token_ciphertext AS rssTokenCiphertext,rss_revoked_at AS rssRevokedAt FROM subscriptions WHERE id=?`).bind(id).first();
  }

  async function replay(owner,row,created){
    const policyState=await currentPolicyState(owner);
    const rank=await rankFor(row);
    return {
      created,
      subscription:await subscriptionView(row,policyState,rank),
    };
  }

  async function currentPolicyState(owner){
    const current=await policyFor(owner);
    if(!current.ok){
      return {status:'auth_unavailable',policy:{access:false,subscriptionLimit:{kind:'missing'}}};
    }
    return {status:'available',policy:current.policy};
  }

  async function rankFor(row){
    const rank=await env.DB.prepare(`SELECT COUNT(*) AS rank FROM subscriptions
      WHERE owner_sub=? AND deleted_at IS NULL AND requested_enabled=1
        AND (priority<? OR (priority=? AND (created_at<? OR (created_at=? AND id<?))))`)
      .bind(row.ownerSub,row.priority,row.priority,row.createdAt,row.createdAt,row.id).first();
    return rank.rank;
  }

  return {
    async change(actor,command){
      const owner=actorId(actor);
      const input=await readCommand(command);
      const existing=await requestFor(owner,input.requestId);
      if(existing){
        if(existing.commandHash!==input.hash)throw validationFailure('本次保存请求对应其他内容，请刷新后重新提交',409);
        if(existing.deletedAt!==null)throw validationFailure('本次保存请求对应已删除的订阅',409);
        return replay(owner,existing,false);
      }

      const before=await policyFor(owner);
      if(!before.ok)throw failure(before.response.code,before.response.retryable);
      const policy=before.policy;
      if(!policy.access)throw validationFailure('需要 Feed 访问权益才能新增订阅',403);
      const limit=policy.subscriptionLimit;
      if(limit.kind==='missing'||(limit.kind==='limited'&&limit.value<1)){
        throw validationFailure('当前未获得新增订阅额度',403);
      }

      const targetSourceIds=await expandTargets(input);
      const id=randomId(),at=timestamp(),token=rssToken(),tokenHash=await sha(token);
      const ciphertext=await sealRssToken(env,{id,ownerSub:owner,rssTokenGeneration:1},token);
      const limited=limit.kind==='limited';
      const insert=limited
        ? env.DB.prepare(`INSERT INTO subscriptions(id,owner_sub,name,requested_enabled,priority,email_mode,activated_at,created_at,rss_token_hash,rss_token_ciphertext,rss_token_generation)
          SELECT ?,?,?,1,100,?,?,?,?,?,1
          WHERE NOT EXISTS(SELECT 1 FROM subscription_requests WHERE owner_sub=? AND request_id=? AND subscription_id<>?)
            AND (SELECT COUNT(*) FROM subscriptions WHERE owner_sub=? AND deleted_at IS NULL)<?`)
          .bind(id,owner,input.name,input.emailMode,at,at,tokenHash,ciphertext,owner,input.requestId,id,owner,limit.value)
        : env.DB.prepare(`INSERT INTO subscriptions(id,owner_sub,name,requested_enabled,priority,email_mode,activated_at,created_at,rss_token_hash,rss_token_ciphertext,rss_token_generation)
          SELECT ?,?,?,1,100,?,?,?,?,?,1
          WHERE NOT EXISTS(SELECT 1 FROM subscription_requests WHERE owner_sub=? AND request_id=? AND subscription_id<>?)`)
          .bind(id,owner,input.name,input.emailMode,at,at,tokenHash,ciphertext,owner,input.requestId,id);
      const statements=[insert];
      for(const sourceId of targetSourceIds){
        const targetId=await sha(`subscription-source:${id}:${sourceId}`);
        statements.push(env.DB.prepare(`INSERT INTO subscription_sources(id,subscription_id,source_id,effective_from)
          SELECT ?,?, ?,? FROM subscriptions WHERE id=? AND owner_sub=?`).bind(targetId.slice(0,24),id,sourceId,at,id,owner));
      }
      statements.push(env.DB.prepare(`INSERT INTO subscription_requests(owner_sub,request_id,command_hash,subscription_id,created_at)
        SELECT ?,?,?,?,? FROM subscriptions WHERE id=? AND owner_sub=?`).bind(owner,input.requestId,input.hash,id,at,id,owner));
      const committed=await env.DB.batch(statements);
      if(!committed[0].meta?.changes){
        const raced=await requestFor(owner,input.requestId);
        if(raced){
          if(raced.commandHash!==input.hash)throw validationFailure('本次保存请求对应其他内容，请刷新后重新提交',409);
          return replay(owner,raced,false);
        }
        throw validationFailure('当前订阅额度已用满',403);
      }

      const row=await readSubscription(id);
      const policyState=await currentPolicyState(owner);
      const rank=await rankFor(row);
      return {
        created:true,
        subscription:await subscriptionView(row,policyState,rank),
      };
    },

    async list(actor){
      const owner=actorId(actor);
      const policyState=await currentPolicyState(owner);
      const sources=(await createSources(env).all()).filter(source=>
        source.enabled&&source.siteEnabled&&source.validationState==='verified');
      const availableSiteIds=new Set(sources.map(source=>source.siteId));
      const sites=(await createSources(env).listSites()).filter(site=>site.enabled&&availableSiteIds.has(site.id));
      const rows=await env.DB.prepare(`SELECT id,owner_sub AS ownerSub,name,requested_enabled AS requestedEnabled,priority,
        email_mode AS emailMode,activated_at AS activatedAt,created_at AS createdAt,deleted_at AS deletedAt,
        rss_token_generation AS rssTokenGeneration,rss_token_ciphertext AS rssTokenCiphertext,rss_revoked_at AS rssRevokedAt
        FROM subscriptions WHERE owner_sub=? AND deleted_at IS NULL ORDER BY priority,created_at,id`).bind(owner).all();
      const subscriptions=[];
      let runningRank=0;
      for(const row of rows.results){
        const rank=row.requestedEnabled===1?runningRank++:Number.POSITIVE_INFINITY;
        subscriptions.push(await subscriptionView(row,policyState,rank));
      }
      const usage=subscriptions.length;
      return {
        subscriptions,
        policy:policyState.status==='available'?{
          status:'available',access:policyState.policy.access,subscriptionLimit:policyState.policy.subscriptionLimit,
        }:{status:policyState.status},
        usage,
        sites:sites.map(site=>({id:site.id,name:site.name})),
        sources:sources.map(source=>({id:source.id,siteId:source.siteId,name:source.name})),
        outputChannels:{
          rss:{enabled:false,reason:'pending_t09'},
          email:{enabled:false,reason:'pending_t11'},
        },
      };
    },
  };
}

export async function subscriptionsRoute(request,env,state){
  const url=new URL(request.url);
  if(url.pathname!=='/api/subscriptions')return null;
  if(!state.authenticated)return json({error:'请先登录'},401);
  const subscriptions=createSubscriptions(env);
  if(request.method==='GET'){
    const result=await subscriptions.list({id:state.user.id});
    return json(result);
  }
  if(request.method!=='POST')return json({error:'Method not allowed'},405);
  if(request.headers.get('Origin')!==new URL(env.BASE_URL).origin)return json({error:'invalid_origin'},403);
  let body;
  try{
    const bytes=new Uint8Array(await request.arrayBuffer());
    if(bytes.byteLength>65536)return json({error:'JSON body too large'},400);
    body=JSON.parse(new TextDecoder().decode(bytes));
  }catch{
    return json({error:'Invalid JSON'},400);
  }
  try{
    const result=await subscriptions.change({id:state.user.id},body);
    return json(result,result.created?201:200);
  }catch(error){
    if(error.name!=='SubscriptionError')throw error;
    if(error.code==='AUTH_UNAVAILABLE')return json({error:'认证服务暂时不可用，请稍后重试',code:error.code},503);
    return json({error:error.message,code:error.code??'INVALID_REQUEST'},error.status??400);
  }
}

function actorId(actor){
  if(typeof actor?.id!=='string'||!actor.id)throw subscriptionError('INVALID_REQUEST','A verified actor is required',400);
  return actor.id;
}

function subscriptionError(code,message,status){
  const error=new Error(message);error.name='SubscriptionError';error.code=code;error.status=status;return error;
}

function normalizeIds(value,field){
  if(!Array.isArray(value)||value.some(id=>typeof id!=='string'))throw subscriptionError('INVALID_REQUEST',`${field} must be an array of IDs`,400);
  return [...new Set(value)].sort();
}

function randomId(){
  const bytes=crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

function rssToken(){
  const bytes=crypto.getRandomValues(new Uint8Array(32));
  let binary='';
  for(const byte of bytes)binary+=String.fromCharCode(byte);
  return btoa(binary).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
}
