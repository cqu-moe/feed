import {sha} from './utils.mjs';
import {readingText} from './reading.mjs';

const normalize=value=>String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim();

export function fingerprintContent({title,body,files}){
  return sha(JSON.stringify({v:1,title:normalize(title),body:normalize(readingText(body)),
    files:files.map(row=>[normalize(row.name),row.kind,row.objectHash])}));
}
