import {extractText,getDocumentProxy} from 'unpdf';
import {put,sha} from './utils.mjs';
import {readingExcerpt} from './reading.mjs';
export const PDF_TEXT_UNAVAILABLE='PDF 正文暂未提取到可搜索文字；可在下方阅读原文件。';
export async function pdfText(buffer){
  if(buffer.byteLength>12*1024*1024)throw new Error('PDF text extraction exceeds 12 MiB');
  const pdf=await getDocumentProxy(new Uint8Array(buffer),{isEvalSupported:false,disableFontFace:true});
  try{
    if(pdf.numPages>100)throw new Error('PDF text extraction exceeds 100 pages');
    const result=await extractText(pdf,{mergePages:true});
    return {text:result.text.trim(),totalPages:result.totalPages};
  }finally{await pdf.loadingTask.destroy();}
}
export async function repairPdfText(env,id){
  const article=await env.DB.prepare('SELECT prefix,body_text,content_hash FROM articles WHERE id=?').bind(id).first();
  if(!article?.prefix||!article.body_text.includes('暂未提取到可搜索文字'))return {id,updated:false,reason:'No missing PDF text'};
  const rows=await env.DB.prepare("SELECT object_key FROM attachments WHERE article_id=? AND role='body-pdf' AND status='complete' ORDER BY id").bind(id).all();
  const texts=[];let pages=0;
  for(const row of rows.results){
    const object=await env.ARCHIVE.get(row.object_key);if(!object)throw new Error('Saved PDF missing');
    const result=await pdfText(await object.arrayBuffer());texts.push(result.text);pages+=result.totalPages;
  }
  const text=texts.join('\n\n').trim();if(!text)return {id,updated:false,reason:'No extractable PDF text layer'};
  const artifact=await put(env,article.prefix,'reading-v2.txt',text,'text/plain; charset=utf-8');
  await put(env,article.prefix,'reading-v2-manifest.json',JSON.stringify({extractor:'unpdf@1.8.1',pages,artifact}),'application/json');
  const updated=await env.DB.prepare('UPDATE articles SET body_text=?,excerpt=?,content_hash=? WHERE id=? AND content_hash=? RETURNING id').bind(text,readingExcerpt(text),await sha(text),id,article.content_hash).first();
  return {id,updated:!!updated,characters:text.length,pages};
}
