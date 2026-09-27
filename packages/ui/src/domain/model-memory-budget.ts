import type {MemoryAvailability} from './model-recommendation-evidence.js';
/** A planning budget leaves room for macOS and other applications; not free RAM. */
export function localMemoryBudget(totalBytes:number,requestedMiB?:number):MemoryAvailability {
 const totalHostMiB=totalBytes/1048576;
 return {accelerator:'metal',totalHostMiB,budgetMiB:Math.min(requestedMiB ?? totalHostMiB*.75,totalHostMiB*.9)};
}
export function exceedsWeightBudget(bytes:number|null,memory?:MemoryAvailability) {
 const shared=memory?.accelerator==='metal'||memory?.accelerator==='cpu';
 const limits=[memory?.budgetMiB,shared?memory?.totalHostMiB:undefined,shared?memory?.freeHostMiB:undefined].filter((v):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0);
 return bytes!==null && Number.isFinite(bytes) && bytes>0 && limits.length>0 && bytes/1048576>=Math.min(...limits);
}

export function discoveryMemoryFit(requiredMiB:number,memory?:MemoryAvailability):'compatible'|'insufficient'|'unknown' {
 const shared=memory?.accelerator==='metal'||memory?.accelerator==='cpu';
 const limits=[memory?.budgetMiB,shared?memory?.totalHostMiB:undefined,shared?memory?.freeHostMiB:undefined].filter((v):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0);
 if(!limits.length)return 'unknown';
 if(requiredMiB>=Math.min(...limits))return 'insufficient';
 return shared || !memory?.accelerator ? 'compatible':'unknown';
}
