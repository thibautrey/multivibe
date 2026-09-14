import fs from "node:fs/promises";
import path from "node:path";
import { createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomUUID, sign } from "node:crypto";
import type { Account, ProviderId, StoreSettings } from "./types.js";
import type { AccountStore } from "./store.js";
import type { TraceEntry } from "./traces.js";
import {decodeTeamProviderCredential, withoutTeamCredentialContext} from "./team-provider-credential.js";

export type TeamPrincipal = Readonly<{ type:"member"|"service"|"unassigned"; id?:string; name?:string }>;
export type TeamProviderManifest = Readonly<{
  id:string; provider:ProviderId; displayName:string; endpoint:string; models:readonly string[];
  deliveryMode:"distributed"|"cloud_proxy"; enabled:boolean; revision:number;
  sealedCredential?:Readonly<{schemaVersion:"multivibe-team-sealed-credential-v1";algorithm:"X25519-HKDF-SHA256-AES-256-GCM";ephemeralPublicKeySpki:string;nonce:string;ciphertext:string;tag:string}>;
}>;
export type TeamSyncManifest = Readonly<{schemaVersion:"multivibe-team-sync-v1";cursor:number;providers:readonly TeamProviderManifest[];removedProviderIds:readonly string[];removedProviders?:readonly {id:string;revision:number}[]} >;
export type TeamInstanceEnrollment=Readonly<{schemaVersion:"multivibe-team-instance-enrollment-v1";id:string;name:string;publicKeySpki:string;encryptionPublicKeySpki:string;version:string}>;
/** The one-use mvmb_ bootstrap is carried only in Authorization, never JSON. */
export type ManagedTeamEnrollmentExchange=Readonly<{schemaVersion:"multivibe-team-managed-enrollment-v1";profileId:string;organizationId:string;membershipId:string;managementChannel:"device"|"user";instance:TeamInstanceEnrollment;deviceClaim?:Readonly<{issuer:string;subject:string;nonce:string}>}>;

type IdentityDocument={schemaVersion:1;instanceId:string;privateKeyPkcs8:string;publicKeySpki:string;encryptionPrivateKeyPkcs8:string;encryptionPublicKeySpki:string;createdAt:string};
type Aggregate={
  bucketId:string; bucketStart:string; revision:number; instanceId:string; principal:TeamPrincipal;
  provider:string;model:string;project?:string;application?:string;executionLocation:"local"|"personal-cluster"|"cloud";
  requests:number;succeeded:number;failed:number;inputTokens:number;outputTokens:number;cachedInputTokens:number;reasoningTokens:number;
  estimatedCostUsd:number;latencyHistogram:number[];ttftHistogram:number[];
};

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HISTOGRAM_BOUNDS=[25,50,100,200,350,500,750,1000,1500,2500,5000,10000,20000,30000,60000,Infinity];

function privateHost(host:string):boolean {
  const value=host.toLowerCase();
  return value==='localhost'||value.endsWith('.local')||value==='::1'||/^127\./.test(value)||/^10\./.test(value)||/^192\.168\./.test(value)||/^169\.254\./.test(value)||/^172\.(1[6-9]|2\d|3[01])\./.test(value);
}

export function teamSyncEligibility(account:Account):{eligible:boolean;reason?:string} {
  if(account.multivibeCloud) return {eligible:false,reason:'multivibe_cloud_internal'};
  if(account.multivibeTeam) return {eligible:false,reason:'already_synchronized'};
  if(account.localRuntime||account.location==='local'||account.location==='personal-cluster') return {eligible:false,reason:'local_runtime'};
  if(!account.baseUrl) return {eligible:true};
  try { const url=new URL(account.baseUrl); if(url.protocol!=='https:'||url.username||url.password||privateHost(url.hostname)) return {eligible:false,reason:'endpoint_not_public_https'}; }
  catch { return {eligible:false,reason:'endpoint_invalid'}; }
  return {eligible:true};
}

function histogram(value:number|undefined):number[] {
  const result=Array(16).fill(0) as number[];
  if(typeof value==='number'&&Number.isFinite(value)&&value>=0) result[HISTOGRAM_BOUNDS.findIndex(bound=>value<=bound)] = 1;
  return result;
}

