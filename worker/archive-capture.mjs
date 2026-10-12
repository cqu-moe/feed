import {adoptObject,storeTextObject,verifyObject} from './archive-objects.mjs';
import {sha} from './utils.mjs';
import {readingText} from './reading.mjs';
import {commitCaptureRevision} from './archive-versions.mjs';

const journalKey=taskId=>`captures/${taskId}/result.json`;
const semanticText=value=>String(value).normalize('NFKC').replace(/\s+/g,' ').trim();

export async function resumeSavedCapture(env,source,article,context){
  const object=await env.ARCHIVE.get(journalKey(context.taskId));
  if(!object)return null;
  const capture=await object.json();
  if(capture.v!==1||capture.taskId!==context.taskId||capture.articleId!==article.id
    ||capture.sourceId!==source.id||capture.url!==article.url||!Number.isSafeInteger(capture.revisionNo)
    ||!Number.isSafeInteger(capture.observedAt))throw new Error('Saved capture identity does not match its task');
  for(const object of capture.objects)await verifyObject(env,object);
  return commitCaptureRevision(env,capture,context);
}

export async function saveCaptureRevision(env,source,article,context,{report,stored,candidates,downloaded,body,rawBody,sourceMarkup,nativePdfs,sourceTitle}){
  const prefix=`articles/${article.id}/${report.runId}`,objects=new Map(),byName=new Map();
  for(const saved of report.artifacts){
    const object=await adoptObject(env,saved,prefix);
    objects.set(object.sha256,object);byName.set(saved.name,object);
  }
  const observedAt=Date.parse(report.capturedAt),requirements=[];
  const knownTime=value=>Number.isFinite(Date.parse(value))?Date.parse(value):null;
  const add=(slotKey,kind,object,{required=true,...metadata}={})=>requirements.push({slotKey,kind,required,
    state:object?'fulfilled':'failed',objectHash:object?.sha256??null,inputHash:null,derivedOutputId:null,
    fetchedAt:object?observedAt:null,errorCode:object?null:'artifact_missing',...metadata});
  add('body','body',byName.get('body.txt'),{name:'正文',fetchedAt:knownTime(report.bodyCapturedAt)});
  add('snapshot','snapshot',byName.get('offline.html'),{name:'原貌存档'});
  const screenshot=byName.get('original.png');
  if(screenshot)add('screenshot','screenshot',screenshot,{name:'截图',required:false});
  for(const [index,candidate] of candidates.entries()){
    const downloadedFile=downloaded.get(candidate.url),saved=stored.get(downloadedFile?.saved?.name);
    const file=downloadedFile?.originalFile&&saved?objects.get(saved.sha256):null;
    const bodyPdf=candidate.role==='body-pdf';
    const filename=saved?.name??`attachment-${index+1}.bin`;
    const slotKey=`attachment:${index+1}`;
    add(slotKey,bodyPdf?'body_pdf':'attachment',file,{originalUrl:candidate.url,name:candidate.name,filename,
      fetchedAt:file?knownTime(downloadedFile.fetchedAt):null,
      errorCode:file?null:downloadedFile?.error??'attachment_missing'});
    if(bodyPdf&&file&&!nativePdfs.has(filename))requirements.push({slotKey:`ocr:${index+1}`,kind:'body_ocr',required:true,
      state:'pending',objectHash:null,inputHash:file.sha256,derivedOutputId:null,fetchedAt:null,errorCode:'ocr_pending',name:candidate.name,filename});
  }
  const fileIdentity=requirements.filter(row=>row.kind==='attachment'||row.kind==='body_pdf');
  const title=sourceTitle||article.title;
  const rawBodyObject=await storeTextObject(env,rawBody);objects.set(rawBodyObject.sha256,rawBodyObject);
  const markupObject=sourceMarkup===null?null:await storeTextObject(env,sourceMarkup,'text/html; charset=utf-8');
  if(markupObject)objects.set(markupObject.sha256,markupObject);
  const rawFingerprint=await sha(JSON.stringify({v:1,title,body:rawBodyObject.sha256,markup:markupObject?.sha256??null,files:fileIdentity.map(row=>[row.originalUrl,row.name,row.kind,row.objectHash])}));
  const semanticFingerprint=await sha(JSON.stringify({v:1,title:semanticText(title),body:semanticText(readingText(rawBody)),files:fileIdentity.map(row=>[semanticText(row.name),row.kind,row.objectHash])}));
  const capture={v:1,taskId:context.taskId,articleId:article.id,sourceId:source.id,url:article.url,
    revisionNo:context.observationNo,observedAt,title,publishedAt:article.published_at??null,body,
    sourceMetadata:{sourceId:source.id,sourceUrl:source.url,configVersion:source.configVersion??1},
    rawFingerprint,semanticFingerprint,sourceBodyHash:rawBodyObject.sha256,sourceMarkupHash:markupObject?.sha256??null,requirements,diagnostics:report.errors,objects:[...objects.values()],
    creditsUsed:report.provider.creditsUsed??null};
  const manifest=await storeTextObject(env,JSON.stringify(capture),'application/json');
  capture.manifestHash=manifest.sha256;capture.objects.push(manifest);
  // A capture intent owns one saved result. A retry never replaces its evidence.
  const saved=await env.ARCHIVE.put(journalKey(context.taskId),JSON.stringify(capture),{
    onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'},
  });
  if(!saved)return resumeSavedCapture(env,source,article,context);
  return commitCaptureRevision(env,capture,context);
}
