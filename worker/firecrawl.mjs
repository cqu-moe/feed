import {bounded, reserveBudget} from './utils.mjs';
export async function scrape(env, url, options = {}) {
  await reserveBudget(env, 'firecrawl', Number(env.MAX_FIRECRAWL_PER_DAY || 120));
  const response = await fetch('https://api.firecrawl.dev/v2/scrape', {
    method:'POST', headers:{'Content-Type':'application/json',...(env.FIRECRAWL_API_KEY ? {Authorization:`Bearer ${env.FIRECRAWL_API_KEY}`} : {})},
    body:JSON.stringify({url,proxy:'auto',maxAge:0,timeout:210000,waitFor:2000,...options}),
    signal:AbortSignal.timeout(235000),
  });
  const result = JSON.parse(new TextDecoder().decode(await bounded(response, 40*1024*1024)));
  if (!response.ok || !result.success) throw new Error(`Firecrawl HTTP ${response.status}: ${String(result.error??'Unsuccessful').slice(0,160)}`);
  if ((result.data?.metadata?.statusCode??200) >= 400) throw new Error(`Origin HTTP ${result.data.metadata.statusCode}`);
  return result.data;
}
