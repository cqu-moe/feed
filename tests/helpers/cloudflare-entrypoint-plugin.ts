import type { Plugin } from 'esbuild';

// Page-action tests run in Node; native Workflow execution is covered in workerd.
export const cloudflareEntrypointPlugin: Plugin={
  name:'cloudflare-entrypoint',
  setup(api){
    api.onResolve({filter:/^cloudflare:workers$/},()=>({path:'entrypoint',namespace:'cloudflare-entrypoint'}));
    api.onLoad({filter:/.*/,namespace:'cloudflare-entrypoint'},()=>({
      loader:'js',contents:'export class WorkflowEntrypoint { constructor(){throw new Error("Workflow execution requires workerd");} }',
    }));
  },
};
