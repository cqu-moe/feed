import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

let mf,db;
before(async()=>{
  const bundle=await build({stdin:{contents:`
    import {reserveBudget} from './worker/utils.mjs';
    import {reservePages} from './worker/ocr-cache.mjs';
    import {scrape} from './worker/firecrawl.mjs';
    let providerCalls=0;
    globalThis.fetch=async()=>{providerCalls++;return Response.json({success:true,data:{}})};
    export default {async fetch(request,env){
      const input=await request.json();
      try{
        if(input.kind==='scrape'){
          await scrape({...env,MAX_FIRECRAWL_PER_DAY:input.limit},'https://example.test/');
          return Response.json({providerCalls});
        }
        const result=input.kind==='pdf'
          ?await reservePages({...env,MAX_PDF_OCR_PAGES_PER_DAY:String(input.daily),MAX_PDF_OCR_PAGES_PER_MONTH:String(input.monthly)},input.count)
          :await reserveBudget(env,input.kind,input.limit);
        return Response.json({result});
      }catch(error){return Response.json({error:error.message},{status:409});}
    }};`,resolveDir:process.cwd(),sourcefile:'usage-budget-fixture.mjs'},
    bundle:true,write:false,format:'esm',platform:'browser',external:['node:*']});
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,
    compatibilityDate:'2026-10-11',compatibilityFlags:['nodejs_compat'],d1Databases:['DB']}));
  db=await mf.getD1Database('DB');
  for(const name of ['0001_feed.sql','0004_pdf_ocr.sql']){
    const sql=await readFile(`migrations/${name}`,'utf8');
    for(const statement of sql.split(/;\s*\n(?=CREATE|ALTER|PRAGMA|$)/).map(s=>s.trim()).filter(s=>s&&!/^PRAGMA\b/i.test(s)))await db.prepare(statement).run();
  }
});
after(async()=>{await mf?.dispose();});
beforeEach(async()=>{
  for(const table of ['usage','pdf_ocr_budget','pdf_ocr_usage'])await db.prepare(`DELETE FROM ${table}`).run();
});
const reserve=input=>mf.dispatchFetch('https://fixture.test/reserve',{method:'POST',body:JSON.stringify(input)});

test('uncapped Firecrawl and CAPTCHA requests still count every concurrent reservation above old limits',async()=>{
  for(const kind of ['firecrawl','ocr']){
    const results=await Promise.all(Array.from({length:12},()=>reserve({kind,limit:0})));
    assert.ok(results.every(r=>r.ok));
    assert.equal((await db.prepare('SELECT used FROM usage WHERE kind=?').bind(kind).first()).used,12);
  }
});

test('finite request budgets stay atomic and invalid configuration cannot disable protection',async()=>{
  const results=await Promise.all(Array.from({length:8},()=>reserve({kind:'firecrawl',limit:3})));
  assert.equal(results.filter(r=>r.ok).length,3);
  for(const limit of [-1,1.5,null])assert.equal((await reserve({kind:'firecrawl',limit})).status,409);
  assert.equal((await db.prepare("SELECT used FROM usage WHERE kind='firecrawl'").first()).used,3);
});

test('uncapped PDF pages preserve day and month ledgers beyond previous allowances',async()=>{
  const results=await Promise.all(Array.from({length:4},()=>reserve({kind:'pdf',daily:0,monthly:0,count:20})));
  assert.ok(results.every(r=>r.ok));
  const row=await db.prepare('SELECT day_pages,month_pages FROM pdf_ocr_budget').first();
  assert.deepEqual(row,{day_pages:80,month_pages:80});
  const rows=(await db.prepare('SELECT reserved_pages FROM pdf_ocr_usage').all()).results;
  assert.equal(rows.length,2);
  assert.ok(rows.every(r=>r.reserved_pages===80));
});

test('disabling either PDF cap retains the other cap and keeps failed reservations out of usage',async()=>{
  for(const limits of [{daily:0,monthly:3},{daily:3,monthly:0}]){
    await db.prepare('DELETE FROM pdf_ocr_budget').run();
    await db.prepare('DELETE FROM pdf_ocr_usage').run();
    assert.equal((await reserve({kind:'pdf',...limits,count:2})).status,200);
    assert.equal((await reserve({kind:'pdf',...limits,count:2})).status,409);
    const rows=(await db.prepare('SELECT reserved_pages FROM pdf_ocr_usage').all()).results;
    assert.ok(rows.every(r=>r.reserved_pages===2));
  }
});

test('malformed environment limits never grant an unlimited paid request',async()=>{
  for(const limit of [' ','',false,'0x0','NaN',-1]){
    const response=await reserve({kind:'scrape',limit});
    assert.equal(response.status,409,`Firecrawl limit ${JSON.stringify(limit)}`);
    assert.equal((await db.prepare('SELECT COUNT(*) count FROM usage').first()).count,0);
  }
  for(const limits of [{daily:' ',monthly:0},{daily:0,monthly:' '}]){
    assert.equal((await reserve({kind:'pdf',...limits,count:1})).status,409);
    assert.equal((await db.prepare('SELECT COUNT(*) count FROM pdf_ocr_budget').first()).count,0);
  }
  const response=await reserve({kind:'scrape',limit:'0'});
  assert.equal(response.status,200);
  assert.equal((await response.json()).providerCalls,1);
});
