export function launchDelaySeconds(dueAt,timestamp){
  const remaining=Number(dueAt)-Number(timestamp);
  return remaining>0?Math.ceil(remaining/1000):0;
}

export async function sendPersistedOutbox(env,target,row,timestamp){
  const message=JSON.parse(row.payload_json);
  const delaySeconds=row.topic==='feed-jobs'
    ?launchDelaySeconds((await env.DB.prepare('SELECT due_at FROM tasks WHERE id=?').bind(message.taskId).first())?.due_at,timestamp)
    :0;
  await target.send(message,delaySeconds>0?{contentType:'json',delaySeconds}:{contentType:'json'});
}
