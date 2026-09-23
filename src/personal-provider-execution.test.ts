import test from 'node:test';
import assert from 'node:assert/strict';
import {executePersonalProviderChat} from './personal-provider-execution.js';

const input={provider:'openai',endpoint:'https://api.openai.com/v1',credential:{accessToken:'private-fixture-key'},body:{model:'fixture',messages:[{role:'user',content:'Hello'}],max_tokens:8}};
test('isolated personal execution preserves API billing identity and chat response',async()=>{
  let calls=0;
  const response=await executePersonalProviderChat(input,async(url,init)=>{
    calls++;
    assert.equal(String(url),'https://api.openai.com/v1/chat/completions');
    assert.equal(new Headers(init?.headers).get('authorization'),'Bearer private-fixture-key');
    assert.equal(init?.redirect,'error');
    assert.equal(JSON.parse(String(init?.body)).max_tokens,8);
    return Response.json({id:'fixture',choices:[{message:{role:'assistant',content:'Hello'},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:1}});
  },new AbortController().signal);
  const body=await response.json();assert.equal(body.choices[0].message.content,'Hello');
  assert.equal(calls,1);assert.doesNotMatch(JSON.stringify(body),/private-fixture-key/);
});
test('personal execution streams incrementally with usage and a completion marker',async()=>{
  const response=await executePersonalProviderChat({...input,body:{...input.body,stream:true}},async()=>new Response([
    {choices:[{delta:{content:'Hello'},finish_reason:null}]},
    {choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:1}},
  ].map(value=>`data: ${JSON.stringify(value)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}}),new AbortController().signal);
  assert.equal(response.headers.get('content-type'),'text/event-stream');
  const text=await response.text();assert.match(text,/Hello/);assert.match(text,/\[DONE\]/);
});
test('personal execution rejects redirects, unknown request fields and excessive limits before dispatch',async()=>{
  let calls=0;const transport:typeof fetch=async()=>{calls++;throw Error('unexpected');};
  for(const body of [{...input.body,baseUrl:'https://attacker.test'},{...input.body,max_tokens:32769},{...input.body,stream:'true'}]) {
    await assert.rejects(executePersonalProviderChat({...input,body},transport,new AbortController().signal),/Personal provider request failed/);
  }
  await assert.rejects(executePersonalProviderChat({...input,endpoint:'https://attacker.test'},transport,new AbortController().signal));
  assert.equal(calls,0);
});
test('upstream diagnostics and stream failures cannot expose credential text',async()=>{
  await assert.rejects(executePersonalProviderChat(input,async()=>Response.json({error:{message:input.credential.accessToken}},{status:401}),new AbortController().signal),error=>{
    assert.equal((error as Error).message,'Personal provider request failed');return true;
  });
  const response=await executePersonalProviderChat({...input,body:{...input.body,stream:true}},async()=>new Response(`data: ${JSON.stringify({error:{message:input.credential.accessToken}})}\n\n`,{headers:{'content-type':'text/event-stream'}}),new AbortController().signal);
  await assert.rejects(response.text(),error=>{assert.doesNotMatch(String(error),/private-fixture-key/);return true;});
});
