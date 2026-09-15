import {groupModels,type OpenModel} from './open-model-ranking.js';
import type {MemoryQueue} from './model-memory-queue.js';
/** Only verified members of the requested family can be prioritized. */
export async function modelMemoryRequest(queue:MemoryQueue,catalog:{family:(id:string)=>Promise<OpenModel[]>},model:string,variant:string){
 if(![model,variant].every(id=>/^[\w.-]+\/[\w.-]+$/.test(id)))throw Error('Invalid model');
 const members=await catalog.family(model);
 const family=groupModels(members).find(g=>g.model.id===model&&g.familyStatus!=='unresolved');
 const selected=family?.variants.find(v=>v.id===variant);
 if(!family||!selected)throw Error('Unverified family');
 await queue.enqueue(family.variants.map(v=>({model:v,original:family.model,priority:v.id===variant?100:20})));
 const snapshot=await queue.snapshot([variant]);
 return {model,variant,report:snapshot.reports[variant],pending:snapshot.pending>0,persistenceError:snapshot.persistenceError};
}
