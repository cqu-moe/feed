// Recover row and cell boundaries from the same saved revision as the reading
// text. Never render source HTML or guess columns from whitespace in a roster.
import {Parser} from 'htmlparser2';

const ignored=new Set(['script','style','template','noscript','nav','footer']);
const compact=text=>text.replace(/\s+/g,'');
const span=(value,max,min=1)=>/^\d+$/.test(value)?Math.max(min,Math.min(max,Number(value))):1;

export async function readArchivedTables(env,key,body){
  if(!key||!body)return [];
  const object=await env.ARCHIVE.get(key);
  if(!object)return [];
  const stack=[],tables=[];
  let skipped=0,textIndex,cursor=0;
  function match(table){
    if(table.nested||!(table.rows.length>1||table.rows.some(row=>row.length>1)))return;
    const needle=compact(table.rows.flat().map(cell=>cell.text).join(''));
    if(!needle)return;
    // innerText uses different separators for Word paragraphs, tabs and bare
    // cells. Match non-whitespace exactly, retaining offsets in the actual body.
    if(!textIndex){
      const offsets=new Uint32Array(body.length);
      let n=0;
      for(let i=0;i<body.length;i++)if(!/\s/.test(body[i]))offsets[n++]=i;
      textIndex={text:compact(body),offsets};
    }
    let at=textIndex.text.indexOf(needle,cursor);
    while(at>=0){
      const begin=textIndex.offsets[at],end=textIndex.offsets[at+needle.length-1]+1;
      if((begin===0||/\s/.test(body[begin-1]))&&(end===body.length||/\s/.test(body[end])))break;
      at=textIndex.text.indexOf(needle,at+1);
    }
    if(at<0)return;
    cursor=at+needle.length;
    tables.push({start:textIndex.offsets[at],end:textIndex.offsets[cursor-1]+1,rows:table.rows});
  }
  const parser=new Parser({
    onopentag(tag,attrs){
      if(skipped||ignored.has(tag)||attrs.hidden!==undefined||attrs['aria-hidden']==='true'){
        skipped++;return;
      }
      let table=stack.at(-1);
      if(tag==='table'){
        if(table)table.nested=true;
        stack.push({rows:[],row:null,cell:null,nested:false});return;
      }
      if(!table)return;
      if(tag==='thead'){table.inHead=true;}else if(tag==='tr'){
        table.row=[];table.rows.push(table.row);
      }else if(table.row&&(tag==='td'||tag==='th')){
        table.cell={text:'',header:tag==='th'||table.inHead===true,rowSpan:span(attrs.rowspan,65534,0),colSpan:span(attrs.colspan,1000)};
        table.row.push(table.cell);
      }else if(table.cell&&(tag==='br'||tag==='p'||tag==='div')){
        table.cell.text+='\n';
      }
    },
    ontext(text){const cell=stack.at(-1)?.cell;if(!skipped&&cell)cell.text+=text;},
    onclosetag(tag){
      if(skipped){skipped--;return;}
      const table=stack.at(-1);
      if(!table)return;
      if(tag==='table'){stack.pop();match(table);}
      else if(tag==='thead'){table.inHead=false;}
      else if(tag==='td'||tag==='th'){
        if(table.cell)table.cell.text=table.cell.text.trim();
        table.cell=null;
      }else if(tag==='tr'){table.row=null;table.cell=null;}
    },
  });
  const decoder=new TextDecoder();
  for await(const bytes of object.body)parser.write(decoder.decode(bytes,{stream:true}));
  parser.end(decoder.decode());
  return tables;
}
