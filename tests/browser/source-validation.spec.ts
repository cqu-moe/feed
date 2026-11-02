import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { test, expect } from '@playwright/test';

// Real browser page actions, signed bridge, AI adapter, D1 slots and R2 uploads.
// Only the public school responses and the external model response are fixtures.
test('historical samples preserve CAPTCHA sessions, large originals and reject challenge pages', async ({ page, context }) => {
  test.setTimeout(90_000);
  const secret='test-only-bridge-secret';
  const bridgeBundle=await build({stdin:{contents:`
    import {bridgeRoute} from './worker/bridge.mjs';
    export default {fetch(request,env){return bridgeRoute(request,{...env,AI:{run:async()=>({response:'1234'})}})}};
  `,resolveDir:process.cwd()},bundle:true,write:false,platform:'browser',format:'esm',external:['node:buffer']});
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bridgeBundle.outputFiles[0].text,
    compatibilityDate:'2026-10-11',compatibilityFlags:['nodejs_compat'],
    bindings:{BRIDGE_SECRET:secret},d1Databases:{DB:'bridge'},r2Buckets:{ARCHIVE:'archive'}}));
  try {
    const db=await mf.getD1Database('DB');
    await db.prepare('CREATE TABLE usage(day TEXT,kind TEXT,used INTEGER,PRIMARY KEY(day,kind))').run();
    await db.prepare('CREATE TABLE ocr_slots(run_id TEXT,slot INTEGER,result TEXT,created_at TEXT,PRIMARY KEY(run_id,slot))').run();
    const archive=await mf.getR2Bucket('ARCHIVE');
    const bundle=await build({entryPoints:['worker/source-validation.mjs'],bundle:true,write:false,
      platform:'node',format:'esm',external:['cloudflare:workers']});
    const {verifySource}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
    const source={id:'sample',url:'https://jwc.cqu.edu.cn/',listUrl:'https://jwc.cqu.edu.cn/list.htm',
      configVersion:1,enabled:false,validationTaskId:'test-validation',timezone:'Asia/Shanghai',
      config:{articlePattern:'^/info/\\d+/\\d+\\.htm$',sampleArticleUrl:'https://jwc.cqu.edu.cn/info/1/1.htm'}};
    const list='<meta charset="utf-8"><ul><li><a href="/info/1/2.htm">当前公告</a><time datetime="2026-11-02">2026-11-02</time></li></ul><a href="/list/2.htm">下一页</a>';
    const continuation='<meta charset="utf-8"><ul><li><span>2026-10-20</span><a href="https://mp.weixin.qq.com/s/public-article">重大青年公众号文章</a></li></ul>';
    const article=`<meta charset="utf-8"><title>历史附件样本-学院</title><div class="v_news_content"><h1>历史附件样本</h1><p>${'这是已公开的往期通知正文。'.repeat(20)}</p><a href="/file.pdf">附件.pdf</a><a href="/large.zip">大型附件.zip</a></div>`;
    const largeAttachment=Buffer.alloc(13*1024*1024+17,42);largeAttachment.set([0x50,0x4b,0x03,0x04]);
    const largeHash=createHash('sha256').update(largeAttachment).digest('hex');
    const sourceRequests:Array<{path:string;cookie:string}>=[];
    const bridgeCalls:string[]=[];
    let challenge=false,pdfBody=false,captchaDenied=false;
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.origin==='https://feed.test')return route.fulfill({status:403,body:'<title>Just a moment...</title>'});
      if(url.origin==='https://bridge.test'){
        bridgeCalls.push(url.pathname);
        const response=await mf.dispatchFetch(url.href,{method:route.request().method(),
          headers:route.request().headers(),body:route.request().postDataBuffer()??undefined});
        return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
      }
      if(url.origin!==new URL(source.url).origin)return route.abort();
      if(['/file.pdf','/large.zip','/captcha.png'].includes(url.pathname))
        sourceRequests.push({path:url.pathname,cookie:route.request().headers()['cookie']??''});
      if(url.pathname==='/captcha.png')return route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5XcAAAAASUVORK5CYII=','base64')});
      if(url.pathname==='/file.pdf')return route.fulfill({contentType:'application/pdf',body:'%PDF-1.7\nfixture-file-bytes'});
      if(url.pathname==='/large.zip')return !captchaDenied&&url.searchParams.get('codeValue')==='1234'
        ?route.fulfill({contentType:'application/zip',body:largeAttachment})
        :route.fulfill({contentType:'text/html',body:'<form><input name="codeValue"><img src="/captcha.png"></form>'});
      const body=url.pathname==='/list.htm'?list:url.pathname==='/list/2.htm'?continuation:challenge
        ?`<title>访问验证</title><p>${'请通过验证后继续访问。'.repeat(30)}</p>`:pdfBody
          ?'<title>历史正文 PDF</title><div class="v_news_content"><iframe src="/file.pdf"></iframe></div>':article;
      return route.fulfill({contentType:'text/html; charset=utf-8',
        headers:url.pathname==='/info/1/1.htm'?{'Set-Cookie':'source_session=t2; Path=/'}:{},body});
    });
    const verify=()=>verifySource({BASE_URL:'https://feed.test',BRIDGE_BASE_URL:'https://bridge.test',BRIDGE_SECRET:secret,ARCHIVE:archive},{
      find:async()=>source,recordValidation:async(_id:string,_version:number,evidence:unknown)=>({verified:true,evidence}),
      recordValidationFailure:async()=>{},
    },source.id,{source,taskId:source.validationTaskId,attemptNo:1,
      scrape:async(_env:unknown,url:string,options:{actions:{script:string}[]})=>{
        await page.goto(url);
        return {actions:{javascriptReturns:[{value:await page.evaluate(options.actions[0].script)}]}};
      }}).catch((error:Error)=>{throw new Error(error.message);});
    const result=await verify();
    expect(result.verified).toBe(true);
    expect(result.evidence).toMatchObject({listPages:2,paginationMode:'followed',articleBody:true,attachmentSample:true,snapshotSample:true});
    expect(result.evidence.fileHashes).toEqual([createHash('sha256').update('%PDF-1.7\nfixture-file-bytes').digest('hex'),largeHash]);
    expect(bridgeCalls.filter(path=>path==='/internal/solve')).toHaveLength(1);
    expect(bridgeCalls.filter(path=>path==='/internal/upload')).toHaveLength(1);
    const stored=(await archive.list()).objects.find(object=>object.key.endsWith('/attachment-2.zip'))!;
    expect(stored.size).toBe(largeAttachment.length);
    expect(Buffer.from(await (await archive.get(stored.key))!.arrayBuffer()).equals(largeAttachment)).toBe(true);
    const manifest=await (await archive.get(stored.key+'.upload.json'))!.json();
    expect(manifest).toMatchObject({sha256:largeHash,bytes:largeAttachment.length});
    const captchaRequests=sourceRequests.filter(request=>request.path!=='/file.pdf');
    expect(captchaRequests.length).toBeGreaterThanOrEqual(3);
    for(const request of captchaRequests)expect(request.cookie).toContain('source_session=t2');
    pdfBody=true;
    const pdfResult=await verify();
    expect(pdfResult.evidence.fileHashes).toEqual([createHash('sha256').update('%PDF-1.7\nfixture-file-bytes').digest('hex')]);
    pdfBody=false;captchaDenied=true;
    await expect(verify()).rejects.toThrow('Sample attachment was not retrieved');
    challenge=true;
    await expect(verify()).rejects.toThrow('Sample article body was not recognized');
  } finally {await mf.dispose();}
});
