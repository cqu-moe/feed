import {scrape} from './browser-scrape.mjs';
import {normalizedDate} from './utils.mjs';
import {canonicalUrl} from './sources.mjs';

function listPage(input) {
  const date=text=>{
    const match=String(text??'').match(/(20\d{2})[年.\/-]\s*(\d{1,2})[月.\/-]\s*(\d{1,2})(?:日)?(?:[T\s]+\d{1,2}:\d{2}(?::\d{2}(?:[.]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/);
    if(!match)return null;
    const clock=match[0].match(/[T\s]+\d{1,2}:\d{2}(?::\d{2}(?:[.]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/);
    return `${match[1]}-${match[2].padStart(2,'0')}-${match[3].padStart(2,'0')}${clock?.[0]??''}`;
  };
  const articleUrl=anchor=>{
    let url;try{url=new URL(anchor.getAttribute('href'),location.href);url.hash='';}catch{return null;}
    if(url.origin!==location.origin)return null;
    if((url.pathname==='/detail.jsp'||url.pathname==='/2022b/wznr.jsp')
      &&url.searchParams.getAll('urltype').length===1
      &&url.searchParams.get('urltype')==='news.NewsContentUrl'){
      const id=name=>{const values=url.searchParams.getAll(name);return values.length===1&&/^\d+$/.test(values[0])?values[0]:null;};
      const tree=id('wbtreeid'),news=id('wbnewsid');
      if(tree&&news){url.pathname=`/info/${tree}/${news}.htm`;url.search='';}
    }
    return url;
  };
  const articles=[],next=[],pattern=new RegExp(input.articlePattern);
  let externalArticleCount=0;
  for(const anchor of document.querySelectorAll('a[href]')){
    if(anchor.closest('nav,.nav,.pup-nav,.subpage-nav,header,footer'))continue;
    const heading=anchor.querySelector('.title,[class*=title],h1,h2,h3,h4,.det .p1');
    const title=(anchor.getAttribute('title')||heading?.innerText||anchor.innerText||'').replace(/^[●•·\s]+/,'').trim();
    const url=articleUrl(anchor);
    if(!url){
      // Youth mixes local articles and dated WeChat cards. Recognize the latter
      // only to distinguish a valid continuation from an empty/error page.
      let external;try{external=new URL(anchor.getAttribute('href'),location.href);}catch{continue;}
      const card=anchor.closest('li');
      if(title&&card&&external.origin==='https://mp.weixin.qq.com'&&/^\/s(?:\/|$)/.test(external.pathname)){
        const copy=card.cloneNode(true);copy.querySelectorAll('a').forEach(link=>link.remove());
        if(date(copy.textContent))externalArticleCount++;
      }
      continue;
    }
    if(pattern.test(url.pathname)){
      let publishedAt=null,fallback=null;
      // Stop at the article boundary so an undated card cannot borrow its neighbour's date.
      for(let card=anchor,depth=0;card&&card!==document.body&&depth<6;card=card.parentElement,depth++){
        const otherArticle=[...card.querySelectorAll('a[href]')].some(link=>{
          const candidate=articleUrl(link);
          return candidate&&pattern.test(candidate.pathname)&&candidate.href!==url.href;
        });
        if(otherArticle)break;
        const parts=[...card.querySelectorAll('time[datetime],[date],.time,.sspan,[class*=timestyle],[class*=time-line]')];
        for(const part of parts){
          if(part.contains(anchor))continue;
          // SEE places MM/DD above the year; CS splits YYYY/MM/ and DD.
          const year=part.querySelector('p')?.innerText.trim();
          const monthDay=part.querySelector('h4')?.innerText.trim();
          publishedAt=/^20\d{2}$/.test(year??'')&&/^\d{1,2}\/\d{1,2}$/.test(monthDay??'')
            ?date(`${year}/${monthDay}`)
            :date(part.getAttribute('datetime')||part.getAttribute('date')||part.innerText);
          if(publishedAt)break;
        }
        if(publishedAt)break;
        if(!fallback&&card!==anchor){
          const copy=card.cloneNode(true);copy.querySelectorAll('a').forEach(link=>link.remove());
          fallback=date(copy.textContent);
        }
      }
      publishedAt??=fallback;
      if(title&&!articles.some(row=>row.url===url.href))articles.push({url:url.href,title,publishedAt});
    }else if(/^(下[一]?页|next|下一頁|›|>)$/i.test(title.replace(/\s+/g,''))){
      next.push(url.href);
    }
  }
  return {articles,next:[...new Set(next)],title:document.title,externalArticleCount};
}

export async function discoverList(env,source,url,{scrape:scrapeDependency=scrape,baselineCutoffAt,allowExternalOnly=false,now=()=>Date.now(),siteAdmission,executionHandoff}={}){
  const target=canonicalUrl(url),origin=new URL(source.url).origin;
  if(target.origin!==origin)throw new Error('Unexpected list origin');
  const pattern=source.config?.articlePattern??source.articlePattern;
  const actionSource={articlePattern:pattern};
  const data=await scrapeDependency(env,target.href,{
    source,formats:['links'],readiness:{articlePattern:pattern,allowExternalOnly},
    ...(siteAdmission?{siteAdmission}:{}),...(executionHandoff===false?{executionHandoff:false}:{}),
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
  if(!articles.length&&!(allowExternalOnly&&page.externalArticleCount>0))throw new Error('No article links found in list');
  return {
    articles,added:articles.length,dated:articles.filter(row=>row.precision!=='unknown').length,
    undated:articles.length-articles.filter(row=>row.precision!=='unknown').length,
    next:[...new Set((page.next??[]).map(value=>{
      const nextUrl=canonicalUrl(value);return nextUrl.origin===origin?nextUrl.href:null;
    }).filter(Boolean))],
    baselineCutoff:baselineCutoffAt,observedAt:Number(now()),rawPage:page,providerMetadata:data.metadata??{},
  };
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
