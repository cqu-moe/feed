import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

let mf,db,bucket;
const id='1234567890abcdef12345678',second='abcdef1234567890abcdef12';
before(async()=>{
  const bundle=await build({stdin:{contents:"import {apiRoute} from './worker/api.mjs'; export default {fetch:apiRoute};",resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser',external:['node:buffer','cloudflare:workers'],target:'es2022'});
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-11',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['ARCHIVE']}));
  db=await mf.getD1Database('DB');bucket=await mf.getR2Bucket('ARCHIVE');
  const sql=await readFile('migrations/0001_feed.sql','utf8');
  for(const statement of sql.split(/;\s*\n(?=CREATE|PRAGMA|$)/).filter(x=>x.trim()))await db.prepare(statement).run();
  const ocrSql=await readFile('migrations/0004_pdf_ocr.sql','utf8');
  for(const statement of ocrSql.split(';').filter(x=>x.trim()))await db.prepare(statement).run();
  await db.prepare("INSERT INTO sources(id,name,url) VALUES ('jwc','教务处','https://jwc.cqu.edu.cn/'),('civil','土木学院','https://civil.cqu.edu.cn/')").run();
  await db.prepare("INSERT INTO articles(id,source_id,url,title,published_at,discovered_at,body_text,snapshot_key) VALUES (?,'jwc','https://jwc.cqu.edu.cn/info/1/1.htm','关于优异生申请通知','2026-10-01','2026-10-11','请提交奖学金材料，比例100%。','snapshot')").bind(id).run();
  await db.prepare("INSERT INTO articles(id,source_id,url,title,published_at,discovered_at,body_text) VALUES (?,'civil','https://civil.cqu.edu.cn/info/1/2.htm','研究生奖学金','2026-10-02','2026-10-11','报名材料')").bind(second).run();
  await db.prepare("INSERT INTO attachments(id,article_id,name,original_url,filename,object_key,bytes,content_type,status) VALUES ('file',?,'通知正文.pdf','https://jwc.cqu.edu.cn/file.pdf','attachment-1.pdf','pdf',17,'application/pdf','complete')").bind(id).run();
  await bucket.put('pdf','%PDF-1.7\nexample!',{httpMetadata:{contentType:'application/pdf'}});
  await bucket.put('snapshot',`<html><head><meta http-equiv="refresh" content="0;url=/auth/logout"><script>alert(1)</script></head><body onload="alert(2)"><form action="/submit"><h1>通知正文</h1><iframe data-feed-pdf="attachment-1.pdf" src="https://school/old.pdf" srcdoc="evil" sandbox="allow-popups allow-top-navigation-by-user-activation" width="700"></iframe><iframe src="/auth/login"></iframe><a href="javascript:alert(3)" onclick="evil()">bad</a></form></body></html>`);
});
after(async()=>{await mf?.dispose();});
test('Chinese title/body search, source filtering and literal short queries',async()=>{
  for(const [query,source,expected] of [['优异生','',[id]],['材料','jwc',[id]],['奖学金','',[second,id]],['%','',[id]],["\" OR 1=1 --",'',[]]]){
    const r=await mf.dispatchFetch('https://feed.test/api/articles?'+new URLSearchParams({q:query,source}));
    assert.equal(r.status,200);const result=await r.json();assert.deepEqual(result.articles.map(a=>a.id),expected);assert.equal(result.total,expected.length);
  }
});
test('PDF content supports bounded ranges, suffixes, HEAD and 416',async()=>{
  const path=`https://feed.test/api/files/${id}/attachment-1.pdf`;
  const r=await mf.dispatchFetch(path,{headers:{Range:'bytes=0-4'}});
  assert.equal(r.status,206);assert.equal(await r.text(),'%PDF-');assert.equal(r.headers.get('content-range'),'bytes 0-4/17');
  const suffix=await mf.dispatchFetch(path,{headers:{Range:'bytes=-4'}});assert.equal(await suffix.text(),'ple!');
  const head=await mf.dispatchFetch(path,{method:'HEAD'});assert.equal(head.headers.get('content-length'),'17');assert.equal(await head.text(),'');
  assert.equal((await mf.dispatchFetch(path,{headers:{Range:'bytes=20-25'}})).status,416);
});
test('Snapshot preserves saved PDF frame and removes executable source content',async()=>{
  const r=await mf.dispatchFetch(`https://feed.test/api/snapshots/${id}`,{method:'GET'}),html=await r.text();
  assert.equal(r.status,200,html);assert.ok(html.includes(`/reader/${id}/attachment-1.pdf`),html);assert.ok(html.includes('width="700"'));
  assert.doesNotMatch(html,/<script|onload=|onclick=|srcdoc=|sandbox=|http-equiv|src="\/auth|javascript:/i);
  assert.match(r.headers.get('content-security-policy'),/script-src 'none'/);
  assert.match(html, /通知正文/);assert.doesNotMatch(html, /<form/i);
});
