import {extractText,getDocumentProxy,getResolvedPDFJS} from 'unpdf';
import {put,sha} from './utils.mjs';
import {readingExcerpt} from './reading.mjs';
export const PDF_TEXT_UNAVAILABLE='PDF 正文暂未提取到可搜索文字；可在下方阅读原文件。';
export async function pdfPages(buffer){
  if(buffer.byteLength>12*1024*1024)throw new Error('PDF text extraction exceeds 12 MiB');
  const pdf=await getDocumentProxy(new Uint8Array(buffer),{isEvalSupported:false,disableFontFace:true});
  try{
    if(pdf.numPages>100)throw new Error('PDF text extraction exceeds 100 pages');
    const {OPS}=await getResolvedPDFJS(),pages=[];
    const imageOps=new Set(['paintImageXObject','paintInlineImageXObject','paintImageMaskXObject','paintImageXObjectRepeat','paintImageMaskXObjectRepeat','paintSolidColorImageMask'].map(key=>OPS[key]).filter(Number.isInteger));
    for(let number=1;number<=pdf.numPages;number++){
      const page=await pdf.getPage(number),content=await page.getTextContent();
      const text=content.items.filter(item=>'str' in item).map(item=>item.str+(item.hasEOL?'\n':' ')).join('').trim();
      const operators=await page.getOperatorList(),hasImages=operators.fnArray.some(op=>imageOps.has(op));
      const chars=text.replace(/\s/g,''),corrupt=(chars.match(/[\uFFFD\u0000-\u0008]/g)||[]).length;
      // A sparse caption/page number does not make an otherwise scanned page searchable.
      const needsOcr=(hasImages&&chars.length<80)||corrupt>Math.max(2,chars.length*.1);
      pages.push({index:number-1,text,hasImages,needsOcr});
      page.cleanup();
    }
    return {pages,totalPages:pdf.numPages};
  }finally{await pdf.loadingTask.destroy();}
}
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
