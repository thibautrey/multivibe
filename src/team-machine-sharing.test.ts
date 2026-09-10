import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AccountStore} from './store.js';
import {TeamMachineSharing} from './team-machine-sharing.js';
import {TEAM_MACHINE_LEASE_MS,issueMachinePolicy,verifyMachinePolicy,type MachinePolicy} from './team-machine-protocol.js';
const pair=generateKeyPairSync('ed25519');const trust={test:pair.publicKey.export({type:'spki',format:'pem'}).toString()};
function policy(now:number):MachinePolicy{return {version:'team-machine-v1',organizationId:randomUUID(),instanceId:randomUUID(),consentId:randomUUID(),revision:1,runtimeId:'local-runtime-ollama',transport:'private_network',endpoint:'https://machine.corp.example/team-machine',enabled:true,models:[],keys:[],maxConcurrent:2,issuedAt:now,expiresAt:now+TEAM_MACHINE_LEASE_MS,entitlementEndsAt:now+TEAM_MACHINE_LEASE_MS*2};}
test('private grants survive 48 hours, reject tampering and respect paid expiry',()=>{
 const now=Date.now(),p=policy(now),signed=issueMachinePolicy(p,'test',pair.privateKey,now);
 assert.equal(verifyMachinePolicy(signed,trust,now+TEAM_MACHINE_LEASE_MS-1).instanceId,p.instanceId);
 assert.throws(()=>verifyMachinePolicy(signed,trust,now+TEAM_MACHINE_LEASE_MS),/expired/);
 assert.throws(()=>verifyMachinePolicy({...signed,policy:{...p,enabled:false}},trust,now),/signature/);
 assert.throws(()=>issueMachinePolicy({...p,expiresAt:p.expiresAt+1},'test',pair.privateKey,now),/expired/);
 assert.throws(()=>issueMachinePolicy({...p,entitlementEndsAt:now+1000},'test',pair.privateKey,now),/expired/);
});
test('consent, restart, renewal, rollback, suspension and local revocation',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'team-machine-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const store=new AccountStore(path.join(dir,'accounts.json'));await store.init();let now=Date.now();
 // A disabled policy exercises durable authorization without fabricating a runtime.
 let p={...policy(now),enabled:false};const file=path.join(dir,'sharing.json');const service=new TeamMachineSharing(store,file,trust,()=>now);await service.initialize();
 assert.equal(service.status().sharing,null);await assert.rejects(service.apply(issueMachinePolicy(p,'test',pair.privateKey,now)),/consent/);
 const consent=await service.consent(p.organizationId,p.instanceId);p={...p,consentId:consent.id};await service.apply(issueMachinePolicy(p,'test',pair.privateKey,now));
 const recovered=new TeamMachineSharing(store,file,trust,()=>now);await recovered.initialize();assert.equal(recovered.status().consent?.id,consent.id);
 now+=3600000;p={...p,issuedAt:now,expiresAt:now+TEAM_MACHINE_LEASE_MS};await recovered.apply(issueMachinePolicy(p,'test',pair.privateKey,now));
 await assert.rejects(recovered.apply(issueMachinePolicy({...p,instanceId:randomUUID()},'test',pair.privateKey,now)),/consent/);
 await recovered.stop();assert.equal(recovered.status().state,'stopped');
 await recovered.apply(issueMachinePolicy({...p,revision:2},'test',pair.privateKey,now));assert.equal(recovered.status().state,'stopped');
 await recovered.revokeConsent();assert.equal(recovered.status().consent,null);
});
test('model ACLs and private endpoint policy validate without URL credentials',()=>{
 const now=Date.now(),p=policy(now),member=randomUUID();
 const model={id:'model',members:[member]};const key={digest:createHash('sha256').update('key').digest('hex'),memberId:member,expiresAt:now+TEAM_MACHINE_LEASE_MS};
 assert.doesNotThrow(()=>issueMachinePolicy({...p,models:[model],keys:[key]},'test',pair.privateKey,now));
 assert.throws(()=>issueMachinePolicy({...p,endpoint:'http://machine.local'},'test',pair.privateKey,now),/tls/);
 assert.throws(()=>issueMachinePolicy({...p,models:[model,model]},'test',pair.privateKey,now),/model/);
 assert.throws(()=>issueMachinePolicy({...p,transport:'cloud_relay'},'test',pair.privateKey,now),/endpoint/);
});
