import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeTeamProviderCredential} from './team-provider-credential.js';
import {createSdkModel} from './ai-sdk/models.js';
import {sdkAccountModels, sdkModelId} from './ai-sdk/catalog.js';
import type {Account} from './types.js';

// These expectations deliberately do not use the onboarding endpoint registry.
const routes = [
  ['openai', 'https://api.openai.com/v1', 'https://api.openai.com/v1/chat/completions'],
  ['anthropic', 'https://api.anthropic.com/v1', 'https://api.anthropic.com/v1/messages'],
  ['deepseek', 'https://api.deepseek.com/v1', 'https://api.deepseek.com/chat/completions'],
  ['mistral', 'https://api.mistral.ai/v1', 'https://api.mistral.ai/v1/chat/completions'],
  ['mistral-zdr', 'https://api.mistral.ai/v1', 'https://api.mistral.ai/v1/chat/completions'],
  ['xai', 'https://api.x.ai/v1', 'https://api.x.ai/v1/chat/completions'],
  ['xai-zdr', 'https://api.x.ai/v1', 'https://api.x.ai/v1/chat/completions'],
  ['z-ai', 'https://api.z.ai/api/paas/v4', 'https://api.z.ai/api/paas/v4/chat/completions'],
];

for (const [provider, endpoint, expected] of routes) test(`${provider}: Team key reaches its API transport and enforces the selected models`, async () => {
  const credential = decodeTeamProviderCredential({accessToken:'fixture-key'}, provider, endpoint);
  const account:Account = {...credential, id:'team-fixture', enabled:true,
    sdkModels:['selected'], multivibeTeam:{providerId:'fixture', models:['selected'], deliveryMode:'distributed', revision:1, readOnly:true}};
  assert.equal(account.provider, 'ai-sdk');
  const [listed] = sdkAccountModels(account);
  const raw = sdkModelId(account, listed.id);
  assert.equal(raw,'selected');
  assert.throws(() => sdkModelId(account, `${account.sdkProvider}/other`));
  const model = createSdkModel(account, raw, async (url, init) => {
    assert.equal(String(url), expected);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get(provider==='anthropic'?'x-api-key':'authorization'), provider==='anthropic'?'fixture-key':'Bearer fixture-key');
    assert.equal(JSON.parse(String(init?.body)).model, 'selected');
    return Response.json(provider==='anthropic'
      ? {id:'fixture',type:'message',role:'assistant',model:'selected',content:[{type:'text',text:'ok'}],stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:1}}
      : {id:'fixture',model:'selected',choices:[{message:{role:'assistant',content:'ok'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}});
  });
  assert.deepEqual((await model.doGenerate({prompt:[{role:'user',content:[{type:'text',text:'test'}]}],maxOutputTokens:2})).content, [{type:'text',text:'ok'}]);
  const denied = {...account, multivibeTeam:{...account.multivibeTeam!,models:[]}};
  assert.deepEqual(sdkAccountModels(denied),[]);
  assert.throws(() => sdkModelId(denied,listed.id));
});

test('bare keys cannot select a subscription endpoint or an unknown provider', () => {
  for (const [provider, endpoint] of [['openai','https://chatgpt.com'],['anthropic','https://api.openai.com/v1'],['unknown','https://example.com'],['constructor','https://example.com']]) {
    assert.throws(() => decodeTeamProviderCredential({accessToken:'fixture-key'},provider,endpoint));
  }
  assert.throws(() => decodeTeamProviderCredential({accessToken:'fixture-key',refreshToken:'oauth'},'openai','https://api.openai.com/v1'));
});
