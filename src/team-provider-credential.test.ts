import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeTeamDeviceCredential, decodeTeamProviderCredential, withoutTeamCredentialContext} from './team-provider-credential.js';
import {accountFromXaiOAuth} from './xai.js';
import type {Account, OAuthFlowState} from './types.js';

const copilot:Account={id:'local-only-id',provider:'github-copilot',accessToken:'access',refreshToken:'refresh',expiresAt:1900000000000,
  baseUrl:'https://api.business.githubcopilot.com',enabled:true,copilotModelEndpoints:{'z-model':'responses','a-model':'chat/completions'},
  email:'not-for-cloud@example.test',state:{lastError:'private-diagnostic'},sdkProvider:'must-not-travel'};
function xai():Account{return accountFromXaiOAuth({id:'',email:'',codeVerifier:'',createdAt:Date.now(),method:'device',provider:'xai',status:'pending'} as OAuthFlowState,
 {access_token:'access',refresh_token:'refresh',expires_in:3600});}

test('device codec preserves inference context but excludes unrelated account state',()=>{
 const encoded=encodeTeamDeviceCredential(copilot);
 assert.equal(encoded.accessToken,'access');assert.equal(encoded.refreshToken,'refresh');
 assert.doesNotMatch(JSON.stringify(encoded),/local-only-id|not-for-cloud|private-diagnostic|must-not-travel/);
 const decoded=decodeTeamProviderCredential(encoded,'github-copilot',copilot.baseUrl!+'/');
 assert.deepEqual(decoded.copilotModelEndpoints,{'a-model':'chat/completions','z-model':'responses'});
 assert.equal(decoded.baseUrl,copilot.baseUrl);
 assert.equal(decoded.provider,'github-copilot');assert.equal(decoded.email,undefined);
 assert.equal(encodeTeamDeviceCredential({...copilot,copilotModelEndpoints:{'a-model':'chat/completions','z-model':'responses'}}).coreAccountContext,encoded.coreAccountContext);
});
test('xAI codec preserves Core OAuth issuer/client/scope and responses mode',()=>{
 const account={...xai(),xaiUserId:'fixture-user'};
 const decoded=decodeTeamProviderCredential(encodeTeamDeviceCredential(account),'xai','https://api.x.ai/v1');
 for(const key of ['oidcIssuer','oidcClientId','xaiAuthScope','xaiUserId','upstreamMode'] as const)assert.equal(decoded[key],account[key]);
 assert.equal(decoded.baseUrl,'https://api.x.ai/v1');
 for(const patch of [{oidcIssuer:'https://attacker.test'},{oidcClientId:'other'},{xaiAuthScope:'other'},{baseUrl:'https://attacker.test/v1'}])assert.throws(()=>encodeTeamDeviceCredential({...account,...patch}),/invalid/);
});
test('context cannot be retargeted to another provider or endpoint',()=>{
 const encoded=encodeTeamDeviceCredential(copilot);
 for(const endpoint of ['https://api.githubcopilot.com','https://attacker.test','http://api.business.githubcopilot.com','https://api.business.githubcopilot.com?secret=leak'])assert.throws(()=>decodeTeamProviderCredential(encoded,'github-copilot',endpoint),/invalid/);
 assert.throws(()=>decodeTeamProviderCredential(encoded,'xai',copilot.baseUrl!),/invalid/);
});
test('unknown, oversized and malicious context cannot become account properties',()=>{
 const encoded=encodeTeamDeviceCredential(copilot),context=JSON.parse(encoded.coreAccountContext!);
 for(const replacement of [null,[],{}, {...context,schemaVersion:2},{...context,accessToken:'override'},{...context,opencodeHeaders:{authorization:'leak'}},
  {...context,copilotModelEndpoints:JSON.parse('{"__proto__":"responses"}')},{...context,copilotModelEndpoints:{model:'http://attacker.test'}},
  {...context,upstreamMode:'anything'},{...context,provider:'opencode'}]){
  assert.throws(()=>decodeTeamProviderCredential({...encoded,coreAccountContext:JSON.stringify(replacement)},'github-copilot',copilot.baseUrl!),/invalid/);
 }
 for(const replacement of [42,'','{','x'.repeat(65537)])assert.throws(()=>decodeTeamProviderCredential({...encoded,coreAccountContext:replacement},'github-copilot',copilot.baseUrl!),/invalid/);
});
test('legacy keys remain supported but malformed private fields are never silently stripped',()=>{
 assert.deepEqual(decodeTeamProviderCredential({accessToken:'api-key'},'openai','https://api.openai.com/v1'),{accessToken:'api-key'});
 for(const patch of [{refreshToken:null},{refreshToken:''},{expiresAt:'1'},{expiresAt:NaN},{expiresAt:Infinity},{expiresAt:-1},{accessToken:'bad\nkey'},{accessToken:'x'.repeat(8193)},{extra:'untrusted'}]){
  assert.throws(()=>decodeTeamProviderCredential({accessToken:'api-key',...patch},'openai','https://api.openai.com/v1'),/invalid/);
 }
});
test('replacing a synchronized account removes all prior provider credential context',()=>{
 const cleaned=withoutTeamCredentialContext({...copilot,chatgptAccountId:'stale-chatgpt',opencodeApiKey:'stale-key',opencodeHeaders:{authorization:'stale'},
  oidcIssuer:'stale',xaiUserId:'stale',localRuntime:undefined,multivibeCloud:true});
 assert.deepEqual(cleaned,{id:copilot.id,provider:'github-copilot',enabled:true,email:copilot.email});
 assert.deepEqual(withoutTeamCredentialContext(undefined),{});
});

test('OpenCode context preserves workspace and inference credential without arbitrary routing',()=>{
 const account:Account={id:'local',enabled:true,provider:'opencode',accessToken:'oauth',refreshToken:'renew',baseUrl:'https://opencode.ai/inference/openai',opencodeAccountId:'user-one',opencodeOrgId:'org-one',opencodeConsoleUrl:'https://opencode.ai/console',opencodeApiKey:'{env:OPENCODE_CONSOLE_TOKEN}',opencodeHeaders:{'x-org-id':'org-one'}};
 const decoded=decodeTeamProviderCredential(encodeTeamDeviceCredential(account),'opencode',account.baseUrl!);
 assert.equal(decoded.opencodeOrgId,'org-one');assert.equal(decoded.opencodeApiKey,account.opencodeApiKey);
 for(const patch of [{baseUrl:'https://evil.test'},{opencodeConsoleUrl:'https://evil.test'}, {opencodeOrgId:'org\nheader'},{opencodeApiKey:'{file:/private}'},{opencodeHeaders:{authorization:'private'}},{opencodeHeaders:{'x-org-id':'other'}}])assert.throws(()=>encodeTeamDeviceCredential({...account,...patch}),/invalid/);
 assert.throws(()=>decodeTeamProviderCredential(encodeTeamDeviceCredential(account),'xai',account.baseUrl!),/invalid/);
 assert.equal(withoutTeamCredentialContext(account).opencodeApiKey,undefined);
});
