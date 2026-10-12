import {discoverList} from './discovery.mjs';

// One source-page task owns one immutable paid result. Database retries consume
// this journal even after a Workflow has ended and a new attempt takes over.
export async function savedDiscoveryPage(env,source,taskId,url,options){
  const key=`discovery/${taskId}/list.json`;
  async function read(){
    const object=await env.ARCHIVE.get(key);
    if(!object)return null;
    if(object.size>8*1024*1024)throw new Error('Saved discovery result exceeds size limit');
    const journal=await object.json();
    if(journal.version!==1||journal.taskId!==taskId||journal.sourceId!==source.id
      ||journal.configVersion!==source.configVersion||journal.url!==url
      ||!Number.isSafeInteger(journal.result?.observedAt)
      ||!Array.isArray(journal.result?.articles)||!Array.isArray(journal.result?.next)){
      throw new Error('Saved discovery result does not match its task');
    }
    return journal.result;
  }
  const prior=await read();
  if(prior)return prior;
  const result=await discoverList(env,source,url,options);
  const journal=JSON.stringify({version:1,taskId,sourceId:source.id,configVersion:source.configVersion,url,result});
  if(new TextEncoder().encode(journal).byteLength>8*1024*1024)throw new Error('Discovery result exceeds size limit');
  const saved=await env.ARCHIVE.put(key,journal,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});
  if(saved)return result;
  const winner=await read();
  if(!winner)throw new Error('Saved discovery result is unavailable');
  return winner;
}
