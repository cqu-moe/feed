import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

// Independent PDF fixture: one page with a real text layer, not a parser mock.
function fixture(){
  const stream='BT /F1 12 Tf 72 120 Td (CQU scholarship notice) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf='%PDF-1.4\n';const offsets=[0];
  objects.forEach((object,index)=>{offsets.push(pdf.length);pdf+=`${index+1} 0 obj\n${object}\nendobj\n`;});
  const start=pdf.length;pdf+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('');
  return pdf+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
}

test('PDF text extraction executes in Workers without a browser or remote converter',async()=>{
  const bundle=await build({stdin:{contents:"import {pdfText} from './worker/pdf-text.mjs'; export default {async fetch(request){return Response.json(await pdfText(await request.arrayBuffer()))}}",resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser',external:['node:*']});
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-11',compatibilityFlags:['nodejs_compat']}));
  try{
    const r=await mf.dispatchFetch('https://feed.test/extract',{method:'POST',body:fixture()});
    assert.equal(r.status,200);const result=await r.json();assert.equal(result.totalPages,1);assert.equal(result.text,'CQU scholarship notice');
  }finally{await mf.dispose();}
});
