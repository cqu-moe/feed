import {WorkflowEntrypoint} from 'cloudflare:workers';
import {createSources} from './sources.mjs';
import {createTaskRuntime,failDiscoveryTask,finishDiscoveryTask} from './task-runtime.mjs';

export class DiscoveryWorkflow extends WorkflowEntrypoint{
  async run(event,step){
    const taskId=event.payload?.taskId,attempt=event.payload?.attempt;
    if(!/^[a-f0-9]{24}$/.test(taskId??'')||!Number.isSafeInteger(attempt)||attempt<1
      ||event.instanceId!==`task-${taskId}-a${attempt}`)throw new Error('Invalid discovery task identity');
    try{
      const claimed=await step.do('mark-running',async()=>{
        const result=await this.env.DB.batch([
          this.env.DB.prepare(`UPDATE tasks SET state='running',updated_at=?
            WHERE id=? AND attempt_no=? AND state IN ('starting','running')
            AND EXISTS(SELECT 1 FROM task_attempts WHERE task_id=? AND attempt_no=? AND workflow_instance_id=?) RETURNING id`)
            .bind(Date.now(),taskId,attempt,taskId,attempt,event.instanceId),
          this.env.DB.prepare(`UPDATE task_attempts SET state='running' WHERE task_id=? AND attempt_no=?
            AND workflow_instance_id=? AND EXISTS(SELECT 1 FROM tasks WHERE id=? AND attempt_no=? AND state='running')`)
            .bind(taskId,attempt,event.instanceId,taskId,attempt),
        ]);
        return result[0].results.length>0;
      });
      if(!claimed)return {superseded:true};
      const result=await step.do('discover-page',{retries:{limit:0},timeout:'5 minutes'},
        ()=>createSources(this.env).discover(taskId,attempt));
      await step.do('finish',()=>finishDiscoveryTask(this.env,taskId,attempt,result));
      await step.do('dispatch-followups',()=>createTaskRuntime(this.env).dispatchDueOutbox());
      return result;
    }catch(error){
      await failDiscoveryTask(this.env,taskId,attempt,error);
      throw error;
    }
  }
}