function aggregateKey(instanceId:string,trace:TraceEntry,principal:TeamPrincipal,bucketStart:string):string {
  return [instanceId,bucketStart,principal.type,principal.id??'',trace.provider??'unknown',trace.resolvedModel??trace.model??'unknown',trace.projectId??'',trace.application??'',trace.executionLocation??'cloud'].join('\0');
}

// All Team mutations sharing one store serialize reads and writes. Failure
// releases the queue so a corrected operation or durable-write retry can run.
const manifestQueues = new WeakMap<AccountStore, Promise<unknown>>();
export class MultivibeTeamSyncService {
  private identity?:IdentityDocument;
  private aggregates=new Map<string,Aggregate>();
  private readonly outboxPath:string;
  constructor(private readonly store:AccountStore,private readonly identityPath:string){this.outboxPath=`${identityPath}.analytics-outbox.json`;}

  async initialize():Promise<void>{ this.identity=await this.readOrCreateIdentity();await this.readOutbox(); }
  getIdentity():Readonly<Omit<IdentityDocument,'privateKeyPkcs8'|'encryptionPrivateKeyPkcs8'>> {
    if(!this.identity) throw new Error('Team Sync is not initialized');
    const {privateKeyPkcs8:_,encryptionPrivateKeyPkcs8:__,...publicIdentity}=this.identity; return Object.freeze(publicIdentity);
  }
  async status(){const settings=await this.store.getSettings();return {schemaVersion:'multivibe-team-status-v1',connected:settings.multivibeTeam?.enabled===true,identity:this.getIdentity(),syncCursor:settings.multivibeTeam?.syncCursor??0,pendingAnalyticsBuckets:this.aggregates.size,lastSuccessfulSyncAt:settings.multivibeTeam?.lastSuccessfulSyncAt,lastSuccessfulAnalyticsUploadAt:settings.multivibeTeam?.lastSuccessfulAnalyticsUploadAt};}
  enrollmentDocument(name:string,version:string):TeamInstanceEnrollment{const identity=this.getIdentity();return Object.freeze({schemaVersion:'multivibe-team-instance-enrollment-v1',id:identity.instanceId,name:name.trim()||'Multivibe instance',publicKeySpki:identity.publicKeySpki,encryptionPublicKeySpki:identity.encryptionPublicKeySpki,version});}
  async eligibleProviders(){return (await this.store.listAccounts()).map(account=>({accountId:account.id,provider:account.provider??'openai',email:account.email,baseUrl:account.baseUrl,...teamSyncEligibility(account)}));}

