import assert from 'node:assert/strict';
import test from 'node:test';
import {instanceActivities,mergeInstanceActivity,type InstanceActivity} from './instance-activity.js';
import type {HarnessEvent} from './harness-runtime/types.js';
const event=(type:string,payload:any,itemId?:string):HarnessEvent=>({sessionId:'session',turnId:'turn',type,payload,itemId,seq:1,createdAt:1});

test('projects tool lifecycle events from every first-party harness',()=>{
 const fixtures:[string,HarnessEvent,string,string][]=[
  ['Hermes and Gemini ACP',event('tool',{title:'Lire',status:'in_progress',rawInput:{url:'https://example.com'}},'acp'),'Lire','running'],
  ['Pi',event('tool',{type:'tool_execution_start',toolCallId:'pi',toolName:'Shell',args:{command:'pwd'}},'pi'),'Shell','running'],
  ['Codex',event('tool',{phase:'item/completed',item:{id:'codex',type:'commandExecution',command:'pwd',aggregatedOutput:'ok'}},'codex'),'commandExecution','success'],
  ['Claude Code',event('tool',{type:'tool_use',id:'claude',name:'Read',input:{file_path:'README.md'}},'claude'),'Read',''],
  ['OpenCode',event('tool',{type:'tool',callID:'open',name:'bash',state:{status:'failed',input:{command:'false'},output:'exit 1'}},'open'),'bash','error'],
  ['Open WebUI',event('tool',{type:'function_call',name:'remote-tool',status:'completed'},'webui'),'remote-tool','success'],
 ];
 for(const [name,input,title,status] of fixtures){const value=instanceActivities(input);assert.equal(value.length,1,name);assert.equal(value[0].title,title,name);if(status)assert.equal(value[0].status,status,name);}
});

test('projects LibreChat batches as separate bounded tool activities',()=>{
 const values=instanceActivities(event('tool',{tool_calls:[{index:0,id:'one',function:{name:'search',arguments:'{"q":"x"}'}},{index:1,id:'two',function:{name:'read',arguments:'{}'}}]}));
 assert.deepEqual(values.map(v=>[v.id,v.title,v.status]),[['one','search','running'],['two','read','running']]);
 const merged:InstanceActivity[]=[];
 for(const update of instanceActivities(event('tool',{tool_calls:[{index:0,id:'fragment',function:{name:'search',arguments:'{"q"'}}]})))mergeInstanceActivity(merged,update);
 for(const update of instanceActivities(event('tool',{tool_calls:[{index:0,id:'fragment',function:{arguments:':"x"}'}}]})))mergeInstanceActivity(merged,update);
 assert.equal(merged[0].input,'{"q":"x"}');assert.equal(merged[0].title,'search');
});

test('projects reasoning, subagents, plans, compaction, retries, diagnostics and terminal output',()=>{
 const fixtures:[HarnessEvent,string][]=[
  [event('reasoning',{text:'Analyse'}),'message'],
  [event('agent',{subtype:'task_progress',task_id:'task',message:'Recherche'},'task'),'agent'],
  [event('plan',{steps:[{step:'Inspecter'}]}),'plan'],
  [event('compaction',{phase:'item/started'}),'status'],
  [event('retry',{message:'Nouvelle tentative'}),'status'],
  [event('diagnostic',{message:'Échec',state:'failed'}),'status'],
  [event('notice',{message:'Information'}),'status'],
  [event('terminal.output',{delta:'ligne\n'},'command'),'tool'],
 ];
 for(const [input,kind] of fixtures)assert.equal(instanceActivities(input)[0]?.kind,kind,input.type);
});

test('merges deltas, preserves patches and redacts private fields',()=>{
 const values:InstanceActivity[]=[];
 for(const update of instanceActivities(event('reasoning',{text:'A'})))mergeInstanceActivity(values,update);
 for(const update of instanceActivities(event('reasoning',{text:'B'})))mergeInstanceActivity(values,update);
 assert.equal(values[0].text,'AB');
 mergeInstanceActivity(values,{id:'tool',kind:'tool',title:'Lire',status:'running',input:JSON.stringify({api_key:'[private]'})});
 mergeInstanceActivity(values,{id:'tool',kind:'tool',status:'success',output:'ok'});
 assert.deepEqual(values[1],{id:'tool',kind:'tool',title:'Lire',status:'success',input:'{"api_key":"[private]"}',output:'ok'});
 const projected=instanceActivities(event('tool',{name:'secret-safe',input:{api_key:'must-not-travel'}},'redacted'))[0];
 assert.doesNotMatch(projected.input??'',/must-not-travel/);assert.match(projected.input??'',/private/);
});
