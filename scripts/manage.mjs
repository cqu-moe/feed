import {readFile} from 'node:fs/promises';
const command=process.argv[2]||'status';
if(!['status','run','auth-check'].includes(command))throw new Error('Usage: node scripts/manage.mjs status|run|auth-check');
const secrets=process.env.FEED_ADMIN_TOKEN?{ADMIN_TOKEN:process.env.FEED_ADMIN_TOKEN}:JSON.parse(await readFile('.private/production-secrets.json','utf8'));
const base=process.env.FEED_URL||'https://cqu-feed.user-unauthorized.workers.dev';
const response=await fetch(new URL(`/internal/${command}`,base),{method:command==='run'?'POST':'GET',headers:{Authorization:`Bearer ${secrets.ADMIN_TOKEN}`},signal:AbortSignal.timeout(30000)});
if(!response.ok)throw new Error(`Admin request HTTP ${response.status}`);
console.log(JSON.stringify(await response.json(),null,2));
