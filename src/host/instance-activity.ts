import {redact,type HarnessEvent} from './harness-runtime/types.js';

export type InstanceActivityKind='tool'|'message'|'agent'|'plan'|'status';
export type InstanceActivity={id:string;kind:InstanceActivityKind;title?:string;status?:string;text?:string;input?:string;output?:string;append?:boolean};
const text=(value:unknown,limit=2400):string|undefined=>typeof value==='string'?String(redact(value)).slice(0,limit):undefined;
const json=(value:unknown):string|undefined=>value===undefined?undefined:text(JSON.stringify(redact(value)));
const content=(value:any):string|undefined=>typeof value==='string'?text(value):Array.isArray(value)?text(value.map(v=>v?.type==='content'?v.content?.text:v?.type==='text'?v.text:undefined).filter(Boolean).join('\n')):undefined;
const status=(raw:unknown):string|undefined=>({pending:'running',started:'running',in_progress:'running',running:'running',completed:'success',complete:'success',success:'success',succeeded:'success',failed:'error',error:'error',cancelled:'stopped',canceled:'stopped',aborted:'stopped'} as Record<string,string>)[String(raw??'').toLowerCase()];
const phaseStatus=(phase:unknown):string|undefined=>String(phase??'').includes('started')?'running':String(phase??'').includes('completed')?'success':undefined;
const nestedText=(value:any):string|undefined=>content(value?.content)??text(value?.text??value?.message??value?.summary??value?.description);
const messageParts=(value:any):string|undefined=>Array.isArray(value?.message?.content)?content(value.message.content):undefined;

function toolActivity(event:HarnessEvent,p:any):InstanceActivity[] {
 const calls=Array.isArray(p.tool_calls)?p.tool_calls:[];
 if(calls.length)return calls.slice(0,32).map((call:any,index:number)=>({
  id:call.id??`${event.itemId??'tool'}-${call.index??index}`,kind:'tool',title:text(call.function?.name??call.name,160)??'Outil',status:'running',
  ...(call.function?.arguments!==undefined?{input:text(String(call.function.arguments))}:{}),append:true,
 }));
 const item=p.item??{},state=p.state??{},type=p.type??item.type;
 const rawStatus=p.status??state.status??state.type;
 const resolved=status(rawStatus)??phaseStatus(p.phase)
  ??(type==='tool_execution_start' || type==='tool_progress'?'running':type==='tool_execution_end'?(p.isError?'error':'success'):undefined);
 const input=p.rawInput??p.args??p.input??state.input??item.arguments??item.command;
 const output=content(p.content??p.result?.content??p.result??state.output??p.output??item.output??item.aggregatedOutput);
 return [{id:event.itemId??p.toolCallId??p.tool_use_id??p.callID??item.id??`tool-${event.seq}`,kind:'tool',
  title:text(p.title??p.toolName??p.tool_name??p.name??item.title??item.name??item.type,160)??'Outil',
  ...(resolved?{status:resolved}:{}),...(input!==undefined?{input:typeof input==='string'?text(input):json(input)}:{}),
  ...(output?{output}:{}),...(type==='tool_execution_update'?{append:true}:{})}];
}

/** Small, redacted display projection shared by every Host harness adapter. */
export function instanceActivities(event:HarnessEvent):InstanceActivity[] {
 const p=event.payload as any;if(!p || typeof p!=='object')return [];
 if(event.type==='tool')return toolActivity(event,p);
 if(event.type==='reasoning'){
  const value=content(p.content)??text(p.text??p.delta??p.summary);return value?[{id:event.itemId??'progress',kind:'message',text:value,append:true}]:[];
 }
 if(event.type==='terminal.output'){
  const output=text(p.delta??p.output??p.text);return output?[{id:event.itemId??'terminal',kind:'tool',title:'Sortie de commande',status:'running',output,append:true}]:[];
 }
 if(event.type==='agent'){
  const item=p.item??{},value=messageParts(p)??nestedText(p)??nestedText(item);
  return [{id:event.itemId??p.task_id??item.id??`agent-${event.seq}`,kind:'agent',title:text(p.title??p.task_type??p.name??item.name,160)??'Sous-agent',
   status:status(p.status??p.subtype)??phaseStatus(p.phase)??'running',...(value?{text:value,append:true}:{})}];
 }
 if(event.type==='plan'){
  const value=nestedText(p)??json(p.steps??p.entries??p.plan);
  return [{id:event.itemId??'plan',kind:'plan',title:'Plan',status:status(p.status)??'running',...(value?{text:value}:{})}];
 }
 if(event.type==='compaction')return [{id:event.itemId??'compaction',kind:'status',title:'Compression du contexte',status:status(p.status??p.state)??phaseStatus(p.phase)??(String(p.subtype??'').includes('boundary')?'success':'running'),...(nestedText(p)?{text:nestedText(p)}:{})}];
 if(event.type==='retry')return [{id:event.itemId??'retry',kind:'status',title:'Nouvelle tentative',status:'running',...(nestedText(p)?{text:nestedText(p)}:{})}];
 if(event.type==='diagnostic')return [{id:event.itemId??`diagnostic-${event.seq}`,kind:'status',title:'Diagnostic',status:status(p.state)??'error',...(text(p.message??p.error)?{text:text(p.message??p.error)}:{})}];
 if(event.type==='notice')return [{id:event.itemId??`notice-${event.seq}`,kind:'status',title:text(p.title,160)??'Information',status:'success',...(text(p.message)?{text:text(p.message)}:{})}];
 return [];
}

/** Updates are patches; omitted fields retain prior values and deltas append. */
export function mergeInstanceActivity(items:InstanceActivity[],update:InstanceActivity){
 const index=items.findIndex(v=>v.id===update.id&&v.kind===update.kind);
 if(index<0){if(items.length<256)items.push(update);return;}
 const previous=items[index],append=update.append===true;
 items[index]={...previous,...update,
  ...(append&&update.text?{text:((previous.text??'')+update.text).slice(0,12_000)}:{}),
  ...(append&&update.input?{input:((previous.input??'')+update.input).slice(0,12_000)}:{}),
  ...(append&&update.output?{output:((previous.output??'')+update.output).slice(0,12_000)}:{})};
}
