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
