import { curatedSourceSnapshot } from './curated-model-sources.js';
export type ModelRecommendationSource = {id:string;label:string;url:string;kind:'curated'|'runtime'|'publisher'|'quantization';checkedAt:string};
const safeId=/^[\w.-]+\/[\w.-]+$/;
const publishers=['Qwen','meta-llama','google','mistralai'];
const converters=['mlx-community','unsloth','bartowski'];
export function snapshotSources() {
 const sources=new Map<string,ModelRecommendationSource[]>();
 for(const entry of curatedSourceSnapshot.entries){const list=sources.get(entry.modelId)??[];if(!list.some(s=>s.id===entry.source))list.push({id:entry.source,label:entry.label,url:entry.url,kind:entry.kind,checkedAt:curatedSourceSnapshot.checkedAt});sources.set(entry.modelId,list);}
 return sources;
}
export async function collectionSources(fetcher:typeof fetch=fetch,now=Date.now) {
 const sources=snapshotSources();
 await Promise.all([...publishers,...converters].map(async owner=>{
  try {
   const response=await fetcher(`https://huggingface.co/api/collections?owner=${owner}&limit=2`,{redirect:'error',signal:AbortSignal.timeout(5000)});
   if(!response.ok)return;const collections=await response.json();if(!Array.isArray(collections))return;
   for(const collection of collections.slice(0,2)){
    if(collection.owner?.name!==owner || typeof collection.slug!=='string' || !safeId.test(collection.slug) || !collection.slug.startsWith(`${owner}/`))continue;
    for(const item of (Array.isArray(collection.items)?collection.items:[]).filter((i:any)=>i.type==='model').slice(0,8)){
     if(typeof item.id!=='string'||!safeId.test(item.id)||!item.id.startsWith(`${owner}/`))continue;
     const kind=publishers.includes(owner)?'publisher' as const:'quantization' as const;
     const list=sources.get(item.id)??[];
     if(!list.some(s=>s.id===owner))list.push({id:owner,label:owner,url:`https://huggingface.co/collections/${collection.slug}`,kind,checkedAt:new Date(now()).toISOString()});sources.set(item.id,list);
    }
   }
  } catch { /* Independent sources cannot make the main catalog unavailable. */ }
 }));
 return sources;
}
