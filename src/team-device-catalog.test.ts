import {test} from 'node:test';
import assert from 'node:assert/strict';
import {discoverTeamDeviceAccount} from './team-device-catalog.js';
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
