// Run from repo root; output belongs in an ignored work/ subdirectory.
import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,relative,resolve} from 'node:path';
const [name,id,mode]=process.argv.slice(2);
if(!/^cqu-feed63-rehearsal-[a-z0-9]{4,12}$/.test(name)||!['queue','workflow'].includes(mode))throw Error('Expected unique cqu-feed63-rehearsal-<suffix>, isolated D1 UUID and queue|workflow');
const prod=JSON.parse(await readFile('wrangler.jsonc','utf8'));
if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id)||prod.d1_databases.some(d=>d.database_id===id))throw Error('Refusing invalid or production database');
const dir=resolve('work',name),image=join(dir,'fixture');
await mkdir(dir,{recursive:true});
await cp('crawler',image,{recursive:true});
const asset=path=>readFile('live/FEED-63/'+path);
const extras=['origin.mjs','chrome-fixture.sh','start-fixture.sh'];
for(const file of extras)await writeFile(join(image,file),await asset(file));
await writeFile(join(image,'.dockerignore'),(await readFile('crawler/.dockerignore','utf8'))+'\n'+extras.map(f=>'!'+f).join('\n')+'\n');
await writeFile(join(image,'Dockerfile'),(await readFile('crawler/Dockerfile','utf8')).replace(/^CMD .*$/m,'')+'\n'+await asset('fixture.Dockerfile'));
const cfg={name,account_id:prod.account_id,compatibility_date:prod.compatibility_date,compatibility_flags:prod.compatibility_flags,
 main:relative(dir,resolve('live/FEED-63/probe.mjs')),workers_dev:false,preview_urls:false,
 vars:{ENVIRONMENT:'preview',SOURCE_MANAGEMENT_ENABLED:'true',CRAWL_ENABLED:'true',TASK_RUNTIME_ENABLED:'true',MAIL_ENABLED:'false',MAX_DISCOVERY_PAGES_PER_RUN:'1',MAX_TASK_ATTEMPTS:'3',TASK_RETRY_BASE_DELAY_MS:'1000',COLLECTION_EXECUTOR:mode},
 queues:{producers:[{binding:'FEED_JOBS',queue:name+'-jobs'}],consumers:[{queue:name+'-jobs',max_batch_size:1,max_batch_timeout:1,...(mode==='queue'?{max_concurrency:2}:{})}]},
 d1_databases:[{binding:'DB',database_name:name+'-db',database_id:id,migrations_dir:relative(dir,resolve('migrations'))}],
 r2_buckets:[{binding:'ARCHIVE',bucket_name:name+'-archive'}],
 workflows:[{name:name+'-discovery',binding:'DISCOVERY',class_name:'DiscoveryWorkflow'},{name:name+'-driver',binding:'PROBE',class_name:'Probe'}],
 durable_objects:{bindings:[{name:'BROWSER',class_name:'FeedBrowser'}]},migrations:[{tag:'v1',new_sqlite_classes:['FeedBrowser']}],
 containers:[{class_name:'FeedBrowser',image:'./fixture/Dockerfile',max_instances:3,instance_type:'basic',constraints:{regions:['APAC']}}]};
await writeFile(join(dir,'wrangler.json'),JSON.stringify(cfg,null,2)+'\n');console.log(join(dir,'wrangler.json'));
