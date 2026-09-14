import assert from 'node:assert/strict';
import test from 'node:test';
import {requestOpenCodeDeviceCode,pollOpenCodeDeviceCode,accountFromOpenCodeOAuth,refreshOpenCodeAccessToken} from './opencode.js';
import type {OAuthFlowState} from './types.js';

test('OpenCode complete device lifecycle uses only injected transport',async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=async()=>{throw Error('Direct egress forbidden')};
 const requests:{path:string;init:RequestInit|undefined}[]=[];
 const transport:typeof fetch=async(input,init)=>{
  const path=new URL(String(input)).pathname;requests.push({path,init});
  if(path==='/auth/device/code')return Response.json({device_code:'private-code',user_code:'ABCD',verification_uri_complete:'/device?user_code=ABCD',expires_in:900,interval:5});
  if(path==='/auth/device/token')return Response.json({access_token:'private-token',refresh_token:'private-refresh',expires_in:3600});
  if(path==='/api/user')return Response.json({id:'user-one',email:'fixture@example.test'});
  if(path==='/api/orgs')return Response.json([{id:'org-one',name:'Team'}]);
  if(path==='/api/config'){
   assert.equal(new Headers(init?.headers).get('x-org-id'),'org-one');
   return Response.json({config:{provider:{opencode:{api:'https://opencode.ai/inference/openai/v1',options:{apiKey:'{env:OPENCODE_CONSOLE_TOKEN}'}}}}});
  }
  throw Error('Unexpected request');
 };
 try{
  const challenge=await requestOpenCodeDeviceCode(transport);
  const polled=await pollOpenCodeDeviceCode(challenge.deviceCode,5,transport);
  assert.equal(polled.status,'success');if(polled.status!=='success')throw Error('Missing token');
  const flow:OAuthFlowState={id:'flow',email:'',codeVerifier:'',createdAt:Date.now(),method:'device',provider:'opencode',status:'pending'};
  const account=await accountFromOpenCodeOAuth(flow,polled.token,undefined,transport);
  assert.equal(account.opencodeOrgId,'org-one');assert.equal(account.baseUrl,'https://opencode.ai/inference/openai');
  await refreshOpenCodeAccessToken(account,transport);
  assert.deepEqual(requests.map(r=>r.path),['/auth/device/code','/auth/device/token','/api/user','/api/orgs','/api/config','/auth/device/token']);
  assert.equal(JSON.parse(String(requests.at(-1)!.init?.body)).grant_type,'refresh_token');
 }finally{globalThis.fetch=original}
});

test('OpenCode transport failure cannot fall back to direct fetch',async()=>{
 const original=globalThis.fetch;let direct=0;
 globalThis.fetch=async()=>{direct++;throw Error('Direct egress forbidden')};
 const denied:typeof fetch=async()=>{throw Error('Transport denied')};
 try{
  await assert.rejects(requestOpenCodeDeviceCode(denied),/Transport denied/);
  await assert.rejects(pollOpenCodeDeviceCode('private',5,denied),/Transport denied/);
  assert.equal(direct,0);
 }finally{globalThis.fetch=original}
});
