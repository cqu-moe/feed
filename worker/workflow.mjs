import {WorkflowEntrypoint} from 'cloudflare:workers';

// Keep the existing platform class while prior instances drain. New/manual work
// enters the task runtime; a replay of this legacy entry cannot bypass admission.
export class FeedIngest extends WorkflowEntrypoint {
  async run(){return {retired:true};}
}
