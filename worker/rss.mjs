import {createSubscriptions} from './subscriptions.mjs';
import {rssFailure} from './rss-output.mjs';

export async function rssRoute(request,env){
  const url=new URL(request.url);
  if(url.pathname!=='/rss')return null;
  if(request.method!=='GET'&&request.method!=='HEAD')return rssFailure('Method not allowed',405);
  const tokens=url.searchParams.getAll('token');
  if(tokens.length!==1||!/^[A-Za-z0-9_-]{43}$/.test(tokens[0]))return rssFailure('RSS 链接无效',404);
  return await createSubscriptions(env).readRss(tokens[0],{
    ifNoneMatch:request.headers.get('If-None-Match'),
    head:request.method==='HEAD',
  });
}