  async applyManifest(manifest:TeamSyncManifest):Promise<{applied:string[];removed:string[]}> {
    const snapshot = structuredClone(manifest);
    return this.serializeMutation(() => this.applyManifestSerial(snapshot));
  }
  private async serializeMutation<T>(operation:()=>Promise<T>):Promise<T> {
    const previous = manifestQueues.get(this.store) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    manifestQueues.set(this.store, result);
    try { return await result; }
    finally { if (manifestQueues.get(this.store) === result) manifestQueues.delete(this.store); }
  }
  private async applyManifestSerial(manifest:TeamSyncManifest):Promise<{applied:string[];removed:string[]}> {
    if(manifest.schemaVersion!=='multivibe-team-sync-v1'||!Number.isSafeInteger(manifest.cursor)||manifest.cursor<0) throw new Error('Team Sync manifest is invalid');
    if(!Array.isArray(manifest.providers))throw new Error('Team providers are invalid');
    if(!Array.isArray(manifest.removedProviderIds)||manifest.removedProviderIds.some(id=>!UUID.test(id)))throw new Error('Team removals are invalid');
    if(manifest.removedProviders!==undefined){
      if(!Array.isArray(manifest.removedProviders)||manifest.removedProviders.length!==manifest.removedProviderIds.length||new Set(manifest.removedProviderIds).size!==manifest.removedProviderIds.length)throw new Error('Team removals are invalid');
      const ids=new Set<string>();
      for(const removal of manifest.removedProviders){if(!UUID.test(removal.id)||ids.has(removal.id)||!manifest.removedProviderIds.includes(removal.id)||!Number.isSafeInteger(removal.revision)||removal.revision<1||removal.revision>manifest.cursor)throw new Error('Team removal revision is invalid');ids.add(removal.id);}
    }
    if(manifest.providers.some(provider=>provider&&manifest.removedProviderIds.includes(provider.id)))throw new Error('Conflicting Team provider removal');
    const settings=await this.store.getSettings(); const current=settings.multivibeTeam?.syncCursor??0;
    if(manifest.cursor<current) throw new Error('Team Sync manifest is stale');
    const applied:string[]=[]; const removed:string[]=[];
    const accounts=await this.store.listAccounts();
    const prepared:Account[]=[];const providerIds=new Set<string>();
    for(const item of manifest.providers){
      if(!item||!UUID.test(item.id)||providerIds.has(item.id)||!Number.isSafeInteger(item.revision)||item.revision<1||item.revision>manifest.cursor) throw new Error('Team provider manifest is invalid');
      providerIds.add(item.id);
      if(!['distributed','cloud_proxy'].includes(item.deliveryMode)||typeof item.enabled!=='boolean'||!Array.isArray(item.models)||item.models.some((model:unknown)=>typeof model!=='string'||!model.trim()))throw new Error('Team provider manifest is invalid');
      if(item.deliveryMode==='distributed'&&!item.sealedCredential) throw new Error('Distributed Team provider credential is unavailable');
      if(item.deliveryMode==='cloud_proxy'&&item.sealedCredential) throw new Error('Cloud proxy manifest exposed a provider credential');
      const existing=accounts.find(account=>account.multivibeTeam?.providerId===item.id);
      if(existing&&existing.multivibeTeam!.revision>item.revision) throw new Error('Team provider revision is stale');
      const credential=item.sealedCredential?this.openCredential(item.id,item.revision,item.sealedCredential,item.provider,item.endpoint):undefined;
      const account:Account={...withoutTeamCredentialContext(existing),...credential,id:existing?.id??`team-${item.id}`,provider:item.provider,email:item.displayName,accessToken:credential?.accessToken??'',refreshToken:credential?.refreshToken,expiresAt:credential?.expiresAt,baseUrl:item.deliveryMode==='cloud_proxy'?`https://api.multivibe.cloud/team/providers/${item.id}`:item.endpoint,enabled:item.enabled,location:'cloud',priority:existing?.priority??0,multivibeTeam:{providerId:item.id,models:[...item.models],deliveryMode:item.deliveryMode,revision:item.revision,readOnly:true}};
      prepared.push(account);
    }
    // Validate/decrypt first, then replace accounts, removals and cursor together.
    await this.store.commitTeamManifest(prepared,manifest.removedProviderIds,current,
      {...settings.multivibeTeam,enabled:true,instanceId:this.getIdentity().instanceId,
       instanceName:settings.multivibeTeam?.instanceName??'Multivibe instance',syncCursor:manifest.cursor,
       lastSuccessfulSyncAt:new Date().toISOString(),lastSuccessfulAnalyticsUploadAt:settings.multivibeTeam?.lastSuccessfulAnalyticsUploadAt});
    applied.push(...prepared.map(account=>account.multivibeTeam!.providerId));
    removed.push(...manifest.removedProviderIds);
    return {applied,removed};
  }

  async duplicateAsLocal(providerId:string):Promise<Account>{
    return this.serializeMutation(() => this.duplicateAsLocalSerial(providerId));
  }
  private async duplicateAsLocalSerial(providerId:string):Promise<Account>{
    const source=(await this.store.listAccounts()).find(value=>value.multivibeTeam?.providerId===providerId);if(!source)throw new Error('Team provider not found');
    if(source.multivibeTeam?.deliveryMode==='cloud_proxy')throw new Error('Cloud proxy providers cannot be copied as local credentials');
    const {multivibeTeam:_,...copy}=source;const account:Account={...copy,id:randomUUID(),email:`${copy.email??copy.provider??'Provider'} (local copy)`};await this.store.addOrUpdate(account);return account;
  }
  async detach():Promise<void>{
    await this.serializeMutation(() => this.store.commitTeamDetach());
  }

