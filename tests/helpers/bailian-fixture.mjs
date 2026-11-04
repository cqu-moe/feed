import {readdir,readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {applyMigration} from './subscriptions-fixture.mjs';

export async function searchFixture(t,entry,{outbound,beforeMigration}={}){
  const bundle=await build({stdin:{resolveDir:process.cwd(),contents:entry},bundle:true,write:false,format:'esm',
    platform:'browser',external:['node:*','cloudflare:workers']});
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-11',
    compatibilityFlags:['nodejs_compat'],bindings:{BAILIAN_SEARCH_WRITES:'true',BAILIAN_SEARCH_READS:'true',
      ARCHIVE_READS_ENABLED:'true',SOURCE_MANAGEMENT_ENABLED:'true',BAILIAN_API_KEY:'local-test',BAILIAN_WORKSPACE_ID:'sample',
      BAILIAN_CATEGORY_ID:'feed',BAILIAN_INDEX_ID:'index',BAILIAN_SEARCH_SERVICE_ID:'service'},
    d1Databases:['DB'],r2Buckets:['ARCHIVE'],outboundService:outbound??(()=>{throw new Error('Unexpected network request');})}));
  t.after(()=>mf.dispose());
  const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('ARCHIVE');
  for(const file of (await readdir('migrations')).filter(f=>f.endsWith('.sql')).sort()){
    if(file.startsWith('0022')&&beforeMigration)await beforeMigration(db,bucket);
    await applyMigration(db,(await readFile('migrations/'+file,'utf8')).replace(/^\s*--[^\n]*/gm,''));
  }
  return {db,bucket,mf,fetch:path=>mf.dispatchFetch('https://feed.test'+path)};
}

export const site='7fd03676e5751e9b6dd95ecb';
export async function seedSources(db){
  await db.prepare("INSERT OR IGNORE INTO sources(id,site_id,name,url) VALUES ('jwc',?,'教务处','https://school.test/'),('second',?,'教学动态','https://school.test/news')").bind(site,site).run();
}
export async function notice(db,id,title,body,day){
  await db.prepare(`INSERT INTO articles(id,source_id,url,title,published_at,discovered_at,status,body_text,excerpt)
    VALUES (?,'jwc',?,?,?,'2025-01-01','complete',?,?)`).bind(id,'https://school.test/'+id,title,day,body,body).run();
}
