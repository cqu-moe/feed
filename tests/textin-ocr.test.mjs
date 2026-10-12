import { test } from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {TEXTIN_CACHE_VERSION,TEXTIN_MODEL,parseTextinResult,textinConfig,textinOcr} from '../worker/textin-ocr.mjs';

const pdf=new TextEncoder().encode('%PDF-1.7\nCQU scanned notice');
const env={TEXTIN_APP_ID:'test-app-id',TEXTIN_SECRET_CODE:'test-secret-code'};

test('TextIn integration fixtures map the only provider-returned page to its original PDF page',async()=>{
  const single=JSON.parse(await readFile('tests/fixtures/textin-single-page-success.json','utf8'));
  const mixed=JSON.parse(await readFile('tests/fixtures/textin-mixed-page-2-success.json','utf8'));
  assert.deepEqual(parseTextinResult(single,{pages:[0]}).pages.map(page=>[page.index,page.text]),[[0,'scanned page text']]);
  assert.deepEqual(parseTextinResult(mixed,{pages:[1]}).pages.map(page=>[page.index,page.text]),[[1,'second scanned page']]);
});

async function withFetch(mockFetch,action){
  const originalFetch=globalThis.fetch;
  globalThis.fetch=mockFetch;
  try{return await action();}
  finally{globalThis.fetch=originalFetch;}
}

test('TextIn config uses the benchmarked xparse settings and one-based page ranges',()=>{
  assert.deepEqual(textinConfig([3,0,1]),{
    capabilities:{
      include_char_details:true,
      include_table_structure:true,
      pages:true,
      table_view:'html',
      element_merge_mode:'separate',
    },
    scope:{page_range:'1-2,4'},
    config:{force_engine:'textin',engine_params:{parse_mode:'auto'}},
  });
  assert.equal(TEXTIN_MODEL,'textin-xparse-auto');
  assert.equal(TEXTIN_CACHE_VERSION,'v1');
});

test('TextIn OCR sends multipart PDF requests and maps provider pages back to zero-based pages',async()=>{
  const calls=[];
  const payload=successfulPayload();
  const result=await withFetch(async(request,init)=>{
    calls.push({request,init});
    return Response.json(payload);
  },()=>textinOcr(env,{bytes:pdf.buffer,pages:[3,0,1]}));

  assert.equal(calls.length,1);
  assert.equal(calls[0].request,'https://api.textin.com/api/v1/xparse/parse/sync');
  assert.equal(calls[0].init.method,'POST');
  assert.equal(calls[0].init.redirect,'manual');
  assert.equal(calls[0].init.signal instanceof AbortSignal,true);
  assert.equal(calls[0].init.headers['x-ti-app-id'],'test-app-id');
  assert.equal(calls[0].init.headers['x-ti-secret-code'],'test-secret-code');
  const form=await new Request(calls[0].request,calls[0].init).formData();
  const file=form.get('file');
  assert.equal(file.name,'document.pdf');
  assert.equal(file.type,'application/pdf');
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()),pdf);
  assert.deepEqual(JSON.parse(form.get('config')),textinConfig([0,1,3]));

  assert.equal(result.model,TEXTIN_MODEL);
  assert.equal(result.requestedModel,TEXTIN_MODEL);
  assert.deepEqual(result.pages.map(page=>page.index),[0,1,3]);
  assert.deepEqual(result.usageInfo,{pages_processed:3});
  assert.deepEqual(result.raw,payload);
  assert.equal(result.elapsedMs>=0,true);
  assert.equal(result.estimatedUsd,0);
  assert.equal(result.estimatedCny,null);
  assert.equal(result.configVersion,TEXTIN_CACHE_VERSION);

  const tablePage=result.pages[1].markdown;
  assert.equal(tablePage.split('\n\n')[0].split('\n').length,4);
  assert.match(tablePage,/^\| .* \| .* \| .* \|$/m);
  assert.match(tablePage,/\| --- \| --- \| --- \|/);
  assert.match(tablePage,/&lt;script&gt;alert\("paid"\)/);
  assert.doesNotMatch(tablePage,/<table|<script|<\/b>/);
  assert.match(result.pages[1].text,/<script>alert\("paid"\)/);
  assert.match(result.pages[1].text,/列 A/);
  assert.match(result.pages[1].markdown,/竖线\\\|/);
  assert.match(result.pages[1].text,/竖线/);
  assert.match(result.pages[0].text,/第一页段落/);
  assert.match(result.pages[2].text,/continuation/);
  assert.match(result.pages[2].markdown,/continuation/);
});

test('TextIn OCR persists raw responses before provider and parsing failures',async()=>{
  const saved=[];
  await assert.rejects(
    () => withFetch(async()=>Response.json({code:40307,message:`quota exhausted ${env.TEXTIN_SECRET_CODE}`}),()=>textinOcr(env,{
      bytes:pdf,pages:[0],onRawResponse:async payload=>{saved.push(payload);},
    })),
    error=>error.code===40307&&!/test-secret-key|test-secret-code/.test(error.message),
  );
  assert.equal(saved.length,1);
  assert.equal(saved[0].code,40307);

  const invalidPayload={code:200,data:{schema_version:'1.4.0'}};
  await assert.rejects(
    () => withFetch(async()=>Response.json(invalidPayload),()=>textinOcr(env,{
      bytes:pdf,pages:[0],onRawResponse:async payload=>{saved.push(payload);},
    })),
    /missing (pages|elements)/,
  );
  assert.equal(saved.length,2);
  assert.deepEqual(saved[1],invalidPayload);
});

