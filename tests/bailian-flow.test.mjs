import {test} from 'node:test';
import assert from 'node:assert/strict';
import {searchFixture,seedSources,notice,site} from './helpers/bailian-fixture.mjs';
import {buildSearchTags} from '../worker/bailian-filters.mjs';

test('HTTP upload, file-level import and ranked Chinese searches round-trip through D1 and R2',async t=>{
  const files=new Map(),queries=[];let serial=0,fail=false;
  const pass=data=>Response.json({code:'Success',status:200,status_code:200,data});
  async function remote(req){
    const u=new URL(req.url),body=req.method==='POST'?await req.json():{};
    if(u.pathname.endsWith('/applyFileUploadLease')){
      const id='file-'+(++serial);files.set(id,{text:null});
      return pass({type:'OSS.PreSignedUrl',leaseId:id,param:{method:'PUT',headers:{},url:'https://example.oss-cn-beijing.aliyuncs.com/'+id}});
    }
    if(req.method==='PUT'){files.get(u.pathname.slice(1)).text=await req.text();return new Response(null,{status:200});}
    if(u.pathname.endsWith('/addFile')){files.get(body.leaseId).tags=body.tags;return pass({fileId:body.leaseId});}
    if(u.pathname.endsWith('/job/create'))return pass({ingestionId:body.docIds[0]});
    if(u.pathname.endsWith('/index_job/status'))return pass({ingestion_status:'COMPLETED',total_count:1,rows:[{doc_id:u.searchParams.get('job_id'),status:'FINISH'}]});
    if(u.pathname.endsWith('/knowledge/search')){
      queries.push(body);
      if(fail)return new Response(null,{status:503});
      const nodes=[{metadata:{doc_id:'obsolete',content:'过期内容'}}];
      for(const [id,f] of [...files].sort((a,b)=>Number(b[1].text.includes('380 元'))-Number(a[1].text.includes('380 元')))){
        const text=f.text.split('\n').at(-1);
        if(body.query==='无匹配')continue;
        nodes.push({metadata:{doc_id:id,content:text,doc_url:'https://provider.test/private'}});
        nodes.push({metadata:{doc_id:id,content:text}});
      }
      return Response.json({code:'Success',success:true,status:'SUCCESS',data:{nodes}});
    }
    throw new Error('Unexpected remote request '+u.pathname);
  }
  const f=await searchFixture(t,`import {apiRoute} from './worker/api.mjs';import {runBailianSync} from './worker/bailian-sync.mjs';
    export default {async fetch(req,env){if(new URL(req.url).pathname==='/tick')return Response.json(await runBailianSync(env));return apiRoute(req,env);}};`,{outbound:remote});
  const a='a'.repeat(24),b='b'.repeat(24);
  await seedSources(f.db);
  await notice(f.db,a,'补考申请','详见附件','2026-02-01');
  await notice(f.db,b,'缓考办法','另一篇通知规定了不同的申请条件','2026-02-02');
  const filename='attachment-1.pdf';
  await f.db.prepare("INSERT INTO attachments(id,article_id,name,original_url,filename,object_key,status,role) VALUES ('one',?,'补助表','https://school.test/p.pdf',?,'orig','complete','body-pdf')")
    .bind(a,filename).run();
  await f.db.prepare("UPDATE articles SET ocr_result_key='ocr' WHERE id=?").bind(a).run();
  await f.bucket.put('orig','%PDF-local');
  await f.bucket.put('ocr',JSON.stringify({htmlText:'详见附件',pages:[{page:1,filename,text:'缴费安排'},{page:2,filename,text:'每名学生补助 380 元'}]}));
  for(let i=0;i<3;i++)assert.equal((await f.fetch('/tick')).status,200);
  const query=async params=>{
    const res=await f.fetch('/api/articles?'+new URLSearchParams(params));return {status:res.status,...await res.json()};
  };
  const browse=await query({source:'jwc'});assert.equal(browse.total,2);assert.equal(queries.length,0);
  const results=await query({q:'补考'});
  assert.equal(results.status,200);assert.equal(results.searchKind,'related');
  assert.deepEqual(results.articles.map(r=>r.id),[a,b],'provider ranking wins over chronological order; repeated fragments collapse');
  assert.equal(results.articles[0].excerpt,'每名学生补助 380 元');
  assert.equal(results.articles[0].match.href,'/reader/'+a+'/'+filename+'?page=2');
  const filtered=await query({q:'没考过可以怎么申请',site,source:'jwc',from:'2026-02-01',to:'2026-02-01'});
  assert.deepEqual(filtered.articles.map(r=>r.id),[a],'D1 independently rejects out-of-range hits from the substitute');
  const config=queries.at(-1).kb_search_configs[0];
  assert.equal(config.id,'index');assert.equal(config.search_filters.length,3);
  const written=await buildSearchTags([{siteId:site,sourceId:'jwc'}],'2026-02-01');
  assert.ok(config.search_filters.every(group=>group.tags.some(tag=>written.includes(tag))));
  assert.equal((await query({q:'无匹配'})).total,0);
  fail=true;assert.equal((await query({q:'补考'})).status,503);
  assert.equal((await query({from:'2026-02-02'})).total,1);
});
