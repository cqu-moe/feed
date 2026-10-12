import {Buffer} from 'node:buffer';
import {sha} from './utils.mjs';

const validHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const objectKey=hash=>`objects/sha256/${hash.slice(0,2)}/${hash}`;
function descriptor(object,hash,type){
  const checksum=object?.checksums?.sha256;
  if(!object||!checksum||Buffer.from(checksum).toString('hex')!==hash)throw new Error('Immutable object checksum is not verified');
  return {sha256:hash,r2Key:object.key,byteSize:object.size,mediaType:type,verifiedAt:Date.now()};
}
export async function adoptObject(env,saved,prefix){
  if(!saved||!validHash(saved.sha256)||!saved.key?.startsWith(`${prefix}/`)
    ||!Number.isSafeInteger(saved.bytes)||saved.bytes<0)throw new Error('Invalid capture artifact reference');
  const key=objectKey(saved.sha256),type=saved.contentType||'application/octet-stream';
  let object=await env.ARCHIVE.head(key);
  if(!object){
    const temporary=await env.ARCHIVE.get(saved.key);
    if(!temporary||temporary.size!==saved.bytes)throw new Error('Capture artifact is missing or truncated');
    object=await env.ARCHIVE.put(key,temporary.body,{onlyIf:{etagDoesNotMatch:'*'},sha256:saved.sha256,httpMetadata:{contentType:type}});
    object??=await env.ARCHIVE.head(key);
  }
  if(object?.size!==saved.bytes)throw new Error('Immutable object size mismatch');
  return descriptor(object,saved.sha256,type);
}
export async function storeTextObject(env,text,type='text/plain; charset=utf-8'){
  const bytes=new TextEncoder().encode(text),hash=await sha(bytes),key=objectKey(hash);
  let object=await env.ARCHIVE.head(key);
  if(!object){
    object=await env.ARCHIVE.put(key,bytes,{onlyIf:{etagDoesNotMatch:'*'},sha256:hash,httpMetadata:{contentType:type}});
    object??=await env.ARCHIVE.head(key);
  }
  if(object?.size!==bytes.byteLength)throw new Error('Immutable object size mismatch');
  return descriptor(object,hash,type);
}
export async function verifyObject(env,object){
  if(!validHash(object?.sha256)||object.r2Key!==objectKey(object.sha256))throw new Error('Invalid immutable object reference');
  const stored=await env.ARCHIVE.head(object.r2Key);
  if(stored?.size!==object.byteSize)throw new Error('Immutable object unavailable');
  return descriptor(stored,object.sha256,object.mediaType);
}
