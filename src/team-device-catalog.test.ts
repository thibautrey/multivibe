import {test} from 'node:test';
import assert from 'node:assert/strict';
import {discoverTeamDeviceAccount} from './team-device-catalog.js';
import {MODELS_CLIENT_VERSION} from './config.js';
import type {Account} from './types.js';
const account={provider:'github-copilot',accessToken:'fixture-token',baseUrl:'https://api.githubcopilot.com'} as Account;
test('Core discovery reuses Copilot filtering and preserves per-model protocol',async()=>{
 let requests=0;
 const result=await discoverTeamDeviceAccount(account,(async(url,init)=>{
  requests++;assert.equal(url,'https://api.githubcopilot.com/models');assert.equal(init?.method,'GET');assert.equal(init?.redirect,'error');
  return Response.json({data:[{id:'a',supported_endpoints:['/responses']},{id:'b',model_picker_enabled:false}]});
 }) as typeof fetch);
 assert.equal(requests,1);assert.deepEqual(result.availableModels,['a']);assert.deepEqual(result.account.copilotModelEndpoints,{a:'responses'});
 assert.equal(account.copilotModelEndpoints,undefined);
});
test('Core discovery fails closed on untrusted endpoints, malformed catalog and upstream diagnostics',async()=>{
 let calls=0;const transport=(async()=>{calls++;return Response.json({data:[]});}) as typeof fetch;
 await assert.rejects(discoverTeamDeviceAccount({...account,baseUrl:'https://evil.example'},transport));assert.equal(calls,0);
 for(const data of [[],[{id:'bad\nmodel'}],[{id:'a'},{id:'a'}]])await assert.rejects(discoverTeamDeviceAccount(account,(async()=>Response.json({data})) as typeof fetch),{message:'Team device model discovery unavailable'});
 await assert.rejects(discoverTeamDeviceAccount(account,(async()=>{throw Error('private provider detail');}) as typeof fetch),{message:'Team device model discovery unavailable'});
});

test('OpenCode discovery uses its scoped inference key rather than the Console OAuth token',async()=>{
 const openCode={id:'local',enabled:true,provider:'opencode',accessToken:'oauth',baseUrl:'https://opencode.ai/inference/openai',opencodeAccountId:'user-one',opencodeOrgId:'org-one',opencodeConsoleUrl:'https://opencode.ai/console',opencodeApiKey:'inference-key'} as Account;
 const result=await discoverTeamDeviceAccount(openCode,async(url,init)=>{
  assert.equal(url,'https://opencode.ai/zen/v1/models');
  const headers=new Headers(init?.headers);assert.equal(headers.get('authorization'),'Bearer inference-key');assert.equal(headers.get('x-org-id'),'org-one');
  return Response.json({data:[{id:'model-b'},{id:'model-a'}]});
 });
 assert.deepEqual(result.availableModels,['model-a','model-b']);assert.equal(result.account.opencodeOrgId,'org-one');
 await discoverTeamDeviceAccount({...openCode,opencodeApiKey:'{env:OPENCODE_CONSOLE_TOKEN}'},async(_url,init)=>{assert.equal(new Headers(init?.headers).get('authorization'),'Bearer oauth');return Response.json({data:[{id:'model-a'}]})});
 let calls=0;await assert.rejects(discoverTeamDeviceAccount({...openCode,opencodeHeaders:{authorization:'leak'}},async()=>{calls++;return Response.json({data:[]})}));assert.equal(calls,0);
});


test('ChatGPT discovery uses the Codex catalog and account header, not OpenAI API models',async()=>{
 const chatgpt:Account={id:'local-only',enabled:true,provider:'openai',accessToken:'oauth-token',chatgptAccountId:'acct_fixture-123'};
 let requests=0;
 const result=await discoverTeamDeviceAccount(chatgpt,async(url,init)=>{
  requests++;assert.equal(url,`https://chatgpt.com/backend-api/codex/models?client_version=${MODELS_CLIENT_VERSION}`);
  assert.equal(init?.method,'GET');assert.equal(init?.redirect,'error');assert.ok(init?.signal);
  const headers=new Headers(init?.headers);assert.equal(headers.get('authorization'),'Bearer oauth-token');assert.equal(headers.get('chatgpt-account-id'),'acct_fixture-123');
  return Response.json({models:[{slug:' model-b '},{slug:'model-a'}]});
 });
 assert.equal(requests,1);assert.equal(result.endpoint,'https://chatgpt.com');assert.equal(result.account.chatgptAccountId,chatgpt.chatgptAccountId);assert.equal(result.account.upstreamMode,'responses');
 assert.deepEqual(result.availableModels,['model-a','model-b']);assert.equal(chatgpt.baseUrl,undefined);
 await discoverTeamDeviceAccount({...chatgpt,chatgptAccountId:undefined},async(_url,init)=>{assert.equal(new Headers(init?.headers).has('chatgpt-account-id'),false);return Response.json({models:[{slug:'model-a'}]})});
 for(const payload of [{data:[{id:'wrong-api-catalog'}]},{models:[]},{models:[{id:'wrong-key'}]},{models:[{slug:'a'},{slug:' a '}]},{models:[{slug:'bad\nslug'}]},{models:Array.from({length:4097},(_,i)=>({slug:`m-${i}`}))}])await assert.rejects(discoverTeamDeviceAccount(chatgpt,async()=>Response.json(payload)),{message:'Team device model discovery unavailable'});
 let calls=0;
 for(const patch of [{baseUrl:'https://api.openai.com/v1'},{chatgptAccountId:'bad\nheader'}])await assert.rejects(discoverTeamDeviceAccount({...chatgpt,...patch},async()=>{calls++;return Response.json({models:[]})}));
 assert.equal(calls,0);
});

test('xAI device discovery retains Core client identification headers',async()=>{
 const {accountFromXaiOAuth,buildXaiUpstreamHeaders}=await import('./xai.js');
 const xai=accountFromXaiOAuth({id:'',email:'',codeVerifier:'',createdAt:Date.now()}, {access_token:'fixture-access',expires_in:3600});
 await discoverTeamDeviceAccount(xai,async(url,init)=>{
  assert.equal(url,'https://api.x.ai/v1/models');assert.deepEqual(init?.headers,buildXaiUpstreamHeaders(xai.accessToken,{accept:'application/json'}));
  return Response.json({data:[{id:'fixture-model'}]});
 });
});
