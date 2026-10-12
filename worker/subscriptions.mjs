import {json,sha} from './utils.mjs';
import {sealRssToken,rssUrlForOwner} from './subscription-credentials.mjs';
import {computeSubscriptionRuntime} from './subscription-runtime.mjs';
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
      s.rss_token_generation AS rssTokenGeneration,s.rss_token_ciphertext AS rssTokenCiphertext,
      s.rss_revoked_at IS NOT NULL AS rssRevoked,
      s.deleted_at IS NOT NULL AS deleted,s.config_version AS configVersion
      FROM subscription_requests r JOIN subscriptions s ON s.id=r.subscription_id
      WHERE r.owner_sub=? AND r.request_id=?`).bind(owner,requestId).first();
  }

  async function commandFor(owner,requestId){
    return await env.DB.prepare(`SELECT owner_sub AS ownerSub,request_id AS requestId,subscription_id AS subscriptionId,
      command_kind AS commandKind,command_hash AS commandHash,result_version AS resultVersion,created_at AS createdAt
      FROM subscription_commands WHERE owner_sub=? AND request_id=?`).bind(owner,requestId).first();
  }

  async function subscriptionView(row,runtime){
    const rows=await env.DB.prepare(`SELECT t.source_id AS sourceId,t.effective_from AS effectiveFrom,s.name AS sourceName
      FROM subscription_sources t JOIN sources s ON s.id=t.source_id WHERE t.subscription_id=? AND t.removed_at IS NULL ORDER BY t.source_id`).bind(row.id).all();
    const savedRows=await env.DB.prepare(`SELECT source_id AS sourceId FROM subscription_sources
      WHERE subscription_id=? AND (removed_at IS NULL OR removed_at=?) GROUP BY source_id ORDER BY source_id`)
      .bind(row.id,row.deletedAt??null).all();
    return {
      id:row.id,name:row.name,requestedEnabled:row.requestedEnabled===1,priority:row.priority,version:row.configVersion,
      emailMode:row.emailMode,activatedAt:new Date(row.activatedAt).toISOString(),
      createdAt:new Date(row.createdAt).toISOString(),
      deletedAt:row.deletedAt===null||row.deletedAt===undefined?null:new Date(row.deletedAt).toISOString(),
      targetSourceIds:rows.results.map(target=>target.sourceId),
      savedSourceIds:savedRows.results.map(target=>target.sourceId),
      targets:rows.results.map(target=>({sourceId:target.sourceId,sourceName:target.sourceName,effectiveFrom:new Date(target.effectiveFrom).toISOString()})),
      effectiveStatus:runtime.effectiveStatus,
      selected:runtime.selected,
      rssStatus:runtime.rssStatus,
      emailStatus:runtime.emailStatus,
      rssUrl:row.rssRevoked===1?null:await rssUrlForOwner(env,row),
    };
  }

  async function readSubscription(id){
    return await env.DB.prepare(`SELECT id,owner_sub AS ownerSub,name,requested_enabled AS requestedEnabled,priority,
      email_mode AS emailMode,activated_at AS activatedAt,created_at AS createdAt,deleted_at AS deletedAt,
      rss_token_generation AS rssTokenGeneration,rss_token_ciphertext AS rssTokenCiphertext,
      rss_revoked_at IS NOT NULL AS rssRevoked,deleted_at IS NOT NULL AS deleted,
      config_version AS configVersion FROM subscriptions WHERE id=?`).bind(id).first();
  }

  async function ownedSubscription(owner,subscriptionId){
    const row=await env.DB.prepare(`SELECT id,owner_sub AS ownerSub,name,requested_enabled AS requestedEnabled,priority,
      email_mode AS emailMode,activated_at AS activatedAt,created_at AS createdAt,deleted_at AS deleted_at,
      rss_token_generation AS rssTokenGeneration,rss_token_ciphertext AS rssTokenCiphertext,
      rss_revoked_at IS NOT NULL AS rssRevoked,deleted_at IS NOT NULL AS deleted,
      config_version AS configVersion FROM subscriptions WHERE id=? AND owner_sub=?`).bind(subscriptionId,owner).first();
    if(!row)return null;
    const targets=await env.DB.prepare(`SELECT source_id AS sourceId FROM subscription_sources
      WHERE subscription_id=? AND removed_at IS NULL ORDER BY source_id`).bind(subscriptionId).all();
    return {...row,targetSourceIds:targets.results.map(target=>target.sourceId)};
  }

  async function runtimeFor(owner){
    const account=await auth.getRecipient(owner);
    const policyState=account.ok
      ?{status:'available',policy:account.data.policy}
      :{status:'auth_unavailable',policy:{access:false,subscriptionLimit:{kind:'missing'}}};
    const rows=await env.DB.prepare(`SELECT id,owner_sub AS ownerSub,name,requested_enabled AS requestedEnabled,priority,
      email_mode AS emailMode,activated_at AS activatedAt,created_at AS createdAt,deleted_at AS deletedAt,
      rss_token_generation AS rssTokenGeneration,rss_token_ciphertext AS rssTokenCiphertext,
      rss_revoked_at IS NOT NULL AS rssRevoked,deleted_at IS NOT NULL AS deleted,
      config_version AS configVersion FROM subscriptions WHERE owner_sub=?`).bind(owner).all();
    const recipientStatus=account.ok?account.data.recipient.status:'unverified';
    const runtimes=computeSubscriptionRuntime(rows.results,policyState,recipientStatus);
    return {policyState,rows:rows.results,runtimes};
  }

  async function replay(owner,row,created){
    const {runtimes}=await runtimeFor(owner);
    return {
      created,
      subscription:await subscriptionView(row,runtimes.get(row.id)),
    };
  }

  async function readUpdateCommand(body,kind='update'){
    if(!body||typeof body!=='object'||Array.isArray(body))throw validationFailure('订阅请求格式不正确');
    const allowed=['requestId','expectedVersion','name','sourceIds','emailMode','requestedEnabled','priority'];
    if(Object.keys(body).some(key=>!allowed.includes(key)))throw validationFailure('订阅请求格式不正确');
    const requestId=body.requestId;
    if(!/^[A-Za-z0-9._:-]{8,100}$/.test(requestId??''))throw validationFailure('保存请求标识无效，请刷新后重试');
    if(!Number.isSafeInteger(body.expectedVersion)||body.expectedVersion<1)throw validationFailure('订阅版本无效，请刷新后重试');
    if(typeof body.name!=='string'||!body.name.trim()||body.name.trim().length>80)throw validationFailure('请填写不超过 80 字的订阅名称');
    if(!emailModes.has(body.emailMode))throw validationFailure('邮件模式无效');
    if(typeof body.requestedEnabled!=='boolean')throw validationFailure('启用状态无效');
    if(!Number.isSafeInteger(body.priority)||body.priority<0||body.priority>1_000_000_000)throw validationFailure('订阅优先级无效');
    const sourceIds=normalizeIds(body.sourceIds,'sourceIds');
    if(!sourceIds.length)throw validationFailure('请至少选择一个栏目');
    const command={requestId,expectedVersion:body.expectedVersion,name:body.name.trim(),sourceIds,emailMode:body.emailMode,
      requestedEnabled:body.requestedEnabled,priority:body.priority};
    command.hash=await sha(JSON.stringify({kind,subscriptionCommand:command}));
    return command;
  }

  async function readVersionCommand(body,kind){
    if(!body||typeof body!=='object'||Array.isArray(body))throw validationFailure('订阅请求格式不正确');
    const allowed=['requestId','expectedVersion'];
    if(Object.keys(body).some(key=>!allowed.includes(key)))throw validationFailure('订阅请求格式不正确');
    const requestId=body.requestId;
    if(!/^[A-Za-z0-9._:-]{8,100}$/.test(requestId??''))throw validationFailure('保存请求标识无效，请刷新后重试');
    if(!Number.isSafeInteger(body.expectedVersion)||body.expectedVersion<1)throw validationFailure('订阅版本无效，请刷新后重试');
    const command={requestId,expectedVersion:body.expectedVersion};
    command.hash=await sha(JSON.stringify({kind,subscriptionCommand:command}));
    return command;
  }

  async function exactTargets(sourceIds,existingSourceIds=[]){
    const sources=await createSources(env).all();
    const available=new Set(sources.filter(source=>source.enabled&&source.siteEnabled&&source.validationState==='verified').map(source=>source.id));
    const existing=new Set(existingSourceIds);
    if(sourceIds.some(sourceId=>!existing.has(sourceId)&&!available.has(sourceId))){
      throw validationFailure('部分所选栏目暂不可订阅，请刷新栏目列表',404);
    }
    return [...sourceIds].sort();
  }

  async function replayUpdate(owner,row,changed){
    const {runtimes}=await runtimeFor(owner);
    return {changed,subscription:await subscriptionView(row,runtimes.get(row.id))};
  }

  return {
    async change(actor,command){
      const owner=actorId(actor);
      const input=await readCommand(command);
      const existing=await requestFor(owner,input.requestId);
      if(existing){
        if(existing.commandHash!==input.hash)throw validationFailure('本次保存请求对应其他内容，请刷新后重新提交',409);
        if(existing.deleted===1||existing.deletedAt!==null&&existing.deletedAt!==undefined){
          throw validationFailure('本次保存请求对应已删除的订阅',409);
        }
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
      statements.push(env.DB.prepare(`INSERT INTO feed_accounts(auth_sub,active_subscription_count,updated_at)
        SELECT ?,1,? FROM subscriptions WHERE id=? AND owner_sub=?
        ON CONFLICT(auth_sub) DO UPDATE SET active_subscription_count=feed_accounts.active_subscription_count+1,updated_at=excluded.updated_at`)
        .bind(owner,at,id,owner));
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
      const {runtimes}=await runtimeFor(owner);
      return {
        created:true,
        subscription:await subscriptionView(row,runtimes.get(row.id)),
      };
    },

    async update(actor,subscriptionId,body){
      const owner=actorId(actor);
      if(!/^[a-f0-9]{24}$/.test(subscriptionId??''))throw validationFailure('订阅不存在',404);
      const input=await readUpdateCommand(body);
      let row=await ownedSubscription(owner,subscriptionId);
      if(!row)throw validationFailure('订阅不存在',404);

      const existing=await commandFor(owner,input.requestId);
      if(existing){
        if(existing.subscriptionId!==subscriptionId||existing.commandKind!=='update'||existing.commandHash!==input.hash){
          throw validationFailure('本次保存请求对应其他内容，请刷新后重新提交',409);
        }
        if(row.configVersion===existing.resultVersion)return replayUpdate(owner,row,false);
        throw validationFailure('订阅已被后续操作修改，请刷新后重试',409);
      }
      if(row.deleted===1||row.deletedAt!==null&&row.deletedAt!==undefined){
        throw validationFailure('订阅已删除，请先恢复后再编辑',409);
      }

      const targetSourceIds=await exactTargets(input.sourceIds,row.targetSourceIds);
      const expandsCapability=(input.requestedEnabled&&!row.requestedEnabled)
        ||targetSourceIds.some(sourceId=>!row.targetSourceIds.includes(sourceId));
      if(expandsCapability){
        const before=await policyFor(owner);
        if(!before.ok)throw failure(before.response.code,before.response.retryable);
        if(!before.policy.access)throw validationFailure('需要 Feed 访问权益才能扩大订阅输出',403);
      }

      const at=timestamp(),nextVersion=input.expectedVersion+1;
      const commandGuard=`EXISTS(SELECT 1 FROM subscription_commands c
        WHERE c.owner_sub=? AND c.request_id=? AND c.subscription_id=? AND c.command_kind='update' AND c.command_hash=? AND c.result_version=?)`;
      const commandArgs=[owner,input.requestId,subscriptionId,input.hash];
      const derivedGuard=`EXISTS(SELECT 1 FROM subscriptions s
        JOIN subscription_commands c ON c.subscription_id=s.id AND c.owner_sub=s.owner_sub
        WHERE s.id=? AND s.owner_sub=? AND s.config_version=?
          AND c.owner_sub=? AND c.request_id=? AND c.subscription_id=? AND c.command_kind='update' AND c.command_hash=? AND c.result_version=?)`;
      const derivedArgs=[subscriptionId,owner,nextVersion,...commandArgs,input.expectedVersion];
      const statements=[
        env.DB.prepare(`INSERT INTO subscription_commands(owner_sub,request_id,subscription_id,command_kind,command_hash,result_version,created_at)
          SELECT ?,?,?,?,?,?,? FROM subscriptions WHERE id=? AND owner_sub=? AND config_version=?
          ON CONFLICT(owner_sub,request_id) DO NOTHING`)
          .bind(owner,input.requestId,subscriptionId,'update',input.hash,input.expectedVersion,at,subscriptionId,owner,input.expectedVersion),
        env.DB.prepare(`UPDATE subscriptions SET name=?,requested_enabled=?,priority=?,email_mode=?,config_version=?
          WHERE id=? AND owner_sub=? AND config_version=? AND ${commandGuard} RETURNING config_version`)
          .bind(input.name,input.requestedEnabled?1:0,input.priority,input.emailMode,nextVersion,
            subscriptionId,owner,input.expectedVersion,...commandArgs,input.expectedVersion),
      ];
      const removedPlaceholders=targetSourceIds.map(()=>'?').join(',');
      statements.push(env.DB.prepare(`UPDATE subscription_sources SET removed_at=?
        WHERE subscription_id=? AND removed_at IS NULL AND source_id NOT IN (${removedPlaceholders})
          AND ${derivedGuard}`)
        .bind(at,subscriptionId,...targetSourceIds,...derivedArgs));
      for(const sourceId of targetSourceIds){
        const targetId=(await sha(`subscription-source:${subscriptionId}:${sourceId}:${at}`)).slice(0,24);
        statements.push(env.DB.prepare(`INSERT INTO subscription_sources(id,subscription_id,source_id,effective_from)
          SELECT ?,?,?,? FROM subscriptions
          WHERE id=? AND owner_sub=? AND config_version=? AND ${derivedGuard}
            AND NOT EXISTS(SELECT 1 FROM subscription_sources WHERE subscription_id=? AND source_id=? AND removed_at IS NULL)`)
          .bind(targetId,subscriptionId,sourceId,at,subscriptionId,owner,nextVersion,...derivedArgs,subscriptionId,sourceId));
      }
      if(input.priority!==row.priority){
        statements.push(env.DB.prepare(`INSERT INTO feed_accounts(auth_sub,preference_revision,updated_at)
          SELECT ?,?,? FROM subscriptions WHERE id=? AND owner_sub=? AND config_version=? AND ${derivedGuard}
          ON CONFLICT(auth_sub) DO UPDATE SET preference_revision=preference_revision+1,updated_at=excluded.updated_at`)
          .bind(owner,1,at,subscriptionId,owner,nextVersion,...derivedArgs));
      }
      statements.push(env.DB.prepare(`UPDATE subscription_commands SET result_version=?
        WHERE owner_sub=? AND request_id=? AND subscription_id=? AND command_kind='update' AND command_hash=? AND result_version=?
          AND EXISTS(SELECT 1 FROM subscriptions WHERE id=subscription_id AND owner_sub=owner_sub AND config_version=?)`)
        .bind(nextVersion,...commandArgs,input.expectedVersion,nextVersion));

      const committed=await env.DB.batch(statements);
      if(!committed[1].meta?.changes){
        row=await ownedSubscription(owner,subscriptionId);
        const raced=await commandFor(owner,input.requestId);
        if(row&&raced&&raced.subscriptionId===subscriptionId&&raced.commandKind==='update'
          &&raced.commandHash===input.hash&&row.configVersion===raced.resultVersion){
          return replayUpdate(owner,row,false);
        }
        throw validationFailure('订阅已被其他操作修改，请刷新后重试',409);
      }
      const {runtimes}=await runtimeFor(owner);
      row=await readSubscription(subscriptionId);
      return replayUpdate(owner,row,true);
    },

    async delete(actor,subscriptionId,body){
      const owner=actorId(actor);
      if(!/^[a-f0-9]{24}$/.test(subscriptionId??''))throw validationFailure('订阅不存在',404);
      const input=await readVersionCommand(body,'delete');
      let row=await ownedSubscription(owner,subscriptionId);
      if(!row)throw validationFailure('订阅不存在',404);

      const existing=await commandFor(owner,input.requestId);
      if(existing){
        if(existing.subscriptionId!==subscriptionId||existing.commandKind!=='delete'||existing.commandHash!==input.hash){
          throw validationFailure('本次保存请求对应其他内容，请刷新后重新提交',409);
        }
        if(row.configVersion===existing.resultVersion)return replayUpdate(owner,row,false);
        throw validationFailure('订阅已被后续操作修改，请刷新后重试',409);
      }
      if(row.deleted===1||row.deletedAt!==null&&row.deletedAt!==undefined){
        throw validationFailure('订阅已删除，不能重复删除',409);
      }

      const at=timestamp(),nextVersion=input.expectedVersion+1;
      const commandArgs=[owner,input.requestId,subscriptionId,'delete',input.hash];
      const commandGuard=`EXISTS(SELECT 1 FROM subscription_commands c
        WHERE c.owner_sub=? AND c.request_id=? AND c.subscription_id=? AND c.command_kind=? AND c.command_hash=? AND c.result_version=?)`;
      const derivedGuard=`EXISTS(SELECT 1 FROM subscriptions s
        JOIN subscription_commands c ON c.subscription_id=s.id AND c.owner_sub=s.owner_sub
        WHERE s.id=? AND s.owner_sub=? AND s.config_version=?
          AND c.owner_sub=? AND c.request_id=? AND c.subscription_id=? AND c.command_kind=? AND c.command_hash=? AND c.result_version=?)`;
      const derivedArgs=[subscriptionId,owner,nextVersion,...commandArgs,input.expectedVersion];
      const statements=[
        env.DB.prepare(`INSERT INTO subscription_commands(owner_sub,request_id,subscription_id,command_kind,command_hash,result_version,created_at)
          SELECT ?,?,?,?,?,?,? FROM subscriptions WHERE id=? AND owner_sub=? AND config_version=? AND deleted_at IS NULL
          ON CONFLICT(owner_sub,request_id) DO NOTHING`)
          .bind(owner,input.requestId,subscriptionId,'delete',input.hash,input.expectedVersion,at,subscriptionId,owner,input.expectedVersion),
        env.DB.prepare(`UPDATE subscriptions SET deleted_at=?,rss_revoked_at=?,config_version=?
          WHERE id=? AND owner_sub=? AND config_version=? AND deleted_at IS NULL AND ${commandGuard} RETURNING config_version`)
          .bind(at,at,nextVersion,subscriptionId,owner,input.expectedVersion,...commandArgs,input.expectedVersion),
        env.DB.prepare(`UPDATE subscription_sources SET removed_at=?
          WHERE subscription_id=? AND removed_at IS NULL AND ${derivedGuard}`)
          .bind(at,subscriptionId,...derivedArgs),
        env.DB.prepare(`UPDATE feed_accounts SET active_subscription_count=CASE
            WHEN active_subscription_count>0 THEN active_subscription_count-1 ELSE 0 END,reservation_request_id=NULL
          WHERE auth_sub=? AND ${derivedGuard}`)
          .bind(owner,...derivedArgs),
        env.DB.prepare(`UPDATE subscription_commands SET result_version=?
          WHERE owner_sub=? AND request_id=? AND subscription_id=? AND command_kind=? AND command_hash=? AND result_version=?
          AND EXISTS(SELECT 1 FROM subscriptions WHERE id=subscription_id AND owner_sub=owner_sub AND config_version=?)`)
          .bind(nextVersion,...commandArgs,input.expectedVersion,nextVersion),
      ];
      const committed=await env.DB.batch(statements);
      if(!committed[1].meta?.changes){
        row=await ownedSubscription(owner,subscriptionId);
        const raced=await commandFor(owner,input.requestId);
        if(row&&raced&&raced.subscriptionId===subscriptionId&&raced.commandKind==='delete'
          &&raced.commandHash===input.hash&&row.configVersion===raced.resultVersion){
          return replayUpdate(owner,row,false);
        }
        throw validationFailure('订阅已被其他操作修改，请刷新后重试',409);
      }
      row=await readSubscription(subscriptionId);
      return replayUpdate(owner,row,true);
    },

    async restore(actor,subscriptionId,body){
      const owner=actorId(actor);
      if(!/^[a-f0-9]{24}$/.test(subscriptionId??''))throw validationFailure('订阅不存在',404);
      const input=await readUpdateCommand(body,'restore');
      let row=await ownedSubscription(owner,subscriptionId);
      if(!row)throw validationFailure('订阅不存在',404);

      const existing=await commandFor(owner,input.requestId);
      if(existing){
        if(existing.subscriptionId!==subscriptionId||existing.commandKind!=='restore'||existing.commandHash!==input.hash){
          throw validationFailure('本次保存请求对应其他内容，请刷新后重新提交',409);
        }
        if(row.configVersion===existing.resultVersion)return replayUpdate(owner,row,false);
        throw validationFailure('订阅已被后续操作修改，请刷新后重试',409);
      }
      if(!(row.deleted===1||row.deletedAt!==null&&row.deletedAt!==undefined)){
        throw validationFailure('订阅未删除，不能恢复',409);
      }

      const targetSourceIds=await exactTargets(input.sourceIds,[]);
      const before=await policyFor(owner);
      if(!before.ok)throw failure(before.response.code,before.response.retryable);
      if(!before.policy.access)throw validationFailure('需要 Feed 访问权益才能恢复订阅',403);
      const limit=before.policy.subscriptionLimit;
      if(limit.kind==='missing'||(limit.kind==='limited'&&limit.value<1)){
        throw validationFailure('当前未获得恢复订阅额度',403);
      }

      const at=timestamp(),nextVersion=input.expectedVersion+1;
      const token=rssToken(),tokenHash=await sha(token);
      const ciphertext=await sealRssToken(env,{id:subscriptionId,ownerSub:owner,rssTokenGeneration:row.rssTokenGeneration+1},token);
      const commandArgs=[owner,input.requestId,subscriptionId,'restore',input.hash];
      const commandGuard=`EXISTS(SELECT 1 FROM subscription_commands c
        WHERE c.owner_sub=? AND c.request_id=? AND c.subscription_id=? AND c.command_kind=? AND c.command_hash=? AND c.result_version=?)`;
      const derivedGuard=`EXISTS(SELECT 1 FROM subscriptions s
        JOIN subscription_commands c ON c.subscription_id=s.id AND c.owner_sub=s.owner_sub
        WHERE s.id=? AND s.owner_sub=? AND s.config_version=?
          AND c.owner_sub=? AND c.request_id=? AND c.subscription_id=? AND c.command_kind=? AND c.command_hash=? AND c.result_version=?)`;
      const derivedArgs=[subscriptionId,owner,nextVersion,...commandArgs,input.expectedVersion];
      const quotaGuard=limit.kind==='limited'
        ?` AND (SELECT COUNT(*) FROM subscriptions WHERE owner_sub=? AND deleted_at IS NULL)<?`
        :'';
      const reservationGuard=`feed_accounts.reservation_request_id IS NULL OR feed_accounts.reservation_request_id<>?`;
      const statements=[
        env.DB.prepare(`INSERT INTO subscription_commands(owner_sub,request_id,subscription_id,command_kind,command_hash,result_version,created_at)
          SELECT ?,?,?,?,?,?,? FROM subscriptions WHERE id=? AND owner_sub=? AND config_version=? AND deleted_at IS NOT NULL
          ON CONFLICT(owner_sub,request_id) DO NOTHING`)
          .bind(owner,input.requestId,subscriptionId,'restore',input.hash,input.expectedVersion,at,subscriptionId,owner,input.expectedVersion),
        env.DB.prepare(`INSERT INTO feed_accounts(auth_sub,active_subscription_count,reservation_request_id,updated_at)
          SELECT ?,1,?,? FROM subscriptions s JOIN subscription_commands c
            ON c.subscription_id=s.id AND c.owner_sub=s.owner_sub
          WHERE s.id=? AND s.owner_sub=? AND s.config_version=? AND s.deleted_at IS NOT NULL
            AND c.owner_sub=? AND c.request_id=? AND c.subscription_id=? AND c.command_kind='restore'
            AND c.command_hash=? AND c.result_version=?
          ON CONFLICT(auth_sub) DO UPDATE SET active_subscription_count=feed_accounts.active_subscription_count+1,
            reservation_request_id=excluded.reservation_request_id,updated_at=excluded.updated_at
            WHERE (${reservationGuard})${limit.kind==='limited'?' AND feed_accounts.active_subscription_count<?':''}`)
          .bind(owner,input.requestId,at,subscriptionId,owner,input.expectedVersion,
            owner,input.requestId,subscriptionId,input.hash,input.expectedVersion,
            input.requestId,...(limit.kind==='limited'?[limit.value]:[])),
        env.DB.prepare(`UPDATE subscriptions SET name=?,requested_enabled=?,priority=?,email_mode=?,deleted_at=NULL,
          rss_token_hash=?,rss_token_ciphertext=?,rss_token_generation=?,rss_revoked_at=NULL,config_version=?
          WHERE id=? AND owner_sub=? AND config_version=? AND deleted_at IS NOT NULL${quotaGuard}
            AND EXISTS(SELECT 1 FROM feed_accounts a WHERE a.auth_sub=? AND a.active_subscription_count>0 AND a.reservation_request_id=?)
            AND ${commandGuard} RETURNING config_version`)
          .bind(input.name,input.requestedEnabled?1:0,input.priority,input.emailMode,tokenHash,ciphertext,row.rssTokenGeneration+1,
            nextVersion,subscriptionId,owner,input.expectedVersion,...(limit.kind==='limited'?[owner,limit.value]:[]),
            owner,input.requestId,...commandArgs,input.expectedVersion),
      ];
      for(const sourceId of targetSourceIds){
        const targetId=(await sha(`subscription-source:${subscriptionId}:${sourceId}:${at}`)).slice(0,24);
        statements.push(env.DB.prepare(`INSERT INTO subscription_sources(id,subscription_id,source_id,effective_from)
          SELECT ?,?,?,? FROM subscriptions WHERE id=? AND owner_sub=? AND config_version=? AND ${derivedGuard}
            AND NOT EXISTS(SELECT 1 FROM subscription_sources WHERE subscription_id=? AND source_id=? AND removed_at IS NULL)`)
          .bind(targetId,subscriptionId,sourceId,at,subscriptionId,owner,nextVersion,...derivedArgs,subscriptionId,sourceId));
      }
      statements.push(env.DB.prepare(`UPDATE subscription_commands SET result_version=?
        WHERE owner_sub=? AND request_id=? AND subscription_id=? AND command_kind=? AND command_hash=? AND result_version=?
          AND EXISTS(SELECT 1 FROM subscriptions WHERE id=subscription_id AND owner_sub=owner_sub AND config_version=?)`)
        .bind(nextVersion,...commandArgs,input.expectedVersion,nextVersion));
      statements.push(env.DB.prepare(`UPDATE feed_accounts SET active_subscription_count=CASE
          WHEN active_subscription_count>0 THEN active_subscription_count-1 ELSE 0 END,reservation_request_id=NULL
        WHERE auth_sub=? AND reservation_request_id=?
          AND NOT EXISTS(SELECT 1 FROM subscriptions WHERE id=? AND owner_sub=? AND config_version=?)`)
        .bind(owner,input.requestId,subscriptionId,owner,nextVersion));
      statements.push(env.DB.prepare(`DELETE FROM subscription_commands
        WHERE owner_sub=? AND request_id=? AND subscription_id=? AND command_kind='restore' AND command_hash=? AND result_version=?
          AND NOT EXISTS(SELECT 1 FROM subscriptions WHERE id=? AND owner_sub=? AND config_version=?)`)
        .bind(owner,input.requestId,subscriptionId,input.hash,input.expectedVersion,subscriptionId,owner,nextVersion));

      const committed=await env.DB.batch(statements);
      if(!committed[2].meta?.changes){
        row=await ownedSubscription(owner,subscriptionId);
        const raced=await commandFor(owner,input.requestId);
        if(row&&raced&&raced.subscriptionId===subscriptionId&&raced.commandKind==='restore'
          &&raced.commandHash===input.hash&&row.configVersion===raced.resultVersion
          &&!(row.deleted===1||row.deletedAt!==null&&row.deletedAt!==undefined)){
          return replayUpdate(owner,row,false);
        }
        if(row?.configVersion!==input.expectedVersion)throw validationFailure('订阅已被其他操作修改，请刷新后重试',409);
        throw validationFailure('当前订阅额度已用满',403);
      }
      row=await readSubscription(subscriptionId);
      return replayUpdate(owner,row,true);
    },

    async credentialCommand(actor,subscriptionId,body,kind){
      const owner=actorId(actor);
      if(!/^[a-f0-9]{24}$/.test(subscriptionId??''))throw validationFailure('订阅不存在',404);
      const input=await readVersionCommand(body,kind);
      let row=await ownedSubscription(owner,subscriptionId);
      if(!row)throw validationFailure('订阅不存在',404);

      const existing=await commandFor(owner,input.requestId);
      if(existing){
        if(existing.subscriptionId!==subscriptionId||existing.commandKind!==kind||existing.commandHash!==input.hash){
          throw validationFailure('本次保存请求对应其他内容，请刷新后重新提交',409);
        }
        if(row.configVersion===existing.resultVersion)return replayUpdate(owner,row,false);
        throw validationFailure('订阅已被后续操作修改，请刷新后重试',409);
      }
      if(row.deleted===1||row.deletedAt!==null&&row.deletedAt!==undefined){
        throw validationFailure('订阅已删除，不能管理 RSS 链接',409);
      }

      const at=timestamp(),nextVersion=input.expectedVersion+1;
      const commandArgs=[owner,input.requestId,subscriptionId,kind,input.hash];
      const commandGuard=`EXISTS(SELECT 1 FROM subscription_commands c
        WHERE c.owner_sub=? AND c.request_id=? AND c.subscription_id=? AND c.command_kind=? AND c.command_hash=? AND c.result_version=?)`;
      let credential=[];
      if(kind==='rotate_rss'){
        const token=rssToken(),tokenHash=await sha(token);
        const ciphertext=await sealRssToken(env,{id:subscriptionId,ownerSub:owner,rssTokenGeneration:row.rssTokenGeneration+1},token);
        credential=[tokenHash,ciphertext,row.rssTokenGeneration+1];
      }
      const assignments=kind==='rotate_rss'
        ?'rss_token_hash=?,rss_token_ciphertext=?,rss_token_generation=?,rss_revoked_at=NULL'
        :'rss_revoked_at=?';
      const assignmentArgs=kind==='rotate_rss'?credential:[at];
      const statements=[
        env.DB.prepare(`INSERT INTO subscription_commands(owner_sub,request_id,subscription_id,command_kind,command_hash,result_version,created_at)
          SELECT ?,?,?,?,?,?,? FROM subscriptions WHERE id=? AND owner_sub=? AND config_version=? AND deleted_at IS NULL
          ON CONFLICT(owner_sub,request_id) DO NOTHING`)
          .bind(owner,input.requestId,subscriptionId,kind,input.hash,input.expectedVersion,at,subscriptionId,owner,input.expectedVersion),
        env.DB.prepare(`UPDATE subscriptions SET ${assignments},config_version=?
          WHERE id=? AND owner_sub=? AND config_version=? AND deleted_at IS NULL AND ${commandGuard} RETURNING config_version`)
          .bind(...assignmentArgs,nextVersion,subscriptionId,owner,input.expectedVersion,...commandArgs,input.expectedVersion),
        env.DB.prepare(`UPDATE subscription_commands SET result_version=?
          WHERE owner_sub=? AND request_id=? AND subscription_id=? AND command_kind=? AND command_hash=? AND result_version=?
          AND EXISTS(SELECT 1 FROM subscriptions WHERE id=subscription_id AND owner_sub=owner_sub AND config_version=?)`)
          .bind(nextVersion,...commandArgs,input.expectedVersion,nextVersion),
      ];
      const committed=await env.DB.batch(statements);
      if(!committed[1].meta?.changes){
        row=await ownedSubscription(owner,subscriptionId);
        const raced=await commandFor(owner,input.requestId);
        if(row&&raced&&raced.subscriptionId===subscriptionId&&raced.commandKind===kind
          &&raced.commandHash===input.hash&&row.configVersion===raced.resultVersion){
          return replayUpdate(owner,row,false);
        }
        throw validationFailure('订阅已被其他操作修改，请刷新后重试',409);
      }
      row=await readSubscription(subscriptionId);
      return replayUpdate(owner,row,true);
    },

    async list(actor){
      const owner=actorId(actor);
      const account=await auth.getRecipient(owner);
      const policyState=account.ok
        ?{status:'available',policy:account.data.policy}
        :{status:'auth_unavailable',policy:{access:false,subscriptionLimit:{kind:'missing'}}};
      const sources=(await createSources(env).all()).filter(source=>
        source.enabled&&source.siteEnabled&&source.validationState==='verified');
      const availableSiteIds=new Set(sources.map(source=>source.siteId));
      const sites=(await createSources(env).listSites()).filter(site=>site.enabled&&availableSiteIds.has(site.id));
      const rows=await env.DB.prepare(`SELECT id,owner_sub AS ownerSub,name,requested_enabled AS requestedEnabled,priority,
        email_mode AS emailMode,activated_at AS activatedAt,created_at AS createdAt,deleted_at AS deletedAt,
        rss_token_generation AS rssTokenGeneration,rss_token_ciphertext AS rssTokenCiphertext,
        rss_revoked_at IS NOT NULL AS rssRevoked,deleted_at IS NOT NULL AS deleted,
        config_version AS configVersion
      FROM subscriptions WHERE owner_sub=? ORDER BY priority,created_at,id,deleted_at`).bind(owner).all();
      const subscriptions=[];
      const runtimes=computeSubscriptionRuntime(rows.results,policyState,account.ok?account.data.recipient.status:'unverified');
      for(const row of rows.results)subscriptions.push(await subscriptionView(row,runtimes.get(row.id)));
      const usage=subscriptions.filter(subscription=>subscription.deletedAt===null).length;
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
  const detail=/^\/api\/subscriptions\/([a-f0-9]{24})$/.exec(url.pathname);
  const restore=/^\/api\/subscriptions\/([a-f0-9]{24})\/restore$/.exec(url.pathname);
  const credential=/^\/api\/subscriptions\/([a-f0-9]{24})\/rss\/(rotate|revoke)$/.exec(url.pathname);
  if(url.pathname!=='/api/subscriptions'&&!detail&&!restore&&!credential)return null;
  if(!state.authenticated)return json({error:'请先登录'},401);
  const subscriptions=createSubscriptions(env);
  if(request.method==='GET'&&url.pathname==='/api/subscriptions'){
    const result=await subscriptions.list({id:state.user.id});
    return json(result);
  }
  const create=request.method==='POST'&&url.pathname==='/api/subscriptions';
  const update=request.method==='PATCH'&&detail;
  const remove=request.method==='DELETE'&&detail;
  const restoreCommand=request.method==='POST'&&restore;
  const credentialCommand=request.method==='POST'&&credential;
  if(!create&&!update&&!remove&&!restoreCommand&&!credentialCommand)return json({error:'Method not allowed'},405);
  if(request.headers.get('Origin')!==new URL(env.BASE_URL).origin)return json({error:'invalid_origin'},403);
  const body=await readJsonBody(request);
  if(body.error)return json({error:body.error},body.status);
  try{
    const actor={id:state.user.id};
    const result=create
      ?await subscriptions.change(actor,body.body)
      :update
        ?await subscriptions.update(actor,detail[1],body.body)
        :remove
          ?await subscriptions.delete(actor,detail[1],body.body)
          :restoreCommand
            ?await subscriptions.restore(actor,restore[1],body.body)
            :await subscriptions.credentialCommand(
              actor,
              credential[1],
              body.body,
              credential[2]==='rotate'?'rotate_rss':'revoke_rss',
            );
    return json(result,create&&result.created?201:200);
  }catch(error){
    if(error.name!=='SubscriptionError')throw error;
    if(error.code==='AUTH_UNAVAILABLE')return json({error:'认证服务暂时不可用，请稍后重试',code:error.code},503);
    return json({error:error.message,code:error.code??'INVALID_REQUEST'},error.status??400);
  }
}

async function readJsonBody(request){
  try{
    const bytes=new Uint8Array(await request.arrayBuffer());
    if(bytes.byteLength>65536)return {error:'JSON body too large',status:400};
    return {body:JSON.parse(new TextDecoder().decode(bytes))};
  }catch{
    return {error:'Invalid JSON',status:400};
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