  async recordTrace(trace:TraceEntry,principal:TeamPrincipal={type:'unassigned'}):Promise<void>{
    if(!this.identity||trace.traceKind!=='upstream-attempt'||trace.lifecycleState!=='completed')return;
    // Execution location describes the upstream, not who meters the request.
    // Distributed Team keys still call cloud providers directly from this Host.
    // Exclude only Cloud-managed accounts, whose usage is recorded server-side.
    const account = trace.accountId ? this.store.getCachedAccounts().find(value => value.id === trace.accountId) : undefined;
    if(trace.accountId==='multivibe-cloud'||account?.multivibeCloud||account?.multivibeTeam?.deliveryMode==='cloud_proxy')return;
    const start=new Date(trace.completedAt??trace.at);start.setUTCMinutes(0,0,0);const bucketStart=start.toISOString();const key=aggregateKey(this.identity.instanceId,trace,principal,bucketStart);const existing=this.aggregates.get(key);
    const next:Aggregate=existing??{bucketId:randomUUID(),bucketStart,revision:0,instanceId:this.identity.instanceId,principal,provider:trace.provider??'unknown',model:trace.resolvedModel??trace.model??'unknown',project:trace.projectId,application:trace.application,executionLocation:trace.executionLocation??'cloud',requests:0,succeeded:0,failed:0,inputTokens:0,outputTokens:0,cachedInputTokens:0,reasoningTokens:0,estimatedCostUsd:0,latencyHistogram:Array(16).fill(0),ttftHistogram:Array(16).fill(0)};
    next.revision++;next.requests++;if(trace.isError)next.failed++;else next.succeeded++;next.inputTokens+=trace.tokensInput??0;next.outputTokens+=trace.tokensOutput??0;next.cachedInputTokens+=trace.tokensInputCached??0;next.reasoningTokens+=trace.tokensReasoning??0;next.estimatedCostUsd+=trace.costUsd??0;
    for(const [index,count] of histogram(trace.latencyMs).entries())next.latencyHistogram[index]+=count;for(const [index,count]of histogram(trace.ttftMs).entries())next.ttftHistogram[index]+=count;this.aggregates.set(key,next);await this.writeOutbox();
  }
  analyticsBatch():Readonly<{schemaVersion:'multivibe-team-analytics-v1';buckets:readonly (Aggregate&{sourceDigest:string})[]}>{
    return Object.freeze({schemaVersion:'multivibe-team-analytics-v1',buckets:Object.freeze([...this.aggregates.values()].map(value=>Object.freeze({...value,sourceDigest:createHash('sha256').update(JSON.stringify(value)).digest('hex')})))});
  }
  async acknowledgeAnalytics(bucketIds:readonly string[]):Promise<void>{const ids=new Set(bucketIds);for(const [key,value]of this.aggregates)if(ids.has(value.bucketId))this.aggregates.delete(key);await this.writeOutbox();}

  signRequest(payload:unknown,issuedAt=new Date()):Readonly<{schemaVersion:'multivibe-team-instance-envelope-v1';instanceId:string;issuedAt:string;payload:unknown;signature:string}>{
    if(!this.identity)throw new Error('Team Sync is not initialized');const at=issuedAt.toISOString();const canonical=JSON.stringify({instanceId:this.identity.instanceId,issuedAt:at,payload});const signature=sign(null,Buffer.from(canonical),createPrivateKey(this.identity.privateKeyPkcs8)).toString('base64url');return Object.freeze({schemaVersion:'multivibe-team-instance-envelope-v1',instanceId:this.identity.instanceId,issuedAt:at,payload,signature});
  }
  private openCredential(providerId:string,revision:number,envelope:NonNullable<TeamProviderManifest['sealedCredential']>,provider:ProviderId,endpoint:string):ReturnType<typeof decodeTeamProviderCredential>{
    if(!this.identity||(envelope.schemaVersion!=='multivibe-team-sealed-credential-v1'&&envelope.schemaVersion!=='multivibe-team-sealed-credential-v2')||envelope.algorithm!=='X25519-HKDF-SHA256-AES-256-GCM')throw new Error('Team credential envelope is invalid');
    let shared:Buffer|undefined,key:Buffer|undefined,clear:Buffer|undefined;
    try {
      if(typeof envelope.ciphertext!=='string'||envelope.ciphertext.length>Math.ceil(200000*4/3)||typeof envelope.ephemeralPublicKeySpki!=='string'||envelope.ephemeralPublicKeySpki.length>1024)throw new Error();
      const publicKey=createPublicKey(envelope.ephemeralPublicKeySpki);
      if(publicKey.asymmetricKeyType!=='x25519')throw new Error();
      const nonce=Buffer.from(envelope.nonce,'base64url'),tag=Buffer.from(envelope.tag,'base64url');
      if(nonce.length!==12||tag.length!==16)throw new Error();
      shared=diffieHellman({privateKey:createPrivateKey(this.identity.encryptionPrivateKeyPkcs8),publicKey});
      key=Buffer.from(hkdfSync('sha256',shared,Buffer.from(providerId),Buffer.from(`multivibe-team-provider-${envelope.schemaVersion.endsWith('v2')?'v2':'v1'}:${revision}`),32));
      const decipher=createDecipheriv('aes-256-gcm',key,nonce);decipher.setAuthTag(tag);
      clear=Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64url')),decipher.final()]);
      const credential:unknown=JSON.parse(clear.toString('utf8'));
      const hasContext=!!credential&&typeof credential==='object'&&Object.hasOwn(credential,'coreAccountContext');
      if(hasContext!==envelope.schemaVersion.endsWith('v2'))throw new Error();
      return decodeTeamProviderCredential(credential,provider,endpoint);
    } catch {throw new Error('Team credential envelope authentication or context validation failed');}
    finally {shared?.fill(0);key?.fill(0);clear?.fill(0);}
  }

