import {script as singleFileBundle} from 'single-file-cli/lib/single-file-bundle.js';
import singleFileOptions from './singlefile-options.json';
import {captchaPage} from './page-action.mjs';
import {issueGrant} from './bridge.mjs';
import {scrape} from './browser-scrape.mjs';
import {discoverList} from './discovery.mjs';
import {canonicalUrl} from './sources.mjs';
import {articleId,fileKind,sha,cleanError} from './utils.mjs';
import {Buffer} from 'node:buffer';

export async function verifySource(env,sources,sourceId,{source,taskId,attemptNo,scrape:scrapeDependency=scrape,siteAdmission}){
  const current=await sources.find(sourceId);
  if(!current||current.configVersion!==source.configVersion||current.validationTaskId!==taskId||current.enabled)return {superseded:true};
  try{
    const evidence=await collectEvidence(env,source,scrapeDependency,siteAdmission);
    return sources.recordValidation(source.id,source.configVersion,evidence,{taskId,attemptNo});
  }catch(error){
    await sources.recordValidationFailure(source.id,source.configVersion,error,{taskId,attemptNo});
    throw error;
  }
}

async function collectEvidence(env,source,scrapeDependency,siteAdmission){
  const scrapeOptions=siteAdmission?{siteAdmission,executionHandoff:false}:{};
  const first=await discoverList(env,source,source.listUrl,{...scrapeOptions,scrape:scrapeDependency,baselineCutoffAt:source.baselineCutoffAt??today()});
  if(!first.articles.length)throw validationError('Sample verification found no article links');
  const paginationUrls=[];
  for(const url of first.next.slice(0,1)){
    await discoverList(env,source,url,{...scrapeOptions,scrape:scrapeDependency,baselineCutoffAt:first.baselineCutoff,allowExternalOnly:true});
    paginationUrls.push(url);
  }
  if(!Array.isArray(first.next))throw validationError('Sample verification could not inspect pagination');

  const sample=canonicalUrl(source.config.sampleArticleUrl??first.articles[0].url);
  if(sample.origin!==new URL(source.url).origin||!new RegExp(source.config.articlePattern).test(sample.pathname)){
    throw validationError('Sample article does not match the source configuration');
  }
  const sampleArticleId=await articleId(sample.href),runId=crypto.randomUUID();
  const grant=await issueGrant(env,source,runId,sampleArticleId);
  const bridgeURL=new URL('/internal/bridge',env.BRIDGE_BASE_URL??env.BASE_URL);bridgeURL.searchParams.set('grant',grant.token);
  const title=first.articles.find(row=>row.url===sample.href)?.title;
  const input={
    id:sampleArticleId,url:sample.href,title:title??null,bridgeURL:bridgeURL.href,
    bridgeOrigin:bridgeURL.origin,channel:grant.channel,bundle:singleFileBundle,
    options:{...singleFileOptions,selfExtractingArchive:false,maxResourceSize:3,maxResourceSizeEnabled:true,networkTimeout:8000,insertMetaCSP:false},
  };
  const data=await scrapeDependency(env,sample.href,{
    source,formats:['markdown','rawHtml',{type:'screenshot',fullPage:true}],onlyMainContent:true,
    ...(siteAdmission?{siteAdmission}:{}),
    actions:[{type:'executeJavascript',script:`var __name=value=>value; (${captchaPage.toString()})(${JSON.stringify(input)})`}],
  });
  let report=data.actions?.javascriptReturns?.[0]?.value;
  if(typeof report==='string')report=JSON.parse(report);
  if(!report?.bodyRecognized||!report.page?.url||canonicalUrl(report.page.url).href!==sample.href
    ||!(String(report.bodyText??'').trim()||report.attachmentCandidates?.some(row=>row.role==='body-pdf'))){
    throw validationError('Sample article body was not recognized');
  }
  const snapshot=report.artifacts?.find(item=>item.name==='offline.html');
  if(!snapshot?.base64)throw validationError('Sample original appearance was not captured');
  const fileHashes=[];
  for(const candidate of report.attachmentCandidates??[]){
    const row=report.downloads?.find(row=>row.url===candidate.url);
    if(!row?.originalFile||!row.saved?.name)throw validationError(`Sample attachment was not retrieved: ${cleanError(row?.error??'missing original file')}`);
    if(canonicalUrl(candidate.url).origin!==sample.origin)throw validationError('Sample attachment origin differs');
    const inline=report.artifacts?.find(item=>item.name===row.saved.name);
    let bytes,hash;
    if(inline?.base64)bytes=Buffer.from(inline.base64,'base64');
    else if(row.saved.uploaded){
      if(!/^attachment-[1-8]\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|bin)$/.test(row.saved.name))
        throw validationError('Sample attachment filename is invalid');
      const key=`articles/${sampleArticleId}/${runId}/${row.saved.name}`;
      const manifest=await env.ARCHIVE.get(key+'.upload.json');
      const saved=manifest?await manifest.json():null;
      // The signed upload route verifies the complete stream and writes its digest.
      // Inspect only the signature here, so a 64 MiB original is never buffered
      // again in the validation Worker after the browser has uploaded it.
      const object=await env.ARCHIVE.get(key,{range:{offset:0,length:8}});
      if(!saved||saved.key!==key||saved.name!==row.saved.name||!object
        ||!Number.isSafeInteger(saved.bytes)||saved.bytes<8||saved.bytes>64*1024*1024
        ||object.size!==saved.bytes||!/^[a-f0-9]{64}$/.test(saved.sha256))
        throw validationError('Sample attachment upload could not be verified');
      bytes=new Uint8Array(await object.arrayBuffer());hash=saved.sha256;
    }
    if(!bytes||bytes.byteLength>12*1024*1024||!fileKind(bytes))throw validationError('Sample attachment is not a verified original file');
    fileHashes.push(hash??await sha(bytes));
  }
  if(!fileHashes.length)throw validationError('Choose an article with an attachment for sample verification');
  return {
    listPages:1+paginationUrls.length,
    paginationVerified:true,
    paginationMode:paginationUrls.length?'followed':'absent',
    articleBody:true,attachmentSample:true,snapshotSample:true,
    bodyTextSha256:await sha(report.bodyText??''),fileHashes,
    snapshotSha256:await sha(Buffer.from(snapshot.base64,'base64')),
    verifiedAt:new Date().toISOString(),
  };
}

function today(){return new Date().toISOString().slice(0,10);}
function validationError(message){const error=new Error(message);error.name='ValidationError';return error;}
