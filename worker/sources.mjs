import sources from './sources.json';
import {cutoffDate} from './utils.mjs';

export function createSources(env,{now=()=>new Date(),createWorkflow}={}){
  const startWorkflow=createWorkflow??((id,params)=>env.INGEST.create({id,params}));
  return {
    all(){
      return sources;
    },
    find(sourceId){
      return sources.find(source=>source.id===sourceId);
    },
    async scheduleDaily(nonce='daily'){
      if(env.CRAWL_ENABLED!=='true')return [];
      const timestamp=now(),day=timestamp.toISOString().slice(0,10),ids=[];
      for(const source of sources){
        const id=`${day}-${source.id}-${nonce}`;
        try{
          await startWorkflow(id,{sourceId:source.id,cutoff:cutoffDate(timestamp.getTime())});
          ids.push(id);
        }catch(error){
          if(!/already exists/i.test(String(error)))throw error;
          ids.push(id);
        }
      }
      return ids;
    },
  };
}
