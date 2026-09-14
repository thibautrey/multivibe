/** Storage-free, non-inference model discovery for the isolated Team vault. */
import {MODELS_CLIENT_VERSION} from './config.js';
import {buildXaiUpstreamHeaders} from './xai.js';
import {openCodeAccountHeaders,openCodeInferenceToken} from './opencode.js';
import {buildCopilotHeaders, copilotModelEntries} from './github-copilot.js';
import {encodeTeamDeviceCredential, decodeTeamProviderCredential} from './team-provider-credential.js';
import type {Account} from './types.js';

export async function discoverTeamDeviceAccount(account:Account, transport:typeof fetch):Promise<{account:Account;endpoint:string;availableModels:string[]}> {
  try {
    const bundle=encodeTeamDeviceCredential(account);
    const endpoint=account.baseUrl??(account.provider==='openai'?'https://chatgpt.com':'https://api.x.ai/v1');
    const validated=decodeTeamProviderCredential(bundle,account.provider!,endpoint);
    const safeAccount:Account={...account,...validated};
    // The same provider discovery contract as the native Core edge's
    // model_discovery_url/model_discovery_headers/upstream_model_entries.
    // Keep these adaptations inside Core; Cloud only admits exact egress routes.
    let url=`${validated.baseUrl}/models`;
    let headers:Record<string,string>={authorization:`Bearer ${safeAccount.accessToken}`,accept:'application/json'};
    if(account.provider==='openai') {
      if(!/^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/.test(MODELS_CLIENT_VERSION))throw Error();
      url=`${validated.baseUrl}/backend-api/codex/models?client_version=${MODELS_CLIENT_VERSION}`;
      if(safeAccount.chatgptAccountId)headers['chatgpt-account-id']=safeAccount.chatgptAccountId;
    } else if(account.provider==='opencode') {
      // Console accounts infer at /inference/openai, but discover via Zen.
      url='https://opencode.ai/zen/v1/models';
      headers={...openCodeAccountHeaders(safeAccount),authorization:`Bearer ${openCodeInferenceToken(safeAccount)}`,accept:'application/json'};
    } else if(account.provider==='github-copilot')headers=buildCopilotHeaders(safeAccount.accessToken,undefined,'application/json');
    else if(account.provider==='xai')headers=buildXaiUpstreamHeaders(safeAccount.accessToken,{accept:'application/json'});
    const response=await transport(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(15_000),headers});
    if(!response.ok||!response.body)throw Error();
    const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
    try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2*1024*1024)throw Error();chunks.push(value);}}
    finally {await reader.cancel();reader.releaseLock();}
    const payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const rawEntries=account.provider==='openai'?payload?.models:payload?.data;
    if(!Array.isArray(rawEntries)||rawEntries.length>4096)throw Error();
    const entries=account.provider==='github-copilot'?copilotModelEntries(payload):account.provider==='openai'?rawEntries.map((entry:any)=>({id:typeof entry?.slug==='string'?entry.slug.trim():entry?.slug})):rawEntries;
    const models=entries.map((entry:{id?:unknown})=>entry?.id);
    if(!models.length||models.some((id:unknown)=>typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/.test(id))||new Set(models).size!==models.length)throw Error();
    const result:Account={...account,...validated};
    if(account.provider==='github-copilot')result.copilotModelEndpoints=Object.fromEntries(entries.map((entry:any)=>[entry.id,entry.upstreamMode]));
    encodeTeamDeviceCredential(result);
    return {account:result,endpoint:validated.baseUrl!,availableModels:(models as string[]).slice().sort()};
  } catch {throw Error('Team device model discovery unavailable');}
}
