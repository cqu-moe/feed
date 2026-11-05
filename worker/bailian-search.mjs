import {createBailianClient} from './bailian-client.mjs';
import {lookupSearchDocuments} from './bailian-sync.mjs';
import {relatedArticleCards} from './archive-api.mjs';
import {json} from './utils.mjs';

const clean=text=>text.replace(/^#{1,6}\s+.*$/gm,'').replace(/\s+/gu,' ').trim();
const normalized=text=>text.normalize('NFKC').replace(/\s+/gu,'').toLowerCase();

async function sourceLink(env,doc,content,quote){
  if(!/^attachment-\d+\.pdf$/.test(doc.filename??''))return {label:doc.label,href:null};
  const revision=doc.revisionId?'revisions/'+encodeURIComponent(doc.revisionId)+'/':'';
  const href='/reader/'+encodeURIComponent(doc.articleId)+'/'+revision+doc.filename;
  if(doc.evidenceKey){
    // A Markdown section/page number from the provider is not an original PDF page.
    const needle=normalized(content);
    if(needle.length>=2){
      const object=await env.ARCHIVE.get(doc.evidenceKey).catch(()=>null);
      if(object){
        const pages=await object.json().catch(()=>[]);
        if(Array.isArray(pages)){
          const candidates=pages.filter(p=>Number.isSafeInteger(p?.number)&&p.number>0&&typeof p.text==='string')
            .map(p=>({number:p.number,text:normalized(p.text)}));
          // A chunk can cross a page boundary while its displayed excerpt is wholly on one page.
          for(const exact of new Set([needle,normalized(quote)])){
            if(exact.length<2)continue;
            const matches=candidates.filter(p=>p.text.includes(exact));
            if(matches.length===1)return {label:doc.label+' · 第 '+matches[0].number+' 页',href:href+'?page='+matches[0].number};
          }
        }
      }
    }
  }
  return {label:doc.label,href};
}

function excerpt(content,query){
  const at=content.toLowerCase().indexOf(query.toLowerCase());
  const start=Math.max(0,at-64),end=start+220;
  const quote=content.slice(start,end);
  return {quote,display:(start?'…':'')+quote+(end<content.length?'…':'')};
}

let cooldownUntil=0; // Per Worker isolate; distributed quota is enforced by the provider.
export async function bailianSearch(env,query,filters){
  try{
    if(Date.now()<cooldownUntil)throw new Error('Cooling down');
    const hits=(await createBailianClient(env).search({query,tagGroups:filters.tagGroups})).slice(0,100);
    const docs=await lookupSearchDocuments(env,[...new Set(hits.map(h=>h.fileId))]);
    const byFile=new Map(docs.map(d=>[d.fileId,d]));
    const cards=await relatedArticleCards(env,filters,[...new Set(docs.map(d=>d.articleId))]);
    const byArticle=new Map(cards.map(c=>[c.id,c]));
    const articles=[];
    for(const hit of hits){
      const doc=byFile.get(hit.fileId),card=doc&&byArticle.get(doc.articleId);
      const content=clean(hit.content)||hit.content.trim();
      if(!card||!content)continue;
      const {quote,display}=excerpt(content,query);
      const match=await sourceLink(env,doc,content,quote);
      articles.push({...card,excerpt:display,match});
      byArticle.delete(doc.articleId);
      if(articles.length===20)break;
    }
    console.info(JSON.stringify({event:'bailian_search',outcome:'ok',results:articles.length}));
    return json({articles,total:articles.length,page:1,pageSize:20,searchKind:'related'});
  }catch(e){
    if(e?.status===429)cooldownUntil=Date.now()+1_000;
    console.info(JSON.stringify({event:'bailian_search',outcome:e?.status===429?'rate_limited':'unavailable'}));
    // Never log the submitted query, signed URLs or returned document fragments.
    return json({error:'通知搜索暂时不可用，可以按条件浏览或稍后重试'},503);
  }
}
