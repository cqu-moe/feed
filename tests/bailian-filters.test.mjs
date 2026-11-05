import assert from 'node:assert/strict';
import test from 'node:test';
import {noticeFilters,buildSearchTags} from '../worker/bailian-filters.mjs';

test('range pushdown admits exactly the same sample days as the reader’s inclusive filter',async()=>{
  const days=['0001-01-01','1999-12-31','2000-01-01','2024-02-28','2024-02-29','2024-03-01','2025-01-01','9999-12-31',null];
  const indexed=await Promise.all(days.map(d=>buildSearchTags([],d)));
  for(const from of days)for(const to of days){
    if((!from&&!to)||(from&&to&&from>to))continue;
    const p=new URLSearchParams();if(from)p.set('from',from);if(to)p.set('to',to);
    const {tagGroups:[tags]}=await noticeFilters(p,[]);
    assert.ok(tags.length<=100&&tags.join('').length<=700);
    days.forEach((d,i)=>assert.equal(tags.some(t=>indexed[i].includes(t)),!!(d&&(!from||d>=from)&&(!to||d<=to)),JSON.stringify({d,from,to})));
  }
});

test('all actual memberships are searchable and an incompatible filter is rejected',async()=>{
  const sources=[{siteId:'dept1',id:'a'},{siteId:'dept2',id:'b'}];
  const tags=await buildSearchTags(sources.map(s=>({siteId:s.siteId,sourceId:s.id})),'2026-11-05');
  for(const tag of tags)assert.match(tag,/^[a-z0-9_-]{1,32}$/,'must pass the provider’s registration character rules');
  const filters=await noticeFilters(new URLSearchParams({site:'dept2',source:'b'}),sources);
  assert.ok(filters.tagGroups.every(g=>g.some(t=>tags.includes(t))));
  assert.ok((await noticeFilters(new URLSearchParams({site:'dept1',source:'b'}),sources)).error);
  assert.ok((await noticeFilters(new URLSearchParams({from:'2025-02-29'}),sources)).error);
});
