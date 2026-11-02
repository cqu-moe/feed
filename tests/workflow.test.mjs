import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

test('a legacy ingestion invocation retires without reading state or starting source work',async()=>{
  const bundle=await build({entryPoints:['worker/workflow.mjs'],bundle:true,write:false,format:'esm',platform:'node',
    plugins:[{name:'workflow-platform',setup(api){
      api.onResolve({filter:/^cloudflare:workers$/},()=>({path:'platform',namespace:'platform'}));
      api.onLoad({filter:/.*/,namespace:'platform'},()=>({contents:'export class WorkflowEntrypoint {constructor(env){this.env=env}}',loader:'js'}));
    }}]});
  const {FeedIngest}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  const accessed=[];
  const env=new Proxy({}, {get(_target,key){accessed.push(String(key));throw new Error('Retired workflow accessed '+String(key));}});
  const step={do(){throw new Error('Retired workflow started a step');}};
  assert.deepEqual(await new FeedIngest(env).run({instanceId:'prior-run',payload:{sourceId:'jwc'}},step),{retired:true});
  assert.deepEqual(accessed,[]);
});
