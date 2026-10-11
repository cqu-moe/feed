import {scrape} from './firecrawl.mjs';
import {articleId,normalizedDate} from './utils.mjs';

function listPage(input) {
  const date = text => {
    const m=text.match(/(20\d{2})[年.\/-](\d{1,2})[月.\/-](\d{1,2})/);
    return m?`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`:null;
  };
  const articles=[],next=[],pattern=new RegExp(input.articlePattern);
  for(const a of document.querySelectorAll('a[href]')){
    let url;try{url=new URL(a.getAttribute('href'),location.href);url.hash='';}catch{continue;}
    if(url.origin!==location.origin)continue;
    const title=(a.getAttribute('title')||a.innerText||'').replace(/^[●•·\s]+/,'').trim();
    if(pattern.test(url.pathname)){
      let node=a,publishedAt;
      for(let depth=0;node&&depth<5;depth++,node=node.parentElement){
        // Do not accidentally assign an entire list's first date to each child.
        if(node.querySelectorAll('a[href]').length>5)break;
        publishedAt=date(node.querySelector('[date]')?.getAttribute('date')||node.querySelector('time')?.getAttribute('datetime')||node.innerText);if(publishedAt)break;
      }
      if(title&&!articles.some(x=>x.url===url.href))articles.push({url:url.href,title,publishedAt});
    }else if(/^(下[一]?页|next|下一頁|›|>)$/i.test(title.replace(/\s+/g,'')))next.push(url.href);
  }
  return {articles,next:[...new Set(next)],title:document.title};
}
export async function discoverPage(env,source,url,cutoff){
  if(new URL(url).origin!==new URL(source.url).origin)throw new Error('Unexpected list origin');
  const data=await scrape(env,url,{formats:['links'],actions:[{type:'executeJavascript',script:`var __name=value=>value; (${listPage.toString()})(${JSON.stringify(source)})`}]});
  let page=data.actions?.javascriptReturns?.[0]?.value;if(typeof page==='string')page=JSON.parse(page);
  if(!page||!Array.isArray(page.articles)||page.articles.length===0)throw new Error('No article links found in list');
  let added=0,recent=0,dated=0;
  for(const row of page.articles){
    const publishedAt=normalizedDate(row.publishedAt);if(!publishedAt)continue;dated++;
    if(publishedAt<cutoff||publishedAt>new Date(Date.now()+86400000).toISOString().slice(0,10))continue;
    recent++;
    if(new URL(row.url).origin!==new URL(source.url).origin||!new RegExp(source.articlePattern).test(new URL(row.url).pathname))continue;
    const result=await env.DB.prepare('INSERT OR IGNORE INTO articles(id,source_id,url,title,published_at,discovered_at) VALUES (?,?,?,?,?,?) RETURNING id')
      .bind(await articleId(row.url),source.id,row.url,row.title,publishedAt,new Date().toISOString()).first();
    if(result)added++;
  }
  if(!dated)throw new Error('List dates missing; refusing to guess the 30-day window');
  return {added,recent,dated,undated:page.articles.length-dated,next:recent?page.next.filter(x=>new URL(x).origin===new URL(source.url).origin):[]};
}
