import {scrape} from './firecrawl.mjs';
import {articleId,normalizedDate} from './utils.mjs';
import {canonicalUrl} from './sources.mjs';

function listPage(input) {
  const date=text=>{
    const match=String(text??'').match(/(20\d{2})[年.\/-](\d{1,2})[月.\/-](\d{1,2})(?:日)?(?:[T\s]+\d{1,2}:\d{2}(?::\d{2}(?:[.]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/);
    return match?.[0]??null;
  };
  const articles=[],next=[],pattern=new RegExp(input.articlePattern);
  for(const anchor of document.querySelectorAll('a[href]')){
    let url;try{url=new URL(anchor.getAttribute('href'),location.href);url.hash='';}catch{continue;}
    if(url.origin!==location.origin)continue;
    const title=(anchor.getAttribute('title')||anchor.innerText||'').replace(/^[●•·\s]+/,'').trim();
    if(pattern.test(url.pathname)){
      let node=anchor,publishedAt;
      for(let depth=0;node&&depth<5;depth++,node=node.parentElement){
        if(node.querySelectorAll('a[href]').length>5)break;
        publishedAt=date(node.querySelector('[date]')?.getAttribute('date')
          ||node.querySelector('time')?.getAttribute('datetime')||node.innerText);
        if(publishedAt)break;
      }
      if(title&&!articles.some(row=>row.url===url.href))articles.push({url:url.href,title,publishedAt});
    }else if(/^(下[一]?页|next|下一頁|›|>)$/i.test(title.replace(/\s+/g,''))){
      next.push(url.href);
    }
  }
  return {articles,next:[...new Set(next)],title:document.title};
}

export async function discoverList(env,source,url,{scrape:scrapeDependency=scrape,baselineCutoffAt}={}){
  const target=canonicalUrl(url),origin=new URL(source.url).origin;
  if(target.origin!==origin)throw new Error('Unexpected list origin');
  const pattern=source.config?.articlePattern??source.articlePattern;
  const actionSource={articlePattern:pattern};
  const data=await scrapeDependency(env,target.href,{
    formats:['links'],
    actions:[{type:'executeJavascript',script:`var __name=value=>value; (${listPage.toString()})(${JSON.stringify(actionSource)})`}],
  });
  let page=data.actions?.javascriptReturns?.[0]?.value;
  if(typeof page==='string')page=JSON.parse(page);
  if(!page||!Array.isArray(page.articles))throw new Error('Invalid discovery list response');
  const articles=[];
  for(const row of page.articles){
    let candidate;try{candidate=canonicalUrl(row.url);}catch{continue;}
    if(candidate.origin!==origin||!new RegExp(pattern).test(candidate.pathname))continue;
    const published=publicationDate(row.publishedAt,source.timezone??'Asia/Shanghai');
    articles.push({
      url:candidate.href,title:String(row.title??'').trim().slice(0,300),
      ...published,
    });
  }
  return {
    articles,added:articles.length,dated:articles.filter(row=>row.precision!=='unknown').length,
    undated:articles.length-articles.filter(row=>row.precision!=='unknown').length,
    next:[...new Set((page.next??[]).map(value=>{
      const nextUrl=canonicalUrl(value);return nextUrl.origin===origin?nextUrl.href:null;
    }).filter(Boolean))],
    baselineCutoff:baselineCutoffAt,
  };
}

export async function discoverPage(env,source,url,cutoff){
  const result=await discoverList(env,source,url,{baselineCutoffAt:cutoff});
  if(result.dated===0&&result.undated===0)throw new Error('No article links found in list');
  if(result.dated===0)throw new Error('List dates missing; refusing to guess the 30-day window');
  let added=0,recent=0;
  for(const row of result.articles){
    if(row.publishedDay<cutoff||row.publishedDay>new Date(Date.now()+86400000).toISOString().slice(0,10))continue;
    recent++;
    const inserted=await env.DB.prepare('INSERT OR IGNORE INTO articles(id,source_id,url,title,published_at,discovered_at) VALUES (?,?,?,?,?,?) RETURNING id')
      .bind(await articleId(row.url),source.id,row.url,row.title,row.publishedDay,new Date().toISOString()).first();
    if(inserted)added++;
  }
  return {added,recent,dated:result.dated,undated:result.undated,next:recent?result.next:[]};
}

// A date without a clock is deliberately not promoted to midnight. Ambiguous
// local times around a DST transition also retain only their known day.
function publicationDate(value,timezone){
  const day=normalizedDate(value);
  if(!day)return {precision:'unknown',publishedDay:null,publishedAt:null};
  const fallback={precision:'day',publishedDay:day,publishedAt:null};
  const clock=String(value).match(/[T\s]+([0-9]{1,2}):([0-9]{2})(?::[0-9]{2}(?:[.][0-9]+)?)?(Z|[+-][0-9]{2}:?[0-9]{2})?/);
  if(!clock||Number(clock[1])>23||Number(clock[2])>59)return fallback;
  const local=`${day}T${clock[1].padStart(2,'0')}:${clock[2]}:00`;
  let instant;
  if(clock[3])instant=Date.parse(local+clock[3]);
  else{
    const wall=Date.parse(local+'Z');
    const format=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
    const asWall=timestamp=>{
      const parts=Object.fromEntries(format.formatToParts(timestamp).map(part=>[part.type,part.value]));
      return Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00Z`);
    };
    const offsets=new Set([-36,0,36].map(hours=>{const at=wall+hours*3600000;return asWall(at)-at;}));
    const matches=[...offsets].map(offset=>wall-offset).filter(at=>asWall(at)===wall);
    if(matches.length!==1)return fallback;
    instant=matches[0];
  }
  if(!Number.isFinite(instant))return fallback;
  return {precision:'minute',publishedDay:new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(instant),publishedAt:new Date(instant).toISOString()};
}
