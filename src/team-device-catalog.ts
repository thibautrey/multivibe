/** Storage-free, non-inference model discovery for the isolated Team vault. */
import {openCodeAccountHeaders,openCodeInferenceToken} from './opencode.js';
import {buildCopilotHeaders, copilotModelEntries} from './github-copilot.js';
import {encodeTeamDeviceCredential, decodeTeamProviderCredential} from './team-provider-credential.js';
import type {Account} from './types.js';

export async function discoverTeamDeviceAccount(account:Account, transport:typeof fetch):Promise<{account:Account;endpoint:string;availableModels:string[]}> {
  try {
    const bundle=encodeTeamDeviceCredential(account);
    const endpoint=account.baseUrl??'https://api.x.ai/v1';
    const validated=decodeTeamProviderCredential(bundle,account.provider!,endpoint);
    const safeAccount:Account={...account,...validated};
    const response=await transport(`${validated.baseUrl}/models`,{method:'GET',redirect:'error',signal:AbortSignal.timeout(15_000),
      headers:account.provider==='github-copilot'?buildCopilotHeaders(account.accessToken,undefined,'application/json'):
        account.provider==='opencode'?{...openCodeAccountHeaders(safeAccount),authorization:`Bearer ${openCodeInferenceToken(safeAccount)}`,accept:'application/json'}:{authorization:`Bearer ${account.accessToken}`,accept:'application/json'}});
    if(!response.ok||!response.body)throw Error();
    const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
    try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2*1024*1024)throw Error();chunks.push(value);}}
    finally {await reader.cancel();reader.releaseLock();}
    const payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(!Array.isArray(payload?.data)||payload.data.length>4096)throw Error();
    const entries=account.provider==='github-copilot'?copilotModelEntries(payload):payload.data;
    const models=entries.map((entry:{id?:unknown})=>entry?.id);
    if(!models.length||models.some((id:unknown)=>typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/.test(id))||new Set(models).size!==models.length)throw Error();
    const result:Account={...account,...validated};
    if(account.provider==='github-copilot')result.copilotModelEndpoints=Object.fromEntries(entries.map((entry:any)=>[entry.id,entry.upstreamMode]));
    encodeTeamDeviceCredential(result);
    return {account:result,endpoint:validated.baseUrl!,availableModels:[...models].sort()};
  } catch {throw Error('Team device model discovery unavailable');}
}
