/** Storage-free adaptation of Core's existing ChatGPT device protocol. */
import {defaultOAuthConfig as config} from './oauth-config.js';
import {pollDeviceCode, requestDeviceCode, exchangeCodeForToken, type TokenResponse} from './oauth.js';

export async function requestTeamOpenAiDeviceCode(transport:typeof fetch) {
  const result=await requestDeviceCode(config,transport);
  if(!result || typeof result.device_auth_id!=='string' || !result.device_auth_id || result.device_auth_id.length>4096 ||
    typeof result.user_code!=='string' || !/^[A-Za-z0-9-]{1,128}$/.test(result.user_code)) throw Error('Invalid device challenge');
  const verificationUrl=result.verification_url??result.verification_uri??config.deviceVerificationUrl;
  // No callback listener or caller-selected URL; user opens the fixed verification page.
  if(verificationUrl!==config.deviceVerificationUrl)throw Error('Invalid verification page');
  const intervalSeconds=Number(result.interval??5);
  let expiresAt=Date.now()+Number(result.expires_in??900)*1000;
  if(result.expires_at!==undefined){
    const numeric=Number(result.expires_at);
    expiresAt=Number.isFinite(numeric)?(numeric>10_000_000_000?numeric:numeric*1000):Date.parse(String(result.expires_at));
  }
  if(!Number.isFinite(expiresAt)||expiresAt<=Date.now()||!Number.isFinite(intervalSeconds)||intervalSeconds<=0||intervalSeconds>900)throw Error('Invalid device lifetime');
  return {deviceCode:result.device_auth_id,userCode:result.user_code,verificationUrl,intervalSeconds,expiresAt:Math.min(expiresAt,Date.now()+900_000)};
}

export async function pollTeamOpenAiDeviceCode(deviceCode:string,userCode:string,intervalSeconds:number,transport:typeof fetch):Promise<
 {status:'pending';intervalSeconds:number}|{status:'success';chatgptToken:TokenResponse}> {
  let code;
  try {
    code=await pollDeviceCode(config,{id:'',email:'',codeVerifier:'',createdAt:Date.now(),method:'device',provider:'openai',status:'pending',deviceAuthId:deviceCode,userCode},transport);
  }catch(error){
    if(error instanceof Error && ['authorization_pending','deviceauth_authorization_pending','deviceauth_authorization_unknown'].includes(error.message))return {status:'pending',intervalSeconds};
    if(error instanceof Error && error.message==='slow_down')return {status:'pending',intervalSeconds:intervalSeconds+5};
    throw error;
  }
  if(!code || typeof code.authorization_code!=='string'||!code.authorization_code||code.authorization_code.length>8192||
    typeof code.code_verifier!=='string'||!code.code_verifier||code.code_verifier.length>1024)throw Error('Invalid device approval');
  // The provider's fixed device redirect URI is token-exchange metadata only.
  // It does not invoke browser OAuth or start a local HTTP callback server.
  const token=await exchangeCodeForToken(config,code.authorization_code,code.code_verifier,config.deviceRedirectUri,transport);
  if(!token||typeof token.access_token!=='string'||!token.access_token||token.access_token.length>32768||
    token.refresh_token!==undefined&&(typeof token.refresh_token!=='string'||!token.refresh_token||token.refresh_token.length>32768)||
    token.account_id!==undefined&&(typeof token.account_id!=='string'||!token.account_id||token.account_id.length>1024)||
    token.id_token!==undefined&&(typeof token.id_token!=='string'||!token.id_token||token.id_token.length>32768)||
    token.expires_in!==undefined&&(!Number.isFinite(token.expires_in)||token.expires_in<=0))throw Error('Invalid device credentials');
  return {status:'success',chatgptToken:token};
}
