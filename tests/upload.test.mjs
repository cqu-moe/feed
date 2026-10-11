import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
let mf,bucket,grant;
before(async()=>{
  const bundle=await build({stdin:{contents:`import {bridgeRoute,issueGrant} from './worker/bridge.mjs'; export default {async fetch(r,e){if(new URL(r.url).pathname==='/fixture')return Response.json(await issueGrant(e,{url:'https://jwc.cqu.edu.cn/'},'12345678-1234-1234-1234-123456789abc','1234567890abcdef12345678'));return bridgeRoute(r,e)}}`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser',external:['node:buffer']});
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-11',compatibilityFlags:['nodejs_compat'],bindings:{BRIDGE_SECRET:'upload-fixture-key',MAX_UPLOAD_BYTES_PER_DAY:'8388608'},d1Databases:['DB'],r2Buckets:['ARCHIVE']}));
  const db=await mf.getD1Database('DB');await db.prepare('CREATE TABLE usage(day TEXT,kind TEXT,used INTEGER,PRIMARY KEY(day,kind))').run();
  bucket=await mf.getR2Bucket('ARCHIVE');grant=await (await mf.dispatchFetch('https://feed.test/fixture')).json();
});
after(async()=>{await mf?.dispose();});
test('Cloud upload preserves multi-megabyte bytes and server digest in R2',async()=>{
  const bytes=new Uint8Array(3*1024*1024);bytes.set([0x50,0x4b,0x03,0x04]);bytes[bytes.length-1]=42;
  const r=await mf.dispatchFetch('https://feed.test/internal/upload',{method:'POST',headers:{Origin:'https://feed.test','X-Grant':grant.token,'X-Filename':'attachment-1.zip','Content-Length':String(bytes.length)},body:bytes});
  const response=await r.json();assert.equal(r.status,200,JSON.stringify(response));
  assert.equal(response.saved.bytes,bytes.length);assert.equal(response.saved.sha256,createHash('sha256').update(bytes).digest('hex'));
  const stored=await bucket.get(response.saved.key);assert.deepEqual(new Uint8Array(await stored.arrayBuffer()),bytes);
});
test('Upload rejects missing capability, wrong origin and HTML disguised as a file',async()=>{
  const url='https://feed.test/internal/upload';
  assert.equal((await mf.dispatchFetch(url,{method:'POST',body:'not a file'})).status,401);
  assert.equal((await mf.dispatchFetch(url,{method:'POST',headers:{'X-Grant':grant.token,Origin:'https://other.test'},body:'not a file'})).status,403);
  const r=await mf.dispatchFetch(url,{method:'POST',headers:{'X-Grant':grant.token,Origin:'https://feed.test','X-Filename':'attachment-2.pdf','Content-Length':'20'},body:'<html>captcha</html>'});
  assert.equal(r.status,400);assert.equal(await bucket.get('articles/1234567890abcdef12345678/12345678-1234-1234-1234-123456789abc/attachment-2.pdf'),null);
});
