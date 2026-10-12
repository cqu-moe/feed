// Preserve the platform's required retry-delay contract even when retries are
// disabled. Cloudflare WorkflowStepConfig requires delay alongside limit.
export const workflowStep={
  async do(_name,config,callback){
    if(typeof config==='function')return config();
    if(config?.retries&&!['string','number','function'].includes(typeof config.retries.delay)){
      throw new TypeError('Workflow retry configuration requires delay');
    }
    return callback();
  },
  async sleep(){},
};
