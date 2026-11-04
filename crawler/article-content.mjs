// These functions also run inside the source page; keep their inputs explicit.
export function fileTarget(element){
  const link=new URL(element.getAttribute('href')||element.getAttribute('src')||element.getAttribute('data'),location.href);
  const file=link.searchParams.get('file');
  const url=file?new URL(file,link):link;
  const typedPdf=element.getAttribute('type')?.split(';')[0].trim().toLowerCase()==='application/pdf';
  const knownViewer=file&&/\/(?:pdfjs\/web\/)?viewer\.html?$/i.test(link.pathname);
  if(url.origin!==location.origin||!(/^https?:$/.test(url.protocol))||
    !(typedPdf||knownViewer||/download\.jsp$|\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z)$/i.test(url.pathname)))return null;
  return url;
}

export function articleContent(title,fileTarget){
  const normalize=value=>String(value??'').normalize('NFKC').replace(/[\s\u200b●•·—–_-]/g,'');
  const expected=normalize(title?.slice(0,18));
  if(!document.body||(expected&&!normalize(document.title).includes(expected)))return null;
  const article=document.querySelector('.v_news_content, #vsb_content, #vsb_content_2, .article-content, .news_content')||document.querySelector('article');
  // A historical sample without a known title needs a recognized article wrapper.
  if(!article&&!expected)return null;
  const content=article||document.querySelector('main')||document.body;
  const ignored='nav,header,footer,aside,h1,h2,h3,h4,h5,h6,script,style,noscript,template,[hidden]';
  const visible=element=>!element.closest(ignored)&&element.checkVisibility({visibilityProperty:true});
  if(content!==document.body&&[...content.querySelectorAll('img[src]')].some(visible))return content;
  for(const embed of content.querySelectorAll('iframe[src],embed[src],object[data]')){
    try{if(!embed.closest(ignored)&&fileTarget(embed))return content;}catch{}
  }
  // Navigation and a heading can arrive before the actual paragraphs.
  const walker=document.createTreeWalker(content,NodeFilter.SHOW_TEXT);
  let length=0;
  while(walker.nextNode()){
    const node=walker.currentNode;
    const text=node.textContent.trim();
    if(!text||!visible(node.parentElement))continue;
    length+=text.length;
    if(length>(content===document.body?100:0))return content;
  }
  return null;
}
