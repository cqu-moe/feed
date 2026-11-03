import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {cloudflareEntrypointPlugin} from './helpers/cloudflare-entrypoint-plugin.ts';

const bundle=await build({entryPoints:['worker/source-validation.mjs'],bundle:true,write:false,format:'esm',platform:'node',plugins:[cloudflareEntrypointPlugin]});
const {verifySource}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text+'\n//# sourceURL=source-validation-fixture.mjs').toString('base64')}`);

test('source verification accepts the matching Youth content endpoint and rejects different article identities',async()=>{
  const original='https://youth.cqu.edu.cn/info/1009/25310.htm';
  const official='https://youth.cqu.edu.cn/content.jsp?urltype=news.NewsContentUrl&wbtreeid=1009&wbnewsid=25310';
  for(const [pageUrl,accepted] of [
    [official,true],[original,true],
    [official.replace('25310','25311'),false],
    [official.replace('youth.cqu.edu.cn','jwc.cqu.edu.cn'),false],
  ]){
    const source={
      id:'youth',siteId:'youth',url:'https://youth.cqu.edu.cn',listUrl:'https://youth.cqu.edu.cn/index/xxgs.htm',
      configVersion:1,validationTaskId:'verify-youth',enabled:false,
      config:{articlePattern:'^/info/[0-9]+/[0-9]+[.]htm$',sampleArticleUrl:original},
    };
    let saved;
    const sources={async find(){return source;},async recordValidation(_id,_version,evidence){saved=evidence;return evidence;},async recordValidationFailure(){}};
    const scrape=async(_env,url,options)=>({actions:{javascriptReturns:[{value:options.readiness
      ?{articles:[{url:original,title:'公开通知'}],next:[]}
      :{
        bodyRecognized:true,page:{url:pageUrl},bodyText:'公开通知正文',
        attachmentCandidates:[{url:'https://youth.cqu.edu.cn/notice.pdf',role:'body-pdf'}],
        downloads:[{url:'https://youth.cqu.edu.cn/notice.pdf',originalFile:true,saved:{name:'attachment-1.pdf'}}],
        artifacts:[
          {name:'attachment-1.pdf',base64:Buffer.from('%PDF-1.7\npublic notice').toString('base64')},
          {name:'offline.html',base64:Buffer.from('<article>公开通知</article>').toString('base64')},
        ],
      },
    }]}});
    const run=()=>verifySource({BASE_URL:'https://feed.test',BRIDGE_SECRET:'test-only-bridge'},sources,source.id,{source,taskId:'verify-youth',attemptNo:1,scrape});
    if(accepted){
      await run();assert.equal(saved.articleBody,true);assert.equal(saved.attachmentSample,true);assert.equal(saved.snapshotSample,true);
    }else{
      await assert.rejects(run(),/Sample article body was not recognized/);assert.equal(saved,undefined);
    }
  }
});
