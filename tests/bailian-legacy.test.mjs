import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import {applyMigration} from './helpers/subscriptions-fixture.mjs';

test('historical PDF-only notice goes from current OCR to a ready document; a correction withdraws its old hit immediately',async t=>{
  const bundle=await build({stdin:{resolveDir:process.cwd(),contents:`
    import {loadLegacySearchNotice} from './worker/bailian-legacy.mjs';
    import {runBailianSync,lookupSearchDocuments} from './worker/bailian-sync.mjs';
    const remote=new Map(); let serial=0,throttle=false,calls=0;
    const client={registerFile:async({text})=>{calls++;if(throttle)throw Object.assign(new Error('busy'),{status:429});const key='file-'+(++serial);remote.set(key,text);return key;},
      startImport:async ids=>ids[0],checkImport:async id=>({state:'done',files:[{fileId:id,state:'done'}]}),
      removeDocument:async()=>{},removeFile:async id=>remote.delete(id)};
    export default {async fetch(req,env){
      const url=new URL(req.url);
      if(url.pathname==='/limit'){throttle=true;calls=0;return Response.json(true);}
      if(url.pathname==='/count')return Response.json(calls);
      if(url.pathname==='/tick')return Response.json(await runBailianSync(env,{client,loadNotice:id=>loadLegacySearchNotice(env,id)}));
      const ids=[...remote].filter(([,text])=>text.includes('380 元')).map(([id])=>id);
      return Response.json(await lookupSearchDocuments(env,ids));
    }};
  `},bundle:true,write:false,format:'esm',platform:'browser',external:['node:*','cloudflare:workers']});
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-11',
    compatibilityFlags:['nodejs_compat'],bindings:{BAILIAN_SEARCH_WRITES:'true'},d1Databases:['DB'],r2Buckets:['ARCHIVE']}));
  t.after(()=>mf.dispose());
  const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('ARCHIVE');
  for(const file of (await readdir('migrations')).filter(f=>f.endsWith('.sql')).sort())
    await applyMigration(db,(await readFile('migrations/'+file,'utf8')).replace(/^\s*--[^\n]*/gm,''));
  await db.prepare("INSERT OR IGNORE INTO sources(id,name,url) VALUES ('legacy','校医院','https://school.test')").run();
  const id='5'.repeat(24),file='attachment-1.pdf';
  await db.prepare(`INSERT INTO articles(id,source_id,url,title,published_at,discovered_at,status,body_text,ocr_result_key)
    VALUES (?,'legacy','https://school.test/1','报销通知','2025-07-02','2025-07-02','complete','详见附件','derived/current')`).bind(id).run();
  await db.prepare(`INSERT INTO attachments(id,article_id,name,original_url,filename,object_key,bytes,content_type,status,role)
    VALUES ('pdf',?,'报销标准.pdf','https://school.test/a.pdf',?,'original',8,'application/pdf','complete','body-pdf')`).bind(id,file).run();
  await bucket.put('original','%PDF-ocr');
  await bucket.put('derived/current',JSON.stringify({htmlText:'详见附件',pages:[{filename:file,page:2,text:'本次可报销 380 元'}]}));
  const tick=async()=>{const res=await mf.dispatchFetch('https://feed.test/tick');assert.equal(res.status,200,await res.text());};
  for(let i=0;i<3;i++)await tick();
  const lookup=async()=>(await mf.dispatchFetch('https://feed.test/lookup')).json();
  const [hit]=await lookup();
  assert.equal(hit.articleId,id);assert.equal(hit.revisionId,null);assert.equal(hit.filename,file);
  assert.deepEqual(await (await bucket.get(hit.evidenceKey)).json(),[{number:2,text:'本次可报销 380 元'}]);
  await db.prepare("UPDATE articles SET ocr_result_key='derived/corrected' WHERE id=?").bind(id).run();
  assert.deepEqual(await lookup(),[]);
  await bucket.put('derived/corrected',JSON.stringify({htmlText:'新报销办法',pages:[{filename:file,page:2,text:'调整金额 580 元'}]}));
  await mf.dispatchFetch('https://feed.test/limit');
  await tick();await tick();
  assert.equal(await (await mf.dispatchFetch('https://feed.test/count')).json(),1,'a provider 429 pauses the whole batch');
});
