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
 // Refresh public catalog references; the checked-in snapshot remains an explicit
 // fallback when a site is unavailable or no longer exposes model links.
 const catalogs=[{id:'lmstudio',label:'LM Studio',origin:'https://lmstudio.ai',path:'/models',kind:'curated' as const},{id:'ollama',label:'Ollama',origin:'https://ollama.com',path:'/library',kind:'runtime' as const}];
 await Promise.all(catalogs.map(async catalog=>{
  try {
   const response=await fetcher(catalog.origin+catalog.path,{redirect:'error',signal:AbortSignal.timeout(5000)});if(!response.ok)return;
   const html=await response.text();if(html.length>3*1024**2)return;
   const pattern=catalog.id==='lmstudio'?/href="(\/models\/[a-z0-9.-]+)"/g:/href="(\/library\/[a-z0-9.-]+)"/g;
   const pages=[...new Set([...html.matchAll(pattern)].map(m=>m[1]))].slice(0,64);
   await Promise.all(Array.from({length:4},async()=>{while(pages.length){const page=pages.shift()!;try{
    const detail=await fetcher(catalog.origin+page,{redirect:'error',signal:AbortSignal.timeout(5000)});if(!detail.ok)continue;
    const body=await detail.text();if(body.length>3*1024**2)continue;
    for(const match of body.matchAll(/https:\/\/huggingface\.co\/([\w.-]+\/[\w.-]+)/g)){
     const id=match[1];if(/^(datasets|spaces|collections)\//.test(id))continue;
     const list=(sources.get(id)??[]).filter(s=>s.id!==catalog.id);
     list.push({id:catalog.id,label:catalog.label,url:catalog.origin+page,kind:catalog.kind,checkedAt:new Date(now()).toISOString()});sources.set(id,list);
    }
   }catch{/* Per-page failures preserve the dated snapshot. */}}}));
  }catch{/* A missing catalog cannot block other sources. */}
 }));
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
