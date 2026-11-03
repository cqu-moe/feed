// Youth's public-notice links also have an official VSB content endpoint.
// Keep article identity at the published URL; resolve only browser navigation.
export function articleNavigationUrl(value){
  const url=new URL(value);
  const article=/^\/info\/1009\/(\d+)\.htm$/.exec(url.pathname);
  if(url.origin==='https://youth.cqu.edu.cn'&&article&&!url.search){
    url.pathname='/content.jsp';
    url.search=new URLSearchParams({urltype:'news.NewsContentUrl',wbtreeid:'1009',wbnewsid:article[1]}).toString();
    url.hash='';
  }
  return url.href;
}
