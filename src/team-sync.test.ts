import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AccountStore } from "./store.js";
import { MultivibeTeamSyncService, teamSyncEligibility } from "./team-sync.js";

test("Team Sync excludes every local runtime and the internal Cloud account",()=>{
 assert.equal(teamSyncEligibility({id:"a",accessToken:"",enabled:true,location:"local"}).eligible,false);
 assert.equal(teamSyncEligibility({id:"a",accessToken:"",enabled:true,location:"cloud",multivibeCloud:true}).eligible,false);
 assert.equal(teamSyncEligibility({id:"a",accessToken:"x",enabled:true,location:"cloud",baseUrl:"https://api.example.com/v1"}).eligible,true);
 assert.equal(teamSyncEligibility({id:"a",accessToken:"x",enabled:true,location:"cloud",baseUrl:"https://192.168.1.2/v1"}).eligible,false);
});
test("Cloud proxy manifests never expose credentials and distributed providers require them",async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"multivibe-team-sync-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));const store=new AccountStore(path.join(root,"accounts.json"));await store.init();const sync=new MultivibeTeamSyncService(store,path.join(root,"identity.json"));await sync.initialize();
 const id="123e4567-e89b-42d3-a456-426614174000";
 await assert.rejects(sync.applyManifest({schemaVersion:"multivibe-team-sync-v1",cursor:1,removedProviderIds:[],providers:[{id,provider:"openai",displayName:"Shared",endpoint:"https://api.openai.com/v1",models:[],deliveryMode:"cloud_proxy",enabled:true,revision:1,sealedCredential:{schemaVersion:"multivibe-team-sealed-credential-v1",algorithm:"X25519-HKDF-SHA256-AES-256-GCM",ephemeralPublicKeySpki:"invalid",nonce:"invalid",ciphertext:"invalid",tag:"invalid"}}]}),/exposed/);
 await sync.applyManifest({schemaVersion:"multivibe-team-sync-v1",cursor:1,removedProviderIds:[],providers:[{id,provider:"openai",displayName:"Shared",endpoint:"https://api.openai.com/v1",models:[],deliveryMode:"cloud_proxy",enabled:true,revision:1}]});
 const [account]=await store.listAccounts();assert.equal(account?.accessToken,"");assert.equal(account?.baseUrl,`https://api.multivibe.cloud/team/providers/${id}`);assert.equal(account?.multivibeTeam?.readOnly,true);
 await sync.detach();assert.equal((await store.listAccounts()).length,0);
});
test("Team analytics are aggregate-only and omit request content",async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"multivibe-team-analytics-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));const store=new AccountStore(path.join(root,"accounts.json"));await store.init();const sync=new MultivibeTeamSyncService(store,path.join(root,"identity.json"));await sync.initialize();
 await sync.recordTrace({id:"trace",at:Date.now(),route:"/responses",clientRequestId:"request",traceKind:"upstream-attempt",accountId:"local",provider:"openai-compatible",model:"local/model",executionLocation:"local",status:200,isError:false,stream:false,latencyMs:100,ttftMs:30,tokensInput:2,tokensOutput:3,tokensTotal:5,costUsd:0,usageStatus:"measured",requestBody:{prompt:"private"},requestHeaders:{authorization:"secret"},lifecycleState:"completed"},{type:"member",id:"member"});
 const encoded=JSON.stringify(sync.analyticsBatch());assert.doesNotMatch(encoded,/private|authorization|requestBody|requestHeaders/);assert.match(encoded,/local\/model/);
 const recovered=new MultivibeTeamSyncService(store,path.join(root,"identity.json"));await recovered.initialize();assert.equal(recovered.analyticsBatch().buckets.length,1);
 const envelope=recovered.signRequest({cursor:1});assert.equal(envelope.instanceId,recovered.getIdentity().instanceId);assert.ok(envelope.signature.length>40);
});
test("Team synchronization preserves managed enrollment bindings",async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"multivibe-managed-team-sync-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));const store=new AccountStore(path.join(root,"accounts.json"));await store.init();const sync=new MultivibeTeamSyncService(store,path.join(root,"identity.json"));await sync.initialize();
 const identity=sync.getIdentity();await store.patchSettings({multivibeTeam:{enabled:true,instanceId:identity.instanceId,instanceName:"Managed Mac",syncCursor:0,organizationId:"10000000-0000-4000-8000-000000000001",membershipId:"20000000-0000-4000-8000-000000000002",managementChannel:"device",deviceClaim:{issuer:"intune",subject:"device-42",nonce:"n".repeat(22)},managedEnrollmentId:"30000000-0000-4000-8000-000000000003",teamKeyId:"40000000-0000-4000-8000-000000000004"}});
 await sync.applyManifest({schemaVersion:"multivibe-team-sync-v1",cursor:1,providers:[],removedProviderIds:[]});
 const settings=await store.getSettings();assert.equal(settings.multivibeTeam?.managedEnrollmentId,"30000000-0000-4000-8000-000000000003");assert.equal(settings.multivibeTeam?.membershipId,"20000000-0000-4000-8000-000000000002");assert.equal(settings.multivibeTeam?.syncCursor,1);
});

