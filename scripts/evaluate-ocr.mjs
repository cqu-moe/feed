// Evaluate saved provider responses against a visual transcription. No provider calls.
import {readFile,writeFile} from 'node:fs/promises';
const root='.private/ocr-comparison';
const gold=JSON.parse(await readFile(`${root}/visual-gold.json`,'utf8'));
const normalize=value=>String(value).normalize('NFKC').replace(/[\s\u00a0]/g,'').replace(/[•・]/g,'·');
const results=[];
for(const model of ['mistral-ocr-2512','mistral-ocr-4-1']){
  const response=JSON.parse(await readFile(`${root}/${model}.json`,'utf8'));
  const rows=[],pages=[];
  for(const doc of response.documents)for(const page of doc.pages){
    let count=0;
    for(const line of page.markdown.split('\n')){
      if(!line.includes('|'))continue;
      const cells=line.trim().replace(/^\||\|$/g,'').split('|').map(value=>value.trim());
      if(cells.length!==5||!/^\d+$/.test(cells[0]))continue;
      rows.push({page:page.index+1,cells});count++;
    }
    pages.push({page:page.index+1,rows:count});
  }
  const byId=new Map(rows.map(row=>[Number(row.cells[0]),row]));
  const duplicates=rows.filter((row,index)=>rows.findIndex(x=>x.cells[0]===row.cells[0])!==index).map(row=>row.cells[0]);
  const missing=Array.from({length:gold.expectedTotalRows},(_,index)=>index+1).filter(id=>!byId.has(id));
  const mismatches=[];let matchedCells=0;
  for(const expected of gold.rows){
    const actual=byId.get(expected[0]);
    expected.forEach((cell,index)=>{
      if(actual&&normalize(cell)===normalize(actual.cells[index]))matchedCells++;
      else mismatches.push({row:expected[0],column:index,expected:String(cell),actual:actual?.cells[index]??null,page:actual?.page??null});
    });
  }
  const output={model,pages,rows:rows.length,uniqueRows:byId.size,missing,duplicates,sampleRows:gold.rows.length,sampleCells:gold.rows.length*5,matchedCells,mismatches,estimatedUsd:response.documents.reduce((sum,doc)=>sum+doc.estimatedUsd,0),elapsedMs:response.documents.flatMap(doc=>doc.calls).reduce((sum,call)=>sum+call.elapsedMs,0)};
  results.push({output,byId});
}
const differences=[];
for(let row=1;row<=gold.expectedTotalRows;row++){
  const left=results[0].byId.get(row),right=results[1].byId.get(row);
  if(!left||!right||left.cells.some((cell,i)=>normalize(cell)!==normalize(right.cells[i])))differences.push({row,ocr3:left,ocr4:right});
}
const review=JSON.parse(await readFile(`${root}/reviewed-differences.json`,'utf8'));
const reviewedNames=results.map(result=>({model:result.output.model,total:Object.keys(review.names).length,correct:Object.entries(review.names).filter(([row,name])=>normalize(result.byId.get(Number(row))?.cells[2])===normalize(name)).length}));
const report={results:results.map(result=>result.output),differences,reviewedNames,reviewMethod:review.method};
await writeFile(`${root}/evaluation.json`,JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify({results:report.results.map(({mismatches,...rest})=>({...rest,mismatches:mismatches.length})),differentRows:differences.length,reviewedNames},null,2));