test('TextIn OCR rejects a malformed raw hook before making a paid request',async()=>{
  await assert.rejects(() => withFetch(()=>{
    throw new Error('provider must not be called');
  },()=>textinOcr(env,{bytes:pdf,pages:[0],onRawResponse:null})),/onRawResponse/);
});

test('TextIn OCR validates credentials, PDF bytes, and page selections before HTTP',async()=>{
  await assert.rejects(() => textinOcr({}, {bytes:pdf, pages:[0]}), /TEXTIN_APP_ID is required/);
  await assert.rejects(() => textinOcr({TEXTIN_APP_ID:'id'}, {bytes:pdf, pages:[0]}), /TEXTIN_SECRET_CODE is required/);
  await assert.rejects(() => textinOcr(env, {bytes:new TextEncoder().encode('not pdf'), pages:[0]}), /%PDF/);
  const oversized=new Uint8Array(12*1024*1024+1);
  oversized.set(pdf.subarray(0,4));
  await assert.rejects(() => textinOcr(env,{bytes:oversized,pages:[0]}),/exceeds 12 MiB/);
  await assert.rejects(() => textinOcr(env,{bytes:pdf,pages:[]}),/non-empty/);
  await assert.rejects(() => textinOcr(env,{bytes:pdf,pages:[0,0]}),/duplicated/);
  await assert.rejects(() => textinOcr(env,{bytes:pdf,pages:[100]}),/0 through 99/);
  await assert.rejects(() => textinOcr(env,{bytes:pdf,pages:Array.from({length:21},(_,index)=>index)}),/exceeds 20 pages/);
});

test('TextIn parse rejects missing, duplicate, out-of-range, and unsuccessful pages',()=>{
  const valid=successfulPayload();
  const variants=[
    {...valid,data:{...valid.data,pages:valid.data.pages.slice(1)}},
    {...valid,data:{...valid.data,pages:[...valid.data.pages,valid.data.pages[0]]}},
    {...valid,data:{...valid.data,pages:[...valid.data.pages,{...valid.data.pages[0],page_number:5}]}},
    {...valid,data:{...valid.data,pages:valid.data.pages.map((page,index)=>index===0?{...page,status:'Failed'}:page)}},
    {...valid,data:{...valid.data,success_count:2}},
    {...valid,data:{...valid.data,metadata:{...valid.data.metadata,page_count:2}}},
  ];
  for(const payload of variants){
    assert.throws(() => parseTextinResult(payload,{pages:[0,1,3]}),Error);
  }
  assert.throws(() => parseTextinResult({...valid,code:40424},{pages:[0,1,3]}),error=>error.code===40424);
  const invalidLink=JSON.parse(JSON.stringify(valid));
  invalidLink.data.elements.find(element=>element.element_id==='table-2').metadata.continuation_of='table-2';
  assert.throws(() => parseTextinResult(invalidLink,{pages:[0,1,3]}),/invalid continuation link/);
});

test('TextIn OCR rejects oversized responses before JSON parsing',async()=>{
  await withFetch(async()=>new Response('{}',{
    headers:{'Content-Length':String(24*1024*1024+1)},
  }),async()=>{
    await assert.rejects(() => textinOcr(env,{bytes:pdf,pages:[0]}),/exceeds 24 MiB/);
  });
});

function successfulPayload(){
  return {
    code:200,
    message:'success',
    data:{
      schema_version:'1.4.0',
      file_id:'file-test',
      job_id:'job-test',
      success_count:3,
      metadata:{filename:'document.pdf',filetype:'application/pdf',page_count:5},
      pages:[
        {page_number:1,status:'Success',element_ids:['text-1']},
        {page_number:2,status:'Success',element_ids:['table-1','text-2']},
        {page_number:4,status:'Success',element_ids:['table-2']},
      ],
      elements:[
        {element_id:'text-1',type:'NarrativeText',text:'第一页段落',page_number:1,metadata:{}},
        {
          element_id:'table-1',type:'Table',text:'<table><script>unused</script></table>',page_number:2,
          metadata:{is_continuation:false},
          table_structure:{rows:3,cols:3,cells:[
            {row:1,col:1,row_span:2,col_span:1,text:'跨行'},
            {row:1,col:2,row_span:1,col_span:2,text:'列 A'},
            {row:2,col:3,row_span:1,col_span:1,text:'<script>alert("paid")</script>'},
            {row:3,col:1,row_span:1,col_span:1,text:'竖线|'},
            {row:3,col:2,row_span:1,col_span:1,text:'值 & <b>安全</b>'},
            {row:3,col:3,row_span:1,col_span:1,text:'结束'},
          ]},
        },
        {element_id:'text-2',type:'NarrativeText',text:'表格后段落',page_number:2,metadata:{}},
        {
          element_id:'table-2',type:'Table',text:'<table>continuation</table>',page_number:4,
          metadata:{is_continuation:true,continuation_of:'table-1'},
          table_structure:{rows:1,cols:1,cells:[{row:1,col:1,row_span:1,col_span:1,text:'continuation'}]},
        },
      ],
      summary:{duration_ms:12},
    },
  };
}