test('Team removals are acknowledged again after local deletion and reject invalid tombstones',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'team-removal-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const store=new AccountStore(path.join(root,'accounts.json'));await store.init();
 const sync=new MultivibeTeamSyncService(store,path.join(root,'identity.json'));await sync.initialize();
 const id='123e4567-e89b-42d3-a456-426614174000';
 const manifest={schemaVersion:'multivibe-team-sync-v1' as const,cursor:9,providers:[],removedProviderIds:[id],removedProviders:[{id,revision:3}]};
 assert.deepEqual((await sync.applyManifest(manifest)).removed,[id]);
 assert.deepEqual((await sync.applyManifest(manifest)).removed,[id]);
 await assert.rejects(sync.applyManifest({...manifest,removedProviders:[{id,revision:10}]}),/revision/);
 await assert.rejects(sync.applyManifest({...manifest,removedProviders:[]}),/removals/);
});

test('Team manifest preflight rejects late failures without changing accounts or cursor',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'team-preflight-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const store=new AccountStore(path.join(root,'accounts.json'));await store.init();
 const sync=new MultivibeTeamSyncService(store,path.join(root,'identity.json'));await sync.initialize();
 const first={id:'123e4567-e89b-42d3-a456-426614174000',provider:'openai' as const,displayName:'Shared',endpoint:'https://api.openai.com/v1',models:['gpt-test'],deliveryMode:'cloud_proxy' as const,enabled:true,revision:1};
 const second={...first,id:'123e4567-e89b-42d3-a456-426614174001',deliveryMode:'distributed' as const};
 const manifest={schemaVersion:'multivibe-team-sync-v1' as const,cursor:1,removedProviderIds:[],providers:[first,second]};
 await assert.rejects(sync.applyManifest(manifest),/unavailable/);
 assert.deepEqual(await store.listAccounts(),[]);
 assert.equal((await store.getSettings()).multivibeTeam?.syncCursor,undefined);
 await assert.rejects(sync.applyManifest({...manifest,providers:[first,first]}),/invalid/);
 await assert.rejects(sync.applyManifest({...manifest,providers:[first,{...second,revision:2}]}),/invalid/);
 await assert.rejects(sync.applyManifest({...manifest,providers:[first,{...second,sealedCredential:{schemaVersion:'multivibe-team-sealed-credential-v1',algorithm:'X25519-HKDF-SHA256-AES-256-GCM',ephemeralPublicKeySpki:'invalid',nonce:'invalid',ciphertext:'invalid',tag:'invalid'}}]}));
 assert.deepEqual(await store.listAccounts(),[]);
 await sync.applyManifest({...manifest,providers:[first]});
 assert.deepEqual((await store.listAccounts())[0].multivibeTeam?.models,['gpt-test']);
 await assert.rejects(sync.duplicateAsLocal(first.id),/cannot be copied/);
 assert.equal((await store.listAccounts()).length,1);
});

test('concurrent services cannot restore a manifest older than a queued revocation',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'team-concurrent-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const store=new AccountStore(path.join(root,'accounts.json'));await store.init();
 const first=new MultivibeTeamSyncService(store,path.join(root,'identity.json'));await first.initialize();
 const second=new MultivibeTeamSyncService(store,path.join(root,'identity.json'));await second.initialize();
 const id='123e4567-e89b-42d3-a456-426614174000';
 const active={schemaVersion:'multivibe-team-sync-v1' as const,cursor:1,removedProviderIds:[],providers:[{id,provider:'openai' as const,displayName:'Shared',endpoint:'https://api.openai.com/v1',models:[],deliveryMode:'cloud_proxy' as const,enabled:true,revision:1}]};
 const revoked={schemaVersion:'multivibe-team-sync-v1' as const,cursor:2,providers:[],removedProviderIds:[id]};
 const results=await Promise.allSettled([first.applyManifest(active),second.applyManifest(revoked),first.applyManifest(active)]);
 assert.deepEqual(results.map(value=>value.status),['fulfilled','fulfilled','rejected']);
 assert.deepEqual(await store.listAccounts(),[]);
 const disk=JSON.parse(await fs.readFile(path.join(root,'accounts.json'),'utf8'));
 assert.deepEqual(disk.accounts,[]);assert.equal(disk.settings.multivibeTeam.syncCursor,2);
 // A rejection releases the shared queue.
 await second.applyManifest({...revoked,cursor:3});
 assert.equal((await store.getSettings()).multivibeTeam?.syncCursor,3);
});

test('a complete Team manifest changes accounts and cursor in one store generation',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'team-batch-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const store=new AccountStore(path.join(root,'accounts.json'));await store.init();
 const sync=new MultivibeTeamSyncService(store,path.join(root,'identity.json'));await sync.initialize();
 const before=store.getRevision();
 const provider={id:'123e4567-e89b-42d3-a456-426614174000',provider:'openai' as const,displayName:'Shared',endpoint:'https://api.openai.com/v1',models:[],deliveryMode:'cloud_proxy' as const,enabled:true,revision:1};
 await sync.applyManifest({schemaVersion:'multivibe-team-sync-v1',cursor:1,removedProviderIds:[],providers:[provider,{...provider,id:'123e4567-e89b-42d3-a456-426614174001'}]});
 assert.equal(store.getRevision()-before,1);
 const disk=JSON.parse(await fs.readFile(path.join(root,'accounts.json'),'utf8'));
 assert.equal(disk.accounts.length,2);assert.equal(disk.settings.multivibeTeam.syncCursor,1);
 await assert.rejects(store.commitTeamManifest([],[],0,disk.settings.multivibeTeam),/cursor changed/);
 assert.equal((await store.listAccounts()).length,2);
});
