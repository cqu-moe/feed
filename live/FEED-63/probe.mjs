import {WorkflowEntrypoint} from 'cloudflare:workers';
import {createSources} from '../../worker/sources.mjs';
import {createTaskRuntime,handleFeedJobs} from '../../worker/task-runtime.mjs';
import {launchOutboxId,launchOutboxStatement} from '../../worker/task-statements.mjs';
import {sha} from '../../worker/utils.mjs';
export {DiscoveryWorkflow} from '../../worker/discovery-workflow.mjs';
export {FeedBrowser} from '../../crawler/worker.mjs';
export default {
  async queue(batch,env,ctx){
    for(const msg of batch.messages){
      await env.DB.prepare('INSERT INTO probe_deliveries(task_id,arrived) VALUES (?,?)').bind(msg.body.taskId,Date.now()).run();
    }
    await handleFeedJobs(batch,env,{lifecycle:ctx});
  }
};
// Triggered via authenticated Wrangler; the temporary Worker has no fetch route.
export class Probe extends WorkflowEntrypoint{
  async run(event,step){
    return step.do('command',{retries:{limit:0,delay:'1 second'},timeout:'2 minutes'},async()=>{
      const env=this.env,db=env.DB,at=Date.now(),cmd=event.payload.cmd;
      if(cmd==='journal'){
        const rows=(await db.prepare("SELECT id,source_id FROM tasks WHERE business_key LIKE 'probe:%' AND state='succeeded'").all()).results;
        const out=[];
        for(const row of rows){
          const blob=await env.ARCHIVE.get('discovery/'+row.id+'/list.json');
          if(blob){const journal=await blob.json();out.push({id:row.id,source:row.source_id,title:journal.result.rawPage.title,etag:blob.etag});}
        }
        return out;
      }
      if(cmd==='dispatch')return createTaskRuntime(env).dispatchDueOutbox();
      if(!['old','backlog','delay'].includes(cmd))throw new Error('Unknown probe command');
      const paths=cmd==='old'?[['a','old']]:cmd==='delay'?[['b','delay']]:[['a','one'],['b','one'],['c','one'],['a','two'],['c','delay']];
      const tasks=[];
      for(const [site,path] of paths){
        const origin='https://'+site+'.feed63.cqu.edu.cn',siteId='probe-'+site,sourceId=siteId+'-'+path,url=origin+'/'+path;
        await db.prepare('INSERT OR IGNORE INTO sites(id,name,origin,created_at,updated_at) VALUES (?,?,?,?,?)')
          .bind(siteId,siteId,origin,at,at).run();
        await db.prepare("INSERT OR IGNORE INTO sources(id,name,url,site_id,list_url,next_discovery_at) VALUES (?,?,?,?,?,?)")
          .bind(sourceId,sourceId,url,siteId,url,at+86400000).run();
        const source=await createSources(env).find(sourceId),key='probe:'+sourceId,id=(await sha(key)).slice(0,24);
        const payload={source,page:1,scheduledSlot:at,checkpoint:{nextUrls:[url],visited:[]}};
        await db.batch([
          db.prepare("INSERT OR IGNORE INTO tasks(id,kind,business_key,source_id,payload_json,state,due_at,created_at,updated_at) VALUES (?,'discover',?,?,?,'queued',?,?,?)")
            .bind(id,key,sourceId,JSON.stringify(payload),path==='delay'?at+120000:at,at,at),
          launchOutboxStatement(env,{id:await launchOutboxId(id,1),taskId:id,attempt:1,timestamp:at}),
        ]);
        tasks.push(id);
      }
      // Keep normal backlog in D1 until the switch; send only via the business dispatcher.
      if(cmd!=='backlog')await createTaskRuntime(env).dispatchDueOutbox();
      return tasks;
    });
  }
}
