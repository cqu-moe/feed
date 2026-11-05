import {test} from 'node:test';
import assert from 'node:assert/strict';
import {searchFixture} from './helpers/bailian-fixture.mjs';
import {mixedPdf} from './helpers/mixed-pdf.mjs';

test('web table keeps cells together; mixed ordinary PDF indexes its native page without paying for scan OCR',async t=>{
  const f=await searchFixture(t,`import {appendSearchPdf,webSearchText} from './worker/bailian-evidence.mjs';
    export default {async fetch(req,env){const p={documents:[],skipped:[]};await appendSearchPdf(env,p,{slot:'pdf:1',filename:'attachment-1.pdf',
      name:'报名表',objectKey:'pdf',kind:'attachment'});
      const text=await webSearchText(env,'snapshot','申请条件\\n年级 金额 大二 380 元',p.documents);
      return Response.json({...p,text});
    }};`);
  await f.bucket.put('pdf',mixedPdf({firstPageText:'Make-up exam registration'}));
  await f.bucket.put('snapshot','<table><tr><th>年级</th><th>金额</th></tr><tr><td>大二</td><td>380 元</td></tr></table>');
  const {text,documents,skipped}=await (await f.fetch('/')).json();
  assert.match(text,/年级 \| 金额\n大二 \| 380 元/);
  assert.deepEqual(documents[0].pages,[{number:1,text:'Make-up exam registration'}]);
  assert.equal(skipped[0].reason,'ordinary_scan_no_text');assert.equal(skipped[0].blocked,false);
});
