import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRuntime,runOpenCode,MODEL} from './runtime.mjs';
const apiKey='fixture-local-runtime-key-123456';
const body={model:MODEL,messages:[{role:'user',content:'Bonjour'}],max_tokens:32};
async function server(run,fn,maxConcurrent=2){
 const s=createRuntime({apiKey,run,maxConcurrent});s.listen(0,'127.0.0.1');await new Promise(r=>s.once('listening',r));
 const call=(value=body,headers={})=>fetch(`http://127.0.0.1:${s.address().port}/v1/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json',...headers},body:JSON.stringify(value)});
 try{await fn(call,s);}finally{s.closeAllConnections();await new Promise(r=>s.close(r));}
}
test('runtime rejects unauthenticated requests, media, tools and other models before running a CLI',async()=>{
 let calls=0;await server(async()=>{calls++;return {text:'no'}},async call=>{
  assert.equal((await call(body,{authorization:'Bearer wrong'})).status,401);
  for(const change of [{model:'paid-model'},{tools:[{type:'function'}]},{messages:[{role:'user',content:[{type:'image_url',image_url:{url:'https://example.test'}}]}]},{max_tokens:0}])assert.equal((await call({...body,...change})).status,400);
 });assert.equal(calls,0);
});
test('text replies and buffered SSE preserve content and provider usage',async()=>{
 await server(async input=>{assert.equal(input.messages[0].content,'Bonjour');assert.equal(input.maxTokens,32);return {text:'Réponse ✓',usage:{prompt_tokens:10,completion_tokens:3,total_tokens:13}}},async call=>{
  const reply=await (await call()).json();assert.equal(reply.choices[0].message.content,'Réponse ✓');assert.equal(reply.usage.total_tokens,13);
  const response=await call({...body,stream:true,stream_options:{include_usage:true}});assert.equal(response.headers.get('content-type'),'text/event-stream');const text=await response.text();assert.match(text,/Réponse ✓/);assert.match(text,/"total_tokens":13/);assert.match(text,/data: \[DONE\]/);
 });
});
test('concurrent work is bounded and disconnected requests abort the CLI operation',async()=>{
 let started;const start=new Promise(r=>started=r);let aborted;const abort=new Promise(r=>aborted=r);
 await server(input=>new Promise((_resolve,reject)=>{started();input.signal.addEventListener('abort',()=>{aborted();reject(Error('cancelled'))},{once:true})}),async(_call,s)=>{
  const controller=new AbortController();const request=fetch(`http://127.0.0.1:${s.address().port}/v1/chat/completions`,{method:'POST',signal:controller.signal,headers:{authorization:`Bearer ${apiKey}`},body:JSON.stringify(body)}).catch(()=>{});
  await start;assert.equal((await _call()).status,429);controller.abort();await request;await abort;
 },1);
});
test('CLI integration uses stdin, isolated configuration, bounded execution and cleanup',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'opencode-fixture-'));const binary=path.join(dir,'cli');
 try{
  await writeFile(binary,`#!${process.execPath}\nlet input='';for await(const c of process.stdin)input+=c;const config=JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);if(config.permission!=='ask'||!input.includes('Bonjour'))process.exit(2);console.log(JSON.stringify({type:'text',part:{text:'Vérifié ✓'}}));console.log(JSON.stringify({type:'step_finish',part:{reason:'length',tokens:{input:3,output:2,reasoning:1,cache:{read:5,write:0}}}}));\n`);await chmod(binary,0o700);
  const result=await runOpenCode({...body,messages:body.messages,maxTokens:32,signal:new AbortController().signal},{binary,tempRoot:dir,timeoutMs:5000});assert.equal(result.text,'Vérifié ✓');assert.equal(result.finishReason,'length');assert.equal(result.usage.total_tokens,11);assert.deepEqual(await readdir(dir),['cli']);
  await writeFile(binary,`#!${process.execPath}\nsetInterval(()=>{},1000);\n`);
  await assert.rejects(runOpenCode({messages:body.messages,maxTokens:32},{binary,tempRoot:dir,timeoutMs:30}),/timed out/);assert.deepEqual(await readdir(dir),['cli']);
 }finally{await rm(dir,{recursive:true,force:true});}
});
