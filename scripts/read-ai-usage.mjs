// Read-only account-level billing metrics; never submits an inference request.
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';

const config=JSON.parse(await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
let token=process.env.CLOUDFLARE_API_TOKEN;
if(!token){
  const result=spawnSync('pnpm',['--config.verify-deps-before-run=false','exec','wrangler','auth','token','--json'],
    {encoding:'utf8',env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
  if(result.status!==0)throw new Error('Cloudflare authentication unavailable');
  token=JSON.parse(result.stdout).token;
}
if(!token)throw new Error('Cloudflare authentication unavailable');
const now=new Date(),start=new Date(now);
start.setUTCHours(0,0,0,0);
start.setUTCDate(start.getUTCDate()-1);
// Yesterday is included so an 08:10 Beijing check sees the day before the UTC reset.
const query=`query Usage($account: string, $start: Time, $end: Time){viewer{accounts(filter:{accountTag:$account}){
  aiInferenceAdaptiveGroups(limit:3,filter:{datetime_geq:$start,datetime_leq:$end}){
    count dimensions{date}sum{totalNeurons totalInputTokens totalOutputTokens}
  }
}}}`;
const response=await fetch('https://api.cloudflare.com/client/v4/graphql',{
  method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),
  headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
  body:JSON.stringify({query,variables:{account:config.account_id,start:start.toISOString(),end:now.toISOString()}}),
});
if(!response.ok)throw new Error(`Cloudflare analytics HTTP ${response.status}`);
const body=await response.json();
const rows=body.data?.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups;
if(body.errors?.length||!Array.isArray(rows))throw new Error('Cloudflare AI usage unavailable; usage is unknown');
console.log(JSON.stringify({at:now.toISOString(),scope:'cloudflare-account',from:start.toISOString(),
  freeNeuronsPerUtcDay:10000,usdPerThousandExcessNeurons:0.011,
  // An empty result is retained rather than invented as a zero bill.
  days:rows.map(row=>{
    const n=row.sum?.totalNeurons;
    const neurons=typeof n==='number'&&Number.isFinite(n)&&n>=0?n:null;
    return {day:row.dimensions?.date,requests:row.count,neurons,
      inputTokens:row.sum?.totalInputTokens??null,outputTokens:row.sum?.totalOutputTokens??null,
      aboveDailyFree:neurons===null?null:neurons>10000,
      estimatedExcessUsd:neurons===null?null:Math.max(0,neurons-10000)/1000*0.011};
  }),note:'Account-wide analytics can lag; estimated excess is not a Feed-attributed invoice.'},null,2));
