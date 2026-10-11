import {readFile,mkdir,writeFile} from 'node:fs/promises';
const [action='status',model]=process.argv.slice(2);
const articleId='4ffc0415b5f4ba168a847f01';
const models=['mistral-ocr-2512','mistral-ocr-4-1'];
if(!['start','status','results','publish'].includes(action)||(['start','results','publish'].includes(action)&&!models.includes(model)))throw new Error('Usage: compare-ocr.mjs status | start|results|publish <model>');
const secrets=process.env.FEED_ADMIN_TOKEN?{ADMIN_TOKEN:process.env.FEED_ADMIN_TOKEN}:JSON.parse(await readFile('.private/production-secrets.json','utf8'));
const base=process.env.FEED_URL||'https://cqu-feed.user-unauthorized.workers.dev';
const url=new URL(`/internal/pdf-ocr/${articleId}`,base);
if(action==='results')url.searchParams.set('model',model);
const post=['start','publish'].includes(action);
const response=await fetch(url,{method:post?'POST':'GET',headers:{Authorization:`Bearer ${secrets.ADMIN_TOKEN}`,'Content-Type':'application/json'},body:post?JSON.stringify({model,publish:action==='publish'}):undefined,signal:AbortSignal.timeout(30000)});
if(!response.ok)throw new Error(`OCR admin HTTP ${response.status}`);
const result=await response.json();
if(action==='results'){
  await mkdir('.private/ocr-comparison',{recursive:true,mode:0o700});
  await writeFile(`.private/ocr-comparison/${model}.json`,JSON.stringify(result,null,2),{mode:0o600});
  for(const doc of result.documents)await writeFile(`.private/ocr-comparison/${model}.md`,doc.pages.map(page=>`## Page ${page.index+1}\n\n${page.markdown}`).join('\n\n'),{mode:0o600});
  console.log(JSON.stringify({model,documents:result.documents.map(doc=>({pages:doc.totalPages,estimatedUsd:doc.estimatedUsd,characters:doc.pages.reduce((n,p)=>n+p.text.length,0),calls:doc.calls.map(call=>({actualModel:call.model,elapsedMs:call.elapsedMs,usage:call.usageInfo}))}))},null,2));
}else console.log(JSON.stringify(result,null,2));
