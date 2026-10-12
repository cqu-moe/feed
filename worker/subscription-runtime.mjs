const configurationOrder=(left,right)=>(
  left.priority-right.priority||
  left.createdAt-right.createdAt||
  (left.id<right.id?-1:left.id>right.id?1:0)
);

const isDeleted=row=>row.deleted===1||row.deletedAt!==null&&row.deletedAt!==undefined;

function baseStatus(row,policyState,rank){
  if(policyState.status==='auth_unavailable')return 'auth_unavailable';
  if(!policyState.policy.access)return 'access_revoked';
  if(isDeleted(row))return 'deleted';
  if(row.requestedEnabled!==1)return 'paused';
  const limit=policyState.policy.subscriptionLimit;
  if(limit.kind==='missing')return 'quota_exceeded';
  if(limit.kind==='limited'&&rank>=limit.value)return 'quota_exceeded';
  return 'active';
}

export function computeSubscriptionRuntime(rows,policyState,recipientStatus='verified'){
  const configurations=rows.filter(row=>!isDeleted(row)).sort(configurationOrder);
  let nextRank=0;
  const results=new Map();
  for(const row of configurations){
    const requestedEnabled=row.requestedEnabled===1;
    const rank=requestedEnabled?nextRank++:Number.POSITIVE_INFINITY;
    const effectiveStatus=baseStatus(row,policyState,rank);
    results.set(row.id,{
      effectiveStatus,
      selected:effectiveStatus==='active',
      runningRank:rank,
      rssStatus:row.rssRevoked===1||row.rssRevokedAt!==null&&row.rssRevokedAt!==undefined?'rss_revoked':effectiveStatus,
      emailStatus:row.emailMode==='off'
        ?'mail_off'
        :recipientStatus==='unverified'&&effectiveStatus==='active'
          ?'email_unverified'
          :effectiveStatus,
    });
  }
  for(const row of rows.filter(isDeleted)){
    if(!results.has(row.id)){
      results.set(row.id,{
        effectiveStatus:'deleted',
        selected:false,
        runningRank:Number.POSITIVE_INFINITY,
        rssStatus:'rss_revoked',
        emailStatus:'deleted',
      });
    }
  }
  return results;
}
