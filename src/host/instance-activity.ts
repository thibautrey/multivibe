import {redact,type HarnessEvent} from './harness-runtime/types.js';

export type InstanceActivity={id:string;kind:'tool'|'message';title?:string;status?:string;text?:string;input?:string;output?:string};
const text=(value:unknown,limit=2400):string|undefined=>typeof value==='string'?String(redact(value)).slice(0,limit):undefined;
const content=(value:any):string|undefined=>typeof value==='string'?text(value):Array.isArray(value)?text(value.map(v=>v?.type==='content'?v.content?.text:v?.type==='text'?v.text:undefined).filter(Boolean).join('\n')):undefined;
/** Small, redacted display projection; never forward arbitrary native metadata or images. */
export function instanceActivity(event:HarnessEvent):InstanceActivity|undefined {
 const p=event.payload as any;if(!p || typeof p!=='object')return;
 if(event.type==='reasoning'){
  const value=content(p.content)??text(p.text);if(!value)return;
  return {id:event.itemId??'progress',kind:'message',text:value};
 }
 if(event.type!=='tool')return;
 const raw=p.status??p.state?.status;
 const status=({pending:'running',in_progress:'running',running:'running',completed:'success',success:'success',failed:'error',error:'error',cancelled:'stopped'} as Record<string,string>)[raw]
  ??(p.type==='tool_execution_start'?'running':p.type==='tool_execution_end'?(p.isError?'error':'success'):undefined);
 const input=p.rawInput??p.args??p.input;
 return {id:event.itemId??p.toolCallId??`tool-${event.seq}`,kind:'tool',
  ...(text(p.title??p.toolName??p.name,160)?{title:text(p.title??p.toolName??p.name,160)}:{}),
  ...(status?{status}:{}),...(input!==undefined?{input:text(typeof input==='string'?input:JSON.stringify(redact(input)))}:{}),
  ...(content(p.content??p.result?.content??p.state?.output)?{output:content(p.content??p.result?.content??p.state?.output)}:{})};
}
/** ACP updates are patches: omitted fields retain their previous values. */
export function mergeInstanceActivity(items:InstanceActivity[],update:InstanceActivity){
 const index=items.findIndex(v=>v.id===update.id&&v.kind===update.kind);
 if(index<0){if(items.length<256)items.push(update);}
 else {const previous=items[index];items[index]={...previous,...update,...(update.kind==='message'?{text:((previous.text??'')+(update.text??'')).slice(0,12000)}: {})};}
}
