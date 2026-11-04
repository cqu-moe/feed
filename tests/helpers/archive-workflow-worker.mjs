import {ArchiveOcrWorkflow} from '../../worker/archive-ocr.mjs';
import {CaptureWorkflow} from '../../worker/capture-workflow.mjs';
import {DiscoveryWorkflow} from '../../worker/discovery-workflow.mjs';
import {createTaskRuntime,handleFeedJobs} from '../../worker/task-runtime.mjs';
import {createSources} from '../../worker/sources.mjs';
import {createArchiveRecheck} from '../../worker/archive-recheck.mjs';
import {listRevisions,readRevision} from '../../worker/archive-versions.mjs';

function environment(raw,taskId){
  const env={...raw,BROWSER:{getByName:()=>raw.TEST_BROWSER},
    FEED_JOBS:{send:async()=>{}},FEED_EVENTS:{send:async()=>{}}};
  if(taskId){
    const journalKey=`captures/${taskId}/result.json`;
    const fail=async stage=>{
      const response=await raw.TEST_FAULT.fetch('https://fixture.test/fault',{method:'POST',body:JSON.stringify({stage,taskId})});
      if((await response.json()).fail)throw new Error('Injected archive storage interruption');
    };
    env.ARCHIVE={
      get(...args){return raw.ARCHIVE.get(...args);},
      head(...args){return raw.ARCHIVE.head(...args);},
      async put(...args){
        const result=await raw.ARCHIVE.put(...args);
        if(args[0]===journalKey)await fail('journal-write');
        return result;
      },
    };
    env.DB={prepare(...args){return raw.DB.prepare(...args);},async batch(statements){
      const saved=await raw.ARCHIVE.head(journalKey);
      if(saved)await fail('before-commit');
      const result=await raw.DB.batch(statements);
      if(saved)await fail('after-commit');
      return result;
    }};
  }
  return env;
}

// Keep real workerd step journaling; accelerate only the clock boundary.
function acceleratedStep(step,raw){
  return {
    do(...args){return step.do(...args);},
    async sleep(name,duration){
      await raw.TEST_WAIT.fetch('https://fixture.test/wait',{method:'POST',body:JSON.stringify({name,duration})});
      return step.sleep(name,1);
    },
  };
}
export class TestCaptureWorkflow extends CaptureWorkflow{
  async run(event,step){
    const raw=this.env;
    this.env=environment(raw,event.payload.taskId);
    return super.run(event,acceleratedStep(step,raw));
  }
}
export class TestDiscoveryWorkflow extends DiscoveryWorkflow{
  async run(event,step){
    const raw=this.env;
    this.env=environment(raw);
    return super.run(event,acceleratedStep(step,raw));
  }
}

export class TestArchiveOcrWorkflow extends ArchiveOcrWorkflow{
  async run(event,step){
    const raw=this.env;
    globalThis.fetch=(input,init)=>raw.TEST_OCR.fetch(new Request(input,init));
    this.env=environment(raw);
    return super.run(event,step);
  }
}

export default {async fetch(request,raw){
  const env=environment(raw),url=new URL(request.url);
  const body=request.method==='POST'?await request.json():{};
  const runtime=createTaskRuntime(env);
  if(url.pathname==='/capture')return Response.json(await runtime.submitCapture(body));
  if(url.pathname==='/discover')return Response.json(await createSources(env).scheduleDue());
  if(url.pathname==='/recheck')return Response.json(await createArchiveRecheck(env).scheduleDue());
  if(url.pathname==='/launch'){
    const messages=(await env.DB.prepare("SELECT payload_json FROM outbox WHERE topic='feed-jobs' AND state IN ('queued','sent')").all()).results
      .filter(row=>!body.taskId||JSON.parse(row.payload_json).taskId===body.taskId)
      .map(row=>({body:JSON.parse(row.payload_json),ack(){},retry(){throw new Error('Unexpected Queue retry');}}));
    await handleFeedJobs({messages},env);
    return Response.json({launched:messages.length});
  }
  if(url.pathname==='/events'){
    const messages=(await env.DB.prepare("SELECT payload_json FROM outbox WHERE topic='feed-events' AND json_extract(payload_json,'$.type')='check-ready'").all()).results
      .map(row=>({body:JSON.parse(row.payload_json),ack(){},retry(){throw new Error('Unexpected event retry');}}));
    await handleFeedJobs({messages},env);
    return Response.json({handled:messages.length});
  }
  if(url.pathname==='/status')return Response.json(await runtime.status(url.searchParams.get('id')));
  if(url.pathname==='/revisions')return Response.json(await listRevisions(env,url.searchParams.get('articleId')));
  if(url.pathname==='/read')return Response.json(await readRevision(env,url.searchParams.get('articleId'),url.searchParams.get('revisionId')));
  return new Response('Not found',{status:404});
}};
