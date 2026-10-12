import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

const first='1234567890abcdef12345678',second='abcdef1234567890abcdef12';
const third='111111111111111111111111';
const failures={
  budget:'firecrawl daily budget reached (120)',
  http429:'Firecrawl HTTP 429: rate limit exceeded',
  http402:'Firecrawl HTTP 402: insufficient credits',
  http403:'Firecrawl HTTP 403: public IP is denied by target site',
};

const workflowPlugin={
  name:'workflow-test',
  setup(buildApi){
    buildApi.onResolve({filter:/^cloudflare:workers$/},()=>({path:'cloudflare-workers',namespace:'workflow-test'}));
    buildApi.onResolve({filter:/\.\/discovery\.mjs$/},args=>args.importer.endsWith('/workflow.mjs')?{path:'discovery',namespace:'workflow-test'}:undefined);
    buildApi.onResolve({filter:/\.\/collect\.mjs$/},()=>({path:'collect',namespace:'workflow-test'}));
    buildApi.onLoad({filter:/.*/,namespace:'workflow-test'},(args)=>{
      if(args.path==='cloudflare-workers')return {loader:'js',contents:'export class WorkflowEntrypoint{constructor(env={}){this.env=env;}}'};
      if(args.path==='discovery')return {loader:'js',contents:'export async function discoverPage(){return {added:0,recent:0,dated:1,undated:0,next:[]};}'};
      return {loader:'js',contents:`
        const failures=${JSON.stringify(failures)};
        export const calls=[];
        globalThis.WORKFLOW_CALLS=calls;
        export const createCollector=()=>collectArticle;
        export async function collectArticle(env,_source,article){
          calls.push(article.id);
          const kind=globalThis.WORKFLOW_ERROR;
          if(kind&&calls.length===1)throw new Error(failures[kind]);
          await env.DB.prepare("UPDATE articles SET status='complete',error=null,lease_until=0 WHERE id=?").bind(article.id).run();
          return {id:article.id,status:'complete',attachments:0,downloaded:0,creditsUsed:1};
        }
      `};
    });
  },
};

async function fixture(){
  const bundle=await build({
    stdin:{contents:`
      import {FeedIngest} from './worker/workflow.mjs';
      const step={
        async do(_name,config,fn){return (typeof config==='function'?config:fn)();},
        async sleep(){},
      };
      export default {async fetch(request,env){
        const url=new URL(request.url);
        if(url.pathname==='/reset'){globalThis.WORKFLOW_CALLS.length=0;globalThis.WORKFLOW_ERROR=null;return Response.json({ok:true});}
        if(url.pathname==='/calls')return Response.json({calls:globalThis.WORKFLOW_CALLS});
        if(url.pathname!=='/run')return new Response('Not found',{status:404});
        const error=url.searchParams.get('error');
        globalThis.WORKFLOW_ERROR=error==='none'?null:error;
        const workflow=new FeedIngest(env);
        const result=await workflow.run({instanceId:url.searchParams.get('runId'),payload:{sourceId:'jwc',cutoff:'2026-01-01'}},step);
        return Response.json(result);
      }}
    `,resolveDir:process.cwd(),sourcefile:'workflow-fixture.mjs'},
    bundle:true,write:false,format:'esm',platform:'browser',external:['node:buffer'],plugins:[workflowPlugin],
  });
  const mf=new Miniflare(convertV4Options({
    modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-11',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],
  }));
  const db=await mf.getD1Database('DB');
  await applyMigration(db,await readFile('migrations/0001_feed.sql','utf8'));
  await applyMigration(db,await readFile('migrations/0003_collection_lease.sql','utf8'));
  await applyMigration(db,await readFile('migrations/0005_task_runtime.sql','utf8'));
  return {mf,db};
}

function convertV4Options(options){return convertV4MiniflareOptions(options);}

async function applyMigration(db,sql){
  const statements=sql.split(/;\s*\n(?=CREATE|PRAGMA|$)/).map(statement=>statement.trim()).filter(statement=>statement&&!/^PRAGMA\b/i.test(statement));
  for(const statement of statements)await db.prepare(statement).run();
}

async function resetArticles(db,rows){
  await db.prepare('DELETE FROM attachments').run();
  await db.prepare('DELETE FROM articles').run();
  await db.prepare('DELETE FROM runs').run();
  await db.prepare('DELETE FROM sources').run();
  await db.prepare("INSERT INTO sources(id,name,url) VALUES ('jwc','教务处','https://jwc.cqu.edu.cn/')").run();
  for(const row of rows)await db.prepare("INSERT INTO articles(id,source_id,url,title,published_at,discovered_at,status,attempts,lease_until) VALUES (?,'jwc',?,?,?,'2026-01-01',?,?,0)").bind(...row).run();
}

