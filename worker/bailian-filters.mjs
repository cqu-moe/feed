async function memberTag(kind,id){
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(id)));
  return kind+'-'+Array.from(bytes.subarray(0,10),b=>b.toString(16).padStart(2,'0')).join('');
}
const validDay=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&value.slice(0,4)!=='0000'&&
  Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
// Leaves are UTC calendar days from 0001 to 9999. A point has at most 23
// ancestors; every closed interval has at most 44 disjoint tree tags. This
// keeps even open-ended queries inside Bailian's tag-count and length limits.
const firstDay=Date.parse('0001-01-01'), leafBase=2**22;
const leaf=day=>leafBase+(Date.parse(day)-firstDay)/86400000;
const dayTag=node=>'d-'+node.toString(36);

export async function buildSearchTags(memberships,publishedDay){
  const tags=new Set();
  for(const {siteId,sourceId} of memberships){
    if(siteId)tags.add(await memberTag('s',siteId));
    if(sourceId)tags.add(await memberTag('c',sourceId));
  }
  if(publishedDay&&validDay(publishedDay)){
    for(let node=leaf(publishedDay);node;node=Math.floor(node/2))tags.add(dayTag(node));
  }
  return [...tags].sort();
}

function dateTags(from,to){
  let left=leaf(from||'0001-01-01'),right=leaf(to||'9999-12-31');
  const tags=[];
  while(left<=right){
    if(left%2===1)tags.push(dayTag(left++));
    if(right%2===0)tags.push(dayTag(right--));
    left=Math.floor(left/2);
    right=Math.floor(right/2);
  }
  return tags;
}

export async function noticeFilters(params,sources){
  const site=params.get('site')||'',source=params.get('source')||'';
  const from=params.get('from')||'',to=params.get('to')||'';
  if((from&&!validDay(from))||(to&&!validDay(to))||(from&&to&&from>to))return {error:'发布日期范围无效'};
  const selected=source?sources.find(s=>s.id===source):null;
  if(source&&!selected)return {error:'未知来源'};
  if(site&&(!sources.some(s=>s.siteId===site)||(selected&&selected.siteId!==site)))return {error:'部门与栏目不匹配'};
  const sourceIds=source?[source]:site?sources.filter(s=>s.siteId===site).map(s=>s.id):[];
  const tagGroups=[];
  if(site)tagGroups.push([await memberTag('s',site)]);
  if(source)tagGroups.push([await memberTag('c',source)]);
  if(from||to)tagGroups.push(dateTags(from,to));
  return {site,source,from,to,sourceIds,tagGroups};
}

export function noticeWhere(filters,daySql,dynamic){
  const clauses=[],bindings=[];
  if(filters.sourceIds.length){
    const ids='SELECT value FROM json_each(?)';
    const primary='a.source_id IN ('+ids+')';
    clauses.push(dynamic?'('+primary+' OR EXISTS(SELECT 1 FROM article_sources member WHERE member.article_id=a.id AND member.source_id IN ('+ids+')))':primary);
    bindings.push(JSON.stringify(filters.sourceIds));
    if(dynamic)bindings.push(JSON.stringify(filters.sourceIds));
  }
  if(filters.from){clauses.push('substr('+daySql+',1,10)>=?');bindings.push(filters.from);}
  if(filters.to){clauses.push('substr('+daySql+',1,10)<=?');bindings.push(filters.to);}
  return {clauses,bindings};
}
