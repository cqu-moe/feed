const encoder=new TextEncoder(),decoder=new TextDecoder();
const purpose='feed-rss-v1';

async function key(env){
  const secret=env.FEED_SESSION_ENCRYPTION_KEY??env.SESSION_ENCRYPTION_KEY;
  if(typeof secret!=='string'||!secret)throw new Error('RSS credential encryption is not configured');
  const material=await crypto.subtle.digest('SHA-256',encoder.encode(`${purpose}:${secret}`));
  return crypto.subtle.importKey('raw',material,'AES-GCM',false,['encrypt','decrypt']);
}
const context=row=>encoder.encode(JSON.stringify([purpose,row.ownerSub,row.id,row.rssTokenGeneration]));
const encode=value=>btoa(String.fromCharCode(...value)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
const decode=value=>Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),char=>char.charCodeAt(0));

export async function sealRssToken(env,row,token){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:context(row)},await key(env),encoder.encode(token));
  return `v1.${encode(iv)}.${encode(new Uint8Array(encrypted))}`;
}

export async function rssUrlForOwner(env,row){
  if(row.rssRevokedAt!==null&&row.rssRevokedAt!==undefined)return null;
  const parts=String(row.rssTokenCiphertext??'').split('.');
  if(parts.length!==3||parts[0]!=='v1'||!parts[1]||!parts[2])throw new Error('RSS credential is unavailable');
  const bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(parts[1]),additionalData:context(row)},await key(env),decode(parts[2]));
  const token=decoder.decode(bytes);
  if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw new Error('RSS credential is invalid');
  return `/rss?token=${token}`;
}
