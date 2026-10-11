// Rebuild derived reading text from already captured text. R2 originals stay
// immutable, and no crawler/provider calls are made. Defaults to a dry run.
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {readingText,readingExcerpt} from '../worker/reading.mjs';
const remote=process.argv.includes('--remote')?'--remote':'--local';
const apply=process.argv.includes('--apply');
const query="SELECT id,body_text,content_hash FROM articles WHERE body_text IS NOT NULL ORDER BY id";
const run=args=>{
  const raw=execFileSync('./node_modules/.bin/wrangler',['d1','execute','DB',remote,...args,'--json'],{encoding:'utf8',maxBuffer:32*1024*1024});
  // Wrangler file imports can emit progress before the JSON result.
  return JSON.parse(raw.slice(raw.search(/^[ \t]*[\[{]/m)));
};
const rows=run(['--command',query]).flatMap(result=>result.results??[]);
const changed=rows.map(row=>({...row,cleaned:readingText(row.body_text)})).filter(row=>row.cleaned!==row.body_text);
console.log(JSON.stringify({mode:apply?'apply':'dry-run',articles:rows.length,changed:changed.length,scannedPdf:changed.filter(row=>row.cleaned.startsWith('正文为扫描版 PDF')).length}));
if(apply&&changed.length){
  await mkdir('.private',{recursive:true});
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  await writeFile(`.private/reading-before-${stamp}.json`,JSON.stringify(changed),{mode:0o600});
  const quote=value=>value===null?'NULL':"'"+value.replaceAll("'","''")+"'";
  const sql=changed.map(row=>`UPDATE articles SET body_text=${quote(row.cleaned)},excerpt=${quote(readingExcerpt(row.cleaned))},content_hash=${quote(createHash('sha256').update(row.cleaned).digest('hex'))} WHERE id=${quote(row.id)} AND content_hash IS ${quote(row.content_hash)};`).join('\n');
  const path=`.private/reading-update-${stamp}.sql`;await writeFile(path,sql,{mode:0o600});
  const result=run(['--file',path]);if(result.some(row=>row.success===false))throw new Error('Reading reindex failed');
  console.log(JSON.stringify({applied:changed.length}));
}
