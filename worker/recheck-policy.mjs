export function parseRecheckPolicy(env){
  return {
    recentAfterMs:boundedInteger(env.RECHECK_RECENT_AFTER_SEC,30*86_400,60,365*86_400,'RECHECK_RECENT_AFTER_SEC')*1000,
    recentIntervalMs:boundedInteger(env.RECHECK_RECENT_INTERVAL_SEC,7*86_400,600,365*86_400,'RECHECK_RECENT_INTERVAL_SEC')*1000,
    oldIntervalMs:boundedInteger(env.RECHECK_OLD_INTERVAL_SEC,30*86_400,600,365*86_400,'RECHECK_OLD_INTERVAL_SEC')*1000,
  };
}

export function nextRecheckAt(env,revision,readyAt){
  const policy=parseRecheckPolicy(env);
  const age=articleAgeMs(revision,readyAt);
  return readyAt+(age<=policy.recentAfterMs?policy.recentIntervalMs:policy.oldIntervalMs);
}

export function boundedInteger(value,fallback,min,max,name='setting'){
  if(value===undefined||value===null)return fallback;
  const number=Number(value);
  if(!Number.isSafeInteger(number)||number<min||number>max)
    throw new Error(`Recheck configuration ${name} must be an integer from ${min} to ${max}`);
  return number;
}

export function articleAgeMs(revision,at){
  const publishedAt=Date.parse(revision.publishedAt??'');
  return Number.isFinite(publishedAt)?at-publishedAt:at-revision.observedAt;
}