  private async readOutbox():Promise<void>{
    try{const raw=await fs.readFile(this.outboxPath,'utf8');const parsed=JSON.parse(raw) as {schemaVersion:number;aggregates:Aggregate[]};if(parsed.schemaVersion!==1||!Array.isArray(parsed.aggregates))throw new Error('invalid');for(const value of parsed.aggregates){if(!UUID.test(value.bucketId)||!UUID.test(value.instanceId)||!Number.isSafeInteger(value.revision)||value.revision<1)throw new Error('invalid');const key=[value.instanceId,value.bucketStart,value.principal.type,value.principal.id??'',value.provider,value.model,value.project??'',value.application??'',value.executionLocation].join('\0');this.aggregates.set(key,value);}}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('Team analytics outbox is invalid');}
  }
  private async writeOutbox():Promise<void>{
    await fs.mkdir(path.dirname(this.outboxPath),{recursive:true});const temporary=`${this.outboxPath}.tmp-${randomUUID()}`;await fs.writeFile(temporary,`${JSON.stringify({schemaVersion:1,aggregates:[...this.aggregates.values()]})}\n`,{mode:0o600});await fs.rename(temporary,this.outboxPath);await fs.chmod(this.outboxPath,0o600);
  }

  private async readOrCreateIdentity():Promise<IdentityDocument>{
    try{const raw=await fs.readFile(this.identityPath,'utf8');const value=JSON.parse(raw) as IdentityDocument;if(value.schemaVersion!==1||!UUID.test(value.instanceId)||!value.privateKeyPkcs8||!value.publicKeySpki||!value.encryptionPrivateKeyPkcs8||!value.encryptionPublicKeySpki)throw new Error('invalid');return value;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('Team Sync instance identity is invalid');}
    const pair=generateKeyPairSync('ed25519');const encryptionPair=generateKeyPairSync('x25519');const value:IdentityDocument={schemaVersion:1,instanceId:randomUUID(),privateKeyPkcs8:pair.privateKey.export({format:'pem',type:'pkcs8'}).toString(),publicKeySpki:pair.publicKey.export({format:'pem',type:'spki'}).toString(),encryptionPrivateKeyPkcs8:encryptionPair.privateKey.export({format:'pem',type:'pkcs8'}).toString(),encryptionPublicKeySpki:encryptionPair.publicKey.export({format:'pem',type:'spki'}).toString(),createdAt:new Date().toISOString()};
    await fs.mkdir(path.dirname(this.identityPath),{recursive:true});const temporary=`${this.identityPath}.tmp-${randomUUID()}`;await fs.writeFile(temporary,`${JSON.stringify(value)}\n`,{mode:0o600});await fs.rename(temporary,this.identityPath);await fs.chmod(this.identityPath,0o600);return value;
  }
}
