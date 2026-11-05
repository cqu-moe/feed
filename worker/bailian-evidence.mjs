import {pdfPages,PDF_TEXT_UNAVAILABLE} from './pdf-text.mjs';
import {readingText} from './reading.mjs';
import {readArchivedTables} from './reading-tables.mjs';

export async function webSearchText(env,tableKey,source,pdfDocuments){
  let text=readingText(source).replaceAll(PDF_TEXT_UNAVAILABLE,'').trim();
  // The capture may already have appended native page text to the HTML body.
  // Remove only an exact transcript, never an arbitrary occurrence of a keyword.
  for(const doc of pdfDocuments){
    if(doc.label.startsWith('正文 PDF')&&doc.text)text=text.replace(doc.text,'').trim();
  }
  for(const t of (await readArchivedTables(env,tableKey,text)).reverse()){
    const rows=t.rows.map(row=>row.map(c=>c.text.replaceAll('|','\\|')).join(' | ')).join('\n');
    text=text.slice(0,t.start)+rows+text.slice(t.end);
  }
  return /^(?:详见|见|请见)(?:下方|以下)?附件[。！.!\s]*$/.test(text)?'':text;
}

async function cachedPages(env,hash){
  if(!hash)return null;
  const row=await env.DB.prepare(`SELECT result_key AS key FROM pdf_ocr_jobs WHERE source_hash=? AND status='complete' AND model=? AND result_key IS NOT NULL ORDER BY updated_at DESC LIMIT 1`)
    .bind(hash,env.PDF_OCR_MODEL??'textin-xparse-auto').first();
  const derived=!row&&await env.DB.prepare(`SELECT o.r2_key AS key FROM derived_outputs d JOIN artifact_objects o ON o.sha256=d.result_hash
    WHERE d.input_hash=? AND d.processor IN ('textin-ocr','mistral-ocr') ORDER BY d.completed_at DESC LIMIT 1`).bind(hash).first();
  const key=(row||derived)?.key;
  if(!key)return null;
  const object=await env.ARCHIVE.get(key);
  if(!object||object.size>12*1024*1024)return null;
  const result=await object.json();
  if((result?.sourceHash??result?.inputHash)!==hash||!Array.isArray(result.pages))return null;
  return result.pages.map(p=>({number:p.index+1,text:p.markdown||p.text}));
}

export async function appendSearchPdf(env,projection,file,knownPages){
  const {slot,filename,objectKey,objectHash}=file;
  const body=file.kind==='body_pdf',label=body?'正文 PDF':'附件：'+(file.name||filename||'PDF');
  const skip=(reason,blocked=false)=>projection.skipped.push({slot,filename,label,reason,blocked});
  if(!body&&file.contentType!=='application/pdf'&&!/\.pdf$/i.test(filename??''))return skip('non_pdf_attachment');
  if(!objectKey)return skip('file_unavailable',true);
  const head=await env.ARCHIVE.head(objectKey);
  if(!head)return skip('file_unavailable',true);
  let pages=knownPages?.length?knownPages:await cachedPages(env,objectHash);
  let missing=false;
  if(!pages){
    if(head.size>12*1024*1024)return skip('file_exceeds_extraction_limit',true);
    const object=await env.ARCHIVE.get(objectKey);
    if(!object)return skip('file_unavailable',true);
    try{
      const native=await pdfPages(await object.arrayBuffer());
      missing=native.pages.some(p=>p.needsOcr);
      pages=native.pages.map(p=>({number:p.index+1,text:p.text}));
    }catch{return skip('pdf_unreadable',true);}
  }
  pages=pages.filter(p=>Number.isSafeInteger(p.number)&&p.number>0&&typeof p.text==='string'&&p.text.trim())
    .map(p=>({number:p.number,text:p.text.trim()}));
  if(!pages.length)return skip(body?'body_pdf_missing_text':'ordinary_scan_no_text',body);
  projection.documents.push({slot,filename,label,text:pages.map(p=>p.text).join('\n\n'),pages});
  if(missing)projection.skipped.push({slot:slot+':scan',filename,label,reason:body?'body_pdf_missing_pages':'ordinary_scan_no_text',blocked:body});
}
