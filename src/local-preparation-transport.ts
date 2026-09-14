/** Private Host control contract. Never accept these fields from browser input. */
export type HostPreparationOperation = {
  operation: 'install'|'start'|'download'|'import';
  policy_revision:number;
  artifact:{model_id:string;revision:string;filename:string;sha256:string;bytes:number};
  context_tokens:number;
};
const errors = new Set(['cancelled','preparation_timeout','host_permission_required','new_preflight_required','storage_unavailable','insufficient_disk','download_budget_exceeded','artifact_verification_failed','local_preparation_failed']);

/** Incremental, bounded NDJSON; EOF alone never means operation success. */
export async function readHostPreparationOperation(response:Response,input:HostPreparationOperation,signal:AbortSignal,progress:(completed:number,total:number)=>Promise<void>):Promise<{runtimeModel?:string}> {
  if(response.status!==200||response.headers.get('content-type')?.split(';')[0]!== 'application/x-ndjson'||!response.body) throw Error('local_preparation_failed');
  const reader=response.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true});
  let buffer='';let previous=0;let done=false;let result:{runtimeModel?:string}={};
  const line=async(raw:string)=>{
    signal.throwIfAborted();
    if(done||!raw||raw.length>4096)throw Error('invalid_preparation_stream');
    const event=JSON.parse(raw);
    if(!event||typeof event!=='object'||Array.isArray(event))throw Error('invalid_preparation_stream');
    if(event.type==='progress'){
      const completed=event.completed_bytes??0,total=event.total_bytes;
      if(input.operation!=='download'||!Number.isSafeInteger(completed)||!Number.isSafeInteger(total)||total!==input.artifact.bytes||completed<previous||completed>total)throw Error('invalid_preparation_progress');
      previous=completed;await progress(completed,total);
    } else if(event.type==='error'){
      throw Error(errors.has(event.error)?event.error:'local_preparation_failed');
    } else if(event.type==='complete'){
      if(input.operation==='import'){
        if(typeof event.runtime_model!=='string'||!/^multivibe-local-[a-f0-9]{32}:latest$/.test(event.runtime_model))throw Error('invalid_preparation_result');
        result={runtimeModel:event.runtime_model};
      }else if(event.runtime_model)throw Error('invalid_preparation_result');
      if(input.operation==='download'&&previous!==input.artifact.bytes)throw Error('incomplete_preparation_download');
      done=true;
    }else throw Error('invalid_preparation_stream');
  };
  try{
    while(true){
      signal.throwIfAborted();const chunk=await reader.read();
      if(chunk.done){buffer+=decoder.decode();break;}
      buffer+=decoder.decode(chunk.value,{stream:true});
      let index;
      while((index=buffer.indexOf('\n'))!==-1){const raw=buffer.slice(0,index);buffer=buffer.slice(index+1);await line(raw);}
      if(buffer.length>4096)throw Error('invalid_preparation_stream');
    }
    if(buffer)await line(buffer);
    signal.throwIfAborted();if(!done)throw Error('incomplete_preparation_stream');return result;
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
