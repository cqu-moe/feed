const maxTitleLength=240;
const maxSummaryLength=500;
export const maxFeedItems=200;

export function privacyHeaders(){
  return {
    'Cache-Control':'private, no-store',
    'X-Content-Type-Options':'nosniff',
  };
}

export function rssFailure(message,status,extraHeaders=[]){
  const headers=new Headers(privacyHeaders());
  for(const header of extraHeaders)headers.set(...header);
  return Response.json({error:message},{status,headers});
}

export function canonicalBase(env){
  let url;
  try{url=new URL(env.BASE_URL);}
  catch{throw new Error('RSS base URL is invalid');}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('RSS base URL is not canonical');
  return url;
}

export function renderRss({title,description,link,lastModified,items}){
  const entries=items.map(item=>`    <item>
      <title>${xmlText(item.title,maxTitleLength)}</title>
      <description>${xmlText(item.summary,maxSummaryLength)}</description>
      <link>${xmlAttribute(item.link)}</link>
      <guid isPermaLink="false">urn:cqu-feed:event:${xmlText(item.id,80)}</guid>
      <pubDate>${rfc1123(item.readyAt)}</pubDate>
      <category>${item.kind==='update'?'更新':'新通知'}</category>
    </item>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${xmlText(title,maxTitleLength)}</title>
    <description>${xmlText(description,maxSummaryLength)}</description>
    <link>${xmlAttribute(link)}</link>
    <lastBuildDate>${rfc1123(lastModified)}</lastBuildDate>
    <generator>cqu-feed</generator>
${entries.join('\n')}
  </channel>
</rss>
`;
}

function xmlText(value,maxLength){
  const bounded=limit(value,maxLength);
  return bounded
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

function xmlAttribute(value){
  return xmlText(value,2000);
}

function limit(value,maxLength){
  const text=String(value??'');
  const characters=[...text];
  return characters.length<=maxLength?text:characters.slice(0,maxLength-1).join('')+'…';
}

function rfc1123(value){
  const timestamp=Number(value);
  if(!Number.isSafeInteger(timestamp)||timestamp<0)throw new Error('RSS event timestamp is invalid');
  return new Date(timestamp).toUTCString();
}