async function run(mf,runId,error='none'){
  const response=await mf.dispatchFetch(`https://feed.test/run?runId=${runId}&error=${error}`);
  if(!response.ok)throw new Error(await response.text());
  return response.json();
}

async function article(db,id){
  return db.prepare('SELECT status,attempts,lease_until,error FROM articles WHERE id=?').bind(id).first();
}

test('global provider limits defer the article and leave the next day retry available',async()=>{
  const {mf,db}=await fixture();
  try{
    await resetArticles(db,[
      [first,'https://jwc.cqu.edu.cn/info/1082/1.htm','全局限额第一篇','2026-01-03','pending',0],
      [second,'https://jwc.cqu.edu.cn/info/1082/2.htm','不应被吞掉的第二篇','2026-01-02','pending',0],
    ]);
    await db.prepare("UPDATE articles SET prefix='articles/prior-run',attempts=1 WHERE id=?").bind(first).run();
    await run(mf,'run-1','http429');
    assert.deepEqual((await(await mf.dispatchFetch('https://feed.test/calls')).json()).calls,[first]);

    const deferred=await article(db,first),untouched=await article(db,second);
    assert.equal(deferred.status,'partial');
    assert.equal(deferred.attempts,1);
    assert.equal(deferred.lease_until,0);
    assert.equal(untouched.status,'pending');
    assert.equal(untouched.attempts,0);
    assert.equal((await db.prepare("SELECT status FROM runs WHERE id='run-1'").first()).status,'partial');

    await(await mf.dispatchFetch('https://feed.test/reset')).json();
    await run(mf,'run-2','none');
    assert.deepEqual((await(await mf.dispatchFetch('https://feed.test/calls')).json()).calls,[first,second]);
    assert.equal((await article(db,first)).status,'complete');
    const completed=await article(db,second);
    assert.ok(completed.status==='complete',JSON.stringify(completed));
    assert.equal((await db.prepare("SELECT status FROM runs WHERE id='run-2'").first()).status,'complete');
  }finally{await mf.dispose();}
});

for(const [kind,message] of Object.entries(failures)){
  test(`recognizes ${message} as run-level deferral without consuming an article attempt`,async()=>{
    const {mf,db}=await fixture();
    try{
      await resetArticles(db,[
        [first,'https://jwc.cqu.edu.cn/info/1082/1.htm','全局限额第一篇','2026-01-03','pending',0],
        [second,'https://jwc.cqu.edu.cn/info/1082/2.htm','不应被吞掉的第二篇','2026-01-02','pending',0],
      ]);
      await run(mf,`run-${kind}`,kind);
      assert.deepEqual((await(await mf.dispatchFetch('https://feed.test/calls')).json()).calls,[first]);
      const deferred=await article(db,first),untouched=await article(db,second);
      assert.equal(deferred.status,'pending');
      assert.equal(deferred.attempts,0);
      assert.equal(deferred.lease_until,0);
      assert.equal(untouched.status,'pending');
      assert.equal(untouched.attempts,0);
    }finally{await mf.dispose();}
  });
}

test('a run cannot be complete while an article exhausted its own attempts as failed',async()=>{
  const {mf,db}=await fixture();
  try{
    await resetArticles(db,[
      [first,'https://jwc.cqu.edu.cn/info/1082/1.htm','已耗尽单篇尝试','2026-01-03','failed',3],
      [second,'https://jwc.cqu.edu.cn/info/1082/2.htm','本 run 可完成','2026-01-02','pending',0],
      [third,'https://jwc.cqu.edu.cn/info/1082/3.htm','另一个 run 正在采集','2026-01-01','collecting',1],
    ]);
    await db.prepare('UPDATE articles SET lease_until=? WHERE id=?').bind(Date.now()+60000,third).run();
    const result=await run(mf,'run-final','none');
    assert.deepEqual((await(await mf.dispatchFetch('https://feed.test/calls')).json()).calls,[second]);
    const completed=await article(db,second);
    assert.ok(completed.status==='complete',JSON.stringify(completed));
    assert.equal(result.errors.length>0,true);
    const runRow=await db.prepare("SELECT status,error FROM runs WHERE id='run-final'").first();
    assert.equal(runRow.status,'partial');
    assert.match(runRow.error,/unfinished/i);
  }finally{await mf.dispose();}
});
